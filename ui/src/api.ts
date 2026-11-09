// The one place the screens reach the shell: a typed function for each command they use, over `bridge.ts`, which drops
// an answer from a vault that has locked since. A screen imports this, never `@tauri-apps/api` or the bridge itself.
// Every refusal comes out as the plain object the shell sent (see `messages.ts`); a stale answer as `StaleAnswer`.
import { call, callPlain, open, type Opened, type Outcome, type SessionRef, type Tagged } from "./bridge";

export { onLocked, StaleAnswer } from "./bridge";
export type { Confirm, Opened, Outcome, SessionRef, Tagged } from "./bridge";

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

/** What an unlock found. The screens of the first task read only `info`; the warnings are shown by Task 8. */
export interface UnlockView {
  info: SessionInfo;
  used_backup_header: boolean;
  header_mac_mismatch: boolean;
  header_repair_failed: boolean;
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

export type ItemKind = "login" | "note" | "file" | "collection";

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
  created_at: string;
  modified_at: string;
  attachments: FileView[];
}

export interface ItemList {
  items: ItemSummary[];
  damaged: string[];
}

/** One item opened. A login's password is not here: it crosses only on Reveal. */
export interface ItemDetail {
  summary: ItemSummary;
  revision: number;
  notes: string;
  urls: string[];
  has_password: boolean;
}

export interface Settings {
  idle_minutes: number;
  clipboard_seconds: number;
}

/** The fields a copy button can ask the shell to put on the clipboard. The value never comes to the page. */
export type CopyableField = "password" | "username";

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

/** Puts a field of the item on the clipboard, in Rust, and clears it after the settings' delay. */
export function copyField(vault: SessionRef, id: string, field: CopyableField): Promise<Tagged<null>> {
  return call<null>("copy_field", { session: vault.session, generation: vault.generation, id, field });
}

/** Locks every vault, then clears the clipboard of what Lockbox put there. */
export async function lockAll(): Promise<void> {
  await callPlain<null>("lock_all", {});
}
