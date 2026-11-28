import { useRef } from "react";
import { answerClose, useCloseQuestion } from "../closeAsk";
import type { CloseAskedEvent, JobKind } from "../api";
import { Button } from "../parts/Button";
import { Dialog } from "../parts/Dialog";

/** What a job is called in the question's title, by the shell's fixed names (33b draws the backup's; the others are the session's words). */
const TITLE: Record<JobKind, string> = {
  import: "Files are being added",
  save_copy: "A copy is being saved",
  save_all: "Files are being saved",
  backup: "A backup is running",
  test: "A backup is being tested",
  restore: "A restore is running",
  restore_check: "A backup is being checked for a restore",
  open_backup: "A backup is being opened",
  open: "A file is being opened",
  replace: "A file is being replaced",
  copy_item: "An item is being copied",
};

const KEEP_RUNNING = "Keep it running";

/**
 * What the question says, in this order: a restore past its swap says Ask 15's words, whatever else runs; a job running says its own (one kind names
 * itself, two or more are "several"; a waiting restore ends with them); only then a restore waiting for its yes at 24d (nothing runs, so its safe
 * answer is "Keep it open", not "Keep it running").
 */
function wordsFor(asked: CloseAskedEvent): { title: string; text: string; keep: string } {
  if (asked.past_swap) {
    return {
      title: "A restore is finishing",
      text: "It's past the point of cancelling. If you close now, Petalock finishes or undoes it the next time it opens, so nothing is lost.",
      keep: KEEP_RUNNING,
    };
  }
  const [only, ...others] = asked.running;
  if (only !== undefined && others.length === 0) {
    return { title: TITLE[only], text: "Closing will cancel it, and nothing half-made is left behind.", keep: KEEP_RUNNING };
  }
  if (only === undefined && asked.restore_waiting) {
    return {
      title: "A restore is waiting for your answer",
      text: "Closing cancels it. Your vault stays as it is, and you can start the restore again.",
      keep: "Keep it open",
    };
  }
  return { title: "Several jobs are running", text: "Closing will cancel them, and nothing half-made is left behind.", keep: KEEP_RUNNING };
}

/**
 * 33b, Ask 15 and Task 13d: the window was closed, or Petalock quit, while a job runs or a restore waits for its yes, and the shell is waiting for the
 * answer. It is over whichever screen is up. Focus starts on Keep it running (Keep it open for a waiting restore), so a stray Enter cancels nothing,
 * and so do Escape and a click outside: all of them are that answer.
 * It goes when the answer is accepted (or the shell has no question left), or when the shell drops the question (a lock); an answer that fails leaves it
 * showing to be pressed again. `closeAsk.ts` does both. Close and Quit say the same words.
 */
export function CloseQuestion() {
  const asked = useCloseQuestion();
  const keep = useRef<HTMLButtonElement>(null);
  if (asked === null) return null;
  const { title, text, keep: keepWords } = wordsFor(asked);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) void answerClose(false);
      }}
      title={title}
      description={text}
      initialFocus={keep}
    >
      <Button
        onClick={() => {
          void answerClose(true);
        }}
      >
        Close anyway
      </Button>
      <Button
        ref={keep}
        look="pill-main"
        onClick={() => {
          void answerClose(false);
        }}
      >
        {keepWords}
      </Button>
    </Dialog>
  );
}
