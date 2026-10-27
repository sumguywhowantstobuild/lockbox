# Lockbox — Design Spec

**Date:** 2026-10-07 · **Author:** Ariel Maningas · **Status:** revision 6 (2026-10-27, Plan 3 decisions)

## 1. Purpose

Moved to [docs/PRD.md](../PRD.md#purpose).

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

Moved to [docs/PRD.md](../PRD.md#phases).

## 3. Scope

Moved to [docs/PRD.md](../PRD.md#scope).

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
│  generator, backup/restore. No Tauri deps.            │
└──────────────────────┬────────────────────────────────┘
                       │
   Disk: one folder per vault. Default parent: %USERPROFILE%\Lockbox Vaults\
```

- **UI:** screens and user input. Holds decrypted data only while displaying it (4.1).
- **Desktop shell:** OS integration (system idle time, Windows lock/sleep events via a native message window, clipboard,
  file dialogs, single instance, window), unlocked vault sessions, journals, and validation of every command.
- **Core:** all cryptography, file formats and the search index. **Keys never leave the core.** It has no Tauri
  dependencies; its Windows-specific filesystem operations are isolated in one platform filesystem module (see the PRD).

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

**Places copies of secrets may exist:** the webview's memory (typed and displayed values), the IPC message buffers
(typed passwords arrive and revealed values leave as JSON text that is not wiped), the OS clipboard (after a copy, until
cleared), the Windows pagefile and hibernation file, crash dumps, the print spooler, and the user's chosen "Save a
copy"/"Open" locations. The UI clears its state on lock (7.4), but webview memory can't be wiped as reliably as Rust's.
WebView2 autofill is off and the webview runs without a persistent profile, so typed values are not stored by it.

### 4.2 Tauri command security
- Every Lockbox command is declared in an **application manifest** (`tauri_build` `AppManifest::commands`) so it
  requires an explicit permission; only the main window's capability grants them. No generic filesystem, shell, HTTP,
  opener or dialog permissions are granted to the webview. The webview's only non-Lockbox permissions are listening to
  and un-listening from events.
- **Dialogs are opened from Rust** inside the command (e.g. a blocking save/open dialog); the chosen path never passes
  through the UI.
- **Stored URLs are opened from Rust**, only for `http` and `https` schemes. Navigation inside the webview to anything
  other than the app's own content is blocked.
- Strict Content-Security-Policy; no remote content is ever loaded.
- The window refuses navigation outside the app, every new-window request and every download. Tauri's drag-and-drop
  handler and WebView2's external drop are off (the app does not start if WebView2 cannot confirm it), and the page
  cancels drops as well, so dropped files reach neither the page nor Rust.
- **The backend validates every command**, never trusting the UI: the session exists and is unlocked; the request's
  session generation is current (7.4); every referenced item, collection or file belongs to that session's vault;
  read-only sessions reject writes; sizes are within limits. A malformed request to a Lockbox command gets a fixed
  error, never the parser's text. Tauri's own event commands and its message transport may answer with error text
  built from what the page sent, so it can quote back any value the page put in the request; that text goes back
  only to the page, and Tauri adds no vault data to it, so screens never pass a secret to Tauri's own commands. In
  debug builds a refusal also names the window, the webview and the permissions linked to the command. A wrong
  invoke key gets no answer, and Tauri prints it with the expected key to standard error, which a release build has
  no console for.

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
- **Minimum master password:** 12 characters (Unicode characters after NFC), enforced by the core when a password is
  set (create, change password), never at unlock, so raising the minimum later can't lock out existing vaults.
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
- **Parser limits:** `vault.json` ≤ 64 KiB, item file ≤ 1 MiB + overhead, JSON nesting depth ≤ 32, strict schemas,
  `backup-manifest.json` ≤ 64 MiB (6.7, checked against the archive's declared entry size before any of it is read
  into memory). Anything over the limits is refused before parsing.

### 6.2 Writing files
- Every file write goes to a temp file `*.tmp` in the same folder, created hidden, flushed to disk, then renamed over the
  target with `MoveFileExW(MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)`.
- **Renames and deletes retry with backoff** on sharing violations and access-denied errors (antivirus, the search
  indexer and backup tools briefly open files), then fail with a clear error.
- **Assumptions, stated plainly:** NTFS rename-replace is treated as atomic (relied on in practice, not formally
  documented by Microsoft). **Process-crash safety is tested; power-loss safety is assumed**, not proven.

### 6.3 Header writes
- **Creating a vault** is all-or-nothing: the whole folder is built in a hidden staging folder `.creating-<random>` in
  the same parent (same drive), synced, then renamed to its final name. A crash leaves only a staging folder, never a
  half-built vault. Staging folders left by a crash are deleted the next time a vault is created in that parent.
- Write the new `vault.json` (6.2), then the same content to `vault.json.bak` (6.2).
- **Interrupted between the two:** the next successful unlock of a writable session notices they differ and rewrites
  `.bak`. A read-only opening never repairs: it writes nothing (6.9).
- **Unlocking tries both headers.** If `vault.json` fails to parse, or its slot fails to unwrap and `.bak` differs from
  it, Lockbox tries the matching slot in `.bak` (reusing the derived key when the salt and parameters are equal, so no
  extra Argon2 cost). Recovery follows the same rule.
- **When `.bak` is used**, a visible warning says: "Opened from the backup header. If you changed this vault's password
  recently, it may need your *previous* password. Change the password again after unlocking." After unlocking a
  writable session, both headers are rewritten.
- After a password change completes, `.bak` is rewritten and, for writable sessions, leftover header `*.tmp` files are
  deleted at the next unlock, so **no copy of the old password slot remains in the vault folder** (older backups and external copies: 5.3).

### 6.4 Multi-file changes and cleanup
The **item file is the commit point**; **nothing referenced is ever deleted inline**, and deletions happen only when an
authenticated item records the intent.
- **Add a file:** write `files/<id>.blob.partial` → flush → rename to `files/<id>.blob` → write the item (6.2).
- **Replace a file:** add the new blob → write the item pointing to it, with the old file_id listed in its encrypted
  `retired_blobs` field → the old blob is deleted later by cleanup.
- **Purge an item:** rewrite the item with `purging: true` → delete its blobs → delete the item file. A crash midway
  leaves a `purging` item, which cleanup finishes.
- **Cleanup** (writable sessions only; a read-only open does none, 6.9) runs **once per unlock, under the vault's write lock, before the session accepts any command**, so it
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
- **Refused** while a header change waits for the user's OK (5.2), or while the two header copies disagree on a key
  slot, so that a backup always restores with either credential. Also refused over 250 000 payload entries.
- **Contents:** the item files of every current item of the open vault (including items created since unlock), plus
  the blobs those items attach, each **authenticated as it is copied**. Damaged items are left out and reported. Also
  left out: damaged or missing blobs, retired blobs and `files/orphaned/`. The backup report counts each.
- **Format:** one `.lockbox-backup` file, a **ZIP64** archive with no compression, containing `vault.json`, `items/`,
  `files/` (excluding `orphaned/`) and a `backup-manifest.json`. The manifest lists every archive entry except itself,
  with its path, size and SHA-256; the archive holds exactly the listed entries plus the one `backup-manifest.json`,
  which is authenticated by its MAC. The manifest carries an **HMAC-SHA256** keyed by HKDF(vault key,
  info = `"lockbox backup manifest v1"`), so after unlocking, restore can prove the backup is complete (nothing added,
  removed or swapped).
  - **Manifest MAC message** = `encode_ad("lockbox/backup-manifest", manifest_version ‖ vault_id ‖ created_at ‖ for each
    entry: path ‖ size (u64 LE) ‖ sha256)`.
  - **Allowed entry names (exact):** `vault.json`, `backup-manifest.json`, `items/<32 lowercase hex>.item`,
    `files/<32 lowercase hex>.blob`.
  - **Limits, applied the same way when testing a backup, restoring and opening read-only:** `backup-manifest.json` ≤
    64 MiB (67 108 864 bytes), checked against the archive's declared entry size before any of it is read into memory
    (not only before parsing); JSON nesting depth ≤ 32; at most 250 000 payload entries, so the
    manifest lists at most 250 001 entries and the archive holds at most 250 002 records.
- The size the UI shows for a backup is the backup file's size on disk.
- **Verify, then publish:** the backup is written to a hidden temp file beside the destination, recorded in the output
  journal (7.2), re-read and checked against the manifest, then renamed into place. A failed or cancelled backup never
  replaces an existing backup file.
- Before starting, Lockbox checks the destination's free space and file-size limit (e.g. FAT32's 4 GiB) and refuses
  with the reason if it can't hold the backup.
- **Reading backups: Lockbox's own strict parser.** The `zip` crate only writes backups. Lockbox reads them with its own
  parser, which accepts exactly this subset and refuses anything else with the name of the failed check:
  - The end record sits at exactly `file_len − 22` and has an empty comment.
  - One disk.
  - ZIP64 end locator and record present when any 16/32-bit field is saturated.
  - Central directory: contiguous, ending where the end record (or ZIP64 record) starts.
  - Every record:
    - flags `0` (bit 11 is allowed)
    - method `0`
    - compressed size equals uncompressed size
    - name ≤ 64 bytes, from the allowlist
    - comment length `0`, disk start `0`
    - not a directory or link: no MS-DOS directory attribute, and unix type bits either `0` or regular file
    - extra fields: only ZIP64 `0x0001`
  - Every local header: right signature, same flags, same method, same name bytes, and sizes that match the central
    record (directly, or through its ZIP64 extra field).
  - Sorted by header offset, the ranges `[header_offset, data_end)` **tile `[0, cd_offset)` exactly**: no gap, overlap,
    duplicate or prepended data.
  - All arithmetic is checked.
- **Test a backup:** any backup can be checked without restoring. Inside the archive, it checks the manifest MAC, every
  entry's SHA-256, every item and every file stream, and reports files the items attach that the backup lacks. Nothing
  is written.

### 6.8 Restore
The existing vault is untouched until extraction and authentication have succeeded, and the swap is journaled so a crash
can't lose both copies. The order is: unlock before extracting, so a wrong password fails at once.
1. **Inspect before writing anything.** Lockbox reads the archive with its own parser (6.7), never a library
   "extract all", and validates every entry: only the allowed names; no absolute paths, `..`, drive letters, links,
   duplicates or unexpected files; entry count, manifest size and declared sizes within the limits in 6.7; total size vs
   free space. The entry list must **match the manifest exactly** (the listed entries plus `backup-manifest.json`
   itself). Refused while a restore journal exists.
2. **Unlock from the archive** with the backup's header and the user's password **or recovery key** (the backup may hold
   an older password; the UI says the restored vault's password is the backup's). Then verify the header MAC and the
   manifest MAC.
3. **Choose the destination** in the chosen parent folder:
   - The folder of the vault with the same ID: replace it (**several such folders → refuse**). The user may instead open
     the backup read-only (6.9).
   - Otherwise a new folder `<name>-<short-id>`, or a new folder the user names, beside the others, when no readable
     copy of this vault is in that parent. A new folder never replaces anything: **if its name (the default
     `<name>-<short-id>` or one the user names) is taken by anything, refuse before writing.** When a vault folder's two
     header copies are both unreadable, restore cannot tell it is the same vault; the UI then offers a new folder beside
     it (e.g. `Clients-1a2b3c4d (restored)`) and leaves the damaged folder untouched.
   - Restore never merges into, or replaces, a folder that is not the same vault.
4. **Journal `extracting`, then extract** into a staging folder `.restore-<32 lowercase hex>` **in the destination's
   parent folder** (same drive, so the final step is a rename). The journal is
   `%LOCALAPPDATA%\Lockbox\restore-journal.json`. Every entry is hash-checked against the manifest as it is written,
   every item opened, and every blob authenticated as it is written (`authenticate_copy`); each entry's byte limit is
   enforced while writing.
5. **Swap, journaled:**
   - Lock and close the existing vault (release `.lock` and every handle).
   - When the swap starts, before any rename, choose the first unused name of `<folder>.before-restore`,
     `<folder>.before-restore-2` … `-99`, so an earlier pre-restore copy is never replaced. If all are taken, the
     restore is refused before any rename; the staged restore stays for the user to free a name.
   - Journal `swapping`, then rename existing → the chosen `.before-restore` name, then staging → `<folder>`, retrying
     on sharing violations (6.2).
   - A rename refused by a brief lock, before anything has moved, keeps the staged restore for a retry.
   - **Cancellation:** a restore checks for cancellation up to the start of the swap. Once the swap has started it is
     never cancelled: it finishes, or the recovery table below rolls it back, and the journal is kept until recovery
     succeeds. The restore holds its own key from unlocking the backup (step 2), independent of any session of the
     destination vault (7.4).
   - Deleting the journal marks the restore done. The `.before-restore` folder is kept and listed in the UI (open
     read-only, or delete). Pre-restore folders are found again at any time by looking beside each known vault; delete
     works only on a real folder with that vault's ID that no session has open.
6. **Recovery at startup:** a journal found at launch is acted on by what is on disk, using the table below. Terms: S =
   staging folder, T = target folder, B = the `.before-restore` folder (`before_restore`).
   - **Journal validation** comes first. A failure gives `Damaged { what: "restore journal" }` and touches nothing:
     - S, T and B (when present) are absolute, with only normal components after the prefix and root (no `.` or `..`),
       and have the same parent.
     - S's name matches `.restore-<32 lowercase hex>`. T's name does not start with `.restore-` and does not contain
       `.before-restore`. B's name is T's name plus `.before-restore` or `.before-restore-<2..=99>`.
     - The three names differ pairwise under case-insensitive comparison (`to_lowercase`), because Windows names are
       case-insensitive.
     - `extracting` has `before_restore == None`.
     - Before deleting or renaming, each path that exists must be a real folder by `symlink_metadata`: not a link, a
       junction or another reparse point that redirects the path (a Windows "name surrogate"). A cloud-sync
       placeholder, such as OneDrive's, does not redirect and counts as a folder.
   - **The vaults folder must be there.** If the folder that holds S, T and B is missing (its drive is not plugged in),
     S and T would both read as missing, which says nothing about them: nothing is decided, the result is
     `Err(RestorePending)`, and the journal is kept. Once S exists, the clean-up after a failed prepare or extraction
     keeps the journal then too, since S always goes before the journal (a failed attempt to create S still removes
     the journal: there is no S yet). Dismissal still works: it removes the journal and touches nothing on the missing
     path (the UI says the drive is not connected). So it does not undo a half-done swap, as recovery would: if T was
     already moved to B but S not yet to T (a drive that goes away between the two renames leaves this), then once the
     drive is back T is missing, the old vault is in B and the restored copy in S. No data is lost: the user renames B
     back to T (keeping the old vault) or un-hides S and renames it to T (taking the restored one), then may delete
     the other. Reconnecting the drive and letting recovery run (B back to T, then S removed) is the better path, and
     the UI offers it before dismissal.

   | Journal | Disk state | Action | Result |
   |---|---|---|---|
   | none | – | nothing | `NothingToDo` |
   | `extracting` | any | remove S | `StagingRemoved` |
   | `swapping`, B none | T exists, S gone | nothing | `Finished` |
   | `swapping`, B none | T missing | remove S | `RolledBack` (no T: a new-destination restore leaves nothing) |
   | `swapping`, B none | T and S exist (T is not ours) | remove S, leave T | `RolledBack` |
   | `swapping`, B some | B missing, T exists | remove S | `RolledBack` |
   | `swapping`, B some | B exists, T missing | rename B → T, then remove S | `RolledBack` |
   | `swapping`, B some | B and T exist, S gone | nothing (B kept) | `Finished` |
   | any other | – | touch nothing, keep journal | `Err(InvalidInput { what: "restore state unclear" })` |

   Every row but the last ends with `remove_staging_then_journal`: the staging folder is always deleted before the
   journal, and the journal stays until cleanup has worked. If a rename or the staging removal fails, the result is
   `Err(RestorePending)` and the journal is kept. Recovery is idempotent: a crash during recovery leaves a state the
   table handles on the next run.
   - A journal that cannot be acted on can be dismissed by the user. Dismissing deletes only a validated staging folder,
     never the vault or a pre-restore copy.
   - The shell can read a journal without acting on it (its step, paths, and whether their parent folder is there), so
     it can tell a disconnected drive from an unclear state.

A validation failure in the archive or during extraction deletes only this operation's own staging folder (the journal
is kept until that cleanup has worked); the existing vault is untouched. A journal-validation failure touches nothing.

### 6.9 Read-only vaults
- A `.lockbox-backup` file or a `.before-restore` folder can be opened **read-only**, alongside the live vault.
- **Opening a folder read-only writes nothing:** no `.lock`, no header repair, no cleanup.
- Sessions are keyed by **location**, not vault_id, so two copies of the same vault can be open at once; read-only ones
  are labelled in the UI and reject every write.
- Backups are browsed **directly inside the archive** (entries are stored uncompressed, so blobs are read by offset)
  after the structural and entry-list checks of restore step 1 (not its restore-journal or extraction-space checks);
  nothing is extracted except files the user saves or opens.
- **A backup opened read-only unlocks and verifies both MACs, as in restore step 2, before any item is shown.** It then
  checks every item against the manifest at open. Blobs are authenticated when exported or copied: file IDs are never
  reused, so the AEAD binds them.
- **An export is refused** when its destination is the backup itself, inside the folder being viewed, or inside any
  vault folder: a folder that holds `vault.json` or `vault.json.bak` (a link of that name counts), or any folder
  under one. A decrypted copy cannot replace a vault's own file, outside the accepted link-swap window between this
  check and the save (`SECURITY.md`).
- **Copying an item** from a read-only vault into the live one:
  - The copy gets a new item ID, and each attachment a new file ID and key. Attachments are re-encrypted in memory,
    never as plaintext on disk.
  - Its collection is kept only if the live vault has that collection and it is not in the trash. Collections
    themselves are not copied, and the copy is never trashed.
  - If the backup lacks some of the item's files, the copy stops and names them. The user may copy without them; the
    result lists what was left off. A file that is present but fails authentication is never skipped. Locking either
    vault stops the copy.
  - A copy that fails deletes the blobs it published itself (none was ever referenced), unless its new item may already
    be on disk; a blob it cannot delete is left for the cleanup at unlock to set aside (6.4).

### 6.10 Locations, locking and filesystems
- **Default vault location:** `%USERPROFILE%\Lockbox Vaults\`. Never inside Tauri's app-data folders
  (`app_data_dir()`, `%APPDATA%\<identifier>`, `%LOCALAPPDATA%\<identifier>`), which the uninstaller can delete, and
  never in the Roaming profile (tested).
- **Vault registry:** the list of known vault locations is kept in `%LOCALAPPDATA%\Lockbox\vaults.json` (locations
  only, no secrets). "Add existing vault folder" adds one.
- For writable sessions, `.lock` is held with an **OS exclusive file lock** (`LockFileEx`) while the vault is open. A stale `.lock` without a
  held lock (after a crash) is ignored and re-locked.
- **Supported:** local, fixed NTFS drives. **Refused in v1:** removable drives (drives Windows reports as removable,
  such as USB sticks and SD cards), FAT32, network drives. **Warned:** folders inside OneDrive, Google Drive or Dropbox
  (not supported in v1).
- Supported means `GetDriveTypeW` reports a fixed drive and the file system is NTFS; CD and DVD drives, RAM disks and
  unknown types are refused too. A USB hard drive that reports as fixed is accepted; unplugging it locks its vault
  (below). The checks run when a vault is created, added, restored to and unlocked. Cloud folders are found by asking
  Windows whether the path is under a cloud sync root, then by each provider's known location.
- If the drive holding an unlocked vault disappears, that vault is locked and shown as "unavailable", never treated as
  deleted.

## 7. Screens and behaviour

### 7.1 Screens

Moved to [docs/PRD.md](../PRD.md#screens).

### 7.2 Decrypted output: Save a copy and Open
**Rule: verify fully, then publish.** Nothing is placed at its final location or launched until the whole stream has
authenticated.
- **Output journal:** every temporary plaintext file Lockbox creates is recorded (by its random temp path, never the
  original name) in `%LOCALAPPDATA%\Lockbox\pending-outputs.json` before writing, and removed from it when published or
  deleted. Recording comes first: if the journal cannot be written, nothing is created. At launch, leftovers listed
  after a crash or power cut are cleaned up by these rules: only Lockbox's own temp names (`.<16 hex>.lockbox-partial`,
  `.<16 hex>.lockbox-backup-partial`) and folders directly inside `open\` are deleted, and only when the recorded path
  has no link anywhere along it; any other entry is dropped from the journal and left on disk, and an entry on a drive
  that is not connected is kept for later. A damaged journal blocks new decrypted output until the user lets Lockbox set
  it aside. Save a copy output, backups and vaults are never placed in Lockbox's own state folder
  (`%LOCALAPPDATA%\Lockbox\`); the only decrypted files there are "Open" files, in its `open\` folder (described below).
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
    similar) require an explicit confirmation before launch. "Executable types" are judged on the sanitised name (so
    `setup.exe.` counts), and also when Windows rates the type as dangerous.
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
hold the clipboard open. "Still holds what Lockbox put there" means the Windows clipboard sequence number is unchanged
since Lockbox's write; the write and the reading of that number happen in one clipboard opening, and so do the check
and the clear. If any of the three exclusion formats cannot be set, the clipboard is emptied and the copy fails. Each
copy has its own timer. Locking a vault clears a copy made from that vault; locking all vaults clears any.

### 7.4 Locking (concurrency contract)
- **Idle** means no keyboard or mouse input anywhere in Windows for the configured minutes. **While a long operation the
  user started is running** (import, Save a copy, Open, backup, restore), the idle timer is paused, the UI shows why, and
  Lockbox asks Windows to stay awake (`SetThreadExecutionState`). Paused means time spent in a long operation does not
  count: after it ends, idle time counts from its end. **Windows lock, sleep and hibernate always lock all vaults
  immediately**, cancelling such operations. Signing out, switching user and a remote-desktop disconnect count as
  Windows lock. Closing the app locks all vaults.
- **Two guarantees, kept separate:**
  - **Access is denied immediately.** From the moment of locking, no new command runs and no response carrying vault
    data is accepted by the UI.
  - **Operations stop eventually.** Running operations stop at their next cancellation check; the last one to finish
    releases the vault key. For operations that stream data, one chunk bounds the *work* done after a lock (≤ 1 MiB),
    not the elapsed time. Unlocking is the exception (see **Unlocking** below).
- **Locking:** (1) marks the session locked and bumps its **generation number**; (2) signals cancellation; (3) drops the
  session's reference to the vault key; (4) tells the UI to clear item state, revealed values and search results, and
  show the lock screen; (5) clears a Lockbox clipboard copy made from this vault (locking all vaults clears any, 7.3).
- **Backend checks:** every command checks the generation when it starts and again before it returns.
- **UI-side check:** every response is **tagged with its session generation**; the UI discards any response whose tag
  doesn't match the vault's current generation.
- **Side effects:** clipboard writes and file publication (renames) re-check the generation **under the session lock**,
  doing only that fast step there (clipboard with a timeout). File publication and clipboard writes take a per-session
  guard for one attempt at a time, so a lock waits for at most one rename attempt, never for its retries. **Launching an
  opened file happens after the lock is released**, so a blocking "How do you want to open this file?" dialog can never
  delay locking.
- **Long operations** check for cancellation between chunks, delete their partial output (via 6.4 / 7.2 rules) and
  report "Cancelled: vault locked." A restore holds its own key from unlocking the backup, independent of any session
  of the destination vault; locking or closing the destination vault cancels a restore only before its swap starts (6.8).
  A credential change or a new vault that a lock interrupts after it was written says so ("changed, but locked before it
  could be shown") instead of plain "locked".
- **Unlocking** is not cancellable inside the engine: a lock during it discards the result when the unlock returns. The
  password derivation runs until it returns, so the chunk bound above does not apply to it; the vault it returns is
  discarded, and its key released, when it returns.
- **Settings:** idle time 1–60 minutes (default 5), clipboard clear delay 10–300 seconds (default 30).

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
| Not enough space, or file too big for the drive (FAT32 4 GiB limit) | Checked **before** any import or export starts; refused at once with the numbers ("needs 50 GB, 12 GB free"). |
| Sharing violation (antivirus, indexer) | Retried with backoff, then a clear error (6.2). |
| Operation running when the vault locks | Cancelled, partial output deleted (7.4). |
| "Open" cleanup fails | Retry + visible message (7.2). |
| Backup destination too small / FAT32 limit | Refused before starting, with the reason (6.7). |
| Backup or restore validation fails | Nothing changes; the error names the check that failed (6.7, 6.8). |
| Restore destination name taken by an unrelated folder, or several folders with the same vault ID | Refused before anything is written (6.8). |
| Crash during restore swap or recovery | Journal rolls back or finishes at next launch, decided by what is on disk (6.8). A journal that can't be acted on is kept and can be dismissed by the user. |
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
  journal recovers with no data lost; a > 4 GiB archive round-trips (ZIP64); test a backup finds a tampered,
  rolled-back or missing entry without writing anything; a damaged blob in the live vault still gives a backup that
  restores; an unrelated folder at the destination name is refused; a second restore keeps the first
  `.before-restore`; a crash during recovery itself recovers on the next run.
- **Read-only vaults:** a backup and a `.before-restore` folder open read-only next to the live vault; every write is
  refused; copying an item into the live vault works.
- **Locking:** lock during unlock, reveal, search, import, Save a copy, Open, backup and restore → no data returned after
  the lock, partial output deleted, key released; a response with an old generation is discarded by the UI; a clipboard
  write racing a lock either completes before it (and is then cleared) or never happens; locking isn't delayed by a
  blocked file launch; idle timer pauses during long operations; Windows lock still cancels them; a restore is cancelled only before its swap
  starts, and a lock or close of the destination vault during the swap leaves it to finish or roll back by the journal.
- **Decrypted output:** a tampered blob or a cancellation never alters an existing destination file; leftovers listed in
  the output journal are cleaned up at the next launch by the 7.2 rules (only Lockbox's own temp names and `open\`
  folders, never through a link; any other entry is left on disk); file-name sanitisation; executable types require
  confirmation.
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

- **Change flow:** branch → tests + security scan → pull request → CI → Greptile review → Ariel approves → merge.
  Nothing is pushed to `main` or released without Ariel's go. Commits under Ariel's GitHub account.
- **CI (GitHub Actions, pinned Windows image):** `cargo fmt --check`, `cargo clippy -D warnings`, `cargo test`, frontend lint +
  tests + build, Tauri build, and the security scan.
- **Security scan:** our own `scripts/scan.mjs` running gitleaks (secrets), semgrep (risky code) and osv-scanner
  (vulnerable dependencies), with one pass/fail result. Calls semgrep by full path (see `docs/SETUP.md`).
- **Dependencies:** the `zip` crate (≥ 2.3.0) only writes backups; Lockbox reads them with its own strict parser (6.7).
- **Repo docs:** `README.md` (incl. "not independently audited"), `SECURITY.md` (R1–R7, limits, how to report a
  vulnerability), `docs/PRD.md` (the product side of this spec), `ARCHITECTURE.md` (code map and rules of the built
  core), `docs/SETUP.md`, `LICENSE` (MIT).
- **Greptile:** free Starter plan (decided 2026-10-17).
- **Personal editor and tool settings stay on the dev machine**, never committed.

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

**Decided in Plan 2 (2026-10-17):**
- Strict own archive reader (the `zip` crate only writes) · blobs authenticated as they are copied · unlock before
  extract · numbered `.before-restore` (an earlier pre-restore copy is never replaced) · an unrelated folder at the
  destination is refused · journaled recovery decided by disk state · test a backup · read-only folders write nothing.

**Decided in Plan 3 (2026-10-27):**
- Restore into a new folder when the headers are unreadable · copy without missing files on request · journal query ·
  file pickers through `rfd` from Rust · the clipboard through `clipboard-win` in one opening per step · OS signals on
  a hidden window · a per-attempt publish gate · item types without public serde.

**Deferred, with a known home:**
- Rotate vault key: v1.1.
- Rollback/deletion detection (authenticated manifest, tombstones) and conflict handling: Phase 3 sync spec.
- Migration implementation and tests: when a v2 format exists.
- Independent security audit: not planned; README states this.

**Confirm at build time:** `aead-stream`'s API and maturity (read with `opensrc`), keeping the nonce layout in 5.5;
reliable Windows session-lock and sleep notifications on Modern Standby PCs (native message window).
