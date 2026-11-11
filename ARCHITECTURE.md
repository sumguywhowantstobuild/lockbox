# Architecture

This describes what is built today: the Rust core, `crates/lockbox-core` (Plans 1 and 2: the vault engine, then backup,
restore and read-only vaults), and the desktop shell, `crates/lockbox-desktop` (Plan 3, [below](#the-desktop-shell)).
The real screens come in Plan 4, and have begun: `ui/` has the bridge to Rust, the lock screen and the main window (unlock,
the item list, copying a password); creating a vault, adding items and the rest come in later tasks. The target design and the
reasons behind it are in the [design spec](docs/design/2026-10-07-lockbox-design.md); this file cites its sections as
"spec 5.2" and so on.

The core is a library with no UI. It does all the encryption and holds every key. Its Rust API is internal to the app:
the place where keys and file contents must not cross is the IPC boundary (the bridge between the shell and the UI;
[spec 4.1](docs/design/2026-10-07-lockbox-design.md#41-what-crosses-into-the-ui) lists what may).

The public surface is what the shell uses, and nothing more:

- from the crate root: `Vault`, `ReadOnlyVault`, `CoreError`, `Result`, `BackupReport`, `BackupSummary`,
  `CleanupReport`, `CreatedVault`, `Credential`, `JournalStep`, `JournalView`, `PreparedRestore`, `Recovery`,
  `RestoreDestination`, `RestoreOutcome`, `UnlockReport`, `dismiss_restore_journal`, `inspect_restore_journal`,
  `CopiedItem`, `folder_name`, `is_reserved_device_name`, `read_vault_id`, `read_vault_name`, `recover_restore`,
  `verify_backup`, `version`;
- `ids::{VaultId, ItemId, FileId}`; `item::{Item, ItemKind, FileRef, MAX_ITEM_JSON}`; `recovery::RecoverySecret`;
  `generator::{PasswordOptions, PassphraseOptions, generate_password, generate_passphrase}`;
  `blob::{CancelToken, OutputJournal, NoJournal, MAX_FILE_BYTES}`; `kdf::{MIN_PASSWORD_CHARS, check_new_password}`;
  `fsio::{atomic_write, is_destination_taken, remove_dir_all_retry, remove_file_retry, rename_file_no_replace}` (the
  shell's state files and sweeps).

`Item`, `ItemKind` and `FileRef` have no serde: an item is only ever written sealed, through crate-private wire types,
so no code outside the engine can serialise one to the screen. A `FileRef`'s key, nonce prefix, blob version and chunk
size are crate-private. Raw keys, header writes and the other low-level modules are private. The `test-internals`
feature (tests only, never in a shipped build) re-exports them under `lockbox_core::internals` and turns the
failpoints on, for the integration tests and the shell's tests.

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
| `item.rs` | The item model (login, note, file, collection) and its sealed file format, padded to 512 bytes; its JSON through crate-private wire types |
| `blob.rs` | Encrypting and decrypting file contents in 1 MiB chunks (STREAM, a standard chunked method); `authenticate_copy` (copies a blob unchanged while checking every chunk); cancel token; output-journal hook |
| `manifest.rs` | `backup-manifest.json`: the list of everything in a backup (path, size, SHA-256) with a MAC, and its strict parser |
| `archive.rs` | The backup file (one stored ZIP64 archive): our own strict reader for the few shapes we write, and the writer |
| `lockfile.rs` | The `.lock` file with an OS exclusive lock: one process per vault |
| `fsio/mod.rs` | Safe file operations: `atomic_write` (all or nothing), `replace_file`, `rename_dir_no_replace`, retries, hidden temps, space checks |
| `fsio/windows.rs` | The Win32 calls. The only place `unsafe` is allowed |
| `fsio/portable.rs` | The same small surface for non-Windows systems |
| `vault/mod.rs` | `Vault`: create (`create_with_id` when the caller must know the folder first), change password, regenerate recovery key, accept a changed header, search |
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
| `search.rs` | The in-memory search index (returns item IDs, and the name of the attached file a match was in) |
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
- **Export** (`export_file`): refuses a destination inside the vault. Decrypts into a hidden temp file beside the
  destination (recorded first through the journal hook, a list that lets a crash cleanup find leftovers), checks the
  whole stream, flushes, unhides, checks for cancel, then publishes over the destination through the journal's gate
  (`rename_replace_gated`, then `sync_after_replace`; rule 1) (spec 7.2). An export that fails, is cancelled or is
  refused before the rename leaves an existing destination alone. Once the rename has happened the destination holds
  the new copy; if making that durable then fails, the error is returned as published, durability not confirmed.
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
| `session.rs` | `Sessions`: open vaults keyed by location, each with a generation, a cancel token and a publish guard; locking in two phases; the ordered lock-hook thread |
| `autolock.rs` | The idle timer, long operations that pause it, Windows signals, and the shutdown with its 2 s bound |
| `clipboard.rs` | A copy's life: write, its timer, and clearing only if the copy's own tag is still there |
| `outputs.rs` | The output journal (`pending-outputs.json`), the gate every decrypted file is published through, and the launch sweep |
| `open.rs` | "Open": the file name allowlist, executable types, the user-only folder, the internet mark, removal and retries |
| `restore.rs` | One restore at a time: its state machine, launch recovery, pre-restore copies and their checks |
| `locations.rs` | Where a vault may live: drive type, file system, links on the way, forbidden folders, cloud folders |
| `registry.rs` | The vault list (`vaults.json`): locations only, no secrets |
| `settings.rs` | The idle time and clipboard delay, with their bounds (`settings.json`) |
| `vault_state.rs` | What is noted about each vault folder (`vault-state.json`, keyed by folder, never by vault ID): the "recovery key not confirmed" mark, written before a key is made, and the last backup |
| `pending.rs` | One-time tokens for a question whose answer needs something kept (a credential, a chosen folder); they end after five minutes or when all vaults lock |
| `paths.rs` | The state folder and default vault folder from Windows' known folders; the size-capped, strict state-file reader |
| `views.rs` | What an item looks like to the page: no keys, no nonces, no password unless revealed |
| `error.rs` | `ShellError`: a fixed code and fixed fields, never a path, a name or input |
| `window.rs` | The one window: what it may load, open, download or receive |
| `commands/` | The `#[tauri::command]` wrappers. `list.rs` names every command; `args.rs` parses a request strictly |
| `os/mod.rs` | The traits (`Dialogs`, `Launcher`, `IdleSource`, `Power`, `Clock`, `Timer`, `ClipboardBackend`, `Volumes`, `Env`) and the shared clipboard steps |
| `os/win.rs` | The real Windows calls, the hidden signal window and the one-copy mutex. The only place the shell allows `unsafe` |
| `os/signals.rs` | Turns a window message into an `OsSignal` |
| `testing.rs` | The fakes (test builds only) |

Beside the code: `capabilities/main.json` (what the page may call), `tauri.conf.json` (the Content Security Policy and
app settings), `tests/ipc.rs` (the bridge, through Tauri's own permission checks). In `ui/src/`: `bridge.ts`, the one
place that calls Rust and drops stale answers; `api.ts`, the typed commands the screens use; `store.ts`, what the page
keeps of each unlocked vault, wiped by a lock; `messages.ts`, the fixed words for every refusal; `dropGuard.ts`; `App.tsx`
and `screens/`, the screens.

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

**Open** (`open_file`). The stored name goes through the allowlist. An executable type asks first, before anything is
decrypted. Then in a long operation (the idle timer pauses): a new folder only this user can reach, recorded in the
journal first; the engine's export, which checks the whole stream before the copy gets its name; the internet mark and
the read-only flag. The generation is checked as the vault is let go, and the launch comes after that, under no lock,
so a blocked "How do you want to open this?" dialog cannot delay locking. Copies go at the lock, at close and at launch;
one a viewer still holds is reported and retried.

**Restore** (`restore_prepare`, `restore_commit`). The pickers run first, then `check_location` on the parent, then
the engine's `prepare` in a long operation. `Prepared` holds no long operation: a question waiting for the user does not
keep every vault unlocked. `restore_commit` locks the vault open at the destination with `LockReason::Restore`, waits
up to 10 s for it to let go, and commits. Any other lock of the destination ends a restore that is not swapping (matched
by location, so it also catches a vault unlocked after `prepare`). Once the swap starts it finishes or rolls back by the
journal, whatever locks. A commit the engine says cannot be retried goes straight to recovery. A stale journal at
`restore_prepare` runs recovery and answers with its result.

### Rules the shell must keep

Each rule names the tests that pin it. Spec 9 and the spec-to-test map behind this list are the fuller record.

1. **Vault keys, file keys and file contents never cross to the page; a stored password only on "Reveal" or edit.** Core
   `Item`s cannot be serialised, and the views hold no key, nonce or unrevealed password: `item_is_not_serialize`,
   `views_never_carry_keys_or_unrevealed_password`, `reveal_returns_password_tagged`. The recovery key crosses once, when
   it is made, for display, and the generator's output is a new value, not a stored one. Spec 4.1.
2. **Paths never come from the page.** Commands take IDs and values; Rust opens every dialog: `request_with_a_path_field_refused`
   (one each in `commands/vaults.rs`, `files.rs`, `backup.rs`), `restore_requests_are_strict`, `item_requests_refuse_unknown_fields`.
   Paths go the other way in one case: a restore that cannot finish (its notice, and the question before dismissing it)
   shows the user's own folders so they can act on them.
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
    A question waiting for an answer does not pause it: `prepared_restore_does_not_stop_idle_lock`. The page's "Lock all"
    also cancels operations that have no session: `the_pages_lock_all_cancels_operations_without_a_session`.
11. **Every way out locks every vault; shutdown waits for that at most 2 s, then the app goes on closing** (one exception:
    the helper thread refused, in the Lock flow above, can wait longer). A vault not yet revoked by then ends with the
    process. `shutdown_locks_and_runs_hooks`, `closing_refuses_new_work`, `shutdown_bound_holds_under_operation_contention`,
    `shutdown_without_helper_revokes_inline`, `shutdown_clears_our_copy`, `shutdown_removes_all_opened_files`. That Tauri's
    exit events reach this code needs a real window, so the hands-on list covers it.
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
