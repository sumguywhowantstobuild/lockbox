// Every refusal the shell can send, in words. A screen never shows an error's own text: it shows what `messageFor` gives,
// which comes from this fixed table and from nothing the shell sent but which entry to look up (the error's code, its
// kind and its `what`, all of them fixed words on the Rust side) and the numbers it carries. A refusal this table does
// not know gets the generic message. `messages.test.ts` reads the Rust sources and fails on a refusal without an entry.

export interface Message {
  title: string;
  /** A second sentence, or an empty string. */
  body: string;
  /** The numbers the refusal carried (sizes in bytes, a minimum length), for the screen to say; only numbers. */
  numbers?: Record<string, number>;
}

type Words = Pick<Message, "title" | "body">;

/** The message for anything this table does not know. */
export const GENERIC: Words = {
  title: "Something went wrong.",
  body: "Try again. If it keeps happening, close Lockbox and open it again.",
};

const UPDATE_LOCKBOX: Words = { title: "Update Lockbox to open this vault.", body: "A newer version made it." };
const DAMAGED: Words = { title: "Lockbox can't read part of this vault.", body: "It may be damaged. A backup can bring it back." };

/**
 * The table. A key is `code:<variant>` for the shell's own refusals and `core:<kind>` for the engine's, and either may
 * be followed by `:<what>` for a refusal that has words of its own. `what` names the thing a refusal is about.
 */
export const MESSAGES: Record<string, Words> = {
  "code:locked": { title: "This vault is locked.", body: "Unlock it to carry on." },
  "code:locked_after_change": {
    title: "The change was made, but the vault locked before Lockbox could show it.",
    body: "Unlock the vault to see it.",
  },
  "code:locked_after_change:password": {
    title: "Your new password was saved, but the vault locked before Lockbox could say so.",
    body: "Unlock with the new one.",
  },
  "code:not_found": { title: "Lockbox can't find that.", body: "It may have been moved or deleted." },
  "code:busy": { title: "That vault is busy.", body: "Wait for what it's doing to finish, then try again." },
  "code:read_only": { title: "This vault is read-only.", body: "It was opened from a backup, so nothing in it can change." },
  "code:too_large": { title: "That is too big for Lockbox to keep.", body: "" },
  "code:invalid_input": { title: "Lockbox can't use that.", body: "Check what you entered and try again." },
  "code:invalid_input:removable drive": {
    title: "A vault can't live on a removable, FAT32 or network drive.",
    body: "Choose a folder on this PC.",
  },
  "code:invalid_input:vault not listed": {
    title: "Your new vault is on disk but couldn't be added to the list.",
    body: "Use Add existing vault folder, then make a new recovery key.",
  },
  "code:invalid_input:password is empty": { title: "Type the password first.", body: "" },
  "code:cancelled": { title: "That was stopped before it finished.", body: "" },
  "code:core": GENERIC,

  // The page's own refusal (code "page"): it never comes from the shell.
  "page:lock_listener": {
    title: "Lockbox can't listen for locks, so it won't open a vault.",
    body: "Close Lockbox and open it again.",
  },

  "core:wrong_password": { title: "Wrong password.", body: "" },
  "core:recovery_key_typo": { title: "That recovery key has a typing mistake.", body: "Check it against the one you saved." },
  "core:invalid_recovery_key": { title: "That isn't a recovery key for Lockbox.", body: "" },
  "core:damaged": DAMAGED,
  "core:password_too_short": { title: "That password is too short.", body: "" },
  "core:not_enough_space": { title: "There isn't enough room on that drive.", body: "" },
  "core:file_system_limit": { title: "That drive can't hold a file this big.", body: "" },
  "core:unsupported_version": UPDATE_LOCKBOX,
  "core:params_out_of_bounds": {
    title: "Lockbox can't open this vault safely.",
    body: "Its settings are outside what Lockbox allows.",
  },
  "core:too_large": { title: "That is too big for Lockbox to keep.", body: "" },
  "core:invalid_input": { title: "Lockbox can't use that.", body: "Check what you entered and try again." },
  "core:vault_in_use": {
    title: "This vault is in use.",
    body: "Close whatever else has it open, then try again.",
  },
  "core:restore_pending": {
    title: "A restore of this vault hasn't finished.",
    body: "Finish or undo it first.",
  },
  "core:not_found": { title: "Lockbox can't find that.", body: "It may have been moved or deleted." },
  "core:io": {
    title: "Lockbox couldn't reach that folder or file.",
    body: "Check that the drive is connected, then try again.",
  },
};

/**
 * Every `what` the Rust sources send. A refusal's `what` is looked up only to find words of its own (a `:<what>` key
 * above); one without falls back to its code's or kind's message. Listing them all here is what makes the test fail
 * when a new one is added, so someone decides its words.
 */
export const KNOWN_WHATS: readonly string[] = [
  "already restored",
  "backup",
  "backup entries",
  "backup extension",
  "backup: archive writer",
  "backup: damaged file",
  "backup: damaged item",
  "backup: entry hash",
  "backup: entry kind",
  "backup: header mac",
  "backup: manifest",
  "backup: manifest mac",
  "backup: manifest mismatch",
  "backup: manifest readback",
  "backup: no header",
  "backup: too many entries",
  "backup: unexpected file",
  "backup: wrong vault",
  "being deleted",
  "chunk",
  "clipboard",
  "clipboard delay",
  "clipboard text",
  "collection",
  "collection has items",
  "collection inside a collection",
  "damaged output journals",
  "destination changed",
  "destination exists",
  "destination in a vault folder",
  "destination inside vault",
  "destination is the backup",
  "destination not writable",
  "file",
  "file missing",
  "file name",
  "file record",
  "folder",
  "folder is open",
  "folder name",
  "header changed on disk",
  "id",
  "idle time",
  "item",
  "item cannot hold files",
  "journal full",
  "json",
  "json nesting",
  "key derivation input",
  "key derivation memory",
  "key length",
  "key slot",
  "key slots",
  "link",
  "link type",
  "no character class selected",
  "not a collection",
  "not a file",
  "not a login",
  "not a plain folder",
  "not a pre-restore copy",
  "not a vault folder",
  "not in trash",
  "open folder",
  "opening",
  "operation in progress",
  "output journal",
  "password",
  "password is empty",
  "recovery key",
  "removable drive",
  "request",
  "restore",
  "restore answer",
  "restore discarded",
  "restore in progress",
  "restore journal",
  "restore path",
  "restore state unclear",
  "revision overflow",
  "sample",
  "search",
  "several copies of this vault",
  "source size changed",
  "source vault",
  "stale revision",
  "state file",
  "state folder",
  "too many before-restore copies",
  "urls",
  "use delete_collection",
  "vault already here",
  "vault created",
  "vault header",
  "vault is unlocked",
  "vault list",
  "vault name",
  "vault not listed",
  "vault still finishing an operation",
];

/** The numbers a refusal can carry, by the name the shell gives them. */
const NUMBER_FIELDS = ["needed", "available", "max_file", "min"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function lookup(key: string): Words | undefined {
  // `hasOwn`, so a `what` of "constructor" or "__proto__" finds nothing.
  return Object.hasOwn(MESSAGES, key) ? MESSAGES[key] : undefined;
}

/**
 * The words for a refusal, from the fixed table. Anything that is not a refusal the table knows gets
 * {@link GENERIC}. The refusal's own text is never part of the answer, whatever it holds.
 */
export function messageFor(error: unknown): Message {
  if (!isRecord(error)) return { ...GENERIC };
  const { code, kind, what } = error;
  if (typeof code !== "string") return { ...GENERIC };
  const detail = typeof what === "string" ? `:${what}` : "";
  const keys =
    code === "core" || code === "page"
      ? typeof kind === "string"
        ? [`${code}:${kind}${detail}`, `${code}:${kind}`]
        : []
      : [`code:${code}${detail}`, `code:${code}`];
  const words = keys.map(lookup).find((found) => found !== undefined);
  if (words === undefined) return { ...GENERIC };

  const numbers: Record<string, number> = {};
  for (const field of NUMBER_FIELDS) {
    const value = error[field];
    if (typeof value === "number" && Number.isFinite(value)) numbers[field] = value;
  }
  return Object.keys(numbers).length > 0 ? { ...words, numbers } : { ...words };
}
