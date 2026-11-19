// The words and the number a new password is set with, shared by the two screens that set one for a vault already made: Change password (27a to 27c) and
// Forgot password (28d, 28e). Said once here so the two never differ: the limit in spec 5.3 above all.

/** The shortest password the engine takes: 12 characters, counted after Unicode normalisation (spec 5.2). */
export const MIN_PASSWORD = 12;

/** Backups made before the change open with the details they were made with (the design: "existing backups still need the old details"). */
export const BACKUPS_NEED_OLD_DETAILS = "Backups you already made still need the old details.";

/**
 * The limit in spec 5.3, in full: a password change doesn't change the vault key, so an old copy of the vault's details with its old password or recovery
 * key still opens it, and what it opens includes current and future data when its holder gets copies of the newer items and files. The design gives no
 * sentence for it; these are the session's words.
 */
export const LIMIT =
  "Changing the password doesn't lock out an old copy. Anyone who has an old copy of this vault's details (an earlier copy of its folder, or an old backup) and its old password or recovery key can read your current and future items and files, if they get copies of them.";

/** The lines for what the page can see wrong before it sends anything (27b's drawn words). */
export const TOO_SHORT = "At least 12 characters.";
export const MISMATCH = "The two new passwords don't match.";

/** The question that offers a fresh backup once a password is set (27c, 28e): the design's backup offer, in the words the drawn screen has. */
export const OFFER_TITLE = "Make a fresh backup now?";
export const OFFER = "Backups you already made still need the old details. A fresh one opens with what you use today.";
