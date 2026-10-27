//! Non-Windows file operations. Lockbox ships on Windows first; this keeps the crate
//! building and tested on Linux CI and ready for other platforms.

use std::fs::{self, File, OpenOptions};
use std::io;
use std::path::Path;

use super::{VolumeInfo, parent_dir};

/// Flushes a folder to disk; also what makes a rename durable.
pub fn sync_dir(dir: &Path) -> io::Result<()> {
    File::open(dir)?.sync_all()
}

pub fn replace_file(from: &Path, to: &Path) -> io::Result<()> {
    // If the folder sync fails after the rename, the new content is already in place even though an error is returned.
    fs::rename(from, to)?;
    sync_dir(parent_dir(to))
}

/// The caller has already checked that `to` does not exist.
// shortcut: check-then-rename has a race, and Linux rename(2) silently replaces an existing
// EMPTY folder or any plain FILE (so it also covers cleanup's quarantine and move-back of
// blobs, not just vault folders). Upgrade to renameat2(RENAME_NOREPLACE) when the
// Android/Linux build matters.
pub fn rename_no_replace(from: &Path, to: &Path) -> io::Result<()> {
    fs::rename(from, to)?;
    sync_dir(parent_dir(to))
}

/// Moves the file `from` to `to`; fails (`AlreadyExists`) if anything is at `to`, a dangling
/// link included. A hard link is created first because `link(2)` refuses an existing name where
/// `rename(2)` would replace it.
pub fn rename_file_no_replace(from: &Path, to: &Path) -> io::Result<()> {
    fs::hard_link(from, to)?;
    fs::remove_file(from)?;
    sync_dir(parent_dir(to))
}

/// Hiding is just a leading dot here, so there is nothing to clear.
pub fn clear_hidden(_path: &Path) -> io::Result<()> {
    Ok(())
}

/// Hiding is just a leading dot here, so there is nothing to set.
pub fn set_hidden(_path: &Path) -> io::Result<()> {
    Ok(())
}

/// Deleting a file needs write access to its folder, not to the file.
pub fn clear_readonly(_path: &Path) -> io::Result<()> {
    Ok(())
}

/// A leading dot already hides the file here.
pub fn create_hidden(path: &Path) -> io::Result<File> {
    OpenOptions::new().write(true).create_new(true).open(path)
}

/// There are no share modes here; callers that need the file unchanged must not rely on it.
pub fn open_shared_read(path: &Path) -> io::Result<File> {
    File::open(path)
}

pub fn read_at(file: &File, buf: &mut [u8], offset: u64) -> io::Result<usize> {
    std::os::unix::fs::FileExt::read_at(file, buf, offset)
}

/// Names the file behind an open handle: device and inode. Two names of the same file (hard
/// links) give the same pair.
pub fn file_id(file: &File) -> io::Result<(u64, u64)> {
    use std::os::unix::fs::MetadataExt;
    let meta = file.metadata()?;
    Ok((meta.dev(), meta.ino()))
}

/// Free space and file-size limits are not measured on this platform.
pub fn volume_info(_dir: &Path) -> io::Result<VolumeInfo> {
    Ok(VolumeInfo {
        free_bytes: None,
        max_file_bytes: None,
    })
}

/// Not measured on this platform.
pub fn peak_memory_bytes() -> Option<u64> {
    None
}
