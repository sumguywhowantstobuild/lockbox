// The one place the page calls Rust. Every answer carrying a vault's data is tagged with the session generation it
// was read in, and the bridge drops it unless that generation is still the session's current one (spec §7.4): an
// answer from before a lock never reaches the screens.
import { invoke, type InvokeArgs } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** One session's data, as a one-session command answers it. */
export interface Tagged<T> {
  session: number;
  generation: number;
  data: T;
}

/** A question the user answers before the command goes on. Each command that asks adds its variant. */
export type Confirm = { HeaderChanged: { token: string } };

/** The answer of a command that may ask first or open a dialog the user may close. */
export type Outcome<T> = { Done: T } | { Confirm: Confirm } | "Dismissed";

/** What {@link open} gives back: the new session's answer, or the question or closed dialog as it came. */
export type Opened<T> = Tagged<T> | { Confirm: Confirm } | "Dismissed";

export type LockReason = "manual" | "idle" | "windows_locked" | "sleep" | "drive_gone" | "app_closing" | "restore";

/** `lockbox://locked`: the session's generation after the lock. */
export interface LockedEvent {
  session: number;
  generation: number;
  reason: LockReason;
}

/** An answer from a generation that is no longer current: the vault locked (or unlocked again) meanwhile. */
export class StaleAnswer extends Error {
  constructor() {
    super("stale answer");
    this.name = "StaleAnswer";
  }
}

// Each session's current generation: the highest one seen, from an opening answer or a lock. Generations only grow.
const generations = new Map<number, number>();

function isCurrent(answer: Tagged<unknown>): boolean {
  return generations.get(answer.session) === answer.generation;
}

// Moves the session to `generation`, unless the bridge has already seen a later one.
function advance(session: number, generation: number): boolean {
  const known = generations.get(session);
  if (known !== undefined && generation < known) return false;
  generations.set(session, generation);
  return true;
}

/** A command without vault data (app info, settings, the vault list): its answer as it is. */
export function callPlain<T>(cmd: string, args?: InvokeArgs): Promise<T> {
  return invoke<T>(cmd, args);
}

/** A one-session command: `Tagged<T>`, or `Tagged<Outcome<T>>`. Rejects with {@link StaleAnswer} when stale. */
export async function call<T>(cmd: string, args?: InvokeArgs): Promise<Tagged<T>> {
  const answer = await invoke<Tagged<T>>(cmd, args);
  if (!isCurrent(answer)) throw new StaleAnswer();
  return answer;
}

/** A command over several sessions (`search_all`): keeps only the elements from a current generation. */
export async function callMany<T>(cmd: string, args?: InvokeArgs): Promise<Tagged<T>[]> {
  const answers = await invoke<Tagged<T>[]>(cmd, args);
  return answers.filter(isCurrent);
}

/**
 * An opening command (unlock, create, recover, open read-only): `Tagged<T>` or `Outcome<Tagged<T>>`. The new
 * session's generation becomes its current one; a question or a closed dialog passes through. Rejects with
 * {@link StaleAnswer} when the session has locked since (its lock event came first).
 */
export async function open<T>(cmd: string, args?: InvokeArgs): Promise<Opened<T>> {
  const answer = await invoke<Tagged<T> | Outcome<Tagged<T>>>(cmd, args);
  if (answer === "Dismissed" || "Confirm" in answer) return answer;
  const tagged = "Done" in answer ? answer.Done : answer;
  if (!advance(tagged.session, tagged.generation)) throw new StaleAnswer();
  return tagged;
}

/** Listens for locks: each makes the session's older answers stale, then `handler` runs (to clear the screens). */
export function onLocked(handler?: (event: LockedEvent) => void): Promise<UnlistenFn> {
  return listen<LockedEvent>("lockbox://locked", ({ payload }) => {
    advance(payload.session, payload.generation);
    handler?.(payload);
  });
}
