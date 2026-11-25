//! Help (task 36): opens the guide in the person's own browser. The address is fixed here, in the shell. The command takes no
//! input at all, so nothing from the page can reach the launcher; the page can only ask for "the guide".

use std::io;
use std::sync::{Arc, LazyLock};

use tauri::State;
use tauri::ipc::Request;

use super::{NoArgs, args, blocking};
use crate::error::{GUIDE_NOT_OPENED, ShellResult};
use crate::os::Launcher;
use crate::shell::Shell;

/// The address of the guide: its text, checked by the tests to be this one `https` address.
const GUIDE_ADDRESS: &str =
    "https://github.com/sumguywhowantstobuild/lockbox/blob/main/docs/GUIDE.md";

/// The guide's address, parsed once. The launcher is handed this parsed form, as it is for a website of a login.
pub static GUIDE_URL: LazyLock<tauri::Url> = LazyLock::new(|| {
    GUIDE_ADDRESS
        .parse()
        .expect("the guide's address is a valid URL")
});

/// Opens the guide in the default browser. Used by Help, and by the notice shown when Petalock can't start.
pub fn open_guide(launcher: &dyn Launcher) -> io::Result<()> {
    launcher.open_url(&GUIDE_URL)
}

impl Shell {
    /// Help: opens the guide. The launch may wait for Windows, so no session or vault is held; a failure is the shell's
    /// refusal ([`GUIDE_NOT_OPENED`]), which carries no address.
    pub fn open_help(&self) -> ShellResult<()> {
        open_guide(&*self.os.launcher).map_err(|_| GUIDE_NOT_OPENED)
    }
}

#[tauri::command]
pub(super) async fn open_help(
    shell: State<'_, Arc<Shell>>,
    request: Request<'_>,
) -> ShellResult<()> {
    let NoArgs {} = args(&request)?;
    let shell = Arc::clone(&shell);
    blocking(move || shell.open_help()).await
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};
    use tauri::ipc::{CallbackFn, InvokeBody};
    use tauri::test::{INVOKE_KEY, MockRuntime, get_ipc_response, mock_builder};
    use tauri::webview::InvokeRequest;
    use tauri::{App, Manager, WebviewWindow};

    use super::*;
    use crate::commands::handler;
    use crate::testing::{FakeLauncher, TestShell};
    use crate::window::main_window;

    fn app_with(ts: &TestShell) -> App<MockRuntime> {
        let app = mock_builder()
            .invoke_handler(handler())
            .build(tauri::generate_context!())
            .expect("the app builds");
        assert!(app.manage(Arc::clone(&ts.shell)));
        app
    }

    /// `cmd` with `body`, sent from the main window as the real page's own origin.
    fn invoke(window: &WebviewWindow<MockRuntime>, cmd: &str, body: Value) -> Result<Value, Value> {
        let request = InvokeRequest {
            cmd: cmd.into(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: "http://tauri.localhost".parse().unwrap(),
            body: InvokeBody::Json(body),
            headers: Default::default(),
            invoke_key: INVOKE_KEY.into(),
        };
        get_ipc_response(window, request).map(|body| body.deserialize().expect("a JSON answer"))
    }

    /// The guide's address is one fixed `https` address on GitHub's own host, and the constant parses to exactly it.
    #[test]
    fn the_guide_address_is_one_fixed_https_address() {
        assert_eq!(
            GUIDE_URL.as_str(),
            "https://github.com/sumguywhowantstobuild/lockbox/blob/main/docs/GUIDE.md"
        );
        assert_eq!(GUIDE_URL.scheme(), "https");
        assert_eq!(GUIDE_URL.host_str(), Some("github.com"));
        assert_eq!(GUIDE_URL.query(), None);
        assert_eq!(GUIDE_URL.fragment(), None);
    }

    /// `open_guide` hands the launcher the parsed guide address, once, and nothing else.
    #[test]
    fn open_guide_gives_the_launcher_the_parsed_address_once() {
        let launcher = FakeLauncher::default();
        open_guide(&launcher).unwrap();
        assert_eq!(launcher.opened(), vec![GUIDE_URL.as_str().to_owned()]);
        assert!(launcher.opened_files().is_empty());
        assert!(launcher.opened_folders().is_empty());
    }

    /// Review Focus 5: Help, through the real command and handler, from the page's two entry points (21g's link and 31a's
    /// row send the same body, `{}`), opens only the fixed `https` address: the fake launcher records exactly that parsed
    /// URL, once for each press, and nothing else.
    #[test]
    fn help_opens_only_the_fixed_https_address() {
        let ts = TestShell::new();
        let app = app_with(&ts);
        let main = main_window(app.handle()).expect("the main window builds");
        let fixed = "https://github.com/sumguywhowantstobuild/lockbox/blob/main/docs/GUIDE.md";

        for entry in ["21g's Help link", "31a's Help row"] {
            let before = ts.launcher.opened().len();
            assert_eq!(
                invoke(&main, "open_help", json!({})),
                Ok(Value::Null),
                "{entry}"
            );
            let opened = ts.launcher.opened();
            assert_eq!(opened.len(), before + 1, "{entry}: once");
            assert_eq!(opened.last().map(String::as_str), Some(fixed), "{entry}");
            let parsed: tauri::Url = opened[before].parse().unwrap();
            assert_eq!(parsed.scheme(), "https", "{entry}");
        }
        assert_eq!(ts.launcher.opened(), vec![fixed.to_owned(); 2]);
        assert!(ts.launcher.opened_files().is_empty());
        assert!(ts.launcher.opened_folders().is_empty());
    }

    /// Review Focus 5: a body with any field in it (a URL, a path, a vault) is a malformed request, refused by the decoder
    /// with the one fixed answer; nothing is launched. A body that is not an object is refused too.
    #[test]
    fn open_help_refuses_any_field() {
        let ts = TestShell::new();
        let app = app_with(&ts);
        let main = main_window(app.handle()).expect("the main window builds");
        let malformed = Err(json!({ "code": "invalid_input", "what": "request" }));

        let bodies = [
            json!({ "url": "https://example.invalid/" }),
            json!({ "address": "https://example.invalid/" }),
            json!({ "path": "C:\\Windows\\System32\\calc.exe" }),
            json!({ "url": null }),
            json!({ "session": 1, "generation": 1 }),
            json!({ "": "" }),
            json!("https://example.invalid/"),
            json!(["https://example.invalid/"]),
            Value::Null,
        ];
        let mut refused = 0;
        for body in bodies {
            assert_eq!(
                invoke(&main, "open_help", body.clone()),
                malformed,
                "{body}"
            );
            refused += 1;
        }
        assert_eq!(refused, 9);
        assert!(ts.launcher.opened().is_empty(), "nothing was launched");
        assert!(ts.launcher.opened_files().is_empty());
        assert!(ts.launcher.opened_folders().is_empty());

        // The plain `{}` still works afterwards: the refusals left nothing behind.
        assert_eq!(invoke(&main, "open_help", json!({})), Ok(Value::Null));
        assert_eq!(ts.launcher.opened().len(), 1);
    }

    /// A browser that can't be started is the shell's usual `io` refusal: fixed words, no address, no path.
    #[test]
    fn open_help_says_nothing_of_the_address_when_the_browser_fails() {
        let ts = TestShell::new();
        let app = app_with(&ts);
        let main = main_window(app.handle()).expect("the main window builds");
        ts.launcher.fail_next_url();

        let refused = invoke(&main, "open_help", json!({}));
        // The page words this one refusal as the browser's, so it is told apart from the engine's plain `io` by its `what`.
        assert_eq!(
            refused,
            Err(json!({ "code": "core", "kind": "io", "what": "guide" }))
        );
        let said = refused.unwrap_err().to_string();
        assert!(!said.contains("github"), "{said}");
        // Try again, and it opens.
        assert_eq!(invoke(&main, "open_help", json!({})), Ok(Value::Null));
    }

    /// Help needs no session: it works with no vault open, and a lock of everything changes nothing for it.
    #[test]
    fn help_works_with_no_vault_open() {
        let ts = TestShell::new();
        assert_eq!(ts.shell.open_help(), Ok(()));
        assert_eq!(ts.launcher.opened().len(), 1);
    }
}
