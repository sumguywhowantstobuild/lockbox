import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { checks, parseArgs, runPhases, summary } from "./check.mjs";

/** A step that prints `name` and exits with `code`, after `ms`. */
const step = (name, code = 0, ms = 0) => ({
  name,
  cmd: process.execPath,
  args: ["-e", `setTimeout(() => { console.log(${JSON.stringify(name)}); process.exit(${code}); }, ${ms})`],
});

const withLogs = async (fn) => {
  const dir = mkdtempSync(join(tmpdir(), "check-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test("every step passes: each is reported ok, with its output in its log", () =>
  withLogs(async (dir) => {
    const results = await runPhases([[[step("a"), step("b")], [step("c")]], [[step("d")]]], dir);
    assert.deepEqual(
      results.map((r) => [r.name, r.code]),
      [["a", 0], ["b", 0], ["c", 0], ["d", 0]],
    );
    assert.equal(readFileSync(join(dir, "b.log"), "utf8").trim(), "b");
    assert.match(summary(results), /every check passed$/);
  }));

test("a failure stops its own lane only, and the next phase still runs", () =>
  withLogs(async (dir) => {
    const results = await runPhases([[[step("a", 2), step("b")], [step("c")]], [[step("d")]]], dir);
    assert.deepEqual(
      results.map((r) => [r.name, r.code]),
      [["a", 2], ["b", null], ["c", 0], ["d", 0]],
    );
    const text = summary(results);
    assert.match(text, /a\s+FAILED \(exit 2\)/);
    assert.match(text, /b\s+skipped/);
    assert.match(text, /2 step\(s\) failed or skipped$/);
  }));

test("lanes of a phase run at the same time", () =>
  withLogs(async (dir) => {
    // Each step leaves its own mark, then waits for the other's: run one after the other, the first would never see
    // the second's mark and give up. The wait only bounds a hang; it measures nothing.
    const meet = (name, other) => ({
      name,
      cmd: process.execPath,
      args: [
        "-e",
        `const fs = require("fs"), path = require("path");
         const dir = ${JSON.stringify(dir)};
         fs.writeFileSync(path.join(dir, ${JSON.stringify(`${name}.mark`)}), "");
         const end = Date.now() + 30000;
         const look = () => fs.existsSync(path.join(dir, ${JSON.stringify(`${other}.mark`)}))
           ? process.exit(0) : Date.now() > end ? process.exit(1) : setTimeout(look, 20);
         look();`,
      ],
    });
    const results = await runPhases([[[meet("a", "b")], [meet("b", "a")]]], dir);
    assert.deepEqual(results.map((r) => r.code), [0, 0]);
  }));

test("a phase waits for every lane of the one before", () =>
  withLogs(async (dir) => {
    // Each step prints the time it ended (`slow`) or started (`after`).
    const clock = (name, ms, when) => ({
      name,
      cmd: process.execPath,
      args: ["-e", when === "end" ? `setTimeout(() => console.log(Date.now()), ${ms})` : "console.log(Date.now())"],
    });
    await runPhases([[[clock("slow", 800, "end")], [clock("fast", 0, "end")]], [[clock("after", 0, "start")]]], dir);
    const at = (name) => Number(readFileSync(join(dir, `${name}.log`), "utf8").trim());
    assert.ok(at("after") >= at("slow"), "the second phase started before the first phase's slow lane ended");
  }));

test("a command that cannot start is a failure, not a crash", () =>
  withLogs(async (dir) => {
    const results = await runPhases([[[{ name: "missing", cmd: "petalock-no-such-command", args: [] }]]], dir);
    assert.equal(results[0].code, 127);
    assert.match(readFileSync(join(dir, "missing.log"), "utf8"), /could not start/);
  }));

// The short check by area. Each step is compared as one command line, so a changed word anywhere shows.
const line = (s) => [s.cmd === process.execPath ? "node" : s.cmd, ...s.args].join(" ");
const phaseLines = (phases, i) => (phases[i] ?? []).flat().map(line);
const firstPhase = [
  "cargo fmt --all --check",
  "cargo clippy --locked --all-targets -- -D warnings",
  "cargo clippy -p petalock-core --locked --all-targets --features test-internals -- -D warnings",
  "cargo test --locked --no-run",
  "npm run lint",
  "npm run build",
  "npm test",
  "node scripts/shipped-page-check.mjs",
  "node --test scripts/*.test.mjs",
  "node scripts/scan.mjs",
];
const fullSecondPhase = [
  "cargo test --locked --no-fail-fast",
  "cargo test -p petalock-core --locked --no-fail-fast --features test-internals --test *",
  "cargo test -p petalock-desktop --locked --features custom-protocol --test ipc",
  "cargo build -p petalock-desktop --release --locked --features custom-protocol",
];
const planFor = (...argv) => {
  const parsed = parseArgs(argv);
  assert.equal(parsed.error, undefined, `refused: ${parsed.error}`);
  return checks(parsed);
};

test("short_check_always_runs_the_whole_first_phase", () => {
  for (const argv of [[], ["--short", "engine"], ["--short", "desktop"], ["--short", "ui"], ["--short", "desktop,ui"],
    ["--short", "engine,ui"], ["--short"], ["--short", "all"]]) {
    assert.deepEqual(phaseLines(planFor(...argv), 0), firstPhase, argv.join(" "));
  }
});

test("short_engine_runs_the_engine_tests_only", () => {
  assert.deepEqual(phaseLines(planFor("--short", "engine"), 1), [
    "cargo test -p petalock-core --locked --no-fail-fast",
    "cargo test -p petalock-core --locked --no-fail-fast --features test-internals --test *",
  ]);
});

test("short_desktop_runs_the_desktop_and_bridge_tests", () => {
  const second = phaseLines(planFor("--short", "desktop"), 1);
  assert.deepEqual(second, [
    "cargo test -p petalock-desktop --locked --no-fail-fast",
    "cargo test -p petalock-desktop --locked --features custom-protocol --test ipc",
  ]);
  assert.ok(!second.some((l) => l.includes("--release")), "the release build runs on GitHub, not in the short check");
});

test("short_desktop_and_ui_or_engine_and_ui_add_nothing_for_the_ui", () => {
  assert.deepEqual(phaseLines(planFor("--short", "desktop,ui"), 1), phaseLines(planFor("--short", "desktop"), 1));
  assert.deepEqual(phaseLines(planFor("--short", "engine,ui"), 1), phaseLines(planFor("--short", "engine"), 1));
});

test("short_ui_runs_no_rust_tests", () => {
  assert.deepEqual(phaseLines(planFor("--short", "ui"), 1), []);
});

test("engine_and_desktop_together_is_the_full_set", () => {
  const full = planFor();
  for (const areas of ["engine,desktop", "engine,desktop,ui", "desktop,engine"]) {
    assert.deepEqual(planFor("--short", areas), full, areas);
  }
});

test("short_with_no_area_or_all_is_the_full_set", () => {
  const full = planFor();
  assert.deepEqual(phaseLines(full, 1), fullSecondPhase);
  assert.deepEqual(planFor("--short"), full);
  assert.deepEqual(planFor("--short", "all"), full);
});

test("the desktop bridge step is CI's bridge step exactly", () => {
  const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  // The step's `run:` is the first one after its name; found nowhere, the comparison would prove nothing.
  const match = ci.match(/- name: Bridge tests \(release configuration\)\n(?:[ \t]+(?!- |run: ).*\n)*?[ \t]+run: (.+)/);
  assert.ok(match, "ci.yml has no 'Bridge tests (release configuration)' step with a run line");
  const bridge = phaseLines(planFor("--short", "desktop"), 1).find((l) => l.includes("custom-protocol"));
  assert.equal(bridge, match[1].trim());
  assert.ok(phaseLines(planFor(), 1).includes(match[1].trim()), "the full set runs the same bridge step");
});

test("short_refuses_no_scan", () => {
  for (const argv of [["--short", "ui", "--no-scan"], ["--no-scan", "--short"]]) {
    const parsed = parseArgs(argv);
    assert.equal(parsed.code, 2, argv.join(" "));
    assert.match(parsed.error, /scan/);
  }
});

test("a refused command line exits 2 with its reason and runs nothing", () => {
  const script = fileURLToPath(new URL("./check.mjs", import.meta.url));
  const run = spawnSync(process.execPath, [script, "--short", "ui", "--no-scan"], { encoding: "utf8" });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /always runs the scan.*nothing ran/);
  // No step's verdict and no summary: the run stopped before the first phase.
  assert.equal(run.stdout, "");
});

test("unknown_area_is_refused", () => {
  for (const argv of [["--short", "docs"], ["--short", "ui,"], ["--short", "UI"], ["ui"], ["--quick"],
    ["--short", "ui", "engine"], ["--short", "--short"]]) {
    const parsed = parseArgs(argv);
    assert.equal(parsed.code, 2, argv.join(" "));
    assert.ok(parsed.error, argv.join(" "));
  }
});

test("the full set without the scan still parses as before", () => {
  const parsed = parseArgs(["--no-scan"]);
  assert.equal(parsed.error, undefined);
  assert.ok(!phaseLines(checks(parsed), 0).includes("node scripts/scan.mjs"));
  assert.deepEqual(phaseLines(checks(parsed), 1), fullSecondPhase);
});
