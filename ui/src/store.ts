// What the page keeps of each unlocked vault: its item list, the item open in the panel, values the person asked to
// see, text typed into a form, and the message about the last copy. Nothing else. A lock wipes the lot at once: the
// store listens for `lockbox://locked` before any command is sent, and a lock event drops the vault's whole record
// (`dropSession`). An answer that comes back for a vault that has locked since is dropped without a word (it is the
// expected outcome of a lock, not an error): the bridge refuses it with `StaleAnswer`, and so does this file when the
// session it was for is gone.
import { useSyncExternalStore } from "react";
import * as api from "./api";
import type { CopyableField, ItemDetail, ItemSummary, VaultEntry } from "./api";

/** The item open in the panel: its summary row's id, and what the shell said of it once it has. */
export interface OpenItem {
  id: string;
  detail: ItemDetail | null;
  /** The shell's refusal, when it would not give the item. */
  error: unknown;
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
}

/** The page's own refusal for a lock listener that could not be set up; `messages.ts` has its words. */
const LISTENER_FAILED = { code: "page", kind: "lock_listener" };

/** Whether the shell refused as locked: the vault is locked and the page missed the event that said so. */
function refusedAsLocked(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "locked";
}

const EMPTY: StoreState = { vaults: null, startError: null, sessions: [], toast: null };

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
  const record: SessionData = {
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
  };
  set({ ...state, sessions: [...state.sessions.filter((entry) => entry.session !== record.session), record] });
  return loadItems(record);
}

async function loadItems(record: SessionData): Promise<"opened" | "stale"> {
  const { session, generation } = record;
  try {
    const list = await api.listItems(record);
    if (!stillOpen(session, generation)) return "stale";
    update(session, (entry) => ({ ...entry, items: list.data.items, loadError: null }));
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
  state = EMPTY;
  for (const notify of listeners) notify();
}
