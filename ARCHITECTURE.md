# Architecture

This describes what is built today: the Rust core, `crates/lockbox-core` (Plans 1 and 2: the vault engine, then backup,
restore and read-only vaults), and the desktop shell, `crates/lockbox-desktop` (Plan 3, [below](#the-desktop-shell)).
The real screens come in Plan 4, in four parts; the first two, daily use (4A) and files and long jobs (4B), are built: `ui/` has the bridge to Rust, first-time
setup with the recovery key, the lock screen, and the main window with search, the item panel, the forms, the Trash, folders,
`.env` in and out, the save shortcut's box and settings ([the UI design](docs/design/2026-11-05-user-interface-design.md)),
and the backup, restore, older-copy, open-a-backup, move-in, add-files and Save all screens with progress and a Stop.
Changing the password, "forgot password", a new recovery key and more than one vault come in 4C; emptying the trash and export in 4D. The target design and the
reasons behind it are in the [design spec](docs/design/2026-10-07-lockbox-design.md); this file cites its sections as
"spec 5.2" and so on.

The core is a library with no UI. It does all the encryption and holds every key. Its Rust API is internal to the app:
the place where keys and file contents must not cross is the IPC boundary (the bridge between the shell and the UI;
[spec 4.1](docs/design/2026-10-07-lockbox-design.md#41-what-crosses-into-the-ui) lists what may).

The public surface is what the shell uses, and nothing more:

- from the crate root: `Vault`, `ReadOnlyVault`, `CoreError`, `Result`, `BackupReport`, `BackupSummary`,
  `BackupPlan` (a backup that `Vault::backup_check` passed and nothing has begun to write; its `write` makes it, and
  `Vault::backup` is the two together), `CleanupReport`, `CreatedVault`, `Credential`, `JournalStep`, `JournalView`,
  `PreparedRestore`, `Recovery`,
  `RestoreDestination`, `RestoreOutcome`, `UnlockReport`, `UnverifiedSlot` (which credential's key slot the two header
  copies disagree on, from `Vault::unverified_slot`; `Vault::created_at` is the header's creation time, for the
  backup reminder), `dismiss_restore_journal`, `inspect_restore_journal`,
  `CopiedItem`, `folder_name`, `is_reserved_device_name`, `read_vault_id`, `read_vault_name`, `recover_restore`,
  `verify_backup`, `version`, `SearchHit` (what a search found: the item, and the attached file a match was in);
- `ids::{VaultId, ItemId, FileId}`; `item::{Item, ItemKind, FileRef, MAX_ITEM_JSON, PreviousPassword,
  MAX_PREVIOUS_PASSWORDS, check_key_name}`; `recovery::RecoverySecret`; `env_file` (reading and writing `.env` files);
  `generator::{PasswordOptions, PassphraseOptions, generate_password, generate_passphrase}`;
  `blob::{CancelToken, Progress, NoProgress, OutputJournal, NoJournal, MAX_FILE_BYTES}`; `kdf::{MIN_PASSWORD_CHARS, check_new_password}`;
  `fsio::{atomic_write, is_destination_taken, remove_dir_all_retry, remove_file_retry, rename_file_no_replace}` (the
  shell's state files and sweeps), and `fsio::{hidden_temp_path, create_hidden_file, clear_hidden, publish_readable,
  refuse_vault_folder}` (the one way the shell writes a readable file: a hidden temp, then a gated, flushed move).

`Item`, `ItemKind` and `FileRef` have no serde: an item is only ever written sealed, through crate-private wire types,
so no code outside the engine can serialise one to the screen. A `FileRef`'s key, nonce prefix, blob version and chunk
size are crate-private. Raw keys, header writes and the other low-level modules are private. The `test-internals`
feature (tests only, never in a shipped build) re-exports them under `lockbox_core::internals` and turns the
failpoints on, for the integration tests and the shell's tests. It also lets the shell's tests pretend a drive's free
space (`internals::fsio::set_volume_override`, per thread): the one `check_space` stays the only check, and its refusal's
`needed` counts the 64 MiB it keeps free, so "needs X, has Y" always has X above Y.

The core has Windows-specific file code (`fsio/windows.rs`) and a portable fallback (`fsio/portable.rs`), so the same
code builds and is tested on Linux CI and can be reused for Android later.

## Code map

Everything in this table is in `crates/lockbox-core/src/`. App code goes through `Vault`; the low-level modules are private
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
| `recovery.rs` | The recovery secret: generate, 24-word display, parse with typo check, derive its key |
| `aead.rs` | The one XChaCha20-Poly1305 call (encryption that also detects tampering) for whole buffers: key slots and items |
| `slots.rs` | Key slots: wrap and unwrap the vault key under the password key or the recovery key |
| `header.rs` | `vault.json` and its `.bak`: strict parse, header MAC (a tamper-evident stamp), writing both copies in order |
| `item.rs` | The item model (login, key, note, file, collection; a login's earlier passwords) and its sealed file format, padded to 512 bytes; its JSON through crate-private wire types |
| `blob.rs` | Encrypting and decrypting file contents in 1 MiB chunks (STREAM, a standard chunked method); `authenticate_copy` (copies a blob unchanged while checking every chunk); cancel token (a job's token is a child of its session's, so a lock stops every job and a stop leaves the others running); progress hook (bytes done and the total, at most once per MiB); output-journal hook |
| `manifest.rs` | `backup-manifest.json`: the list of everything in a backup (path, size, SHA-256) with a MAC, and its strict parser |
| `archive.rs` | The backup file (one stored ZIP64 archive): our own strict reader for the few shapes we write, and the writer |
| `lockfile.rs` | The `.lock` file with an OS exclusive lock: one process per vault |
| `fsio/mod.rs` | Safe file operations: `atomic_write` (all or nothing), `replace_file`, `rename_dir_no_replace`, the gated renames that publish an output (`rename_replace_gated`; `rename_no_replace_gated`, which never replaces), retries, hidden temps, space checks |
| `fsio/windows.rs` | The Win32 calls. The only place `unsafe` is allowed |
| `fsio/portable.rs` | The same small surface for non-Windows systems |
| `vault/mod.rs` | `Vault`: create (`create_with_id` when the caller must know the folder first), change password, regenerate recovery key, accept a changed header, search |
| `vault/unlock.rs` | Opening a vault: header fallback and repair |
| `vault/items.rs` | Items in an open vault: add, edit, trash, restore, collections |
| `vault/files.rs` | Files in an open vault: import, replace, save a decrypted copy (replacing, or never replacing with numbered names), purge |
| `vault/cleanup.rs` | The cleanup that runs at unlock; listing and deleting quarantined files |
| `vault/naming.rs` | Vault names, folder names and timestamps |
| `vault/backup.rs` | Making a backup of an open vault: built hidden, re-read and checked, then published |
| `vault/source.rs` | One way to unlock and check a vault, whether it sits in a folder or inside a backup; also "test a backup" |
| `vault/restore.rs` | Restore: check and extract into a hidden staging folder, the journaled swap into place, and recovery after a crash |
| `vault/journal.rs` | The restore journal: its strict reader and validation, and the lock around it |
| `vault/readonly.rs` | `ReadOnlyVault`: look inside a backup or a `.before-restore` folder, save a file out, copy an item out (`Vault::copy_item_from` puts the copy in the collection the caller names, by the live vault's own rule, and never carries the source's); for a backup, the date its signed manifest gives (`backup_created_at`) |
| `vault/fixture.rs` | Tests only (`test-internals`): a real backup the engine writes whose one item refers to a file the backup does not hold (`backup_missing_a_file`), for the shell's copy-out question |
| `search.rs` | The in-memory search index (returns item IDs, and the name of the attached file a match was in) |
| `generator.rs` | Password and passphrase generator (EFF word list in `wordlists/`) |
| `env_file.rs` | Reading and writing `.env` files (`NAME=value` lines) for keys; a line it can't read is reported by its number only, and every value is wiped |

Tests: unit tests sit beside the code. `tests/` uses the public API, and `internals` where it must build or read what
the API keeps private (those tests need `--features test-internals`): `vault_lifecycle.rs`, `files.rs`,
`properties.rs` (random and corrupted input), and two checks run on purpose, `large_file.rs` (4 GiB) and
`backup_large.rs` (a 4 GiB file through backup, test, restore and export). A third check run on purpose,
`search.rs` (5 000 items), uses the public API only. The parsers for backup input (the archive, the manifest, the
restore journal) have property tests beside their code, because they are crate-private: random and damaged bytes
must give an error with fixed wording, never a panic.

## How data flows

### Create a vault (`Vault::create`)
1. Check the name and the password length (spec 5.2), and that the parent is not inside a vault folder. Make a random
   vault key and calibrate Argon2id to about 1 s.
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
  `check_import_space` asks the same refusals once for a whole batch of sizes (each over 256 GiB, the file system's limit
  for the largest, free space for every blob together plus the slack kept free) before the first byte of the first file.
- **Export** (`export_file`): refuses a destination inside the vault. Decrypts into a hidden temp file beside the
  destination (recorded first through the journal hook, a list that lets a crash cleanup find leftovers), checks the
  whole stream, flushes, unhides, checks for cancel, then publishes over the destination through the journal's gate
  (`rename_replace_gated`, then `sync_after_replace`; rule 1) (spec 7.2). An export that fails, is cancelled or is
  refused before the rename leaves an existing destination alone. Once the rename has happened the destination holds
  the new copy; if making that durable then fails, the error is returned as published, durability not confirmed. The
  job's cancel token is looked at inside every gated rename attempt, before the move (also for a backup's publication),
  so a Stop that comes while another program holds the temp, during the wait between attempts, stops the publication.
  A write or flush that fails because the drive is full (Windows `ERROR_DISK_FULL` 112 and `ERROR_HANDLE_DISK_FULL` 39,
  or the portable `StorageFull`) is answered as the `NotEnoughSpace` refusal, with `needed` (the file and the slack kept
  free) and `available` (the free space read at that moment, kept below `needed`, 0 where it cannot be read), the temp
  removed; every other I/O error stays one.
- **Export that never replaces** (`export_file_new`, on `Vault` and `ReadOnlyVault`; saving all of a folder's files):
  the same verified temp, but its last step is `rename_no_replace_gated`, one `MoveFileExW` without
  `MOVEFILE_REPLACE_EXISTING` through the same journal gate and waits, whose `renamed` hook disarms the temp's guard in the
  attempt. A taken name (a file, a folder or a link, even a dangling one) answers `DESTINATION_EXISTS` at once, with the
  temp untouched, and the caller's `candidates(n)` gives the next name (`a (2).txt` ... up to 999, then the refusal): the
  copy is decrypted and verified once and moved to the first free name, and each name is refused like `export_file`'s
  (inside the vault, in a vault's folder, the backup itself). Once the move has happened nothing after it
  (the durability step, the failpoint `export.after_publish`) is an error of the save: the answer is the path it has.
  The one failure that comes with a path is the journal's gate failing after the move (its contract allows it): the move
  is not made again and nothing is removed, and the error is a `NewExportError { error, published: Some(path) }` (the
  caller counts the file as saved and ends its batch with `error`); every other error has `published: None`.
  `check_output_space(dir, sizes)` asks the space refusals once for a whole batch of copies, as `check_import_space` does.
- **Purge** (`purge_item`, trashed items only): rewrite the item with `purging: true`, delete its blobs from `files/`
  and the quarantine (never one another item still attaches; refused while `files/` or `files/orphaned/` is a link),
  then delete the item file. A crash in between is finished at the next unlock. Refused while `items/` is a link,
  checked before the mark and again before the item file is deleted.
- **Trash and folders** (`trash_item`, `restore_item`, `delete_collection`): each trash or restore of an item is one
  item write. `delete_collection` writes the items first and the folder last, and each item it newly trashes records the
  folder in `trashed_with` in that same write; an item already in the trash is left as it is, and a retry after a crash
  writes the same value on the items still to go. `restore_item` on a folder brings back the items in the trash that
  name it (still filed in it, and not being purged), items first and the folder last, so a crash leaves the folder in the
  trash and restoring it again finishes the job; a folder being purged is refused whole. Restoring any other item clears
  its own `trashed_with` and brings back its folder alone, folder first.

### Restore a backup (`PreparedRestore::prepare`, `commit`; spec 6.8)
1. `prepare` refuses while anything is at the journal path, then opens the archive with its own parser, unlocks it
   with the password or recovery key, and checks the manifest, every header and item hash, the header MAC, that every
   blob belongs to an item, and the free space. Nothing is written yet.
2. The destination in the chosen parent folder (`RestoreDestination`):
   - `SameVault`: the one real folder there whose header (either copy, read without the key) has the backup's vault
     ID is replaced (several are refused); without one, a new folder `<name>-<short id>`, refused if the parent is
     inside a vault folder.
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
   `replace_file`), and the vault folder itself only by `rename_dir_no_replace`. (The folders inside it, `items/`,
   `files/` and `files/orphaned/`, are empty working folders created in place with `create_dir_all`.) That same
   no-replace rename also moves blobs into and out of `files/orphaned/` during cleanup; it is a rename, not a write.
   A decrypted copy or a backup is published by `replace_file`'s two halves, split: `rename_replace_gated` retries the
   move with each attempt run through the output journal's `publish` gate (the waits between attempts outside it),
   then `sync_after_replace` makes it durable. A transient error (sharing violation, access denied) is retried; a gate
   refusal or any other error stops the retries, and the temp is then removed, its record cleared only if the removal
   worked (otherwise it stays recorded for the crash sweep). A durability error after the move is returned with the
   destination already published.
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

## The desktop shell

`crates/lockbox-desktop` is the Tauri 2 app between the screens and the engine (spec 4). The commands are thin wrappers
that parse their own request and call a plain-Rust `Shell`, so almost every rule is tested without a window. Every call
to Windows sits behind a small trait in `os/mod.rs`; tests use the fakes in `testing.rs`. The crate builds only on
Windows.

### Code map

Everything in this table is in `crates/lockbox-desktop/src/`.

| Module | Its one job |
|---|---|
| `lib.rs` | Builds the app: the launch order, the signal and tick threads, locking on every way out |
| `shell.rs` | `Shell`: owns everything below, runs the launch work, sends the page's events |
| `session.rs` | `Sessions`: open vaults keyed by location, each with a generation, a cancel token and a publish guard (`SessionInfo` also says its `kind`, from the location and the read-only flag: `vault`, `older_copy` or `backup`; a backup's `name` is its file's name without `.lockbox-backup`); the lock epoch and the launch token (cancelled and replaced with each lock of all vaults); locking in two phases; the ordered lock-hook thread |
| `autolock.rs` | The idle timer, the table of long operations (jobs) that pauses it, Windows signals, and the shutdown with its 2 s bound |
| `jobs.rs` | A job as the page sees it: its operation ID, its scope (a session and generation, or a launch's lock epoch), its own cancel token, and the throttled `lockbox://job-started`, `lockbox://progress` and `lockbox://lock-epoch` events; also the shape of `lockbox://close-asked` |
| `clipboard.rs` | A copy's life: write, its timer, and clearing only if the copy's own tag is still there |
| `outputs.rs` | The output journal (`pending-outputs.json`), the gate every decrypted file is published through, and the launch sweep |
| `open.rs` | "Open": the file name allowlist, executable types, the user-only folder, the internet mark, removal and retries; also `save_name`, the lighter name rule for a folder's saved files (only what Windows refuses, what could leave the folder, or a direction control that makes an executable read as a document is changed) |
| `restore.rs` | One restore at a time: the five steps (pick, password check, folder, copy, swap), its state machine, launch recovery, pre-restore copies and their checks |
| `locations.rs` | Where a vault may live: drive type, file system, links on the way, forbidden folders, cloud folders |
| `registry.rs` | The vault list (`vaults.json`, version 2): locations and each vault's last-known name, no secrets (the name is read from the header, kept at add, rename and each list read, shown when the folder or header is gone, and removed with its row); a random list identity and a highest-ID mark, so a row is named by list and ID (`VaultRef`), an ID is never given twice on one list, and a row from before Ask 12's new list names nothing; version 1 reads and is rewritten as 2 |
| `settings.rs` | The app-wide settings with their bounds (`settings.json`): idle time, clipboard delay, theme, the save shortcut (two modifiers, a letter, digit or F1 to F12, never Ctrl with C, V or X) and capture protection |
| `startup.rs` | Start with Windows: the `Run` value's name and command line, how Windows' own on/off value reads, the `--hidden` rule, and the two commands' answers |
| `vault_state.rs` | What is noted about each vault folder (`vault-state.json`, keyed by folder, never by vault ID): the "recovery key not confirmed" mark, written before a key is made, and when the vault was last backed up (`YYYY-MM-DDTHH:MM:SSZ`, UTC, written when a backup is published and never otherwise) |
| `dates.rs` | The one date shape the shell writes and reads (RFC 3339, UTC, whole seconds), and "whole days since": the 30-day backup reminder counts from the last backup, else from the vault's creation |
| `pending.rs` | One-time tokens for a question whose answer needs something kept (a credential, a chosen folder); they end after five minutes or when all vaults lock, and a pasted `.env`'s values, the copies waiting in a cloud question, the files picked to be added, and Save all's plans, cloud questions and summary handles also when their own vault locks (the picked list keeps one token while Pick more and Remove change it, each starting its five minutes again; a Save all plan is read, then used up by its start, and told apart from its cloud question, which is the same choice with no files; the summary's handle is read, never used up, and closed by `close_output`); a backup picked to be tested (its path, and the lock epoch it was held in) belongs to no vault, so only a lock of all vaults, expiry, a new pick or `forget_test_backup` drop it, and each `test_backup` attempt starts its five minutes again; a backup picked to be opened read-only (`PendingChoice::OpenBackup`) is held the same way, as a kind of its own that the test never answers for (and the other way round), with `forget_open_backup`; a backup picked to be restored is held the same way (`PendingChoice::RestorePick`, with `forget_restore_pick`, and every use of it, a check or a copy, in use until it ends), and once the password has worked it also holds the credential that worked and what the check found (the vault's name, ID and date, and the folder), so the typed text is on the page only until it is sent; a lock of all vaults of any kind, an idle one included, drops it |
| `paths.rs` | The state folder and default vault folder from Windows' known folders; the size-capped, strict state-file reader |
| `views.rs` | What an item looks like to the page: no keys, no nonces, no password unless revealed |
| `error.rs` | `ShellError`: a fixed code and fixed fields, never a path, a name or input |
| `window.rs` | The one window: what it may load, open, download or receive, and how it starts (shown, or hidden for a `--hidden` start) |
| `commands/` | The `#[tauri::command]` wrappers. `list.rs` names every command; `args.rs` parses a request strictly |
| `commands/add_files.rs` | Many files in: the picker and its held list (paths stay in Rust), and `add_files`, one job for the batch (one bar over every file's bytes) where each file is its own change of the vault, the vault is let go between two files, a file that cannot be read, or is no longer the size measured, is named and skipped, and a Stop or a refusal names what was not added |
| `commands/batch.rs` | What the two batch jobs share: the bar over every file's bytes together, the 30 ms the vault is let go between two files, the wait while another command has the vault (tried every 50 ms for 30 s by the shell's clock), and what a cancelled job's token means |
| `commands/save_all.rs` | Saving all of a folder's files: `save_all_files` (the picker, the shared destination checks, the batch's space, the plan), `save_all_files_confirm` (the cloud question's yes), `save_all_start` (the checks again, then one job over every file, each its own read of the vault, never replacing; a damaged file, one that went, a full drive and a Stop each named in the summary) and the summary's handle (`show_output_in_explorer`, `close_output`) |
| `os/mod.rs` | The traits (`Dialogs`, `Launcher` (a link, an opened copy, a folder in Explorer), `IdleSource`, `Power`, `Clock` (monotonic time, the wall clock, the PC's local date and its offset from UTC, which turns a backup's UTC date into the day the person calls it), `Timer`, `ClipboardBackend`, `Volumes`, `Env`, `MainWindow`, `Hotkey`, `StartupEntry`) and the shared clipboard steps |
| `os/win.rs` | The real Windows calls (the real clocks included), the hidden signal window and the one-copy mutex. The only place the shell allows `unsafe` |
| `os/signals.rs` | Turns a window message into an `OsSignal` |
| `testing.rs` | The fakes (test builds only) |

Beside the code: `capabilities/main.json` (what the page may call), `tauri.conf.json` (the Content Security Policy and
app settings), `tests/ipc.rs` (the bridge, through Tauri's own permission checks). In `ui/src/`: `bridge.ts`, the one
place that calls Rust and drops stale answers; `api.ts`, the typed commands the screens use; `store.ts`, what the page
keeps of each unlocked vault, wiped by a lock; `messages.ts`, the fixed words for every refusal; `dropGuard.ts`; `App.tsx`
and `screens/`, the screens; `parts/`, the shared parts (Base UI gives the behaviour and accessibility, plain CSS every
pixel); `styles/`, the style sheets (tokens, components, the short-window, high-contrast and print rules); `testing/`, the
pretend shell the screen tests run against and the axe-core check. `screens/everyScreen.test.tsx` reaches every screen as a
person would and checks it with axe-core and for `<style>` elements; a component a screen file exports that no case reaches
fails it, so a new screen can't go unchecked. `policy.test.ts` pins the Content Security Policy and checks the built page
carries no inline script or style (Tauri would add a hash for one to the policy, letting it run).

State lives in `%LOCALAPPDATA%\Lockbox\`: `vaults.json`, `settings.json`, `vault-state.json`, `pending-outputs.json`,
`restore-journal.json` and `open\`. Vaults default to `%USERPROFILE%\Lockbox Vaults\`.

### How data flows

**Launch** (the `.setup` hook in `lib.rs`). The single-instance plugin hands a second copy over to the first window. A
named mutex then catches the case it misses, so a second copy never runs launch work. The signal window starts, and the
app refuses to run without it. `Shell::launch_work` settles a half-done restore, sweeps the output journal, then sweeps
`open\`. Only then is the shell made available to commands and the window built, and the app refuses to run if WebView2
cannot confirm that external file drops are off.

**Unlock** (`unlock_vault`). The page sends a registry ID and the password, never a path. The strict parser reads them
into a wiped string. The session opens under its location, so a vault opens once. Inside: `check_location` on the folder,
a check that it is still the listed one, then the engine's unlock. If a lock came during that second or so, the result
is discarded and the vault's key is released (spec 7.4). The answer carries the session and generation, which the bridge
remembers.

**Lock** (`Sessions::lock`, `lock_all`, `revoke_some`). Two phases. First, the revocation: in one step every affected
session's generation goes up and its state becomes `Locked` or `Unavailable`, and from this moment no command gets
through. Each publish guard is then passed once, so an attempt that saw the old generation has finished. Operations are
cancelled, the session lets go of the vault, a lock of all vaults also drops every pending token, and the page gets its
`lockbox://locked` event. Second, the hooks are queued on one ordered thread: the clipboard's (with a short timeout), the
"Open" folders' (its deletes run on a worker), then the restore's. The timer, the signal router and the folder check never
wait for a hook; the page's lock commands and shutdown do, shutdown until its 2 s deadline. (If Windows refuses shutdown's
helper thread, revocation runs inline and can wait past the deadline for one publish attempt.) The vault key goes when
the last operation holding it finishes (spec 7.4's two guarantees).

**Copy** (`copy_field`). The value never reaches the page. Rust reads the field, then in one clipboard opening, under
the session's publish guard, which re-checks the generation: empties the clipboard, writes a 16-byte random tag, the
three exclusion formats, and the text last. A failure before the clipboard is emptied leaves it as it was; a failure after
empties it again in the same opening, and if that fails too the copy stays owned and the clear is retried. A timer clears
it after the delay, and so does a lock, in one opening and only if that tag is still there, so a later copy of the user's
own stays. A clear that finds the clipboard busy retries while the app runs. The answer re-checks the generation too.

**Long jobs** (`autolock.rs` `begin_job`, `jobs.rs`). A job is one entry in the table of long operations that pauses the
idle timer, so "a job" is exactly what the timer counts. Its token is a child of its scope's: the session's for a job of
an unlocked session (`JobScope::Session`, with the generation it started in), the launch's for one with no session
(`JobScope::Launch`, with the lock epoch it started in). A lock of that session, or of all vaults for the launch's,
stops every job in the scope; the page's Stop (`cancel_operation`, given the operation and its scope) stops one job and
no other. A scope that has gone answers `Locked` and a job not running in it `NotFound`, and a launch job's answer after
the epoch changed is refused as `Locked`. A command that takes the page's `request` number sends `lockbox://job-started`
(request, operation, scope, kind) once its work starts, then `lockbox://progress` at most about ten times a second and
always one last event with `finished: true`; the page learns the operation from that event only, since an answer arrives
after the job has ended. Every lock of all vaults also sends `lockbox://lock-epoch`, with or without a vault open. All three
go to the main window only. Open, Replace file and copying an item are jobs in the table and send neither.

**Close and Quit with a job running or a restore waiting** (`Shell::ask_before_closing`, `close_answer`). The window's
close button and the tray's Quit first ask `AutoLock::running_kinds`, which lists the kinds of every operation the idle
timer counts (each once, in start order), and `Restores::waiting`, which is true only in `RestoreState::Prepared` (a
restore extracted, checked and waiting at 24d for the yes). With none running and none waiting, both do what they always
did. With either, nothing is locked, hidden or cancelled: the page is sent `lockbox://close-asked` (`reason` close or
quit, the kinds, `past_swap`, `restore_waiting` and `question`; the page shows a job's question before the waiting restore's) and the shell keeps
one pending question, with the lock epoch it was asked in and what was sent. `question` is the question's own ID, minted by the shell (a counter
kept under the same lock as the pending question, counting up from 1 and never reused; a plain JSON number, far below 2^53 like the operation IDs
and the lock epoch, and the page ignores one that is not a positive safe integer). A Quit comes from the tray, so the window is shown first. A
second close or Quit while it is pending sends the same event again (the first one's reason, payload and ID; a Quit shows the window again), so a
question the page never showed cannot leave Close and Quit dead; the page knows a repeat by its ID and changes nothing, and ignores the event of a
question whose answer has settled or that is older than the newest it has shown, so a late echo cannot bring an answered question back; a question
a lock cleared on the page before anyone answered it shows again if the shell repeats it, since the shell may still hold it
(`a_second_close_sends_the_same_question_again`, `a_repeat_carries_the_same_id`, `a_repeated_event_after_its_answer_cannot_reopen_it`,
`a_question_cleared_by_a_lock_before_an_answer_shows_again_when_the_shell_repeats_it`).
A lock of all vaults (a new epoch) clears it. **When the last
running operation ends while the question is pending in the current epoch, and no restore waits at 24d or is past its swap,
the shell answers it as Close anyway itself** (`Shell::carry_on_close`): there is nothing left to cancel, so the close or
Quit the person asked for goes ahead with no second press, and the page's own answer, if it comes after, is `NotFound`
(`the_last_job_ending_still_carries_on_with_the_close`, `last_job_ending_carries_on_with_the_quit`). The auto-lock tells the shell through a
hook (`AutoLock::on_last_end`) that `Operations::end` calls with no lock of its own held; the hook only starts a thread
(`lockbox-carry-on`, holding a `Weak` to the shell, which is why `Shell::new` returns an `Arc`), because the end can come from
`LongOp`'s drop inside a lock's cancel or a lock hook and the go path waits for the lock hooks
(`the_carry_on_does_not_run_on_the_ending_jobs_thread`). A thread that cannot start leaves the question pending. With anything
still running or waiting the question stays as asked (`a_job_ending_with_another_running_keeps_the_question`,
`a_restore_waiting_at_24d_keeps_the_question_when_its_copy_ends`). The page
answers with `close_answer(question, go)`, naming the question it was given: `Shell::claim_close_answer` compares the ID and the
lock epoch with the pending question's under the lock before it takes the question out, so an answer to an older question (answered or
dropped) is `NotFound` and leaves a newer one pending (`a_stale_answer_is_refused_and_leaves_the_newer_question_answerable`). `false` changes nothing, `true` runs the old path for the question's reason (a close:
`close_window`, whose lock cancels the jobs, ends a waiting restore and which still shows 5b on a first close; a Quit: the shutdown within 2 s,
which also waits, inside that bound, for the waiting restore's clean-up so its staging folder and journal are gone before the exit
(`quitting_removes_the_staging_folder_and_journal_before_it_returns`), then the exit through `MainWindow::exit_app`). Either answer uses the question up, and an answer with none pending (or for
another question) is `NotFound`. `past_swap` is the engine's flag from `PreparedRestore::swap_flag`, which goes on when the restore's journal
says `swapping` (the point from which a cancel no longer counts) and is kept in `RestoreState::Committing`: a restore
there finishes, or is undone by recovery at the next launch, whatever is answered. Windows ending the session never
asks (its path is the shutdown, as before).

**Back up** (`backup_vault`, `vault_backup_due`). A backup is a session job (`JobKind::Backup`) with progress and a Stop;
the save dialog suggests `<vault name> <local date>.lockbox-backup`, and the page never receives the path. The engine
refuses a backup in four cases the person acts on differently, and the shell tells them apart with fixed words:
`details changed` (a header change not yet accepted), `password copies disagree` and `recovery key copies disagree`
(asked of the open vault, `Vault::unverified_slot`) and `details unchecked` (a failed header write left its state
unknown, or `vault.json` is no longer the header that was opened). A drive known to have too little room refuses with the
numbers before anything is written; an unreadable free-space figure never blocks. Every refusal that comes before the
first byte (those four, a destination inside the vault or one that cannot be replaced, too many entries, too little
room, a stop while the files are measured) is the engine's `Vault::backup_check`, which the shell runs before it begins
the job: the page is sent `job-started` only for work that has begun, so these reach it as plain refusals (the "not
enough space" screen needs the numbers, not a "didn't finish" screen). The job then runs `BackupPlan::write`. Only a published backup notes its date;
a date that cannot be saved does not fail a backup that is on disk. `vault_backup_due` answers `{ days }` once the last
backup, else the vault's creation, is 30 or more whole days back, and `null` otherwise and always for a read-only session.
A published backup's answer (`BackupView`) also carries `test`, a held `TestBackup` choice for the file just written
(`{ choice, file_name, size }`), so "Test this backup" needs no picker.

**Test a backup** (`test_backup_pick`, `test_backup`, `forget_test_backup`). The pick comes first: the picker (titled "Test
a backup", with the backup filter) runs outside every lock and the path is held in `pending.rs` as
`PendingChoice::TestBackup { path, epoch }`; the page gets `{ choice, file_name, size }` and never the path. The lock epoch
is read before the picker, and a lock that came meanwhile takes the choice back out and answers `Locked` (a closed picker
answers `Dismissed`, leaving the choice sent with it; a new pick forgets that choice). `test_backup` takes the choice, the
credential and the page's `request`: a missing, used, expired, other-kind or other-epoch token answers `ChoiceExpired`
(`Pending::use_test_backup`, which holds the choice in use until the attempt ends, so no sweep drops it however long the
check runs, and then starts its five minutes again); the credential is read before the job
begins (a malformed one starts none); the job is `begin_launch_job(JobKind::Test, Some(request))`, so the page hears
`job-started` and `progress` under `{ "type": "launch", "epoch": N }` and can Stop it; and the answer goes through
`answer_job`, so a lock of all vaults while it ran, or the app closing, answers `Locked` whatever was found. Every other
answer keeps the choice. The credential's third form, `{ "password_or_key": text }`, is tried as a recovery key first when
the text is a well-formed key (and as a password too when that is wrong), and as a password only when it is not
(`CredentialArg::attempts`); the other commands' `CredentialArg::typed` refuses it. No session is needed, so the three
commands take no session or generation. Testing writes nothing.

**Open a backup read-only, and copy items out of it** (`open_backup_pick`, `forget_open_backup`, `open_backup_read_only`,
`copy_item_to`). Two steps, as testing is. `open_backup_pick` (picker titled "Open a backup") holds the path as
`PendingChoice::OpenBackup { path, epoch }` with exactly the rules of a held test backup (the page gets
`{ choice, file_name, size }`; a lock while the picker is open is `Locked` with nothing held; a closed picker is
`Dismissed`; a lock of all vaults, closing, a new pick, `forget_open_backup` or five minutes drop it), and it is a kind
of its own: a test choice sent to the open, or an open choice to the test, is `ChoiceExpired` and is left where it is.
`open_backup_read_only(choice, credential, request)` reads the credential as the test does (`attempts`: the one box tries
a well-formed key as a key, then as a password) and runs `ReadOnlyVault::open_backup` in a launch-scoped job
(`JobKind::OpenBackup`, progress, a Stop through `cancel_operation`, the engine's token the job's own); the session it
opens is keyed by the backup's location and a backup already open is answered as it is. A wrong credential, damage, a
Stop or an I/O refusal keep the choice; a session opened, and any `Locked` (a lock of all vaults or closing, found as the
job begins, when the open ends, or in the announcement that ends the job), use it up. Every session answer carries
`kind` (`vault`, `older_copy`, `backup`), computed from the session's location and read-only flag; a backup session is
named for its file. `copy_item_to` takes the target vault's `folder` (a folder ID in hex, or `null`; the key is
required) and passes it to `Vault::copy_item_from`, which refuses a folder the target does not have, or has in the trash,
with `InvalidInput { "collection" }` before anything is written (`Vault::check_copy_collection` is that same check, which
the shell runs first, so a folder that would be refused is never preceded by `Confirm::MissingFiles`, the question about
files the backup lacks; the yes is the same command again, with the same folder). A backup or an older copy is only ever
a source: as a target it is `ReadOnly`, and a writable session as a source is `InvalidInput { "source vault" }`.

**Open** (`open_file`). The stored name goes through the allowlist. An executable type asks first, before anything is
decrypted. Then in a long operation (the idle timer pauses): a new folder only this user can reach, recorded in the
journal first; the engine's export, which checks the whole stream before the copy gets its name; the internet mark and
the read-only flag. The generation is checked as the vault is let go, and the launch comes after that, under no lock,
so a blocked "How do you want to open this?" dialog cannot delay locking. Copies go at the lock, at close and at launch;
one a viewer still holds is reported and retried.

**Restore** (`restore_pick`, `restore_check`, `restore_choose_folder`, `restore_prepare`, `restore_prepare_confirm`,
`restore_commit`, `restore_discard`, `forget_restore_pick`). Five steps on one held pick, none of which takes a path.
`restore_pick` opens the picker ("Restore a backup", the backup filter) and holds the path as
`PendingChoice::RestorePick { path, epoch, vault, checked }`; `Busy` while a restore is alive. Its `vault` (a number on
the vault list or `null`) is for the questions that offer a backup for a vault (Ask 4: some items cannot be read; Ask 8: both
header copies are damaged): one not on the list is `NotFound` before a picker opens, and the check then makes the folder
that holds that vault the restore's folder (`usual` false), not the usual one. The engine's own rules do the rest: a vault
that opens is found there and replaced (kept as an older copy), and a folder whose headers cannot be read is never written,
since the backup unpacks into a new folder beside it (the existing new-folder question, which refuses a name in use). The
vault list tells the page which vaults Ask 8 is for: `VaultEntry.details_damaged` is true exactly when the folder holds a
header file (`vault.json` or `vault.json.bak`) and every copy there is refused by the engine as damaged (corrupt or too
large: `lockbox_core::header_is_damaged`); an empty folder, one with no header files, a header another program holds (a
sharing violation) and a newer vault have no name from the header either but are not damaged; each such row shows the
name the list kept for it, or none when it never had one (`both_headers_unreadable_listed_with_the_kept_name`,
`a_listed_folder_with_no_vault_in_it_lists_the_same_way`, `a_header_held_by_another_program_is_not_damage`). While the
pick's folder is still the damaged vault's own parent (Choose another has not moved it), `restore_prepare` never uses the
engine's same-vault rule, which would find a healthy copy of the backup's vault there (the sibling an earlier Ask 8 restore
made) and replace it: it restores into a new folder of the default name, asks the new-folder question when that name is the
damaged folder's, and is refused ("vault already here", as the engine refuses a second writable copy of a vault in one
folder) when such a sibling is there (`a_second_ask_8_restore_never_replaces_the_first_sibling`,
`ask_8_from_a_renamed_folder_goes_to_the_default_folder`). Ask 4's vault opens, so it keeps the same-vault rule.
`restore_check` takes the typed
text (`{ "password_or_key": text }`: a well-formed key is tried as a key, then as a password) and the page's `request`, opens the backup read-only
without unpacking it (`ReadOnlyVault::open_backup`), and keeps the credential that worked (`Attempts::run_keeping`), the
vault's name and ID, the day it was made (`backup_created_at` read in the PC's zone, `Clock::utc_offset_secs`) and the
usual folder (`<Profile>\Lockbox Vaults`) in the pick. It is a launch-scoped job of kind `restore_check` (`begin_launch_job`,
begun with the page's `request` after the credential has been read: `job-started`, idle time paused, counted by the close
question, no progress) whose own stop, a child of the launch token, is what `open_backup` is given: Cancel at 24a
(`cancel_operation`) ends it as `Cancelled`, and a good result found cancelled just before it would be kept is discarded
with its credential. A refusal or a Stop keeps nothing new and leaves the pick held as it was (an earlier check stays,
exactly as after a wrong password); 24a's Cancel leaves the restore and lets the file go. A lock of all vaults drops the
pick (`Locked`). `restore_choose_folder` (needs a checked pick) opens "Restore into this folder" starting in the pick's folder and
moves the pick there, the credential kept (in the pending table only: across the dialog the call holds the folder it starts
in and a use guard, `RestorePickUse::release_checked`, and takes the pick again after it, `ChoiceExpired` if it is gone, so
a lock wipes the credential while the dialog is open). Both answer `RestoreChecked { name, made, folder_shown, usual,
replaces_existing }`; the folder is shown as text and never accepted back. `restore_prepare` makes the usual folder when it
is missing, runs `check_location` on the folder (a cloud folder asks first, the question holding the pick's token and no
credential), then the engine's `prepare` as a launch-scoped job of kind `restore` (`begin_launch_job`: `job-started`, the
bytes written as progress, a Stop by `cancel_operation`); the engine's own checks (the credential, the vault ID the check
saw against the archive actually opened, `PreparedRestore::prepare_expecting`, free space, the destination) come first
inside it, so a refusal is the job's answer. A refusal leaves the pick held (another folder can be chosen), except `backup
changed` (the file is another vault's now: `InvalidInput`, nothing written, the pick and its credential forgotten); a
finished copy, a Stop and a lock drop it, since the staged restore holds all it needs. An existing folder the
engine cannot tell is the same vault asks for a new name (`Confirm::NewFolder`, suggested from the name and ID the check
found, with no second unlocking). The answer carries `kept_as`: the name the swap will give the older copy, the first free
of `<folder>.before-restore` and `-2` to `-99` by the engine's own rule (`None` when all are taken; the swap then refuses), and
`replaces`: the vault the swap would replace, as its ID on the vault list (`Some` when `replaces_existing` and that vault is
listed), which the page lists the older copies of when the swap is refused for too many of them (the commit keeps the finished
restore for that refusal, `too_many_copies_keeps_the_finished_restore`, so Replace can be pressed again after a delete).

**Older copies** (`list_pre_restore`, `open_pre_restore_read_only`, `delete_pre_restore`; plain commands, not jobs). The listing
replaces every ID, and each entry carries the folder's name (never its path), `last_written` (the local day of the newest
modified time of any regular file under the folder, items and stored files included, in the PC's zone) and `size` (the regular
files under the folder, links not followed), both from one walk and each `null` on a read error, read before the list is locked
(`pre_restore_list_says_the_day_and_size`, `an_older_copys_day_counts_the_item_files_too`). Opening takes
the same one-box credential as Test a backup (`CredentialArg::attempts`, `pre_restore_opens_with_the_one_box_credential`); a
delete asks first and is refused `Busy` while a session is open on the copy (`pre_restore_delete_checks`). The page keeps one
listing and sends the ID of the newest; a copy opened read-only is a session whose place on the vault list is none, so the live
vault never shows as unlocked because of it (`ui/src/store.ts`, `NOT_ON_THE_LIST`).

`Prepared` holds no long operation, no credential and no unlocked vault (its staging folder is encrypted), so **an idle
lock leaves it**: the lock hook (`Restores::locked`) tells `LockReason::Idle` apart and ends the restore for every other
reason (Lock all, the window's close, Windows locking, sleep, closing), and `Sessions::non_idle_lock_since` says the same
before the hook has run. `restore_commit` is a launch-scoped job with no Stop (`begin_launch_job_without_stop`:
`job-started`, nought of one to one of one, and `cancel_operation` finds nothing to stop); it locks the vault open at
the destination with `LockReason::Restore`, waits up to 10 s for it to let go, and commits. It is refused `Cancelled` only
when the restore was ended by a lock other than an idle one, or by the person's lock of the destination (matched by
location, so it also catches a vault unlocked after `prepare`). Once the swap starts it finishes or rolls back by the
journal, whatever locks. A commit the engine says cannot be retried goes straight to recovery. A stale journal at
`restore_prepare` runs recovery and answers with its result.

**What a restore that did not finish tells the page** (`restore_notice`, `retry_restore_recovery`, `dismiss_restore`, and
`lockbox://notice` with `kind: "restore"`). Recovery runs at launch before the window (`Shell::launch_work`) and its
result is kept (`RestoreNotice`), so a reloaded page asks again. `recovered` (`staging_removed`, `rolled_back` or `finished`)
carries `vault: { id, name } | null`: the vault of the list at the journal's folder, read before recovery removes the
journal and looked up once it is done, never a path. A `finished` restore whose swap ended before `restore_commit` listed the
vault is listed by recovery, as that does, so the notice can name it. `drive_missing` carries `folder`, the target's parent
as text (what the drive-missing screen names); the page never sends it back.

### Rules the shell must keep

Each rule names the tests that pin it. Spec 9 and the spec-to-test map behind this list are the fuller record.

1. **Vault keys, file keys and file contents never cross to the page; a stored password only on "Reveal" or edit.** Core
   `Item`s cannot be serialised, and the views hold no key, nonce or unrevealed password: `item_is_not_serialize`,
   `views_never_carry_keys_or_unrevealed_password`, `reveal_returns_password_tagged`. The recovery key crosses once, when
   it is made, for display, and the generator's output is a new value, not a stored one. Spec 4.1.
2. **Paths never come from the page.** Commands take IDs and values; Rust opens every dialog: `request_with_a_path_field_refused`
   (one each in `commands/vaults.rs`, `files.rs`, `backup.rs`), `restore_requests_are_strict`, `restore_pick_vault_field_is_strict`,
   `item_requests_refuse_unknown_fields`.
   Paths go the other way as text, for showing only and never accepted back, in four cases: a restore that cannot
   finish (its notice, and the question before dismissing it), the folder a restore will use, the folder Save all
   files is about to write to (and later saved to), and a readable file Lockbox saved where you chose (the recovery
   key's PDF, a saved `.env`).
3. **Every command needs a permission, and the window has exactly the expected set.** `capability_grants_exactly_the_expected_set`,
   `granted_command_runs_in_main_window`, `every_listed_command_reaches_its_handler`, `other_window_is_refused`,
   `remote_origin_is_refused`, `plugin_commands_are_refused`. Spec 4.2.
4. **A malformed request gets a fixed error, never the parser's text.** `malformed_request_answers_fixed_error`.
5. **The window goes nowhere and takes nothing in.** Navigation, new windows, downloads, drops, the policy:
   `navigation_allows_only_the_app`, `dev_server_refused_in_release`, `security_config_is_pinned`, and the window probes
   in the hands-on list (no test runtime runs WebView2's callback).
6. **An answer from before a lock is never delivered.** The backend checks the generation at the start and before it
   returns; the bridge drops an answer with an old tag: `stale_generation_refused`, `result_after_lock_is_never_returned`,
   `lock_during_search_and_reveal`, `search_all_skips_locked_sessions`, `ui/src/bridge.test.ts`. Spec 7.4.
7. **Locking revokes first, and revocation and the automatic triggers never wait for a hook** (the page's lock commands
   wait for theirs, after revoking). `lock_steps_run_in_spec_order`, `blocked_hook_never_delays_other_vaults`,
   `blocked_hook_never_stalls_triggers`, `overlapping_locks_finish_in_turn`.
8. **A lock waits for one publish attempt at most, never for its retries.** `lock_waits_only_for_one_publish_step`,
   `lock_not_delayed_by_a_held_file`, and the engine's `publish_called_once_per_attempt`.
9. **A lock during an unlock discards the vault.** `lock_during_unlock_discards_vault`, `open_since_a_stale_epoch_answers_locked_and_does_not_open`.
10. **A long operation pauses the idle timer; Windows lock and sleep cancel it.** `long_operation_pauses_idle`,
    `idle_counts_from_end_of_long_operation`, `windows_lock_cancels_long_operations`, `sleep_locks_all`, `keep_awake_off_when_last_op_ends`.
    A question waiting for an answer does not pause it, but a finished restore waiting for its answer survives an idle lock
    (and only an idle one): `restore_copy_pauses_idle_time`, `finished_restore_survives_an_idle_lock`,
    `lock_all_discards_a_finished_restore`, `windows_lock_discards_a_finished_restore`, `sleep_discards_a_finished_restore`.
    The page's "Lock all"
    also cancels operations that have no session: `the_pages_lock_all_cancels_operations_without_a_session`. A Stop stops one
    job and a lock stops every job of its scope: `cancel_operation_stops_only_that_job`, `a_lock_cancels_every_job_of_its_session_and_sends_finished`,
    `lock_all_cancels_launch_jobs_and_refuses_their_answers`; the job events go to the main window only:
    `progress_events_go_to_the_main_window_only`.
11. **Every way out locks every vault; shutdown waits for that at most 2 s, then the app goes on closing** (one exception:
    the helper thread refused, in the Lock flow above, can wait longer). A vault not yet revoked by then ends with the
    process. `shutdown_locks_and_runs_hooks`, `closing_refuses_new_work`, `shutdown_bound_holds_under_operation_contention`,
    `shutdown_without_helper_revokes_inline`, `shutdown_clears_our_copy`, `shutdown_removes_all_opened_files`. That Tauri's
    exit events reach this code needs a real window, so the hands-on list covers it. With a job running, a close or Quit
    asks first and nothing is locked or cancelled until the answer; Windows ending the session never asks:
    `close_with_a_job_running_asks_first`, `close_anyway_cancels_the_jobs_then_hides_and_locks`, `keep_it_running_changes_nothing`,
    `quit_with_a_job_running_asks_first`, `close_past_the_swap_says_it_finishes_next_time`, `a_lock_epoch_change_clears_the_question`,
    `windows_ending_the_session_does_not_wait_for_an_answer`. When the last job ends the shell carries the question on:
    `last_job_ending_carries_on_with_the_close`, `last_job_ending_carries_on_with_the_quit`,
    `keep_it_running_then_the_job_ends_closes_nothing`. A restore waiting for its yes asks too:
    `close_with_a_restore_waiting_asks_first`, `quit_with_a_restore_waiting_asks_first`,
    `close_anyway_with_a_restore_waiting_ends_it_then_hides_and_locks`, `keep_it_open_leaves_the_restore_waiting`.
12. **A vanished drive locks its vault as unavailable, never deleted.** `drive_gone_lock_marks_unavailable`,
    `vanished_folder_locks_as_unavailable`, `drive_gone_revokes_every_vault_on_it_despite_a_blocked_hook`. Spec 6.10.
13. **The clipboard is one opening, and fails closed.** `write_and_clear_are_each_one_opening`, `failed_exclusion_empties_clipboard`,
    `failed_step_empties_in_the_same_opening`, `copy_after_lock_never_writes`, `copy_racing_lock_never_leaves_secret`. Only
    our own tag is cleared: `user_copy_after_ours_is_kept`, `only_the_exact_tag_counts`, `later_copy_not_cleared_by_earlier_timer`. Spec 7.3.
14. **A temp plaintext file is recorded before it exists, and the sweep deletes only what Lockbox made.**
    `record_before_temp_exists`, `record_write_failure_stops_the_output`, `sweep_ignores_paths_it_did_not_make`,
    `sweep_refuses_a_junctioned_higher_ancestor`, `sweep_rechecks_before_each_delete`, `damaged_journal_kept_and_reported`. Spec 7.2.
15. **Nothing is launched before the whole file has verified, and the launch holds no lock.** The engine's
    `export_verify_then_publish` pins the verification and the shell launches only on its success;
    `opened_copy_is_read_only_and_launched_after_unlock`, `lock_between_decrypt_and_launch_stops_launch`,
    `locking_is_not_delayed_by_a_blocked_launch`. No shell test opens a damaged file and checks that nothing launched.
16. **An opened copy has a safe name, a user-only folder and the internet mark, or it does not open.** `safe_name_table`,
    `rtl_override_name_sanitised_and_flagged`, `trailing_dot_executable_flagged`, `executable_needs_confirmation_first`,
    `open_folder_acl_is_user_only`, `opened_copy_carries_the_internet_mark`, `mark_that_cannot_be_written_stops_the_open`,
    `open_refused_where_permissions_do_not_last`, `open_refused_when_a_link_leads_to_the_open_folder`.
17. **No opened copy stays for good.** `lock_removes_that_vaults_opened_files`, `file_in_use_is_kept_and_retried`,
    `sweep_removes_a_copy_left_by_a_crash`, `leftover_is_removed_while_the_journal_is_damaged`,
    `other_things_in_the_open_folder_are_left_alone`. A held copy does not hold up the launch:
    `launch_does_not_wait_out_held_copies`.
18. **Locations are checked at create, add, unlock, recover and the restore parent.** `locations_refused_table`,
    `fixed_ntfs_accepted`, `link_into_a_forbidden_folder_refused`, `unlock_rechecks_location`, `recover_confirm_rechecks_location`,
    `add_existing_vault_checks_the_folder`, `restore_parent_location_checked`, `cloud_folder_needs_confirmation`. Output stays
    out of the state folder: `save_into_state_folder_refused`. A new vault folder never goes inside another vault's folder (the engine's
    `create_inside_a_vault_folder_refused`, `same_vault_restore_inside_a_vault_folder_refused`). Spec 6.10.
19. **Launch work comes before any command, and one copy of the app runs it.** `launch_runs_recovery_before_anything`,
    `instance_claim_is_refused_while_another_holds_it`. No test fails if the order inside `.setup` changes, since that
    needs a real window; the hands-on list checks the result (a leftover "Open" folder is gone by the time the window shows).
20. **A restore's own lock of its destination goes on; any other cancels it until the swap starts.**
    `own_destination_lock_does_not_cancel`, `user_lock_of_destination_cancels_before_commit`,
    `destination_lock_with_its_hook_still_queued_cancels`, `a_lock_just_before_the_swap_cancels_it`,
    `restore_closes_open_vault_first`, `lock_during_restore`, `no_restore_starts_between_a_failed_commit_and_its_recovery`,
    and the engine's `a_cancel_during_the_last_checks_stops_the_swap`. Spec 6.8.
21. **A question that keeps something for its answer is a one-time token, and a lock of all vaults ends it.** (A plain yes,
    such as an executable type or deleting a pre-restore copy, is a flag on the repeated request, which goes through the
    same checks.) `token_expires_after_five_minutes`, `create_vault_confirm_with_unknown_or_other_token_refused`,
    `lock_all_drops_everything_pending`, `ask_racing_lock_parks_nothing`.
22. **Read-only sessions refuse every write.** `read_only_session_refuses_writes`, `read_only_session_refuses_every_edit`,
    `sessions_for_backup_and_live_vault_coexist`. A pre-restore copy whose header was changed opens and says so:
    `pre_restore_copy_with_a_changed_header_says_so`. Spec 6.9.
23. **Stored links open only for `http` and `https`, from Rust.** `only_http_and_https_urls_open`, `lock_during_link_launch_answers_locked`.
24. **Errors carry fixed text and numbers only.** `core_errors_keep_their_numbers`, `malformed_request_answers_fixed_error`,
    `notice_json_is_flat_and_debug_hides_paths`. R5.
25. **`unsafe` only in `os::win`.** The crate root has `#![deny(unsafe_code)]`, which the compiler enforces; that one
    module opts out, and each block carries a `// SAFETY:` comment.

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
| What crosses to the page; command security | [4.1](docs/design/2026-10-07-lockbox-design.md#41-what-crosses-into-the-ui), [4.2](docs/design/2026-10-07-lockbox-design.md#42-tauri-command-security) |
| Where a vault may live | [6.10](docs/design/2026-10-07-lockbox-design.md#610-locations-locking-and-filesystems) |
| Saving decrypted files | [7.2](docs/design/2026-10-07-lockbox-design.md#72-decrypted-output-save-a-copy-and-open) |
| Clipboard | [7.3](docs/design/2026-10-07-lockbox-design.md#73-clipboard) |
| Locking | [7.4](docs/design/2026-10-07-lockbox-design.md#74-locking-concurrency-contract) |
| Tests expected | [9](docs/design/2026-10-07-lockbox-design.md#9-testing-acceptance-criteria) |
