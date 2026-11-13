//! The password and passphrase generator. No vault data: plain answers. The engine checks the options (length, word
//! count, separator) and answers a bad one with `Core(InvalidInput)`.
//!
//! `copy_generated` is the one command here that touches a session: a generated value the page shows and has not saved
//! anywhere goes back to Rust to be copied with the marks and timer of any copy (spec 7.3), owned by the vault on
//! screen. The page's own clipboard could not be used: it skips the marks that keep a value out of Win+V.

use std::sync::Arc;

use lockbox_core::generator::{self, PassphraseOptions, PasswordOptions};
use serde::Deserialize;
use tauri::State;
use tauri::ipc::Request;
use zeroize::Zeroizing;

use super::{args, blocking};
use crate::error::{ShellError, ShellResult};
use crate::session::{SessionId, Tagged};
use crate::shell::Shell;

/// The longest value `copy_generated` takes, in bytes: the generator's own maximum. A password is at most 128
/// characters, all ASCII; a passphrase at most 12 words of at most 16 bytes each (the engine sizes its buffer by
/// that). Anything longer did not come from the generator.
const MAX_GENERATED: usize = 192;

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

impl Shell {
    /// Copies a generated `value` the page holds to the clipboard, in Rust, with the same marks and timer as
    /// `copy_field`, owned by `session` (a lock of it clears the copy). Refused when the session is locked or unknown,
    /// and when `value` is longer than the generator makes (`TooLarge`).
    ///
    /// A read-only session may copy: nothing is written to the vault, and the value is not an item's.
    pub fn copy_generated(
        &self,
        session: SessionId,
        generation: u64,
        value: Zeroizing<String>,
    ) -> ShellResult<Tagged<()>> {
        if value.len() > MAX_GENERATED {
            return Err(ShellError::TooLarge { what: "password" });
        }
        self.clipboard
            .copy(&self.sessions, session, generation, value)?;
        // The generation once more before answering (spec 7.4), as `copy_field` does: a lock after the write, whose
        // hook has cleared the copy, answers `Locked`.
        if !self.unlocked().contains(&(session, generation)) {
            return Err(ShellError::Locked);
        }
        Ok(Tagged {
            session,
            generation,
            data: (),
        })
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CopyGenerated {
    session: SessionId,
    generation: u64,
    value: Zeroizing<String>,
}

#[tauri::command]
pub(super) async fn copy_generated(
    shell: State<'_, Arc<Shell>>,
    request: Request<'_>,
) -> ShellResult<Tagged<()>> {
    let CopyGenerated {
        session,
        generation,
        value,
    } = args(&request)?;
    let shell = Arc::clone(&shell);
    blocking(move || shell.copy_generated(session, generation, value)).await
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
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::time::{Duration, Instant};

    use lockbox_core::blob::CancelToken;
    use lockbox_core::{CoreError, Credential, ReadOnlyVault};
    use serde_json::json;
    use tauri::ipc::InvokeBody;

    use super::super::{MALFORMED, parse};
    use super::*;
    use crate::error::Outcome;
    use crate::os::{Clock, EXCLUSION_FORMATS};
    use crate::session::{Location, LockReason, OpenStep, Opened};
    use crate::settings::Settings;
    use crate::testing::{TestShell, heavy};

    const PW: &str = "correct horse battery";
    /// What the generator shows on 16a: made up, never a real password.
    const VALUE: &str = "demo-Rk7!mQ2z-Vx9p-Lt4w";

    fn secret(text: &str) -> Zeroizing<String> {
        Zeroizing::new(text.to_owned())
    }

    /// A new vault named `name`, created and unlocked through the shell: its session and generation.
    fn open_vault(ts: &TestShell, name: &str) -> (SessionId, u64) {
        let created = heavy(|| ts.shell.create_vault(name.into(), secret(PW), false));
        let Outcome::Done(tagged) = created.unwrap() else {
            panic!("the vault did not open");
        };
        (tagged.session, tagged.generation)
    }

    /// Moves the fake clock to `start + secs` seconds and runs the timers due by then.
    fn at(ts: &TestShell, start: Instant, secs: u64) {
        let when = start + Duration::from_secs(secs);
        ts.clock.set(when);
        ts.timer.run_due(when);
    }

    /// A generated value copies like any password: out of the page's hands into Rust's clipboard write, kept out of
    /// clipboard history and cloud sync (the marks), owned by the vault on screen, and cleared after the settings' delay.
    #[test]
    fn copy_generated_uses_marks_and_timer() {
        let ts = TestShell::new();
        let (s, g) = open_vault(&ts, "Family");
        let start = ts.clock.now();
        let answer = ts.shell.copy_generated(s, g, secret(VALUE)).unwrap();
        assert_eq!((answer.session, answer.generation), (s, g));
        // The answer carries no value.
        assert_eq!(
            serde_json::to_value(&answer).unwrap(),
            json!({ "session": s.0, "generation": g, "data": null })
        );
        assert_eq!(ts.clipboard.text().as_deref(), Some(VALUE));
        assert_eq!(ts.clipboard.formats(), EXCLUSION_FORMATS, "the marks");
        assert_eq!(ts.shell.clipboard.owner(), Some(s));
        at(&ts, start, 29);
        assert_eq!(ts.clipboard.text().as_deref(), Some(VALUE), "cleared early");
        at(&ts, start, 30);
        assert_eq!(ts.clipboard.text(), None, "not cleared at 30 s");
        assert_eq!(ts.shell.clipboard.owner(), None);

        // The delay is the settings' own, read at each copy.
        ts.shell
            .settings
            .set(Settings {
                clipboard_seconds: 10,
                ..Settings::default()
            })
            .unwrap();
        let start = ts.clock.now();
        ts.shell.copy_generated(s, g, secret(VALUE)).unwrap();
        at(&ts, start, 9);
        assert_eq!(ts.clipboard.text().as_deref(), Some(VALUE), "cleared early");
        at(&ts, start, 10);
        assert_eq!(ts.clipboard.text(), None, "not cleared at 10 s");

        // Something the person copied since is left alone, as for any copy.
        let start = ts.clock.now();
        ts.shell.copy_generated(s, g, secret(VALUE)).unwrap();
        assert!(ts.clipboard.user_copy("mine"));
        at(&ts, start, 10);
        assert_eq!(ts.clipboard.text().as_deref(), Some("mine"));
    }

    /// The vault locking clears the copy, and only its own vault's lock does.
    #[test]
    fn copy_generated_clears_on_lock() {
        let ts = TestShell::new();
        let (a, ga) = open_vault(&ts, "Family");
        let (b, _) = open_vault(&ts, "Work");
        ts.shell.copy_generated(a, ga, secret(VALUE)).unwrap();
        ts.shell.sessions.lock(b, LockReason::Manual);
        assert_eq!(
            ts.clipboard.text().as_deref(),
            Some(VALUE),
            "another vault's lock cleared it"
        );
        assert_eq!(ts.shell.clipboard.owner(), Some(a));
        ts.shell.sessions.lock(a, LockReason::Manual);
        assert_eq!(ts.clipboard.text(), None, "its own vault's lock left it");
        assert_eq!(ts.shell.clipboard.owner(), None);

        let (c, gc) = open_vault(&ts, "Third");
        ts.shell.copy_generated(c, gc, secret(VALUE)).unwrap();
        ts.shell.sessions.lock_all(LockReason::Idle);
        assert_eq!(ts.clipboard.text(), None, "Lock all left it");
        assert_eq!(ts.shell.clipboard.owner(), None);

        // A lock that comes right after the write, before the answer: `Locked`, and nothing left on the clipboard.
        let (d, gd) = open_vault(&ts, "Fourth");
        let shell = Arc::clone(&ts.shell);
        ts.shell.clipboard.after_next_write(Box::new(move || {
            shell.sessions.lock_all(LockReason::Manual);
        }));
        assert_eq!(
            ts.shell.copy_generated(d, gd, secret(VALUE)).err(),
            Some(ShellError::Locked)
        );
        assert_eq!(ts.clipboard.text(), None);
    }

    /// A locked session (its old generation, or one it never had) and a session that was never issued are refused,
    /// and nothing reaches the clipboard: not even an opening of it.
    #[test]
    fn copy_generated_refused_stale() {
        let ts = TestShell::new();
        let (s, g) = open_vault(&ts, "Family");
        assert!(ts.clipboard.user_copy("theirs"));
        let opens = ts.clipboard.opens();
        let never_issued = SessionId(u64::MAX);
        for (session, generation, refusal) in [
            (s, g + 1, ShellError::Locked),
            (never_issued, g, ShellError::NotFound),
        ] {
            assert_eq!(
                ts.shell
                    .copy_generated(session, generation, secret(VALUE))
                    .err(),
                Some(refusal)
            );
        }
        ts.shell.sessions.lock(s, LockReason::Manual);
        assert_eq!(
            ts.shell.copy_generated(s, g, secret(VALUE)).err(),
            Some(ShellError::Locked)
        );
        assert_eq!(ts.clipboard.text().as_deref(), Some("theirs"));
        assert_eq!(
            ts.clipboard.opens(),
            opens,
            "a refusal opened the clipboard"
        );
    }

    /// The vault's folder: every file under it with its size, so a test can see that nothing was written.
    fn files_of(dir: &Path) -> Vec<(PathBuf, u64)> {
        let mut found = Vec::new();
        let mut stack = vec![dir.to_path_buf()];
        while let Some(folder) = stack.pop() {
            for entry in fs::read_dir(&folder).unwrap() {
                let entry = entry.unwrap();
                match entry.metadata().unwrap() {
                    meta if meta.is_dir() => stack.push(entry.path()),
                    meta => found.push((entry.path(), meta.len())),
                }
            }
        }
        found.sort();
        found
    }

    /// A read-only session may copy: it writes nothing to the vault, and the value is not an item's. (Every command
    /// that writes is refused there; this one writes only to the clipboard.)
    #[test]
    fn copy_generated_on_a_read_only_session_copies_and_writes_nothing() {
        let ts = TestShell::new();
        let (s, _) = open_vault(&ts, "Family");
        let dir = ts.shell.registry.entries()[0].1.clone();
        ts.shell.sessions.lock(s, LockReason::Manual);
        let vault = heavy(|| {
            ReadOnlyVault::open_folder(&dir, Credential::Password(PW), &CancelToken::new())
        })
        .unwrap();
        let location = Location::folder(&dir).unwrap();
        let opened = ts.shell.sessions.open(Some(location.clone()), None, |_| {
            Ok(OpenStep::Session(location, Opened::ReadOnly(vault), ()))
        });
        let Ok(Outcome::Done(tagged)) = opened else {
            panic!("the read-only session did not open");
        };
        let before = files_of(&dir);
        ts.shell
            .copy_generated(tagged.session, tagged.generation, secret(VALUE))
            .unwrap();
        assert_eq!(ts.clipboard.text().as_deref(), Some(VALUE));
        assert_eq!(files_of(&dir), before, "the vault's folder changed");
        ts.shell.sessions.lock_all(LockReason::Manual);
        assert_eq!(ts.clipboard.text(), None);
    }

    /// Only what the generator can make: up to its longest value, in bytes. Longer did not come from it (`TooLarge`).
    #[test]
    fn copy_generated_refused_when_too_long() {
        let ts = TestShell::new();
        let (s, g) = open_vault(&ts, "Family");
        assert!(ts.clipboard.user_copy("theirs"));
        let opens = ts.clipboard.opens();
        let too_large = Some(ShellError::TooLarge { what: "password" });
        for long in ["a".repeat(193), "é".repeat(97), "a".repeat(1 << 20)] {
            assert_eq!(
                ts.shell.copy_generated(s, g, secret(&long)).err(),
                too_large,
                "{} bytes",
                long.len()
            );
        }
        assert_eq!(ts.clipboard.text().as_deref(), Some("theirs"));
        assert_eq!(
            ts.clipboard.opens(),
            opens,
            "a refusal opened the clipboard"
        );

        // The longest the generator makes is copied: 128 characters, and twelve words.
        let longest_password = generator::generate_password(&PasswordOptions {
            length: 128,
            ..PasswordOptions::default()
        })
        .unwrap();
        let longest_phrase = generator::generate_passphrase(&PassphraseOptions {
            words: 12,
            separator: '\u{1F512}',
            capitalize: true,
            include_number: true,
        })
        .unwrap();
        for value in [longest_password, longest_phrase, secret(&"a".repeat(192))] {
            assert!(value.len() <= 192);
            ts.shell.copy_generated(s, g, value.clone()).unwrap();
            assert_eq!(ts.clipboard.text().as_deref(), Some(value.as_str()));
        }
    }

    #[test]
    fn copy_generated_request_is_strict() {
        let body = |value: serde_json::Value| InvokeBody::Json(value);
        let good = json!({ "session": 1, "generation": 1, "value": VALUE });
        assert!(parse::<CopyGenerated>(&body(good.clone())).is_ok());
        let mut extra = good.clone();
        extra["id"] = json!("00");
        let mut missing = good.clone();
        missing.as_object_mut().unwrap().remove("value");
        let mut number = good;
        number["value"] = json!(5);
        for bad in [extra, missing, number] {
            assert_eq!(parse::<CopyGenerated>(&body(bad)).err(), Some(MALFORMED));
        }
    }

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
