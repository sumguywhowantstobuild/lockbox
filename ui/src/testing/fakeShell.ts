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
}

export interface FakeVault {
  id: number;
  name: string | null;
  available?: boolean;
  password?: string;
  readOnly?: boolean;
  items?: FakeItem[];
  /** The "recovery key not confirmed" mark the shell keeps for the vault's folder. */
  unconfirmed?: boolean;
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
/** What the shell sends when it cannot write the mark first (`write_state(…, "vault state")`, `TooLarge`). */
export const VAULT_STATE_REFUSED = { code: "too_large", what: "vault state" };
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

export interface FakeShell {
  /** Every command sent, in order, with its arguments. */
  calls: { cmd: string; args: unknown }[];
  /** Every `copy_field` that reached the shell, as it was sent. */
  copied: Record<string, unknown>[];
  /** Sends `lockbox://locked` for the session and moves its generation on, as a lock does. */
  lock(session: number, reason?: string): void;
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
  cloudNext(): void;
  /** The next create or new key finds the mark can't be written: nothing is made, the shell refuses. */
  refuseMarkNext(): void;
  /** The next key the shell makes is this one (a test of a key with a repeated word needs one the fake would not make). */
  nextKeyIs(key: string): void;
  /** The next folder picker (create with `choose_folder`, add existing) is closed without a choice. */
  dismissPickerNext(): void;
  /** The vault the next `add_existing_vault` finds in the folder the person picks. */
  offerExisting(vault: FakeVault): void;
  /** The folders a recovery key PDF was saved in, in order (a PDF the shell never wrote is not here). */
  pdfs: string[];
  /** The next Save as PDF is closed without a choice. */
  dismissPdfNext(): void;
  /** The next Save as PDF finds a cloud-synced folder and asks first. Each call is one more question. */
  cloudPdfNext(): void;
  /** The next Save as PDF or Print is refused with this. */
  refusePrintNext(error: object): void;
  /** Holds every print command's answer until `release` is called (the PDF is still being made, the job is on its way). */
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
   * Holds every answer of `trash_item`, `restore_item`, `delete_collection` and `purge_item` until `release` is called: the
   * change is made when the command arrives, as the shell writes it, and the answer is read later, so a lock or another click in
   * between leaves an answer tagged with the generation from before.
   */
  holdTrash(): () => void;
}

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

/** Refuses as the shell does: Tauri rejects with the plain object the error was serialised to, not an `Error`. */
function refuse(error: object): never {
  // eslint-disable-next-line @typescript-eslint/only-throw-error -- see above
  throw error;
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
  settings = { idle_minutes: 5, clipboard_seconds: 30 },
): FakeShell {
  // The handlers each event has, as `listen` was given them.
  const handlers = new Map<string, ((event: { payload: unknown }) => void)[]>();
  const emit = (event: string, payload: unknown): void => {
    for (const handler of handlers.get(event) ?? []) handler({ payload });
  };
  let launchNotices: object[] = [];
  let outputResets = 0;
  // The settings file's `close_explained` (which the page never sees), whether 5b is showing, and where the window is.
  let closeExplained = false;
  let explaining = false;
  let hidden = false;
  let closeExplainedCalls = 0;
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
  let heldTrash: (() => void)[] | undefined;
  const refusals = new Map<string, object>();
  const edited: FakeShell["edited"] = [];
  const made: FakeShell["made"] = [];
  const generated: FakeShell["generated"] = [];
  const revealed: FakeShell["revealed"] = [];
  const random = randomSource(7);
  let nextItem = 0x1000;
  const keys = new Map<FakeVault, string>();
  let keysMade = 0;
  let chosenKey: string | undefined;
  let cloud = false;
  let refuseMark = false;
  let dismissPicker = false;
  let existing: FakeVault | undefined;
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
  // The save a cloud question parked: its session and generation, to go on with it (`save_readable_confirm`).
  const pendingPdfs = new Map<string, { session: number; generation: number }>();

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
    emit("lockbox://locked", { session, generation: entry.generation, reason });
  };

  /** 5b's button, or a second close while it shows: the flag is kept, `explain: false` is sent, the window hides. */
  const explained = (): void => {
    closeExplained = true;
    explaining = false;
    hidden = true;
    emit("lockbox://notice", { kind: "first_close", explain: false });
  };

  const vaultFor = (session: number, generation: number): FakeVault => {
    const entry = live.get(session);
    const vault = sessionVault.get(session);
    if (entry?.unlocked !== true || entry.generation !== generation || vault === undefined) return refuse(LOCKED);
    return vault;
  };

  const tagged = (session: number, generation: number, data: unknown) => ({ session, generation, data });

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
    return [session, state];
  };

  const infoOf = (vault: FakeVault, session: number, generation: number) => ({
    session,
    generation,
    name: vault.name ?? "",
    read_only: vault.readOnly ?? false,
    state: "unlocked",
  });

  const makeKey = (vault: FakeVault): string => {
    keysMade += 1;
    const key = chosenKey ?? fakeKey(keysMade);
    chosenKey = undefined;
    keys.set(vault, key);
    return key;
  };

  /** A create that goes through: the mark is written first, then the vault is made, listed and unlocked. */
  const created = (name: string, password: string): unknown => {
    if (refuseMark) {
      refuseMark = false;
      return refuse(VAULT_STATE_REFUSED);
    }
    const vault: FakeVault = {
      id: Math.max(0, ...vaults.map((v) => v.id)) + 1,
      name,
      password,
      items: [],
      unconfirmed: true,
    };
    vaults.push(vault);
    const [session, state] = openSession(vault);
    return {
      Done: tagged(session, state.generation, {
        info: infoOf(vault, session, state.generation),
        recovery_key: makeKey(vault),
      }),
    };
  };

  const added = (): unknown => {
    const vault = existing;
    if (vault === undefined) return refuse({ code: "not_found" });
    existing = undefined;
    vaults.push(vault);
    return { Done: { id: vault.id, name: vault.name, available: true } };
  };

  const answer = (cmd: string, args: unknown): unknown => {
    switch (cmd) {
      case "list_vaults":
        exactly(args ?? {}, []);
        return vaults.map((v) => ({ id: v.id, name: v.name, available: v.available ?? true }));
      case "get_settings":
        exactly(args ?? {}, []);
        return settings;
      case "unlock_vault": {
        const { id, password } = exactly(args, ["id", "password"]);
        const vault = vaults.find((v) => v.id === id);
        if (vault === undefined) return refuse({ code: "not_found" });
        if (password !== (vault.password ?? PASSWORD)) return refuse(WRONG_PASSWORD);
        if (vault.newer ?? false) return refuse(NEWER_VAULT);
        const [session, state] = openSession(vault);
        return tagged(session, state.generation, {
          info: infoOf(vault, session, state.generation),
          used_backup_header: vault.usedBackupHeader ?? false,
          header_mac_mismatch: vault.headerChanged ?? false,
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
        if (cloud) {
          cloud = false;
          nextToken += 1;
          const token = `create-token-${String(nextToken)}`;
          pendingCreates.set(token, { name, password });
          return { Confirm: { CloudFolder: { token } } };
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
        if (cloud) {
          cloud = false;
          nextToken += 1;
          const token = `add-token-${String(nextToken)}`;
          pendingAdds.add(token);
          return { Confirm: { CloudFolder: { token } } };
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
        // The engine writes no header while a changed one waits for the person's yes.
        if (vault.headerChanged ?? false) return refuse(ACCEPT_FIRST);
        // The mark goes first; when it can't be written no key is made.
        if (refuseMark) {
          refuseMark = false;
          return refuse(VAULT_STATE_REFUSED);
        }
        vault.unconfirmed = true;
        return tagged(session, generation, makeKey(vault));
      }
      case "accept_header": {
        const { session, generation } = exactly(args, ["session", "generation"]) as { session: number; generation: number };
        const vault = vaultFor(session, generation);
        if (vault.readOnly ?? false) return refuse({ code: "read_only" });
        vault.headerChanged = false;
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
        const { session, generation } = exactly(args, ["session", "generation"]) as { session: number; generation: number };
        const vault = vaultFor(session, generation);
        if (vault.readOnly ?? false) return refuse({ code: "read_only" });
        vault.unconfirmed = false;
        return tagged(session, generation, null);
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
          pendingPdfs.set(token, { session, generation });
          return tagged(session, generation, { Confirm: { CloudFolder: { token } } });
        }
        pdfs.push(SAVED_FOLDER);
        return tagged(session, generation, { Done: { folder: SAVED_FOLDER } });
      }
      case "save_readable_confirm": {
        const { token } = exactly(args, ["token"]) as { token: string };
        const parked = pendingPdfs.get(token);
        if (parked === undefined) return refuse({ code: "not_found" });
        pendingPdfs.delete(token);
        vaultFor(parked.session, parked.generation);
        pdfs.push(SAVED_FOLDER);
        return tagged(parked.session, parked.generation, { Done: { folder: SAVED_FOLDER } });
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
          // The engine's index: a live item's title, a login's username and links, and its folder's title.
          // At most `SEARCH_LIMIT` come back from a vault, of every kind (`commands/items.rs`), whatever the page shows.
          const found =
            needle === ""
              ? []
              : all
                  .filter(
                    (item) =>
                      !(item.trashed ?? false) &&
                      [item.title, item.username ?? "", ...(item.urls ?? []), folderTitle(item)].some((text) =>
                        text.toLowerCase().includes(needle),
                      ),
                  )
                  .slice(0, SEARCH_LIMIT);
          hits.push(tagged(session, entry.generation, found.map(summary)));
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
      case "close_explained_ok":
        exactly(args ?? {}, []);
        closeExplainedCalls += 1;
        explained();
        return null;
      case "lock_vault": {
        const { session } = exactly(args, ["session"]) as { session: number };
        lock(session);
        return null;
      }
      case "lock_all":
        exactly(args ?? {}, []);
        for (const session of [...live.keys()]) lock(session);
        return null;
      default:
        throw new Error(`the fake shell has no command ${cmd}`);
    }
  };

  invoke.mockImplementation((cmd: string, args?: unknown) => {
    calls.push({ cmd, args });
    const refusal = refusals.get(cmd);
    if (refusal !== undefined) {
      refusals.delete(cmd);
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- Tauri rejects with the plain object
      return Promise.reject(refusal);
    }
    if (heldPrint !== undefined && (cmd === "save_recovery_pdf" || cmd === "print_recovery_key" || cmd === "save_readable_confirm")) {
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
    try {
      const result = answer(cmd, args);
      if (cmd === "list_printers" && heldPrinterList !== undefined) {
        const waiting = heldPrinterList;
        // Asked when released, so a list changed in between is the one that is read.
        return new Promise((resolve) => {
          waiting.push(() => {
            resolve(answer(cmd, args));
          });
        });
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
      if (cmd === "new_item" && heldNewItem !== undefined) {
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
        (cmd === "trash_item" || cmd === "restore_item" || cmd === "delete_collection" || cmd === "purge_item") &&
        heldTrash !== undefined
      ) {
        const release = heldTrash;
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
    cloudNext: () => {
      cloud = true;
    },
    refuseMarkNext: () => {
      refuseMark = true;
    },
    nextKeyIs: (key) => {
      chosenKey = key;
    },
    dismissPickerNext: () => {
      dismissPicker = true;
    },
    offerExisting: (vault) => {
      existing = vault;
    },
    pdfs,
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
    closeWindow: () => {
      for (const session of [...live.keys()]) lock(session);
      if (explaining) {
        explained();
      } else if (closeExplained) {
        hidden = true;
      } else {
        explaining = true;
        emit("lockbox://notice", { kind: "first_close", explain: true });
      }
    },
    windowHidden: () => hidden,
    closeExplainedCalls: () => closeExplainedCalls,
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
  };
}
