//! What the two batch jobs share: Add files (task 10) and Save all of a folder's files (task 11). Each is one job for
//! the whole batch (one operation, one bar over every file's bytes together) in which each file is its own use of the
//! vault, and the vault is let go between two files, so a read (a search) is answered during the batch and a lock lands
//! within one file.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use petalock_core::blob::Progress;

use crate::error::{ShellError, ShellResult};
use crate::jobs::RunningJob;
use crate::session::SessionId;
use crate::shell::Shell;

/// How long the vault is let go between two files: three times a read's 10 ms wait between tries (a sleep can run over,
/// and a busy PC delays the thread), so a read that was waiting for it gets in. About 30 ms a file, which a batch of
/// large files never notices and a batch of thousands of tiny ones does.
pub(super) const RELEASE_GAP: Duration = Duration::from_millis(30);

/// How long a file waits for a vault another command is using, trying again every [`BUSY_RETRY`], by the shell's clock.
const BUSY_WAIT: Duration = Duration::from_secs(30);
const BUSY_RETRY: Duration = Duration::from_millis(50);

/// The batch's bar: each file's engine progress (bytes of that file) laid after the bytes of the files before it, out of
/// the batch's total. Every file counts as the size it was measured at (the one the space check and the total used), not
/// the length the engine sees when it opens it: its progress is held at that size, and the file's whole size is counted
/// when it is finished or passed over, so a batch that ends well ends at its total. Never reports past the total, and
/// never reports less than it has.
pub(super) struct BatchProgress<'a> {
    inner: &'a dyn Progress,
    /// The measured bytes of the files finished or passed over.
    before: AtomicU64,
    /// The measured size of the file the engine is working on.
    current: AtomicU64,
    /// The most reported so far.
    high: AtomicU64,
    total: u64,
}

impl Progress for BatchProgress<'_> {
    fn advance(&self, done: u64, file_total: u64) {
        let in_file = done
            .min(file_total)
            .min(self.current.load(Ordering::SeqCst));
        self.report(self.before.load(Ordering::SeqCst).saturating_add(in_file));
    }
}

impl<'a> BatchProgress<'a> {
    pub(super) fn new(inner: &'a dyn Progress, total: u64) -> Self {
        Self {
            inner,
            before: AtomicU64::new(0),
            current: AtomicU64::new(0),
            high: AtomicU64::new(0),
            total,
        }
    }

    /// Sends `done` bytes of the total, or the most sent so far if that is more.
    fn report(&self, done: u64) {
        let done = done.min(self.total);
        let done = self.high.fetch_max(done, Ordering::SeqCst).max(done);
        self.inner.advance(done, self.total);
    }

    /// The engine is about to work on a file measured at `size`.
    pub(super) fn begin_file(&self, size: u64) {
        self.current.store(size, Ordering::SeqCst);
    }

    /// A file went in whole: all of its measured size is done, whatever the engine last reported.
    pub(super) fn finished_file(&self, size: u64) {
        self.passed_over(size);
    }

    /// A file that could not be read is passed over: its bytes count as done, so a batch that ends well ends at its total.
    pub(super) fn passed_over(&self, size: u64) {
        let before = self
            .before
            .fetch_add(size, Ordering::SeqCst)
            .saturating_add(size);
        self.current.store(0, Ordering::SeqCst);
        self.report(before);
    }
}

impl Shell {
    /// Runs `attempt` (one use of the vault for one file of a batch) and, while it answers `Busy` (another command has
    /// the vault), again every [`BUSY_RETRY`] by the shell's clock for up to [`BUSY_WAIT`]; a Stop of `job` ends the wait
    /// as `Cancelled`. `on_retry` is told the number of tries so far before each wait (tests watch it). Any other answer,
    /// and the last `Busy`, is returned.
    pub(super) fn when_free<T>(
        &self,
        job: &RunningJob,
        mut on_retry: impl FnMut(usize),
        mut attempt: impl FnMut() -> ShellResult<T>,
    ) -> ShellResult<T> {
        let clock = &self.os.clock;
        let mut waited_from = None;
        let mut retries = 0;
        loop {
            let result = attempt();
            if !matches!(result, Err(ShellError::Busy { .. })) {
                return result;
            }
            let began = *waited_from.get_or_insert_with(|| clock.now());
            if clock.now().saturating_duration_since(began) >= BUSY_WAIT {
                return result;
            }
            if job.token().is_cancelled() {
                return Err(ShellError::Cancelled);
            }
            retries += 1;
            on_retry(retries);
            clock.sleep(BUSY_RETRY);
        }
    }

    /// What a cancelled job's token means: `Cancelled` for a Stop, but `Locked` (the error) when the session was locked
    /// meanwhile, which cancels every job of it too.
    pub(super) fn cancelled_or_locked(
        &self,
        session: SessionId,
        generation: u64,
    ) -> ShellResult<ShellError> {
        self.still_current(session, generation, ())
            .map(|_| ShellError::Cancelled)
    }
}
