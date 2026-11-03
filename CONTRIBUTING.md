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
Run the same checks CI runs:

```
cargo fmt --all --check
cargo clippy --locked --all-targets -- -D warnings
cargo clippy -p lockbox-core --locked --all-targets --features test-internals -- -D warnings
cargo test --locked
cargo test -p lockbox-core --locked --features test-internals
npm --prefix ui run lint
npm --prefix ui test
npm --prefix ui run build
cargo test -p lockbox-desktop --locked --features custom-protocol --test ipc
node --test "scripts/*.test.mjs"
node scripts/scan.mjs
```

Install the UI's dependencies once with `npm ci --ignore-scripts` in `ui/`. The `custom-protocol` test run comes
after `npm run build`, because the app embeds the built UI.

`node scripts/scan.mjs` runs the security scanners (secrets, risky code, vulnerable dependencies); see
[docs/SETUP.md](docs/SETUP.md#security-scan) for what it reports and how to handle a finding.
