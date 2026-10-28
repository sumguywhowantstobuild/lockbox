//! `backup-manifest.json` (spec 6.7): every archive entry except itself, with its path,
//! size and SHA-256, plus an HMAC keyed from the vault key. After unlocking, restore can
//! prove a backup is complete: nothing added, removed or swapped. Nothing here is secret.

use crate::ad::{encode_ad, v16};
use crate::blob::CancelToken;
use crate::error::{CoreError, Result};
use crate::ids::VaultId;
use crate::limits::{MAX_JSON_DEPTH, check_json};
use crate::secret::Key32;
use hmac::{Hmac, KeyInit, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;

/// Name of the manifest inside the archive.
pub const MANIFEST_FILE: &str = "backup-manifest.json";
/// The manifest version this build reads and writes.
pub const MANIFEST_VERSION: u16 = 1;
/// Largest manifest accepted (64 MiB).
pub const MAX_MANIFEST_BYTES: usize = 67_108_864;
/// Most payload entries (items + blobs) in a backup. The manifest also lists `vault.json`,
/// so it holds at most `MAX_ENTRIES + 1`.
pub const MAX_ENTRIES: usize = 250_000;

const MAC_INFO: &[u8] = b"lockbox backup manifest v1";
/// Bytes of the MAC message hashed between two cancellation checks.
const MAC_PIECE: usize = 1 << 20;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ManifestEntry {
    pub path: String,
    pub size: u64,
    #[serde(with = "crate::serde_b64")]
    pub sha256: [u8; 32],
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BackupManifest {
    pub manifest_version: u16,
    pub vault_id: VaultId,
    /// Stored as given, not format-checked: the MAC covers it and it is only displayed.
    pub created_at: String,
    pub entries: Vec<ManifestEntry>,
    /// Always written, `null` until signed; a missing key is rejected.
    #[serde(with = "crate::serde_b64::option")]
    pub mac: Option<[u8; 32]>,
}

impl BackupManifest {
    pub fn entry(&self, path: &str) -> Option<&ManifestEntry> {
        self.entries.iter().find(|e| e.path == path)
    }
}

/// Everything except the MAC itself.
fn mac_message(m: &BackupManifest) -> Vec<u8> {
    let version = v16(m.manifest_version);
    let sizes: Vec<[u8; 8]> = m.entries.iter().map(|e| e.size.to_le_bytes()).collect();
    let mut fields: Vec<&[u8]> = vec![&version, &m.vault_id.0, m.created_at.as_bytes()];
    for (e, size) in m.entries.iter().zip(&sizes) {
        fields.extend([e.path.as_bytes(), size, &e.sha256]);
    }
    encode_ad("lockbox/backup-manifest", &fields)
}

/// An HMAC-SHA256 keyed by a key derived from (not equal to) the vault key, nothing fed in yet.
fn manifest_hmac_start(vault_key: &Key32) -> Hmac<Sha256> {
    let key = Key32::hkdf_sha256(None, vault_key.as_bytes(), MAC_INFO);
    Hmac::<Sha256>::new_from_slice(key.as_bytes()).expect("HMAC accepts keys of any length")
}

/// The HMAC over [`mac_message`], for signing and verifying alike. A manifest may be tens of
/// MiB, so the message is fed in pieces of at most 1 MiB; `cancel` is checked before each piece
/// and once more after the last, so even a tiny manifest sees a cancel that arrived meanwhile.
fn manifest_hmac(
    m: &BackupManifest,
    vault_key: &Key32,
    cancel: &CancelToken,
) -> Result<Hmac<Sha256>> {
    let mut hmac = manifest_hmac_start(vault_key);
    for piece in mac_message(m).chunks(MAC_PIECE) {
        cancel.check()?;
        hmac.update(piece);
        #[cfg(any(test, feature = "test-internals"))]
        crate::fsio::failpoint::check("manifest.mac_piece")?;
    }
    cancel.check()?;
    Ok(hmac)
}

/// HMAC-SHA256 over [`mac_message`].
pub fn manifest_mac(m: &BackupManifest, vault_key: &Key32) -> [u8; 32] {
    // A token nobody holds is never cancelled, so this is the same signing without a way out.
    manifest_mac_cancellable(m, vault_key, &CancelToken::new())
        .expect("a token nobody holds is never cancelled")
}

/// [`manifest_mac`] that stops when `cancel` is set (see [`manifest_hmac`]).
pub(crate) fn manifest_mac_cancellable(
    m: &BackupManifest,
    vault_key: &Key32,
    cancel: &CancelToken,
) -> Result<[u8; 32]> {
    Ok(manifest_hmac(m, vault_key, cancel)?
        .finalize()
        .into_bytes()
        .into())
}

/// False if the manifest has no MAC or it does not match. The comparison is constant-time.
pub fn verify_manifest_mac(m: &BackupManifest, vault_key: &Key32) -> bool {
    verify_manifest_mac_cancellable(m, vault_key, &CancelToken::new()).unwrap_or(false)
}

/// [`verify_manifest_mac`] that stops when `cancel` is set (see [`manifest_hmac`]).
pub(crate) fn verify_manifest_mac_cancellable(
    m: &BackupManifest,
    vault_key: &Key32,
    cancel: &CancelToken,
) -> Result<bool> {
    let Some(mac) = m.mac else {
        return Ok(false);
    };
    Ok(manifest_hmac(m, vault_key, cancel)?
        .verify_slice(&mac)
        .is_ok())
}

pub fn serialize_manifest(m: &BackupManifest) -> Vec<u8> {
    serde_json::to_vec(m).expect("a manifest always serializes")
}

/// Reads `backup-manifest.json`. Order matters: size and depth first, then only the
/// version (so a newer backup says "update Lockbox", not "damaged"), then the strict
/// parse and the entry cap. Serde's own messages are never passed on.
pub fn parse_manifest(bytes: &[u8]) -> Result<BackupManifest> {
    const DAMAGED: CoreError = CoreError::Damaged {
        what: "backup: manifest",
    };
    check_json(bytes, MAX_MANIFEST_BYTES, MAX_JSON_DEPTH)?;
    #[derive(Deserialize)]
    struct Peek {
        manifest_version: u16,
    }
    let peek: Peek = serde_json::from_slice(bytes).map_err(|_| DAMAGED)?;
    if peek.manifest_version != MANIFEST_VERSION {
        return Err(CoreError::UnsupportedVersion);
    }
    let m: BackupManifest = serde_json::from_slice(bytes).map_err(|_| DAMAGED)?;
    if m.entries.len() > MAX_ENTRIES + 1 {
        return Err(CoreError::Damaged {
            what: "backup: too many entries",
        });
    }
    Ok(m)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    fn entry(path: &str, size: u64, byte: u8) -> ManifestEntry {
        ManifestEntry {
            path: path.to_owned(),
            size,
            sha256: [byte; 32],
        }
    }

    fn sample() -> BackupManifest {
        BackupManifest {
            manifest_version: 1,
            vault_id: VaultId([0xAA; 16]),
            created_at: "2026-10-17T00:00:00Z".to_owned(),
            entries: vec![entry("vault.json", 5, 0x11)],
            mac: None,
        }
    }

    fn key() -> Key32 {
        Key32::from_bytes([7; 32])
    }

    fn signed(mut m: BackupManifest) -> BackupManifest {
        m.mac = Some(manifest_mac(&m, &key()));
        m
    }

    #[test]
    fn mac_message_test_vector() {
        let field = |out: &mut Vec<u8>, bytes: &[u8]| {
            out.extend((bytes.len() as u32).to_le_bytes());
            out.extend(bytes);
        };
        let mut expected = b"lockbox/backup-manifest".to_vec();
        field(&mut expected, &[1, 0]); // manifest_version, u16 LE
        field(&mut expected, &[0xAA; 16]); // vault_id as raw bytes
        field(&mut expected, b"2026-10-17T00:00:00Z");
        field(&mut expected, b"vault.json");
        field(&mut expected, &5u64.to_le_bytes());
        field(&mut expected, &[0x11; 32]);
        assert_eq!(mac_message(&sample()), expected);
    }

    #[test]
    fn mac_round_trip_and_tamper() {
        let mut base = sample();
        base.entries.push(entry("items/a.item", 9, 0x22));
        let m = signed(base);
        assert!(verify_manifest_mac(&m, &key()));

        type Edit = fn(&mut BackupManifest);
        let edits: [(&str, Edit); 10] = [
            ("vault_id", |m| m.vault_id.0[0] ^= 1),
            ("created_at", |m| m.created_at.push('x')),
            ("path", |m| m.entries[0].path.push('x')),
            ("size", |m| m.entries[0].size += 1),
            ("sha256", |m| m.entries[0].sha256[0] ^= 1),
            ("add", |m| m.entries.push(entry("items/b.item", 1, 3))),
            ("remove", |m| {
                m.entries.pop();
            }),
            ("swap", |m| m.entries.swap(0, 1)),
            ("version", |m| m.manifest_version = 2),
            ("mac none", |m| m.mac = None),
        ];
        for (what, edit) in edits {
            let mut bad = m.clone();
            edit(&mut bad);
            assert!(!verify_manifest_mac(&bad, &key()), "{what}");
        }
        assert!(!verify_manifest_mac(&m, &Key32::from_bytes([8; 32])));
    }

    #[test]
    fn cancellable_mac_agrees_with_the_plain_one() {
        let token = CancelToken::new();
        let mut m = sample();
        m.entries.push(entry("items/a.item", 9, 0x22));
        // Small, and several pieces long: both must give the plain verdict.
        for created_at in ["2026-10-17T00:00:00Z".to_owned(), "x".repeat(3 << 20)] {
            m.created_at = created_at;
            let m = signed(m.clone());
            assert!(verify_manifest_mac_cancellable(&m, &key(), &token).unwrap());
            let wrong = Key32::from_bytes([8; 32]);
            assert!(!verify_manifest_mac_cancellable(&m, &wrong, &token).unwrap());
            let mut bad = m.clone();
            bad.entries[0].size += 1;
            assert!(!verify_manifest_mac_cancellable(&bad, &key(), &token).unwrap());
            bad.mac = None;
            assert!(!verify_manifest_mac_cancellable(&bad, &key(), &token).unwrap());
        }
    }

    /// A manifest over 1 MiB is hashed in pieces, and a cancel during the first piece stops it
    /// before the rest; a cancel during the only piece of a tiny one is still seen.
    #[test]
    fn mac_check_is_cancellable() {
        use crate::fsio::failpoint;
        let mut big = sample();
        big.created_at = "x".repeat(3 << 20);
        let big = signed(big);
        let pieces = std::rc::Rc::new(std::cell::Cell::new(0));
        let counter = pieces.clone();
        failpoint::observe(
            "manifest.mac_piece",
            Box::new(move || counter.set(counter.get() + 1)),
        );
        let token = CancelToken::new();
        failpoint::arm_cancel("manifest.mac_piece", token.clone());
        let result = verify_manifest_mac_cancellable(&big, &key(), &token);
        failpoint::disarm_all();
        assert!(matches!(result, Err(CoreError::Cancelled)));
        assert_eq!(pieces.get(), 1, "stopped after the first piece");

        let token = CancelToken::new();
        failpoint::arm_cancel("manifest.mac_piece", token.clone());
        let result = verify_manifest_mac_cancellable(&signed(sample()), &key(), &token);
        failpoint::disarm_all();
        assert!(matches!(result, Err(CoreError::Cancelled)));

        let cancelled = CancelToken::new();
        cancelled.cancel();
        let result = verify_manifest_mac_cancellable(&big, &key(), &cancelled);
        assert!(matches!(result, Err(CoreError::Cancelled)));
    }

    /// Signing feeds the MAC in the same pieces as verifying and checks the cancel before each,
    /// and the bytes it produces are those of the plain `manifest_mac`.
    #[test]
    fn signing_is_cancellable() {
        use crate::fsio::failpoint;
        let mut big = sample();
        big.created_at = "x".repeat(3 << 20);
        let pieces = std::rc::Rc::new(std::cell::Cell::new(0));
        let counter = pieces.clone();
        failpoint::observe(
            "manifest.mac_piece",
            Box::new(move || counter.set(counter.get() + 1)),
        );
        let token = CancelToken::new();
        failpoint::arm_cancel("manifest.mac_piece", token.clone());
        let result = manifest_mac_cancellable(&big, &key(), &token);
        failpoint::disarm_all();
        assert!(matches!(result, Err(CoreError::Cancelled)));
        assert_eq!(pieces.get(), 1, "stopped after the first piece");

        let live = CancelToken::new();
        let mac = manifest_mac_cancellable(&big, &key(), &live).unwrap();
        assert_eq!(mac, manifest_mac(&big, &key()));
        let cancelled = CancelToken::new();
        cancelled.cancel();
        let result = manifest_mac_cancellable(&sample(), &key(), &cancelled);
        assert!(matches!(result, Err(CoreError::Cancelled)));
    }

    /// A manifest with `n` entries as JSON text, built directly (fast for 250 000).
    fn json_with_entries(n: usize) -> Vec<u8> {
        let sha = "ERERERERERERERERERERERERERERERERERERERERERE="; // [0x11; 32]
        let one = format!(r#"{{"path":"items/x.item","size":1,"sha256":"{sha}"}}"#);
        let list = vec![one; n].join(",");
        format!(
            r#"{{"manifest_version":1,"vault_id":"{}","created_at":"t","entries":[{list}],"mac":null}}"#,
            "aa".repeat(16)
        )
        .into_bytes()
    }

    #[test]
    fn parse_limits() {
        assert!(matches!(
            parse_manifest(&vec![b' '; MAX_MANIFEST_BYTES + 1]),
            Err(CoreError::TooLarge { .. })
        ));
        let deep = format!(r#"{{"x":{}{}}}"#, "[".repeat(32), "]".repeat(32));
        assert!(matches!(
            parse_manifest(deep.as_bytes()),
            Err(CoreError::Damaged {
                what: "json nesting"
            })
        ));

        assert_eq!(
            parse_manifest(&json_with_entries(MAX_ENTRIES + 1))
                .unwrap()
                .entries
                .len(),
            MAX_ENTRIES + 1
        );
        assert!(matches!(
            parse_manifest(&json_with_entries(MAX_ENTRIES + 2)),
            Err(CoreError::Damaged {
                what: "backup: too many entries"
            })
        ));

        let value =
            |m: &BackupManifest| serde_json::from_slice::<Value>(&serialize_manifest(m)).unwrap();
        let mut v = value(&sample());
        v["extra"] = json!(1);
        assert!(matches!(
            parse_manifest(&serde_json::to_vec(&v).unwrap()),
            Err(CoreError::Damaged {
                what: "backup: manifest"
            })
        ));
        v["manifest_version"] = json!(2);
        assert!(matches!(
            parse_manifest(&serde_json::to_vec(&v).unwrap()),
            Err(CoreError::UnsupportedVersion)
        ));
    }

    #[test]
    fn serialize_parse_round_trip() {
        let mut m = sample();
        m.entries.push(entry("files/b.blob", u64::MAX, 0x33));
        let m = signed(m);
        let back = parse_manifest(&serialize_manifest(&m)).unwrap();
        assert_eq!(back, m);
        assert!(verify_manifest_mac(&back, &key()));
        assert_eq!(back.entry("files/b.blob").unwrap().size, u64::MAX);
        assert!(back.entry("nope").is_none());
        // Unsigned manifests keep `"mac":null`, and a missing key is refused.
        let unsigned = parse_manifest(&serialize_manifest(&sample())).unwrap();
        assert!(unsigned.mac.is_none());
        let mut v: Value = serde_json::from_slice(&serialize_manifest(&sample())).unwrap();
        v.as_object_mut().unwrap().remove("mac");
        assert!(parse_manifest(&serde_json::to_vec(&v).unwrap()).is_err());
    }

    #[test]
    fn errors_never_echo_content() {
        let mut v: Value = serde_json::from_slice(&serialize_manifest(&sample())).unwrap();
        v["created_at"] = json!("SECRET-MARKER");
        v["extra"] = json!("SECRET-MARKER");
        let err = parse_manifest(&serde_json::to_vec(&v).unwrap()).unwrap_err();
        assert!(!format!("{err} {err:?}").contains("SECRET-MARKER"));
    }

    /// Property tests (spec 5.4): the manifest comes out of an untrusted backup, so any bytes
    /// are an error or a manifest, never a panic, and the error text never repeats the input.
    mod never_panics {
        use super::*;
        use crate::archive::testkit::{assert_text_is_fixed, manifest_for, mutated};
        use proptest::collection::vec;
        use proptest::prelude::*;
        use std::sync::LazyLock;

        /// A signed manifest of three entries, serialized once.
        static VALID: LazyLock<Vec<u8>> = LazyLock::new(|| {
            let item = format!("items/{}.item", "cd".repeat(16));
            let blob = format!("files/{}.blob", "ef".repeat(16));
            let entries: [(&str, &[u8]); 3] =
                [("vault.json", &[1; 9]), (&item, &[2; 33]), (&blob, &[3; 5])];
            serialize_manifest(&manifest_for(&entries, Some(&key())))
        });

        /// Half the cases are random bytes, which stop at the size or JSON check; half are a
        /// valid manifest with up to three bytes changed, which reach the version peek and the
        /// strict parse.
        fn manifest_bytes() -> impl Strategy<Value = Vec<u8>> {
            prop_oneof![vec(any::<u8>(), 0..1024), mutated(&VALID, 3)]
        }

        #[test]
        fn the_valid_manifest_parses() {
            assert_eq!(parse_manifest(&VALID).unwrap().entries.len(), 3);
        }

        proptest! {
            #![proptest_config(ProptestConfig::with_cases(256))]

            #[test]
            fn parse_manifest_never_panics(bytes in manifest_bytes()) {
                if let Err(error) = parse_manifest(&bytes) {
                    assert_text_is_fixed(&error, &bytes)?;
                }
            }
        }
    }
}
