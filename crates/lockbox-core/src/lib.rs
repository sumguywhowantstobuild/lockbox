//! Lockbox core: the vault engine. All encryption and key handling live here.
//!
//! The public surface is what the desktop shell uses: [`Vault`] and [`ReadOnlyVault`], the
//! reports, the IDs, items (with no serde of their own), the generator and a few file helpers.
//! Raw keys, header writes and the other low-level modules are private; the `test-internals`
//! feature (tests only) opens them under `internals`.

// `deny`, not `forbid`: only `fsio::windows` may opt in, for documented Win32 calls.
#![deny(unsafe_code)]

// Public as a whole: every item is part of the surface.
pub mod generator;
pub mod ids;

// Private. `error` and `vault` are re-exported at the root below. The low-level modules keep their
// items `pub` so `internals` can re-export them; each item that only tests use allows dead code
// in a build without them (on the item, so other dead code is still reported).
pub(crate) mod aead;
mod error;
pub(crate) mod serde_b64;
mod vault;

mod ad;
mod archive;
mod header;
mod limits;
mod lockfile;
mod manifest;
mod search;
mod secret;
mod slots;

// Mixed modules: the code is private, and a public facade of the same name re-exports only what
// the shell uses. The facade's crate-wide glob keeps every other item reachable inside the crate
// under its usual path.
#[path = "blob.rs"]
mod blob_impl;
#[path = "fsio/mod.rs"]
mod fsio_impl;
#[path = "item.rs"]
mod item_impl;
#[path = "kdf.rs"]
mod kdf_impl;
#[path = "recovery.rs"]
mod recovery_impl;

/// Encrypted file blobs: cancelling a long operation, recording the outputs it creates, the size
/// limit.
pub mod blob {
    pub(crate) use crate::blob_impl::*;
    pub use crate::blob_impl::{CancelToken, MAX_FILE_BYTES, NoJournal, OutputJournal};
}

/// Crash-safe file helpers, for the shell's own state files and sweeps.
pub mod fsio {
    pub(crate) use crate::fsio_impl::*;
    pub use crate::fsio_impl::{atomic_write, remove_dir_all_retry, remove_file_retry};
}

/// Saved entries. No serde: an item's JSON (password and file keys included) is only ever written
/// sealed.
pub mod item {
    pub(crate) use crate::item_impl::*;
    pub use crate::item_impl::{FileRef, Item, ItemKind};
}

/// Password rules.
pub mod kdf {
    pub use crate::kdf_impl::MIN_PASSWORD_CHARS;
    pub(crate) use crate::kdf_impl::*;
}

/// The recovery secret: parse what the user types, show a new one.
pub mod recovery {
    pub use crate::recovery_impl::RecoverySecret;
    pub(crate) use crate::recovery_impl::*;
}

/// Everything the public surface leaves out, for the engine's integration tests and the shell's
/// tests. Only with the `test-internals` feature, which no shipped build turns on.
#[cfg(feature = "test-internals")]
pub mod internals {
    pub mod ad {
        pub use crate::ad::*;
    }
    pub mod archive {
        pub use crate::archive::*;
    }
    pub mod blob {
        pub use crate::blob_impl::{
            BLOB_VERSION, CHUNK_SIZE, blob_len, chunk_count, decrypt_stream, encrypt_stream,
        };
    }
    pub mod fsio {
        pub use crate::fsio_impl::*;
    }
    pub mod header {
        pub use crate::header::*;
    }
    pub mod item {
        use crate::ids::FileId;
        use crate::item_impl::FileRef;
        use crate::secret::Key32;

        pub use crate::item_impl::{open_item, same_item, seal_item};

        /// Every field of a [`FileRef`], all public, so a test can build one by hand (the key
        /// fields are crate-private).
        pub struct FileRefParts {
            pub file_id: FileId,
            pub blob_version: u16,
            pub chunk_size: u32,
            pub file_key: Key32,
            pub nonce_prefix: [u8; 19],
            pub length: u64,
            pub chunk_count: u64,
            pub name: String,
            pub media_type: String,
        }

        impl From<FileRefParts> for FileRef {
            fn from(p: FileRefParts) -> Self {
                FileRef {
                    file_id: p.file_id,
                    blob_version: p.blob_version,
                    chunk_size: p.chunk_size,
                    file_key: p.file_key,
                    nonce_prefix: p.nonce_prefix,
                    length: p.length,
                    chunk_count: p.chunk_count,
                    name: p.name,
                    media_type: p.media_type,
                }
            }
        }

        /// The file's key, for a test that checks a key changed.
        pub fn file_key(fref: &FileRef) -> &Key32 {
            &fref.file_key
        }
    }
    pub mod kdf {
        pub use crate::kdf_impl::*;
    }
    pub mod limits {
        pub use crate::limits::*;
    }
    pub mod lockfile {
        pub use crate::lockfile::*;
    }
    pub mod manifest {
        pub use crate::manifest::*;
    }
    pub mod recovery {
        pub use crate::recovery_impl::derive_recovery_key;

        /// A fresh random recovery secret, for a test that builds a vault's slots by hand.
        pub fn generate() -> crate::recovery_impl::RecoverySecret {
            crate::recovery_impl::RecoverySecret::generate()
        }
    }
    pub mod search {
        pub use crate::search::*;
    }
    pub mod secret {
        pub use crate::secret::*;
    }
    pub mod slots {
        pub use crate::slots::*;
    }
}

pub use error::{CoreError, Result};
pub use vault::{
    BackupReport, BackupSummary, CleanupReport, CreatedVault, Credential, PreparedRestore,
    ReadOnlyVault, Recovery, RestoreOutcome, UnlockReport, Vault, dismiss_restore_journal,
    read_vault_name, recover_restore, verify_backup,
};

/// The version of this crate, as set in `Cargo.toml`.
pub fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

/// Checks that the public surface stays narrow: each snippet must fail to compile.
#[cfg(doctest)]
mod surface {
    /// Header writes are internal.
    ///
    /// ```compile_fail
    /// use lockbox_core::header::write_headers;
    /// ```
    pub fn header_is_private() {}

    /// Raw keys are internal.
    ///
    /// ```compile_fail
    /// use lockbox_core::secret::Key32;
    /// ```
    pub fn secret_is_private() {}

    /// A core `Item` cannot be serialised outside the engine (it holds the password and file
    /// keys).
    ///
    /// ```compile_fail
    /// fn f(_: impl serde::Serialize) {}
    /// fn g(i: lockbox_core::item::Item) { f(i) }
    /// ```
    pub fn item_is_not_serialize() {}

    /// Nor can a login's kind (it holds the password).
    ///
    /// ```compile_fail
    /// fn f(_: impl serde::Serialize) {}
    /// fn g(k: lockbox_core::item::ItemKind) { f(k) }
    /// ```
    pub fn item_kind_is_not_serialize() {}

    /// Nor a file record (it holds the file key).
    ///
    /// ```compile_fail
    /// fn f(_: impl serde::Serialize) {}
    /// fn g(r: lockbox_core::item::FileRef) { f(r) }
    /// ```
    pub fn file_ref_is_not_serialize() {}

    /// And no code outside the engine can build an `Item` from JSON.
    ///
    /// ```compile_fail
    /// fn f<T: serde::de::DeserializeOwned>() {}
    /// fn g() { f::<lockbox_core::item::Item>() }
    /// ```
    pub fn item_is_not_deserialize() {}
}

#[cfg(test)]
mod tests {
    #[test]
    fn version_matches_cargo() {
        assert_eq!(super::version(), "0.1.0");
    }
}
