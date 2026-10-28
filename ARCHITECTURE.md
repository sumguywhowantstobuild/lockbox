# Architecture

This describes what is built today: the Rust core, `crates/lockbox-core` (Plans 1 and 2: the vault engine, then backup,
restore and read-only vaults). The desktop shell and the UI come in later plans and are not here yet. The target design and the reasons behind it
are in the [design spec](docs/design/2026-10-07-lockbox-design.md); this file cites its sections as "spec
5.2" and so on.

The core is a library with no UI. It does all the encryption and holds every key. Its Rust API is internal to the app:
the place where secrets must not cross is the IPC boundary (the bridge between the Rust core and the UI, built in Plan
3).

The public surface is what the shell uses, and nothing more:

- from the crate root: `Vault`, `ReadOnlyVault`, `CoreError`, `Result`, `BackupReport`, `BackupSummary`,
  `CleanupReport`, `CreatedVault`, `Credential`, `JournalStep`, `JournalView`, `PreparedRestore`, `Recovery`,
  `RestoreDestination`, `RestoreOutcome`, `UnlockReport`, `dismiss_restore_journal`, `inspect_restore_journal`,
  `is_reserved_device_name`, `read_vault_id`, `read_vault_name`, `recover_restore`, `verify_backup`, `version`;
- `ids::{VaultId, ItemId, FileId}`; `item::{Item, ItemKind, FileRef}`; `recovery::RecoverySecret`;
  `generator::{PasswordOptions, PassphraseOptions, generate_password, generate_passphrase}`;
  `blob::{CancelToken, OutputJournal, NoJournal, MAX_FILE_BYTES}`; `kdf::MIN_PASSWORD_CHARS`;
  `fsio::{atomic_write, remove_file_retry, remove_dir_all_retry}` (the shell's state files and sweeps).

`Item`, `ItemKind` and `FileRef` have no serde: an item is only ever written sealed, through crate-private wire types,
so no code outside the engine can serialise one to the screen. A `FileRef`'s key, nonce prefix, blob version and chunk
size are crate-private. Raw keys, header writes and the other low-level modules are private. The `test-internals`
feature (tests only, never in a shipped build) re-exports them under `lockbox_core::internals` and turns the
failpoints on, for the integration tests and the shell's tests.

The core has Windows-specific file code (`fsio/windows.rs`) and a portable fallback (`fsio/portable.rs`), so the same
code builds and is tested on Linux CI and can be reused for Android later.

## Code map

Everything below is in `crates/lockbox-core/src/`. App code goes through `Vault`; the low-level modules are private
(tests reach them through `internals`). A "blob" is one stored file, encrypted.

| Module | Its one job |
|---|---|
| `lib.rs` | Crate root; the public surface (re-exports and the facades of `blob`, `fsio`, `item`, `kdf`, `recovery`); `internals`; denies `unsafe` for the whole crate |
| `error.rs` | The single error type, `CoreError`. Fixed wording; no message contains input, secrets or item content |
| `ids.rs` | Random 16-byte IDs (vault, item, file), written as 32 lowercase hex characters |
| `ad.rs` | Encoding of "associated data" (the extra context an encryption is bound to); frozen by test vectors |
| `limits.rs` | Size and nesting checks on untrusted JSON, run before parsing |
| `serde_b64.rs` | Base64 for binary fields in JSON (non-secret fields only) |
| `secret.rs` | `Key32`, a key that wipes itself and never prints; the one OS random source; the one HKDF helper (HKDF makes new keys from a secret) |
| `kdf.rs` | Password to key with Argon2id (a slow, memory-hungry password hash); accepted settings; calibration; the 12-character minimum |
| `recovery.rs` | The recovery secret: generate, 52-symbol display, parse with typo check, derive its key |
| `aead.rs` | The one XChaCha20-Poly1305 call (encryption that also detects tampering) for whole buffers: key slots and items |
| `slots.rs` | Key slots: wrap and unwrap the vault key under the password key or the recovery key |
| `header.rs` | `vault.json` and its `.bak`: strict parse, header MAC (a tamper-evident stamp), writing both copies in order |
| `item.rs` | The item model (login, note, file, collection) and its sealed file format, padded to 512 bytes; its JSON through crate-private wire types |
| `blob.rs` | Encrypting and decrypting file contents in 1 MiB chunks (STREAM, a standard chunked method); `authenticate_copy` (copies a blob unchanged while checking every chunk); cancel token; output-journal hook |
| `manifest.rs` | `backup-manifest.json`: the list of everything in a backup (path, size, SHA-256) with a MAC, and its strict parser |
| `archive.rs` | The backup file (one stored ZIP64 archive): our own strict reader for the few shapes we write, and the writer |
| `lockfile.rs` | The `.lock` file with an OS exclusive lock: one process per vault |
| `fsio/mod.rs` | Safe file operations: `atomic_write` (all or nothing), `replace_file`, `rename_dir_no_replace`, retries, hidden temps, space checks |
| `fsio/windows.rs` | The Win32 calls. The only place `unsafe` is allowed |
| `fsio/portable.rs` | The same small surface for non-Windows systems |
| `vault/mod.rs` | `Vault`: create, change password, regenerate recovery key, accept a changed header, search |
| `vault/unlock.rs` | Opening a vault: header fallback and repair |
| `vault/items.rs` | Items in an open vault: add, edit, trash, restore, collections |
| `vault/files.rs` | Files in an open vault: import, replace, save a decrypted copy, purge |
| `vault/cleanup.rs` | The cleanup that runs at unlock; listing and deleting quarantined files |
| `vault/naming.rs` | Vault names, folder names and timestamps |
| `vault/backup.rs` | Making a backup of an open vault: built hidden, re-read and checked, then published |
| `vault/source.rs` | One way to unlock and check a vault, whether it sits in a folder or inside a backup; also "test a backup" |
| `vault/restore.rs` | Restore: check and extract into a hidden staging folder, the journaled swap into place, and recovery after a crash |
| `vault/journal.rs` | The restore journal: its strict reader and validation, and the lock around it |
| `vault/readonly.rs` | `ReadOnlyVault`: look inside a backup or a `.before-restore` folder, save a file out, copy an item out |
| `search.rs` | The in-memory search index (returns item IDs only) |
| `generator.rs` | Password and passphrase generator (EFF word list in `wordlists/`) |

Tests: unit tests sit beside the code. `tests/` uses the public API, and `internals` where it must build or read what
the API keeps private (those tests need `--features test-internals`): `vault_lifecycle.rs`, `files.rs`,
`properties.rs` (random and corrupted input), and two checks run on purpose, `large_file.rs` (4 GiB) and
`backup_large.rs` (a 4 GiB file through backup, test, restore and export). A third check run on purpose,
`search.rs` (5 000 items), uses the public API only. The parsers for backup input (the archive, the manifest, the
restore journal) have property tests beside their code, because they are crate-private: random and damaged bytes
must give an error with fixed wording, never a panic.

## How data flows

### Create a vault (`Vault::create`)
1. Check the name and the password length (spec 5.2). Make a random vault key and calibrate Argon2id to about 1 s.
2. Derive the password key, make the recovery secret and derive its key. Wrap the vault key into two key slots
   (spec 5.2). Add the header MAC.
3. Remove old `.creating-*` folders left by a crash. Build the whole vault in a hidden `.creating-<random>` folder in
   the same parent (`items/`, `files/orphaned/`, `vault.json`, `vault.json.bak`) and sync it to disk.
4. Unhide it and rename it to its final name without replacing anything (spec 6.3), then take the `.lock`.
5. Return the open vault and the recovery secret. The caller shows the secret once; the core never writes it to disk
   (only the slot it unlocks is stored).

### Unlock (`unlock_with_password`, `unlock_with_recovery`)
1. No `vault.json` and no `.bak`: `NotFound`, and nothing is created. Otherwise take the `.lock` first, so nothing is
   read while another process has the vault open.
2. Read `vault.json` and `vault.json.bak`: at most 64 KiB each, strict parse, Argon2 settings and the key slot's
   version checked before any derivation (spec 6.1, 5.2).
3. Unwrap the vault key from `vault.json`. If that fails, or the file cannot be read, try `.bak` (spec 6.3). A readable
   `vault.json` falls back only to a `.bak` of the same vault, and at unlock a newer format is never replaced by an
   older copy (a later header write can still replace it; see SECURITY.md, "An unreadable or newer-format header copy
   is left alone at unlock").
   The derived key is reused when salt and settings match, so there is one Argon2 run, not two.
4. Open every file in `items/` with the vault key. A file that does not open goes on the damaged list and is never
   deleted or overwritten.
5. Check the header MAC. Repair the other header copy only if the MAC passed and the repair destroys nothing unverified
   (see rules). A failed repair is reported in the result; it does not fail the unlock.
6. Run cleanup (spec 6.4), in this order: delete `*.tmp` and `*.partial` leftovers; finish purges that were started;
   delete blobs listed as retired, from `files/` and the quarantine; move quarantined blobs back if an item references them again; move unreferenced
   blobs to `files/orphaned/`, unless any item was damaged. It never fails an unlock; what did not work is counted and
   tried again next time.
7. The search index is built from the open items. The caller gets the vault and a report of what was noticed.

### Save an item
`update_item` takes only the editable fields from the caller and keeps the rest from the stored copy. It then:
1. seals the item: JSON, padded to a multiple of 512 bytes, XChaCha20-Poly1305 with a fresh nonce (a one-time value)
   and associated data that binds vault and item ID (spec 5.4);
2. writes it with `atomic_write` (hidden temp file in the same folder, flushed, unhidden, swapped over the target);
3. only then replaces the in-memory copy and rebuilds the search index. If the write fails, the file is read back and
   memory takes what is on disk (the old item, or the new one if it did land) when that read-back works; if it does
   not, memory is left as it was.

### Import and export a file
- **Import** (`attach_file`, `new_file_item`, `replace_attachment`): check length and free space, encrypt chunk by chunk
  into `files/<id>.blob.partial`, flush, check for cancel, `replace_file` to `files/<id>.blob`. Only then is the item
  saved with `atomic_write`. The item file is the commit point; a failure before it leaves an unreferenced blob that
  cleanup sets aside (spec 6.4). Replacing a file lists the old one in the item's `retired_blobs`; cleanup deletes it.
- **Export** (`export_file`): refuses a destination inside the vault. Decrypts into a hidden temp file beside the
  destination (recorded first through the journal hook, a list that lets a crash cleanup find leftovers), checks the
  whole stream, flushes, unhides, checks for cancel, then `replace_file` over the destination (spec 7.2). A failed or
  cancelled export leaves an existing destination alone.
- **Purge** (`purge_item`, trashed items only): rewrite the item with `purging: true`, delete its blobs from `files/`
  and the quarantine (never one another item still attaches; refused while `files/` or `files/orphaned/` is a link),
  then delete the item file. A crash in between is finished at the next unlock. Refused while `items/` is a link,
  checked before the mark and again before the item file is deleted.

### Restore a backup (`PreparedRestore::prepare`, `commit`; spec 6.8)
1. `prepare` refuses while anything is at the journal path, then opens the archive with its own parser, unlocks it
   with the password or recovery key, and checks the manifest, every header and item hash, the header MAC, that every
   blob belongs to an item, and the free space. Nothing is written yet.
2. The destination in the chosen parent folder (`RestoreDestination`):
   - `SameVault`: the one real folder there whose header (either copy, read without the key) has the backup's vault
     ID is replaced (several are refused); without one, a new folder `<name>-<short id>`.
   - `NewFolder(name)`: for a vault folder whose two header copies are unreadable. Refused while a readable copy of
     the vault is in the parent ("vault already here"), for a name `check_folder_name` refuses ("folder name"), and,
     like every new folder, when anything at all is at that name ("destination exists"). The damaged folder is never
     touched.
3. Only then: the journal (`extracting`) under its lock, the hidden `.restore-<hex>` staging folder beside the
   target, and the extraction, each entry hashed as it is written and again as it is read back. Any error removes the
   staging folder, then the journal.
4. `commit` takes the replaced vault's lock (`VaultInUse` if it is open), picks a free `.before-restore` name,
   re-validates the journal under its lock, writes `swapping`, renames the old vault aside, renames the staging folder
   into place with a rename that never replaces (so a name taken after step 2 stops the swap), and removes the
   journal.
5. At launch, `recover_restore` finishes or undoes a swap that was cut short. `inspect_restore_journal` reads the
   same journal through the same read-and-validate code without acting on it (only `<journal>.lock` may be created),
   so the interface can show where the folders are and whether their drive is there.

### Passwords and the recovery key
Every header write first asks a private guard on the open vault. It refuses (with a fixed message) while a header
changed outside Lockbox has not been accepted, while the other header copy holds a slot this unlock could not check
(only a write that replaces that slot may go ahead), and after a failed write left `vault.json` in a state Lockbox
cannot establish (reopen the vault). A credential change that goes through clears it. `accept_header` clears only the
pending consent; if a slot is unverified it writes each file with the accepted header and that file's own version of the
slot, backup first, and the slot block stays until a credential change replaces it.

`change_password` derives a new key with a fresh salt (a random value mixed into the password) and writes `vault.json`,
then `.bak`. `regenerate_recovery` writes `.bak` first, then `vault.json`, so a failed write never leaves `vault.json`
holding a secret the user did not receive. (If the process dies after both writes but before the caller shows the new
secret, it is lost; the password still works.) Neither changes the vault key (spec 5.3).

## Rules the code must keep

1. **All writes go through `atomic_write` or `replace_file`.** Nothing is written in place. A file gets its final name
   only by one of these two (header and item files by `atomic_write`; blobs and exports by a temp file and
   `replace_file`), and the vault folder itself only by `rename_dir_no_replace`. A decrypted copy or a backup is
   published by `replace_file_gated`: the same retried move, each attempt run through the output journal's `publish`
   gate, with the waits between attempts outside it; a refusal from the gate stops it, and the temp is removed. (The folders inside it, `items/`,
   `files/` and `files/orphaned/`, are empty working folders created in place with `create_dir_all`.) That same
   no-replace rename also moves blobs into and out of `files/orphaned/` during cleanup; it is a rename, not a write.
   Restore is the exception in two places: it writes each entry in place inside its hidden staging folder (a new
   file, synced, closed and read back before the next), which holds no vault until it is renamed into place and is
   removed whole by the clean-up, recovery or a dismissal (rule 15); and it publishes the restore journal's first
   version with `atomic_create`, the same temp-file write renamed only to a name that is still free. The empty lock
   files, a vault's `.lock` and the journal's `<journal>.lock`, hold no data and are created in place too. Spec 6.2.
2. **`unsafe` only in `fsio::windows`.** (`unsafe` marks Rust code the compiler cannot check.) The crate root has
   `#![deny(unsafe_code)]`; that one module opts out, and each block carries a comment saying why it is sound.
3. **Repair only what was verified.** The other header copy is overwritten only when the header that unlocked passed its
   MAC, and the other copy is missing or unparseable (never a file that failed to read for another reason, and never a
   newer-format file), or is the same vault with an identical slot that this unlock could not check. Otherwise both
   files stay as they are. Spec 6.3.
4. **Nothing referenced is deleted automatically.** Deletion needs an intent written into an authenticated item
   (`purging`, `retired_blobs`). Unreferenced blobs are moved to `files/orphaned/`, never deleted, and not even moved
   if any item is damaged. The one exception: a failed item copy (`copy_item_from`) deletes from `files/` the blobs it
   published itself, when no item can reference them (its new item cannot be on disk). Damaged items are never
   deleted. Cleanup refuses to work through an `items/` or `files/` folder that is a link, a junction or another
   reparse point that redirects the path (what Windows calls a "name surrogate"); a cloud-sync placeholder, such as
   OneDrive's, does not redirect and is a real folder. Spec 6.4.
5. **Secrets live in `Zeroizing` buffers (memory wiped when released) or types that wipe themselves.** `Key32` cannot be
   copied, printed or saved by accident (no `Clone`, `Display` or serde). Sealing and opening items happens inside one
   pre-sized wiped buffer.
6. **No secrets in `Debug`, `Display` or errors.** Secret types print `<redacted>`; `CoreError` messages are fixed
   wording with no input in them; library error text that could quote data is replaced before it is passed on
   (requirement R5).
7. **No hand-written cryptography.** Only the RustCrypto crates (a family of well-reviewed Rust encryption libraries)
   listed in [SECURITY.md](SECURITY.md#how-lockbox-encrypts). The one thing written here is the small encoding around
   them (IDs, associated data, base64).
8. **One shared version of each piece of logic.** One XChaCha20-Poly1305 call (`aead.rs`), one random source and one
   HKDF helper (`secret.rs`), one retry helper and one atomic write (`fsio`), one timestamp
   formatter (`vault/naming.rs`). Fix a bug once, there.
9. **Untrusted input is checked before work is done.** File sizes, JSON depth, Argon2 settings and version numbers are
   checked before parsing or deriving anything; an unknown or newer format is refused, never guessed at.
10. **Disk first, memory second.** A change reaches the in-memory vault only after its file is written; after a failed
    write, memory re-reads the file and takes it when the read-back works. For the header, memory adopts `vault.json`
    only if it holds the previous or the intended header state (it does not prove authorship); anything else blocks later
    header writes. While a key slot is unverified, any failed header write blocks them until the vault is reopened.
11. **Persistent formats are pinned by tests.** Associated-data bytes, key slots, the header MAC, item plaintext and
    the recovery-key display each have fixed expected values, so a refactor cannot silently change them.
12. **A backup is read only by our own strict parser.** The `zip` crate only writes archives. Reading never goes
    through it: `archive.rs` accepts exactly the shapes we write (stored entries, fixed names, entries that fill the file
    with no gap or overlap) and refuses anything else, naming the check that failed. Spec 6.7.
13. **Every blob that moves is authenticated as it moves.** Into a backup, out of a backup into a restored vault, and
    out of a vault or backup into another vault, a blob goes through `authenticate_copy` (or the same chunk-by-chunk
    decryption), so a damaged blob is caught while it is copied, not later, and the partial copy is thrown away.
    Spec 6.7, 6.8, 6.9.
14. **A restore changes nothing in the vaults folder outside a hidden staging folder until every check has passed.**
    The staging folder (`.restore-<random>`, beside the destination) is where the backup is extracted while the last
    checks run: every blob is authenticated as it is written, and every entry is hashed again as it is read back. The
    only other writes before then are the restore journal and its lock file (`<journal>.lock`), at the path the caller
    gives (the design keeps them in the user's profile, not in the vaults folder), and the existing vault's lock:
    commit takes it before its final re-checks, which can create an empty `.lock` inside that vault. The existing vault
    is moved aside to `<folder>.before-restore` (never overwriting an earlier one) only at the final swap. Spec 6.8.
15. **The journal is checked before it is acted on, and the staging folder goes before the journal.** A journal whose
    paths are not what a restore would write (not absolute, not siblings, wrong names) is refused and touches nothing.
    Cleaning up removes the staging folder first and the journal last, so a crash in between leaves a journal that
    points at nothing (recovery clears it), never a staging folder with no journal, though a dismissal while the
    staging folder's drive is not plugged in can leave one (below). While the folder that holds the staging folder is
    missing (its drive is not plugged in, say), recovery and the clean-up after a failed restore decide nothing and
    keep the journal: a staging folder that cannot be seen is not a staging folder that is gone. Dismissal, the user's
    confirmed way out, still removes the journal then, and touches nothing on the missing path. Spec 6.8.
16. **Read-only is a separate type.** `ReadOnlyVault` has no method that changes its source, the folder or the backup
    it was opened from: opening a backup or a `.before-restore` folder takes no lock and repairs, cleans and creates
    nothing. Its exports (`export_file`) write only a decrypted copy of a file, to a place the user picked, and only
    when asked; that place may not be the backup itself, inside the folder being viewed, or inside any vault folder (a
    folder that holds `vault.json` or `vault.json.bak`, or any folder under one). `Vault::export_file` refuses the
    same vault folders (and its own vault folder). A function that must not change a vault cannot be handed one that
    can. Spec 6.9.

## Where the "why" lives

| Topic | Spec section |
|---|---|
| Key hierarchy, key slots, header MAC | [5.2](docs/design/2026-10-07-lockbox-design.md#52-key-hierarchy) |
| Password change, recovery, regenerate | [5.3](docs/design/2026-10-07-lockbox-design.md#53-password-change-recovery-and-recovery-key-regeneration) |
| Item format | [5.4](docs/design/2026-10-07-lockbox-design.md#54-items) |
| File (blob) format | [5.5](docs/design/2026-10-07-lockbox-design.md#55-files-blobs) |
| Memory handling and honest limits | [5.6](docs/design/2026-10-07-lockbox-design.md#56-memory-and-honest-limits-all-go-into-securitymd) |
| Folder layout, safe writes, header writes | [6.1–6.3](docs/design/2026-10-07-lockbox-design.md#61-layout) |
| Multi-file changes and cleanup | [6.4](docs/design/2026-10-07-lockbox-design.md#64-multi-file-changes-and-cleanup) |
| Rollback limit | [6.6](docs/design/2026-10-07-lockbox-design.md#66-rollback-and-deletion-v1-limit) |
| Saving decrypted files | [7.2](docs/design/2026-10-07-lockbox-design.md#72-decrypted-output-save-a-copy-and-open) |
| Tests expected | [9](docs/design/2026-10-07-lockbox-design.md#9-testing-acceptance-criteria) |
