//! Binary fields in JSON: standard padded base64 (RFC 4648 section 4), used as
//! `#[serde(with = "crate::serde_b64")]` on `[u8; N]` and `Vec<u8>` fields.
//! For non-secret fields only: the intermediate `String` and `Vec` are not wiped.

use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, Deserializer, Serializer, de::Error};

pub fn serialize<S: Serializer, T: AsRef<[u8]>>(bytes: &T, s: S) -> Result<S::Ok, S::Error> {
    s.serialize_str(&STANDARD.encode(bytes))
}

/// Rejects bad base64 and, for fixed-size arrays, any length other than `N`.
/// Error text is fixed so a bad field never echoes its content.
pub fn deserialize<'de, D, T>(d: D) -> Result<T, D::Error>
where
    D: Deserializer<'de>,
    T: TryFrom<Vec<u8>>,
{
    let text = String::deserialize(d)?;
    let bytes = STANDARD
        .decode(text)
        .map_err(|_| D::Error::custom("invalid base64"))?;
    T::try_from(bytes).map_err(|_| D::Error::custom("wrong length"))
}

#[cfg(test)]
mod tests {
    use serde::{Deserialize, Serialize};

    #[derive(Serialize, Deserialize, PartialEq, Debug)]
    struct Probe {
        #[serde(with = "crate::serde_b64")]
        fixed: [u8; 4],
        #[serde(with = "crate::serde_b64")]
        any: Vec<u8>,
    }

    #[test]
    fn round_trips_as_standard_padded_base64() {
        let p = Probe {
            fixed: [0xFB, 0xFF, 0xBF, 0x00],
            any: vec![b'f', b'o'],
        };
        let json = serde_json::to_string(&p).unwrap();
        assert_eq!(json, r#"{"fixed":"+/+/AA==","any":"Zm8="}"#);
        assert_eq!(serde_json::from_str::<Probe>(&json).unwrap(), p);
    }

    #[test]
    fn wrong_length_for_array_is_an_error() {
        // 3 and 5 bytes for a [u8; 4] field: no padding, no truncation.
        for bad in ["AAAA", "AAAAAAA="] {
            let json = format!(r#"{{"fixed":"{bad}","any":""}}"#);
            assert!(serde_json::from_str::<Probe>(&json).is_err(), "{bad}");
        }
    }

    #[test]
    fn rejects_unpadded_url_safe_and_garbage() {
        for bad in ["AAAAAA", "-_-_AA==", "not base64!", "AAAAAA==\\n"] {
            let json = format!(r#"{{"fixed":"AAAAAA==","any":"{bad}"}}"#);
            assert!(serde_json::from_str::<Probe>(&json).is_err(), "{bad:?}");
        }
    }
}
