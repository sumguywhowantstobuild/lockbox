// A stand-in for the Rust side, for the screens' tests. It answers the commands the first screens call, in the shapes
// the shell's own serialisers pin (`views.rs`, `error.rs`, `session.rs`): an answer carries its session and
// generation, a refusal is a plain object with a `code`, and a command refuses a field it does not know with the
// shell's fixed malformed-request answer. A lock changes the generation and sends `lockbox://locked` before the
// command that caused it answers, as the shell does.
import type { Mock } from "vitest";

export const PASSWORD = "correct horse battery";

export interface FakeItem {
  id: string;
  kind: "login" | "key" | "note" | "file" | "collection";
  title: string;
  username?: string | null;
  collection?: string | null;
  trashed?: boolean;
  /** When it went to the trash (RFC 3339); a trashed item with none went on 1 November. */
  trashedAt?: string;
  /** The folder whose delete sent it to the trash (`trashed_with`), as the engine records it. */
  trashedWith?: string;
  /** Its delete for good started and has not finished (`purging`): frozen, and left out of a folder's restore. */
  purging?: boolean;
  modified_at?: string;
  notes?: string;
  urls?: string[];
  has_password?: boolean;
  /** A key's value: it reaches the page only through `reveal_password`, as in the shell. */
  value?: string;
  /** A login's password: it reaches the page only through `reveal_password`, as in the shell. */
  password?: string;
  /**
   * A login's earlier passwords, newest first, each with the time it was replaced. Only their numbers and times reach the
   * page (in `get_item`); a password crosses through `reveal_password` and `copy_field` as `{ previous: <number> }`.
   */
  previous?: { password: string; replaced_at: string }[];
  /** What `get_item` says the revision is (2 unless set); an accepted `update_item` adds one, as the engine does. */
  revision?: number;
  attachments?: { file_id: string; name: string; length: number; media_type: string }[];
  /**
   * In a backup's items: the names of attached files the backup does not hold (the item refers to a file entry the backup lacks). A copy out of the
   * backup asks first (`Confirm` `MissingFiles`) and, once told to go on, leaves them out (`left_out`).
   */
  missingFiles?: string[];
}

export interface FakeVault {
  id: number;
  name: string | null;
  /** What the session is, as `SessionInfo.kind` says it: a vault when left out, an older copy a restore kept, or a backup opened read-only. */
  kind?: "older_copy" | "backup";
  available?: boolean;
  /** Both copies of the vault's details are unreadable (Ask 8): the list says `details_damaged: true`. False unless a test makes it so. */
  detailsDamaged?: boolean;
  /** The vault's place on the list is a file, a link or a junction, not a plain folder: Show in Explorer is refused as `invalid_input` `folder`. */
  notAFolder?: boolean;
  password?: string;
  /**
   * The recovery key that opens the vault's recovery slot (Forgot password): `fakeKey(40 + id)` when none is given and none was made. A key the fake makes
   * (create, `regenerate_recovery`, `new_recovery_key`) replaces it, as a new key replaces the old one in the vault's details.
   */
  recoveryKey?: string;
  readOnly?: boolean;
  items?: FakeItem[];
  /** The "recovery key not confirmed" mark the shell keeps for the vault's folder. */
  unconfirmed?: boolean;
  /**
   * The shell's note about this vault can't be read (another program holds the file): 21f still shows at unlock (the lenient
   * read says yes), but the strict read that grants a key without the password is an error, so the session gets none.
   */
  markUnreadable?: boolean;
  /**
   * The vault's details were changed outside Lockbox: every unlock reports `header_mac_mismatch` until `accept_header`,
   * and the engine refuses a new recovery key meanwhile, as `HeaderGuard` does.
   */
  headerChanged?: boolean;
  /** Every unlock reports `used_backup_header` (opened from the spare copy of the details). */
  usedBackupHeader?: boolean;
  /** Every unlock reports the vault's folder as synced by this provider. */
  cloud?: "OneDrive" | "GoogleDrive" | "Dropbox" | "Other";
  /** Items that can't be read: reported as `skipped_damaged` at unlock and as `damaged` in the item list. */
  unreadable?: number;
  /** Files no item uses, moved aside by the unlock's cleanup (`orphans_quarantined`). */
  leftover?: number;
  /** A newer Lockbox made this vault: unlock is refused as `unsupported_version`. */
  newer?: boolean;
  /** A long change holds the vault past the short wait: a search reports it in `busy` and gives none of its items. */
  busy?: boolean;
  /** Stored files (by file id) that do not decrypt: opening or saving one is refused as `damaged`. */
  damagedFiles?: string[];
  /**
   * Whole days since the vault's last backup, or since it was made when it has none (`vault_backup_due`): 30 or more is "due" and is answered
   * as `{ days }`, less (and unset) as `null`. A backup that works clears it, as the shell's written date does.
   */
  backupDays?: number;
  /** What a finished backup says it holds and left out (`BackupView`); the default is the vault's own counts, nothing left out, 1.2 GB on disk. */
  backupView?: Partial<{
    items: number;
    files: number;
    damaged_items: number;
    damaged_files: number;
    missing_files: number;
    size_on_disk: number;
  }>;
}

interface Live {
  session: number;
  generation: number;
  unlocked: boolean;
}

export const MALFORMED = { code: "invalid_input", what: "request" };
export const WRONG_PASSWORD = { code: "core", kind: "wrong_password" };
export const LOCKED = { code: "locked" };
/** What the shell sends when the vault list file can't be read (`registry.rs`: `Damaged { what: "vault list" }`). */
export const VAULT_LIST_DAMAGED = { code: "core", kind: "damaged", what: "vault list" };
/** What the engine sends when a newer Lockbox made the vault (`unsupported_version`). */
export const NEWER_VAULT = { code: "core", kind: "unsupported_version" };
/** What the engine refuses a new recovery key with while a changed header waits to be accepted (`HeaderGuard::check`). */
const ACCEPT_FIRST = { code: "core", kind: "invalid_input", what: "accept the header change first" };
/**
 * What Rename is refused with, as a backup is (`backup_refusal`): the shell's own `what`s for the four reasons, and the engine's refusal of a name it won't keep (`validate_name`).
 * The fake models the first (`headerChanged`) and the last; `refuseNext("rename_vault", …)` gives it the other three.
 */
export const DETAILS_CHANGED = { code: "invalid_input", what: "details changed" };
export const DETAILS_UNCHECKED = { code: "invalid_input", what: "details unchecked" };
export const PASSWORD_COPIES_DISAGREE = { code: "invalid_input", what: "password copies disagree" };
export const RECOVERY_KEY_COPIES_DISAGREE = { code: "invalid_input", what: "recovery key copies disagree" };
export const VAULT_NAME_REFUSED = { code: "core", kind: "invalid_input", what: "vault name" };
/** What the shell sends when it cannot write the mark first (`write_state(…, "vault state")`, `TooLarge`). */
export const VAULT_STATE_REFUSED = { code: "too_large", what: "vault state" };
/** What a create answers when the vault was made but the list refused it and the folder could not be removed again (`VAULT_NOT_LISTED`, `error.rs`). */
export const VAULT_NOT_LISTED = { code: "invalid_input", what: "vault not listed" };
/** What a create or an add answers when the list holds its most (`registry.check_room`: `TooLarge { what: "vault list" }`); nothing is written. */
export const VAULT_LIST_FULL = { code: "too_large", what: "vault list" };
/** What the shell sends when a session asks for a key without the password but never entered 21f the way that grants it. */
const NO_KEY_PERMISSION = { code: "invalid_input", what: "recovery key" };
/** What the shell sends while a print of its own runs, and when no PDF came (`error.rs`: `PRINTER_BUSY`, `PDF_NOT_MADE`). */
export const PRINTER_BUSY = { code: "busy", what: "printer" };
export const PDF_NOT_MADE = { code: "print_failed", what: "pdf" };
/** What the shell sends when the printer asked for is not listed any more, and when the job could not be sent (`error.rs`: `PRINTER_GONE`, `PRINT_NOT_SENT`). */
export const PRINTER_GONE = { code: "invalid_input", what: "printer name" };
export const PRINT_NOT_SENT = { code: "print_failed", what: "print" };
/** The printers the fake lists to begin with, and the one Windows has as the default (not the first, so a test can tell). */
export const PRINTERS = ["Office Laser", "Hall Inkjet"];
export const DEFAULT_PRINTER = "Hall Inkjet";
/** The folder the fake saves a PDF in: a made-up path, shown to the person after a save. */
export const SAVED_FOLDER = "C:\\Users\\Someone\\Documents";
/** The folder the fake's picker chooses for Save all files: made-up display text, as the shell sends it (`restore::shown`, no `\\?\`). */
export const SAVE_ALL_FOLDER = "D:\\Clients\\Agency";

/**
 * Made-up stand-ins for the engine's word list: 64 lowercase words, none of them a word the screens use themselves
 * (so a test can tell a key word on the page from the page's own words). The engine's real list is 2,048 words.
 */
export const FAKE_WORDS: readonly string[] = [
  "amber", "badger", "basalt", "beacon", "birch", "cactus", "cedar", "cobalt",
  "copper", "coral", "dagger", "daisy", "ember", "falcon", "fennel", "flint",
  "garnet", "ginger", "glacier", "harbor", "hazel", "indigo", "ivory", "jasper",
  "jungle", "kernel", "lagoon", "lantern", "lemon", "magnet", "maple", "marble",
  "meadow", "nectar", "nickel", "nutmeg", "olive", "onyx", "orchid", "otter",
  "pebble", "pepper", "plum", "quartz", "quiver", "raven", "ribbon", "saddle",
  "sapphire", "sorrel", "tangent", "thistle", "timber", "topaz", "tundra", "umber",
  "velvet", "violet", "walnut", "willow", "yarrow", "zephyr", "zinnia", "zircon",
];

/**
 * A recovery key in the shell's display form (24 lowercase words, single spaces, no numbers), different for each `n`.
 * Its words are distinct, so a test that needs a repeated word builds its own.
 */
export function fakeKey(n: number): string {
  const words: string[] = [];
  for (let i = 0; i < 24; i += 1) {
    // 24 steps of 5 round a list of 64 never meet themselves (5 and 64 share no factor); `n` moves where it starts.
    words.push(FAKE_WORDS[(n * 11 + i * 5) % FAKE_WORDS.length] ?? "");
  }
  return words.join(" ");
}

export function itemId(n: number): string {
  return n.toString(16).padStart(32, "0");
}

export const FOLDER = itemId(0xf1);
export const FOLDER_2 = itemId(0xf2);

/** Items for a vault: two folders, logins in and out of a folder, a note, a stored file and one in the trash. */
export function sampleItems(): FakeItem[] {
  return [
    { id: FOLDER, kind: "collection", title: "Agency support agent" },
    { id: FOLDER_2, kind: "collection", title: "Lineproof" },
    {
      id: itemId(1),
      kind: "login",
      title: "Bot admin console",
      username: "admin@example.com",
      collection: FOLDER,
      urls: ["https://support.example.com"],
      has_password: true,
      modified_at: "2026-11-04T09:00:00Z",
    },
    {
      id: itemId(2),
      kind: "login",
      title: "Error tracker",
      username: "team@example.com",
      collection: FOLDER_2,
      has_password: true,
      modified_at: "2026-10-12T09:00:00Z",
    },
    { id: itemId(3), kind: "note", title: "Rotation steps", collection: FOLDER, notes: "Made-up note", modified_at: "2026-09-20T09:00:00Z" },
    {
      id: itemId(4),
      kind: "file",
      title: "Client contract",
      collection: null,
      attachments: [{ file_id: itemId(0xa1), name: "contract-demo.pdf", length: 98304, media_type: "application/pdf" }],
      modified_at: "2026-09-02T09:00:00Z",
    },
    { id: itemId(5), kind: "login", title: "Old login in the trash", username: "gone@example.com", trashed: true, has_password: true },
  ];
}

/** What an export says it wrote (`ExportSummary` in `views.rs`): counts and titles, never a value. */
export interface FakeExport {
  items: number;
  left_out_files: number;
  line_breaks: string[];
  /** The vault's damaged items (the same count the item list's `damaged` shows), which aren't in the file. */
  unreadable: number;
}

/**
 * What the shell's export works out from a vault (the frozen connection): the rows are the live logins, notes and keys (not the trashed, not the ones being deleted
 * for good); `left_out_files` counts every stored file on a live item, a file item's and any other item's alike; `line_breaks` names the rows, in order, whose
 * password, key value or notes hold a CR or an LF; `unreadable` is the vault's damaged items.
 */
function exportSummary(items: FakeItem[], unreadable: number): FakeExport {
  const live = items.filter((item) => !(item.trashed ?? false) && !(item.purging ?? false));
  const rows = live.filter((item) => item.kind === "login" || item.kind === "note" || item.kind === "key");
  const broken = (text: string | undefined) => text !== undefined && /[\r\n]/.test(text);
  return {
    items: rows.length,
    left_out_files: live.reduce((sum, item) => sum + (item.attachments?.length ?? 0), 0),
    line_breaks: rows.filter((row) => broken(row.password) || broken(row.value) || broken(row.notes)).map((row) => row.title),
    unreadable,
  };
}

/**
 * What the shell's `ItemSummary.site` holds (`views.rs`): the host of a login's first website and nothing else of the
 * address, or null when there is none, it does not parse, or it is not an `http` or `https` one.
 */
function siteOf(item: FakeItem): string | null {
  const first = item.kind === "login" ? item.urls?.[0] : undefined;
  return first === undefined ? null : siteOfUrl(first);
}

/** The most one vault gives a search (`SEARCH_LIMIT` in `commands/items.rs`). */
export const SEARCH_LIMIT = 100;

function siteOfUrl(stored: string): string | null {
  try {
    const url = new URL(stored);
    return url.protocol === "http:" || url.protocol === "https:" ? url.hostname : null;
  } catch {
    return null;
  }
}

function summary(item: FakeItem) {
  return {
    id: item.id,
    kind: item.kind,
    title: item.title,
    username: item.kind === "login" ? (item.username ?? "") : null,
    collection: item.collection ?? null,
    trashed: item.trashed ?? false,
    trashed_at: item.trashed === true ? (item.trashedAt ?? "2026-11-01T09:00:00Z") : null,
    trashed_with: item.trashed === true ? (item.trashedWith ?? null) : null,
    purging: item.purging ?? false,
    site: siteOf(item),
    created_at: "2026-08-01T09:00:00Z",
    modified_at: item.modified_at ?? "2026-08-01T09:00:00Z",
    attachments: item.attachments ?? [],
  };
}

/** What a job belongs to, as `lockbox://job-started` says: a session at a generation, or the launch at a lock epoch (a test of a backup). */
type JobScopeOf = { type: "session"; session: number; generation: number } | { type: "launch"; epoch: number };

export interface FakeShell {
  /** Every command sent, in order, with its arguments. */
  calls: { cmd: string; args: unknown }[];
  /** Every `copy_field` that reached the shell, as it was sent. */
  copied: Record<string, unknown>[];
  /** Sends `lockbox://locked` for the session and moves its generation on, as a lock does. */
  lock(session: number, reason?: string): void;
  /**
   * Locks the session in the shell without telling the page: the generation moves on and everything the session had parked (a cloud
   * question, a pasted `.env`) is let go, as a lock does, but no `lockbox://locked` is sent. The page learns of it only from the next
   * refusal (`locked`) or stale answer, as when a lock event is missed.
   */
  lockWithoutEvent(session: number): void;
  /** The session the vault is open in, if it is. */
  sessionOf(vaultId: number): Live | undefined;
  /** Holds every `list_items` answer until `release` is called, to lock while one is in flight. */
  holdListItems(newestFirst?: boolean): () => void;
  /**
   * The next `delete_collection` or `restore_item` of a folder (`cmd`) makes `writes` of its changes and then refuses with
   * `error`, as the engine can when a write fails partway: what was written stays written, and the answer is a refusal.
   */
  failPartwayNext(cmd: "delete_collection" | "restore_item", writes: number, error: object): void;
  /** The recovery key last made for the vault (by creating it or by `regenerate_recovery`), as the shell showed it. */
  keyOf(vaultId: number): string | undefined;
  /** Whether the vault carries the "not confirmed" mark. */
  unconfirmed(vaultId: number): boolean;
  /** The next create or add-existing asks about a cloud folder first, as the shell does. */
  cloudNext(provider?: "OneDrive" | "GoogleDrive" | "Dropbox" | "Other"): void;
  /** The next create or new key finds the mark can't be written: nothing is made, the shell refuses. */
  refuseMarkNext(): void;
  /** The next key the shell makes is this one (a test of a key with a repeated word needs one the fake would not make). */
  nextKeyIs(key: string): void;
  /** The next key the shell makes is numbered `issue` (the real shell counts 1, 2, 3 in a session; a test may start elsewhere to tell a carried number from a made-up one). */
  nextIssueIs(issue: number): void;
  /** The next folder picker (create with `choose_folder`, add existing) is closed without a choice. */
  dismissPickerNext(): void;
  /** The vault the next `add_existing_vault` finds in the folder the person picks. */
  offerExisting(vault: FakeVault): void;
  /**
   * From now on the vault list can't be read: `list_vaults` is refused as damaged (`VAULT_LIST_DAMAGED`) until `start_new_vault_list`
   * sets it aside, which leaves the list empty, as the shell's does. That command is refused (`invalid_input`, `vault list`) while the
   * list is good.
   */
  damageVaultList(): void;
  /**
   * The next `start_new_vault_list` sets the damaged list aside and leaves an empty one, then is refused with `error`, as the shell's is
   * when the move worked and writing the new list did not: the list reads as empty from then on, but the answer is a refusal.
   */
  startNewListFailsAfterMoveNext(error: object): void;
  /** The damaged list is mended from outside: `list_vaults` reads it again (its vaults still there) with no command from the page. */
  repairVaultList(): void;
  /** Holds every `start_new_vault_list` answer until `release` is called: the list is set aside when the command arrives. */
  holdStartNewList(): () => void;
  /** The folders a recovery key PDF was saved in, in order (a PDF the shell never wrote is not here). */
  pdfs: string[];
  /** The next Save as PDF, Save as .env file, or export's dialog (`export_csv`, `export_repick`) is closed without a choice. */
  dismissPdfNext(): void;
  /** The next Save as PDF, Save as .env file, or export's dialog finds a cloud-synced folder and asks first. Each call is one more question. */
  cloudPdfNext(): void;
  /** What each export that was written said it held (`export_csv`, or its cloud question's yes): a refusal, a closed dialog or a question not yet answered is not here. */
  exports: FakeExport[];
  /** The next Save as PDF or Print is refused with this. */
  refusePrintNext(error: object): void;
  /** Holds every print command's answer, and a `.env` file's, until `release` is called (the PDF is still being made, the job is on its way). */
  holdPrint(): () => void;
  /** Drops every parked cloud question without a lock event, as the shell does when a session locks (a late yes is `not_found`). */
  dropParkedChoices(): void;
  /** The printers a print was sent to, in order, by the name the page sent. */
  printed: string[];
  /** The printers the shell lists from now on, and the default among them (`null` for none). */
  setPrinters(printers: string[], defaultPrinter?: string | null): void;
  /** Holds every `list_printers` answer until `release` is called (Windows is still being asked). */
  holdPrinterList(): () => void;
  /** What launch found, as `launch_notices` answers it (kept, not used up). Set before the page starts. */
  setLaunchNotices(notices: object[]): void;
  /** A notice of a running app: sent as `lockbox://notice` to the page, and kept for `launch_notices` as `tell` does. */
  tell(notice: object): void;
  /** How many times `reset_output_journal` reached the shell. */
  outputJournalResets(): number;
  /**
   * The window's close button, as the shell handles it: every vault locks (reason `manual`, since the app keeps running),
   * then the first time the window stays and `first_close` `{ explain: true }` is sent; a close while that explanation
   * shows counts as its button; once it has been explained, the window just hides and nothing is sent.
   */
  closeWindow(): void;
  /** Whether the window is hidden to the tray (a close after the explanation, or the explanation's button). */
  windowHidden(): boolean;
  /** How many times `close_explained_ok` reached the shell. */
  closeExplainedCalls(): number;
  /** How many `clear_copied` (2c's Clear now) reached the shell. */
  clearCopiedCalls(): number;
  /** What the next `clear_copied` answers (`"cleared"` until set): `"gone"` or `"busy"` for the shell's other answers. */
  answerClearCopied(answer: "cleared" | "gone" | "busy"): void;
  /**
   * A close or a Quit while a job runs, as the shell asks it (Plan 4B Task 12): `lockbox://close-asked` goes out and the question is pending,
   * with nothing locked, hidden or cancelled, until `close_answer`. `running` is the kinds as the shell names them (distinct, in start order);
   * `restoreWaiting` is a finished restore waiting for its yes at 24d (Task 13d), alone or beside jobs. Each call is a new question: the shell
   * gives it the next number (1, 2, ...), which is in the event and is returned; `close_answer` must name it, and an answer naming another
   * question is refused and leaves the pending one.
   */
  askClose(reason: "close" | "quit", options: { running: string[]; pastSwap?: boolean; restoreWaiting?: boolean }): number;
  /** The shell says the pending question again (a second close or Quit, a reloaded page): the same event, with the same `question` number. Nothing if none is pending. */
  repeatClose(): void;
  /** How many `lockbox://close-asked` events the page's listener has been handed so far (every one, however it was sent). */
  closeAskedHeard(): number;
  /** The shell's lock epoch changes (Lock all, Windows locking or sleeping, an idle lock): `lockbox://lock-epoch` goes out and a pending question is dropped. */
  changeLockEpoch(reason?: string): void;
  /** Whether a question is waiting for `close_answer`. */
  pendingClose(): boolean;
  /** Every `close_answer` the shell accepted, as `go` was sent (an answer with no question pending is refused and not here). */
  closeAnswers(): boolean[];
  /** How many times the app was quit (a Quit with nothing running, or a yes to a Quit's question). */
  quits(): number;
  /** Sends `payload` on `channel` exactly as given, for an event the page must not trust. */
  sendRaw(channel: string, payload: unknown): void;
  /** The shell has already shown 5b in an earlier run: the next close hides at once. */
  markCloseExplained(): void;
  /** A notice sent as `lockbox://notice` only, never kept for `launch_notices` (`first_close` is only ever an event). */
  sendEvent(notice: object): void;
  /** Every `open_url` that reached the shell, as it was sent (a link the shell refused is not here). */
  opened: Record<string, unknown>[];
  /**
   * Holds every `search_all` answer until `release` is called (newest first): what was found is read when the search
   * arrives, as the shell reads it, so a lock in between leaves answers tagged with the generation from before it.
   */
  holdSearch(): () => void;
  /** Makes a vault busy (or not) from now on, as a long change on it does: its search answer is `busy`. */
  setBusy(vaultId: number, busy: boolean): void;
  /** Every `new_item` that reached the shell and was made, as it was sent. */
  made: { session: number; generation: number; kind: string; title: string; collection: string | null; fields: Record<string, unknown> | null }[];
  /** Every `copy_generated` that reached the shell, as it was sent (the values are made up). */
  generated: { session: number; generation: number; value: string }[];
  /** Every `reveal_password` the shell answered, as it was sent (a refused one is not here). */
  revealed: { session: number; generation: number; id: string; field: string | { previous: number } }[];
  /** Every `update_item` the shell accepted, as it was sent (a refused one is not here). */
  edited: { session: number; generation: number; edit: Record<string, unknown> }[];
  /**
   * Holds every `update_item` answer until `release` is called: the item is changed when the command arrives, as the shell
   * writes it, and the answer is read later, so a lock in between leaves an answer tagged with the generation from before.
   */
  holdUpdate(): () => void;
  /** The next `cmd` sent is refused with `error` (once), before anything else is done for it. */
  refuseNext(cmd: string, error: object): void;
  /**
   * Holds every `reveal_password` answer until `release` is called: the value is read when the command arrives, as the
   * shell reads it, and the answer comes later, so the person can open another item or lock in between.
   */
  holdReveal(): () => void;
  /** While `holdReveal` holds, lets the oldest waiting answer through and keeps holding the rest, to answer out of step. */
  releaseOneReveal(): void;
  /** While `holdReveal` holds, lets the newest waiting answer through first, so an earlier press is answered last. */
  releaseNewestReveal(): void;
  /**
   * Holds every `new_item` answer until `release` is called: the item is made when the command arrives, as the shell
   * writes it, and the answer is read later, so a lock in between leaves an answer tagged with the generation from before.
   */
  holdNewItem(): () => void;
  /**
   * Holds every answer of `trash_item`, `restore_item`, `delete_collection`, `purge_item` and `empty_trash` until `release` is called: the
   * change is made when the command arrives, as the shell writes it, and the answer is read later, so a lock or another click in
   * between leaves an answer tagged with the generation from before.
   */
  holdTrash(): () => void;
  /**
   * Holds every `env_read` answer until `release` is called: the paste is read, and its token made, when the command arrives, as
   * the shell does, and the answer comes later, so the panel can close or a newer paste can be sent in between.
   */
  holdEnvRead(): () => void;
  /** Holds every `env_save` answer until `release` is called: the keys are written when the command arrives, the answer comes later. */
  holdEnvSave(): () => void;
  /** How many pasted `.env`s the shell still holds the values of (a token that is not used up, dropped by a lock or older than five minutes). */
  envHeld(): number;
  /** Lets the shell forget every held paste at once, as five minutes do: a late `env_save` is then `not_found`. */
  expireEnvTokens(): void;
  /** The folders (by id) whose keys `env_copy` put on the clipboard, in order. */
  envCopied: string[];
  /** The folders (by id) whose keys `env_save_file` wrote as a file, in order (a Dismissed or refused save is not here). */
  envFiles: string[];
  /**
   * The save shortcut pressed with `what` on the clipboard: a text (kept as read, the surrounding spaces and line breaks too), `"empty"`
   * (no text: an image, say) or `"too_large"`. A new slot with a new id replaces the one waiting, as the shell does, and
   * `lockbox://capture` is sent with `changed` and `env_keys` worked out by the connection's rules. The clipboard is left as it is.
   */
  press(what: { text: string } | "empty" | "too_large"): void;
  /** What the clipboard holds now (`null` for no text): set it to what the person copied before pressing, or to something else after. */
  setClipboard(text: string | null): void;
  clipboard(): string | null;
  /** The next clipboard clear (a save's, or the paste panel's) errors: the answer is `failed`, and the text stays. */
  failClipboardClearNext(): void;
  /** The slot the shell holds, as the page can only know it by asking: its id, state and the vault it was handed to (session and generation). `null` for none. */
  captureSlot(): { id: string; state: string; chosen: number | null; chosenGeneration: number | null } | null;
  /** Empties the slot as a lock of its vault does: `lockbox://capture` with `gone` is sent. */
  emptyCaptureSlot(): void;
  /** Empties the slot and says nothing, as when the page missed the `gone` event: the next command about it is `not_found`. */
  forgetCaptureSlot(): void;
  /**
   * Holds every `capture_reveal` answer until `release` is called: the value is read when the command arrives, as the shell reads
   * it, and the answer comes later, so a new press or a lock can come in between.
   */
  holdCaptureReveal(): () => void;
  /** How many times `capture_reveal` was answered with the value. */
  captureReveals(): number;
  /**
   * Holds every `capture_state` answer until `release` is called: the slot is read when the command arrives, as the shell reads it, and the
   * answer comes later, so a press or a `gone` can be heard before it.
   */
  holdCaptureState(): () => void;
  /**
   * Holds every `capture_choose` until `release` is called, and does it then: until it is done the shell has handed the copy to no vault, so
   * a `capture_reveal` meanwhile is `locked`, as the shell answers it.
   */
  holdCaptureChoose(): () => void;
  /**
   * Holds the next `capture_unchoose` (that one only) until `release` is called, and does it then: until it is done the shell still holds the copy for the vault it was
   * handed to, and a press that replaces the copy keeps that binding (`fill`). Later ones go through.
   */
  holdCaptureUnchoose(): () => void;
  /**
   * Every stored-file command that got as far as working on a file, in order (`open_file`, `save_file_copy`, `add_file`,
   * `attach_file`, `replace_file`), with the ids it was sent. A refused one, a question (a program file asks first) and a
   * closed dialog are not here. No path is ever in it: the page sends none.
   */
  fileOps: { cmd: string; id?: string; file_id?: string; collection?: string | null }[];
  /** The next file picker or save dialog (the next file command that opens one) is closed without a choice. */
  dismissFileNext(): void;
  /** The file the next picker chooses, by its name and size in bytes (a made-up name; a made-up one is chosen when none is set). */
  pickNext(name: string, length?: number): void;
  /**
   * The files the next `pick_files_to_add` chooses (a first pick, or Pick more), by name and size in bytes. A pick with none set chooses
   * the one file `pickNext` names, or a made-up one, so a test of one file needs nothing more.
   */
  pickFilesNext(files: { name: string; size: number }[]): void;
  /** The choices the shell holds now (the page's picks), as the names and sizes in each, in order of the picks. */
  heldChoices(): { name: string; size: number }[][];
  /** Free space on the drive, in bytes, as `add_files` checks it; `null` (to begin with) is a drive whose free space can't be read, which never blocks. */
  setFreeSpace(bytes: number | null): void;
  /** The names a batch can't read (deleted or held open after the pick, or not a file): each goes in `failed`, and the batch goes on. */
  unreadableFiles(names: string[]): void;
  /** The next batch ends after `count` files went in, for the vault's `refusal` (a drive that filled, a vault that stayed busy). */
  batchEndsAfter(count: number, refusal: object): void;
  /** The names `add_files` stored, in order. */
  addedFiles: string[];
  /** The names Save all files wrote, as they are on disk (after the name rule and any " (2)"), in order. */
  savedToDisk: string[];
  /** Names that are already in the folder the next Save all files picks: a file with one of them is saved under the next free number. */
  savedNamesTaken(names: string[]): void;
  /** The files (by stored name) that go from the vault while the next Save all files runs: each is listed in `gone` and the batch goes on. */
  filesGoneDuringSave(names: string[]): void;
  /** A file is added to the folder just after the next `save_all_files` answers its plan, so `save_all_start` finds the folder changed. */
  changeFolderAfterPlanNext(): void;
  /** The folders `show_output_in_explorer` opened, as the shell shows them. */
  openedFolders: string[];
  /** The next `show_output_in_explorer` fails to open the folder (`{ code: "io" }`). */
  explorerFailsNext(): void;
  /** How many times `open_help` reached the shell, which opens only its own fixed address (the body is `{}`, nothing else). */
  helpOpened: () => number;
  /** The next `open_help` fails to start the browser (the shell's usual `io` refusal, which carries no address). */
  helpFailsNext(): void;
  /** How many summary handles the shell holds now (one per finished Save all files or export, until `close_output`, a lock or `dropParkedChoices`). */
  heldOutputs(): number;
  /**
   * Holds every stored-file command's answer until `release` is called, as a big file would: `lockbox://busy` says the vault is
   * working (`import`, `save_copy` or `open`) as the command arrives, and says it is not when the answer is decided, which is
   * at release, as the shell decides it: a lock in between leaves a refusal (`locked`) and nothing done.
   */
  holdFiles(): () => void;
  /**
   * The long jobs of a held command that has a request (an add, an attach, a Save a copy and its cloud yes), as the shell's job table would
   * list them: sent to the page by `lockbox://job-started` as the command arrives, ended by `lockbox://progress` with `finished` when it is let
   * go, cancelled (`cancel_operation`) or its vault locks. The operation is the shell's number, which the page learns from that event only.
   */
  runningJobs(): { request: number; operation: number; scope: { type: "session"; session: number; generation: number }; kind: string }[];
  /** The launch-scoped jobs running (a test of a backup), as `runningJobs` lists a vault's: the scope names the lock epoch the job began in. */
  runningLaunchJobs(): { request: number; operation: number; scope: { type: "launch"; epoch: number }; kind: string }[];
  /** Sends `lockbox://progress` for a running job with these figures. */
  sendProgress(operation: number, done: number, total: number): void;
  /**
   * Test a backup (Plan 4B Task 4). The shell holds the picked backups under choices of 32 hex characters, launch-scoped: a pick forgets the choice it was
   * sent, and the shell's lock epoch (`lock_all`, `changeLockEpoch`) drops every one. These are the names and sizes held now, in order of the picks.
   */
  testChoices(): { name: string; size: number }[];
  /** The tokens of the choices held now, in order of the picks (the page only learns one from an answer). */
  testChoiceTokens(): string[];
  /** The file the next `test_backup_pick` chooses, by name and size in bytes (`BACKUP_NAME` and 1.2 GB when none is set). */
  pickBackupNext(name: string, size?: number): void;
  /** Lets the shell forget every held backup at once, as five minutes do: a `test_backup` for one is then `choice_expired`. */
  expireTestChoices(): void;
  /** What the next tests find when they open (changes what `test_backup` answers with): the summary's fields over a made-up one. Stays until changed. */
  backupSummary(summary: Partial<{ created_at: string; items: number; files: number; missing_files: number; size_on_disk: number }>): void;
  /** The next test that opens the backup finds it damaged, with this first failing `what` (`undefined`: a refusal with none). Once. */
  damageBackup(what: string | undefined): void;
  /** Holds every `test_backup_pick` answer until `release` is called, as the picker stays open: the choice is made at release. */
  holdPicker(): () => void;
  /**
   * Holds every `test_backup` until `release` is called, as a big backup would: its job (kind `test`, scope `launch` with the epoch it began in) is
   * running from the moment the command arrives, and it is decided at release (a lock epoch in between leaves `locked`, a Cancel leaves `cancelled`).
   */
  holdTest(): () => void;
  /**
   * Holds the `lockbox://job-started` of a test of a backup until `release` is called, as an event that reaches the page late (the command has begun
   * and the job is running in the shell; the page has not heard which operation it is).
   */
  holdJobStarted(): () => void;
  /**
   * Open a backup read-only (Plan 4B Task 7). The shell holds the picked backups under choices of 32 hex characters, launch-scoped and of their own kind (a
   * test's choice never answers for an open's): a pick forgets the choice it was sent, a session opened uses its choice up, a wrong password or a Stop keeps
   * it, and the shell's lock epoch drops every one. These are the names and sizes held now, and their tokens, in order of the picks (the picker uses
   * `pickBackupNext`, `dismissFile` and `holdPicker`, as Test a backup's does).
   */
  openChoices(): { name: string; size: number }[];
  openChoiceTokens(): string[];
  /** Lets the shell forget every held open choice at once, as five minutes do: an `open_backup_read_only` for one is then `choice_expired`. */
  expireOpenChoices(): void;
  /** Holds every `open_backup_read_only` until `release` is called: its job (kind `open_backup`, scope `launch`) runs from the moment the command arrives. */
  holdOpen(): () => void;
  /**
   * Holds every `copy_item_to` answer until `release` is called, as a copy with big attachments would: the shell decides and writes when the command arrives (a
   * `MissingFiles` question or the copy itself), and the answer reaches the page only at release, so a switch of window or a Cancel can come in between.
   */
  holdCopy(): () => void;
  /** The items the next backups that are opened hold (a made-up set when none is given): copied for each open, so a copy out never changes what the next open finds. */
  backupHolds(items: FakeItem[]): void;
  /** The file names (as picked) of the backups open now: a session of this page on each. */
  backupsOpen(): string[];
  /** The session of the backup opened from this file name, when it is open. */
  sessionOfBackup(fileName: string): Live | undefined;
  /** What `copy_item_to` copied, in order: the item (by id), the folder it went to (`null` for none), whether the missing files were left out, and the new item's id. */
  copiedOut: { from: number; to: number; id: string; folder: string | null; skipMissing: boolean; newId: string }[];
  /**
   * Restore a backup (Plan 4B Task 5). The shell holds the picked backups under choices of 32 hex characters, launch-scoped, as for Test a backup (the
   * pick uses `pickBackupNext`, `dismissFileNext` and `holdPicker`): a pick forgets the choice it was sent, every lock epoch drops them all, and one that is
   * checked also holds the credential and the parent folder. These are the names and sizes held, and whether each is checked, in order of the picks.
   */
  restorePicks(): { name: string; size: number; checked: boolean }[];
  /** The tokens of the restore picks held now, in order of the picks. */
  restorePickTokens(): string[];
  /** What the next checks find in the backup: its vault's name, the day it was made (`null`: it does not say), and whether a vault with its ID is in the folder (and the name its older copy gets). Stays until changed. */
  restoreIs(found: Partial<{ name: string; made: string | null; replaces: boolean; keptAs: string }>): void;
  /** Lets the shell forget every held restore pick at once, as five minutes do. */
  expireRestorePicks(): void;
  /**
   * Holds every `restore_check` until `release` is called, as unlocking the backup takes a moment: its job (kind `restore_check`, scope `launch`) runs from the
   * moment the command arrives, and the answer is decided at release (a Cancel in between leaves `cancelled`, the pick kept and nothing found).
   */
  holdRestoreCheck(): () => void;
  /** Holds every restore copy (`restore_prepare`, `restore_prepare_confirm`) until `release` is called: its job (kind `restore`, scope `launch`) runs from the moment it starts. */
  holdRestoreCopy(): () => void;
  /** Holds every `restore_commit` until `release` is called: the swap's job (kind `restore`, `total` 1) runs, with no Stop. */
  holdRestoreSwap(): () => void;
  /**
   * Holds the answer of every restore copy that finishes until `release` is called: the copy is done in the shell (its job has ended, the finished restore
   * is held, the pick is gone) but the page has not heard yet, so a lock can land in between. A lock epoch of any reason but `idle` ends the finished restore.
   */
  holdRestoreAnswer(): () => void;
  /** The next finished copy's answer names the vault this (the archive the copy actually opened), not the name the check found. */
  restoreCopyNames(name: string): void;
  /** The next `restore_prepare` asks a question first, as the shell does: the cloud folder's, or the new folder's name (suggested `<name> (restored)`). */
  restoreAsksNext(kind: "cloud" | "name"): void;
  /** The next restore copy starts its job and then ends with this refusal (the pick is kept, except for `backup changed`, which forgets it), as the engine's own checks come first inside the job. */
  restoreCopyRefuses(error: object): void;
  /** The next `restore_commit` is refused with this, after its job started (a swap that could not be made: nothing changes). */
  restoreCommitRefuses(error: object): void;
  /** The finished copies the shell holds, waiting for their swap, by number; and the numbers `restore_discard` let go. */
  preparedRestores(): number[];
  discardedRestores(): number[];
  /** The folder names `restore_prepare_confirm` was sent, in order (`null` for none). */
  confirmedNames(): (string | null)[];
  /**
   * Plan 4B Task 6, a restore that didn't finish. `restore_notice` answers what launch kept (the last `kind: "restore"` of `setLaunchNotices` or `tell`, without its
   * kind), or `{ state: "none" }`. `retry_restore_recovery` answers the next of these (and that becomes what `restore_notice` answers), or the same notice again when
   * none is given; `dismiss_restore` with `confirm: true` leaves nothing, and without it asks (`Confirm` `Dismissal`). A refusal is `refuseNext`.
   */
  retryRestoreGives(...answers: object[]): void;
  /** The next `restore_prepare` (or its confirm) is not answered with a copy but with `Confirm` `Recovery` carrying this notice, as an unfinished restore's journal makes it. */
  restoreRecoversNext(notice: object): void;
  /**
   * The older copies the shell lists (Plan 4B Task 8), in order, from the next listing on. Every `list_pre_restore` replaces every ID it gave before, as the shell
   * does; a copy opened read-only is a session of its own, and a delete of a copy a session has open is refused as `busy`.
   */
  olderCopies(copies: FakeOlderCopy[]): void;
  /** The ID each listed copy has in the newest listing, by folder name. */
  olderIds(): Record<string, number>;
  /** Makes every ID the shell gave so far unknown, as another listing would: the page's IDs no longer match, and its next send is `not_found`. */
  forgetOlderIds(): void;
  /** The folder names `delete_pre_restore` deleted, in order. */
  deletedOlderCopies(): string[];
  /** Pretends another session has this copy open: its delete is refused as `busy`. */
  olderCopyIsOpen(folder: string): void;
  /** The folder names of the older copies a session of this page has open now. */
  olderCopiesOpen(): string[];
  /**
   * Holds every `list_pre_restore` until `release` is called, which answers them in the reverse order they were sent: each listing is decided (its IDs given, and
   * every earlier ID replaced) when it is let go, as the shell does when a slow scan ends after a quicker one that began later.
   */
  holdOlderListing(): () => void;
  /** Holds every `open_pre_restore_read_only` until `release` is called: the credential is checked and the session made when it is let go. */
  holdOlderOpen(): () => void;
  /** Holds every `delete_pre_restore` until `release` is called: the copy is deleted (or the refusal decided) when it is let go. */
  holdOlderDelete(): () => void;
  /** The name and the choice of the backup the last `backup_vault` wrote and parked for 22c's Test this backup. */
  lastBackupName(): string;
  lastBackupChoice(): string;
  /** How many opened copies another program holds, as the last `lockbox://notice` of `open_cleanup` told. `retry_open_cleanup` leaves this many. */
  retryLeaves(stillOpen: number): void;
  /** How many times `retry_open_cleanup` reached the shell. */
  retries(): number;
  /** Holds every `retry_open_cleanup` answer until `release` is called: the count is read when it arrives, and the answer comes later. */
  holdRetry(): () => void;
  /**
   * Holds every `get_item` answer until `release` is called, which lets the newest through first: what each answer says is read when the
   * command arrives, so an older answer comes after a newer one, as it can on a busy shell.
   */
  holdGetItem(): () => void;
  /**
   * Holds every `change_password` answer until `release` is called: the change is decided (and written, when it is good) as the command arrives,
   * as the shell writes it, and the answer comes later, so the person can switch vault or a lock can come in between.
   */
  holdChangePassword(): () => void;
  /**
   * Holds every `unlock_vault` answer until `release` is called (Plan 4C Task 6): the password is checked and the session is opened as the command arrives, as the
   * shell does it, and the answer comes later, so the person can go Back, or lock the vault, in between.
   */
  holdUnlock(): () => void;
  /**
   * Holds every `create_vault` and `create_vault_confirm` answer until `release` is called (Plan 4C Task 7): the vault is decided, made and listed as the command
   * arrives, as the shell does it, and the answer comes later, so the typed text can be looked for, or a lock can come in between.
   */
  holdCreate(): () => void;
  /**
   * The next `create_vault` or `create_vault_confirm` that would make a vault (not one that asks, is dismissed or is refused first) is cut short as a lock of all
   * vaults can cut it: every unlocked session locks, and the lock epoch moves on. `lock_before_create`: nothing was made, and the answer is `locked`.
   * `lock_after_create`: the vault is made and listed (with its "not confirmed" mark and a key nobody saw) and its session opened, then the lock; the answer is
   * tagged with the generation from before (the bridge drops it as stale). `lock_after_create_as_error`: the vault is made and listed (mark and key as above),
   * no session is opened, then the lock, and the answer is `locked_after_change` with the new vault's registry ID.
   */
  interruptCreateNext(how: "lock_before_create" | "lock_after_create" | "lock_after_create_as_error"): void;
  /**
   * The next create that makes a vault also puts `vault` on the list right after its own, with the next higher ID, as an add in another window would. `vault.id`
   * is overwritten with that ID. A page that took the newest vault of the list for its own would take this one.
   */
  listAlongsideNextCreate(vault: FakeVault): void;
  /**
   * The next `change_password` is cut short as a lock can cut it (Plan 4C Task 3, Ask 16's cases). `lock_before_write`: the lock came before the
   * headers were written, so nothing changed and the answer is `locked`. `lock_after_write`: the change landed, then the lock event reached the
   * page before the good answer did, so the answer is tagged with the generation from before. `lock_after_write_as_error`: the change landed and the
   * shell answered `locked_after_change` with the vault's registry ID: this is also what the shell answers when `vault.json` landed though the
   * write came back as an error (`commit` read it back and made the new header live), after locking that vault. `refused_before_write`: the write
   * failed before `vault.json` was touched, so nothing changed, the old password still opens and the answer is this plain refusal.
   */
  interruptChangeNext(how: "lock_before_write" | "lock_after_write" | "lock_after_write_as_error" | { refused_before_write: object }): void;
  /**
   * The vaults shown in Explorer by `show_vault_in_explorer`, by registry ID, in order (Plan 4C Task 9). A refusal puts nothing here.
   */
  openedVaults: number[];
  /** The identity of the vault list now (what each `list_vaults` entry says in `list`): a new list (`start_new_vault_list`) has another. */
  listIdentity(): number;
  /**
   * The vault list is replaced by another (as when a damaged list was started over and the vaults added back): it has a new identity, and `next` are the vaults on it, whose
   * IDs may be numbers the old list used for other vaults. Vaults that are open stay open, as they do in the shell. Nothing is sent to the page; it reads the list again.
   */
  replaceVaultList(next: FakeVault[]): void;
  /** The vault's folder or drive is there again (`true`) or isn't (`false`): the list says `available` from then on. Nothing is sent to the page. */
  setAvailable(vaultId: number, available: boolean): void;
  /** The vault's drive goes while it is open: it is `available: false` from now, and its session (when open) locks alone with the reason `drive_gone`, with the event. */
  driveGone(vaultId: number): void;
  /**
   * The next `forget_vault` that gets past the busy check locks the vault when it is open, keeps it listed and refuses with `error`, as the shell's can when the list write
   * fails after the lock.
   */
  forgetFailsAfterLockNext(error: object): void;
  /** Holds every `forget_vault` answer until `release` is called: the vault is locked and taken off the list as the command arrives, and the answer comes later. */
  holdForget(): () => void;
  /**
   * Holds every `rename_vault` answer until `release` is called (Plan 4C Task 8): the name is decided (and written, when it is good) as the command arrives, as the shell writes it,
   * and the answer comes later, so the person can switch vault or a lock can come in between.
   */
  holdRename(): () => void;
  /**
   * The next `rename_vault` that gets as far as the write is cut short as a lock can cut it, as `interruptChangeNext` does for a change. `lock_before_write`: the lock came first,
   * so nothing changes and the answer is `locked`. `lock_after_write`: the name is set, then the lock event reaches the page before the good answer, so the answer is tagged with
   * the generation from before (the bridge drops it as stale). `lock_after_write_as_error`: the name is set, the vault locks, and the answer is `locked_after_change` with
   * what `"vault name"` and the vault's registry ID.
   */
  interruptRenameNext(how: "lock_before_write" | "lock_after_write" | "lock_after_write_as_error"): void;
  /**
   * Forgot password (Plan 4C Task 4). The recovery key that opens the vault now: its `recoveryKey`, or the key the fake last made for it, or `fakeKey(40 + id)`.
   * `keyOf` stays as it is (what a setup test expects: `undefined` until a key was made).
   */
  recoveryKeyOf(vaultId: number): string;
  /** Holds every `recover_check` until `release` is called: it is decided, and its choice parked, as the command arrives; the answer comes at release. */
  holdRecoverCheck(): () => void;
  /** Holds every `recover_finish` until `release` is called: it is decided, and the password written, as the command arrives; the answer comes at release. */
  holdRecoverFinish(): () => void;
  /**
   * The next `recover_finish` is cut short as a lock can cut it, as `interruptChangeNext` does for a change. `lock_before_write`: the lock epoch moves on, nothing
   * changes and the answer is `locked`. `lock_after_write`: the password is set and the session opened, then it locks, and the answer is tagged with the
   * generation from before (the bridge drops it as stale). `lock_after_write_as_error`: the same, and the answer is `locked_after_change` with the vault's ID.
   */
  interruptRecoverNext(how: "lock_before_write" | "lock_after_write" | "lock_after_write_as_error"): void;
  /** The tokens of the recovery choices the shell holds now (a checked key waits for its new password), in order. */
  recoveryChoiceTokens(): string[];
  /** Lets the shell forget every held recovery choice at once, as five minutes do: a `recover_finish` for one is then `choice_expired`. */
  expireRecoveryChoices(): void;
  /** The settings the shell holds now (what the last accepted `set_settings` sent), and every one it accepted, in order. */
  settings(): FakeSettings;
  settingsSaved: FakeSettings[];
  /** Holds every `set_settings` answer until `release` is called: the settings are saved when the command arrives, the answer comes later. */
  holdSettings(): () => void;
  /** The state `get_startup` answers from now on (turned off in Windows, say), and what it is now. */
  setStartup(state: FakeStartup): void;
  startup(): FakeStartup;
  /** The next `set_startup` writes, and then refuses (the readback failed), as the shell's one fixed refusal can mean. */
  startupReadbackFailsNext(): void;
}

/** The settings as the shell sends them (`settings.rs`): the three new fields have the shell's defaults. */
export interface FakeSettings {
  idle_minutes: number;
  clipboard_seconds: number;
  theme: "system" | "light" | "dark";
  shortcut: { ctrl: boolean; shift: boolean; alt: boolean; key: number };
  capture_protected: boolean;
}

export const DEFAULT_SETTINGS: FakeSettings = {
  idle_minutes: 5,
  clipboard_seconds: 30,
  theme: "system",
  shortcut: { ctrl: true, shift: true, alt: false, key: 76 },
  capture_protected: true,
};

/** Start with Windows as the shell reads it (`startup.rs`). */
export interface FakeStartup {
  on: boolean;
  turned_off_in_windows: boolean;
}

/** What the shell sends for a shortcut that is not allowed, one another app has, and one Windows would not take (`Settings::check`, `set_settings`). */
export const SHORTCUT_REFUSED = { code: "invalid_input", what: "shortcut" };
export const SHORTCUT_TAKEN = { code: "invalid_input", what: "shortcut taken" };
export const SHORTCUT_NOT_SET = { code: "invalid_input", what: "shortcut not set" };
/** What the shell sends when Start with Windows could not be changed (`ShellError::Core` `io` with `what: "startup"`). */
export const STARTUP_FAILED = { code: "core", kind: "io", what: "startup" };

/** The shell's own check of a shortcut: at least two modifiers, a letter, a digit or F1 to F12, and never Ctrl with C, V or X. */
function shortcutAllowed(shortcut: FakeSettings["shortcut"]): boolean {
  const modifiers = [shortcut.ctrl, shortcut.shift, shortcut.alt].filter(Boolean).length;
  const { key } = shortcut;
  const known = (key >= 0x41 && key <= 0x5a) || (key >= 0x30 && key <= 0x39) || (key >= 0x70 && key <= 0x7b);
  return modifiers >= 2 && known && !(shortcut.ctrl && (key === 0x43 || key === 0x56 || key === 0x58));
}

/** What the shell sends for a theme, an idle time or a clipboard delay it does not take. */
const SETTINGS_FIELDS = ["idle_minutes", "clipboard_seconds", "theme", "shortcut", "capture_protected"];

/** What the shell sends for a website that is not an `http` or `https` address (`NOT_A_WEBSITE`). */
export const NOT_A_WEBSITE = { code: "invalid_input", what: "website" };
/** What the engine sends for a key's name that is not a variable name (`check_key_name`). */
export const BAD_KEY_NAME = { code: "core", kind: "invalid_input", what: "key name" };
/** What the shell sends for a login's field asked of a key or a note, and a key's value asked of anything else. */
const NOT_A_LOGIN = { code: "invalid_input", what: "not a login" };
const NOT_A_KEY = { code: "invalid_input", what: "not a key" };
/** What the shell sends for an earlier password's number past the login's list. */
const NO_SUCH_EARLIER = { code: "invalid_input", what: "earlier password" };
/** An item counted as one more edit: next revision, modified now. */
function bump(item: FakeItem): void {
  item.revision = (item.revision ?? 2) + 1;
  item.modified_at = nowText();
}

/** Puts an item in the trash, with the folder whose delete sends it (`with`), as the engine writes it; one already there is left alone. */
function intoTrash(item: FakeItem, folder: string | undefined): void {
  if (item.trashed ?? false) return;
  item.trashed = true;
  item.trashedAt = nowText();
  item.trashedWith = folder;
  bump(item);
}

/** Takes an item out of the trash and clears the folder it went with; one that is not there is left alone. */
function outOfTrash(item: FakeItem): void {
  if (!(item.trashed ?? false)) return;
  item.trashed = false;
  item.trashedAt = undefined;
  item.trashedWith = undefined;
  bump(item);
}

/** What the shell sends for a folder named with nothing (`NO_FOLDER_NAME`). */
export const FOLDER_NAME_EMPTY = { code: "invalid_input", what: "folder name" };
/** What the engine sends for an item whose delete for good has started (`BEING_DELETED`). */
const BEING_DELETED = { code: "core", kind: "invalid_input", what: "being deleted" };
/** The shell's limit on a title, in bytes (`MAX_TITLE`). */
const MAX_TITLE = 1024;

/** The time as the engine writes it: RFC 3339, UTC, whole seconds. */
function nowText(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, "Z");
}

/** What the engine sends for a folder asked to go to the trash on its own (`trash_item`). */
const USE_DELETE_COLLECTION = { code: "core", kind: "invalid_input", what: "use delete_collection" };
/** What the engine sends for a delete of something that is not a folder (`delete_collection`). */
const NOT_A_COLLECTION = { code: "core", kind: "invalid_input", what: "not a collection" };
/** What the engine sends for a delete for good of an item that is not in the trash (`purge_item`). */
const NOT_IN_TRASH = { code: "core", kind: "invalid_input", what: "not in trash" };
/** What the engine sends when an edit's revision is not the stored one. */
export const STALE_REVISION = { code: "core", kind: "invalid_input", what: "stale revision" };
/** How many earlier passwords a login keeps (`MAX_PREVIOUS_PASSWORDS`). */
const MAX_PREVIOUS = 5;

/** The number in `{ previous: <number> }` as the shell reads it (0 to 255, nothing else in the object), or null. */
function previousIndex(field: unknown): number | null {
  if (typeof field !== "object" || field === null || Array.isArray(field)) return null;
  const keys = Object.keys(field);
  const index = (field as { previous?: unknown }).previous;
  if (keys.length !== 1 || keys[0] !== "previous") return null;
  return typeof index === "number" && Number.isInteger(index) && index >= 0 && index <= 255 ? index : null;
}
/** The shell's limit on a key's value (`MAX_KEY_VALUE`). */
const MAX_KEY_VALUE = 16_384;

/**
 * `normalise_url` as the shell has it, in short: trimmed, `https://` added when there is no scheme of its own (a host and
 * port such as `localhost:3000` has none), and every other scheme, an empty address and a control character refused.
 */
function normaliseUrl(text: string): string {
  const typed = text.trim();
  // eslint-disable-next-line no-control-regex -- the shell refuses control characters
  if (typed === "" || /[\u0000-\u001f\u007f-\u009f]/.test(typed)) return refuse(NOT_A_WEBSITE);
  const scheme = /^([a-z][a-z0-9+.-]*):(\d+(?:[/?#]|$))?/i.exec(typed);
  const hasScheme = scheme !== null && (scheme[2] === undefined || /^https?$/i.test(scheme[1] ?? ""));
  if (!hasScheme && /^[/\\]/.test(typed)) return refuse(NOT_A_WEBSITE);
  const saved = hasScheme ? typed : `https://${typed}`;
  if (!/^https?:\/\//i.test(saved)) return refuse(NOT_A_WEBSITE);
  return saved;
}

/** The generator's own limit on what `copy_generated` takes (`MAX_GENERATED` in `commands/generator.rs`). */
const MAX_GENERATED = 192;

/** A small repeatable random source, so a test's "different value" is not left to chance. */
function randomSource(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let sessionRange = 0;
/** How many times the save shortcut has been pressed in any fake of this test file (it makes each copy's id). */
let pressesMade = 0;

/** Refuses as the shell does: Tauri rejects with the plain object the error was serialised to, not an `Error`. */
function refuse(error: object): never {
  // eslint-disable-next-line @typescript-eslint/only-throw-error -- see above
  throw error;
}

/** What the shell sends for a pasted `.env` over 1 MB, over 500 keys, and for choices that no longer fit the folder, a name found twice, and a folder with no key. */
export const ENV_TEXT_TOO_LARGE = { code: "too_large", what: "env text" };
export const ENV_KEYS_TOO_MANY = { code: "too_large", what: "env keys" };
export const ENV_ROWS_CHANGED = { code: "invalid_input", what: "env rows" };
export const ENV_TWICE = { code: "invalid_input", what: "env twice" };
export const NO_KEYS = { code: "invalid_input", what: "no keys" };
/** The most a pasted `.env` can be, in bytes, and the most keys it can hold. */
const MAX_ENV_TEXT = 1_048_576;
const MAX_ENV_KEYS = 500;

/** One key read from a pasted `.env`, with its value, which waits in the fake as in the shell and never comes back. */
interface EnvPasted {
  index: number;
  name: string;
  value: string;
}

/**
 * A small stand-in for the engine's `.env` reader: `NAME=value` per line, an optional `export `, blank lines and `#` comments
 * skipped, one pair of quotes taken off a value; a line it can't read is its number (from 1), never its text.
 */
function readEnvText(text: string): { rows: EnvPasted[]; bad: number[] } {
  const rows: EnvPasted[] = [];
  const bad: number[] = [];
  text.split(/\r?\n/).forEach((raw, at) => {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) return;
    const found = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (found === null) {
      bad.push(at + 1);
      return;
    }
    rows.push({ index: rows.length, name: found[1] ?? "", value: (found[2] ?? "").replace(/^(['"])(.*)\1$/, "$2") });
  });
  return { rows, bad };
}

/**
 * A stand-in for the engine's `.env` writer (`env_file::write`, whose own tests prove it): `NAME=value` per line, a value of only
 * letters, digits and `_-./:@+=,` bare, one with no quote or line break in single quotes, any other in double quotes with
 * `\\`, `\"`, `\n`, `\r`, `\t` and `$` escaped. Line breaks are never turned into others.
 */
function writeEnvText(keys: readonly { title: string; value?: string }[]): string {
  return keys
    .map(({ title, value = "" }) => {
      if (/^[A-Za-z0-9_\-./:@+=,]*$/.test(value)) return `${title}=${value}\n`;
      if (!/['\r\n]/.test(value)) return `${title}='${value}'\n`;
      const escaped = value.replace(/[\\"\n\r\t$]/g, (c) => ({ "\\": "\\\\", '"': '\\"', "\n": "\\n", "\r": "\\r", "\t": "\\t", $: "\\$" })[c] ?? c);
      return `${title}="${escaped}"\n`;
    })
    .join("");
}

/** The live key items filed in `place` (a folder's id, or null for none), as the engine counts them. */
function liveKeys(items: readonly FakeItem[], place: string | null): FakeItem[] {
  return items.filter((item) => item.kind === "key" && !(item.trashed ?? false) && (item.collection ?? null) === place);
}

/** The rows that clash in `place`, with the name Keep both would use, by the rules the shell works them out by. */
function envClashes(items: readonly FakeItem[], rows: readonly EnvPasted[], place: string | null): { index: number; saved_as: string }[] {
  const there = liveKeys(items, place).map((item) => item.title);
  const pasted = new Set(rows.map((row) => row.name));
  const given = new Set<string>();
  const found: { index: number; saved_as: string }[] = [];
  rows.forEach((row, at) => {
    if (!there.includes(row.name) && !rows.slice(0, at).some((earlier) => earlier.name === row.name)) return;
    let number = 2;
    while (there.includes(`${row.name}_${String(number)}`) || pasted.has(`${row.name}_${String(number)}`) || given.has(`${row.name}_${String(number)}`)) {
      number += 1;
    }
    const savedAs = `${row.name}_${String(number)}`;
    given.add(savedAs);
    found.push({ index: row.index, saved_as: savedAs });
  });
  return found;
}

/** What the shell sends when a capture's value is missing: nothing was copied and nothing was typed (`what: "capture value"`). */
export const CAPTURE_VALUE_NEEDED = { code: "invalid_input", what: "capture value" };

/** The copy the shortcut left waiting in the shell: the text as it was read, and what the page may know of it. */
interface FakeSlot {
  id: string;
  text: string | null;
  state: "value" | "empty" | "too_large";
  /** The session the copy is handed to, with its generation (`capture_choose`), or `null` for none. Save and Reveal are held to both. */
  chosen: number | null;
  chosenGeneration: number | null;
}

/** What the shell sends when `capture_save` is given a session the copy is not handed to (none chosen, another one, or the chosen one at another generation). */
export const CAPTURE_VAULT = { code: "invalid_input", what: "capture vault" };

/** What the engine sends for a file that does not decrypt (`Damaged { what: "file" }`), and for an item that holds no files. */
export const FILE_DAMAGED = { code: "core", kind: "damaged", what: "file" };
const CANNOT_HOLD_FILES = { code: "core", kind: "invalid_input", what: "item cannot hold files" };
/** The types the shell asks about before it opens them (`is_executable`: a few of the many it knows). */
const PROGRAM_FILE = /\.(exe|bat|cmd|msi|ps1|scr|com)$/i;
/** What a stored-file command is called in `lockbox://busy`. */
const OPERATION: Record<string, string> = {
  open_file: "open",
  save_file_copy: "save_copy",
  save_file_copy_confirm: "save_copy",
  add_file: "import",
  attach_file: "import",
  add_files: "import",
  replace_file: "import",
  backup_vault: "backup",
  save_all_start: "save_all",
};

/** What a stored-file command that takes a `request` is called in `lockbox://job-started` and `lockbox://progress` (the others start no job event). */
const JOB_KIND: Record<string, string> = {
  add_file: "import",
  attach_file: "import",
  add_files: "import",
  save_file_copy: "save_copy",
  save_file_copy_confirm: "save_copy",
  backup_vault: "backup",
  save_all_start: "save_all",
};

/** The most one file can be (`MAX_FILE_BYTES`, 256 GiB): a file over it is refused before the batch starts. */
const MAX_FILE = 256 * 1024 ** 3;
/** What the shell sends for a choice that was used, dropped, expired or is another session's. */
export const CHOICE_EXPIRED = { code: "choice_expired" };
/** The backup the picker chooses when a test names none, how big it is, and the password it was made with (the day it was made, not today's). */
export const BACKUP_NAME = "My vault 2026-10-02.lockbox-backup";
const BACKUP_SIZE = 1_288_490_188;
export const BACKUP_PASSWORD = "from-the-day-it-was-made";
/** The backup the fake's backups write, as named and kept for 22c. */
const BACKUP_DAY = "2026-11-04";
/** What the shell sends for a file's number past the end of the picked list. */
const NO_SUCH_PICK = { code: "invalid_input", what: "index" };

/**
 * An older copy a restore kept beside a vault (Plan 4B Task 8), as the fake shell holds it: `vault` is the vault's place on the list, `last_written` and `size`
 * are what a listing says (the default is 4 November 2026 and 5 MB; `null` is a part the shell could not read), and `password` opens it (the vault's own
 * password unless set). The folder is a name only: no path ever reaches the page.
 */
export interface FakeOlderCopy {
  vault: number;
  folder: string;
  name?: string | null;
  last_written?: string | null;
  size?: number | null;
  password?: string;
  /** Its details were changed outside Lockbox: opening it answers `header_changed: true`. */
  headerChanged?: boolean;
}

/** One file the page picked, as the shell holds it (the page sees the name and size only). */
interface PickedEntry {
  name: string;
  size: number;
}

/** A batch the shell has taken the choice for: where it goes, and the files in the order picked. */
interface Batch {
  session: number;
  generation: number;
  into: { type: "folder"; collection: string | null } | { type: "item"; id: string };
  files: PickedEntry[];
  total: number;
}

/** One stored file of a folder, as Save all files plans it: where it is stored, its name as stored and as written (after the shell's name rule), its size. */
interface PlannedEntry {
  itemId: string;
  fileId: string;
  stored: string;
  name: string;
  size: number;
  attached_to: string | null;
}

/** A save the shell holds: the folder, where it goes (display text), and the files in the order they will be saved. Held from its plan to its start. */
interface SaveRun {
  session: number;
  generation: number;
  folder: string;
  files: PlannedEntry[];
  total: number;
}

/**
 * `save_name`, in short: what Windows refuses (`< > : " / \ | ? *` and control characters) becomes `_`, and trailing dots and spaces go. The real
 * one also handles device names and a cut at 100 characters; the page never works a name out, so the fake needs only a rule that changes some.
 */
function saveNameOf(name: string): string {
  const changed = Array.from(name, (letter) => (`<>:"/\\|?*`.includes(letter) || letter.charCodeAt(0) < 32 ? "_" : letter)).join("");
  return changed.replace(/[. ]+$/, "") || "file";
}

/** `name` with " (n)" before its last extension: "contract.pdf" and 2 make "contract (2).pdf". */
function numberedName(name: string, number: number): string {
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? `${name} (${String(number)})` : `${name.slice(0, dot)} (${String(number)})${name.slice(dot)}`;
}

/** A request is a whole number the page chose (a `u32`); anything else is the shell's malformed-request answer. */
function requestOf(sent: Record<string, unknown>): number {
  const { request } = sent;
  if (typeof request !== "number" || !Number.isInteger(request) || request < 0 || request > 0xffff_ffff) return refuse(MALFORMED);
  return request;
}

/** One long job in the fake shell's table. */
interface RunningJob {
  request: number;
  operation: number;
  scope: JobScopeOf;
  kind: string;
  done: number;
  total: number;
  /** Ends the held command as a Cancel does: it answers `cancelled`. */
  cancel: () => void;
  /** A restore's swap: no lock epoch ends it (it is past the point of cancelling), and it has no Stop. */
  pastTheSwap?: boolean;
}

/** The first free `NAME_2`, `NAME_3`, ... among the live keys of one place. */
function freeName(items: readonly FakeItem[], place: string | null, name: string): string {
  const taken = liveKeys(items, place).map((item) => item.title);
  let number = 2;
  while (taken.includes(`${name}_${String(number)}`)) number += 1;
  return `${name}_${String(number)}`;
}

/** A clipboard text with every line ending read as a line feed, as the paste panel's clear compares them. */
function linesOf(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

function exactly(args: unknown, keys: string[]): Record<string, unknown> {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return refuse(MALFORMED);
  const found = Object.keys(args).sort();
  if (found.join() !== [...keys].sort().join()) return refuse(MALFORMED);
  return args as Record<string, unknown>;
}

/**
 * Wires `invoke` and `listen` (the mocked Tauri modules) to a fake shell holding `vaults`. `listen` keeps the handlers
 * it was given, so `lock` can call them.
 */
export function installFakeShell(
  invoke: Mock,
  listen: Mock,
  vaults: FakeVault[],
  given: Partial<FakeSettings> = {},
): FakeShell {
  // The settings the shell holds: what the person gave over the defaults. `set_settings` changes them, as the shell's save does.
  let settings: FakeSettings = { ...DEFAULT_SETTINGS, shortcut: { ...DEFAULT_SETTINGS.shortcut }, ...given };
  let startup: FakeStartup = { on: false, turned_off_in_windows: false };
  let readbackFails = false;
  const saved: FakeSettings[] = [];
  let heldSettings: (() => void)[] | undefined;
  // The handlers each event has, as `listen` was given them.
  const handlers = new Map<string, ((event: { payload: unknown }) => void)[]>();
  // How many `lockbox://close-asked` events a listener was handed, by whatever sent them (a test checks a repeat really arrived).
  let closeAskedHeard = 0;
  const emit = (event: string, payload: unknown): void => {
    for (const handler of handlers.get(event) ?? []) {
      if (event === "lockbox://close-asked") closeAskedHeard += 1;
      handler({ payload });
    }
  };
  let launchNotices: object[] = [];
  let outputResets = 0;
  // The settings file's `close_explained` (which the page never sees), whether 5b is showing, and where the window is.
  let closeExplained = false;
  let explaining = false;
  let hidden = false;
  let closeExplainedCalls = 0;
  // The question a close or a Quit asked and the shell is holding, what was answered, how often the app quit, and the lock epoch's number.
  // Each question gets its number from the shell (Plan 4C Task 12); a repeat of the pending one carries the same number.
  let pendingClose: { reason: "close" | "quit"; question: number; event: Record<string, unknown> } | undefined;
  let closeQuestions = 0;
  const closeAnswers: boolean[] = [];
  let quits = 0;
  let lockEpoch = 0;
  let clearCopiedCalls = 0;
  let clearCopiedAnswer: "cleared" | "gone" | "busy" = "cleared";
  const live = new Map<number, Live>();
  const sessionVault = new Map<number, FakeVault>();
  // A fresh range of session numbers for each fake, because the bridge remembers every session's generation for the
  // life of the test file, and a later test must not meet an earlier test's.
  sessionRange += 100;
  let nextSession = sessionRange;
  let held: (() => void)[] | undefined;
  let partway: { cmd: string; writes: number; error: object } | undefined;
  const calls: FakeShell["calls"] = [];
  const copied: FakeShell["copied"] = [];
  const opened: FakeShell["opened"] = [];
  let heldSearch: (() => void)[] | undefined;
  let heldNewItem: (() => void)[] | undefined;
  let heldReveal: (() => void)[] | undefined;
  let heldUpdate: (() => void)[] | undefined;
  let heldChange: (() => void)[] | undefined;
  let heldUnlock: (() => void)[] | undefined;
  let heldCreate: (() => void)[] | undefined;
  let interruptCreate: Parameters<FakeShell["interruptCreateNext"]>[0] | undefined;
  let alongside: FakeVault | undefined;
  let interruptChange: Parameters<FakeShell["interruptChangeNext"]>[0] | undefined;
  let heldRename: (() => void)[] | undefined;
  let interruptRename: Parameters<FakeShell["interruptRenameNext"]>[0] | undefined;
  // Forgot password (Task 4): the checked keys the shell holds under their choices (32 hex characters, launch-scoped: every lock epoch and the five minutes drop
  // them), what the vault's details were as checked, the holds a test can put on the two steps, and how the next finish is cut short.
  const recoveryHeld = new Map<string, { vault: FakeVault; key: string; headerChanged: boolean }>();
  let recoveriesMade = 0;
  let heldRecoverChecks: (() => void)[] | undefined;
  let heldRecoverFinishes: (() => void)[] | undefined;
  let interruptRecover: Parameters<FakeShell["interruptRecoverNext"]>[0] | undefined;
  let heldTrash: (() => void)[] | undefined;
  const refusals = new Map<string, object>();
  const edited: FakeShell["edited"] = [];
  const made: FakeShell["made"] = [];
  const generated: FakeShell["generated"] = [];
  const revealed: FakeShell["revealed"] = [];
  const random = randomSource(7);
  let nextItem = 0x1000;
  const keys = new Map<FakeVault, string>();
  /** Every key the fake issued or was told to issue (`makeKey`, `nextKeyIs`): a key that reads as a key but is none of these (or a `fakeKey`) has a typo. */
  const issuedKeys = new Set<string>();
  let keysMade = 0;
  let chosenKey: string | undefined;
  let chosenIssue: number | undefined;
  /** What each session holds about its keys, as the shell's `KeyState` does: 21f's permission, and the last key's number. */
  const keyStates = new Map<number, { may: boolean; last: number }>();
  // The service the next create or add-existing finds syncing its folder (`cloudNext`), or `null` for none.
  let cloud: "OneDrive" | "GoogleDrive" | "Dropbox" | "Other" | null = null;
  let refuseMark = false;
  let dismissPicker = false;
  let existing: FakeVault | undefined;
  let listDamaged = false;
  // The vault list's identity and high-water mark (Task 9): an ID is never given twice within a list, and a row from another list is `not_found`.
  let listId = 4242;
  let lastId = Math.max(0, ...vaults.map((v) => v.id));
  const nextVaultId = (): number => {
    lastId += 1;
    return lastId;
  };
  const openedVaults: number[] = [];
  let heldForget: (() => void)[] | undefined;
  let forgetFailsAfterLock: object | undefined;
  /** A row as the page names it, `{ list, id }`: exactly those two whole numbers; another list's row or an ID not listed is `not_found`. */
  const vaultRefOf = (raw: unknown): FakeVault => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return refuse(MALFORMED);
    if (Object.keys(raw).sort().join() !== "id,list") return refuse(MALFORMED);
    const { list, id } = raw as { list: unknown; id: unknown };
    if (typeof list !== "number" || typeof id !== "number" || !Number.isSafeInteger(list) || !Number.isSafeInteger(id) || list <= 0 || id <= 0) return refuse(MALFORMED);
    if (listDamaged || list !== listId) return refuse({ code: "not_found" });
    const found = vaults.find((v) => v.id === id);
    if (found === undefined) return refuse({ code: "not_found" });
    return found;
  };
  let heldStartList: (() => void)[] | undefined;
  let failAfterMove: object | undefined;
  let nextToken = 0;
  const pendingCreates = new Map<string, { name: string; password: string }>();
  const pendingAdds = new Set<string>();
  const pdfs: string[] = [];
  let dismissPdf = false;
  let cloudPdf = 0;
  let printRefusal: object | undefined;
  let heldPrint: (() => void)[] | undefined;
  let heldPrinterList: (() => void)[] | undefined;
  let printers = [...PRINTERS];
  let defaultPrinter: string | null = DEFAULT_PRINTER;
  const printed: string[] = [];
  // The save a cloud question parked: its session and generation, to go on with it (`save_readable_confirm`), and the folder
  // of a `.env` file (null for the recovery key's PDF).
  const pendingPdfs = new Map<string, { session: number; generation: number; envFolder: string | null; copy?: { id: string; file_id: string }; exported?: boolean }>();
  // The exports the shell wrote (Plan 4D Task 2): what each said it held and left out. A closed dialog, a refusal or a cloud question not yet answered is not here.
  const exportsWritten: FakeExport[] = [];
  /**
   * The CSV is "written": the summary (counts and titles) is worked out from the vault's live items, and the answer carries it beside the folder and the handle
   * for Show in Explorer (`SavedView.output`: one per export, for that session and generation, shown as Save all's, until `close_output`, a lock or a drop).
   */
  const writeExport = (session: number, generation: number, vault: FakeVault) => {
    const summary = exportSummary(vault.items ?? [], vault.unreadable ?? 0);
    exportsWritten.push(summary);
    nextToken += 1;
    const output = nextToken.toString(16).padStart(32, "0");
    outputs.set(output, { session, generation, shown: SAVED_FOLDER });
    return { Done: { folder: SAVED_FOLDER, export: summary, output } };
  };
  /** The save dialog an export opens (after the password was checked): closed, a cloud-synced folder (asks first, nothing built), or a folder that is written to. */
  const exportDialog = (session: number, generation: number, vault: FakeVault) => {
    if (dismissPdf) {
      dismissPdf = false;
      return tagged(session, generation, "Dismissed");
    }
    if (cloudPdf > 0) {
      cloudPdf -= 1;
      nextToken += 1;
      const token = `export-token-${String(nextToken)}`;
      pendingPdfs.set(token, { session, generation, envFolder: null, exported: true });
      return tagged(session, generation, { Confirm: { CloudFolder: { token, provider: "Other" } } });
    }
    return tagged(session, generation, writeExport(session, generation, vault));
  };
  // The pasted `.env`s the shell holds, by token: their rows, values included, which never leave the fake.
  const envPastes = new Map<string, { session: number; generation: number; rows: EnvPasted[]; text: string }>();
  let heldEnvRead: (() => void)[] | undefined;
  let heldEnvSave: (() => void)[] | undefined;
  const envCopied: string[] = [];
  const envFiles: string[] = [];
  // The copy the shortcut left waiting (one at most), what the clipboard holds, and the holds a test can put on the reveal.
  let slot: FakeSlot | undefined;
  let clipboardText: string | null = null;
  let failClear = false;
  let heldCaptureReveal: (() => void)[] | undefined;
  let heldCaptureState: (() => void)[] | undefined;
  let heldCaptureChoose: (() => void)[] | undefined;
  let heldCaptureUnchoose: (() => void)[] | undefined;
  let captureRevealed = 0;
  // Stored files: what the commands did, the picker's next choice, a closed dialog, the hold, and the opened copies left behind.
  const fileOps: FakeShell["fileOps"] = [];
  let dismissFile = false;
  let pickedFile: { name: string; length: number } | undefined;
  let heldFiles: (() => void)[] | undefined;
  // Many files (Task 10): the choices the shell holds (one per pick session, kept by Pick more and Remove), the next picks, and how a batch ends.
  const choices = new Map<string, { session: number; generation: number; files: PickedEntry[] }>();
  const nextPicks: PickedEntry[][] = [];
  const batches = new Map<number, Batch>();
  const addedFiles: string[] = [];
  let freeSpace: number | null = null;
  let unreadable: string[] = [];
  let batchEnd: { count: number; refusal: object } | undefined;
  // Save all files (Task 11): the plans the shell holds from the picker to the start (and the cloud question's parked folder), the saves taken for a
  // job, the summary handles, and what the next save is told to meet.
  const parkedSaves = new Map<string, { session: number; generation: number; folder: string }>();
  const savePlans = new Map<string, SaveRun>();
  const saveRuns = new Map<number, SaveRun>();
  const outputs = new Map<string, { session: number; generation: number; shown: string }>();
  const savedToDisk: string[] = [];
  const openedFolders: string[] = [];
  let takenNames: string[] = [];
  let goneNames: string[] = [];
  let changeAfterPlan = false;
  let explorerFails = false;
  let helpCount = 0;
  let helpFails = false;
  // Test a backup (Task 4): the backups the shell holds paths of, by choice (the password each was made with is the shell's own), the next pick, what a test
  // finds, a damage to find once, the holds a test can put on the picker and on the test, and the backup the last `backup_vault` wrote.
  const testHeld = new Map<string, { name: string; size: number; password: string }>();
  let nextBackupPick: { name: string; size: number } | undefined;
  let summaryMade: Partial<{ created_at: string; items: number; files: number; missing_files: number; size_on_disk: number }> = {};
  let damage: { what: string | undefined } | undefined;
  let heldPicker: (() => void)[] | undefined;
  let heldTests: (() => void)[] | undefined;
  let heldStarts: (() => void)[] | undefined;
  let lastBackup: { name: string; choice: string } | undefined;
  // Open a backup read-only (Task 7): the backups the shell holds paths of for it, by choice (their own kind, so a test's choice and an open's never answer for
  // each other), what the next opened backups hold, the sessions made on backups (by the file's name), what was copied out, and the hold on the open.
  const openHeld = new Map<string, { name: string; size: number; password: string }>();
  let backupItems: FakeItem[] | undefined;
  const backupSessions = new Map<number, string>();
  const copiedOut: FakeShell["copiedOut"] = [];
  let heldOpens: (() => void)[] | undefined;
  let heldCopies: (() => void)[] | undefined;
  // Restore a backup (Task 5): the picks the shell holds by choice (with what a check found, once it has), the finished copies waiting for their swap,
  // the questions parked for their answer, what the next checks find, and the holds and refusals a test can put on each step.
  interface RestoreHeld {
    name: string;
    size: number;
    checked: { name: string; made: string | null; replaces: boolean; keptAs: string; usual: boolean } | undefined;
    /** The listed vault the pick was made for (Ask 4, Ask 8): its parent folder is where the restore goes, not the usual one. */
    vault: number | null;
  }
  const restoreHeld = new Map<string, RestoreHeld>();
  const restorePrepared = new Map<number, { name: string; replaces: boolean; keptAs: string; ended: boolean }>();
  const restoreAsked = new Map<string, string>();
  const restoreDiscarded: number[] = [];
  const restoreNames: (string | null)[] = [];
  // Older copies (Task 8): what the shell lists, the IDs of the newest listing (each listing replaces them all), the folders deleted, the copies another session
  // is pretended to have open, and the sessions this page opened on a copy.
  let olderHeld: FakeOlderCopy[] = [];
  const olderListed = new Map<number, FakeOlderCopy>();
  let nextOlderId = 0;
  const olderDeleted: string[] = [];
  const olderOpenElsewhere = new Set<string>();
  const olderSessions = new Map<number, string>();
  let heldOlderListings: (() => void)[] | undefined;
  let heldOlderOpens: (() => void)[] | undefined;
  let heldOlderDeletes: (() => void)[] | undefined;
  let restoreFound = { name: "My vault", made: "2026-10-02" as string | null, replaces: false, keptAs: "My vault.before-restore" };
  let restoreQuestion: "cloud" | "name" | undefined;
  let restoreCopyRefusal: object | undefined;
  let restoreCommitRefusal: object | undefined;
  /** What the next restore copy answers instead of copying: an unfinished restore's notice (`Confirm` `Recovery`). */
  let restoreRecovery: object | undefined;
  /** The answers the next `retry_restore_recovery` calls give, and the notice `restore_notice` answers since the last of them (`undefined`: what launch kept). */
  const retryAnswers: object[] = [];
  let restoreNoticeNow: object | undefined;
  let nextRestore = 0;
  let heldRestoreChecks: (() => void)[] | undefined;
  let heldRestoreCopies: (() => void)[] | undefined;
  let heldRestoreSwaps: (() => void)[] | undefined;
  let heldRestoreAnswers: (() => void)[] | undefined;
  /** The name the next finished copy's answer gives (the archive prepare actually opened), when it is not the checked one's. */
  let restoreCopyName: string | undefined;
  /** What launch kept of a restore that didn't finish, as `restore_notice` answers it: the last of its notices without their `kind`, or none. */
  const noticeOfLaunch = (): object => {
    const last = [...launchNotices].reverse().find((notice) => (notice as { kind?: unknown }).kind === "restore");
    if (last === undefined) return { state: "none" };
    const plain: Record<string, unknown> = { ...(last as Record<string, unknown>) };
    delete plain.kind;
    return plain;
  };
  /** What a checked pick says (the shell's `RestoreChecked`): where it goes is display text, never sent back. */
  const restoreViewOf = (held: RestoreHeld) => {
    const found = held.checked ?? { ...restoreFound, usual: true };
    return {
      name: found.name,
      made: found.made,
      folder_shown: `${found.usual ? "C:\\Users\\Someone\\Lockbox Vaults" : "D:\\Vaults"}\\${found.name}`,
      usual: found.usual,
      replaces_existing: found.replaces,
    };
  };
  // The shell's job table, for the commands that take a request: operations are numbered from 1 and never reused.
  const running = new Map<number, RunningJob>();
  let nextOperation = 0;
  let heldRetry: (() => void)[] | undefined;
  let heldGetItem: (() => void)[] | undefined;
  let stillOpenAfterRetry = 0;
  let retried = 0;

  /** The slot as an event would describe it. */
  const slotEvent = (made: FakeSlot, changed: boolean) => {
    const read = made.state === "value" && made.text !== null ? readEnvText(made.text.trim()) : undefined;
    return {
      capture_id: made.id,
      state: made.state,
      changed,
      env_keys: read !== undefined && read.rows.length >= 1 && read.bad.length === 0 ? read.rows.length : null,
    };
  };

  /** Empties the slot (its text goes) and sends `gone` with its id. */
  const emptySlot = (): void => {
    if (slot === undefined) return;
    const gone = slot.id;
    slot = undefined;
    emit("lockbox://capture", { capture_id: gone, state: "gone", changed: false, env_keys: null });
  };

  listen.mockImplementation((event: string, handler: (event: { payload: unknown }) => void) => {
    calls.push({ cmd: `listen:${event}`, args: undefined });
    handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    return Promise.resolve(() => undefined);
  });

  const lock = (session: number, reason = "manual"): void => {
    const entry = live.get(session);
    if (entry?.unlocked !== true) return;
    entry.unlocked = false;
    entry.generation += 1;
    // A lock lets go of the values of every paste its vault held.
    for (const [token, held] of envPastes) if (held.session === session) envPastes.delete(token);
    // And of the files picked and not yet added.
    for (const [token, held] of choices) if (held.session === session) choices.delete(token);
    // And of a save's plan, the folder a cloud question parked, and the summary's handle.
    for (const [token, held] of savePlans) if (held.session === session) savePlans.delete(token);
    for (const [token, held] of parkedSaves) if (held.session === session) parkedSaves.delete(token);
    for (const [token, held] of outputs) if (held.session === session) outputs.delete(token);
    emit("lockbox://locked", { session, generation: entry.generation, reason });
    // A lock stops every job of its session, and each says it has ended.
    for (const job of [...running.values()]) {
      if (job.scope.type !== "session" || job.scope.session !== session) continue;
      running.delete(job.operation);
      emit("lockbox://progress", { operation: job.operation, scope: job.scope, kind: job.kind, done: job.done, total: job.total, finished: true });
    }
    // The copy handed to this vault goes with its lock.
    if (slot?.chosen === session) emptySlot();
  };

  /**
   * The shell's lock epoch moves on (Lock all, an idle lock, Windows locking or sleeping, the app closing): `lockbox://lock-epoch` goes out, the backups
   * it held for Test a backup are let go, and every launch-scoped job ends (its command, still out, is refused as `locked` when it answers).
   */
  const bumpEpoch = (reason = "manual"): void => {
    lockEpoch += 1;
    pendingClose = undefined;
    testHeld.clear();
    openHeld.clear();
    // Every lock drops the picks and the questions; a finished copy waits through an idle lock and is ended by every other reason.
    restoreHeld.clear();
    restoreAsked.clear();
    // The checked recovery keys go the same way: a lock epoch of any reason drops them.
    recoveryHeld.clear();
    if (reason !== "idle") for (const copy of restorePrepared.values()) copy.ended = true;
    for (const job of [...running.values()]) {
      if (job.scope.type !== "launch" || (job.pastTheSwap ?? false)) continue;
      running.delete(job.operation);
      emit("lockbox://progress", { operation: job.operation, scope: job.scope, kind: job.kind, done: job.done, total: job.total, finished: true });
    }
    emit("lockbox://lock-epoch", { epoch: lockEpoch, reason });
  };

  /** 5b's button, or a second close while it shows: the flag is kept, `explain: false` is sent, the window hides. */
  const explained = (): void => {
    closeExplained = true;
    explaining = false;
    hidden = true;
    emit("lockbox://notice", { kind: "first_close", explain: false });
  };

  /** The window's close, as the shell does it with nothing running (and after a yes): every vault locks, then 5b or the hide. */
  const closeAsBefore = (): void => {
    for (const session of [...live.keys()]) lock(session);
    emptySlot();
    bumpEpoch();
    if (explaining) {
      explained();
    } else if (closeExplained) {
      hidden = true;
    } else {
      explaining = true;
      emit("lockbox://notice", { kind: "first_close", explain: true });
    }
  };

  const vaultFor = (session: number, generation: number): FakeVault => {
    const entry = live.get(session);
    const vault = sessionVault.get(session);
    if (entry?.unlocked !== true || entry.generation !== generation || vault === undefined) return refuse(LOCKED);
    return vault;
  };

  const tagged = (session: number, generation: number, data: unknown) => ({ session, generation, data });

  /** Reads a `.env`'s text and parks its rows under a token, as `env_read` and `capture_env` do: names, bad lines and clashes come back. */
  const parkPaste = (session: number, generation: number, vault: FakeVault, text: string): unknown => {
    if (new TextEncoder().encode(text).length > MAX_ENV_TEXT) return refuse(ENV_TEXT_TOO_LARGE);
    const { rows, bad } = readEnvText(text);
    if (rows.length > MAX_ENV_KEYS) return refuse(ENV_KEYS_TOO_MANY);
    let token: string | null = null;
    if (rows.length > 0) {
      nextToken += 1;
      token = `env-token-${String(nextToken)}`;
      envPastes.set(token, { session, generation, rows, text });
    }
    const all = vault.items ?? [];
    const places = [...all.filter((item) => item.kind === "collection" && !(item.trashed ?? false)).map((folder) => folder.id), null];
    // Names only: a value never comes back.
    return tagged(session, generation, {
      token,
      rows: rows.map(({ index, name }) => ({ index, name })),
      bad_lines: bad,
      clashes: places.map((place) => ({ collection: place, rows: envClashes(all, rows, place) })),
    });
  };

  /**
   * One write of a command that makes several: runs it, unless `failPartwayNext` armed this command and its writes are used up,
   * when it refuses instead (what was written before stays written).
   */
  const partwayWrites = (cmd: string): ((apply: () => void) => void) => {
    const armed = partway?.cmd === cmd ? partway : undefined;
    if (armed !== undefined) partway = undefined;
    let left = armed?.writes ?? Number.POSITIVE_INFINITY;
    return (apply) => {
      if (armed !== undefined && left <= 0) refuse(armed.error);
      left -= 1;
      apply();
    };
  };

  /** Opens (or opens again) the vault's session and moves its generation on, as an unlock does. */
  const openSession = (vault: FakeVault): [number, Live] => {
    let entry = [...live.entries()].find(([session]) => sessionVault.get(session) === vault);
    if (entry === undefined) {
      nextSession += 1;
      entry = [nextSession, { session: nextSession, generation: 0, unlocked: false }];
      live.set(nextSession, entry[1]);
      sessionVault.set(nextSession, vault);
    }
    const [session, state] = entry;
    state.unlocked = true;
    state.generation += 1;
    // A new unlock starts the session's key state over: no permission, no key made yet.
    keyStates.set(session, { may: false, last: 0 });
    return [session, state];
  };

  /** The session's key state (an unlocked session has one). */
  const keyStateOf = (session: number): { may: boolean; last: number } => {
    const found = keyStates.get(session);
    if (found !== undefined) return found;
    const fresh = { may: false, last: 0 };
    keyStates.set(session, fresh);
    return fresh;
  };

  /** Numbers the key the session has just made: the next in its count, or the one a test asked for. */
  const numberKey = (session: number): number => {
    const state = keyStateOf(session);
    state.last = chosenIssue ?? state.last + 1;
    chosenIssue = undefined;
    return state.last;
  };

  const infoOf = (vault: FakeVault, session: number, generation: number) => ({
    session,
    generation,
    name: vault.name ?? "",
    read_only: vault.readOnly ?? false,
    state: "unlocked",
    kind: vault.kind ?? "vault",
  });

  const makeKey = (vault: FakeVault): string => {
    keysMade += 1;
    const key = chosenKey ?? fakeKey(keysMade);
    chosenKey = undefined;
    keys.set(vault, key);
    issuedKeys.add(key);
    return key;
  };

  /** The recovery key that opens the vault now: the last one made for it, else the one it was given, else `fakeKey(40 + id)`. */
  const recoveryKeyOf = (vault: FakeVault): string => keys.get(vault) ?? vault.recoveryKey ?? fakeKey(40 + vault.id);

  /**
   * The shell's reading of a typed recovery key (`RecoverySecret::parse`), in its order: the text is lowercased and split at white space, commas and
   * dots; list numbers ("3", "3)") are dropped; the first token that is no listed word is `recovery_key_word` with its place among the words kept; any
   * count but 24 is `recovery_key_count`; a key that is no key anyone made (a word swapped for another) is `recovery_key_typo`. Gives the key in its display form.
   */
  const readRecoveryKey = (text: string): string => {
    const tokens = text
      .toLowerCase()
      .split(/[\s,.]+/)
      .filter((token) => token !== "" && !/^\d+\)?$/.test(token));
    const place = tokens.findIndex((token) => !FAKE_WORDS.includes(token));
    if (place >= 0) return refuse({ code: "core", kind: "recovery_key_word", position: place + 1 });
    if (tokens.length !== 24) return refuse({ code: "core", kind: "recovery_key_count", found: tokens.length });
    const key = tokens.join(" ");
    const known =
      Array.from({ length: 64 }, (_, n) => fakeKey(n)).includes(key) || issuedKeys.has(key) || vaults.some((one) => one.recoveryKey === key);
    if (!known) return refuse({ code: "core", kind: "recovery_key_typo" });
    return key;
  };

  /** One token for a held recovery choice: 32 lowercase hex characters, a new one for every check. */
  const recoveryToken = (): string => {
    recoveriesMade += 1;
    return `${(0xec0).toString(16)}${recoveriesMade.toString(16).padStart(29, "0")}`;
  };

  /** What an unlock found and answers (`UnlockView`), for the vault just opened in `session`. */
  const unlockView = (vault: FakeVault, session: number, generation: number, headerMacMismatch: boolean) => ({
    info: infoOf(vault, session, generation),
    used_backup_header: vault.usedBackupHeader ?? false,
    header_mac_mismatch: headerMacMismatch,
    header_repair_failed: false,
    cleanup: {
      partials_removed: 0,
      temps_removed: 0,
      retired_deleted: 0,
      purges_finished: 0,
      orphans_quarantined: vault.leftover ?? 0,
      orphans_restored: 0,
      skipped_damaged: vault.unreadable ?? 0,
      failed: 0,
    },
    cloud: vault.cloud ?? null,
    // Worked out on every answer, as the shell does: a writable vault with the mark, never a read-only copy.
    recovery_unconfirmed: (vault.unconfirmed ?? false) && !(vault.readOnly ?? false),
  });

  /** A lock of all vaults, as Lock all, an idle lock or the app closing do it: every unlocked session locks, then the lock epoch moves on. */
  const lockEveryVault = (): void => {
    for (const session of [...live.keys()]) lock(session);
    bumpEpoch();
  };

  /** A create that goes through: the mark is written first, then the vault is made, listed and unlocked. */
  const created = (name: string, password: string): unknown => {
    if (refuseMark) {
      refuseMark = false;
      return refuse(VAULT_STATE_REFUSED);
    }
    // A cut (`interruptCreateNext`) is used by the create that makes a vault, and only that one.
    const cut = interruptCreate;
    interruptCreate = undefined;
    if (cut === "lock_before_create") {
      lockEveryVault();
      return refuse(LOCKED);
    }
    const vault: FakeVault = {
      id: nextVaultId(),
      name,
      password,
      items: [],
      unconfirmed: true,
    };
    vaults.push(vault);
    // An add in another window lands on the list right after this vault: the next ID is its.
    if (alongside !== undefined) {
      const other = alongside;
      alongside = undefined;
      other.id = nextVaultId();
      vaults.push(other);
    }
    if (cut === "lock_after_create_as_error") {
      // Made and listed, with a key nobody saw, then the lock: no session, and the answer names the vault.
      makeKey(vault);
      lockEveryVault();
      return refuse({ code: "locked_after_change", what: "vault created", vault: vault.id });
    }
    const [session, state] = openSession(vault);
    // A new vault's session may make its key again without the password (21c's retries) until the key is confirmed.
    keyStateOf(session).may = true;
    const recoveryKey = makeKey(vault);
    const done = {
      Done: tagged(session, state.generation, {
        info: infoOf(vault, session, state.generation),
        recovery_key: recoveryKey,
        issue: numberKey(session),
        vault_id: vault.id,
      }),
    };
    // The lock came after the vault was made and opened: the good answer is from before it, and the bridge drops it as stale.
    if (cut === "lock_after_create") lockEveryVault();
    return done;
  };

  const added = (): unknown => {
    const vault = existing;
    if (vault === undefined) return refuse({ code: "not_found" });
    existing = undefined;
    // The list gives the new row the next ID of its own (as it does a created vault): the one the test offered is overwritten.
    vault.id = nextVaultId();
    vaults.push(vault);
    return { Done: { list: listId, id: vault.id, name: vault.name, available: true, details_damaged: vault.detailsDamaged ?? false } };
  };

  /** The held choice of a pick session, when it is this session's at this generation; otherwise the shell's `choice_expired`. */
  const choiceOf = (token: unknown, session: number, generation: number) => {
    const held = typeof token === "string" ? choices.get(token) : undefined;
    if (held === undefined || held.session !== session || held.generation !== generation) return refuse(CHOICE_EXPIRED);
    return held;
  };

  /**
   * Everything `add_files` decides before the job starts, in the shell's order: the request, the vault, read-only, the choice, where it
   * goes, a file over 256 GiB, and room for the whole batch (an unknown drive never blocks). Only then is the choice used up.
   */
  const startBatch = (args: unknown): Batch => {
    const sent = exactly(args, ["session", "generation", "choice", "into", "request"]) as {
      session: number;
      generation: number;
      choice: unknown;
      into: Batch["into"];
      request: unknown;
    };
    requestOf(sent);
    const vault = vaultFor(sent.session, sent.generation);
    if (vault.readOnly ?? false) return refuse({ code: "read_only" });
    const held = choiceOf(sent.choice, sent.session, sent.generation);
    if (sent.into.type === "folder") {
      const place = sent.into.collection;
      if (place !== null && vault.items?.find((item) => item.id === place && item.kind === "collection") === undefined) return refuse({ code: "core", kind: "not_found" });
    } else {
      const holder = vault.items?.find((item) => item.id === (sent.into as { id: string }).id);
      if (holder === undefined) return refuse({ code: "core", kind: "not_found" });
      if (holder.kind === "collection" || holder.kind === "file") return refuse(CANNOT_HOLD_FILES);
    }
    if (held.files.some((file) => file.size > MAX_FILE)) return refuse({ code: "core", kind: "too_large", what: "file" });
    const total = held.files.reduce((sum, file) => sum + file.size, 0);
    if (freeSpace !== null && total > freeSpace) return refuse({ code: "core", kind: "not_enough_space", needed: total, available: freeSpace });
    choices.delete(sent.choice as string);
    return { session: sent.session, generation: sent.generation, into: sent.into, files: held.files, total };
  };

  /**
   * The batch's end: each file in turn is stored, or named in `failed` when it can't be read, until a stop (`cutAt` bytes done when Cancel
   * was pressed) or a refusal ends it, and every file after that is `not_added`, in the order picked. A file the stop caught part way is
   * `not_added` too: the engine leaves nothing of it.
   */
  const finishBatch = (batch: Batch, cutAt?: number): unknown => {
    const vault = sessionVault.get(batch.session);
    const failed: string[] = [];
    const notAdded: string[] = [];
    let stopped: object | null = null;
    let count = 0;
    let sofar = 0;
    for (const file of batch.files) {
      if (stopped === null && cutAt !== undefined && sofar + file.size > cutAt) stopped = { code: "cancelled" };
      if (stopped === null && batchEnd !== undefined && count >= batchEnd.count) {
        stopped = batchEnd.refusal;
        batchEnd = undefined;
      }
      if (stopped !== null) {
        notAdded.push(file.name);
        continue;
      }
      if (unreadable.includes(file.name)) {
        failed.push(file.name);
        continue;
      }
      sofar += file.size;
      count += 1;
      nextItem += 1;
      const stored = { file_id: itemId(nextItem), name: file.name, length: file.size, media_type: "application/octet-stream" };
      if (batch.into.type === "folder") {
        const made: FakeItem = {
          id: itemId(nextItem + 0x100),
          kind: "file",
          title: file.name,
          collection: batch.into.collection,
          attachments: [stored],
          modified_at: nowText(),
        };
        if (vault !== undefined) vault.items = [...(vault.items ?? []), made];
      } else {
        const id = batch.into.id;
        const holder = vault?.items?.find((item) => item.id === id);
        if (holder !== undefined) {
          holder.attachments = [...(holder.attachments ?? []), stored];
          bump(holder);
        }
      }
      addedFiles.push(file.name);
    }
    // A batch that stored anything is one operation of the vault's, so it counts once; one stopped before its first file counts for nothing.
    if (count > 0) fileOps.push(batch.into.type === "folder" ? { cmd: "add_files", collection: batch.into.collection } : { cmd: "add_files", id: batch.into.id });
    return { added: count, failed, not_added: notAdded, stopped };
  };

  /** The next pick: what `pickFilesNext` queued, else the one file `pickNext` names, else a made-up one. */
  const nextPick = (): PickedEntry[] => {
    const queued = nextPicks.shift();
    if (queued !== undefined) return queued;
    const one = pickedFile ?? { name: "picked-file.pdf", length: 2048 };
    pickedFile = undefined;
    return [{ name: one.name, size: one.length }];
  };

  /** Every stored file of every live item filed in the folder (a file item's own file and every attachment), in the vault's order. */
  const filesOfFolder = (vault: FakeVault, folder: string): PlannedEntry[] =>
    (vault.items ?? [])
      .filter((item) => item.kind !== "collection" && !(item.trashed ?? false) && item.collection === folder)
      .flatMap((item) =>
        (item.attachments ?? []).map((file) => ({
          itemId: item.id,
          fileId: file.file_id,
          stored: file.name,
          name: saveNameOf(file.name),
          size: file.length,
          attached_to: item.kind === "file" ? null : item.title,
        })),
      );

  /** The checks both steps make, in the shell's order: a folder with no files, then room for the whole batch (an unknown drive never blocks). */
  const checkSave = (files: PlannedEntry[]): number => {
    if (files.length === 0) return refuse({ code: "invalid_input", what: "no files" });
    const total = files.reduce((sum, file) => sum + file.size, 0);
    if (freeSpace !== null && total > freeSpace) return refuse({ code: "core", kind: "not_enough_space", needed: total, available: freeSpace });
    return total;
  };

  /** The plan `save_all_files` and its cloud yes answer: the choice is held until the start takes it. */
  const planSave = (session: number, generation: number, vault: FakeVault, folder: string): unknown => {
    const files = filesOfFolder(vault, folder);
    const total = checkSave(files);
    nextToken += 1;
    const choice = nextToken.toString(16).padStart(32, "0");
    savePlans.set(choice, { session, generation, folder, files, total });
    if (changeAfterPlan) {
      changeAfterPlan = false;
      nextItem += 1;
      const late = { file_id: itemId(nextItem), name: "late-arrival-demo.pdf", length: 2048, media_type: "application/pdf" };
      vault.items = [...(vault.items ?? []), { id: itemId(nextItem + 0x100), kind: "file", title: late.name, collection: folder, attachments: [late], modified_at: nowText() }];
    }
    return tagged(session, generation, {
      Done: { choice, folder_shown: SAVE_ALL_FOLDER, files: files.map(({ name, size, attached_to }) => ({ name, size, attached_to })), total },
    });
  };

  /** Everything `save_all_start` decides before its job starts, in the shell's order; only then is the choice used up. */
  const startSave = (args: unknown): SaveRun => {
    const sent = exactly(args, ["choice", "request"]);
    requestOf(sent);
    const run = typeof sent.choice === "string" ? savePlans.get(sent.choice) : undefined;
    if (run === undefined) return refuse(CHOICE_EXPIRED);
    const vault = vaultFor(run.session, run.generation);
    const now = filesOfFolder(vault, run.folder);
    // The files must still be exactly the planned ones (the checks run again at the start).
    if (now.length !== run.files.length || now.some((file, at) => file.fileId !== run.files[at]?.fileId)) {
      return refuse({ code: "invalid_input", what: "folder changed" });
    }
    checkSave(now);
    savePlans.delete(sent.choice as string);
    return run;
  };

  /**
   * The save's end: each file in turn is written under a free name (the name rule, then " (2)", " (3)" for one that is taken), left out as damaged
   * or gone, and the batch goes on; a stop (`cutAt` bytes done when Stop was pressed) or a refusal ends it at the file being written, which leaves
   * nothing, and every file after it was not started.
   */
  const finishSave = (run: SaveRun, cutAt?: number): unknown => {
    const vault = sessionVault.get(run.session);
    const saved: { name: string; size: number; attached_to: string | null }[] = [];
    const renamed: { from: string; to: string }[] = [];
    const damaged: string[] = [];
    const gone: string[] = [];
    const notStarted: string[] = [];
    let unfinished: string | null = null;
    let stopped: object | null = null;
    let sofar = 0;
    const used = new Set(takenNames);
    for (const file of run.files) {
      if (stopped === null && cutAt !== undefined && sofar + file.size > cutAt) {
        stopped = { code: "cancelled" };
        unfinished = file.name;
        continue;
      }
      if (stopped === null && batchEnd !== undefined && saved.length >= batchEnd.count) {
        stopped = batchEnd.refusal;
        batchEnd = undefined;
        unfinished = file.name;
        continue;
      }
      if (stopped !== null) {
        notStarted.push(file.name);
        continue;
      }
      const holder = vault?.items?.find((item) => item.id === file.itemId && !(item.trashed ?? false));
      if (holder?.attachments?.some((stored) => stored.file_id === file.fileId) !== true || goneNames.includes(file.stored)) {
        gone.push(file.name);
        continue;
      }
      if ((vault?.damagedFiles ?? []).includes(file.fileId)) {
        damaged.push(file.name);
        continue;
      }
      let disk = file.name;
      for (let number = 2; used.has(disk); number += 1) disk = numberedName(file.name, number);
      used.add(disk);
      sofar += file.size;
      saved.push({ name: disk, size: file.size, attached_to: file.attached_to });
      savedToDisk.push(disk);
      if (disk !== file.stored) renamed.push({ from: file.stored, to: disk });
    }
    takenNames = [];
    goneNames = [];
    nextToken += 1;
    const output = nextToken.toString(16).padStart(32, "0");
    outputs.set(output, { session: run.session, generation: run.generation, shown: SAVE_ALL_FOLDER });
    if (saved.length > 0) fileOps.push({ cmd: "save_all_files", collection: run.folder });
    return { saved, renamed, damaged, gone, unfinished, not_started: notStarted, stopped, folder_shown: SAVE_ALL_FOLDER, output };
  };

  const answer = (cmd: string, args: unknown): unknown => {
    switch (cmd) {
      case "list_vaults":
        exactly(args ?? {}, []);
        if (listDamaged) return refuse(VAULT_LIST_DAMAGED);
        return vaults.map((v) => ({ list: listId, id: v.id, name: v.name, available: v.available ?? true, details_damaged: v.detailsDamaged ?? false }));
      case "start_new_vault_list":
        exactly(args ?? {}, []);
        // Only a damaged list is started over: a good one is refused and left as it is.
        if (!listDamaged) return refuse({ code: "invalid_input", what: "vault list" });
        // The damaged file is set aside and a new, empty list is made: no vault is on it until each is added back. It has its own identity, and IDs start again at 1.
        listDamaged = false;
        listId += 1;
        lastId = 0;
        vaults.splice(0);
        if (failAfterMove !== undefined) {
          const failure = failAfterMove;
          failAfterMove = undefined;
          return refuse(failure);
        }
        return null;
      case "get_settings":
        exactly(args ?? {}, []);
        return { ...settings, shortcut: { ...settings.shortcut } };
      case "set_settings": {
        // The whole settings, flat, as the shell reads them: a missing or an extra field is malformed.
        const raw = exactly(args, SETTINGS_FIELDS);
        const wholeNumber = (value: unknown, low: number, high: number) => Number.isInteger(value) && (value as number) >= low && (value as number) <= high;
        const shape: unknown = raw.shortcut;
        if (
          typeof shape !== "object" ||
          shape === null ||
          Object.keys(shape).sort().join() !== "alt,ctrl,key,shift" ||
          typeof raw.capture_protected !== "boolean" ||
          typeof raw.theme !== "string" ||
          !["system", "light", "dark"].includes(raw.theme)
        ) {
          return refuse(MALFORMED);
        }
        const sent = raw as unknown as FakeSettings;
        const { shortcut } = sent;
        if (!wholeNumber(sent.idle_minutes, 1, 60)) return refuse({ code: "invalid_input", what: "idle time" });
        if (!wholeNumber(sent.clipboard_seconds, 10, 300)) return refuse({ code: "invalid_input", what: "clipboard delay" });
        if (!shortcutAllowed(shortcut)) return refuse(SHORTCUT_REFUSED);
        settings = { ...sent, shortcut: { ...shortcut } };
        saved.push(settings);
        return null;
      }
      case "get_startup":
        exactly(args ?? {}, []);
        return { ...startup };
      case "set_startup": {
        const { on } = exactly(args, ["on"]);
        if (typeof on !== "boolean") return refuse(MALFORMED);
        // Windows' own switch is left as it is: writing the entry again does not turn it back on there.
        startup = { ...startup, on };
        // The write went through but reading it back failed: one fixed refusal, whichever half failed (`startup_failure_is_one_fixed_refusal`).
        if (readbackFails) {
          readbackFails = false;
          return refuse(STARTUP_FAILED);
        }
        return { ...startup };
      }
      case "app_info":
        exactly(args ?? {}, []);
        return { version: "1.2.3" };
      case "open_help":
        // The shell takes no input at all: any field is a malformed request, and nothing is opened.
        // The body is checked as sent: `null` is no `{}` (the real command refuses it too), so a call without one counts no launch.
        exactly(args, []);
        helpCount += 1;
        if (helpFails) {
          helpFails = false;
          return refuse({ code: "core", kind: "io", what: "guide" });
        }
        return null;
      case "unlock_vault": {
        const { vault: row, password } = exactly(args, ["vault", "password"]);
        const vault = vaultRefOf(row);
        if (password !== (vault.password ?? PASSWORD)) return refuse(WRONG_PASSWORD);
        if (vault.newer ?? false) return refuse(NEWER_VAULT);
        const [session, state] = openSession(vault);
        // A writable unlock that enters 21f from a mark read without error may make a key without the password; a mark the shell
        // could not read shows 21f all the same, and grants nothing.
        keyStateOf(session).may = (vault.unconfirmed ?? false) && !(vault.markUnreadable ?? false) && !(vault.readOnly ?? false);
        return tagged(session, state.generation, unlockView(vault, session, state.generation, vault.headerChanged ?? false));
      }
      case "recover_check": {
        const sent = exactly(args, ["vault", "recovery_key"]);
        if (typeof sent.recovery_key !== "string") return refuse(MALFORMED);
        const vault = vaultRefOf(sent.vault);
        // A vault that is open has no need of its recovery key here.
        if ([...live.entries()].some(([session, entry]) => entry.unlocked && sessionVault.get(session) === vault)) {
          return refuse({ code: "invalid_input", what: "vault is unlocked" });
        }
        // The key is read first (no derivation is spent on a typo), then tried against this vault's recovery slot alone.
        const key = readRecoveryKey(sent.recovery_key);
        if (key !== recoveryKeyOf(vault)) return refuse(WRONG_PASSWORD);
        const choice = recoveryToken();
        recoveryHeld.set(choice, { vault, key, headerChanged: vault.headerChanged ?? false });
        return { kind: (vault.headerChanged ?? false) ? "header_changed" : "checked", choice, vault_name: vault.name ?? "" };
      }
      case "recover_finish": {
        const sent = exactly(args, ["choice", "new_password", "accept_changed_header"]);
        if (typeof sent.choice !== "string" || typeof sent.new_password !== "string" || typeof sent.accept_changed_header !== "boolean") return refuse(MALFORMED);
        // The new password's length first, before anything is looked up: the choice is kept.
        if (Array.from(sent.new_password.normalize("NFC")).length < 12) return refuse({ code: "core", kind: "password_too_short", min: 12 });
        const held = recoveryHeld.get(sent.choice);
        if (held === undefined) return refuse(CHOICE_EXPIRED);
        // The changed details are accepted by a yes, never by a silence: refused, with the choice kept.
        if (held.headerChanged && !sent.accept_changed_header) return refuse({ code: "invalid_input", what: "header changed on disk" });
        // From here the choice is used up, whatever comes.
        recoveryHeld.delete(sent.choice);
        const { vault } = held;
        if ([...live.entries()].some(([session, entry]) => entry.unlocked && sessionVault.get(session) === vault)) {
          return refuse({ code: "invalid_input", what: "vault is unlocked" });
        }
        // The key must still open it and the details be as they were checked: otherwise it is checked again.
        if (recoveryKeyOf(vault) !== held.key || (vault.headerChanged ?? false) !== held.headerChanged) return refuse(CHOICE_EXPIRED);
        const cut = interruptRecover;
        interruptRecover = undefined;
        if (cut === "lock_before_write") {
          bumpEpoch();
          return refuse(LOCKED);
        }
        vault.password = sent.new_password;
        if (held.headerChanged) vault.headerChanged = false;
        const [session, state] = openSession(vault);
        keyStateOf(session).may = (vault.unconfirmed ?? false) && !(vault.markUnreadable ?? false) && !(vault.readOnly ?? false);
        const before = state.generation;
        if (cut === "lock_after_write") {
          lock(session);
          return { Done: tagged(session, before, unlockView(vault, session, before, false)) };
        }
        if (cut === "lock_after_write_as_error") {
          lock(session);
          return refuse({ code: "locked_after_change", what: "password", vault: vault.id });
        }
        return { Done: tagged(session, before, unlockView(vault, session, before, false)) };
      }
      case "recover_forget": {
        const sent = exactly(args, ["choice"]);
        if (typeof sent.choice !== "string") return refuse(MALFORMED);
        recoveryHeld.delete(sent.choice);
        return null;
      }
      case "create_vault": {
        const { name, password, choose_folder } = exactly(args, ["name", "password", "choose_folder"]) as {
          name: string;
          password: string;
          choose_folder: boolean;
        };
        if (Array.from(password.normalize("NFC")).length < 12) return refuse({ code: "core", kind: "password_too_short", min: 12 });
        if (choose_folder && dismissPicker) {
          dismissPicker = false;
          return "Dismissed";
        }
        if (cloud !== null) {
          const provider = cloud;
          cloud = null;
          nextToken += 1;
          const token = `create-token-${String(nextToken)}`;
          pendingCreates.set(token, { name, password });
          return { Confirm: { CloudFolder: { token, provider } } };
        }
        return created(name, password);
      }
      case "create_vault_confirm": {
        const { token } = exactly(args, ["token"]) as { token: string };
        const pending = pendingCreates.get(token);
        if (pending === undefined) return refuse({ code: "not_found" });
        pendingCreates.delete(token);
        return created(pending.name, pending.password);
      }
      case "add_existing_vault": {
        exactly(args ?? {}, []);
        if (dismissPicker) {
          dismissPicker = false;
          return "Dismissed";
        }
        if (existing === undefined) return refuse({ code: "invalid_input", what: "not a vault folder" });
        if (cloud !== null) {
          const provider = cloud;
          cloud = null;
          nextToken += 1;
          const token = `add-token-${String(nextToken)}`;
          pendingAdds.add(token);
          return { Confirm: { CloudFolder: { token, provider } } };
        }
        return added();
      }
      case "add_existing_vault_confirm": {
        const { token } = exactly(args, ["token"]) as { token: string };
        if (!pendingAdds.delete(token)) return refuse({ code: "not_found" });
        return added();
      }
      case "regenerate_recovery": {
        const { session, generation } = exactly(args, ["session", "generation"]) as { session: number; generation: number };
        const vault = vaultFor(session, generation);
        if (vault.readOnly ?? false) return refuse({ code: "read_only" });
        // Without the password only a session that entered 21f may: any other asks through `new_recovery_key`.
        if (!keyStateOf(session).may) return refuse(NO_KEY_PERMISSION);
        // The engine writes no header while a changed one waits for the person's yes.
        if (vault.headerChanged ?? false) return refuse(ACCEPT_FIRST);
        // The mark goes first; when it can't be written no key is made.
        if (refuseMark) {
          refuseMark = false;
          return refuse(VAULT_STATE_REFUSED);
        }
        vault.unconfirmed = true;
        const words = makeKey(vault);
        return tagged(session, generation, { words, issue: numberKey(session) });
      }
      case "new_recovery_key": {
        const { session, generation, current_password } = exactly(args, ["session", "generation", "current_password"]) as {
          session: number;
          generation: number;
          current_password: string;
        };
        const vault = vaultFor(session, generation);
        if (vault.readOnly ?? false) return refuse({ code: "read_only" });
        // The current password is checked first: a wrong one writes no mark and makes no key.
        if (current_password !== (vault.password ?? PASSWORD)) return refuse(WRONG_PASSWORD);
        if (refuseMark) {
          refuseMark = false;
          return refuse(VAULT_STATE_REFUSED);
        }
        if (vault.headerChanged ?? false) return refuse(ACCEPT_FIRST);
        vault.unconfirmed = true;
        const words = makeKey(vault);
        return tagged(session, generation, { words, issue: numberKey(session) });
      }
      case "change_password": {
        const { session, generation, current_password, new_password } = exactly(args, [
          "session",
          "generation",
          "current_password",
          "new_password",
        ]) as { session: number; generation: number; current_password: string; new_password: string };
        const vault = vaultFor(session, generation);
        if (vault.readOnly ?? false) return refuse({ code: "read_only" });
        // The new password's length first, then the current password; a wrong current one changes nothing.
        if (Array.from(new_password.normalize("NFC")).length < 12) return refuse({ code: "core", kind: "password_too_short", min: 12 });
        if (current_password !== (vault.password ?? PASSWORD)) return refuse(WRONG_PASSWORD);
        if (vault.headerChanged ?? false) return refuse(ACCEPT_FIRST);
        // A lock that cuts the change short: before the headers are written nothing changes; after, the change stays.
        const cut = interruptChange;
        interruptChange = undefined;
        if (cut === "lock_before_write") {
          lock(session);
          return refuse(LOCKED);
        }
        if (typeof cut === "object") return refuse(cut.refused_before_write);
        vault.password = new_password;
        if (cut === "lock_after_write") {
          lock(session);
          return tagged(session, generation, null);
        }
        if (cut === "lock_after_write_as_error") {
          lock(session);
          return refuse({ code: "locked_after_change", what: "password", vault: vault.id });
        }
        return tagged(session, generation, null);
      }
      case "accept_header": {
        const { session, generation } = exactly(args, ["session", "generation"]) as { session: number; generation: number };
        const vault = vaultFor(session, generation);
        if (vault.readOnly ?? false) return refuse({ code: "read_only" });
        vault.headerChanged = false;
        return tagged(session, generation, null);
      }
      case "rename_vault": {
        const sent = exactly(args, ["session", "generation", "name"]);
        const { session, generation, name } = sent;
        if (typeof session !== "number" || typeof generation !== "number" || typeof name !== "string") return refuse(MALFORMED);
        const vault = vaultFor(session, generation);
        if (vault.readOnly ?? false) return refuse({ code: "read_only" });
        // The engine's own check of the name first (`validate_name`: nothing but spaces, or over 200 characters), then the backup's refusals.
        if (name.trim() === "" || Array.from(name).length > 200) return refuse(VAULT_NAME_REFUSED);
        if (vault.headerChanged ?? false) return refuse(DETAILS_CHANGED);
        // A lock that cuts the rename short: before the headers are written nothing changes; after, the new name stays.
        const cut = interruptRename;
        interruptRename = undefined;
        if (cut === "lock_before_write") {
          lock(session);
          return refuse(LOCKED);
        }
        vault.name = name;
        if (cut === "lock_after_write") {
          lock(session);
          return tagged(session, generation, null);
        }
        if (cut === "lock_after_write_as_error") {
          lock(session);
          return refuse({ code: "locked_after_change", what: "vault name", vault: vault.id });
        }
        return tagged(session, generation, null);
      }
      case "launch_notices":
        exactly(args ?? {}, []);
        return [...launchNotices];
      case "reset_output_journal":
        exactly(args ?? {}, []);
        outputResets += 1;
        return null;
      case "recovery_confirmed": {
        const { session, generation, issue } = exactly(args, ["session", "generation", "issue"]) as {
          session: number;
          generation: number;
          issue: number;
        };
        const vault = vaultFor(session, generation);
        if (vault.readOnly ?? false) return refuse({ code: "read_only" });
        // Only the latest key's confirmation clears the mark and ends 21f's permission; an older one changes nothing.
        const state = keyStateOf(session);
        if (issue === 0 || issue !== state.last) return tagged(session, generation, "Superseded");
        vault.unconfirmed = false;
        state.may = false;
        return tagged(session, generation, "Confirmed");
      }
      case "save_recovery_pdf": {
        const { session, generation } = exactly(args, ["session", "generation"]) as { session: number; generation: number };
        const vault = vaultFor(session, generation);
        if (vault.readOnly ?? false) return refuse({ code: "read_only" });
        if (printRefusal !== undefined) {
          const error = printRefusal;
          printRefusal = undefined;
          return refuse(error);
        }
        if (dismissPdf) {
          dismissPdf = false;
          return tagged(session, generation, "Dismissed");
        }
        if (cloudPdf > 0) {
          cloudPdf -= 1;
          nextToken += 1;
          const token = `pdf-token-${String(nextToken)}`;
          pendingPdfs.set(token, { session, generation, envFolder: null });
          return tagged(session, generation, { Confirm: { CloudFolder: { token, provider: "Other" } } });
        }
        pdfs.push(SAVED_FOLDER);
        return tagged(session, generation, { Done: { folder: SAVED_FOLDER } });
      }
      case "save_readable_confirm": {
        const { token } = exactly(args, ["token"]) as { token: string };
        const parked = pendingPdfs.get(token);
        if (parked === undefined) return refuse({ code: "not_found" });
        pendingPdfs.delete(token);
        const vault = vaultFor(parked.session, parked.generation);
        // An export's yes builds and writes the CSV now, with the summary beside the folder.
        if (parked.exported ?? false) return tagged(parked.session, parked.generation, writeExport(parked.session, parked.generation, vault));
        if (parked.envFolder === null) pdfs.push(SAVED_FOLDER);
        else envFiles.push(parked.envFolder);
        return tagged(parked.session, parked.generation, { Done: { folder: SAVED_FOLDER } });
      }
      case "export_csv": {
        const sent = exactly(args, ["session", "generation", "password"]) as { session: number; generation: number; password: unknown };
        const vault = vaultFor(sent.session, sent.generation);
        if (typeof sent.password !== "string") return refuse(MALFORMED);
        if (vault.readOnly ?? false) return refuse({ code: "read_only" });
        // The password is checked in this call, before any dialog: a wrong one opens nothing and writes nothing.
        if (sent.password !== (vault.password ?? PASSWORD)) return refuse(WRONG_PASSWORD);
        return exportDialog(sent.session, sent.generation, vault);
      }
      case "export_repick": {
        const { token } = exactly(args, ["token"]) as { token: string };
        const parked = pendingPdfs.get(token);
        // Only an export's question is Pick another folder's to answer; the choice is used up either way.
        if (parked === undefined || !(parked.exported ?? false)) {
          pendingPdfs.delete(token);
          return refuse({ code: "not_found" });
        }
        pendingPdfs.delete(token);
        const vault = vaultFor(parked.session, parked.generation);
        return exportDialog(parked.session, parked.generation, vault);
      }
      case "env_read": {
        const sent = exactly(args, ["session", "generation", "text"]) as { session: number; generation: number; text: unknown };
        const vault = vaultFor(sent.session, sent.generation);
        if (typeof sent.text !== "string") return refuse(MALFORMED);
        if (vault.readOnly ?? false) return refuse({ code: "read_only" });
        return parkPaste(sent.session, sent.generation, vault, sent.text);
      }
      case "capture_state":
        exactly(args ?? {}, []);
        return slot === undefined ? null : slotEvent(slot, false);
      case "capture_choose": {
        const sent = exactly(args, ["session", "generation", "capture_id"]) as { session: number; generation: number; capture_id: string };
        const vault = vaultFor(sent.session, sent.generation);
        // A read-only vault can't take a key: it is never a choice.
        if (vault.readOnly ?? false) return refuse({ code: "read_only" });
        if (slot?.id !== sent.capture_id) return refuse({ code: "not_found" });
        slot.chosen = sent.session;
        slot.chosenGeneration = sent.generation;
        return tagged(sent.session, sent.generation, null);
      }
      case "capture_unchoose": {
        const sent = exactly(args, ["capture_id"]) as { capture_id: string };
        if (slot?.id !== sent.capture_id) return refuse({ code: "not_found" });
        slot.chosen = null;
        slot.chosenGeneration = null;
        return null;
      }
      case "capture_reveal": {
        const sent = exactly(args, ["capture_id"]) as { capture_id: string };
        if (slot?.id !== sent.capture_id || slot.text === null || slot.state !== "value") return refuse({ code: "not_found" });
        const chosen = slot.chosen === null ? undefined : live.get(slot.chosen);
        if (chosen?.unlocked !== true || chosen.generation !== slot.chosenGeneration) return refuse(LOCKED);
        captureRevealed += 1;
        // The value saved and shown is the text with its surrounding spaces and line breaks dropped.
        return slot.text.trim();
      }
      case "capture_cancel": {
        const sent = exactly(args, ["capture_id"]) as { capture_id: string };
        if (slot?.id === sent.capture_id) emptySlot();
        return null;
      }
      case "capture_env": {
        const sent = exactly(args, ["session", "generation", "capture_id"]) as { session: number; generation: number; capture_id: string };
        const vault = vaultFor(sent.session, sent.generation);
        if (vault.readOnly ?? false) return refuse({ code: "read_only" });
        if (slot?.id !== sent.capture_id || slot.text === null || slot.state !== "value") return refuse({ code: "not_found" });
        const rows = parkPaste(sent.session, sent.generation, vault, slot.text);
        // The text moves into the paste: the slot is empty.
        emptySlot();
        return rows;
      }
      case "capture_save": {
        const sent = exactly(args, ["session", "generation", "capture_id", "name", "collection", "on_clash", "clear_clipboard", "typed"]) as {
          session: number;
          generation: number;
          capture_id: string;
          name: unknown;
          collection: unknown;
          on_clash: unknown;
          clear_clipboard: unknown;
          typed: unknown;
        };
        const vault = vaultFor(sent.session, sent.generation);
        if (vault.readOnly ?? false) return refuse({ code: "read_only" });
        if (slot?.id !== sent.capture_id) return refuse({ code: "not_found" });
        // Only into the vault the copy is handed to, at the generation it was handed to.
        if (slot.chosen !== sent.session || slot.chosenGeneration !== sent.generation) return refuse(CAPTURE_VAULT);
        const name = sent.name;
        const place = sent.collection;
        const onClash = sent.on_clash;
        const keepBoth =
          typeof onClash === "object" && onClash !== null && Object.keys(onClash).join() === "keep_both" && typeof (onClash as { keep_both?: unknown }).keep_both === "string"
            ? (onClash as { keep_both: string }).keep_both
            : null;
        if (
          typeof name !== "string" ||
          (place !== null && typeof place !== "string") ||
          typeof sent.clear_clipboard !== "boolean" ||
          (sent.typed !== null && typeof sent.typed !== "string") ||
          (onClash !== "ask" && onClash !== "replace" && keepBoth === null)
        ) {
          return refuse(MALFORMED);
        }
        // The name is a key's title, checked as `new_item` checks it.
        if (new TextEncoder().encode(name).length > MAX_TITLE) return refuse({ code: "too_large", what: "title" });
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return refuse(BAD_KEY_NAME);
        const all = vault.items ?? [];
        if (place !== null && !all.some((item) => item.id === place && item.kind === "collection" && !(item.trashed ?? false))) {
          return refuse({ code: "not_found" });
        }
        // What is saved: the capture's own text, trimmed, or what was typed when nothing was captured.
        let value: string;
        if (slot.state === "value") {
          if (sent.typed !== null) return refuse(CAPTURE_VALUE_NEEDED);
          value = (slot.text ?? "").trim();
        } else {
          if (typeof sent.typed !== "string" || sent.typed.trim() === "") return refuse(CAPTURE_VALUE_NEEDED);
          value = sent.typed.trim();
        }
        if (new TextEncoder().encode(value).length > MAX_KEY_VALUE) return refuse({ code: "too_large", what: "value" });
        const there = liveKeys(all, place).filter((item) => item.title === name);
        let saveAs = name;
        let replacing: FakeItem | undefined;
        if (there.length > 0) {
          const given = freeName(all, place, name);
          if (onClash === "ask") return tagged(sent.session, sent.generation, { Clash: { saved_as: given } });
          if (onClash === "replace") {
            if (there.length >= 2) return refuse(ENV_TWICE);
            replacing = there[0];
          } else if (keepBoth !== given) {
            // The name the person saw is not the one the rule gives now: nothing is written.
            return tagged(sent.session, sent.generation, { Clash: { saved_as: given } });
          } else {
            saveAs = given;
          }
        }
        let id: string;
        if (replacing === undefined) {
          nextItem += 1;
          id = itemId(nextItem);
          vault.items = [...all, { id, kind: "key", title: saveAs, value, collection: place, notes: "", modified_at: nowText() }];
        } else {
          id = replacing.id;
          replacing.value = value;
          bump(replacing);
        }
        // Only after the write: the clipboard is cleared if it still holds what was copied; then the slot empties.
        let clipboard: "cleared" | "not_ours" | "failed" | "not_asked" = "not_asked";
        if (sent.clear_clipboard && slot.state === "value") {
          if (clipboardText !== slot.text) clipboard = "not_ours";
          else if (failClear) {
            failClear = false;
            clipboard = "failed";
          } else {
            clipboardText = null;
            clipboard = "cleared";
          }
        }
        emptySlot();
        return tagged(sent.session, sent.generation, { Saved: { id, name: saveAs, clipboard } });
      }
      case "env_save": {
        const sent = exactly(args, ["session", "generation", "token", "choices", "collection", "clear_clipboard"]) as {
          session: number;
          generation: number;
          token: unknown;
          choices: unknown;
          collection: unknown;
          clear_clipboard: unknown;
        };
        if (typeof sent.clear_clipboard !== "boolean") return refuse(MALFORMED);
        const vault = vaultFor(sent.session, sent.generation);
        if (vault.readOnly ?? false) return refuse({ code: "read_only" });
        if (typeof sent.token !== "string" || !Array.isArray(sent.choices) || (sent.collection !== null && typeof sent.collection !== "string")) {
          return refuse(MALFORMED);
        }
        const held = envPastes.get(sent.token);
        // Used up whatever the answer is.
        envPastes.delete(sent.token);
        if (held?.session !== sent.session || held.generation !== sent.generation) return refuse({ code: "not_found" });
        const choices = (sent.choices as { index?: unknown; action?: unknown }[]).map((choice) => {
          const known = ["save", "replace", "keep_both", "leave_out"];
          if (typeof choice.index !== "number" || typeof choice.action !== "string" || !known.includes(choice.action)) return refuse(MALFORMED);
          return { index: choice.index, action: choice.action };
        });
        const all = vault.items ?? [];
        const place = sent.collection;
        if (place !== null && !all.some((item) => item.id === place && item.kind === "collection" && !(item.trashed ?? false))) {
          return refuse({ code: "core", kind: "invalid_input", what: "collection" });
        }
        // Every row named once, and no other; then what each choice may be, by the folder as it is now.
        const named = choices.map((choice) => choice.index).sort((a, b) => a - b);
        if (named.length !== held.rows.length || named.some((index, at) => index !== at)) return refuse(ENV_ROWS_CHANGED);
        const clashes = envClashes(all, held.rows, place);
        for (const choice of choices) {
          const clashing = clashes.some((clash) => clash.index === choice.index);
          if (choice.action === "save" && clashing) return refuse(ENV_ROWS_CHANGED);
          if (choice.action === "keep_both" && !clashing) return refuse(ENV_ROWS_CHANGED);
          const name = held.rows[choice.index]?.name;
          if (choice.action === "replace" && liveKeys(all, place).filter((item) => item.title === name).length >= 2) return refuse(ENV_TWICE);
        }
        let written = 0;
        const make = (title: string, value: string) => {
          nextItem += 1;
          vault.items = [...(vault.items ?? []), { id: itemId(nextItem), kind: "key", title, value, collection: place, notes: "", modified_at: nowText() }];
        };
        for (const choice of [...choices].sort((a, b) => a.index - b.index)) {
          const row = held.rows[choice.index];
          if (row === undefined || choice.action === "leave_out") continue;
          if (choice.action === "save") make(row.name, row.value);
          else if (choice.action === "keep_both") make(clashes.find((clash) => clash.index === row.index)?.saved_as ?? row.name, row.value);
          else {
            const there = liveKeys(vault.items ?? [], place).find((item) => item.title === row.name);
            if (there === undefined) make(row.name, row.value);
            else {
              there.value = row.value;
              bump(there);
            }
          }
          written += 1;
        }
        // The clear runs only when asked, after at least one key was written, and only when the clipboard still holds the pasted text
        // (line endings read alike on both sides).
        let clipboard: "cleared" | "not_ours" | "failed" | "not_asked" = "not_asked";
        if (sent.clear_clipboard && written > 0) {
          if (clipboardText === null || linesOf(clipboardText) !== linesOf(held.text)) clipboard = "not_ours";
          else if (failClear) {
            failClear = false;
            clipboard = "failed";
          } else {
            clipboardText = null;
            clipboard = "cleared";
          }
        }
        return tagged(sent.session, sent.generation, { saved: written, clipboard });
      }
      case "env_copy":
      case "env_save_file": {
        const sent = exactly(args, ["session", "generation", "collection"]) as { session: number; generation: number; collection: unknown };
        const vault = vaultFor(sent.session, sent.generation);
        if (cmd === "env_save_file" && (vault.readOnly ?? false)) return refuse({ code: "read_only" });
        if (typeof sent.collection !== "string") return refuse(MALFORMED);
        const folder = vault.items?.find((item) => item.id === sent.collection && item.kind === "collection" && !(item.trashed ?? false));
        if (folder === undefined) return refuse({ code: "not_found" });
        // The folder's live keys by name, in byte order; two with one name stop it with nothing copied or written.
        const keysHere = liveKeys(vault.items ?? [], folder.id).sort((a, b) => (a.title < b.title ? -1 : a.title > b.title ? 1 : 0));
        if (keysHere.length === 0) return refuse(NO_KEYS);
        const twice = keysHere.find((key, at) => at > 0 && keysHere[at - 1]?.title === key.title);
        if (twice !== undefined) return tagged(sent.session, sent.generation, { Duplicate: { name: twice.title } });
        if (cmd === "env_copy") {
          envCopied.push(folder.id);
          // The text is made and put on the clipboard in Rust: here it waits in the fake's clipboard, for a test to read.
          clipboardText = writeEnvText(keysHere);
          return tagged(sent.session, sent.generation, "Done");
        }
        if (dismissPdf) {
          dismissPdf = false;
          return tagged(sent.session, sent.generation, { Saved: "Dismissed" });
        }
        if (cloudPdf > 0) {
          cloudPdf -= 1;
          nextToken += 1;
          const token = `env-file-token-${String(nextToken)}`;
          pendingPdfs.set(token, { session: sent.session, generation: sent.generation, envFolder: folder.id });
          return tagged(sent.session, sent.generation, { Saved: { Confirm: { CloudFolder: { token, provider: "Other" } } } });
        }
        envFiles.push(folder.id);
        return tagged(sent.session, sent.generation, { Saved: { Done: { folder: SAVED_FOLDER } } });
      }
      case "open_file":
      case "save_file_copy": {
        const sent = exactly(
          args,
          cmd === "open_file" ? ["session", "generation", "id", "file_id", "confirmed_executable"] : ["session", "generation", "id", "file_id", "request"],
        ) as {
          session: number;
          generation: number;
          id: string;
          file_id: string;
          confirmed_executable?: boolean;
        };
        if (cmd === "save_file_copy") requestOf(sent);
        const vault = vaultFor(sent.session, sent.generation);
        const holder = vault.items?.find((item) => item.id === sent.id);
        const file = holder?.attachments?.find((stored) => stored.file_id === sent.file_id);
        if (file === undefined) return refuse({ code: "core", kind: "not_found" });
        // A program file asks first, before anything is decrypted.
        if (cmd === "open_file" && PROGRAM_FILE.test(file.name) && sent.confirmed_executable !== true) {
          return tagged(sent.session, sent.generation, { Confirm: "Executable" });
        }
        if (cmd === "save_file_copy" && dismissFile) {
          dismissFile = false;
          return tagged(sent.session, sent.generation, "Dismissed");
        }
        // A cloud-synced folder asks first, before anything is decrypted: the copy waits under a token.
        if (cmd === "save_file_copy" && cloudPdf > 0) {
          cloudPdf -= 1;
          nextToken += 1;
          const token = `copy-token-${String(nextToken)}`;
          pendingPdfs.set(token, { session: sent.session, generation: sent.generation, envFolder: null, copy: { id: sent.id, file_id: sent.file_id } });
          return tagged(sent.session, sent.generation, { Confirm: { CloudFolder: { token, provider: "Other" } } });
        }
        if ((vault.damagedFiles ?? []).includes(sent.file_id)) return refuse(FILE_DAMAGED);
        fileOps.push({ cmd, id: sent.id, file_id: sent.file_id });
        return tagged(sent.session, sent.generation, { Done: null });
      }
      case "save_file_copy_confirm": {
        const sent = exactly(args, ["token", "request"]);
        requestOf(sent);
        const { token } = sent as { token: string };
        const parked = pendingPdfs.get(token);
        if (parked?.copy === undefined) return refuse({ code: "not_found" });
        pendingPdfs.delete(token);
        vaultFor(parked.session, parked.generation);
        fileOps.push({ cmd: "save_file_copy", id: parked.copy.id, file_id: parked.copy.file_id });
        return tagged(parked.session, parked.generation, { Done: null });
      }
      case "add_file":
      case "attach_file":
      case "replace_file": {
        const keys = {
          add_file: ["session", "generation", "collection", "request"],
          attach_file: ["session", "generation", "id", "request"],
          replace_file: ["session", "generation", "id", "file_id"],
        };
        const sent = exactly(args, keys[cmd]) as { session: number; generation: number; collection?: string | null; id?: string; file_id?: string };
        if (cmd !== "replace_file") requestOf(sent);
        const vault = vaultFor(sent.session, sent.generation);
        if (vault.readOnly ?? false) return refuse({ code: "read_only" });
        const holder = cmd === "add_file" ? undefined : vault.items?.find((item) => item.id === sent.id);
        if (cmd !== "add_file") {
          if (holder === undefined) return refuse({ code: "core", kind: "not_found" });
          if (holder.kind === "collection" || (cmd === "attach_file" && holder.kind === "file")) return refuse(CANNOT_HOLD_FILES);
        }
        const old = cmd === "replace_file" ? holder?.attachments?.find((stored) => stored.file_id === sent.file_id) : undefined;
        if (cmd === "replace_file" && old === undefined) return refuse({ code: "core", kind: "not_found" });
        if (dismissFile) {
          dismissFile = false;
          return tagged(sent.session, sent.generation, "Dismissed");
        }
        const picked = pickedFile ?? { name: "picked-file.pdf", length: 2048 };
        pickedFile = undefined;
        nextItem += 1;
        const stored = { file_id: itemId(nextItem), name: picked.name, length: picked.length, media_type: "application/octet-stream" };
        if (cmd === "add_file") {
          const made: FakeItem = { id: itemId(nextItem + 0x100), kind: "file", title: picked.name, collection: sent.collection ?? null, attachments: [stored], modified_at: nowText() };
          vault.items = [...(vault.items ?? []), made];
          fileOps.push({ cmd, collection: sent.collection ?? null });
          return tagged(sent.session, sent.generation, { Done: made.id });
        }
        if (holder === undefined) return refuse({ code: "core", kind: "not_found" });
        holder.attachments = cmd === "replace_file" ? (holder.attachments ?? []).map((was) => (was === old ? stored : was)) : [...(holder.attachments ?? []), stored];
        bump(holder);
        fileOps.push({ cmd, id: sent.id, ...(cmd === "replace_file" ? { file_id: sent.file_id } : {}) });
        return tagged(sent.session, sent.generation, { Done: stored.file_id });
      }
      case "test_backup_pick": {
        const sent = exactly(args, ["choice"]);
        if (sent.choice !== null && typeof sent.choice !== "string") return refuse(MALFORMED);
        // A closed picker: nothing is picked, and the choice that was sent is left as it was.
        if (dismissFile) {
          dismissFile = false;
          return "Dismissed";
        }
        const file = nextBackupPick ?? { name: BACKUP_NAME, size: BACKUP_SIZE };
        nextBackupPick = undefined;
        // A new pick forgets the old one.
        if (typeof sent.choice === "string") testHeld.delete(sent.choice);
        nextToken += 1;
        const token = nextToken.toString(16).padStart(32, "0");
        testHeld.set(token, { ...file, password: BACKUP_PASSWORD });
        return { Done: { choice: token, file_name: file.name, size: file.size } };
      }
      case "forget_test_backup": {
        const sent = exactly(args, ["choice"]);
        if (typeof sent.choice !== "string") return refuse(MALFORMED);
        // Forgetting is idempotent: a token that is unknown or already gone is no error.
        testHeld.delete(sent.choice);
        return null;
      }
      case "open_backup_pick": {
        const sent = exactly(args, ["choice"]);
        if (sent.choice !== null && typeof sent.choice !== "string") return refuse(MALFORMED);
        // A closed picker: nothing is picked, and the choice that was sent is left as it was.
        if (dismissFile) {
          dismissFile = false;
          return "Dismissed";
        }
        const file = nextBackupPick ?? { name: BACKUP_NAME, size: BACKUP_SIZE };
        nextBackupPick = undefined;
        // A new pick forgets the old one.
        if (typeof sent.choice === "string") openHeld.delete(sent.choice);
        nextToken += 1;
        const token = nextToken.toString(16).padStart(32, "0");
        openHeld.set(token, { ...file, password: BACKUP_PASSWORD });
        return { Done: { choice: token, file_name: file.name, size: file.size } };
      }
      case "forget_open_backup": {
        const sent = exactly(args, ["choice"]);
        if (typeof sent.choice !== "string") return refuse(MALFORMED);
        // Idempotent, and only an open's own choices: a test's choice is another kind.
        openHeld.delete(sent.choice);
        return null;
      }
      case "copy_item_to": {
        const sent = exactly(args, ["from", "from_generation", "id", "to", "to_generation", "folder", "skip_missing"]) as {
          from: unknown;
          from_generation: unknown;
          id: unknown;
          to: unknown;
          to_generation: unknown;
          folder: unknown;
          skip_missing: unknown;
        };
        if (
          typeof sent.from !== "number" ||
          typeof sent.from_generation !== "number" ||
          typeof sent.to !== "number" ||
          typeof sent.to_generation !== "number" ||
          typeof sent.id !== "string" ||
          (sent.folder !== null && typeof sent.folder !== "string") ||
          typeof sent.skip_missing !== "boolean"
        ) {
          return refuse(MALFORMED);
        }
        // Either session locked or foreign (a stale generation) is the shell's `locked`, before anything else is looked at.
        const source = vaultFor(sent.from, sent.from_generation);
        const target = vaultFor(sent.to, sent.to_generation);
        if (target.readOnly ?? false) return refuse({ code: "read_only" });
        const item = source.items?.find((one) => one.id === sent.id && one.kind !== "collection" && !(one.trashed ?? false));
        if (item === undefined) return refuse({ code: "core", kind: "not_found" });
        // The folder is the target's own, by the engine's rule: one that is not in it, or is in its trash, is refused before anything is written.
        if (sent.folder !== null && target.items?.find((one) => one.id === sent.folder && one.kind === "collection" && !(one.trashed ?? false)) === undefined) {
          return refuse({ code: "core", kind: "invalid_input", what: "collection" });
        }
        const lacking = item.missingFiles ?? [];
        if (lacking.length > 0 && !sent.skip_missing) {
          return tagged(sent.to, sent.to_generation, { Confirm: { MissingFiles: { names: [...lacking] } } });
        }
        nextItem += 1;
        const made: FakeItem = {
          ...item,
          id: itemId(nextItem),
          collection: sent.folder,
          attachments: (item.attachments ?? []).filter((file) => !lacking.includes(file.name)).map((file) => ({ ...file })),
          missingFiles: undefined,
          modified_at: nowText(),
        };
        target.items = [...(target.items ?? []), made];
        copiedOut.push({ from: sent.from, to: sent.to, id: sent.id, folder: sent.folder, skipMissing: sent.skip_missing, newId: made.id });
        return tagged(sent.to, sent.to_generation, { Done: { id: made.id, left_out: [...lacking] } });
      }
      case "restore_pick": {
        const sent = exactly(args, ["choice", "vault"]);
        if (sent.choice !== null && typeof sent.choice !== "string") return refuse(MALFORMED);
        if (sent.vault !== null && typeof sent.vault !== "number") return refuse(MALFORMED);
        // A vault that is not listed is refused, and nothing is picked.
        if (typeof sent.vault === "number" && !vaults.some((v) => v.id === sent.vault)) return refuse({ code: "not_found" });
        if (dismissFile) {
          dismissFile = false;
          return "Dismissed";
        }
        const file = nextBackupPick ?? { name: BACKUP_NAME, size: BACKUP_SIZE };
        nextBackupPick = undefined;
        // A new pick forgets the old one.
        if (typeof sent.choice === "string") restoreHeld.delete(sent.choice);
        nextToken += 1;
        const token = nextToken.toString(16).padStart(32, "0");
        restoreHeld.set(token, { ...file, checked: undefined, vault: sent.vault });
        return { Done: { choice: token, file_name: file.name, size: file.size } };
      }
      case "restore_check": {
        // Decided as the check ends (`restoreCheckCommand` begins the job and calls this): the request names the job, and is checked there.
        const sent = exactly(args, ["choice", "credential", "request"]);
        const credential = sent.credential;
        if (typeof credential !== "object" || credential === null || Object.keys(credential).join() !== "password_or_key") return refuse(MALFORMED);
        const text = (credential as { password_or_key?: unknown }).password_or_key;
        if (typeof text !== "string" || typeof sent.choice !== "string") return refuse(MALFORMED);
        const held = restoreHeld.get(sent.choice);
        if (held === undefined) return refuse(CHOICE_EXPIRED);
        // A wrong password keeps the pick, and what was checked before is left as it was.
        if (text !== BACKUP_PASSWORD) return refuse(WRONG_PASSWORD);
        if (damage !== undefined) {
          const { what } = damage;
          damage = undefined;
          return refuse({ code: "core", kind: "damaged", ...(what === undefined ? {} : { what }) });
        }
        // A pick made for a vault goes in that vault's folder, which is not the usual one.
        held.checked = { ...restoreFound, usual: held.vault === null ? (held.checked?.usual ?? true) : false };
        return restoreViewOf(held);
      }
      case "restore_notice": {
        exactly(args ?? {}, []);
        return restoreNoticeNow ?? noticeOfLaunch();
      }
      case "retry_restore_recovery": {
        exactly(args ?? {}, []);
        const found = retryAnswers.shift() ?? restoreNoticeNow ?? noticeOfLaunch();
        restoreNoticeNow = found;
        return found;
      }
      case "dismiss_restore": {
        const sent = exactly(args, ["confirm"]);
        if (typeof sent.confirm !== "boolean") return refuse(MALFORMED);
        if (!sent.confirm) return { Confirm: { Dismissal: { leaves: { staging: "C:\\Vaults\\demo.restore", before_restore: null } } } };
        restoreNoticeNow = { state: "none" };
        launchNotices = launchNotices.filter((notice) => (notice as { kind?: unknown }).kind !== "restore");
        return { Done: null };
      }
      case "restore_choose_folder": {
        const sent = exactly(args, ["choice"]);
        if (typeof sent.choice !== "string") return refuse(MALFORMED);
        const held = restoreHeld.get(sent.choice);
        if (held?.checked === undefined) return refuse(CHOICE_EXPIRED);
        if (dismissFile) {
          dismissFile = false;
          return "Dismissed";
        }
        held.checked.usual = false;
        return { Done: restoreViewOf(held) };
      }
      case "forget_restore_pick": {
        const sent = exactly(args, ["choice"]);
        if (typeof sent.choice !== "string") return refuse(MALFORMED);
        restoreHeld.delete(sent.choice);
        return null;
      }
      case "restore_discard": {
        const sent = exactly(args, ["restore"]);
        if (typeof sent.restore !== "number") return refuse(MALFORMED);
        restorePrepared.delete(sent.restore);
        restoreDiscarded.push(sent.restore);
        return null;
      }
      case "list_pre_restore": {
        exactly(args ?? {}, []);
        // Every listing replaces every ID.
        olderListed.clear();
        return olderHeld.map((copy) => {
          nextOlderId += 1;
          olderListed.set(nextOlderId, copy);
          return {
            id: nextOlderId,
            vault: copy.vault,
            name: copy.name === undefined ? (vaults.find((v) => v.id === copy.vault)?.name ?? null) : copy.name,
            folder: copy.folder,
            last_written: copy.last_written === undefined ? "2026-11-04" : copy.last_written,
            size: copy.size === undefined ? 5 * 1024 * 1024 : copy.size,
          };
        });
      }
      case "open_pre_restore_read_only": {
        const sent = exactly(args, ["id", "credential"]);
        const credential = sent.credential;
        const form = typeof credential === "object" && credential !== null ? Object.keys(credential) : [];
        if (typeof sent.id !== "number" || form.length !== 1 || !["password", "recovery_key", "password_or_key"].includes(form[0] ?? "")) return refuse(MALFORMED);
        const text = (credential as Record<string, unknown>)[form[0] ?? ""];
        if (typeof text !== "string") return refuse(MALFORMED);
        const copy = olderListed.get(sent.id);
        if (copy === undefined) return refuse({ code: "not_found" });
        if (text !== (copy.password ?? PASSWORD)) return refuse(WRONG_PASSWORD);
        // A session open on the copy already is the one answered; else the copy is a read-only vault of its own, beside the live one and not on the list.
        const open = [...olderSessions].find(([session, folder]) => folder === copy.folder && live.get(session)?.unlocked === true);
        if (open !== undefined) {
          const opened = live.get(open[0]);
          if (opened !== undefined) {
            return tagged(opened.session, opened.generation, {
              ...infoOf(sessionVault.get(opened.session) as FakeVault, opened.session, opened.generation),
              header_changed: false,
            });
          }
        }
        const vault: FakeVault = {
          id: -nextOlderId,
          name: copy.name === undefined ? (vaults.find((v) => v.id === copy.vault)?.name ?? "") : copy.name,
          password: copy.password,
          readOnly: true,
          kind: "older_copy",
          items: sampleItems(),
        };
        nextSession += 1;
        const entry: Live = { session: nextSession, generation: 1, unlocked: true };
        live.set(nextSession, entry);
        sessionVault.set(nextSession, vault);
        olderSessions.set(nextSession, copy.folder);
        return tagged(nextSession, entry.generation, { ...infoOf(vault, nextSession, entry.generation), header_changed: copy.headerChanged ?? false });
      }
      case "delete_pre_restore": {
        const sent = exactly(args, ["id", "confirm"]);
        if (typeof sent.id !== "number" || typeof sent.confirm !== "boolean") return refuse(MALFORMED);
        const copy = olderListed.get(sent.id);
        if (copy === undefined) return refuse({ code: "not_found" });
        // A session open on the copy (or an open under way) keeps it, before the question and again before the delete.
        const inUse = olderOpenElsewhere.has(copy.folder) || [...olderSessions].some(([session, folder]) => folder === copy.folder && live.get(session)?.unlocked === true);
        if (inUse) return refuse({ code: "busy", what: "folder is open" });
        if (!sent.confirm) return { Confirm: "DeletePreRestore" };
        olderHeld = olderHeld.filter((other) => other !== copy);
        olderListed.delete(sent.id);
        olderDeleted.push(copy.folder);
        return { Done: null };
      }
      case "backup_vault": {
        const sent = exactly(args, ["session", "generation", "request"]) as { session: number; generation: number };
        requestOf(sent);
        const vault = vaultFor(sent.session, sent.generation);
        if (vault.readOnly ?? false) return refuse({ code: "read_only" });
        // The save dialog, closed without a choice: nothing is written and no date is kept.
        if (dismissFile) {
          dismissFile = false;
          return tagged(sent.session, sent.generation, "Dismissed");
        }
        const live = (vault.items ?? []).filter((item) => item.kind !== "collection" && !(item.trashed ?? false));
        const view = {
          items: live.length,
          files: live.reduce((total, item) => total + (item.attachments?.length ?? 0), 0),
          damaged_items: 0,
          damaged_files: 0,
          missing_files: 0,
          size_on_disk: 1_288_490_188,
          ...vault.backupView,
        };
        fileOps.push({ cmd });
        // The shell writes the vault's last backup date on success only.
        vault.backupDays = undefined;
        // And parks the backup it wrote for 22c's Test this backup, which opens it with this vault's password (the one it was made with).
        nextToken += 1;
        const token = nextToken.toString(16).padStart(32, "0");
        const name = `${vault.name ?? "Vault"} ${BACKUP_DAY}.lockbox-backup`;
        testHeld.set(token, { name, size: view.size_on_disk, password: vault.password ?? PASSWORD });
        lastBackup = { name, choice: token };
        return tagged(sent.session, sent.generation, { Done: { ...view, test: { choice: token, file_name: name, size: view.size_on_disk } } });
      }
      case "vault_backup_due": {
        const { session, generation } = exactly(args, ["session", "generation"]) as { session: number; generation: number };
        const vault = vaultFor(session, generation);
        const days = vault.backupDays;
        // Never for a read-only copy; due from 30 whole days.
        return tagged(session, generation, (vault.readOnly ?? false) || days === undefined || days < 30 ? null : { days });
      }
      case "pick_files_to_add": {
        const sent = exactly(args, ["session", "generation", "choice"]) as { session: number; generation: number; choice: unknown };
        const vault = vaultFor(sent.session, sent.generation);
        if (vault.readOnly ?? false) return refuse({ code: "read_only" });
        if (sent.choice !== null && typeof sent.choice !== "string") return refuse(MALFORMED);
        // A bad choice is refused before any dialog opens.
        const held = sent.choice === null ? undefined : choiceOf(sent.choice, sent.session, sent.generation);
        if (dismissFile) {
          dismissFile = false;
          // Nothing was picked: a new choice is not made, and Pick more keeps its list as it was.
          return tagged(sent.session, sent.generation, held === undefined ? "Dismissed" : { Done: { choice: sent.choice, files: held.files.map((file) => ({ ...file })) } });
        }
        const picked = nextPick();
        let token = sent.choice;
        if (held === undefined) {
          nextToken += 1;
          token = nextToken.toString(16).padStart(32, "0");
          choices.set(token, { session: sent.session, generation: sent.generation, files: picked });
        } else {
          held.files.push(...picked);
        }
        const now = choices.get(token as string)?.files ?? [];
        return tagged(sent.session, sent.generation, { Done: { choice: token, files: now.map((file) => ({ ...file })) } });
      }
      case "remove_picked_file": {
        const sent = exactly(args, ["session", "generation", "choice", "index"]) as { session: number; generation: number; choice: unknown; index: unknown };
        const vault = vaultFor(sent.session, sent.generation);
        if (vault.readOnly ?? false) return refuse({ code: "read_only" });
        const held = choiceOf(sent.choice, sent.session, sent.generation);
        if (typeof sent.index !== "number" || !Number.isInteger(sent.index) || sent.index < 0 || sent.index >= held.files.length) return refuse(NO_SUCH_PICK);
        held.files.splice(sent.index, 1);
        return tagged(sent.session, sent.generation, { Done: { files: held.files.map((file) => ({ ...file })) } });
      }
      case "add_files": {
        const request = (args as { request?: unknown } | null)?.request;
        const taken = typeof request === "number" ? batches.get(request) : undefined;
        const batch = taken ?? startBatch(args);
        if (typeof request === "number") batches.delete(request);
        // A lock between the job's start and its end leaves a refusal, and nothing is written.
        vaultFor(batch.session, batch.generation);
        return tagged(batch.session, batch.generation, { Done: finishBatch(batch) });
      }
      case "save_all_files": {
        const sent = exactly(args, ["session", "generation", "folder"]) as { session: number; generation: number; folder: string };
        // A read-only vault saves too (as Save a copy does): no refusal for it here.
        const vault = vaultFor(sent.session, sent.generation);
        if (vault.items?.find((item) => item.id === sent.folder && item.kind === "collection" && !(item.trashed ?? false)) === undefined) {
          return refuse({ code: "core", kind: "not_found" });
        }
        // The count in the picker's title is the shell's own: a folder with no files is refused before any dialog opens.
        if (filesOfFolder(vault, sent.folder).length === 0) return refuse({ code: "invalid_input", what: "no files" });
        if (dismissFile) {
          dismissFile = false;
          return tagged(sent.session, sent.generation, "Dismissed");
        }
        // A cloud-synced folder asks first, before anything is checked further or written: the folder waits under a token.
        if (cloudPdf > 0) {
          cloudPdf -= 1;
          nextToken += 1;
          const token = `save-all-token-${String(nextToken)}`;
          parkedSaves.set(token, { session: sent.session, generation: sent.generation, folder: sent.folder });
          return tagged(sent.session, sent.generation, { Confirm: { CloudFolder: { token, provider: "Other" } } });
        }
        return planSave(sent.session, sent.generation, vault, sent.folder);
      }
      case "save_all_files_confirm": {
        const { token } = exactly(args, ["token"]);
        const parked = typeof token === "string" ? parkedSaves.get(token) : undefined;
        // A token that is used, old, dropped by a lock or another kind's is the shell's `choice_expired`.
        if (parked === undefined) return refuse(CHOICE_EXPIRED);
        parkedSaves.delete(token as string);
        // The checks run again on the yes.
        return planSave(parked.session, parked.generation, vaultFor(parked.session, parked.generation), parked.folder);
      }
      case "save_all_start": {
        const request = (args as { request?: unknown } | null)?.request;
        const taken = typeof request === "number" ? saveRuns.get(request) : undefined;
        const run = taken ?? startSave(args);
        if (typeof request === "number") saveRuns.delete(request);
        // A lock between the job's start and its end leaves a refusal, and nothing is written.
        vaultFor(run.session, run.generation);
        return tagged(run.session, run.generation, { Done: finishSave(run) });
      }
      case "show_output_in_explorer": {
        const { output } = exactly(args, ["output"]);
        const held = typeof output === "string" ? outputs.get(output) : undefined;
        if (held === undefined) return refuse(CHOICE_EXPIRED);
        if (explorerFails) {
          explorerFails = false;
          return refuse({ code: "io" });
        }
        openedFolders.push(held.shown);
        return null;
      }
      case "close_output": {
        const { output } = exactly(args, ["output"]);
        if (typeof output === "string") outputs.delete(output);
        return null;
      }
      case "cancel_operation": {
        const sent = exactly(args, ["operation", "scope"]) as { operation: number; scope: RunningJob["scope"] };
        const job = running.get(sent.operation);
        // A scope the page names wrongly, a vault that has locked since, and a job that is over or was never here are each refused, and nothing is stopped.
        if (job === undefined) return refuse({ code: "not_found" });
        if (job.scope.type === "launch") {
          // A launch's job (a test of a backup) is named by the lock epoch it began in.
          if (sent.scope.type !== "launch" || sent.scope.epoch !== job.scope.epoch) return refuse({ code: "not_found" });
          job.cancel();
          return null;
        }
        if (sent.scope.type !== "session" || sent.scope.session !== job.scope.session || sent.scope.generation !== job.scope.generation) {
          return refuse({ code: "not_found" });
        }
        vaultFor(job.scope.session, job.scope.generation);
        job.cancel();
        return null;
      }
      case "retry_open_cleanup": {
        exactly(args ?? {}, []);
        retried += 1;
        return { removed: 0, still_open: stillOpenAfterRetry };
      }
      case "list_printers":
        exactly(args ?? {}, []);
        return { printers: [...printers], default: defaultPrinter !== null && printers.includes(defaultPrinter) ? defaultPrinter : null };
      case "print_recovery_key": {
        const { session, generation, printer } = exactly(args, ["session", "generation", "printer"]) as {
          session: number;
          generation: number;
          printer: unknown;
        };
        const vault = vaultFor(session, generation);
        if (vault.readOnly ?? false) return refuse({ code: "read_only" });
        if (printRefusal !== undefined) {
          const error = printRefusal;
          printRefusal = undefined;
          return refuse(error);
        }
        // Only a printer the shell lists is printed to: a name that is gone, or never was, is refused.
        if (typeof printer !== "string" || !printers.includes(printer)) return refuse(PRINTER_GONE);
        printed.push(printer);
        return tagged(session, generation, null);
      }
      case "list_items": {
        const { session, generation } = exactly(args, ["session", "generation"]) as { session: number; generation: number };
        const vault = vaultFor(session, generation);
        const damaged = Array.from({ length: vault.unreadable ?? 0 }, (_, n) => itemId(0xd0 + n));
        return tagged(session, generation, { items: (vault.items ?? []).map(summary), damaged });
      }
      case "get_item": {
        const { session, generation, id } = exactly(args, ["session", "generation", "id"]) as {
          session: number;
          generation: number;
          id: string;
        };
        const item = vaultFor(session, generation).items?.find((i) => i.id === id);
        if (item === undefined) return refuse({ code: "core", kind: "not_found" });
        return tagged(session, generation, {
          summary: summary(item),
          revision: item.revision ?? 2,
          notes: item.notes ?? "",
          urls: item.urls ?? [],
          has_password: item.has_password ?? false,
          has_value: item.kind === "key" && (item.value ?? "") !== "",
          // Numbers and times only: a password crosses through `reveal_password` and `copy_field`.
          previous: (item.previous ?? []).map((old, index) => ({ index, replaced_at: old.replaced_at })),
        });
      }
      case "reveal_password": {
        const sent = exactly(args, ["session", "generation", "id", "field"]) as {
          session: number;
          generation: number;
          id: string;
          field: unknown;
        };
        const item = vaultFor(sent.session, sent.generation).items?.find((i) => i.id === sent.id);
        if (item === undefined) return refuse({ code: "core", kind: "not_found" });
        const earlier = previousIndex(sent.field);
        if (earlier !== null) {
          // An earlier password: a login's, by its number.
          if (item.kind !== "login") return refuse(NOT_A_LOGIN);
          const old = item.previous?.[earlier];
          if (old === undefined) return refuse(NO_SUCH_EARLIER);
          revealed.push({ session: sent.session, generation: sent.generation, id: sent.id, field: { previous: earlier } });
          return tagged(sent.session, sent.generation, old.password);
        }
        if (sent.field !== "password" && sent.field !== "key_value") return refuse(MALFORMED);
        // A login's password and a key's value, each only of its own kind.
        if (sent.field === "password" && item.kind !== "login") return refuse(NOT_A_LOGIN);
        if (sent.field === "key_value" && item.kind !== "key") return refuse(NOT_A_KEY);
        revealed.push({ session: sent.session, generation: sent.generation, id: sent.id, field: sent.field });
        return tagged(sent.session, sent.generation, sent.field === "key_value" ? (item.value ?? "") : (item.password ?? "Pw-from-the-fake-shell"));
      }
      case "copy_field": {
        const sent = exactly(args, ["session", "generation", "id", "field"]) as {
          session: number;
          generation: number;
          id: string;
          field: unknown;
        };
        const item = vaultFor(sent.session, sent.generation).items?.find((i) => i.id === sent.id);
        const earlier = previousIndex(sent.field);
        if (earlier !== null && item !== undefined) {
          if (item.kind !== "login") return refuse(NOT_A_LOGIN);
          if (item.previous?.[earlier] === undefined) return refuse(NO_SUCH_EARLIER);
        }
        // A key's value is a key's alone, and a login's fields are a login's.
        if (item !== undefined && sent.field === "key_value" && item.kind !== "key") return refuse(NOT_A_KEY);
        if (item?.kind === "key" && (sent.field === "password" || sent.field === "username")) return refuse(NOT_A_LOGIN);
        copied.push(sent);
        return tagged(sent.session, sent.generation, null);
      }
      case "search_all": {
        const { query } = exactly(args, ["query"]) as { query: unknown };
        if (typeof query !== "string") return refuse(MALFORMED);
        if (Array.from(query).length > 256) return refuse({ code: "too_large", what: "search" });
        const needle = query.trim().toLowerCase();
        const hits: unknown[] = [];
        const busy: number[] = [];
        for (const [session, entry] of live) {
          const vault = sessionVault.get(session);
          if (!entry.unlocked || vault === undefined) continue;
          if (vault.busy ?? false) {
            busy.push(session);
            continue;
          }
          const all = vault.items ?? [];
          const folderTitle = (item: FakeItem) => all.find((other) => other.id === item.collection)?.title ?? "";
          // The engine's index: a live item's title, a login's username and links, its folder's title and the names of its attached
          // files. An item that matches in its own fields is a hit; each file name that matches (once) is a hit with that file, after it.
          // At most `SEARCH_LIMIT` come back from a vault, of every kind (`commands/items.rs`), whatever the page shows.
          const found: unknown[] = [];
          if (needle !== "") {
            for (const item of all) {
              if (item.trashed ?? false) continue;
              const own = [item.title, item.username ?? "", ...(item.urls ?? []), folderTitle(item)].some((text) => text.toLowerCase().includes(needle));
              if (own) found.push({ ...summary(item), matched_file: null });
              const seen = new Set<string>();
              for (const file of item.attachments ?? []) {
                if (seen.has(file.name) || !file.name.toLowerCase().includes(needle)) continue;
                seen.add(file.name);
                found.push({ ...summary(item), matched_file: file });
              }
            }
          }
          hits.push(tagged(session, entry.generation, found.slice(0, SEARCH_LIMIT)));
        }
        return { hits, busy };
      }
      case "open_url": {
        const sent = exactly(args, ["session", "generation", "id", "index"]) as {
          session: number;
          generation: number;
          id: string;
          index: number;
        };
        const item = vaultFor(sent.session, sent.generation).items?.find((i) => i.id === sent.id);
        const link = item?.kind === "login" ? item.urls?.[sent.index] : undefined;
        if (link === undefined) return refuse({ code: "not_found" });
        // Only an `http` or `https` link that parses opens (`web_link`); like the shell's parser, `URL` trims the ends.
        if (siteOfUrl(link) === null) return refuse({ code: "invalid_input", what: "link type" });
        opened.push(sent);
        return tagged(sent.session, sent.generation, null);
      }
      case "new_item": {
        const sent = exactly(args, ["session", "generation", "kind", "title", "collection", "fields"]) as {
          session: number;
          generation: number;
          kind: string;
          title: string;
          collection: string | null;
          fields: Record<string, unknown> | null;
        };
        const vault = vaultFor(sent.session, sent.generation);
        if (sent.kind !== "login" && sent.kind !== "key" && sent.kind !== "note" && sent.kind !== "collection") return refuse(MALFORMED);
        const kind = sent.kind;
        if (sent.fields !== null) {
          const known = ["username", "password", "urls", "notes", "value"];
          if (Object.keys(sent.fields).some((name) => !known.includes(name))) return refuse(MALFORMED);
        }
        const fields = sent.fields ?? {};
        // A folder has a name and nothing else: fields sent for one are refused, and the name is trimmed and never empty.
        if (kind === "collection") {
          if (sent.fields !== null) return refuse(NOT_A_LOGIN);
          if (new TextEncoder().encode(sent.title).length > MAX_TITLE) return refuse({ code: "too_large", what: "title" });
          if (sent.title.trim() === "") return refuse(FOLDER_NAME_EMPTY);
          if (vault.readOnly ?? false) return refuse({ code: "read_only" });
          nextItem += 1;
          const folderId = itemId(nextItem);
          if (sent.collection !== null) {
            const parent = sent.collection;
            if (vault.items?.find((item) => item.id === parent && item.kind === "collection" && !(item.trashed ?? false)) === undefined) {
              return refuse({ code: "core", kind: "invalid_input", what: "collection" });
            }
            return refuse({ code: "core", kind: "invalid_input", what: "collection inside a collection" });
          }
          vault.items = [
            ...(vault.items ?? []),
            { id: folderId, kind: "collection", title: sent.title.trim(), collection: null, modified_at: nowText() },
          ];
          made.push(sent);
          return tagged(sent.session, sent.generation, folderId);
        }
        // The shell's limits come first, then which fields belong to which kind, then the session's own refusals.
        if (typeof fields.value === "string" && new TextEncoder().encode(fields.value).length > MAX_KEY_VALUE) {
          return refuse({ code: "too_large", what: "value" });
        }
        const text = (name: string): string => {
          const found = fields[name];
          return typeof found === "string" ? found : "";
        };
        const loginOnly = text("username") !== "" || text("password") !== "" || ((fields.urls as string[] | undefined) ?? []).length > 0;
        if (kind !== "login" && loginOnly) return refuse(NOT_A_LOGIN);
        if (kind !== "key" && text("value") !== "") return refuse(NOT_A_KEY);
        if (vault.readOnly ?? false) return refuse({ code: "read_only" });
        const urls = kind === "login" ? ((fields.urls as string[] | undefined) ?? []).map(normaliseUrl) : [];
        const folder = sent.collection;
        if (folder !== null && vault.items?.find((item) => item.id === folder && item.kind === "collection") === undefined) {
          return refuse({ code: "core", kind: "invalid_input", what: "collection" });
        }
        // The engine's rule for a key's title: a variable name.
        if (kind === "key" && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(sent.title)) return refuse(BAD_KEY_NAME);
        nextItem += 1;
        const id = itemId(nextItem);
        const password = text("password");
        vault.items = [
          ...(vault.items ?? []),
          {
            id,
            kind,
            title: sent.title,
            ...(kind === "login" ? { username: text("username"), urls, has_password: password !== "" } : {}),
            ...(kind === "key" ? { value: text("value") } : {}),
            collection: folder,
            notes: text("notes"),
            modified_at: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
          },
        ];
        made.push(sent);
        return tagged(sent.session, sent.generation, id);
      }
      case "update_item": {
        const sent = exactly(args, ["session", "generation", "edit"]) as {
          session: number;
          generation: number;
          edit: Record<string, unknown>;
        };
        // The edit says its own fields and no others (`ItemEdit`): the optional ones may be left out, and nothing says an
        // earlier password, which only the engine writes.
        const required = ["id", "revision", "title", "notes", "collection"];
        const optional = ["username", "password", "urls", "key_value"];
        const given = Object.keys(sent.edit);
        if (given.some((name) => !required.includes(name) && !optional.includes(name))) return refuse(MALFORMED);
        if (required.some((name) => !given.includes(name))) return refuse(MALFORMED);
        const edit = sent.edit;
        const text = (name: string): string | undefined => (typeof edit[name] === "string" ? edit[name] : undefined);
        if (typeof edit.id !== "string" || typeof edit.revision !== "number" || text("title") === undefined) return refuse(MALFORMED);
        if (typeof edit.key_value === "string" && new TextEncoder().encode(edit.key_value).length > MAX_KEY_VALUE) {
          return refuse({ code: "too_large", what: "value" });
        }
        const urls = edit.urls === undefined ? undefined : (edit.urls as string[]).map(normaliseUrl);
        const vault = vaultFor(sent.session, sent.generation);
        if (vault.readOnly ?? false) return refuse({ code: "read_only" });
        const id = edit.id;
        const item = vault.items?.find((i) => i.id === id);
        if (item === undefined) return refuse({ code: "core", kind: "not_found" });
        // A folder's new name is trimmed and never empty (`folder_name`).
        if (item.kind === "collection" && (text("title") ?? "").trim() === "") return refuse(FOLDER_NAME_EMPTY);
        const loginFields = edit.username !== undefined || edit.password !== undefined || edit.urls !== undefined;
        if (item.kind === "login" && edit.key_value !== undefined) return refuse(NOT_A_KEY);
        if (item.kind === "key" && loginFields) return refuse(NOT_A_LOGIN);
        if (item.kind !== "login" && item.kind !== "key" && loginFields) return refuse(NOT_A_LOGIN);
        if (item.kind !== "login" && item.kind !== "key" && edit.key_value !== undefined) return refuse(NOT_A_KEY);
        if (item.purging ?? false) return refuse(BEING_DELETED);
        if ((item.revision ?? 2) !== edit.revision) return refuse(STALE_REVISION);
        // The engine's folder rules (`check_collection`): a folder newly named must be a folder that is not in the trash, and
        // nothing sits in itself or, if it is a folder, in another.
        const target = typeof edit.collection === "string" ? edit.collection : null;
        if (target !== null) {
          if (target === item.id) return refuse({ code: "core", kind: "invalid_input", what: "collection" });
          if (item.kind === "collection") return refuse({ code: "core", kind: "invalid_input", what: "collection inside a collection" });
          const usable = vault.items?.find((other) => other.id === target && other.kind === "collection" && !(other.trashed ?? false));
          if (target !== (item.collection ?? null) && usable === undefined) {
            return refuse({ code: "core", kind: "invalid_input", what: "collection" });
          }
        }
        const title = item.kind === "collection" ? (text("title") ?? "").trim() : (text("title") ?? "");
        if (item.kind === "key" && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(title)) return refuse(BAD_KEY_NAME);
        // The engine moves the old password aside on a real change, and the page never sends the list.
        const before = item.password ?? (item.has_password ?? false ? "Pw-from-the-fake-shell" : "");
        const password = text("password");
        if (item.kind === "login" && password !== undefined) {
          if (password !== before && before !== "") {
            item.previous = [{ password: before, replaced_at: new Date().toISOString().replace(/\.\d+Z$/, "Z") }, ...(item.previous ?? [])].slice(
              0,
              MAX_PREVIOUS,
            );
          }
          item.password = password;
          item.has_password = password !== "";
        }
        if (item.kind === "login") {
          const username = text("username");
          if (username !== undefined) item.username = username;
          if (urls !== undefined) item.urls = urls;
        }
        const value = text("key_value");
        if (item.kind === "key" && value !== undefined) item.value = value;
        item.title = title;
        item.notes = text("notes") ?? "";
        item.collection = typeof edit.collection === "string" ? edit.collection : null;
        item.revision = (item.revision ?? 2) + 1;
        item.modified_at = new Date().toISOString().replace(/\.\d+Z$/, "Z");
        edited.push(sent);
        return tagged(sent.session, sent.generation, null);
      }
      case "trash_item":
      case "restore_item":
      case "delete_collection":
      case "purge_item": {
        const { session, generation, id } = exactly(args, ["session", "generation", "id"]) as {
          session: number;
          generation: number;
          id: string;
        };
        const vault = vaultFor(session, generation);
        if (vault.readOnly ?? false) return refuse({ code: "read_only" });
        const all = vault.items ?? [];
        const item = all.find((i) => i.id === id);
        if (item === undefined) return refuse({ code: "core", kind: "not_found" });
        if (cmd === "trash_item") {
          if (item.purging ?? false) return refuse(BEING_DELETED);
          if (item.kind === "collection") return refuse(USE_DELETE_COLLECTION);
          intoTrash(item, undefined);
          return tagged(session, generation, null);
        }
        if (cmd === "delete_collection") {
          if (item.kind !== "collection") return refuse(NOT_A_COLLECTION);
          // The items first, each with the folder it went with; the folder last. One already in the trash is left as it is.
          const members = all.filter((m) => m.collection === id && !(m.trashed ?? false));
          const write = partwayWrites(cmd);
          for (const member of members) write(() => { intoTrash(member, id); });
          write(() => { intoTrash(item, undefined); });
          return tagged(session, generation, members.length);
        }
        if (cmd === "purge_item") {
          if (!(item.trashed ?? false)) return refuse(NOT_IN_TRASH);
          vault.items = all.filter((i) => i.id !== id);
          return tagged(session, generation, null);
        }
        // restore_item
        if (item.purging ?? false) return refuse(BEING_DELETED);
        if (!(item.trashed ?? false)) return tagged(session, generation, null);
        if (item.kind === "collection") {
          // What went with it and is still filed in it, items first and the folder last; not what is being deleted for good.
          const members = all.filter(
            (m) => (m.trashed ?? false) && !(m.purging ?? false) && m.trashedWith === id && (m.collection ?? null) === id,
          );
          const write = partwayWrites(cmd);
          for (const member of members) write(() => { outOfTrash(member); });
          write(() => { outOfTrash(item); });
          return tagged(session, generation, null);
        }
        const folder = all.find((f) => f.id === item.collection);
        if (folder !== undefined && (folder.purging ?? false)) return refuse(BEING_DELETED);
        if (folder !== undefined) outOfTrash(folder);
        outOfTrash(item);
        return tagged(session, generation, null);
      }
      case "old_trash": {
        // The ids in the trash for `days` days or more, by the clock the page runs on; a read-only vault is refused, as the shell does.
        const { session, generation, days } = exactly(args, ["session", "generation", "days"]) as {
          session: number;
          generation: number;
          days: number;
        };
        const vault = vaultFor(session, generation);
        if (vault.readOnly ?? false) return refuse({ code: "read_only" });
        const cutoff = Date.now() - days * 86_400_000;
        const old = (vault.items ?? []).filter(
          (item) => (item.trashed ?? false) && Date.parse(item.trashedAt ?? "2026-11-01T09:00:00Z") <= cutoff,
        );
        return tagged(
          session,
          generation,
          old.map((item) => item.id),
        );
      }
      case "empty_trash": {
        // Everything in this vault's trash goes (the vault's own list is changed in place, as `purge_item` removes one); a
        // read-only vault is refused. The answer is a count, as the shell's is.
        // With `older_than_days` (the old group's button) only what has been there that many days or more, by the clock the page runs on.
        const given = typeof args === "object" && args !== null && "older_than_days" in args;
        // `expected` is how many items the question said would go: another number deletes nothing and says the trash changed.
        const { session, generation, older_than_days, expected } = exactly(
          args,
          given ? ["session", "generation", "expected", "older_than_days"] : ["session", "generation", "expected"],
        ) as {
          session: number;
          generation: number;
          expected: number;
          older_than_days?: number;
        };
        if ((given && !Number.isInteger(older_than_days)) || !Number.isInteger(expected)) return refuse(MALFORMED);
        const vault = vaultFor(session, generation);
        if (vault.readOnly ?? false) return refuse({ code: "read_only" });
        const all = vault.items ?? [];
        const cutoff = Date.now() - (older_than_days ?? 0) * 86_400_000;
        const goes = (item: FakeItem | undefined) =>
          (item?.trashed ?? false) && (!given || Date.parse(item?.trashedAt ?? "2026-11-01T09:00:00Z") <= cutoff);
        if (all.filter(goes).length !== expected) return tagged(session, generation, { Done: { purged: 0, trash_changed: true } });
        let purged = 0;
        for (let at = all.length - 1; at >= 0; at -= 1) {
          if (goes(all[at])) {
            all.splice(at, 1);
            purged += 1;
          }
        }
        return tagged(session, generation, { Done: { purged, trash_changed: false } });
      }
      case "generate_password": {
        const { options } = exactly(args, ["options"]) as { options: unknown };
        const given = exactly(options, ["length", "lowercase", "uppercase", "digits", "symbols", "avoid_ambiguous"]) as {
          length: number;
          lowercase: boolean;
          uppercase: boolean;
          digits: boolean;
          symbols: boolean;
        };
        if (!Number.isInteger(given.length) || given.length < 8 || given.length > 128) {
          return refuse({ code: "core", kind: "invalid_input", what: "password length" });
        }
        const classes = [
          given.lowercase ? "abcdefghijkmnpqrstuvwxyz" : "",
          given.uppercase ? "ABCDEFGHJKLMNPQRSTUVWXYZ" : "",
          given.digits ? "23456789" : "",
          given.symbols ? "!@#$%^&*-_=+" : "",
        ].filter((set) => set !== "");
        if (classes.length === 0) return refuse({ code: "core", kind: "invalid_input", what: "no character class selected" });
        const pick = (set: string) => set.charAt(Math.floor(random() * set.length));
        const chars = classes.map(pick);
        while (chars.length < given.length) chars.push(pick(classes.join("")));
        return chars.join("");
      }
      case "generate_passphrase": {
        const { options } = exactly(args, ["options"]) as { options: unknown };
        const given = exactly(options, ["words", "separator", "capitalize", "include_number"]) as {
          words: number;
          separator: string;
          capitalize: boolean;
          include_number: boolean;
        };
        if (!Number.isInteger(given.words) || given.words < 3 || given.words > 12) {
          return refuse({ code: "core", kind: "invalid_input", what: "word count" });
        }
        const numbered = given.include_number ? Math.floor(random() * given.words) : -1;
        const words = Array.from({ length: given.words }, (_, at) => {
          const word = FAKE_WORDS[Math.floor(random() * FAKE_WORDS.length)] ?? "";
          const shown = given.capitalize ? word.charAt(0).toUpperCase() + word.slice(1) : word;
          return at === numbered ? `${shown}${String(Math.floor(random() * 10))}` : shown;
        });
        return words.join(given.separator);
      }
      case "copy_generated": {
        const sent = exactly(args, ["session", "generation", "value"]) as {
          session: number;
          generation: number;
          value: unknown;
        };
        // A read-only vault may copy: nothing is written to it.
        vaultFor(sent.session, sent.generation);
        if (typeof sent.value !== "string") return refuse(MALFORMED);
        if (new TextEncoder().encode(sent.value).length > MAX_GENERATED) return refuse({ code: "too_large", what: "password" });
        generated.push({ session: sent.session, generation: sent.generation, value: sent.value });
        return tagged(sent.session, sent.generation, null);
      }
      case "clear_copied": {
        exactly(args ?? {}, []);
        clearCopiedCalls += 1;
        const answer = clearCopiedAnswer;
        clearCopiedAnswer = "cleared";
        return answer;
      }
      case "close_explained_ok":
        exactly(args ?? {}, []);
        closeExplainedCalls += 1;
        explained();
        return null;
      case "close_answer": {
        const { question, go } = exactly(args, ["question", "go"]);
        if (typeof go !== "boolean" || typeof question !== "number" || !Number.isSafeInteger(question)) return refuse(MALFORMED);
        // No question pending, a second answer, or an answer to another question than the pending one: refused, with nothing done and the pending question kept.
        if (pendingClose === undefined || pendingClose.question !== question) return refuse({ code: "not_found" });
        const { reason } = pendingClose;
        pendingClose = undefined;
        closeAnswers.push(go);
        if (go && reason === "close") closeAsBefore();
        if (go && reason === "quit") quits += 1;
        return null;
      }
      case "forget_vault": {
        const row = vaultRefOf(exactly(args, ["vault"]).vault);
        const open = [...live.entries()].find(([session, entry]) => entry.unlocked && sessionVault.get(session) === row);
        // A job of that vault's open session is running: the Remove is refused, and nothing changes.
        if (open !== undefined && [...running.values()].some((job) => job.scope.type === "session" && job.scope.session === open[0])) {
          return refuse({ code: "busy", what: "operation in progress" });
        }
        // The list write fails after the lock: the vault is locked, still listed, and the answer is the refusal.
        if (forgetFailsAfterLock !== undefined) {
          const error = forgetFailsAfterLock;
          forgetFailsAfterLock = undefined;
          if (open !== undefined) lock(open[0], "manual");
          return refuse(error);
        }
        // An open vault is locked first (its lock event goes out), then it comes off the list. The high-water mark stays, so its ID is never given again.
        if (open !== undefined) lock(open[0], "manual");
        vaults.splice(vaults.indexOf(row), 1);
        return null;
      }
      case "show_vault_in_explorer": {
        const row = vaultRefOf(exactly(args, ["vault"]).vault);
        if (!(row.available ?? true)) return refuse({ code: "not_found" });
        if (row.notAFolder ?? false) return refuse({ code: "invalid_input", what: "folder" });
        if (explorerFails) {
          explorerFails = false;
          return refuse({ code: "core", kind: "io" });
        }
        openedVaults.push(row.id);
        return null;
      }
      case "lock_vault": {
        const { session } = exactly(args, ["session"]) as { session: number };
        lock(session);
        return null;
      }
      case "lock_all":
        exactly(args ?? {}, []);
        for (const session of [...live.keys()]) lock(session);
        // Every all-vault lock empties the slot, even with no vault open, and moves the lock epoch (which drops what the launch holds).
        emptySlot();
        bumpEpoch();
        return null;
      default:
        throw new Error(`the fake shell has no command ${cmd}`);
    }
  };

  /**
   * Test a backup, as the shell does it: the arguments are checked and the credential read as one box's (`password_or_key`); a choice that is not held
   * is `choice_expired`; only then does the job begin (launch-scoped, kind `test`, `lockbox://job-started` before the answer). It ends when the answer is
   * decided (held until released with `holdTest`): a Cancel answers `cancelled`; a lock epoch that moved meanwhile refuses `locked`; a wrong password is
   * `wrong_password`; a damaged backup is `damaged` with the first failing `what`; else the summary. The choice is kept by every one of these.
   */
  const testBackupCommand = (args: unknown): Promise<unknown> => {
    const sent = exactly(args, ["choice", "credential", "request"]);
    const request = requestOf(sent);
    const credential = sent.credential;
    if (typeof credential !== "object" || credential === null || Object.keys(credential).join() !== "password_or_key") return refuse(MALFORMED);
    const text = (credential as { password_or_key?: unknown }).password_or_key;
    if (typeof text !== "string" || typeof sent.choice !== "string") return refuse(MALFORMED);
    const held = testHeld.get(sent.choice);
    if (held === undefined) return refuse(CHOICE_EXPIRED);
    const epoch = lockEpoch;
    nextOperation += 1;
    const job: RunningJob = {
      request,
      operation: nextOperation,
      scope: { type: "launch", epoch },
      kind: "test",
      done: 0,
      total: held.size,
      cancel: () => undefined,
    };
    running.set(job.operation, job);
    const startedEvent = { request, operation: job.operation, scope: job.scope, kind: job.kind };
    if (heldStarts === undefined) emit("lockbox://job-started", startedEvent);
    else heldStarts.push(() => {
      emit("lockbox://job-started", startedEvent);
    });
    return new Promise((resolve, reject) => {
      let settled = false;
      const end = (cancelled: boolean): void => {
        if (settled) return;
        settled = true;
        if (running.delete(job.operation)) {
          if (!cancelled) job.done = job.total;
          emit("lockbox://progress", { operation: job.operation, scope: job.scope, kind: job.kind, done: job.done, total: job.total, finished: true });
        }
        const found = ((): { refused: object } | { done: object } => {
          if (cancelled) return { refused: { code: "cancelled" } };
          if (lockEpoch !== epoch) return { refused: LOCKED };
          if (text !== held.password) return { refused: WRONG_PASSWORD };
          if (damage !== undefined) {
            const { what } = damage;
            damage = undefined;
            return { refused: { code: "core", kind: "damaged", ...(what === undefined ? {} : { what }) } };
          }
          return { done: { created_at: "2026-10-02T12:00:00Z", items: 24, files: 6, missing_files: 0, size_on_disk: held.size, ...summaryMade } };
        })();
        if ("refused" in found) {
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- Tauri rejects with the plain object
          reject(found.refused);
        } else {
          resolve({ Done: found.done });
        }
      };
      job.cancel = () => {
        end(true);
      };
      if (heldTests === undefined) end(false);
      else heldTests.push(() => {
        end(false);
      });
    });
  };

  /**
   * Open a backup read-only, as the shell does it: the arguments are checked and the credential read as one box's (`password_or_key`); a choice that is not
   * held (or is a test's) is `choice_expired`, before anything; only then does the job begin (launch-scoped, kind `open_backup`, `lockbox://job-started` before
   * the answer). It ends when the answer is decided (held until released with `holdOpen`): a Cancel answers `cancelled`; a lock epoch that moved meanwhile
   * refuses `locked` (the choice went with it); a wrong password is `wrong_password`; a damaged backup is `damaged`; else the backup is a read-only session whose
   * name is the file's name without `.lockbox-backup`, and the choice is used up. A wrong password, damage and a Stop keep the choice. A backup that is open
   * already is answered as it is (and its choice is used up too).
   */
  const openBackupCommand = (args: unknown): Promise<unknown> => {
    const sent = exactly(args, ["choice", "credential", "request"]);
    const request = requestOf(sent);
    const credential = sent.credential;
    if (typeof credential !== "object" || credential === null || Object.keys(credential).join() !== "password_or_key") return refuse(MALFORMED);
    const text = (credential as { password_or_key?: unknown }).password_or_key;
    if (typeof text !== "string" || typeof sent.choice !== "string") return refuse(MALFORMED);
    const token = sent.choice;
    const held = openHeld.get(token);
    if (held === undefined) return refuse(CHOICE_EXPIRED);
    const epoch = lockEpoch;
    nextOperation += 1;
    const job: RunningJob = {
      request,
      operation: nextOperation,
      scope: { type: "launch", epoch },
      kind: "open_backup",
      done: 0,
      total: held.size,
      cancel: () => undefined,
    };
    running.set(job.operation, job);
    const startedEvent = { request, operation: job.operation, scope: job.scope, kind: job.kind };
    if (heldStarts === undefined) emit("lockbox://job-started", startedEvent);
    else heldStarts.push(() => {
      emit("lockbox://job-started", startedEvent);
    });
    return new Promise((resolve, reject) => {
      let settled = false;
      const end = (cancelled: boolean): void => {
        if (settled) return;
        settled = true;
        if (running.delete(job.operation)) {
          if (!cancelled) job.done = job.total;
          emit("lockbox://progress", { operation: job.operation, scope: job.scope, kind: job.kind, done: job.done, total: job.total, finished: true });
        }
        if (cancelled) {
          rejectPlain(reject, { code: "cancelled" });
          return;
        }
        if (lockEpoch !== epoch) {
          // The lock took the choice with it.
          openHeld.delete(token);
          rejectPlain(reject, LOCKED);
          return;
        }
        if (text !== held.password) {
          rejectPlain(reject, WRONG_PASSWORD);
          return;
        }
        if (damage !== undefined) {
          const { what } = damage;
          damage = undefined;
          rejectPlain(reject, { code: "core", kind: "damaged", ...(what === undefined ? {} : { what }) });
          return;
        }
        // The choice is used up by a session opened, and by one that was open already.
        openHeld.delete(token);
        const already = [...backupSessions].find(([session, name]) => name === held.name && live.get(session)?.unlocked === true);
        if (already !== undefined) {
          const state = live.get(already[0]);
          if (state !== undefined) {
            resolve({ Done: tagged(state.session, state.generation, infoOf(sessionVault.get(state.session) as FakeVault, state.session, state.generation)) });
            return;
          }
        }
        const vault: FakeVault = {
          id: -(nextSession + 1),
          name: held.name.replace(/\.lockbox-backup$/, ""),
          password: held.password,
          readOnly: true,
          kind: "backup",
          items: (backupItems ?? sampleItems()).map((one) => ({ ...one, missingFiles: one.missingFiles === undefined ? undefined : [...one.missingFiles] })),
        };
        nextSession += 1;
        const entry: Live = { session: nextSession, generation: 1, unlocked: true };
        live.set(nextSession, entry);
        sessionVault.set(nextSession, vault);
        backupSessions.set(nextSession, held.name);
        resolve({ Done: tagged(nextSession, entry.generation, infoOf(vault, nextSession, entry.generation)) });
      };
      job.cancel = () => {
        end(true);
      };
      if (heldOpens === undefined) end(false);
      else heldOpens.push(() => {
        end(false);
      });
    });
  };

  /** Rejects as Tauri does, with the plain object the refusal was serialised to. */
  const rejectPlain = (reject: (reason?: unknown) => void, error: object): void => {
    reject(error);
  };

  /**
   * 24a's check of the picked backup, as the shell does it: the arguments are checked and the credential read as one box's; a pick that is not held is
   * `choice_expired`, before anything; only then does the job begin (launch-scoped, kind `restore_check`, `lockbox://job-started` under the page's
   * request, no progress). It ends when the answer is decided (held until released with `holdRestoreCheck`): a Cancel answers `cancelled` and keeps the pick
   * and no result; otherwise the answer is the check's own (a wrong password, damage, or what was found).
   */
  const restoreCheckCommand = (args: unknown): Promise<unknown> => {
    const sent = exactly(args, ["choice", "credential", "request"]);
    const request = requestOf(sent);
    const credential = sent.credential;
    if (typeof credential !== "object" || credential === null || Object.keys(credential).join() !== "password_or_key") return refuse(MALFORMED);
    if (typeof (credential as { password_or_key?: unknown }).password_or_key !== "string" || typeof sent.choice !== "string") return refuse(MALFORMED);
    if (!restoreHeld.has(sent.choice)) return refuse(CHOICE_EXPIRED);
    const epoch = lockEpoch;
    nextOperation += 1;
    const job: RunningJob = {
      request,
      operation: nextOperation,
      scope: { type: "launch", epoch },
      kind: "restore_check",
      done: 0,
      total: 0,
      cancel: () => undefined,
    };
    running.set(job.operation, job);
    const startedEvent = { request, operation: job.operation, scope: job.scope, kind: job.kind };
    if (heldStarts === undefined) emit("lockbox://job-started", startedEvent);
    else heldStarts.push(() => {
      emit("lockbox://job-started", startedEvent);
    });
    return new Promise((resolve, reject) => {
      let settled = false;
      const end = (cancelled: boolean): void => {
        if (settled) return;
        settled = true;
        running.delete(job.operation);
        if (cancelled) {
          // The pick stays, and what the check would have found is not kept.
          rejectPlain(reject, { code: "cancelled" });
          return;
        }
        try {
          resolve(answer("restore_check", args));
        } catch (error) {
          rejectPlain(reject, error as object);
        }
      };
      job.cancel = () => {
        end(true);
      };
      if (heldRestoreChecks === undefined) end(false);
      else heldRestoreChecks.push(() => {
        end(false);
      });
    });
  };

  /** One long step of a restore as a launch-scoped job of kind `restore`: `job-started` goes out as the command begins, as it does for a test. */
  const restoreJob = (request: number, total: number, pastTheSwap: boolean): { job: RunningJob; epoch: number } => {
    const epoch = lockEpoch;
    nextOperation += 1;
    const job: RunningJob = {
      request,
      operation: nextOperation,
      scope: { type: "launch", epoch },
      kind: "restore",
      done: 0,
      total,
      cancel: () => undefined,
      ...(pastTheSwap ? { pastTheSwap: true } : {}),
    };
    running.set(job.operation, job);
    const startedEvent = { request, operation: job.operation, scope: job.scope, kind: job.kind };
    if (heldStarts === undefined) emit("lockbox://job-started", startedEvent);
    else heldStarts.push(() => {
      emit("lockbox://job-started", startedEvent);
    });
    return { job, epoch };
  };

  /** The copy, from the pick the shell holds: ends as a Cancel, a lock epoch, a refusal of its own or its finish decide, and forgets the pick unless refused. */
  const restoreCopy = (choice: string, request: number): Promise<unknown> => {
    const checked = restoreHeld.get(choice)?.checked;
    if (checked === undefined) return refuse(CHOICE_EXPIRED);
    const size = restoreHeld.get(choice)?.size ?? 0;
    const { job, epoch } = restoreJob(request, size, false);
    return new Promise((resolve, reject) => {
      let settled = false;
      const end = (cancelled: boolean): void => {
        if (settled) return;
        settled = true;
        if (running.delete(job.operation)) {
          if (!cancelled) job.done = job.total;
          emit("lockbox://progress", { operation: job.operation, scope: job.scope, kind: job.kind, done: job.done, total: job.total, finished: true });
        }
        if (cancelled) {
          // A Stop lets the pick go.
          restoreHeld.delete(choice);
          rejectPlain(reject, { code: "cancelled" });
        } else if (lockEpoch !== epoch) {
          rejectPlain(reject, LOCKED);
        } else if (restoreCopyRefusal !== undefined) {
          const refusal = restoreCopyRefusal;
          restoreCopyRefusal = undefined;
          // The archive that was opened is not the one that was checked: nothing is copied, and the shell forgets the pick (and the credential with it).
          const changed = (refusal as { what?: unknown }).what === "backup changed";
          if (changed) restoreHeld.delete(choice);
          rejectPlain(reject, refusal);
        } else {
          // The copy is made: the prepared restore holds what it needs, so the pick goes. Its name is the archive's the copy opened.
          restoreHeld.delete(choice);
          nextRestore += 1;
          const name = restoreCopyName ?? checked.name;
          restoreCopyName = undefined;
          restorePrepared.set(nextRestore, { name, replaces: checked.replaces, keptAs: checked.keptAs, ended: false });
          // The vault it replaces, as its place on the list (the swap's own find: the one with the archive's name, else the first).
          const replaced = checked.replaces ? (vaults.find((v) => v.name === name) ?? vaults[0])?.id ?? null : null;
          const view = {
            Done: { restore: nextRestore, name, replaces_existing: checked.replaces, kept_as: checked.replaces ? checked.keptAs : null, replaces: replaced },
          };
          // The answer can be on its way when a lock lands: the copy is done and the shell has decided, but the page has not heard.
          if (heldRestoreAnswers === undefined) resolve(view);
          else heldRestoreAnswers.push(() => {
            resolve(view);
          });
        }
      };
      job.cancel = () => {
        end(true);
      };
      if (heldRestoreCopies === undefined) end(false);
      else heldRestoreCopies.push(() => {
        end(false);
      });
    });
  };

  /** `restore_prepare` and its confirm: the question first when one is set, else the copy. */
  const restorePrepareCommand = (cmd: string, args: unknown): Promise<unknown> => {
    if (cmd === "restore_prepare") {
      const sent = exactly(args, ["choice", "request"]);
      const request = requestOf(sent);
      if (typeof sent.choice !== "string") return refuse(MALFORMED);
      const checked = restoreHeld.get(sent.choice)?.checked;
      if (checked === undefined) return refuse(CHOICE_EXPIRED);
      if (restoreRecovery !== undefined) return recoveryAnswer();
      if (restoreQuestion !== undefined) {
        const kind = restoreQuestion;
        restoreQuestion = undefined;
        nextToken += 1;
        const token = `restore-token-${String(nextToken)}`;
        restoreAsked.set(token, sent.choice);
        return Promise.resolve({
          Confirm: kind === "cloud" ? { CloudFolder: { token, provider: "Other" } } : { NewFolder: { suggested: `${checked.name} (restored)`, token } },
        });
      }
      return restoreCopy(sent.choice, request);
    }
    const sent = exactly(args, ["token", "name", "request"]);
    const request = requestOf(sent);
    if (typeof sent.token !== "string" || (sent.name !== null && typeof sent.name !== "string")) return refuse(MALFORMED);
    const choice = restoreAsked.get(sent.token);
    if (choice === undefined) return refuse(CHOICE_EXPIRED);
    restoreAsked.delete(sent.token);
    if (restoreRecovery !== undefined) return recoveryAnswer();
    restoreNames.push(sent.name);
    return restoreCopy(choice, request);
  };

  /** An unfinished restore's journal is still there: the shell ran its recovery and answers what it found, instead of a copy. */
  const recoveryAnswer = (): Promise<unknown> => {
    const notice = restoreRecovery;
    restoreRecovery = undefined;
    restoreNoticeNow = notice;
    return Promise.resolve({ Confirm: { Recovery: { notice } } });
  };

  /** The swap: a job with progress and no Stop. It ends the vault it replaces (that vault locks, reason `restore`) or adds the restored one to the list. */
  const restoreCommitCommand = (args: unknown): Promise<unknown> => {
    const sent = exactly(args, ["restore", "request"]);
    const request = requestOf(sent);
    if (typeof sent.restore !== "number") return refuse(MALFORMED);
    const copy = restorePrepared.get(sent.restore);
    if (copy === undefined || copy.ended) return refuse({ code: "cancelled" });
    const { job } = restoreJob(request, 1, true);
    emit("lockbox://progress", { operation: job.operation, scope: job.scope, kind: job.kind, done: 0, total: 1, finished: false });
    return new Promise((resolve, reject) => {
      const end = (): void => {
        running.delete(job.operation);
        job.done = 1;
        emit("lockbox://progress", { operation: job.operation, scope: job.scope, kind: job.kind, done: 1, total: 1, finished: true });
        if (restoreCommitRefusal !== undefined) {
          const refusal = restoreCommitRefusal;
          restoreCommitRefusal = undefined;
          rejectPlain(reject, refusal);
          return;
        }
        restorePrepared.delete(sent.restore as number);
        let vaultId: number;
        if (copy.replaces) {
          const target = vaults.find((v) => v.name === copy.name) ?? vaults[0];
          if (target === undefined) {
            rejectPlain(reject, { code: "cancelled" });
            return;
          }
          target.password = BACKUP_PASSWORD;
          vaultId = target.id;
          for (const [session] of [...live.entries()]) if (sessionVault.get(session) === target) lock(session, "restore");
        } else {
          vaultId = nextVaultId();
          vaults.push({ id: vaultId, name: copy.name, password: BACKUP_PASSWORD, items: [] });
        }
        resolve({ vault: vaultId, before_restore: copy.replaces });
      };
      if (heldRestoreSwaps === undefined) end();
      else heldRestoreSwaps.push(end);
    });
  };

  invoke.mockImplementation((cmd: string, args?: unknown) => {
    calls.push({ cmd, args });
    const refusal = refusals.get(cmd);
    // A stored-file command that is being held is refused when it is let go, as the shell decides it (a refusal that comes late).
    const heldFile = heldFiles !== undefined && Object.hasOwn(OPERATION, cmd);
    if (refusal !== undefined && !heldFile) {
      refusals.delete(cmd);
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- Tauri rejects with the plain object
      return Promise.reject(refusal);
    }
    if (cmd === "test_backup") {
      try {
        return testBackupCommand(args);
      } catch (error) {
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- Tauri rejects with the plain object
        return Promise.reject(error);
      }
    }
    if (cmd === "copy_item_to" && heldCopies !== undefined) {
      // Decided (and written) now, as the shell does; the answer comes when it is let go.
      const waiting = heldCopies;
      try {
        const decided = answer(cmd, args);
        return new Promise((resolve) => {
          waiting.push(() => {
            resolve(decided);
          });
        });
      } catch (error) {
        return new Promise((_, reject) => {
          waiting.push(() => {
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- Tauri rejects with the plain object
            reject(error);
          });
        });
      }
    }
    if (cmd === "open_backup_read_only") {
      try {
        return openBackupCommand(args);
      } catch (error) {
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- Tauri rejects with the plain object
        return Promise.reject(error);
      }
    }
    if (cmd === "restore_prepare" || cmd === "restore_prepare_confirm" || cmd === "restore_commit") {
      try {
        return cmd === "restore_commit" ? restoreCommitCommand(args) : restorePrepareCommand(cmd, args);
      } catch (error) {
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- Tauri rejects with the plain object
        return Promise.reject(error);
      }
    }
    const heldOlder =
      cmd === "list_pre_restore"
        ? heldOlderListings
        : cmd === "open_pre_restore_read_only"
          ? heldOlderOpens
          : cmd === "delete_pre_restore"
            ? heldOlderDeletes
            : undefined;
    if (heldOlder !== undefined) {
      // Decided when it is let go.
      return new Promise((resolve, reject) => {
        heldOlder.push(() => {
          try {
            resolve(answer(cmd, args));
          } catch (error) {
            rejectPlain(reject, error as object);
          }
        });
      });
    }
    const heldRecover = cmd === "recover_check" ? heldRecoverChecks : cmd === "recover_finish" ? heldRecoverFinishes : undefined;
    if (heldRecover !== undefined) {
      // Decided as the command arrives (a choice parked, a password written, a lock that came with it); the answer reaches the page at release.
      try {
        const decided = answer(cmd, args);
        return new Promise((resolve) => {
          heldRecover.push(() => {
            resolve(decided);
          });
        });
      } catch (error) {
        return new Promise((_, reject) => {
          heldRecover.push(() => {
            rejectPlain(reject, error as object);
          });
        });
      }
    }
    if (cmd === "restore_check") {
      // A job of its own; unlocking the backup takes a moment when it is held: it is decided when it is let go.
      try {
        return restoreCheckCommand(args);
      } catch (error) {
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- Tauri rejects with the plain object
        return Promise.reject(error);
      }
    }
    if ((cmd === "test_backup_pick" || cmd === "open_backup_pick" || cmd === "restore_pick") && heldPicker !== undefined) {
      // The picker stays open: the pick is made when it closes.
      const waiting = heldPicker;
      return new Promise((resolve, reject) => {
        waiting.push(() => {
          try {
            resolve(answer(cmd, args));
          } catch (error) {
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- Tauri rejects with the plain object
            reject(error);
          }
        });
      });
    }
    if (
      heldPrint !== undefined &&
      (cmd === "save_recovery_pdf" ||
        cmd === "print_recovery_key" ||
        cmd === "save_readable_confirm" ||
        cmd === "env_save_file" ||
        cmd === "export_csv" ||
        cmd === "export_repick")
    ) {
      // Decided when released, as the shell does: a lock in between leaves no file, and the answer is a refusal.
      const waiting = heldPrint;
      return new Promise((resolve, reject) => {
        waiting.push(() => {
          try {
            resolve(answer(cmd, args));
          } catch (error) {
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- Tauri rejects with the plain object
            reject(error);
          }
        });
      });
    }
    if (cmd === "capture_choose" && heldCaptureChoose !== undefined) {
      // Done when released: until then the shell has not handed the copy to the vault.
      const waiting = heldCaptureChoose;
      return new Promise((resolve, reject) => {
        waiting.push(() => {
          try {
            resolve(answer(cmd, args));
          } catch (error) {
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- Tauri rejects with the plain object
            reject(error);
          }
        });
      });
    }
    if (cmd === "capture_unchoose" && heldCaptureUnchoose !== undefined) {
      // The next one only, and done when released: until then the shell still holds the copy for the vault it was handed to, and a copy that replaces it inherits that.
      const waiting = heldCaptureUnchoose;
      heldCaptureUnchoose = undefined;
      return new Promise((resolve, reject) => {
        waiting.push(() => {
          try {
            resolve(answer(cmd, args));
          } catch (error) {
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- Tauri rejects with the plain object
            reject(error);
          }
        });
      });
    }
    if (heldFiles !== undefined && Object.hasOwn(OPERATION, cmd)) {
      // The vault is working from the moment the command arrives; the answer is decided when it is let go.
      const waiting = heldFiles;
      // A command that carries a session names it; the cloud question's yes names it by the copy it parked.
      const parkedFor = typeof args === "object" && args !== null && "token" in args ? pendingPdfs.get(args.token as string) : undefined;
      // A save's start carries only its choice and request: the session is the plan's, and it is checked, and the choice used up, before its job starts.
      let run: SaveRun | undefined;
      if (cmd === "save_all_start") {
        try {
          run = startSave(args);
        } catch (error) {
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- Tauri rejects with the plain object
          return Promise.reject(error);
        }
        saveRuns.set((args as { request: number }).request, run);
      }
      const session = typeof args === "object" && args !== null && "session" in args ? (args.session as number) : (parkedFor?.session ?? run?.session ?? null);
      // A command that takes a request becomes a job in the table once its work starts, and the page is told before the first progress and the answer.
      const request = typeof args === "object" && args !== null && "request" in args && typeof args.request === "number" ? args.request : undefined;
      const generation = typeof args === "object" && args !== null && "generation" in args ? (args.generation as number) : (parkedFor?.generation ?? run?.generation);
      // A batch is checked, and its choice used up, before its job starts: a refusal then starts no job and sends no `job-started`.
      let batch: Batch | undefined;
      if (cmd === "add_files") {
        try {
          batch = startBatch(args);
        } catch (error) {
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- Tauri rejects with the plain object
          return Promise.reject(error);
        }
        if (request !== undefined) batches.set(request, batch);
      }
      let job: RunningJob | undefined;
      if (Object.hasOwn(JOB_KIND, cmd) && request !== undefined && session !== null && generation !== undefined) {
        nextOperation += 1;
        job = {
          request,
          operation: nextOperation,
          scope: { type: "session", session, generation },
          kind: JOB_KIND[cmd] ?? "import",
          done: 0,
          total: run?.total ?? batch?.total ?? 0,
          cancel: () => undefined,
        };
        running.set(job.operation, job);
        emit("lockbox://job-started", { request, operation: job.operation, scope: job.scope, kind: job.kind });
      }
      emit("lockbox://busy", { session, operations: [OPERATION[cmd]] });
      return new Promise((resolve, reject) => {
        const settle = (): void => {
          const late = refusals.get(cmd);
          if (late !== undefined) {
            refusals.delete(cmd);
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- Tauri rejects with the plain object
            reject(late);
            return;
          }
          try {
            resolve(answer(cmd, args));
          } catch (error) {
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- Tauri rejects with the plain object
            reject(error);
          }
        };
        let settled = false;
        const end = (cancelled: boolean): void => {
          if (settled) return;
          settled = true;
          // The job's last event says it ended, with the whole of it done on success; a lock has already sent its own.
          if (job !== undefined && running.delete(job.operation)) {
            if (!cancelled) job.done = job.total;
            emit("lockbox://progress", { operation: job.operation, scope: job.scope, kind: job.kind, done: job.done, total: job.total, finished: true });
          }
          emit("lockbox://busy", { session, operations: [] });
          if (cancelled && batch !== undefined && request !== undefined) {
            // A Stop on a batch is not a refusal: the files before it stay stored, and the answer says what went in and what did not.
            batches.delete(request);
            try {
              vaultFor(batch.session, batch.generation);
              resolve(tagged(batch.session, batch.generation, { Done: finishBatch(batch, job?.done ?? 0) }));
            } catch (error) {
              // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- Tauri rejects with the plain object
              reject(error);
            }
            return;
          }
          if (cancelled && run !== undefined && request !== undefined) {
            // A Stop on a save is a result too: the files before it stay written, and the answer names the one it caught and those not started.
            saveRuns.delete(request);
            try {
              vaultFor(run.session, run.generation);
              resolve(tagged(run.session, run.generation, { Done: finishSave(run, job?.done ?? 0) }));
            } catch (error) {
              // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- Tauri rejects with the plain object
              reject(error);
            }
            return;
          }
          if (cancelled) {
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- Tauri rejects with the plain object
            reject({ code: "cancelled" });
            return;
          }
          settle();
        };
        if (job !== undefined) {
          job.cancel = () => {
            end(true);
          };
        }
        waiting.push(() => {
          end(false);
        });
      });
    }
    try {
      const result = answer(cmd, args);
      if (cmd === "capture_state" && heldCaptureState !== undefined) {
        const waiting = heldCaptureState;
        return new Promise((resolve) => {
          waiting.push(() => {
            resolve(result);
          });
        });
      }
      if (cmd === "list_printers" && heldPrinterList !== undefined) {
        const waiting = heldPrinterList;
        // Asked when released, so a list changed in between is the one that is read.
        return new Promise((resolve) => {
          waiting.push(() => {
            resolve(answer(cmd, args));
          });
        });
      }
      for (const [name, waiting] of [
        ["retry_open_cleanup", heldRetry],
        ["get_item", heldGetItem],
        ["set_settings", heldSettings],
        ["start_new_vault_list", heldStartList],
        ["change_password", heldChange],
        ["rename_vault", heldRename],
        ["forget_vault", heldForget],
        ["unlock_vault", heldUnlock],
        ["create_vault", heldCreate],
        ["create_vault_confirm", heldCreate],
      ] as const) {
        if (cmd === name && waiting !== undefined) {
          return new Promise((resolve) => {
            waiting.push(() => {
              resolve(result);
            });
          });
        }
      }
      if (cmd === "list_items" && held !== undefined) {
        const release = held;
        return new Promise((resolve) => {
          release.push(() => {
            resolve(result);
          });
        });
      }
      if (cmd === "search_all" && heldSearch !== undefined) {
        const release = heldSearch;
        return new Promise((resolve) => {
          release.push(() => {
            resolve(result);
          });
        });
      }
      if ((cmd === "new_item" || cmd === "capture_save") && heldNewItem !== undefined) {
        const release = heldNewItem;
        return new Promise((resolve) => {
          release.push(() => {
            resolve(result);
          });
        });
      }
      if (cmd === "update_item" && heldUpdate !== undefined) {
        const release = heldUpdate;
        return new Promise((resolve) => {
          release.push(() => {
            resolve(result);
          });
        });
      }
      if (
        (cmd === "trash_item" || cmd === "restore_item" || cmd === "delete_collection" || cmd === "purge_item" || cmd === "empty_trash") &&
        heldTrash !== undefined
      ) {
        const release = heldTrash;
        return new Promise((resolve) => {
          release.push(() => {
            resolve(result);
          });
        });
      }
      for (const [name, waiting] of [["env_read", heldEnvRead], ["capture_env", heldEnvRead], ["env_save", heldEnvSave]] as const) {
        if (cmd === name && waiting !== undefined) {
          return new Promise((resolve) => {
            waiting.push(() => {
              resolve(result);
            });
          });
        }
      }
      if (cmd === "capture_reveal" && heldCaptureReveal !== undefined) {
        const release = heldCaptureReveal;
        return new Promise((resolve) => {
          release.push(() => {
            resolve(result);
          });
        });
      }
      if (cmd === "reveal_password" && heldReveal !== undefined) {
        const release = heldReveal;
        return new Promise((resolve) => {
          release.push(() => {
            resolve(result);
          });
        });
      }
      return Promise.resolve(result);
    } catch (error) {
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- Tauri rejects with the plain object
      return Promise.reject(error);
    }
  });

  return {
    calls,
    copied,
    lock,
    lockWithoutEvent: (session) => {
      const entry = live.get(session);
      if (entry?.unlocked !== true) return;
      entry.unlocked = false;
      entry.generation += 1;
      for (const [token, held] of envPastes) if (held.session === session) envPastes.delete(token);
      for (const [token, parked] of pendingPdfs) if (parked.session === session) pendingPdfs.delete(token);
      for (const [token, held] of choices) if (held.session === session) choices.delete(token);
      for (const [token, held] of savePlans) if (held.session === session) savePlans.delete(token);
      for (const [token, held] of parkedSaves) if (held.session === session) parkedSaves.delete(token);
      for (const [token, held] of outputs) if (held.session === session) outputs.delete(token);
    },
    sessionOf: (vaultId) => {
      const vault = vaults.find((v) => v.id === vaultId);
      return [...live.values()].find((entry) => sessionVault.get(entry.session) === vault);
    },
    holdListItems: (newestFirst = false) => {
      const waiting: (() => void)[] = [];
      held = waiting;
      return () => {
        held = undefined;
        // Oldest first, as the shell answers; or the newest first, so an older answer comes late.
        for (const release of newestFirst ? [...waiting].reverse() : waiting) release();
      };
    },
    failPartwayNext: (cmd, writes, error) => {
      partway = { cmd, writes, error };
    },
    keyOf: (vaultId) => {
      const vault = vaults.find((v) => v.id === vaultId);
      return vault === undefined ? undefined : keys.get(vault);
    },
    unconfirmed: (vaultId) => vaults.find((v) => v.id === vaultId)?.unconfirmed ?? false,
    cloudNext: (provider = "Other") => {
      cloud = provider;
    },
    refuseMarkNext: () => {
      refuseMark = true;
    },
    nextKeyIs: (key) => {
      chosenKey = key;
      issuedKeys.add(key);
    },
    recoveryKeyOf: (vaultId) => {
      const vault = vaults.find((v) => v.id === vaultId);
      return vault === undefined ? "" : recoveryKeyOf(vault);
    },
    holdRecoverCheck: () => {
      const waiting: (() => void)[] = [];
      heldRecoverChecks = waiting;
      return () => {
        heldRecoverChecks = undefined;
        for (const release of waiting) release();
      };
    },
    holdRecoverFinish: () => {
      const waiting: (() => void)[] = [];
      heldRecoverFinishes = waiting;
      return () => {
        heldRecoverFinishes = undefined;
        for (const release of waiting) release();
      };
    },
    interruptRecoverNext: (how) => {
      interruptRecover = how;
    },
    recoveryChoiceTokens: () => [...recoveryHeld.keys()],
    expireRecoveryChoices: () => {
      recoveryHeld.clear();
    },
    nextIssueIs: (issue) => {
      chosenIssue = issue;
    },
    dismissPickerNext: () => {
      dismissPicker = true;
    },
    offerExisting: (vault) => {
      existing = vault;
    },
    damageVaultList: () => {
      listDamaged = true;
    },
    startNewListFailsAfterMoveNext: (error) => {
      failAfterMove = error;
    },
    repairVaultList: () => {
      listDamaged = false;
    },
    holdStartNewList: () => {
      const waiting: (() => void)[] = [];
      heldStartList = waiting;
      return () => {
        heldStartList = undefined;
        for (const release of waiting) release();
      };
    },
    pdfs,
    exports: exportsWritten,
    dismissPdfNext: () => {
      dismissPdf = true;
    },
    cloudPdfNext: () => {
      cloudPdf += 1;
    },
    refusePrintNext: (error) => {
      printRefusal = error;
    },
    holdPrint: () => {
      const waiting: (() => void)[] = [];
      heldPrint = waiting;
      return () => {
        heldPrint = undefined;
        for (const release of waiting) release();
      };
    },
    dropParkedChoices: () => {
      pendingPdfs.clear();
      choices.clear();
      parkedSaves.clear();
      savePlans.clear();
      outputs.clear();
    },
    printed,
    setPrinters: (names, preferred = null) => {
      printers = [...names];
      defaultPrinter = preferred;
    },
    holdPrinterList: () => {
      const waiting: (() => void)[] = [];
      heldPrinterList = waiting;
      return () => {
        heldPrinterList = undefined;
        for (const release of waiting) release();
      };
    },
    setLaunchNotices: (notices) => {
      launchNotices = [...notices];
    },
    tell: (notice) => {
      launchNotices.push(notice);
      emit("lockbox://notice", notice);
    },
    outputJournalResets: () => outputResets,
    closeWindow: closeAsBefore,
    askClose: (reason, { running: kinds, pastSwap = false, restoreWaiting = false }) => {
      closeQuestions += 1;
      const event = { reason, running: kinds, past_swap: pastSwap, restore_waiting: restoreWaiting, question: closeQuestions };
      pendingClose = { reason, question: closeQuestions, event };
      emit("lockbox://close-asked", event);
      return closeQuestions;
    },
    repeatClose: () => {
      if (pendingClose !== undefined) emit("lockbox://close-asked", pendingClose.event);
    },
    closeAskedHeard: () => closeAskedHeard,
    changeLockEpoch: bumpEpoch,
    pendingClose: () => pendingClose !== undefined,
    closeAnswers: () => [...closeAnswers],
    quits: () => quits,
    sendRaw: (channel, payload) => {
      emit(channel, payload);
    },
    windowHidden: () => hidden,
    closeExplainedCalls: () => closeExplainedCalls,
    clearCopiedCalls: () => clearCopiedCalls,
    answerClearCopied: (answer) => {
      clearCopiedAnswer = answer;
    },
    markCloseExplained: () => {
      closeExplained = true;
    },
    sendEvent: (notice) => {
      emit("lockbox://notice", notice);
    },
    opened,
    holdSearch: () => {
      const waiting: (() => void)[] = [];
      heldSearch = waiting;
      return () => {
        heldSearch = undefined;
        // The newest answer first: a late answer to an older search comes after a newer one, as it can on a busy shell.
        for (const release of [...waiting].reverse()) release();
      };
    },
    setBusy: (vaultId, busy) => {
      const vault = vaults.find((v) => v.id === vaultId);
      if (vault !== undefined) vault.busy = busy;
    },
    made,
    generated,
    revealed,
    holdReveal: () => {
      const waiting: (() => void)[] = [];
      heldReveal = waiting;
      return () => {
        heldReveal = undefined;
        for (const release of waiting) release();
      };
    },
    releaseOneReveal: () => {
      heldReveal?.shift()?.();
    },
    releaseNewestReveal: () => {
      heldReveal?.pop()?.();
    },
    holdNewItem: () => {
      const waiting: (() => void)[] = [];
      heldNewItem = waiting;
      return () => {
        heldNewItem = undefined;
        for (const release of waiting) release();
      };
    },
    edited,
    holdUpdate: () => {
      const waiting: (() => void)[] = [];
      heldUpdate = waiting;
      return () => {
        heldUpdate = undefined;
        for (const release of waiting) release();
      };
    },
    holdTrash: () => {
      const waiting: (() => void)[] = [];
      heldTrash = waiting;
      return () => {
        heldTrash = undefined;
        for (const release of waiting) release();
      };
    },
    refuseNext: (cmd, error) => {
      refusals.set(cmd, error);
    },
    holdChangePassword: () => {
      const waiting: (() => void)[] = [];
      heldChange = waiting;
      return () => {
        heldChange = undefined;
        for (const release of waiting) release();
      };
    },
    openedVaults,
    listIdentity: () => listId,
    replaceVaultList: (next) => {
      listId += 1;
      vaults.splice(0, vaults.length, ...next);
      lastId = Math.max(0, ...vaults.map((v) => v.id));
    },
    setAvailable: (vaultId, available) => {
      const found = vaults.find((v) => v.id === vaultId);
      if (found !== undefined) found.available = available;
    },
    driveGone: (vaultId) => {
      const found = vaults.find((v) => v.id === vaultId);
      if (found === undefined) return;
      found.available = false;
      const open = [...live.entries()].find(([session, entry]) => entry.unlocked && sessionVault.get(session) === found);
      if (open !== undefined) lock(open[0], "drive_gone");
    },
    forgetFailsAfterLockNext: (error) => {
      forgetFailsAfterLock = error;
    },
    holdForget: () => {
      const waiting: (() => void)[] = [];
      heldForget = waiting;
      return () => {
        heldForget = undefined;
        for (const release of waiting) release();
      };
    },
    holdRename: () => {
      const waiting: (() => void)[] = [];
      heldRename = waiting;
      return () => {
        heldRename = undefined;
        for (const release of waiting) release();
      };
    },
    interruptRenameNext: (how) => {
      interruptRename = how;
    },
    holdUnlock: () => {
      const waiting: (() => void)[] = [];
      heldUnlock = waiting;
      return () => {
        heldUnlock = undefined;
        for (const release of waiting) release();
      };
    },
    holdCreate: () => {
      const waiting: (() => void)[] = [];
      heldCreate = waiting;
      return () => {
        heldCreate = undefined;
        for (const release of waiting) release();
      };
    },
    interruptCreateNext: (how) => {
      interruptCreate = how;
    },
    listAlongsideNextCreate: (vault) => {
      alongside = vault;
    },
    interruptChangeNext: (how) => {
      interruptChange = how;
    },
    settings: () => ({ ...settings, shortcut: { ...settings.shortcut } }),
    settingsSaved: saved,
    holdSettings: () => {
      const waiting: (() => void)[] = [];
      heldSettings = waiting;
      return () => {
        heldSettings = undefined;
        for (const release of waiting) release();
      };
    },
    setStartup: (state) => {
      startup = { ...state };
    },
    startup: () => ({ ...startup }),
    startupReadbackFailsNext: () => {
      readbackFails = true;
    },
    fileOps,
    dismissFileNext: () => {
      dismissFile = true;
    },
    pickNext: (name, length = 2048) => {
      pickedFile = { name, length };
    },
    pickFilesNext: (files) => {
      nextPicks.push(files.map(({ name, size }) => ({ name, size })));
    },
    heldChoices: () => [...choices.values()].map((held) => held.files.map((file) => ({ ...file }))),
    setFreeSpace: (bytes) => {
      freeSpace = bytes;
    },
    unreadableFiles: (names) => {
      unreadable = [...names];
    },
    batchEndsAfter: (count, refusal) => {
      batchEnd = { count, refusal };
    },
    addedFiles,
    savedToDisk,
    savedNamesTaken: (names) => {
      takenNames = [...names];
    },
    filesGoneDuringSave: (names) => {
      goneNames = [...names];
    },
    changeFolderAfterPlanNext: () => {
      changeAfterPlan = true;
    },
    openedFolders,
    explorerFailsNext: () => {
      explorerFails = true;
    },
    helpOpened: () => helpCount,
    helpFailsNext: () => {
      helpFails = true;
    },
    heldOutputs: () => outputs.size,
    holdFiles: () => {
      const waiting: (() => void)[] = [];
      heldFiles = waiting;
      return () => {
        heldFiles = undefined;
        for (const release of waiting) release();
      };
    },
    runningJobs: () =>
      [...running.values()].flatMap(({ request, operation, scope, kind }) => (scope.type === "session" ? [{ request, operation, scope, kind }] : [])),
    runningLaunchJobs: () =>
      [...running.values()].flatMap(({ request, operation, scope, kind }) => (scope.type === "launch" ? [{ request, operation, scope, kind }] : [])),
    testChoices: () => [...testHeld.values()].map(({ name, size }) => ({ name, size })),
    testChoiceTokens: () => [...testHeld.keys()],
    pickBackupNext: (name, size = BACKUP_SIZE) => {
      nextBackupPick = { name, size };
    },
    expireTestChoices: () => {
      testHeld.clear();
    },
    backupSummary: (summary) => {
      summaryMade = { ...summaryMade, ...summary };
    },
    damageBackup: (what) => {
      damage = { what };
    },
    holdPicker: () => {
      const waiting: (() => void)[] = [];
      heldPicker = waiting;
      return () => {
        heldPicker = undefined;
        for (const release of waiting) release();
      };
    },
    holdTest: () => {
      const waiting: (() => void)[] = [];
      heldTests = waiting;
      return () => {
        heldTests = undefined;
        for (const release of waiting) release();
      };
    },
    holdJobStarted: () => {
      const waiting: (() => void)[] = [];
      heldStarts = waiting;
      return () => {
        heldStarts = undefined;
        for (const release of waiting) release();
      };
    },
    openChoices: () => [...openHeld.values()].map(({ name, size }) => ({ name, size })),
    openChoiceTokens: () => [...openHeld.keys()],
    expireOpenChoices: () => {
      openHeld.clear();
    },
    holdOpen: () => {
      const waiting: (() => void)[] = [];
      heldOpens = waiting;
      return () => {
        heldOpens = undefined;
        for (const release of waiting) release();
      };
    },
    holdCopy: () => {
      const waiting: (() => void)[] = [];
      heldCopies = waiting;
      return () => {
        heldCopies = undefined;
        for (const release of waiting) release();
      };
    },
    backupHolds: (items) => {
      backupItems = items;
    },
    backupsOpen: () => [...backupSessions].filter(([session]) => live.get(session)?.unlocked === true).map(([, name]) => name),
    sessionOfBackup: (fileName) => {
      const found = [...backupSessions].find(([session, name]) => name === fileName && live.get(session)?.unlocked === true);
      return found === undefined ? undefined : live.get(found[0]);
    },
    copiedOut,
    restorePicks: () => [...restoreHeld.values()].map(({ name, size, checked }) => ({ name, size, checked: checked !== undefined })),
    restorePickTokens: () => [...restoreHeld.keys()],
    restoreIs: (found) => {
      restoreFound = { ...restoreFound, ...found };
    },
    expireRestorePicks: () => {
      restoreHeld.clear();
    },
    holdRestoreCheck: () => {
      const waiting: (() => void)[] = [];
      heldRestoreChecks = waiting;
      return () => {
        heldRestoreChecks = undefined;
        for (const release of waiting) release();
      };
    },
    holdRestoreCopy: () => {
      const waiting: (() => void)[] = [];
      heldRestoreCopies = waiting;
      return () => {
        heldRestoreCopies = undefined;
        for (const release of waiting) release();
      };
    },
    holdRestoreSwap: () => {
      const waiting: (() => void)[] = [];
      heldRestoreSwaps = waiting;
      return () => {
        heldRestoreSwaps = undefined;
        for (const release of waiting) release();
      };
    },
    holdRestoreAnswer: () => {
      const waiting: (() => void)[] = [];
      heldRestoreAnswers = waiting;
      return () => {
        heldRestoreAnswers = undefined;
        for (const release of waiting) release();
      };
    },
    restoreCopyNames: (name) => {
      restoreCopyName = name;
    },
    restoreAsksNext: (kind) => {
      restoreQuestion = kind;
    },
    restoreCopyRefuses: (error) => {
      restoreCopyRefusal = error;
    },
    restoreCommitRefuses: (error) => {
      restoreCommitRefusal = error;
    },
    olderCopies: (copies) => {
      olderHeld = [...copies];
    },
    olderIds: () => Object.fromEntries([...olderListed].map(([id, copy]) => [copy.folder, id])),
    forgetOlderIds: () => {
      olderListed.clear();
    },
    deletedOlderCopies: () => [...olderDeleted],
    olderCopyIsOpen: (folder) => {
      olderOpenElsewhere.add(folder);
    },
    olderCopiesOpen: () => [...olderSessions].filter(([session]) => live.get(session)?.unlocked === true).map(([, folder]) => folder),
    holdOlderListing: () => {
      const waiting: (() => void)[] = [];
      heldOlderListings = waiting;
      return () => {
        heldOlderListings = undefined;
        for (const release of waiting.reverse()) release();
      };
    },
    holdOlderOpen: () => {
      const waiting: (() => void)[] = [];
      heldOlderOpens = waiting;
      return () => {
        heldOlderOpens = undefined;
        for (const release of waiting) release();
      };
    },
    holdOlderDelete: () => {
      const waiting: (() => void)[] = [];
      heldOlderDeletes = waiting;
      return () => {
        heldOlderDeletes = undefined;
        for (const release of waiting) release();
      };
    },
    preparedRestores: () => [...restorePrepared.keys()],
    discardedRestores: () => [...restoreDiscarded],
    confirmedNames: () => [...restoreNames],
    retryRestoreGives: (...answers) => {
      // The command answers the notice's own fields; the `kind` tag belongs to the event.
      for (const answer of answers) {
        const plain: Record<string, unknown> = { ...(answer as Record<string, unknown>) };
        delete plain.kind;
        retryAnswers.push(plain);
      }
    },
    restoreRecoversNext: (notice) => {
      restoreRecovery = notice;
    },
    lastBackupName: () => lastBackup?.name ?? "",
    lastBackupChoice: () => lastBackup?.choice ?? "",
    sendProgress: (operation, done, total) => {
      const job = running.get(operation);
      if (job === undefined) return;
      job.done = done;
      job.total = total;
      emit("lockbox://progress", { operation, scope: job.scope, kind: job.kind, done, total, finished: false });
    },
    retryLeaves: (stillOpen) => {
      stillOpenAfterRetry = stillOpen;
    },
    retries: () => retried,
    holdRetry: () => {
      const waiting: (() => void)[] = [];
      heldRetry = waiting;
      return () => {
        heldRetry = undefined;
        for (const release of waiting) release();
      };
    },
    holdGetItem: () => {
      const waiting: (() => void)[] = [];
      heldGetItem = waiting;
      return () => {
        heldGetItem = undefined;
        for (const release of [...waiting].reverse()) release();
      };
    },
    holdEnvRead: () => {
      const waiting: (() => void)[] = [];
      heldEnvRead = waiting;
      return () => {
        heldEnvRead = undefined;
        for (const release of waiting) release();
      };
    },
    holdEnvSave: () => {
      const waiting: (() => void)[] = [];
      heldEnvSave = waiting;
      return () => {
        heldEnvSave = undefined;
        for (const release of waiting) release();
      };
    },
    envHeld: () => envPastes.size,
    expireEnvTokens: () => {
      envPastes.clear();
    },
    envCopied,
    envFiles,
    press: (what) => {
      const text = typeof what === "object" ? what.text : null;
      const state = typeof what === "object" ? (what.text.trim() === "" ? "empty" : "value") : what;
      // The shell makes the id from the OS's random source: 32 lowercase hex characters, a new one for every press. Here a count that
      // keeps going from one fake to the next, so an id never comes up twice in a test file.
      pressesMade += 1;
      const id = `${(0xca97).toString(16)}${pressesMade.toString(16).padStart(28, "0")}`;
      const before = slot;
      const value = (made: FakeSlot | undefined) => (made?.state === "value" ? (made.text ?? "").trim() : null);
      const next: FakeSlot = { id, text: state === "value" ? text : null, state, chosen: before?.chosen ?? null, chosenGeneration: before?.chosenGeneration ?? null };
      // A copy was waiting and its value differs from this one's.
      const changed = before !== undefined && value(before) !== value(next);
      slot = next;
      emit("lockbox://capture", slotEvent(next, changed));
    },
    setClipboard: (text) => {
      clipboardText = text;
    },
    clipboard: () => clipboardText,
    failClipboardClearNext: () => {
      failClear = true;
    },
    captureSlot: () => (slot === undefined ? null : { id: slot.id, state: slot.state, chosen: slot.chosen, chosenGeneration: slot.chosenGeneration }),
    emptyCaptureSlot: emptySlot,
    forgetCaptureSlot: () => {
      slot = undefined;
    },
    holdCaptureReveal: () => {
      const waiting: (() => void)[] = [];
      heldCaptureReveal = waiting;
      return () => {
        heldCaptureReveal = undefined;
        for (const release of waiting) release();
      };
    },
    captureReveals: () => captureRevealed,
    holdCaptureState: () => {
      const waiting: (() => void)[] = [];
      heldCaptureState = waiting;
      return () => {
        heldCaptureState = undefined;
        for (const release of waiting) release();
      };
    },
    holdCaptureChoose: () => {
      const waiting: (() => void)[] = [];
      heldCaptureChoose = waiting;
      return () => {
        heldCaptureChoose = undefined;
        for (const release of waiting) release();
      };
    },
    holdCaptureUnchoose: () => {
      const waiting: (() => void)[] = [];
      heldCaptureUnchoose = waiting;
      return () => {
        heldCaptureUnchoose = undefined;
        for (const release of waiting) release();
      };
    },
  };
}
