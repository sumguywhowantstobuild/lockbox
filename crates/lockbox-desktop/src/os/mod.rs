//! Calls into the operating system. `win` is the only module of the crate allowed `unsafe`.

#[cfg(windows)]
pub mod signals;
#[cfg(windows)]
pub mod win;

/// A Windows event that locks every vault (spec §7.4), or the vaults on a drive that went away (spec §6.10).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OsSignal {
    /// The session was locked, signed out, switched away from (another user's sign-in screen took the console) or
    /// disconnected from remote desktop.
    SessionLocked,
    /// The PC is going to sleep or hibernating.
    Suspending,
    /// Volumes went away: bit 0 of `mask` is drive A:, bit 1 drive B:, bit 2 drive C:, and so on.
    DriveRemoved { mask: u32 },
    /// Windows is signing out or shutting down, and may end the process as soon as the window has the message.
    Ending,
}
