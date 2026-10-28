# Development setup

Every tool needed to build and check Lockbox, the version used and one line on why.
Never passwords or keys here, only where they're kept.

## Dev machine (Windows 11)

### Base tools
| Tool | Version | Used for |
|---|---|---|
| Git | 2.41.0 | Version control |
| Node.js | 24.22.1 (Active LTS, pinned in `ui/.node-version`) | The UI's build tools (Vite, TypeScript, ESLint, Vitest) and the scan scripts |
| GitHub CLI (`gh`) | — | Pull requests and CI status |
| Python | 3.11.4 | Runs semgrep |

### Security tools
| Tool | Version | How | Why |
|---|---|---|---|
| gitleaks | 8.30.1 | `winget install --id Gitleaks.Gitleaks --source winget` | Finds passwords/keys accidentally committed to git |
| osv-scanner | 2.7.0 | `winget install --id Google.OSVScanner --source winget` (`winget upgrade` to update) | Flags dependencies with known vulnerabilities |
| semgrep | 1.179.0 | `python -m pip install --user semgrep` | Spots risky code patterns |
| opensrc | 0.7.3 | `npm install -g opensrc@0.7.3` | Fetches a library's published source, to read before using its API |

### Rust toolchain
| Tool | Version | How | Why |
|---|---|---|---|
| Visual Studio 2022 Build Tools, "Desktop development with C++" | 17.14 · Windows SDK 10.0.26100 | `winget install --id Microsoft.VisualStudio.2022.BuildTools --override "--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"` (accept the licence) | Rust on Windows needs Microsoft's C++ linker |
| rustup | 1.29.1 | `winget install --id Rustlang.Rustup` | Installs and switches Rust versions |
| Rust | 1.99.1 + rustfmt, clippy | `rustup toolchain install 1.99.1 --profile minimal --component rustfmt,clippy` | The language of the Lockbox core; pinned so every machine builds the same |

Check: a test program builds and runs (`cargo new hello && cargo run`). `~/.cargo/bin` must be on the user PATH;
terminals opened before the install need restarting to see `cargo`.

### Desktop app (Tauri)
| Tool | Version | How | Why |
|---|---|---|---|
| Tauri CLI | 2.12.4 | `cargo install tauri-cli --version 2.12.4 --locked` | Runs the app against the Vite dev server (`cargo tauri dev`) |
| WebView2 Runtime | ships with Windows 11 | — | The web view the app's window draws its screens in |

- **UI dependencies:** `npm ci --ignore-scripts` in `ui/` (no package needs an install script) installs the exact versions in `ui/package-lock.json` (every version in
  `ui/package.json` is pinned, no `^`). Then `npm run lint`, `npm test`, `npm run build` (from the repo root:
  `npm --prefix ui run lint` and so on).
- **Run the app:** `cargo tauri dev` from `crates/lockbox-desktop`. It starts the Vite dev server on port 5173 (`npm
  run dev` in `ui/`, set in `tauri.conf.json` `build.beforeDevCommand`, whose `cwd` is relative to the folder holding
  `tauri.conf.json`) and opens the window on it. The port is fixed (`strictPort`): the window may only show the app's
  own origin and, in dev builds, `http://localhost:5173`.
- **Release configuration:** build the UI first (`npm --prefix ui run build`; the app embeds `ui/dist` at compile
  time), then `cargo build -p lockbox-desktop --release --locked --features custom-protocol`. The bridge tests that
  only exist in that configuration run with `cargo test -p lockbox-desktop --locked --features custom-protocol --test
  ipc`.
- Tauri writes generated schemas to `crates/lockbox-desktop/gen/` on every build; it is git-ignored.

## Workspace and CI
- `rust-toolchain.toml` pins Rust 1.99.1 (minimal profile, plus rustfmt and clippy); `cargo` in the repo picks it up
  automatically.
- Checks to run before every commit: `cargo fmt --all --check`, `cargo clippy --locked --all-targets -- -D warnings`,
  `cargo clippy -p lockbox-core --locked --all-targets --features test-internals -- -D warnings`,
  `cargo test --locked`, `cargo test -p lockbox-core --locked --features test-internals` (the engine's internal
  modules and the integration tests that build on them), and for the UI `npm --prefix ui run lint`,
  `npm --prefix ui test`, `npm --prefix ui run build`, then the release-configuration bridge tests above.
  `Cargo.lock` and `ui/package-lock.json` are committed so builds are repeatable.
- `.github/workflows/ci.yml` runs the same checks. It installs the pinned toolchain with
  `rustup toolchain install` (newer rustup no longer installs one on `rustup show`), and every GitHub Action is pinned
  to a commit SHA so a moved tag can't change what runs. Node comes from `ui/.node-version` (`actions/setup-node`).
- CI job `UI: lint, test, build` (`ubuntu-24.04`) runs the three UI checks. The Windows Rust job also builds the UI,
  runs the release-configuration bridge tests and makes a release build of the app (step `Tauri build`).

### Windows file code and the Linux CI run
- `crates/lockbox-core` depends on `windows-sys` 0.61 (Windows only) for safe file moves, disk-space and file-system
  checks. Its `unsafe` is confined to `src/fsio/windows.rs`; the rest of the crate denies `unsafe`.
- The CI Rust job is a matrix on pinned images (`windows-2025-vs2026`, `ubuntu-24.04`), so the non-Windows file
  code in `src/fsio/portable.rs` is compiled and tested too. Job names are `Rust: format, lint, test (windows)` and
  `Rust: format, lint, test (linux)`, fixed across image bumps; required-status-check rules on GitHub must match them.
  Bump an image by changing only its `os:` value in `.github/workflows/ci.yml`.
- The desktop app (`crates/lockbox-desktop`) is Windows-only, so the Linux run lints and tests
  `--workspace --exclude lockbox-desktop` (building it there would need WebKitGTK for nothing).

## Commit identity
Commits use GitHub's noreply address so no personal email is published:
`git config user.email <id>+<username>@users.noreply.github.com` (this repo only). Merges made on GitHub's website use
the account's email setting, so turn on "Keep my email addresses private" in GitHub's email settings too.

## Security scan
- Run `node scripts/scan.mjs` (add `--json` for machine-readable output). It runs three tools over the whole repo and
  writes their raw reports to `.scan/` (git-ignored): gitleaks (passwords/keys, run twice: over committed history, and
  over staged, unstaged and brand-new files, so it works before you commit), semgrep (risky code patterns) and osv-scanner (dependencies with known vulnerabilities, from `Cargo.lock` and
  `ui/package-lock.json`; a missing lockfile makes the scan INCOMPLETE, the UI's once `ui/package.json` exists).
- Result: exit `0` CLEAN, `1` FINDINGS (fix them), `2` INCOMPLETE (a tool is missing or failed, so it never says
  "clean" by accident). What counts as a finding: any gitleaks hit; semgrep `ERROR` or `WARNING`; osv score 4.0 or
  higher, or no score at all. Lower scores and semgrep `INFO` are listed but don't fail.
- The "uncommitted" gitleaks pass stages everything into a throwaway copy of git's index (`.scan/index`), so your real
  staging area is never touched. Files git ignores (`.env`, `target/`) are not scanned.
- A fake secret on purpose (e.g. in a test) is excused by a `gitleaks:allow` comment on that line. A secret already in
  history can't be rewritten once pushed, so it goes in `.gitleaksignore` by its fingerprint (`commit:file:rule:line`,
  printed in gitleaks' JSON report). Never loosen a gitleaks rule globally.
- Tools are found by name on PATH, except semgrep (see the troubleshooting entry below). To use another copy, set
  `LOCKBOX_GITLEAKS`, `LOCKBOX_SEMGREP` or `LOCKBOX_OSV` to its path. The tests use this to swap in fake tools.
- Tests: `node --test "scripts/*.test.mjs"`.
- A semgrep hit we accept on purpose is silenced on that line with `// nosemgrep: <rule id> -- <reason>`.
- An osv finding we accept for now goes in `osv-scanner.toml` at the repo root (osv-scanner reads it for the
  `Cargo.lock` next to it), as an `[[IgnoredVulns]]` entry with a one-line `reason` and an `ignoreUntil` date. Every
  entry must expire: when the date passes the scan fails again, and the entry is fixed or renewed after a fresh
  look. Today's entries are Linux-only crates and one compile-time-only crate in Tauri's tree.
- CI job "Security scan" (Windows) installs pinned versions: gitleaks 8.30.1 and osv-scanner 2.7.0 downloaded from their
  GitHub releases and checked against SHA-256 values copied from the releases (the job fails on a mismatch), and
  `pip install semgrep==1.179.0`, then runs the scanner's own tests before the scan. Bumping a version means getting the new SHA-256 from the release's checksum file (osv-scanner: `osv-scanner_SHA256SUMS`).

## Troubleshooting log

**Desktop app tests stop at once with `STATUS_ENTRYPOINT_NOT_FOUND` (0xc0000139)**
Tauri needs Windows' Common Controls 6, which a program asks for in its embedded manifest. tauri-build gives the app
that manifest but not test programs. `crates/lockbox-desktop/build.rs` embeds the same manifest into the test
programs (`embed_test_manifest`); keep it when changing the build script.

**semgrep: `executing pysemgrep failed ... No such file or directory`**
pip installs semgrep into `%APPDATA%\Python\Python311\Scripts`, which isn't on PATH, so `semgrep.exe` can't find its
helper `pysemgrep`. Fix used here: the scan script calls semgrep by its full path, with that folder added to PATH only
for the script's run. (Alternative: add the folder to your user PATH.)

**winget says Build Tools are "already installed" after a stopped install**
Stopping `winget` doesn't stop the Visual Studio installer it started; it can finish on its own. Check what's really
there before retrying: `"C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe" -all -requires
Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`. A path printed means the C++ tools are in.

**`node --test <folder>/` fails with `Cannot find module` (Node 24)**
Node 24 treats a folder argument as a file to run. Pass the test files instead: `node --test "scripts/*.test.mjs"`.
