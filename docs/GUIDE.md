# The Petalock guide

Petalock keeps your passwords, keys, notes and files on your own PC, in an encrypted folder called a vault. There is no
account and no server. This guide is short on purpose. The longer, exact version of what Petalock can and can't protect is
in [SECURITY.md](../SECURITY.md).

Petalock is still being built and **hasn't been checked by an independent security expert**. Please don't keep your real
passwords in it yet.

## First steps

1. Open Petalock and choose **Create a vault**.
2. Give the vault a name. The name isn't encrypted, so don't put anything secret in it.
3. Choose a password and type it twice. Use at least 12 characters. A password that is easy to guess is still easy to
   guess, however well Petalock protects it.
4. Petalock shows your **recovery key** once. Save it before you go on (see the next part). Then Petalock asks you to pick
   the right word for three of the numbers, to show you saved it.
5. Your vault is open and empty. Add a login, a key, a note or a file, or paste a whole `.env`.

Petalock locks your vaults by itself after 5 minutes with no keyboard or mouse use on this PC (you can change this in
Settings), so working in other apps keeps them open; it also locks them when Windows
locks or goes to sleep. It clears a password you copied from the clipboard after 30 seconds.

## The recovery key

The recovery key is 24 numbered words. It is the only way back in if you forget your password.

- **If you lose both your password and your recovery key, nobody can get your data back.**
- Print it or save it as a PDF, and keep it somewhere that isn't this PC. Writing it down by hand is fine.
- Don't take a screenshot or a recording of it, and don't share your screen while it is showing. Petalock asks Windows to
  show its window blank in screenshots, recordings and screen sharing, but Windows doesn't guarantee that, so anyone who
  captures the key could open a copy of your vault.
- Forgot your password? On the lock screen choose **Forgot password?** and type your recovery key.
- To get a new recovery key, use **New recovery key** in Settings. The old key stops working for that vault, but a backup
  made earlier still needs the old one.

## Backups, on another drive

A backup is one encrypted file with a copy of a vault. Make one once the vault holds things you'd miss.

- In Settings, choose **Back up**, and keep the backup on another drive.
- A backup opens with the password or recovery key the vault had **on the day the backup was made**. Changing your
  password later doesn't change what an old backup needs.
- Check a backup works with **Test a backup** in Settings. It changes nothing.
- To bring a vault back, or to move to a new PC, use **Restore a backup**, or **I already have a vault or a backup** on
  the first screen of Petalock on the new PC.

## What Petalock can't protect against

Petalock protects a copy of your vault folder: without your password or recovery key nobody can read your items, though
the vault's name, how many files it has, their sizes and dates can be seen. It can't
help with these:

- **Malware on your PC while a vault is open.** It can see what Petalock can see.
- **Someone who has your password or recovery key.**
- **A weak password.** Each guess against a copied vault is made slow, but a guessable password is still guessable.
  Petalock doesn't lock anyone out after wrong passwords, because someone with a copy of the folder doesn't need Petalock.
- **Old copies of a vault.** Changing your password, or making a new recovery key, doesn't change the vault's main key.
  Someone who has an old copy of the vault (an old backup, for example) and the old password or recovery key can open
  that copy. They can open your newer items too, if they also get copies of them.
- **Copies Windows makes.** Windows may write secrets to its own files, such as the pagefile, the hibernation file,
  crash dumps and the print queue. Turn on full-disk encryption (BitLocker on Windows Pro and above, or Device
  encryption on PCs that have it).
- **Other programs.** Any program running as you can read the clipboard while a copy is on it. A file you open with
  another program may be copied by that program.

## The trash

Items you delete go to the **Trash**, and you can restore them from there. Petalock never empties the trash by itself.
**Empty trash** (or **Delete for good** on one item) deletes them for good and can't be undone, though a backup made
earlier still holds them.

## Deleting a vault

Petalock can't delete a vault for you yet. To delete one, remove it from the list, then delete its folder yourself:

1. Open the menu under your vault's name, and choose **Show (the vault's name) in Explorer**. Note which folder it is.
2. In the same menu, choose **Remove (the vault's name) from this list**. The folder and everything in it stay on your
   PC, and you can add the vault back.
3. If you might want the vault back, check that you have a backup of it first, and test the backup (see "Backups"
   above). Deleting the folder deletes the vault and everything in it.
4. In Explorer, delete that one folder. It goes to the Recycle Bin. To get rid of it for good, open the Recycle Bin and
   delete just that folder from it. Leave everything else in the bin alone. A big vault may be too large for the
   Recycle Bin: Explorer then asks whether to delete it permanently, at once.

## Exporting a vault

**Export** in Settings writes your logins, keys and notes to a file that other programs can read. **That file isn't
protected: anyone who gets it can read every password in it.** Petalock warns you first.

- When you are done with the file, delete it, then empty the Recycle Bin. A deleted file can also stay behind on an SSD,
  or in a cloud service's older versions.
- Don't open the file in a spreadsheet. A value that starts with `=` can be run as a formula.
- Don't save it in a folder that a cloud service syncs: it would be uploaded unprotected. Petalock asks first if you do.
- Stored files and earlier passwords aren't in an export.

## If Petalock can't start

Petalock says "Petalock can't start. Your vaults aren't affected." Your vaults are safe where they are. Try these, in this
order:

1. Restart your PC and try again.
2. Look for Petalock's icon by the clock. If Petalock is already running, opening it again brings that one forward.
3. Check that Microsoft Edge WebView2 Runtime is installed. Petalock draws its window with it, and it comes with
   Windows 11. Petalock won't start if it can't confirm that its safety settings are on.
4. Petalock also won't start if it can't listen for Windows locking and sleeping.

If none of that helps, your vaults are still in their folders, and your backups still open on another PC.
