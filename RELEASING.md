# Releasing Petalock

How a release is made, from the version commit to the published file and the download page. Every step has a pass mark
(what must be true before the next step) and a way back (what to do when it isn't). A failed pass mark stops the
release; nothing is skipped to save time.

The rules behind it:

- **A release is built by GitHub from a tag on `main`, never on anyone's PC.** The release workflow
  (`.github/workflows/release.yml`) is started by hand on `main` with the tag as its input. It refuses a tag that isn't
  on `main`, a version that doesn't match `Cargo.toml`, and a commit whose CI push run on `main` didn't pass every job on
  its latest attempt.
- **The file that ships is the file that was tested.** The workflow builds the installer with the same reusable workflow
  CI runs on every push (`build-installer.yml`), runs the installer's smoke checks on those exact bytes, and passes them
  on by their SHA-256. Each later job checks the digest.
- **Signing and publishing need the owner.** The `attest` and `draft` jobs run in the GitHub environment `release`, which
  allows only `main` and waits for the owner's approval, so each release asks for approval twice. Only the owner can
  create a `v*` tag, and nobody can move or delete one without first changing the tag rulesets (two, below).
- **Making a draft public is the owner's click,** only after the draft's own files have been checked (step 6).
- **Candidates are plain versions** (0.1.1, 0.1.2 and so on), each published as a pre-release. The first candidate whose
  walk-through is clean is promoted to the release as the same file, never rebuilt.
- **Every candidate has a record**, `docs/releases/v<version>.md`, filled from [the template](docs/releases/TEMPLATE.md)
  against its exact commit. The record is the evidence that the release is "reviewed".
- **Earlier releases stay published.** A bad one is marked withdrawn and the download page goes back to the last good one.

## Before the first release (once)

Each of these is set by the owner in GitHub's or Cloudflare's settings, and read back into the first record (template
section 5):

- Two tag rulesets on `refs/tags/v*`, because a ruleset's bypass applies to every rule in it: "release tags" restricts
  creation (and also lists update and deletion), and only the repository admin role bypasses it (so only the owner can
  make a release tag); "release tags
  fixed" restricts update and deletion with no bypass at all, so nobody, the owner included, can move or delete one
  without first changing that ruleset in the repository's settings.
- The environment `release`: the owner as required reviewer; deployment branches: `main` only.
- The environment `site`: deployment branches `main` only; the Cloudflare token as its only secret; the repository
  variable `SITE_DEPLOY` set to `on` only once the site is ready to go live (`.github/workflows/site.yml`).
- Branch protection on `main`: a pull request with the required checks green before any merge.

## The steps

### 1. The version commit

Change `version` under `[workspace.package]` in `Cargo.toml` to the candidate's version (refresh `Cargo.lock` with
`cargo update --workspace`), and give `CHANGELOG.md` a section for it. Open a pull request, get its review, merge it.

- **Pass mark:** the pull request is merged to `main`, and CI's push run on `main` for the merge commit passed every job:
  both Rust legs, UI, the security scan, end-to-end and the installer.
- **Way back:** a failing job is fixed in another reviewed pull request, which becomes the new version commit. Nothing
  outside the repository has changed yet. A job that failed for a flaky reason is re-run with **"Re-run all jobs"**,
  never "Re-run failed jobs": the release checks every job on the run's latest attempt, and a partial re-run leaves the
  others on an earlier one, which it refuses.

### 2. The record

Copy `docs/releases/TEMPLATE.md` to `docs/releases/v<version>.md` and fill, against the version commit, section 1's
commit lines (the tag line waits for step 4), sections 2 to 5, and section 6's R1 to R7 table and signature: the CI run
and every job's result, every scan finding's disposition, each pull request since the last record with its Greptile
review and the owner's approval, the live ruleset, branch protection and environments read from GitHub's API, and the
walk-through of `SECURITY.md` against the code, signed by the owner. The first candidate also runs the multi-GB local
test. Section 6's hands-on rows wait for step 7.

- **Pass mark:** section 1's commit lines, sections 2 to 5, and section 6's R1 to R7 table are filled, every check
  passed, and the owner signed the walk-through.
- **Way back:** a wrong claim in `SECURITY.md` or a failing check is fixed in a reviewed pull request, and the release
  goes back to step 1 with a new version. The record stays out of the repository until step 9. A candidate that stops
  before step 9 keeps its record, with the reason it stopped, and that record goes to `main` in the next version commit's
  reviewed pull request (step 1).

### 3. First release only: a branch can't sign

GitHub checks an environment's branch rule only when a job that names the environment is about to start, so the trial
must reach that moment: a job that is skipped because an earlier one failed proves nothing. On a throwaway branch, push
a copy of `release.yml` in which `attest` and `draft` need no other job (their `needs:` removed) and each has, in place
of its steps, one step that only prints a line; `authorize`, `build` and `inspect` are deleted from the copy, and
nothing in it checks out code, signs or uploads. Keep both jobs' `environment: release` exactly as in the real file.
Dispatch it from that branch (`gh workflow run release.yml --ref <branch> -f tag=trial-branch-check`; a name outside
`v*`, since a `v*` tag could never be deleted, and no tag needs to exist), and read the run. Write the run and GitHub's
answer in the record (`a_branch_dispatch_cannot_attest_or_draft`), then delete the branch.

This is the attacker's case at its simplest: whatever a branch's copy of the workflow says, it can't enter `release`.

- **Pass mark:** both jobs fail before any step runs, and the run's own error for each names the branch rule (GitHub's
  words: the branch "is not allowed to deploy to release due to environment protection rules"). A job shown as
  skipped, waiting for approval, or with any step run is a **fail** of this step, not a pass.
- **Way back:** if GitHub lets it in, stop: the environment's deployment-branch rule is wrong. Delete any draft the run
  made, write any attestation it made in the record (an attestation can't be deleted), fix the rule, read it back into
  the record, and run this step again. No release is made until it refuses.

### 4. The tag

The owner creates the tag `v<version>` on the version commit (on GitHub's release page, or `git tag v<version>
<commit>` and `git push origin v<version>`). The version commit must still be `main`'s newest commit when the tag is
made and when step 5 starts: the release runs `main`'s newest build workflow on the tag's own scripts, and only at
`main`'s head are those the files CI ran together. If anything merged after the version commit, go back to step 1 with
the next version.

- **Pass mark:** `git rev-parse "v<version>^{commit}"` prints the version commit, and that commit is `main`'s newest
  (`git rev-parse origin/main` after a fetch). Write the tag line in the record's section 1.
- **Way back:** a tag can't be moved or deleted (the second ruleset). A tag on the wrong commit is never released: leave
  it, and go back to step 1 with the next version.

### 5. The release workflow

Start it on `main` with the tag:

```
gh workflow run release.yml --ref main -f tag=v<version>
```

`authorize` checks the tag, `main` and every CI job; `build` builds and smoke-tests the installer from scratch, with no
cache; `inspect` checks the installer's name, digest and the version inside it. Then GitHub asks the owner to approve
`attest` (it signs the build provenance and a second statement that binds the tag, the commit and the installer's
digest), and again to approve `draft` (it deletes any earlier draft for the tag, makes a new draft pre-release, uploads
the installer, its `.sha256` and both attestation bundles, downloads them again and compares them).

- **Pass mark:** every job green; the run's summary names the draft's ID and the installer's SHA-256. Write both, with
  the run, in the record (section 7).
- **Way back:** any failure deletes the draft, and nothing is public. Read why in the run, fix it (a code fix is a reviewed
  pull request and a new version from step 1), then start the workflow again: a rerun starts from a fresh draft. An
  approval more than seven days late finds the build's files gone; start the workflow again.

### 6. Check the draft

Download the draft's four files (on its GitHub page, signed in) into an empty folder. Check that the installer's SHA-256
equals the build's output and the `.sha256` file, then run both attestation checks on the downloaded installer, against
the draft's own bundles (the commands are in the template, section 8), and write the results, with the draft's ID, in
the record.

- **Pass mark:** the digests agree; `node scripts/release-guard.mjs verify` prints "verified" for both statements; the
  downloader's `gh attestation verify` line passes. Only then may the draft become public.
- **Way back:** any mismatch or failed check means the draft is not published. Delete the draft on GitHub (only a draft:
  never a published release), find out why, and start again from step 5, or from step 1 if the code must change.
  A deleted draft's failed checks stay written in the record.

### 7. Hands-on checks on the draft's installer

In the spare standard Windows account kept for this, install the draft's downloaded installer (fingerprint checked) and,
with made-up data only, run the checks the record lists in section 6: Quick Assist and remote desktop with "Keep out of
screen capture" on, and a vault's USB drive unplugged. Then uninstall, so the walk-through starts clean.

- **Pass mark:** each check's result written in the record's section 6 hands-on rows; any check that can't be run has
  the owner's written exception there.
- **Way back:** a finding is fixed in a reviewed pull request and becomes the next candidate (step 1). The draft is
  deleted, never published.

### 8. Publish the pre-release

The owner opens the draft on GitHub and publishes it as a **pre-release**.

- **Pass mark:** the release page is public; the four files download signed out; the installer's SHA-256 is unchanged.
- **Way back:** see [Withdrawing a release](#withdrawing-a-release).

### 9. Point the download page at it

A reviewed pull request changes `site/release.json` to `{"tag": "v<version>"}`, adds the record,
`docs/releases/v<version>.md`, filled to this point, and updates README.md's status lines so they name this candidate as
the current preview (a pre-release, not yet reviewed as a release) with a link to its record. The record goes to `main` only now, after the tag: it records the
tagged commit and is never part of it, so the tag never has to move. When the pull request merges, the Site workflow
downloads that release's installer, verifies its attestation, builds the page from the real file (its size, date and
fingerprint) and deploys it. The build refuses a draft, a missing or extra file, a malformed `.sha256`, or bytes that
don't match, and then the last good page stays live.

- **Pass mark:** the live checks in the record, section 9: headers exact, no cookie, no script, no request to another
  site, `http://` sends to `https://`, the page's fingerprint equals the SHA-256 of the file downloaded through its
  button, a missing page answers 404, and the page's links reach the release, the releases list and `SECURITY.md`.
- **Way back:** in a reviewed pull request, set `site/release.json` back to the earlier tag (or to `{"tag": null}`,
  which shows "Coming soon"), keeping the record; the next deploy puts the earlier page back. Never revert the whole pull
  request: that would remove the record too.

### 10. The walk-through as a stranger

In the spare account, one action at a time, with a capture of each screen: open the page in a normal browser, read it,
download, the browser's warning, check the fingerprint with the page's line, run it, SmartScreen, install (no
administrator prompt), first open, a made-up vault in a folder of the owner's choosing with a made-up login and file.
For the next candidate: its installer started with Petalock open (the prompt, Cancel, Quit, Retry), the upgrade, the
vault opened from its kept entry, then uninstall from Windows Settings (the last page's words, the opened-file copies
gone, the vault folder still there), a restart, and the account's folders checked.

- **Pass mark:** no finding. Write the walk in the record, section 9.
- **Way back:** each finding is fixed in a small reviewed pull request and walked again in the next candidate (step 1).
  The candidate with findings stays a pre-release.

### 11. Promote the release

The first candidate with a clean walk-through becomes the release: on GitHub, edit it and untick "Set as a pre-release".
The file is the same; nothing is rebuilt. Then, in one reviewed pull request: the record's section 10 (which conditions
hold) and section 11 (signed by the owner as the release); `CHANGELOG.md`'s section for this version dated; and
README.md's "Is the current release reviewed?" naming this release, which conditions held, and a link to its record.

- **Pass mark:** the release page shows it as the latest release, the download page already offers it, and README.md
  names it.
- **Way back:** see [Withdrawing a release](#withdrawing-a-release).

## Withdrawing a release

When a published release (a candidate or the release) turns out to be wrong. Tags stay as they are; they can't be moved
or deleted.

1. **Point the page back first.** A reviewed pull request sets `site/release.json` to the last good release, or to
   `{"tag": null}` if there is none (the page then shows "Coming soon"). The Site workflow deploys it.
   *Pass mark:* the live page offers the earlier release, or "Coming soon", and its fingerprint matches that file.
2. **Mark the release withdrawn.** Edit its GitHub release: the title starts with "Withdrawn:", the first lines of its
   notes say why, what to do instead, and which release replaces it; tick "Set as a pre-release" so it is no longer the
   latest. Its files stay, so anyone who has the file can still check what they have.
   *Pass mark:* the release page says "Withdrawn" at the top, and GitHub's "Latest" is another release (or none).
3. **Unpublish only when the file itself is harmful** (for example, it isn't what the build made, or it damages data):
   set the release back to a draft (`gh api -X PATCH repos/sumguywhowantstobuild/petalock/releases/<release id> -F
   draft=true`), so its files can't be downloaded. Do step 1 first: the page's build refuses a draft, so the page would
   otherwise keep a broken link.
   *Pass mark:* the release's files no longer download signed out.
4. **Tell users** where they look: the release's own notes (step 2); `CHANGELOG.md`, with a "Withdrawn" line under that
   version and the reason; the download page, which already offers the earlier release; and, for a security problem, a
   GitHub security advisory for the repository that names the affected versions and what to do (uninstall, or install
   the replacement over it). Vaults are never touched by an uninstall or an upgrade, so the advice never asks anyone to
   delete one.
5. **Write it in the record** of the withdrawn release, section 11: the date, the reason, what was done, and where users
   were told.

The guide already tells people that a withdrawn release's notes say why and that the page goes back to the last good one.

- **Way back from a withdrawal:** none is needed for the files (they are unchanged). A release withdrawn by mistake is
  put back by reversing steps 1 to 3, in reviewed changes, and the record says so.
