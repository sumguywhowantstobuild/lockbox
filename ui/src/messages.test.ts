import { expect, test } from "vitest";
import { GENERIC, KNOWN_WHATS, MESSAGES, messageFor } from "./messages";
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
  expect(whats, "a change's label was read").toContain("password");
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

  // Every message is words: a title, and a body that may be empty. The only braces are a number's place, `{position}`, and the
  // place for the shortcut the page tried, `{shortcut}`.
  for (const [id, message] of Object.entries(MESSAGES)) {
    expect(message.title.length, id).toBeGreaterThan(0);
    const bare = `${message.title} ${message.body}`.replace(/\{(?:position|found|s|shortcut)\}/g, "1");
    expect(bare, id).not.toMatch(/[{}[\]]|undefined|null|\\/);
  }
});

test("a_new_recovery_key_a_lock_kept_from_the_screen_has_words_of_its_own", () => {
  // Not "Unlock the vault to see it.": that key was never seen, and the next unlock makes another.
  const message = messageFor({ code: "locked_after_change", what: "recovery key" });
  expect(message.title).toBe("The vault locked before Lockbox could show your new recovery key.");
  expect(message.body).toContain("make another one");
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
  // The old kinds are as they were.
  expect(messageFor({ code: "core", kind: "recovery_key_typo" }).title).toBe("That recovery key has a typing mistake.");
  expect(messageFor({ code: "core", kind: "invalid_recovery_key" }).title).toBe("That isn't a recovery key for Lockbox.");
});

test("a_vault_made_but_not_listed_points_at_the_first_screens_words", () => {
  const words = messageFor({ code: "invalid_input", what: "vault not listed" });
  expect(words.title).toBe("Your new vault is on disk but couldn't be added to the list.");
  expect(words.body).toContain("I already have a vault");
  // The new key is made automatically at the next unlock.
  expect(words.body).not.toMatch(/recovery key/i);
});

test("a_bad_key_name_has_words_of_its_own", () => {
  // The engine refuses a key's name that is not a variable name; the shell sends it as the engine's refusal.
  const words = messageFor({ code: "core", kind: "invalid_input", what: "key name" });
  expect(words).toEqual({
    title: "That isn't a name Lockbox can use for a key.",
    body: "Use letters, digits and _ only, and don't start with a digit.",
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
