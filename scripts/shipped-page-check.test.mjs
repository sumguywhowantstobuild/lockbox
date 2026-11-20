import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { buildPage, buildToolProblems, canBuild } from "./shipped-page-check.mjs";

/** A chunk as Vite's build returns it: its file name and the modules it holds. */
const chunk = (fileName, ...moduleIds) => ({ type: "chunk", fileName, moduleIds });

const OWN = "C:/lockbox/ui/src/main.tsx";

test("shipped_page_holds_no_build_tool_code: a page of our own code and React passes", () => {
  const output = [
    chunk("assets/index-a1.js", OWN, "C:/lockbox/ui/node_modules/react/index.js"),
    { type: "asset", fileName: "assets/index-b2.css" },
  ];
  assert.deepEqual(buildToolProblems(output), []);
});

test("shipped_page_holds_no_build_tool_code: a module from picomatch, minimatch or tinyglobby fails", () => {
  const output = [
    chunk("assets/index-a1.js", OWN, "/repo/ui/node_modules/picomatch/lib/picomatch.js"),
    chunk("assets/vendor-c3.js", "C:\\lockbox\\ui\\node_modules\\minimatch\\dist\\esm\\index.js"),
    chunk("assets/glob-d4.js", "/repo/ui/node_modules/.pnpm/tinyglobby@0.2.17/node_modules/tinyglobby/dist/x.mjs"),
  ];
  const problems = buildToolProblems(output);
  assert.equal(problems.length, 3);
  assert.match(problems[0], /assets\/index-a1\.js holds picomatch/);
  assert.match(problems[1], /assets\/vendor-c3\.js holds minimatch/);
  assert.match(problems[2], /assets\/glob-d4\.js holds tinyglobby/);
});

test("shipped_page_holds_no_build_tool_code: a look-alike name is not one of them", () => {
  const output = [chunk("assets/index-a1.js", "/repo/ui/node_modules/picomatch-lite/index.js", "/repo/ui/src/minimatch.ts")];
  assert.deepEqual(buildToolProblems(output), []);
});

test("shipped_page_holds_no_build_tool_code: a build with nothing to check fails", () => {
  assert.match(buildToolProblems([{ type: "asset", fileName: "assets/index-b2.css" }]).join("\n"), /no chunk/);
  assert.match(buildToolProblems([]).join("\n"), /no chunk/);
  assert.match(buildToolProblems([chunk("assets/index-a1.js")]).join("\n"), /no chunk holds a module of our own/);
  const packagesOnly = [chunk("assets/index-a1.js", "/repo/ui/node_modules/react/index.js", "\0vite/preload-helper")];
  assert.match(buildToolProblems(packagesOnly).join("\n"), /no chunk holds a module of our own/);
});

// The real build. Skipped where the UI's packages aren't installed (CI's scan job); CI's UI job runs this
// file once the page is built, and scripts/check.mjs runs it with the UI installed.
const real = { skip: canBuild() ? false : "ui/node_modules is not installed", timeout: 180_000 };

test("shipped_page_holds_no_build_tool_code: the real page, run as a command, is clean", real, () => {
  const script = fileURLToPath(new URL("./shipped-page-check.mjs", import.meta.url));
  const run = spawnSync(process.execPath, [script], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const modules = Number(/shipped page clean: \d+ chunk\(s\), (\d+) module\(s\)/.exec(run.stdout)?.[1] ?? 0);
  assert.ok(modules > 0, `no module count in: ${run.stdout}`);
});

test("shipped_page_holds_no_build_tool_code: the real page with picomatch slipped in fails", real, async () => {
  const slipIn = {
    name: "slip-in-picomatch",
    transform(code, id) {
      if (id.replaceAll("\\", "/").endsWith("/src/main.tsx")) {
        return `${code}\nimport picomatch from "picomatch";\nconsole.log(picomatch("*.x")("a.x"));\n`;
      }
    },
  };
  const problems = buildToolProblems(await buildPage([slipIn]));
  assert.ok(problems.some((p) => /holds picomatch/.test(p)), problems.join("\n"));
});
