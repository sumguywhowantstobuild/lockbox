// The words of saving all of a folder's files (Plan 4B Task 11), in one place, since the panel, the card that keeps the summary when the person has
// gone from the panel, and the spoken line for an end nobody was looking at all say them. Plain functions of what the shell answered.
import { filesWords } from "./addFilesWords";
import type { Renamed, SaveAllView, SavedFile, ShellRefusal } from "./api";
import { messageFor, messageText } from "./messages";

/** The design's warning, word for word: the copies are not encrypted. Said with every summary that holds a copy. */
export const UNENCRYPTED_WARNING =
  "These copies aren't encrypted, so anyone who can reach this folder can open them. Delete them when you're finished, and empty the Recycle Bin. Your vault still has its own copies.";

/** The line about the laptop under the bar, as drawn (Saving). */
export const KEEP_OPEN =
  "Keep the laptop open. Windows locking or sleeping stops this. Files already saved stay there, and a file only appears once it's whole and checked.";

/** How it ended, as the heading says it: "4 files saved", "3 of 4 files saved", "Stopped after 2 of 4 files", "No files were saved". */
export function endTitle(view: SaveAllView, total: number): string {
  const saved = view.saved.length;
  if (view.stopped !== null && view.stopped.code !== "locked") return `Stopped after ${String(saved)} of ${filesWords(total)}`;
  if (saved === 0) return "No files were saved";
  if (saved === total) return `${filesWords(saved)} saved`;
  return `${String(saved)} of ${filesWords(total)} saved`;
}

/**
 * What ended it early, in the page's words (`messageFor`), never the shell's text: a full drive says so. A Stop is the person's own press and the
 * heading says it ("Stopped after ..."), so it adds nothing; a lock takes the vault and the summary with it. `null` when it ran to the end.
 */
export function stoppedReason(stopped: ShellRefusal | null): string | null {
  if (stopped === null || stopped.code === "cancelled" || stopped.code === "locked") return null;
  return messageText(messageFor(stopped));
}

/**
 * A name that changed on the way out. A number added because the name was taken says the one that was there is untouched; a name Windows refuses
 * (which the shell changed) says that. The two are told apart by the name on disk: it is the stored name with " (2)", " (3)" ... before its last
 * extension, or it is not.
 */
export function renamedSentence({ from, to }: Renamed): string {
  const numbered = to.replace(/ \(\d+\)(\.[^.]*)?$/, "$1") === from;
  return numbered
    ? `${from} was already in this folder, so the new copy is ${to}. The one that was there is untouched.`
    : `${from} can't be a file name in Windows, so it was saved as ${to}.`;
}

/** The size of a saved file and, for an attachment, what it is attached to: "180 KB, attached to Bot admin console". */
export function attachedTo(file: Pick<SavedFile, "attached_to">): string {
  return file.attached_to === null ? "" : `, attached to ${file.attached_to}`;
}

/** The sentences about the file that was being written when it ended and the ones after it: one paragraph, then a list when several were not started. */
export function stoppedLines(view: SaveAllView): { sentence: string | null; notStarted: string[] } {
  const parts: string[] = [];
  if (view.unfinished !== null) parts.push(`${view.unfinished} wasn't finished, so nothing half-made was left.`);
  const [only] = view.not_started;
  if (view.not_started.length === 1 && only !== undefined) parts.push(`${only} wasn't started.`);
  return { sentence: parts.length === 0 ? null : parts.join(" "), notStarted: view.not_started.length > 1 ? view.not_started : [] };
}

/**
 * What is spoken when an end arrives and nothing has taken focus to its summary (the person went to another item, or is in the filter): how it ended,
 * where the summary is, and the warning, since the copies exist whether or not anyone looked.
 */
export function spokenEnd(view: SaveAllView, total: number): string {
  const warning = view.saved.length > 0 ? ` ${UNENCRYPTED_WARNING}` : "";
  return `${endTitle(view, total)}. The summary is beside the list.${warning}`;
}
