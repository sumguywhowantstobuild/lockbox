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
  // A new recovery key is shown only once: one the lock kept from the screen was never seen, and the next unlock makes another.
  "code:locked_after_change:recovery key": {
    title: "The vault locked before Lockbox could show your new recovery key.",
    body: "Unlock the vault, and Lockbox will make another one to write down.",
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
    body: "Use “I already have a vault” on the first screen to add it.",
  },
  "code:invalid_input:password is empty": { title: "Type the password first.", body: "" },
  // The shell writes a "not confirmed" note before it makes a recovery key, and makes none when it can't.
  "code:too_large:vault state": {
    title: "Lockbox couldn't save a note it needs before making the key, so it made none.",
    body: "Try again.",
  },
  "code:invalid_input:state folder": {
    title: "Lockbox won't save that in its own settings folder.",
    body: "Choose another folder.",
  },
  // Printing: one print of Lockbox's own at a time, and a PDF that never came leaves nothing behind.
  "code:busy:printer": { title: "Lockbox is still printing.", body: "Wait for it to finish, then try again." },
  "code:print_failed": { title: "Lockbox couldn't print that.", body: "Try again." },
  "code:print_failed:pdf": { title: "Lockbox couldn't make the PDF.", body: "Nothing was saved. Try again." },
  "code:print_failed:print": {
    title: "Lockbox couldn't send that to the printer.",
    body: "Check that it's on and connected, then try again.",
  },
  "code:invalid_input:printer name": { title: "That printer isn't available any more.", body: "Pick another one." },
  // A new login's website: Rust adds https:// where there is none and keeps only http and https addresses.
  "code:invalid_input:website": {
    title: "That isn't a web address Lockbox can open.",
    body: "Use one that starts with http:// or https://.",
  },
  // A folder named with nothing, new or renamed: the page asks first, and the shell refuses it all the same.
  "code:invalid_input:folder name": { title: "A folder needs a name.", body: "Type a name first." },
  // A pasted .env (Task 17): too much text, too many keys, choices that no longer fit the folder, a name found twice, and a folder with nothing to take out.
  "code:too_large:env text": { title: "That's too much to paste at once.", body: "A pasted .env can be up to 1 MB." },
  "code:too_large:env keys": { title: "That's too many keys to paste at once.", body: "A pasted .env can hold up to 500 keys." },
  "code:invalid_input:env rows": { title: "This folder changed while you were choosing.", body: "Paste the .env again." },
  "code:invalid_input:env twice": { title: "A key name is in this folder twice.", body: "Rename or move one, then try again." },
  "code:invalid_input:no keys": { title: "This folder has no keys.", body: "Add a key first." },
  // A copied key saved with the shortcut (Task 18): the copy was empty or too big, and nothing was typed in its place.
  "code:invalid_input:capture value": { title: "Paste or type the value first.", body: "" },
  // Settings (Task 20): the save shortcut, and Start with Windows. `{shortcut}` is the combination the page tried, put in by the page.
  "code:invalid_input:shortcut": {
    title: "Use at least two of Ctrl, Shift and Alt, with a letter, a digit or F1 to F12.",
    body: "Ctrl with C, V or X is kept for copy and paste.",
  },
  "code:invalid_input:shortcut taken": { title: "Another app already uses {shortcut}.", body: "Press a different combination." },
  "code:invalid_input:shortcut not set": { title: "Windows didn't take that shortcut.", body: "Try again." },
  "core:io:startup": { title: "Lockbox couldn't change Start with Windows.", body: "Try again." },
  "code:cancelled": { title: "That was stopped before it finished.", body: "" },
  "code:core": GENERIC,

  // The page's own refusal (code "page"): it never comes from the shell.
  "page:lock_listener": {
    title: "Lockbox can't listen for locks, so it won't open a vault.",
    body: "Close Lockbox and open it again.",
  },
  // A cloud question left open past the shell's five minutes: the shell let go of the save it had parked, so the yes finds nothing.
  "page:key_pdf_expired": { title: "That took too long, so nothing was saved. Press Save as PDF again.", body: "" },
  "page:file_copy_expired": { title: "That took too long, so nothing was saved. Press Save a copy again.", body: "" },
  "page:env_file_expired": { title: "That took too long, so nothing was saved. Choose Save as .env file again.", body: "" },

  "core:wrong_password": { title: "Wrong password.", body: "" },
  "core:recovery_key_typo": { title: "That recovery key has a typing mistake.", body: "Check it against the one you saved." },
  "core:invalid_recovery_key": { title: "That isn't a recovery key for Lockbox.", body: "" },
  // These two say a number of their own, filled in from the refusal's: `{position}` and `{found}`, and `{s}`, which is
  // an "s" unless `found` is 1.
  "core:recovery_key_word": { title: "Word {position} isn't a recovery key word.", body: "Check it against the key you saved." },
  "core:recovery_key_count": { title: "That's {found} word{s}; a recovery key has 24.", body: "Check none are missing or doubled." },
  "core:damaged": DAMAGED,
  // A stored file that does not decrypt, or whose stored copy is gone (10d): Open and Save a copy are refused. The design offers a backup
  // here; the button that opens one is 4B's, so only the sentence is shown.
  "core:damaged:file": { title: "This file is damaged, so it can't be opened or saved.", body: "A backup may have a good copy." },
  "core:damaged:file missing": { title: "This file is missing, so it can't be opened or saved.", body: "A backup may have a good copy." },
  // Ask 12: the list of vaults itself. The lost-list screen (`screens/setup/LostList.tsx`) has the design's own words and its
  // "Start a new list" button; these are for any other place that meets the same refusal (a refused add, say).
  "core:damaged:vault list": { title: "Lockbox lost its list of vaults.", body: "Your vaults are still in their folders." },
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
  // A key's name is a variable name, since a `.env` file is where keys go out: the engine refuses any other.
  "core:invalid_input:key name": {
    title: "That isn't a name Lockbox can use for a key.",
    body: "Use letters, digits and underscores (_) only, and don't start with a digit.",
  },
  // An edit made from a read of the item that is no longer the stored one: the design has no words for it, so these are
  // the session's own. The engine refuses the whole edit, so nothing was saved.
  "core:invalid_input:stale revision": {
    title: "This item changed while you were editing it.",
    body: "Nothing was saved. Cancel, then open it again to see the change.",
  },
  "core:invalid_input:destination in a vault folder": {
    title: "Lockbox won't save that inside a vault's folder.",
    body: "Choose another folder.",
  },
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
  "capture value",
  "chunk",
  "clipboard",
  "clipboard delay",
  "clipboard text",
  "collection",
  "collection has items",
  "collection inside a collection",
  "damaged output journals",
  "damaged vault lists",
  "destination changed",
  "destination exists",
  "destination in a vault folder",
  "destination inside vault",
  "destination is the backup",
  "destination not writable",
  "earlier password",
  "env keys",
  "env rows",
  "env text",
  "env twice",
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
  "key name",
  "key slot",
  "key slots",
  "link",
  "link type",
  "no character class selected",
  "no keys",
  "not a collection",
  "not a file",
  "not a key",
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
  "pdf",
  "print",
  "printer",
  "printer name",
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
  "shortcut",
  "shortcut not set",
  "shortcut taken",
  "source size changed",
  "source vault",
  "stale revision",
  "startup",
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
  "vault state",
  "vault still finishing an operation",
  "website",
];

/** A message as one line of text, for a screen that shows it in one place. */
export function messageText(message: Pick<Message, "title" | "body">): string {
  return message.body === "" ? message.title : `${message.title} ${message.body}`;
}

/** The numbers a refusal can carry, by the name the shell gives them. */
const NUMBER_FIELDS = ["needed", "available", "max_file", "min", "position", "found"] as const;

/** Fills a table entry's number places from the refusal's numbers; `undefined` when one it needs did not come as a whole number. */
function filled(words: Words, numbers: Record<string, number>): Words | undefined {
  const whole = (name: string): number | undefined => {
    const value = numbers[name];
    return value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  };
  const text = `${words.title}\n${words.body}`;
  // `{s}` follows `found`, so it needs it too.
  const needs = [...text.matchAll(/\{(position|found|s)\}/g)].map((match) => (match[1] === "s" ? "found" : (match[1] ?? "")));
  if (needs.some((name) => whole(name) === undefined)) return undefined;
  const fill = (part: string) =>
    part.replace(/\{(position|found|s)\}/g, (_, name: string) =>
      name === "s" ? (whole("found") === 1 ? "" : "s") : String(whole(name)),
    );
  return { title: fill(words.title), body: fill(words.body) };
}

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
export function messageFor(error: unknown, names: { shortcut?: string } = {}): Message {
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
  // A message with a number's place in it needs that number as a whole number: without it, it is the generic message.
  const counted = filled(words, numbers);
  if (counted === undefined) return { ...GENERIC };
  // The shortcut the page tried is the page's own text (never the shell's); a message that names one says "that shortcut" without it.
  const named = (part: string) => part.replace("{shortcut}", () => names.shortcut ?? "that shortcut");
  const said = { title: named(counted.title), body: named(counted.body) };
  return Object.keys(numbers).length > 0 ? { ...said, numbers } : { ...said };
}
