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

  // Every message is words: a title, and a body that may be empty.
  for (const [id, message] of Object.entries(MESSAGES)) {
    expect(message.title.length, id).toBeGreaterThan(0);
    expect(`${message.title} ${message.body}`, id).not.toMatch(/[{}[\]]|undefined|null|\\/);
  }
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

test("a_vault_made_but_not_listed_points_at_the_first_screens_words", () => {
  const words = messageFor({ code: "invalid_input", what: "vault not listed" });
  expect(words.title).toBe("Your new vault is on disk but couldn't be added to the list.");
  expect(words.body).toContain("I already have a vault");
  // The new key is made automatically at the next unlock.
  expect(words.body).not.toMatch(/recovery key/i);
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
