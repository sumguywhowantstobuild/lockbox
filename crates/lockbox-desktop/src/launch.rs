//! Starting the app, and what the person sees when it can't start (Ask 14). Setup (and the build before it) has one way
//! to fail, [`Failed`], which carries nothing: the error behind it, with any path or name it names, ends where it
//! happens (R5), and the one notice, [`cant_start`], says the same fixed words for every failure.

use std::error::Error;
use std::ffi::OsStr;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::mpsc::{self, Sender};

use tauri::{AppHandle, Manager, Runtime, WebviewWindow};

use crate::commands::guide::open_guide;
use crate::os::{self, Launcher, NoticeAnswer, OsSignal, StartupNotice, StartupWords};
use crate::shell::{Events, Shell};
use crate::{startup, tray, window};

/// The exit code of a Petalock that could not start, whatever the person answered.
pub const EXIT_CANT_START: i32 = 1;

/// The notice, word for word (Ask 14).
pub const CANT_START: StartupWords = StartupWords {
    title: "Petalock",
    text: "Petalock can't start. Your vaults aren't affected. Restart your PC and try again. If that doesn't help, the guide says what to check.",
    open_guide: "Open the guide",
    close: "Close",
};

/// Shows the notice that Petalock can't start, and returns the exit code to end the process with: never zero. Only the
/// "Open the guide" button opens the guide; Close, the title bar's close and Esc do not, and a browser that fails to
/// open changes nothing (the person has read the notice, and there is nothing more to say that is true and fixed).
/// Nothing is passed in about why: no error, path or name can reach the screen.
pub fn cant_start(notice: &dyn StartupNotice, launcher: &dyn Launcher) -> i32 {
    if notice.show(&CANT_START) == NoticeAnswer::OpenGuide {
        let _ = open_guide(launcher);
    }
    EXIT_CANT_START
}

/// Setup (or the build) failed. Carries nothing: see the module's note.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Failed;

/// What a step failed with: dropped as soon as it is returned into a [`Failed`].
pub type StepError = Box<dyn Error>;
type StepResult<T> = Result<T, StepError>;

impl From<StepError> for Failed {
    fn from(_: StepError) -> Failed {
        Failed
    }
}

/// Whether this copy is the app's one running copy.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Claim {
    /// Nothing else runs: this copy goes on.
    Mine,
    /// Another copy runs and has the claim: this one simply ends (the person asked for Petalock and it is there).
    AlreadyRunning,
}

/// The steps of the app's setup that can fail, in the order [`start_up`] takes them, each behind this trait so a test
/// can fail each one. The real ones are [`RealSteps`].
pub trait Steps<R: Runtime> {
    /// The main window, as [`make_window`](Self::make_window) makes it and [`start_window`](Self::start_window) takes it.
    type Window;
    /// Claims being the app's one running copy, and keeps the claim for the life of the process.
    fn claim_instance(&self, app: &AppHandle<R>) -> StepResult<Claim>;
    /// Starts listening to Windows' lock, sleep and drive notices, which go to `sink`, and keeps the listener.
    fn listen_for_windows(&self, app: &AppHandle<R>, sink: Sender<OsSignal>) -> StepResult<()>;
    fn app_data_dir(&self, app: &AppHandle<R>) -> StepResult<PathBuf>;
    fn app_local_data_dir(&self, app: &AppHandle<R>) -> StepResult<PathBuf>;
    /// The shell, over the real OS calls, refusing any vault in `app_dirs`.
    fn make_shell(&self, app: &AppHandle<R>, app_dirs: Vec<PathBuf>) -> StepResult<Arc<Shell>>;
    /// Keeps the shell in the app's state, for the commands.
    fn keep_shell(&self, app: &AppHandle<R>, shell: &Arc<Shell>) -> StepResult<()>;
    /// Hands each Windows signal to the shell.
    fn route_signals(&self, signals: mpsc::Receiver<OsSignal>, shell: Arc<Shell>)
    -> StepResult<()>;
    /// Starts the auto-lock's timer.
    fn start_ticks(&self, shell: Arc<Shell>) -> StepResult<()>;
    /// The icon by the clock.
    fn build_tray(&self, app: &AppHandle<R>) -> StepResult<()>;
    /// The main window, built hidden.
    fn make_window(&self, app: &AppHandle<R>) -> StepResult<Self::Window>;
    /// Puts the window's protections in place and shows it, unless this is a start from Windows' sign-in (`hidden`).
    fn start_window(&self, window: &Self::Window, shell: &Shell, hidden: bool) -> StepResult<()>;
    /// Takes down what could be reached while the notice is up (the icon by the clock): called once, before it.
    fn give_up(&self, app: &AppHandle<R>);
}

/// What a start came to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Started {
    Running,
    /// Another copy runs: this one ends with nothing said.
    HandedOff,
}

/// What [`launch`] came to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Launch {
    Started,
    /// Another copy runs: end with exit code 0, saying nothing.
    HandedOff,
    /// Setup failed and the notice was shown: end with this exit code.
    CantStart(i32),
}

impl Launch {
    /// The exit code to end the process with, or `None` to go on running: what the setup hook does with the outcome.
    pub fn exit_code(self) -> Option<i32> {
        match self {
            Launch::Started => None,
            Launch::HandedOff => Some(0),
            Launch::CantStart(code) => Some(code),
        }
    }
}

/// Setup, in order. The first step that fails ends it with [`Failed`]; no later step runs.
pub fn start_up<R: Runtime, S: Steps<R>>(
    app: &AppHandle<R>,
    steps: &S,
    hidden: bool,
) -> Result<Started, Failed> {
    // First of all, before any launch work: the one copy of the app in this sign-in. The single-instance plugin falls
    // through when its mutex exists but its window does not exist yet, so two copies can reach here, and the second
    // one's launch work would remove the first one's staging folder and temps. Nothing has started in this copy, so
    // it simply ends. Fail closed when Windows will not say.
    if steps.claim_instance(app)? == Claim::AlreadyRunning {
        return Ok(Started::HandedOff);
    }
    // Fail closed: never run without Windows' lock, sleep and drive notices (spec §7.4). The save shortcut is
    // registered last, once the shell exists to answer a press and to tell the page when Windows says no.
    let (sink, signals) = mpsc::channel();
    steps.listen_for_windows(app, sink)?;

    // Before the window, so every command finds it. No vault may live in the folders Tauri keeps for the app, which an
    // uninstaller may delete (spec §6.10).
    let app_dirs = vec![steps.app_data_dir(app)?, steps.app_local_data_dir(app)?];
    let shell = steps.make_shell(app, app_dirs)?;
    // Launch work, here only: a second copy of the app ends before this, so it never recovers or sweeps the first
    // copy's folders. It comes before the shell is kept and before the window exists, so no command can answer before
    // it has run: a half-done restore is settled first (spec §6.8), then the output journal's leftovers (spec §7.2),
    // then the "Open" folders'.
    shell.launch_work();
    steps.keep_shell(app, &shell)?;
    // Fail closed here too: never run without the auto-lock. Signals that came before this wait in the channel.
    steps.route_signals(signals, Arc::clone(&shell))?;
    steps.start_ticks(Arc::clone(&shell))?;

    // The icon by the clock, where the window hides to: fail closed, since a hidden window with no icon could never be
    // reached again.
    steps.build_tray(app)?;

    // The window is built hidden and shown only once its protections are in place. Fail closed as well: never run with
    // files droppable into the page, or with the browser's keys and menu (Ctrl+P, F12, the context menu) able to reach
    // a revealed secret. A start from Windows' sign-in (`hidden`) puts the same protections in place and leaves the
    // window in the tray: the launch work above has run, and its notices wait for the page to ask.
    let window = steps.make_window(app)?;
    steps.start_window(&window, &shell, hidden)?;

    // Last, after every step that can fail: a start that fails never holds the save shortcut (a press of it would read
    // the clipboard while the notice says Petalock can't start). After the route, so a press that comes at once is
    // answered. The app runs whatever Windows says.
    shell.register_save_shortcut();
    Ok(Started::Running)
}

/// The whole of the setup hook: [`start_up`] for a start with these process arguments (`args` as `std::env::args_os`
/// gives them: [`startup::hidden_launch`] reads them), and the notice when it fails: exactly once, after
/// [`Steps::give_up`]. A hand-off to a running copy says nothing.
pub fn launch<R: Runtime, S: Steps<R>, A: AsRef<OsStr>>(
    app: &AppHandle<R>,
    steps: &S,
    notice: &dyn StartupNotice,
    launcher: &dyn Launcher,
    args: impl IntoIterator<Item = A>,
) -> Launch {
    match start_up(app, steps, startup::hidden_launch(args)) {
        Ok(Started::Running) => Launch::Started,
        Ok(Started::HandedOff) => Launch::HandedOff,
        Err(Failed) => {
            steps.give_up(app);
            Launch::CantStart(cant_start(notice, launcher))
        }
    }
}

/// The result of building the app, with the notice for a build that failed: `Err` holds the exit code. The error is
/// dropped unread.
pub fn built<T, E>(
    built: Result<T, E>,
    notice: &dyn StartupNotice,
    launcher: &dyn Launcher,
) -> Result<T, i32> {
    built.map_err(|_| cant_start(notice, launcher))
}

/// Keeps `value` in the app's state; refuses a second of the same type.
fn keep<R: Runtime, T: Send + Sync + 'static>(app: &AppHandle<R>, value: T) -> StepResult<()> {
    match app.manage(value) {
        true => Ok(()),
        false => Err("already kept".into()),
    }
}

/// The real steps.
pub struct RealSteps;

impl<R: Runtime> Steps<R> for RealSteps {
    type Window = WebviewWindow<R>;

    fn claim_instance(&self, app: &AppHandle<R>) -> StepResult<Claim> {
        match os::win::claim_instance()? {
            None => Ok(Claim::AlreadyRunning),
            // For the life of the process: dropping the guard would let a second copy start.
            Some(running) => keep(app, running).map(|()| Claim::Mine),
        }
    }

    fn listen_for_windows(&self, app: &AppHandle<R>, sink: Sender<OsSignal>) -> StepResult<()> {
        // The app's state keeps the signal thread for as long as the app runs: dropping it would stop the notices.
        keep(app, os::win::spawn(sink)?)
    }

    fn app_data_dir(&self, app: &AppHandle<R>) -> StepResult<PathBuf> {
        Ok(app.path().app_data_dir()?)
    }

    fn app_local_data_dir(&self, app: &AppHandle<R>) -> StepResult<PathBuf> {
        Ok(app.path().app_local_data_dir()?)
    }

    fn make_shell(&self, app: &AppHandle<R>, app_dirs: Vec<PathBuf>) -> StepResult<Arc<Shell>> {
        Ok(Shell::new(
            Arc::new(Events(app.clone())),
            os::Os::windows(app.clone()),
            app_dirs,
        )?)
    }

    fn keep_shell(&self, app: &AppHandle<R>, shell: &Arc<Shell>) -> StepResult<()> {
        keep(app, Arc::clone(shell))
    }

    fn route_signals(
        &self,
        signals: mpsc::Receiver<OsSignal>,
        shell: Arc<Shell>,
    ) -> StepResult<()> {
        Ok(crate::route_signals(signals, shell)?)
    }

    fn start_ticks(&self, shell: Arc<Shell>) -> StepResult<()> {
        Ok(crate::start_ticks(shell)?)
    }

    fn build_tray(&self, app: &AppHandle<R>) -> StepResult<()> {
        Ok(tray::build(app)?)
    }

    fn make_window(&self, app: &AppHandle<R>) -> StepResult<WebviewWindow<R>> {
        let window = window::main_window(app)?;
        // The icon for the taskbar Windows shows, on the window and by the clock, changing with Windows' setting.
        crate::app_icon::follow_taskbar(app, &window);
        Ok(window)
    }

    fn start_window(
        &self,
        window: &WebviewWindow<R>,
        shell: &Shell,
        hidden: bool,
    ) -> StepResult<()> {
        window::start_main_window(window, shell, hidden)
            .map_err(|_| "the window stayed hidden".into())
    }

    fn give_up(&self, app: &AppHandle<R>) {
        tray::remove(app);
    }
}

#[cfg(test)]
mod tests {
    use std::ffi::OsString;
    use std::io;
    use std::process::Command;
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use tauri::App;
    use tauri::test::{MockRuntime, mock_builder, mock_context, noop_assets};

    use super::*;
    use crate::commands::guide::GUIDE_URL;
    use crate::lock;
    use crate::testing::{FakeLauncher, FakeNotice, TestShell};

    /// A made-up path and name that an error could carry, and that must never reach the screen, stderr or a log.
    const MARKED_PATH: &str = "C:\\Users\\MU-Marked-Person\\MU-marked-vaults";
    const MARKED_NAME: &str = "MU-Marked-Family-Vault";

    /// Each step that can fail, in the order setup takes them.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    enum Point {
        Claim,
        Listen,
        AppDataDir,
        AppLocalDataDir,
        MakeShell,
        KeepShell,
        RouteSignals,
        StartTicks,
        Tray,
        MakeWindow,
        StartWindow,
    }

    const POINTS: [Point; 11] = [
        Point::Claim,
        Point::Listen,
        Point::AppDataDir,
        Point::AppLocalDataDir,
        Point::MakeShell,
        Point::KeepShell,
        Point::RouteSignals,
        Point::StartTicks,
        Point::Tray,
        Point::MakeWindow,
        Point::StartWindow,
    ];

    /// Setup's steps on fakes: each one records that it ran, and the one named in `fail_at` fails with an error that
    /// carries a marked path and name, as a real one could.
    struct FakeSteps {
        ts: TestShell,
        fail_at: Option<Point>,
        claim: Claim,
        calls: Mutex<Vec<Point>>,
        hidden: Mutex<Option<bool>>,
        gave_up: AtomicUsize,
    }

    impl FakeSteps {
        fn new(fail_at: Option<Point>) -> FakeSteps {
            FakeSteps {
                ts: TestShell::new(),
                fail_at,
                claim: Claim::Mine,
                calls: Mutex::new(Vec::new()),
                hidden: Mutex::new(None),
                gave_up: AtomicUsize::new(0),
            }
        }

        fn step(&self, at: Point) -> StepResult<()> {
            lock(&self.calls).push(at);
            match self.fail_at == Some(at) {
                true => Err(Box::new(io::Error::other(format!(
                    "{MARKED_PATH} {MARKED_NAME}"
                )))),
                false => Ok(()),
            }
        }

        fn calls(&self) -> Vec<Point> {
            lock(&self.calls).clone()
        }
    }

    impl Steps<MockRuntime> for FakeSteps {
        type Window = ();

        fn claim_instance(&self, _: &AppHandle<MockRuntime>) -> StepResult<Claim> {
            self.step(Point::Claim).map(|()| self.claim)
        }

        fn listen_for_windows(
            &self,
            _: &AppHandle<MockRuntime>,
            _: Sender<OsSignal>,
        ) -> StepResult<()> {
            self.step(Point::Listen)
        }

        fn app_data_dir(&self, _: &AppHandle<MockRuntime>) -> StepResult<PathBuf> {
            self.step(Point::AppDataDir).map(|()| PathBuf::new())
        }

        fn app_local_data_dir(&self, _: &AppHandle<MockRuntime>) -> StepResult<PathBuf> {
            self.step(Point::AppLocalDataDir).map(|()| PathBuf::new())
        }

        fn make_shell(
            &self,
            _: &AppHandle<MockRuntime>,
            _: Vec<PathBuf>,
        ) -> StepResult<Arc<Shell>> {
            self.step(Point::MakeShell)
                .map(|()| Arc::clone(&self.ts.shell))
        }

        fn keep_shell(&self, _: &AppHandle<MockRuntime>, _: &Arc<Shell>) -> StepResult<()> {
            self.step(Point::KeepShell)
        }

        fn route_signals(&self, _: mpsc::Receiver<OsSignal>, _: Arc<Shell>) -> StepResult<()> {
            self.step(Point::RouteSignals)
        }

        fn start_ticks(&self, _: Arc<Shell>) -> StepResult<()> {
            self.step(Point::StartTicks)
        }

        fn build_tray(&self, _: &AppHandle<MockRuntime>) -> StepResult<()> {
            self.step(Point::Tray)
        }

        fn make_window(&self, _: &AppHandle<MockRuntime>) -> StepResult<()> {
            self.step(Point::MakeWindow)
        }

        fn start_window(&self, _: &(), _: &Shell, hidden: bool) -> StepResult<()> {
            *lock(&self.hidden) = Some(hidden);
            self.step(Point::StartWindow)
        }

        fn give_up(&self, _: &AppHandle<MockRuntime>) {
            self.gave_up.fetch_add(1, Ordering::SeqCst);
        }
    }

    fn mock_app() -> App<MockRuntime> {
        mock_builder()
            .build(mock_context(noop_assets()))
            .expect("the mock app builds")
    }

    /// A build that fails because a plugin's start fails with an error that holds a marked path and name.
    fn marked_build_failure() -> tauri::Result<App<MockRuntime>> {
        let failing = tauri::plugin::Builder::<MockRuntime>::new("failing")
            .setup(|_, _| Err(format!("{MARKED_PATH} {MARKED_NAME}").into()))
            .build();
        mock_builder()
            .plugin(failing)
            .build(mock_context(noop_assets()))
    }

    /// One launch on `steps` with a fresh notice and launcher.
    fn launched(
        app: &App<MockRuntime>,
        steps: &FakeSteps,
        answer: NoticeAnswer,
        hidden: bool,
    ) -> (Launch, FakeNotice, FakeLauncher) {
        let notice = FakeNotice::default();
        notice.answer(answer);
        let launcher = FakeLauncher::default();
        let result = launch(app.handle(), steps, &notice, &launcher, args_of(hidden));
        (result, notice, launcher)
    }

    /// The process's arguments for a normal start, or for Windows' sign-in start (`--hidden`).
    fn args_of(hidden: bool) -> Vec<OsString> {
        let mut args = vec![OsString::from("C:\\Program Files\\Petalock\\lockbox.exe")];
        if hidden {
            args.push(OsString::from("--hidden"));
        }
        args
    }

    /// Every failure point of setup, in a normal and a `--hidden` start, reaches the notice exactly once: no step after
    /// the failed one runs, the notice follows the clean-up, and it says the design's words and nothing else. A start
    /// where nothing fails shows no notice (the control: the counts below are of cases that did fail).
    #[test]
    fn every_setup_failure_reaches_the_notice_once() {
        let app = mock_app();
        let mut failed_cases = 0;
        for hidden in [false, true] {
            for (index, point) in POINTS.into_iter().enumerate() {
                let steps = FakeSteps::new(Some(point));
                let (result, notice, launcher) =
                    launched(&app, &steps, NoticeAnswer::Close, hidden);
                assert_eq!(
                    result,
                    Launch::CantStart(EXIT_CANT_START),
                    "{point:?} hidden={hidden}"
                );
                assert_eq!(
                    notice.shown(),
                    [CANT_START],
                    "{point:?} hidden={hidden}: the notice was not shown exactly once"
                );
                assert_eq!(
                    steps.calls(),
                    POINTS[..=index].to_vec(),
                    "{point:?}: a step after the failed one ran, or one before it did not"
                );
                assert_eq!(steps.gave_up.load(Ordering::SeqCst), 1, "{point:?}");
                assert!(launcher.opened().is_empty(), "{point:?}: Close opened it");
                assert!(
                    steps.ts.hotkey.asked().is_empty(),
                    "{point:?}: a start that failed asked Windows for the save shortcut"
                );
                failed_cases += 1;
            }
        }
        assert_eq!(failed_cases, 22, "a failure point was not tried");

        for hidden in [false, true] {
            let steps = FakeSteps::new(None);
            let (result, notice, _) = launched(&app, &steps, NoticeAnswer::Close, hidden);
            assert_eq!(result, Launch::Started);
            assert!(notice.shown().is_empty(), "a notice with nothing failing");
            assert_eq!(steps.calls(), POINTS.to_vec(), "the steps' order");
            assert_eq!(*lock(&steps.hidden), Some(hidden), "the start's kind");
            assert_eq!(steps.gave_up.load(Ordering::SeqCst), 0);
            assert_eq!(
                steps.ts.hotkey.asked(),
                [Some(os::Shortcut::default())],
                "a start that worked asks for the save shortcut once"
            );
        }
    }

    /// What the setup hook does with the process's own arguments and each outcome, through the one function `run()` calls
    /// ([`launch`], then [`Launch::exit_code`]): only exactly `--hidden` after the program is a sign-in start; a start
    /// that works goes on; a hand-off ends with exit code 0 and no notice; a failure shows the notice once and ends with
    /// a non-zero code, in a normal and a hidden start.
    #[test]
    fn the_setup_hook_reads_the_arguments_and_ends_with_the_right_code() {
        let app = mock_app();
        let raw = |args: &[&str]| -> Vec<OsString> { args.iter().map(OsString::from).collect() };
        let hidden_cases = [
            (raw(&["lockbox.exe"]), false),
            (raw(&["lockbox.exe", "--hidden"]), true),
            (raw(&["lockbox.exe", "--HIDDEN"]), false),
            (raw(&["lockbox.exe", "--hidden", "x"]), false),
            (raw(&["lockbox.exe", "--hidden", "--hidden"]), false),
            (raw(&["lockbox.exe", "C:\\vault"]), false),
            (raw(&[]), false),
        ];
        let mut tried = 0;
        for (args, hidden) in hidden_cases {
            let (steps, notice, launcher) = (
                FakeSteps::new(None),
                FakeNotice::default(),
                FakeLauncher::default(),
            );
            let result = launch(app.handle(), &steps, &notice, &launcher, args.clone());
            assert_eq!(result.exit_code(), None, "{args:?}: a start goes on");
            assert_eq!(*lock(&steps.hidden), Some(hidden), "{args:?}");
            assert!(notice.shown().is_empty());
            tried += 1;
        }
        assert_eq!(tried, 7);

        for hidden in [false, true] {
            // A hand-off: code 0, nothing said.
            let mut steps = FakeSteps::new(None);
            steps.claim = Claim::AlreadyRunning;
            let (result, notice, _) = launched(&app, &steps, NoticeAnswer::Close, hidden);
            assert_eq!(result.exit_code(), Some(0), "hidden={hidden}");
            assert!(notice.shown().is_empty());
            // A failure: a non-zero code, the notice once.
            let steps = FakeSteps::new(Some(Point::Tray));
            let (result, notice, _) = launched(&app, &steps, NoticeAnswer::Close, hidden);
            let code = result.exit_code().expect("a failure ends the process");
            assert_ne!(code, 0, "hidden={hidden}");
            assert_eq!(notice.shown().len(), 1, "hidden={hidden}");
        }
    }

    /// A build that fails (a plugin that cannot start) reaches the notice once, with the exit code, and the error's
    /// text goes nowhere; a build that works shows nothing.
    #[test]
    fn a_build_failure_reaches_the_notice_once() {
        let result = marked_build_failure();
        assert!(result.is_err(), "the build was meant to fail");

        let notice = FakeNotice::default();
        let launcher = FakeLauncher::default();
        let after = built(result, &notice, &launcher);
        assert_eq!(after.err(), Some(EXIT_CANT_START));
        assert_eq!(notice.shown(), [CANT_START]);
        assert!(launcher.opened().is_empty());

        let notice = FakeNotice::default();
        assert!(built(Ok::<_, io::Error>(7), &notice, &launcher) == Ok(7));
        assert!(
            notice.shown().is_empty(),
            "a notice for a build that worked"
        );
    }

    /// The words are the design's, exactly, for every failure and each answer; the error that caused the failure (with
    /// its marked path and name) is in nothing the notice, the launcher or the process's own output holds. The output
    /// check runs the failing launches in a child copy of this test program, since stderr is the process's own; the
    /// child's output is checked to be there at all, and the same check is shown to catch a marker that does leak.
    #[test]
    fn cant_start_shows_only_the_designs_words_on_screen_and_in_logs() {
        assert_eq!(
            CANT_START.text,
            "Petalock can't start. Your vaults aren't affected. Restart your PC and try again. If that doesn't help, \
             the guide says what to check."
        );
        assert_eq!(
            (CANT_START.title, CANT_START.open_guide, CANT_START.close),
            ("Petalock", "Open the guide", "Close")
        );

        let app = mock_app();
        let mut checked = 0;
        for answer in [
            NoticeAnswer::OpenGuide,
            NoticeAnswer::Close,
            NoticeAnswer::Dismissed,
        ] {
            let steps = FakeSteps::new(Some(Point::MakeShell));
            let (result, notice, launcher) = launched(&app, &steps, answer, false);
            assert_eq!(result, Launch::CantStart(EXIT_CANT_START));
            let everything = format!("{:?} {:?}", notice.shown(), launcher.opened());
            for marker in [MARKED_PATH, MARKED_NAME, "MU-"] {
                assert!(!everything.contains(marker), "{answer:?}: {marker}");
            }
            assert_eq!(notice.shown(), [CANT_START]);
            checked += 1;
        }
        assert_eq!(checked, 3);

        // There is no log sink for startup to write to: none of the crates that make one is a dependency, so stderr (checked
        // below) is the only output. A crate added for logging fails here, to be covered by this test first.
        let manifest = include_str!("../Cargo.toml");
        let named: Vec<&str> = manifest
            .lines()
            .filter_map(|line| line.split(['=', ' ']).next())
            .collect();
        assert!(
            named.contains(&"tauri-plugin-single-instance"),
            "the scan read no dependencies"
        );
        for sink in [
            "tauri-plugin-log",
            "log",
            "tracing",
            "tracing-subscriber",
            "env_logger",
            "fern",
            "flexi_logger",
            "simplelog",
        ] {
            assert!(!named.contains(&sink), "a log crate: {sink}");
        }

        let clean = run_child(false);
        assert!(clean.contains("1 passed"), "the child did not run: {clean}");
        for marker in [MARKED_PATH, MARKED_NAME, "MU-"] {
            assert!(!clean.contains(marker), "the child's output holds {marker}");
        }
        let leaked = run_child(true);
        assert!(
            leaked.contains("1 passed") && leaked.contains(MARKED_NAME),
            "the check cannot see a marker that is printed: {leaked}"
        );
    }

    /// Runs the child test below in a copy of this program and returns its whole output (both streams).
    fn run_child(leak: bool) -> String {
        let out = Command::new(std::env::current_exe().expect("the test program's path"))
            .args([
                "--ignored",
                "--exact",
                "launch::tests::child_of_the_output_check",
                "--nocapture",
            ])
            .env("LOCKBOX_TEST_LEAK", if leak { "1" } else { "0" })
            .output()
            .expect("the child test program runs");
        assert!(out.status.success(), "the child failed: {out:?}");
        format!(
            "{}{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        )
    }

    /// Only run by the test above: every failing launch, with the answers, in this program's own output; and, when
    /// asked, one print of a marker, which the check above has to see.
    #[test]
    #[ignore = "run by cant_start_shows_only_the_designs_words_on_screen_and_in_logs"]
    fn child_of_the_output_check() {
        let app = mock_app();
        for point in POINTS {
            for answer in [NoticeAnswer::OpenGuide, NoticeAnswer::Close] {
                let steps = FakeSteps::new(Some(point));
                let (result, _, _) = launched(&app, &steps, answer, true);
                assert_eq!(result, Launch::CantStart(EXIT_CANT_START));
            }
        }
        // The build failing with the marked error, for both buttons.
        let mut failed_builds = 0;
        for answer in [NoticeAnswer::OpenGuide, NoticeAnswer::Close] {
            let (notice, launcher) = (FakeNotice::default(), FakeLauncher::default());
            notice.answer(answer);
            let after = built(marked_build_failure(), &notice, &launcher);
            assert_eq!(after.err(), Some(EXIT_CANT_START));
            assert_eq!(notice.shown(), [CANT_START]);
            failed_builds += 1;
        }
        assert_eq!(failed_builds, 2);
        if std::env::var("LOCKBOX_TEST_LEAK").as_deref() == Ok("1") {
            eprintln!("leak {MARKED_NAME}");
        }
    }

    /// "Open the guide" opens the fixed address, once and only that, and the exit code is the failure one.
    #[test]
    fn cant_start_open_the_guide_opens_the_fixed_address() {
        let (notice, launcher) = (FakeNotice::default(), FakeLauncher::default());
        notice.answer(NoticeAnswer::OpenGuide);
        assert_eq!(cant_start(&notice, &launcher), EXIT_CANT_START);
        assert_eq!(launcher.opened(), vec![GUIDE_URL.as_str().to_owned()]);
        assert!(launcher.opened_files().is_empty());
        assert!(launcher.opened_folders().is_empty());
        assert_eq!(notice.shown(), [CANT_START]);
    }

    /// A browser that cannot be started changes nothing: the notice is not shown again, and the exit code is the same.
    #[test]
    fn cant_start_open_the_guide_exits_non_zero_when_the_browser_fails() {
        let (notice, launcher) = (FakeNotice::default(), FakeLauncher::default());
        notice.answer(NoticeAnswer::OpenGuide);
        launcher.fail_next_url();
        let code = cant_start(&notice, &launcher);
        assert_eq!(code, EXIT_CANT_START);
        assert_ne!(code, 0);
        assert_eq!(launcher.opened().len(), 1, "it was tried once");
        assert_eq!(notice.shown().len(), 1, "the notice came back");
    }

    /// Close, and a dialog closed from its title bar (or Esc, or never shown), open nothing and exit with the failure
    /// code.
    #[test]
    fn cant_start_close_and_title_bar_close_exit_non_zero() {
        let mut tried = 0;
        for answer in [NoticeAnswer::Close, NoticeAnswer::Dismissed] {
            let (notice, launcher) = (FakeNotice::default(), FakeLauncher::default());
            notice.answer(answer);
            let code = cant_start(&notice, &launcher);
            assert_ne!(code, 0, "{answer:?}");
            assert_eq!(code, EXIT_CANT_START, "{answer:?}");
            assert!(launcher.opened().is_empty(), "{answer:?} opened the guide");
            assert_eq!(notice.shown().len(), 1, "{answer:?}");
            tried += 1;
        }
        assert_eq!(tried, 2);
    }

    /// A second copy that finds the first running ends with nothing said: setup stops at the claim, nothing is built or
    /// started, no notice, and the launcher is not touched. The same through [`launch`]'s result, which the app turns
    /// into exit code 0.
    #[test]
    fn a_second_launch_handing_off_shows_no_notice() {
        let app = mock_app();
        for hidden in [false, true] {
            let mut steps = FakeSteps::new(None);
            steps.claim = Claim::AlreadyRunning;
            let (result, notice, launcher) = launched(&app, &steps, NoticeAnswer::Close, hidden);
            assert_eq!(result, Launch::HandedOff, "hidden={hidden}");
            assert!(notice.shown().is_empty(), "a notice for a hand-off");
            assert_eq!(steps.calls(), [Point::Claim], "more than the claim ran");
            assert_eq!(steps.gave_up.load(Ordering::SeqCst), 0);
            assert!(launcher.opened().is_empty());
        }
    }

    /// The state a step keeps is kept once: a second value of the same type is refused, which is a failure of the step.
    #[test]
    fn a_kept_value_is_refused_the_second_time() {
        let app = mock_app();
        assert!(keep(app.handle(), 5_u32).is_ok());
        assert!(keep(app.handle(), 6_u32).is_err());
    }
}
