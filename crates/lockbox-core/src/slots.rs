//! Key slots (spec 5): the vault key, wrapped under a key derived from the password
//! or the recovery secret. Everything that identifies the slot is bound into the
//! encryption as associated data, so editing any of it makes unwrapping fail.

use crate::ad::{encode_ad, v16};
use crate::error::{CoreError, Result};
use crate::ids::VaultId;
use crate::kdf::Argon2Params;
use crate::secret::{Key32, random_bytes};
use chacha20poly1305::XChaCha20Poly1305;
use chacha20poly1305::aead::{AeadInOut, KeyInit};
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

/// The slot format version written today. It is part of the AD, not the container
/// version, so routine container upgrades never re-wrap slots.
pub const SLOT_VERSION: u16 = 1;

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum SlotType {
    Password,
    Recovery,
}

impl SlotType {
    fn as_str(self) -> &'static str {
        match self {
            Self::Password => "password",
            Self::Recovery => "recovery",
        }
    }
}

/// One wrapped copy of the vault key, as stored in `vault.json`. Nothing here is secret.
/// `kdf` is `None` for slots whose key does not come from a password hash.
#[derive(Serialize, Deserialize, Clone, PartialEq, Eq, Debug)]
#[serde(deny_unknown_fields)]
pub struct KeySlot {
    #[serde(rename = "type")]
    pub slot_type: SlotType,
    pub slot_version: u16,
    #[serde(with = "crate::serde_b64")]
    pub salt: [u8; 16],
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kdf: Option<Argon2Params>,
    #[serde(with = "crate::serde_b64")]
    pub nonce: [u8; 24],
    #[serde(with = "crate::serde_b64")]
    pub ciphertext: Vec<u8>,
}

/// The authenticated data for a slot: its own version, vault, type, salt and KDF settings.
fn slot_ad(
    slot_version: u16,
    vault_id: &VaultId,
    slot_type: SlotType,
    salt: &[u8; 16],
    kdf: Option<&Argon2Params>,
) -> Vec<u8> {
    let kdf_bytes = kdf.map(Argon2Params::to_ad_bytes);
    encode_ad(
        "lockbox/slot",
        &[
            &v16(slot_version),
            &vault_id.0,
            slot_type.as_str().as_bytes(),
            salt,
            kdf_bytes.as_ref().map_or(&[][..], |b| &b[..]),
        ],
    )
}

fn seal(
    plaintext: &[u8],
    slot_type: SlotType,
    vault_id: &VaultId,
    salt: [u8; 16],
    kdf: Option<Argon2Params>,
    slot_key: &Key32,
) -> KeySlot {
    let nonce = random_bytes::<24>();
    let ad = slot_ad(SLOT_VERSION, vault_id, slot_type, &salt, kdf.as_ref());
    // Room for the 16-byte tag, so the buffer never reallocates (and never leaves a stray copy).
    let mut buf = Zeroizing::new(Vec::with_capacity(plaintext.len() + 16));
    buf.extend_from_slice(plaintext);
    XChaCha20Poly1305::new(slot_key.as_bytes().into())
        .encrypt_in_place(&nonce.into(), &ad, &mut *buf)
        // Only fails for inputs beyond the cipher's length limits; ours are tiny.
        .expect("encrypting a key-sized plaintext cannot fail");
    KeySlot {
        slot_type,
        slot_version: SLOT_VERSION,
        salt,
        kdf,
        nonce,
        ciphertext: buf.to_vec(),
    }
}

/// Wraps `vault_key` under `slot_key` with a fresh random nonce.
pub fn wrap_slot(
    slot_type: SlotType,
    vault_id: &VaultId,
    salt: [u8; 16],
    kdf: Option<Argon2Params>,
    slot_key: &Key32,
    vault_key: &Key32,
) -> KeySlot {
    seal(
        vault_key.as_bytes(),
        slot_type,
        vault_id,
        salt,
        kdf,
        slot_key,
    )
}

/// Recovers the vault key. Any failure to authenticate (wrong key, other vault, or an
/// edited slot) is reported as `WrongPassword`; the cipher cannot tell these apart.
/// Does not validate `slot.kdf`: whoever derives `slot_key` from it must do that first.
pub fn unwrap_slot(slot: &KeySlot, vault_id: &VaultId, slot_key: &Key32) -> Result<Key32> {
    if slot.slot_version != SLOT_VERSION {
        return Err(CoreError::UnsupportedVersion);
    }
    let ad = slot_ad(
        slot.slot_version,
        vault_id,
        slot.slot_type,
        &slot.salt,
        slot.kdf.as_ref(),
    );
    let mut buf = Zeroizing::new(slot.ciphertext.clone());
    XChaCha20Poly1305::new(slot_key.as_bytes().into())
        .decrypt_in_place(&slot.nonce.into(), &ad, &mut *buf)
        .map_err(|_| CoreError::WrongPassword)?;
    Key32::fill_with(|key| {
        if buf.len() != key.len() {
            return Err(CoreError::Damaged { what: "key slot" });
        }
        key.copy_from_slice(&buf);
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use chacha20poly1305::aead::{Aead, Payload};

    fn hex(s: &str) -> Vec<u8> {
        let digits: Vec<u8> = s.bytes().filter(|b| !b.is_ascii_whitespace()).collect();
        digits
            .chunks(2)
            .map(|p| u8::from_str_radix(std::str::from_utf8(p).unwrap(), 16).unwrap())
            .collect()
    }

    /// draft-irtf-cfrg-xchacha-03, appendix A.3.1 (hex copied from the draft text).
    #[test]
    fn xchacha20poly1305_known_answer() {
        let plaintext = hex(
            "4c616469657320616e642047656e746c656d656e206f662074686520636c6173
             73206f66202739393a204966204920636f756c64206f6666657220796f75206f
             6e6c79206f6e652074697020666f7220746865206675747572652c2073756e73
             637265656e20776f756c642062652069742e",
        );
        let aad = hex("50515253c0c1c2c3c4c5c6c7");
        let key = hex("808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f");
        let iv = hex("404142434445464748494a4b4c4d4e4f5051525354555657");
        let expected = hex(
            "bd6d179d3e83d43b9576579493c0e939572a1700252bfaccbed2902c21396cbb
             731c7f1b0b4aa6440bf3a82f4eda7e39ae64c6708c54c216cb96b72e1213b452
             2f8c9ba40db5d945b11b69b982c1bb9e3f3fac2bc369488f76b2383565d3fff9
             21f9664c97637da9768812f615c68b13b52e
             c0875924c1c7987947deafd8780acf49",
        );

        let key: [u8; 32] = key.try_into().unwrap();
        let iv: [u8; 24] = iv.try_into().unwrap();
        let out = XChaCha20Poly1305::new((&key).into())
            .encrypt(
                (&iv).into(),
                Payload {
                    msg: &plaintext,
                    aad: &aad,
                },
            )
            .unwrap();
        assert_eq!(out, expected);
    }

    fn sample() -> (VaultId, Key32, Key32, KeySlot) {
        let vault_id = VaultId([7; 16]);
        let slot_key = Key32::from_bytes([1; 32]);
        let vault_key = Key32::from_bytes([2; 32]);
        let kdf = Argon2Params {
            memory_kib: 65_536,
            iterations: 3,
            parallelism: 4,
        };
        let slot = wrap_slot(
            SlotType::Password,
            &vault_id,
            [9; 16],
            Some(kdf),
            &slot_key,
            &vault_key,
        );
        (vault_id, slot_key, vault_key, slot)
    }

    #[test]
    fn wrap_unwrap_round_trip() {
        let (vault_id, slot_key, vault_key, slot) = sample();
        assert_eq!(slot.slot_version, SLOT_VERSION);
        assert_eq!(slot.ciphertext.len(), 32 + 16);
        let back = unwrap_slot(&slot, &vault_id, &slot_key).unwrap();
        assert_eq!(back.as_bytes(), vault_key.as_bytes());
    }

    #[test]
    fn nonces_are_fresh_per_wrap() {
        let (vault_id, slot_key, vault_key, slot) = sample();
        let again = wrap_slot(
            SlotType::Password,
            &vault_id,
            slot.salt,
            slot.kdf,
            &slot_key,
            &vault_key,
        );
        assert_ne!(slot.nonce, again.nonce);
    }

    #[test]
    fn wrong_key_is_wrong_password() {
        let (vault_id, _, _, slot) = sample();
        let other = Key32::from_bytes([3; 32]);
        assert!(matches!(
            unwrap_slot(&slot, &vault_id, &other),
            Err(CoreError::WrongPassword)
        ));
    }

    #[test]
    fn bound_to_vault() {
        let (_, slot_key, _, slot) = sample();
        assert!(matches!(
            unwrap_slot(&slot, &VaultId([8; 16]), &slot_key),
            Err(CoreError::WrongPassword)
        ));
    }

    #[test]
    fn slot_ad_golden_bytes() {
        // Built by hand (not via encode_ad) so field order and the empty-field rule are pinned.
        let field = |out: &mut Vec<u8>, bytes: &[u8]| {
            out.extend((bytes.len() as u32).to_le_bytes());
            out.extend(bytes);
        };
        let vault_id = VaultId([0x11; 16]);
        let salt = [0x22; 16];
        let params = Argon2Params {
            memory_kib: 0x0001_0000,
            iterations: 3,
            parallelism: 4,
        };

        let mut expected = b"lockbox/slot".to_vec();
        field(&mut expected, &[1, 0]); // slot_version, u16 LE
        field(&mut expected, &[0x11; 16]);
        field(&mut expected, b"password");
        field(&mut expected, &[0x22; 16]);
        field(&mut expected, &[0, 0, 1, 0, 3, 0, 0, 0, 4, 0, 0, 0]); // m, t, p as u32 LE
        assert_eq!(
            slot_ad(1, &vault_id, SlotType::Password, &salt, Some(&params)),
            expected
        );

        let mut expected = b"lockbox/slot".to_vec();
        field(&mut expected, &[1, 0]);
        field(&mut expected, &[0x11; 16]);
        field(&mut expected, b"recovery");
        field(&mut expected, &[0x22; 16]);
        field(&mut expected, &[]); // no kdf: the field is still there, zero-length
        assert_eq!(
            slot_ad(1, &vault_id, SlotType::Recovery, &salt, None),
            expected
        );
    }

    #[test]
    fn tamper_detected() {
        let (vault_id, slot_key, _, slot) = sample();
        type Edit = fn(&mut KeySlot);
        let edits: [(&str, Edit); 6] = [
            ("ciphertext", |s| s.ciphertext[0] ^= 1),
            ("nonce", |s| s.nonce[0] ^= 1),
            ("salt", |s| s.salt[0] ^= 1),
            ("kdf.iterations", |s| {
                s.kdf.as_mut().unwrap().iterations ^= 1;
            }),
            ("slot_type", |s| s.slot_type = SlotType::Recovery),
            ("kdf removed", |s| s.kdf = None),
        ];
        for (what, edit) in edits {
            let mut bad = slot.clone();
            edit(&mut bad);
            assert!(
                matches!(
                    unwrap_slot(&bad, &vault_id, &slot_key),
                    Err(CoreError::WrongPassword)
                ),
                "{what}"
            );
        }
        // A slot wrapped without kdf must not unwrap once a kdf is added.
        let no_kdf = wrap_slot(
            SlotType::Recovery,
            &vault_id,
            [9; 16],
            None,
            &slot_key,
            &Key32::from_bytes([2; 32]),
        );
        let mut added = no_kdf.clone();
        added.kdf = sample().3.kdf;
        assert!(matches!(
            unwrap_slot(&added, &vault_id, &slot_key),
            Err(CoreError::WrongPassword)
        ));
        // A cut-short ciphertext is also just a failed unwrap.
        let mut short = slot.clone();
        short.ciphertext.truncate(10);
        assert!(matches!(
            unwrap_slot(&short, &vault_id, &slot_key),
            Err(CoreError::WrongPassword)
        ));
    }

    #[test]
    fn unknown_slot_version_is_unsupported() {
        let (vault_id, slot_key, _, mut slot) = sample();
        slot.slot_version = SLOT_VERSION + 1;
        assert!(matches!(
            unwrap_slot(&slot, &vault_id, &slot_key),
            Err(CoreError::UnsupportedVersion)
        ));
    }

    #[test]
    fn wrong_size_plaintext_is_damaged() {
        let vault_id = VaultId([7; 16]);
        let slot_key = Key32::from_bytes([1; 32]);
        for len in [31, 33] {
            let plaintext = vec![5u8; len];
            let slot = seal(
                &plaintext,
                SlotType::Recovery,
                &vault_id,
                [9; 16],
                None,
                &slot_key,
            );
            assert!(matches!(
                unwrap_slot(&slot, &vault_id, &slot_key),
                Err(CoreError::Damaged { what: "key slot" })
            ));
        }
    }

    #[test]
    fn recovery_slot_without_kdf_round_trips_through_json() {
        let vault_id = VaultId([7; 16]);
        let slot_key = Key32::from_bytes([1; 32]);
        let vault_key = Key32::from_bytes([2; 32]);
        let slot = wrap_slot(
            SlotType::Recovery,
            &vault_id,
            [9; 16],
            None,
            &slot_key,
            &vault_key,
        );
        let json = serde_json::to_value(&slot).unwrap();
        assert_eq!(json["type"], "recovery");
        assert!(json.get("kdf").is_none());
        assert_eq!(json["salt"].as_str().unwrap().len(), 24); // 16 bytes -> padded base64
        let back: KeySlot = serde_json::from_value(json).unwrap();
        let key = unwrap_slot(&back, &vault_id, &slot_key).unwrap();
        assert_eq!(key.as_bytes(), vault_key.as_bytes());
    }

    #[test]
    fn unknown_json_fields_are_rejected() {
        let (_, _, _, slot) = sample();
        let mut json = serde_json::to_value(&slot).unwrap();
        json["extra"] = 1.into();
        assert!(serde_json::from_value::<KeySlot>(json).is_err());
    }
}
