// The words of a new recovery key for an open vault (29a to 29c), said once here for the form, the key screens and the offer. The design gives only the gist
// ("the old key stops working here, but old backups still need it"), so these are the session's words, to be changed by Ariel. The limit in spec 5.3 and the
// offer's title are the change-password screens' (`passwordWords.ts`) and are not repeated.

/** 29a: what the new key does to the old one, and to the backups already made. */
export const OLD_KEY_STOPS = "The old recovery key stops working for this vault. Backups you already made still need the old key.";

/** 29b: the first screen's heading and the line under it, in place of setup's "Save your recovery key" and its step line. */
export const NEW_KEY_HEADING = "Your new recovery key";
export const NEW_KEY_SUB = "The old key no longer works for this vault. Save this one before you go on.";

/** 29b: the questions' heading (21d's is "Check your recovery key"). */
export const NEW_KEY_CHECK_HEADING = "Check your new recovery key";

/** 29c: the offer of a fresh backup once the new key is picked back, as 27c's with the key where its password is. */
export const NEW_KEY_OFFER = "Backups you already made still need the old key. A fresh one opens with what you use today.";
