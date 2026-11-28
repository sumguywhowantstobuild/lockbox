# Download page and guide (Plan 5): design

**Date:** 2026-11-26, the picture changed 2026-11-27 · **Author:** Ariel Maningas · **Status:** approved by Ariel,
2026-11-27; amended 2026-11-28 (the file check made optional,
[amendment](2026-11-28-optional-file-check-amendment.md))

This is the look and the words of Petalock's public site: the download page, the guide and the not-found page, at
`https://petalock.arielmaningas.com/`. Plan 5 Task 6 builds it from this document, and its tests pin the words below
word for word. The site's security rules (no script, nothing loaded from elsewhere, the exact headers, the release chosen
by a reviewed change and hashed at build) are in the plan's constraints and are not repeated here, except where they
shape the look. Tags on decisions: **Ariel** (Ariel decided, with the date), **standard** (common practice for this kind
of page), **my call** (the author's choice, open to correction at approval).

## Context

Strangers will download an unsigned, unaudited password manager from this page. Before they run anything, the page has
to tell them plainly what it is, what Windows will show and why, and how to check that the file is the one we published.
It also has to tell them what happens to their vaults when they install, update or uninstall. Research before the round
(KeePassXC, VeraCrypt, Espanso, Bitwarden and Microsoft's SmartScreen page) found that none of them explains Windows'
warning before the visitor meets it, and only VeraCrypt says to stop when the check fails. This page does both.

The maker, that the file is unsigned and the expected warning come before the button (the plan's decision 1). The check
after download is optional (Ariel, 2026-11-28, option A; [the amendment](2026-11-28-optional-file-check-amendment.md)).

How the look was chosen (steps 1 to 5 on 2026-11-26, 6 to 8 on 2026-11-27):

1. Three page drafts (plain, steps, branded). **Ariel:** "It looks bland actually... Generic feel."
2. Ariel sent twelve inspiration images (halftone and dot textures, painterly openings, editorial type, lots of room) and
   tied them to the name: Petalock's petals as the fine line-work of security printing.
3. Twelve studies for the opening picture, then the same twelve drawn only from the real logo (**Ariel:** "base it on
   the current logo"). **Ariel picked study 8, the logo as a halftone print.**
4. The whole page in that halftone three ways: V1 blue all the way down, V2 the blue dissolving into cream paper, V3
   Petalock's app greys with halftone accents. **Ariel picked V2.**
5. Ariel placed the opening picture with a slider panel: size 500, x +40, y −21, blue area 0, at 1536 wide.
6. Ariel felt the page and the app didn't go together. The page and the app's lock screen were drawn in each other's
   colours; Ariel kept the page's blue for the page and the app's own greys for the app (**Ariel:** "I feel like blue
   is not appropriate to the app itself"), so the two share the drawing, not the colours. The app's side is a dated
   note in the user interface design (2026-11-05), not here.
7. The picture's meaning became security printing: fine engraved lines are what makes a banknote hard to copy, where a
   halftone is how a copier prints (**Ariel:** "I mean more on security printing, like making the forging hard"). Of
   four richer studies (intaglio, medallion, rainbow, relief), **Ariel picked the intaglio**. A wavy-line band was tried
   with it and dropped: **Ariel** kept V2's dots ("Can we bring back the old look?").
8. Ariel placed the new picture with the slider panel: **size 530, x +55, y −30, blue area 0, at 1536 wide**, and
   approved the set ("I approve it").

The drawn files are kept with the project's private design notes, like the Plan 4 screens: the picked pages are
`f-download`, `f-guide` and `f-notfound`, each with a `-dark` twin, drawn by `final.mjs`, which takes V2's pages from
`pages3.mjs` (with `content.mjs`, the draft words) and puts in the picture from `intaglio.mjs`; the board is
`final.html`. The earlier V2 halftone pages (`h-v2-*`, board `halftone.html`) stay as the record of steps 1 to 5. The
pages are drawn responsive: the same files are the desktop and the phone drawings, shown at 1280 and 390 wide on the
board. Where this document and the drawings differ, this document wins (the changes are listed in
[Changes from the drawings](#changes-from-the-drawings)).

## The look

### The opening picture

Petalock's logo engraved, as intaglio on a banknote plate: twenty-six lines of the logo's three-petal rule, each a filled
ribbon of ink that swells where its petal crests and thins between petals. It is drawn from the same rule as the app's
mark and icon (three petals round a centre), so the page, the app's lock screen and the icon read as one mark; it is
the same picture the app's lock and setup screens show from Plan 5 (the user interface design's note of 2026-11-27).
**Ariel**, 2026-11-27.

- **How it is drawn** (`intaglio.mjs`): in a 200 by 200 logo box centred at (100, 100), line `i` (0 to 25) follows
  `r = 100 × (0.62 + a × sin(3t + φ))` with `a = 0.16 + 0.156 × i / 25` and `φ = iπ/26`. Each line is a ribbon whose
  full width at angle `t` is `weight × (0.18 + 1.05 × (0.5 + 0.5 × sin(3t + φ))^2.2)` logo units, set out on both sides
  of the line along its normal, sampled every 1.5°, and filled (`fill-rule: evenodd`). The drawing's frame is the logo
  box with 8 units of room on every side (`viewBox="-8 -8 216 216"`).
- **Weight:** fixed per place, worked out once from the size each place is designed at and never changed with the window:
  weight 1 on the download page (designed at 530 pixels, about 2.45 pixels per logo unit), about 1.53 in the guide header
  and 1.4 on the not-found page (given below), so the ink looks about as thick on each. A picture shrunk with a narrow
  window keeps its weight, so its finest lines get thinner, as in the drawings.
- **Never rotated or recoloured beyond the two themes below:** it would stop matching the app.
- **Decorative:** hidden from screen readers (`aria-hidden`). The words beside it carry the meaning.

### Colours

The opening is strong blue with the picture engraved in cream. Below it, a dissolve band turns the blue into warm cream
paper dot by dot, and the page below is printed in blue ink on that paper. Dark mode follows the visitor's Windows or browser setting
(`prefers-color-scheme`); there is no switch, since a switch would need a script. **Ariel** (V2), 2026-11-26.

| Role | Light | Dark | Use |
|---|---|---|---|
| Opening background | `#1d3fb8` | `#0c1633` | Header, band top, guide header, not-found page |
| Picture ink | `#f1e6cc` | `#8fa9e8` | The engraved picture |
| Opening text | `#f4ecd8` | `#e9ecf5` | Name, headline |
| Opening secondary text | `#d4dcff` | `#a9b6d8` | Lead line, version line |
| Opening button | `#f4ecd8` on, text `#1d3fb8` | `#e9ecf5` on, text `#0c1633` | Download button in the opening |
| Page | `#f3ecda` | `#0b0f1a` | Everything below the band |
| Text | `#1f2a44` | `#e3e7f0` | Body |
| Secondary text | `#545e75` | `#9aa3b5` | Notes under steps, footer |
| Headings, links in place, focus ring on the paper, step numbers | `#1d3fb8` | `#a9bdf5` | |
| Focus ring on the blue areas | `#f4ecd8` | `#e9ecf5` | Menu, opening, guide header, not-found page, skip link |
| Cards | `#f8f3e6`, line `#e2d8c0` | `#111726`, line `rgba(255,255,255,.08)` | Step cards, the deletion box |
| Code box | `#ebe2cc`, text `#1f2a44` | `#111726`, text `#e3e7f0` | The PowerShell line |
| Page button | `#1d3fb8`, text `#f4ecd8` | `#a9bdf5`, text `#0b0f1a` | Download button in step 1 |
| Stop line | `#a3200c` | `#ff9c8a` | "If it prints False, stop." |
| Rules | `#d8cdb4` | `rgba(255,255,255,.1)` | Lines between sections (decorative) |

**Contrast** (WCAG 2.2, computed for this document): every text pair is at least 5.5:1 in light and 7:1 in dark; the
lowest are secondary text on the page (5.51:1 light) and on cards (5.86:1). The focus ring is 7.26:1 against the paper in
light and 10.28:1 in dark; on the blue areas it is cream, 7.26:1 on `#1d3fb8` and 15.09:1 on `#0c1633` (a blue ring
there would vanish). Links in running text are always underlined, so they never rely on colour alone. The picture and
the band are decorative, and no text sits on the picture's lines at any width. **standard** (AA asks 4.5:1 for text, 3:1 for the focus ring).

**High contrast** (Windows contrast themes, `forced-colors: active`): the picture (drawn inline; if Task 6 picks image
files, the picture is hidden instead, see [What Task 6 still decides](#what-task-6-still-decides)) switches to the
system's text colour on the system's background; the band is hidden, since both of its sides become the system's
background and a dissolve between them would read as a solid bar (Task 6, 2026-11-27); buttons and cards get a visible
system-coloured border, and nothing depends on colour alone (the stop line is also bold and starts with "stop").
**standard**.

### Type

Geist for text and Geist Mono for the PowerShell line and the fingerprint, both as variable fonts, self-hosted with
their licence (SIL Open Font License 1.1), loaded with `font-display: swap`. Only the Latin subsets (about 29 KB and
23 KB). **my call**, carried from the round's drawings.

| Element | Size, weight | Phone (≤ 640 px) |
|---|---|---|
| Headline | 60 px, 500, letter-spacing −0.025em, line-height 1.08 | 40 px |
| Lead line | 19 px | 17 px |
| Section heading | 34 px, 500 | 27 px |
| Step heading | 21 px, 500 | 21 px |
| Body | 16 px, line-height 1.6 | 16 px |
| Version line, footer | 14.5 px | 14.5 px |
| PowerShell line | 12.5 px mono, wrapped inside its read-only box | same |
| Fingerprint | 13.5 px mono, in groups of eight | same |

Between 900 and 1180 px wide the headline scales with the window (`clamp(40px, 4.8vw, 60px)`).

### Layout

- **Width:** content up to 1180 px with 48 px side margins; the opening up to 1280 px. Phone side margins 16 px; no
  sideways scrolling at 320 px or wider except inside the code box. **standard**.
- **The opening, wider than 900 px (from 901):** two columns centred on each other: the words (up to 520 px) and the picture, 64 px
  apart (40 px below 1180 px). The picture fills its column up to 530 px, sits at the column's end and is moved 55 px
  right and 30 px up from there. Nothing sits under it but the band (blue area 0). **Ariel**, 2026-11-27, placed at 1536
  wide; narrower windows shrink it with its column and keep the same nudge. The opening clips sideways only
  (`overflow-x: clip`, which makes no scroll box) whatever the nudge pushes past its edges, so the page never scrolls
  sideways; the download button sits well inside the opening, so its focus ring is never cut. Task 12 checks the stacked
  layout at 900 px and the two columns at 901 px, with the button focused.
- **The opening, 900 px and narrower:** one column; the picture goes under the words, centred, up to 520 px, with no nudge.
  On a phone the download button fills the width.
- **The band:** 110 px tall, full width, below the opening on the download page only: rows of page-coloured dots, 10 px
  apart, each row's dots larger than the last until they close over the blue (radius `5 × 1.45 × ((row+1)/rows)^1.3`,
  odd rows offset half a step). It is cropped, never stretched, at other widths.
- **Sections:** 72 px above and below (48 px on a phone), a 1 px rule between them.
- **Cards:** 18 px corners, 28 px inside. Buttons are fully rounded, 14 by 24 px inside, 16.5 px semibold, with a
  download arrow.
- **The menu** (on the opening): the logo mark and "Petalock" on the left; "Download", "Guide" and "Source code" on the
  right; the current page is underlined (`aria-current="page"`). On a phone "Source code" moves to the footer only.

### Behaviour without a script

- **The PowerShell line:** a read-only text box (`<textarea readonly>`, three rows, the line wrapped, Geist Mono, styled
  as the code box), labelled "PowerShell line to check the file" by a visible label. Tab or a click puts you in it,
  Ctrl+A selects just the line and Ctrl+C copies it, by mouse or keyboard alike, with no script and no form. No copy
  button: it would need a script. **my call**, from the plan's no-script rule; the read-only box is the **standard** way
  to make copyable text work by keyboard.
- **The fingerprint:** folded under "See the fingerprint" (`details`); open, it shows the hash in groups of eight.
- **No inline styles:** the site's Content Security Policy allows styles only from its own style sheet, so every style
  in the drawings' `style=""` attributes moves into `styles.css`.
- **No motion:** nothing animates, so there is nothing to turn off for reduced motion.

## The pages

### Download page, top to bottom

1. **Skip link** ("Skip to content", visible on focus), then the menu.
2. **The opening:** the preview pill, the headline, the lead line, a short line naming the maker and the warning to
   expect (with a link to the steps), the download button, and under it the version line (with "Release notes") and
   what Windows it needs. The picture beside it (or under it on narrow screens). The maker, that it's unsigned and the
   expected warning all come before the button (the plan's decision 1). The button downloads the file directly from
   GitHub (below); the steps are one link away for those who read first.
3. **The band.**
4. **"An early preview, said plainly":** two short columns, Unsigned and Not independently audited.
5. **"Three steps to install":** three numbered cards. 1 Download (version line, where to get it from, when setup needs
   the internet, a second download button). 2 Check the file matches, optional (the PowerShell line, what it should print, the stop
   line, the fingerprint). 3 Open it (what the browser and Windows will show, and why).
6. **"What happens to your vaults":** four columns (Installing, Updating, Uninstalling, Going back), then a box,
   "Deleting a vault on purpose", with a link to the guide's steps.
7. **"What you need":** Windows, when setup needs the internet, and what this preview doesn't offer yet.
8. **Footer:** the mark and name, links (Release notes, Older versions, Source code, Security policy), the licence line.

**Before the first release:** shown only when `site/release.json` is exactly `{"tag": null}`. A missing, unreadable or
differently shaped file, or a tag the build can't verify, stops the build with no output, as the plan's release rules
say, so a broken release choice never publishes an empty page. In this state both download buttons become a plain label,
"Coming soon", that is not a link; the version line reads "The first preview isn't out yet."; step 2 keeps its words and
the PowerShell line with `Petalock_<version>_x64-setup.exe` in place of the file name and `<fingerprint>` in place of
the hash, and says "The fingerprint appears here with the first
release." Everything else stays. Task 6 adds `coming_soon_only_from_an_explicit_null` beside its refusal tests. **my
call**: the page can go live before the release without a broken button.

**Where things point:** the download buttons go to the fixed GitHub release address,
`https://github.com/sumguywhowantstobuild/petalock/releases/download/<tag>/<file>`; the file name in the button, the
PowerShell line and the fingerprint come from the release's real installer asset, never typed. Size is the file's bytes
divided by 1,000,000, one decimal, "MB"; the date is the release's publish date in UTC, as "8 December 2026". The pages
are `/` (download), `/guide/` (guide) and `/404.html`. Help in the app opens only the one fixed address
`https://petalock.arielmaningas.com/guide/` (Task 8); the section anchors (`/guide/#uninstall` and so on) are for the
download page's own links.

### Guide page

A shorter blue header (300 px; 220 px on a phone) with "Guide", one line under it, and the engraved logo low at the right,
cropped by the header's foot: drawn over a 1280 by 300 box kept to the right edge (`preserveAspectRatio="xMaxYMid
slice"`), the logo centred at (1060, 236) at 1.6 pixels per logo unit, weight 2.45 / 1.6 (about 1.53). At V2's place
(centred at 1060, 160, 2.4 per unit) the fine lines ran behind the menu links; lower and smaller, they clear them. The
line under "Guide" is up to 560 px wide. Below 1024 px the picture is not drawn in the guide header: there it ran behind
that line (checked at 641 and 820 px); from 1024 px they clear. The words come first, and the download page's opening
still shows the logo at every width. **my call**, 2026-11-27. Below it,
on the paper: a list of sections on the left that stays in view while reading ("On this page"), the sections on the
right. At 900 px and narrower the list goes above the sections. The guide's full words are written in Task 6 from `docs/GUIDE.md`
and reviewed with that task (high risk, so an independent review reads them before they ship); the check and deletion
steps are word for word the ones below. Its sections, in this order, each with an anchor (`#install`,
`#delete-a-vault` and so on), after a short opening (below) that gives the preview disclosure, the official sources and
the tested Windows version before any install instruction, and what each must say:

| Section | Must say |
|---|---|
| Install | No administrator password; Petalock goes into your own user folder. If Petalock is running, setup asks you to quit it from its icon by the clock, with Retry and Cancel; it never closes Petalock itself. |
| Check the file | The words below, the PowerShell line (labelled with its version in the guide), and what to do on False. For people with GitHub's command-line tool, GitHub's build record too, as a quoted path pinned to the release workflow file on `main` by its certificate identity: `gh attestation verify "$HOME\Downloads\Petalock_<version>_x64-setup.exe" --repo sumguywhowantstobuild/petalock --cert-identity "https://github.com/sumguywhowantstobuild/petalock/.github/workflows/release.yml@refs/heads/main" --source-ref refs/heads/main`, which should report the release workflow on `main`; anything else or a failure means stop and delete the file. For a file saved elsewhere or renamed, the two-line alternative (below) takes the path once as data in `$f`, and the guide's `gh attestation verify $f` with the same pins checks the same file. |
| The warnings | In this order: the stop rules (a malware or virus finding, any administrator permission prompt); keep the file only for the "not commonly downloaded" notice; at SmartScreen's unrecognized-app screen, if any check failed, delete the file; otherwise, if it came from an official place or printed True in the check, More info then Run anyway; Smart App Control, as on the download page (the words are below). |
| Internet and WebView2 | Setup goes online only when WebView2 is missing, to get it from Microsoft. Microsoft installs a shared WebView2 Runtime that other apps use too; Petalock's uninstall leaves it installed. If setup's download fails, install Microsoft's official "Evergreen Standalone" WebView2 Runtime from Microsoft's website, then run setup again. What the WebView2 installer itself changes on the PC is Microsoft's, not Petalock's. |
| Update | Install over the old version; what stays; no automatic updates (below). |
| Uninstall | Where to find it in Settings; the program and the copies of opened files go, vaults stay; if the uninstaller says some opened copies are still in use or could not be removed, close whatever holds them, then choose Retry (Cancel leaves Petalock installed, and some copies may already be gone); what the "Delete the application data" box removes and what stays. Before the uninstall steps (Petalock is needed for both): note where your vaults are (new vaults default to `%USERPROFILE%\Petalock Vaults\`, others stay where they were made) and finish any restore in progress. After a successful uninstall, as an optional removal of Petalock's own records (not a promise of "no trace"): delete `%LOCALAPPDATA%\Petalock`, which holds the settings, the vault list and the restore and output records, never the vaults; if the deleted folder appears in the Recycle Bin, select that entry only and delete it permanently (never "empty" the bin). |
| Going back | Older versions on the releases list, with the caution below; each release lists its own installer and its own fingerprint (its `.sha256` file), so checking an older version downloaded from Petalock's GitHub releases is optional, and a copy from anywhere else must match that release's own fingerprint before it is opened, never a checksum that came with the copy, and not the page's (amendment 2026-11-28, review finding 5 and the re-check). |
| Delete a vault | The words below. |
| If Petalock won't start | Restart, look for the icon by the clock, check WebView2 is installed; the vaults stay safe in their folders. |

### Not-found page

All blue: the menu, the engraved logo centred (up to 300 px, weight 1.4, since it is shown at about 1.4 pixels per
logo unit; **my call**, 2026-11-27), a "404 · Page not found" pill, a heading, one line, and two buttons back to the
download page and the guide. It also tells people where the only real downloads are.

## The words

Amended 2026-11-28: the file check is optional; where the blocks below and
[the amendment](2026-11-28-optional-file-check-amendment.md) differ, the amendment wins.

These are final once approved; Task 6's `pages_say_what_the_design_says` checks them word for word. Version, size, date
and fingerprint are filled from the real release at build; `0.1.0` and the rest are examples.

**How to read this list:** a " / " separates sentences or blocks shown one after another and is not shown itself. The
element names "Pill:", "Headline:", "Lead:", "Before the button:", "Button:", "Link:", "Folded:", "Version line:" and
"Needs line:" are not shown; every other heading before a colon (a step's title such as "1 Download", "Unsigned",
"Installing") is shown as that block's heading, without the colon. " · " is always shown. **bold** marks text shown
bold. The PowerShell line is shown exactly as written, straight quotes included. Elsewhere, quotation marks shown on the
page are curly (“ ” and ’); the test compares after treating straight and curly apostrophes as the same, so the source
may use either.

**Page title:** Petalock: download for Windows · **Guide title:** Petalock: guide · **Not found title:** Page not found
· Petalock

**The opening**
- Pill: Early preview · Unsigned and not independently audited.
- Headline: Your secrets, in print only you can read.
- Lead: A password manager and file vault for Windows. Your vaults stay on your PC, encrypted.
- Before the button: Made by Ariel Maningas. It’s unsigned, so your browser and Windows may warn you. Link: Which
  warnings mean stop? (to step 3, anchor `#open`; step 2 keeps `#check`)
- Button: Download for Windows
- Version line: Version 0.1.0 · 7.1 MB · 8 December 2026 · Release notes
- Needs line: Windows 11, 64-bit

**An early preview, said plainly**
- Unsigned: Petalock has no code-signing certificate yet, so Windows can't tell who made the file. Your browser and
  Windows may warn you before it runs.
- Not independently audited: No outside security firm has checked Petalock's code yet. The code is public, so anyone
  can read it.

**Three steps to install**
- 1 Download: Version 0.1.0 · 7.1 MB · 8 December 2026. / Get Petalock only from petalock.arielmaningas.com or
  github.com/sumguywhowantstobuild/petalock. / Setup needs the internet only if your PC lacks Microsoft Edge WebView2,
  which Windows 11 includes: setup then gets it from Microsoft. Petalock has no online features: it sends nothing about
  you or your vaults anywhere. / Button: Download
- 2 Check the file matches (optional): About a minute. If you downloaded it from petalock.arielmaningas.com or
  Petalock’s GitHub releases, you can skip this. Got it anywhere else? The simplest is to download it again from this
  page; to use that copy anyway, check it first (for another version, against that release’s fingerprint on GitHub, as
  the guide shows). Open PowerShell and paste this line (click in the box, press Ctrl+A, then Ctrl+C):
  `(Get-FileHash -LiteralPath "$HOME\Downloads\Petalock_0.1.0_x64-setup.exe").Hash -eq "<FINGERPRINT IN CAPITALS>"`
  / If you saved it somewhere else, or your browser renamed it (for example with “(1)” at the end), use these two lines
  instead. Paste both, then type or paste the file’s full path when PowerShell asks, without quotation marks. / Label:
  PowerShell lines for a file saved elsewhere or renamed, with the two lines in a second read-only box:
  `$f = Read-Host "Full path of the downloaded file"` then
  `(Get-FileHash -LiteralPath $f).Hash -eq "<FINGERPRINT IN CAPITALS>"` (the path is typed at a prompt, so it is data and
  never parsed as code). / It should print True, which means the file matches the fingerprint published for this
  version. / **If it prints False,
  stop. Don't open the file: delete it and download it again from this page.** / Folded: See the fingerprint → the
  fingerprint (SHA-256) in groups of eight.
- 3 Open it: Because the file is unsigned and new, you may see warnings. The exact words may differ on your PC. /
  **Stop and delete the file if your browser or a security product says it found malware or a virus, or if Windows asks
  for administrator permission in any form (a password or a Yes/No prompt): setup never needs it.** / Your browser may
  say the file isn't commonly downloaded. Choose to keep it, and only for that notice. / Windows may show “Windows
  protected your PC”, saying it prevented an unrecognized app from starting. If any check you ran on this file failed,
  don’t run it: delete it. Otherwise, if the file came from this site or Petalock’s GitHub releases, or it printed True
  in step 2, choose More info, then Run anyway, for that screen only. / These notices mean Windows doesn't know the file yet, not
  that it found something wrong. A fake copy can show the same notices, so get Petalock only from this site or its
  GitHub releases. / If Smart App Control is on, Windows may block Petalock with no Run anyway option. This preview can’t run on that PC
  until Petalock is signed; we don’t suggest turning Smart App Control off for it.

**What happens to your vaults**
- Installing: Petalock goes into your own user folder; no administrator needed. It makes no vault until you create one.
- Updating: Install the new version over the old one. Your vaults, settings and “start with Windows” stay as they are.
  Petalock doesn’t update itself or tell you about new versions: check this page or the releases list.
- Uninstalling: Removes the program and its temporary copies of opened files. Your vaults are never deleted, and nor
  are Petalock’s settings and list of vaults; the guide shows how to remove those too.
- Going back: Older versions stay on the releases list. Setup lets you install one over a newer version, but going back
  hasn’t been tested: an older version may not open vaults or settings a newer one has changed, so keep a tested backup
  before you try. If a release is
  withdrawn, this page goes back to the last good one and the withdrawn release’s notes say why.
- Deleting a vault on purpose: Petalock can't delete a vault for you yet. First note the vault's exact folder (in
  Petalock, choose Show in File Explorer). If you might want the vault back, make sure you have a tested backup you can
  restore. Then remove it from the list in Petalock, then delete that folder in File Explorer. / Link: Step by step in
  the guide. (Reordered after the Task 6 review, 2026-11-27, to match the guide; the tested backup restored in the
  corrections.)

**What you need:** Windows 11, 64-bit. Windows 10 (64-bit) should work but hasn't been tested. / Setup needs the
internet only if your PC lacks Microsoft Edge WebView2 (the same line as step 1).

**Not offered yet** (a line at the end of "What you need"): No code signature (Authenticode or PGP), no package
managers and no automatic updates in this preview: the optional check in step 2 shows a file matches the one published
(the guide also shows GitHub’s build record, which shows the workflow that built it).

**Footer:** Release notes · Older versions · Source code · Security policy / Petalock is free and open source (MIT).
Made by Ariel Maningas.

**Guide: Install:** Get the installer from the download page and open it. Checking its fingerprint first is optional (the
next section). (Then the words about the administrator password, quitting a running Petalock and the setup screen, as in
the table.)

**Guide: Check the file:** Optional. If you downloaded the file from petalock.arielmaningas.com or Petalock’s GitHub
releases, you can skip this. For a copy from anywhere else, the simplest is to download it again from the download page;
to use that copy anyway, check it first: for the version the download page offers, with the lines below; for any other
version, against that release’s own fingerprint (Going back, below). / Every release lists the file's fingerprint. Paste
the PowerShell line from the download page; it prints True when the file matches the fingerprint published for that
version. GitHub’s build record (below) is the separate check of which workflow built it. / If you saved the file somewhere other than Downloads, or your browser renamed it,
use these two lines instead. Paste both, then type or paste the file’s full path when PowerShell asks, without quotation
marks. (The two lines as on the download page; in the guide, each box is labelled with its version, "for version
0.1.0" or "for the first release".) / **If it prints False, stop and delete the file.** / For people with GitHub's
command-line tool: if it reports anything else or fails, stop and delete the file. For a file saved elsewhere or
renamed, run this in the same PowerShell window right after the two lines above, so it checks the same file:
`gh attestation verify $f --repo sumguywhowantstobuild/petalock --cert-identity
"https://github.com/sumguywhowantstobuild/petalock/.github/workflows/release.yml@refs/heads/main" --source-ref
refs/heads/main`.

**Guide: Uninstall (the records):** Before you uninstall, note where your vaults are: new vaults go in
%USERPROFILE%\Petalock Vaults\, and a vault you made somewhere else stays there. Finish any restore that is in progress,
because you need Petalock for both. / (the Settings steps and the uninstaller's Retry words, as in the table) /
Optionally, once the uninstall has finished, you can also remove Petalock’s own records by deleting the folder
%LOCALAPPDATA%\Petalock: it holds the settings, the list of vaults and the restore and output records, never the
vaults. In File Explorer, delete the folder named Petalock. If the deleted folder appears in the Recycle Bin, you can
select that entry only and delete it permanently; if Windows says it will delete permanently and you didn't expect
that, cancel.

**Guide: Delete a vault:** First note the vault's exact folder (in Petalock, choose Show in File Explorer). If you
might want the vault back, make sure you have a tested backup you can restore. Then remove the vault from Petalock's
list, then delete that folder in File Explorer. It usually goes to the Recycle Bin; a very large folder or some drives
delete it for good, so if Windows says it will delete it permanently and you didn't expect that, cancel. If the deleted
folder appears in the Recycle Bin, you can select that entry only and delete it permanently. (Changed after the Task 6
review, 2026-11-27: the folder is noted before the list entry goes, the Recycle Bin is not promised, and the bin is
never "emptied", which would delete unrelated files.)

**Guide: opening (before Install):** Petalock is an early preview: it is unsigned and has not been independently
audited. / Get Petalock only from petalock.arielmaningas.com or github.com/sumguywhowantstobuild/petalock. / Windows 11,
64-bit is the only tested setup. Windows 10 (64-bit) should work but hasn't been tested.

**Guide: The warnings:** An unsigned, new file may get warnings from your browser and from Windows. They mean Windows
doesn't know the file yet, not that it found something wrong; the exact words may differ on your PC. A matching
fingerprint shows the file matches the one we published. It does not mean no security product will object to it. /
**Stop and delete the file if your browser or a security product says it found malware or a virus, or if Windows asks
for administrator permission in any form (a password or a Yes/No prompt): setup never needs it.** / Your browser may say
the file isn't commonly downloaded: choose to keep it, and only for that notice. Windows may show “Windows protected
your PC”, saying it prevented an unrecognized app from starting. If any check you ran on this file failed, don’t run it:
delete it. Otherwise, if the file came from the download page or Petalock’s GitHub releases, or it printed True in the
check above, choose More info, then Run anyway, for that screen only. / Smart App Control, as on the download page.

**Not-found page:** 404 · Page not found / This page isn't here. / The address may be mistyped, or the page has moved.
Download Petalock only from this site or its GitHub releases. / Buttons: Go to the download page · Read the guide

**Links:** Release notes → the chosen release's page on GitHub; Older versions → the releases list; Source code → the
repository; Security policy → `SECURITY.md` on GitHub. Task 6's `every_link_resolves` checks each.

## Changes from the drawings

The drawings carried draft words and a few gaps; this document changes them as follows.

- **The file check is optional** (amendment 2026-11-28, option A): the opening's link, step 2's title and first line,
  step 3's order and conditions and the guide's warnings follow
  [the amendment](2026-11-28-optional-file-check-amendment.md), which wins over the drawings and the original word list.

- **The picture on the guide and not-found pages:** Ariel approved the engraved picture on the download page; the guide
  header and the not-found page take the same picture, placed and weighted as described above, drawn in `final.mjs`
  for this document (the V2 drawings had the halftone there). **my call**.
- **What Windows it needs:** the drawings said "Windows 10 or 11, 64-bit". Only Windows 11 is tested (the plan's
  platform rule), so the page says Windows 11 and that Windows 10 is expected to work but untested. **standard**.
- **Where to get it:** added the official address and the GitHub repository in words to step 1; the drawings had a
  source line only on the not-found page. **standard** (Task 6's tests look for an official-source line).
- **The maker and the warning before the button:** a line above the opening's button, as the plan's decision 1 asks.
- **The PowerShell line's file:** added the line about another folder or a renamed file; the command assumes Downloads.
  **my call**.
- **Smart App Control:** where it is on, there is no Run anyway; step 3 and the guide say so without telling people to
  turn it off. **standard**.
- **Uninstalling:** the settings and vault list stay after an uninstall (the "Delete the application data" box removes
  only the app's two identifier folders under `AppData`, where the browser engine keeps its data, by the installer's
  rules), so the page says so and the guide shows the manual removal of Petalock's records as optional, after the
  uninstall and after noting where the vaults are (it does not promise "no trace": a deleted folder sits in the Recycle
  Bin until it is emptied). **standard**.
- **The PowerShell line's box:** a read-only text box instead of a selectable code block, so keyboard users can copy
  it too. **standard**.
- **Updating and "not offered yet":** no automatic updates, signatures or package managers, said on the page as the
  plan's practice line asks; and what happens when a release is withdrawn. **standard**.
- **Going back:** worded as untested (no test installs an older version over a newer one) with a backup first.
  **standard**.
- **No absolute claims:** "keeps everything on your PC" and "never goes online" became what is true (opened files are
  decrypted copies; Help opens the website). **standard**.
- **Focus ring on blue:** cream on the blue areas, where a blue ring would vanish; links in text underlined.
  **standard**.
- **Release notes beside the version:** added to the version line in the opening; the drawings had it only in the
  footer. **my call**.
- **Before the first release:** the "Coming soon" state is new (Task 6 builds the page before the release exists).
- **High contrast:** the drawings had no `forced-colors` rules; added above. **standard**.
- **The fingerprint's spoken form:** the drawings put the whole hash in an `aria-label` on a plain `span`, which screen
  readers don't reliably read. The groups stay as visible text, read as they are. **standard**.

## What Task 6 still decides

Decided in Task 6: the picture is drawn inline on each page (it follows the high-contrast rule above); the second point
is still for Task 13. The choice as it was written:

- **The picture's weight:** drawn inline as `intaglio.mjs` writes it (two decimals, a point every 1.5°), the picture
  is about 164 KB of SVG on each of the three pages. Task 6 may round to fewer decimals or sample less often if the
  picture looks the same at 1536 wide, and chooses between inline SVG and a same-site SVG file (`img-src
  'self'` allows it). A file can't take the page's colour variables, and the site's security header would block a
  `<style>` inside it, so the file route means a light and a dark file for each page in a `picture` element, coloured
  by presentation attributes (each page's picture has its own weight, and the guide's its own crop, so one pair can't
  serve all three); a Windows contrast theme doesn't recolour images, so there the picture is hidden (it is
  decorative). Inline, the picture follows the high-contrast rule above. Either way it must look as drawn in both
  themes.
- **The real warnings' wording** is confirmed on a real run in Task 13; the page's words already allow for differences.

## Testing

Task 6 owns the tests (its section in the plan): the words above checked word for word, every link, nothing loaded from
elsewhere, the exact headers, and the axe check on each page at 1280×800 and 390×844, light and dark, with its skipped
count recorded. Task 12 compares the built pages with the drawings named above, at those widths and at 1536 wide (where
Ariel placed the picture), and in a Windows contrast theme.

## Out of scope

The portfolio site, a logo change, real vault data in screenshots, the installer's own look (parked from Task 1),
visitor counts, forms, translations and a blog.
