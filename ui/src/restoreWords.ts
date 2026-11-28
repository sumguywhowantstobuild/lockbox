// The words of Restore a backup (24a to 24e) that are the flow's own. The wrong-password line, a damaged backup's sentence and the expired choice's
// words are Test a backup's (`testBackupWords.ts`, `messages.ts`), said again here and never copied; the refusals of the copy are the design's.
import { formatBytes, fullDay } from "./format";
import { messageFor, messageText } from "./messages";
import { damagedWords, WRONG_FOR_THIS_BACKUP } from "./testBackupWords";

/** The dark side's line on every step of the restore. */
export const SAY_RESTORE = "A restore keeps your current vault beside the restored one.";

/** 24c's line under the bar. */
export const KEEP_OPEN = "Keep the laptop open. Windows locking or sleeping cancels this.";

/** 24d's second line. It names what ends a waiting restore (spec 7.4): Lock all, Close anyway (closing Petalock), and Windows locking or sleeping. An idle lock does not. */
export const WAITS = "This waits for your answer, however long you take. Lock all, closing Petalock, or Windows locking or sleeping cancels it.";

/** The words of the folder step's refusals, for the drives a vault can't live on: the engine's four whats are one answer to the person. */
const DRIVE_WHATS: ReadonlySet<string> = new Set(["removable drive", "network drive", "drive type not supported", "file system not supported"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** The kinds of refusal that are about what was typed into the box: the password or key is not the backup's. */
const ABOUT_THE_BOX: ReadonlySet<string> = new Set(["wrong_password", "recovery_key_typo", "invalid_recovery_key", "recovery_key_word", "recovery_key_count"]);

/** Whether a refusal says what was typed is not it (24a puts its words under the box, and the file stays picked). */
export function isAboutTheBox(error: unknown): boolean {
  return isRecord(error) && error.code === "core" && typeof error.kind === "string" && ABOUT_THE_BOX.has(error.kind);
}

/** The words under the box for a refusal about what was typed: 23c's line for a wrong password, the table's words for a key that cannot be one. */
export function boxWords(error: unknown): string {
  const wrong = isRecord(error) && error.kind === "wrong_password";
  return wrong ? WRONG_FOR_THIS_BACKUP : messageText(messageFor(error));
}

/** The words under the file's row for any other refusal of 24a: a damaged backup in plain words, the table's words for the rest. */
export function fileWords(error: unknown): string {
  const damaged = isRecord(error) && error.code === "core" && error.kind === "damaged";
  return damaged ? damagedWords(error) : messageText(messageFor(error));
}

/** The words of a refusal of the copy or the swap: the design's, with the numbers a refusal carried. */
export function refusalWords(error: unknown): string {
  if (isRecord(error) && error.code === "core" && error.kind === "not_enough_space") {
    const { needed, available } = messageFor(error).numbers ?? {};
    if (needed !== undefined && available !== undefined) {
      return `Not enough space. This needs ${formatBytes(needed)}, and that drive has ${formatBytes(available)} free.`;
    }
  }
  if (isRecord(error) && error.code === "invalid_input" && typeof error.what === "string" && DRIVE_WHATS.has(error.what)) {
    return messageText(messageFor({ code: "invalid_input", what: "removable drive" }));
  }
  return messageText(messageFor(error));
}

/** Whether the refusal is the swap's "too many older copies": it has no way back but Cancel, since the copy is made and waits. */
export function isTooManyOlderCopies(error: unknown): boolean {
  return isRecord(error) && error.what === "too many before-restore copies";
}

/** 24e's label for the vault's own password: "Password from 2 October 2026", or without the day when the backup did not say. */
export function passwordFromWords(made: string | null): string {
  // Noon, so no time zone moves the day: the shell sends the day alone.
  const day = made === null ? "" : fullDay(`${made}T12:00:00`);
  return day === "" ? "Password from when this backup was made" : `Password from ${day}`;
}

/**
 * 24b's sentence for where it unpacks. `beside` is set while the folder is the one a restore started from a damaged vault's question (Ask 8) or from the
 * open vault's (Ask 4) gave it, and the person has not chosen another.
 */
export function whereWords(name: string, usual: boolean, replaces: boolean, beside: "damaged" | "open" | null = null): string {
  if (replaces) return `${name} is already in this folder. Petalock asks before replacing it, and keeps your current one beside it.`;
  if (beside === "damaged") return `It unpacks as ${name}, in a new folder beside the damaged one.`;
  if (beside === "open") return `It unpacks as ${name}, in the same folder as your vault.`;
  return usual ? `It unpacks as ${name}, in your usual vaults folder.` : `It unpacks as ${name}, in the folder you chose.`;
}

// A restore that didn't finish (Ask 6, Ask 7, the two states with no drawn screen) and a vault that can't be opened (Ask 8): the design's words and the
// drawn ones, with the vault's name or the folder as text. A notice that can't name its vault says "your vault" (and "a vault" once finished).

/** Ask 6's heading, which the screen for notes that can't be read shares. */
export const UNDONE_HEADING = "A restore didn't finish";

/** Ask 6: Petalock was closed partway through and put the vault back. */
export function undoneWords(name: string | null): string {
  return `Petalock was closed partway through, and has put ${name ?? "your vault"} back the way it was. Nothing is lost. You can start the restore again.`;
}

/** The finished notice on the lock screen. */
export function finishedWords(name: string | null): string {
  return `Petalock finished restoring ${name ?? "a vault"}. Unlock with the password from when that backup was made.`;
}

/** Ask 7's heading. */
export const MISSING_HEADING = "A restore is waiting for a drive";

/** Ask 7: the folder is shown as text. */
export function missingWords(folder: string): string {
  return `It was using ${folder}, which isn't connected. Connect the drive, then try again. Dismissing leaves the folders there as they are, for you to sort out.`;
}

/** What Try again says when the drive is still not there. */
export const DRIVE_STILL_MISSING = "That drive still isn't connected.";

/** The state with no drawn screen: the drive is there but a rename failed. */
export const PENDING_HEADING = "A restore is waiting";
export const PENDING_WORDS =
  "Petalock couldn't finish putting things back yet. Close anything that may be using the vault's folder, then try again. Dismissing leaves the folders there as they are, for you to sort out.";
/** What Try again says when it still cannot finish. */
export const RESTORE_STILL_WAITING = "That restore still isn't finished.";

/** The state with no drawn screen: the notes on what the restore had done can't be read. */
export const UNCLEAR_WORDS =
  "Petalock can't read its notes on what the restore had done. Dismissing leaves the folders there as they are, for you to sort out.";

/** Ask 8's heading: the vault by its name when the list gives one, else "This vault". */
export function damagedHeading(name: string | null): string {
  return `${name ?? "This vault"} can't be opened`;
}

/** Ask 8. */
export const DAMAGED_WORDS =
  "Both copies of its details are damaged, so no password can open it. A backup can bring it back, in a new folder beside this one, and the damaged folder is left alone.";

/** 24d's sentence: the current vault is kept, under the name the shell will give it. */
export function keptWords(name: string, keptAs: string | null): string {
  const beside = keptAs === null ? "Your current one stays beside it" : `Your current one stays beside it as ${keptAs}`;
  return `${name} is already on this PC. ${beside}, so you can still open it.`;
}
