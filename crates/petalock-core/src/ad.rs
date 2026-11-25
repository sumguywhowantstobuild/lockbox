//! Associated-data (AD) encoding, frozen by test vectors (spec 5.1): an ASCII
//! label, then each field as a 4-byte little-endian length followed by its bytes.

/// Builds the AD bytes for `label` and `fields`.
///
/// # Panics
/// If a field is longer than `u32::MAX` bytes; AD fields are IDs and versions.
pub fn encode_ad(label: &str, fields: &[&[u8]]) -> Vec<u8> {
    let mut out = label.as_bytes().to_vec();
    for field in fields {
        let len = u32::try_from(field.len()).expect("AD field longer than u32::MAX");
        out.extend(len.to_le_bytes());
        out.extend_from_slice(field);
    }
    out
}

/// A version number as 2 little-endian bytes.
pub fn v16(v: u16) -> [u8; 2] {
    v.to_le_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ad_encoding_test_vector() {
        let ad = encode_ad("lockbox/item", &[&v16(1), &[0xAA; 16]]);
        let mut expected = b"lockbox/item".to_vec();
        expected.extend([2, 0, 0, 0, 1, 0]);
        expected.extend([16, 0, 0, 0]);
        expected.extend([0xAA; 16]);
        assert_eq!(ad, expected);
    }

    #[test]
    fn ad_empty_field_has_zero_length() {
        assert_eq!(encode_ad("x", &[&[]]), [b'x', 0, 0, 0, 0]);
    }

    #[test]
    fn v16_is_little_endian() {
        assert_eq!(v16(0x0102), [0x02, 0x01]);
    }
}
