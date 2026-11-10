// The one place the screens reach the shell: a typed function for each command they use, over `bridge.ts`, which drops
// an answer from a vault that has locked since. A screen imports this, never `@tauri-apps/api` or the bridge itself.
// Every refusal comes out as the plain object the shell sent (see `messages.ts`); a stale answer as `StaleAnswer`.
import {
  call,
  callMany,
  callPlain,
  open,
  type Opened,
  type Outcome,
  type PageNotice,
  type SearchResults,
  type SessionRef,
  type Tagged,
} from "./bridge";

export { onLocked, onNotice, StaleAnswer } from "./bridge";
export type { Confirm, Opened, Outcome, PageNotice, SessionRef, Tagged } from "./bridge";

/** One vault on the list: no path, ever. `name` is null when its details cannot be read. */
export interface VaultEntry {
  id: number;
  name: string | null;
  available: boolean;
}

export interface SessionInfo {
  session: number;
  generation: number;
  name: string;
  read_only: boolean;
  state: "unlocked" | "locked" | "unavailable";
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

export interface Settings {
  idle_minutes: number;
  clipboard_seconds: number;
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

export function getSettings(): Promise<Settings> {
  return callPlain<Settings>("get_settings", {});
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
 * Adds a vault folder the person already has (21a's "I already have a vault"): a folder picker, then the folder is
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
 * Searches every unlocked vault for `query` (title, username, website, folder name): one answer per vault searched, each
 * tagged with the generation it was read in, and the sessions that were busy with a long change (their results are
 * missing). A vault that locked meanwhile is in neither, and an answer from before a lock is dropped here. The query
 * is at most 256 characters; an empty one is not worth asking.
 */
export function searchAll(query: string): Promise<SearchResults<ItemSummary[]>> {
  return callMany<ItemSummary[]>("search_all", { query });
}

/**
 * Opens the login's website number `index` in the default browser, from Rust: only an `http` or `https` one opens
 * (`invalid_input`, `what: "link type"` otherwise), and the page never holds the address to open.
 */
export function openUrl(vault: SessionRef, id: string, index: number): Promise<Tagged<null>> {
  return call<null>("open_url", { session: vault.session, generation: vault.generation, id, index });
}

/** Locks every vault, then clears the clipboard of what Lockbox put there. */
export async function lockAll(): Promise<void> {
  await callPlain<null>("lock_all", {});
}
