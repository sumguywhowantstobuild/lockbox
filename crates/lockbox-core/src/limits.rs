//! Cheap size and nesting checks run on untrusted JSON before it is parsed.

use crate::{CoreError, Result};

/// Rejects `bytes` longer than `max_len` (`TooLarge`) or nested deeper than
/// `max_depth` arrays/objects (`Damaged`). Brackets inside JSON strings are ignored.
pub fn check_json(bytes: &[u8], max_len: usize, max_depth: usize) -> Result<()> {
    if bytes.len() > max_len {
        return Err(CoreError::TooLarge { what: "json" });
    }
    let (mut depth, mut in_string, mut escaped) = (0usize, false, false);
    for &b in bytes {
        if in_string {
            match (escaped, b) {
                (true, _) => escaped = false,
                (false, b'\\') => escaped = true,
                (false, b'"') => in_string = false,
                _ => {}
            }
        } else {
            match b {
                b'"' => in_string = true,
                b'[' | b'{' => {
                    depth += 1;
                    if depth > max_depth {
                        return Err(CoreError::Damaged {
                            what: "json nesting",
                        });
                    }
                }
                b']' | b'}' => depth = depth.saturating_sub(1),
                _ => {}
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::CoreError;

    fn nested(depth: usize) -> Vec<u8> {
        let mut v = vec![b'['; depth];
        v.extend(vec![b']'; depth]);
        v
    }

    #[test]
    fn json_depth_33_rejected_32_accepted() {
        assert!(check_json(&nested(32), 1000, 32).is_ok());
        assert!(matches!(
            check_json(&nested(33), 1000, 32),
            Err(CoreError::Damaged { .. })
        ));
    }

    #[test]
    fn json_brackets_inside_strings_ignored() {
        assert!(check_json(br#"{"a":"[[[[[[["}"#, 100, 2).is_ok());
    }

    #[test]
    fn json_escaped_quote_does_not_end_string() {
        // The string is `\"[[[` (escaped quote, then brackets); it must stay a string.
        assert!(check_json(br#"{"a":"\"[[[[[["}"#, 100, 2).is_ok());
        // An escaped backslash before the closing quote does end the string,
        // so the brackets after it count.
        assert!(matches!(
            check_json(br#"{"a":"\\"}[[[["#, 100, 2),
            Err(CoreError::Damaged { .. })
        ));
    }

    #[test]
    fn json_over_length_rejected() {
        assert!(check_json(&[b' '; 10], 10, 32).is_ok());
        assert!(matches!(
            check_json(&[b' '; 11], 10, 32),
            Err(CoreError::TooLarge { .. })
        ));
    }
}
