import { expect, test } from "vitest";
import { GENERIC, KNOWN_WHATS, MESSAGES, messageFor, messageText } from "./messages";
import { folderWords } from "./moveInWords";
import { listBelow, readBeside } from "./testing/files";

const CRATES = "../../crates/";

/** Every `.rs` file under `crates/`, with its text. */
function rustSources(): { path: string; text: string }[] {
  return listBelow(import.meta.url, CRATES)
    .filter((path) => path.endsWith(".rs") && !path.includes("/target/"))
    .map((path) => ({ path, text: readBeside(import.meta.url, `${CRATES}${path}`) }));
}

function snake(name: string): string {
  return name.replace(/(?<!^)([A-Z])/g, "_$1").toLowerCase();
}

test("every_shell_error_has_a_message", () => {
  const sources = rustSources();
  expect(sources.length, "the Rust sources were found").toBeGreaterThan(20);

  // Each variant of the shell's own refusal.
  const errorSource = sources.find((source) => source.path === "lockbox-desktop/src/error.rs")?.text ?? "";
  const body = /pub enum ShellError \{([\s\S]*?)\n\}/.exec(errorSource)?.[1] ?? "";
  const variants = [...body.matchAll(/^ {4}([A-Z]\w*)/gm)].map((match) => snake(match[1] ?? ""));
  expect(variants, "the variants were read").toContain("locked");
  expect(variants).toContain("core");
  const missing: string[] = [];
  for (const variant of variants) if (!(`code:${variant}` in MESSAGES)) missing.push(`code:${variant}`);

  // Each kind of engine error that crosses (`view("…")` in the same file).
  const kinds = [...errorSource.matchAll(/view\("([a-z_]+)"\)/g)].map((match) => match[1] ?? "");
  expect(kinds, "the kinds were read").toContain("wrong_password");
  for (const kind of kinds) if (!(`core:${kind}` in MESSAGES)) missing.push(`core:${kind}`);

  // Each `what: "…"` anywhere in the crates: the words are decided, even if they are the kind's own.
  const whats = new Set<string>();
  for (const { text } of sources) for (const match of text.matchAll(/\bwhat: (?:Some\()?"([^"]*)"/g)) whats.add(match[1] ?? "");
  // And the label a change passes as an argument (`write_change(session, generation, "…", …)`): it is a refusal's `what` too.
  for (const { text } of sources) for (const match of text.matchAll(/\bwrite_change\(\s*\w+,\s*\w+,\s*"([^"]*)"/g)) whats.add(match[1] ?? "");
  // And the location check's own, which it makes through its local `refuse("…")` (it has no `what:` of its own to read).
  for (const { path, text } of sources) {
    if (path.endsWith("lockbox-desktop/src/locations.rs")) for (const match of text.matchAll(/\brefuse\("([^"]*)"\)/g)) whats.add(match[1] ?? "");
  }
  expect(whats, "a change's label was read").toContain("password");
  expect(whats, "the location check's labels were read").toContain("network drive");
  expect(whats.size, "the whats were read").toBeGreaterThan(50);
  for (const what of whats) if (!KNOWN_WHATS.includes(what)) missing.push(`what: ${what}`);
  expect(missing, "no message for these").toEqual([]);

  // And the other way: nothing in the list that the Rust code no longer sends (a `what` outlives its refusal otherwise).
  const leftOver = KNOWN_WHATS.filter((what) => !whats.has(what));
  expect(leftOver, "listed here, sent by nothing").toEqual([]);

  // A message that names a `what` of its own is for one that exists.
  for (const id of Object.keys(MESSAGES)) {
    const what = /^(?:code|core):[a-z_]+:(.+)$/.exec(id)?.[1];
    if (what !== undefined) expect(KNOWN_WHATS, id).toContain(what);
  }

  // Every message is words: a title, and a body that may be empty. The only braces are a number's place, `{position}`, the
  // place for the shortcut the page tried, `{shortcut}`, and the one for the vault's name from the list, `{vault}`.
  for (const [id, message] of Object.entries(MESSAGES)) {
    expect(message.title.length, id).toBeGreaterThan(0);
    const bare = `${message.title} ${message.body}`.replace(/\{(?:position|found|s|shortcut|vault)\}/g, "1");
    expect(bare, id).not.toMatch(/[{}[\]]|undefined|null|\\/);
  }
});

test("a_new_recovery_key_a_lock_kept_from_the_screen_has_words_of_its_own", () => {
  // Not "Unlock the vault to see it.": that key was never seen, and the next unlock makes another.
  const message = messageFor({ code: "locked_after_change", what: "recovery key" });
  expect(message.title).toBe("The vault locked before Lockbox could show your new recovery key.");
  expect(message.body).toContain("make another one");
});

test("a_choice_that_expired_asks_to_pick_again", () => {
  const message = messageFor({ code: "choice_expired" });
  expect(message.title).toBe("That choice has expired.");
  expect(message.body).toBe("Pick the files again.");
});

test("a_backup_choice_that_expired_has_the_test_screens_own_words", () => {
  // The page's own refusal, for Test a backup: the shared "Pick the files again." stays for Add files.
  const message = messageFor({ code: "page", kind: "test_choice_expired" });
  expect(message.title).toBe("That choice has expired.");
  expect(message.body).toBe("Pick the backup again.");
  expect(messageFor({ code: "choice_expired" }).body).toBe("Pick the files again.");
});

test("a_restore_that_was_stopped_and_one_with_too_many_older_copies_have_the_designs_words", () => {
  const stopped = messageFor({ code: "page", kind: "restore_cancelled" });
  expect(stopped).toEqual({ title: "The restore was cancelled.", body: "Your vault is as it was." });
  // The swap's refusal when all 99 names for the older copy are taken, as the engine sends it (`CoreError::InvalidInput`).
  const tooMany = messageFor({ code: "core", kind: "invalid_input", what: "too many before-restore copies" });
  expect(tooMany).toEqual({ title: "There are too many older copies of this vault.", body: "Delete some, then restore again." });
  // Any other invalid input keeps the kind's own words.
  expect(messageFor({ code: "core", kind: "invalid_input", what: "something else" }).title).toBe(MESSAGES["core:invalid_input"]?.title);
});

test("an_older_copy_that_is_open_says_to_close_it_before_it_is_deleted", () => {
  // `delete_pre_restore` while a session is open on the copy (or an open of it is under way): the shell's busy refusal, with this `what`.
  const open = messageFor({ code: "busy", what: "folder is open" });
  expect(open).toEqual({ title: "Close this older copy first, then delete it.", body: "" });
  // A busy vault of another kind keeps the busy words.
  expect(messageFor({ code: "busy" }).title).toBe("That vault is busy.");
  // An older copy the page's listing no longer matches is `not_found`: the screen says its own words, the table has the plain ones.
  expect(messageFor({ code: "not_found" }).title).toBe("Lockbox can't find that.");
});

test("a_backup_that_changed_after_it_was_checked_says_to_pick_it_again", () => {
  // The shell's refusal when the archive prepare opened is not the one that was checked (the file was replaced in between).
  const changed = messageFor({ code: "invalid_input", what: "backup changed" });
  expect(changed).toEqual({ title: "This backup changed after it was checked.", body: "Pick it again." });
  expect(KNOWN_WHATS).toContain("backup changed");
});

test("unknown_error_gets_the_generic_message", () => {
  const unknown: unknown[] = [
    new Error("boom"),
    "a string",
    42,
    null,
    undefined,
    {},
    { code: "never_seen_before" },
    { code: "core" },
    { code: "core", kind: "never_seen_before" },
    { message: "something" },
  ];
  for (const error of unknown) {
    const message = messageFor(error);
    expect(message.title, JSON.stringify(error)).toBe(GENERIC.title);
    expect(message.body).toBe(GENERIC.body);
  }
});

test("wrong_password_has_the_designs_words", () => {
  expect(messageFor({ code: "core", kind: "wrong_password" })).toEqual({ title: "Wrong password.", body: "" });
});

test("a_vault_state_refusal_has_words_of_its_own", () => {
  // The shell could not write the "not confirmed" mark, so it made no key (and, for a new vault, no vault).
  const words = messageFor({ code: "too_large", what: "vault state" });
  expect(words).toEqual({
    title: "Lockbox couldn't save a note it needs before making the key, so it made none.",
    body: "Try again.",
  });
  expect(KNOWN_WHATS).toContain("vault state");
  // The same note failing as a disk error reads as the disk error it is.
  expect(messageFor({ code: "core", kind: "io" }).title).toBe(MESSAGES["core:io"]?.title);
});

test("word_and_count_refusals_have_words", () => {
  // Task 6b's two refusals, exactly as the shell sends them (the contract's JSON), said with their numbers.
  const word = messageFor({ code: "core", kind: "recovery_key_word", position: 7 });
  expect(word.title).toBe("Word 7 isn't a recovery key word.");
  expect(word.body).toBe("Check it against the key you saved.");
  expect(word.numbers).toEqual({ position: 7 });
  const count = messageFor({ code: "core", kind: "recovery_key_count", found: 23 });
  expect(count.title).toBe("That's 23 words; a recovery key has 24.");
  expect(count.body).toBe("Check none are missing or doubled.");
  expect(count.numbers).toEqual({ found: 23 });
  // One word is one word.
  expect(messageFor({ code: "core", kind: "recovery_key_count", found: 1 }).title).toBe("That's 1 word; a recovery key has 24.");
  expect(messageFor({ code: "core", kind: "recovery_key_count", found: 0 }).title).toBe("That's 0 words; a recovery key has 24.");

  // The numbers are numbers: anything else, or no number, is the generic message and carries none of the shell's text.
  const SENTINEL = "SENTINEL-4c1d C:\\Users\\secret";
  for (const bad of [SENTINEL, "7", -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, null, undefined, { nested: 7 }]) {
    for (const [kind, field] of [
      ["recovery_key_word", "position"],
      ["recovery_key_count", "found"],
    ] as const) {
      const message = messageFor({ code: "core", kind, [field]: bad });
      expect(message.title, `${kind} ${JSON.stringify(bad)}`).toBe(GENERIC.title);
      expect(JSON.stringify(message)).not.toContain("SENTINEL");
    }
  }
  // The typo's words are the spec's (5.2: "That recovery key has a typo"), on every screen that meets it; the other old kind is as it was.
  expect(messageFor({ code: "core", kind: "recovery_key_typo" })).toEqual({ title: "That recovery key has a typo.", body: "Check it against the one you saved." });
  expect(messageFor({ code: "core", kind: "invalid_recovery_key" }).title).toBe("That isn't a recovery key for Lockbox.");
});

test("a_key_that_does_not_open_a_vault_names_the_vault_the_page_gives", () => {
  // The design's words (28b). The shell sends `wrong_password` and the page makes this refusal of it; the vault's name is the list's, put in by the page.
  const refusal = { code: "page", kind: "recovery_key_does_not_open" };
  expect(messageFor(refusal, { vault: "My vault" })).toEqual({ title: "This key doesn't open My vault.", body: "" });
  // With no name (a vault whose details can't be read) it says "this vault", and never leaves a brace.
  expect(messageFor(refusal)).toEqual({ title: "This key doesn't open this vault.", body: "" });
  // The name is put in as text: nothing in it is read as a place to fill, and a name with `$` characters comes out as it is.
  expect(messageFor(refusal, { vault: "$& {vault} $1" }).title).toBe("This key doesn't open $& {vault} $1.");
  // The shortcut's place still works beside it.
  expect(messageFor({ code: "invalid_input", what: "shortcut taken" }, { shortcut: "Ctrl+Shift+L", vault: "My vault" }).title).toBe("Another app already uses Ctrl+Shift+L.");
});

test("a_recovery_choice_that_expired_asks_for_the_key_again", () => {
  // The page's own refusal of the shell's `choice_expired` from `recover_finish` (the words are the session's: the design gives none).
  expect(messageFor({ code: "page", kind: "recovery_choice_expired" })).toEqual({
    title: "Type the recovery key again.",
    body: "It waited too long, or the vault changed since it was checked. Nothing was changed.",
  });
  // The shared "Pick the files again." is not what it says.
  expect(messageFor({ code: "choice_expired" }).body).toBe("Pick the files again.");
});

test("a_vault_made_but_not_listed_points_at_the_first_screens_words", () => {
  const words = messageFor({ code: "invalid_input", what: "vault not listed" });
  expect(words.title).toBe("Your new vault is on disk but couldn't be added to the list.");
  expect(words.body).toContain("I already have a vault or a backup");
  // The new key is made automatically at the next unlock.
  expect(words.body).not.toMatch(/recovery key/i);
});

test("a_vault_folder_on_a_removable_drive_has_26bs_words_in_the_table", () => {
  // The words come through `messageFor`, from the table, as the design gives them; the page's own kind is what the first screen asks for.
  expect(messageText(messageFor({ code: "page", kind: "copy_it_first" }))).toBe(
    "That folder is on a removable drive. Copy it to this PC first, then choose the copy.",
  );
  expect(MESSAGES["page:copy_it_first"]).toBeDefined();
  expect(folderWords({ code: "invalid_input", what: "removable drive" })).toBe(messageText(messageFor({ code: "page", kind: "copy_it_first" })));
  // Any other refusal is the table's words for it, never the removable drive's.
  expect(folderWords({ code: "invalid_input", what: "network drive" })).toBe(messageText(messageFor({ code: "invalid_input", what: "network drive" })));
});

test("a_folder_that_cannot_be_added_has_words_of_its_own", () => {
  // Every drive a vault can't live on is the design's wrong-drive sentence; a folder with no vault in it is told to pick the vault's own.
  for (const what of ["removable drive", "network drive", "drive type not supported", "file system not supported"]) {
    expect(messageText(messageFor({ code: "invalid_input", what })), what).toBe(
      "A vault can't live on a removable, FAT32 or network drive. Choose a folder on this PC.",
    );
  }
  expect(messageText(messageFor({ code: "invalid_input", what: "not a vault folder" }))).toBe(
    "That folder isn't a Lockbox vault. Choose the vault's own folder.",
  );
  // Lockbox's own settings folder has the words `state folder` has.
  expect(messageFor({ code: "invalid_input", what: "app data folder" })).toEqual(messageFor({ code: "invalid_input", what: "state folder" }));
  for (const what of ["network drive", "drive type not supported", "file system not supported", "not a vault folder", "app data folder"]) {
    expect(KNOWN_WHATS).toContain(what);
  }
});

test("a_bad_key_name_has_words_of_its_own", () => {
  // The engine refuses a key's name that is not a variable name; the shell sends it as the engine's refusal.
  const words = messageFor({ code: "core", kind: "invalid_input", what: "key name" });
  expect(words).toEqual({
    title: "That isn't a name Lockbox can use for a key.",
    body: "Use letters, digits and underscores (_) only, and don't start with a digit.",
  });
  expect(KNOWN_WHATS).toContain("key name");
  // A key's value asked of another kind, or a login's field of a key, is a page mistake: the plain words, nothing of the kind.
  expect(KNOWN_WHATS).toContain("not a key");
  expect(messageFor({ code: "invalid_input", what: "not a key" }).title).toBe("Lockbox can't use that.");
});

test("a_folder_without_a_name_has_words_and_the_trash_refusals_stay_plain", () => {
  // The shell refuses a folder named with nothing (new, or renamed); the page asks first, so this is the shell's own say.
  expect(messageFor({ code: "invalid_input", what: "folder name" })).toEqual({
    title: "A folder needs a name.",
    body: "Type a name first.",
  });
  // The engine's refusals of the trash and the folders say no more than the plain words, and none says a title.
  for (const what of ["being deleted", "not in trash", "not a collection", "use delete_collection", "collection", "collection inside a collection"]) {
    expect(KNOWN_WHATS, what).toContain(what);
    const message = messageFor({ code: "core", kind: "invalid_input", what });
    expect(message.title, what).toBe("Lockbox can't use that.");
  }
});

test("the_env_refusals_have_words_of_their_own", () => {
  // Task 17's five labels, exactly as the shell sends them (the connection's table), each with its own title and body.
  const words: [object, string, string][] = [
    [{ code: "too_large", what: "env text" }, "That's too much to paste at once.", "A pasted .env can be up to 1 MB."],
    [{ code: "too_large", what: "env keys" }, "That's too many keys to paste at once.", "A pasted .env can hold up to 500 keys."],
    [{ code: "invalid_input", what: "env rows" }, "This folder changed while you were choosing.", "Paste the .env again."],
    [{ code: "invalid_input", what: "env twice" }, "A key name is in this folder twice.", "Rename or move one, then try again."],
    [{ code: "invalid_input", what: "no keys" }, "This folder has no keys.", "Add a key first."],
  ];
  for (const [error, title, body] of words) {
    expect(messageFor(error), JSON.stringify(error)).toEqual({ title, body });
    expect(KNOWN_WHATS).toContain((error as { what: string }).what);
  }
  // The label lists stay sorted, so the next one goes where a reader looks for it.
  expect([...KNOWN_WHATS]).toEqual([...KNOWN_WHATS].sort());
  // A value or a name over its limit has its own label already, and the same plain words as any too-large refusal.
  expect(messageFor({ code: "too_large", what: "value" }).title).toBe("That is too big for Lockbox to keep.");
});

test("a_save_with_no_value_has_words_of_its_own", () => {
  // Task 18: a copy that was empty or too big, saved with nothing typed in its place (the connection's new label).
  expect(messageFor({ code: "invalid_input", what: "capture value" })).toEqual({ title: "Paste or type the value first.", body: "" });
  expect(KNOWN_WHATS).toContain("capture value");
  expect([...KNOWN_WHATS]).toEqual([...KNOWN_WHATS].sort());
});

test("the_settings_refusals_have_words_of_their_own", () => {
  // Task 20's four labels, exactly as the shell sends them (the connection's table), each with its own words.
  const words: [object, string, string][] = [
    [
      { code: "invalid_input", what: "shortcut" },
      "Use at least two of Ctrl, Shift and Alt, with a letter, a digit or F1 to F12.",
      "Ctrl with C, V or X is kept for copy and paste.",
    ],
    [{ code: "invalid_input", what: "shortcut not set" }, "Windows didn't take that shortcut.", "Try again."],
    [{ code: "core", kind: "io", what: "startup" }, "Lockbox couldn't change Start with Windows.", "Try again."],
  ];
  for (const [error, title, body] of words) {
    expect(messageFor(error), JSON.stringify(error)).toEqual({ title, body });
    expect(KNOWN_WHATS).toContain((error as { what: string }).what);
  }
  // A taken shortcut names the combination the page tried (the page's own words, never the shell's); with none given it says "that shortcut".
  expect(messageFor({ code: "invalid_input", what: "shortcut taken" }, { shortcut: "Ctrl+Shift+S" })).toEqual({
    title: "Another app already uses Ctrl+Shift+S.",
    body: "Press a different combination.",
  });
  expect(messageFor({ code: "invalid_input", what: "shortcut taken" }).title).toBe("Another app already uses that shortcut.");
  expect(KNOWN_WHATS).toContain("shortcut taken");
  // The name is only put in a place made for it: it does not turn other words into something else, and braces in it stay as they are.
  expect(messageFor({ code: "invalid_input", what: "shortcut not set" }, { shortcut: "{found}" }).title).toBe("Windows didn't take that shortcut.");
  expect(messageFor({ code: "invalid_input", what: "shortcut taken" }, { shortcut: "{found}" }).title).toBe("Another app already uses {found}.");
  // The other refusals of these rows keep the general words.
  expect(messageFor({ code: "invalid_input", what: "idle time" }).title).toBe("Lockbox can't use that.");
  expect(messageFor({ code: "invalid_input", what: "clipboard delay" }).title).toBe("Lockbox can't use that.");
  expect([...KNOWN_WHATS]).toEqual([...KNOWN_WHATS].sort());
});

test("a_damaged_stored_file_has_the_designs_words_and_no_backup_button_text", () => {
  // Task 19, 10d: a stored file that does not decrypt, and one whose stored copy is gone, as the engine sends them. Any other damaged
  // thing keeps the general message.
  for (const what of ["file", "file missing"]) {
    expect(KNOWN_WHATS).toContain(what);
    const said = messageFor({ code: "core", kind: "damaged", what });
    expect(said.title).toMatch(/so it can't be opened or saved\.$/);
    expect(said.body).toBe("A backup may have a good copy.");
  }
  expect(messageFor({ code: "core", kind: "damaged", what: "file" }).title).toBe("This file is damaged, so it can't be opened or saved.");
  expect(messageFor({ code: "core", kind: "damaged", what: "item" }).title).toBe("Lockbox can't read part of this vault.");
});

test("the_new_vault_list_refusals_say_no_more_than_the_plain_words", () => {
  // `Start a new list` is refused for a list that reads fine (or none), and once a hundred damaged copies are already set aside.
  expect(KNOWN_WHATS).toContain("damaged vault lists");
  expect(KNOWN_WHATS).toContain("vault list");
  expect(messageFor({ code: "invalid_input", what: "vault list" }).title).toBe("Lockbox can't use that.");
  expect(messageFor({ code: "too_large", what: "damaged vault lists" }).title).toBe("That is too big for Lockbox to keep.");
  // The damaged list itself keeps its own words, which the lost-list screen no longer needs but a refused add still can say.
  expect(messageFor({ code: "core", kind: "damaged", what: "vault list" }).title).toBe("Lockbox lost its list of vaults.");
  expect([...KNOWN_WHATS]).toEqual([...KNOWN_WHATS].sort());
});

test("no_message_contains_raw_error_text", () => {
  const SENTINEL = "SENTINEL-7f3a C:\\Users\\secret";
  const errors: unknown[] = [
    new Error(SENTINEL),
    SENTINEL,
    { message: SENTINEL },
    { code: SENTINEL },
    { code: "core", kind: SENTINEL },
    { code: "core", kind: "io", what: SENTINEL },
    { code: "core", kind: "damaged", what: SENTINEL },
    { code: "invalid_input", what: SENTINEL },
    { code: "busy", what: SENTINEL },
    { code: "locked_after_change", what: SENTINEL },
    { code: "core", kind: "not_enough_space", needed: SENTINEL, available: SENTINEL },
    { code: "core", kind: "password_too_short", min: SENTINEL },
    { code: "core", kind: "wrong_password", text: SENTINEL, detail: { nested: SENTINEL } },
  ];
  for (const error of errors) {
    const message = messageFor(error);
    expect(JSON.stringify(message), JSON.stringify(error)).not.toContain("SENTINEL");
    expect(JSON.stringify(message)).not.toContain("secret");
  }
  // The numbers an error carries do come through, and only numbers.
  expect(messageFor({ code: "core", kind: "not_enough_space", needed: 5, available: 3 }).numbers).toEqual({
    needed: 5,
    available: 3,
  });
  expect(messageFor({ code: "core", kind: "password_too_short", min: 12 }).numbers).toEqual({ min: 12 });
  expect(messageFor({ code: "core", kind: "not_enough_space", needed: "5", available: 3 }).numbers).toEqual({
    available: 3,
  });
  expect(messageFor({ code: "core", kind: "wrong_password" }).numbers).toBeUndefined();
});

// Plan 4B Task 3: the four reasons a backup is refused before anything is written, each with the design's words (the vault's name is
// the screen's own, in its heading). Nothing here is the shell's text: only which one it was.
test("the_four_backup_refusals_have_the_designs_words", () => {
  const said = (what: string) => messageText(messageFor({ code: "invalid_input", what }));
  expect(said("details changed")).toBe(
    "Its details were changed outside Lockbox, so a backup made now might not open. Look at that change and accept it first, then back up.",
  );
  expect(said("password copies disagree")).toBe("Change this vault's password once more, then back up.");
  expect(said("recovery key copies disagree")).toBe("Make a new recovery key for this vault, then back up.");
  expect(said("details unchecked")).toBe("Lock this vault and open it again, then back up.");
  for (const what of ["details changed", "password copies disagree", "recovery key copies disagree", "details unchecked"]) {
    expect(KNOWN_WHATS).toContain(what);
  }
});
