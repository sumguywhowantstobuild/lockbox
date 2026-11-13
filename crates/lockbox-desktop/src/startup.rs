//! Starting with Windows (design, Settings): the current user's `Run` entry, and Windows' own Startup settings, which can
//! turn the entry off. The registry calls are `os::win`'s, behind [`StartupEntry`](crate::os::StartupEntry); what is
//! decided here is plain Rust: the entry's name and its command line, how Windows' own on/off value reads, whether a launch
//! asked to stay hidden, and the two commands' answers.

use std::ffi::{OsStr, OsString};
use std::path::Path;

use serde::Serialize;

use crate::error::{CoreErrorView, ShellError, ShellResult};
use crate::shell::Shell;

/// The `Run` entry's name: the app's product name (`productName` in `tauri.conf.json`), exactly as Tauri's NSIS
/// uninstaller deletes it (`DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${PRODUCTNAME}"`), so
/// removing the app removes the entry too.
pub const RUN_VALUE: &str = "Lockbox";

/// The argument the `Run` entry starts the app with: the window stays hidden, in the tray, until it is opened.
pub const HIDDEN_ARGUMENT: &str = "--hidden";

/// What the page learns of starting with Windows: `{ on, turned_off_in_windows }`. `on` is whether Lockbox's `Run` entry
/// is there. `turned_off_in_windows` is whether Windows' own Startup settings say Lockbox must not start (the person's
/// choice there wins, and Lockbox never writes it): the page then shows it off and says where to turn it on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct StartupState {
    pub on: bool,
    pub turned_off_in_windows: bool,
}

/// The registry could not be read or written. Fixed text only: never the entry's path or data, or Windows' message
/// (R5).
pub const STARTUP_FAILED: ShellError = ShellError::Core(CoreErrorView {
    kind: "io",
    what: Some("startup"),
    needed: None,
    available: None,
    max_file: None,
    min: None,
    position: None,
    found: None,
});

/// Whether Windows' own Startup settings say off, from the data of the entry named [`RUN_VALUE`] under
/// `Explorer\StartupApproved\Run` (`None`: there is no such entry, or it is not binary data). Windows writes 12 bytes: a
/// first byte that is odd (`03`) when the person turned the program off in its Startup settings, `02` (or `00`) when on,
/// then an 8-byte time. Only the first byte is read; a missing or empty entry is not "off".
pub fn approved_is_off(data: Option<&[u8]>) -> bool {
    data.and_then(|data| data.first())
        .is_some_and(|first| first % 2 == 1)
}

/// The state from Lockbox's `Run` entry (`on`: whether it is there) and Windows' own entry for it (`approved`, as for
/// [`approved_is_off`]). Windows' "off" counts only while Lockbox's entry is there: a mark left behind after Lockbox's
/// entry was removed is not something the person can see in Windows' Startup settings, so it is not reported.
pub fn state_of(on: bool, approved: Option<&[u8]>) -> StartupState {
    StartupState {
        on,
        turned_off_in_windows: on && approved_is_off(approved),
    }
}

/// Whether a launch asked to stay hidden: `args` are the process's arguments as `std::env::args_os` gives them, the
/// program first, and the rest is exactly [`HIDDEN_ARGUMENT`]. Any other arguments (more, fewer, another word) are
/// ignored: the window shows as always. The argument only ever affects whether the window shows.
pub fn hidden_launch<S: AsRef<OsStr>>(args: impl IntoIterator<Item = S>) -> bool {
    let mut after_program = args.into_iter().skip(1);
    matches!(
        (after_program.next(), after_program.next()),
        (Some(only), None) if only.as_ref() == OsStr::new(HIDDEN_ARGUMENT)
    )
}

/// The `Run` entry's data for the program at `exe`: the path in quotes, then [`HIDDEN_ARGUMENT`]. `None` for an empty
/// path, or one that holds a quote, which Windows paths cannot and which would end the quoting early.
pub fn run_command(exe: &Path) -> Option<OsString> {
    let path = exe.as_os_str();
    if path.is_empty() || path.to_string_lossy().contains('"') {
        return None;
    }
    let mut command = OsString::from("\"");
    command.push(path);
    command.push("\" ");
    command.push(HIDDEN_ARGUMENT);
    Some(command)
}

impl Shell {
    /// Whether Lockbox starts with Windows, as the registry says now. A registry that cannot be read is
    /// [`STARTUP_FAILED`], whatever Windows said.
    pub fn startup(&self) -> ShellResult<StartupState> {
        self.os.startup.read().map_err(|_| STARTUP_FAILED)
    }

    /// Turns the `Run` entry on or off and answers the state read back: what Windows will do, which is not always what
    /// was asked (the person may have turned it off in Windows' own settings, and Lockbox never undoes that). A
    /// registry that cannot be written, or read back, is [`STARTUP_FAILED`].
    pub fn set_startup(&self, on: bool) -> ShellResult<StartupState> {
        self.os.startup.write(on).map_err(|_| STARTUP_FAILED)?;
        self.startup()
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;
    use crate::testing::TestShell;

    /// The state as the page reads it.
    fn state(on: bool, turned_off_in_windows: bool) -> StartupState {
        StartupState {
            on,
            turned_off_in_windows,
        }
    }

    /// Start with Windows is off until turned on; what the page is told is read from the registry each time, never
    /// remembered: what the person does in Windows' own settings, or another program does, shows at the next read.
    #[test]
    fn startup_reads_the_true_state() {
        let ts = TestShell::new();
        assert_eq!(ts.startup.reads(), 0);
        assert_eq!(ts.shell.startup(), Ok(state(false, false)));
        assert_eq!(ts.startup.reads(), 1, "the state was not read");

        // Turning it on writes the entry, and the answer is what the registry says afterwards.
        assert_eq!(ts.shell.set_startup(true), Ok(state(true, false)));
        assert_eq!(ts.startup.writes(), [true]);
        assert!(ts.startup.entry_present());
        assert_eq!(ts.shell.startup(), Ok(state(true, false)));

        // Turning it off removes it, and an entry that is not there is turned off again without complaint.
        assert_eq!(ts.shell.set_startup(false), Ok(state(false, false)));
        assert_eq!(ts.shell.set_startup(false), Ok(state(false, false)));
        assert_eq!(ts.startup.writes(), [true, false, false]);
        assert!(!ts.startup.entry_present());

        // The registry changed behind Lockbox's back: the next read shows it.
        ts.startup.set_entry_elsewhere(true);
        assert_eq!(ts.shell.startup(), Ok(state(true, false)));
        ts.startup.set_entry_elsewhere(false);
        assert_eq!(ts.shell.startup(), Ok(state(false, false)));
    }

    /// Turned off in Windows' own Startup settings: the answer says so while Lockbox's entry is there, and turning
    /// Lockbox's own switch on does not undo it (Lockbox never writes Windows' setting): the answer still says off. With
    /// the entry removed, the mark Windows left behind is not reported ([`state_of`], which the fake uses too).
    #[test]
    fn startup_turned_off_in_windows_shows_off() {
        let ts = TestShell::new();
        ts.shell.set_startup(true).unwrap();
        ts.startup.turn_off_in_windows();
        assert_eq!(ts.shell.startup(), Ok(state(true, true)));
        assert_eq!(ts.shell.set_startup(true), Ok(state(true, true)));
        assert_eq!(ts.shell.set_startup(false), Ok(state(false, false)));
        assert_eq!(ts.shell.set_startup(true), Ok(state(true, true)));

        // The person turns it back on in Windows.
        ts.startup.turn_on_in_windows();
        assert_eq!(ts.shell.startup(), Ok(state(true, false)));
    }

    /// A registry that cannot be read or written is one fixed refusal, with nothing of Windows' words, the entry's path
    /// or its data in it, however it shows (the page's answer, `Debug`).
    #[test]
    fn startup_failure_is_one_fixed_refusal() {
        let secret = "C:\\Users\\someone\\secret.exe HKCU\\Software 0xDEADBEEF";
        let ts = TestShell::new();
        ts.startup.fail_next_read(secret);
        let refused = ts.shell.startup().unwrap_err();
        assert_eq!(refused, STARTUP_FAILED);
        assert_eq!(
            serde_json::to_value(refused).unwrap(),
            serde_json::json!({ "code": "core", "kind": "io", "what": "startup" })
        );

        ts.startup.fail_next_write(secret);
        assert_eq!(ts.shell.set_startup(true), Err(STARTUP_FAILED));
        assert!(!ts.startup.entry_present(), "a failed write changed it");
        // The read back after a write that went through can fail too: the answer is the same refusal.
        ts.startup.fail_next_read(secret);
        assert_eq!(ts.shell.set_startup(true), Err(STARTUP_FAILED));
        assert!(ts.startup.entry_present(), "the write that went through");
        for error in [
            format!("{refused:?}"),
            serde_json::to_string(&refused).unwrap(),
        ] {
            for leaked in ["secret", "HKCU", "DEAD", "Users"] {
                assert!(!error.contains(leaked), "{leaked} in {error}");
            }
        }
        // Then it works again.
        assert_eq!(ts.shell.startup(), Ok(state(true, false)));
    }

    /// Windows' own on/off value: the first byte decides, odd is off; no entry, no data or an even first byte is on.
    /// Seen on this PC, 2026-11-11: switched off reads `03` and an 8-byte time, on reads `02` or `00` and zeros.
    #[test]
    fn approved_first_byte_decides() {
        let time = [0x1d, 0xa5, 0x2b, 0x3c, 0x4d, 0x5e, 0x6f, 0x70];
        let with = |first: u8| [&[first, 0, 0, 0][..], &time[..]].concat();
        assert!(approved_is_off(Some(&with(0x03))));
        assert!(approved_is_off(Some(&with(0x01))));
        assert!(approved_is_off(Some(&with(0xFF))));
        assert!(!approved_is_off(Some(&with(0x02))));
        assert!(!approved_is_off(Some(&with(0x00))));
        assert!(!approved_is_off(Some(&with(0x06))));
        assert!(!approved_is_off(Some(&[])));
        assert!(!approved_is_off(None));
        // Only the first byte is read: a short or odd-shaped value says what its first byte says.
        assert!(approved_is_off(Some(&[0x03])));
        assert!(!approved_is_off(Some(&[0x02])));
        assert!(!approved_is_off(Some(&[0x02, 0x03, 0x03])));
    }

    /// Windows' "off" is reported only while Lockbox's own entry is there: a mark left behind after the entry was
    /// removed is not shown as "turned off in Windows".
    #[test]
    fn turned_off_in_windows_only_while_the_entry_is_there() {
        let off = [0x03, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8];
        let on = [0x02, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
        assert_eq!(state_of(true, Some(&off)), state(true, true));
        assert_eq!(state_of(false, Some(&off)), state(false, false));
        assert_eq!(state_of(true, Some(&on)), state(true, false));
        assert_eq!(state_of(true, None), state(true, false));
        assert_eq!(state_of(false, None), state(false, false));
    }

    fn args(list: &[&str]) -> Vec<OsString> {
        list.iter().map(OsString::from).collect()
    }

    /// A launch stays hidden only when its arguments after the program are exactly `--hidden`.
    #[test]
    fn hidden_argument_is_exactly_one() {
        assert!(hidden_launch(args(&["lockbox.exe", "--hidden"])));
        assert!(hidden_launch([
            "C:\\Program Files\\Lockbox\\lockbox.exe",
            "--hidden"
        ]));
        // The program's own name is never looked at.
        assert!(hidden_launch(args(&["--hidden", "--hidden"])));
        assert!(hidden_launch(args(&["", "--hidden"])));
    }

    /// Any other arguments are ignored (the window shows as always): none, a different word, the word twice or with
    /// others, another case, a prefix or a longer word, a value attached, the word in the program's place.
    #[test]
    fn other_arguments_ignored() {
        for other in [
            &[][..],
            &["lockbox.exe"],
            &["lockbox.exe", "--HIDDEN"],
            &["lockbox.exe", "--Hidden"],
            &["lockbox.exe", "-hidden"],
            &["lockbox.exe", "hidden"],
            &["lockbox.exe", "--hidden="],
            &["lockbox.exe", "--hidden=true"],
            &["lockbox.exe", "--hidden "],
            &["lockbox.exe", " --hidden"],
            &["lockbox.exe", "--hidde"],
            &["lockbox.exe", "--hiddenx"],
            &["lockbox.exe", ""],
            &["lockbox.exe", "--hidden", "--hidden"],
            &["lockbox.exe", "--hidden", "C:\\vault"],
            &["lockbox.exe", "C:\\vault", "--hidden"],
            &["lockbox.exe", "--visible"],
            &["lockbox.exe", "--hidden\0"],
            &["--hidden"],
        ] {
            assert!(!hidden_launch(args(other)), "{other:?}");
        }
    }

    /// The entry's data is the program's full path in quotes, a space, and `--hidden`; a path with a quote in it is
    /// refused rather than written with its quoting broken.
    #[test]
    fn run_command_quotes_the_path() {
        let exe = PathBuf::from("C:\\Program Files\\Lockbox\\lockbox.exe");
        assert_eq!(
            run_command(&exe),
            Some(OsString::from(
                "\"C:\\Program Files\\Lockbox\\lockbox.exe\" --hidden"
            ))
        );
        let plain = PathBuf::from("C:\\x\\lockbox.exe");
        assert_eq!(
            run_command(&plain),
            Some(OsString::from("\"C:\\x\\lockbox.exe\" --hidden"))
        );
        assert_eq!(run_command(Path::new("C:\\x\"y\\lockbox.exe")), None);
        assert_eq!(run_command(Path::new("")), None);
        // What is written reads back as hidden launch: the program and then the argument.
        assert_eq!(RUN_VALUE, "Lockbox");
    }
}
