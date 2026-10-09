//! Windows file operations. The only module in the crate allowed to use `unsafe`,
//! and only for the Win32 calls below; every block states why it is sound.

#![allow(unsafe_code)]

use std::ffi::OsStr;
use std::fs::{File, OpenOptions};
use std::io;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::fs::OpenOptionsExt;
use std::path::Path;
use std::ptr::null_mut;

use windows_sys::Win32::Storage::FileSystem::{
    FILE_ATTRIBUTE_HIDDEN, GetDiskFreeSpaceExW, GetVolumeInformationW, GetVolumePathNameW,
    MOVE_FILE_FLAGS, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
};

use super::VolumeInfo;

/// Largest file FAT and FAT32 can hold (4 GiB minus one byte).
const FAT_MAX_FILE: u64 = u32::MAX as u64;

/// Room for any path Windows can return (32,767 UTF-16 units) plus the terminating NUL.
const LONG_PATH_UNITS: usize = 32_768;
/// `MAX_PATH + 1`: the documented upper bound for a file-system name from `GetVolumeInformationW`.
const FS_NAME_UNITS: usize = 261;

/// UTF-16, NUL-terminated, as the `...W` functions want. A NUL inside the path would
/// silently cut it short, so it is rejected.
fn to_wide(path: &OsStr) -> io::Result<Vec<u16>> {
    let mut wide: Vec<u16> = path.encode_wide().collect();
    if wide.contains(&0) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "path contains a NUL",
        ));
    }
    wide.push(0);
    Ok(wide)
}

fn move_file(from: &Path, to: &Path, flags: MOVE_FILE_FLAGS) -> io::Result<()> {
    let (from, to) = (to_wide(from.as_os_str())?, to_wide(to.as_os_str())?);
    // SAFETY: both pointers come from live `Vec<u16>`s that end in a NUL and outlive
    // the call; `MoveFileExW` only reads them. No other memory is passed.
    let ok = unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), flags) };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

/// Replaces `to` with `from`; returns once the move is on disk.
pub fn replace_file(from: &Path, to: &Path) -> io::Result<()> {
    move_file(from, to, MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)
}

/// Moves `from` to `to`; fails (`AlreadyExists`) rather than replace.
pub fn rename_no_replace(from: &Path, to: &Path) -> io::Result<()> {
    move_file(from, to, MOVEFILE_WRITE_THROUGH)
}

// On Windows `set_readonly(false)` clears only the read-only attribute. The lint's
// worry (world-writable Unix modes) does not apply.
#[allow(clippy::permissions_set_readonly_false)]
pub fn clear_readonly(path: &Path) -> io::Result<()> {
    let mut perms = std::fs::metadata(path)?.permissions();
    if perms.readonly() {
        perms.set_readonly(false);
        std::fs::set_permissions(path, perms)?;
    }
    Ok(())
}

/// Creates a new file with the hidden attribute set from the start; fails if it exists.
pub fn create_hidden(path: &Path) -> io::Result<File> {
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .attributes(FILE_ATTRIBUTE_HIDDEN)
        .open(path)
}

pub fn volume_info(dir: &Path) -> io::Result<VolumeInfo> {
    let dir = to_wide(dir.as_os_str())?;

    let mut root = vec![0u16; LONG_PATH_UNITS];
    // SAFETY: `dir` is NUL-terminated and live; `root` is a writable buffer of exactly
    // `root.len()` units, which is the length passed, so the call cannot write past it.
    let ok = unsafe { GetVolumePathNameW(dir.as_ptr(), root.as_mut_ptr(), root.len() as u32) };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }

    // The amount this user may use, which respects disk quotas.
    let mut free = 0u64;
    // SAFETY: `root` was NUL-terminated by `GetVolumePathNameW` on success. `free` is a
    // valid `u64` the call writes to; the two other outputs are documented as optional (null).
    let ok = unsafe { GetDiskFreeSpaceExW(root.as_ptr(), &mut free, null_mut(), null_mut()) };
    let free_bytes = (ok != 0).then_some(free);

    let mut fs_name = [0u16; FS_NAME_UNITS];
    // SAFETY: `root` is NUL-terminated. `fs_name` is writable for exactly the
    // `fs_name.len()` units passed. Every other output is documented as optional (null, size 0).
    let ok = unsafe {
        GetVolumeInformationW(
            root.as_ptr(),
            null_mut(),
            0,
            null_mut(),
            null_mut(),
            null_mut(),
            fs_name.as_mut_ptr(),
            fs_name.len() as u32,
        )
    };
    let max_file_bytes = (ok != 0)
        .then(|| {
            let len = fs_name.iter().position(|&c| c == 0)?;
            let name = String::from_utf16_lossy(&fs_name[..len]);
            // exFAT and NTFS are fine; only FAT and FAT32 cap a file at 4 GiB - 1.
            (name.eq_ignore_ascii_case("FAT") || name.eq_ignore_ascii_case("FAT32"))
                .then_some(FAT_MAX_FILE)
        })
        .flatten();

    Ok(VolumeInfo {
        free_bytes,
        max_file_bytes,
    })
}
