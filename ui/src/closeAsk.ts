// The question a close or a Quit asks while a job runs (Plan 4B Task 12). The shell sends `lockbox://close-asked` and holds everything (nothing is
// locked, hidden or cancelled) until `close_answer`. The page keeps the one question that is pending, answers it once, and drops it when the shell
// has: a lock epoch change (Lock all, Windows locking or sleeping, an idle lock) clears the shell's side, so the page's goes with it.
// Only fixed names of kinds and two flags (a restore past its swap, a restore waiting at 24d) pass through here: never a vault, a path or an item.
import { useSyncExternalStore } from "react";
import * as api from "./api";
import type { CloseAskedEvent, JobKind } from "./api";

const KINDS: ReadonlySet<string> = new Set<JobKind>([
  "import",
  "save_copy",
  "save_all",
  "backup",
  "test",
  "restore",
  "open_backup",
  "open",
  "replace",
  "copy_item",
]);

let question: CloseAskedEvent | null = null;
/** The question whose answer is out: a second press, or Escape, while it is adds nothing. */
let answering: CloseAskedEvent | null = null;
let started: Promise<void> | undefined;
const listeners = new Set<() => void>();

function set(next: CloseAskedEvent | null): void {
  question = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function isKind(name: unknown): name is JobKind {
  return typeof name === "string" && KINDS.has(name);
}

/**
 * Takes in one `lockbox://close-asked`. What is not a question is ignored: a reason that is not close or quit, a flag that is not a boolean, and
 * nothing running with nothing past its swap and no restore waiting (there is nothing to say). Kinds the page does not know are left out of the
 * words (a question with none it knows says "Several jobs are running"), and each kind counts once.
 */
function take(event: unknown): void {
  if (typeof event !== "object" || event === null) return;
  const { reason, running, past_swap: pastSwap, restore_waiting: restoreWaiting } = event as Record<string, unknown>;
  if (
    (reason !== "close" && reason !== "quit") ||
    !Array.isArray(running) ||
    typeof pastSwap !== "boolean" ||
    typeof restoreWaiting !== "boolean"
  ) {
    return;
  }
  const kinds = [...new Set(running.filter(isKind))];
  // Nothing running, nothing past its swap and no restore waiting: there is nothing to say. A job of a kind the page has no name for still asks (in
  // the words for jobs in general): the shell holds its question until it is answered, so a dropped one would leave Close and Quit doing nothing.
  if (running.length === 0 && !pastSwap && !restoreWaiting) return;
  set({ reason, running: kinds, past_swap: pastSwap, restore_waiting: restoreWaiting });
}

/** The question the shell is waiting on, or `null`. */
export function useCloseQuestion(): CloseAskedEvent | null {
  return useSyncExternalStore(subscribe, () => question);
}

/** Whether the shell refused with `not_found`: it has no question pending, so there is nothing left to answer. */
function hasNoQuestion(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "not_found";
}

/**
 * Answers the question: `true` is Close anyway, `false` is Keep it running. One answer goes out at a time. The question goes quietly when the
 * answer is accepted, or refused with `not_found` (the shell had already dropped it). Any other failure (a bridge that can't be reached, another
 * refusal) leaves it showing, since the shell still holds the question and sends no second one until it is answered: the person presses again,
 * and nothing is said of why.
 */
export async function answerClose(go: boolean): Promise<void> {
  const asked = question;
  if (asked === null || answering !== null) return;
  answering = asked;
  let settled = true;
  try {
    await api.closeAnswer(go);
  } catch (error) {
    settled = hasNoQuestion(error);
  } finally {
    answering = null;
  }
  // A newer question, or none, is not this one's to take away.
  if (settled && question === asked) set(null);
}

/**
 * Starts hearing questions and lock epoch changes (once; call it with the other listeners, after `startStore`). A listener that can't be set up
 * costs only what it carries: without the first the shell's question is never seen, which is the shell's to hold.
 */
export function startCloseAsk(): Promise<void> {
  started ??= (async () => {
    try {
      await api.onCloseAsked(take);
    } catch {
      // Nothing to hear.
    }
    try {
      await api.onLockEpoch(() => {
        set(null);
      });
    } catch {
      // Without it the question stays until it is answered; its answer is then refused, and the question goes.
    }
  })();
  return started;
}

/** Forgets everything, for the tests' fresh start. */
export function resetCloseAskForTests(): void {
  answering = null;
  started = undefined;
  set(null);
}
