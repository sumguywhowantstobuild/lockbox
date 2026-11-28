# Amendment: the file check becomes optional

**Date:** 2026-11-28 · **Amends:** [the download page design](2026-11-26-download-page-design.md), its "The words"
(the opening, steps 2 and 3, "Not offered yet", the guide's Install, Check the file and The warnings, and the guide
table's "The warnings" row) · **Decided by:** Ariel ("Ok, as recommended", option A, 2026-11-28) · **Plan:** Plan 5,
Task 12b · **Where this and the design differ, this amendment wins.**

## Why

The approved words make the fingerprint check a gate: "Only after step 2 printed True, choose More info, then Run
anyway". This amendment keeps the check and stops requiring it, for these reasons:

1. **Most people skip it.** A survey of 2,000 users and an eye-tracking study found that people who download a program
   don't verify its checksum, or do it inattentively, and find the manual check cumbersome and error-prone (Meylan,
   Cherubini et al., "A Study on the Use of Checksums for Integrity Verification of Web Downloads", ACM TOPS 2020). The
   study shows the check is rarely done; it does not show that a required check makes people ignore other warnings. That
   leading with the steps people take, and putting the two stop rules first, gets those rules read is a design
   judgement, not a finding. **my call**.
2. **For a file from an official place it adds little, and this is the trade-off.** The fingerprint on the page is
   computed by the page's build from the release's real installer. A match shows the file is byte for byte the one
   published for that version; on its own it can't show who built or published it (the page and the release have one
   owner), and it can't catch a compromised build or someone who changes both the file and the fingerprint. For a file
   downloaded through the page's button or from the releases list, it still catches a file whose bytes changed after the
   page was built while the page's fingerprint stayed right (a replaced or damaged download). Making the check
   optional gives up that detection for people who would have followed a required check. It matters most for a copy
   from anywhere else (a mirror, an ad, a lookalike site, a file someone sent), which the new words tell people to
   replace with a fresh download, or to check.
3. **The stop rules stay hard.** Stop at a malware or virus finding; stop at any administrator prompt (setup never needs
   one). They stay in bold, and now come before "Run anyway" on the page, in the guide and in SECURITY.md, so they are
   read before the action they guard.

**standard** (practice for unsigned open-source downloads: publish the fingerprint and say how to check it, with GitHub's
build record for people with its tool). The lasting improvement is a code signature (Phase 2): Windows can then check who
signed the file and that it hasn't changed since; it does not make a signed program safe by itself.

## One rule everywhere

The two official places are named the same way on all five surfaces (download page, hosted guide, `docs/GUIDE.md`,
README, SECURITY.md): **petalock.arielmaningas.com** and **Petalock's GitHub releases**
(`github.com/sumguywhowantstobuild/petalock/releases`).
- A file from either: the check is optional.
- A copy from anywhere else: the simplest is to download it again from an official place; to use that copy anyway, check
  it first, against the fingerprint an official place gives for that version (the download page for the version it
  offers, that release's page on GitHub for any other), never a checksum that came with the copy.
- Run anyway: only at SmartScreen's unrecognized-app screen, and only for a file from an official place or one that
  printed True in the check. The failed-check sentence comes first: if any check run on that file failed (the fingerprint
  printed False, or GitHub's build record reported anything else), don't run it: delete it. Then, "Otherwise", the
  condition, then the action. A reader who stops at the first sentence that applies never reaches "Run anyway" for a file
  that failed a check (review finding 1, 2026-11-28).
- The Markdown documents (README, SECURITY.md) name the official GitHub place with its full address, as a link,
  "[Petalock's releases on GitHub](https://github.com/sumguywhowantstobuild/petalock/releases)", never as "this
  repository", because a fork keeps a document's words and "this repository" would then mean the fork (review finding 2).
- GitHub's build record is the separate check of which workflow built the file. It doesn't say which version the file
  is, so on its own it doesn't allow Run anyway; the fingerprint for the version does (review finding 3).
- The stop rules are on all five surfaces, in bold, before any Run anyway.
- True means the file matches the fingerprint published for that version. GitHub's build record is the separate check of
  which workflow built it.

## What changes on the page

The layout stays: three numbered cards, the check still second (download, check, open), the approved look unchanged.
Step 3's paragraphs are reordered so the stop rule comes right after the opening line. The opening's link now points at
step 3 (`#open`) and asks which warnings mean stop. Unchanged: the PowerShell lines, the two-line alternative, the False
stop line, the folded fingerprint, GitHub's build record in the guide, Smart App Control, the plan's decision 1 (the
maker, that it is unsigned and the expected warning come before the button).

## The new words

The design's "How to read this list" applies. Only these blocks change; each old block is quoted first.

**The opening, "Before the button"**
- Old: Made by Ariel Maningas. It’s unsigned, so your browser and Windows will warn you. Link: Check the file before you
  open it.
- New: Made by Ariel Maningas. It’s unsigned, so your browser and Windows may warn you. Link: Which warnings mean stop?
  (to step 3, anchor `#open`; step 2 keeps `#check`)

**Step 2**
- Old title and first line: 2 Check the file is ours: Before you open it, check that the file you got is the one we
  published. Open PowerShell and paste this line (click in the box, press Ctrl+A, then Ctrl+C):
- New: 2 Check the file matches (optional): About a minute. If you downloaded it from petalock.arielmaningas.com or
  Petalock’s GitHub releases, you can skip this. Got it anywhere else? The simplest is to download it again from this
  page; to use that copy anyway, check it first (for another version, against that release’s fingerprint on GitHub, as
  the guide shows). Open PowerShell and paste this line (click in the box, press Ctrl+A, then Ctrl+C):
- Old: It should print True.
- New: It should print True, which means the file matches the fingerprint published for this version.
- The rest of step 2 is unchanged (the two-line alternative, the False stop line, the folded fingerprint).

**Step 3**, in this order:
- Old: Because the file is unsigned and new, you'll see warnings. The exact words may differ on your PC.
- New: Because the file is unsigned and new, you may see warnings. The exact words may differ on your PC.
- **Stop and delete the file if your browser or a security product says it found malware or a virus, or if Windows asks
  for administrator permission in any form (a password or a Yes/No prompt): setup never needs it.** (unchanged words,
  now second)
- Old: Your browser may say the file isn't commonly downloaded. Choose to keep it, and only for that notice. Then check the
  saved file in step 2.
- New: Your browser may say the file isn't commonly downloaded. Choose to keep it, and only for that notice.
- Old: Windows may show “Windows protected your PC”. Only after step 2 printed True, choose More info, then Run anyway,
  and only for that screen.
- New: Windows may show “Windows protected your PC”, saying it prevented an unrecognized app from starting. If any check
  you ran on this file failed, don’t run it: delete it. Otherwise, if the file came from this site or Petalock’s GitHub
  releases, or it printed True in step 2, choose More info, then Run anyway, for that screen only.
- Old: These warnings mean Windows doesn't know the file yet, not that it found something wrong. A fake copy would bring
  the same warnings, which is why checking the fingerprint matters.
- New: These notices mean Windows doesn't know the file yet, not that it found something wrong. A fake copy can show the
  same notices, so get Petalock only from this site or its GitHub releases.
- Smart App Control: unchanged, last.

**An early preview, said plainly: Unsigned**
- Old: ... so Windows can't tell who made the file. Your browser and Windows will warn you before it runs.
- New: ... so Windows can't tell who made the file. Your browser and Windows may warn you before it runs.

**Not offered yet**
- Old: ... the fingerprint above is how you check a file (the guide also shows GitHub’s build record).
- New: ... the optional check in step 2 shows a file matches the one published (the guide also shows GitHub’s build
  record, which shows the workflow that built it).

**Guide: Install**
- Old: Get the installer from the download page, check its fingerprint (the next section), then open it.
- New: Get the installer from the download page and open it. Checking its fingerprint first is optional (the next
  section).

**Guide: Check the file** (heading and `#check-the-file` unchanged)
- New first paragraph, before the existing words: Optional. If you downloaded the file from petalock.arielmaningas.com or
  Petalock’s GitHub releases, you can skip this. For a copy from anywhere else, the simplest is to download it again from
  the download page; to use that copy anyway, check it first: for the version the download page offers, with the lines
  below; for any other version, against that release’s own fingerprint (Going back, below).
- Old: Every release lists the file's fingerprint. Paste the PowerShell line from the download page; it prints True when
  the file is ours.
- New: Every release lists the file's fingerprint. Paste the PowerShell line from the download page; it prints True when
  the file matches the fingerprint published for that version. GitHub’s build record (below) is the separate check of
  which workflow built it.
- The rest is unchanged.

**Guide: The warnings**, in this order:
- Old: An unsigned, new file gets warnings from your browser and from Windows. ... A matching fingerprint shows the file
  is the one we published. It does not mean no security product will object to it.
- New: An unsigned, new file may get warnings from your browser and from Windows. They mean Windows doesn't know the file
  yet, not that it found something wrong; the exact words may differ on your PC. A matching fingerprint shows the file
  matches the one we published. It does not mean no security product will object to it.
- The stop rule (unchanged words), now second.
- Old: Your browser may say the file isn't commonly downloaded: choose to keep it, and only for that notice. Then check
  the saved file (the section above). Windows may show “Windows protected your PC”: only after the check printed True,
  choose More info, then Run anyway, and only for that screen.
- New: Your browser may say the file isn't commonly downloaded: choose to keep it, and only for that notice. Windows may
  show “Windows protected your PC”, saying it prevented an unrecognized app from starting. If any check you ran on this
  file failed, don’t run it: delete it. Otherwise, if the file came from the download page or Petalock’s GitHub
  releases, or it printed True in the check above, choose More info, then Run anyway, for that screen only.
- Smart App Control: unchanged, last.

**Guide: Going back** (review finding 5; the rest of the section is unchanged)
- Old: Older versions stay on the releases list. Each release lists its own installer and its own fingerprint (the
  .sha256 file on its page). Check the exact file you will open against that release's fingerprint, not against this
  page's: ...
- New (second fix, Codex re-check): Older versions stay on the releases list. Each release lists its own installer and its
  own fingerprint. Checking an older version you downloaded from Petalock’s GitHub releases is optional. A copy from
  anywhere else must match that release’s own fingerprint (the .sha256 file on its page) before you open it, never a
  checksum that came with the copy; compare the exact file you will open with it, not with this page’s: ... (The first
  fix round's "If you check an older version, check the exact file ..." made the check sound optional for the readers the
  third-party-copy paragraph sends here; this wording replaces it.) In `docs/GUIDE.md` the end reads "not with the
  download page's: its PowerShell line is for its own version only."

**Guide table, "The warnings" row** (design, "The pages"): In this order: the stop rules (a malware or virus finding,
any administrator permission prompt); keep the file only for the "not commonly downloaded" notice; at SmartScreen's
unrecognized-app screen, if any check failed, delete the file; otherwise, if it came from an official place or printed
True in the check, More info then Run anyway; Smart App Control.

## The same change elsewhere (exact sentences)

`docs/GUIDE.md`: the guide's new words above, word for word (it matches the hosted guide).

`README.md`, the note at the top:
- Old: The installer has no code signature, so your browser and Windows will warn you before it runs.
- New: The installer has no code signature, so your browser and Windows may warn you before it runs.

`README.md`, the install part:
- Old: Before you open it, check its fingerprint (SHA-256). The download page gives a PowerShell line that prints `True`
  when the file is the one GitHub built; each release also lists the fingerprint in its `.sha256` file. If you have
  GitHub's command-line tool, you can also check GitHub's build record for the file.
- New: You can check its fingerprint (SHA-256) before you open it: optional for a file from the download page or
  [Petalock's releases on GitHub](https://github.com/sumguywhowantstobuild/petalock/releases). A copy from anywhere else:
  download a fresh one from either, or check it before you open it, against the fingerprint on
  petalock.arielmaningas.com for the version it offers, or the `.sha256` file on that version's release page at
  github.com/sumguywhowantstobuild/petalock/releases for any other version, never a checksum that came with the copy.
  The download page gives a PowerShell line that prints `True` when the file matches the fingerprint published for that
  version; each release also lists the fingerprint in its `.sha256` file. If you have GitHub's command-line tool, you can
  also check GitHub's build record, which shows the workflow that built the file.
- Also (the Download paragraph): "or from this repository's [releases](...)" becomes "or from [Petalock's releases on
  GitHub](https://github.com/sumguywhowantstobuild/petalock/releases)".
- Old (the Unsigned bullet): A fake copy would bring the same warnings, which is why the fingerprint check matters.
- New: A fake copy can show the same warnings, so get it only from the download page or [Petalock's releases on
  GitHub](https://github.com/sumguywhowantstobuild/petalock/releases). **Stop and delete the file if your browser or a security product says it found malware or a virus, or if Windows asks
  for administrator permission in any form (a password or a Yes/No prompt): setup never needs it.**

`SECURITY.md`, "Verifying a download":
- Old: Check the file before you open it, in either or both of two ways.
- Old: Get Petalock only from `petalock.arielmaningas.com` or this repository's releases on GitHub.
- New: Get Petalock only from `petalock.arielmaningas.com` or [Petalock's releases on
  GitHub](https://github.com/sumguywhowantstobuild/petalock/releases).
- New: You can check the file before you open it, in either or both of two ways. It is optional for a file from the
  download page or [Petalock's releases on GitHub](https://github.com/sumguywhowantstobuild/petalock/releases). For a copy
  from anywhere else, download a fresh one from either place, or check it before you open it, against the fingerprint on
  `petalock.arielmaningas.com` for the version it offers, or the `.sha256` file on that version's release page at
  `github.com/sumguywhowantstobuild/petalock/releases` for any other version, never a checksum that came with the copy.
- After "...because the page and the release are both run by the same owner." add: For a file from the download page or
  Petalock's releases on GitHub, a match adds little: it catches a file whose bytes changed after the page was built while the
  page's fingerprint stayed right (a replaced or damaged download), and it can't catch a compromised build or a change to
  both the file and the fingerprint.

`SECURITY.md`, "The unsigned preview and SmartScreen":
- Old: Expect two warnings, worded differently on some PCs:
- New: Expect up to two warnings, worded differently on some PCs. First, when to stop, as its own bold paragraph:
  **Stop and delete the file if your browser or a security product says it found malware or a virus, or if Windows asks
  for administrator permission in any form (a password or a Yes/No prompt): setup never needs it.** Then "The two
  warnings:" and the bullets.
- That stop sentence is removed from its old place after the bullets; the Smart App Control sentence stays there.
- Old browser bullet ending: Keep the file for that notice only, then check it as above.
- New: Keep the file for that notice only.
- Old SmartScreen bullet: ... may show "Windows protected your PC" when you open it. Only after the fingerprint check
  printed `True`, choose More info, then Run anyway, for that screen only.
- New: ... may show "Windows protected your PC" when you open it, saying it prevented an unrecognized app from starting.
  If any check you ran on this file failed, don't run it: delete it. Otherwise, if the file came from the download page or
  [Petalock's releases on GitHub](https://github.com/sumguywhowantstobuild/petalock/releases), or its fingerprint printed
  `True` against the fingerprint published for its version, choose More info, then Run anyway, for that screen only.
  (GitHub's build record stays a separate check of which workflow built the file; on its own it no longer allows Run
  anyway. Review finding 3: it doesn't say which version the file is. In the build record paragraph, after "If it reports
  anything else or fails, delete the file.", SECURITY.md adds: It shows which workflow built the file, not which version
  the file is, so it is a separate check: on its own it does not clear a file for the SmartScreen step in the next section.)
- Old: A fake copy would bring the same two warnings, which is why the check matters.
- New: A fake copy can show the same two warnings, so get Petalock only from those two places.

The design's "Changes from the drawings" gets one line: **The file check is optional** (amendment 2026-11-28, option A):
the opening's link, step 2's title and first line, step 3's order and conditions and the guide's warnings follow
[the amendment](2026-11-28-optional-file-check-amendment.md), which wins over the drawings and the original word list.
"The words" also gets a first line, "Amended 2026-11-28: the file check is optional; where the blocks below and
[the amendment](2026-11-28-optional-file-check-amendment.md) differ, the amendment wins.", and the Context's decision
list a line after the plan's decision 1: "The check after download is optional (Ariel, 2026-11-28, option A; the
amendment)".

## Testing

- Task 6's word-for-word lists take the new words, page and guide.
- The safety-instructions test checks the new order on screen (stop rule, then the browser notice, then SmartScreen) in
  both themes and sizes, on the download page and the guide.
- A new check, without a browser, reads the built pages (download and guide, both states, and 404), `docs/GUIDE.md`,
  README and SECURITY.md and fails on any old gate, matched case-sensitively as whole phrases: "Only after step 2
  printed True", "only after the check printed True", "Only after the fingerprint check", "Check the file before you open
  it." (the old link), "Check the file before you open it, in either", "Before you open it, check", "Then check the saved
  file", "then check it as above", "which is why the check matters", "which is why checking the fingerprint matters",
  "which is why the fingerprint check matters", "will warn you". It also requires on each of the five: both official
  places and the stop rule's words; and on the download page, both guides and SECURITY.md the Run anyway condition
  ("Otherwise, if the file came from") and "If any check you ran on this file failed, don't run it: delete it.", which
  must come before the words "choose More info, then Run anyway". It is shown to fail on today's text before the words
  change.
- Fix round (Codex review, 2026-11-28): the gates also include "this repository's releases", "check its fingerprint (the
  next section), then open it" (the old guide Install line), "Check the exact file you will open" (the old Going back),
  "failed, don't: delete it" (the old order) and "or a check above passed for it" (a build record alone). The Markdown
  documents must hold their approved optional-check sentences (the guide's Install and Check the file, the README's and
  SECURITY.md's optional check with the third-party-copy rule, "Petalock's releases on GitHub" as a link to
  `github.com/sumguywhowantstobuild/petalock/releases`), with fixtures that put the old text back or remove the policy while
  the stop rule and the URLs stay. A browser test reads the failed-check sentence and the Run anyway condition each in
  its own text (display, visibility, size, colour), on both pages, both themes and sizes, with fixtures that hide only
  one of them. The old rule that nothing may link to `#check` is dropped: the opening's link label and destination and the
  two step ids are kept.
- `every_link_resolves` covers the opening's link to `#open`; `#check` and `#check-the-file` stay.
- Task 12's pictures are taken again for the opening, the three cards and the guide's two sections.
