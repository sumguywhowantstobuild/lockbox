# Lockbox — Design Spec

**Date:** 2026-10-07 · **Author:** Ariel Maningas · **Status:** revision 3 (after second design review), awaiting approval

## 1. Purpose

Lockbox is a local-only password manager and encrypted file vault for Windows, with no server. Besides passwords and
notes, it stores real files (client contracts, design files, project archives), grouped by client or project. Its
differentiators are a better UI and file storage organised by client/project.

It is a public, open-source portfolio project. It must be production quality: tested, reviewed, documented, and honest
about its limits.

### Security requirements (v1)
| ID | Requirement |
|---|---|
| R1 | **Confidentiality at rest.** Without the vault password or recovery key, a copy of the vault folder reveals only: the vault name, Argon2id parameters, the number of items and stored files, their approximate sizes, and file timestamps. |
| R2 | **Integrity.** Any modification of a header key slot, item, or file chunk is detected and refused. (Limits: see R7.) |
| R3 | **Guessing cost.** Each password guess costs one Argon2id derivation of at least 64 MiB, 3 iterations, parallelism 4 (calibrated to ~1 s); vaults with weaker parameters are refused (section 5.2). |
| R4 | **No plaintext written by Lockbox** except where the user asks for it: "Save a copy", "Open", and printing or saving the recovery key as a PDF. OS paging, hibernation, crash dumps and the print spooler are outside Lockbox's control (section 5.6). |
| R5 | **No secrets in logs or error messages**: no passwords, keys, recovery keys or item content. |
| R6 | **Locking stops access.** After a vault locks, no command returns its data and its running operations stop (section 7.4). |
| R7 | **Documented limits.** v1 does not detect an attacker restoring an older valid copy of an item, or deleting a whole item file (section 6.6). |

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
conflict handling, deletion tombstones and an authenticated manifest; the format version (section 6.1) is the upgrade
path to add them.

## 3. Scope

### v1 features
- **Vaults**, each with its own password; unlocking one doesn't unlock the others.
- **Collections** inside a vault, one per client or project.
- **Items:** Login, Secure note, File. Logins and notes can have files attached. **Maximum file size: 256 GiB.**
- **Password generator:** length, character sets, passphrase mode.
- **Auto-lock** after idle time and when Windows locks, sleeps or hibernates; **clipboard clearing** after copying.
- **Ctrl+K quick search** across unlocked vaults, with quick actions.
- **Recovery key** per vault, shown once at creation.
- **Change password** (with the warning in section 5.3).
- **Encrypted backup and restore** of a vault.

### v1.1 (next, not in this spec)
Rotate vault key (re-encrypt everything) · password health check · built-in 2FA codes (TOTP) · Windows Hello unlock.

### Not in v1
Browser autofill extension · sync · mobile · sharing between people · importing from other password managers.

## 4. Architecture

```
┌──────────────── Lockbox app (Tauri 2) ───────────────┐
│  UI: React + TypeScript                               │
│                      │ Tauri commands (IPC)           │
│  Desktop shell (Rust, crate: lockbox-desktop)         │
│  Command bridge, sessions, auto-lock, clipboard,      │
│  single instance, "Open" folder                       │
│                      │                                │
│  Core library (Rust, crate: lockbox-core)             │
│  Crypto, vault format, items, files, generator, backup│
│  No Tauri/Windows dependencies; own test suite        │
└──────────────────────┬────────────────────────────────┘
                       │
      Disk: one folder per vault
      Default parent: %APPDATA%\Lockbox\vaults\ (user may pick another location per vault)
```

- **UI:** screens and user input. Holds decrypted data only while displaying it (section 4.1).
- **Desktop shell:** OS integration (idle detection, Windows lock/sleep events, clipboard, single instance, window),
  unlocked vault sessions, and validation of every command.
- **Core:** all cryptography and file formats. **Keys never leave the core.**

### 4.1 What crosses into the UI
| Data | Crosses IPC? | When |
|---|---|---|
| Vault keys, file keys, password/recovery-derived keys | **Never** | — |
| File contents | **Never** | Rust streams between disk and the vault directly |
| Vault password, new password | UI → Rust | Typed into the UI on unlock, create, change |
| Recovery key | Rust → UI once; UI → Rust | Displayed at vault creation; typed in when recovering |
| Item titles, usernames, URLs, notes, collection names | Rust → UI | While an item or list is displayed |
| Item passwords | Rust → UI | Only on "Reveal" or while editing. **Never for copying**: copy runs entirely in Rust. |

**Places copies of secrets may exist:** the webview's memory (typed and displayed values), the OS clipboard (after a
copy, until cleared), the Windows pagefile and hibernation file, crash dumps, and the user's chosen "Save a copy"/"Open"
locations. The UI clears its state on lock (section 7.4), but webview memory can't be wiped as reliably as Rust's.

### 4.2 Tauri command security
- Every Lockbox command is declared in an **application manifest** (`tauri_build` app manifest) so it requires an
  explicit permission. Only the main window's capability grants them. No generic filesystem, shell or HTTP plugins are
  exposed to the UI.
- Strict Content-Security-Policy; no remote content is ever loaded.
- **The backend validates every command**, never trusting the UI: the vault handle exists and is unlocked; the request's
  session generation is current (section 7.4); every referenced item, collection or file belongs to that vault; sizes
  are within limits. File system paths come only from native open/save dialogs and are canonicalised; the UI never
  sends arbitrary paths.

## 5. Cryptography

### 5.1 Libraries and encoding
RustCrypto crates only: `argon2`, `chacha20poly1305` (XChaCha20-Poly1305), a RustCrypto STREAM implementation,
`hkdf` + `sha2`, `zeroize`; randomness from the OS (`getrandom`). **No hand-written cryptography.** Crate versions are
pinned in `Cargo.lock`, and APIs are read with `opensrc` before use. Binary fields in JSON are base64 (standard, padded).
All associated-data (AD) strings below are UTF-8 labels joined with length-prefixed fields.

### 5.2 Key hierarchy
```
Vault password ──► Argon2id ───────► password key ──┐  each unwraps a copy of
Recovery secret ─► HKDF-SHA256 ────► recovery key ──┘  ──► Vault key (random 256-bit) ──► encrypts items
                                                                         └─► items hold per-file keys ──► encrypt file blobs
```
- **Vault key:** random 256 bits, generated at creation, never stored unwrapped.
- **Each key slot has its own salt.** The password slot's salt is replaced on every password change; the recovery
  slot's salt is set once at creation and never changes. (A shared salt would silently break the recovery key after a
  password change, because HKDF's output depends on its salt.)
- **Password key:** Argon2id(password as UTF-8 after Unicode NFC normalisation, password-slot salt (16 random bytes),
  params) → 32 bytes.
- **Argon2id parameters:** calibrated at creation to ~1 s, never below 64 MiB / 3 iterations / parallelism 4.
  **Accepted bounds when reading a vault** (vault.json is attacker-controlled before unlock): memory 64 MiB–1 GiB,
  iterations 3–10, parallelism 4–16, salt exactly 16 bytes. Out-of-bounds values are refused **before** any derivation.
- **Recovery secret:** 256 random bits, shown once as 13 groups of 4 Crockford base32 characters. Input ignores spaces,
  dashes and case, and maps O→0 and I/L→1. **Recovery key** = HKDF-SHA256(ikm = recovery secret, salt = recovery-slot
  salt (16 random bytes), info = `"lockbox recovery key v1"`) → 32 bytes.
- **Key slots** in `vault.json`: `{type: "password"|"recovery", slot_version, salt, [kdf params], nonce: 24 random
  bytes, ciphertext}`, where ciphertext = XChaCha20-Poly1305(slot key, vault key) with AD = `"lockbox/slot"` ‖
  slot_version ‖ vault_id ‖ slot type ‖ salt. **The AD contains the slot's own version, not the container version**, so
  routine format upgrades never need to re-wrap slots (and never need the recovery secret).

### 5.3 Changing the password, and recovering
- **Change password:** unlock, derive a new password key with a fresh password-slot salt, re-wrap the vault key into a
  new password slot, write the new header (section 6.3). The recovery slot is copied unchanged. Both `vault.json` and
  `vault.json.bak` end up with only the new password slot.
- **Recover:** unwrap with the recovery key, then the user must set a new password (same steps as change). The original
  recovery secret keeps working after any number of password changes.
- **⚠ Limit, shown in the UI and documented:** changing the password does **not** change the vault key. Anyone who has
  an old copy of the header (an earlier copy of the vault folder, an old backup, or a stale `vault.json.bak`) plus the
  old password can recover the vault key, and that key decrypts **current and future data too**, if they ever get
  copies of the newer item and file blobs. Full revocation needs **Rotate vault key** (v1.1), which creates a new vault
  key and re-encrypts everything.

### 5.4 Items
- Each item is serialized (JSON, max 1 MiB plaintext) and encrypted with XChaCha20-Poly1305 under the vault key, with
  a fresh random 24-byte nonce.
- Each item file records its own **item_version** (readable, beside the ciphertext).
- AD = `"lockbox/item"` ‖ item_version ‖ vault_id ‖ item_id. An item file can't be moved into another slot or vault
  undetected.

### 5.5 Files (blobs)
- Each stored file has a random 128-bit **file_id** and its own random 256-bit **file key**, kept inside its (encrypted)
  item. **Replacing a file creates a new file_id and key**; blobs are never modified in place.
- Content is encrypted with the **STREAM construction** over XChaCha20-Poly1305 ("big-endian 32-bit counter" variant):
  nonce = 19-byte random prefix ‖ 32-bit big-endian chunk counter ‖ 1-byte last-chunk flag.
- **Chunks:** 1 MiB of plaintext each (the last may be smaller), stored back to back in one blob file
  `files/<file_id>.blob`. Each ciphertext chunk = plaintext + 16-byte tag.
- **Per-chunk AD** = `"lockbox/chunk/v1"` ‖ vault_id ‖ file_id ‖ total plaintext length ‖ chunk count.
- **Authenticated metadata in the item:** file_id, file key, nonce prefix, total plaintext length, chunk count, original
  file name, media type.
- **Empty file:** exactly one chunk with empty plaintext, marked last.
- **Decryption is valid only if** the blob has exactly the expected size, every chunk authenticates in order, the last
  chunk carries the last-chunk flag, and no chunk before it does. Anything else is refused as damaged.
- **Limits:** max 256 GiB per file (262,144 chunks, far below the 2³² counter limit).

### 5.6 Memory and honest limits (all go into `SECURITY.md`)
- Secrets in Rust are held in `Zeroizing`/`secrecy` types and are not cloned needlessly; keys are shared by reference
  counting so only one copy exists. `zeroize` wipes buffers Lockbox owns when they're dropped, but cannot guarantee
  that earlier copies (from moves or reallocations) are gone, and cleanup doesn't run if the process is killed or crashes.
- Secrets may reach the **pagefile**, **hibernation file** or **crash dumps**, and a printed recovery key passes
  through the **print spooler**. Lockbox doesn't control these; users who need more should use full-disk encryption
  (BitLocker), which the README recommends.
- Malware running on the PC while a vault is unlocked can read what Lockbox can read.
- Values shown or typed in the UI pass through webview memory (section 4.1).
- Deleted files on SSDs are not guaranteed to be erased from the disk.
- No lockout after wrong passwords: an attacker with the vault folder bypasses the app. Argon2id cost is the protection.
- Rollback and deletion detection limits: section 6.6.

## 6. Vault format on disk

### 6.1 Layout
```
<VaultName>-<short-id>/
├── vault.json          container_version, vault_id, vault name, key slots (each with its own salt), migration marker, created_at
├── vault.json.bak      copy of the current vault.json, used if vault.json is damaged
├── .lock               held with an OS exclusive lock while a Lockbox instance has the vault open
├── items/
│   └── <random-id>.item     one encrypted item (login, note, file metadata, or collection)
└── files/
    └── <file_id>.blob       one encrypted file (chunks back to back)
```
- **Collections are items** of type `collection`; other items reference their collection's ID.
- **On-disk names are random IDs.** Titles, usernames, collection names and file names exist only inside encrypted
  items. The **vault name is readable** in `vault.json` so the lock screen can list vaults; the UI warns at creation not
  to put secrets in it.
- **Every item has a revision number and modified timestamp**, kept for a future sync design (not a sync guarantee).
- **Trash:** deleted items are flagged `trashed_at` and purged after 30 days or on "Empty trash".
- **Three independent versions:** `container_version` (vault.json layout and folder rules), `item_version` (per item),
  `slot_version` (per key slot). The app opens vaults whose container version it knows (upgrading older ones, section
  6.5) and refuses newer ones with "Update Lockbox to open this vault."
- **Parser limits:** `vault.json` ≤ 64 KiB, item file ≤ 1 MiB + overhead, JSON nesting depth ≤ 32, strict schemas.
  Anything over the limits is refused before parsing.
- **Search index:** built in memory on unlock; never written to disk.

### 6.2 Single-file writes
Every file write goes to a temp file in the same folder, is flushed to disk, then renamed over the target (an atomic
replace on NTFS).

### 6.3 Header writes
- Write the new `vault.json` (6.2), then write the same content to `vault.json.bak` (6.2).
- **Interrupted between the two:** `vault.json` is new and `.bak` is stale. The next successful unlock notices they
  differ and rewrites `.bak` from `vault.json`.
- **Fallback to `.bak`** (only when `vault.json` is damaged): Lockbox unlocks from `.bak` and shows a visible warning:
  "Opened from the backup header. If you changed this vault's password recently, it may need your *previous* password.
  Change the password again after unlocking." After a successful unlock it rewrites both headers.
- After a password change completes and `.bak` is rewritten, **no copy of the old password slot remains in the vault
  folder** (old backups and external copies are covered by the limit in 5.3).

### 6.4 Multi-file changes (commit order)
The **item file is the commit point**: a blob without an item is an orphan, never a visible file.
- **Add a file:** write `files/<id>.blob.partial` → flush → rename to `files/<id>.blob` → write the item (6.2).
- **Replace a file:** add the new blob as above → write the item pointing to it → delete the old blob.
- **Purge an item:** delete the item file → delete its blobs.
- **Cleanup after unlock:**
  - `*.partial` files are always deleted (they are never referenced by any item).
  - Unreferenced `.blob` files are deleted **only if every item in the vault decrypted and authenticated successfully.**
    If any item is damaged or unreadable, its references are unknown, so **no blob is deleted** and the UI reports
    "Cleanup skipped: N damaged items" (restoring the item from a backup may need those blobs).

### 6.5 Format upgrades (migration)
- Before upgrading, Lockbox automatically makes a backup (section 6.7).
- **Order:** (1) write the header with the **new `container_version` and a migration marker** `{from, to}`; (2) upgrade
  items one at a time (6.2); (3) write the header again without the marker.
- **Older apps can't see a half-upgraded vault:** from step 1 onward the container version is newer than they know, so
  they refuse it with "Update Lockbox." The new app reads both old and new item versions, so a half-upgraded vault is
  always readable by the new app, and an interrupted upgrade resumes on the next unlock.
- **Routine upgrades never touch key slots.** If a future slot format change is ever needed, the password slot is
  re-wrapped at the next unlock and the recovery slot when the recovery key is next used; both old and new slot
  versions stay readable until then.

### 6.6 Rollback and deletion (v1 limit)
Per-item encryption detects changes to an item, but not an attacker **replacing an item with an older valid copy**, or
**deleting an item file** entirely. v1 documents this. An authenticated manifest (with tombstones for deletions) is
deferred to the Phase 3 sync design.

### 6.7 Backup and restore
- **Consistent snapshot:** backups are made only by Lockbox, never by zipping the folder externally. While a backup
  runs, the vault's writes are paused (the backup holds the vault's write lock), so items and blobs match. Edits made
  during the backup wait or are refused with "Backup in progress."
- **Backup file:** one `.lockbox-backup` file, a **ZIP64** archive with no compression, containing `vault.json`,
  `items/`, `files/` and a `backup-manifest.json` listing every entry's path, size and SHA-256.
- **The manifest is authenticated:** it carries an HMAC-SHA256 made with a key derived from the vault key
  (HKDF, info = `"lockbox backup manifest v1"`). Backups are only made while unlocked, so the key is available. An
  attacker can rewrite a plain SHA-256 list, but not the HMAC, so after unlocking, restore can prove the backup is
  **complete**: no entry added, removed or swapped.
- **Restore** (nothing in the vaults folder changes until every check passes):
  1. **Inspect before writing anything.** Read the archive's directory listing and validate every entry first: only
     expected names (`vault.json`, `backup-manifest.json`, `items/<hex>.item`, `files/<hex>.blob`); reject absolute
     paths, `..`, drive letters, links, duplicates and unexpected files; entry count and declared sizes within limits;
     total size checked against free disk space. The entry list must **match the manifest exactly.**
  2. **Extract into a staging folder** `.restore-<random>` beside the vault folders, enforcing each entry's byte limit
     while writing (stop if actual bytes exceed the declared size) and checking each SHA-256 against the manifest.
  3. Unlock with the vault password, **verify the manifest HMAC**, then **authenticate every item and every complete
     file stream.**
  4. Only then move it into place. If a vault with the same ID exists, the user chooses: replace it (the current folder
     is kept aside as `<folder>.before-restore`) or cancel. The vault ID is kept, since items are bound to it.
  5. On any failure, delete the staging folder; the existing vault is untouched.

### 6.8 Locking and filesystem assumptions
- `.lock` is held with an **OS exclusive file lock** (`LockFileEx`) for as long as the vault is open. A stale `.lock`
  file without a held lock (after a crash) is ignored and re-locked.
- **Supported:** local NTFS drives. **Removable drives formatted exFAT or NTFS:** allowed with a warning, because
  rename and flush guarantees are weaker on removable media; use "Safely remove" before unplugging. **FAT32: refused**
  as a vault location (its 4 GiB file limit conflicts with blobs up to 256 GiB). **Network drives and cloud-synced
  folders:** not supported in v1 (warned at vault creation).

## 7. Screens and behaviour

### 7.1 Screens
| Screen | Contents |
|---|---|
| First run | Create first vault: name, password with strength meter, then the recovery key. Must confirm it's saved (print / save as PDF / checkbox) before continuing. |
| Lock screen | List of vaults (from `vault.json` names); pick one, enter its password. Vaults unlock independently. "Forgot password?" link. |
| Main window | Three columns: sidebar (vaults → collections, trash) · item list (filter, sort) · item details (copy/reveal, attached files: Open / Save a copy / Replace file). |
| Ctrl+K | Search across unlocked vaults; actions: copy password, copy username, new item, lock all. |
| Generator | Pop-out beside password fields, plus a standalone screen. |
| Settings | Auto-lock idle time (default 5 min), clipboard clear delay (default 30 s), theme (light/dark/system), backup, change password. |
| Backup / restore | Export a vault to one backup file; restore it (section 6.7). |
| Forgot password | Enter recovery key → set a new password. |

**Visual design** (colours, type, polish) is decided at the start of the UI work with Ariel's `design-bakeoff` skill:
clickable mockups, approved before screens are built.

### 7.2 Opening files
**Rule for every decrypted output: verify fully, then publish.** Nothing is placed at its final location or launched
until the whole stream has authenticated.
- **Save a copy:**
  - The user picks the destination with a native save dialog; overwriting an existing file needs the dialog's
    overwrite confirmation.
  - Lockbox decrypts into a hidden temporary sibling in the same folder (`.<random>.lockbox-partial`), verifies the
    entire stream, then atomically renames it over the destination.
  - On failure or cancellation, only the temporary file is deleted. **An existing destination file is never touched
    unless the copy completed and verified.**
- **Open:**
  - Decrypts into `%LOCALAPPDATA%\Lockbox\open\<random>\`, a folder whose permissions are restricted to the current
    Windows user. The file is launched with its default app **only after the full stream has verified.**
  - The file name is the original name made safe: path separators, control characters and reserved Windows names
    (CON, NUL, …) removed; length capped.
  - The copy is marked **read-only. Edits are not saved back into Lockbox**; to update a stored file, use "Replace file".
  - **Deletion is attempted** when the vault locks, when the app closes, and on the next launch. Cleanup clears the
    read-only attribute first (Windows won't delete a read-only file otherwise). Files held open by
    another app can't be deleted on Windows: Lockbox retries, shows "Couldn't remove N opened files. Close the app
    using them, then Retry," and retries on every launch until gone.
  - **Beyond Lockbox's control** (stated in the UI's first-use notice and in `SECURITY.md`): copies the other app makes
    (autosaves, recent-file caches, temp files).

### 7.3 Clipboard
Copied secrets are marked so **Windows clipboard history (Win+V) and cloud clipboard don't store them** (the Windows
"exclude from clipboard history / monitoring" formats, set by the desktop shell). After the delay, and when the vault
locks, the clipboard is cleared **only if it still holds what Lockbox put there.**

### 7.4 Locking (concurrency contract)
- **Idle** means no keyboard or mouse input anywhere in Windows (system idle time) for the configured minutes. Windows
  lock, sleep and hibernate lock all vaults immediately.
- Each unlocked vault session has a **generation number.** Locking: (1) marks the session locked and bumps the
  generation, so **new commands are rejected at once**; (2) signals cancellation to running operations; (3) drops the
  session's keys; (4) tells the UI to clear item state, revealed values and the search index, and show the lock screen;
  (5) clears Lockbox-owned clipboard content.
- **Two guarantees, kept separate:**
  - **Access is denied immediately.** From the moment of locking, no new command runs and no response carrying vault
    data is accepted by the UI.
  - **Operations stop eventually.** Running operations stop at their next cancellation check; keys are released when
    the last one ends. "One chunk" bounds the *work* done after a lock (≤ 1 MiB), not the elapsed time; a slow disk can
    make that take longer.
- **Backend checks:** every command checks the generation when it starts and again before it returns, and discards its
  result if the vault locked meanwhile.
- **UI-side check (closes the last race):** every response is **tagged with the session generation** it was produced
  under. The UI keeps the current generation for each vault (updated by lock/unlock events) and **discards any response
  whose tag doesn't match**, so a response that passed the backend check just before a lock can't repopulate cleared
  state.
- **Side effects are synchronized with locking:** clipboard writes, "Open" launches and file publication (7.2) run
  while holding the session's lock and re-check the generation under it, so they either complete before the lock or
  don't happen at all.
- **Long operations** (import, Save a copy, Open, backup, restore) check for cancellation between chunks, delete their
  partial output (`.partial` blobs, temporary copies, staging folders) and report "Cancelled: vault locked."

## 8. Error handling

| Situation | Behaviour |
|---|---|
| Wrong password | "Wrong password." No lockout (section 5.6). |
| Out-of-bounds Argon2 parameters or oversized header | Refused before derivation: "This vault file is damaged or not a Lockbox vault." |
| Damaged/tampered item | That item shows as damaged and is refused; the rest of the vault works; offer restore from backup. |
| Damaged/tampered file blob | "Save a copy"/"Open" refused; only the temporary file is deleted, an existing destination is untouched (7.2); offer restore from backup. |
| Damaged `vault.json` | Fall back to `vault.json.bak` with the visible warning in 6.3; if both fail, prompt to restore from backup. |
| Some items unreadable at unlock | Blob cleanup skipped, "Cleanup skipped: N damaged items" shown (6.4). |
| FAT32 chosen as vault location | Refused, with the reason (6.8). |
| Disk full / crash during save | Previous state remains (sections 6.2, 6.4); clear error shown. |
| Interrupted import | Partial blob deleted (or cleaned at next unlock); no item appears. |
| Operation running when the vault locks | Cancelled, partial output deleted (section 7.4). |
| "Open" cleanup fails | Retry + visible message (section 7.2). |
| Backup or restore validation fails | Nothing changes; error names the check that failed. |
| Second app instance | Single-instance app focuses the existing window; `.lock` prevents two writers on one vault. |
| Vault on unplugged drive | Shown as "unavailable", never treated as deleted. |
| Newer vault format | Refused with "Update Lockbox". |
| Crash while unlocked | Session memory is gone with the process (see 5.6 for limits); orphans and "Open" files cleaned on next launch/unlock. |

**Rule:** no password, key, recovery key or item content ever appears in an error message or log (R5).

## 9. Testing (acceptance criteria)

- **Test-first** for every piece of the core and shell. Every bug gets a regression test.
- **Crypto:** round-trips; wrong password; single-byte tamper in a slot, item and chunk → refused; chunk reorder,
  removal, duplication, truncation and extension → refused; empty file; last-chunk flag missing or early → refused;
  known-answer tests against published Argon2id and XChaCha20-Poly1305 vectors.
- **Header and passwords:** after a password change, the old password fails against **both** `vault.json` and
  `vault.json.bak`; **create → change password (several times) → recover with the original recovery secret** works;
  a crash between the two header writes recovers correctly; fallback to `.bak` shows the warning; out-of-bounds Argon2
  parameters (including parallelism < 4) are refused without allocating memory.
- **Crash safety:** simulated failure at each step of 6.2–6.5 → previous state intact, orphans cleaned at next unlock;
  **a damaged item never causes its blobs to be deleted**; stale `.lock` file is recovered; a held lock blocks a second
  writer.
- **Migration:** an interrupted upgrade resumes in the new app; an older app refuses the half-upgraded vault; routine
  upgrades leave both key slots byte-for-byte unchanged.
- **Backup/restore:** backup while edits and imports are attempted → snapshot is consistent; malformed archives
  (traversal paths, absolute paths, links, duplicates, unexpected files, entries not in the manifest or missing from it,
  declared/actual size mismatches, oversized entries) → refused **before any file is written**; a rewritten manifest
  (bad HMAC), or a tampered item or blob → refused after unlock with the vault untouched; a > 4 GiB archive round-trips
  (ZIP64).
- **Locking:** lock during unlock, reveal, search, import, Save a copy, Open, backup and restore → no data returned after
  the lock, partial output deleted, keys released; **a response tagged with an old generation is discarded by the UI**;
  a clipboard write racing a lock either completes before it (and is then cleared) or never happens.
- **Save a copy:** a tampered blob or a cancellation never alters an existing destination file.
- **"Open" cleanup:** read-only copies are removed (attribute cleared first); a file held open by another process →
  retry message, removed on a later launch.
- **Filesystem:** a FAT32 vault location is refused.
- **IPC security:** a command not granted by the capability is refused; commands with a stale generation, a foreign item
  ID or an out-of-limit size are refused by the backend.
- **Property tests** (`proptest`): random data round-trips; malformed headers, items and archives never panic or leak data.
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
- **Repo docs:** `README.md` (incl. "not independently audited"), `SECURITY.md` (requirements R1–R7, limits, how to
  report a vulnerability), `docs/SETUP.md`, `TRACKER.md`, `LICENSE` (MIT).
- **Greptile:** apply for the free open-source plan once the repo is public.
- **Third-party skills and tools stay on the dev machine**, never committed.

## 11. Decisions and deferred items

**Decided in review (2026-10-07):** password change warns instead of rotating (rotation in v1.1) · opened files are
read-only copies, updated via "Replace file" · idle means system-wide input idle · max file size 256 GiB · one blob
file per stored file · separate salts per key slot · separate container/item/slot versions · conservative blob cleanup ·
authenticated (HMAC) backup manifest · verify-then-publish for all decrypted output · FAT32 refused.

**Deferred, with a known home:**
- Rotate vault key: v1.1.
- Rollback/deletion detection (authenticated manifest, tombstones) and conflict handling: Phase 3 sync spec.
- Independent security audit: not planned; README states this.

**Confirm at build time:** the exact RustCrypto STREAM crate and API (read with `opensrc`), keeping the nonce layout in
section 5.5 unchanged.
