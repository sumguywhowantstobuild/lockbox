// The words of Older copies (24f, 24g): the design's where it has them, and the session's own for the rest (the credential step's label and hint, and what a
// listing that changed says). `messages.ts` has the refusal for a copy that is still open.
import { formatBytes, fullDay } from "./format";

/** The panel's and the screen's title. */
export const OLDER_COPIES = "Older copies";

/** 24f's line under the title. */
export function olderCopiesFor(vaultName: string): string {
  return `For ${vaultName}. Kept when you restored a backup over it.`;
}

/** 24f's hint under the rows. */
export const DELETE_ASKS_FIRST = "Delete asks first, because it can't be undone.";

/** 24f when no copy is left. */
export const NONE_LEFT = "No older copies are left.";

/** What the page says when the shell no longer knows an older copy by the ID it sent: the listing was read again. */
export const CHANGED_LISTING = "That older copy has changed. Here is the list as it is now.";

/** The box that opens a copy read-only. */
export const COPY_CREDENTIAL_LABEL = "Password or recovery key for this copy";

export function copyCredentialHint(vaultName: string): string {
  return `It's the one ${vaultName} used before the restore.`;
}

/** 24g's heading. */
export function deleteHeading(folder: string): string {
  return `Delete ${folder}?`;
}

/** 24g's sentence: what is deleted, that it can't be undone, and what is not touched. */
export function deleteWords(vaultName: string): string {
  return `This older copy is deleted from this PC, for good, with everything in it. This can't be undone. Your current ${vaultName} and the backups you saved yourself aren't touched.`;
}

/** Settings' row for the vault's copies. */
export const SETTINGS_HINT = "Kept when you restored a backup over this vault.";

/**
 * A row's second line: "From 4 November 2026 · 1.3 GB". A part the shell could not give (a day or a size that is `null`, or a day that is not one) is left out;
 * with neither there is no second line (`null`).
 */
export function rowDetail(entry: { last_written: string | null; size: number | null }): string | null {
  // Noon, so no time zone moves the day: the shell sends the day alone.
  const day = entry.last_written === null ? "" : fullDay(`${entry.last_written}T12:00:00`);
  const parts = [day === "" ? null : `From ${day}`, entry.size === null ? null : formatBytes(entry.size)].filter((part): part is string => part !== null);
  return parts.length === 0 ? null : parts.join(" · ");
}
