# Release record: Petalock <version> (`v<version>`)

<!--
How to use this template (RELEASING.md, steps 2 to 11):
- Copy it to docs/releases/v<version>.md for every candidate, and fill it against that candidate's exact commit.
- The record goes to main in a reviewed pull request after the tag exists (with the one that points the download page
  at the release, RELEASING.md step 9), so the tag never moves. It records the commit; it is never part of it. A
  candidate that is never published keeps its record too, with the reason it stopped.
- Every section is filled. Write "none" where there is nothing, never leave a section blank. A failed check is written
  down as failed, with what was done about it.
- Evidence may be carried forward from an earlier record only where the commit range between the two shows it still
  applies (for example, no change to SECURITY.md or to the code a requirement covers). Name the record it comes from.
- Commands are run in a clean PowerShell window in a clone of the repository, signed in to GitHub's command-line tool.
  Paste what they print (trimmed to the lines that matter), not a summary of it.
- Made-up values in any example carry MU-. Never paste a token, a password or a personal path.
-->

| | |
|---|---|
| Version | `<version>` |
| Tag | `v<version>` |
| Kind | Candidate (pre-release) / Promoted to the release / Withdrawn |
| Commit | `<40-character commit hash>` on `main` |
| Previous record | `docs/releases/v<previous>.md`, or "none: first record" |
| Record started | `<YYYY-MM-DD>` |

## 1. The commit

- [ ] The version commit is on `main`, merged through a pull request: `#<number>`.
- [ ] `Cargo.toml`'s `[workspace.package]` version is `<version>`, and `CHANGELOG.md` has a section for it.
- [ ] The tag `v<version>` peels to the commit above (filled at RELEASING.md step 4, after the tag exists):

```
git fetch origin --tags
git rev-parse "v<version>^{commit}"
git merge-base --is-ancestor "v<version>^{commit}" origin/main; $LASTEXITCODE   # 0: the commit is on main
```

```
<paste>
```

## 2. CI on that commit

The push run of `ci.yml` on `main` for the commit, its latest attempt. Every job must be `success`; the release
workflow's `authorize` job refuses otherwise.

```
gh run list --workflow ci.yml --branch main --event push --commit <commit> --json databaseId,attempt,status,conclusion
gh run view <run id> --json jobs --jq '.jobs[] | "\(.name): \(.conclusion)"'
```

- Run: `<run id>`, attempt `<n>`, `https://github.com/sumguywhowantstobuild/petalock/actions/runs/<run id>`

| Job | Result |
|---|---|
| Rust: format, lint, test (windows) | |
| Rust: format, lint, test (linux) | |
| UI: lint, test, build | |
| Security scan | |
| End-to-end: the real app (windows) | |
| Installer / Installer: build and smoke test (windows) | |

- [ ] Every job `success` on the latest attempt.
- [ ] Any failure that passed on a re-run is written here as "failed once, passed on re-run, cause unknown" (or its
  cause): `<none, or which>`.
- Tests skipped in the run, with the reason for each (the script suite's skips are tests whose input only another job
  has): `<paste the skip lines>`

## 3. The security scan

Every finding's disposition. The scan job must have passed (section 2); this section says why each accepted item is
still acceptable on this commit.

| Tool | Finding | Where it is accepted | Reason (in your words) | Expires | Looked at again on |
|---|---|---|---|---|---|
| osv-scanner | | `osv-scanner.toml` | | | |
| osv-scanner (UI) | | `ui/osv-scanner.toml` | | | |
| gitleaks | | `.gitleaksignore` | | n/a | |
| semgrep | | a `nosemgrep` comment in the file | | n/a | |

```
git grep -n "nosemgrep" <commit>
git show <commit>:.gitleaksignore
```

- [ ] Every entry in `osv-scanner.toml` and `ui/osv-scanner.toml` is in the table, and none has expired.
- [ ] Every `nosemgrep` comment and `.gitleaksignore` line is in the table, or the table says "unchanged since
  `<previous record>`" and the commit range shows no new one.
- [ ] Nothing found by the scan is unaccepted.

## 4. Every change since the last record

Range: `<previous record's commit>..<commit>` (the first record covers the whole history up to the commit).

```
gh pr list --state merged --base main --search "merged:>=<date of the previous record's commit>" --json number,title,mergedAt,reviews
```

| Pull request | Title | Greptile review | Owner's approval | Notes |
|---|---|---|---|---|
| `#<n>` | | link | link | |

- [ ] Every commit in the range came through one of the pull requests above:
  `git log --first-parent --oneline <range>` shows only merges of those pull requests.
- [ ] Each pull request has a Greptile review and the owner's approval. An exception (for example, one merged before
  this rule held) is listed here with its reason, and condition 3 below says "not fully".

## 5. The live repository settings

Read from GitHub's API on the day the record is filled, not copied from an earlier record.

```
gh api repos/sumguywhowantstobuild/petalock/rulesets
gh api repos/sumguywhowantstobuild/petalock/rulesets/<id of "release tags">
gh api repos/sumguywhowantstobuild/petalock/rulesets/<id of "release tags fixed">
gh api repos/sumguywhowantstobuild/petalock/branches/main/protection
gh api repos/sumguywhowantstobuild/petalock/environments/release
gh api repos/sumguywhowantstobuild/petalock/environments/release/deployment-branch-policies
gh api repos/sumguywhowantstobuild/petalock/environments/site
gh api repos/sumguywhowantstobuild/petalock/environments/site/deployment-branch-policies
gh api repos/sumguywhowantstobuild/petalock/environments/site/secrets --jq '.secrets[].name'
```

A ruleset's bypass applies to every rule in it, so the two tag rules are two rulesets: one with the owner's bypass for
creating a tag, one with no bypass for moving or deleting one.

| Setting | Expected | Read |
|---|---|---|
| Tag ruleset "release tags" on `refs/tags/v*` | active; rules creation (update and deletion may also be listed); bypass: the repository admin role only | |
| Tag ruleset "release tags fixed" on `refs/tags/v*` | active; rules update and deletion; bypass: none | |
| Branch protection on `main` | pull request required; the required checks; no force push; no deletion | |
| Environment `release` | required reviewer: the owner; deployment branches: `main` only | |
| Environment `site` | deployment branches: `main` only; holds the Cloudflare token as its only secret | |

- [ ] Each row matches what is expected. A difference is explained here, or the release stops.

## 6. The walk-through of SECURITY.md against the code (R1 to R7)

Read `SECURITY.md` at the commit (`git show <commit>:SECURITY.md`) and check each claim it makes for every requirement
against the code and the tests at that commit. Where a claim is wrong, the release stops until `SECURITY.md` or the code
is fixed.

| Requirement | What SECURITY.md claims | Checked in the code (file:line) | Tests that hold it | Result |
|---|---|---|---|---|
| R1 Confidentiality at rest | | | | |
| R2 Integrity | | | | |
| R3 Guessing cost | | | | |
| R4 No plaintext written except on request | | | | |
| R5 No secrets in logs and errors | | | | |
| R6 Locking stops access | | | | |
| R7 Documented limits | Every limit in "Honest limits" is still true and none is missing | | | |

- First candidate only: the multi-GB local test (the three slow checks in README.md, "Build and test", on the commit, in
  release mode): `<date, results, peak memory>`.
- Hands-on checks before publishing (RELEASING.md, step 7), on the draft's installer in the spare account:

| Check | Result |
|---|---|
| Quick Assist with "Keep out of screen capture" on | |
| Remote desktop with it on (or the owner's written exception) | |
| A vault on a USB drive unplugged while open (or parked, with the reason) | |
| Printing the recovery key to a real printer | parked: no printer |
| Every screen walked with NVDA and in a Windows high contrast theme (the PRD's "How it is checked"), or the owner's written exception | |

Signed (at RELEASING.md step 2): I walked through `SECURITY.md` against commit `<commit>`, every requirement R1 to R7,
and the R1 to R7 table above is true. `<name>`, `<YYYY-MM-DD>`. The hands-on rows are filled at step 7, by their own
results.

## 7. The draft release

From the release workflow's run (RELEASING.md, steps 5 and 6).

- Release workflow run: `<run id>`, `https://github.com/sumguywhowantstobuild/petalock/actions/runs/<run id>`
- Approvals in the `release` environment: `attest` by `<who>` at `<time>`; `draft` by `<who>` at `<time>`
- Draft ID: `<id>` (the `draft` step's output `draft-id`, also in the run's summary)
- Expected installer SHA-256 (the build's output): `<64 hex>`

| Asset | Size | SHA-256 of the downloaded file |
|---|---|---|
| `Petalock_<version>_x64-setup.exe` | | |
| `Petalock_<version>_x64-setup.exe.sha256` | | the line it holds: |
| `Petalock_<version>_x64-setup.exe.provenance.sigstore.json` | | |
| `Petalock_<version>_x64-setup.exe.release-binding.sigstore.json` | | |

- [ ] The downloaded installer's SHA-256 equals the build's output and the `.sha256` file's line.
- [ ] The installer's own version (Properties, Details, or `(Get-Item <file>).VersionInfo`) is `<version>`.

## 8. The attestation checks

Run on the draft's downloaded installer, against the draft's own bundles, before the draft is made public.

```
$env:INSTALLER = "<folder>\Petalock_<version>_x64-setup.exe"
$env:PROVENANCE_BUNDLE = "<folder>\Petalock_<version>_x64-setup.exe.provenance.sigstore.json"
$env:BINDING_BUNDLE = "<folder>\Petalock_<version>_x64-setup.exe.release-binding.sigstore.json"
$env:GITHUB_REPOSITORY = "sumguywhowantstobuild/petalock"
$env:TAG = "v<version>"; $env:SOURCE = "<commit>"; $env:VERSION = "<version>"
node scripts/release-guard.mjs verify
```

```
<paste: "verified Petalock_<version>_x64-setup.exe (<sha256>) for: https://slsa.dev/provenance/v1, https://github.com/sumguywhowantstobuild/petalock/release-binding/v1">
```

And the check a downloader runs, as the guide gives it:

```
gh attestation verify "<folder>\Petalock_<version>_x64-setup.exe" --repo sumguywhowantstobuild/petalock --cert-identity "https://github.com/sumguywhowantstobuild/petalock/.github/workflows/release.yml@refs/heads/main" --source-ref refs/heads/main
```

```
<paste>
```

- [ ] Build provenance verified: signer `release.yml` on `refs/heads/main`, this repository, a GitHub-hosted runner.
- [ ] The bound statement verified: it names this tag, this commit, this version and this installer's SHA-256.
- [ ] First record only: `a_branch_dispatch_cannot_attest_or_draft`: a dispatch of the release workflow from a branch
  other than `main` was refused the `release` environment. Run: `<run id>`, what GitHub said: `<paste>`.

## 9. Publication

- [ ] Published as a pre-release by `<who>` at `<time>`: `https://github.com/sumguywhowantstobuild/petalock/releases/tag/v<version>`
- [ ] The four assets download signed out, and the installer's SHA-256 is still `<64 hex>`.
- [ ] `site/release.json` set to `{"tag": "v<version>"}` in pull request `#<n>`, merged as `<commit>`; the Site workflow's
  run `<run id>` verified the attestation, built and deployed.
- [ ] Live checks on the download page, the guide and a missing page (status 404): the headers exactly as in
  `site/_headers`, no cookie, no script, no request to another site on load, `http://` sends to `https://`, the page's
  fingerprint equals the SHA-256 of the file downloaded through its button, and its links reach this release, the
  releases list and `SECURITY.md`.
- Walk-through as a stranger, in the spare account (RELEASING.md, step 10): `<date; findings, each with its pull request,
  or "clean">`

## 10. Which "reviewed" conditions hold

The five conditions of the [design spec](../design/2026-10-07-lockbox-design.md#what-reviewed-means-for-lockbox). This
table is copied into README.md's "Is the current release reviewed?" when this release is the current one.

| # | Condition | Holds? | Evidence |
|---|---|---|---|
| 1 | All tests pass in CI, the security tests included | | section 2 |
| 2 | The scan is clean, or each finding is triaged in writing | | section 3 |
| 3 | Every change merged through a pull request with a Greptile review and the owner's approval | | section 4 |
| 4 | The written walk-through of SECURITY.md against the code, R1 to R7, signed off | | section 6 |
| 5 | README.md states plainly that Petalock has not been independently audited | | README.md at the commit |

## 11. Promotion or withdrawal

- Promoted to the release: `<date>`, by `<who>`; the same file as the candidate, never rebuilt (SHA-256 `<64 hex>`).
  Signed: this candidate is the release. `<name>`, `<YYYY-MM-DD>`.
- Withdrawn: `<date>`, the reason, what was done (RELEASING.md, "Withdrawing a release"), and where users were told.
