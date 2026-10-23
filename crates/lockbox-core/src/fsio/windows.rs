//! Windows file operations. The only module in the crate allowed to use `unsafe`,
//! and only for the Win32 calls below; every block states why it is sound.

#![allow(unsafe_code)]

use std::ffi::OsStr;
use std::fs::{File, OpenOptions};
use std::io;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::fs::OpenOptionsExt;
use std::os::windows::io::AsRawHandle;
use std::path::Path;
use std::ptr::null_mut;

use windows_sys::Win32::Storage::FileSystem::{
    BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_HIDDEN, FILE_FLAG_BACKUP_SEMANTICS,
    GetDiskFreeSpaceExW, GetFileAttributesW, GetFileInformationByHandle, GetVolumeInformationW,
    GetVolumePathNameW, INVALID_FILE_ATTRIBUTES, MOVE_FILE_FLAGS, MOVEFILE_REPLACE_EXISTING,
    MOVEFILE_WRITE_THROUGH, MoveFileExW, SetFileAttributesW,
};
use windows_sys::Win32::System::ProcessStatus::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS};
use windows_sys::Win32::System::Threading::GetCurrentProcess;

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

/// Replaces `to` with `from`. `MOVEFILE_WRITE_THROUGH` is passed as planned (Microsoft
/// documents it as waiting for a copy-then-delete move to finish); the content itself
/// is made durable by the caller's `sync_all` on the source before this move.
pub fn replace_file(from: &Path, to: &Path) -> io::Result<()> {
    move_file(from, to, MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)
}

/// Moves `from` to `to`; fails (`AlreadyExists`) rather than replace.
pub fn rename_no_replace(from: &Path, to: &Path) -> io::Result<()> {
    move_file(from, to, MOVEFILE_WRITE_THROUGH)
}

/// Moves the file `from` to `to`; fails (`AlreadyExists`) if anything is at `to`.
pub fn rename_file_no_replace(from: &Path, to: &Path) -> io::Result<()> {
    rename_no_replace(from, to)
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

/// Rewrites a file's or folder's attributes through `change`; skips the write if nothing changes.
fn change_attributes(path: &Path, change: impl FnOnce(u32) -> u32) -> io::Result<()> {
    let wide = to_wide(path.as_os_str())?;
    // SAFETY: `wide` is a live NUL-terminated UTF-16 path; the call only reads it.
    let attrs = unsafe { GetFileAttributesW(wide.as_ptr()) };
    if attrs == INVALID_FILE_ATTRIBUTES {
        return Err(io::Error::last_os_error());
    }
    let new = change(attrs);
    if new == attrs {
        return Ok(());
    }
    // SAFETY: same `wide` path as above; the attribute value is passed by value.
    let ok = unsafe { SetFileAttributesW(wide.as_ptr(), new) };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

/// Removes only the hidden bit from a file or folder; every other attribute stays.
pub fn clear_hidden(path: &Path) -> io::Result<()> {
    change_attributes(path, |attrs| attrs & !FILE_ATTRIBUTE_HIDDEN)
}

/// Adds only the hidden bit to a file or folder; every other attribute stays.
pub fn set_hidden(path: &Path) -> io::Result<()> {
    change_attributes(path, |attrs| attrs | FILE_ATTRIBUTE_HIDDEN)
}

/// Flushes a folder to disk. Opening a folder needs `FILE_FLAG_BACKUP_SEMANTICS`, and the
/// flush needs a handle opened for writing; std supplies both safely.
pub fn sync_dir(path: &Path) -> io::Result<()> {
    OpenOptions::new()
        .write(true)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
        .open(path)?
        .sync_all()
}

/// Creates a new file with the hidden attribute set from the start; fails if it exists.
pub fn create_hidden(path: &Path) -> io::Result<File> {
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .attributes(FILE_ATTRIBUTE_HIDDEN)
        .open(path)
}

/// Opens for reading and shares read access only, so nobody can write, rename, replace or
/// delete the file while this handle is open.
pub fn open_shared_read(path: &Path) -> io::Result<File> {
    const FILE_SHARE_READ: u32 = 1;
    OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ)
        .open(path)
}

/// Reads at `offset` without depending on (or caring about) the handle's position.
pub fn read_at(file: &File, buf: &mut [u8], offset: u64) -> io::Result<usize> {
    std::os::windows::fs::FileExt::seek_read(file, buf, offset)
}

/// Names the file behind an open handle: volume serial number and file index. Two names of the
/// same file (hard links) give the same pair.
pub fn file_id(file: &File) -> io::Result<(u64, u64)> {
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    // SAFETY: the handle comes from a live `File` and stays open for the call; `info` is a
    // valid, writable struct of the type the call fills in.
    let ok = unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    let index = (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow);
    Ok((u64::from(info.dwVolumeSerialNumber), index))
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
    // A failed query means "unknown", and unknown never blocks (see `check_space`).
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

/// The most memory this process has had in RAM at once (peak working set), in bytes.
pub fn peak_memory_bytes() -> Option<u64> {
    let size = size_of::<PROCESS_MEMORY_COUNTERS>() as u32;
    let mut counters = PROCESS_MEMORY_COUNTERS {
        cb: size,
        ..Default::default()
    };
    // SAFETY: `GetCurrentProcess` takes no arguments and returns a pseudo-handle that needs
    // no closing. `counters` is a valid, writable `PROCESS_MEMORY_COUNTERS` whose size is
    // passed as `cb`, so the call cannot write past it.
    let ok = unsafe { GetProcessMemoryInfo(GetCurrentProcess(), &mut counters, size) };
    (ok != 0).then_some(counters.PeakWorkingSetSize as u64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fsio::testutil::TempDir;
    use std::os::windows::fs::MetadataExt;

    #[test]
    fn clear_hidden_works_on_a_hidden_folder() {
        let dir = TempDir::new();
        let folder = dir.path().join("staging");
        std::fs::create_dir(&folder).unwrap();
        let wide = to_wide(folder.as_os_str()).unwrap();
        // SAFETY: test only; `wide` is a live NUL-terminated path.
        let ok = unsafe {
            SetFileAttributesW(
                wide.as_ptr(),
                FILE_ATTRIBUTE_HIDDEN | 0x10, /* directory */
            )
        };
        assert_ne!(ok, 0);
        assert_ne!(
            std::fs::metadata(&folder).unwrap().file_attributes() & FILE_ATTRIBUTE_HIDDEN,
            0
        );
        clear_hidden(&folder).unwrap();
        let attrs = std::fs::metadata(&folder).unwrap().file_attributes();
        assert_eq!(attrs & FILE_ATTRIBUTE_HIDDEN, 0);
        assert_ne!(attrs & 0x10, 0, "directory bit lost");
    }
}
