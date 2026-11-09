// A stand-in for the Rust side, for the screens' tests. It answers the commands the first screens call, in the shapes
// the shell's own serialisers pin (`views.rs`, `error.rs`, `session.rs`): an answer carries its session and
// generation, a refusal is a plain object with a `code`, and a command refuses a field it does not know with the
// shell's fixed malformed-request answer. A lock changes the generation and sends `lockbox://locked` before the
// command that caused it answers, as the shell does.
import type { Mock } from "vitest";

export const PASSWORD = "correct horse battery";

export interface FakeItem {
  id: string;
  kind: "login" | "note" | "file" | "collection";
  title: string;
  username?: string | null;
  collection?: string | null;
  trashed?: boolean;
  modified_at?: string;
  notes?: string;
  urls?: string[];
  has_password?: boolean;
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

function summary(item: FakeItem) {
  return {
    id: item.id,
    kind: item.kind,
    title: item.title,
    username: item.kind === "login" ? (item.username ?? "") : null,
    collection: item.collection ?? null,
    trashed: item.trashed ?? false,
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
  holdListItems(): () => void;
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
  const calls: FakeShell["calls"] = [];
  const copied: FakeShell["copied"] = [];
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
          revision: 2,
          notes: item.notes ?? "",
          urls: item.urls ?? [],
          has_password: item.has_password ?? false,
        });
      }
      case "copy_field": {
        const sent = exactly(args, ["session", "generation", "id", "field"]) as {
          session: number;
          generation: number;
        };
        vaultFor(sent.session, sent.generation);
        copied.push(sent);
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
    holdListItems: () => {
      const waiting: (() => void)[] = [];
      held = waiting;
      return () => {
        held = undefined;
        for (const release of waiting) release();
      };
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
  };
}
