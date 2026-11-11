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
- **Someone who builds software or automations** and keeps API keys, bot tokens and integration keys from `.env` files,
  grouped by project, and wants to save one the moment a website shows it.
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

**Who the screens are for.** They are designed for strangers who download Lockbox, not only for Ariel (Ariel,
2026-11-04). When downloads happen, in v1 or in Phase 2, is still open, and with it the installer's signing and updates.

## Scope

### v1 features
- **Vaults**, each with its own password; unlocking one doesn't unlock the others. Create another, switch between them,
  lock one or all, rename one, remove one from the list (its data stays on disk), and show one in Explorer.
- **Folders** inside a vault, one per client or project: create, rename, delete. (The engine and spec call them
  collections; people only ever see "folder".) Deleting a folder sends its items to the trash, and restoring it brings
  back the items that went with it.
- **Items:** Login, Key, Secure note, File. Logins, keys and notes can have files attached. **Maximum file size: 256 GiB.**
  Every item can be edited, moved to a folder or out of one, and sent to the trash.
- **Trash:** a deleted item can be restored. Nothing is removed for good unless the user asks, and items there for 30
  days or more are offered for deletion.
- **Logins:** username, password and website. A website typed without `https://` gets it on save, and can be opened from
  Lockbox. Each login keeps its last few passwords, encrypted, for when a website rejects a change.
- **Keys:** an environment-variable name (such as `OPENAI_API_KEY`) and a value protected like a password: hidden until
  revealed, copied with the same clipboard clearing, and the value left out of search.
- **Files:** pick one or many at once, with real progress and a Cancel button. Adding says the original is still
  unprotected on disk. Open, Save a copy and Replace file on each. All of a folder's files can be saved out together to
  one place, with one progress bar and a Stop button, and an existing file is never overwritten.
- **Save from the clipboard:** a Windows-wide keyboard shortcut brings Lockbox forward with a save box holding what was
  just copied, hidden. It reads the clipboard only when the shortcut is pressed, and again if asked to clear it, to check
  it still holds the same value. It asks for the vault's password first if the vault is locked. Saving offers to clear the
  clipboard.
- **`.env` in and out:** paste a whole `.env` to save one key per line; copy all of a project's keys in `.env` form, or
  save them as a `.env` file, with a warning that the saved file is not encrypted.
- **Tray:** closing the window locks every vault and leaves Lockbox in the system tray so the shortcut keeps working.
  Quit is in the tray menu.
- **Password generator:** length, character sets, passphrase mode; beside a password field or on its own, with a vault
  unlocked.
- **Auto-lock** after idle time and when Windows locks, sleeps or hibernates; **clipboard clearing** after copying.
- **Quick search** with Ctrl+K or Ctrl+F across unlocked vaults, with quick actions. It also finds attached files by
  name and can open one.
- **Recovery key** per vault, shown once at creation; **Regenerate recovery key**. Each can be printed or saved as a PDF,
  and three of its words are picked to continue. If that step never finished, the next unlock says so and makes a new
  key.
- **Change password** (with the warning in spec 5.3). Changing the password, making a new recovery key, and export each
  ask for the current password first.
- **Encrypted backup and restore** of a vault, with real progress and a Cancel button, and a choice of backup that stays
  while retrying its password. A finished restore waits for an answer through an idle lock.
- **Backup reminder:** every 30 days since a vault's last backup, or since it was created if it has none, with a "later"
  button.
- **Test a backup** without restoring it.
- **Open a backup read-only**, to browse it or copy single items out.
- **Older copies:** a restore keeps the vault it replaced. The copies are listed; each can be opened read-only or deleted.
- **Add existing vault folder** (e.g. after moving a vault).
- **Move to a new computer:** the first screen offers "I already have a vault or a backup", and takes the person through
  each vault.
- **Export:** logins, keys and notes to a file other apps can read. Asks for the password, and warns that the file isn't
  protected. Earlier passwords and stored files are left out. (In this document "backup" is always the encrypted one and
  "export" always this readable one.)
- **Settings:** auto-lock time, clipboard time, save shortcut, light or dark, Start with Windows (off unless turned on,
  and it starts locked), staying out of screen capture, the app version.
- **Staying out of screen capture:** covers screenshots, recordings, screen sharing and Windows Recall, with a setting to
  turn it on or off. It's on by default unless testing on a real PC shows it blanks Magnifier, Quick Assist or remote
  desktop; then it's off by default. Microsoft says this isn't a guarantee, so the wording says so.
- **Asking first:** a warning before a file with an unencrypted result goes to a cloud-synced folder (an export, a saved
  `.env`, a recovery key PDF, all of a folder's files), and a question before closing or quitting during a long job.
- **Help:** a Help link, a short "what to do first" on an empty vault, and a short guide on the landing page covering
  getting started, moving in, backups and what Lockbox doesn't protect against.
- **For everyone:** every screen works fully by keyboard and with a screen reader, in Windows high contrast, and in a
  small laptop's window (1093×534).

### v1.1 (next, after v1)
Rotate vault key (re-encrypt everything) · password health check · built-in 2FA codes (TOTP) · Windows Hello unlock ·
delete a vault from inside Lockbox (in v1: remove it from the list, show it in Explorer, and delete the folder by hand) ·
the password generator with every vault locked (in v1: unlock a vault first).

### Not in v1
Browser autofill extension · a browser extension for saving keys · feeding keys directly into running programs · key
expiry reminders · sync · mobile · sharing between people · importing from other password managers · vaults on removable
drives · a Windows-wide shortcut to search · adding a whole folder with its structure · moving an item from one vault
to another · a button to check a recovery key still works · a warning before auto-lock (a half-typed item is lost, and
nothing saved is).

## User stories

Each story is one thing a person can do with a v1 feature. Engineering detail lives in the spec.

1. **Create a vault.** As a new user, I want to create a vault with its own password and be shown a recovery key once,
   so that I can still get back in if I forget the password. (Vaults, recovery key)
2. **Keep vaults apart.** As a user with more than one vault, I want each vault to have its own password, so that
   unlocking one does not open the others. (Vaults)
3. **Organise by client or project.** As a user who works for clients, I want folders inside a vault, one per client or
   project, holding logins, keys, secure notes and files, so that everything for one client sits together. (Folders,
   items)
4. **Store real files.** As a user, I want to attach files to a login or note, or store a file on its own, up to 256
   GiB, so that contracts and project archives live next to the passwords for the same client. (Items, files)
5. **Generate a password.** As a user, I want to generate a password by length and character set, or a passphrase, so
   that I do not have to invent one. (Password generator)
6. **Find things fast.** As a user with many items, I want Ctrl+K or Ctrl+F to search across my unlocked vaults and offer
   quick actions (copy password, copy username, copy key, open a file, new item, lock all), so that I reach an item
   without browsing. (Quick search)
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
11. **Keep a project's keys together.** As someone who builds software, I want to keep each project's API keys under
    their environment-variable names, hidden until I reveal or copy them, so that they are not sitting in plain text
    files. (Keys)
12. **Save a key the moment I copy it.** As a user who just copied a key from a website, I want to press a shortcut and
    save it to a project without opening Lockbox first, so that it does not get lost or left on the clipboard. (Save
    from the clipboard, tray)
13. **Move a whole `.env`.** As a user setting a project up, I want to paste a whole `.env` in and get all of its keys
    back in the same form, so that I do not handle them one by one. (`.env` in and out)
14. **Change my mind.** As a user who deleted the wrong thing, I want it in the trash with everything that went with it,
    so that I can get it back. (Trash, folders)
15. **Survive a website's password change.** As a user changing a website's password, I want the old one kept on the
    login, so that I am not locked out if the website rejected the change. (Logins)
16. **Change computers.** As a user with a new PC, I want to be taken from a backup or a copied folder to an unlocked
    vault, one vault at a time, so that I do not have to work out the order. (Move to a new computer)
17. **Be reminded to back up.** As a user who forgets, I want Lockbox to tell me when a vault has gone 30 days without a
    backup, so that one bad day does not cost me a month. (Backup reminder)
18. **Leave.** As a user moving to another password manager, I want my logins, keys and notes in a file it can read, and
    to be told plainly that the file isn't protected, so that I am never trapped. (Export)
19. **Use it my way.** As a user who works by keyboard, with a screen reader, in high contrast, or on a small laptop, I
    want every screen to work for me, so that Lockbox is not only for people with big screens and a mouse. (For everyone)

## Success measures

Where the design spec states a number, it is used as written. Numbers marked "Plan 1" were set while building the core
engine (Plan 1), not in the spec. Plan 3 is the desktop shell, and Plan 4 the UI, in three parts: 4A daily use, 4B files
and long jobs, 4C the rest (see the [README](../README.md#what-exists-today)).

| Measure | Target | Where it comes from | How it is checked |
|---|---|---|---|
| Opening a big vault | 5 000 items: unlock under 3 s (not counting the roughly 1 s password check), search under 50 ms, release build | Plan 1 | `five_thousand_items_fast` (run on purpose, see the [README](../README.md#build-and-test)) (the engine's own unlock and search). Measured on the real screens in the release build (4A Task 21, 2026-11-11, a vault of 5 000 made-up items), which add the bridge and drawing to the engine's times: unlock to the list drawn 1.1 to 1.2 s with the password check; search, from typing to the result drawn, 26 to 60 ms; a filter keystroke or a change of kind 10 to 60 ms; clearing the filter or sorting by name, which draw every row again, about 250 ms |
| Big files | A file of 4 GiB + 1 byte goes in and comes out with the same SHA-256 (a fingerprint of its contents), and memory stays flat (peak under 200 MB) | [Scope](#scope) (256 GiB limit) and spec 9 (a multi-GB local test before release); the 4 GiB size and 200 MB limit are from Plan 1 | `large_file_round_trip_4_gib` and `backup_restore_over_4_gib` (both run on purpose) |
| Cost of guessing a password | Each guess costs one Argon2id run (a deliberately slow password-to-key step) of at least 64 MiB, 3 iterations, parallelism 4, calibrated to about 1 s | Spec R3 and 5.2 | Unit tests on the settings and their bounds |
| Typos in the recovery key | A word whose first four letters match no word in the list is always caught (a slip after the fourth letter still reads as the intended word), and a wrong but listed word about 255 times in 256, before any unlock attempt | Spec 5.2 | Tests in the core's recovery module (at least 250 in 256) |
| Auto-lock and clipboard defaults | Lock after 5 minutes idle; clear the clipboard after 30 seconds | [Screens](#screens) (Settings) | `settings_bounds_table` (the defaults and their limits), `locks_after_idle_setting` and `clears_after_delay_when_still_ours` (Plan 3) |
| Backups of any size | An archive over 4 GiB backs up and restores (ZIP64 is the zip format for archives that big) | Spec 9 | `backup_restore_over_4_gib` (run on purpose): a 4 GiB + 1 byte file through backup, test, restore and export; the other backup and restore tests are in the core (Plan 2) |
| Every screen, for everyone | Works by keyboard alone and with a screen reader; no automated accessibility failures; usable in Windows high contrast; nothing cut off in a 1093×534 window | [Scope](#scope) (For everyone) | Automated accessibility checks on every screen in CI; a written walk-through with NVDA (a free screen reader) and in high contrast before each release |
| Sign-in in few clicks | From an unlocked vault: search, pick the login, copy username, copy password, in six keys or clicks or fewer | Task steps, Plan 4 design | End-to-end test on the real app |
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
| First run | Create a first vault, or "I already have a vault or a backup". Name and password, then the recovery key: print it or save it as a PDF, then pick three of its words to continue. Then an empty vault with "what to do first". |
| Lock screen | Known vaults (from the registry and `vault.json` names); pick one, enter its password. Vaults unlock independently. "Forgot password?", "Restore a backup" and "Add existing vault folder". |
| Main window | A side menu that closes to icons (vault strip from two vaults, search, All items, folders, Generator, Trash, Lock all) · item list (show one kind, sort) with one Add button always in the same place · item details in a side panel (copy/reveal, attached files: Open / Save a copy / Replace file) · a folder's `.env` in and out · leftover files (the spec's orphaned files) when any are found. Read-only vaults labelled. |
| Save box | Opened by the shortcut, in the main window: the copied value hidden, the vault, the name, the folder, Save. A pasted `.env` shows one row per key. |
| Search | Ctrl+K or Ctrl+F. Across unlocked vaults; actions: copy password, copy username, copy key, open a file, new item, lock all. |
| Generator | Pop-out beside password fields, plus a standalone screen. |
| Settings | Auto-lock idle time (default 5 min), clipboard clear delay (default 30 s), save shortcut, theme, Start with Windows, screen capture, app version. Under each vault's name: backup, test a backup, open a backup, older copies, change password, new recovery key, export. |
| Backup / restore | Back up a vault; restore it (spec 6.8); open a backup read-only (spec 6.9). Restore runs in full-screen steps, since it starts from places with no main window. |
| Forgot password | Enter recovery key → set a new password → offered a fresh backup. |
| Moments the app has to ask | Each with its own message and buttons: see the [Plan 4 design](design/2026-11-05-user-interface-design.md). |

**Visual design** (colours, type, polish) is in the [Plan 4 design](design/2026-11-05-user-interface-design.md), decided
through clickable mockups approved before screens are built. The lock screen says "Your items stay encrypted until you
enter the password."
