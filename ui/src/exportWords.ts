// The words of Export to a readable file (34a to 34c), said once here for the form, the question and the end. The design gives the gist ("Warning, password,
// where it goes. A vault folder is refused; a cloud folder warns that the file would be uploaded unprotected, then pick another or continue. Afterwards it says
// to delete the file and empty the Recycle Bin. Stored files aren't included."); the refusals and the cloud question use the existing words (`messages.ts`,
// `FileActions.tsx`). The rest are the drawn screens', and where the design gives none they are the session's, to be changed by Ariel.

/** 34a: what goes in the file and what stays out, as the drawn screen has it with the design's "Stored files aren't included". */
export function exportContents(vaultName: string): string {
  return `For ${vaultName}: logins, keys and notes. Stored files aren't included, and earlier passwords stay out.`;
}

/** 34a: the warning before the password. */
export const EXPORT_WARNING = "Anyone who gets this file can read everything in it.";

/** 34c: the file isn't protected: delete it, and empty the Recycle Bin. */
export const EXPORT_DELETE_IT = "This file isn't protected. Delete it once you're done with it, and empty the Recycle Bin.";

/** 34c: one sentence for the items whose values another app may change, above their titles. */
export const EXPORT_LINE_BREAKS = "Another app may change the line breaks in the values of these items when it reads the file.";

/** The Settings row's hint. */
export function exportHint(vaultName: string): string {
  return `Save a readable copy of ${vaultName} for another app. It isn't encrypted.`;
}

/** 34c: where it went, to read (the folder only, never a path the page could send back). */
export function exportSavedIn(folder: string): string {
  return `Saved in ${folder}.`;
}

/** 34c: items the vault couldn't read, which therefore aren't in the file (said only when there are some, so a partial file is never taken for the whole). The words are the session's. */
export function exportUnreadable(count: number): string {
  return count === 1 ? "1 item couldn't be read and isn't in the file." : `${String(count)} items couldn't be read and aren't in the file.`;
}

/** 34c: how many items were written and how many stored files were left out (counted for the person, so a vault with none says so). */
export function exportCounts(items: number, leftOutFiles: number): string {
  const rows = items === 1 ? "1 item saved." : `${String(items)} items saved.`;
  const files = leftOutFiles === 0 ? "No stored files left out." : leftOutFiles === 1 ? "1 stored file left out." : `${String(leftOutFiles)} stored files left out.`;
  return `${rows} ${files}`;
}
