# Lockbox — Design Spec

**Date:** 2026-10-07 · **Author:** Ariel Maningas · **Status:** approved in brainstorming, awaiting written-spec review

## 1. Purpose

Lockbox is a local-only password manager and encrypted file vault for Windows: Bitwarden/1Password-level security with a
better UI, and no server. Besides passwords and notes, it stores real files (client contracts, design files, project
archives), grouped by client or project.

It is a public, open-source portfolio project, so it must be production quality: tested, security-reviewed, documented,
and honest about its limits.

**Success:** every v1 feature in section 3 works on Windows, all tests pass in CI, and the security write-up
(`SECURITY.md`) matches what the code actually does.

## 2. Phases

| Phase | Ships | Design choice made now so it isn't a rewrite later |
|---|---|---|
| **1 (this spec)** | Windows app for Ariel | Rust core is a separate library with no Windows or Tauri code |
| 2 | Share with friends: download website, code-signed installer, auto-updates | Vault format is versioned; app refuses vaults newer than itself |
| 3 | Android app + sync between devices without a server | Vault = folder of small files with revision numbers, safe to sync through a cloud folder |

## 3. Scope

### v1 features
- **Vaults**, each with its own password; unlocking one doesn't unlock the others.
- **Collections** inside a vault, one per client or project.
- **Items:** Login, Secure note, File (any size, including multi-GB). Logins and notes can have files attached.
- **Password generator:** length, character sets, passphrase mode.
- **Auto-lock** after idle time and when Windows locks or sleeps; **clipboard clearing** after copying.
- **Ctrl+K quick search** across unlocked vaults, with quick actions.
- **Recovery key** per vault, shown once at creation.
- **Encrypted backup and restore** of a vault.

### v1.1 (next, not in this spec)
Password health check · built-in 2FA codes (TOTP) · Windows Hello unlock.

### Not in v1
Browser autofill extension · sync · mobile · sharing between people · importing from other password managers.

## 4. Architecture

```
┌──────────────── Lockbox app (Tauri 2) ───────────────┐
│  UI: React + TypeScript                               │
│  Screens only. Never holds keys.                      │
│                      │ Tauri commands                 │
│  Desktop shell (Rust, crate: lockbox-desktop)         │
│  Command bridge, auto-lock, clipboard, single instance│
│                      │                                │
│  Core library (Rust, crate: lockbox-core)             │
│  Crypto, vault format, items, files, generator, backup│
│  No Tauri/Windows dependencies; own test suite        │
└──────────────────────┬────────────────────────────────┘
                       │
      Disk: one folder per vault (encrypted files only)
      Default parent: %APPDATA%\Lockbox\vaults\ (user may pick another location per vault)
```

**Boundaries**
- **UI** asks the shell to do things ("unlock vault X", "list items in collection Y", "copy password of item Z"). It
  receives only what it must display. **Copying a password happens in Rust; the UI never receives the password for a
  copy.** "Reveal" sends the value to the UI only on demand, and it is cleared from the UI's state when hidden or locked.
- **Desktop shell** owns OS integration: idle timer, Windows session lock/sleep notifications, clipboard, single-instance
  enforcement, window. It holds unlocked vault sessions and calls the core.
- **Core** owns all cryptography and file formats. Decrypted secrets live only in core memory, in types that are wiped
  (zeroized) when dropped; locking a vault drops them.

**Tauri hardening:** strict Content-Security-Policy, no remote content loaded, Tauri 2 capabilities limited to Lockbox's
own commands (no generic filesystem or shell access exposed to the UI).

## 5. Cryptography

### Libraries
RustCrypto crates only — `argon2`, `chacha20poly1305` (XChaCha20-Poly1305), `hkdf` + `sha2`, `zeroize`; randomness from
the OS (`getrandom`). **No hand-written cryptography.** Exact crate versions are pinned in `Cargo.lock` and their APIs
read with `opensrc` before use.

### Key hierarchy
```
Vault password ──► Argon2id ──► password key ──┐  each unwraps a copy of
Recovery key ─────► HKDF-SHA256 ──► recovery key ┘  ──► Vault key (random 256-bit) ──► encrypts all items and files
```
- **Vault key:** random 256-bit, generated at vault creation, never stored unwrapped.
- **Key slots:** `vault.json` holds two wrapped copies of the vault key (password slot, recovery slot), each encrypted
  with XChaCha20-Poly1305 under its slot key.
- **Argon2id parameters:** calibrated at vault creation to take about 1 second on the creating machine, with floors of
  64 MiB memory, 3 iterations, parallelism 4. Parameters and the 16-byte random salt are stored in `vault.json`.
- **Recovery key:** 256 random bits, shown once as 13 groups of 4 Crockford base32 characters. High-entropy, so it uses
  HKDF instead of Argon2.
- **Changing the password** re-wraps only the password slot (instant; no data is re-encrypted).
- **Recovering** with the recovery key unwraps the vault key, then the user must set a new password.

### Item encryption
- Each item is serialized (JSON), then encrypted with XChaCha20-Poly1305 under the vault key with a fresh random 24-byte
  nonce.
- **Associated data binds** the vault ID, item ID and format version, so an item file can't be swapped into another
  slot or vault undetected.

### File encryption (any size)
- Each file gets its own random 256-bit file key, wrapped by the vault key and stored in the file's item.
- Content is encrypted with the **STREAM construction** (the `aead` crate's stream module) over XChaCha20-Poly1305 in
  **1 MiB chunks**, with a per-file nonce prefix, a chunk counter and a last-chunk flag. Reordered, removed, duplicated or
  truncated chunks fail authentication.
- Encryption and decryption stream through memory; a multi-GB file never has to fit in RAM.

### Honest limits (go into `SECURITY.md`)
- Malware running on the PC while a vault is unlocked can read what Lockbox can read. No password manager prevents this.
- A value shown in the UI ("reveal") passes through the webview, whose memory can't be wiped as reliably as Rust's.
- Deleted files on SSDs are not guaranteed to be erased from the disk.
- No lockout after wrong passwords: an attacker with the vault folder bypasses the app. Argon2id cost is the protection.

## 6. Vault format on disk

```
<VaultName>-<short-id>/
├── vault.json          format_version, vault_id, vault name, Argon2id params + salt, key slots, created_at
├── vault.json.bak      previous good copy, used automatically if vault.json is damaged
├── .lock               present while a Lockbox instance has the vault open
├── items/
│   └── <random-id>.item    one encrypted item (login, note, file metadata, or collection)
└── files/
    └── <random-id>/        one encrypted file: chunk files 000000.chunk, 000001.chunk, …
```

- **Collections are items** of type `collection`; other items reference their collection's ID.
- **File names on disk are random IDs.** Titles, usernames, collection names and file names are only inside encrypted
  items. The **vault name is stored readable** in `vault.json` so the lock screen can list vaults; the UI warns at
  creation not to put secrets in a vault name.
- **Every item has a revision number** and modified timestamp (for Phase 3 sync).
- **Crash-safe writes:** write to a temp file in the same folder, flush to disk, then rename over the old file.
- **Trash:** deleted items are flagged `trashed_at` and purged after 30 days (or on "Empty trash").
- **Format version:** the app opens vaults of its own version or older (upgrading them), and refuses newer ones with
  "Update Lockbox to open this vault."
- **Search index:** built in memory on unlock from decrypted items; never written to disk.
- **Backup file:** a single `.lockbox-backup` file — a zip (no extra compression) of the vault folder, minus `.lock`.
  Its contents are already encrypted, so the backup is as safe as the vault. **Restore** unpacks it as a vault folder
  and verifies it by unlocking with the vault password. The vault ID is kept (items are bound to it), so if a vault
  with the same ID already exists, the user chooses: replace it (the current folder is kept aside as
  `<folder>.before-restore`) or cancel.

## 7. Screens

| Screen | Contents |
|---|---|
| First run | Create first vault: name, password with strength meter, then the recovery key. Must confirm it's saved (print / save as PDF / checkbox) before continuing. |
| Lock screen | List of vaults (from `vault.json` names); pick one, enter its password. Vaults unlock independently. "Forgot password?" link. |
| Main window | Three columns: sidebar (vaults → collections, trash) · item list (filter, sort) · item details (copy/reveal buttons, attached files, Open / Save a copy). |
| Ctrl+K | Search across unlocked vaults; actions: copy password, copy username, new item, lock all. |
| Generator | Pop-out beside password fields, plus a standalone screen. |
| Settings | Auto-lock idle time (default 5 min; always on Windows lock/sleep), clipboard clear delay (default 30 s), theme (light/dark/system), backup. |
| Backup / restore | Export a vault to one backup file; restore it as a vault (requires its password to open). |
| Forgot password | Enter recovery key → set a new password. |

**Opening files:**
- **Save a copy:** user picks the destination; decrypted copy written there.
- **Open:** decrypts into a private Lockbox temp folder under `%LOCALAPPDATA%\Lockbox\open\`, opened with the default
  app; the folder is wiped when the vault locks, the app closes, or on next launch after a crash.

**Clipboard:** copied secrets are marked so **Windows clipboard history (Win+V) and cloud clipboard don't keep them**
(the Windows "exclude from clipboard history/monitoring" formats, set from the desktop shell). After the delay, the
clipboard is cleared only if it still holds what Lockbox put there.

**Visual design** (colours, type, polish) is decided at the start of the UI work with Ariel's `design-bakeoff` skill:
clickable mockups, approved before screens are built.

## 8. Error handling

| Situation | Behaviour |
|---|---|
| Wrong password | "Wrong password." No lockout (see section 5 limits). |
| Damaged/tampered item | That item shows as damaged and is refused; the rest of the vault works; offer restore from backup. |
| Damaged `vault.json` | Fall back to `vault.json.bak`; if both fail, prompt to restore from backup. |
| Disk full / crash during save | Old version remains (crash-safe writes); clear error shown. |
| Interrupted file import | Partial chunks deleted; the item is only created after the last chunk is written. |
| Second app instance | Single-instance app focuses the existing window; `.lock` prevents two writers on one vault. |
| Vault on unplugged drive | Shown as "unavailable", never treated as deleted. |
| Newer vault format | Refused with "Update Lockbox". |
| Crash while unlocked | Secrets vanish with process memory; temp "Open" folder wiped on next launch. |

**Rule:** no password, key, or item content ever appears in an error message or log.

## 9. Testing and quality

- **Test-first** for every piece of the core and shell.
- **Core:** round-trips; wrong password; single-byte tamper → refused; chunk reorder/removal/truncation → refused;
  password change; recovery; format-version refusal; crash-safe write (simulated failure mid-save); trash purge.
- **Known-answer tests** against published Argon2id and XChaCha20-Poly1305 test vectors.
- **Property tests** (`proptest`): random data round-trips; malformed vault/item files never panic or leak data.
- **Large files:** chunk-boundary cases in CI; a multi-hundred-MB local test.
- **UI:** component tests (Vitest); end-to-end tests on the real app (WebdriverIO + `tauri-driver` on Windows): create
  vault → unlock → add item → copy → auto-lock.
- **Every bug gets a regression test.**

## 10. Workflow, repo and tooling

- **Change flow:** branch → tests + security scan → pull request → CI → `/greploop` (Greptile) → Ariel approves → merge.
  Nothing is pushed to `main` or released without Ariel's go. Commits under Ariel's GitHub account, no AI co-author.
- **CI (GitHub Actions, `windows-latest`):** `cargo fmt --check`, `cargo clippy -D warnings`, `cargo test`, frontend lint +
  tests + build, Tauri build, and the security scan.
- **Security scan:** our own `scripts/scan.mjs` running gitleaks (secrets), semgrep (risky code) and osv-scanner
  (vulnerable dependencies), with a single pass/fail result. Calls semgrep by full path (see `docs/SETUP.md`).
- **Repo docs:** `README.md`, `SECURITY.md` (what's protected, what isn't, how to report a vulnerability), `docs/SETUP.md`
  (setup runbook), `TRACKER.md`, `LICENSE`.
- **License:** MIT. Apply for Greptile's free open-source plan once the repo is public.
- **Third-party skills and tools stay on the dev machine**, never committed (some have no redistribution license).

## 11. Open questions

None. Visual design is intentionally deferred to the UI stage (section 7).
