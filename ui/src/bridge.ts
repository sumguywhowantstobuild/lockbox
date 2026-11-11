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

/** The folders a restore journal names, as the user's own paths (spec 6.8): shown so they can act, nothing else. */
export interface JournalPaths {
  step: "extracting" | "swapping";
  staging: string;
  target: string;
  before_restore: string | null;
}

/**
 * What restore recovery found (`restore_notice`, and `lockbox://notice` with `kind: "restore"`, which carries these
 * fields beside the kind): at launch, or when a restore ends in a state the user must hear about.
 */
export type RestoreNotice =
  | { state: "none" }
  | { state: "recovered"; how: "staging_removed" | "rolled_back" | "finished" }
  | { state: "drive_missing"; paths: JournalPaths }
  | { state: "pending"; paths: JournalPaths }
  | { state: "unclear"; journal: string; paths: JournalPaths | null };

/**
 * What launch, or a running app, has to tell (`launch_notices`, and `lockbox://notice`): flat objects tagged `kind`, with
 * counts and flags only. The output sweep's `unreadable` is true when the record of opened files could not be read.
 * `first_close` comes only as an event, never from `launch_notices`: `explain: true` when the window was closed for the
 * first time (every vault is locked and the window stayed visible: show 5b), `explain: false` once the explanation is
 * done, by 5b's button (`closeExplainedOk`) or by a second close while it showed (the window hides either way).
 */
export type PageNotice =
  | { kind: "output_sweep"; removed: number; kept: number; unreadable: boolean }
  | { kind: "open_cleanup"; removed: number; still_open: number }
  | ({ kind: "restore" } & RestoreNotice)
  | { kind: "first_close"; explain: boolean }
  /** Windows said the save shortcut (Ctrl+Shift+L) belongs to another app: it is off until Lockbox is started again. */
  | { kind: "shortcut_taken" }
  /** The shortcut could not be turned on for a reason that is not another app holding it. */
  | { kind: "shortcut_not_set" };

/** What dismissing a restore journal leaves behind, for the user to act on. */
export interface Leaves {
  staging: string | null;
  before_restore: string | null;
}

/**
 * A question the user answers before the command goes on. Each command that asks adds its variant. `Executable` has
 * no token: it is confirmed by sending `open_file` again with `confirmed_executable`. `MissingFiles` has none
 * either: it is confirmed by sending `copy_item_to` again with `skip_missing`; its names are the user's own file
 * names, vault data, so it only ever arrives in a tagged answer. `NewFolder` is answered with
 * `restore_prepare_confirm` (the token and the folder's name), `CloudFolder` of a restore with the same command and
 * no name. `Dismissal` is confirmed by sending `dismiss_restore` again with `confirm`, `DeletePreRestore` by sending
 * `delete_pre_restore` again with `confirm`. `Recovery` is not a question: a restore journal was found and recovery
 * ran, and this is what it found.
 */
export type Confirm =
  | { CloudFolder: { token: string } }
  | { HeaderChanged: { token: string } }
  | "Executable"
  | { MissingFiles: { names: string[] } }
  | { NewFolder: { suggested: string; token: string } }
  | { Dismissal: { leaves: Leaves } }
  | "DeletePreRestore"
  | { Recovery: { notice: RestoreNotice } };

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

/** A session and the generation the page read it in. */
export interface SessionRef {
  session: number;
  generation: number;
}

/**
 * A command over two sessions (`copy_item_to`: out of a backup, into a vault): `Tagged<T>` for the session it is
 * tagged with, and `other` is the second one. The answer is dropped ({@link StaleAnswer}) unless both are current, so
 * a lock of only the source session drops it too.
 */
export async function callPair<T>(cmd: string, args: InvokeArgs, other: SessionRef): Promise<Tagged<T>> {
  const answer = await invoke<Tagged<T>>(cmd, args);
  if (!isCurrent(answer) || generations.get(other.session) !== other.generation) throw new StaleAnswer();
  return answer;
}

/**
 * What a command over several sessions answers (`search_all`, the shell's `views::SearchResults`): one tagged answer
 * per vault searched, and the sessions that were busy (a long change held them), to search again later.
 */
export interface SearchResults<T> {
  hits: Tagged<T>[];
  busy: number[];
}

/**
 * A command over several sessions (`search_all`): keeps only the hits from a current generation; `busy` (sessions
 * only, no vault data) passes through as it came.
 */
export async function callMany<T>(cmd: string, args?: InvokeArgs): Promise<SearchResults<T>> {
  const answer = await invoke<SearchResults<T>>(cmd, args);
  return { hits: answer.hits.filter(isCurrent), busy: answer.busy };
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

/** Listens for `lockbox://notice`: each notice is handed over as it came (it holds no vault data, so it has no generation). */
export function onNotice(handler: (notice: PageNotice) => void): Promise<UnlistenFn> {
  return listen<PageNotice>("lockbox://notice", ({ payload }) => {
    handler(payload);
  });
}

/**
 * What the save shortcut left in the shell, as `lockbox://capture` and `capture_state` say it: the copy's id (32 lowercase hex
 * characters, new for every press), what the clipboard held (`value`, `empty` for no text, `too_large`), or `gone` when the copy
 * was let go. Never the value. `changed` is true when a copy was waiting and this one's value is different; `env_keys` is how many
 * keys the copy reads as when it is a `.env` of at least one key and no line that can't be read, otherwise `null`.
 */
export interface CaptureEvent {
  capture_id: string;
  state: "value" | "empty" | "too_large" | "gone";
  changed: boolean;
  env_keys: number | null;
}

/** Listens for `lockbox://capture`: each event is handed over as it came (it holds no vault data, so it has no generation). */
export function onCapture(handler: (event: CaptureEvent) => void): Promise<UnlistenFn> {
  return listen<CaptureEvent>("lockbox://capture", ({ payload }) => {
    handler(payload);
  });
}

/**
 * Listens for locks: each makes the session's older answers stale, then `handler` runs (to clear the screens). An
 * event older than what the bridge has seen (it arrived after the session was unlocked again) is ignored.
 */
export function onLocked(handler?: (event: LockedEvent) => void): Promise<UnlistenFn> {
  return listen<LockedEvent>("lockbox://locked", ({ payload }) => {
    if (advance(payload.session, payload.generation)) handler?.(payload);
  });
}
