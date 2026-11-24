// The words of Open a backup (25a to 25d) that are the screens' own. The wrong-password line, a damaged backup's sentence and the expired choice's words are Test a
// backup's (`testBackupWords.ts`, `messages.ts`), said again here and never copied. The sentences marked † in the plan were not drawn: they are the page's own, said
// in the words the screens around them use.
import type { SessionData } from "./store";

/** The heading of the panel and of the lock screen's steps, and the name of the button that opens them. */
export const OPEN_A_BACKUP = "Open a backup";

/** The dark side's line on the lock screen's steps †. */
export const SAY_OPEN = "A backup opens read-only. You can look through it and copy items out, and nothing in it changes.";

/** The line under the Open a backup row of Settings †. */
export const SETTINGS_OPEN_HINT = "Browse a backup and copy items out, without restoring it.";

/** What the line under an item's title says in place of its folder and day, in a session that is one: where the item is from †. */
export function fromWords(kind: SessionData["kind"]): string | null {
  if (kind === "backup") return "from this backup";
  if (kind === "older_copy") return "from this older copy";
  return null;
}

/** What a read-only session is, under its name in the vault menu †. */
export function kindRow(kind: SessionData["kind"]): string | undefined {
  if (kind === "backup") return "Backup";
  if (kind === "older_copy") return "Older copy";
  return undefined;
}

/** The name a session wears in the window's header and the vault menu: an older copy says so beside its vault's name †; a backup's name is its file's, which says it. */
export function shownName(session: Pick<SessionData, "name" | "kind">): string {
  return session.kind === "older_copy" ? `${session.name}, older copy` : session.name;
}

/** 25b: the sentence above Copy to a vault. */
export const PUT_BACK = "Put this item back in a vault you're using.";

/** 25c's button, and the form's own name. */
export const COPY_TO_A_VAULT = "Copy to a vault";

/** What the form says when no vault is open to copy into (the design's "Nowhere to copy to"). */
export const NOWHERE_TO_COPY = "Unlock a vault first, so there's somewhere to copy this to.";

/** What is said, politely, when a copy has gone in †. */
export function copiedTo(vault: string, leftOut: number): string {
  return leftOut === 0 ? `Copied to ${vault}.` : `Copied to ${vault}, without the files the backup doesn't have.`;
}

/** 25d's heading. */
export const COPY_WITHOUT_TITLE = "Copy without these files?";

/** "a", "a and b", "a, b and c". */
function listOf(names: readonly string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1] ?? ""}`;
}

/**
 * 25d's sentence: what the backup does not hold, and that the item will copy without it. `kind` is the item's: login, key, note or file. More than one name is said
 * in the plural †.
 */
export function copyWithoutWords(names: readonly string[], kind: string): string {
  return names.length === 1
    ? `This backup doesn't have ${listOf(names)}, which is attached to this item. The ${kind} will copy without it.`
    : `This backup doesn't have ${listOf(names)}, which are attached to this item. The ${kind} will copy without them.`;
}

/** What a busy copy says in the window's note †. */
export const COPYING = "Copying the item.";
