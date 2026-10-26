# Security

Lockbox is a work in progress and **has not been independently audited**. Don't store real passwords in it yet. This
file says what Lockbox is built to protect, what it does not protect, how it encrypts, and every limit we know about.
The requirements R1–R7 are defined in the
[design spec](docs/design/2026-10-07-lockbox-design.md#security-requirements-v1).

## Reporting a vulnerability

Please report it privately, not in a public issue: on this repository's **Security** tab choose **Report a
vulnerability** (GitHub private vulnerability reporting). Say what you found and how to reproduce it. Lockbox is a
one-person project, so there is no promised response time. There is no release yet; reports apply to the latest code.

## What Lockbox protects against

Lockbox keeps everything on your own PC, in one folder per vault. It is built so that:

- **A copy of the vault folder is useless without the password or recovery key (R1).** Someone who steals the folder (a
  stolen disk, a copied folder, a stolen backup) learns only the vault's name, the settings used to slow down password
  guessing, how many items and files there are, item sizes rounded up to 512-byte steps, the exact sizes of stored
  files, and file dates. Item titles, usernames, file names and contents are all inside encrypted items.
- **Changes are noticed (R2).** Changing a byte of a key slot, the header, an item or a file chunk is detected and
  refused or warned about. Swapping a file into another slot or vault is detected too.
- **Guessing a password is slow (R3).** Each guess costs one Argon2id run of at least 64 MiB, 3 passes and 4 parallel
  lanes, tuned to about one second on the PC that created the vault. A vault file asking for settings outside the
  accepted range is refused before any work starts.
- **No secrets in error messages or logs (R5).** Error messages are written by us and never include what was typed or
  stored; secret types print `<redacted>`. The property tests feed random and damaged input and check, for inputs of 8
  bytes or more, that neither an error's message nor its debug text (the form a developer sees) contains the input or
  any 8-byte stretch of it. For the backup parsers (the archive, its manifest, the restore journal) one kind of shared
  stretch is allowed: one that lies inside a word of our own fixed error text that a valid file also holds, such as
  `manifest`, where that word stands in the message. A shorter piece, such as a name of under 8 bytes, is not caught;
  the test that damages a whole backup also checks that no error names the vault, its IDs, an item title or a file
  name.

## What Lockbox does not protect against

- **Malware on your PC while a vault is unlocked.** It can read whatever Lockbox can read.
- **Someone who has your password or recovery key.**
- **A weak password.** The core insists on at least 12 characters when a password is set, but a guessable password is
  still guessable. Argon2id makes each guess costly; it cannot make a poor password good.
- **Unlimited guessing against a copied folder.** There is no lockout after wrong passwords, because an attacker with
  the folder simply bypasses the app. The cost of each guess is the protection.
- **Old copies of the vault.** Changing the password or regenerating the recovery key does **not** change the vault
  key. Anyone holding an earlier copy of the vault folder (an old backup, an old header) plus the old password or old
  recovery key can recover the vault key, and that key opens current and future data if they also get copies of the
  newer files. Full revocation needs "Rotate vault key", planned for v1.1 (spec 5.3). A backup is such a copy (see
  "Old backups keep old passwords working" under "Honest limits").
- **Old data a restore leaves behind.** The vault a restore replaces stays beside it until you delete it (see "A
  restore keeps the vault it replaced" under "Honest limits").
- **Rollback and deleted item files.** An attacker who can write to the folder can put back an older valid copy of an
  item, or delete an item file, and Lockbox will not notice (R7, spec 6.6). Files that lose their item are set aside,
  not deleted. An authenticated manifest (a tamper-proof list of every file) is left for the future sync design.
- **Copies the operating system makes.** Windows may write secrets to the pagefile (memory it parks on disk), the
  hibernation file (memory saved when the PC hibernates), crash dumps (memory saved when a program crashes) or the print
  spooler (the queue of print jobs), and Lockbox cannot control that. Use full-disk encryption (BitLocker on Windows Pro
  and above; "Device encryption" on supported Home PCs). Deleted files on an SSD are not guaranteed to be erased.
- **Copies made by the interface and other programs.** Text typed or shown in the app's window passes through the
  webview's memory (a browser engine, planned for the UI), which cannot be wiped as reliably as Rust's. Files you open
  with another program may be copied by that program (autosaves, recent-file lists).

## Where each requirement stands today

Only the Rust core exists (Plans 1 and 2: the vault engine, then backup, restore and read-only opening). Requirements
that need the desktop app are not met yet.

| Requirement | State |
|---|---|
| R1 Confidentiality at rest | Built into the core's file formats |
| R2 Integrity | Built: every key slot, item and file chunk is authenticated; the header has a MAC (a tamper-evident stamp); a backup carries a MAC-protected list of its contents, and restore checks every entry against it |
| R3 Guessing cost | Built: settings enforced and bounded, calibrated at creation |
| R4 No plaintext written except on request | In the core, plaintext is written only when you save a decrypted copy to a place you choose. A crash during that save can leave a hidden partial copy behind (see "Honest limits"). Backup, restore and copying an item between vaults never write plaintext. The app's "Open" and recovery-key printing do not exist yet |
| R5 No secrets in logs and errors | Built in the core (there is no logging yet) |
| R6 Locking stops access | **Not built.** Locking lives in the desktop app (Plan 3). The core only offers a cancel switch for long operations |
| R7 Documented limits | This file |

## How Lockbox encrypts

Everything comes from well-reviewed libraries. We wrote no cryptography ourselves, only the small encoding around
it (IDs, the extra context each encryption is bound to, base64). Exact versions are pinned in `Cargo.lock`.

- **Password to key:** Argon2id (a deliberately slow, memory-hungry way to turn a password into a key), crate `argon2`.
  The password is first normalised to Unicode NFC (one standard way of writing letters that have accents), so the same
  text typed on different keyboards unlocks the same vault.
- **Vault key:** 256 random bits from the operating system (`getrandom`), made once per vault. It is stored only
  wrapped (encrypted) in two **key slots**, one opened by the password key and one by the recovery key.
- **Recovery key:** 256 random bits plus a 4-bit typo check, shown as 52 characters. The key is derived from it with
  HKDF-SHA256 (a standard way to derive keys from a secret), crates `hkdf` and `sha2`.
- **Encryption:** XChaCha20-Poly1305 (encryption that also detects tampering), crate `chacha20poly1305`. Key slots
  and items use it directly with a fresh random 24-byte nonce (a one-time value) each time.
- **Files:** each stored file has its own random key, kept inside its encrypted item. File contents are encrypted in
  1 MiB chunks with the STREAM construction (a standard way to encrypt big data in pieces so that reordering,
  removing or cutting chunks is detected), crate `aead-stream`.
- **Header stamp:** HMAC-SHA256 (crate `hmac`) over the readable header fields, with a key derived from the vault key.
- **Wiping memory:** the `zeroize` crate clears keys and passwords when they are dropped.

The formats are pinned by tests, including known-answer tests (our output checked against answers published by the
algorithms' authors) where such answers exist.

## Honest limits

These are the weak spots and shortcuts we know about, each with a short reason why we accept it. Some of them are marked
in the code with a `shortcut:` comment.

### Review status

- **Not independently audited.** No independent security expert has audited Lockbox, and none is planned (spec 11).
  *Accepted:* the project's answer is tests, a written walk-through of this file against the code before each release,
  and honesty about what is not covered.

### Memory and wiping

Lockbox wipes the secrets it owns when it is done with them, but wiping is best effort. Anyone who can read the
memory of the running program (malware, a debugger, a crash dump) is already past what a password manager can stop.

- **Wiping cannot reach every copy.** Rust moves values and grows buffers, which can leave earlier copies behind, and
  nothing is wiped if the process is killed or crashes (spec 5.6). *Accepted:* this is true of every program; we keep
  secrets in fixed-size wiped buffers to leave as few copies as we can.
- **Moving a key leaves a copy.** Passing a `Key32` by value can leave an unwiped copy on the stack (short-term working
  memory). *Accepted:* inherent to Rust; the vault key is shared by reference instead of copied.
- **The JSON library's scratch buffers.** When an item contains characters that JSON escapes (quotes, backslashes, line
  breaks, tabs and other control characters), `serde_json` copies the text through scratch buffers (temporary working
  memory) it does not wipe, in a password or note. *Accepted:* fixing it means writing our own JSON reader or patching
  the library; plain text is copied straight into wiped fields.
- **JSON error messages can quote text.** If an item that passed authentication is nevertheless malformed, the library's
  error text may quote part of it into an unwiped string before we replace it with a fixed message. *Accepted:*
  reaching it needs malformed content that was authenticated, which means a bug of ours or someone who already holds the
  vault key; guarding every field would be large and error-prone.
- **HKDF leaves two temporary blocks.** `hkdf` 0.13 does not wipe its internal working key or its last output block. It
  affects deriving the recovery key and the header-stamp key. *Accepted:* wiping it means hand-writing HKDF (forbidden)
  or patching the crate; exploiting it needs a live memory read. We will upgrade when a release wipes them.
- **Titles, usernames, URLs and attached file names are not wiped.** Item titles, login usernames and URLs, the names of
  attached files (which can be revealing, such as a client's contract), and the search index built from the first three,
  are ordinary strings and stay in memory until freed, even after locking. Passwords and notes are wiped. *Accepted:*
  these are less secret than passwords, and wiping only the search copy would protect nothing.
- **The cipher keeps its own copy of the key while it works.** Each encrypt or decrypt call builds a cipher object that
  holds a copy of the key (spec 5.6). Lockbox builds it for that one operation and drops it straight away, and the
  `chacha20poly1305` library's wiping option is on. *Accepted:* the copy lives only for the call and is wiped when
  dropped.
- **Other libraries' internals.** How well Argon2, SHA-2 and HMAC wipe their own working memory is up to those
  libraries. We turn on their wiping options where they exist. *Accepted:* part of using reviewed libraries.
- **If the system's random source fails, Lockbox stops** (it "panics", Rust's word for a controlled crash) rather than
  continue without randomness. *Accepted:* continuing would be worse.
- **Unlocking uses a lot of memory for a moment.** Argon2id deliberately takes 64 to 256 MiB while it runs for a vault
  Lockbox creates, and Lockbox will read a vault file that asks for up to 1 GiB, so unlocking such a file can use that
  much. The 200 MB "flat memory" check for big files was measured with the smallest accepted setting, not a typical
  vault's. *Accepted:* the memory cost is what makes guessing expensive, and the upper limit stops a damaged or hostile
  file from asking for more.

### Crashes, power cuts and half-finished writes

- **Power loss is assumed safe, not proven.** Windows renames over an existing file are relied on to be atomic (all or
  nothing), though Microsoft does not formally document it. Crashes of Lockbox itself are tested by simulation (the
  tests make each step fail in turn and rebuild the folder a crash would leave); no process is actually killed and power
  cuts are not tested (spec 6.2). *Accepted:* it is how nearly all software saves files on Windows.
- **A crash during "Save a copy" can leave a decrypted file behind.** The copy is first built in a hidden temp file
  (`.<random>.lockbox-partial`) beside the destination, and moved into place only after every chunk has been checked. If
  Lockbox crashes, is killed or loses power while that temp file exists, it stays there as plaintext (part of the file
  you chose to export). The core has no output journal yet (a record of temp files to delete at the next launch; the
  core has the hook only, and the desktop app adds the real one in Plan 3, spec 7.2), and the cleanup at unlock only
  tidies inside the vault folder. A normal failure or cancel removes the temp file. *Accepted:* it is a copy you asked to have in plaintext, it is hidden, and the journal that deletes
  such leftovers at the next launch is planned.
- **A stale `.bak` after a half-failed password change.** The header is stored twice (`vault.json` and
  `vault.json.bak`). If a password change writes the first and fails on the second, the change reports an error and
  `.bak` still holds the old password slot. Until the next unlock, either password opens the vault, and whichever is
  used first wins: the new password makes Lockbox repair `.bak`, but the old password opens from `.bak` and then copies
  it over `vault.json`, silently undoing the password change (the only sign is the "opened from the backup header"
  notice, and the new password stops working). There is no key rotation. *Accepted:* it follows from the two-copy
  design; and because a password change does not change the vault key, an old password plus any older copy of the header
  already works (see "Old copies of the vault").
- **The regenerate-recovery double fault.** A new recovery key is written to `.bak` first and then `vault.json`. If the
  second write fails, the old recovery key keeps working and the new one is never shown. If `vault.json` is then
  destroyed before the next repair, `.bak` takes over, and its recovery slot belongs to the key that was never shown, so
  recovery is lost (the password still works and a new recovery key can be made). *Accepted:* it needs two failures in a
  row; the other write order could leave a vault with no working recovery key at all.
- **A new recovery key can be lost if the process dies right after writing it.** If Lockbox is killed after both header
  files are written but before the caller shows the new recovery key, the old key no longer works and the new one was
  never seen (the password still works and a new recovery key can be made). *Accepted:* a very narrow window, the same
  kind as the "Concurrent vault creation in one folder" case below.
- **A foreign `.bak` can take over an unreadable `vault.json`.** If `vault.json` is missing or unparseable and the `.bak` is from
  a different vault that has the same password, it unlocks and repairs `vault.json`; the items then show as damaged.
  *Accepted:* the original header was already unreadable and it needs the same password.
- **An unreadable or newer-format header copy is left alone at unlock, but a later header write can overwrite it.** If
  the other header copy is unreadable even after retries, or is in a newer format, unlock does not touch it and cannot
  check its slots. A later password change, recovery regeneration or accept can still overwrite it. *Accepted:* blocking
  those writes would let a permanently unreadable `.bak` lock the user out of credential changes.
- **Header writes are refused while the two copies disagree on a slot.** An unlock checks only the key slot for the
  credential it was given (the password slot after a password unlock, the recovery slot after a recovery unlock). If the
  other slot (the recovery slot after a password unlock, the password slot after a recovery unlock) differs between
  `vault.json` and `.bak` (for example one copy was damaged), Lockbox cannot tell which is good, so it leaves both files
  alone and remembers that slot as unverified. Until that slot is replaced, any header write that would copy it over
  the other file is refused with a fixed message ("header copies disagree"). Regenerating the recovery key replaces the
  recovery slot, and changing the password replaces the password slot, so each is allowed when it is the unchecked one,
  and clears the block. *Accepted:* the user may have to replace the unchecked credential first.
- **A header changed outside Lockbox must be accepted before any other header change.** While the "changed outside
  Lockbox" warning is pending, changing the password or regenerating the recovery key is refused ("accept the header
  change first"), so the authentic `.bak` is never overwritten by the edited header before the user agrees. There is
  no "decline" yet; the app's screen for it comes in Plan 3.
- **Both at once.** If the header was changed and a slot is unverified, accepting writes each file with the accepted
  name and date and a fresh stamp but keeps that file's OWN version of the unverified slot (the stamp does not cover
  slots, so nothing unchecked is thrown away and no copy is preferred). The consent clears; the slot block stays, and
  replacing that slot (regenerate the recovery key, or change the password) ends it, so the other credential is not
  needed. *Accepted:* until then the two files differ in that slot.
- **After a failed header write, Lockbox does not trust what it finds.** It reads `vault.json` back and accepts it
  only if it is exactly the previous header state or the intended one (it does not prove who wrote it; the previous
  state may itself hold edits made outside Lockbox). Anything else, or a read that fails, means Lockbox cannot
  establish the state, so every later header write on that open vault is refused until the vault is reopened. While two
  copies disagree on a key slot, any failed header write blocks this way without a read-back, because the per-file slots
  cannot be kept in step with a half-written pair; reopening re-reads both files. The original error is still
  reported. *Accepted:* the user must reopen the vault after such a failure; that includes a failed accept when the
  vault was opened from `.bak` and `vault.json` was not yet touched.
- **The Rust API still exposes internal helpers.** The core's public functions include raw keys, header writes and
  file-system helpers that skip the vault's checks. Nothing reaches a UI today (there is none), but the API does not yet
  enforce the boundary. Narrowing it to key-free views is the first job of Plan 3.
- **Odd header files read as damaged.** A `vault.json` saved with a byte-order mark (an invisible marker some editors
  add), or a version number out of range, reads as damaged rather than "update Lockbox", so Lockbox may fall back to
  `.bak` and repair the unreadable file from it. *Accepted:* only a header that passed its checks is ever copied over
  it.
- **Concurrent vault creation in one folder.** Two Lockbox processes creating vaults in the same parent folder at the
  same instant could delete each other's half-built staging folder, and a second process opening a brand-new folder in
  that instant can make the first report an error after the vault was already created (the password still works and
  the recovery key can be regenerated). *Accepted:* it takes two instances at the same moment, and a retry fixes it.
- **Windows hidden-attribute edge cases.** Lockbox hides its temporary files and un-hides them before moving them into
  place. A few unusual cases are not tested: a file with only the hidden attribute, a failure on a missing file, and
  un-hiding a temp file that is still open (it works with the sharing Rust's standard library uses, but would fail if
  the file were opened more restrictively). *Accepted:* if one went wrong, the write would report an error and clean up
  its temp file, not lose data.

### Someone who can already write inside your vault folder

These need a local attacker with write access to the vault folder or to the place you export to, which is outside what
Lockbox defends.

- **The restore journal can be edited by code running as you.** A restore keeps a small file, the restore journal,
  in your own profile folder (the app picks the place; the design uses `%LOCALAPPDATA%\Lockbox`). It records the hidden
  staging folder and the folders being swapped, so that a crash in the middle can be finished or undone at the next
  start. Before acting on it Lockbox checks it hard: the paths must be absolute and in the same folder, the names must
  have the exact shapes a restore writes, and each folder it names must be a real folder and not a link. Those checks
  guard against damage and mistakes. They do not guard against a program already running as you that writes a
  journal on purpose: it could point recovery at a staging-shaped folder it chose. *Accepted:* such a program can
  already read and delete your files, and the checks still mean recovery deletes only a folder named `.restore-` plus
  32 hex characters.
- **Swapping the export destination.** Before saving a decrypted copy, Lockbox checks that the destination is not
  inside the vault. A local attacker could swap a folder link into place between that check and the save.
  *Accepted:* the window is tiny and the attacker already has the access to cause harm. The same check, and the same
  accepted window, apply when you save a file out of a backup or a `.before-restore` folder opened read-only: the
  destination must not be the backup itself or inside the folder being viewed.
- **Linked `items/` or `files/` folders.** Cleanup and deleting quarantined files refuse to work through a link or
  junction (a Windows folder link) and report it only as a failed cleanup. A purge refuses a linked `files/` or
  `files/orphaned/` before deleting any file content. Unlocking, saving items, importing and exporting still work
  through one, and a purge's last step, deleting the item's own `items/<id>.item` file, does not yet check `items/`
  (a follow-up adds that check). *Accepted:* reaching it needs write access inside the vault folder already, and the
  steps that delete file content are guarded.
- **Non-Windows rename race (Android only).** On non-Windows systems "rename without replacing" is a check followed by a
  rename, so a racing outside process could cause a quarantined file to be replaced. Replacing a file there can also
  report failure after the new file is already in place. *Accepted:* the non-Windows code only ships with the Android
  plan; Windows uses a genuinely atomic call, and the vault lock keeps other Lockbox processes out.

### Things the format cannot detect

- **No rollback protection (spec 6.6).** Described under "What Lockbox does not protect against". *Accepted:* it needs
  the authenticated manifest of the sync design.
- **Old backups keep old passwords working.** A backup holds the vault's header as it was when the backup was made, so
  a password or recovery key you have changed since keeps opening that backup, and restoring it brings the old
  password back (spec 5.3). *Accepted:* a backup has to open with the credentials it was made with, and changing them
  does not change the vault key; full revocation needs "Rotate vault key" (v1.1). Delete backups you no longer want
  reachable.
- **Some recovery-key typos are not caught.** The 4-bit check catches a mistyped symbol about 15 times in 16 (the test
  requires at least 14 in 16); the rest simply fail to unlock. *Accepted:* a short check keeps the key easy to type.
- **Guess cost can end up below the 1-second target.** Calibration times each size once, so a noisy PC can pick
  settings that are cheaper than intended, but never below the minimum (64 MiB, 3 passes). A password change keeps the
  vault's existing settings rather than calibrating again. *Accepted:* the floor is the guarantee; the target is a goal.

### Smaller shortcuts

- A backup leaves out damaged files, and says so. If an item file fails to open, or an attached file is missing from the
  vault folder or fails its checks, the backup is still made without it, and its report counts what was left out
  (damaged items, damaged files, missing files). It is never silently complete. *Accepted:* refusing to back up at
  all would leave you with no backup of the healthy part; check the report, and keep an older backup until a clean
  one has been made.
- A restore keeps the vault it replaced until you delete it. When a restore replaces a vault, the old one is kept next
  to it as `<folder>.before-restore` (then `-2`, `-3` and so on up to `-99`; past that, a restore over that vault is
  refused until one is deleted), so a bad restore can be undone. That folder is a full copy of the old vault, readable with the
  old password, and Lockbox never deletes it for you. *Accepted:* deleting it automatically could throw away the only
  good copy; the planned interface lists these folders, to open read-only or delete.
- Every stored file is labelled `application/octet-stream`; there is no file-type table yet. *Accepted:* the label is
  only display information and the file's bytes are unaffected; how files are opened is decided with the interface.
- A stored file's name is kept as text; a name that is not valid Unicode (very rare on Windows) is stored with
  replacement characters. *Accepted:* the name is only a label shown to you, and an export goes to the name you choose.
- An item can point at a collection whose file is damaged or missing; the link is kept, so it reattaches if the
  collection is restored from a backup, and the interface is meant to show such items under "no collection". *Accepted:*
  refusing to restore the item would trap it in the trash behind a file that may never be repaired.
- Search does not fold accents: "e" does not find "é". *Accepted:* a convenience gap, not a security one; the interface
  may add it.
- The core does not cap password length (the interface will); a very long password only costs time and memory.
  *Accepted:* capping is an interface decision, and the only one who pays is the person typing it.
- A vault's creation time is stored as given and not format-checked. *Accepted:* it is display-only, covered by the
  header stamp, and checking it would need a date library for no gain.
- File-system limits (such as FAT32's 4 GiB file size) are checked through the volume's reported limits and tested with
  a simulated volume, not on real FAT media. *Accepted:* the check is simple arithmetic on what the system reports;
  testing on real media waits for the desktop app that refuses those drives.
- The word list has four hyphenated words (such as "t-shirt") that look like two words with the default `-` separator,
  and the password generator's guaranteed one-of-each-character-class rule favours small classes very slightly.
  *Accepted:* neither changes strength in a way that matters (negligible at length 8 and up); the list is used exactly
  as published.

### Not built yet

These are described in the spec but do not exist, so nothing here should be relied on yet: the desktop shell (locking,
idle timer, clipboard clearing, dialogs, the "Open" folder, the output journal that cleans up leftover decrypted files
after a crash), the vault registry, the checks on where a vault may live (refusing removable, FAT32 and network
drives; warning about OneDrive, Google Drive and Dropbox folders, spec 6.10) and the UI. The core has backup, restore
and read-only opening (Plan 2), but no screen uses them yet; choosing the restore journal's place in your profile and
running recovery at every launch are jobs of the desktop shell. Unlocking a vault can still write to it (header repair
and cleanup); to look at a vault or a backup without writing, open it read-only.

## How this is checked

Every push runs formatting, lint, the test suite (Windows and Linux; the three slow checks that are run on purpose are
left out) and a security scan (gitleaks for secrets, semgrep for risky code, osv-scanner for vulnerable
dependencies). Per the spec, a release only counts as "reviewed" when a written walk-through of this file against the
code is signed off first; none has been done because there is no release.
