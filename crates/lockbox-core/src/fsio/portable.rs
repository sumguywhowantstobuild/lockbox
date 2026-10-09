//! Non-Windows file operations. Lockbox ships on Windows first; this keeps the crate
//! building and tested on Linux CI and ready for other platforms.

use std::fs::{self, File, OpenOptions};
use std::io;
use std::path::Path;

use super::{VolumeInfo, parent_dir};

/// Makes a rename durable: flush the folder that holds the new name.
fn sync_dir(dir: &Path) -> io::Result<()> {
    File::open(dir)?.sync_all()
}

pub fn replace_file(from: &Path, to: &Path) -> io::Result<()> {
    fs::rename(from, to)?;
    sync_dir(parent_dir(to))
}

/// The caller has already checked that `to` does not exist.
pub fn rename_no_replace(from: &Path, to: &Path) -> io::Result<()> {
    fs::rename(from, to)?;
    sync_dir(parent_dir(to))
}

/// Deleting a file needs write access to its folder, not to the file.
pub fn clear_readonly(_path: &Path) -> io::Result<()> {
    Ok(())
}

/// A leading dot already hides the file here.
pub fn create_hidden(path: &Path) -> io::Result<File> {
    OpenOptions::new().write(true).create_new(true).open(path)
}

/// Free space and file-size limits are not measured on this platform.
pub fn volume_info(_dir: &Path) -> io::Result<VolumeInfo> {
    Ok(VolumeInfo {
        free_bytes: None,
        max_file_bytes: None,
    })
}
