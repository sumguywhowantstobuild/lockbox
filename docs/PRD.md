# Lockbox — Product Requirements

This is the product side of Lockbox: who it is for, what it does, and how we will know it works. The purpose, phases,
scope and screens below were moved here from the [design spec](design/2026-10-07-lockbox-design.md); the spec
keeps the engineering side (architecture, cryptography, file formats, error handling, tests). Numbers such as 5.3 or R3
refer to sections and requirements of that spec.

## Purpose

Lockbox is a local-only password manager and encrypted file vault for Windows, with no server. Besides passwords and
notes, it stores real files (client contracts, design files, project archives), grouped by client or project. Its
differentiators are a better UI and file storage organised by client/project.

It is a public, open-source portfolio project. It must be production quality: tested, reviewed, documented, and honest
about its limits.

## Target users

- **A privacy-minded individual on Windows** who wants to keep passwords and notes on their own PC: no cloud, no
  server, nobody else holding the data.
- **Someone who also keeps real files next to their logins**, such as client contracts, design files or project
  archives, and wants them grouped by client or project instead of in one flat list.
- **Anyone judging the project** (it is an open-source portfolio piece): they should find clear documents, tests and an
  honest account of what Lockbox does not protect against.

Not for v1: people who need browser autofill, sync between devices, a phone app, sharing between people, or import from
other password managers (see "Not in v1" under [Scope](#scope)).

## Phases

| Phase | Ships | Design choice made now |
|---|---|---|
| **1 (v1)** | Windows app for Ariel | Rust core is a separate library with no Windows or Tauri code\* |
| 2 | Share with friends: download website, code-signed installer, auto-updates | Vault format is versioned; app refuses vaults newer than itself |
| 3 | Android app + sync between devices without a server | Vault = folder of small independent files, a reasonable base for sync |

\* The core has one small Windows-only file-system module (`fsio/windows.rs`) behind a platform switch, with a portable
fallback (`fsio/portable.rs`); it has no Tauri code.

**Sync is a future protocol design, not a v1 property.** Revision numbers alone do not resolve concurrent edits,
deletion conflicts, partially copied files, or two devices changing the password. Phase 3 needs its own spec covering
conflict handling, deletion tombstones and an authenticated manifest; the container version (spec 6.1) is the upgrade
path.

## Scope

### v1 features
- **Vaults**, each with its own password; unlocking one doesn't unlock the others.
- **Collections** inside a vault, one per client or project.
- **Items:** Login, Secure note, File. Logins and notes can have files attached. **Maximum file size: 256 GiB.**
- **Password generator:** length, character sets, passphrase mode.
- **Auto-lock** after idle time and when Windows locks, sleeps or hibernates; **clipboard clearing** after copying.
- **Ctrl+K quick search** across unlocked vaults, with quick actions.
- **Recovery key** per vault, shown once at creation; **Regenerate recovery key**.
- **Change password** (with the warning in spec 5.3).
- **Encrypted backup and restore** of a vault.
- **Test a backup** without restoring it.
- **Open a backup (or a pre-restore copy) read-only**, to browse it or copy single items out.
- **Add existing vault folder** (e.g. after moving a vault).

### v1.1 (next, after v1)
Rotate vault key (re-encrypt everything) · password health check · built-in 2FA codes (TOTP) · Windows Hello unlock.

### Not in v1
Browser autofill extension · sync · mobile · sharing between people · importing from other password managers ·
vaults on removable drives.

## User stories

Each story is one thing a person can do with a v1 feature. Engineering detail lives in the spec.

1. **Create a vault.** As a new user, I want to create a vault with its own password and be shown a recovery key once,
   so that I can still get back in if I forget the password. (Vaults, recovery key)
2. **Keep vaults apart.** As a user with more than one vault, I want each vault to have its own password, so that
   unlocking one does not open the others. (Vaults)
3. **Organise by client or project.** As a user who works for clients, I want collections inside a vault, one per
   client or project, holding logins, secure notes and files, so that everything for one client sits together.
   (Collections, items)
4. **Store real files.** As a user, I want to attach files to a login or note, or store a file on its own, up to 256
   GiB, so that contracts and project archives live next to the passwords for the same client. (Items, files)
5. **Generate a password.** As a user, I want to generate a password by length and character set, or a passphrase, so
   that I do not have to invent one. (Password generator)
6. **Find things fast.** As a user with many items, I want Ctrl+K to search across my unlocked vaults and offer quick
   actions (copy password, copy username, new item, lock all), so that I reach an item without browsing. (Quick search)
7. **Stay safe when I walk away.** As a user, I want Lockbox to lock after idle time and when Windows locks, sleeps or
   hibernates, and to clear the clipboard after I copy a secret, so that a forgotten session does not leave my data
   open. (Auto-lock, clipboard clearing)
8. **Recover and change access.** As a user, I want to change my password, set a new one with my recovery key if I
   forget it, and regenerate the recovery key, so that I stay in control of how my vault opens. I want to be told
   plainly what a password change does not do (spec 5.3). (Change password, recovery key, regenerate)
9. **Back up and restore.** As a user, I want an encrypted backup of a vault, to restore it later, and to open a backup
   read-only to browse it or copy single items out, so that one bad day does not cost me my data. (Backup and restore,
   read-only open)
10. **Move a vault.** As a user who moved a vault folder, I want to add it back to Lockbox, so that I do not have to
    recreate it. (Add existing vault folder)

## Success measures

Where the design spec states a number, it is used as written. Numbers marked "Plan 1" were set while building the core
engine (Plan 1), not in the spec. Plans 3 and 4 are the desktop shell and the UI (see the
[README](../README.md#what-exists-today)).

| Measure | Target | Where it comes from | How it is checked |
|---|---|---|---|
| Opening a big vault | 5 000 items: unlock under 3 s (not counting the roughly 1 s password check), search under 50 ms, release build | Plan 1 | `five_thousand_items_fast` (run on purpose, see the [README](../README.md#build-and-test)) |
| Big files | A file of 4 GiB + 1 byte goes in and comes out with the same SHA-256 (a fingerprint of its contents), and memory stays flat (peak under 200 MB) | [Scope](#scope) (256 GiB limit) and spec 9 (a multi-GB local test before release); the 4 GiB size and 200 MB limit are from Plan 1 | `large_file_round_trip_4_gib` and `backup_restore_over_4_gib` (both run on purpose) |
| Cost of guessing a password | Each guess costs one Argon2id run (a deliberately slow password-to-key step) of at least 64 MiB, 3 iterations, parallelism 4, calibrated to about 1 s | Spec R3 and 5.2 | Unit tests on the settings and their bounds |
| Typos in the recovery key | A mistyped recovery key is caught about 15 times in 16, before any unlock attempt | Spec 5.2 | Test in the core's recovery module (it requires at least 14 in 16) |
| Auto-lock and clipboard defaults | Lock after 5 minutes idle; clear the clipboard after 30 seconds | [Screens](#screens) (Settings) | Desktop app tests (Plan 3) |
| Backups of any size | An archive over 4 GiB backs up and restores (ZIP64 is the zip format for archives that big) | Spec 9 | `backup_restore_over_4_gib` (run on purpose): a 4 GiB + 1 byte file through backup, test, restore and export; the other backup and restore tests are in the core (Plan 2) |
| "Reviewed" release | All five review conditions hold, and each of R1–R7 is walked through against `SECURITY.md` before a release | [Spec 1](design/2026-10-07-lockbox-design.md#what-reviewed-means-for-lockbox) | Written sign-off by Ariel before each release |
| v1 done | Every v1 feature works on Windows and the five review conditions hold | Spec 1 | All of the above |

## Security and review requirements

The security requirements R1–R7 and the definition of a "reviewed" release stay in the spec, because the code and the
reviews cite them by number:

- [Security requirements (v1)](design/2026-10-07-lockbox-design.md#security-requirements-v1)
- [What "reviewed" means for Lockbox](design/2026-10-07-lockbox-design.md#what-reviewed-means-for-lockbox)

## Screens

| Screen | Contents |
|---|---|
| First run | Create first vault: name, password with strength meter, then the recovery key. Must confirm it's saved (print / save as PDF / checkbox) before continuing. |
| Lock screen | Known vaults (from the registry and `vault.json` names); pick one, enter its password. Vaults unlock independently. "Forgot password?" and "Add existing vault folder". |
| Main window | Three columns: sidebar (vaults → collections, trash, orphaned files) · item list (filter, sort) · item details (copy/reveal, attached files: Open / Save a copy / Replace file). Read-only vaults labelled. |
| Ctrl+K | Search across unlocked vaults; actions: copy password, copy username, new item, lock all. |
| Generator | Pop-out beside password fields, plus a standalone screen. |
| Settings | Auto-lock idle time (default 5 min), clipboard clear delay (default 30 s), theme, backup, change password, regenerate recovery key. |
| Backup / restore | Export a vault; restore it (spec 6.8); open a backup read-only (spec 6.9). |
| Forgot password | Enter recovery key → set a new password. |

**Visual design** (colours, type, polish) is decided at the start of the UI work: clickable mockups, approved before
screens are built.
