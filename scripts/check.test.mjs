import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { runPhases, summary } from "./check.mjs";

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
    const results = await runPhases([[[{ name: "missing", cmd: "lockbox-no-such-command", args: [] }]]], dir);
    assert.equal(results[0].code, 127);
    assert.match(readFileSync(join(dir, "missing.log"), "utf8"), /could not start/);
  }));
