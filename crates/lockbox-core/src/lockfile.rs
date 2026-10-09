//! The vault lock: one process at a time may have a vault open.

use std::fs::{File, OpenOptions, TryLockError};
use std::path::Path;

use crate::{CoreError, Result};

/// Holds the exclusive lock on `<vault>/.lock` until dropped. The OS releases the
/// lock when the handle closes, so a crash never leaves a vault stuck; a leftover
/// `.lock` file that nobody holds is simply locked again.
#[derive(Debug)]
pub struct VaultLock {
    _file: File,
}

impl VaultLock {
    /// Opens (creating if needed) `.lock` in `vault_dir` and locks it.
    /// `VaultInUse` if another handle holds it.
    pub fn acquire(vault_dir: &Path) -> Result<VaultLock> {
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(vault_dir.join(".lock"))?;
        match file.try_lock() {
            Ok(()) => Ok(VaultLock { _file: file }),
            Err(TryLockError::WouldBlock) => Err(CoreError::VaultInUse),
            Err(TryLockError::Error(e)) => Err(CoreError::Io(e)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fsio::testutil::TempDir;

    #[test]
    fn second_lock_refused() {
        let dir = TempDir::new();
        let _first = VaultLock::acquire(dir.path()).unwrap();
        assert!(matches!(
            VaultLock::acquire(dir.path()),
            Err(CoreError::VaultInUse)
        ));
    }

    #[test]
    fn lock_released_on_drop() {
        let dir = TempDir::new();
        drop(VaultLock::acquire(dir.path()).unwrap());
        VaultLock::acquire(dir.path()).unwrap();
    }

    #[test]
    fn stale_lock_file_is_reacquired() {
        let dir = TempDir::new();
        std::fs::write(dir.path().join(".lock"), b"left over").unwrap();
        VaultLock::acquire(dir.path()).unwrap();
    }
}
