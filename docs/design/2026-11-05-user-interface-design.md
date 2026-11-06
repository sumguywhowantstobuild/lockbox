# User interface (Plan 4): design

**Date:** 2026-11-05 · **Author:** Ariel Maningas · **Status:** approved by Ariel, 2026-11-05; results of the first build checks added 2026-11-06 ([Results of the risky checks](#results-of-the-risky-checks)), and two changes from Task 5's hands-on and review (the vault mark, what the page does when a lock event is lost)

The product side is in the [PRD](../PRD.md); the engine, vault format and security rules are in the
[design spec](2026-10-07-lockbox-design.md), cited here as "spec 7.3" and so on. This document is what the screens do and
what has to be built under them. Tags on decisions: **Ariel** (Ariel decided, with the date), **standard** (common
practice for this kind of app), **my call** (the author's choice, open to correction at approval).

## Context

Plans 1 to 3 built the engine and the desktop shell: 57 commands, and one test page. There is no real user interface.
Plan 4 builds it. People use it, so this is also where several requirements meet real life: strangers will download it
(Ariel, 2026-11-04), so it has to explain itself, and it has to work with a screen reader, by keyboard and on a small
laptop.

The design was worked out in this order (Ariel, 2026-11-03: mockups before the plan): every task a person comes to do
(36 of them), the steps of each including what goes wrong, one screen for each step, the look, then checks. The result is
146 screens, in light and dark, linked into clicks. They are kept with the project's private design notes; this document
carries their decisions, and screen numbers such as 8a refer to them (task 8, first screen). "Ask 3" is the third moment
the app itself has to ask something.

What the screens have been checked for (2026-11-04 and 11-05): automated contrast (0 failures), nothing cut off at
1093×534, Windows high contrast (it was badly broken, and is fixed), display scaling, real clicks along the main paths, a
real window at the real title bar size. **Known gaps in those checks:** Windows' "make text bigger" setting, real screen
reader use, and Windows 10 were not covered; they are in [Testing](#testing).

## Goals and non-goals

**Goals**
- All 36 tasks and every moment the app has to ask work, on real commands, and look like the approved screens.
- Strangers can get started and recover from mistakes without help.
- Every screen works by keyboard, with a screen reader, in high contrast, and in a 1093×534 window.
- Nothing weakens the rules already set: keys never leave the engine, the page never receives a path it can send back,
  and every answer is tagged with its session generation (spec 4.1, 4.2, 7.4).

**Non-goals**
- Updates (task 19), the installer and download (task 20) and uninstall (task 35): see [Out of scope](#out-of-scope).
- A new vault format. Items gain fields, inside the rules the format already has (spec 6.1).
- A second platform. The UI stays web technology, so it could travel to Phase 3, but nothing is done for that now.

## The tasks

Numbers are used throughout. Screens that show each one are listed by number.

| # | Task | Screens |
|---|---|---|
| 1 | Open and unlock a vault | 1a to 1d |
| 2 | Sign in to a website: open it, copy username, copy password | 2a to 2f |
| 3 | Find a key or item, reveal or copy it | 3a to 3h |
| 4 | Search with Ctrl+F or Ctrl+K and act on the result | 4a to 4c |
| 5 | Lock: one vault, all, close to the tray, or walk away | 5a to 5d |
| 6 | Add a login, with the generator | 6a to 6d |
| 7 | Add a key or a note | 7a, 7b |
| 8 | Save a key just copied from a website | 8a to 8e |
| 9 | Store files, or attach them | 9a to 9g |
| 10 | Open a stored file, save a copy, replace it | 10a to 10f |
| 11 | Edit an item; earlier passwords | 11a to 11c |
| 12 | Move an item to a folder | 12a |
| 13 | Delete an item, or get it back | 13a to 13d |
| 14 | Create, rename or delete a folder | 14a to 14d |
| 15 | Paste a whole `.env` in, or take a folder's keys out | 15a to 15f |
| 16 | Generate a password on its own | 16a (16b waits for v1.1) |
| 17 | Show one kind, sort | 17a to 17c |
| 18 | More vaults: create, switch, rename, remove | 18a to 18g (18e waits for v1.1) |
| 21 | First-time setup and the recovery key | 21a to 21g |
| 22 | Back up a vault | 22a to 22d |
| 23 | Test a backup | 23a to 23d |
| 24 | Restore a backup; older copies | 24a to 24g |
| 25 | Open a backup read-only, copy items out | 25a to 25d |
| 26 | Move to a new computer | 26a to 26c |
| 27 | Change the password | 27a to 27c |
| 28 | Forgot the password | 28a to 28e |
| 29 | Make a new recovery key | 29a to 29c |
| 30 | Add back a moved vault, remove one | 30a, 30b, 18g |
| 31 | Settings | 31a, 31b |
| 32 | Empty the trash | 32a, 32b |
| 33 | Quit from the tray | 33a, 33b |
| 34 | Export to a readable file | 34a to 34c |
| 36 | Get help | 21g, 31a |

Tasks 19, 20 and 35 are out of scope here. The one-screen stand-ins are worth knowing when building: Edit is drawn once,
for a login, so a key's, note's and file's Edit forms follow 7a, 7b and 10f; Reveal is drawn once, on a key (3d).

## Options considered

### What to build the screens from

| Option | For | Against |
|---|---|---|
| **Headless parts** (behaviour and accessibility from a library, every pixel from our style sheet) | Keeps the approved look as drawn; dialogs, menus and lists get keyboard and screen reader behaviour that has been tested widely | One more dependency in a password manager's page |
| Hand-written parts on native HTML (`<dialog>`, `<select>`) | No dependency | Menus, comboboxes and focus handling are where hand-written accessibility goes wrong, and screen reader work is a v1 requirement |
| A finished kit (Fluent UI React 9.75, MIT, active) | Native Windows feel, fast to start | Fights the approved look: every screen would need overriding, and the look was already chosen by Ariel |

**Headless candidates, checked at their source on 2026-11-05.** All four are active and open source. "Style tags" matters
because the app's Content Security Policy (`style-src 'self'`) refuses `<style>` elements; style properties set by script
are allowed.

| Library | Version, licence | Style tags in the package | Notes |
|---|---|---|---|
| **Base UI** | 1.9.0, MIT | Yes, in its scroll area and select, and its CSP provider's `disableStyleElements` turns them off | From the Radix and Material UI people; its CSP handling is documented |
| React Aria Components | 1.22.1, Apache-2.0 | Yes: `react-aria` 3.53.1, which it depends on, creates them in `usePress` and `usePreventScroll`. No switch found | From Adobe. Known for screen reader testing across browsers (general knowledge, not measured). The policy would block those tags, with an error in the console each time; what they do is unchecked |
| Radix Primitives | Dialog 1.3.1, Select 2.4.1, MIT | None found in those two | Widely used; split into many packages. Other parts unchecked |
| Ark UI | 5.40.0, MIT | Not checked | Smaller user base; nothing it offers over the others for this app |

These searches read only the named packages, so the first build task proves the choice under the real policy (see
[Testing](#testing)).

### Other choices, each decided in [Decision](#decision)

- **The list of items.** A virtual list (`@tanstack/react-virtual` 3.14, MIT) keeps only visible rows on the page, but
  hides the rest from screen readers' reading order and adds work. CSS `content-visibility: auto` keeps every row on the
  page and skips drawing those out of view, with no dependency.
- **The save shortcut.** `tauri-plugin-global-shortcut` 2.4 (MIT or Apache-2.0, active) or Windows' `RegisterHotKey`
  directly, on the hidden window the shell already runs for Windows signals, through the `windows-sys` it already uses.
- **Start with Windows.** `tauri-plugin-autostart` 2.7 (MIT or Apache-2.0, active) or a value under the current user's
  `Run` registry key, written directly.
- **Recovery key as a PDF.** WebView2's own print-to-PDF, through the WebView2 bindings the shell already has
  (`ICoreWebView2_7`), or building a PDF in Rust with `printpdf` 0.12 (MIT).
- **End-to-end tests.** The spec already chose WebdriverIO (10.1, MIT) with `tauri-driver` (2.1).

## Decision

### Decisions approved

Ariel approved all of these on 2026-11-05, as the author's updated picks. Everything else in this document follows the
rules already set.

**The six features that were undecided** (Ariel, 2026-11-05: keep all six, size each, decide at approval). Each is its own
task or tasks. Sizes come from reading the code; they are estimates, with **Small** meaning one task or part of one,
**Medium** one or two tasks, and **Large** more than that. **High risk** means the project's rule applies: it touches
passwords, keys, decryption or authenticity checks, or deletes user data, so a build task gets the stronger review.

| Feature | Size | What it takes | If it waited | Decision |
|---|---|---|---|---|
| **Earlier passwords** (11b) | Medium, high risk | A capped list inside each login, moved there by the engine on a password change, with reveal and copy. Goes through the item format, which keys change anyway | v1 warns to copy the old password first. Adding it later means a new item version, and an older Lockbox then treats those items as damaged | **Keep.** It prevents losing access to a website, and it's cheapest now, alongside keys |
| **Rename a vault** (18d) | Small, high risk | One header write through the code `accept_header` already uses, since the name is covered by the header's check. The folder keeps its old name | The name stays what it was at creation, and a typo means a new vault | **Keep.** Small |
| **Delete a vault** (18e) | Medium to large, high risk | Password check, refusals (open, busy, a restore waiting on it, not really a vault), rename to a hidden name so an interrupted delete can't look like a working vault, a delete that never follows links, and finishing an interrupted one at launch; older copies offered too | Remove from list plus Show in Explorer, and the folder is deleted by hand. Both exist anyway | **Wait for v1.1.** Permanent, the riskiest of the six, and there's a plain way round |
| **Save all of a folder's files** (9f) | Small to medium, high risk | The folder picker and the verified save for each file exist, and progress and a stop are built for other jobs anyway. New: going through the files, the names, and the summary. See [below](#saving-all-of-a-folders-files-task-9) | Save a copy, one file at a time. Export leaves stored files out, so a person leaving could only save them singly or restore a backup | **Keep.** First picked to wait, then changed once it was drawn and checked against the code: it's cheaper than sized, it never overwrites a file, and it serves the promise that nobody is trapped |
| **Attached file names in search, and opening a file from search** (9g) | Small | Names added to the search index, the result says which file matched, and Open uses the existing command with its existing questions. The page already receives these names | Find the item first, then open the file | **Keep.** Nearly free, and files are the product's difference |
| **Start with Windows** (31a) | Small | A registry value, a start with no window, launch notices held until the window opens, and the setting reading the true state. Tauri's uninstaller already removes the `Run` entry (read in its installer script by the review of 2026-11-04) | Lockbox must be opened before the shortcut works, and the app says so | **Keep.** The save shortcut is a v1 promise, and this makes it dependable |
| **Staying out of screen capture** (31a) | Small to build, plus a real-PC test | `set_content_protected` exists in Tauri 2.12.5 and sets `WDA_EXCLUDEFROMCAPTURE` (read in the source). A setting, applied before the window shows. The test is whether it blanks Lockbox in Magnifier, Quick Assist or remote desktop | Screens capture like any app, and the guide says what Recall can capture | **Keep, and decide its default after the test.** Off by default if it blanks Magnifier, since "for everyone" outranks it. **Tested: on by default.** Magnifier shows Lockbox in all three views, judged by eye; Quick Assist and remote desktop are still to test before release, and the default is weighed again if either blanks Lockbox ([results](#results-of-the-risky-checks)) |
| **Generator with every vault locked** (16b) | Small, high risk | The generate commands already need no vault. Copying from the generator doesn't exist at all yet, so v1 needs a copy owned by the unlocked vault on screen either way. This adds only a copy with no owner, cleared by its timer, Lock all or closing | The generator's link on the lock screen goes, and it needs an unlocked vault. The generator's Copy still works | **Wait for v1.1.** Rare, and it's the one change to the clipboard's ownership rule |

Delete a vault and the generator with every vault locked go to v1.1. Screens 16b and 18e stay in the notes for later, and
each screen that links to them loses that link.

**Other decisions**

| # | Question | Options | Decision |
|---|---|---|---|
| A | Does a note's text show openly when it's opened (3g)? | Show it, as drawn. Or hide it until Reveal, like a password | **Show it.** One click fewer, and it matches what people from other password managers expect (general knowledge, not checked). The word "secret" is kept away from notes on screen. Someone who wants a value hidden can use a Key |
| B | Export's file format (task 34) | CSV, or JSON. An own layout, or one an importer already knows | **CSV in Bitwarden's documented layout:** `folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp`. Bitwarden reads it as it stands, and it's a plain list other importers can map. A login is `type` login. A note is `type` note. A key is `type` login, with its name in `name` and its value in `login_password`, so the value stays in a hidden field; its kind doesn't survive. Build task: import a test file into Bitwarden's format and into one other manager, and check every value arrived |
| C | Parts for the screens | The candidates above | **Base UI**, since it's the one with a documented way to stop style tags, if it passes the first build task, screen reader included. Otherwise React Aria Components |
| D | The save shortcut | Plugin, or `RegisterHotKey` directly | **Directly**: no new dependency, the hidden window already exists, and the failure Windows returns is exactly what 31b needs to say |
| E | Start with Windows | Plugin, or the `Run` value directly | **Directly**: a few lines, and no new dependency for it |
| F | The default shortcut | Ctrl+Shift+L, as drawn, or another | **Ctrl+Shift+L for now.** Bitwarden's browser extension uses it too, as far as the author recalls. A Windows-wide shortcut would take it from them, so check this at build and change it if so. **Checked, and kept (Ariel, 2026-11-05: "seems easier for me").** It is taken: Bitwarden's extension manifest sets its login fill to Ctrl+Shift+L, and Lockbox got the press with Chrome in front. While Lockbox runs, Bitwarden's fill, Word's bulleted list, VS Code's select all occurrences and Edge's paste and go lose it; Settings can change it (31a) |
| G | How Plan 4 is split | See [Building it in order](#building-it-in-order) | **Three plans** |

### Decided without needing a question

- **Screens: React and TypeScript, as the spec says**, with no router and no state library. A small store keeps each
  session's data and drops it on a lock event (standard for this size; my call on no library).
- **Styles: plain CSS files**, taken from the approved style sheet: colour and size variables, components, the short-window
  rules and the high contrast block. The policy refuses inline styles in HTML, which the mockups use a lot, so nothing is
  copied across as-is (found by the Windows check).
- **The list of items: every row on the page, with `content-visibility: auto`**, measured against 5,000 items. A virtual
  list comes in only if that measure fails (my call: lowest cost, and better for screen readers).
- **Fonts: Geist and Geist Mono, bundled** through `@fontsource-variable/geist` and `geist-mono` (5.3, OFL-1.1). The
  policy allows fonts only from the app itself, and there's no network at run time.
- **Recovery key PDF: WebView2's print-to-PDF** with a print style sheet that shows only the key and its words. The bindings
  are already in the shell, the page already draws the key, and a PDF library isn't needed (my call; Microsoft's reference
  says a second print job at the same time fails at once, so the button waits for the first).
- **Accessibility checks: `axe-core` called directly** (4.14, MPL-2.0, test only). `vitest-axe` hasn't been updated since
  January 2025, and calling it directly is only a few lines.
- **No analytics, no telemetry, and no network calls from Lockbox itself.** Help opens the user's own browser.

## Parts and data flow

```
React screens ── bridge.ts (every answer's generation is checked) ── commands ── shell ── engine
      ▲                                                                 │
      └── events: locked, notice, progress, save box ───────────────────┘
Tray icon, save shortcut and close button arrive at the shell, not the page.
```

### The look (approved 2026-11-04)

- **Side menu:** flat, with a thin edge rather than a floating card; closes to icons (3h). A vault strip appears only from
  two vaults. Contents: search, All items, folders, Generator, Trash, Lock all.
- **Vault colour:** each vault has one, shown on the main button, the selected row and the vault mark. Three accents are
  drawn, each with light and dark values: Work `#14663F` / `#4FD08A`, Home `#4E2FA8` / `#B49CF5`, a read-only old copy
  `#7A5A00` / `#F2C14E`. No gradients (Ariel: they looked unprofessional for strangers).
- **Vault mark:** each vault's line mark has its own number of points, from its place on the vault list (3, 5, 6, 7 and
  on; 4 stays the read-only copy's), while the colours take turns, Work then Home. So two vaults of one colour still look
  different (Ariel, 2026-11-06, at the first hands-on: the first and third vault looked alike). The small mark beside a
  name is drawn in its vault's colour (a contrast theme's text colour under one), with a line thick enough to stay clear
  at 36 pixels. On the lock screen every vault takes its place's look, since whether it's a read-only copy is known only
  once it's open; the amber look appears then.
- **Item details** open in a side panel, not a third column. Forms and rarer jobs use the same panel. Restore, first-time
  setup and forgot password are full-screen steps, since they start from places with no main window.
- **Lock screen (Ariel, 2026-11-04, "stick with the current design"):** split, a dark side with the line pattern and "Your
  items stay encrypted until you enter the password.", the form on the other side.
- **Type:** Geist, with Geist Mono for key values and recovery keys. Light and dark both ship.
- **Name and logo:** the name stays for now; the final logo follows once it's decided before release. The vault mark stands
  in, and the final logo needs a simpler version for 16 to 20 pixels.
- **Words on screen:** "folder", never "collection" or "project". "Key" for an API key; "recovery key" always in full; the
  vault key never appears. "Details" for the header, "leftover files" for orphaned files. "Backup" is encrypted; "export"
  is readable.

### The window

- **Size:** opens at 1280×800, minimum 960×460 so a 200% screen still fits (today the app sets no size and opens at
  640×480, where Add is cut off). The main view fills the window. The native Windows title bar stays.
- **Closing the window** locks every vault and hides to the tray; the first time, a message in the window says so (5b),
  not a Windows notification, which Focus settings can hide. **Quit** is in the tray menu. Today closing goes straight to
  shutdown (`lib.rs`), so this is a real change, and spec 7.4's "closing the app locks all vaults" still holds.
- **During a long job,** close and Quit ask first (33b). Past a restore's swap the wording changes, because closing no
  longer cancels it (Ask 15).
- **Tray:** the Tauri `tray-icon` feature (in Tauri 2.12.5, read in its manifest). Menu: Open Lockbox, Lock all, Quit.
- **Started by Windows,** the window stays hidden until asked for. Launch work runs as usual, and its notices wait for the
  window. An argument on the `Run` value does this; it only ever affects visibility.

### What's new under the screens

The reverse check of 2026-11-04 compared the tasks with the 57 commands. All of this is real work, not drawing.

**Engine (`lockbox-core`)**

| Addition | How |
|---|---|
| **Key items** | `ItemKind::Key { value }`, and the item's title is its name. Names must be valid variable names (letters, digits and `_`, not starting with a digit; my call), since `.env` out is the point of the feature. The value is never indexed, and the name is |
| **Earlier passwords** | `previous_passwords` on a login: at most 5, oldest dropped, each with the date it was replaced. The engine moves the old one on a real change, never the page. An old file with no such field still opens (a new test pins it, beside the updated format test) |
| **Rename a vault** | Writes the header with a new name and a new check value, refused while the header has an unaccepted change or the copies disagree, as backups are. The folder name stays |
| **Check a password on an open vault** | One internal function. It's never its own command: change password, new recovery key and export each take the current password and check it in the same call, so there's no gap between checking and acting (differs from the review's suggestion of one command; my call). Takes about a second, with no lockout, as spec 5.6 says |
| **Progress and a stop that doesn't lock** | File import, Save a copy, backup, test and restore report bytes done and total through a callback. `CancelToken` reaches these loops today, but its clones share one flag per session, and setting it would stop everything in that vault until the next unlock. So each long job gets its own token that also stops when the session's does: Cancel stops that job, and a lock stops them all. An operation ID, on the progress events and the cancel command, says which job |
| **Restore a folder with its items** | An item trashed with a folder records that folder in a new encrypted field, `trashed_with`. A retry after a crash writes the same value, and items trashed earlier have none, so nothing depends on timestamps (they're whole seconds, and a retry gets a new one). Restoring the folder brings back the items naming it, and restoring any item clears its own field. Today it brings back the folder alone |
| **File names in search** | Added to the index, ranked with the other non-title fields. `SECURITY.md` already lists these names as unwiped, so that entry only needs the index added |
| **`.env` parser and writer** | In the engine, so it's tested without Tauri. See [`.env` rules](#env-rules) |

**Shell (`lockbox-desktop`)**

| Addition | How |
|---|---|
| **Save shortcut** | Registered on the hidden window. A press reads the clipboard once, in Rust, into a single wiped slot, and tells the page only that a value is waiting. See below |
| **Clipboard clear for a value Lockbox didn't copy** | Reads the clipboard and clears it only if it still holds the same text, in one opening. The wording doesn't promise more: Windows clipboard history keeps it (tested on 2026-11-05), so 8a says the value may still be in clipboard history (spec 7.3) |
| **One way to write a readable file** | An export, a saved `.env` and a recovery key PDF all follow Save a copy's rules (spec 7.2, 7.4): Rust picks the destination, the existing cloud check and vault-folder refusal run on it, the file goes to a journaled temp file beside it (for the PDF, a new file inside a new hidden folder there, since WebView2 refuses an existing hidden file), and it's renamed into place only if the session's generation is still current. An existing file is untouched until then. WebView2 writes its PDF straight over the path it's given, so it's given the temp path; a lock while it runs means the result is discarded |
| **Export** | Rust writes the CSV. Earlier passwords and files are left out. The result names any item whose password, key value or note has a line break, since another app's importer may change those: Bitwarden's turns every line ending into a plain line feed before reading the file (read in its source). The test file includes them. The vault itself is unaffected |
| **`.env` in and out** | Paste goes page to Rust, like a typed password, and comes back as rows with names only. Copy out and save as a file happen in Rust |
| **Copy from the generator** | A new command takes the generated value from the page, like a typed password, and copies it in Rust with the same marks and timer, owned by the unlocked vault on screen. Without it there's no way to copy an unsaved password. The page's own clipboard can't be used: it skips the marks that keep values out of Win+V |
| **Many files** | One picker, then a queue. The vault is released between files, so a long batch doesn't keep reads waiting |
| **Save all of a folder's files** | The same queue, the other way. See [below](#saving-all-of-a-folders-files-task-9) |
| **Pick a backup first** | A short-lived choice held in Rust, kept through password retries (the existing mechanism for waiting choices). The page never holds the path |
| **Keep a finished restore through an idle lock** | It waits for its answer. Windows locking or sleeping still cancels it |
| **Per-vault state** | `vault-state.json` in the state folder, by the vault's folder location, as sessions are (spec 6.9), so two copies with one vault ID don't share a mark: the last backup date and "recovery key not confirmed". It's a separate file because a read-only open writes nothing to the vault and backups shouldn't carry it. If damaged, it starts empty: at worst a reminder comes early, or a mark is lost |
| **Settings** | Theme, shortcut and screen capture join `settings.json`, which stays version 1, with defaults for the new fields. Start with Windows reads its true state from the registry instead, since Windows' own Startup settings can change it |
| **Small commands** | Show in Explorer (Rust opens it; no path from the page), Help (a fixed link), `https://` on a saved website, a visible message when start-up fails (Ask 14), a reset for a damaged vault list (Ask 12) |
| **Commands widened** | `copy_field` and `reveal_password` gain the key value and earlier passwords. `ItemSummary` gains dates for sorting and `"key"`. Search hits say which file matched. Every new command joins the manifest and capability, as spec 4.2 requires |

**The test page goes.** `App.tsx` is today a page of hand-check buttons with a fixed test password. It's replaced, and the
drop checks and bridge tests stay.

### How a copied key gets saved (task 8)

1. The shortcut is pressed. Rust reads the clipboard once and keeps the text in one wiped slot, with a new random capture ID.
   The only other read is the comparison when the person asks to clear that value, and a different value is dropped at once
   (PRD).
2. Lockbox comes forward, and the page is told "a value is waiting" and the capture ID, without the value. With every vault
   locked, the lock screen shows first (8b). Nothing usable, or over the item limit: the box opens empty and says so (8c).
3. Order is vault, then password if locked, then name and folder, since folders are encrypted (found by the review of
   2026-11-04).
4. Save happens in Rust, from the slot, for the capture ID and the chosen session and generation. The value reaches the page
   only if the person presses Reveal, and the page drops a Reveal answer whose capture ID isn't the current one.
5. A name already in that folder asks Replace, Keep both or Cancel (8d).
6. **A second press** replaces the value and gets a new ID, and the box says the value changed but keeps what was typed. A
   Save or Reveal with the old ID is refused, so a name can't quietly land on another value.
7. **The slot empties** on saving, on cancelling, on Lock all, on closing the window, on Quit, on Windows locking or sleeping,
   on locking the vault chosen in the box, and once the auto-lock idle time passes even with no vault open, so a secret never
   waits in memory for someone who has walked away (my call). Unlocking a vault doesn't empty it, since 8b needs that. The
   value is still on the clipboard if the slot empties, so pressing the shortcut again gets it back.

### Saving all of a folder's files (task 9)

1. **Save all files (N)** is in the folder's menu. N counts every stored file in the folder, attached ones included, and the
   entry doesn't show when there are none. It works on a read-only vault too, as Save a copy does.
2. Rust opens the Windows folder picker, titled "Choose where to save 4 unencrypted copies" so the warning comes before any
   file is written, and the page never receives a path it can send back. The rules for readable output
   apply first: a damaged output journal refuses it, Lockbox's own state folder is refused, a cloud-synced folder warns first,
   and free space for the whole batch is checked before anything starts, with the numbers.
3. Each file goes through Save a copy's path (spec 7.2) up to its last step: a hidden temp file, then the whole stream verified.
   The vault is released between files. It's one job with one operation ID, so it has one progress bar and one Stop.
4. **An existing file is never overwritten.** Save a copy's last step replaces its destination (`rename_replace_gated`), which is
   right there because Windows has already asked. This job can't use it. It publishes with a rename that refuses a taken name
   (`rename_file_no_replace` exists; it needs the same generation gate and journal handling), so a file that appears at the last
   moment is safe. A name that's taken gets " (2)", then " (3)", with no question for each clash, and the same goes for two files
   with one name in the folder. The summary says which names changed.
5. **Stop, or any lock:** files already saved stay, and the file in progress leaves nothing. The screen says how many were saved.
6. **A damaged file** doesn't stop the rest: it's named in the summary, with a way to open a backup. Anything else that fails
   partway, such as a full or missing drive, ends the job and says how many were saved.
7. **The summary** lists what was saved and where, with Show in Explorer and this warning: "These copies aren't encrypted, so
   anyone who can reach this folder can open them. Delete them when you're finished, and empty the Recycle Bin. Your vault still
   has its own copies."

### `.env` rules

- **Reading:** `NAME=value` per line, with an optional `export ` in front. Blank lines and comments are skipped. A value is
  bare (trimmed, ending at ` #`), in single quotes (taken literally), or in double quotes, which may run over several lines
  and understand `\\`, `\"`, `\n`, `\r`, `\t` and `\$`. Nothing is interpolated: `$OTHER` stays as those characters. A line
  it can't read is reported by line number, never by content.
- **Writing:** a value of only letters, digits and `_-./:@+=,` is bare. Otherwise it's in single quotes, unless it holds a
  single quote or a line break; then double quotes with the escapes above. Single quotes come first since other programs'
  `.env` loaders may interpolate `$` in double quotes (general knowledge; varies by loader).
- **The promise:** any value written and read back by Lockbox is identical (a property test). Other programs' loaders vary,
  and the design doesn't promise they all agree.
- **Two keys with one name:** Keep both saves the new one as `NAME_2`, shown in its row before saving, so a folder normally
  holds one of each name (my call). A move or an edit can still produce two. Then taking keys out stops and says so:
  "OPENAI_API_KEY appears twice in this folder. Rename or move one, then try again." Nothing is dropped silently.
- **Cancel on a row** of a pasted `.env` means leave that key out.

### What crosses to the page (adds to spec 4.1)

| Data | Crosses? | When |
|---|---|---|
| Key values, earlier passwords | Rust → UI | Only on Reveal or while editing, like item passwords; never for copying |
| A value captured by the shortcut | Rust → UI | Only on Reveal |
| A pasted `.env` | UI → Rust | Once, on paste; the box empties at once and shows rows with names only |
| Paths | Rust → UI | Shown for the person to read (a saved export's folder, Ask 7). Never accepted back |
| A generated password | Rust → UI | As it does today, for display |

### The app's questions

Each moment has its message and buttons, in plain words. These are the wording, and the build uses them. "My vault" stands
for the vault's name. Moments with their own screen in a task (10d, 10e, 1c, 2c, 4c, 30b, 31b, 33b) follow that screen.

| Moment | Message | Buttons |
|---|---|---|
| Backup overdue (Ask 1) | My vault hasn't been backed up in 30 days. A backup on another drive is what saves you if this PC fails. | Later, Back up now |
| Backup refused, details changed (Ask 2) | Can't back up My vault yet. Its details were changed outside Lockbox, so a backup made now might not open. Look at that change and accept it first, then back up. | Not now, See the change |
| Backup refused, the copies of its details disagree on the password | Change this vault's password once more, then back up. | Not now, Change password |
| Backup refused, the copies disagree on the recovery key | Make a new recovery key for this vault, then back up. | Not now, New recovery key |
| Backup refused, its details couldn't be checked | Lock this vault and open it again, then back up. | Not now, Lock this vault |
| Details changed (Ask 3) | My vault's details were changed outside Lockbox. Its name, or other details kept beside your items, don't match what Lockbox last saved. Moving a vault or restoring a backup doesn't cause this. If you edited that file yourself, accept it. If you didn't, lock it and check your PC first; restoring a backup you trust is the safer way back. Backups stay off until you accept. | Lock this vault, Accept |
| Items can't be read (Ask 4) | 3 items in this vault can't be read. Everything else works. They may be damaged, so Lockbox left all stored files where they are until this is sorted. | Restore a backup, Open a backup |
| Leftover files (Ask 5) | These files have no item that uses them. Their names were kept in the item, so only a date and size can show. | Restore a backup, Delete them all |
| Restore undone (Ask 6) | A restore didn't finish. Lockbox was closed partway through, and has put My vault back the way it was. Nothing is lost. You can start the restore again. | Restore again, Not now |
| Restore finished at launch | Lockbox finished restoring My vault. Unlock with the password from when that backup was made. | Unlock |
| Restore waiting for a drive (Ask 7) | A restore is waiting for a drive. It was using E:\Vaults, which isn't connected. Connect the drive, then try again. Dismissing leaves the folders there as they are, for you to sort out. | Try again, Dismiss |
| Details unreadable (Ask 8) | My vault can't be opened. Both copies of its details are damaged, so no password can open it. A backup can bring it back, in a new folder beside this one, and the damaged folder is left alone. | Restore a backup, Back |
| Opened from the spare details (Ask 9) | Opened from the backup copy of this vault's details. If you changed this vault's password recently, it may need your previous password. Change the password again now that it's open. | Later, Change password |
| Vault in a cloud folder (Ask 10) | OneDrive syncs My vault's folder. Lockbox doesn't support vaults in cloud folders. To stop this message, move the vault to a folder on this PC. | Keep it there, Show in Explorer |
| Lost track of opened files (Ask 11) | Lockbox lost track of some opened files. Its record of files you opened is damaged, so it can't clean them up. Until you set the record aside, backing up, Save a copy and Open stay off. | Set it aside |
| Vault list damaged (Ask 12) | Lockbox lost its list of vaults. Your vaults are still in their folders. Start a new list, then add each vault back. | Start a new list |
| Newer vault (Ask 13) | Update Lockbox to open this vault. A newer version made it. | none |
| Can't start (Ask 14) | Lockbox can't start. Your vaults aren't affected. Restart your PC and try again. If that doesn't help, the guide says what to check. | Open the guide, Close |
| Closing past a restore's swap (Ask 15) | A restore is finishing. It's past the point of cancelling. If you close now, Lockbox finishes or undoes it the next time it opens, so nothing is lost. | Close anyway, Keep it running |
| Locked before it could say (Ask 16) | Your new password was saved, but the vault locked before Lockbox could say so. Unlock with the new one. | none |
| Backup fails or is cancelled | The backup didn't finish. Nothing half-made was left. | OK |
| Restore refused, no space | Not enough space. This needs 1.2 GB, and that drive has 400 MB free. | OK |
| Restore refused, wrong drive | A vault can't live on a removable, FAT32 or network drive. Choose a folder on this PC. | OK |
| All old-copy names used | There are too many older copies of this vault. Delete some, then restore again. | Older copies, Cancel |
| Nowhere to copy to | Unlock a vault first, so there's somewhere to copy this to. | OK |
| Vault made but not listed | Your new vault is on disk but couldn't be added to the list. Use Add existing vault folder, then make a new recovery key. | OK |

**New behind these:** today's code has no "no" answer to Ask 3. Lock this vault uses the lock that already exists, and the
question comes back at the next unlock. The vault-list reset for Ask 12 doesn't exist yet either. The shell has to say which
credential the copies disagree on, since the engine refuses the other one (`HeaderGuard`).

**Where this differs from the pictures, the words here win:** Ask 3's message, and the refused-backup messages (the pictures
said a move or restore explains a changed header, which it doesn't, and that items weren't touched, which spec 6.6 says can't
be known).

### First use, and the recovery key

Set out in tasks 21 and 29, since this is where a person can lose everything.

- The vault is already written when the key appears, so nothing on this screen may be the only record that it happened. A
  per-vault mark is written first and cleared only once part of it has been typed back. **First, so a crash can't get between
  them:** for a new vault, the shell chooses its ID, writes the mark, then creates it (the engine's `create_with_id` already
  takes one, and gives the folder's location); for a new key, the mark goes before the header changes. If the mark can't be
  written, no key is made. A mark left by a failed attempt costs one extra key at worst. If the mark is still there at the next unlock of a writable, live vault, Lockbox says so and makes a new key straight
  away (21f). A read-only copy with the same ID is never touched.
- The key is hidden while two random groups of it are typed back, so typing proves something.
- It says plainly that losing both means nobody can get the data back, advises against keeping the saved key on this PC,
  and says writing it down by hand is fine and screenshots won't work.
- The idle timer doesn't pause on this screen, and any lock wipes it. This is why the mark exists: a lock costs one more
  key, not the vault.

## Errors and safety

**Screens never show raw error text.** One function turns each shell error into a message from a fixed table, and a test
fails if an error has no entry. Anything unknown gets a generic message. This keeps R5 true on screen.

**Locks win.** The store drops a session's data, revealed values and search results on its `locked` event. Forms in progress
go too: a half-typed item is lost at auto-lock, with no warning (accepted, Ariel, 2026-11-04). The bridge already discards
answers from an old generation. Every screen with an answer in flight has to handle that without showing an error. The
page doesn't rely on the event alone: once Lock all is answered, it drops every session it held when Lock all was pressed, and a "locked" refusal
drops that session instead of showing an error over its data. If the page can't listen for locks at all, it opens no vault
and says "Lockbox can't listen for locks, so it won't open a vault." with "Close Lockbox and open it again." (my call,
2026-11-06, from Task 5's review).

**Corrections the pictures need in the build** (from the checks of 2026-11-05):
- **Dialogs hold focus.** In the mockups, Tab reaches the screen behind a dialog. In the app it can't, and focus returns to
  where it was when the dialog closes (standard).
- **The search box shows focus** on its row (4a removes the ring on purpose, leaving only the text cursor).
- **The closed side menu's icons have names** a screen reader can read (3h hides the words).
- **Long lines shortened with "…"** show their full text on hover.
- **The high contrast block stays,** and is retested with the real parts.

**Changes to the spec and `SECURITY.md`, made when this design is approved:**
- **R4** gains the two new places Lockbox writes plaintext because the person asks: an export and a saved `.env`.
- **Spec 4.1, 5.4, 6.1:** the table above; Key items and earlier passwords in the item's encrypted fields.
- **Spec 7.2:** saving all of a folder's files, and one way to write a readable file.
- **Spec 7.3:** the shortcut's one clipboard read, the clear for a value Lockbox didn't copy, the generator's copy, and the
  Win+V result once tested.
- **Spec 7.4:** closing hides and locks, a finished restore waits through an idle lock, a per-operation stop.
- **Spec 8:** the table above.
- **`SECURITY.md` gains:** what the shortcut reads and when; that an export or saved `.env` is readable by anyone who gets
  it, and that a deleted file may stay in a cloud provider's history; that screen capture protection isn't a guarantee;
  that earlier passwords stay in old backups; that the current-password check slows someone at an unlocked PC but isn't
  protection against malware (spec 5.6).

**Weighed and parked, with the reasons:**
- A damaged per-vault state file loses a "recovery key not confirmed" mark. It takes a damaged file, an unconfirmed key at
  that same moment, and a forgotten password later. Very unlikely, and a warning for every vault after each damaged file would
  cost more than it saves.
- The same goes for a vault moved to a new PC before its key was confirmed, since the mark stays behind. It takes a key step
  left unfinished, a move before the next unlock, and a forgotten password. Asking about every moved vault instead would nag
  everyone who changes computers to protect almost no one.
- Delete a folder, restore one item from it (the folder returns), delete the folder again, then restore it: the items still in
  the trash from the first delete come back too. Unlikely, nothing is lost, and they're visible. A batch ID on every delete
  costs more than this.
- CSV formula cells: a value starting with `=` could run as a formula if the export is opened in Excel. Escaping would
  change the password in the file, which breaks the export's purpose. The warning screen says to delete the file, and the
  guide says not to open it in a spreadsheet. Unlikely, and the person chose to write the file.
- A window at 200% on a 1080p screen: 36 screens scroll. Uncommon, still reachable, parked.
- Toolbar Filter and Sort outlines stay faint (about 1.2 to 1): they carry their own words and icons.
- Trash's count on 18d (3.99 to 1) under an open menu's shadow: brief, and not needed at that moment.

## Testing

**Prove the risky parts first.** The first build tasks answer these on this PC, before screens depend on them:
- The chosen parts library draws a dialog, a menu and a combobox under the real policy, with no policy errors in the
  console.
- NVDA (free) reads a dialog, a list and a form in a real Lockbox window. WebView2 screen reader behaviour hasn't been tried
  here.
- Capture protection in Magnifier, Quick Assist and remote desktop, which sets its default.
- Win+V after a clear: whether history keeps a value Lockbox didn't copy.
- The save shortcut from a hidden window, and print-to-PDF in the app's private browsing mode.

### Results of the risky checks

Run on this PC (Windows 11 Home) on the release build, 2026-11-05 and 2026-11-06, in the first build checks.

| Check | Result | What it changes |
|---|---|---|
| Base UI under the real policy | Dialog, menu, combobox, list, select and form: zero policy violations; dialog focus held and returned; keyboard works; fonts show | Decision C stands: **Base UI kept** |
| Isolation frame | Not used (Ariel, 2026-11-05, against Tauri's own advice): its frame runs scripts only, a reported bug hangs every call on Windows (read, not run), and it can't tell the app's calls from a bad package's on the same page. Exact versions, install scripts off and the lockfile in the dependency scan instead, pinned by a test | `SECURITY.md` says so |
| NVDA | Announces each part with its name and role: the dialog with its description, fields, buttons, the list with its count, the form landmark, the required field, the combobox. Read in NVDA's Speech Viewer. On closing the dialog it reads the page heading before the button, though focus lands on the button | Nothing; the full pass stays before release |
| Win+V after a clear | A value copied from Notepad stays in clipboard history after Lockbox clears it | 8a's words: the clipboard is cleared, but clipboard history may still have it |
| The default shortcut | Ctrl+Shift+L works hidden, minimised and behind other apps, and takes the key from them (decision F) | Kept by Ariel; Settings can change it |
| Capture protection | Screenshots and Snipping Tool leave Lockbox out. Magnifier shows it in Full screen, Docked and Lens, by eye (a screenshot of Magnifier loses it too, so only a person can judge). Quick Assist and remote desktop not tested | **On by default.** Screen 21c's "screenshots won't work" stays, and changes only when the setting is off. Quick Assist and remote desktop join the pre-release checks; if either blanks Lockbox there, the default is weighed again |
| Browser keys | Ctrl+P, F12, Ctrl+Shift+I, F5, Ctrl+R, Ctrl+U and right-click open nothing. Ctrl+F reaches the page, with no find bar. Copy and paste work in fields | Search can use Ctrl+F as drawn |
| Print to the real temp form | WebView2 refuses an existing hidden file (no error, no file). A new file, a new `\\?\` path, an existing visible file, a new file hidden afterwards and a new file in a new hidden folder all work | The recovery key PDF is printed to a new file inside a new hidden folder beside the destination, then moved into place. While it's written, and after a crash until the next launch's sweep, it isn't shown in Explorer by default; it's hidden, not protected |

**Each task's checks:**
- **Rust:** tests first, as for Plans 1 to 3. Every new command is refused with a stale generation, a foreign ID, or on a
  read-only session. Old-format items still open. Property tests on the `.env` parser: random input never panics and never
  puts a value in an error.
- **Files people ask for:** a lock during an export, a saved `.env` or a PDF leaves no file and doesn't touch an existing
  one. The capture slot empties on each case listed above, and an old capture ID is refused. A Cancel stops one job and leaves
  another in the same vault running. Saving a folder's files never replaces an existing file, including one that appears
  partway; a Stop or a lock keeps finished files and leaves no partial one; a damaged file doesn't stop the rest. A folder restore brings back the right items after a crash partway through its delete.
- **Screens:** Vitest and Testing Library for what each does on success, failure and lock. `axe-core` on every screen in
  CI.
- **End to end:** WebdriverIO and `tauri-driver` on the real app, as the spec says. Not set up yet; it's a build task, and
  it goes into CI if it's reliable there. Paths: first-time setup, unlock, add a login, copy, auto-lock; save a copied key
  with every vault locked; back up, then restore. The sign-in measure in the PRD (six keys or clicks at most) is a test here;
  the number is my call.
- **Measures:** 5,000 items list and search stay within the PRD's numbers with the real screens.
- **By eye:** each plan compares its screens with the approved ones side by side, in light, dark and high contrast. Windows'
  real window, since a test browser hides things like its scrollbars.
- **Before release:** NVDA through the daily tasks; "make text bigger"; Windows 10, if it stays supported; the USB unplug
  check from the pre-release list; capture protection in Quick Assist and remote desktop, which needs a second PC.

**Known gap:** tests can't prove what another program keeps (clipboard history, a cloud provider's versions). The wording
says so instead.

## Building it in order

This is too much for one plan. Proposed split, for the build plans to size properly, each ending in a working app:

| Plan | Holds | Ends with |
|---|---|---|
| **4A, daily use** | The risky-part checks, styles and fonts, window and tray, parts, error table; key items and earlier passwords; tasks 1 to 8, 10 to 17, 21 and 31 | Someone can set up, keep logins, keys, notes and `.env`s, and use them every day. Real progress isn't in yet, so big files show as busy |
| **4B, files and long jobs** | Progress and stop, many files, close and Quit questions; tasks 9, 22 to 26 and 33 | Big files and backups work with progress, and a person can move PCs |
| **4C, the rest** | Tasks 18, 27 to 30, 32, 34, 36, every remaining question, end-to-end coverage, and the accessibility pass | Everything in this design |

The installer stays Plan 5, as the PRD says. Plan numbers there may shift, and the PRD follows when plans are written.

## Out of scope

- **Updates (19), download and install (20), uninstall (35):** with the installer, in Plan 5. They wait on Ariel's decisions
  on when downloads happen, signing and the name. Two findings are carried for that plan: Tauri's "delete application data"
  option misses `%LOCALAPPDATA%\Lockbox`, so an uninstall hook has to remove `open\`; and the minimum Windows version and how
  WebView2 gets installed are decided there.
- **The landing page and its guide:** the app's Help link goes to it. The page is separate work, and the app's link waits
  for its address.
- **The final name and logo:** decided before release.
- **Parked in the PRD's "Not in v1":** a whole folder added with its structure, moving items between vaults, a check-my-key
  button, a Windows-wide search shortcut.
- **A test with real people:** skipped for now (Ariel, 2026-11-04). Worth doing before release, since this design has only
  been judged by its author, reviewers and Ariel.

## Appendix: the steps of each task

What each screen does, so this document stands without the pictures. "If wrong" lists what goes wrong and what happens then.

**1. Open and unlock.** Open from Start, the taskbar or the tray. See the vaults; with one, it's already chosen. Type the
password, press Enter, about a second, then the items. *If wrong:* wrong password says "Wrong password." with no lockout;
Caps Lock shows a hint; "Forgot password?" goes to task 28; no vaults goes to task 21.

**2. Sign in to a website.** Go to Lockbox, search, pick the login. Optionally open the site. Copy the username, go back, paste;
copy the password, go back, paste. It clears after 30 seconds or when the vault locks. The copy buttons sit on the login's
details, for as few clicks as possible. *If wrong:* nothing found says so and offers a new login; two logins for a site show
their usernames; no website saved means no open button; pasted too late means copy again; locked meanwhile means unlock and
carry on.

**3. Find a key or item.** Pick a folder or All items, or search. Filter or sort. Click an item; passwords and key values stay
hidden, and a note's text follows decision A. Reveal or copy. *If wrong:* an empty vault or folder says so with Add right
there; items in a locked vault aren't listed, and a line says so.

**4. Search.** Ctrl+F or Ctrl+K opens the same search. Results come from every unlocked vault. Pick a result and an action: copy
password, username or key, or open a file. At the foot: new item, Lock all. *If wrong:* nothing found says so, and says if any
vaults are locked; a vault busy with a long job says its results are missing for now.

**5. Lock.** Lock one vault, or Lock all, also in search. Or close the window: every vault locks and Lockbox stays in the tray,
which the first close explains. Or walk away: after 5 minutes without input, or when Windows locks or sleeps. Then the lock
screen, with secrets gone from the screen and the clipboard cleared. *If wrong:* during a long job, idle time pauses and the
screen says why; Windows locking or sleeping still locks.

**6. Add a login.** Add, then Login. Title, username, website (`https://` added on save if missing). Generate beside the password
field, adjust, use. Pick a folder or none. Save, then copy the password for the website. *If wrong:* the same title is allowed,
and the username tells them apart; a lock before saving loses what was typed.

**7. Add a key or note.** Add, then Key or Note. Key: name and value, hidden. Note: title and text. Pick a folder or none, save.

**8. Save a copied key.** See [How a copied key gets saved](#how-a-copied-key-gets-saved-task-8). Choose whether to clear the
clipboard; the words don't promise more than it does.

**9. Store a file, or attach one.** Add, then File, or attach on a login, key or note. Pick one or many in the Windows picker. A
short panel chooses the folder and refuses early if they won't fit. Progress for big files, with Cancel. It says the originals
are still unprotected on disk and stay as they were. To take files out: Save a copy, or save all of a folder's files (see
[above](#saving-all-of-a-folders-files-task-9)). *If wrong:* not enough space, or over 256 GiB, is refused before starting, with the numbers; dropping a file in isn't available.

**10. Open, copy, replace.** Open decrypts a temporary read-only copy into its usual app, and says edits aren't saved back. Save
a copy picks where in the Windows dialog. Replace picks the new file after warning the old one goes. *If wrong:* a program file
asks first; a damaged file is refused and offers a backup; a file still open at lock says "Couldn't remove N opened files.
Close the app using them, then Retry."

**11. Edit.** Edit, change fields (a password shows while editing), Save or Cancel. Changing a password keeps the old one on the
login, with "Until" the day it was replaced. *If wrong:* a read-only vault has no Edit, and is labelled.

**12. Move.** Move on the item, pick a folder or No folder. A short "Moved to..." message.

**13. Delete and get back.** Move to trash goes at once, with Undo. Trash, pick, Restore; if its folder was trashed, that comes
back too. Restoring a folder brings back what went with it. Delete for good asks first. Lockbox never empties the trash by
itself.

**14. Folders.** New folder, name, save. Rename from its menu. Delete says how many items go to the trash, and asks first.

**15. `.env`.** In: paste into Add. It turns into rows at once, one per key, values hidden. Pick a folder, save. Out: from the
folder, copy all in `.env` form, or save as a file, with a warning that it isn't encrypted and the cloud warning if it applies.
See [`.env` rules](#env-rules).

**16. Generator.** From the side menu, with a vault unlocked. Length and character types, or passphrase. Copy clears like
any password, and it's lost once cleared if not saved.

**17. Show one kind, sort.** Above the list. The choice shows clearly, with a way to clear it, so a filtered list doesn't look
like missing items. Nothing matching says so.

**18. Vaults.** New vault uses first-time setup's two steps. Switch from the side menu, unlocking first if needed. With two open,
Add and Settings say which vault. Rename from the vault's menu. Remove from the list says the folder stays on disk and can be
added back. To delete a vault in v1, remove it, show it in Explorer first, and delete the folder by hand; the guide says so. *If
wrong:* a cloud-synced folder warns; removable, FAT32 or network is refused. Show in Explorer shows where a vault lives and tells
two with the same name apart.

**21. First-time setup.** First screen: create a vault, or "I already have a vault or a backup". Name (not encrypted, so no secrets
in it) and password twice. The recovery key: see [First use](#first-use-and-the-recovery-key). Type two random groups back. Then
the empty vault, with "what to do first".

**22. Back up.** From Settings or the reminder. Choose where; it says to keep it on another drive. Progress; closing asks first.
It says what was saved, and what was left out. *If wrong:* not enough space is refused with the numbers; a failed or cancelled one
leaves nothing half-made.

**23. Test a backup.** Pick the file. Password or recovery key from when it was made. Whether it's good, with date, size and counts.
Nothing changes. *If wrong:* wrong password says it's the one from that day, and keeps the chosen file; damage is named in plain
words.

**24. Restore.** From Settings, the lock screen or the first screen, in full-screen steps. Pick the backup first; the choice stays
through retries. Password or recovery key from when it was made. Choose the folder; the usual one is suggested. Progress; Cancel
works until the swap. "Replace your vault with this?" if it's there, saying the current one is kept as an older copy. It waits, and
5 idle minutes don't discard it; Windows locking or sleeping still cancels. Then unlock with the backup's password, which it says
plainly. Older copies are in Settings: open read-only, or delete, which asks first. *If wrong:* interrupted means Ask 6; a missing
drive means Ask 7; both copies of its details unreadable means Ask 8.

**25. Open a backup read-only.** Pick it, password or recovery key. Browse, labelled read-only. Copy an item into a live vault, or
save a file. *If wrong:* files missing from the backup are named, then "Copy without them?"

**26. New computer.** Old PC: back up. New PC: install, then "I already have a vault or a backup". Pick the backup or a vault folder;
a folder on a USB stick must be copied to this PC first, and it says so. Password or recovery key from when it was made. Restore
into the usual folder. Repeat for each vault.

**27. Change password.** It shows which vault. Current password, new one twice. It says existing backups still need the old details,
and states the limit in spec 5.3. Offers a fresh backup right then. *If wrong:* under 12 characters, or a mismatch, is said on the
form.

**28. Forgot password.** "Forgot password?", recovery key, new password, offered a fresh backup. *If wrong:* a typo says so; a key for
another vault or an old one says "This key doesn't open My vault."; no key says plainly nobody can get in, unless a backup opens
with details they still have.

**29. New recovery key.** Current password. It says the old key stops working here, but old backups still need it. See it once, print
or save, type part back. Offered a fresh backup.

**30. Add back or remove.** Add existing vault folder on the lock screen. *If wrong:* a folder that isn't a vault says so; a vault
whose folder or drive is gone shows as unavailable, with Try again and Remove from list on its row.

**31. Settings.** Each change applies at once and shows which vault it's for. *If wrong:* a shortcut already taken says so.

**32. Empty the trash.** Items there 30 days or more are listed with "Delete permanently?" Empty trash, or one item, says it can't be
undone and asks first.

**33. Quit.** Tray menu, Quit. Every vault locks and Lockbox stops. The first-close message says the shortcut stops until it's opened
again. During a long job it asks first.

**34. Export.** Warning, password, where it goes. A vault folder is refused; a cloud folder warns that the file would be uploaded
unprotected, then pick another or continue. Afterwards it says to delete the file and empty the Recycle Bin. Stored files aren't
included.

**36. Help.** Help opens the guide in the browser. An empty vault shows "what to do first".

**Other cases, said on the form or in a short message:** a change made but locked before it could show (Ask 16); a vault busy with a
job says "Backup in progress. Your change waits until it's done."; a first look at a vault in a cloud folder (Ask 10).
