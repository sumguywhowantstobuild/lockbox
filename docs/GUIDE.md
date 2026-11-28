# The Petalock guide

Petalock keeps your passwords, keys, notes and files on your own PC, in an encrypted folder called a vault. There is no
account and no server. This guide is short on purpose. The longer, exact version of what Petalock can and can't protect is
in [SECURITY.md](../SECURITY.md).

This is the text of the guide page, https://petalock.arielmaningas.com/guide/, which Help in Petalock opens. The two are
kept the same; the page's own file is `site/guide/index.html`, where the PowerShell lines carry the current release's
version and fingerprint.

Petalock is an early preview: it is unsigned and has not been independently audited. Please don't keep your real
passwords in it yet.

Get Petalock only from petalock.arielmaningas.com or github.com/sumguywhowantstobuild/petalock.

Windows 11, 64-bit is the only tested setup. Windows 10 (64-bit) should work but hasn't been tested.

## Install

Get the installer from the [download page](https://petalock.arielmaningas.com/) and open it. Checking its fingerprint
first is optional (the next section). No administrator password is needed: Petalock goes into your own user folder. If
Petalock is running, setup asks you to quit it from its icon by the clock, with Retry and Cancel; it never closes
Petalock itself.

Setup shows what it will do on one screen. Choose Install; to put Petalock in another folder, open Options first. When it
has finished, you can open Petalock from that screen or from the Start menu.

## Check the file

Optional. If you downloaded the file from petalock.arielmaningas.com or Petalock's GitHub releases, you can skip this.
For a copy from anywhere else, the simplest is to download it again from the
[download page](https://petalock.arielmaningas.com/); to use that copy anyway, check it first: for the version the
download page offers, with the lines below; for any other version, against that release's own fingerprint (Going back,
below).

Every release lists the file's fingerprint. Paste the PowerShell line from the download page; it prints True when the file
matches the fingerprint published for that version. GitHub's build record (below) is the separate check of which workflow
built it. The page fills in the version and the fingerprint; the line looks like this:

```
(Get-FileHash -LiteralPath "$HOME\Downloads\Petalock_<version>_x64-setup.exe").Hash -eq "<fingerprint>"
```

If you saved the file somewhere other than Downloads, or your browser renamed it, use these two lines instead. Paste both,
then type or paste the file's full path when PowerShell asks, without quotation marks.

```
$f = Read-Host "Full path of the downloaded file"
(Get-FileHash -LiteralPath $f).Hash -eq "<fingerprint>"
```

**If it prints False, stop and delete the file.**

If you have GitHub's command-line tool, you can also check GitHub's build record for the file. It should report the
release workflow on `main`; if it reports anything else or fails, stop and delete the file.

```
gh attestation verify "$HOME\Downloads\Petalock_<version>_x64-setup.exe" --repo sumguywhowantstobuild/petalock --cert-identity "https://github.com/sumguywhowantstobuild/petalock/.github/workflows/release.yml@refs/heads/main" --source-ref refs/heads/main
```

For a file saved elsewhere or renamed, run this in the same PowerShell window right after the two lines above, so it
checks the same file:

```
gh attestation verify $f --repo sumguywhowantstobuild/petalock --cert-identity "https://github.com/sumguywhowantstobuild/petalock/.github/workflows/release.yml@refs/heads/main" --source-ref refs/heads/main
```

## The warnings

An unsigned, new file may get warnings from your browser and from Windows. They mean Windows doesn't know the file yet,
not that it found something wrong; the exact words may differ on your PC. A matching fingerprint shows the file matches
the one we published. It does not mean no security product will object to it.

**Stop and delete the file if your browser or a security product says it found malware or a virus, or if Windows asks for
administrator permission in any form (a password or a Yes/No prompt): setup never needs it.**

Your browser may say the file isn't commonly downloaded: choose to keep it, and only for that notice. Windows may show
"Windows protected your PC", saying it prevented an unrecognized app from starting. If any check you ran on this file
failed, don't run it: delete it. Otherwise, if the file came from the
[download page](https://petalock.arielmaningas.com/) or Petalock's GitHub releases, or it printed True in the check
above, choose More info, then Run anyway, for that screen only.

If Smart App Control is on, Windows may block Petalock with no Run anyway option. This preview can't run on that PC until
Petalock is signed; we don't suggest turning Smart App Control off for it.

## Internet and WebView2

Setup goes online only when Microsoft Edge WebView2 is missing, to get it from Microsoft. Windows 11 includes it.
Microsoft installs a shared WebView2 Runtime that other apps use too; Petalock's uninstall leaves it installed. If setup's
download fails, install Microsoft's official "Evergreen Standalone" WebView2 Runtime from Microsoft's website, then run
setup again. What the WebView2 installer itself changes on the PC is Microsoft's, not Petalock's.

Petalock has no online features: it sends nothing about you or your vaults anywhere.

## First steps

Open Petalock and choose Create a vault. Give the vault a name. The name isn't encrypted, so don't put anything secret in
it.

Choose a password and type it twice. Use at least 12 characters. A password that is easy to guess is still easy to guess,
however well Petalock protects it.

Petalock shows your recovery key once. Save it before you go on (see the next part). Then Petalock asks you to pick the
right word for three of the numbers, to show you saved it. Your vault is then open and empty: add a login, a key, a note
or a file, or paste a whole `.env`.

Petalock locks your vaults by itself after 5 minutes with no keyboard or mouse use on this PC (you can change this in
Settings), so working in other apps keeps them open; it also locks them when Windows locks or goes to sleep. It clears a
password you copied from the clipboard after 30 seconds.

## The recovery key

The recovery key is 24 numbered words. It is the only way back in if you forget your password.

**If you lose both your password and your recovery key, nobody can get your data back.**

Print it or save it as a PDF, and keep it somewhere that isn't this PC. Writing it down by hand is fine.

Don't take a screenshot or a recording of it, and don't share your screen while it is showing. Petalock asks Windows to
show its window blank in screenshots, recordings and screen sharing, but Windows doesn't guarantee that, so anyone who
captures the key could open a copy of your vault.

Forgot your password? On the lock screen choose Forgot password? and type your recovery key. To get a new recovery key,
use New recovery key in Settings. The old key stops working for that vault, but a backup made earlier still needs the old
one.

## Backups, on another drive

A backup is one encrypted file with a copy of a vault. Make one once the vault holds things you'd miss. In Settings,
choose Back up, and keep the backup on another drive.

A backup opens with the password or recovery key the vault had on the day the backup was made. Changing your password
later doesn't change what an old backup needs.

Check a backup works with Test a backup in Settings. It changes nothing. To bring a vault back, or to move to a new PC,
use Restore a backup, or I already have a vault or a backup on the first screen of Petalock on the new PC.

## The trash

Items you delete go to the Trash, and you can restore them from there. Petalock never empties the trash by itself. Empty
trash (or Delete for good on one item) deletes them for good and can't be undone, though a backup made earlier still
holds them.

## Exporting a vault

Export in Settings writes your logins, keys and notes to a file that other programs can read. **That file isn't
protected: anyone who gets it can read every password in it.** Petalock warns you first.

When you are done with the file, delete it, then empty the Recycle Bin. A deleted file can also stay behind on an SSD, or
in a cloud service's older versions. Don't open the file in a spreadsheet: a value that starts with `=` can be run as a
formula. Don't save it in a folder that a cloud service syncs: it would be uploaded unprotected, and Petalock asks first
if you do. Stored files and earlier passwords aren't in an export.

## What Petalock can't protect against

Petalock protects a copy of your vault folder: without your password or recovery key nobody can read your items, though
the vault's name, how many files it has, their sizes and dates can be seen. It can't help with these:

**Malware on your PC while a vault is open.** It can see what Petalock can see.

**Someone who has your password or recovery key.**

**A weak password.** Each guess against a copied vault is made slow, but a guessable password is still guessable.
Petalock doesn't lock anyone out after wrong passwords, because someone with a copy of the folder doesn't need Petalock.

**Old copies of a vault.** Changing your password, or making a new recovery key, doesn't change the vault's main key.
Someone who has an old copy of the vault (an old backup, for example) and the old password or recovery key can open that
copy. They can open your newer items too, if they also get copies of them.

**Copies Windows makes.** Windows may write secrets to its own files, such as the pagefile, the hibernation file, crash
dumps and the print queue. Turn on full-disk encryption (BitLocker on Windows Pro and above, or Device encryption on PCs
that have it).

**Other programs.** Any program running as you can read the clipboard while a copy is on it. A file you open with another
program may be copied by that program.

## Update

Install the new version over the old one. Your vaults, settings and "start with Windows" stay as they are. Petalock
doesn't update itself or tell you about new versions: check the [download page](https://petalock.arielmaningas.com/) or
the [releases list](https://github.com/sumguywhowantstobuild/petalock/releases).

## Uninstall

Before you uninstall, note where your vaults are: new vaults go in `%USERPROFILE%\Petalock Vaults\`, and a vault you made
somewhere else stays there. Finish any restore that is in progress, because you need Petalock for both.

Open Settings, then Apps, then Installed apps, find Petalock and choose Uninstall: the program and the temporary copies
of opened files go; your vaults stay where they are.

If the uninstaller says some opened copies of your files are still in use or could not be removed, close whatever holds
them, then choose Retry. Cancel stops there and leaves Petalock installed. Some copies may already have been removed by
then.

The "Delete the application data" box removes only the two folders under AppData where Petalock's web view keeps its
data. It never removes a vault, and it leaves Petalock's settings and its list of vaults.

Optionally, once the uninstall has finished, you can also remove Petalock's own records by deleting the folder
`%LOCALAPPDATA%\Petalock`: it holds the settings, the list of vaults and the restore and output records, never the vaults.

1. Press the Windows key and R, type `%LOCALAPPDATA%` and press Enter.
2. In File Explorer, delete the folder named Petalock. If the deleted folder appears in the Recycle Bin, you can select
   that entry only and delete it permanently; if Windows says it will delete permanently and you didn't expect that,
   cancel.

## Going back

Older versions stay on the [releases list](https://github.com/sumguywhowantstobuild/petalock/releases). Each release
lists its own installer and its own fingerprint. Checking an older version you downloaded from Petalock's GitHub
releases is optional. A copy from anywhere else must match that release's own fingerprint (the .sha256 file on its page)
before you open it, never a checksum that came with the copy; compare the exact file you will open with it, not with the
download page's: its PowerShell line is for its own version only.

Setup lets you install one over a newer version, but going back hasn't been tested: an older version may not open vaults
or settings a newer one has changed, so keep a tested backup before you try. If a release is withdrawn, the download page
goes back to the last good one and the withdrawn release's notes say why.

## Delete a vault

Petalock can't delete a vault for you yet. First note the vault's exact folder (in Petalock, choose Show in File
Explorer). If you might want the vault back, make sure you have a tested backup you can restore. Then remove the vault
from Petalock's list, then delete that folder in File Explorer. It usually goes to the Recycle Bin; a very large folder or
some drives delete it for good, so if Windows says it will delete it permanently and you didn't expect that, cancel. If
the deleted folder appears in the Recycle Bin, you can select that entry only and delete it permanently.

In Petalock, the two choices are in the menu under your vault's name:

1. Show (the vault's name) in Explorer opens the vault's folder. Note which folder it is.
2. Remove (the vault's name) from this list takes the vault off the list. The folder and everything in it stay on your
   PC, and you can add the vault back with Add existing vault folder.

## If Petalock won't start

If Petalock says "Petalock can't start. Your vaults aren't affected.", or doesn't open, try these in order. Your vaults
stay safe in their folders either way, and your backups still open on another PC.

1. Restart your PC and try again.
2. Look for Petalock's icon by the clock. If Petalock is already running, opening it again brings that one forward.
3. Check that Microsoft Edge WebView2 Runtime is installed. Petalock draws its window with it, and it comes with
   Windows 11. Petalock won't start if it can't confirm that its safety settings are on.
4. Petalock also won't start if it can't listen for Windows locking and sleeping.
