// The words of Test a backup (23a to 23d) that are the screen's own: the wrong-password line and what a damaged backup says. The engine reports only
// the first thing that failed, as a fixed `what`; the page says it in three groups, each ending with the same advice, and never repeats the engine's
// own text, a count or the name of an entry.

/** 23c: the line under the box for a password or recovery key that is not the one this backup was made with. */
export const WRONG_FOR_THIS_BACKUP = "Wrong password. It needs the one from the day this backup was made, which may not be today's.";

const USE_ANOTHER = "Use another backup if you have one.";

/** A stored file or an item that no longer matches what the backup recorded for it: the engine's `what`, as `vault/source.rs` and `vault/files.rs` send it. */
const STORED_FILE = new Set(["backup: damaged file", "backup: entry hash", "file missing", "backup: file missing"]);
const AN_ITEM = new Set(["backup: damaged item"]);
/** A backup made from another vault. */
const OTHER_VAULT = new Set(["backup: wrong vault"]);

/**
 * 23d's sentence for a damaged backup, from the refusal the shell sent (`{ code: "core", kind: "damaged", what }`). Only the whats listed above get a
 * sentence of their own: a stored file, an item, another vault's backup. Everything else (the archive's own structure: `not a backup archive`,
 * `central directory`, `end record`, `local header` and the rest of the `backup: ...` whats of `archive.rs`; the signatures: `manifest mac`, `header mac`,
 * `no header`, `no manifest`; and any word nobody listed) is the one that says the file is not a whole Lockbox backup, since none of them can be trusted.
 */
export function damagedWords(error: unknown): string {
  const what = typeof error === "object" && error !== null ? (error as { what?: unknown }).what : undefined;
  if (typeof what === "string") {
    if (STORED_FILE.has(what)) {
      return `A stored file in this backup doesn't match what the backup recorded, so it can't be trusted. ${USE_ANOTHER}`;
    }
    if (AN_ITEM.has(what)) {
      return `An item in this backup doesn't match what the backup recorded, so it can't be trusted. ${USE_ANOTHER}`;
    }
    if (OTHER_VAULT.has(what)) return `This backup was made from a different vault. ${USE_ANOTHER}`;
  }
  return `This file isn't a whole Lockbox backup, or its contents were changed after it was made, so it can't be trusted. ${USE_ANOTHER}`;
}

/** 23b: how many attached files the backup did not hold, when it did not hold some. `null` when it held them all. */
export function missingWords(missing: number): string | null {
  if (missing <= 0) return null;
  return missing === 1 ? "1 file was missing when this backup was made." : `${String(missing)} files were missing when this backup was made.`;
}
