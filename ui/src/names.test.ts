// Plan 5, Task 0c, `no_lockbox_in_what_people_see` (the page's half; the shell's half is `src/names.rs` in the desktop
// crate): the product is Petalock, and no word the page shows says Lockbox. Every string, template and piece of text the
// page's code holds, the words of `index.html` and the style sheets' strings are read, and none says `lockbox` since Task
// 0e renamed the code names. A new one fails this test until someone decides it is a code name nobody is shown and lists
// it, with the reason. The repository-wide scan is `scripts/names.test.mjs`.
import ts from "typescript";
import { expect, test } from "vitest";
import { listBelow, readBeside } from "./testing/files";

/** Every piece of text in a TypeScript or TSX file: string and template parts and JSX text. Import and export paths are
 *  file names, never words, so they are not read; comments are not code and are never reached. */
export function textsIn(source: string, fileName: string): string[] {
  const kind = fileName.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node) ||
      ts.isJsxText(node)
    ) {
      found.push(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/** The strings a style sheet holds (`content: "..."`, `url("...")`), comments left out. */
export function cssTextsIn(source: string): string[] {
  const bare = source.replace(/\/\*[\s\S]*?\*\//g, "");
  return [...bare.matchAll(/"([^"]*)"|'([^']*)'/g)].map((m) => m[1] ?? m[2] ?? "");
}

/** The words of an HTML file: everything but its comments. */
export function htmlTextIn(source: string): string {
  // The comment's marks are written in two pieces: the security scan's parser reads a regular expression holding them as a
  // syntax error, and a scan that cannot read a file is not a clean scan.
  const [open, close] = ["<!" + "--", "--" + ">"];
  let text = source;
  for (let at = text.indexOf(open); at !== -1; at = text.indexOf(open)) {
    const end = text.indexOf(close, at);
    text = text.slice(0, at) + (end === -1 ? "" : text.slice(end + close.length));
  }
  return text;
}

const says = (text: string): boolean => text.toLowerCase().includes("lockbox");

/** Where the page's own code lives, and what is not shipped: the tests and the fake shell they stand on. */
function shippedFiles(): string[] {
  return listBelow(import.meta.url, "./").filter(
    (path) =>
      /\.(ts|tsx|css)$/.test(path) &&
      !/\.test\.tsx?$/.test(path) &&
      !path.startsWith("testing/") &&
      path !== "vite-env.d.ts",
  );
}

/** The `lockbox` strings that stay on the page, by file, and why; none may be shown to anyone. Empty since Task 0e renamed
 *  the shell's event names, the last code names the page held. */
const ALLOWED: readonly (readonly [string, string])[] = [];

function lockboxTexts(files: readonly (readonly [string, string])[]): [string, string][] {
  const hits: [string, string][] = [];
  for (const [name, source] of files) {
    const texts = name.endsWith(".css") ? cssTextsIn(source) : name.endsWith(".html") ? [htmlTextIn(source)] : textsIn(source, name);
    for (const text of texts) if (says(text)) hits.push([name, text]);
  }
  return hits;
}

test("no_lockbox_in_what_people_see", () => {
  const names = shippedFiles();
  expect(names.length, "the page's files went missing").toBeGreaterThan(80);
  const files: [string, string][] = names.map((name) => [name, readBeside(import.meta.url, `./${name}`)]);
  files.push(["index.html", readBeside(import.meta.url, "../index.html")]);
  const texts = files
    .filter(([name]) => name.endsWith(".ts") || name.endsWith(".tsx"))
    .reduce((count, [name, source]) => count + textsIn(source, name).length, 0);
  expect(texts, "the scan found too few words to be reading the page").toBeGreaterThan(1500);

  const hits = lockboxTexts(files);
  const unlisted = hits.filter(([file, text]) => !ALLOWED.some(([f, t]) => f === file && t === text));
  expect(unlisted, "words that say Lockbox").toEqual([]);
  // No entry of the list has gone stale.
  for (const [file, text] of ALLOWED) {
    expect(hits.some(([f, t]) => f === file && t === text), `${file}: ${text} is listed but no longer there`).toBe(true);
  }
});

test("the scan for Lockbox fires on a planted word and stays quiet when clean", () => {
  const planted = [
    ["Planted.tsx", 'export const a = "Welcome to Lockbox"; const b = `Open ${1} lockbox`; const c = <p title="LOCKBOX">Hi Lockbox</p>;'],
    ["planted.css", '.a::before { content: "Lockbox"; } /* Lockbox in a comment */'],
    ["index.html", "<title>Lockbox</title><!-- Lockbox in a comment -->"],
  ] as const;
  // The template's head (`Open `) says nothing; its tail does. The comments are not read.
  expect(lockboxTexts(planted)).toEqual([
    ["Planted.tsx", "Welcome to Lockbox"],
    ["Planted.tsx", " lockbox"],
    ["Planted.tsx", "LOCKBOX"],
    ["Planted.tsx", "Hi Lockbox"],
    ["planted.css", "Lockbox"],
    ["index.html", "<title>Lockbox</title>"],
  ]);
  const clean = [
    ["Clean.tsx", 'import { LockboxParts } from "./parts/LockboxParts"; // Lockbox, in a comment\nexport const a = "Welcome to Petalock";'],
    ["clean.css", "/* Lockbox */ .a { color: red; }"],
    ["index.html", "<title>Petalock</title>"],
  ] as const;
  expect(lockboxTexts(clean)).toEqual([]);
  expect(textsIn(clean[0][1], "Clean.tsx")).toEqual(["Welcome to Petalock"]);
});
