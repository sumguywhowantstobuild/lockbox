//! Long jobs as the page sees them: an operation ID for each, the scope that decides when its answer and its Stop are
//! no longer wanted, and the three events the page hears (`lockbox://job-started`, `lockbox://progress`,
//! `lockbox://lock-epoch`). The table of running jobs is the auto-lock's list of operations
//! ([`AutoLock::begin_job`](crate::autolock::AutoLock::begin_job)), so a "job" is exactly what pauses the idle lock.
//!
//! Every job has a token of its own, a child of its scope's token: the session's for [`JobScope::Session`], the launch's
//! for [`JobScope::Launch`] (replaced, after being cancelled, whenever all vaults lock). Stopping one job leaves every
//! other one running; a lock stops all of its scope's.

use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use lockbox_core::blob::{CancelToken, NoProgress, Progress};
use serde::{Deserialize, Serialize};

use crate::autolock::LongOp;
use crate::lock;
use crate::os::Clock;
use crate::session::{LockReason, Notifier, SessionId};
use crate::shell::Shell;

/// The least time between two progress events of one job: about ten a second.
const PROGRESS_GAP: Duration = Duration::from_millis(100);

/// A running job's number: unique for the whole launch, never reused, from 1. A JSON number, like a session's.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct OperationId(pub u64);

/// What a job's answer and its Stop depend on. A scope that has gone (the session's generation or the lock epoch
/// changed) refuses both as `Locked`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum JobScope {
    /// A job of one unlocked session, in the generation it started in: its token is a child of the session's.
    Session { session: SessionId, generation: u64 },
    /// A job with no session (testing a backup, a restore's copy, opening a backup read-only), in the lock epoch it
    /// started in: its token is a child of the launch's.
    Launch { epoch: u64 },
}

/// What a job is, for the page's words and for the question on closing.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum JobKind {
    Import,
    SaveCopy,
    SaveAll,
    Backup,
    Test,
    Restore,
    OpenBackup,
    Open,
    Replace,
    CopyItem,
}

impl JobKind {
    /// The name `lockbox://busy` gives it, as it always has: a replace is listed as an import (the page says the same
    /// words for both), and a test as `test_backup`.
    pub(crate) fn busy_name(self) -> &'static str {
        match self {
            JobKind::Import | JobKind::Replace => "import",
            JobKind::SaveCopy => "save_copy",
            JobKind::SaveAll => "save_all",
            JobKind::Backup => "backup",
            JobKind::Test => "test_backup",
            JobKind::Restore => "restore",
            JobKind::OpenBackup => "open_backup",
            JobKind::Open => "open",
            JobKind::CopyItem => "copy_item",
        }
    }

    /// Whether the page is sent progress for it: the jobs with a bar of their own.
    fn reports_progress(self) -> bool {
        !matches!(self, JobKind::Open | JobKind::Replace | JobKind::CopyItem)
    }
}

/// `lockbox://job-started`: the operation a command's `request` got, sent before that job's first progress event and
/// before the command answers.
#[derive(Clone, Copy, Debug, Serialize)]
pub struct JobStarted {
    pub request: u32,
    pub operation: OperationId,
    pub scope: JobScope,
    pub kind: JobKind,
}

/// `lockbox://progress`: bytes done of the total. `done` never passes `total`; the last event of a job has `finished`.
#[derive(Clone, Copy, Debug, Serialize)]
pub struct ProgressEvent {
    pub operation: OperationId,
    pub scope: JobScope,
    pub kind: JobKind,
    pub done: u64,
    pub total: u64,
    pub finished: bool,
}

/// `lockbox://lock-epoch`: all vaults locked (or the app is closing), with or without any open.
#[derive(Clone, Copy, Debug, Serialize)]
pub struct LockEpochEvent {
    pub epoch: u64,
    pub reason: LockReason,
}

/// What was asked of the app when the question came: the window's close button, or the tray's Quit.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CloseReason {
    Close,
    Quit,
}

/// `lockbox://close-asked`: a close or Quit arrived while at least one job runs. The kinds, each once, in the order the
/// first of each began, and whether a restore is past its swap (a cancel no longer counts, so it finishes or is undone
/// by recovery at the next launch). Nothing else: no path, no name, no count.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct CloseAsked {
    pub reason: CloseReason,
    pub running: Vec<JobKind>,
    pub past_swap: bool,
}

/// A job under way: it holds its place in the auto-lock's list (so idle time does not count and the PC stays awake),
/// its token, and what it tells the page. Dropping it ends the job: the page is told it finished, then the list is
/// let go.
pub struct RunningJob {
    scope: JobScope,
    token: CancelToken,
    /// `None` for a job that tells the page nothing: no `request`, a kind without a bar, or one refused as the app
    /// closes.
    reporter: Option<Reporter>,
    /// Dropped last, after the final progress event.
    operation: LongOp,
}

/// What a job that tells the page of itself is given: the clock its progress is throttled by, and where the events go.
pub(crate) struct ReportTo {
    pub(crate) clock: Arc<dyn Clock>,
    pub(crate) notifier: Arc<dyn Notifier>,
}

impl RunningJob {
    pub(crate) fn new(
        scope: JobScope,
        kind: JobKind,
        token: CancelToken,
        operation: LongOp,
        report_to: Option<ReportTo>,
    ) -> RunningJob {
        let reporter = match (operation.id(), report_to) {
            (Some(id), Some(ReportTo { clock, notifier })) if kind.reports_progress() => {
                Some(Reporter {
                    operation: id,
                    scope,
                    kind,
                    clock,
                    notifier,
                    state: Mutex::default(),
                })
            }
            _ => None,
        };
        RunningJob {
            scope,
            token,
            reporter,
            operation,
        }
    }

    /// The job's number; `None` when the app is closing and nothing was registered (the token is cancelled).
    pub fn id(&self) -> Option<OperationId> {
        self.operation.id()
    }

    pub fn scope(&self) -> JobScope {
        self.scope
    }

    /// The job's own token: cancelled by a Stop of this job, and by a lock of its scope.
    pub fn token(&self) -> &CancelToken {
        &self.token
    }

    /// Where the engine reports bytes done: throttled to the page, which hears the end of the job from [`Drop`].
    pub fn progress(&self) -> &dyn Progress {
        match &self.reporter {
            Some(reporter) => reporter,
            None => &NoProgress,
        }
    }
}

impl Drop for RunningJob {
    fn drop(&mut self) {
        // While unwinding the page is not told: a second panic would abort the process, and the command's own answer
        // ends the job on the page.
        if let Some(reporter) = &self.reporter
            && !thread::panicking()
        {
            reporter.finish();
        }
    }
}

/// Sends a job's progress, at most once per [`PROGRESS_GAP`], and its last event always.
struct Reporter {
    operation: OperationId,
    scope: JobScope,
    kind: JobKind,
    clock: Arc<dyn Clock>,
    notifier: Arc<dyn Notifier>,
    state: Mutex<Reported>,
}

#[derive(Default)]
struct Reported {
    done: u64,
    total: u64,
    last_sent: Option<Instant>,
    finished: bool,
}

impl Reporter {
    fn event(&self, done: u64, total: u64, finished: bool) -> ProgressEvent {
        ProgressEvent {
            operation: self.operation,
            scope: self.scope,
            kind: self.kind,
            done,
            total,
            finished,
        }
    }

    /// The last event, with the last numbers the engine gave (done at the total after a success), sent once.
    fn finish(&self) {
        let (done, total) = {
            let mut state = lock(&self.state);
            if state.finished {
                return;
            }
            state.finished = true;
            (state.done, state.total)
        };
        self.notifier.progress(&self.event(done, total, true));
    }
}

impl Progress for Reporter {
    fn advance(&self, done: u64, total: u64) {
        let done = done.min(total);
        let now = self.clock.now();
        let due = {
            let mut state = lock(&self.state);
            if state.finished {
                return;
            }
            state.done = done;
            state.total = total;
            let due = state
                .last_sent
                .is_none_or(|sent| now.saturating_duration_since(sent) >= PROGRESS_GAP);
            if due {
                state.last_sent = Some(now);
            }
            due
        };
        if due {
            self.notifier.progress(&self.event(done, total, false));
        }
    }
}

impl Shell {
    /// Begins a job with no session, in the lock epoch it starts in: its token is a child of the launch's, which a lock
    /// of all vaults cancels. Its answer goes through [`AutoLock::answer_job`](crate::autolock::AutoLock::answer_job),
    /// so one that outlived the epoch is refused as `Locked`. Testing a backup, opening one read-only and a restore's copy
    /// use it.
    pub fn begin_launch_job(&self, kind: JobKind, request: Option<u32>) -> RunningJob {
        let (epoch, launch) = self.sessions.launch_scope();
        self.autolock
            .begin_job(JobScope::Launch { epoch }, kind, &launch, request)
    }

    /// [`begin_launch_job`](Self::begin_launch_job) for a job the page's Stop must not reach (a restore's swap, past the
    /// point of cancelling): told to the page the same way, and still cancelled by a lock of all vaults.
    pub fn begin_launch_job_without_stop(&self, kind: JobKind, request: Option<u32>) -> RunningJob {
        let (epoch, launch) = self.sessions.launch_scope();
        self.autolock
            .begin_job_without_stop(JobScope::Launch { epoch }, kind, &launch, request)
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use lockbox_core::blob::CancelToken;
    use serde_json::{Value, json};

    use super::*;
    use crate::error::ShellError;
    use crate::os::OsSignal;
    use crate::session::{LockReason, SessionId};
    use crate::testing::TestShell;

    const MS: Duration = Duration::from_millis(1);

    fn scope(session: SessionId, generation: u64) -> JobScope {
        JobScope::Session {
            session,
            generation,
        }
    }

    /// The session's own token, which every job of the session is a child of.
    fn session_token(ts: &TestShell, session: SessionId, generation: u64) -> CancelToken {
        ts.shell
            .sessions
            .read(session, generation, |_, cancel| Ok(cancel.clone()))
            .unwrap()
            .data
    }

    fn operation_of(job: &RunningJob) -> OperationId {
        job.id().expect("the job is registered")
    }

    /// The progress events of `operation`, in order.
    fn progress_of(ts: &TestShell, operation: OperationId) -> Vec<Value> {
        ts.events
            .progress()
            .into_iter()
            .filter(|event| event["operation"] == json!(operation.0))
            .collect()
    }

    fn state_of(ts: &TestShell, session: SessionId) -> crate::session::SessionState {
        ts.shell
            .sessions
            .list()
            .into_iter()
            .find(|info| info.session == session)
            .unwrap()
            .state
    }

    /// The frozen connection's shapes, exactly: a scope in both directions, the operation and the kinds as plain values.
    #[test]
    fn scope_operation_and_kind_have_the_frozen_shapes() {
        let session = scope(SessionId(3), 7);
        let launch = JobScope::Launch { epoch: 2 };
        assert_eq!(
            serde_json::to_value(session).unwrap(),
            json!({ "type": "session", "session": 3, "generation": 7 })
        );
        assert_eq!(
            serde_json::to_value(launch).unwrap(),
            json!({ "type": "launch", "epoch": 2 })
        );
        for scope in [session, launch] {
            let back: JobScope =
                serde_json::from_value(serde_json::to_value(scope).unwrap()).unwrap();
            assert_eq!(back, scope);
        }
        for bad in [
            json!({ "type": "launch", "epoch": 2, "session": 1 }),
            json!({ "type": "session", "session": 3 }),
            json!({ "type": "elsewhere", "epoch": 2 }),
            json!({ "session": 3, "generation": 7 }),
            json!({ "type": "launch", "epoch": "2" }),
            json!({ "type": "launch", "epoch": -1 }),
            json!(7),
        ] {
            assert!(
                serde_json::from_value::<JobScope>(bad.clone()).is_err(),
                "{bad} was accepted"
            );
        }
        assert_eq!(serde_json::to_value(OperationId(5)).unwrap(), json!(5));
        assert_eq!(
            serde_json::from_value::<OperationId>(json!(5)).unwrap(),
            OperationId(5)
        );
        let kinds = [
            (JobKind::Import, "import"),
            (JobKind::SaveCopy, "save_copy"),
            (JobKind::SaveAll, "save_all"),
            (JobKind::Backup, "backup"),
            (JobKind::Test, "test"),
            (JobKind::Restore, "restore"),
            (JobKind::OpenBackup, "open_backup"),
            (JobKind::Open, "open"),
            (JobKind::Replace, "replace"),
            (JobKind::CopyItem, "copy_item"),
        ];
        for (kind, name) in kinds {
            assert_eq!(serde_json::to_value(kind).unwrap(), json!(name));
        }
    }

    #[test]
    fn the_three_events_have_the_frozen_shapes() {
        let session = scope(SessionId(3), 7);
        let started = JobStarted {
            request: 9,
            operation: OperationId(4),
            scope: session,
            kind: JobKind::SaveCopy,
        };
        assert_eq!(
            serde_json::to_value(started).unwrap(),
            json!({
                "request": 9,
                "operation": 4,
                "scope": { "type": "session", "session": 3, "generation": 7 },
                "kind": "save_copy"
            })
        );
        let progress = ProgressEvent {
            operation: OperationId(4),
            scope: JobScope::Launch { epoch: 2 },
            kind: JobKind::Import,
            done: 10,
            total: 20,
            finished: false,
        };
        assert_eq!(
            serde_json::to_value(progress).unwrap(),
            json!({
                "operation": 4,
                "scope": { "type": "launch", "epoch": 2 },
                "kind": "import",
                "done": 10,
                "total": 20,
                "finished": false
            })
        );
        let epoch = LockEpochEvent {
            epoch: 2,
            reason: LockReason::Sleep,
        };
        assert_eq!(
            serde_json::to_value(epoch).unwrap(),
            json!({ "epoch": 2, "reason": "sleep" })
        );
    }

    /// A job reports at most about ten times a second, and the last report, the one that says it is finished, is always
    /// sent however soon it follows the one before. The clock is the fake one: it moves only when told to.
    #[test]
    fn events_are_throttled_and_the_last_one_always_sent() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let parent = session_token(&ts, s, g);
        let job = ts
            .shell
            .autolock
            .begin_job(scope(s, g), JobKind::Import, &parent, Some(1));
        let operation = operation_of(&job);

        // Two thousand reports, one every millisecond, over two seconds.
        for step in 0..2_000u64 {
            job.progress().advance(step, 2_000);
            ts.clock.sleep(MS);
        }
        let sent = progress_of(&ts, operation);
        assert!(
            (19..=21).contains(&sent.len()),
            "{} events in two seconds",
            sent.len()
        );
        assert!(sent.iter().all(|event| event["finished"] == json!(false)));
        // A burst at one instant sends at most one.
        job.progress().advance(1_000, 2_000);
        let before = progress_of(&ts, operation).len();
        for step in 0..500u64 {
            job.progress().advance(1_000 + step, 2_000);
        }
        assert_eq!(
            progress_of(&ts, operation).len(),
            before,
            "a burst got through"
        );

        // Done never passes the total, even when the engine says so.
        job.progress().advance(9_999, 2_000);
        drop(job);
        let sent = progress_of(&ts, operation);
        let last = sent.last().unwrap();
        assert_eq!(last["finished"], json!(true));
        assert_eq!(last["done"], json!(2_000));
        assert_eq!(last["total"], json!(2_000));
        assert_eq!(
            sent.iter()
                .filter(|event| event["finished"] == json!(true))
                .count(),
            1,
            "one finished event"
        );
        assert!(
            sent.iter()
                .all(|event| event["done"].as_u64() <= event["total"].as_u64())
        );
    }

    #[test]
    fn progress_event_carries_its_scope() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let parent = session_token(&ts, s, g);
        let in_session =
            ts.shell
                .autolock
                .begin_job(scope(s, g), JobKind::SaveCopy, &parent, Some(1));
        in_session.progress().advance(1, 4);
        let session_op = operation_of(&in_session);
        drop(in_session);
        let launch = ts.shell.begin_launch_job(JobKind::Test, Some(2));
        launch.progress().advance(2, 4);
        let launch_op = operation_of(&launch);
        drop(launch);

        let session_json = json!({ "type": "session", "session": s.0, "generation": g });
        let launch_json = json!({ "type": "launch", "epoch": 0 });
        for event in progress_of(&ts, session_op) {
            assert_eq!(event["scope"], session_json);
            assert_eq!(event["kind"], json!("save_copy"));
        }
        for event in progress_of(&ts, launch_op) {
            assert_eq!(event["scope"], launch_json);
            assert_eq!(event["kind"], json!("test"));
        }
        let started = ts.events.started();
        assert_eq!(started.len(), 2);
        assert_eq!(started[0]["scope"], session_json);
        assert_eq!(started[1]["scope"], launch_json);
        assert_eq!(started[0]["request"], json!(1));
        assert_eq!(started[1]["request"], json!(2));
    }

    /// `job-started` goes out as the job registers, before its first progress event, and a job that is not given a
    /// request (Open, Replace) sends no event of its own at all.
    #[test]
    fn job_started_is_sent_before_progress() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let parent = session_token(&ts, s, g);
        let job = ts
            .shell
            .autolock
            .begin_job(scope(s, g), JobKind::Import, &parent, Some(5));
        job.progress().advance(1, 2);
        job.progress().advance(2, 2);
        drop(job);
        let names: Vec<&str> = ts
            .events
            .job_events()
            .iter()
            .map(|(name, _)| *name)
            .collect();
        assert_eq!(names[0], crate::shell::JOB_STARTED_EVENT);
        assert!(
            names[1..]
                .iter()
                .all(|name| *name == crate::shell::PROGRESS_EVENT)
        );
        assert!(names.len() >= 3, "{names:?}");

        let quiet = ts
            .shell
            .autolock
            .begin_job(scope(s, g), JobKind::Open, &parent, None);
        quiet.progress().advance(1, 2);
        drop(quiet);
        assert_eq!(
            ts.events.job_events().len(),
            names.len(),
            "a quiet job spoke"
        );
    }

    /// A job with no Stop (a restore's swap) is told to the page like any other, and counts as an operation, but no Stop
    /// of the page reaches it: the page's `cancel_operation` finds nothing to stop and its token stays. A lock of all
    /// vaults still cancels it, as it does every job.
    #[test]
    fn a_job_with_no_stop_is_told_but_never_stopped_by_the_page() {
        let ts = TestShell::new();
        let job = ts
            .shell
            .begin_launch_job_without_stop(JobKind::Restore, Some(6));
        let operation = operation_of(&job);
        let launch = JobScope::Launch { epoch: 0 };
        assert_eq!(job.scope(), launch);
        assert_eq!(
            ts.shell.autolock.cancel_operation(operation, launch),
            Err(ShellError::NotFound)
        );
        assert!(!job.token().is_cancelled(), "the page's Stop did nothing");

        job.progress().advance(0, 1);
        job.progress().advance(1, 1);
        let started = ts.events.started();
        assert_eq!(started.len(), 1);
        assert_eq!(started[0]["request"], json!(6));
        assert_eq!(started[0]["kind"], json!("restore"));
        assert_eq!(started[0]["scope"], json!({ "type": "launch", "epoch": 0 }));
        assert_eq!(started[0]["operation"], json!(operation.0));
        assert_eq!(ts.shell.autolock.running_kinds(), [JobKind::Restore]);

        ts.shell.sessions.lock_all(LockReason::Manual);
        assert!(job.token().is_cancelled(), "a lock still stops it");
        drop(job);
        let sent = progress_of(&ts, operation);
        assert_eq!(sent.last().unwrap()["finished"], json!(true));
        assert!(ts.shell.autolock.running_kinds().is_empty());
    }

    /// Two starts in one session, both running at once: each is told to the page with its own `request`, and gets an
    /// operation of its own.
    #[test]
    fn two_overlapping_starts_get_their_own_operations() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let parent = session_token(&ts, s, g);
        let first = ts
            .shell
            .autolock
            .begin_job(scope(s, g), JobKind::Import, &parent, Some(7));
        let second = ts
            .shell
            .autolock
            .begin_job(scope(s, g), JobKind::SaveCopy, &parent, Some(8));
        let started = ts.events.started();
        assert_eq!(started.len(), 2);
        assert_eq!(started[0]["request"], json!(7));
        assert_eq!(started[1]["request"], json!(8));
        assert_eq!(started[0]["operation"], json!(operation_of(&first).0));
        assert_eq!(started[1]["operation"], json!(operation_of(&second).0));
        assert_ne!(started[0]["operation"], started[1]["operation"]);
        assert_eq!(started[0]["kind"], json!("import"));
        assert_eq!(started[1]["kind"], json!("save_copy"));
    }

    #[test]
    fn cancel_operation_stops_only_that_job() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let parent = session_token(&ts, s, g);
        let autolock = &ts.shell.autolock;
        let first = autolock.begin_job(scope(s, g), JobKind::Import, &parent, Some(1));
        let second = autolock.begin_job(scope(s, g), JobKind::SaveCopy, &parent, Some(2));

        assert_eq!(
            autolock.cancel_operation(operation_of(&first), scope(s, g)),
            Ok(())
        );
        assert!(first.token().is_cancelled());
        assert!(!second.token().is_cancelled(), "the other job was stopped");
        assert!(!parent.is_cancelled(), "the session was stopped");

        assert_eq!(
            autolock.cancel_operation(operation_of(&second), scope(s, g)),
            Ok(())
        );
        assert!(second.token().is_cancelled());
        assert!(!parent.is_cancelled());
    }

    #[test]
    fn cancel_operation_refused_stale_foreign_or_finished() {
        let ts = TestShell::new();
        let (a, ga) = ts.open_vault("Family");
        let (b, gb) = ts.open_vault("Work");
        let parent = session_token(&ts, a, ga);
        let autolock = &ts.shell.autolock;
        let job = autolock.begin_job(scope(a, ga), JobKind::Import, &parent, Some(1));
        let op = operation_of(&job);
        let epoch = ts.shell.sessions.epoch();
        let cancel = |operation, scope| autolock.cancel_operation(operation, scope);

        // Another vault's scope, an operation that never existed, and a launch scope: not this operation's.
        assert_eq!(cancel(op, scope(b, gb)), Err(ShellError::NotFound));
        assert_eq!(
            cancel(OperationId(op.0 + 100), scope(a, ga)),
            Err(ShellError::NotFound)
        );
        assert_eq!(
            cancel(op, JobScope::Launch { epoch }),
            Err(ShellError::NotFound)
        );
        // A scope that has gone: an old generation, a session nobody has, an epoch that is not the current one.
        assert_eq!(cancel(op, scope(a, ga + 1)), Err(ShellError::Locked));
        assert_eq!(
            cancel(op, scope(SessionId(a.0 + 100), ga)),
            Err(ShellError::Locked)
        );
        assert_eq!(
            cancel(op, JobScope::Launch { epoch: epoch + 1 }),
            Err(ShellError::Locked)
        );
        assert!(
            !job.token().is_cancelled(),
            "a refused call stopped the job"
        );

        // Finished: the job's entry is gone.
        drop(job);
        assert_eq!(cancel(op, scope(a, ga)), Err(ShellError::NotFound));

        // After a lock the session's scope has gone.
        ts.shell.sessions.lock(a, LockReason::Manual);
        assert_eq!(cancel(op, scope(a, ga)), Err(ShellError::Locked));
    }

    #[test]
    fn a_lock_cancels_every_job_of_its_session_and_sends_finished() {
        let ts = TestShell::new();
        let (a, ga) = ts.open_vault("Family");
        let (b, gb) = ts.open_vault("Work");
        let (parent_a, parent_b) = (session_token(&ts, a, ga), session_token(&ts, b, gb));
        let autolock = &ts.shell.autolock;
        let import = autolock.begin_job(scope(a, ga), JobKind::Import, &parent_a, Some(1));
        let save = autolock.begin_job(scope(a, ga), JobKind::SaveCopy, &parent_a, Some(2));
        let other = autolock.begin_job(scope(b, gb), JobKind::Import, &parent_b, Some(3));
        let (import_op, save_op, other_op) = (
            operation_of(&import),
            operation_of(&save),
            operation_of(&other),
        );

        ts.shell.sessions.lock(a, LockReason::Manual);
        assert!(import.token().is_cancelled());
        assert!(save.token().is_cancelled());
        assert!(!other.token().is_cancelled(), "another vault's job stopped");

        // The jobs end as the engine returns; each one then says it is finished, and the other vault's does not.
        drop(import);
        drop(save);
        for operation in [import_op, save_op] {
            let last = progress_of(&ts, operation).pop().unwrap();
            assert_eq!(last["finished"], json!(true));
            assert!(last["done"].as_u64() <= last["total"].as_u64());
        }
        assert!(progress_of(&ts, other_op).is_empty());
        drop(other);
        assert_eq!(
            progress_of(&ts, other_op).last().unwrap()["finished"],
            json!(true)
        );
    }

    #[test]
    fn lock_all_cancels_launch_jobs_and_refuses_their_answers() {
        let ts = TestShell::new();
        let autolock = &ts.shell.autolock;
        let first = ts.shell.begin_launch_job(JobKind::Test, Some(3));
        let (first_op, first_scope) = (operation_of(&first), first.scope());
        assert_eq!(first_scope, JobScope::Launch { epoch: 0 });

        ts.shell.lock_all();
        assert!(first.token().is_cancelled());

        // A job begun after the lock has a fresh token and the new epoch.
        let second = ts.shell.begin_launch_job(JobKind::Test, Some(4));
        assert!(!second.token().is_cancelled());
        assert_eq!(second.scope(), JobScope::Launch { epoch: 1 });

        // The first one's answer is refused, and so is a stop addressed to its scope.
        assert_eq!(autolock.answer_job(first, Ok(5)), Err(ShellError::Locked));
        let last = progress_of(&ts, first_op).pop().unwrap();
        assert_eq!(last["finished"], json!(true));
        assert_eq!(
            autolock.cancel_operation(first_op, first_scope),
            Err(ShellError::Locked)
        );
        // The second one still answers.
        assert_eq!(autolock.answer_job(second, Ok(6)), Ok(6));
    }

    /// The app closing is an epoch change too: a launch job's token is cancelled by it.
    #[test]
    fn closing_the_app_cancels_launch_jobs() {
        let ts = TestShell::new();
        let job = ts.shell.begin_launch_job(JobKind::Test, Some(1));
        ts.shell.shutdown();
        assert!(job.token().is_cancelled());
        assert_eq!(
            ts.shell.autolock.answer_job(job, Ok(1)),
            Err(ShellError::Locked)
        );
    }

    #[test]
    fn lock_epoch_event_is_sent_with_no_vault_open() {
        let ts = TestShell::new();
        assert!(ts.shell.sessions.list().is_empty());

        ts.shell.lock_all();
        ts.shell.autolock.signal(OsSignal::SessionLocked);
        ts.shell.autolock.signal(OsSignal::Suspending);
        // One vault's own lock is not an epoch change.
        let (s, _) = ts.open_vault("Family");
        ts.shell.sessions.lock(s, LockReason::Manual);
        ts.shell.shutdown();

        assert_eq!(
            ts.events.epochs(),
            [
                json!({ "epoch": 1, "reason": "manual" }),
                json!({ "epoch": 2, "reason": "windows_locked" }),
                json!({ "epoch": 3, "reason": "sleep" }),
                json!({ "epoch": 4, "reason": "app_closing" }),
            ]
        );
    }

    #[test]
    fn operation_ids_are_never_reused_in_a_launch() {
        let ts = TestShell::new();
        let autolock = &ts.shell.autolock;
        let mut ids = Vec::new();
        for request in 0..3 {
            let job = ts.shell.begin_launch_job(JobKind::Test, Some(request));
            ids.push(operation_of(&job).0);
        }
        // Other operations count in the same list, and none of them takes a number a finished one had.
        let plain = autolock.begin(None, JobKind::Restore, CancelToken::new());
        let job = ts.shell.begin_launch_job(JobKind::Test, None);
        ids.push(operation_of(&job).0);
        drop((plain, job));
        let job = ts.shell.begin_launch_job(JobKind::Test, None);
        ids.push(operation_of(&job).0);
        assert_eq!(ids, [1, 2, 3, 5, 6]);
    }

    /// The idle time stops counting while any job runs, and the busy event names what runs: the page's 5d says what the
    /// vault is doing until the last one ends.
    #[test]
    fn idle_pause_names_the_running_job() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let parent = session_token(&ts, s, g);
        let autolock = &ts.shell.autolock;
        let t0 = ts.clock.now();
        let minutes = |m: u64| Duration::from_secs(m * 60);

        let import = autolock.begin_job(scope(s, g), JobKind::Import, &parent, Some(1));
        let save = autolock.begin_job(scope(s, g), JobKind::SaveCopy, &parent, Some(2));
        ts.idle.set(minutes(30));
        autolock.tick(t0 + minutes(30));
        assert_eq!(state_of(&ts, s), crate::session::SessionState::Unlocked);

        drop(import);
        ts.idle.set(minutes(40));
        autolock.tick(t0 + minutes(40));
        assert_eq!(
            state_of(&ts, s),
            crate::session::SessionState::Unlocked,
            "one job still runs"
        );
        ts.clock.set(t0 + minutes(40));
        drop(save);
        assert_eq!(
            ts.events.busy(),
            [
                (Some(s), vec!["import"]),
                (Some(s), vec!["import", "save_copy"]),
                (Some(s), vec!["save_copy"]),
                (Some(s), vec![]),
            ]
        );
        // The pause ends with the last job: idle counts from then.
        ts.idle.set(minutes(50));
        autolock.tick(t0 + minutes(44));
        assert_eq!(state_of(&ts, s), crate::session::SessionState::Unlocked);
        autolock.tick(t0 + minutes(45));
        assert_eq!(state_of(&ts, s), crate::session::SessionState::Locked);
    }
}
