// The one place the screens reach the shell: a typed function for each command they use, over `bridge.ts`, which drops
// an answer from a vault that has locked since. A screen imports this, never `@tauri-apps/api` or the bridge itself.
// Every refusal comes out as the plain object the shell sent (see `messages.ts`); a stale answer as `StaleAnswer`.
import {
  call,
  callMany,
  callPair,
  callPlain,
  open,
  type CaptureEvent,
  type JobScope,
  type OperationId,
  type Opened,
  type Outcome,
  type PageNotice,
  type RestoreNotice,
  type SearchResults,
  type SessionRef,
  type Tagged,
} from "./bridge";

export {
  isSessionCurrent,
  onBusy,
  onCapture,
  onCloseAsked,
  onJobStarted,
  onLocked,
  onLockEpoch,
  onNotice,
  onProgress,
  StaleAnswer,
} from "./bridge";
export type {
  BusyEvent,
  CaptureEvent,
  CloseAskedEvent,
  CloseReason,
  Confirm,
  JobKind,
  JobScope,
  JobStartedEvent,
  LockedEvent,
  LockEpochEvent,
  OperationId,
  Opened,
  Outcome,
  PageNotice,
  ProgressEvent,
  RestoreNotice,
  SessionRef,
  Tagged,
} from "./bridge";

/** One vault on the list: no path, ever. `name` is null when its details cannot be read. */
export interface VaultEntry {
  id: number;
  name: string | null;
  available: boolean;
  /** True exactly when the folder holds the vault's header files but neither copy of its details can be read (Ask 8). Another `name: null` vault is `false`. */
  details_damaged: boolean;
}

/** What a session is: a vault, an older copy a restore kept (opened read-only), or a backup opened read-only. */
export type SessionKind = "vault" | "older_copy" | "backup";

export interface SessionInfo {
  session: number;
  generation: number;
  /** A backup's is the backup file's name without `.lockbox-backup`, not the vault's name inside it; an older copy keeps its vault's name. */
  name: string;
  read_only: boolean;
  state: "unlocked" | "locked" | "unavailable";
  /** Says what a read-only session is: an older copy or a backup. A vault's is `vault`. */
  kind: SessionKind;
}

/** What the cleanup at unlock did (spec 6.4), as counts: the shell's `CleanupView`, field by field. */
export interface CleanupView {
  partials_removed: number;
  temps_removed: number;
  retired_deleted: number;
  purges_finished: number;
  /** Unreferenced files moved to `files/orphaned/` (Ask 5). */
  orphans_quarantined: number;
  orphans_restored: number;
  /** Damaged items: when not zero, nothing was quarantined (Ask 4). */
  skipped_damaged: number;
  failed: number;
}

/** The cloud service syncing a vault's folder: a fixed name from the shell, never a path. */
export type CloudProvider = "OneDrive" | "GoogleDrive" | "Dropbox" | "Other";

/**
 * What an unlock found, and so which of the app's questions to ask (Task 8): `header_mac_mismatch` is Ask 3 (answered with
 * `acceptHeader` or `lockVault`), `used_backup_header` Ask 9, `cloud` Ask 10, `cleanup.skipped_damaged` Ask 4 and
 * `cleanup.orphans_quarantined` Ask 5. An already-unlocked vault answers all of them as false, 0 and null.
 */
export interface UnlockView {
  info: SessionInfo;
  used_backup_header: boolean;
  header_mac_mismatch: boolean;
  header_repair_failed: boolean;
  cleanup: CleanupView;
  /** The cloud provider syncing the vault's folder, when this unlock's location check found one (Ask 10). */
  cloud: CloudProvider | null;
  /**
   * The vault's recovery key was made but never typed back (a "not confirmed" mark is in the state folder). True only
   * for a writable, live vault with the mark, on every unlock answer, an already-unlocked one included; a read-only
   * copy is always false. The page then makes a new key at once (21f): `regenerateRecovery`, shown once, typed back,
   * `recoveryConfirmed`.
   */
  recovery_unconfirmed: boolean;
}

/** A vault just created and unlocked, with its recovery key, shown once. The vault is marked "not confirmed" already. */
export interface CreatedView {
  info: SessionInfo;
  recovery_key: string;
}

export type ItemKind = "login" | "key" | "note" | "file" | "collection";

export interface FileView {
  file_id: string;
  name: string;
  length: number;
  media_type: string;
}

/** One item in a list. It never holds a password, a key value or a note's text. */
export interface ItemSummary {
  id: string;
  kind: ItemKind;
  title: string;
  username: string | null;
  collection: string | null;
  trashed: boolean;
  /** When it went to the trash (RFC 3339, UTC, whole seconds); `null` when it is not in the trash. */
  trashed_at: string | null;
  /** The folder whose delete sent it to the trash, when that is why it is there; `null` for one trashed on its own. */
  trashed_with: string | null;
  /** Its delete for good has begun and not finished: it is frozen, and a folder's restore does not bring it back. */
  purging: boolean;
  /**
   * The host of a login's first website (`support.example.com`), and nothing else of the address; `null` when there is
   * none, or the shell would not open it (only `http` and `https` open). Whether to offer "Open site" is this being set.
   */
  site: string | null;
  created_at: string;
  modified_at: string;
  attachments: FileView[];
}

export interface ItemList {
  items: ItemSummary[];
  damaged: string[];
}

/**
 * One of a login's earlier passwords: its number (what Reveal and Copy send back) and when it was replaced (RFC 3339, UTC).
 * Never the password: that crosses only on Reveal, or while editing.
 */
export interface PreviousView {
  index: number;
  replaced_at: string;
}

/** One item opened. A login's password and a key's value are not here: each crosses only on Reveal. */
export interface ItemDetail {
  summary: ItemSummary;
  revision: number;
  notes: string;
  urls: string[];
  has_password: boolean;
  /** A key has a value to reveal or copy. Only whether: the value is not here. */
  has_value: boolean;
  /** A login's earlier passwords, newest first (at most five); empty for every other kind. */
  previous: PreviousView[];
}

/** How the window looks: Light, Dark, or whatever Windows is set to. */
export type Theme = "system" | "light" | "dark";

/** The save shortcut: which of Ctrl, Shift and Alt, and a Windows virtual-key code (65 to 90 for A to Z, 48 to 57 for 0 to 9, 112 to 123 for F1 to F12). */
export interface Shortcut {
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  key: number;
}

/** The app's settings (`settings.rs`), all of them, always: a save sends the whole of it. */
export interface Settings {
  /** 1 to 60. */
  idle_minutes: number;
  /** 10 to 300. */
  clipboard_seconds: number;
  theme: Theme;
  shortcut: Shortcut;
  /** Lockbox is kept out of screenshots, recordings and screen sharing. */
  capture_protected: boolean;
}

/** Start with Windows as the shell reads it: Lockbox's own entry, and whether Windows' Startup settings have turned it off. */
export interface StartupState {
  on: boolean;
  turned_off_in_windows: boolean;
}

/** What `app_info` says of the app. */
export interface AppInfo {
  version: string;
}

/**
 * The fields a copy button can ask the shell to put on the clipboard: a login's `password` and `username`, a key's
 * `key_value` and a note's text, `notes`. The value never comes to the page.
 */
export type CopyableField = "password" | "username" | "key_value" | "notes";

/** What `copyField` can copy: a field above, or one of a login's earlier passwords by its number (`PreviousView.index`). */
export type CopyTarget = CopyableField | { previous: number };

export function listVaults(): Promise<VaultEntry[]> {
  return callPlain<VaultEntry[]>("list_vaults", {});
}

/**
 * Sets a damaged vault list aside (the shell keeps the file under another name, never deletes it) and starts a new, empty one
 * (Ask 12). Refused when the list reads fine (`invalid_input`, `vault list`), when a hundred damaged lists are already set aside
 * (`too_large`, `damaged vault lists`) or when the disk won't take the change (`core`, `io`); nothing is changed by a refusal that
 * comes before the move.
 */
export function startNewVaultList(): Promise<null> {
  return callPlain<null>("start_new_vault_list", {});
}

export function getSettings(): Promise<Settings> {
  return callPlain<Settings>("get_settings", {});
}

/**
 * Saves the whole settings and puts them in effect at once. Refused (`invalid_input`) with `what` `idle time`, `clipboard delay`, `shortcut`
 * (not allowed), `shortcut taken` (another app has it) or `shortcut not set` (Windows would not take it): nothing is saved and the old
 * shortcut still works.
 */
export function setSettings(settings: Settings): Promise<null> {
  return callPlain<null>("set_settings", { ...settings });
}

/** Whether Lockbox starts with Windows, as the shell reads it now. */
export function getStartup(): Promise<StartupState> {
  return callPlain<StartupState>("get_startup", {});
}

/** Turns Start with Windows on or off, and answers the state read back. */
export function setStartup(on: boolean): Promise<StartupState> {
  return callPlain<StartupState>("set_startup", { on });
}

export function appInfo(): Promise<AppInfo> {
  return callPlain<AppInfo>("app_info", {});
}

/**
 * Unlocks the vault with `password` (about a second). Rejects with the shell's refusal (`wrong_password` among them)
 * or `StaleAnswer` when the vault locked again before the answer was read.
 */
export async function unlockVault(id: number, password: string): Promise<Tagged<UnlockView>> {
  const answer = await open<UnlockView>("unlock_vault", { id, password });
  // `unlock_vault` answers a tagged view and never asks a question or opens a dialog.
  if (answer === "Dismissed" || "Confirm" in answer) throw new Error("unexpected answer to unlock_vault");
  return answer;
}

/**
 * Creates a vault named `name` with `password` in the default vaults folder, or in one the person picks
 * (`chooseFolder`), adds it to the list and unlocks it. The shell writes the "not confirmed" mark before the vault
 * exists; if the mark can't be written, no vault is made and this rejects (a state-file refusal, `what: "vault state"`).
 * A cloud-synced folder answers `{ Confirm: { CloudFolder: { token } } }` before anything is written: go on with
 * `createVaultConfirm(token)`. A closed folder picker answers `"Dismissed"`.
 */
export function createVault(name: string, password: string, chooseFolder: boolean): Promise<Opened<CreatedView>> {
  return open<CreatedView>("create_vault", { name, password, choose_folder: chooseFolder });
}

/** The person's yes to creating the vault in a cloud-synced folder. */
export function createVaultConfirm(token: string): Promise<Opened<CreatedView>> {
  return open<CreatedView>("create_vault_confirm", { token });
}

/**
 * Adds a vault folder the person already has (26a's "A vault folder", after 21a's "I already have a vault or a backup"): a folder picker, then the folder is
 * checked and listed. A cloud-synced folder asks first (`CloudFolder`), confirmed with `addExistingVaultConfirm`.
 */
export function addExistingVault(): Promise<Outcome<VaultEntry>> {
  return callPlain<Outcome<VaultEntry>>("add_existing_vault", {});
}

export function addExistingVaultConfirm(token: string): Promise<Outcome<VaultEntry>> {
  return callPlain<Outcome<VaultEntry>>("add_existing_vault_confirm", { token });
}

/**
 * A new recovery key for the unlocked vault, shown once; the old one stops working. The shell writes the "not
 * confirmed" mark before the vault's header changes, and makes no key if it can't (`what: "vault state"`). No password
 * is asked on this path (21f).
 */
export function regenerateRecovery(vault: SessionRef): Promise<Tagged<string>> {
  return call<string>("regenerate_recovery", { session: vault.session, generation: vault.generation });
}

/**
 * The key was typed back: clears the vault's "not confirmed" mark. Refused on a stale generation and on a read-only
 * copy. Send it only after the typed-back groups matched.
 */
export function recoveryConfirmed(vault: SessionRef): Promise<Tagged<null>> {
  return call<null>("recovery_confirmed", { session: vault.session, generation: vault.generation });
}

/**
 * The person's yes to Ask 3: the vault's details, changed outside Lockbox, are signed again and saved (the shell writes).
 * Until then the engine refuses every other header write, a new recovery key included, so this comes before one. Refused
 * on a stale generation and on a read-only copy.
 */
export function acceptHeader(vault: SessionRef): Promise<Tagged<null>> {
  return call<null>("accept_header", { session: vault.session, generation: vault.generation });
}

/**
 * Locks one vault (Ask 3's "Lock this vault"): the same lock as Lock all, for this session alone. The shell sends the lock
 * event before it answers; the vault asks its question again at the next unlock.
 */
export async function lockVault(session: number): Promise<void> {
  await callPlain<null>("lock_vault", { session });
}

/**
 * What launch found (the output sweep's counts and whether its record could not be read, opened copies another program
 * still holds, a restore's outcome), asked once the page has loaded since launch work runs before it can listen. The shell
 * keeps them rather than using them up, so the same notice may arrive again as a `lockbox://notice` event: the latest of
 * each kind is the one that counts.
 */
export function launchNotices(): Promise<PageNotice[]> {
  return callPlain<PageNotice[]>("launch_notices", {});
}

/**
 * Sets a damaged record of opened files aside (Ask 11), so opening and saving decrypted copies work again. A record that
 * reads fine is left as it is. Refused with `too_large` (`what: "damaged output journals"`) when 99 are already set aside.
 */
export async function resetOutputJournal(): Promise<void> {
  await callPlain<null>("reset_output_journal", {});
}

/**
 * 5b's button, after the first close: the shell saves that the explanation was seen, so later closes hide the window at
 * once, sends `first_close` with `explain: false`, and hides the window. Every vault is already locked by then. When the
 * settings file can't be written, the shell still remembers it for this run and hides the window: a note seen once is not
 * worth an error, and it shows again only after Lockbox restarts. So this never refuses.
 */
export async function closeExplainedOk(): Promise<void> {
  await callPlain<null>("close_explained_ok", {});
}

/**
 * The answer to the question a close or a Quit asked while a job runs (`lockbox://close-asked`). `true` is Close anyway: the shell runs the old
 * path for the reason it asked about (close locks every vault, which cancels the jobs; Quit quits). `false` is Keep it running: nothing
 * changes. Either answer clears the question. Refused with `not_found` when none is pending (it was cleared by a lock, or answered already).
 */
export async function closeAnswer(go: boolean): Promise<null> {
  return callPlain<null>("close_answer", { go });
}

/**
 * Where a readable file was saved, to show the person: the folder that holds it, as their own path. For showing only;
 * no command takes it back.
 */
export interface SavedView {
  folder: string;
}

/**
 * Saves the recovery key on screen as a PDF (21c, 21f). Rust opens the save dialog, refuses a vault folder and Lockbox's
 * own folder, and prints the page as it shows now: only the part marked `data-print-only` (see `print.css`), so the key
 * reaches the PDF through the printed page and never through this call. Answers `"Dismissed"` when the dialog is
 * closed, `{ Confirm: { CloudFolder: { token } } }` before anything is written to a cloud-synced folder (21e: go on with
 * `saveReadableConfirm(token)`, or call this again to pick another folder), or `{ Done: SavedView }`. Refused with
 * `busy` (`what: "printer"`) while a print of Lockbox's own runs, and `print_failed` (`what: "pdf"`) when no PDF came;
 * nothing is left on disk either way. A lock while it runs makes the answer stale: no file appears and no error shows.
 */
export function saveRecoveryPdf(vault: SessionRef): Promise<Tagged<Outcome<SavedView>>> {
  return call<Outcome<SavedView>>("save_recovery_pdf", { session: vault.session, generation: vault.generation });
}

/** The person's yes to saving a readable file in a cloud-synced folder (21e's Continue): the parked save goes on. */
export function saveReadableConfirm(token: string): Promise<Tagged<Outcome<SavedView>>> {
  return call<Outcome<SavedView>>("save_readable_confirm", { token });
}

/**
 * The printers Lockbox can print to, by the names Windows shows, and the default one when it is among them. Printers
 * that write a file through a save box of their own (Microsoft Print to PDF, XPS, OneNote, fax) are left out: that box
 * would hold the key outside Lockbox after a lock, and Save as PDF is Lockbox's own way to make a file. No vault data.
 */
export interface PrinterList {
  printers: string[];
  default: string | null;
}

export function listPrinters(): Promise<PrinterList> {
  return callPlain<PrinterList>("list_printers", {});
}

/**
 * Prints the page as it shows now to `printer` (a name from `listPrinters`), with no Windows window: only the part
 * marked `data-print-only`. Answers once the printer has the job. Refused with `busy` (`what: "printer"`) while a print
 * of Lockbox's own runs, `invalid_input` (`what: "printer name"`) when that printer is not listed any more, and
 * `print_failed` (`what: "print"`) when the job could not be sent. A lock while it runs makes the answer stale.
 */
export function printRecoveryKey(vault: SessionRef, printer: string): Promise<Tagged<null>> {
  return call<null>("print_recovery_key", { session: vault.session, generation: vault.generation, printer });
}

export function listItems(vault: SessionRef): Promise<Tagged<ItemList>> {
  return call<ItemList>("list_items", { session: vault.session, generation: vault.generation });
}

export function getItem(vault: SessionRef, id: string): Promise<Tagged<ItemDetail>> {
  return call<ItemDetail>("get_item", { session: vault.session, generation: vault.generation, id });
}

/**
 * Puts a field of the item on the clipboard, in Rust, and clears it after the settings' delay. An earlier password is asked
 * for by its number; a number past the login's list is refused (`invalid_input`, `what: "earlier password"`).
 */
export function copyField(vault: SessionRef, id: string, field: CopyTarget): Promise<Tagged<null>> {
  return call<null>("copy_field", { session: vault.session, generation: vault.generation, id, field });
}

/**
 * What a new item starts with, saved with it in one write. Each may be left out, and each belongs to a kind: `username`,
 * `password` and `urls` to a login, `value` to a key, `notes` (the text) to a login, a key or a note; the shell refuses one
 * sent for a kind that has no use for it. The websites are sent as typed: the shell adds `https://` where it is missing and
 * refuses anything but `http` and `https` (`invalid_input`, `what: "website"`). The password and a key's value go to Rust
 * here, like a typed password, and never come back but on Reveal.
 */
export interface ItemFields {
  username?: string;
  password?: string;
  urls?: string[];
  notes?: string;
  value?: string;
}

/** What `new_item` makes here; a stored file is made by attaching one. (A folder is the shell's kind `collection`.) */
type NewKind = "login" | "key" | "note" | "collection";

function newItem(
  vault: SessionRef,
  kind: NewKind,
  title: string,
  collection: string | null,
  fields: ItemFields | null,
): Promise<Tagged<string>> {
  return call<string>("new_item", { session: vault.session, generation: vault.generation, kind, title, collection, fields });
}

/**
 * Makes a new folder named `name` (trimmed by the shell), in no other folder, and answers its id. A folder takes no fields, so
 * none are sent. Refused with `too_large` past the title limit, `invalid_input` (`what: "folder name"`) for a name with nothing
 * in it, and `read_only` in a vault opened from a backup. The same name as another folder is allowed.
 */
export function newFolder(vault: SessionRef, name: string): Promise<Tagged<string>> {
  return newItem(vault, "collection", name, null, null);
}

/**
 * Makes a new login in the vault, whole and in one write, and answers its id. `collection` is a folder's id, or `null` for
 * none. Refused with `too_large` past the shell's limits, `invalid_input` (`what: "website"`) for a website that is not an
 * `http` or `https` address, and `read_only` in a vault opened from a backup; nothing is written then.
 */
export function newLogin(
  vault: SessionRef,
  title: string,
  collection: string | null,
  fields: ItemFields,
): Promise<Tagged<string>> {
  return newItem(vault, "login", title, collection, fields);
}

/**
 * Makes a new key, named `name` (its title) and holding `value`, whole and in one write; answers its id. Refused as
 * `newLogin` is, and with `core` `invalid_input` (`what: "key name"`) when the name is not made of letters, digits and `_`
 * or starts with a digit.
 */
export function newKey(vault: SessionRef, name: string, collection: string | null, value: string): Promise<Tagged<string>> {
  return newItem(vault, "key", name, collection, { value });
}

/** Makes a new note, titled `title` and holding `text`, whole and in one write; answers its id. Refused as `newLogin` is. */
export function newNote(vault: SessionRef, title: string, collection: string | null, text: string): Promise<Tagged<string>> {
  return newItem(vault, "note", title, collection, { notes: text });
}

/**
 * What Reveal can ask for: a login's `password`, a key's `key_value`, or one of a login's earlier passwords by its number
 * (`{ previous: 0 }` is the newest).
 */
export type RevealableField = "password" | "key_value" | { previous: number };

/**
 * Reveal: a login's password, a key's value or an earlier password, asked for by the person (or by an edit form, which
 * needs the stored value to show), from Rust: the one way any of them reaches the page. Refused with `invalid_input`
 * (`what: "not a login"` or `"not a key"`) when the field is not the item's own, and (`what: "earlier password"`) for a
 * number past the list. It is kept only while the item is open (or the form is), and a lock takes it away.
 */
export function revealValue(vault: SessionRef, id: string, field: RevealableField): Promise<Tagged<string>> {
  return call<string>("reveal_password", { session: vault.session, generation: vault.generation, id, field });
}

/**
 * What an edit sends: the item's title and notes and folder, always (the shell wants them, and a folder left out would take
 * the item out of its folder), and a field of its kind only when the person changed it. A field left out is kept as stored,
 * byte for byte. There is no field for a login's earlier passwords: only the engine writes that list.
 */
export interface ItemEdit {
  id: string;
  /** The revision the page read: a change made meanwhile makes the edit stale (`core` `invalid_input`, `what: "stale revision"`). */
  revision: number;
  title: string;
  notes: string;
  /** The folder's id, or `null` for none. */
  collection: string | null;
  username?: string;
  password?: string;
  /** All the login's websites, as typed: the shell adds `https://` where it is missing and refuses all but `http` and `https`. */
  urls?: string[];
  /** A key's value. */
  key_value?: string;
}

/**
 * Saves an edit of an item, in one write. A real change of a login's password moves the old one into its earlier passwords
 * (the engine does that). Refused with `read_only` in a vault opened from a backup, `invalid_input` (`what: "not a key"`,
 * `"not a login"`, `"website"`), `too_large`, and `core` `invalid_input` (`what: "key name"`, `"stale revision"`).
 */
export function updateItem(vault: SessionRef, edit: ItemEdit): Promise<Tagged<null>> {
  // A field that was not changed is not sent at all, not sent as `undefined`.
  const sent = Object.fromEntries(Object.entries(edit).filter(([, value]) => value !== undefined));
  return call<null>("update_item", { session: vault.session, generation: vault.generation, edit: sent });
}

/**
 * Moves an item (not a folder) to the trash. Refused with `core` `invalid_input` (`what: "use delete_collection"`) for a folder,
 * `not_found` for an id that is not in the vault, and `read_only` in a vault opened from a backup.
 */
export function trashItem(vault: SessionRef, id: string): Promise<Tagged<null>> {
  return call<null>("trash_item", { session: vault.session, generation: vault.generation, id });
}

/**
 * Takes an item out of the trash, and its folder too if that is in the trash. For a folder: the items that went with it come
 * back, and the folder. Refused with `core` `invalid_input` (`what: "being deleted"`) for one whose delete for good has begun.
 */
export function restoreItem(vault: SessionRef, id: string): Promise<Tagged<null>> {
  return call<null>("restore_item", { session: vault.session, generation: vault.generation, id });
}

/** Moves a folder and its items to the trash; answers how many items went with it. */
export function deleteFolder(vault: SessionRef, id: string): Promise<Tagged<number>> {
  return call<number>("delete_collection", { session: vault.session, generation: vault.generation, id });
}

/**
 * Deletes an item in the trash for good, with its attached files, once the person has said yes. A folder goes alone: its items
 * stay in the trash. Refused with `core` `invalid_input` (`what: "not in trash"`) for an item that is not there.
 */
export function purgeItem(vault: SessionRef, id: string): Promise<Tagged<null>> {
  return call<null>("purge_item", { session: vault.session, generation: vault.generation, id });
}

/** The generator's options for a password, as the engine takes them (`length` is 8 to 128). */
export interface PasswordOptions {
  length: number;
  lowercase: boolean;
  uppercase: boolean;
  digits: boolean;
  symbols: boolean;
  avoid_ambiguous: boolean;
}

/** The generator's options for a passphrase (`words` is 3 to 12; `separator` is not a letter or digit). */
export interface PassphraseOptions {
  words: number;
  separator: string;
  capitalize: boolean;
  include_number: boolean;
}

/** A new random password, for display. It crosses Rust to the page as it always has; no vault is involved. */
export function generatePassword(options: PasswordOptions): Promise<string> {
  return callPlain<string>("generate_password", { options });
}

export function generatePassphrase(options: PassphraseOptions): Promise<string> {
  return callPlain<string>("generate_passphrase", { options });
}

/**
 * Puts a generated value the page holds on the clipboard, in Rust, with the marks and timer of any copy, owned by the
 * vault on screen: cleared after the settings' delay, or when that vault locks. Refused with `too_large` for a value
 * longer than the generator makes. A read-only vault may copy.
 */
export function copyGenerated(vault: SessionRef, value: string): Promise<Tagged<null>> {
  return call<null>("copy_generated", { session: vault.session, generation: vault.generation, value });
}

/**
 * One search result: the item as a list shows it, and the attached file whose name matched, or `null` when the item matched in
 * its own fields. An item that matched both ways is two results, its own first. The file's ID is what Open and Save a copy send.
 */
export interface SearchHit extends ItemSummary {
  matched_file: FileView | null;
}

/**
 * Searches every unlocked vault for `query` (title, username, website, folder name, attached file names): one answer per vault
 * searched, each tagged with the generation it was read in, and the sessions that were busy with a long change (their results are
 * missing). A vault that locked meanwhile is in neither, and an answer from before a lock is dropped here. The query
 * is at most 256 characters; an empty one is not worth asking.
 */
export function searchAll(query: string): Promise<SearchResults<SearchHit[]>> {
  return callMany<SearchHit[]>("search_all", { query });
}

// ---- Stored files (Task 19): open, save a copy, replace, attach and add, one file at a time ----
//
// Every one of these is a long operation in the shell: Rust opens the Windows picker or save dialog inside the command, so the page
// sends ids and never a path, and the shell says it is working with `lockbox://busy` (`onBusy`). A lock while one runs makes its answer
// stale (or the shell's `locked` refusal), and the screens say nothing of it.

/**
 * Opens the stored file `fileId` of the item `id` with its default app, as a read-only copy that is removed at the next lock. A type that
 * can run code answers `{ Confirm: "Executable" }` before anything is decrypted: ask, then send this again with `confirmedExecutable`.
 * A file that does not decrypt is refused as `damaged` (`what: "file"`, or `"file missing"`).
 */
export function openFile(vault: SessionRef, id: string, fileId: string, confirmedExecutable: boolean): Promise<Tagged<Outcome<null>>> {
  return call<Outcome<null>>("open_file", {
    session: vault.session,
    generation: vault.generation,
    id,
    file_id: fileId,
    confirmed_executable: confirmedExecutable,
  });
}

/**
 * Saves a decrypted copy of the stored file where the person picks, in the Windows save dialog Rust opens (`"Dismissed"` when it is
 * closed). A cloud-synced folder answers `{ Confirm: { CloudFolder: { token } } }` first (`saveFileCopyConfirm` goes on with it). Allowed
 * in a vault opened from a backup. Refused as `damaged` for a file that does not decrypt.
 */
export function saveFileCopy(vault: SessionRef, id: string, fileId: string, request: number): Promise<Tagged<Outcome<null>>> {
  return call<Outcome<null>>("save_file_copy", { session: vault.session, generation: vault.generation, id, file_id: fileId, request });
}

/**
 * The person's yes to saving the copy in a cloud-synced folder: `saveFileCopy` answered `{ Confirm: { CloudFolder: { token } } }` before
 * decrypting or writing anything, and the shell parked the copy under the token. It goes on only while the vault is unlocked as it was
 * when asked; a token that is used, old, or dropped by a lock is `not_found`.
 */
export function saveFileCopyConfirm(token: string, request: number): Promise<Tagged<Outcome<null>>> {
  return call<Outcome<null>>("save_file_copy_confirm", { token, request });
}

/** Adds a file item holding one file the person picks, in the folder `collection` (`null`: none): the new item's ID. Read-only refuses. */
export function addFile(vault: SessionRef, collection: string | null, request: number): Promise<Tagged<Outcome<string>>> {
  return call<Outcome<string>>("add_file", { session: vault.session, generation: vault.generation, collection, request });
}

/** Attaches one file the person picks to the login, key or note `id`: the new file's ID. Read-only refuses. */
export function attachFile(vault: SessionRef, id: string, request: number): Promise<Tagged<Outcome<string>>> {
  return call<Outcome<string>>("attach_file", { session: vault.session, generation: vault.generation, id, request });
}

// ---- Many files in (Task 10): one picker, the picked list held in Rust, then one job for the batch ----
//
// The page holds names and sizes for display, and a choice (a token). The paths stay in Rust; the page can send back the choice and an
// index, never a path.

/** One picked file, for display: its name (not its path) and its size in bytes. */
export interface PickedFile {
  name: string;
  size: number;
}

/** What a pick answers: the choice the shell holds the paths under, and every file picked so far, in order. */
export interface PickedFiles {
  choice: string;
  files: PickedFile[];
}

/** Where a batch goes: the folder on screen (`null`: no folder), or an item the files are attached to (a login, key or note; its hex id). */
export type AddInto = { type: "folder"; collection: string | null } | { type: "item"; id: string };

/** A refusal as the shell sends it: a plain object with a `code`, and the fields of that refusal. `messageFor` gives its words. */
export type ShellRefusal = { code: string } & Record<string, unknown>;

/**
 * How a batch ended: how many files went in, the names of those that could not be read (the batch went on), the names never tried because
 * the batch stopped (in the order picked), and what stopped it (`cancelled` for a Stop, `locked`, `busy`, or a full drive), or `null` when
 * it ran to the end. A file that was being written when it stopped is in `not_added`.
 */
export interface AddFilesView {
  added: number;
  failed: string[];
  not_added: string[];
  stopped: ShellRefusal | null;
}

/**
 * Opens the Windows picker for many files. With no `choice` it starts a pick (`"Dismissed"` when the picker is closed with nothing
 * chosen). With the choice a pick answered, Pick more adds the new files to the same choice, and a closed picker leaves the list as it
 * was. A choice that was used, dropped or has expired is refused as `choice_expired`.
 */
export function pickFilesToAdd(vault: SessionRef, choice: string | null): Promise<Tagged<Outcome<PickedFiles>>> {
  return call<Outcome<PickedFiles>>("pick_files_to_add", { session: vault.session, generation: vault.generation, choice });
}

/** Leaves file number `index` (from 0) out of a pick: the list that is left. An index past the end is refused (`invalid_input`, `index`). */
export function removePickedFile(vault: SessionRef, choice: string, index: number): Promise<Tagged<Outcome<{ files: PickedFile[] }>>> {
  return call<Outcome<{ files: PickedFile[] }>>("remove_picked_file", { session: vault.session, generation: vault.generation, choice, index });
}

/**
 * Stores every file of the pick, one after another, as one job with one progress over the batch's bytes (`request` names it for
 * `lockbox://job-started`). The choice is used up when the job starts; one refused before that (no room for the whole batch, a file over
 * 256 GiB) leaves it. Read-only refuses.
 */
export function addFiles(vault: SessionRef, choice: string, into: AddInto, request: number): Promise<Tagged<Outcome<AddFilesView>>> {
  return call<Outcome<AddFilesView>>("add_files", { session: vault.session, generation: vault.generation, choice, into, request });
}

// ---- Save all of a folder's files (Task 11): two steps, then a summary whose handle is held in Rust ----
//
// `saveAllFiles` opens the Windows folder picker (titled with the number of files), runs the checks and answers a plan; `saveAllStart` runs the job
// and answers how it ended. The destination is held in Rust under the plan's choice: the page sends the folder's id and a token, never a path, and
// the names it is given back are for display only.

/** One file of the plan: its name as it will be written (after the shell's name rule), its size, and the item it is attached to (`null` for a file item's own file). */
export interface PlannedFile {
  name: string;
  size: number;
  attached_to: string | null;
}

/** What `saveAllFiles` plans: the choice the start takes, where it goes (display text), every file in the order it will be saved, and their total bytes. */
export interface SavePlan {
  choice: string;
  folder_shown: string;
  files: PlannedFile[];
  total: number;
}

/** A file that was saved: its name on disk, its size, and the item it is attached to (`null` for a file item's own file). */
export interface SavedFile {
  name: string;
  size: number;
  attached_to: string | null;
}

/** A name that changed on the way out: `from` as stored, `to` as on disk (a name Windows refuses, or a number added because the name was taken). */
export interface Renamed {
  from: string;
  to: string;
}

/**
 * How a save ended. `damaged` and `gone` name files left out (the batch went on); `unfinished` is the file being written when it ended (nothing of it
 * is left) and `not_started` the names after it, in order; `stopped` is the refusal that ended it early (`cancelled` for a Stop, or a full drive), else
 * `null`. `output` is the handle the shell holds for Show in Explorer, put away with `closeOutput`.
 */
export interface SaveAllView {
  saved: SavedFile[];
  renamed: Renamed[];
  damaged: string[];
  gone: string[];
  unfinished: string | null;
  not_started: string[];
  stopped: ShellRefusal | null;
  folder_shown: string;
  output: string;
}

/**
 * Picks where to save every stored file of the folder `folder` (its id) and checks it: `"Dismissed"` for a closed picker, `{ Confirm: { CloudFolder:
 * { token } } }` for a cloud-synced folder (go on with `saveAllFilesConfirm`), or `{ Done: plan }`. Allowed in a vault opened from a backup. Refused
 * as `invalid_input` (`no files`, `state folder`), `core` `not_enough_space` with its numbers, or for a damaged output journal.
 */
export function saveAllFiles(vault: SessionRef, folder: string): Promise<Tagged<Outcome<SavePlan>>> {
  return call<Outcome<SavePlan>>("save_all_files", { session: vault.session, generation: vault.generation, folder });
}

/** The person's yes to the cloud question: the checks run again and the plan comes back, or a refusal. A token that is used, old or dropped is `choice_expired`. */
export function saveAllFilesConfirm(token: string): Promise<Tagged<Outcome<SavePlan>>> {
  return call<Outcome<SavePlan>>("save_all_files_confirm", { token });
}

/**
 * Saves the files of a plan as one job with one progress over every file's bytes (`request` names it for `lockbox://job-started`, kind `save_all`).
 * Every check runs again; the choice is used up when the job starts. Refused as `invalid_input` `folder changed` when the folder's files are no longer
 * the planned ones. A Stop answers `Done` with `stopped` set; a lock answers `locked`.
 */
export function saveAllStart(choice: string, request: number): Promise<Tagged<Outcome<SaveAllView>>> {
  return call<Outcome<SaveAllView>>("save_all_start", { choice, request });
}

/** Opens the saved folder in Windows' Explorer, by the summary's handle. A handle that was put away or let go is `choice_expired`; a failed open is `io`. */
export function showOutputInExplorer(output: string): Promise<null> {
  return callPlain<null>("show_output_in_explorer", { output });
}

/** Puts the summary's handle away when the summary closes. Safe to repeat. */
export function closeOutput(output: string): Promise<null> {
  return callPlain<null>("close_output", { output });
}

/** Replaces the stored file `fileId` of the item `id` with one the person picks: the new file's ID. Read-only refuses. */
export function replaceFile(vault: SessionRef, id: string, fileId: string): Promise<Tagged<Outcome<string>>> {
  return call<Outcome<string>>("replace_file", { session: vault.session, generation: vault.generation, id, file_id: fileId });
}

/**
 * Stops one running job: `operation` as `lockbox://job-started` gave it, with the scope that event named. The job ends with its own
 * answer (`cancelled`). Refused (`locked`: the scope has gone; `not_found`: the job is over or was never there) when there is nothing to
 * stop: the screens show nothing for either.
 */
export function cancelOperation(operation: OperationId, scope: JobScope): Promise<null> {
  return callPlain<null>("cancel_operation", { operation, scope });
}

/**
 * What a finished backup holds and left out, as counts (the shell's `BackupView`): never a name. `damaged_items` are items left out because their
 * stored record is damaged; `damaged_files` and `missing_files` are attached files left out because they fail their check or are not in the vault.
 * `size_on_disk` is the backup file's size in bytes.
 */
export interface BackupView {
  items: number;
  files: number;
  damaged_items: number;
  damaged_files: number;
  missing_files: number;
  size_on_disk: number;
  /** The backup just written, held by the shell for Test a backup (22c's "Test this backup"): its choice, and the name and size to show. Never the path. */
  test: TestPick;
}

/**
 * A backup file the shell holds for Test a backup under `choice` (32 lowercase hex characters): the page only ever sees its name and size. The shell
 * keeps the path to itself, and lets the choice go at a lock of every vault, after five minutes unused, when another is picked, and at `forgetTestBackup`.
 */
export interface TestPick {
  choice: string;
  file_name: string;
  size: number;
}

/** What testing a backup found (the shell's `BackupSummaryView`): when it was made (RFC 3339, UTC), the counts of what it holds, and its size on disk. Never a name. */
export interface BackupSummaryView {
  created_at: string;
  items: number;
  files: number;
  /** Attached files the backup does not hold. */
  missing_files: number;
  size_on_disk: number;
}

/**
 * What is typed to open a backup: one box for a password or a recovery key (`password_or_key`). The shell tries the text as a recovery key when it
 * is a well-formed one (then as a password, if that was not it) and as a password otherwise. `password` and `recovery_key` are the shell's other forms,
 * for other screens.
 */
export type CredentialArg = { password: string } | { recovery_key: string } | { password_or_key: string };

/** A backup is due: the vault's last one (else its making) is `days` whole days ago, and that is 30 or more. */
export interface BackupDue {
  days: number;
}

/**
 * Backs up the open vault to a file the person picks in the Windows save dialog Rust opens (the path never comes to the page; the dialog
 * suggests the vault's name and the day). A long job: `request` is the number the page chose, and `lockbox://job-started` says which operation it
 * became (not sent for `"Dismissed"`, a closed dialog, or a refusal before anything is written). Cancel (`cancelOperation`) answers `cancelled`
 * with nothing half-made left. Refused before writing with `invalid_input` and `what` `details changed`, `password copies disagree`,
 * `recovery key copies disagree` or `details unchecked` (a backup made now might not open), `core` `not_enough_space` with its two numbers, or
 * `read_only`. On success the shell keeps the date, which `vaultBackupDue` reads.
 */
export function backupVault(vault: SessionRef, request: number): Promise<Tagged<Outcome<BackupView>>> {
  return call<Outcome<BackupView>>("backup_vault", { session: vault.session, generation: vault.generation, request });
}

/**
 * Opens the Windows picker (titled "Test a backup") for a backup file and holds its path in the shell under a choice, launch-scoped (not one vault's). With
 * `choice: null` it starts a pick; with the choice a pick answered, Pick another replaces that file with the new one and the shell forgets the old.
 * `"Dismissed"` is a closed picker, which leaves the sent choice as it was. It needs no open vault, and is plain (not tagged with a session).
 */
export function testBackupPick(choice: string | null): Promise<Outcome<TestPick>> {
  return callPlain<Outcome<TestPick>>("test_backup_pick", { choice });
}

/**
 * Tests the picked backup without restoring it: opens it with the typed text, checks everything in it and writes nothing. A launch-scoped job (`request`
 * names it for `lockbox://job-started` and `lockbox://progress`, kind `test`, scope `launch`; sent only once the job begins). Every answer keeps the
 * choice: a wrong password (`core` `wrong_password`, also for a well-formed recovery key that is not the one), a damaged backup (`core` `damaged` with the
 * first failing `what`), `core` `io`, `unsupported_version` or `params_out_of_bounds`, and a stop (`cancelled`). A choice that is gone (expired, used,
 * dropped by a lock) is `choice_expired`; `locked` means every vault was locked while it ran.
 */
export function testBackup(choice: string, credential: CredentialArg, request: number): Promise<Outcome<BackupSummaryView>> {
  return callPlain<Outcome<BackupSummaryView>>("test_backup", { choice, credential, request });
}

/** Lets the picked backup go (the panel closed, or another panel took its place). A choice that is unknown or already gone is no error. */
export async function forgetTestBackup(choice: string): Promise<void> {
  await callPlain<null>("forget_test_backup", { choice });
}

/**
 * A backup file the shell holds for Open a backup under `choice` (32 lowercase hex characters, of its own kind: a Test a backup choice never answers for it):
 * the page sees its name and size only. The shell keeps the path to itself, and lets the choice go at a lock of every vault, after five minutes unused,
 * when another is picked, at `forgetOpenBackup`, and once a session has been opened with it.
 */
export interface OpenPick {
  choice: string;
  file_name: string;
  size: number;
}

/**
 * Opens the Windows picker (titled "Open a backup") for a backup file and holds its path in the shell under a choice, launch-scoped. With `choice: null` it starts
 * a pick; with the choice a pick answered, Pick another replaces that file with the new one and the shell forgets the old. `"Dismissed"` is a closed picker, which
 * leaves the sent choice as it was. It needs no open vault, and is plain (not tagged with a session).
 */
export function openBackupPick(choice: string | null): Promise<Outcome<OpenPick>> {
  return callPlain<Outcome<OpenPick>>("open_backup_pick", { choice });
}

/** Lets the picked backup go (the panel closed, or another took its place). A choice that is unknown or already gone is no error; a Test a backup choice is not this kind. */
export async function forgetOpenBackup(choice: string): Promise<void> {
  await callPlain<null>("forget_open_backup", { choice });
}

/**
 * Opens the picked backup read-only, with what was typed as one box's (`password_or_key`). A launch-scoped job (`request` names it for `lockbox://job-started`
 * and `lockbox://progress`, kind `open_backup`, scope `launch`): it shows progress and a Stop (`cancelOperation`). The answer is the new session, tagged: a
 * read-only session of `kind` `backup` whose name is the backup file's name without `.lockbox-backup`. A wrong password (`core` `wrong_password`), damage (`core`
 * `damaged`), `core` `io` and a stop (`cancelled`) keep the choice; a session opened uses it up. A choice that is gone is `choice_expired`; `locked` means every
 * vault was locked while it ran. A backup that is open already is answered as it is.
 */
export async function openBackupReadOnly(choice: string, credential: CredentialArg, request: number): Promise<Tagged<SessionInfo>> {
  const answer = await open<SessionInfo>("open_backup_read_only", { choice, credential, request });
  // The command answers a tagged session and never asks a question; there is no picker in it any more.
  if (answer === "Dismissed" || "Confirm" in answer) throw new Error("unexpected answer to open_backup_read_only");
  return answer;
}

/** The item a copy put in the target vault: its new id, and the names of the attached files the backup did not hold (so they were left out). */
export interface CopiedItemView {
  id: string;
  left_out: string[];
}

/**
 * Copies an item out of one open session (`from`, a backup or an older copy) into another (`to`, a vault in use), into the target's folder `folder` (its id, or
 * `null` for none). The answer is tagged with `to`, and is dropped (`StaleAnswer`) unless both sessions are current. When the backup lacks files that are attached to
 * the item and `skipMissing` is false, nothing is copied and the answer is the question (`Confirm` `MissingFiles` with their names); sent again with `skipMissing`
 * it copies the item without them. A folder that is not in the target, or is in its Trash, is `invalid_input` (`what` `collection`); a read-only target is
 * `read_only`; either session locked is `locked`.
 */
export function copyItemTo(
  from: SessionRef,
  id: string,
  to: SessionRef,
  folder: string | null,
  skipMissing: boolean,
): Promise<Tagged<Outcome<CopiedItemView>>> {
  return callPair<Outcome<CopiedItemView>>(
    "copy_item_to",
    { from: from.session, from_generation: from.generation, id, to: to.session, to_generation: to.generation, folder, skip_missing: skipMissing },
    from,
  );
}

/**
 * A backup file the shell holds for Restore a backup under `choice` (32 lowercase hex characters): the page sees its name and size only. The shell keeps
 * the path, and the credential the person types once the backup is checked, to itself, and lets the pick go at every lock, after five minutes unused, when
 * another is picked, and at `forgetRestorePick`.
 */
export interface RestorePick {
  choice: string;
  file_name: string;
  size: number;
}

/**
 * What a checked backup says about itself and where it would go (the shell's `RestoreChecked`): the vault's name inside it, the day it was made
 * (`YYYY-MM-DD`, the PC's own, or `null`), the folder it would go in as display text (never sent back), whether that is the usual vaults folder, and
 * whether a vault with this backup's own vault ID is already in that folder (a restore then replaces it, after asking).
 */
export interface RestoreChecked {
  name: string;
  made: string | null;
  folder_shown: string;
  usual: boolean;
  replaces_existing: boolean;
}

/**
 * A finished copy, waiting for its swap (the shell's `RestorePreparedView`): `kept_as` is the folder name the older copy will have, when one is replaced, and
 * `replaces` is the vault the swap would replace, as its place on the vault list (the older copies of that vault are listed by `listPreRestore`); `null` when
 * nothing is replaced, or the vault replaced is not on the list.
 */
export interface RestorePreparedView {
  restore: number;
  name: string;
  replaces_existing: boolean;
  kept_as: string | null;
  replaces: number | null;
}

/** A finished swap (the shell's `RestoredView`): the vault to unlock, and whether the one it replaced was kept beside it. */
export interface RestoredView {
  vault: number;
  before_restore: boolean;
}

/**
 * Opens the Windows picker (titled "Restore a backup") for a backup file and holds its path in the shell under a choice, launch-scoped. With `choice: null`
 * it starts a pick; with the choice a pick answered, the new file replaces that one. `"Dismissed"` is a closed picker. A lock while the picker is open is
 * refused as `locked` and holds nothing; `busy` (`what: "restore"`) while another restore is going. Plain: it needs no open vault. `vault` is a listed
 * vault's id, or `null`: with one, the restore goes in that vault's own parent folder instead of the usual one (a vault id that isn't listed is refused as
 * `not_found`, and nothing is picked).
 */
export function restorePick(choice: string | null, vault: number | null): Promise<Outcome<RestorePick>> {
  return callPlain<Outcome<RestorePick>>("restore_pick", { choice, vault });
}

/** What a restore that didn't finish left, as launch found it (also kept for `launch_notices`): `{ state: "none" }` when there is nothing. Plain. */
export function restoreNotice(): Promise<RestoreNotice> {
  return callPlain<RestoreNotice>("restore_notice", {});
}

/** Ask 7's and the pending notice's Try again: recovery runs again, and what it found is the answer. `busy` (`what: "restore"`) while a restore is running. */
export function retryRestoreRecovery(): Promise<RestoreNotice> {
  return callPlain<RestoreNotice>("retry_restore_recovery", {});
}

/**
 * Dismisses an unfinished restore's journal, leaving the folders there as they are. Sent with `confirm: true` straight away: the notice's own words say what
 * dismissing leaves. Without `confirm` the shell answers `Confirm` `Dismissal` with what it leaves. `busy` (`what: "restore"`) while a restore is running.
 */
export function dismissRestore(confirm: boolean): Promise<Outcome<null>> {
  return callPlain<Outcome<null>>("dismiss_restore", { confirm });
}

/**
 * Unlocks the picked backup read-only (nothing is unpacked) with the typed text, as one box's (`password_or_key`), and answers what it is and where it
 * would go. The shell keeps the working credential beside the pick, so the page sends the text once. A wrong one is `core` `wrong_password` (or a recovery
 * key kind) and keeps the pick; a damaged backup is `core` `damaged`; a pick that is gone is `choice_expired`.
 */
export function restoreCheck(choice: string, credential: CredentialArg): Promise<RestoreChecked> {
  return callPlain<RestoreChecked>("restore_check", { choice, credential });
}

/** Opens the Windows picker (titled "Restore into this folder") for another parent folder; answers the new `RestoreChecked`, or `"Dismissed"` (the folder stays). Needs a checked pick, else `choice_expired`. */
export function restoreChooseFolder(choice: string): Promise<Outcome<RestoreChecked>> {
  return callPlain<Outcome<RestoreChecked>>("restore_choose_folder", { choice });
}

/**
 * The copy: checks the folder, then unpacks the backup beside the vault it replaces, as a launch-scoped job (`request` names it for `lockbox://job-started`
 * and `lockbox://progress`, kind `restore`) that Cancel (`cancelOperation`) stops, leaving the vault as it was. A cloud-synced folder asks first
 * (`Confirm` `CloudFolder`), and a folder holding a vault it can't tell apart asks for a new folder's name (`Confirm` `NewFolder`); both are answered with
 * `restorePrepareConfirm`. A refusal of the copy (not enough space, a drive a vault can't live on, a file system limit) keeps the pick.
 */
export function restorePrepare(choice: string, request: number): Promise<Outcome<RestorePreparedView>> {
  return callPlain<Outcome<RestorePreparedView>>("restore_prepare", { choice, request });
}

/** The person's answer to the question `restorePrepare` asked: the same copy job. `name` is the new folder's name the person chose, or `null` for none (the cloud question's yes, or the suggestion). */
export function restorePrepareConfirm(token: string, name: string | null, request: number): Promise<Outcome<RestorePreparedView>> {
  return callPlain<Outcome<RestorePreparedView>>("restore_prepare_confirm", { token, name, request });
}

/**
 * The swap: puts the copy in place and keeps the vault it replaces beside it. A launch-scoped job with progress (`total` 1) and no Stop. Refused as
 * `cancelled` when Windows locking, sleep, Lock all or closing ended the finished restore; `core` `invalid_input` with `what` `too many before-restore copies`
 * when all the older copies' names are taken.
 */
export function restoreCommit(restore: number, request: number): Promise<RestoredView> {
  return callPlain<RestoredView>("restore_commit", { restore, request });
}

/** Lets a finished copy go without swapping it in (24d's Cancel). */
export async function restoreDiscard(restore: number): Promise<void> {
  await callPlain<null>("restore_discard", { restore });
}

/** Lets the picked backup go (the flow was cancelled). A pick that is unknown or already gone is no error. */
export async function forgetRestorePick(choice: string): Promise<void> {
  await callPlain<null>("forget_restore_pick", { choice });
}

/**
 * An older copy a restore kept beside a vault (the shell's `PreRestoreEntry`), as `listPreRestore` lists it. `id` is valid until the next listing, which replaces
 * every ID; `vault` is the vault's place on the vault list; `folder` is the folder's name (never a path); `last_written` is the local day (`YYYY-MM-DD`) that vault
 * was last written and `size` is its bytes on disk, each `null` when the shell could not read it.
 */
export interface PreRestoreEntry {
  id: number;
  vault: number;
  name: string | null;
  folder: string;
  last_written: string | null;
  size: number | null;
}

/** What opening an older copy answers: the read-only session's details beside the flag that its details were changed outside Lockbox (the shell's `PreRestoreOpened`). */
export interface PreRestoreOpened extends SessionInfo {
  header_changed: boolean;
}

/** Every older copy beside every vault on the list, with new IDs (the last listing's are gone). Never refuses. */
export function listPreRestore(): Promise<PreRestoreEntry[]> {
  return callPlain<PreRestoreEntry[]>("list_pre_restore", {});
}

/**
 * Opens an older copy of the last listing as a read-only session beside the live vault, with what was typed as one box's (`password_or_key`: a well-formed
 * recovery key is tried as a key, then as a password). A wrong one is `core` `wrong_password`; an ID the last listing does not have, or a folder that is not what it
 * was listed as, is `not_found`. The new session is read-only, and a lock of it (`lockVault`) closes it.
 */
export async function openPreRestoreReadOnly(id: number, passwordOrKey: string): Promise<Tagged<PreRestoreOpened>> {
  const answer = await open<PreRestoreOpened>("open_pre_restore_read_only", { id, credential: { password_or_key: passwordOrKey } });
  // The command answers a tagged session and never asks a question or opens a dialog.
  if (answer === "Dismissed" || "Confirm" in answer) throw new Error("unexpected answer to open_pre_restore_read_only");
  return answer;
}

/**
 * Deletes an older copy of the last listing, for good. Without `confirm` nothing is touched and the answer is the question (`Confirm` `DeletePreRestore`);
 * with it the folder is deleted. `busy` (`what` `folder is open`) while a session is open on it; `not_found` for an ID the last listing does not have.
 */
export function deletePreRestore(id: number, confirm: boolean): Promise<Outcome<null>> {
  return callPlain<Outcome<null>>("delete_pre_restore", { id, confirm });
}

/** Whether the vault's last backup, or its making when it has none, is 30 or more days ago. `null` when it is not, and always for a read-only copy. */
export function vaultBackupDue(vault: SessionRef): Promise<Tagged<BackupDue | null>> {
  return call<BackupDue | null>("vault_backup_due", { session: vault.session, generation: vault.generation });
}

/** What a cleanup of opened copies did, as counts: the shell's `RemoveReport`. `still_open` counts every copy another program still holds. */
export interface RemoveReport {
  removed: number;
  still_open: number;
}

/** Tries again to remove the opened copies a cleanup could not (10e's Retry): counts only. */
export function retryOpenCleanup(): Promise<RemoveReport> {
  return callPlain<RemoveReport>("retry_open_cleanup", {});
}

/**
 * Opens the login's website number `index` in the default browser, from Rust: only an `http` or `https` one opens
 * (`invalid_input`, `what: "link type"` otherwise), and the page never holds the address to open.
 */
export function openUrl(vault: SessionRef, id: string, index: number): Promise<Tagged<null>> {
  return call<null>("open_url", { session: vault.session, generation: vault.generation, id, index });
}

/** What 2c's Clear now found: Lockbox's copy taken off, nothing of Lockbox's left to clear, or the clipboard held by another app. */
export type ClearNow = "cleared" | "gone" | "busy";

/**
 * 2c's Clear now: takes Lockbox's last copy off the clipboard while it is still there. Whatever was copied since is left alone,
 * as the timer leaves it. With the clipboard busy, the shell keeps trying on its own.
 */
export function clearCopied(): Promise<ClearNow> {
  return callPlain<ClearNow>("clear_copied", {});
}

/** Locks every vault, then clears the clipboard of what Lockbox put there. */
export async function lockAll(): Promise<void> {
  await callPlain<null>("lock_all", {});
}

/** One key read from a pasted `.env`: its place among the keys read (from 0; what a choice sends back) and its name. Never its value. */
export interface EnvRow {
  index: number;
  name: string;
}

/**
 * A row whose name is already taken in one place: by a key that is there, or by an earlier row of the same paste.
 * `saved_as` is the name Keep both saves it under there (`NAME_2`, or the next free number).
 */
export interface EnvClash {
  index: number;
  saved_as: string;
}

/**
 * What a pasted `.env` came to. The values wait in Rust under `token` (five minutes, or until the vault locks) and never
 * come back. `bad_lines` are the numbers of the lines that could not be read, counted from 1. `clashes` has one entry for
 * every folder of the vault (by id) and one for no folder (`null`): the rows that clash there. A folder that is not
 * listed has no clashes.
 */
export interface EnvRows {
  /** `null` when no key was read: nothing waits in Rust. */
  token: string | null;
  rows: EnvRow[];
  bad_lines: number[];
  clashes: { collection: string | null; rows: EnvClash[] }[];
}

/** What to do with one row. `save` is for a row with no clash; `keep_both` only for one that clashes. */
export type EnvAction = "save" | "replace" | "keep_both" | "leave_out";

export interface EnvChoice {
  index: number;
  action: EnvAction;
}

/**
 * What taking a folder's keys out came to: `"Done"` (copied), `{ Saved }` (the save dialog's outcome, as
 * `saveRecoveryPdf` answers it; a cloud folder's yes goes through `saveReadableConfirm`), or `{ Duplicate }` when two
 * keys in the folder share a name: nothing was copied or written then.
 */
export type EnvOut = "Done" | { Saved: Outcome<SavedView> } | { Duplicate: { name: string } };

/**
 * Reads a pasted `.env` in Rust, like a typed password: the text goes once and the answer has names only. Refused with
 * `too_large` (`what: "env text"` over 1,048,576 bytes, `"env keys"` over 500 keys, `"value"` for a value over a key's
 * limit, `"title"` for a name over a title's) and `read_only`.
 */
export function envRead(vault: SessionRef, text: string): Promise<Tagged<EnvRows>> {
  return call<EnvRows>("env_read", { session: vault.session, generation: vault.generation, text });
}

/**
 * What became of the clipboard when a save was asked to clear it: `cleared` (it still held the copied text, and now holds nothing),
 * `not_ours` (it no longer holds that text, or holds none: left alone), `failed` (the clear errored, busy or refused), `not_asked`
 * (the clear was not asked for, or nothing was written, or what was saved did not come from the clipboard).
 */
export type ClipboardAfter = "cleared" | "not_ours" | "failed" | "not_asked";

/** What a `.env` paste's save came to: how many keys were written, and what became of the clipboard. */
export interface EnvSaved {
  saved: number;
  clipboard: ClipboardAfter;
}

/**
 * Saves the rows as key items in `collection` (a folder's id, or `null` for none) and answers how many keys were written and what
 * became of the clipboard. `choices` names every row once. The token is used up whatever the answer. With `clearClipboard`, and at
 * least one key written, the clipboard is cleared if it still holds the pasted text (line endings read alike). Refused, with
 * nothing written, with `not_found` when the token is gone (used, older than five minutes, or dropped by a lock),
 * `invalid_input` (`what: "env rows"`) when the choices do not fit the folder as it is now, and (`what: "env twice"`) when Replace
 * finds the name twice in the folder. Every row `leave_out` writes nothing and answers 0 and `not_asked`: that is how Cancel lets go
 * of the values at once.
 */
export function envSave(
  vault: SessionRef,
  token: string,
  choices: EnvChoice[],
  collection: string | null,
  clearClipboard: boolean,
): Promise<Tagged<EnvSaved>> {
  return call<EnvSaved>("env_save", {
    session: vault.session,
    generation: vault.generation,
    token,
    choices,
    collection,
    clear_clipboard: clearClipboard,
  });
}

/**
 * Copies the folder's keys in `.env` form, in Rust, with the marks and timer of any copy. Refused with `not_found` for a
 * folder that is not there and `invalid_input` (`what: "no keys"`) for one with no key in it. A read-only vault may copy.
 */
export function envCopy(vault: SessionRef, collection: string): Promise<Tagged<EnvOut>> {
  return call<EnvOut>("env_copy", { session: vault.session, generation: vault.generation, collection });
}

/**
 * Saves the folder's keys as a readable `.env` file: Rust opens the save dialog and writes as `saveRecoveryPdf` does
 * (`"Dismissed"`, a `CloudFolder` question answered with `saveReadableConfirm`, or `Done` with where it went). Refused as
 * `envCopy` is, with `read_only`, and with `invalid_input` (`what: "env twice"`) when the folder gained a second key of
 * one name while the dialog was open. A lock while it runs makes the answer stale: no file appears and no error shows.
 */
export function envSaveFile(vault: SessionRef, collection: string): Promise<Tagged<EnvOut>> {
  return call<EnvOut>("env_save_file", { session: vault.session, generation: vault.generation, collection });
}

/** What a clash does: `ask` stops at a name already there, `replace` puts the value in that key, `keep_both` saves under the name shown. */
export type OnClash = "ask" | "replace" | { keep_both: string };

/**
 * What saving a copied key came to: `Saved` (the new key's id, the name it was saved under, and what became of the clipboard), or
 * `Clash` (a live key of that name is in that place: nothing was written, and `saved_as` is the name Keep both would use).
 */
export type CaptureSaved =
  | { Saved: { id: string; name: string; clipboard: ClipboardAfter } }
  | { Clash: { saved_as: string } };

/** What the page sends to save the copy: the key's name, the folder, what to do on a clash, whether to clear the clipboard, a typed value. */
export interface CaptureSave {
  captureId: string;
  /** The key's name, as a key's title is checked (`invalid_input`, `what: "key name"`; `too_large`, `what: "title"`). */
  name: string;
  /** A live folder's id, or `null` for none; a folder that is not there is `not_found`. */
  collection: string | null;
  onClash: OnClash;
  /** Honoured only when the shell holds a copied value; the clipboard is cleared after the write, and only if it still holds that text. */
  clearClipboard: boolean;
  /** `null` when the shell holds a copied value; the value when it holds none (`empty`, `too_large`). */
  typed: string | null;
}

/**
 * What the shortcut left waiting in the shell, as an event would say it (`changed` false), or `null` for nothing: asked once when
 * the page starts, since a copy can be waiting from before the page loaded.
 */
export function captureState(): Promise<CaptureEvent | null> {
  return callPlain<CaptureEvent | null>("capture_state", {});
}

/**
 * Hands the copy to the unlocked vault `vault`: a lock of that vault lets it go. Refused `not_found` for an id that is not the
 * waiting copy's any more, and stale or foreign as every command.
 */
export function captureChoose(vault: SessionRef, captureId: string): Promise<Tagged<null>> {
  return call<null>("capture_choose", { session: vault.session, generation: vault.generation, capture_id: captureId });
}

/**
 * The copied value, trimmed, for Reveal: the one way it reaches the page. Refused `not_found` for an old id or a copy that holds no
 * value, and `locked` when the copy was not handed to a vault or that vault is no longer unlocked.
 */
export function captureReveal(captureId: string): Promise<string> {
  return callPlain<string>("capture_reveal", { capture_id: captureId });
}

/**
 * Saves the copy as a key (see `CaptureSave` and `CaptureSaved`), in one write; on success the shell clears the clipboard if asked,
 * and lets go of the copy (`gone`). A refusal writes nothing: `read_only`, `not_found` (the copy or the folder), `invalid_input`
 * (`what: "key name"`, `"capture value"` for a copy with nothing typed in its place, `"env twice"` for Replace finding the name
 * twice), `too_large` (`"title"`, `"value"`).
 */
export function captureSave(vault: SessionRef, save: CaptureSave): Promise<Tagged<CaptureSaved>> {
  return call<CaptureSaved>("capture_save", {
    session: vault.session,
    generation: vault.generation,
    capture_id: save.captureId,
    name: save.name,
    collection: save.collection,
    on_clash: save.onClash,
    clear_clipboard: save.clearClipboard,
    typed: save.typed,
  });
}

/** Lets go of the copy at once. An id that is not the waiting copy's is a quiet no-op. */
export async function captureCancel(captureId: string): Promise<void> {
  await callPlain<null>("capture_cancel", { capture_id: captureId });
}

/**
 * Reads the copy as a `.env` and parks it as a paste (`envRead`'s answer: names, bad lines and clashes, the values waiting in Rust
 * under the token); the copy goes (`gone`). Refused as `envRead` is, and `not_found` for an old id or a copy that holds no value.
 */
export function captureEnv(vault: SessionRef, captureId: string): Promise<Tagged<EnvRows>> {
  return call<EnvRows>("capture_env", { session: vault.session, generation: vault.generation, capture_id: captureId });
}
