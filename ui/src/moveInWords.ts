// The words of moving to a new computer (26a to 26c) that are the steps' own. A refusal's words come from `messages.ts`, the removable drive's too (as the
// page's own `copy_it_first`, since the design gives this step alone the words "Copy it to this PC first").
import { messageFor, messageText } from "./messages";

/** The dark side's line on every step of moving in. */
export const SAY_MOVE_IN = "Your vault comes with you as a backup or a folder.";

/** 26a's sub line. */
export const EITHER_WORKS = "Either works on a new computer. Backups and folders need the password or recovery key from when they were made.";

/** 26c's sub line. */
export const BRING_IN_THE_NEXT = "Each vault comes across on its own. If you had more than one, bring in the next.";

/** The words under 26a for a refusal of the vault folder: 26b's for a removable drive, the table's for the rest. */
export function folderWords(refusal: unknown): string {
  const removable =
    typeof refusal === "object" &&
    refusal !== null &&
    (refusal as { code?: unknown }).code === "invalid_input" &&
    (refusal as { what?: unknown }).what === "removable drive";
  return messageText(messageFor(removable ? { code: "page", kind: "copy_it_first" } : refusal));
}
