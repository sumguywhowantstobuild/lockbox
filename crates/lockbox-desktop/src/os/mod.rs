//! Calls into the operating system. `win` is the only module of the crate allowed `unsafe`. Each kind of call sits
//! behind a small trait, so the rules built on it are tested with fakes; [`Os`] holds the real ones.

#[cfg(windows)]
pub mod signals;
#[cfg(windows)]
pub mod win;

use std::ffi::{OsStr, OsString};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// The OS calls the shell makes, behind their traits.
pub struct Os {
    pub volumes: Arc<dyn Volumes>,
    pub env: Arc<dyn Env>,
    pub dialogs: Arc<dyn Dialogs>,
}

/// A folder Windows keeps for each user (`SHGetKnownFolderPath`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum KnownFolder {
    /// `%USERPROFILE%`: the default vaults folder goes inside it.
    Profile,
    /// `%LOCALAPPDATA%`: the state folder goes inside it.
    LocalAppData,
    /// `%APPDATA%`, the Roaming profile: never a vault's place (spec §6.10).
    RoamingAppData,
}

/// Environment variables and known folders. Read only through this, never `std::env` directly, so tests give their
/// own (`std::env::set_var` is unsafe in edition 2024).
pub trait Env: Send + Sync {
    fn var(&self, name: &str) -> Option<OsString>;
    fn known_folder(&self, id: KnownFolder) -> io::Result<PathBuf>;
}

/// What Windows says a drive is (`GetDriveTypeW`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DriveType {
    Fixed,
    Removable,
    Remote,
    CdRom,
    RamDisk,
    Unknown,
}

/// Volumes and the folders on them. A `root` is what [`volume_root`](Volumes::volume_root) gives: a drive's root or
/// the folder a volume is mounted on, with its trailing backslash.
pub trait Volumes: Send + Sync {
    fn drive_type(&self, root: &Path) -> DriveType;
    /// The file system's name, such as `NTFS` or `FAT32`.
    fn file_system(&self, root: &Path) -> io::Result<String>;
    fn volume_label(&self, root: &Path) -> io::Result<String>;
    /// The root of the volume `path` is on.
    fn volume_root(&self, path: &Path) -> io::Result<PathBuf>;
    /// Whether `path` (an existing one) is inside a folder a cloud provider syncs and has registered with Windows.
    fn under_sync_root(&self, path: &Path) -> bool;
    /// The provider name the sync root above `path` (an existing one) registered with Windows, such as `OneDrive`;
    /// `None` when there is no sync root there or its name cannot be read.
    fn sync_root_provider(&self, path: &Path) -> Option<String>;
    fn exists(&self, path: &Path) -> io::Result<bool>;
}

/// File dialogs, opened by Rust inside a command (spec §4.2): the path chosen never passes through the page. `None`
/// when the user closed the dialog. Never called under a session or vault lock: a dialog waits for the user.
pub trait Dialogs: Send + Sync {
    fn pick_folder(&self, title: &str) -> Option<PathBuf>;
    /// `filter`: a name and the extensions it shows, without dots.
    fn pick_file(&self, title: &str, filter: Option<(&str, &[&str])>) -> Option<PathBuf>;
    fn save_file(
        &self,
        title: &str,
        suggested: &str,
        filter: Option<(&str, &[&str])>,
    ) -> Option<PathBuf>;
}

/// Whether `a` and `b` name the same path as the file system compares names: component by component (so a trailing
/// separator changes nothing), each on Windows ordinal and ignoring case, with Windows' own case table (not Unicode
/// lowercasing, which merges names Windows keeps apart); elsewhere exactly.
pub fn same_path(a: &Path, b: &Path) -> bool {
    let (mut a, mut b) = (a.components(), b.components());
    loop {
        match (a.next(), b.next()) {
            (None, None) => return true,
            (Some(x), Some(y)) if same_name(x.as_os_str(), y.as_os_str()) => {}
            _ => return false,
        }
    }
}

/// Whether two names (one path component each) are equal as the file system compares them; see [`same_path`].
pub fn same_name(a: &OsStr, b: &OsStr) -> bool {
    #[cfg(windows)]
    return win::equal_ignoring_case(a, b);
    #[cfg(not(windows))]
    return a == b;
}

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
