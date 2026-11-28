// Runs every check CI runs, side by side where they don't depend on each other, and reports each one.
//
//   node scripts/check.mjs           every check, the security scan included
//   node scripts/check.mjs --no-scan every check but the scan (it needs gitleaks, semgrep and osv-scanner)
//   node scripts/check.mjs --short <areas>
//                                    the whole first phase, then only the Rust tests of the areas named: `engine`,
//                                    `desktop`, `ui`, or two of them joined by a comma (`desktop,ui`, `engine,ui`).
//                                    `engine` and `desktop` together, `all`, or `--short` alone run every check. The
//                                    scan always runs here; the release build and the other tests run in CI.
//
// Two phases. The first runs three lanes at once: Rust's format and lint checks, then a build of the tests; the UI's
// lint, build and tests; the scripts' tests and the scan. The second runs the Rust tests with the machine otherwise
// idle, because a few of them time how long a lock takes. A lane stops at its first failure; the other lanes go on.
// Each step's output is in target/check-logs/<step>.log, and the exit code is 1 when any step failed (2 when the
// arguments were refused, with nothing run).

import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

/** Runs one step, its output to `<logDir>/<name>.log`: its exit code and how long it took, in seconds. */
function runStep(step, logDir) {
  return new Promise((resolve) => {
    const started = Date.now();
    const log = createWriteStream(join(logDir, `${step.name}.log`));
    // npm is a .cmd file on Windows, which only starts through the shell: such a step goes as one command line, every
    // word of it fixed in this file.
    const [cmd, args] = step.shell ? [[step.cmd, ...step.args].join(" "), []] : [step.cmd, step.args];
    const options = { cwd: step.cwd ?? root, stdio: ["ignore", "pipe", "pipe"], shell: step.shell ?? false };
    // nosemgrep: javascript.lang.security.detect-child-process.detect-child-process -- every command and argument is a fixed string in checks() below, or a test's own
    const child = spawn(cmd, args, options);
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    // `error` and `close` can both come for one step: the first decides. The log is flushed before the step counts as done.
    let done = false;
    const finish = (code) => {
      if (done) return;
      done = true;
      const seconds = (Date.now() - started) / 1000;
      log.end(() => resolve({ name: step.name, code, seconds }));
    };
    child.on("error", (error) => {
      log.write(`could not start: ${error.message}\n`);
      finish(127);
    });
    child.on("close", (code) => finish(code ?? 1));
  });
}

/** Runs a lane's steps in turn, stopping at the first failure: the steps after it are reported as skipped. */
async function runLane(lane, logDir) {
  const results = [];
  for (const step of lane) {
    if (results.some((r) => r.code !== 0)) {
      results.push({ name: step.name, code: null, seconds: 0 });
      continue;
    }
    results.push(await runStep(step, logDir));
  }
  return results;
}

/**
 * Runs each phase in turn, and each phase's lanes at once. Every phase runs, whatever came before: a failure in one
 * lane says nothing about another. Returns every step's result, in the order the steps were listed.
 */
export async function runPhases(phases, logDir) {
  mkdirSync(logDir, { recursive: true });
  const results = [];
  for (const lanes of phases) {
    for (const lane of await Promise.all(lanes.map((lane) => runLane(lane, logDir)))) results.push(...lane);
  }
  return results;
}

/** One line per step and a last line with the verdict. */
export function summary(results) {
  const lines = results.map((r) => {
    const verdict = r.code === null ? "skipped" : r.code === 0 ? "ok" : `FAILED (exit ${r.code})`;
    return `${r.name.padEnd(16)} ${verdict.padEnd(18)} ${r.code === null ? "" : `${r.seconds.toFixed(0)} s`}`.trimEnd();
  });
  const failed = results.filter((r) => r.code !== 0);
  lines.push(failed.length === 0 ? "every check passed" : `${failed.length} step(s) failed or skipped`);
  return lines.join("\n");
}

const AREAS = ["engine", "desktop", "ui"];

/**
 * Reads the command line: `{ scan, areas }`, where `areas` is null for every check or the set of areas whose Rust tests
 * run; or `{ error, code: 2 }` when the arguments are refused, so nothing runs on a guess.
 */
export function parseArgs(argv) {
  const refuse = (error) => ({ error, code: 2 });
  let scan = true;
  let short = false;
  let list;
  for (const arg of argv) {
    if (arg === "--no-scan") scan = false;
    else if (arg === "--short" && !short) short = true;
    else if (short && list === undefined && !arg.startsWith("-")) list = arg;
    else return refuse(`unknown argument: ${arg}`);
  }
  if (!short) return { scan, areas: null };
  if (!scan) return refuse("the short check always runs the scan; --no-scan goes only with every check");
  if (list === undefined || list === "all") return { scan, areas: null };
  const areas = new Set(list.split(","));
  const unknown = [...areas].filter((a) => !AREAS.includes(a));
  if (unknown.length > 0) return refuse(`unknown area: ${unknown.map((a) => JSON.stringify(a)).join(", ")}; ` +
    `use ${AREAS.join(", ")} or all`);
  // The engine's tests and the desktop's together are most of the full set, and a change touching both is no time to
  // leave anything out.
  if (areas.has("engine") && areas.has("desktop")) return { scan, areas: null };
  return { scan, areas };
}

/** The checks CI runs, as phases of lanes: every check, or with `areas`, the first phase and those areas' tests. */
export function checks({ scan, areas = null }) {
  const cargo = (name, ...args) => ({ name, cmd: "cargo", args });
  const ui = (name, ...args) => ({ name, cmd: "npm", args, cwd: join(root, "ui"), shell: true });
  // `--no-fail-fast`: one failing test program doesn't hide the others' results.
  // The engine's internal-only tests, as CI runs them (its unit tests run in `rust-tests` or `engine-tests`).
  const engineInternal = cargo("engine-internal", "test", "-p", "petalock-core", "--locked", "--no-fail-fast",
    "--features", "test-internals", "--test", "*");
  // CI's "Bridge tests (release configuration)": the checks only the shipped configuration compiles.
  const ipc = cargo("ipc", "test", "-p", "petalock-desktop", "--locked", "--features", "custom-protocol", "--test",
    "ipc");
  const rustTests = areas === null
    ? [
      cargo("rust-tests", "test", "--locked", "--no-fail-fast"),
      engineInternal,
      ipc,
      // The app as shipped, the built UI embedded, as CI builds it.
      cargo("release-build", "build", "-p", "petalock-desktop", "--release", "--locked", "--features",
        "custom-protocol"),
    ]
    : [
      ...(areas.has("engine")
        ? [cargo("engine-tests", "test", "-p", "petalock-core", "--locked", "--no-fail-fast"), engineInternal]
        : []),
      ...(areas.has("desktop")
        ? [cargo("desktop-tests", "test", "-p", "petalock-desktop", "--locked", "--no-fail-fast"), ipc]
        : []),
    ];
  // Node expands the pattern itself, as CI's step does.
  const scanner = [{ name: "script-tests", cmd: process.execPath, args: ["--test", "scripts/*.test.mjs"] }];
  if (scan) scanner.push({ name: "scan", cmd: process.execPath, args: ["scripts/scan.mjs"] });
  return [
    [
      [
        cargo("fmt", "fmt", "--all", "--check"),
        cargo("clippy", "clippy", "--locked", "--all-targets", "--", "-D", "warnings"),
        cargo("clippy-engine", "clippy", "-p", "petalock-core", "--locked", "--all-targets", "--features",
          "test-internals", "--", "-D", "warnings"),
        // Builds the tests while the other lanes run, so the quiet phase only runs them.
        cargo("build-tests", "test", "--locked", "--no-run"),
      ],
      // The UI's tests read the built page, and the ipc test embeds it: build before both. The shipped-page check
      // builds its own copy in memory, so it runs with or without the scan.
      [
        ui("ui-lint", "run", "lint"),
        ui("ui-build", "run", "build"),
        ui("ui-tests", "test"),
        { name: "shipped-page", cmd: process.execPath, args: ["scripts/shipped-page-check.mjs"] },
      ],
      scanner,
    ],
    ...(rustTests.length > 0 ? [[rustTests]] : []),
  ];
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.error) {
    console.error(`check: ${parsed.error}; nothing ran`);
    process.exitCode = parsed.code;
    return;
  }
  const logDir = join(root, "target", "check-logs");
  const started = Date.now();
  const results = await runPhases(checks(parsed), logDir);
  console.log(summary(results));
  if (parsed.areas !== null) {
    console.log(`short check (${[...parsed.areas].join(",")}): the release build and the other areas' tests run in CI`);
  }
  console.log(`total ${((Date.now() - started) / 1000).toFixed(0)} s; logs in ${logDir}`);
  process.exitCode = results.every((r) => r.code === 0) ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
