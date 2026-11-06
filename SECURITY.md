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
  not deleted. An authenticated manifest (a tamper-proof list of every file) for the live vault is left for the future
  sync design. A backup already has one: restore and "test a backup" check every entry against it, so no entry of a
  backup can be swapped for an older one (an older backup as a whole still opens).
- **Copies the operating system makes.** Windows may write secrets to the pagefile (memory it parks on disk), the
  hibernation file (memory saved when the PC hibernates), crash dumps (memory saved when a program crashes) or the print
  spooler (the queue of print jobs), and Lockbox cannot control that. Use full-disk encryption (BitLocker on Windows Pro
  and above; "Device encryption" on supported Home PCs). Deleted files on an SSD are not guaranteed to be erased.
- **Copies made by the interface and other programs.** Text typed or shown in the app's window passes through the
  webview's memory (WebView2, a browser engine), which cannot be wiped as reliably as Rust's. Files you open with
  another program may be copied by that program (autosaves, recent-file lists, temp files).
- **Programs that read the clipboard while a copy is on it.** Copied passwords stay out of Windows clipboard history
  and cloud clipboard, but any program running as you can read the clipboard until it is cleared.

## Where each requirement stands today

The Rust core (Plans 1 and 2) and the desktop shell (Plan 3) exist. The real screens come in Plan 4; the app shows a
bare test page until then.

| Requirement | State |
|---|---|
| R1 Confidentiality at rest | Built into the core's file formats |
| R2 Integrity | Built: every key slot, item and file chunk is authenticated; the header has a MAC (a tamper-evident stamp); a backup carries a MAC-protected list of its contents, and restore checks every entry against it |
| R3 Guessing cost | Built: settings enforced and bounded, calibrated at creation |
| R4 No plaintext written except on request | Built: plaintext is written only for "Save a copy", to a place you choose, and for "Open", into a folder only you can reach. A crash can leave a hidden partial copy until the next launch (see "Honest limits"). Backup, restore and copying an item between vaults never write plaintext. Recovery-key printing, an export and a saved `.env` come with the screens (Plan 4) |
| R5 No secrets in logs and errors | Built in the core and the shell: errors reaching the page carry fixed text and numbers only. There is no logging; debug builds print each Windows signal's name, and a removed drive's letter mask, and nothing else |
| R6 Locking stops access | Built in the shell (see "Locking" below). The page's half (clearing what it shows) comes with the screens (Plan 4); today's test page and the bridge drop stale answers |
| R7 Documented limits | This file |

## How the app is locked down

The shell sits between the screens and the engine. The screens run in a webview, and we treat what runs there as less
trusted than Rust.

- **Permissions.** Each Lockbox command has its own permission, and one capability grants them to the main window only.
  The page's only other permissions are listening to and un-listening from events. It has no file, shell, HTTP, opener or
  dialog permissions, and a test pins the exact set.
- **Content Security Policy.** Scripts, styles, images and fonts come only from the app itself (images also from `data:`).
  It can connect only to the IPC bridge, no remote content is ever loaded, and inline scripts and styles are refused.
- **Requests.** Every command parses its own request strictly and refuses unknown fields. A malformed one gets a fixed
  error, never the parser's text, which could quote what was sent. Tauri's own event commands and its transport can
  answer with text built from what the page sent, so screens must never pass a secret to them; that text goes only back
  to the page.
- **Paths.** Commands take IDs and values, never paths. Rust opens every file dialog, so a chosen path never comes from
  the page. Paths go to the page in one case only: a restore that cannot finish (its notice, and the question before
  dismissing it) shows your own folders so you can act on them. Stored links are opened from Rust, and only for `http` and `https`.
- **The window.** It navigates only within the app, opens no other windows and downloads nothing. Tauri's drag-and-drop
  handler and WebView2's external drop are off, and the page cancels drops as well, so dropped files reach neither the
  page nor Rust. The app does not start if WebView2 cannot confirm that. WebView2's autofill is off and the webview runs
  without a persistent profile, so typed titles, usernames and searches are not kept on disk.
- **What crosses to the page.** Vault keys, file keys and file contents never do. A stored password does only on
  "Reveal" or while editing: copying runs entirely in Rust. The recovery key crosses once, when it is made, for display,
  and the generator's output crosses as a new value. Search runs in Rust and returns only what is shown.

## Locking

- **What locks.** Idle for the set time (1 to 60 minutes, default 5; no keyboard or mouse input anywhere in Windows),
  Windows lock, sleep, hibernate, signing out, switching user, a remote-desktop disconnect, shutdown, and closing the
  app. Windows lock and sleep lock every vault at once. A vault whose drive goes away locks and shows as unavailable.
- **Two guarantees, kept separate.** Access is denied at once: from the moment of locking no new command runs, an answer
  already on its way is refused by Rust, and one that still reaches the page is dropped by the bridge, because its
  generation number is old. Work stops soon after: an operation that streams data stops at its next check, at most 1 MiB
  of work later (that bounds the work, not the time), and the vault key is released when the last one finishes. Two
  exceptions: an unlock runs to its end (see "Unlocking cannot be cancelled inside the engine"), and a restore whose swap
  has started finishes or rolls back.
- **Long operations pause the idle timer** (import, Save a copy, Open, backup, restore) and keep the PC awake, and time
  spent in them does not count. Windows lock and sleep still cancel them. A question waiting for your answer does not
  pause anything.
- **The app does not start** if it cannot listen for Windows lock and sleep.

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

### The desktop app

- **Unlocking cannot be cancelled inside the engine.** A lock during an unlock (the password check of about a second,
  loading the items, then cleanup) discards the result when the unlock returns, and its key goes with it. The vault never
  shows as unlocked, but until then the key is in memory after the lock. No deadline limits this: a very large or slow
  vault takes longer. *Accepted:* the target is under 3 s for 5 000 items, the cleanup resumes at the next unlock, and
  nothing is delivered.
- **IPC buffers are not wiped.** Typed passwords arrive and revealed values leave as JSON text inside Tauri's message
  buffers, which Lockbox does not own. The fields Rust parses them into are wiped when they are dropped; a password kept
  for a question waiting for your answer lives until the answer, the five-minute limit or a lock of all vaults, and one
  typed before a file or folder picker lives until that picker closes, even past a lock (nothing is done with it then).
  *Accepted:* wiping the buffers would mean replacing Tauri's transport.
- **Webview memory is not wiped.** Values typed or shown in the window live in WebView2's memory until the browser engine
  frees them. The screens clear their state at a lock, but that releases the text; it does not erase it. *Accepted:*
  no browser engine offers more. Keep the time a password is revealed short.
- **The clipboard.** A copy carries the three Windows formats that keep it out of clipboard history, out of cloud clipboard
  and away from monitors that honour them (`CanIncludeInClipboardHistory`, `CanUploadToCloudClipboard`,
  `ExcludeClipboardContentFromMonitorProcessing`). The text is written last, so if any format cannot be set the password
  never reaches the clipboard and the copy fails. These formats are a request: a program that ignores them, or one that simply reads the clipboard, can still get the password
  while it is there. Lockbox clears it after the delay (10 to 300 seconds, default 30), at a lock of its vault and at
  close, and only if the copy's own random tag is still there, so a later copy of yours is left alone. Another program
  holding the clipboard open delays the clear: Lockbox keeps trying while it runs, and at close it tries until its 2 s
  deadline, so a password can stay behind after a normal exit if the clipboard stays busy. If Lockbox is killed, or the PC
  loses power, before the clear, the password also stays until something replaces it. *Accepted:* this is how the
  clipboard works on Windows, and you asked for the copy.
- **"Open" writes a decrypted copy to disk.** It goes in `%LOCALAPPDATA%\Lockbox\open\<random>\`, a folder only your
  Windows user can reach, read-only, and only after the whole file has verified. Edits are not saved back. The copy
  carries Windows' internet mark, so Office blocks its macros and Windows warns as for a download; to use macros, use
  "Save a copy". Types that can run code ask first, judged on the cleaned-up name and on Windows' own opinion of the type. Copies
  go at the lock, at close and at the next launch, and a file another program holds open cannot be deleted until it lets
  go: Lockbox reports it and keeps trying. Deleted files can still be recovered from the disk, and copies the other
  program makes (autosaves, recent-file caches, temp files) are outside Lockbox's reach. *Accepted:* opening a file in
  another program needs a file on disk; full-disk encryption covers the rest.
- **What the launch sweep deletes.** Every temp plaintext file is recorded in `pending-outputs.json` (by its random temp
  path, never the original name) before it is created. At launch, an entry is deleted only if it has Lockbox's own temp
  name (`.<16 hex>.lockbox-partial`, `.<16 hex>.lockbox-backup-partial`) or is a folder directly inside `open\`, and only
  if no link is anywhere along its path. Anything else is dropped from the list and left on disk. An entry on a drive that
  is not connected is kept for later. A damaged journal blocks new decrypted output until you let Lockbox set it aside;
  after that, any "Save a copy" temp files it listed are no longer swept and may need deleting by hand (they are hidden,
  named as above, and beside the place you saved to). The launch also lists `open\` itself, damaged journal or not, and removes folders named exactly 32 lowercase hex under the
  same no-link rule. The check runs again before each delete attempt, but it is a check followed by a delete, not one step:
  a program already running as you could swap something in between, and only a victim carrying one of those names could be hit.
  *Accepted:* such a program can already delete your files.
- **State files can be edited by code running as you.** `vaults.json`, `settings.json` and `pending-outputs.json` in
  `%LOCALAPPDATA%\Lockbox\` are not authenticated, only size-capped and strictly parsed. Such a program could add a vault
  to the list, raise the idle time or clipboard delay to their limits (a value out of range gives the defaults), or
  empty the output journal so a leftover stays. They hold no secrets. *Accepted:* the same reasoning as the restore
  journal (see "Someone who can already write inside your vault folder").
- **Cloud folders.** A vault in a OneDrive, Google Drive or Dropbox folder is not refused. The shell asks first when one is
  created or added, and reports it at each unlock for the screen to warn (Plan 4; the test page does not show that
  one). They are found by asking Windows about sync roots, then by each provider's known location,
  so a provider that does neither goes unnoticed. Syncing can leave conflicting copies of vault files, and old versions on
  the provider's servers. *Accepted:* v1 does not support these folders, and the warning says so.
- **A USB hard drive that reports as fixed is accepted** (the checks use what Windows reports). Unplugging it locks its
  vault as unavailable. This path has been tested with simulated signals; the check with a real drive is on the
  pre-release list. A different disk mounted under the same drive letter is not told apart at recovery, which checks that
  the parent folder is present, not that it is the same disk. *Accepted:* rare, and recovery's checks on names and folders still hold.
- **Windows' lock signals are tested on one PC.** It has S3 sleep only; Modern Standby is on the pre-release list for
  another laptop. *Accepted for now:* the app is not released.
- **Browser shortcuts and menus are off, but only as far as WebView2 offers.** The window is built hidden, and shows only
  after WebView2 confirms its browser keys and default context menu are off; if it can't confirm, Lockbox stops. Tested on
  2026-11-06: Ctrl+P, F12, Ctrl+Shift+I, F5, Ctrl+R, Ctrl+U and right-click open nothing, while Ctrl+F, copy and paste still
  reach the page. Lockbox prints only through its own code (the recovery key, once its screen exists), and anything printed
  can pass through the print spooler (see above). *Accepted:* this is WebView2's documented switch; there is no stronger one.
- **Staying out of screen capture isn't a guarantee.** At every start Lockbox asks Windows to leave its window out of
  screenshots, recordings, screen sharing and Recall (`WDA_EXCLUDEFROMCAPTURE`), before the window shows. Tested on
  2026-11-06: screenshots and Snipping Tool leave Lockbox out, and Magnifier still shows it in Full screen,
  Docked and Lens, judged by eye, since a screenshot of Magnifier loses Lockbox too. Not tested yet: Quick Assist and remote
  desktop (pre-release list). If asking fails, the window still shows. Microsoft says there's no guarantee, and a camera can
  always get round it. *Accepted:* this is the strongest request Windows offers; a setting to turn it off comes with the
  Settings screen.
- **No isolation frame.** Tauri's isolation pattern (a sandboxed frame that checks every IPC message) is not used (Ariel's
  pick, 2026-11-05, against Tauri's own advice). Tauri 2.12.5's frame runs scripts only, with no same-origin access, and
  a reported bug hangs every call on Windows; its check also can't tell the app's own calls from a bad package's on the
  same page. Instead: exact versions, install scripts off, the lockfile in the dependency scan, and no packages beyond
  the reviewed ones. A test pins the setting. *Accepted:* a compromised package in the page could send commands the page
  can send; keys never leave Rust.
- **Small windows we chose not to close.**
  - A lock arriving during the very last write of an item copy does not stop it. The page hears "locked", and the item is
    in the destination vault as you asked, even if only the source vault locked; it can be read there while that vault
    stays unlocked.
  - A lock that lands between the last check and Windows opening a file: the viewer may still open, or finds the copy gone.
  - Deleting a `.before-restore` folder as you open it is decided by which comes first, after you confirmed the delete.
  - A failed keep-awake request is not retried, so sleep then locks and cancels the operation (the safe side).
  - A lock of the destination while a restore is still extracting ends it when extraction finishes, not before.
  - A destination vault unlocked after a restore was prepared, then locked in the instant you confirm: the restore goes
    ahead, and the old vault is kept as its `.before-restore` folder.
  - If Windows refuses the thread that removes "Open" copies at a lock, they stay until the next lock, close or launch,
    with no message.

  *Accepted:* in each the worst outcome is something you had already asked for, a delay, or a copy left in the private
  "Open" folder until the next cleanup.
- **A file dialog stays open across a lock.** Windows' dialogs cannot be closed from outside, so a save dialog already open
  keeps showing the suggested file name after a lock. Nothing happens when it is answered: the command answers "locked".

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
- **If the system's random source fails, the core stops that operation** (it "panics", Rust's word for a controlled crash)
  rather than continue without randomness; a command running on a worker thread then answers "cancelled", and a clipboard
  copy's tag simply fails that copy. *Accepted:* continuing would be worse.
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
  you chose to export), until the next launch: the output journal, a record of temp files, lets the launch sweep delete
  it (see "What the launch sweep deletes"). A leftover on a drive that is not connected waits until it is. A normal
  failure or cancel tries to remove the temp file at once; if that fails, it stays recorded for the sweep. *Accepted:* it
  is a copy you asked to have in plaintext, it is hidden, and the sweep removes it.
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
  no "decline" yet; the app's screen for it comes in Plan 4.
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
- **No backup while a header question waits for you.** A backup is refused while a header change made outside
  Lockbox waits to be accepted ("accept the header change first"), while the two header copies disagree on a key slot
  ("header copies disagree; replace the unchecked credential first"), and while the header state is unknown after a
  failed header write ("header state unknown; reopen the vault"). *Accepted:* a backup made then would keep a header
  nobody has checked; accepting the change, replacing the unchecked credential or reopening the vault ends it.
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
  in your own profile folder (`%LOCALAPPDATA%\Lockbox`). It records the hidden
  staging folder and the folders being swapped, so that a crash in the middle can be finished or undone at the next
  start. Before acting on it Lockbox checks it hard: the paths must be absolute and in the same folder, the names must
  have the exact shapes a restore writes, and each folder it names must be a real folder, not a link, a junction or
  another reparse point that redirects the path. Those checks guard against damage and mistakes. They do not guard
  against a program already running as you that writes a journal on purpose: it could point recovery at a
  staging-shaped folder it chose. *Accepted:* such a program can already read and delete your files, and the checks
  still mean recovery deletes only a folder named `.restore-` plus 32 hex characters.
- **Swapping the export destination.** Before saving a decrypted copy, Lockbox checks that the destination is not
  inside the vault. A local attacker could swap a folder link into place between that check and the save.
  *Accepted:* the window is tiny and the attacker already has the access to cause harm. The same check, and the same
  accepted window, apply when you save a file out of a backup or a `.before-restore` folder opened read-only: the
  destination must not be the backup itself, inside the folder being viewed, or inside any vault folder (a folder
  that holds `vault.json` or `vault.json.bak`, or any folder under one), so, outside that window, a saved copy cannot
  replace a vault's own files.
- **Linked `items/` or `files/` folders.** Cleanup and deleting quarantined files refuse to work through a link, a
  junction or another reparse point that redirects the path (what Windows calls a "name surrogate"), and report it
  only as a failed cleanup. Cloud-sync placeholders, such as OneDrive's, are accepted, because they do not redirect. A
  purge refuses a linked `files/` or `files/orphaned/` before deleting any file content. Unlocking, saving items,
  importing and exporting still work through one; a purge also refuses a linked `items/`, before its mark and again
  before it deletes the item's own file. Opening a folder read-only is stricter than
  unlocking it: it refuses a vault folder that is itself a link, and a linked `items/`, though a writable unlock opens
  both; a linked `files/` does not stop it, and each file read through one is still authenticated. *Accepted:*
  reaching it needs write access inside the vault folder already, and the steps that delete file content are guarded.
- **Non-Windows rename race (Android only).** On non-Windows systems "rename without replacing" is a check followed by a
  rename, so a racing outside process could cause a quarantined file to be replaced. Replacing a file there can also
  report failure after the new file is already in place. *Accepted:* the non-Windows code only ships with the Android
  plan; Windows uses a genuinely atomic call, and the vault lock keeps other Lockbox processes out.

### Things the format cannot detect

- **No rollback protection for the live vault (spec 6.6).** Described under "What Lockbox does not protect against".
  *Accepted:* it needs the authenticated manifest of the sync design.
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
- A backup holds at most 250 000 entries (items and stored files together); a vault with more is refused ("too large:
  backup entries"). *Accepted:* the limit bounds the lists a backup's reader has to take in, and it is far above what
  a personal vault holds.
- A restore keeps the vault it replaced until you delete it. When a restore replaces a vault, the old one is kept next
  to it as `<folder>.before-restore` (then `-2`, `-3` and so on up to `-99`; past that, a restore over that vault is
  refused until one is deleted), so a bad restore can be undone. That folder is a full copy of the old vault, readable
  with the old password, and Lockbox never deletes it for you. *Accepted:* deleting it automatically could throw away
  the only good copy; the shell lists these folders, to open read-only or delete.
- Dismissing a stuck restore (one that recovery cannot finish) while its drive is not connected removes only the
  restore journal. The hidden staging folder (`.restore-` plus 32 hex characters) stays on that drive, and nothing
  removes it later. It is an encrypted copy of the vault in the backup (complete if the restore had finished copying
  it), and it still opens with the backup's password. When the drive is back, delete that folder by hand (Plan 4's
  dialog will say so), unless the swap was left half done. A swap that replaces a vault moves the old one aside to
  `<folder>.before-restore` (or `-2` and so on), then moves the restored copy into its place; if it stopped between
  the two (the drive went away, say), recovery would move the old vault back, but a dismissal does not. So once the
  drive is back, the vault's own folder is missing, the old vault is in that `.before-restore` folder and the
  restored copy is in the staging folder. No data is lost. To keep the old vault, rename that `.before-restore`
  folder back to the vault folder's name; to take the restored one, un-hide the staging folder and rename it to that
  name. Then delete the other when you no longer need it. Reconnecting the drive and letting recovery run, instead
  of dismissing, is the better way out: it moves the old vault back and removes the staging folder itself. Plan 4's
  dialog should offer it first. *Accepted:* dismissing is your confirmed way out of a restore that cannot finish, so
  it has to work without the drive, and the folder holds nothing the backup itself does not.
- A new vault, and a restore that makes a new folder, are refused anywhere under a folder holding a file named
  `vault.json` or `vault.json.bak`, so one is never nested inside another. An unrelated file of that name higher up (in
  your profile folder, say) refuses them too. *Accepted:* rare, the error says why, and another folder gets round it.
- A vault whose two header files are both unreadable cannot be restored in place. Restore cannot tell that its folder
  is that vault, so it makes a new folder; while the damaged one still has the name Lockbox gave it, that name is
  taken, and the restore stops ("destination exists") before writing anything. The restore dialog then offers a new
  folder you name, beside the damaged one (for example `Family-1a2b3c4d (restored)`): the backup is restored there, and
  the damaged folder is left exactly as it was, for you to delete once you no longer need it. A new folder is refused,
  again before anything is written, while a readable copy of the same vault is in that folder ("vault already here":
  two working copies would make every later restore there refuse "several copies"), when its name is not one plain
  Windows folder name (at most 200 characters as Windows counts them, no `\ / : * ? " < > |`, no leading dot, no
  trailing dot or space, no device name such as `CON` or `NUL.txt`, and no `.before-restore`), and when anything at
  all already has that name, in any letter case. *Accepted:* restore never replaces a folder it cannot identify, since
  that folder may hold data the backup does not.
- An item whose attached file the backup left out (missing or damaged when the backup was made), or whose file is
  gone from a `.before-restore` folder, is not copied out of it by default: the copy stops ("file missing") before
  anything is written. On request, the copy goes ahead without those files and reports which ones it left out; the
  item's other files are copied in full. A file that is there but damaged, or that disappears while the copy runs,
  still stops the whole copy. The files it had already copied are then removed; one that cannot be removed stays
  unused, and the next unlock sets it aside. *Accepted:* a missing file cannot be brought back from that source, and
  the copy never leaves one out unless you ask.
- Every stored file is labelled `application/octet-stream`; there is no file-type table yet. *Accepted:* the label is
  only display information and the file's bytes are unaffected. "Open" goes by the cleaned-up file name and Windows' default
  program for it.
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
  a simulated volume, not on real FAT media. *Accepted:* the check is simple arithmetic on what the system reports, and
  the desktop app refuses those drives for vaults; a decrypted copy or backup saved to one still relies on this check.
- The word list has four hyphenated words (such as "t-shirt") that look like two words with the default `-` separator,
  and the password generator's guaranteed one-of-each-character-class rule favours small classes very slightly.
  *Accepted:* neither changes strength in a way that matters (negligible at length 8 and up); the list is used exactly
  as published.

### Not built yet

These are described in the spec but do not exist, so nothing here should be relied on yet: the real screens and
everything they do (the wording of warnings, recovery-key printing, clearing what is shown at a lock), the end-to-end
tests on the running app, and the installer. Today's bare test page exposes selected checks; the shell's other commands
exist with no button yet. Unlocking a vault can still write to it (header repair and cleanup); to look at a vault or a backup without writing,
open it read-only.

**Limits that come with the screens** ([Plan 4 design](docs/design/2026-11-05-user-interface-design.md)). None of this exists
yet; each moves up to the sections above as it's built.

- **The save shortcut reads the clipboard once, each time it's pressed.** The only other read is when you ask Lockbox to clear
  that value: it compares what's on the clipboard, and drops it if it's different. The value waits in one wiped
  slot in Rust until it's saved or the slot empties. Clearing it afterwards may not reach a copy Windows clipboard history already
  took, because a value copied from another app usually carries none of Lockbox's marks. Tested on 2026-11-05: a value copied
  from Notepad stayed in Win+V after the clear, so clear it from Win+V too (Win+V, then the entry's menu).
- **An export, a saved `.env` and files saved out are readable by anyone who gets them.** They aren't encrypted. An export or a
  `.env` warns first, and saving a folder's files says so in the folder picker. Lockbox can't protect them or delete them afterwards. Deleting one may leave it in the Recycle Bin, on an SSD, or in a
  cloud provider's version history.
- **Earlier passwords stay in old backups.** They're encrypted like everything else, and dropping one from a login doesn't remove
  it from a backup already made.
- **Asking for the current password slows someone at an unlocked PC.** It isn't protection against malware (spec 5.6), and there's
  no lockout.
- **File names in search.** The search index will hold attached file names, so they join the titles and usernames under "Titles,
  usernames, URLs and attached file names are not wiped".

## How this is checked

Every push runs formatting, lint, the test suite (the engine on Windows and Linux, the desktop app on Windows, the UI's
tests and build; the three slow checks that are run on purpose are left out) and a security scan (gitleaks for secrets, semgrep for risky code, osv-scanner for vulnerable
dependencies). Per the spec, a release only counts as "reviewed" when a written walk-through of this file against the
code is signed off first; none has been done because there is no release.
