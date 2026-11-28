// The question a close or a Quit asks while a job runs (Plan 4B Task 12). The shell sends `petalock://close-asked` and holds everything (nothing is
// locked, hidden or cancelled) until `close_answer`. The page keeps the one question that is pending, answers it once, and drops it when the shell
// has: a lock epoch change (Lock all, Windows locking or sleeping, an idle lock) clears the shell's side, so the page's goes with it.
// Only fixed names of kinds, two flags (a restore past its swap, a restore waiting at 24d) and the question's number pass through here: never a vault, a
// path or an item. The shell gives each question a number (Plan 4C Task 12) and the page sends it back with the answer, so an answer reaches only the
// question it was given for, and the page knows a repeat of the same question, or an echo of one that has ended, from a new one.
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
  "restore_check",
  "open_backup",
  "open",
  "replace",
  "copy_item",
]);

let question: CloseAskedEvent | null = null;
/** The question whose answer is out: a second press, or Escape, while it is adds nothing. */
let answering: CloseAskedEvent | null = null;
/**
 * The newest question number the page has shown, whether it is still showing, was answered, or was dropped by a lock. The shell counts up and never
 * reuses a number, so an event numbered below this is an older question (an echo that came late): it changes nothing.
 */
let newest = 0;
/**
 * The newest question number whose answer settled (accepted, or refused with `not_found`). Such a question is over for good: an event for it
 * changes nothing, and in particular cannot bring an answered question back. A question a lock cleared before anyone answered it is not over: the
 * lock's event can reach the page after a question the shell asked in the new epoch and still holds, so the shell's repeat of that exact number
 * shows it again (an answer to one the shell did drop is refused `not_found` and goes quietly).
 */
let finished = 0;
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
 * Takes in one `petalock://close-asked`. What is not a question is ignored: a reason that is not close or quit, a flag that is not a boolean, a number
 * that is not a positive whole number (it could not be answered), and nothing running with nothing past its swap and no restore waiting (there is
 * nothing to say). Kinds the page does not know are left out of the words (a question with none it knows says "Several jobs are running"), and each
 * kind counts once. The number of the question showing is the same question said again, and one whose answer settled or that is older than the newest
 * shown has ended: nothing changes, so the question showing stays the very one an answer in flight is for, and settles away with it. The number of a
 * question a lock cleared unanswered shows again.
 */
function take(event: unknown): void {
  if (typeof event !== "object" || event === null) return;
  const { reason, running, past_swap: pastSwap, restore_waiting: restoreWaiting, question: number } = event as Record<string, unknown>;
  if (
    (reason !== "close" && reason !== "quit") ||
    !Array.isArray(running) ||
    typeof pastSwap !== "boolean" ||
    typeof restoreWaiting !== "boolean" ||
    typeof number !== "number" ||
    !Number.isSafeInteger(number) ||
    number < 1
  ) {
    return;
  }
  if (number < newest || number <= finished || question?.question === number) return;
  const kinds = [...new Set(running.filter(isKind))];
  // Nothing running, nothing past its swap and no restore waiting: there is nothing to say. A job of a kind the page has no name for still asks (in
  // the words for jobs in general): the shell holds its question until it is answered, so a dropped one would leave Close and Quit doing nothing.
  if (running.length === 0 && !pastSwap && !restoreWaiting) return;
  newest = number;
  set({ reason, running: kinds, past_swap: pastSwap, restore_waiting: restoreWaiting, question: number });
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
 * Answers the question: `true` is Close anyway, `false` is Keep it running. The answer carries the question's own number. One answer goes out at a
 * time. The question goes quietly when the answer is accepted, or refused with `not_found` (the shell had already dropped it, or has a newer one
 * pending, which this answer leaves alone). Any other failure (a bridge that can't be reached, another
 * refusal) leaves it showing, since the shell still holds the question (a second close or Quit only sends the same question again): the person
 * presses again, and nothing is said of why.
 */
export async function answerClose(go: boolean): Promise<void> {
  const asked = question;
  if (asked === null || answering !== null) return;
  answering = asked;
  let settled = true;
  try {
    await api.closeAnswer(asked.question, go);
  } catch (error) {
    settled = hasNoQuestion(error);
  } finally {
    answering = null;
  }
  if (settled) finished = Math.max(finished, asked.question);
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
  newest = 0;
  finished = 0;
  started = undefined;
  set(null);
}
