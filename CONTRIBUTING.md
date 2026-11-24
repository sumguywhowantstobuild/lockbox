# Contributing to Lockbox

Lockbox is a local-only password manager and encrypted file vault for Windows (see [README.md](README.md)). These
rules apply to everyone who changes the code.

Found a security problem? Don't open a public issue; follow [SECURITY.md](SECURITY.md).

## How the project is built
- **Stack:** Tauri 2 with a Rust core and a React + TypeScript UI. All encryption and keys stay in the Rust core.
- **Phase 1 targets Windows only.** Keep the Rust core (`crates/lockbox-core`) separate from the app so a later
  Android app can reuse it.
- **Design first:** what Lockbox does is in [docs/PRD.md](docs/PRD.md), how it's built in
  [ARCHITECTURE.md](ARCHITECTURE.md), and the full design (encryption, file formats) in
  [docs/design/2026-10-07-lockbox-design.md](docs/design/2026-10-07-lockbox-design.md).
  A change that alters the design updates those documents in the same pull request. New design specs go in
  `docs/design/`.
- **Dev setup:** [docs/SETUP.md](docs/SETUP.md) lists every tool and version. Record any new setup step there.

## Rules
- **Never write our own cryptography.** Use well-reviewed libraries only.
- **Read a library's real source before using its API.** Tauri 2 and the crypto crates change fast; documentation
  and memory go stale.
- **Tests first.** Write the test that fails, then the code that makes it pass.
- **Never commit secrets,** or third-party files without a licence that allows it (list them in
  [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)).
- **`main` changes only through a reviewed pull request** with every CI check green.

## Before you push
Run the same checks CI runs, in one command that runs them side by side where it can and reports each one (logs in
`target/check-logs/`; add `--no-scan` to leave out the security scan):

```
node scripts/check.mjs
```

For a change that touches one part, a short check runs every format, lint, UI and script check and the security scan,
then only the Rust tests of the parts named: `engine` (`crates/lockbox-core`), `desktop` (`crates/lockbox-desktop`,
with the bridge tests in the release configuration) or `ui` (no Rust tests); join two with a comma, as in `desktop,ui`.
`engine` and `desktop` together, `all`, or `--short` alone run every check. The short check always runs the scan, so
it refuses `--no-scan`. When unsure which tests cover a change, run every check. CI runs the full set, the release
build included, on every push.

```
node scripts/check.mjs --short ui
```

The same checks one by one:

```
cargo fmt --all --check
cargo clippy --locked --all-targets -- -D warnings
cargo clippy -p lockbox-core --locked --all-targets --features test-internals -- -D warnings
cargo test --locked
cargo test -p lockbox-core --locked --features test-internals --test '*'
npm --prefix ui run lint
npm --prefix ui run build
npm --prefix ui test
cargo test -p lockbox-desktop --locked --features custom-protocol --test ipc
node --test "scripts/*.test.mjs"
node scripts/scan.mjs
```

Install the UI's dependencies once with `npm ci --ignore-scripts` in `ui/`. The UI's tests come after `npm run build`,
because one of them reads the built style sheet (it fails, saying to build first, when there is none). The
`custom-protocol` test run comes after it too, because the app embeds the built UI.

`node scripts/scan.mjs` runs the security scanners (secrets, risky code, vulnerable dependencies); see
[docs/SETUP.md](docs/SETUP.md#security-scan) for what it reports and how to handle a finding.

## Running the app against a test state
A local end-to-end or hands-on run must never touch your own Lockbox data. `e2e/lib/state.mjs` renames the app's
state folders, its web-view folders and the default vault folder aside (each gets a sentinel file naming the run), puts a
test state in their place, and renames everything back when the run ends. It finds those folders through Windows
(and refuses if `%LOCALAPPDATA%`, `%APPDATA%` or `%USERPROFILE%` say something else), refuses while any
`lockbox-desktop.exe` runs, refuses a folder that is a link or junction, and runs one command at a time. If a run is cut short (a crash, a closed terminal), put
everything back from any later terminal with `node e2e/lib/state.mjs recover`; `node e2e/lib/state.mjs status` says
what is set aside. A run started from a packaged app (one installed as an MSIX package) swaps that app's private copy
of AppData, which is the copy the app under test opens too, and `status` names it. The swap's journal and lock sit
beside the default vault folder in your profile, which every terminal sees alike; a terminal that cannot see that
private copy refuses to recover and says to run recover from a terminal inside the app. Recovery only renames folders
back and deletes only its own sentinel and journal files. Its tests
(`scripts/state-swap.test.mjs`) run on temporary folders only and are part of `node --test "scripts/*.test.mjs"`.

## End-to-end tests on the real app
`node scripts/e2e.mjs [spec]` builds the release app (the page, then `cargo build -p lockbox-desktop --release --locked
--features custom-protocol`), then drives it through `tauri-driver` and Microsoft Edge WebDriver with WebdriverIO, on a
test state swapped in as above. It refuses to start while any `lockbox-desktop.exe` runs. One-time setup:

1. `npm ci --ignore-scripts` in `e2e/` (WebdriverIO's packages stay in that folder).
2. `cargo install tauri-driver --locked --version 2.1.0`. The run looks for it in `%CARGO_HOME%\bin` (set
   `LOCKBOX_TAURI_DRIVER` to a full path to use another).
3. Download the Microsoft Edge WebDriver whose first three version parts equal your WebView2 runtime's (the registry
   value `pv` under `HKLM\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}`),
   check its download against Microsoft's publisher signature, and pass it as `node scripts/e2e.mjs --edgedriver
   <full path to msedgedriver.exe>` (or set `LOCKBOX_EDGEDRIVER`). The run refuses, naming both versions, when they
   differ. On the GitHub job the image's own driver (`EDGEWEBDRIVER`) is used.

The specs in `e2e/specs` are the design's end-to-end paths: `thin-path` (first-time setup, lock, unlock, add a login,
copy, auto-lock), `save-copied-key` (a copied key saved through the real save shortcut with every vault locked),
`back-up-then-restore` (a backup made through Windows' Save box, restored over the vault and read back) and `sign-in`
(the PRD's measure: pick a login, open its site, copy the username and the password in six keys or clicks or fewer).
Each spec runs on a fresh test state of its own, as on a new PC, with its own vault folder and files folder in the run's
temp folder (never the default vault folder), and the run stops at the first spec that fails. Shared steps are in
`e2e/lib/steps.mjs`; Windows' file and folder boxes are answered by window messages, off the screen
(`e2e/lib/folderbox.mjs`).

The run keeps the app's window off your screen and puts the real folders back when it ends; if it is cut short,
`node e2e/lib/state.mjs recover` does. Each spec's test state stays beside the real folders as `<folder>.test-<run>-s<n>`
(the run prints where; nothing it parked is ever deleted, since someone may have opened Lockbox meanwhile), so delete
those by hand when you are done. Only the run's own folder in the temp folder is deleted. A second run started while one
is going is refused and leaves the first alone. The run sends one mouse event that moves nothing, because Lockbox's idle
lock counts the session's input and would otherwise lock a vault that nobody has touched for minutes. The steps that use
the clipboard, the keyboard (the save shortcut is pressed as real keys) or the browser (`sign-in` opens a made-up
`.example` address) run on the GitHub job (which sets `LOCKBOX_E2E_CI=1`; the generic `CI=true` changes nothing here)
and, on a PC, only with `LOCKBOX_E2E_PC_FREE=1` (they replace what is on your clipboard, press keys and open a browser
tab); the run says which steps it skipped. The auto-lock step needs a minute with no
input at the PC and waits up to about four and a half minutes for it; if the PC was in use throughout, that step is
skipped and says so, and if the PC was quiet for over a minute and the vault did not lock, it fails. On the GitHub job
a skipped step fails the run and the lock must come within a minute plus 25 seconds. The job (`End-to-end: the real app`)
is not a required check.
`scripts/e2e.test.mjs` tests the runner on temporary folders (part of `node --test "scripts/*.test.mjs"`);
`e2e/real-app.test.mjs`, run by the script, checks the built app itself.
