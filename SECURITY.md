> **Draft — awaiting Ariel's approval.**

# Security

Lockbox is a work in progress and **has not been independently audited**. Don't store real passwords in it yet. This
file says what Lockbox is built to protect, what it does not protect, how it encrypts, and every limit we know about.
The requirements R1–R7 are defined in the
[design spec](docs/superpowers/specs/2026-10-07-lockbox-design.md#security-requirements-v1).

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
  stored; secret types print `<redacted>`. The property tests feed random and damaged input and check that no error
  repeats it.

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
  newer files. Full revocation needs "Rotate vault key", planned for v1.1 (spec 5.3).
- **Rollback and deleted item files.** An attacker who can write to the folder can put back an older valid copy of an
  item, or delete an item file, and Lockbox will not notice (R7, spec 6.6). Files that lose their item are set aside,
  not deleted. An authenticated manifest (a tamper-proof list of every file) is left for the future sync design.
- **Copies the operating system makes.** Windows may write secrets to the pagefile (memory it parks on disk), the
  hibernation file (memory saved when the PC hibernates), crash dumps (memory saved when a program crashes) or the print
  spooler (the queue of print jobs), and Lockbox cannot control that. Use full-disk encryption (BitLocker). Deleted
  files on an SSD are not guaranteed to be erased.
- **Copies made by the interface and other programs.** Text typed or shown in the app's window passes through the
  webview's memory (a browser engine, planned for the UI), which cannot be wiped as reliably as Rust's. Files you open
  with another program may be copied by that program (autosaves, recent-file lists).

## Where each requirement stands today

Only the Rust core exists (Plan 1). Requirements that need the desktop app are not met yet.

| Requirement | State |
|---|---|
| R1 Confidentiality at rest | Built into the core's file formats |
| R2 Integrity | Built: every key slot, item and file chunk is authenticated; the header has a MAC (a tamper-evident stamp) |
| R3 Guessing cost | Built: settings enforced and bounded, calibrated at creation |
| R4 No plaintext written except on request | In the core, plaintext is written only when you save a decrypted copy to a place you choose. The app's "Open" and recovery-key printing do not exist yet |
| R5 No secrets in logs and errors | Built in the core (there is no logging yet) |
| R6 Locking stops access | **Not built.** Locking lives in the desktop app (Plan 3). The core only offers a cancel switch for long operations |
| R7 Documented limits | This file |

## How Lockbox encrypts

Everything comes from well-reviewed libraries. We wrote no cryptography ourselves, only the small encoding around
it (IDs, the extra context each encryption is bound to, base64). Exact versions are pinned in `Cargo.lock`.

- **Password to key:** Argon2id (a deliberately slow, memory-hungry way to turn a password into a key), crate
  `argon2`. The password is first normalised to Unicode NFC, so the same text typed on different keyboards unlocks the
  same vault.
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

The formats are pinned by tests, including known-answer tests against published test vectors where they exist.

## Honest limits

These are the weak spots and shortcuts we know about, each with a short reason why we accept it. Where a limit is a
deliberate shortcut in the code, a `shortcut:` comment sits next to it.

### Memory and wiping

Lockbox wipes the secrets it owns when it is done with them, but wiping is best effort. Anyone who can read the
memory of the running program (malware, a debugger, a crash dump) is already past what a password manager can stop.

- **Wiping cannot reach every copy.** Rust moves values and grows buffers, which can leave earlier copies behind, and
  nothing is wiped if the process is killed or crashes (spec 5.6). *Accepted:* this is true of every program; we keep
  secrets in fixed-size wiped buffers to leave as few copies as we can.
- **Moving a key leaves a copy.** Passing a `Key32` by value can leave an unwiped copy on the stack (short-term working
  memory). *Accepted:* inherent to Rust; the vault key is shared by reference instead of copied.
- **The JSON library's scratch buffers.** When an item contains characters that JSON escapes (quotes, backslashes, line
  breaks, some non-English letters), `serde_json` copies the text through scratch buffers (temporary working memory) it
  does not wipe, in a password or note. *Accepted:* fixing it means writing our own JSON reader or patching the library;
  plain text is copied straight into wiped fields.
- **JSON error messages can quote text.** If an item that passed authentication is nevertheless malformed, the library's
  error text may quote part of it into an unwiped string before we replace it with a fixed message. *Accepted:*
  reaching it needs malformed content that was authenticated, which means a bug of ours or someone who already holds the
  vault key; guarding every field would be large and error-prone.
- **HKDF leaves two temporary blocks.** `hkdf` 0.13 does not wipe its internal pseudo-random key or its last output
  block. It affects deriving the recovery key and the header-stamp key. *Accepted:* wiping it means hand-writing HKDF
  (forbidden) or patching the crate; exploiting it needs a live memory read. We will upgrade when a release wipes them.
- **Titles, usernames and URLs are not wiped.** Item titles, login usernames and URLs, and the search index built from
  them, are ordinary strings and stay in memory until freed, even after locking. Passwords and notes are wiped.
  *Accepted:* these are less secret, and wiping only the search copy would protect nothing.
- **Other libraries' internals.** How well Argon2, SHA-2 and HMAC wipe their own working memory is up to those
  libraries. We turn on their wiping options where they exist. *Accepted:* part of using reviewed libraries.
- **If the system's random source fails, Lockbox stops** (it "panics", Rust's word for a controlled crash) rather than
  continue without randomness. *Accepted:* continuing would be worse.
- **Unlocking uses a lot of memory for a moment.** Argon2id deliberately takes 64 to 256 MiB while it runs. The
  200 MB "flat memory" check for big files was measured with the smallest accepted setting, not a typical vault's.
  *Accepted:* the memory cost is what makes guessing expensive.

### Crashes, power cuts and half-finished writes

- **Power loss is assumed safe, not proven.** Windows renames over an existing file are relied on to be atomic (all or
  nothing), though Microsoft does not formally document it. Crashes of Lockbox itself are tested; power cuts are not
  (spec 6.2). *Accepted:* it is how nearly all software saves files on Windows.
- **A stale `.bak` after a half-failed password change.** The header is stored twice (`vault.json` and
  `vault.json.bak`). If a password change writes the first and fails on the second, the change reports an error and
  `.bak` still holds the old password slot. The old password may then open the vault, from `.bak`, until the next
  successful unlock repairs it. There is no key rotation. *Accepted:* it follows from the two-copy design; and because a
  password change does not change the vault key, an old password plus any older copy of the header already works
  (see "Old copies of the vault").
- **The regenerate-recovery double fault.** A new recovery key is written to `.bak` first and then `vault.json`. If the
  second write fails, the old recovery key keeps working and the new one is never shown. If `vault.json` is then
  destroyed before the next repair, `.bak` takes over, and its recovery slot belongs to the key that was never shown,
  so recovery is lost (the password still works and a new recovery key can be made). *Accepted:* it needs two failures
  in a row; the other write order could leave a vault with no working recovery key at all.
- **A foreign `.bak` can take over an unreadable `vault.json`.** If `vault.json` cannot be read and the `.bak` is from a
  different vault that has the same password, it unlocks and repairs `vault.json`; the items then show as damaged.
  *Accepted:* the original header was already unreadable and it needs the same password.
- **A changed header can be accepted by a later change.** If the header was edited outside Lockbox (the "changed outside
  Lockbox" warning), changing the password or regenerating the recovery key before answering that warning signs the
  edited name or date again. *Accepted for now:* the app must make the user accept or decline first (Plan 3).
- **Re-reading the header after a failed write.** Lockbox re-reads `vault.json` to learn what is live. If that re-read
  also fails, or the file was swapped in that instant, it keeps its previous idea of the header. *Accepted:* a double
  fault, or an outside actor at that exact moment.
- **Odd header files read as damaged.** A `vault.json` saved with a byte-order mark (an invisible marker some editors
  add), or a version number out of range, reads as damaged rather than "update Lockbox", so Lockbox may fall back to
  `.bak` and repair the unreadable file from it. *Accepted:* only a header that passed its checks is ever copied over
  it.
- **Concurrent vault creation in one folder.** Two Lockbox processes creating vaults in the same parent folder at the
  same instant could delete each other's half-built staging folder, and a second process opening a brand-new folder in
  that instant can make the first report an error after the vault was already created (the password still works and
  the recovery key can be regenerated). *Accepted:* it takes two instances at the same moment, and a retry fixes it.
- **Windows hidden-attribute edge cases.** Lockbox hides its temporary files and un-hides them before moving them into
  place; a few unusual cases (a file with only the hidden attribute, a failure on a missing file) are not tested.
  *Accepted:* if one went wrong, the write would report an error and clean up its temp file, not lose data.

### Someone who can already write inside your vault folder

These need a local attacker with write access to the vault folder or to the place you export to, which is outside what
Lockbox defends.

- **Swapping the export destination.** Before saving a decrypted copy, Lockbox checks that the destination is not
  inside the vault. A local attacker could swap a folder link into place between that check and the save.
  *Accepted:* the window is tiny and the attacker already has the access to cause harm.
- **Linked `items/` or `files/` folders.** Cleanup refuses to work through a link or junction (a Windows folder link)
  and reports it only as a failed cleanup. Unlocking, purging and exporting still work through one. *Accepted:*
  reaching it needs write access inside the vault folder already; the guard covers the steps that delete or move
  files (cleanup, deleting quarantined files).
- **Non-Windows rename race (Android only).** On non-Windows systems "rename without replacing" is a check followed by a
  rename, so a racing outside process could cause a quarantined file to be replaced. Replacing a file there can also
  report failure after the new file is already in place. *Accepted:* the non-Windows code only ships with the Android
  plan; Windows uses a genuinely atomic call, and the vault lock keeps other Lockbox processes out.

### Things the format cannot detect

- **No rollback protection (spec 6.6).** Described under "What Lockbox does not protect against". *Accepted:* it needs
  the authenticated manifest of the sync design.
- **Some recovery-key typos are not caught.** The 4-bit check catches a mistyped symbol 15 times in 16; the rest
  simply fail to unlock. *Accepted:* a short check keeps the key easy to type.
- **Guess cost can end up below the 1-second target.** Calibration times each size once, so a noisy PC can pick
  settings that are cheaper than intended, but never below the minimum (64 MiB, 3 passes). A password change keeps the
  vault's existing settings rather than calibrating again. *Accepted:* the floor is the guarantee; the target is a goal.
- **Not independently audited.** No independent security expert has audited Lockbox, and none is planned (spec 11).
  *Accepted:* the project's answer is tests, a written walk-through of this file against the code before each release,
  and honesty about what is not covered.

### Smaller shortcuts

- Every stored file is labelled `application/octet-stream`; there is no file-type table yet.
- A stored file's name is kept as text; a name that is not valid Unicode (very rare on Windows) is stored with
  replacement characters.
- An item can point at a collection whose file is damaged or missing; the link is kept, so it reattaches if the
  collection is restored from a backup, and the interface is meant to show such items under "no collection".
- Search does not fold accents: "e" does not find "é".
- The core does not cap password length (the interface will); a very long password only costs time and memory.
- A vault's creation time is stored as given and not format-checked. It is display-only and covered by the header stamp.
- Windows file-system limits (such as FAT32's 4 GiB file size) are checked through the volume's reported limits and
  tested with a simulated volume, not on real FAT media. Removable, FAT32 and network drives are meant to be refused by
  the desktop app (Plan 3), which does not exist yet.
- The word list has four hyphenated words (such as "t-shirt") that look like two words with the default `-` separator.
  The password generator's guaranteed one-of-each-character-class rule favours small classes very slightly; the effect
  on strength is negligible at length 8 and up.

### Not built yet

These are described in the spec but do not exist, so nothing here should be relied on yet: the desktop shell
(locking, idle timer, clipboard clearing, dialogs, the "Open" folder, the output journal that cleans up leftover
decrypted files after a crash), backup and restore, opening a backup read-only, the vault registry and the UI.
Until read-only opening exists, unlocking a vault can write to it (header repair and cleanup).

## How this is checked

Every push runs formatting, lint, the test suite (Windows and Linux; the two slow checks that are run on purpose are
left out) and a security scan (gitleaks for secrets, semgrep for risky code, osv-scanner for vulnerable
dependencies). Per the spec, a release only counts as "reviewed" when a written walk-through of this file against the
code is signed off first; none has been done because there is no release.
