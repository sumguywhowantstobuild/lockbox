//! The password and passphrase generator. No vault data: plain answers. The engine checks the options (length, word
//! count, separator) and answers a bad one with `Core(InvalidInput)`.

use lockbox_core::generator::{self, PassphraseOptions, PasswordOptions};
use serde::Deserialize;
use tauri::ipc::Request;
use zeroize::Zeroizing;

use super::{args, blocking};
use crate::error::ShellResult;

/// A generator command's body: `{ "options": { .. } }`.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Generate<T> {
    options: T,
}

/// The engine's `PasswordOptions`, as the page sends them.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PasswordArgs {
    length: u8,
    lowercase: bool,
    uppercase: bool,
    digits: bool,
    symbols: bool,
    avoid_ambiguous: bool,
}

/// The engine's `PassphraseOptions`, as the page sends them.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PassphraseArgs {
    words: u8,
    separator: char,
    capitalize: bool,
    include_number: bool,
}

fn password(options: PasswordArgs) -> ShellResult<Zeroizing<String>> {
    let PasswordArgs {
        length,
        lowercase,
        uppercase,
        digits,
        symbols,
        avoid_ambiguous,
    } = options;
    Ok(generator::generate_password(&PasswordOptions {
        length,
        lowercase,
        uppercase,
        digits,
        symbols,
        avoid_ambiguous,
    })?)
}

fn passphrase(options: PassphraseArgs) -> ShellResult<Zeroizing<String>> {
    let PassphraseArgs {
        words,
        separator,
        capitalize,
        include_number,
    } = options;
    Ok(generator::generate_passphrase(&PassphraseOptions {
        words,
        separator,
        capitalize,
        include_number,
    })?)
}

/// Random draws, and the word list parsed on first use: on the blocking pool, off the async runtime.
#[tauri::command]
pub(super) async fn generate_password(request: Request<'_>) -> ShellResult<Zeroizing<String>> {
    let Generate { options } = args(&request)?;
    blocking(move || password(options)).await
}

#[tauri::command]
pub(super) async fn generate_passphrase(request: Request<'_>) -> ShellResult<Zeroizing<String>> {
    let Generate { options } = args(&request)?;
    blocking(move || passphrase(options)).await
}

#[cfg(test)]
mod tests {
    use lockbox_core::CoreError;
    use serde_json::json;
    use tauri::ipc::InvokeBody;

    use super::super::{MALFORMED, parse};
    use super::*;
    use crate::error::ShellError;

    #[test]
    fn generator_options_reach_the_engine() {
        let generate = |options| {
            let body = InvokeBody::Json(json!({ "options": options }));
            password(parse::<Generate<PasswordArgs>>(&body)?.options)
        };
        let digits_only = json!({
            "length": 32, "lowercase": false, "uppercase": false, "digits": true, "symbols": false,
            "avoid_ambiguous": false,
        });
        let made = generate(digits_only.clone()).unwrap();
        assert_eq!(made.len(), 32);
        assert!(made.chars().all(|c| c.is_ascii_digit()));

        let mut none = digits_only.clone();
        none["digits"] = json!(false);
        assert_eq!(
            generate(none).err(),
            Some(ShellError::from(CoreError::InvalidInput {
                what: "no character class selected"
            }))
        );
        let mut extra = digits_only;
        extra["seed"] = json!(1);
        assert_eq!(generate(extra).err(), Some(MALFORMED));

        let body = InvokeBody::Json(json!({ "options": {
            "words": 4, "separator": "+", "capitalize": false, "include_number": false,
        }}));
        let made = passphrase(parse::<Generate<PassphraseArgs>>(&body).unwrap().options).unwrap();
        assert_eq!(made.split('+').count(), 4);
        assert!(made.chars().all(|c| c == '+' || c.is_ascii_lowercase()));
    }
}
