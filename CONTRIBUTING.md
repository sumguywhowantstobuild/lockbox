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
