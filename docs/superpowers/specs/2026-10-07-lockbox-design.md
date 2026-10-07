# Lockbox — Design Spec

**Date:** 2026-10-07 · **Author:** Ariel Maningas · **Status:** revision 4 (after independent review), awaiting approval

## 1. Purpose

Lockbox is a local-only password manager and encrypted file vault for Windows, with no server. Besides passwords and
notes, it stores real files (client contracts, design files, project archives), grouped by client or project. Its
differentiators are a better UI and file storage organised by client/project.

It is a public, open-source portfolio project. It must be production quality: tested, reviewed, documented, and honest
about its limits.

### Security requirements (v1)
| ID | Requirement |
|---|---|
| R1 | **Confidentiality at rest.** Without the vault password or recovery key, a copy of the vault folder reveals only: the vault name, key-derivation parameters, the number of items and stored files, item sizes rounded up to 512-byte buckets, exact stored-file sizes, and file timestamps. (An old header plus an old password is covered in 5.3.) |
| R2 | **Integrity.** Any modification of a key slot, the header fields, an item, or a file chunk is detected and refused or warned about. (Limits: R7.) |
| R3 | **Guessing cost.** Each password guess costs one Argon2id derivation of at least 64 MiB, 3 iterations, parallelism 4 (calibrated to ~1 s, capped per 5.2); vaults outside the accepted bounds are refused. |
| R4 | **No plaintext written by Lockbox** except where the user asks for it: "Save a copy", "Open", and printing or saving the recovery key as a PDF. OS paging, hibernation, crash dumps and the print spooler are outside Lockbox's control (5.6). |
| R5 | **No secrets in logs or error messages**: no passwords, keys, recovery keys or item content. |
| R6 | **Locking stops access.** After a vault locks, no command returns its data and its running operations stop (7.4). |
| R7 | **Documented limits.** v1 does not detect an attacker restoring an older valid copy of an item, or deleting a whole item file (6.6). |

### What "reviewed" means for Lockbox
A release counts as reviewed only when all of these hold, and the README says which apply:
1. All tests pass in CI, including the security tests in section 9.
2. The security scan (gitleaks, semgrep, osv-scanner) is clean or each finding is triaged in writing.
3. Every change was merged through a pull request with a Greptile review and Ariel's approval.
4. Before each release, a written walk-through of `SECURITY.md` against the code, checking every requirement R1–R7,
   signed off by Ariel.
5. The README states plainly that Lockbox has **not been independently audited** (unless that changes).

Scans and passing tests alone do not make it "secure"; they are evidence for the claims above.

**v1 is done when** every v1 feature in section 3 works on Windows and the five review conditions above hold.

## 2. Phases

| Phase | Ships | Design choice made now |
|---|---|---|
| **1 (this spec)** | Windows app for Ariel | Rust core is a separate library with no Windows or Tauri code |
| 2 | Share with friends: download website, code-signed installer, auto-updates | Vault format is versioned; app refuses vaults newer than itself |
| 3 | Android app + sync between devices without a server | Vault = folder of small independent files, a reasonable base for sync |

**Sync is a future protocol design, not a v1 property.** Revision numbers alone do not resolve concurrent edits,
deletion conflicts, partially copied files, or two devices changing the password. Phase 3 needs its own spec covering
conflict handling, deletion tombstones and an authenticated manifest; the container version (6.1) is the upgrade path.

## 3. Scope

### v1 features
- **Vaults**, each with its own password; unlocking one doesn't unlock the others.
- **Collections** inside a vault, one per client or project.
- **Items:** Login, Secure note, File. Logins and notes can have files attached. **Maximum file size: 256 GiB.**
- **Password generator:** length, character sets, passphrase mode.
- **Auto-lock** after idle time and when Windows locks, sleeps or hibernates; **clipboard clearing** after copying.
- **Ctrl+K quick search** across unlocked vaults, with quick actions.
- **Recovery key** per vault, shown once at creation; **Regenerate recovery key**.
- **Change password** (with the warning in 5.3).
- **Encrypted backup and restore** of a vault.
- **Open a backup (or a pre-restore copy) read-only**, to browse it or copy single items out.
- **Add existing vault folder** (e.g. after moving a vault).

### v1.1 (next, not in this spec)
Rotate vault key (re-encrypt everything) · password health check · built-in 2FA codes (TOTP) · Windows Hello unlock.

### Not in v1
Browser autofill extension · sync · mobile · sharing between people · importing from other password managers ·
vaults on removable drives.

## 4. Architecture

```
┌──────────────── Lockbox app (Tauri 2) ───────────────┐
│  UI: React + TypeScript                               │
│                      │ Tauri commands (IPC)           │
│  Desktop shell (Rust, crate: lockbox-desktop)         │
│  Command bridge, sessions, auto-lock, clipboard,      │
│  dialogs, single instance, "Open" folder, journals    │
│                      │                                │
│  Core library (Rust, crate: lockbox-core)             │
│  Crypto, vault format, items, files, search index,    │
│  generator, backup/restore. No Tauri/Windows deps.    │
└──────────────────────┬────────────────────────────────┘
                       │
   Disk: one folder per vault. Default parent: %USERPROFILE%\Lockbox Vaults\
```

- **UI:** screens and user input. Holds decrypted data only while displaying it (4.1).
- **Desktop shell:** OS integration (system idle time, Windows lock/sleep events via a native message window, clipboard,
  file dialogs, single instance, window), unlocked vault sessions, journals, and validation of every command.
- **Core:** all cryptography, file formats and the search index. **Keys never leave the core.**

### 4.1 What crosses into the UI
| Data | Crosses IPC? | When |
|---|---|---|
| Vault keys, file keys, password/recovery-derived keys | **Never** | — |
| File contents | **Never** | Rust streams between disk and the vault directly |
| File system paths | **Never from the UI** | Dialogs are opened by Rust inside commands (4.2) |
| Vault password, new password | UI → Rust | Typed into the UI on unlock, create, change |
| Recovery key | Rust → UI once; UI → Rust | Displayed at creation/regeneration; typed in when recovering or restoring |
| Item titles, usernames, URLs, notes, collection names | Rust → UI | While a list, item or search result is displayed |
| Item passwords | Rust → UI | Only on "Reveal" or while editing. **Never for copying**: copy runs entirely in Rust. |

**The search index lives in Rust.** The UI sends a query and receives only the matching results to display.

**Places copies of secrets may exist:** the webview's memory (typed and displayed values), the OS clipboard (after a
copy, until cleared), the Windows pagefile and hibernation file, crash dumps, the print spooler, and the user's chosen
"Save a copy"/"Open" locations. The UI clears its state on lock (7.4), but webview memory can't be wiped as reliably as
Rust's.

### 4.2 Tauri command security
- Every Lockbox command is declared in an **application manifest** (`tauri_build` `AppManifest::commands`) so it
  requires an explicit permission; only the main window's capability grants them. No generic filesystem, shell, HTTP,
  opener or dialog permissions are granted to the webview.
- **Dialogs are opened from Rust** inside the command (e.g. a blocking save/open dialog); the chosen path never passes
  through the UI.
- **Stored URLs are opened from Rust**, only for `http` and `https` schemes. Navigation inside the webview to anything
  other than the app's own content is blocked.
- Strict Content-Security-Policy; no remote content is ever loaded.
- **The backend validates every command**, never trusting the UI: the session exists and is unlocked; the request's
  session generation is current (7.4); every referenced item, collection or file belongs to that session's vault;
  read-only sessions reject writes; sizes are within limits.

## 5. Cryptography

### 5.1 Libraries and encoding
- RustCrypto crates only: `argon2` (features `parallel` and `zeroize` enabled), `chacha20poly1305`
  (XChaCha20-Poly1305), `aead-stream` (STREAM), `hkdf` + `hmac` + `sha2`, `zeroize`; randomness from the OS
  (`getrandom`). **No hand-written cryptography.** Versions are pinned in `Cargo.lock`; APIs are read with `opensrc`
  before use, and `aead-stream`'s maturity is checked before relying on it.
- **IDs:** `vault_id`, `item_id` and `file_id` are 16 random bytes. **Versions** are unsigned 16-bit integers.
- **Associated data (AD) encoding**, frozen with test vectors: an ASCII label, then each field as a 4-byte little-endian
  length followed by its bytes. IDs are raw 16 bytes; versions are 2 bytes little-endian; strings are UTF-8. Written
  below as `"label"` ‖ field ‖ field.
- Binary fields in JSON files are base64 (standard, padded).

### 5.2 Key hierarchy
```
Vault password ──► Argon2id ───────► password key ──┐  each unwraps a copy of
Recovery secret ─► HKDF-SHA256 ────► recovery key ──┘  ──► Vault key (random 256-bit) ──► encrypts items
                                                                │                └─► items hold per-file keys ──► file blobs
                                                                └─► HKDF ──► header MAC key, backup MAC key
```
- **Vault key:** random 256 bits, generated at creation, never stored unwrapped.
- **Each key slot has its own salt.** The password slot's salt is replaced on every password change; the recovery
  slot's salt is replaced only when the recovery key is regenerated. (A shared salt would break the recovery key after a
  password change, because HKDF's output depends on its salt.)
- **Password key:** Argon2id(password as UTF-8 after Unicode NFC normalisation, password-slot salt (16 random bytes),
  params) → 32 bytes.
- **Argon2id parameters:**
  - **Calibrated at creation** to ~1 s, then **clamped** to memory 64–256 MiB, iterations 3–10, parallelism 4. (256 MiB
    leaves headroom for a future phone client.)
  - **Accepted when reading** (vault.json is attacker-controlled before unlock): memory 64 MiB–1 GiB, iterations 3–10,
    parallelism 4–16, salt exactly 16 bytes. Out-of-bounds values are refused **before** any derivation.
  - Calibration output always lies inside the read bounds (tested).
- **Recovery secret:** 256 random bits plus a 4-bit checksum (the first 4 bits of SHA-256 of the secret), shown as 52
  Crockford base32 characters in 13 groups of 4. Input ignores spaces, dashes and case, and maps O→0 and I/L→1. A typo
  is reported as "That recovery key has a typo" (caught 15 times in 16) before any unwrap attempt.
  **Recovery key** = HKDF-SHA256(ikm = secret, salt = recovery-slot salt (16 random bytes),
  info = `"lockbox recovery key v1"`) → 32 bytes.
- **Key slots** in `vault.json`: `{type: "password"|"recovery", slot_version, salt, [kdf params], nonce: 24 random
  bytes, ciphertext}`, where ciphertext = XChaCha20-Poly1305(slot key, vault key) with
  AD = `"lockbox/slot"` ‖ slot_version ‖ vault_id ‖ slot type ‖ salt ‖ kdf params (if any).
  The AD contains the slot's own version, not the container version, so routine format upgrades never re-wrap slots.
- **Header MAC:** `vault.json` carries an HMAC-SHA256 over its non-slot fields (vault name, container_version,
  migration marker, created_at, vault_id), keyed by HKDF(vault key, info = `"lockbox header mac v1"`). It is checked
  after unlock; a mismatch shows a warning ("This vault's header was changed outside Lockbox") and the header is
  rewritten only with the user's OK.

### 5.3 Password change, recovery and recovery-key regeneration
- **Change password:** unlock, derive a new password key with a fresh password-slot salt, re-wrap the vault key into a
  new password slot, write the new header (6.3). The recovery slot is copied unchanged.
- **Recover:** unwrap with the recovery key, then the user must set a new password. The original recovery secret keeps
  working after any number of password changes.
- **Regenerate recovery key:** unlock, create a new recovery secret and salt, re-wrap the vault key into a new recovery
  slot, write the header. The old recovery key stops working against this header (old copies: see below).
- **⚠ Limit, shown in the UI and documented:** these changes do **not** change the vault key. Anyone who has an old copy
  of the header (an earlier copy of the vault folder, an old backup) plus the old password or old recovery key can
  recover the vault key, and that key decrypts **current and future data too**, if they ever get copies of the newer
  items and blobs. Full revocation needs **Rotate vault key** (v1.1).

### 5.4 Items
- Each item is serialized as JSON (max 1 MiB) and **padded to the next 512-byte boundary** before encryption, so
  ciphertext sizes reveal only a size bucket.
- Encrypted with XChaCha20-Poly1305 under the vault key, with a fresh random 24-byte nonce.
- Each item file records its own readable **item_version** beside the ciphertext.
- AD = `"lockbox/item"` ‖ item_version ‖ vault_id ‖ item_id. An item file can't be moved into another slot or vault
  undetected.

### 5.5 Files (blobs)
- Each stored file has a random **file_id** and its own random 256-bit **file key**, kept inside its (encrypted) item.
  **Replacing a file creates a new file_id and key**; blobs are never modified in place.
- **STREAM construction** over XChaCha20-Poly1305 (`aead-stream`, big-endian 32-bit counter variant): nonce = 19-byte
  random prefix ‖ 32-bit big-endian chunk counter ‖ 1-byte last-chunk flag.
- **Chunks:** `chunk_size` bytes of plaintext each (1 MiB in blob_version 1; the last may be smaller), stored back to
  back in one blob file `files/<file_id>.blob`. Each ciphertext chunk = plaintext + 16-byte tag.
- **Per-chunk AD** = `"lockbox/chunk"` ‖ blob_version ‖ vault_id ‖ file_id ‖ total plaintext length ‖ chunk count.
- **Metadata in the item** (authenticated as part of the item): file_id, blob_version, chunk_size, file key, nonce prefix,
  total plaintext length, chunk count, original file name, media type.
- **Empty file:** exactly one chunk with empty plaintext, marked last.
- **Decryption is valid only if** the blob has exactly the expected size, every chunk authenticates in order, the last
  chunk carries the last-chunk flag, and no chunk before it does.
- **Limits:** max 256 GiB per file (262,144 chunks, far below the 2³² counter limit).

### 5.6 Memory and honest limits (all go into `SECURITY.md`)
- Secrets in Rust are held in `Zeroizing`/`secrecy` types and aren't cloned needlessly; the session holds one
  reference-counted vault key. Cipher instances hold their own working copy of a key; they're created per operation and
  dropped promptly. `zeroize` wipes buffers Lockbox owns when they're dropped, but can't guarantee that earlier copies
  (from moves or reallocations) are gone, and cleanup doesn't run if the process is killed or crashes.
- Secrets may reach the **pagefile**, **hibernation file**, **crash dumps** and the **print spooler**. Lockbox doesn't
  control these; the README recommends full-disk encryption (BitLocker).
- Malware running on the PC while a vault is unlocked can read what Lockbox can read.
- Values shown or typed in the UI pass through webview memory (4.1).
- Deleted files on SSDs are not guaranteed to be erased from the disk.
- No lockout after wrong passwords: an attacker with the vault folder bypasses the app. Argon2id cost is the protection.
- Rollback and deletion detection limits: 6.6. Old headers: 5.3.

## 6. Vault format on disk

### 6.1 Layout
```
<VaultName>-<short-id>/
├── vault.json          container_version, vault_id, vault name, key slots, migration marker, created_at, header MAC
├── vault.json.bak      copy of the current vault.json
├── .lock               held with an OS exclusive lock while a Lockbox instance has the vault open
├── items/
│   └── <hex id>.item        one encrypted item (login, note, file metadata, or collection)
└── files/
    ├── <hex file_id>.blob   one encrypted file (chunks back to back)
    └── orphaned/            quarantine for unreferenced blobs (6.4)
```
- **Collections are items** of type `collection`; other items reference their collection's ID. Deleting a collection
  asks for confirmation and moves its items to the trash with it.
- **On-disk names are random IDs.** Titles, usernames, collection names and file names exist only inside encrypted
  items. The **vault name is readable** in `vault.json` so the lock screen can list vaults (it is covered by the header
  MAC); the UI warns at creation not to put secrets in it.
- **Every item has a revision number and modified timestamp**, kept for a future sync design (not a sync guarantee).
- **Trash:** deleted items are flagged `trashed_at`. Lockbox **never purges automatically**: items in the trash for 30+
  days are listed with "Delete permanently?", and "Empty trash" purges on request. (Avoids early purges from clock
  changes.)
- **Three independent versions:** `container_version` (vault.json layout and folder rules), `item_version` (per item),
  `slot_version` (per key slot), plus `blob_version` (per stored file, in its item). The app opens vaults whose container
  version it knows and refuses newer ones with "Update Lockbox to open this vault."
- **Parser limits:** `vault.json` ≤ 64 KiB, item file ≤ 1 MiB + overhead, JSON nesting depth ≤ 32, strict schemas.
  Anything over the limits is refused before parsing.

### 6.2 Writing files
- Every file write goes to a temp file `*.tmp` in the same folder, created hidden, flushed to disk, then renamed over the
  target with `MoveFileExW(MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)`.
- **Renames and deletes retry with backoff** on sharing violations and access-denied errors (antivirus, the search
  indexer and backup tools briefly open files), then fail with a clear error.
- **Assumptions, stated plainly:** NTFS rename-replace is treated as atomic (relied on in practice, not formally
  documented by Microsoft). **Process-crash safety is tested; power-loss safety is assumed**, not proven.

### 6.3 Header writes
- Write the new `vault.json` (6.2), then the same content to `vault.json.bak` (6.2).
- **Interrupted between the two:** the next successful unlock notices they differ and rewrites `.bak`.
- **Unlocking tries both headers.** If `vault.json` fails to parse, or its slot fails to unwrap and `.bak` differs from
  it, Lockbox tries the matching slot in `.bak` (reusing the derived key when the salt and parameters are equal, so no
  extra Argon2 cost). Recovery follows the same rule.
- **When `.bak` is used**, a visible warning says: "Opened from the backup header. If you changed this vault's password
  recently, it may need your *previous* password. Change the password again after unlocking." After unlocking, both
  headers are rewritten.
- After a password change completes, `.bak` is rewritten and leftover header `*.tmp` files are deleted at the next
  unlock, so **no copy of the old password slot remains in the vault folder** (older backups and external copies: 5.3).

### 6.4 Multi-file changes and cleanup
The **item file is the commit point**; **nothing referenced is ever deleted inline**, and deletions happen only when an
authenticated item records the intent.
- **Add a file:** write `files/<id>.blob.partial` → flush → rename to `files/<id>.blob` → write the item (6.2).
- **Replace a file:** add the new blob → write the item pointing to it, with the old file_id listed in its encrypted
  `retired_blobs` field → the old blob is deleted later by cleanup.
- **Purge an item:** rewrite the item with `purging: true` → delete its blobs → delete the item file. A crash midway
  leaves a `purging` item, which cleanup finishes.
- **Cleanup** runs **once per unlock, under the vault's write lock, before the session accepts any command**, so it
  can never race an import:
  - Delete all `*.partial` and `*.tmp` files (none can belong to a running operation at that moment).
  - Delete blobs listed in `retired_blobs` of authenticated items, then clear those lists. Finish `purging` items.
  - **Unreferenced blobs with no recorded intent are never deleted automatically.** They're moved to
    `files/orphaned/` and shown in the UI ("N orphaned files, X GB — Restore from backup / Delete permanently"). If any
    item failed to decrypt, even this move is skipped and the UI reports "Cleanup skipped: N damaged items."

### 6.5 Format upgrades (migration)
- **v1 implements:** the container-version check, the "Update Lockbox" refusal, and reading the migration marker
  (a vault with a marker this app doesn't know is refused).
- **Protocol for when a v2 format exists** (implemented and tested then, not in v1):
  1. Check free space; back up `vault.json` and `items/` (blobs are never migrated) into the vault's own
     `migration-backup/` folder. Not enough space → don't start; explain how much is needed.
  2. Write the header with the **new container_version and a migration marker** `{from, to}`. From here, older apps
     refuse the vault.
  3. Upgrade items one at a time (6.2). The new app reads both item versions, so an interrupted upgrade resumes on the
     next unlock.
  4. Write the header without the marker; delete `migration-backup/` after the next successful unlock.
  - Routine upgrades never touch key slots or need the recovery secret.

### 6.6 Rollback and deletion (v1 limit)
Per-item encryption detects changes to an item, but not an attacker **replacing an item with an older valid copy**, or
**deleting an item file** entirely. v1 documents this; because unreferenced blobs are quarantined rather than deleted
(6.4), a lost item file doesn't also destroy its attachments. An authenticated manifest is deferred to the Phase 3 sync
design.

### 6.7 Backup
- **Consistent snapshot:** backups are made only by Lockbox. While a backup runs, the vault's writes are paused (the
  backup holds the vault's write lock); edits show "Backup in progress."
- **Format:** one `.lockbox-backup` file, a **ZIP64** archive with no compression, containing `vault.json`, `items/`,
  `files/` (excluding `orphaned/`) and a `backup-manifest.json` listing every entry's path, size and SHA-256. The manifest
  carries an **HMAC-SHA256** keyed by HKDF(vault key, info = `"lockbox backup manifest v1"`), so after unlocking,
  restore can prove the backup is complete (nothing added, removed or swapped).
- **Verify, then publish:** the backup is written to a hidden temp file beside the destination, re-read and checked
  against the manifest, then renamed into place. A failed or cancelled backup never replaces an existing backup file.
- Before starting, Lockbox checks the destination's free space and file-size limit (e.g. FAT32's 4 GiB) and refuses
  with the reason if it can't hold the backup.

### 6.8 Restore
Nothing in the vaults folder changes until every check passes, and the swap is journaled so a crash can't lose both
copies.
1. **Inspect before writing anything.** Lockbox parses the ZIP central directory itself (never a library
   "extract all") and validates every entry: only expected names (`vault.json`, `backup-manifest.json`,
   `items/<hex>.item`, `files/<hex>.blob`); no absolute paths, `..`, drive letters, links, duplicates or unexpected
   files; entry count and declared sizes within limits; total size vs free space. The entry list must **match the
   manifest exactly.**
2. **Extract into a staging folder** `.restore-<random>` **in the destination's parent folder** (same drive, so the
   final step is a rename), enforcing each entry's byte limit while writing and checking each SHA-256.
3. **Unlock** with the backup's password **or recovery key** (the backup may hold an older password; the UI says the
   restored vault's password is the backup's). Verify the manifest HMAC, then **authenticate every item and every
   complete file stream.**
4. **Swap, journaled:**
   - If a vault with the same ID exists, the user chooses: replace it, or open the backup read-only instead (6.9).
   - Lock and close the existing vault (release `.lock` and every handle).
   - Write a restore journal `%LOCALAPPDATA%\Lockbox\restore-journal.json` (paths and step).
   - Rename existing → `<folder>.before-restore`, then staging → `<folder>`, retrying on sharing violations (6.2).
   - Mark the journal done. `<folder>.before-restore` is kept and listed in the UI (open read-only, or delete).
5. **Recovery at startup:** if a journal is unfinished, roll back (rename `.before-restore` back when the target is
   missing) or finish, depending on its step. `.restore-*` folders are deleted only when the journal says so.
6. On any validation failure, the staging folder is deleted; the existing vault is untouched.

### 6.9 Read-only vaults
- A `.lockbox-backup` file or a `.before-restore` folder can be opened **read-only**, alongside the live vault.
- Sessions are keyed by **location**, not vault_id, so two copies of the same vault can be open at once; read-only ones
  are labelled in the UI and reject every write.
- Backups are browsed **directly inside the archive** (entries are stored uncompressed, so blobs are read by offset)
  after the same validation as restore step 1; nothing is extracted except files the user saves or opens.
- Single items can be copied from a read-only vault into the live one.

### 6.10 Locations, locking and filesystems
- **Default vault location:** `%USERPROFILE%\Lockbox Vaults\`. Never inside Tauri's app-data folders
  (`app_data_dir()`, `%APPDATA%\<identifier>`, `%LOCALAPPDATA%\<identifier>`), which the uninstaller can delete, and
  never in the Roaming profile (tested).
- **Vault registry:** the list of known vault locations is kept in `%LOCALAPPDATA%\Lockbox\vaults.json` (locations
  only, no secrets). "Add existing vault folder" adds one.
- `.lock` is held with an **OS exclusive file lock** (`LockFileEx`) while the vault is open. A stale `.lock` without a
  held lock (after a crash) is ignored and re-locked.
- **Supported:** local, fixed NTFS drives. **Refused in v1:** removable drives, FAT32, network drives. **Warned:**
  folders inside OneDrive, Google Drive or Dropbox (not supported in v1).
- If the drive holding an unlocked vault disappears, that vault is locked and shown as "unavailable", never treated as
  deleted.

## 7. Screens and behaviour

### 7.1 Screens
| Screen | Contents |
|---|---|
| First run | Create first vault: name, password with strength meter, then the recovery key. Must confirm it's saved (print / save as PDF / checkbox) before continuing. |
| Lock screen | Known vaults (from the registry and `vault.json` names); pick one, enter its password. Vaults unlock independently. "Forgot password?" and "Add existing vault folder". |
| Main window | Three columns: sidebar (vaults → collections, trash, orphaned files) · item list (filter, sort) · item details (copy/reveal, attached files: Open / Save a copy / Replace file). Read-only vaults labelled. |
| Ctrl+K | Search across unlocked vaults; actions: copy password, copy username, new item, lock all. |
| Generator | Pop-out beside password fields, plus a standalone screen. |
| Settings | Auto-lock idle time (default 5 min), clipboard clear delay (default 30 s), theme, backup, change password, regenerate recovery key. |
| Backup / restore | Export a vault; restore it (6.8); open a backup read-only (6.9). |
| Forgot password | Enter recovery key → set a new password. |

**Visual design** (colours, type, polish) is decided at the start of the UI work with Ariel's `design-bakeoff` skill:
clickable mockups, approved before screens are built.

### 7.2 Decrypted output: Save a copy and Open
**Rule: verify fully, then publish.** Nothing is placed at its final location or launched until the whole stream has
authenticated.
- **Output journal:** every temporary plaintext file Lockbox creates is recorded (by its random temp path, never the
  original name) in `%LOCALAPPDATA%\Lockbox\pending-outputs.json` before writing, and removed from it when published or
  deleted. At launch, any listed leftovers (after a crash or power cut) are deleted.
- **Save a copy:** Rust opens the native save dialog (overwrite needs its confirmation). Lockbox decrypts into a hidden
  temp sibling `.<random>.lockbox-partial` (created with the hidden attribute), verifies the entire stream, then renames
  it over the destination (6.2). On failure or cancellation only the temp file is deleted; **an existing destination is
  never touched unless the copy completed and verified.** Free space and file-size limits are checked first.
- **Open:**
  - Decrypts into `%LOCALAPPDATA%\Lockbox\open\<random>\`, a folder whose permissions are restricted to the current
    Windows user, and launches the file with its default app **only after the full stream has verified.**
  - **File name:** built from an allowlist (letters, digits, space, `-`, `_`, `.`, `(`, `)`), with trailing dots and
    spaces removed, reserved Windows names (CON, NUL, …) avoided, and length capped.
  - **Executable types** (`.exe`, `.bat`, `.cmd`, `.ps1`, `.vbs`, `.js`, `.hta`, `.lnk`, `.url`, `.msi`, `.scr` and
    similar) require an explicit confirmation before launch.
  - The copy is marked **read-only. Edits are not saved back**; to update a stored file, use "Replace file".
  - **Deletion is attempted** when the vault locks, when the app closes, and on the next launch; cleanup clears the
    read-only attribute first. Files held open by another app can't be deleted on Windows: Lockbox retries, shows
    "Couldn't remove N opened files. Close the app using them, then Retry," and retries on every launch until gone.
  - **Beyond Lockbox's control** (stated on first use and in `SECURITY.md`): copies the other app makes (autosaves,
    recent-file caches, temp files).

### 7.3 Clipboard
Copied secrets are marked so **Windows clipboard history (Win+V) and cloud clipboard don't store them** (the Windows
"exclude from clipboard history / monitoring" formats). After the delay, and when the vault locks, the clipboard is
cleared **only if it still holds what Lockbox put there.** Clipboard access uses a short timeout, since another app can
hold the clipboard open.

### 7.4 Locking (concurrency contract)
- **Idle** means no keyboard or mouse input anywhere in Windows for the configured minutes. **While a long operation the
  user started is running** (import, Save a copy, Open, backup, restore), the idle timer is paused, the UI shows why, and
  Lockbox asks Windows to stay awake (`SetThreadExecutionState`). **Windows lock, sleep and hibernate always lock all
  vaults immediately**, cancelling such operations.
- **Two guarantees, kept separate:**
  - **Access is denied immediately.** From the moment of locking, no new command runs and no response carrying vault
    data is accepted by the UI.
  - **Operations stop eventually.** Running operations stop at their next cancellation check; the last one to finish
    releases the vault key. One chunk bounds the *work* done after a lock (≤ 1 MiB), not the elapsed time.
- **Locking:** (1) marks the session locked and bumps its **generation number**; (2) signals cancellation; (3) drops the
  session's reference to the vault key; (4) tells the UI to clear item state, revealed values and search results, and
  show the lock screen; (5) clears Lockbox-owned clipboard content.
- **Backend checks:** every command checks the generation when it starts and again before it returns.
- **UI-side check:** every response is **tagged with its session generation**; the UI discards any response whose tag
  doesn't match the vault's current generation.
- **Side effects:** clipboard writes and file publication (renames) re-check the generation **under the session lock**,
  doing only that fast step there (clipboard with a timeout). **Launching an opened file happens after the lock is
  released**, so a blocking "How do you want to open this file?" dialog can never delay locking.
- **Long operations** check for cancellation between chunks, delete their partial output (via 6.4 / 7.2 rules) and
  report "Cancelled: vault locked."

## 8. Error handling

| Situation | Behaviour |
|---|---|
| Wrong password | "Wrong password." (after also trying `.bak`, 6.3). No lockout (5.6). |
| Recovery key typo | "That recovery key has a typo" (checksum, 5.2). |
| Out-of-bounds Argon2 parameters or oversized header | Refused before derivation: "This vault file is damaged or not a Lockbox vault." |
| Header MAC mismatch | Warning after unlock; header rewritten only with the user's OK (5.2). |
| Damaged/tampered item | That item shows as damaged and is refused; the rest of the vault works; offer restore or open a backup read-only. |
| Damaged/tampered blob | "Save a copy"/"Open" refused; only the temp file is deleted (7.2). |
| Damaged `vault.json` | Unlock from `.bak` with the warning in 6.3; if both fail, offer restore from backup. |
| Some items unreadable at unlock | Orphan quarantine skipped, "Cleanup skipped: N damaged items" (6.4). |
| Unreferenced blobs found | Moved to `files/orphaned/`, shown in the UI (6.4). |
| Disk full / crash during save | Previous state remains (6.2–6.4); clear error shown. |
| Sharing violation (antivirus, indexer) | Retried with backoff, then a clear error (6.2). |
| Operation running when the vault locks | Cancelled, partial output deleted (7.4). |
| "Open" cleanup fails | Retry + visible message (7.2). |
| Backup destination too small / FAT32 limit | Refused before starting, with the reason (6.7). |
| Backup or restore validation fails | Nothing changes; the error names the check that failed. |
| Crash during restore swap | Journal rolls back or finishes at next launch (6.8). |
| Unsupported vault location | Removable, FAT32 or network drive refused; cloud-synced folders warned (6.10). |
| Drive disappears while unlocked | That vault locks and shows as "unavailable" (6.10). |
| Second app instance | Single instance focuses the existing window; `.lock` prevents two writers on one vault. |
| Newer vault format or unknown migration marker | Refused with "Update Lockbox". |
| Crash while unlocked | Session memory is gone with the process (5.6 limits); temp outputs, `.tmp`/`.partial` files and "Open" files cleaned at next launch/unlock. |

**Rule:** no password, key, recovery key or item content ever appears in an error message or log (R5).

## 9. Testing (acceptance criteria)

- **Test-first** for every piece of the core and shell. Every bug gets a regression test.
- **Crypto:** round-trips; wrong password; single-byte tamper in a slot, the MAC-covered header fields, an item and a
  chunk → refused or warned; chunk reorder, removal, duplication, truncation and extension → refused; empty file;
  last-chunk flag missing or early → refused; known-answer tests against published Argon2id and XChaCha20-Poly1305
  vectors; **AD encoding test vectors** frozen; item padding to 512-byte buckets.
- **Header and passwords:** after a password change, the old password fails against both headers; **create → change
  password (several times) → recover with the original recovery secret**; regenerate recovery key → old key fails, new
  key works; a damaged password slot in `vault.json` unlocks via `.bak` with the warning; a crash between the two header
  writes recovers; recovery-key checksum catches typos; Argon2 calibration output always passes the read bounds;
  out-of-bounds parameters are refused without allocating memory.
- **Crash safety:** simulated failure at each step of 6.2–6.4 → previous state intact; **a damaged item never causes
  any blob to be deleted or moved**; **a missing item file causes its blobs to be quarantined, not deleted**; retired
  blobs and `purging` items are finished by cleanup; stale `.lock` recovered; a held lock blocks a second writer;
  sharing violations are retried.
- **Concurrency:** cleanup never runs while a command can run (an import started right after unlock waits for cleanup);
  backup while edits and imports are attempted → consistent snapshot.
- **Backup/restore:** a cancelled or failed backup never replaces an existing backup file; malformed archives (traversal
  and absolute paths, links, duplicates, entries missing from or extra to the manifest, declared/actual size mismatches,
  oversized entries) → refused **before any file is written**; a rewritten manifest (bad HMAC) or a tampered item/blob →
  refused after unlock with the vault untouched; restore with the recovery key; a crash at each step of the swap →
  journal recovers with no data lost; a > 4 GiB archive round-trips (ZIP64).
- **Read-only vaults:** a backup and a `.before-restore` folder open read-only next to the live vault; every write is
  refused; copying an item into the live vault works.
- **Locking:** lock during unlock, reveal, search, import, Save a copy, Open, backup and restore → no data returned after
  the lock, partial output deleted, key released; a response with an old generation is discarded by the UI; a clipboard
  write racing a lock either completes before it (and is then cleared) or never happens; locking isn't delayed by a
  blocked file launch; idle timer pauses during long operations; Windows lock still cancels them.
- **Decrypted output:** a tampered blob or a cancellation never alters an existing destination file; leftovers listed in
  the output journal are deleted at the next launch; file-name sanitisation; executable types require confirmation.
- **"Open" cleanup:** read-only copies are removed (attribute cleared first); a file held open by another process →
  retry message, removed on a later launch.
- **Locations:** default location is `%USERPROFILE%\Lockbox Vaults`; vault paths are never inside the app-data or
  Roaming folders; removable, FAT32 and network locations are refused.
- **IPC security:** a command not granted by the capability is refused; commands with a stale generation, a foreign item
  ID, a write to a read-only session, or an out-of-limit size are refused; no dialog or opener permission is available
  to the webview; non-http(s) URLs are not opened.
- **Property tests** (`proptest`): random data round-trips; malformed headers, items and archives never panic or leak.
- **Large files:** chunk-boundary cases in CI; a multi-GB local test before release.
- **UI:** component tests (Vitest); end-to-end tests on the real app (WebdriverIO + `tauri-driver` on Windows): create
  vault → unlock → add item → copy → auto-lock.

## 10. Workflow, repo and tooling

- **Change flow:** branch → tests + security scan → pull request → CI → `/greploop` (Greptile) → Ariel approves → merge.
  Nothing is pushed to `main` or released without Ariel's go. Commits under Ariel's GitHub account, no AI co-author.
- **CI (GitHub Actions, `windows-latest`):** `cargo fmt --check`, `cargo clippy -D warnings`, `cargo test`, frontend lint +
  tests + build, Tauri build, and the security scan.
- **Security scan:** our own `scripts/scan.mjs` running gitleaks (secrets), semgrep (risky code) and osv-scanner
  (vulnerable dependencies), with one pass/fail result. Calls semgrep by full path (see `docs/SETUP.md`).
- **Dependencies:** if the `zip` crate is used (for writing or reading the directory), it must be ≥ 2.3.0
  (CVE-2025-29787), and its extract functions are never used.
- **Repo docs:** `README.md` (incl. "not independently audited"), `SECURITY.md` (R1–R7, limits, how to report a
  vulnerability), `docs/SETUP.md`, `TRACKER.md`, `LICENSE` (MIT).
- **Greptile:** apply for the free open-source plan once the repo is public.
- **Third-party skills and tools stay on the dev machine**, never committed.

## 11. Decisions and deferred items

**Decided in review (2026-10-07):**
- Rounds 1–2: password change warns instead of rotating · opened files are read-only copies · idle = system-wide input
  idle · max file 256 GiB · one blob per file · per-slot salts · separate versions · authenticated backup manifest ·
  verify-then-publish · FAT32 refused.
- Round 3 (independent review): intent-based deletion and orphan quarantine · cleanup before commands at unlock ·
  journaled restore swap · auto-lock pauses during long operations · default location `%USERPROFILE%\Lockbox Vaults` ·
  removable drives refused · regenerate recovery key and read-only backups in v1 · Argon2 calibration clamped ·
  header MAC · item padding · recovery-key checksum · dialogs and URLs handled in Rust · search index in Rust ·
  manual trash purge · migration protocol documented now, implemented with v2.

**Deferred, with a known home:**
- Rotate vault key: v1.1.
- Rollback/deletion detection (authenticated manifest, tombstones) and conflict handling: Phase 3 sync spec.
- Migration implementation and tests: when a v2 format exists.
- Independent security audit: not planned; README states this.

**Confirm at build time:** `aead-stream`'s API and maturity (read with `opensrc`), keeping the nonce layout in 5.5;
reliable Windows session-lock and sleep notifications on Modern Standby PCs (native message window).
