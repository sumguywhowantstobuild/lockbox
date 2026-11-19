// The words of many files in (Plan 4B Task 10: 9a, 9b, 9c, 9e), in one place, since the panel, the card that keeps the summary when the person
// moves on, and the message after a clean batch that finished out of sight all say them. Plain functions of numbers and the page's own words.
import { formatBytes } from "./format";
import type { AddFilesView, AddInto, PickedFile, ShellRefusal } from "./api";
import { messageFor, messageText } from "./messages";

/** The most one file can be, in bytes (256 GiB): the shell refuses a file over it before the batch starts (the page names the file from the sizes it holds). */
export const MAX_FILE_BYTES = 256 * 1024 ** 3;

/** "1 file", "3 files". */
export function filesWords(count: number): string {
  return `${String(count)} ${count === 1 ? "file" : "files"}`;
}

/** 9a's sentence after "N files picked, size.": where they go, " They go into My vault." or " They're attached to Bot admin console." (one file: "It"). */
export function placeWords(count: number, itemTitle: string | null, vaultName: string): string {
  const one = count === 1;
  return itemTitle !== null
    ? ` ${one ? "It's" : "They're"} attached to ${itemTitle}.`
    : ` ${one ? "It goes" : "They go"} into ${vaultName}.`;
}

/** The words that differ between adding to a folder and attaching to an item. */
export function verbs(into: AddInto): { action: string; doing: string; done: string; none: string } {
  return into.type === "item"
    ? { action: "Attach", doing: "Attaching", done: "attached", none: "Nothing was attached" }
    : { action: "Add", doing: "Adding", done: "added", none: "Nothing was added" };
}

/** 9c's sentence that the originals stay: "The originals are still unprotected on your PC. ..." (one file: "The original ... it"). */
export function originalsStay(count: number): string {
  return count === 1
    ? "The original is still unprotected on your PC. Lockbox didn't change or delete it, so remove it yourself if you no longer need it."
    : "The originals are still unprotected on your PC. Lockbox didn't change or delete them, so remove them yourself if you no longer need them.";
}

/** What a batch left out says about the originals that were never stored, `count` of them: keep them (one: "Keep the file … It isn't … its original … it"). */
export function keepTheListed(count: number): string {
  return count === 1
    ? "Keep the file listed above. It isn't in your vault, and its original is all that is left of it."
    : "Keep the files listed above. They aren't in your vault, and their originals are all that is left of them.";
}

/** The heading over the names a batch couldn't read, `count` of them. */
export function unreadHeading(count: number): string {
  return count === 1 ? "This file couldn't be read:" : "These files couldn't be read:";
}

/** The heading over the names a batch never tried, `count` of them: "These files were not added:" (one: "This file was not added:"). */
export function notDoneHeading(count: number, done: string): string {
  return count === 1 ? `This file was not ${done}:` : `These files were not ${done}:`;
}

/** How a batch ended, as its heading says it: "3 files added", "1 of 3 files added", "Nothing was added". */
export function endTitle(view: AddFilesView, total: number, into: AddInto): string {
  const { done, none } = verbs(into);
  if (view.added === 0) return none;
  if (view.added === total) return `${filesWords(view.added)} ${done}`;
  return `${String(view.added)} of ${filesWords(total)} ${done}`;
}

/** Whether every file went in: nothing failed, nothing was left out, nothing stopped it. */
export function wasClean(view: AddFilesView): boolean {
  return view.failed.length === 0 && view.not_added.length === 0 && view.stopped === null;
}

/**
 * What ended a batch early, in words: the person's own Stop is said as theirs; anything else is the shell's refusal in the page's words
 * (`messageFor`), never the shell's own text. `null` when it ran to the end, and for a lock, which the vault going takes care of.
 */
export function stoppedWords(stopped: ShellRefusal | null): string | null {
  if (stopped === null || stopped.code === "locked") return null;
  if (stopped.code === "cancelled") return "You stopped it.";
  return messageText(messageFor(stopped));
}

/** The message after a clean batch that finished while the person was elsewhere: what went in, and that the originals stay. */
export function awayMessage(view: AddFilesView, into: AddInto): string {
  return `${filesWords(view.added)} ${verbs(into).done}. ${originalsStay(view.added)}`;
}

/**
 * What is spoken when a batch that left something out ends and nothing has taken focus to its summary (the person went to another item, or
 * is in the filter): how it ended, and where the names of the files that did not go in are.
 */
export function partialWords(view: AddFilesView, total: number, into: AddInto): string {
  return `${endTitle(view, total, into)}. The files that didn't go in are named in the summary beside the list.`;
}

/**
 * 9e's refusal before a batch starts, in words with the numbers: no room for the whole batch ("Not enough space. These files need 3.2 GB, and
 * this drive has 1.1 GB free."; one file: "This file needs"), or a file over 256 GB named with its size, from the list the page holds. Any other refusal is the page's own
 * words for it. A refusal that is about the size of the batch is also what turns Add off until the list changes.
 */
export function refusalWords(error: unknown, files: readonly PickedFile[]): { text: string; size: boolean } {
  const message = messageFor(error);
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown; kind?: unknown }) : {};
  if (code.code === "core" && code.kind === "not_enough_space" && message.numbers?.needed !== undefined && message.numbers.available !== undefined) {
    return {
      // One picked file is "This file"; a batch, or a refusal said with no list (Save all's, before its files are counted), is "These files".
      text: `Not enough space. ${files.length === 1 ? "This file needs" : "These files need"} ${formatBytes(message.numbers.needed)}, and this drive has ${formatBytes(message.numbers.available)} free.`,
      size: true,
    };
  }
  if (code.code === "core" && code.kind === "too_large") {
    const over = files.filter((file) => file.size > MAX_FILE_BYTES);
    if (over.length > 0) {
      const limit = formatBytes(MAX_FILE_BYTES);
      return {
        text: over.map((file) => `${file.name} is ${formatBytes(file.size)}. Lockbox can keep a file up to ${limit}.`).join(" "),
        size: true,
      };
    }
  }
  return { text: messageText(message), size: false };
}
