// What the page keeps of each unlocked vault: its item list, the item open in the panel, values the person asked to
// see, text typed into a form, the message about the last copy, and a recovery key being shown or picked back (with the
// questions asked of it), and what its unlock found that is still to be answered (the app's questions, `SessionAsks`).
// Beside the sessions, only what launch told, a refusal for the lock screen, and the one search (what is typed and what
// each vault found, which a lock takes away vault by vault). Nothing else. A lock wipes the lot at once: the
// store listens for `lockbox://locked` before any command is sent, and a lock event drops the vault's whole record
// (`dropSession`). An answer that comes back for a vault that has locked since is dropped without a word (it is the
// expected outcome of a lock, not an error): the bridge refuses it with `StaleAnswer`, and so does this file when the
// session it was for is gone.
import { useSyncExternalStore } from "react";
import * as api from "./api";
import { focusList } from "./focus";
import type { CopyableField, CopyTarget, FileView, ItemDetail, ItemSummary, SearchHit, VaultEntry } from "./api";
import type { Ask } from "./screens/setup/keyWords";

/** A stored file the shell refused to open or save as damaged, for the item panel to say beside that file. */
export interface FileError {
  fileId: string;
  error: unknown;
}

/** The item open in the panel: its summary row's id, and what the shell said of it once it has. */
export interface OpenItem {
  id: string;
  detail: ItemDetail | null;
  /** The shell's refusal, when it would not give the item. */
  error: unknown;
  /** A stored file of this item that did not decrypt when it was opened or saved (10d); gone when the panel is opened again. */
  fileError?: FileError | null;
  /** It was just saved from the new-login form: the panel takes focus when it opens, as the form's next step. */
  saved: boolean;
  /** It comes back from its Edit form (saved or cancelled): focus goes to Edit, the button that opened the form. */
  focusEdit: boolean;
}

/**
 * A form or tool open in the side panel instead of an item's details. What is typed into it is that form's own state, not
 * kept here: a lock takes the session's record, this with it, and the form goes with nothing saved and nothing said.
 */
export type Tool =
  /** The new-login form (6b), its title started with `title` (the search text it was opened from, or empty). */
  | { kind: "new_login"; title: string }
  /** The new-key form (7a). */
  | { kind: "new_key" }
  /** The new-note form (7b). */
  | { kind: "new_note" }
  /**
   * Paste a .env (15a to 15c). What is pasted never comes here: the panel sends it to Rust at once, and keeps only the rows' names
   * and the token the values wait under, in its own state. `opening` numbers each time it is opened, so opening it again (from another
   * folder's menu, say) is a new panel with nothing of the old one's rows or folder in it. `rows` and `folder` are for a panel opened
   * on a copy that was read in Rust already (`captureAsEnv`): the answer's names and token, and the folder the save box had chosen.
   */
  | { kind: "paste_env"; opening: number; rows?: api.EnvRows; folder?: string }
  /** The save box (8a, 8c): what the shortcut copied, to be named and saved. What is typed lives in the box; the copy is `StoreState.capture`. */
  | { kind: "save_box" }
  /**
   * The Edit form of an item (11a, and 7a, 7b and 10f for the other kinds), from the summary and the details the panel had
   * when Edit was pressed. What the form asks of Rust (the password, a key's value) and what is typed live in the form.
   */
  | { kind: "edit"; summary: ItemSummary; detail: ItemDetail }
  /** The Generator page (16a). */
  | { kind: "generator" }
  /** Settings (31a, 31b): the app's, for every vault, so a read-only vault opens it too. What it shows is `StoreState.settings`. */
  | { kind: "settings" };

/** What the new-login form sends: the person's own text, as typed. The shell completes the website and checks the limits. */
export interface LoginDraft {
  title: string;
  username: string;
  website: string;
  password: string;
  /** The folder's id, or `null` for none. */
  folder: string | null;
}

/** What the new-key form sends: the name, and the value exactly as typed or pasted. The shell checks the name and the limits. */
export interface KeyDraft {
  name: string;
  value: string;
  /** The folder's id, or `null` for none. */
  folder: string | null;
}

/** What the new-note form sends: the title and the text as typed. */
export interface NoteDraft {
  title: string;
  text: string;
  /** The folder's id, or `null` for none. */
  folder: string | null;
}

/**
 * Where a vault is in its recovery key step (21c, 21d, 21f), or `null` when it is not in one. The key is held here, like
 * the rest of a session's data, so a lock of any kind drops it with the session: nothing of it outlives the unlock it
 * was made in. Whatever the lock cuts short, the shell's "not confirmed" mark makes the next unlock start again.
 */
export type RecoveryStep =
  /** A new key has been asked for (an unlock found the mark) and has not come yet. */
  | { phase: "making" }
  /** The shell would not make the key (it could not write its mark first); the person can ask again. */
  | { phase: "failed"; error: unknown }
  /**
   * The key on screen, to be saved. `unfinished` is the key of an earlier step that never finished (21f); `missed` is
   * that a wrong pick brought the person back here.
   */
  | { phase: "show"; key: string; unfinished: boolean; missed: boolean }
  /** The key hidden, and three words to pick, one question at a time: `at` (from 0) is the one now asked. */
  | { phase: "pick"; key: string; unfinished: boolean; asks: readonly Ask[]; at: number };

/** The banners an unlock can raise, each closed with its own button (Asks 4, 5, 9 and 10). */
export type Banner = "unreadable" | "leftover" | "spare" | "cloud";

/**
 * What an unlock found that the person has not answered yet. It lives in the session's record, so a lock drops it with
 * the rest, and the next unlock is told again by the shell: the page keeps no memory that would hide a question.
 */
export interface SessionAsks {
  /** Ask 3 waits: the vault's details were changed outside Lockbox. */
  detailsChanged: boolean;
  /** The vault's recovery key was never confirmed, and its new key (21f) follows Ask 3's yes, not before. */
  keyWaits: boolean;
  /** Ask 3's answer is on its way, so a second press does nothing. */
  answering: boolean;
  /** The shell's refusal of Ask 3's answer, to say in words; the question stays. */
  detailsError: unknown;
  /** How many items can't be read (Ask 4): the unlock's count, or the item list's if that is more. */
  unreadable: number;
  /** How many leftover files the cleanup moved aside (Ask 5). */
  leftover: number;
  /** Opened from the spare copy of the vault's details (Ask 9). */
  spareDetails: boolean;
  /** The cloud service syncing the vault's folder (Ask 10), or `null`. */
  cloud: api.CloudProvider | null;
  /** The banners the person has closed since this unlock. */
  closed: Banner[];
}

const NO_ASKS: SessionAsks = {
  detailsChanged: false,
  keyWaits: false,
  answering: false,
  detailsError: null,
  unreadable: 0,
  leftover: 0,
  spareDetails: false,
  cloud: null,
  closed: [],
};

/** What launch, or a running app, told that is still to be answered; not tied to a vault. */
export interface Notices {
  /** The record of opened files is damaged (Ask 11) until the person sets it aside. */
  lostOutputs: boolean;
  /** A restore was finished at launch (the words say to unlock with the password from when the backup was made). */
  restoreFinished: boolean;
  /**
   * The window was closed for the first time: every vault is locked, the window stayed, and 5b says why Lockbox is still
   * running. It is only ever heard as an event (never at launch), and it goes with the shell's `explain: false`.
   */
  firstClose: boolean;
  /**
   * The save shortcut is off: `taken` (another app holds it) or `not_set` (it could not be turned on for another reason). Both stay until the
   * person closes the message, and are told again only when Lockbox starts again.
   */
  shortcut: "taken" | "not_set" | null;
  /** How many opened copies of stored files another program still holds after a cleanup (10e): the count of the last `open_cleanup`, 0 for none. */
  openFiles: number;
}

/**
 * The copy the save shortcut left waiting in the shell, as far as the page knows it: never its value. It is not a vault's: it can wait while
 * every vault is locked (the lock screen asks for an unlock first, 8b), and goes when the person saves or cancels, the shell lets it go (a
 * lock of the vault it was handed to, Lock all, idle) or the paste panel takes it over.
 */
export interface CaptureView {
  /** The copy's id: 32 lowercase hex characters, new for every press. A command about an older id is refused `not_found`. */
  id: string;
  /** What the clipboard held: a value, no text, or too much. The save box differs for the last two (8c). */
  state: "value" | "empty" | "too_large";
  /** How many keys the copy reads as, when it is a `.env` of one or more keys and no line that can't be read; otherwise `null`. */
  envKeys: number | null;
  /** A later press found a different value while this was waiting: the box says so and keeps what was typed. */
  changed: boolean;
  /** The session the copy was handed to (`capture_choose`), or `null` while no vault is open. */
  chosen: number | null;
}

/** One unlocked vault. */
export interface SessionData {
  session: number;
  generation: number;
  /** The vault's place on the registry's list. */
  vaultId: number;
  name: string;
  readOnly: boolean;
  /** `null` until the list has come. */
  items: ItemSummary[] | null;
  /** The shell's refusal, when it would not give the list. */
  loadError: unknown;
  openItem: OpenItem | null;
  /** The form or tool open in the panel (it and an open item are never both), or `null`. */
  tool: Tool | null;
  /** The folder shown, or `null` for All items. */
  folder: string | null;
  /** The Trash view is on screen instead of the list (then `folder` is `null`, and a picked row's panel is the Trash panel). */
  trash: boolean;
  /**
   * Values the person asked to see (a key's value or a login's password on Reveal), by item. Only the item open in the panel
   * can have one: Hide, opening an item (the same one again too), a form or another folder, or closing the panel, takes it
   * away, and a lock takes the whole record.
   */
  reveals: Record<string, string>;
  /**
   * The reveal token: a Reveal request keeps the number it was asked under, and every one of those events moves it on
   * (`endReveals`), so an answer that comes after is known to be late and is dropped.
   */
  revealEpoch: number;
  /** Text typed and not saved, by name. */
  forms: Record<string, string>;
  /** The recovery key step this vault is in, or `null`. */
  recovery: RecoveryStep | null;
  /** What the unlock found, still to be answered. */
  asks: SessionAsks;
  /**
   * The stored-file action this page began and has no answer to yet (Open, Save a copy, Replace, Attach, or Add), for the buttons to say
   * they are working and the others to wait: one at a time. A lock takes it with the record.
   */
  fileJob: FileJob | null;
  /** The long operations the shell says are running for this vault (`lockbox://busy`): while there are any, auto-lock waits and the window says so. */
  operations: string[];
}

/** What a stored-file action is doing: its kind, and the item and file it is about (`null` where there is none: Add has neither, Attach has no file). */
export interface FileJob {
  kind: "open" | "save" | "replace" | "attach" | "add";
  id: string | null;
  fileId: string | null;
}

/** The message about the last copy (or the refusal of one), save, move or restore, and the vault that made it. */
export type Toast =
  | { kind: "copied"; session: number; text: string; seconds: number; endsAt: number }
  | { kind: "saved"; session: number }
  /** A short message of its own words ("Moved to Lineproof", "Restored"): it says it once and goes after a few seconds. */
  | { kind: "said"; session: number; text: string }
  /**
   * "Moved to Trash" with Undo: `id` is the item or folder that went (held here, never found again from a title), for Undo to
   * bring back. It stays about ten seconds, and waits while the pointer or focus is on it.
   */
  | { kind: "trashed"; session: number; id: string }
  /**
   * A sentence of the page's own that the person has to read and act on (a name found twice, a file saved without encryption): it
   * stays until it is dismissed or another message takes its place, since four seconds is too short to read it.
   */
  | { kind: "told"; session: number; text: string }
  /**
   * A sentence the person is told once and puts away with "Got it" (a file opened as a read-only copy, a saved copy that is not encrypted,
   * a file added with its original still on the PC): it stays until then or until another message takes its place. It holds no file name.
   */
  | { kind: "noted"; session: number; text: string }
  | { kind: "failed"; session: number | null; error: unknown };

/** What one vault answered to the search: its results, tagged with the generation they were read in. */
export interface SearchHits {
  session: number;
  generation: number;
  items: SearchHit[];
}

/**
 * The one search (Ctrl+F, Ctrl+K), while it is open: what is typed (it is not a secret, but it never goes in a URL or a
 * log), what each unlocked vault found, the vaults that were busy, and the refusal of the last copy or open from it. It
 * is across vaults, so it lives here rather than in a session's record; a lock takes that vault's part away at once
 * (`dropSession`), and the last lock closes it.
 */
export interface SearchState {
  query: string;
  /** The word the shell last answered for, or `null` before any answer (and for a blank one): "Nothing for ..." says it. */
  answered: string | null;
  hits: SearchHits[];
  /** The sessions that were busy with a long change when asked: their results are missing. */
  busy: number[];
  /** The shell's refusal of the last search, copy or open from the search, to say in words. */
  error: unknown;
  /**
   * A question the shell asked about a file result, on screen over the search: Open on a program file (`program`), or Save a copy to a
   * cloud-synced folder (`cloud`, with the token the yes goes on with).
   */
  asking: { kind: "program"; session: number; id: string; file: FileView } | { kind: "cloud"; session: number; id: string; file: FileView; token: string } | null;
}

export interface StoreState {
  /** `null` until the vault list has come. */
  vaults: VaultEntry[] | null;
  /** The shell's refusal, when the vault list could not be read. */
  startError: unknown;
  /** The unlocked vaults, in the order they were unlocked (the last is the one on screen). */
  sessions: SessionData[];
  toast: Toast | null;
  notices: Notices;
  /** A refusal to say on the lock screen, since the vault it was about has locked (Ask 16); `null` for none. */
  lockNote: unknown;
  /** The search, or `null` while it is closed. */
  search: SearchState | null;
  /** The copy the shortcut left waiting, or `null` for none. */
  capture: CaptureView | null;
  /**
   * The app's settings as the shell has them saved: read once at the start and made current by each save (`saveSettings`). `null` until
   * they come, and when they could not be read; the screens then use `DEFAULT_SETTINGS`. Nothing secret is in them, so a lock leaves them.
   */
  settings: api.Settings | null;
}

/** What the settings are when the page has none yet: the shell's own defaults (`Settings::default`). */
export const DEFAULT_SETTINGS: api.Settings = {
  idle_minutes: 5,
  clipboard_seconds: 30,
  theme: "system",
  shortcut: { ctrl: true, shift: true, alt: false, key: 76 },
  capture_protected: true,
};

/** The page's own refusal for a lock listener that could not be set up; `messages.ts` has its words. */
const LISTENER_FAILED = { code: "page", kind: "lock_listener" };

function refusedWith(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === code;
}

/** Whether the shell refused as locked: the vault is locked and the page missed the event that said so. */
function refusedAsLocked(error: unknown): boolean {
  return refusedWith(error, "locked");
}

const EMPTY: StoreState = {
  vaults: null,
  startError: null,
  sessions: [],
  toast: null,
  notices: { lostOutputs: false, restoreFinished: false, firstClose: false, shortcut: null, openFiles: 0 },
  lockNote: null,
  search: null,
  capture: null,
  settings: null,
};

let state: StoreState = EMPTY;
const listeners = new Set<() => void>();
let started: Promise<void> | undefined;
/** Which search is the latest asked (and 0 more each time the search closes): an older answer is dropped. */
let searchRun = 0;
/** Which opening of the search is on screen: it moves on each time the search opens or closes, so a file action that began in one is known not to belong to the next. */
let searchOpening = 0;

/** A session's record with every revealed value gone and the reveal token moved on, so no request still out can show one. */
function endReveals(entry: SessionData): SessionData {
  return { ...entry, reveals: {}, revealEpoch: entry.revealEpoch + 1 };
}

function set(next: StoreState): void {
  state = next;
  for (const notify of listeners) notify();
}

function subscribe(notify: () => void): () => void {
  listeners.add(notify);
  return () => listeners.delete(notify);
}

function useSelect<T>(select: (current: StoreState) => T): T {
  return useSyncExternalStore(subscribe, () => select(state));
}

function sessionOf(session: number): SessionData | undefined {
  return state.sessions.find((entry) => entry.session === session);
}

/** Changes one session's record, when it is still there. */
function update(session: number, change: (entry: SessionData) => SessionData): void {
  if (sessionOf(session) === undefined) return;
  set({ ...state, sessions: state.sessions.map((entry) => (entry.session === session ? change(entry) : entry)) });
}

/** Whether the session is still open in the generation the caller read it in. */
function stillOpen(session: number, generation: number): boolean {
  return sessionOf(session)?.generation === generation;
}

/**
 * Begins listening for locks, and only then reads the vault list: a lock must never be missed because a command was in
 * flight first. Safe to call twice (React's strict mode does): the second call gets the first's answer.
 */
export function startStore(): Promise<void> {
  started ??= (async () => {
    try {
      await api.onLocked((event) => {
        dropSession(event.session);
      });
    } catch {
      // Without the lock listener the page could not hear a lock, so it asks the shell for nothing: no vault list, no
      // unlock. The screen says so in words (a fixed refusal of the page's own, never the listener's error).
      set({ ...state, startError: LISTENER_FAILED });
      return;
    }
    try {
      // The settings first, so the first screen is drawn in the saved theme. When they can't be read the page uses the defaults.
      const settings = await api.getSettings();
      set({ ...state, settings });
    } catch {
      // Nothing to say: the screens that read them fall back to `DEFAULT_SETTINGS`, and Settings reads them again when it opens.
    }
    try {
      set({ ...state, vaults: await api.listVaults(), startError: null });
    } catch (error) {
      set({ ...state, startError: error });
    }
  })();
  return started;
}

/** Forgets everything the page holds of the vault: the list, the open item, revealed values and typed text. */
export function dropSession(session: number): void {
  const toast = state.toast;
  const keepToast = toast === null || toast.session !== session;
  const sessions = state.sessions.filter((entry) => entry.session !== session);
  const search = state.search;
  // The search goes with the last vault, and a vault's results with the vault: nothing said, no error.
  if (sessions.length === 0) {
    searchRun += 1;
    searchOpening += 1;
  }
  set({
    ...state,
    sessions,
    toast: keepToast ? toast : null,
    search:
      search === null || sessions.length === 0
        ? null
        : {
            ...search,
            hits: search.hits.filter((found) => found.session !== session),
            busy: search.busy.filter((busy) => busy !== session),
            asking: search.asking?.session === session ? null : search.asking,
          },
  });
  // The copy that was handed to this vault goes with its lock (the shell lets it go too, and says so with `gone`): none of it stays on screen.
  if (state.capture?.chosen === session) endCapture(true);
}

/**
 * Unlocks the vault and reads its list. `"opened"` when the list is on the page; `"stale"` when the vault locked again
 * before an answer was read, which is not an error. A refusal (a wrong password) is thrown for the lock screen to say.
 */
export async function unlock(vaultId: number, password: string): Promise<"opened" | "stale"> {
  let answer;
  try {
    answer = await api.unlockVault(vaultId, password);
  } catch (error) {
    if (error instanceof api.StaleAnswer) return "stale";
    throw error;
  }
  const { info } = answer.data;
  // The recovery key of this vault was made and never confirmed by picking: the page goes straight to a new one (21f), before it
  // shows anything of the vault. A read-only copy never does (the shell says false for it).
  const unfinished = answer.data.recovery_unconfirmed && !info.read_only;
  // But Ask 3 first: the engine refuses a new key while the changed details wait for a yes, so the key waits for it.
  const details = answer.data.header_mac_mismatch;
  const record = newRecord(answer, vaultId, info, unfinished && !details ? { phase: "making" } : null, {
    ...NO_ASKS,
    detailsChanged: details,
    keyWaits: unfinished && details,
    unreadable: answer.data.cleanup.skipped_damaged,
    leftover: answer.data.cleanup.orphans_quarantined,
    spareDetails: answer.data.used_backup_header,
    cloud: answer.data.cloud,
  });
  // The vault is open: what the lock screen was still saying (a restore finished, a change saved before a lock) has been read.
  set({
    ...state,
    sessions: [...state.sessions.filter((entry) => entry.session !== record.session), record],
    notices: { ...state.notices, restoreFinished: false },
    lockNote: null,
  });
  if (unfinished && !details) void makeNewKey(record.session);
  // A copy that waited on the lock screen (8b) opens its box in this vault, and is handed to it.
  seatCapture();
  return loadItems(record);
}

function newRecord(
  answer: { session: number; generation: number },
  vaultId: number,
  info: { name: string; read_only: boolean },
  recovery: RecoveryStep | null,
  asks: SessionAsks = NO_ASKS,
): SessionData {
  return {
    session: answer.session,
    generation: answer.generation,
    vaultId,
    name: info.name,
    readOnly: info.read_only,
    items: null,
    loadError: null,
    openItem: null,
    tool: null,
    folder: null,
    trash: false,
    reveals: {},
    revealEpoch: 0,
    forms: {},
    recovery,
    asks,
    fileJob: null,
    operations: [],
  };
}

/** The page's own refusal for an answer it did not expect; `messages.ts` gives it the generic words. */
const UNEXPECTED = { code: "page", kind: "unexpected_answer" };

/** The vault list again, from the shell: after a vault was created or added. `null` when it could not be read. */
export async function refreshVaults(): Promise<VaultEntry[] | null> {
  try {
    const list = await api.listVaults();
    set({ ...state, vaults: list, startError: null });
    return list;
  } catch (error) {
    set({ ...state, startError: error });
    return null;
  }
}

/** What a create, or an add of an existing vault, came to. */
export type SetupResult =
  | "done"
  /** The vault locked, or the PC did, before the answer was read: nothing to say. */
  | "stale"
  /** The person closed the folder picker. */
  | "dismissed"
  /** A cloud-synced folder: nothing is done until the person says yes, with this token. */
  | { confirm: string };

/** Pulls the token out of a cloud-folder question, or refuses any other question (none is expected here). */
function cloudToken(question: api.Confirm): string {
  if (typeof question === "object" && "CloudFolder" in question) return question.CloudFolder.token;
  // eslint-disable-next-line @typescript-eslint/only-throw-error -- a refusal is a plain object, as the shell's are
  throw UNEXPECTED;
}

/**
 * Creates a vault and opens it on its recovery key. The vault is unlocked and marked "not confirmed" by the shell
 * before this answers; its key is on the page only here, in its session's record. If a lock overtook the answer, the
 * record is never made, and the vault list is read again so the lock screen offers the vault.
 */
export function createVault(name: string, password: string, chooseFolder: boolean): Promise<SetupResult> {
  return finishCreate(() => api.createVault(name, password, chooseFolder));
}

/** The person's yes to creating the vault in a cloud-synced folder. */
export function confirmCreateVault(token: string): Promise<SetupResult> {
  return finishCreate(() => api.createVaultConfirm(token));
}

async function finishCreate(run: () => Promise<api.Opened<api.CreatedView>>): Promise<SetupResult> {
  let answer;
  try {
    answer = await run();
  } catch (error) {
    // The vault may have been made all the same (a lock after it, or a list that wouldn't take it): read the list again.
    if (error instanceof api.StaleAnswer || refusedWith(error, "locked_after_change")) await refreshVaults();
    if (error instanceof api.StaleAnswer) return "stale";
    // A lock that ended the create before anything was made (the picker was open when Windows locked): no vault exists
    // and the person did nothing wrong, so there is nothing to say.
    if (refusedAsLocked(error)) return "stale";
    throw error;
  }
  if (answer === "Dismissed") return "dismissed";
  if ("Confirm" in answer) return { confirm: cloudToken(answer.Confirm) };
  const before = new Set((state.vaults ?? []).map((vault) => vault.id));
  const { info, recovery_key } = answer.data;
  // The vault's place on the list is not known until the list is read again; the record stands in the meantime.
  const record = newRecord(answer, -1, info, {
    phase: "show",
    key: recovery_key,
    unfinished: false,
    missed: false,
  });
  set({ ...state, sessions: [...state.sessions.filter((entry) => entry.session !== record.session), record] });
  void loadItems(record);
  const list = await refreshVaults();
  const added = (list ?? []).filter((vault) => !before.has(vault.id));
  const made = added.at(-1);
  if (made !== undefined) update(record.session, (entry) => ({ ...entry, vaultId: made.id }));
  return "done";
}

/** Adds a vault folder the person picks (21a's "I already have a vault"). */
export async function addExistingVault(): Promise<SetupResult> {
  return finishAdd(() => api.addExistingVault());
}

export function confirmAddExistingVault(token: string): Promise<SetupResult> {
  return finishAdd(() => api.addExistingVaultConfirm(token));
}

async function finishAdd(run: () => Promise<api.Outcome<VaultEntry>>): Promise<SetupResult> {
  const answer = await run();
  if (answer === "Dismissed") return "dismissed";
  if ("Confirm" in answer) return { confirm: cloudToken(answer.Confirm) };
  await refreshVaults();
  return "done";
}

/**
 * Asks the shell for a new recovery key for the unlocked vault and puts it on screen, shown once more (21f). No password
 * is asked. A refusal (the shell could not write its mark first, and so made no key) is kept for the screen to say,
 * with a way to ask again; a vault that locked meanwhile gets nothing.
 */
export async function makeNewKey(session: number): Promise<void> {
  const entry = sessionOf(session);
  if (entry === undefined || entry.readOnly) return;
  const { generation } = entry;
  update(session, (current) => ({ ...current, recovery: { phase: "making" } }));
  try {
    const answer = await api.regenerateRecovery({ session, generation });
    if (!stillOpen(session, generation)) return;
    update(session, (current) => ({
      ...current,
      recovery: { phase: "show", key: answer.data, unfinished: true, missed: false },
    }));
  } catch (error) {
    if (refusedAsLocked(error)) dropSession(session);
    if (error instanceof api.StaleAnswer || !stillOpen(session, generation)) return;
    update(session, (current) => ({ ...current, recovery: { phase: "failed", error } }));
  }
}

/** Hides the key and asks the first of `asks`, three words to pick (made by the screen, from the key's own words). */
export function startPicking(session: number, asks: readonly Ask[]): void {
  update(session, (entry) => {
    if (entry.recovery?.phase !== "show") return entry;
    const { key, unfinished } = entry.recovery;
    return { ...entry, recovery: { phase: "pick", key, unfinished, asks, at: 0 } };
  });
}

/** A right pick on question `at` that is not the last: on to the next. A second click on the same question does nothing. */
export function nextQuestion(session: number, at: number): void {
  update(session, (entry) => {
    if (entry.recovery?.phase !== "pick" || entry.recovery.at !== at) return entry;
    return { ...entry, recovery: { ...entry.recovery, at: at + 1 } };
  });
}

/** A wrong pick on question `at`: the key is shown again, with a note that says so, to start over with new words. */
export function missedPick(session: number, at: number): void {
  update(session, (entry) => {
    if (entry.recovery?.phase !== "pick" || entry.recovery.at !== at) return entry;
    const { key, unfinished } = entry.recovery;
    return { ...entry, recovery: { phase: "show", key, unfinished, missed: true } };
  });
}

/** Shows the key again, with no note: the questions are dropped, and new ones are made when the person goes on. */
export function showKeyAgain(session: number): void {
  update(session, (entry) => {
    if (entry.recovery?.phase !== "pick") return entry;
    const { key, unfinished } = entry.recovery;
    return { ...entry, recovery: { phase: "show", key, unfinished, missed: false } };
  });
}

/**
 * The three words were right: tells the shell, which clears its mark, and only then lets the key go. The key and the
 * questions are dropped on success. A refusal is thrown for the screen to say, and the step stays.
 */
export async function confirmRecovery(session: number): Promise<void> {
  const entry = sessionOf(session);
  if (entry === undefined) return;
  const { generation } = entry;
  try {
    await api.recoveryConfirmed({ session, generation });
  } catch (error) {
    if (refusedAsLocked(error)) dropSession(session);
    if (error instanceof api.StaleAnswer || !stillOpen(session, generation)) return;
    throw error;
  }
  if (!stillOpen(session, generation)) return;
  update(session, (current) => ({ ...current, recovery: null }));
}

/**
 * What saving the key's PDF came to, for the screen: the folder picker was closed (`dismissed`), the folder is a cloud
 * one and the person is asked first (`confirm` is the token to answer with), the file is written (`saved` is the folder
 * that holds it), or the vault locked meanwhile (`stale`: nothing to say, nothing was written).
 */
export type KeyPdf = "dismissed" | "stale" | { confirm: string } | { saved: string };

/**
 * Runs a print command of the key screen. A vault that locked meanwhile (the bridge's `StaleAnswer`, or the shell's
 * `locked` when the page missed the event, which also takes the vault's record away) comes back as `"stale"`; any other
 * refusal is thrown for the screen to say.
 */
async function printCommand<T>(session: number, run: (vault: api.SessionRef) => Promise<T>): Promise<T | "stale"> {
  const entry = sessionOf(session);
  if (entry === undefined) return "stale";
  const { generation } = entry;
  try {
    const answer = await run({ session, generation });
    return stillOpen(session, generation) ? answer : "stale";
  } catch (error) {
    // A stale answer says the bridge has seen a later generation than this call began in, as a `locked` refusal does: a session the
    // page still holds at the generation the call started with is dropped; one that was opened again since is left alone.
    const missedLock = refusedAsLocked(error) || (error instanceof api.StaleAnswer && stillOpen(session, generation));
    if (missedLock) dropSession(session);
    if (error instanceof api.StaleAnswer || missedLock || !stillOpen(session, generation)) return "stale";
    throw error;
  }
}

/**
 * The page's own refusal for a cloud question whose yes found nothing parked (`not_found`): the shell lets go of a parked save after
 * five minutes as well as at a lock, so it says nothing of a lock. A real lock is heard as the lock event, or as the `locked` refusal of
 * the next command, and takes the session then. Carries only the words' key, never anything the shell sent.
 */
function expiredQuestion(kind: "key_pdf_expired" | "env_file_expired" | "file_copy_expired"): Error {
  return Object.assign(new Error(kind), { code: "page", kind });
}

/**
 * What a cloud question's `not_found` means, found out by asking the shell about the session itself: a lock also lets go of a parked
 * save, and the page may have missed its event. The item list is asked for (`list_items`: the one command of a session that takes
 * nothing, changes nothing and sends nothing secret), through `printCommand`, so a `locked` refusal or a stale answer takes the session
 * off the page and comes back as `"stale"`: nothing is said. A session that is still live had only an old question: the page's refusal
 * (`expiredQuestion`) is thrown to say so. If the lookup itself fails another way, that failure is thrown to be said, and the session stays.
 */
async function whyNotFound(session: number, kind: "key_pdf_expired" | "env_file_expired" | "file_copy_expired"): Promise<"stale"> {
  const seen = await printCommand(session, (vault) => api.listItems(vault));
  if (seen === "stale") return "stale";
  throw expiredQuestion(kind);
}

function keyPdfFrom(answer: api.Tagged<api.Outcome<api.SavedView>>): KeyPdf {
  return keyPdfOf(answer.data);
}

/** What a save dialog's outcome means for the screen (the recovery key's PDF and a saved `.env` file are answered alike). */
function keyPdfOf(outcome: api.Outcome<api.SavedView>): KeyPdf {
  if (outcome === "Dismissed") return "dismissed";
  if ("Done" in outcome) return { saved: outcome.Done.folder };
  if (typeof outcome.Confirm === "object" && "CloudFolder" in outcome.Confirm) {
    return { confirm: outcome.Confirm.CloudFolder.token };
  }
  throw new Error("unexpected answer to save_recovery_pdf");
}

/** Saves the key on screen as a PDF: the shell asks where, prints the page as it shows, and writes the file. */
export async function saveKeyPdf(session: number): Promise<KeyPdf> {
  const answer = await printCommand(session, (vault) => api.saveRecoveryPdf(vault));
  return answer === "stale" ? answer : keyPdfFrom(answer);
}

/**
 * The person's yes to saving it in a cloud-synced folder: the shell goes on with the save it parked. The shell lets go of a
 * parked save at a lock and also after five minutes, so `not_found` is not news of a lock by itself: the shell is asked about the
 * session (`whyNotFound`). Locked: the session leaves the page and nothing is said (`"stale"`). Still live: the page's own refusal
 * ("that took too long, press Save as PDF again") is thrown for the screen to say, the question closes, and the session stays.
 */
export async function confirmKeyPdf(session: number, token: string): Promise<KeyPdf> {
  let answer;
  try {
    answer = await printCommand(session, () => api.saveReadableConfirm(token));
  } catch (error) {
    if (refusedWith(error, "not_found")) return whyNotFound(session, "key_pdf_expired");
    throw error;
  }
  return answer === "stale" ? answer : keyPdfFrom(answer);
}

/**
 * The printers the key can be printed to, for the picker: `"stale"` when the vault locked while Windows was being asked
 * (nothing to show). The list holds no vault data, so it is asked for without a session, but a lock still makes the
 * answer stale. Any refusal is thrown for the screen to say.
 */
export async function loadPrinters(session: number): Promise<api.PrinterList | "stale"> {
  const entry = sessionOf(session);
  if (entry === undefined) return "stale";
  const { generation } = entry;
  try {
    const list = await api.listPrinters();
    return stillOpen(session, generation) ? list : "stale";
  } catch (error) {
    if (!stillOpen(session, generation)) return "stale";
    throw error;
  }
}

/** Whether the shell refused because the printer asked for is not listed any more (so the list is out of date). */
export function refusedAsPrinterGone(error: unknown): boolean {
  return refusedWith(error, "invalid_input") && (error as { what?: unknown }).what === "printer name";
}

/** Prints the key on screen to `printer` (a name from `loadPrinters`): the shell sends the job and answers once it has it. */
export async function printKey(session: number, printer: string): Promise<"done" | "stale"> {
  const answer = await printCommand(session, (vault) => api.printRecoveryKey(vault, printer));
  return answer === "stale" ? answer : "done";
}

/**
 * The number of the latest list asked of each session. Every list load goes through `loadItems`, which takes the next number as
 * it asks and keeps an answer only while its number is still the latest: an older answer that comes after a newer one (a delayed
 * list from a move that arrives after the list from a delete) is dropped, so it can never put back what the newer one took away.
 * A lock or a new generation still wins over all of it (`stillOpen`).
 */
const listRuns = new Map<number, number>();

/**
 * Reads the vault's list again and puts it on the page, along with what depends on it: an open panel that no longer belongs (its
 * item has gone to the Trash, or is gone, outside the Trash view; or has left the Trash, in it) closes, and a value revealed in it
 * goes with it. `quiet` says a refusal of the read changes nothing on the page (a read on top of a refusal that is already being
 * said). `"stale"` when the vault locked meanwhile; an answer overtaken by a newer ask is `"opened"` and installs nothing.
 */
async function loadItems(record: SessionData, options: { quiet?: boolean } = {}): Promise<"opened" | "stale"> {
  const { session, generation } = record;
  const run = (listRuns.get(session) ?? 0) + 1;
  listRuns.set(session, run);
  const latest = () => listRuns.get(session) === run;
  try {
    const list = await api.listItems(record);
    if (!stillOpen(session, generation)) return "stale";
    if (!latest()) return "opened";
    // Items that can't be read are told at unlock (Ask 4); the list's own count counts too, whichever is more.
    update(session, (entry) => {
      const items = list.data.items;
      const open = entry.openItem;
      const row = open === null ? undefined : items.find((item) => item.id === open.id);
      const orphaned = open !== null && (row === undefined || row.trashed !== entry.trash);
      const next = {
        ...entry,
        items,
        loadError: null,
        asks: { ...entry.asks, unreadable: Math.max(entry.asks.unreadable, list.data.damaged.length) },
      };
      return orphaned ? { ...endReveals(next), openItem: null } : next;
    });
    return "opened";
  } catch (error) {
    // A lock that overtook the question: the bridge says so, and so does the shell ("locked"). If the page never heard
    // the lock, the refusal is the news of it: the vault goes.
    if (refusedAsLocked(error)) dropSession(session);
    if (error instanceof api.StaleAnswer || refusedAsLocked(error) || !stillOpen(session, generation)) return "stale";
    if (!latest() || options.quiet === true) return "opened";
    update(session, (entry) => ({ ...entry, loadError: error }));
    return "opened";
  }
}

/**
 * Locks every vault. The lock events drop their records; if one is lost on the way, the shell's answer that it has
 * locked everything drops what the page held when Lock all was pressed. A refusal is shown as a message.
 */
export async function lockEverything(): Promise<void> {
  const held = state.sessions.map((entry) => entry.session);
  try {
    await api.lockAll();
    for (const session of held) dropSession(session);
  } catch (error) {
    set({ ...state, toast: { kind: "failed", session: null, error } });
  }
}

/** Changes what the unlock found for one session, when it is still there. */
function updateAsks(session: number, change: (asks: SessionAsks) => SessionAsks): void {
  update(session, (entry) => ({ ...entry, asks: change(entry.asks) }));
}

/**
 * Ask 3's "Accept": the shell signs the vault's details again. Only then does the question close, and the new recovery
 * key (21f) that waited behind it start. A refusal is kept for the question to say, and it stays. A vault that locked
 * meanwhile (the bridge's `StaleAnswer`, or the shell's `locked` when the page missed the event) closes it with nothing
 * said. A second press while the first has no answer does nothing.
 */
export async function acceptDetails(session: number): Promise<void> {
  const entry = sessionOf(session);
  if (entry === undefined || !entry.asks.detailsChanged || entry.asks.answering) return;
  const { generation } = entry;
  updateAsks(session, (asks) => ({ ...asks, answering: true, detailsError: null }));
  try {
    await api.acceptHeader({ session, generation });
  } catch (error) {
    if (refusedAsLocked(error)) dropSession(session);
    if (error instanceof api.StaleAnswer || !stillOpen(session, generation)) return;
    updateAsks(session, (asks) => ({ ...asks, answering: false, detailsError: error }));
    return;
  }
  const now = sessionOf(session);
  if (now?.generation !== generation) return;
  const newKey = now.asks.keyWaits;
  update(session, (current) => ({
    ...current,
    asks: { ...current.asks, detailsChanged: false, keyWaits: false, answering: false, detailsError: null },
    recovery: newKey ? { phase: "making" } : current.recovery,
  }));
  if (newKey) void makeNewKey(session);
}

/**
 * Ask 3's "Lock this vault": the lock that already exists, for this vault. Its event drops the record; if the event was
 * lost on the way, the shell's answer that it has locked drops it. The question is asked again at the next unlock,
 * because the shell reports the change again, and the page keeps nothing of this answer. A refusal is kept for the
 * question to say. An answer that comes late, after the lock's event cleared this session and the vault was unlocked
 * again, belongs to the old generation and touches nothing of the new session.
 */
export async function lockThisVault(session: number): Promise<void> {
  const entry = sessionOf(session);
  if (entry === undefined || entry.asks.answering) return;
  const { generation } = entry;
  updateAsks(session, (asks) => ({ ...asks, answering: true, detailsError: null }));
  try {
    await api.lockVault(session);
  } catch (error) {
    if (error instanceof api.StaleAnswer || !stillOpen(session, generation)) return;
    if (refusedAsLocked(error)) {
      dropSession(session);
      return;
    }
    updateAsks(session, (asks) => ({ ...asks, answering: false, detailsError: error }));
    return;
  }
  if (stillOpen(session, generation)) dropSession(session);
}

/**
 * Locks one vault, from the vault menu: the lock that already exists, for this vault alone. Its event drops the record;
 * if the event was lost on the way, the shell's answer that it has locked drops it. An answer that comes late, after the
 * lock's event cleared this session and the vault was unlocked again, belongs to the old generation and touches nothing of
 * the new session. A refusal is said as a message, and the vault stays; a refusal as locked means it is locked already.
 */
export async function lockOneVault(session: number): Promise<void> {
  const entry = sessionOf(session);
  if (entry === undefined) return;
  const { generation } = entry;
  try {
    await api.lockVault(session);
  } catch (error) {
    if (error instanceof api.StaleAnswer || !stillOpen(session, generation)) return;
    if (refusedAsLocked(error)) {
      dropSession(session);
      return;
    }
    set({ ...state, toast: { kind: "failed", session, error } });
    return;
  }
  if (stillOpen(session, generation)) dropSession(session);
}

/** Closes one of an unlock's banners. It comes back at the next unlock if the shell still has it to report. */
export function closeBanner(session: number, banner: Banner): void {
  updateAsks(session, (asks) => (asks.closed.includes(banner) ? asks : { ...asks, closed: [...asks.closed, banner] }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Takes in what launch, or a running app, tells. Only the kinds that have a question in 4A change anything: the record of
 * opened files that could not be read (Ask 11), a restore finished at launch, and the first close (5b). The shell keeps its launch notices
 * and may send one again as an event, so the latest of each kind replaces the one before.
 */
function takeNotice(notice: unknown): void {
  if (!isRecord(notice)) return;
  if (notice.kind === "output_sweep") {
    set({ ...state, notices: { ...state.notices, lostOutputs: notice.unreadable === true } });
  } else if (notice.kind === "restore") {
    set({
      ...state,
      notices: { ...state.notices, restoreFinished: notice.state === "recovered" && notice.how === "finished" },
    });
  } else if (notice.kind === "first_close" && typeof notice.explain === "boolean") {
    set({ ...state, notices: { ...state.notices, firstClose: notice.explain } });
  } else if (notice.kind === "shortcut_taken") {
    if (!shortcutNoticeVoid) set({ ...state, notices: { ...state.notices, shortcut: "taken" } });
  } else if (notice.kind === "shortcut_not_set") {
    if (!shortcutNoticeVoid) set({ ...state, notices: { ...state.notices, shortcut: "not_set" } });
  } else if (notice.kind === "open_cleanup" && typeof notice.still_open === "number") {
    // Opened copies another program still holds, after a lock's cleanup or at launch. The latest count is the one that counts; none says nothing.
    cleanupNotices += 1;
    set({ ...state, notices: { ...state.notices, openFiles: Math.max(0, Math.floor(notice.still_open)) } });
  }
}

/**
 * Takes in `lockbox://busy`: the long operations running for a vault, which the window says (auto-lock waits for them). It is kept in that
 * vault's record, so a lock takes it away; an event for a vault the page does not hold, or for none, changes nothing. It holds only the
 * shell's fixed names of operations: anything else is not kept.
 */
function takeBusy(event: unknown): void {
  if (!isRecord(event) || typeof event.session !== "number" || !Array.isArray(event.operations)) return;
  const operations = event.operations.filter((name): name is string => typeof name === "string");
  update(event.session, (entry) => ({ ...entry, operations }));
}

let retryingOpen = false;
/** How many `open_cleanup` notices have been heard: a Retry whose answer comes after a newer notice is older news and is not kept. */
let cleanupNotices = 0;

/**
 * 10e's Retry: the shell tries again to remove the opened copies another program held, and answers how many it still cannot. The
 * message goes when none are left. A second press before the answer does nothing. A refusal is thrown, for the message to say.
 */
export async function retryOpenFiles(): Promise<void> {
  if (retryingOpen) return;
  retryingOpen = true;
  const heard = cleanupNotices;
  try {
    const report = await api.retryOpenCleanup();
    // A notice that came while Retry was out (another vault's lock could not remove a copy) is newer than this answer.
    if (cleanupNotices === heard) set({ ...state, notices: { ...state.notices, openFiles: Math.max(0, report.still_open) } });
  } finally {
    retryingOpen = false;
  }
}

/** Closes the message that the save shortcut is off. It comes back only when Lockbox starts again, or if the shell tells it again. */
export function dismissShortcutNotice(): void {
  set({ ...state, notices: { ...state.notices, shortcut: null } });
}

let confirmingClose = false;

/**
 * 5b's "Got it": the shell keeps that the explanation was seen and hides the window. The message goes with the shell's own
 * `explain: false`, and on the answer too, in case that event was lost. A second press before the answer does nothing. The
 * command never refuses; if the call fails all the same (the bridge itself), the message stays so the button can be pressed
 * again, and nothing is said of why.
 */
export async function confirmFirstClose(): Promise<void> {
  if (confirmingClose) return;
  confirmingClose = true;
  try {
    await api.closeExplainedOk();
    set({ ...state, notices: { ...state.notices, firstClose: false } });
  } catch {
    // The message stays.
  } finally {
    confirmingClose = false;
  }
}

let noticesStarted: Promise<void> | undefined;

/**
 * Starts hearing notices, once the lock listener is up (call it after `startStore`): listens for `lockbox://notice`
 * first, then asks for what launch kept, so none falls between. A notice that can't be heard or read tells nothing and
 * stops nothing: the shell keeps launch notices for the next time the page asks.
 */
export function startNotices(): Promise<void> {
  noticesStarted ??= (async () => {
    if (refusedWith(state.startError, "page")) return;
    try {
      await api.onNotice(takeNotice);
    } catch {
      // Launch notices are still read below; only later ones are missed.
    }
    try {
      await api.onBusy(takeBusy);
    } catch {
      // Without it the window does not say why auto-lock waits; the wait itself is the shell's, and unchanged.
    }
    try {
      for (const notice of await api.launchNotices()) takeNotice(notice);
    } catch {
      // Nothing to tell, as far as the page can know.
    }
  })();
  return noticesStarted;
}

/**
 * Ask 11's "Set it aside": the shell sets the damaged record of opened files aside, and the banner goes. A refusal is
 * thrown for the banner to say, and the banner stays.
 */
export async function setOutputRecordAside(): Promise<void> {
  await api.resetOutputJournal();
  set({ ...state, notices: { ...state.notices, lostOutputs: false } });
}

/**
 * Puts a refusal on the lock screen for the person to read, when the vault it was about is locked already (Ask 16: a new
 * password was saved but the vault locked before the page could say so). It goes when a vault is unlocked. The change-
 * password screen (4C) is what calls this; nothing in 4A does.
 */
export function sayOnLockScreen(refusal: unknown): void {
  set({ ...state, lockNote: refusal });
}

/** How an item comes to the panel, beyond which one: from where it was opened. */
export interface OpenedHow {
  /** Just saved from a new-item form: the panel takes focus on its heading. */
  saved?: boolean;
  /** Back from its Edit form: focus goes to Edit. */
  focusEdit?: boolean;
  /** What the panel had a moment ago (Cancel on a form): shown at once, and read again from the shell meanwhile. */
  detail?: ItemDetail;
}

/**
 * Opens an item in the panel, or closes the panel (`null`). An item takes the panel from a form or tool open in it:
 * what was typed there goes with it.
 */
export async function selectItem(session: number, id: string | null, opened: OpenedHow = {}): Promise<void> {
  const entry = sessionOf(session);
  if (entry === undefined) return;
  if (id === null) {
    update(session, (current) => ({ ...endReveals(current), openItem: null }));
    return;
  }
  const { generation } = entry;
  const saved = opened.saved ?? false;
  const focusEdit = opened.focusEdit ?? false;
  // A value revealed for the item that was open does not stay for the next, or for the same one opened again.
  update(session, (current) => ({
    ...endReveals(current),
    tool: null,
    // An item of the list is never opened in the Trash view: a result of the search takes the person out of it.
    trash: false,
    openItem: { id, detail: opened.detail ?? null, error: null, saved, focusEdit },
  }));
  const run = nextDetailRun(session);
  const shows = () => sessionOf(session)?.openItem?.id === id && stillOpen(session, generation) && detailRuns.get(session) === run;
  try {
    const answer = await api.getItem({ session, generation }, id);
    if (shows()) {
      update(session, (current) => ({ ...current, openItem: { id, detail: answer.data, error: null, saved, focusEdit } }));
    }
  } catch (error) {
    if (refusedAsLocked(error)) dropSession(session);
    if (error instanceof api.StaleAnswer || !shows()) return;
    // What was shown stays when only the second read failed.
    update(session, (current) => ({
      ...current,
      openItem: { id, detail: opened.detail ?? null, error, saved, focusEdit },
    }));
  }
}

/**
 * Edit on an open item's details: the item's form takes the panel, from the summary and the details the panel has. Nothing in a
 * vault that is read-only, and nothing until the details have come. The form asks for what it needs itself
 * (`revealForEdit`), so no value is kept here.
 */
export function openEdit(session: number): void {
  const entry = sessionOf(session);
  const open = entry?.openItem;
  if (entry === undefined || entry.readOnly || open === null || open === undefined || open.detail === null) return;
  const detail = open.detail;
  update(session, (current) => ({
    ...endReveals(current),
    openItem: null,
    tool: { kind: "edit", summary: detail.summary, detail },
  }));
}

/**
 * Cancel on an Edit form: nothing was saved. The item's details come back at once, from what the panel had, and are read
 * again from the shell (the item may have changed since), with focus on Edit.
 */
export function closeEdit(session: number): void {
  const tool = sessionOf(session)?.tool;
  if (tool?.kind !== "edit") return;
  void selectItem(session, tool.summary.id, { focusEdit: true, detail: tool.detail });
}

/** What `revealForEdit` came to: the stored value, a refusal to say, or nothing to say (a lock, or the form is gone). */
export type StoredValue = { value: string } | { failed: unknown } | "gone";

/**
 * The stored password or key's value an Edit form shows, asked of Rust as the form opens, through the same reveal command
 * as Reveal. The request carries the reveal token as it was when asked: Cancel, another item, another form and a lock move
 * it on (or drop the session), so an answer that is late, or for a form that is no longer there, comes back as `"gone"`
 * and fills nothing. The value goes to the form's state alone, never into the store.
 */
export async function revealForEdit(session: number, id: string, field: "password" | "key_value"): Promise<StoredValue> {
  const entry = sessionOf(session);
  if (entry === undefined) return "gone";
  const { generation, revealEpoch: token } = entry;
  const current = () => {
    const now = sessionOf(session);
    return stillOpen(session, generation) && now?.revealEpoch === token && now.tool?.kind === "edit" && now.tool.summary.id === id;
  };
  try {
    const answer = await api.revealValue({ session, generation }, id, field);
    return current() ? { value: answer.data } : "gone";
  } catch (error) {
    if (refusedAsLocked(error)) dropSession(session);
    if (error instanceof api.StaleAnswer || !current()) return "gone";
    return { failed: error };
  }
}

/** Opens the new-login form in the vault's panel, its title started with `title`. Nothing in a vault that is read-only. */
export function openNewLogin(session: number, title = ""): void {
  openTool(session, { kind: "new_login", title });
}

/** Opens the new-key form in the vault's panel. Nothing in a vault that is read-only. */
export function openNewKey(session: number): void {
  openTool(session, { kind: "new_key" });
}

/** Opens the new-note form in the vault's panel. Nothing in a vault that is read-only. */
export function openNewNote(session: number): void {
  openTool(session, { kind: "new_note" });
}

/** The number of the last time Paste a .env was opened. */
let pasteOpenings = 0;

/** Opens Paste a .env in the vault's panel, as a new panel each time. Nothing in a vault that is read-only. */
export function openPasteEnv(session: number): void {
  pasteOpenings += 1;
  openTool(session, { kind: "paste_env", opening: pasteOpenings });
}

/**
 * Puts a form in the vault's panel in place of the item open there (and of the value revealed for it). A `paste_env` that is told its `rows`
 * and `folder` opens on those, as if they had been pasted.
 */
function openTool(session: number, tool: Tool): void {
  const entry = sessionOf(session);
  if (entry === undefined || entry.readOnly) return;
  update(session, (current) => ({ ...endReveals(current), openItem: null, tool, trash: false }));
}

/** Opens the Generator page in the vault's panel. */
export function openGenerator(session: number): void {
  update(session, (current) => ({ ...endReveals(current), openItem: null, tool: { kind: "generator" } }));
}

/** Opens Settings in the vault's panel. It is the app's, not the vault's, so a read-only vault opens it as well. */
export function openSettings(session: number): void {
  update(session, (current) => ({ ...endReveals(current), openItem: null, tool: { kind: "settings" } }));
}

/** What a settings save came to: saved (the page's copy has it now), or the shell's refusal, with the page's copy as it was. */
export type SettingsResult = "saved" | "cancelled" | { failed: unknown };

/**
 * A save the screen may call back while it still waits in line (`cancelled`), until its turn comes and it is sent (`sent`): after that the
 * shell has it, and it cannot be taken back from here.
 */
export interface SaveTicket {
  cancelled: boolean;
  sent: boolean;
}

/** The saves in line: each waits for the one before it, so an older answer can never land over a newer save. */
let settingsLine: Promise<unknown> = Promise.resolve();

/** Whether the launch notice that the save shortcut is off was made untrue by a shortcut saved since (it stays gone, and is not taken in again). */
let shortcutNoticeVoid = false;

/**
 * Saves one change to the settings, as the whole settings: the saved ones with `change` over them, built when its turn comes so a refused
 * change before it is not carried along. The shell applies it at once (the shortcut registered, the capture protection changed). On
 * success the page's copy is the new settings; on a refusal it is left as it was and the refusal comes back for the screen to say. A
 * `ticket` marked cancelled before its turn comes is not sent at all. A saved shortcut makes the launch notice (the shortcut is off) untrue,
 * so it goes, and a kept copy of it that the shell tells again is not shown.
 */
export function saveSettings(change: Partial<api.Settings>, ticket?: SaveTicket): Promise<SettingsResult> {
  const turn = async (): Promise<SettingsResult> => {
    if (ticket?.cancelled === true) return "cancelled";
    if (ticket !== undefined) ticket.sent = true;
    try {
      const next = { ...(state.settings ?? (await api.getSettings())), ...change };
      await api.setSettings(next);
      if (change.shortcut !== undefined) shortcutNoticeVoid = true;
      set({ ...state, settings: next, notices: change.shortcut === undefined ? state.notices : { ...state.notices, shortcut: null } });
      return "saved";
    } catch (error) {
      return { failed: error };
    }
  };
  const result = settingsLine.then(turn);
  settingsLine = result;
  return result;
}

/** Reads the settings again when the page has none (they could not be read at the start); the screens fall back to the defaults meanwhile. */
export function loadSettings(): void {
  if (state.settings !== null) return;
  api.getSettings().then(
    (settings) => {
      if (state.settings === null) set({ ...state, settings });
    },
    () => undefined,
  );
}

/** Closes the form or tool in the panel; what was typed in it is gone. */
export function closeTool(session: number): void {
  update(session, (current) => ({ ...current, tool: null }));
}

/** How a save came out: made (the form is gone and the login is open), the vault locked meanwhile, or the shell's refusal. */
export type SaveResult = "saved" | "stale" | { failed: unknown };

/**
 * Saves the new-login form's text as a login, whole, in one write by the shell. On success the form goes, the list is read
 * again, the new login opens in the panel and "Saved" is said. A vault that locked meanwhile (the bridge's `StaleAnswer`,
 * or the shell's `locked` when the page missed the event) gets nothing said: the form is already gone with the vault's
 * record, and what was written stays written. A refusal comes back for the form to say, and the form stays as it was.
 */
export function saveNewLogin(session: number, draft: LoginDraft): Promise<SaveResult> {
  const website = draft.website.trim();
  return saveNew(session, (vault) =>
    api.newLogin(vault, draft.title.trim(), draft.folder, {
      username: draft.username,
      password: draft.password,
      urls: website === "" ? [] : [website],
    }),
  );
}

/**
 * Saves the new-key form as a key, whole, in one write: the name (trimmed) is its title, the value goes to Rust exactly as
 * typed and is never kept here. Everything else is as `saveNewLogin`: the key opens hidden with "Saved", a vault that locked
 * meanwhile gets nothing said, and a refusal (a name that is not a variable name) comes back for the form to say.
 */
export function saveNewKey(session: number, draft: KeyDraft): Promise<SaveResult> {
  return saveNew(session, (vault) => api.newKey(vault, draft.name.trim(), draft.folder, draft.value));
}

/** Saves the new-note form as a note, whole, in one write, and opens it with its text showing. As `saveNewLogin`. */
export function saveNewNote(session: number, draft: NoteDraft): Promise<SaveResult> {
  return saveNew(session, (vault) => api.newNote(vault, draft.title.trim(), draft.folder, draft.text));
}

/**
 * Saves the Edit form: the one write the shell makes of the changes, whole. On success the form goes, the list is read again,
 * the item's details open with "Saved" and focus on Edit. A refusal comes back for the form to say (a stale revision among
 * them: the item changed while it was open), and the form stays as it was. A vault that locked meanwhile gets nothing said,
 * as `saveNewLogin`.
 */
export function saveEdit(session: number, edit: api.ItemEdit): Promise<SaveResult> {
  return saveThen(session, async (vault) => {
    await api.updateItem(vault, edit);
    return edit.id;
  }, { focusEdit: true });
}

function saveNew(session: number, make: (vault: api.SessionRef) => Promise<api.Tagged<string>>): Promise<SaveResult> {
  return saveThen(session, async (vault) => (await make(vault)).data, { saved: true });
}

/**
 * Runs a save that the shell writes in one step (`write` answers the id of the item to show), then reads the list again and
 * opens the item. The item exists once the write is done: whatever the list refresh says (it may be refused), the item's
 * details still open, from their own read.
 */
async function saveThen(
  session: number,
  write: (vault: api.SessionRef) => Promise<string>,
  opened: OpenedHow,
): Promise<SaveResult> {
  const entry = sessionOf(session);
  if (entry === undefined) return "stale";
  const { generation } = entry;
  // The form that started this save, by its own object (a second form of the same kind for another item is another one).
  const starter = entry.tool;
  try {
    const id = await write({ session, generation });
    if (!stillOpen(session, generation)) return "stale";
    // It is written now. Whatever the list says next, the form's job is done.
    const record = sessionOf(session);
    if (record === undefined) return "stale";
    const read = await loadItems(record);
    if (read === "stale" || !stillOpen(session, generation)) return "stale";
    set({ ...state, toast: { kind: "saved", session } });
    // The saved item opens only if the form that saved it is still what the panel shows. If the person has cancelled and
    // gone on to something else (another item, a newer form with text in it), the panel stays as they have it.
    if (sessionOf(session)?.tool === starter) void selectItem(session, id, opened);
    return "saved";
  } catch (error) {
    if (refusedAsLocked(error)) dropSession(session);
    if (error instanceof api.StaleAnswer || !stillOpen(session, generation)) return "stale";
    return { failed: error };
  }
}

/** Shows a folder's items (`null`: all items), and closes the panel. */
export function selectFolder(session: number, folder: string | null): void {
  update(session, (entry) => ({ ...endReveals(entry), folder, trash: false, openItem: null }));
}

/** Shows the Trash view in place of the list, and closes the panel and any form (the Trash has nothing to add). */
export function openTrash(session: number): void {
  update(session, (entry) => ({ ...endReveals(entry), folder: null, trash: true, openItem: null, tool: null }));
}

/**
 * Picks a row of the Trash view (`null` closes the panel). Nothing of the item is asked of the shell for it: the Trash panel
 * shows what the list already says (its title, kind, folder and when), and no password, key or note.
 */
export function pickTrashed(session: number, id: string | null): void {
  update(session, (entry) => ({
    ...endReveals(entry),
    openItem: id === null ? null : { id, detail: null, error: null, saved: false, focusEdit: false },
  }));
}

/** How a copy or an open ended: it worked, the vault locked meanwhile (nothing to say), or the shell's refusal. */
type Done = "done" | "stale" | { failed: unknown };

/**
 * Asks the shell to put a field of the item on the clipboard (it never reaches the page) and, once it has, tells the
 * person when it will be cleared. The shell's refusal comes back for the caller to say where it fits.
 */
async function copyAndTell(session: number, id: string, field: CopyTarget): Promise<Done> {
  const words = typeof field === "string" ? COPIED[field] : "Password copied";
  return copyThenTell(session, words, (vault) => api.copyField(vault, id, field));
}

/** What the message says after each copy. */
const COPIED: Record<CopyableField, string> = {
  password: "Password copied",
  username: "Username copied",
  key_value: "Key copied",
  notes: "Text copied",
};

/**
 * Runs a copy the shell makes, and once it has, says `text` and when the clipboard clears. `copied` looks at the shell's answer and
 * says whether anything was put on the clipboard: when it says no (nothing was copied), nothing is said here and the caller does.
 */
async function copyThenTell(
  session: number,
  text: string,
  copy: (vault: api.SessionRef) => Promise<unknown>,
  copied: (answer: unknown) => boolean = () => true,
): Promise<Done> {
  const entry = sessionOf(session);
  if (entry === undefined) return "stale";
  const { generation } = entry;
  try {
    const { clipboard_seconds } = await api.getSettings();
    const answer = await copy({ session, generation });
    if (!stillOpen(session, generation)) return "stale";
    if (!copied(answer)) return "done";
    set({
      ...state,
      toast: {
        kind: "copied",
        session,
        text,
        seconds: clipboard_seconds,
        endsAt: Date.now() + clipboard_seconds * 1000,
      },
    });
    return "done";
  } catch (error) {
    if (refusedAsLocked(error)) dropSession(session);
    if (error instanceof api.StaleAnswer || !stillOpen(session, generation)) return "stale";
    return { failed: error };
  }
}

/**
 * Copies the password the Generator page shows: the value goes back to the shell, which puts it on the clipboard with the
 * marks and timer of any copy, owned by this vault. The page never uses its own clipboard, which skips those marks. The
 * message says when it clears; a refusal is said as a message. A vault that locked meanwhile gets nothing.
 */
export async function copyGenerated(session: number, value: string): Promise<void> {
  const done = await copyThenTell(session, "Password copied", (vault) => api.copyGenerated(vault, value));
  if (typeof done === "object") set({ ...state, toast: { kind: "failed", session, error: done.failed } });
}

/**
 * Asks the shell to put a field of the item on the clipboard (it never reaches the page) and tells the person when it
 * will be cleared. A vault that locked meanwhile gets no message.
 */
export async function copyField(session: number, id: string, field: CopyTarget): Promise<void> {
  const done = await copyAndTell(session, id, field);
  if (typeof done === "object") set({ ...state, toast: { kind: "failed", session, error: done.failed } });
}

/**
 * Where `SessionData.reveals` keeps a revealed value: under the item's id for its password or key's value, and under the id and
 * the number for one of a login's earlier passwords.
 */
export function revealKey(id: string, field: api.RevealableField): string {
  return typeof field === "string" ? id : `${id}:previous:${String(field.previous)}`;
}

/**
 * Reveal on an item's details: asks the shell for a login's password, a key's value or an earlier password (`field`) and keeps
 * it in the session's record while the item stays open. Each request carries the session's reveal token as it was when asked; Hide, another item,
 * a form or tool, another folder, the panel closing and the same item opening again all change it (`endReveals`), and an
 * answer whose token is no longer the current one is dropped, so a late answer, or a second one from a second press, never
 * puts a hidden value back. An answer from a vault that locked is dropped too. Neither says anything; a refusal that is still
 * current is said as a message.
 */
export async function revealValue(session: number, id: string, field: api.RevealableField): Promise<void> {
  const entry = sessionOf(session);
  if (entry === undefined) return;
  const { generation } = entry;
  // Each request moves the token on as it starts and accepts only its own answer, so the latest press wins whatever order the
  // answers come in. What is shown stays until the answer replaces it.
  const token = entry.revealEpoch + 1;
  update(session, (record) => ({ ...record, revealEpoch: token }));
  const current = () => stillOpen(session, generation) && sessionOf(session)?.revealEpoch === token;
  try {
    const answer = await api.revealValue({ session, generation }, id, field);
    if (!current() || sessionOf(session)?.openItem?.id !== id) return;
    // One value on screen at a time: this one takes the place of any other the item's details were showing.
    update(session, (record) => ({ ...record, reveals: { [revealKey(id, field)]: answer.data } }));
  } catch (error) {
    if (refusedAsLocked(error)) dropSession(session);
    if (error instanceof api.StaleAnswer || !current()) return;
    set({ ...state, toast: { kind: "failed", session, error } });
  }
}

/** Hide on a revealed value: it goes off the page and out of the store, and any answer still on its way is no longer wanted. */
export function hideReveal(session: number): void {
  update(session, endReveals);
}

/** Opens the login's website number `index` through the shell, which opens only an `http` or `https` one. */
async function openAndTell(session: number, id: string, index: number): Promise<Done> {
  const entry = sessionOf(session);
  if (entry === undefined) return "stale";
  const { generation } = entry;
  try {
    await api.openUrl({ session, generation }, id, index);
    return stillOpen(session, generation) ? "done" : "stale";
  } catch (error) {
    if (refusedAsLocked(error)) dropSession(session);
    if (error instanceof api.StaleAnswer || !stillOpen(session, generation)) return "stale";
    return { failed: error };
  }
}

/** "Open" beside a website on the login's details: a refusal is said as a message. */
export async function openSite(session: number, id: string, index: number): Promise<void> {
  const done = await openAndTell(session, id, index);
  if (typeof done === "object") set({ ...state, toast: { kind: "failed", session, error: done.failed } });
}

/** What a change the shell writes came to: done, the vault locked meanwhile (nothing to say), or the shell's refusal. */
type Changed<T> = { done: T } | "stale" | { failed: unknown };

/**
 * Runs a change the shell writes (a move, a trash, a restore, a folder made or renamed) and, once it is written, reads the
 * list again. A vault that locked meanwhile (the bridge's `StaleAnswer`, or the shell's `locked` when the page missed the event,
 * which also takes the vault's record away) comes back as `"stale"`: nothing to say. The caller decides what the answer does to
 * the screen, and checks that the view it started from is still the one on screen first (a late answer never acts on a view that
 * is gone or newer); the list is read whatever the view, since the change is written.
 */
async function change<T>(session: number, run: (vault: api.SessionRef) => Promise<T>): Promise<Changed<T>> {
  const entry = sessionOf(session);
  if (entry === undefined) return "stale";
  const { generation } = entry;
  try {
    const done = await run({ session, generation });
    if (!stillOpen(session, generation)) return "stale";
    const record = sessionOf(session);
    if (record === undefined) return "stale";
    const read = await loadItems(record);
    if (read === "stale" || !stillOpen(session, generation)) return "stale";
    return { done };
  } catch (error) {
    if (refusedAsLocked(error)) dropSession(session);
    if (error instanceof api.StaleAnswer || !stillOpen(session, generation)) return "stale";
    // A refusal can come after some of the change was written (a folder's items go one at a time), or after the write landed.
    // The list is read again so the page agrees with the vault, a panel that no longer belongs closes with its revealed value,
    // and the refusal is still what is said: a refused read on top of it says nothing and throws nothing.
    const record = sessionOf(session);
    if (record !== undefined) {
      const read = await loadItems(record, { quiet: true });
      if (read === "stale" || !stillOpen(session, generation)) return "stale";
    }
    return { failed: error };
  }
}

function say(session: number, text: string): void {
  set({ ...state, toast: { kind: "said", session, text } });
}

function sayFailure(session: number, error: unknown): void {
  set({ ...state, toast: { kind: "failed", session, error } });
}

/**
 * Whether the panel is still the one a change began from: it is on `id` (`openAtStart` says it was when the change began), or the
 * list read that followed the change closed it because its item had gone. A panel the person has since moved to another item is
 * not, and is left as it is.
 */
function panelWasOurs(session: number, id: string, openAtStart: boolean): boolean {
  const now = sessionOf(session)?.openItem ?? null;
  return now === null ? openAtStart : now.id === id;
}

/**
 * The number of the latest read of the open item's details asked of each session (by `selectItem` and `reloadOpen`): an answer is kept only
 * while its number is still the latest, so a slow older answer never puts back details a newer one replaced.
 */
const detailRuns = new Map<number, number>();

function nextDetailRun(session: number): number {
  const run = (detailRuns.get(session) ?? 0) + 1;
  detailRuns.set(session, run);
  return run;
}

/** Reads the open item's details again after a change to it, in place: what the panel shows stays, and Reveal's value too. */
async function reloadOpen(session: number, id: string): Promise<void> {
  const entry = sessionOf(session);
  if (entry === undefined) return;
  const { generation } = entry;
  const run = nextDetailRun(session);
  try {
    const answer = await api.getItem({ session, generation }, id);
    // An older read that comes after a newer one (two changes in a row, delayed answers) is not the details any more.
    if (!stillOpen(session, generation) || sessionOf(session)?.openItem?.id !== id || detailRuns.get(session) !== run) return;
    update(session, (current) =>
      current.openItem?.id === id ? { ...current, openItem: { ...current.openItem, detail: answer.data, error: null } } : current,
    );
  } catch (error) {
    // What the panel shows stays; only a lock is news.
    if (refusedAsLocked(error)) dropSession(session);
  }
}

/**
 * Move on the open item: it goes to `folder` (a folder's id, or `null` for none) at once, as an edit that sends the revision the
 * panel read, so a change made meanwhile makes it stale and nothing moves (the shell's refusal is said as a message). Says
 * "Moved to <name>" (`name` is the folder's, `null` for none). The panel reads the item again, and only when it is still the
 * one open. Picking the folder it is in does nothing. Nothing in a vault that is read-only.
 */
export async function moveOpenItem(session: number, folder: string | null, name: string | null): Promise<void> {
  const entry = sessionOf(session);
  const open = entry?.openItem;
  if (entry === undefined || entry.readOnly || open === null || open === undefined || open.detail === null) return;
  const { id, detail } = open;
  if (detail.summary.collection === folder) return;
  const edit: api.ItemEdit = {
    id,
    revision: detail.revision,
    title: detail.summary.title,
    notes: detail.notes,
    collection: folder,
  };
  const done = await change(session, (vault) => api.updateItem(vault, edit));
  if (done === "stale") return;
  if ("failed" in done) {
    sayFailure(session, done.failed);
    return;
  }
  say(session, `Moved to ${name ?? "No folder"}`);
  void reloadOpen(session, id);
}

/**
 * Move to trash on the open item: it goes at once, with no question. The panel closes (when it is still that item's), the list
 * is read again, and "Moved to Trash" shows with Undo, which holds the item's id. Focus goes to the list. A refusal is said as a
 * message and the panel stays. A vault that locked meanwhile gets nothing.
 */
export async function trashOpenItem(session: number): Promise<void> {
  const entry = sessionOf(session);
  const open = entry?.openItem;
  if (entry === undefined || entry.readOnly || open === null || open === undefined) return;
  const { id } = open;
  const done = await change(session, (vault) => api.trashItem(vault, id));
  if (done === "stale") return;
  if ("failed" in done) {
    sayFailure(session, done.failed);
    return;
  }
  const stillThere = panelWasOurs(session, id, true);
  if (stillThere) update(session, (current) => ({ ...endReveals(current), openItem: null }));
  set({ ...state, toast: { kind: "trashed", session, id } });
  if (stillThere) focusList();
}

/**
 * Delete on the folder on screen, once the person said yes: it and its items go to the trash, the view goes to All items
 * (when it is still that folder's), and "Moved to Trash" shows with Undo, which holds the folder's id and brings the folder back
 * with what went with it. A refusal is said as a message.
 */
export async function deleteFolderOnScreen(session: number, id: string): Promise<void> {
  const entry = sessionOf(session);
  if (entry === undefined || entry.readOnly) return;
  const done = await change(session, (vault) => api.deleteFolder(vault, id));
  if (done === "stale") return;
  if ("failed" in done) {
    sayFailure(session, done.failed);
    return;
  }
  const leaving = sessionOf(session)?.folder === id;
  if (leaving) selectFolder(session, null);
  set({ ...state, toast: { kind: "trashed", session, id } });
  if (leaving) focusList();
}

/** Undo on "Moved to Trash": brings back what went (the item, or the folder with its items) and says "Restored". */
export async function undoTrash(session: number, id: string): Promise<void> {
  const entry = sessionOf(session);
  if (entry === undefined || entry.readOnly) return;
  const done = await change(session, (vault) => api.restoreItem(vault, id));
  if (done === "stale") return;
  // Whatever comes next replaces the message, and with it the Undo button. If that button has focus now, focus goes to the
  // list (or the heading, when there is none) rather than to the top of the page; if focus is elsewhere, it stays there.
  const hadFocus = document.activeElement?.closest(".tstack") != null;
  if ("failed" in done) sayFailure(session, done.failed);
  else say(session, "Restored");
  if (hadFocus) focusList();
}

// ---- Stored files (Task 19): open, save a copy, replace, attach, add ----
//
// Each is one long job in the shell, which opens the Windows picker or save dialog itself, so the page sends ids and never a path. One
// job at a time per vault (`SessionData.fileJob`): a second press while one works sends nothing. What an answer does depends on where the
// person is when it comes. A success is a fact about the vault (a copy was opened, a file stored) and is said whenever the vault is still
// open; a refusal is said only where the action began (the item's panel, or the search it was pressed in), so a late refusal never lands on
// something the person has moved on to. A lock, or a stale answer, says nothing at all.

const OPENED_COPY = "Opened a temporary read-only copy. Edits there aren't saved back. To change the stored file, use Replace file.";
const SAVED_COPY = "Saved a copy. It isn't encrypted. Delete it when you're finished.";
const ORIGINAL_STAYS =
  "The original is still unprotected on your PC. Lockbox didn't change or delete it, so remove it yourself if you no longer need it.";

/** Says something the person reads and puts away with "Got it", and that holds no file name. */
function noted(session: number, text: string): void {
  set({ ...state, toast: { kind: "noted", session, text } });
}

/**
 * Where a file action began: the item panel it was pressed in, the search it was pressed in (the opening, and the query typed at that moment:
 * a result of a newer query is not the one that was pressed), or the window (Add).
 */
type FileOrigin = { panel: string } | { search: number; query: number } | "anywhere";

/** The search as it is now, for an action that begins in it. */
function searchOrigin(): FileOrigin {
  return { search: searchOpening, query: searchRun };
}

/** Whether the person is still where the action began. */
function stillWhere(session: number, origin: FileOrigin): boolean {
  if (origin === "anywhere") return sessionOf(session) !== undefined;
  if ("search" in origin) return state.search !== null && searchOpening === origin.search && searchRun === origin.query;
  return sessionOf(session)?.openItem?.id === origin.panel;
}

/** Whether the shell refused because the stored file does not decrypt (`damaged`, of the file, or one that is missing). */
function damagedFile(error: unknown): boolean {
  return refusedWith(error, "core") && isRecord(error) && error.kind === "damaged" && (error.what === "file" || error.what === "file missing");
}

function endFileJob(session: number, generation: number): void {
  if (stillOpen(session, generation)) update(session, (current) => ({ ...current, fileJob: null }));
}

/** Says a refusal where the action began: a damaged file beside that file in the panel, anything else in the search or as a message. */
function refuseFile(session: number, origin: FileOrigin, job: FileJob, error: unknown): void {
  if (!stillWhere(session, origin)) return;
  if (origin === "anywhere") sayFailure(session, error);
  else if ("search" in origin) sayInSearch(error);
  else if (damagedFile(error) && job.fileId !== null) {
    const fileId = job.fileId;
    update(session, (current) =>
      current.openItem?.id === origin.panel ? { ...current, openItem: { ...current.openItem, fileError: { fileId, error } } } : current,
    );
  } else sayFailure(session, error);
}

/** What a stored-file action came to when it did not answer a plain yes: the shell's answer, the vault locked (nothing to say), another action is working, or a refusal that was said. */
type FileRan<T> = { outcome: api.Outcome<T> } | "stale" | "busy" | "refused";

/**
 * Runs one stored-file job: marks the vault as working, asks the shell, and gives the answer back unless the vault locked meanwhile. With
 * `reload` the list is read again after it (a change that writes), through the same path as every other change.
 */
async function runFile<T>(
  session: number,
  job: FileJob,
  origin: FileOrigin,
  reload: boolean,
  run: (vault: api.SessionRef) => Promise<api.Tagged<api.Outcome<T>>>,
): Promise<FileRan<T>> {
  const entry = sessionOf(session);
  if (entry === undefined) return "stale";
  if (entry.fileJob !== null) return "busy";
  const { generation } = entry;
  // A new job takes away what the last one said about this item's files.
  update(session, (current) => ({
    ...current,
    fileJob: job,
    openItem: current.openItem !== null && current.openItem.id === job.id ? { ...current.openItem, fileError: null } : current.openItem,
  }));
  try {
    if (reload) {
      const done = await change(session, async (vault) => (await run(vault)).data);
      if (done === "stale") return "stale";
      if ("failed" in done) {
        refuseFile(session, origin, job, done.failed);
        return "refused";
      }
      return { outcome: done.done };
    }
    try {
      const answer = await run({ session, generation });
      return stillOpen(session, generation) ? { outcome: answer.data } : "stale";
    } catch (error) {
      if (refusedAsLocked(error)) dropSession(session);
      if (error instanceof api.StaleAnswer || !stillOpen(session, generation)) return "stale";
      refuseFile(session, origin, job, error);
      return "refused";
    }
  } finally {
    endFileJob(session, generation);
  }
}

/** How Open came out. `asks`: a program file, and the question is the screen's to ask. */
export type OpenResult = "done" | "asks" | "stale" | "busy" | "refused";

function openResult(session: number, ran: FileRan<null>): OpenResult {
  if (typeof ran === "string") return ran;
  const { outcome } = ran;
  if (typeof outcome === "object" && "Done" in outcome) {
    noted(session, OPENED_COPY);
    return "done";
  }
  if (typeof outcome === "object" && "Confirm" in outcome && outcome.Confirm === "Executable") return "asks";
  sayFailure(session, UNEXPECTED);
  return "refused";
}

/**
 * Open on a stored file of the item open in the panel: the shell decrypts a read-only copy and opens it in its app, and says so (the
 * copy is removed at the next lock, and edits to it are not kept). A program file answers `asks` first, before anything is decrypted; send
 * it again with `confirmed` once the person says yes. A file that does not decrypt is said beside the file in the panel.
 */
export async function openStoredFile(session: number, id: string, fileId: string, confirmed = false): Promise<OpenResult> {
  const ran = await runFile(session, { kind: "open", id, fileId }, { panel: id }, false, (vault) => api.openFile(vault, id, fileId, confirmed));
  return openResult(session, ran);
}

/**
 * How Save a copy came out: `dismissed` is a closed Windows dialog, which says nothing; `confirm` is a cloud-synced folder, with the token
 * the yes goes on with (nothing was decrypted or written).
 */
export type CopyResult = "done" | "dismissed" | "stale" | "busy" | "refused" | { confirm: string };

function saveResult(session: number, ran: FileRan<null>): CopyResult {
  if (typeof ran === "string") return ran;
  const { outcome } = ran;
  if (outcome === "Dismissed") return "dismissed";
  if (typeof outcome === "object" && "Done" in outcome) {
    noted(session, SAVED_COPY);
    return "done";
  }
  if (typeof outcome === "object" && "Confirm" in outcome && typeof outcome.Confirm === "object" && "CloudFolder" in outcome.Confirm) {
    return { confirm: outcome.Confirm.CloudFolder.token };
  }
  sayFailure(session, UNEXPECTED);
  return "refused";
}

/**
 * Save a copy on a stored file of the item open in the panel: Rust opens the Windows save dialog and writes the copy, which is not encrypted.
 * A cloud-synced folder answers `{ confirm }` first, for the screen to ask (21e); `confirmStoredCopy` goes on with it.
 */
export async function saveStoredFile(session: number, id: string, fileId: string): Promise<CopyResult> {
  const ran = await runFile(session, { kind: "save", id, fileId }, { panel: id }, false, (vault) => api.saveFileCopy(vault, id, fileId));
  return saveResult(session, ran);
}

/**
 * The run of a cloud question's yes. The shell lets go of a parked copy after five minutes as well as at a lock, so `not_found` is not news of
 * a lock by itself: the shell is asked about the session (`whyNotFound`). Locked: the session leaves the page and nothing is said. Still live:
 * the page's own "that took too long" is the refusal, said where the save began.
 */
function confirmCopy(session: number, token: string): (vault: api.SessionRef) => Promise<api.Tagged<api.Outcome<null>>> {
  return async () => {
    try {
      return await api.saveFileCopyConfirm(token);
    } catch (error) {
      if (refusedWith(error, "not_found")) await whyNotFound(session, "file_copy_expired");
      throw error;
    }
  };
}

/** The person's yes to the cloud question of a copy saved from the item open in the panel: the shell goes on with the copy it parked. */
export async function confirmStoredCopy(session: number, id: string, fileId: string, token: string): Promise<CopyResult> {
  const ran = await runFile(session, { kind: "save", id, fileId }, { panel: id }, false, confirmCopy(session, token));
  return saveResult(session, ran);
}

/** How a replace, attach or add came out: `dismissed` is a closed picker, which says nothing and changes nothing. */
export type StoreResult = "done" | "dismissed" | "stale" | "busy" | "refused";

/** What a stored file's import came to once it is said: the new item or file's ID, for the caller that needs it. */
function storeResult(ran: FileRan<string>, done: (id: string) => void): StoreResult {
  if (typeof ran === "string") return ran;
  const { outcome } = ran;
  if (outcome === "Dismissed") return "dismissed";
  if (typeof outcome === "object" && "Done" in outcome) {
    done(outcome.Done);
    return "done";
  }
  return "refused";
}

/**
 * Replace file on a stored file of the item open in the panel, once the person has said yes to the warning: Rust opens the Windows picker and
 * puts the chosen file in the old one's place. The panel reads the item again only if it is still that item's; "File replaced" is said either way.
 */
export async function replaceStoredFile(session: number, id: string, fileId: string): Promise<StoreResult> {
  const ran = await runFile(session, { kind: "replace", id, fileId }, { panel: id }, true, (vault) => api.replaceFile(vault, id, fileId));
  return storeResult(ran, () => {
    say(session, "File replaced");
    void reloadOpen(session, id);
  });
}

/** Attach a file on the login, key or note open in the panel: one file, picked in the Windows picker. It says the original is still on the PC. */
export async function attachStoredFile(session: number, id: string): Promise<StoreResult> {
  const ran = await runFile(session, { kind: "attach", id, fileId: null }, { panel: id }, true, (vault) => api.attachFile(vault, id));
  return storeResult(ran, () => {
    noted(session, `File attached. ${ORIGINAL_STAYS}`);
    void reloadOpen(session, id);
  });
}

/**
 * Add, then File: one file picked in the Windows picker becomes an item in the folder on screen (`collection`, `null` for none). The new item
 * opens in the panel only if the panel is as it was when Add was pressed; one the person has moved to is left as it is. It says the original is
 * still on the PC.
 */
export async function addStoredFile(session: number, collection: string | null): Promise<StoreResult> {
  const start = sessionOf(session);
  const openId = start?.openItem?.id ?? null;
  const tool = start?.tool ?? null;
  const ran = await runFile(session, { kind: "add", id: null, fileId: null }, "anywhere", true, (vault) => api.addFile(vault, collection));
  return storeResult(ran, (made) => {
    noted(session, `File added. ${ORIGINAL_STAYS}`);
    const now = sessionOf(session);
    if (now !== undefined && (now.openItem?.id ?? null) === openId && now.tool === tool) void selectItem(session, made);
  });
}

/** Open on a file result of the search: as the panel's, and the search steps aside once it worked. A program file is asked over the search. */
export async function openFileFromSearch(session: number, id: string, file: FileView, confirmed = false): Promise<void> {
  const origin = searchOrigin();
  const ran = await runFile(session, { kind: "open", id, fileId: file.file_id }, origin, false, (vault) =>
    api.openFile(vault, id, file.file_id, confirmed),
  );
  const result = openResult(session, ran);
  if (!stillWhere(session, origin)) return;
  if (result === "asks" && state.search !== null) {
    set({ ...state, search: { ...state.search, asking: { kind: "program", session, id, file } } });
  } else if (result === "done") closeSearch();
}

/** What a save from the search came to: the search steps aside once it worked, and a cloud folder is asked over the search. */
function afterSearchSave(session: number, id: string, file: FileView, origin: FileOrigin, result: CopyResult): void {
  if (!stillWhere(session, origin)) return;
  if (result === "done") closeSearch();
  else if (typeof result === "object" && state.search !== null) {
    set({ ...state, search: { ...state.search, asking: { kind: "cloud", session, id, file, token: result.confirm } } });
  }
}

/** Save a copy on a file result of the search: as the panel's, and the search steps aside once it worked. */
export async function saveFileFromSearch(session: number, id: string, file: FileView): Promise<void> {
  const origin = searchOrigin();
  const ran = await runFile(session, { kind: "save", id, fileId: file.file_id }, origin, false, (vault) => api.saveFileCopy(vault, id, file.file_id));
  afterSearchSave(session, id, file, origin, saveResult(session, ran));
}

/** The person's answer to a question asked over the search: yes goes on (Open anyway, or Continue to a cloud folder); no leaves it, with nothing done. */
export function answerSearchQuestion(yes: boolean): void {
  const search = state.search;
  const asking = search?.asking ?? null;
  if (search === null || asking === null) return;
  set({ ...state, search: { ...search, asking: null } });
  if (!yes) return;
  if (asking.kind === "program") {
    void openFileFromSearch(asking.session, asking.id, asking.file, true);
    return;
  }
  const origin = searchOrigin();
  const { session, id, file, token } = asking;
  void (async () => {
    const ran = await runFile(session, { kind: "save", id, fileId: file.file_id }, origin, false, confirmCopy(session, token));
    afterSearchSave(session, id, file, origin, saveResult(session, ran));
  })();
}

/** "Pick another folder" over the search: the question goes and Windows is asked for a folder again. */
export function pickAnotherFolderFromSearch(): void {
  const asking = state.search?.asking ?? null;
  if (state.search === null || asking === null || asking.kind !== "cloud") return;
  set({ ...state, search: { ...state.search, asking: null } });
  void saveFileFromSearch(asking.session, asking.id, asking.file);
}

/**
 * Restore on a Trash row's panel: the item comes back (its folder with it when that is in the trash too; a folder brings back
 * the items that went with it). The panel closes when it is still that row's, and "Restored" is said. A refusal is said as a message.
 */
export async function restoreTrashed(session: number, id: string): Promise<void> {
  const entry = sessionOf(session);
  if (entry === undefined || entry.readOnly) return;
  const openAtStart = entry.openItem?.id === id;
  const done = await change(session, (vault) => api.restoreItem(vault, id));
  if (done === "stale") return;
  if ("failed" in done) {
    sayFailure(session, done.failed);
    return;
  }
  const stillThere = panelWasOurs(session, id, openAtStart);
  if (stillThere) update(session, (current) => ({ ...endReveals(current), openItem: null }));
  say(session, "Restored");
  if (stillThere) focusList();
}

/**
 * Delete for good on a Trash row, once the person said yes in the question: the item (a folder alone) goes for good. The panel
 * closes when it is still that row's. A refusal is said as a message and the row stays.
 */
export async function purgeTrashed(session: number, id: string): Promise<void> {
  const entry = sessionOf(session);
  if (entry === undefined || entry.readOnly) return;
  const openAtStart = entry.openItem?.id === id;
  const done = await change(session, (vault) => api.purgeItem(vault, id));
  if (done === "stale") return;
  if ("failed" in done) {
    sayFailure(session, done.failed);
    return;
  }
  const stillThere = panelWasOurs(session, id, openAtStart);
  if (stillThere) update(session, (current) => ({ ...endReveals(current), openItem: null }));
  say(session, "Deleted for good");
  if (stillThere) focusList();
}

/** What making a folder came to: its id, a lock meanwhile (nothing to say), or the shell's refusal to say under the box. */
export type FolderMade = { made: string } | "stale" | { failed: unknown };

/**
 * Makes a folder named `name` (the shell trims it, and refuses one with nothing in it). The list is read again; the new folder is
 * not opened here: the name box that asked opens it when it is still there (the late answer of a box that is gone opens nothing).
 */
export async function addFolder(session: number, name: string): Promise<FolderMade> {
  const done = await change(session, (vault) => api.newFolder(vault, name));
  if (done === "stale") return "stale";
  if ("failed" in done) return { failed: done.failed };
  return { made: done.done.data };
}

/** What the page read of a folder to rename it: its revision and notes, as `get_item` says them. */
export type FolderRead = { revision: number; notes: string } | "stale" | { failed: unknown };

/** Reads a folder's revision (for a rename to send back) and notes (which a rename keeps). */
export async function readFolder(session: number, id: string): Promise<FolderRead> {
  const entry = sessionOf(session);
  if (entry === undefined) return "stale";
  const { generation } = entry;
  try {
    const answer = await api.getItem({ session, generation }, id);
    return stillOpen(session, generation) ? { revision: answer.data.revision, notes: answer.data.notes } : "stale";
  } catch (error) {
    if (refusedAsLocked(error)) dropSession(session);
    if (error instanceof api.StaleAnswer || !stillOpen(session, generation)) return "stale";
    return { failed: error };
  }
}

/**
 * Renames a folder, as an edit that sends the folder's revision (from `readFolder`): a change made meanwhile makes it stale and
 * nothing changes (the shell's refusal comes back for the dialog to say). The list is read again, so the folder's name changes
 * wherever it is shown. A vault that locked meanwhile gets nothing said.
 */
export async function renameFolder(session: number, id: string, read: { revision: number; notes: string }, name: string): Promise<SaveResult> {
  const edit: api.ItemEdit = { id, revision: read.revision, title: name, notes: read.notes, collection: null };
  const done = await change(session, (vault) => api.updateItem(vault, edit));
  if (done === "stale") return "stale";
  if ("failed" in done) return { failed: done.failed };
  return "saved";
}

/** What reading a pasted `.env` came to: its rows (names only), a vault that locked meanwhile (nothing to say), or the shell's refusal. */
export type EnvRead = { rows: api.EnvRows } | "stale" | { failed: unknown };

/**
 * Sends a pasted `.env`'s text to Rust, once, and answers what it came to: names, the numbers of lines that could not be read, and
 * which names clash in which folder, never a value. The text is only an argument of this one call: nothing here keeps it, logs it
 * or puts it in the session's record, and a refusal comes back as the shell's own object, which holds none of it.
 */
export async function readEnv(session: number, text: string): Promise<EnvRead> {
  const entry = sessionOf(session);
  if (entry === undefined) return "stale";
  const { generation } = entry;
  try {
    const answer = await api.envRead({ session, generation }, text);
    return stillOpen(session, generation) ? { rows: answer.data } : "stale";
  } catch (error) {
    if (refusedAsLocked(error)) dropSession(session);
    if (error instanceof api.StaleAnswer || !stillOpen(session, generation)) return "stale";
    return { failed: error };
  }
}

/**
 * Lets Rust forget the values of a pasted `.env` at once: a save in which every row is left out writes nothing, and uses the token
 * up. It is sent without waiting and its outcome is not shown (a token already gone is the same as one let go). A vault that has
 * locked since sends nothing: the lock already let the values go, and a stale call would only be refused.
 */
export function releaseEnv(session: number, generation: number, token: string, indexes: readonly number[]): void {
  if (!stillOpen(session, generation)) return;
  const choices = indexes.map((index): api.EnvChoice => ({ index, action: "leave_out" }));
  void api.envSave({ session, generation }, token, choices, null, false).then(undefined, (error: unknown) => {
    if (refusedAsLocked(error)) dropSession(session);
  });
}

/** Whether the shell refused a save because it no longer holds the pasted values (used, five minutes old, or let go by a lock). */
export function refusedAsEnvGone(error: unknown): boolean {
  return refusedWith(error, "not_found");
}

/** How a pasted `.env`'s save came out: how many keys were written (the panel is gone), a lock meanwhile (nothing to say), or the refusal. */
export type EnvSaved = { saved: number; closed: boolean } | "stale" | { failed: unknown };

/** "3 keys", "1 key". */
function keysWords(count: number): string {
  return `${String(count)} ${count === 1 ? "key" : "keys"}`;
}

/**
 * Saves the pasted keys with one choice for every row, into `collection` (a folder's id, or `null`), by the token Rust holds them
 * under. The list is read again whatever the answer (a save cut short can have written some). Written: the panel closes (when it is
 * still the one that saved) and "Saved 3 keys to <where>" is said, `where` being the folder's name or "No folder", as a move says it, and
 * after it what became of the clipboard when `clearClipboard` asked for it to be cleared (`sayAfterSave`).
 * A refusal comes back for the panel to say. A vault that locked meanwhile gets nothing said. `onScreen` says whether the panel that
 * asked is still the one on screen; it is asked at the moment the panel is closed, and `closed` is true only then, so a panel that
 * left the screen meanwhile (the person went to another vault) is closed in its record without asking for focus.
 */
export async function saveEnv(
  session: number,
  token: string,
  choices: api.EnvChoice[],
  collection: string | null,
  where: string,
  clearClipboard: boolean,
  onScreen: () => boolean,
): Promise<EnvSaved> {
  const starter = sessionOf(session)?.tool;
  const done = await change(session, (vault) => api.envSave(vault, token, choices, collection, clearClipboard));
  if (done === "stale") return "stale";
  if ("failed" in done) return { failed: done.failed };
  const { saved: count, clipboard } = done.done.data;
  sayAfterSave(session, `Saved ${keysWords(count)} to ${where}`, clipboard);
  const closes = starter !== undefined && starter !== null && sessionOf(session)?.tool === starter;
  const shown = closes && onScreen();
  if (closes) closeTool(session);
  return { saved: count, closed: shown };
}

/** Says something the person has to read and act on, until it is dismissed. */
function told(session: number, text: string): void {
  set({ ...state, toast: { kind: "told", session, text } });
}

/** What a save says of the clipboard after its own words, by what the shell answered. Nothing is said when the clear was not asked for. */
const CLIPBOARD_WORDS: Record<api.ClipboardAfter, string> = {
  cleared: "Clipboard cleared.",
  not_ours: "The clipboard had changed, so it was left alone.",
  failed: "The clipboard couldn't be cleared.",
  not_asked: "",
};

/**
 * Says what a save did (`base`, with no full stop) and what became of the clipboard. A clipboard that could not be cleared still holds
 * what was copied, so that one stays until it is dismissed; the others are said once, as any short message.
 */
function sayAfterSave(session: number, base: string, clipboard: api.ClipboardAfter): void {
  const after = CLIPBOARD_WORDS[clipboard];
  if (after === "") say(session, base);
  else if (clipboard === "failed") told(session, `${base}. ${after}`);
  else say(session, `${base}. ${after}`);
}

/** What a folder's keys taken out says when two of them share a name: nothing was copied or written. */
function twiceWords(name: string): string {
  return `${name} appears twice in this folder. Rename or move one, then try again.`;
}

/** What is said after a `.env` file is written: where it went, and that it is not encrypted. */
const UNENCRYPTED_COPY = "This copy isn't encrypted. Delete it when you're finished.";

/**
 * Copy all as .env: Rust makes the text and puts it on the clipboard with the marks and timer of any copy; the page hears only
 * whether it worked. Worked: "Keys copied" and when the clipboard clears. Two keys with one name: nothing is copied, and the
 * sentence says which. A refusal is said as a message; a vault that locked meanwhile gets nothing.
 */
export async function copyEnv(session: number, collection: string): Promise<void> {
  // What the shell answered besides `Done`, for after the copy is over (an object, so what is read is the answer and not a guess).
  const found: { twice: string | null } = { twice: null };
  const done = await copyThenTell(
    session,
    "Keys copied",
    async (vault) => {
      const answer = await api.envCopy(vault, collection);
      if (typeof answer.data === "object" && "Duplicate" in answer.data) found.twice = answer.data.Duplicate.name;
      return answer;
    },
    () => found.twice === null,
  );
  if (typeof done === "object") sayFailure(session, done.failed);
  else if (done === "done" && found.twice !== null) told(session, twiceWords(found.twice));
}

/**
 * What Save as .env file left for the dialog: nothing more (`done`: it was written, dismissed, said in words or refused), a vault
 * that locked meanwhile (`stale`: nothing to say, nothing was written), or a cloud-synced folder, with the token to answer with.
 */
export type EnvFile = "done" | "stale" | { confirm: string };

/** Says what a save dialog's outcome came to for a `.env` file, and what is left for the dialog. */
function sayEnvFile(session: number, outcome: api.Outcome<api.SavedView>): EnvFile {
  const result = keyPdfOf(outcome);
  if (typeof result === "object" && "confirm" in result) return result;
  if (typeof result === "object" && "saved" in result) told(session, `Saved in ${result.saved}. ${UNENCRYPTED_COPY}`);
  return "done";
}

/**
 * Saves the folder's keys as a readable `.env` file: Rust opens the save dialog and writes the file. Written: where it went, and that
 * the copy is not encrypted. A closed dialog does nothing. Two keys with one name: the same sentence as Copy all, and no file. A
 * refusal is said as a message. A lock while it runs makes the answer stale: no file, and nothing said.
 */
export async function saveEnvFile(session: number, collection: string): Promise<EnvFile> {
  let answer;
  try {
    answer = await printCommand(session, (vault) => api.envSaveFile(vault, collection));
  } catch (error) {
    sayFailure(session, error);
    return "done";
  }
  if (answer === "stale") return "stale";
  const out = answer.data;
  if (typeof out === "object" && "Duplicate" in out) {
    told(session, twiceWords(out.Duplicate.name));
    return "done";
  }
  if (typeof out === "object" && "Saved" in out) return sayEnvFile(session, out.Saved);
  // `"Done"` is the answer of a copy: not one a save can give, so it is said in the plain words rather than as a success.
  sayFailure(session, new Error("unexpected answer to env_save_file"));
  return "done";
}

/**
 * The person's yes to saving the `.env` file in a cloud-synced folder: the shell goes on with the save it parked. As the recovery key's
 * PDF: `not_found` alone is not news of a lock, so the shell is asked about the session (`whyNotFound`). Locked: the session leaves the
 * page and nothing is said. Still live: it is said in words as something to do again, the question closes, and the session stays.
 * A lookup that fails another way is said as that failure.
 */
export async function confirmEnvFile(session: number, token: string): Promise<EnvFile> {
  let answer;
  try {
    answer = await printCommand(session, () => api.saveReadableConfirm(token));
  } catch (error) {
    let failure = error;
    if (refusedWith(error, "not_found")) {
      try {
        return await whyNotFound(session, "env_file_expired");
      } catch (lookup) {
        failure = lookup;
      }
    }
    sayFailure(session, failure);
    return "done";
  }
  return answer === "stale" ? "stale" : sayEnvFile(session, answer.data);
}

// ---- The copy the save shortcut left (Task 18) ----
//
// The shell reads the clipboard when the shortcut is pressed and keeps the text in one slot; the page hears a state and an id
// (`lockbox://capture`) and never the text, which comes only on Reveal and is kept by the box that asked for it, never here. The copy
// is not a vault's: with every vault locked the lock screen asks for an unlock first (8b), and once one is open the save box (8a, 8c)
// takes that vault's panel and the copy is handed to it, so a lock of that vault lets the copy go.

/** The copy, session and generation a `capture_choose` was last sent for, so one is not sent twice for the same. */
let chooseSent: string | null = null;

/** The copy being read as a `.env` right now: its `gone` (the shell empties the slot as it reads it) must not close the box that asked. */
let converting: string | null = null;

/** The hand-over of a copy to a vault (`capture_choose`) as it was last sent, and whether it worked: Reveal waits for it, since the shell calls the vault locked until it is done. */
let choosing: { id: string; done: Promise<boolean> } | null = null;

/** How many `lockbox://capture` events the page has heard: an answer to `capture_state` that was asked before one came is older than it. */
let captureHeard = 0;

let captureStarted: Promise<void> | undefined;

/**
 * Starts hearing the shortcut, once the lock listener is up (call it after `startStore`): listens for `lockbox://capture` first, then
 * asks what is waiting, so a copy made before the page loaded is shown and one made between is not lost. The answer is as old as the
 * moment the shell read the slot: if any event was heard while it was on its way, the event is newer and the answer is dropped (a newer
 * copy is not replaced by an older one, and a `gone` is not undone). Nothing is said when the listener or the question fails: the
 * next press is told by the event if the listener is up.
 */
export function startCapture(): Promise<void> {
  captureStarted ??= (async () => {
    if (refusedWith(state.startError, "page")) return;
    try {
      await api.onCapture((event) => {
        captureHeard += 1;
        takeCapture(event);
      });
    } catch {
      return;
    }
    try {
      const heardBefore = captureHeard;
      const waiting = await api.captureState();
      if (waiting !== null && captureHeard === heardBefore) takeCapture(waiting);
    } catch {
      // Nothing waiting, as far as the page can know.
    }
  })();
  return captureStarted;
}

/** Lets the shell forget the copy at once. An id that is not the waiting one's is a quiet no-op there, and any refusal is not news. */
function letGo(id: string): void {
  void api.captureCancel(id).catch(() => undefined);
}

/**
 * The copy is over, as far as the page goes: the box closes (unless `closeBox` is false) and nothing of it stays. `tellShell` is for when the
 * shell may still hold it (Cancel, a panel that took the place, a lock): it is asked to let go, and a copy it has let go already makes that a no-op.
 */
function endCapture(tellShell: boolean, closeBox = true): void {
  const capture = state.capture;
  if (capture === null) return;
  chooseSent = null;
  choosing = null;
  set({
    ...state,
    capture: null,
    sessions: closeBox
      ? state.sessions.map((entry) => (entry.tool?.kind === "save_box" ? { ...endReveals(entry), tool: null } : entry))
      : state.sessions,
  });
  if (tellShell) letGo(capture.id);
}

/** Cancel (the box's, or the lock screen's): the copy is let go at once, here and in the shell. */
export function cancelCapture(): void {
  endCapture(true);
}

/** The box that showed copy `id` has left the screen some other way (another panel took its place): the copy is let go, if it is still the one waiting. */
export function abandonCapture(id: string): void {
  if (state.capture?.id === id) endCapture(true);
}

/**
 * Takes in what the shortcut did: a copy (`value`, `empty`, `too_large`), or `gone` for one the shell let go of. A `gone` for another id than the
 * one held is an old copy's and changes nothing. With no vault in existence at all (first-time setup is showing) the copy is let go and nothing
 * shows. A copy that comes while another waits replaces it: what was typed in the box is kept, and `changed` says the value differs.
 */
function takeCapture(event: unknown): void {
  if (!isRecord(event) || typeof event.capture_id !== "string") return;
  const id = event.capture_id;
  const copied = event.state;
  if (copied === "gone") {
    if (state.capture?.id === id) endCapture(false, converting !== id);
    return;
  }
  if (copied !== "value" && copied !== "empty" && copied !== "too_large") return;
  if (state.vaults !== null && state.vaults.length === 0) {
    letGo(id);
    return;
  }
  const before = state.capture;
  set({
    ...state,
    capture: {
      id,
      state: copied,
      envKeys: copied === "value" && typeof event.env_keys === "number" ? event.env_keys : null,
      changed: (before?.changed ?? false) || event.changed === true,
      chosen: before?.chosen ?? null,
    },
  });
  seatCapture();
}

/**
 * Puts a waiting copy in front of the person: in the vault on screen (the one opened last), its box takes the panel as opening any tool
 * does, and the copy is handed to it. With no vault open there is nothing to do: the lock screen shows the step (8b), and `unlock` comes back
 * here. A read-only vault cannot take a key, so it is said and the copy is let go. A box already open stays as it is, with what was typed.
 */
function seatCapture(): void {
  const capture = state.capture;
  const active = state.sessions.at(-1);
  if (capture === null || active === undefined) return;
  if (active.readOnly) {
    sayFailure(active.session, { code: "read_only" });
    endCapture(true);
    return;
  }
  if (active.tool?.kind !== "save_box") openTool(active.session, { kind: "save_box" });
  const sent = `${capture.id}:${String(active.session)}:${String(active.generation)}`;
  if (chooseSent === sent) return;
  chooseSent = sent;
  set({ ...state, capture: { ...capture, chosen: active.session } });
  choosing = { id: capture.id, done: chooseCapture(active.session, active.generation, capture.id) };
}

/**
 * `capture_choose`: tells the shell which vault the copy was handed to, and answers whether that worked. A lock the page missed takes the
 * vault off; an old id means the shell has let go or replaced the copy (its `gone` or a new copy is on its way), so the box goes quietly;
 * another refusal is said.
 */
async function chooseCapture(session: number, generation: number, id: string): Promise<boolean> {
  try {
    await api.captureChoose({ session, generation }, id);
    return true;
  } catch (error) {
    if (refusedAsLocked(error)) {
      dropSession(session);
      return false;
    }
    if (error instanceof api.StaleAnswer || !stillOpen(session, generation)) return false;
    if (refusedWith(error, "not_found")) {
      if (state.capture?.id === id) endCapture(false);
      return false;
    }
    sayFailure(session, error);
    return false;
  }
}

/** What Reveal came to: the value (for the box that asked to keep, never here), a copy that is gone (nothing to say), or a refusal. */
export type CaptureRevealed = { value: string } | "gone" | { failed: unknown };

/**
 * Reveal on the copied value: asked of the shell by the copy's id. The answer is only for that copy: one that comes after the copy was
 * replaced or let go is dropped, and so is its value. A copy the shell no longer has closes the box quietly, and a vault that locked takes the
 * copy with it (the page missed the lock). The value is handed back to the caller and kept nowhere here. The shell calls the vault locked until
 * the copy has been handed to it, so Reveal waits for that hand-over (`capture_choose`) to finish, and asks nothing if it did not work: a `locked`
 * that came only from asking too early would otherwise be taken for a lock and take the vault off the screen.
 */
export async function revealCapture(id: string): Promise<CaptureRevealed> {
  const current = () => state.capture?.id === id;
  if (choosing?.id === id && !(await choosing.done)) return "gone";
  if (!current()) return "gone";
  try {
    const value = await api.captureReveal(id);
    return current() ? { value } : "gone";
  } catch (error) {
    if (!current()) return "gone";
    if (refusedWith(error, "not_found")) {
      endCapture(false);
      return "gone";
    }
    const chosen = state.capture?.chosen;
    if (refusedAsLocked(error) && chosen !== null && chosen !== undefined) {
      dropSession(chosen);
      return "gone";
    }
    return { failed: error };
  }
}

/**
 * Asks the shell whether copy `id` is still waiting, after a `not_found` that could be about something else (a folder that is not there):
 * a copy that is gone, or replaced by another, is dealt with as its event would have, and the answer is false; one that is still there is true.
 * When the question itself fails the copy is taken to be there, so the person sees the refusal and can cancel.
 */
async function copyStillThere(id: string): Promise<boolean> {
  let waiting: api.CaptureEvent | null;
  try {
    waiting = await api.captureState();
  } catch {
    return true;
  }
  if (state.capture?.id !== id) return false;
  if (waiting === null || waiting.state === "gone") {
    endCapture(false);
    return false;
  }
  if (waiting.capture_id !== id) {
    takeCapture(waiting);
    return false;
  }
  return true;
}

/** How saving the copy came out: saved (the box is gone, the key is open), a name taken (`clash` is the name Keep both would use), a lock or a gone copy (nothing to say), or the refusal. */
export type CaptureSaveResult = "saved" | "stale" | "gone" | { clash: string } | { failed: unknown };

/**
 * Saves the copy as a key in the vault, in one write by the shell, which also clears the clipboard when asked. A name that is taken comes
 * back as `clash`, with nothing written. Saved: the copy is over, the list is read again, the new key is selected and "<name> saved in <where>" is said,
 * with what became of the clipboard (`sayAfterSave`). A refusal comes back for the box to say, and the box stays. A lock meanwhile gets nothing
 * said (what was written stays written); a copy the shell no longer has closes the box quietly, but a `not_found` while the copy is still waiting
 * is about the folder, and is said.
 */
export async function saveCapture(session: number, save: api.CaptureSave, where: string): Promise<CaptureSaveResult> {
  const entry = sessionOf(session);
  if (entry === undefined) return "stale";
  const { generation } = entry;
  try {
    const answer = await api.captureSave({ session, generation }, save);
    if (!stillOpen(session, generation)) return "stale";
    if ("Clash" in answer.data) return { clash: answer.data.Clash.saved_as };
    const { id, name, clipboard } = answer.data.Saved;
    // The shell has let go of the copy (its `gone` may have come already): so does the page.
    if (state.capture?.id === save.captureId) endCapture(false);
    const record = sessionOf(session);
    if (record === undefined) return "stale";
    if ((await loadItems(record)) === "stale" || !stillOpen(session, generation)) return "stale";
    // The saved key is selected only if the panel is still free: another press, or another form or item opened while this was on its way, has
    // the panel now, and it is left as it is (its copy, or what was typed in it). The save is still said.
    const now = sessionOf(session);
    if (state.capture === null && now !== undefined && now.tool === null && now.openItem === null) {
      void selectItem(session, id, { saved: true });
    }
    sayAfterSave(session, `${name} saved in ${where}`, clipboard);
    return "saved";
  } catch (error) {
    if (refusedAsLocked(error)) dropSession(session);
    if (error instanceof api.StaleAnswer || !stillOpen(session, generation)) return "stale";
    if (refusedWith(error, "not_found") && !(await copyStillThere(save.captureId))) return "gone";
    return { failed: error };
  }
}

/** How reading the copy as a `.env` came out: the paste panel is open on its rows, a lock or a gone copy (nothing to say), or the refusal. */
export type CaptureEnvResult = "opened" | "stale" | "gone" | { failed: unknown };

/**
 * "Save as separate keys": the shell reads the copy as a `.env` and parks it as a paste (names only come back); the copy goes into the paste, so
 * the shell's slot is empty, and the paste panel opens on the rows as if they had been pasted, in `folder` (what the box had chosen). If the box was
 * closed meanwhile (Cancel while the shell was reading), the panel does not open and the values are let go as Cancel would. A refusal is said in the box.
 */
export async function captureAsEnv(session: number, id: string, folder: string): Promise<CaptureEnvResult> {
  const entry = sessionOf(session);
  if (entry === undefined || entry.readOnly) return "stale";
  const { generation } = entry;
  converting = id;
  try {
    const answer = await api.captureEnv({ session, generation }, id);
    if (!stillOpen(session, generation)) return "stale";
    const rows = answer.data;
    // The box that asked is still the one on screen, with no newer copy in it: a second press while this was on its way has a box of its own,
    // which this must not close, and a box that was cancelled has nothing to open on. Either way the values this read parked are let go.
    const newer = state.capture !== null && state.capture.id !== id;
    if (newer || sessionOf(session)?.tool?.kind !== "save_box") {
      if (rows.token !== null) releaseEnv(session, generation, rows.token, rows.rows.map((row) => row.index));
      return "gone";
    }
    endCapture(false);
    pasteOpenings += 1;
    openTool(session, { kind: "paste_env", opening: pasteOpenings, rows, folder });
    return "opened";
  } catch (error) {
    if (refusedAsLocked(error)) dropSession(session);
    if (error instanceof api.StaleAnswer || !stillOpen(session, generation)) return "stale";
    if (refusedWith(error, "not_found")) {
      if (state.capture?.id === id) endCapture(false);
      return "gone";
    }
    return { failed: error };
  } finally {
    if (converting === id) converting = null;
  }
}

/** Opens the search (Ctrl+F, Ctrl+K): the one search, empty. It does nothing when there is no vault open, or one is open already. */
export function openSearch(): void {
  if (state.search !== null || state.sessions.length === 0) return;
  searchRun += 1;
  searchOpening += 1;
  set({ ...state, search: { query: "", answered: null, hits: [], busy: [], error: null, asking: null } });
}

/** Closes the search and forgets what was typed and found; an answer still on its way is dropped. */
export function closeSearch(): void {
  searchRun += 1;
  searchOpening += 1;
  if (state.search !== null) set({ ...state, search: null });
}

/**
 * Types in the search: what each unlocked vault finds comes back through the shell, and only the latest question's
 * answer is kept. A vault that locked meanwhile is left out with nothing said. Nothing is asked for a blank word.
 */
export async function setSearchQuery(query: string): Promise<void> {
  const current = state.search;
  if (current === null) return;
  searchRun += 1;
  const run = searchRun;
  const blank = query.trim() === "";
  set({ ...state, search: { ...current, query, error: null, ...(blank ? { answered: null, hits: [], busy: [] } : {}) } });
  if (blank) return;
  try {
    const answer = await api.searchAll(query);
    if (run !== searchRun || state.search === null) return;
    // Only the vaults still open as they were read: a lock on the way takes that vault's results away, with no error.
    const hits = answer.hits
      .filter((found) => stillOpen(found.session, found.generation))
      .map((found) => ({ session: found.session, generation: found.generation, items: found.data }));
    const busy = answer.busy.filter((session) => sessionOf(session) !== undefined);
    set({ ...state, search: { ...state.search, answered: query, hits, busy, error: null } });
  } catch (error) {
    if (run !== searchRun || state.search === null) return;
    set({ ...state, search: { ...state.search, answered: null, hits: [], busy: [], error } });
  }
}

function sayInSearch(error: unknown): void {
  if (state.search !== null) set({ ...state, search: { ...state.search, error } });
}

/** Puts the vault on screen (the one opened last is shown) and opens the item in its panel, closing the search. */
export function showResult(session: number, id: string): void {
  const entry = sessionOf(session);
  if (entry === undefined) return;
  set({ ...state, sessions: [...state.sessions.filter((other) => other.session !== session), entry] });
  closeSearch();
  void selectItem(session, id);
}

/**
 * Copy from a search result: the copy is made by the shell, then the search steps aside and the login opens behind it
 * with the message about the copy and its clear time. A refusal is said in the search, which stays.
 */
export async function copyFromSearch(session: number, id: string, field: CopyableField): Promise<void> {
  const done = await copyAndTell(session, id, field);
  if (done === "done") showResult(session, id);
  else if (typeof done === "object") sayInSearch(done.failed);
}

/** "Open site" on a search result: the login's first website, opened by the shell. A refusal is said in the search. */
export async function openFromSearch(session: number, id: string): Promise<void> {
  const done = await openAndTell(session, id, 0);
  if (typeof done === "object") sayInSearch(done.failed);
}

/** Takes the message away. */
export function clearToast(): void {
  if (state.toast !== null) set({ ...state, toast: null });
}

/** Keeps a value the person asked to see, for as long as the vault stays unlocked. Refused for a vault that is not. */
export function addReveal(session: number, id: string, value: string): void {
  update(session, (entry) => ({ ...entry, reveals: { ...entry.reveals, [id]: value } }));
}

export function getReveal(session: number, id: string): string | undefined {
  return sessionOf(session)?.reveals[id];
}

/** Keeps text typed into a form, by name, for as long as the vault stays unlocked. */
export function setForm(session: number, name: string, value: string): void {
  update(session, (entry) => ({ ...entry, forms: { ...entry.forms, [name]: value } }));
}

export function getForm(session: number, name: string): string | undefined {
  return sessionOf(session)?.forms[name];
}

export function useSessions(): SessionData[] {
  return useSelect((current) => current.sessions);
}

export function useVaults(): VaultEntry[] | null {
  return useSelect((current) => current.vaults);
}

export function useStartError(): unknown {
  return useSelect((current) => current.startError);
}

export function useToast(): Toast | null {
  return useSelect((current) => current.toast);
}

export function useNotices(): Notices {
  return useSelect((current) => current.notices);
}

export function useLockNote(): unknown {
  return useSelect((current) => current.lockNote);
}

/** The search, or `null` while it is closed. */
export function useSearch(): SearchState | null {
  return useSelect((current) => current.search);
}

/** The settings as the shell has them saved, or the defaults while the page has none. */
export function useSettings(): api.Settings {
  return useSelect((current) => current.settings ?? DEFAULT_SETTINGS);
}

/** The copy the save shortcut left waiting, or `null` for none. */
export function useCapture(): CaptureView | null {
  return useSelect((current) => current.capture);
}

/** The vault's item list, or `null` while it is on its way or when the vault is not unlocked. */
export function useItems(session: number): ItemSummary[] | null {
  return useSelect((current) => current.sessions.find((entry) => entry.session === session)?.items ?? null);
}

/** The same, for code that is not a component. */
export function openedItems(session: number): ItemSummary[] | null {
  return sessionOf(session)?.items ?? null;
}

export function useForm(session: number, name: string): string {
  return useSelect((current) => current.sessions.find((entry) => entry.session === session)?.forms[name] ?? "");
}

/** For tests: the store as it stands. */
export function debugState(): StoreState {
  return state;
}

/** For tests: back to a page that has just opened. */
export function resetStoreForTests(): void {
  started = undefined;
  noticesStarted = undefined;
  captureStarted = undefined;
  captureHeard = 0;
  choosing = null;
  chooseSent = null;
  converting = null;
  confirmingClose = false;
  searchRun = 0;
  searchOpening = 0;
  retryingOpen = false;
  settingsLine = Promise.resolve();
  shortcutNoticeVoid = false;
  listRuns.clear();
  detailRuns.clear();
  cleanupNotices = 0;
  state = EMPTY;
  for (const notify of listeners) notify();
}
