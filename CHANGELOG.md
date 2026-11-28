# Changelog

All notable changes to Petalock are written here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and Petalock uses [Semantic Versioning](https://semver.org/).

Release candidates are plain versions (0.1.1, 0.1.2 and so on), each published as a GitHub pre-release. The first
candidate that passes its walk-through is promoted to the release unchanged: the same file, never rebuilt. When that
happens, "Unreleased" below takes the release's version and date. How a release is made is in
[RELEASING.md](RELEASING.md), and each release's evidence is in its record in [docs/releases/](docs/releases/).

## [Unreleased]

The first public preview of Petalock, version 0.1: a password manager and encrypted file vault for Windows that keeps
everything on your own PC. It is unsigned and has not been independently audited. Don't store real passwords in it yet.

### Added

- **Vaults:** create one with a password and a recovery key (24 words, shown once); keep several, each with its own
  password, open them side by side and switch between them; rename one, remove it from the list and add it back, and
  show its folder in Explorer.
- **Items:** logins, keys (such as `OPENAI_API_KEY`), notes and files, in folders; search with Ctrl+K or Ctrl+F; reveal
  and copy, with the clipboard cleared after 30 seconds and kept out of Windows clipboard history; trash and restore,
  and emptying the trash.
- **Files:** add one or many at once, open, save a copy, replace, and save all of a folder's files, each with progress and
  a Stop or Cancel. Files up to 256 GiB.
- **`.env` in and out:** paste a whole `.env` to save one key per line, and copy or save a folder's keys as a `.env`.
- **A save shortcut** that brings Petalock forward with what you just copied, ready to save as a key.
- **Backups:** back up a vault to one encrypted file, test a backup, restore one (the vault it replaces is kept as an
  older copy), open a backup read-only, and move vaults to a new PC.
- **Passwords:** change a vault's password, get back in with the recovery key, make a new recovery key; a password and
  passphrase generator.
- **Export** of logins, keys and notes to a CSV file another password manager imports, with a warning that the file isn't
  protected.
- **Locking:** after 5 minutes with no keyboard or mouse use (you can change this), when Windows locks or sleeps, when the
  window closes, and when a vault's drive goes away.
- **Staying out of screen capture:** Petalock asks Windows to leave its window out of screenshots, recordings, screen
  sharing and Recall. Windows doesn't guarantee it.
- **Start with Windows**, off unless you turn it on; Petalock then starts in the tray with every vault locked.
- **An installer** for your own Windows account, with no administrator rights: one screen, the folder under Options, and
  Petalock opens when it finishes. It writes only its program folder, its uninstall entry and its shortcuts.
- **Upgrades** by installing the new version over the old one: vaults, settings and "start with Windows" stay as they are.
- **Uninstalling** from Windows Settings removes the program and the temporary copies of opened files. It never removes a
  vault, the list of vaults or Petalock's settings, and its last page says where the vaults stayed.
- **The open-source licence texts** of every library and font the installer ships, inside the installer.
- **A download page and guide** at petalock.arielmaningas.com, with the file's fingerprint and how to check it. Help in
  the app opens the guide.
- **Releases** built by GitHub only from a protected tag on `main` after every CI job passed, with a signed build record
  (GitHub artifact attestation) and a SHA-256 file for each installer.

### Not in this preview

Code signing, automatic updates or an update notice, package managers (winget and others), ARM64, and Windows 10 testing.
Deleting a vault from inside Petalock (remove it from the list, then delete its folder by hand; the guide shows how).

### Known limits

Every known limit, with the reason it is accepted, is in [SECURITY.md](SECURITY.md#honest-limits).

[Unreleased]: https://github.com/sumguywhowantstobuild/petalock/commits/main
