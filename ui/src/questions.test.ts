// Every row of the design's "The app's questions" table is in the app word for word: its message and its buttons. The
// rows built in 4A to 4C keep their own screen tests, which drive the words through the production screen; this test
// catches a row that was never built, or whose words drifted. The design is read, not copied here, so a change to the
// design's words fails this test until the app follows.
import { expect, test } from "vitest";
import { listBelow, readBeside } from "./testing/files";

const DESIGN = "../../docs/design/2026-11-05-user-interface-design.md";
const DESKTOP = "../../crates/petalock-desktop/src/";

type Row = { moment: string; message: string; buttons: string[] };

/** The table under "### The app's questions": one row each, buttons split on commas ("none" is no buttons). */
function designRows(): Row[] {
  // The design keeps its original wording (its note of 2026-11-25 says the product is now Petalock), so its table still
  // says Lockbox where the app says Petalock: the product's name is the one word read as renamed.
  const design = readBeside(import.meta.url, DESIGN).replaceAll("Lockbox", "Petalock");
  const start = design.indexOf("### The app's questions");
  const section = design.slice(start, design.indexOf("\n### ", start + 1));
  return section
    .split("\n")
    .filter((line) => line.startsWith("| ") && !line.startsWith("| Moment") && !line.startsWith("|---"))
    .map((line) => {
      const [moment = "", message = "", buttons = ""] = line
        .trim()
        .replace(/^\|\s*|\s*\|$/g, "")
        .split(" | ")
        .map((cell) => cell.trim());
      return { moment, message, buttons: buttons === "none" ? [] : buttons.split(", ").map((label) => label.trim()) };
    });
}

/**
 * Where a row's message is not the words on screen as they stand: the design describes them. Each says what the
 * screen shows instead, still from the design's own words; `design` is the row as this was written, so a change to the
 * design's row fails the test until this follows.
 */
const AS_SHOWN: Record<string, { design: string; shown: string }> = {
  // the rule, then the live count joined to it in code (`${rule} · ${typed} so far`), then a check mark with its own words
  "Password count while typing (21b)": {
    design:
      'At least 12 characters · 5 so far. At 12 or more, a check mark and "12 characters or more", said once to a screen reader.',
    shown: "At least 12 characters. so far. 12 characters or more",
  },
  // the bracket is a note for the build, not words on screen
  "Vault made but not listed": {
    design:
      'Your new vault is on disk but couldn\'t be added to the list. Use "I already have a vault or a backup" on the first screen to add it. (Its new recovery key is made at its first unlock, 21f.)',
    shown:
      'Your new vault is on disk but couldn\'t be added to the list. Use "I already have a vault or a backup" on the first screen to add it.',
  },
};

/** Rows whose sentence a count builds in two pieces, singular and plural, each carrying the words up to a comma. */
const SPLIT_AT_COMMAS = new Set(["Items can't be read (Ask 4)"]);

/**
 * Where the built buttons stand in for the design's, each with why (the session's call, in 4D Task 7's notes for Ariel).
 */
const BUTTONS_AS_BUILT: Record<string, string[]> = {
  // Copy to a vault's form (25c) says it with an Unlock button for each locked vault and Cancel, which does OK's job: no dead end
  "Nowhere to copy to": ["Cancel"],
};

/** Rows whose words are the desktop crate's (a notice shown before the page exists), not the page's. */
const IN_THE_SHELL = new Set(["Can't start (Ask 14)"]);

/**
 * Rows not built, each waiting on Ariel's call, with why. The check still runs on them and fails once one is built, so
 * this list can't outlive the gap. None waits now: Ask 5, the last, was built as drawn (4D Task 11b).
 */
const WAITING_ON_ARIEL: Record<string, string> = {};

/**
 * The parts of a message that are fixed words, split at what changes (the vault's name, the cloud service's name,
 * counts, sizes, paths, printer names) and at sentence ends (a title shows its sentence without the full stop); with
 * `commas`, at commas too.
 */
function fixedParts(message: string, commas = false): string[] {
  return message
    .split(/My vault|OneDrive|E:\\Vaults|C:\\Users\\you\\Documents|\[[^\]]*\]|\d+(?:\.\d+)? ?(?:GB|MB)\b|\b\d+\b/)
    .flatMap((piece) => piece.split(commas ? /(?<=[.?!,])\s+/ : /(?<=[.?!])\s+/))
    .map((piece) => piece.trim().replace(/^[,.:]\s*/, "").replace(/[.,:]$/, "").trim())
    .filter((piece) => piece.length >= 3);
}

/** The fixed parts of `row` as the screen shows it. */
const partsOf = (row: Row): string[] =>
  fixedParts(AS_SHOWN[row.moment]?.shown ?? row.message, SPLIT_AT_COMMAS.has(row.moment));

/**
 * Source text with comments taken out (a sentence quoted in a comment is not on screen) and the ways it may spell the
 * same words made one: escapes, entities, quotes, joins and line breaks.
 */
function normalised(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[\s;,{}()])\/\/.*$/gm, "$1")
    .replace(/\\(["'`])/g, "$1")
    .replace(/&apos;|&#39;|[‘’]/g, "'")
    .replace(/&quot;|[“”]/g, '"')
    .replace(/(["'`])\s*\+\s*\1/g, "")
    .replace(/\\\r?\n\s*/g, "")
    .replace(/\s+/g, " ");
}

type Source = { path: string; text: string; imports: string[] };

/** The page's source files (tests and test helpers left out), each with the files it imports beside it. */
function pageSources(): Source[] {
  const paths = listBelow(import.meta.url, "./").filter(
    (path) => /\.(ts|tsx)$/.test(path) && !/\.test\.tsx?$/.test(path) && !path.startsWith("testing/"),
  );
  return paths.map((path) => {
    const raw = readBeside(import.meta.url, `./${path}`);
    const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : "";
    const imports = [...raw.matchAll(/from "(\.{1,2}\/[^"]+)"/g)].map((match) => {
      const parts = `${dir}${match[1] ?? ""}`.split("/");
      const out: string[] = [];
      for (const part of parts) {
        if (part === "..") out.pop();
        else if (part !== ".") out.push(part);
      }
      return out.join("/");
    });
    return { path, text: normalised(raw), imports };
  });
}

function shellSources(): Source[] {
  return listBelow(import.meta.url, DESKTOP)
    .filter((path) => path.endsWith(".rs"))
    .map((path) => ({ path, text: normalised(readBeside(import.meta.url, `${DESKTOP}${path}`)), imports: [] }));
}

/** A button's label as words on screen: a string or a JSX text of its own, not a part of a longer sentence. */
const hasLabel = (text: string, label: string): boolean => {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(["'\`>]\\s*${escaped}\\s*["'\`<]|label: "${escaped}")`).test(text);
};

/**
 * What of `row` no one source file has, together with the words files (`.ts`) and shared parts (`parts/`, never another
 * screen) it imports: the
 * best file's missing parts, or every part when no file has any.
 */
function missingFrom(row: Row, sources: Source[]): string[] {
  const parts = partsOf(row);
  const byPath = new Map(sources.map((source) => [source.path, source]));
  const scopeOf = (source: Source): string =>
    [source, ...source.imports.map((name) => byPath.get(`${name}.ts`) ?? (name.startsWith("parts/") ? byPath.get(`${name}.tsx`) : undefined))]
      .filter((each): each is Source => each !== undefined)
      .map((each) => each.text)
      .join("\n");
  let best: string[] | undefined;
  for (const source of sources) {
    const scope = scopeOf(source);
    const missing = [
      ...parts.filter((part) => !scope.includes(part)).map((part) => `words "${part}"`),
      ...(BUTTONS_AS_BUILT[row.moment] ?? row.buttons).filter((label) => !hasLabel(scope, label)).map((label) => `button "${label}"`),
    ];
    if (best === undefined || missing.length < best.length) best = missing;
    if (missing.length === 0) return [];
  }
  return best ?? parts;
}

test("every_design_question_is_in_the_app", () => {
  const rows = designRows();
  expect(rows.length, "the design's table was read").toBeGreaterThanOrEqual(38);
  const page = pageSources();
  const shell = shellSources();
  expect(page.length, "the page's sources were found").toBeGreaterThan(50);
  expect(shell.length, "the desktop crate's sources were found").toBeGreaterThan(20);
  let checked = 0;
  const wrong: string[] = [];
  for (const row of rows) {
    expect(partsOf(row).length, `${row.moment} has words to look for`).toBeGreaterThan(0);
    for (const label of row.buttons) expect(label.length, `${row.moment}: every button has a label`).toBeGreaterThan(0);
    const shown = AS_SHOWN[row.moment];
    if (shown !== undefined) expect(row.message, `${row.moment}: the design's row is still the one AS_SHOWN describes`).toBe(shown.design);
    const missing = missingFrom(row, IN_THE_SHELL.has(row.moment) ? shell : page);
    const waiting = WAITING_ON_ARIEL[row.moment];
    if (waiting !== undefined) {
      if (missing.length === 0) wrong.push(`${row.moment}: now in the app, so take it off the waiting list`);
    } else if (missing.length > 0) wrong.push(`${row.moment}: ${missing.join("; ")}`);
    checked += 1;
  }
  expect(checked).toBe(rows.length);
  for (const moment of [...Object.keys(AS_SHOWN), ...Object.keys(BUTTONS_AS_BUILT), ...SPLIT_AT_COMMAS, ...IN_THE_SHELL])
    expect(rows.some((row) => row.moment === moment), `${moment} is still a row of the design`).toBe(true);
  for (const moment of Object.keys(WAITING_ON_ARIEL)) expect(rows.some((row) => row.moment === moment), `${moment} is still a row of the design`).toBe(true);
  expect(wrong, "rows not in the app word for word").toEqual([]);
});

test("the_question_check_fires_on_a_drifted_or_missing_row", () => {
  const sources: Source[] = [
    { path: "a.tsx", text: normalised('title={`${name} hasn\'t been backed up in 30 days`} <Button>Later</Button> label: "Back up now"'), imports: ["b"] },
    { path: "b.ts", text: normalised('"A backup on another drive is what saves you if this " +\n  "PC fails."'), imports: [] },
  ];
  const row: Row = {
    moment: "Backup overdue (Ask 1)",
    message: "My vault hasn't been backed up in 30 days. A backup on another drive is what saves you if this PC fails.",
    buttons: ["Later", "Back up now"],
  };
  expect(missingFrom(row, sources), "found across a screen and the words file it imports").toEqual([]);
  expect(missingFrom({ ...row, message: row.message.replace("another drive", "a second drive") }, sources)).toEqual([
    'words "A backup on a second drive is what saves you if this PC fails"',
  ]);
  expect(missingFrom({ ...row, buttons: ["Later", "Back up"] }, sources), "a label inside a longer one is not it").toEqual(['button "Back up"']);
  expect(missingFrom(row, [sources[1] as Source]).length, "a file without the rest of the row").toBeGreaterThan(0);
  expect(missingFrom(row, []).length, "no source at all").toBeGreaterThan(0);
  // a sentence only in a comment is not on screen
  const commented: Source = {
    path: "c.tsx",
    text: normalised('// My vault hasn\'t been backed up in 30 days\n/* A backup on another drive is what saves you if this PC fails. */ <Button>Later</Button> label: "Back up now"'),
    imports: [],
  };
  expect(missingFrom(row, [commented]).length, "words only in comments").toBe(3);
  // an address in a string is not a comment
  expect(normalised('"https://example.com/a" // gone')).toBe('"https://example.com/a" ');
  // words in another screen the file imports are not this file's
  const screens: Source[] = [
    { path: "App.tsx", text: normalised("<Button>Later</Button>"), imports: ["screens/Reminder"] },
    { path: "screens/Reminder.tsx", text: sources[0]?.text ?? "", imports: [] },
  ];
  expect(missingFrom({ ...row, buttons: [] }, screens).length, "a screen's words are not borrowed through another screen").toBeGreaterThan(0);
});
