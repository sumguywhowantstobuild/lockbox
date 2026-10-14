//! `vault.json` (spec 5.2, 6.2): the readable part of a vault. It holds the key slots
//! and a MAC over the fields no slot covers, so renaming a vault or editing its
//! creation time is noticed once the vault key is known. Nothing here is secret.

use crate::ad::{encode_ad, v16};
use crate::error::{CoreError, Result};
use crate::fsio::atomic_write;
use crate::ids::VaultId;
use crate::limits::{MAX_JSON_DEPTH, check_json};
use crate::secret::Key32;
use crate::slots::{KeySlot, SlotType};
use hmac::{Hmac, KeyInit, Mac};
use serde::de::IgnoredAny;
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use std::path::Path;

/// The container version this build reads and writes.
pub const CONTAINER_VERSION: u16 = 1;
/// Largest `vault.json` accepted.
pub const MAX_HEADER_BYTES: usize = 65_536;

const MAC_INFO: &[u8] = b"lockbox header mac v1";
/// File names inside a vault folder.
pub const HEADER_FILE: &str = "vault.json";
pub const HEADER_BACKUP: &str = "vault.json.bak";

/// Marks a vault part-way through an upgrade. Version 1 never writes one and refuses
/// to open a vault that has one.
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(deny_unknown_fields)]
pub struct Migration {
    pub from: u16,
    pub to: u16,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct VaultHeader {
    pub container_version: u16,
    pub vault_id: VaultId,
    pub name: String,
    pub slots: Vec<KeySlot>,
    /// Always written, `null` when absent; a missing key is rejected (serde would
    /// otherwise quietly read it as `None`).
    #[serde(deserialize_with = "Option::deserialize")]
    pub migration: Option<Migration>,
    /// Stored as given, not format-checked: the MAC covers it and it is only displayed.
    pub created_at: String,
    #[serde(with = "crate::serde_b64::option")]
    pub header_mac: Option<[u8; 32]>,
}

/// Reads `vault.json`. Order matters: size and depth first (before any parsing), then
/// only the version fields, so a newer vault with new fields says "update Lockbox"
/// rather than "damaged"; the strict parse and slot rules come last.
pub fn parse_header(bytes: &[u8]) -> Result<VaultHeader> {
    const DAMAGED: CoreError = CoreError::Damaged {
        what: "vault header",
    };
    check_json(bytes, MAX_HEADER_BYTES, MAX_JSON_DEPTH)?;
    #[derive(Deserialize)]
    struct Peek {
        container_version: u16,
        migration: Option<IgnoredAny>,
    }
    let peek: Peek = serde_json::from_slice(bytes).map_err(|_| DAMAGED)?;
    if peek.container_version != CONTAINER_VERSION || peek.migration.is_some() {
        return Err(CoreError::UnsupportedVersion);
    }
    let header: VaultHeader = serde_json::from_slice(bytes).map_err(|_| DAMAGED)?;
    check_slots(&header.slots)?;
    Ok(header)
}

/// Exactly one password slot (with in-bounds KDF settings) and one recovery slot (without).
fn check_slots(slots: &[KeySlot]) -> Result<()> {
    let count = |t| slots.iter().filter(|s| s.slot_type == t).count();
    if count(SlotType::Password) != 1 || count(SlotType::Recovery) != 1 {
        return Err(CoreError::Damaged { what: "key slots" });
    }
    for slot in slots {
        match (slot.slot_type, &slot.kdf) {
            (SlotType::Password, Some(kdf)) => kdf.validate_for_read()?,
            (SlotType::Recovery, None) => {}
            _ => return Err(CoreError::Damaged { what: "key slots" }),
        }
    }
    Ok(())
}

/// Pretty-printed so a person can read it; the MAC does not depend on this text.
pub fn serialize_header(h: &VaultHeader) -> Vec<u8> {
    serde_json::to_vec_pretty(h).expect("a header always serializes")
}

/// What the MAC covers: everything except the slots (which authenticate themselves)
/// and the MAC itself.
fn mac_message(h: &VaultHeader) -> Vec<u8> {
    let migration = h
        .migration
        .map(|m| serde_json::to_vec(&m).expect("a migration always serializes"))
        .unwrap_or_default();
    encode_ad(
        "lockbox/header",
        &[
            h.name.as_bytes(),
            &v16(h.container_version),
            &migration,
            h.created_at.as_bytes(),
            &h.vault_id.0,
        ],
    )
}

/// HMAC-SHA256 over [`mac_message`], keyed by a key derived from (not equal to) the vault key.
fn header_hmac(h: &VaultHeader, vault_key: &Key32) -> Hmac<Sha256> {
    let key = Key32::hkdf_sha256(None, vault_key.as_bytes(), MAC_INFO);
    Hmac::<Sha256>::new_from_slice(key.as_bytes())
        .expect("HMAC accepts keys of any length")
        .chain_update(mac_message(h))
}

pub fn header_mac(h: &VaultHeader, vault_key: &Key32) -> [u8; 32] {
    header_hmac(h, vault_key).finalize().into_bytes().into()
}

/// False if the header has no MAC or it does not match. The comparison is constant-time.
pub fn verify_header_mac(h: &VaultHeader, vault_key: &Key32) -> bool {
    h.header_mac
        .is_some_and(|mac| header_hmac(h, vault_key).verify_slice(&mac).is_ok())
}

/// Writes `vault.json`, then the identical `vault.json.bak`. Each write is crash-safe,
/// so at least one good copy exists at every moment.
///
/// An `Err` after `vault.json` was replaced means the new header is already live and
/// `vault.json.bak` is one version behind (after a password change it still holds the
/// old password slot). The caller must rewrite `.bak`, e.g. at the next unlock.
/// A header whose pretty-printed text exceeds [`MAX_HEADER_BYTES`] is refused with
/// `TooLarge` before either file is touched.
pub fn write_headers(dir: &Path, h: &VaultHeader) -> Result<()> {
    write_pair(dir, h, [HEADER_FILE, HEADER_BACKUP])
}

/// Like [`write_headers`] but `vault.json.bak` first, then `vault.json`. For changes
/// whose result the user must receive (a new recovery secret): the primary never holds
/// something that was not committed to both files first. An `Err` after `.bak` was
/// replaced leaves `.bak` one version ahead of `vault.json`.
pub fn write_headers_backup_first(dir: &Path, h: &VaultHeader) -> Result<()> {
    write_pair(dir, h, [HEADER_BACKUP, HEADER_FILE])
}

fn write_pair(dir: &Path, h: &VaultHeader, [first, second]: [&str; 2]) -> Result<()> {
    let bytes = serialize_header(h);
    // Size only: the content is the caller's job. This just keeps a header that `parse_header`
    // would refuse for its length from being saved.
    if bytes.len() > MAX_HEADER_BYTES {
        return Err(CoreError::TooLarge {
            what: "vault header",
        });
    }
    #[cfg(test)]
    crate::fsio::failpoint::check("write_headers.before_first")?;
    atomic_write(&dir.join(first), &bytes)?;
    #[cfg(test)]
    crate::fsio::failpoint::check("write_headers.before_second")?;
    atomic_write(&dir.join(second), &bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fsio::testutil::TempDir;
    use crate::kdf::Argon2Params;
    use crate::slots::wrap_slot;
    use serde_json::{Value, json};

    type Edit = fn(&mut VaultHeader);

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    fn sample_with(name: &str) -> VaultHeader {
        let vault_id = VaultId([0x11; 16]);
        let key = Key32::from_bytes([1; 32]);
        let vault_key = Key32::from_bytes([2; 32]);
        let kdf = Argon2Params {
            memory_kib: 65_536,
            iterations: 3,
            parallelism: 4,
        };
        VaultHeader {
            container_version: CONTAINER_VERSION,
            vault_id,
            name: name.to_owned(),
            slots: vec![
                wrap_slot(
                    SlotType::Password,
                    &vault_id,
                    [9; 16],
                    Some(kdf),
                    &key,
                    &vault_key,
                ),
                wrap_slot(
                    SlotType::Recovery,
                    &vault_id,
                    [8; 16],
                    None,
                    &key,
                    &vault_key,
                ),
            ],
            migration: None,
            created_at: "2026-10-09T12:00:00Z".to_owned(),
            header_mac: None,
        }
    }

    /// Name "My Vault": the header the MAC known answers below were computed for.
    fn sample() -> VaultHeader {
        sample_with("My Vault")
    }

    fn to_value(h: &VaultHeader) -> Value {
        serde_json::from_slice(&serialize_header(h)).unwrap()
    }

    fn parse_value(v: &Value) -> Result<VaultHeader> {
        parse_header(&serde_json::to_vec(v).unwrap())
    }

    /// The vault key the MAC known answers below were computed for: bytes 0..32.
    fn kat_key() -> Key32 {
        Key32::from_bytes(std::array::from_fn(|i| i as u8))
    }

    #[test]
    fn round_trip() {
        let mut h = sample();
        h.header_mac = Some(header_mac(&h, &kat_key()));
        let bytes = serialize_header(&h);
        let json = to_value(&h);
        assert_eq!(json["container_version"], 1);
        assert_eq!(json["vault_id"], "11".repeat(16));
        assert_eq!(json["slots"][0]["type"], "password");
        assert_eq!(json["slots"][1]["type"], "recovery");
        assert!(json["migration"].is_null());
        assert!(json["header_mac"].is_string());
        let back = parse_header(&bytes).unwrap();
        assert_eq!(serialize_header(&back), bytes);
        assert_eq!(back.name, "My Vault");
        assert_eq!(back.header_mac, h.header_mac);

        // No MAC yet: both optional fields are written as null, and read back as None.
        let json = to_value(&sample());
        assert!(json["header_mac"].is_null() && json["migration"].is_null());
        assert!(parse_value(&json).unwrap().header_mac.is_none());
    }

    #[test]
    fn awkward_names_survive_exactly() {
        let long = "x".repeat(250);
        for name in [
            "Family \u{1F512} vault \u{00E9}\u{4E2D}",
            "<>:\"/\\|?*",
            long.as_str(),
            "",
        ] {
            let back = parse_header(&serialize_header(&sample_with(name))).unwrap();
            assert_eq!(back.name, name);
        }
    }

    #[test]
    fn limits_are_pinned() {
        assert_eq!(MAX_HEADER_BYTES, 65_536);
        assert_eq!(MAX_JSON_DEPTH, 32);
        assert_eq!(CONTAINER_VERSION, 1);
    }

    #[test]
    fn missing_migration_or_mac_rejected() {
        for key in ["migration", "header_mac"] {
            let mut json = to_value(&sample());
            json.as_object_mut().unwrap().remove(key);
            assert!(
                matches!(parse_value(&json), Err(CoreError::Damaged { .. })),
                "{key}"
            );
        }
    }

    #[test]
    fn unknown_kdf_field_rejected() {
        let mut json = to_value(&sample());
        json["slots"][0]["kdf"]["extra"] = 1.into();
        assert!(matches!(parse_value(&json), Err(CoreError::Damaged { .. })));
    }

    #[test]
    fn unknown_field_rejected() {
        let mut json = to_value(&sample());
        json["extra"] = 1.into();
        assert!(matches!(parse_value(&json), Err(CoreError::Damaged { .. })));
    }

    #[test]
    fn bad_json_is_damaged() {
        let truncated = br#"{"container_version":1}"#;
        for bad in [&b""[..], b"not json", b"{}", b"[]", truncated] {
            assert!(matches!(parse_header(bad), Err(CoreError::Damaged { .. })));
        }
        let mut bytes = serialize_header(&sample());
        bytes.extend(b" x");
        assert!(matches!(
            parse_header(&bytes),
            Err(CoreError::Damaged { .. })
        ));
    }

    #[test]
    fn oversized_rejected_before_parse() {
        // Not even JSON: the size check must come first.
        let junk = vec![b'{'; MAX_HEADER_BYTES + 1];
        assert!(matches!(
            parse_header(&junk),
            Err(CoreError::TooLarge { .. })
        ));
        // Over-deep nesting is refused before the parser sees it.
        let deep = format!(
            r#"{{"x":{}{}}}"#,
            "[".repeat(MAX_JSON_DEPTH + 1),
            "]".repeat(MAX_JSON_DEPTH + 1)
        );
        assert!(matches!(
            parse_header(deep.as_bytes()),
            Err(CoreError::Damaged {
                what: "json nesting"
            })
        ));
    }

    #[test]
    fn newer_container_version_refused() {
        for version in [0, 2] {
            let mut json = to_value(&sample());
            json["container_version"] = version.into();
            assert!(matches!(
                parse_value(&json),
                Err(CoreError::UnsupportedVersion)
            ));
        }
    }

    #[test]
    fn newer_version_with_new_fields_says_update_not_damaged() {
        let mut json = to_value(&sample());
        json["container_version"] = 2.into();
        json["some_new_field"] = json!({"a": 1});
        assert!(matches!(
            parse_value(&json),
            Err(CoreError::UnsupportedVersion)
        ));
    }

    #[test]
    fn migration_marker_refused() {
        let markers = [
            json!({"from": 1, "to": 2}),
            json!({"unfamiliar": [1, 2], "fields": {"a": null}}),
            json!(false),
            json!(0),
            json!(""),
            json!([]),
        ];
        for marker in markers {
            let mut json = to_value(&sample());
            json["migration"] = marker.clone();
            assert!(
                matches!(parse_value(&json), Err(CoreError::UnsupportedVersion)),
                "{marker}"
            );
        }
        // null means "no migration" and stays allowed.
        let mut json = to_value(&sample());
        json["migration"] = Value::Null;
        assert!(parse_value(&json).is_ok());
    }

    #[test]
    fn out_of_bounds_kdf_refused() {
        for (field, value) in [("memory_kib", 1), ("iterations", 99), ("parallelism", 1)] {
            let mut json = to_value(&sample());
            json["slots"][0]["kdf"][field] = value.into();
            assert!(
                matches!(parse_value(&json), Err(CoreError::ParamsOutOfBounds)),
                "{field}"
            );
        }
    }

    #[test]
    fn slot_rules_enforced() {
        fn damaged(h: &VaultHeader) -> bool {
            matches!(parse_value(&to_value(h)), Err(CoreError::Damaged { .. }))
        }
        let edits: [(&str, Edit); 7] = [
            ("no slots", |h| h.slots.clear()),
            ("missing recovery slot", |h| h.slots.truncate(1)),
            ("missing password slot", |h| {
                h.slots.remove(0);
            }),
            ("duplicate password slot", |h| {
                h.slots.push(h.slots[0].clone());
            }),
            ("duplicate recovery slot", |h| {
                h.slots.push(h.slots[1].clone());
            }),
            ("password slot without kdf", |h| h.slots[0].kdf = None),
            ("recovery slot with kdf", |h| {
                h.slots[1].kdf = h.slots[0].kdf
            }),
        ];
        for (what, edit) in edits {
            let mut h = sample();
            edit(&mut h);
            assert!(damaged(&h), "{what}");
        }
        // Either order is fine.
        let mut swapped = sample();
        swapped.slots.reverse();
        assert!(parse_value(&to_value(&swapped)).is_ok());
    }

    #[test]
    fn errors_never_echo_content() {
        let mut json = to_value(&sample());
        json["name"] = "SECRET-MARKER".into();
        json["extra"] = "SECRET-MARKER".into();
        let err = parse_value(&json).unwrap_err();
        assert!(!format!("{err} {err:?}").contains("SECRET-MARKER"));
    }

    #[test]
    fn mac_message_golden_bytes() {
        // Built by hand (not via encode_ad) so field order and the empty-migration rule are pinned.
        let field = |out: &mut Vec<u8>, bytes: &[u8]| {
            out.extend((bytes.len() as u32).to_le_bytes());
            out.extend(bytes);
        };
        let mut h = sample();
        let mut expected = b"lockbox/header".to_vec();
        field(&mut expected, b"My Vault");
        field(&mut expected, &[1, 0]); // container_version, u16 LE
        field(&mut expected, &[]); // no migration: the field is still there, zero-length
        field(&mut expected, b"2026-10-09T12:00:00Z");
        field(&mut expected, &[0x11; 16]); // vault_id as raw bytes
        assert_eq!(mac_message(&h), expected);

        h.migration = Some(Migration { from: 1, to: 2 });
        let mut expected = b"lockbox/header".to_vec();
        field(&mut expected, b"My Vault");
        field(&mut expected, &[1, 0]);
        field(&mut expected, br#"{"from":1,"to":2}"#);
        field(&mut expected, b"2026-10-09T12:00:00Z");
        field(&mut expected, &[0x11; 16]);
        assert_eq!(mac_message(&h), expected);
    }

    #[test]
    fn header_mac_known_answers() {
        // Computed independently with Python 3 (stdlib only), not from this code:
        //
        //   import hmac, hashlib, struct
        //   def ad(label, fields):
        //       out = label.encode()
        //       for f in fields: out += struct.pack("<I", len(f)) + f
        //       return out
        //   vault_key = bytes(range(32))
        //   # HKDF-SHA256 (RFC 5869): empty salt = 32 zero bytes; 32 bytes out = one block
        //   prk = hmac.new(b"\x00" * 32, vault_key, hashlib.sha256).digest()
        //   mac_key = hmac.new(prk, b"lockbox header mac v1" + b"\x01", hashlib.sha256).digest()
        //   def tag(migration):
        //       msg = ad("lockbox/header", [b"My Vault", struct.pack("<H", 1), migration,
        //                b"2026-10-09T12:00:00Z", bytes([0x11] * 16)])
        //       return hmac.new(mac_key, msg, hashlib.sha256).hexdigest()
        //   print(tag(b""))                    # no migration
        //   print(tag(b'{"from":1,"to":2}'))   # migration 1 -> 2
        let mut h = sample();
        assert_eq!(
            hex(&header_mac(&h, &kat_key())),
            "728117f13deae4457d837651c99f20105a2a94a32168719b2213e9b6b1333087"
        );
        h.migration = Some(Migration { from: 1, to: 2 });
        assert_eq!(
            hex(&header_mac(&h, &kat_key())),
            "0492b32164aa45866178c084a32a4fd0cdd4fb5cff24fc8d1198408fbd4673bd"
        );
    }

    #[test]
    fn mac_verifies_and_needs_the_right_key() {
        let mut h = sample();
        assert!(!verify_header_mac(&h, &kat_key()), "no MAC stored");
        h.header_mac = Some(header_mac(&h, &kat_key()));
        assert!(verify_header_mac(&h, &kat_key()));
        assert!(!verify_header_mac(&h, &Key32::from_bytes([5; 32])));
        h.header_mac.as_mut().unwrap()[31] ^= 1;
        assert!(!verify_header_mac(&h, &kat_key()));
    }

    #[test]
    fn mac_detects_renamed_vault() {
        let mut h = sample();
        h.header_mac = Some(header_mac(&h, &kat_key()));
        h.name = "Other".to_owned();
        assert!(!verify_header_mac(&h, &kat_key()));
    }

    #[test]
    fn mac_covers_every_non_slot_field() {
        let mut h = sample();
        h.header_mac = Some(header_mac(&h, &kat_key()));
        let edits: [(&str, Edit); 4] = [
            ("created_at", |h| h.created_at.push('x')),
            ("vault_id", |h| h.vault_id.0[0] ^= 1),
            ("container_version", |h| h.container_version = 2),
            ("migration", |h| {
                h.migration = Some(Migration { from: 1, to: 2 });
            }),
        ];
        for (what, edit) in edits {
            let mut bad = h.clone();
            edit(&mut bad);
            assert!(!verify_header_mac(&bad, &kat_key()), "{what}");
        }
    }

    #[test]
    fn mac_ignores_slot_changes() {
        let mut h = sample();
        h.header_mac = Some(header_mac(&h, &kat_key()));
        h.slots[0].salt[0] ^= 1;
        h.slots.reverse();
        assert!(verify_header_mac(&h, &kat_key()));
    }

    #[test]
    fn write_headers_refuses_oversized_and_leaves_files_alone() {
        let dir = TempDir::new();
        let read = |name: &str| std::fs::read(dir.path().join(name)).unwrap();
        let mut h = sample();
        write_headers(dir.path(), &h).unwrap();
        let (main, bak) = (read("vault.json"), read("vault.json.bak"));

        // Just over the limit once pretty-printed (the limit applies to the written bytes).
        h.name = "x".repeat(MAX_HEADER_BYTES);
        assert!(serialize_header(&h).len() > MAX_HEADER_BYTES);
        assert!(matches!(
            write_headers(dir.path(), &h),
            Err(CoreError::TooLarge { .. })
        ));
        assert_eq!(read("vault.json"), main);
        assert_eq!(read("vault.json.bak"), bak);
        let leftovers = std::fs::read_dir(dir.path()).unwrap().count();
        assert_eq!(leftovers, 2, "no stray temp files");

        // The largest header that still parses is accepted.
        let base = serialize_header(&sample_with("")).len();
        h.name = "x".repeat(MAX_HEADER_BYTES - base);
        assert_eq!(serialize_header(&h).len(), MAX_HEADER_BYTES);
        write_headers(dir.path(), &h).unwrap();
        assert!(parse_header(&read("vault.json")).is_ok());
    }

    #[test]
    fn write_headers_writes_identical_files() {
        let dir = TempDir::new();
        let read = |name: &str| std::fs::read(dir.path().join(name)).unwrap();
        let mut h = sample();
        h.header_mac = Some(header_mac(&h, &kat_key()));
        write_headers(dir.path(), &h).unwrap();
        assert_eq!(read("vault.json"), read("vault.json.bak"));
        assert_eq!(read("vault.json"), serialize_header(&h));
        assert!(parse_header(&read("vault.json")).is_ok());
        // Writing again replaces both.
        h.name = "Renamed".to_owned();
        write_headers(dir.path(), &h).unwrap();
        assert_eq!(read("vault.json"), serialize_header(&h));
        assert_eq!(read("vault.json.bak"), serialize_header(&h));
    }
}
