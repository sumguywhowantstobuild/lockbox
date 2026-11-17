// The words of Restore a backup (24a to 24e) that are the flow's own. The wrong-password line, a damaged backup's sentence and the expired choice's
// words are Test a backup's (`testBackupWords.ts`, `messages.ts`), said again here and never copied; the refusals of the copy are the design's.
import { formatBytes, fullDay } from "./format";
import { messageFor, messageText } from "./messages";
import { damagedWords, WRONG_FOR_THIS_BACKUP } from "./testBackupWords";

/** The dark side's line on every step of the restore. */
export const SAY_RESTORE = "A restore keeps your current vault beside the restored one.";

/** 24c's line under the bar. */
export const KEEP_OPEN = "Keep the laptop open. Windows locking or sleeping cancels this.";

/** 24d's second line. */
export const WAITS = "This waits for your answer, however long you take. Only Windows locking or sleeping cancels it.";

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

/** 24b's sentence for where it unpacks. */
export function whereWords(name: string, usual: boolean, replaces: boolean): string {
  if (replaces) return `${name} is already in this folder. Lockbox asks before replacing it, and keeps your current one beside it.`;
  return usual ? `It unpacks as ${name}, in your usual vaults folder.` : `It unpacks as ${name}, in the folder you chose.`;
}

/** 24d's sentence: the current vault is kept, under the name the shell will give it. */
export function keptWords(name: string, keptAs: string | null): string {
  const beside = keptAs === null ? "Your current one stays beside it" : `Your current one stays beside it as ${keptAs}`;
  return `${name} is already on this PC. ${beside}, so you can still open it.`;
}
