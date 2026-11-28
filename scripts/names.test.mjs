// Plan 5, Task 0e, `no_lockbox_outside_the_format_labels`: the product, its code and its repository are Petalock. The old
// name Lockbox is left only where changing it would break something or rewrite history, each listed below with the reason:
// the vault and backup format labels (inside every vault and backup ever made), the old backup extension (which opens
// once renamed), the dated design notes and links to them, and two lines of SECURITY.md about a test run while the app
// had its old name. Every tracked file and path is read; a new `lockbox`
// anywhere else fails this test until someone decides it belongs on the list.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Whole files that keep the old name, and why. */
export const FILES = [
  // Dated design notes are history: they record what was decided under the old name.
  [/^docs\/design\//, "dated design notes"],
  // gitleaks' fingerprints of past findings name the commits and paths of their day.
  [/^\.gitleaksignore$/, "fingerprints of past findings"],
  // The scans for the old name: they search for the word, so they hold it.
  [/^scripts\/names\.test\.mjs$/, "this scan"],
  [/^crates\/petalock-desktop\/src\/names\.rs$/, "the shell's scan of what people see"],
  [/^ui\/src\/names\.test\.ts$/, "the page's scan of what people see"],
];

/** Words that keep the old name wherever they are, and why. */
export const WORDS = [
  // The vault and backup format labels: bound into every vault and backup's encryption and MACs, so renaming them would
  // make every existing vault and backup unreadable (the format constants).
  [/lockbox\/(?:header|slot|item|chunk|backup-manifest)/g, "format label"],
  [/lockbox (?:header mac v1|backup manifest v1|recovery key v1)/g, "format label"],
  // The key-derivation timing run's fixed input, never stored; kept as it was with the labels.
  [/lockbox calibration/g, "timing run's fixed input"],
  // Backups made before the rename end in .lockbox-backup. No picker offers that ending (no migration ships: nobody outside
  // this PC ever ran the app); such a backup opens once renamed to .petalock-backup, since the engine reads by content.
  [/lockbox-backup/gi, "the old backup extension"],
  // The dated design spec keeps its file name and headings (history), so links to it keep them too.
  [/2026-10-07-lockbox-design/g, "dated design spec's file name"],
  [/what-reviewed-means-for-lockbox/g, "a heading of the dated design spec"],
];

/** Single lines that keep the old name, by file, and why. */
export const LINES = [
  ["SECURITY.md", "(when the app was still called Lockbox): screenshots and Snipping Tool leave Lockbox out", "a test run under the old name"],
  ["SECURITY.md", "since a screenshot of Magnifier loses Lockbox too", "a test run under the old name"],
  // The design spec it reads still says Lockbox, so the test reads the old name as the new one.
  ["ui/src/questions.test.ts", 'replaceAll("Lockbox", "Petalock")', "reads the dated design spec"],
  ["ui/src/questions.test.ts", "// says Lockbox where the app says Petalock", "reads the dated design spec"],
  ["crates/petalock-desktop/src/clipboard.rs", "when the app was still called Lockbox", "a test run under the old name"],
  // Tests that prove the app leaves the old name alone: they must name it.
  ["crates/petalock-desktop/src/paths.rs", 'const OLD_NAME: &str = "Lockbox";', "the state folder is not the old one"],
  ["crates/petalock-desktop/src/os/win.rs", "io.github.sumguywhowantstobuild.lockbox.instance.test-", "the old instance lock is its own"],
  ["crates/petalock-desktop/src/os/win.rs", 'const OLD_VALUE: &str = "Lockbox";', "the old startup entry is left alone"],
  ["crates/petalock-desktop/src/os/win.rs", "old\\lockbox.exe", "the old startup entry is left alone"],
];

const OLD = /lockbox/i;

/**
 * The places that say lockbox and aren't on the lists, as `[path, line number, line]` (line 0 is the path itself), and
 * what each list entry matched, so a stale entry shows.
 */
export function oldNames(files) {
  const hits = [];
  const used = { files: new Set(), words: new Set(), lines: new Set() };
  for (const [path, text] of files) {
    const file = FILES.findIndex(([pattern]) => pattern.test(path));
    if (file >= 0) {
      used.files.add(file);
      continue;
    }
    if (OLD.test(path.replace(/2026-10-07-lockbox-design/g, ""))) hits.push([path, 0, path]);
    else if (path.includes("2026-10-07-lockbox-design")) used.words.add(WORDS.findIndex(([p]) => p.source.includes("2026-10-07")));
    text.split("\n").forEach((line, i) => {
      if (!OLD.test(line)) return;
      const listed = LINES.findIndex(([where, words]) => where === path && line.includes(words));
      if (listed >= 0) {
        used.lines.add(listed);
        return;
      }
      let rest = line;
      WORDS.forEach(([pattern], w) => {
        pattern.lastIndex = 0;
        if (pattern.test(rest)) used.words.add(w);
        pattern.lastIndex = 0;
        rest = rest.replace(pattern, "");
      });
      if (OLD.test(rest)) hits.push([path, i + 1, line.trim()]);
    });
  }
  return { hits, used };
}

/** Every tracked file and its text; files holding a NUL byte (the icons) are binary and are checked by path only. */
function trackedFiles() {
  const listed = spawnSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(listed.status, 0, listed.stderr);
  return listed.stdout
    .split("\0")
    .filter(Boolean)
    .map((path) => {
      const bytes = readFileSync(join(ROOT, path));
      return [path, bytes.includes(0) ? "" : bytes.toString("utf8")];
    });
}

test("no_lockbox_outside_the_format_labels: only the listed labels, history and scans say Lockbox", () => {
  const files = trackedFiles();
  const lines = files.reduce((sum, [, text]) => sum + text.split("\n").length, 0);
  // A scan that read nothing would pass: the repository has hundreds of files and far more lines.
  assert.ok(files.length > 300, `only ${String(files.length)} files read`);
  assert.ok(lines > 50000, `only ${String(lines)} lines read`);
  const { hits, used } = oldNames(files);
  assert.deepEqual(hits, [], "places that still say Lockbox");
  // And no entry of the lists has gone stale.
  FILES.forEach(([pattern, why], i) => assert.ok(used.files.has(i), `no file matches ${String(pattern)} (${why})`));
  WORDS.forEach(([pattern, why], i) => assert.ok(used.words.has(i), `nothing says ${String(pattern)} (${why})`));
  LINES.forEach(([path, words], i) => assert.ok(used.lines.has(i), `${path} no longer has ${JSON.stringify(words)}`));
});

test("the_old_name_scan_fires_on_a_planted_word_and_stays_quiet_on_the_lists", () => {
  const planted = [
    ["src/a.rs", 'let x = "ok";\nlet y = lockbox_core::Vault;\n// Lockbox in a comment\n'],
    ["crates/lockbox-new/Cargo.toml", "name = \"x\"\n"],
    ["src/b.rs", 'const L: &str = "lockbox/item"; let z = "LOCKBOX";\n'],
    ["SECURITY.md", "Tested (when the app was still called Lockbox): screenshots and Snipping Tool leave Lockbox out\nLockbox again\n"],
  ];
  assert.deepEqual(oldNames(planted).hits, [
    ["src/a.rs", 2, "let y = lockbox_core::Vault;"],
    ["src/a.rs", 3, "// Lockbox in a comment"],
    ["crates/lockbox-new/Cargo.toml", 0, "crates/lockbox-new/Cargo.toml"],
    ["src/b.rs", 1, 'const L: &str = "lockbox/item"; let z = "LOCKBOX";'],
    ["SECURITY.md", 2, "Lockbox again"],
  ]);
  const clean = [
    ["src/a.rs", 'const L: &[u8] = b"lockbox header mac v1";\nlet a = "lockbox/chunk";\n'],
    ["docs/design/2026-10-07-lockbox-design.md", "# Lockbox\n"],
    ["README.md", "[spec](docs/design/2026-10-07-lockbox-design.md#what-reviewed-means-for-lockbox)\n"],
    ["src/c.rs", 'let old = "made.lockbox-backup";\n'],
  ];
  assert.deepEqual(oldNames(clean).hits, []);
});
