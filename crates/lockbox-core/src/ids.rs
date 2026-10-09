//! Random 16-byte IDs, written as 32 lowercase hex characters in file names and JSON.

use crate::{CoreError, Result};
use serde::{Deserialize, Deserializer, Serialize, Serializer};

fn to_hex(bytes: &[u8; 16]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(32);
    for b in bytes {
        s.push(DIGITS[usize::from(b >> 4)] as char);
        s.push(DIGITS[usize::from(b & 0x0f)] as char);
    }
    s
}

fn from_hex(s: &str) -> Result<[u8; 16]> {
    const BAD: CoreError = CoreError::InvalidInput { what: "id" };
    let nibble = |c: u8| match c {
        b'0'..=b'9' => Ok(c - b'0'),
        b'a'..=b'f' => Ok(c - b'a' + 10),
        _ => Err(BAD),
    };
    let s = s.as_bytes();
    if s.len() != 32 {
        return Err(BAD);
    }
    let mut out = [0u8; 16];
    for (byte, pair) in out.iter_mut().zip(s.as_chunks::<2>().0) {
        *byte = nibble(pair[0])? << 4 | nibble(pair[1])?;
    }
    Ok(out)
}

macro_rules! id_type {
    ($name:ident) => {
        #[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Debug)]
        pub struct $name(pub [u8; 16]);

        impl $name {
            pub fn random() -> Self {
                Self(crate::secret::random_bytes())
            }

            pub fn to_hex(&self) -> String {
                to_hex(&self.0)
            }

            pub fn from_hex(s: &str) -> Result<Self> {
                from_hex(s).map(Self)
            }
        }

        impl Serialize for $name {
            fn serialize<S: Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
                s.serialize_str(&self.to_hex())
            }
        }

        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D: Deserializer<'de>>(d: D) -> std::result::Result<Self, D::Error> {
                let s = String::deserialize(d)?;
                Self::from_hex(&s).map_err(serde::de::Error::custom)
            }
        }
    };
}

id_type!(VaultId);
id_type!(ItemId);
id_type!(FileId);

#[cfg(test)]
mod tests {
    use super::*;
    use crate::CoreError;

    #[test]
    fn ids_hex_round_trip_and_reject_bad_hex() {
        let id = VaultId([0xAB; 16]);
        let hex = id.to_hex();
        assert_eq!(hex.len(), 32);
        assert!(
            hex.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        );
        assert_eq!(hex, "ab".repeat(16));
        assert_eq!(VaultId::from_hex(&hex).unwrap(), id);

        let bad_char = format!("zz{}", "00".repeat(15));
        assert!(matches!(
            VaultId::from_hex(&bad_char),
            Err(CoreError::InvalidInput { .. })
        ));
        let too_short = "00".repeat(15);
        assert!(matches!(
            VaultId::from_hex(&too_short),
            Err(CoreError::InvalidInput { .. })
        ));
        let too_long = "00".repeat(17);
        assert!(matches!(
            VaultId::from_hex(&too_long),
            Err(CoreError::InvalidInput { .. })
        ));
        // Uppercase is not the canonical form.
        assert!(matches!(
            VaultId::from_hex(&"AB".repeat(16)),
            Err(CoreError::InvalidInput { .. })
        ));
        // Non-ASCII input must not panic on slicing.
        assert!(matches!(
            VaultId::from_hex(&"é".repeat(16)),
            Err(CoreError::InvalidInput { .. })
        ));
    }

    #[test]
    fn random_ids_differ() {
        assert_ne!(ItemId::random(), ItemId::random());
    }

    #[test]
    fn serde_uses_hex_strings() {
        let id = FileId([1; 16]);
        let json = serde_json::to_string(&id).unwrap();
        assert_eq!(json, format!("\"{}\"", "01".repeat(16)));
        assert_eq!(serde_json::from_str::<FileId>(&json).unwrap(), id);
        assert!(serde_json::from_str::<FileId>("\"nothex\"").is_err());
    }
}
