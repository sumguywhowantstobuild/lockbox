# Lockbox

Lockbox is a password manager and encrypted file vault for Windows that keeps everything on your own PC: no server, no
cloud. Besides passwords and notes, it is meant to store real files such as client contracts, design files and project
archives, grouped by client or project. It is an open-source portfolio project, aiming for production standards: tested,
documented and honest about its limits.

> **Status: work in progress. Not independently audited. Don't store real passwords in it yet.**
>
> No independent security expert has audited Lockbox's code or its encryption, and none is planned.
> There is no app to install yet (see below), and no release.

## What exists today

Only the first two of five planned stages are built, and there is nothing to run yet. Together the five plans make up Phase
1, the Windows app (see the [phases](docs/PRD.md#phases)).

| Plan | What it delivers | State |
|---|---|---|
| 1 | **Core engine:** a library written in Rust (the programming language), `crates/lockbox-core`, that does all the encryption and file handling | Built |
| 2 | Backup, restore, and opening a backup read-only, all in the same core library | Built (not yet reviewed in a pull request) |
| 3 | Desktop shell (built with Tauri, a toolkit for desktop apps): sessions, auto-lock, clipboard, dialogs, "Open" and "Save a copy" | Not started |
| 4 | The user interface (clickable design mockups first) | Not started |
| 5 | Release: installer, final README, and the written walk-through of SECURITY.md against the code | Not started |

The core can already create and unlock vaults (with the password, or with the recovery key: a long code shown once that
opens the vault if you forget the password), change the password, make a new recovery key, keep logins, notes, files and
collections as encrypted items, store files in encrypted chunks (the limit is 256 GiB; the largest file tested is just
over 4 GiB), tidy up after a crash, search items in memory and generate passwords and passphrases. It can also write
an encrypted backup of a vault (one file, with a list of its contents that is checked on the way back), test a backup
without restoring it, restore one (into a hidden folder first, with a record that lets a crash be finished or undone;
the vault it replaces is kept as a `.before-restore` folder), open a backup or a `.before-restore` folder read-only,
and copy single items out of it. It has no screens.

## Build and test

You need Windows (developed on Windows 11; the code also builds on Linux, where CI, the automatic checks GitHub runs,
tests the non-Windows file code), Git, and Rust. The security scan and its self-tests also need Node.js. On Windows,
Rust also needs Microsoft's C++ linker: Visual Studio 2022 Build Tools with "Desktop development with C++". Setup
details and troubleshooting are in [docs/SETUP.md](docs/SETUP.md).

```
rustup toolchain install     # installs the Rust version this project pins (1.99.1), from rust-toolchain.toml
cargo test --locked          # most tests; it runs real password hashing, so allow a minute or two
cargo test -p lockbox-core --locked --features test-internals   # every engine test, the internal ones too
```

The same checks that CI runs on every push:

```
cargo fmt --all --check
cargo clippy --locked --all-targets -- -D warnings
cargo clippy -p lockbox-core --locked --all-targets --features test-internals -- -D warnings
cargo test --locked
cargo test -p lockbox-core --locked --features test-internals
node --test "scripts/*.test.mjs"   # the scanner's own tests (needs Node.js)
node scripts/scan.mjs        # security scan; needs gitleaks, semgrep and osv-scanner, see docs/SETUP.md
```

Three checks are slow, so they only run when asked (always in release mode, the fast optimised build):

```
# 5 000 items: unlock and search must stay fast
cargo test --release --locked -p lockbox-core --test search -- --ignored --nocapture
# a file of 4 GiB + 1 byte goes in and out unchanged while memory stays flat
cargo test --release --locked -p lockbox-core --features test-internals --test large_file -- --ignored --nocapture
# the same file goes through backup, test, restore and export, and comes out unchanged
cargo test --release --locked -p lockbox-core --features test-internals --test backup_large -- --ignored --nocapture
```

The large-file check writes about 12 GiB of temporary files and can take minutes. The backup check needs about 9 GiB
of free disk space at its peak (it deletes what it no longer needs as it goes) and took about a minute on a fast SSD.
Their memory limits are only checked on Windows.

## Before you trust it

- Read [SECURITY.md](SECURITY.md): what Lockbox protects against, what it doesn't, and every known limit. It also says
  how to report a vulnerability privately.
- Use full-disk encryption (BitLocker on Windows Pro and above; "Device encryption" on supported Home PCs). Windows may
  copy secrets to the pagefile (memory it parks on disk), the hibernation file and crash dumps (memory copies saved when
  a program crashes), and Lockbox cannot control that.
- The design asks for five things before a release counts as "reviewed": passing tests in CI, a clean security scan,
  every change reviewed in a pull request, a written walk-through of `SECURITY.md` against the code signed off before
  each release, and this README stating plainly that the code is not independently audited. Today the tests and the scan
  run on every push and this statement is made. Plan 1 was reviewed in a pull request (by Greptile, an automated code
  reviewer, plus separate review passes) before the code was published, and the walk-through will happen when there
  is a release. See the [design spec](docs/design/2026-10-07-lockbox-design.md#what-reviewed-means-for-lockbox).

## Documents

| Document | What it is |
|---|---|
| [docs/PRD.md](docs/PRD.md) | What Lockbox is for: users, features, user stories, how success is measured |
| [ARCHITECTURE.md](ARCHITECTURE.md) | How the built core is organised, how data flows, and the rules the code keeps |
| [SECURITY.md](SECURITY.md) | Threat model, the encryption used, honest limits, how to report a vulnerability |
| [Design spec](docs/design/2026-10-07-lockbox-design.md) | The full technical design: cryptography, file formats, error handling, tests |
| [docs/SETUP.md](docs/SETUP.md) | Tools and setup steps, with troubleshooting |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Rules for anyone changing the code, and the checks to run before pushing |

## Licence

Lockbox is released under the MIT licence; see [LICENSE](LICENSE). The password generator's word list comes from the
Electronic Frontier Foundation under a Creative Commons licence; credit and details are in
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
