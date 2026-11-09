// What the page keeps of each unlocked vault: its item list, the item open in the panel, values the person asked to
// see, text typed into a form, the message about the last copy, and a recovery key being shown or picked back (with the
// questions asked of it), and what its unlock found that is still to be answered (the app's questions, `SessionAsks`).
// Beside the sessions, only what launch told and a refusal for the lock screen. Nothing else. A lock wipes the lot at once: the
// store listens for `lockbox://locked` before any command is sent, and a lock event drops the vault's whole record
// (`dropSession`). An answer that comes back for a vault that has locked since is dropped without a word (it is the
// expected outcome of a lock, not an error): the bridge refuses it with `StaleAnswer`, and so does this file when the
// session it was for is gone.
import { useSyncExternalStore } from "react";
import * as api from "./api";
import type { CopyableField, ItemDetail, ItemSummary, VaultEntry } from "./api";
import type { Ask } from "./screens/setup/keyWords";

/** The item open in the panel: its summary row's id, and what the shell said of it once it has. */
export interface OpenItem {
  id: string;
  detail: ItemDetail | null;
  /** The shell's refusal, when it would not give the item. */
  error: unknown;
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
  /** The folder shown, or `null` for All items. */
  folder: string | null;
  /** Values the person asked to see (a password on Reveal), by item. */
  reveals: Record<string, string>;
  /** Text typed and not saved, by name. */
  forms: Record<string, string>;
  /** The recovery key step this vault is in, or `null`. */
  recovery: RecoveryStep | null;
  /** What the unlock found, still to be answered. */
  asks: SessionAsks;
}

/** The message about the last copy (or the refusal of one), and the vault that made it. */
export type Toast =
  | { kind: "copied"; session: number; text: string; seconds: number; endsAt: number }
  | { kind: "failed"; session: number | null; error: unknown };

export interface StoreState {
  /** `null` until the vault list has come. */
  vaults: VaultEntry[] | null;
  /** The shell's refusal, when the vault list could not be read. */
  startError: unknown;
  /** The unlocked vaults, in the order they were unlocked. */
  sessions: SessionData[];
  toast: Toast | null;
  notices: Notices;
  /** A refusal to say on the lock screen, since the vault it was about has locked (Ask 16); `null` for none. */
  lockNote: unknown;
}

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
  notices: { lostOutputs: false, restoreFinished: false },
  lockNote: null,
};

let state: StoreState = EMPTY;
const listeners = new Set<() => void>();
let started: Promise<void> | undefined;

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
  set({
    ...state,
    sessions: state.sessions.filter((entry) => entry.session !== session),
    toast: keepToast ? toast : null,
  });
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
    folder: null,
    reveals: {},
    forms: {},
    recovery,
    asks,
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
 * refusal is thrown for the screen to say. `meansLocked` names a refusal that also means the vault locked and the page
 * missed it (a cloud question's token the shell has dropped).
 */
async function printCommand<T>(
  session: number,
  run: (vault: api.SessionRef) => Promise<T>,
  meansLocked: (error: unknown) => boolean = () => false,
): Promise<T | "stale"> {
  const entry = sessionOf(session);
  if (entry === undefined) return "stale";
  const { generation } = entry;
  try {
    const answer = await run({ session, generation });
    return stillOpen(session, generation) ? answer : "stale";
  } catch (error) {
    const missedLock = refusedAsLocked(error) || meansLocked(error);
    if (missedLock) dropSession(session);
    if (error instanceof api.StaleAnswer || missedLock || !stillOpen(session, generation)) return "stale";
    throw error;
  }
}

function keyPdfFrom(answer: api.Tagged<api.Outcome<api.SavedView>>): KeyPdf {
  const outcome = answer.data;
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
 * The person's yes to saving it in a cloud-synced folder: the shell goes on with the save it parked. The shell drops a
 * session's parked questions when it locks, so `not_found` here means the vault locked and the page missed the event: the
 * key and the question come off the screen, and nothing is said.
 */
export async function confirmKeyPdf(session: number, token: string): Promise<KeyPdf> {
  const answer = await printCommand(
    session,
    () => api.saveReadableConfirm(token),
    (error) => refusedWith(error, "not_found"),
  );
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

async function loadItems(record: SessionData): Promise<"opened" | "stale"> {
  const { session, generation } = record;
  try {
    const list = await api.listItems(record);
    if (!stillOpen(session, generation)) return "stale";
    // Items that can't be read are told at unlock (Ask 4); the list's own count counts too, whichever is more.
    update(session, (entry) => ({
      ...entry,
      items: list.data.items,
      loadError: null,
      asks: { ...entry.asks, unreadable: Math.max(entry.asks.unreadable, list.data.damaged.length) },
    }));
    return "opened";
  } catch (error) {
    // A lock that overtook the question: the bridge says so, and so does the shell ("locked"). If the page never heard
    // the lock, the refusal is the news of it: the vault goes.
    if (refusedAsLocked(error)) dropSession(session);
    if (error instanceof api.StaleAnswer || refusedAsLocked(error) || !stillOpen(session, generation)) return "stale";
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

/** Closes one of an unlock's banners. It comes back at the next unlock if the shell still has it to report. */
export function closeBanner(session: number, banner: Banner): void {
  updateAsks(session, (asks) => (asks.closed.includes(banner) ? asks : { ...asks, closed: [...asks.closed, banner] }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Takes in what launch, or a running app, tells. Only the kinds that have a question in 4A change anything: the record of
 * opened files that could not be read (Ask 11), and a restore finished at launch. The shell keeps its launch notices
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

/** Opens an item in the panel, or closes the panel (`null`). */
export async function selectItem(session: number, id: string | null): Promise<void> {
  const entry = sessionOf(session);
  if (entry === undefined) return;
  if (id === null) {
    update(session, (current) => ({ ...current, openItem: null }));
    return;
  }
  const { generation } = entry;
  update(session, (current) => ({ ...current, openItem: { id, detail: null, error: null } }));
  const shows = () => sessionOf(session)?.openItem?.id === id && stillOpen(session, generation);
  try {
    const answer = await api.getItem({ session, generation }, id);
    if (shows()) update(session, (current) => ({ ...current, openItem: { id, detail: answer.data, error: null } }));
  } catch (error) {
    if (refusedAsLocked(error)) dropSession(session);
    if (error instanceof api.StaleAnswer || !shows()) return;
    update(session, (current) => ({ ...current, openItem: { id, detail: null, error } }));
  }
}

/** Shows a folder's items (`null`: all items), and closes the panel. */
export function selectFolder(session: number, folder: string | null): void {
  update(session, (entry) => ({ ...entry, folder, openItem: null }));
}

/**
 * Asks the shell to put a field of the item on the clipboard (it never reaches the page) and tells the person when it
 * will be cleared. A vault that locked meanwhile gets no message.
 */
export async function copyField(session: number, id: string, field: CopyableField): Promise<void> {
  const entry = sessionOf(session);
  if (entry === undefined) return;
  const { generation } = entry;
  try {
    const { clipboard_seconds } = await api.getSettings();
    await api.copyField({ session, generation }, id, field);
    if (!stillOpen(session, generation)) return;
    set({
      ...state,
      toast: {
        kind: "copied",
        session,
        text: field === "password" ? "Password copied" : "Username copied",
        seconds: clipboard_seconds,
        endsAt: Date.now() + clipboard_seconds * 1000,
      },
    });
  } catch (error) {
    if (refusedAsLocked(error)) dropSession(session);
    if (error instanceof api.StaleAnswer || !stillOpen(session, generation)) return;
    set({ ...state, toast: { kind: "failed", session, error } });
  }
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
  state = EMPTY;
  for (const notify of listeners) notify();
}
