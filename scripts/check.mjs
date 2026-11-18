// Runs every check CI runs, side by side where they don't depend on each other, and reports each one.
//
//   node scripts/check.mjs           every check, the security scan included
//   node scripts/check.mjs --no-scan every check but the scan (it needs gitleaks, semgrep and osv-scanner)
//
// Two phases. The first runs three lanes at once: Rust's format and lint checks, then a build of the tests; the UI's
// lint, build and tests; the scripts' tests and the scan. The second runs the Rust tests with the machine otherwise
// idle, because a few of them time how long a lock takes. A lane stops at its first failure; the other lanes go on.
// Each step's output is in target/check-logs/<step>.log, and the exit code is 1 when any step failed.

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

/** The checks CI runs, as phases of lanes. */
function checks({ scan }) {
  const cargo = (name, ...args) => ({ name, cmd: "cargo", args });
  const ui = (name, ...args) => ({ name, cmd: "npm", args, cwd: join(root, "ui"), shell: true });
  // `--no-fail-fast`: one failing test program doesn't hide the others' results.
  const rustTests = [
    cargo("rust-tests", "test", "--locked", "--no-fail-fast"),
    // The engine's internal-only tests, as CI runs them (its unit tests already ran above).
    cargo("engine-internal", "test", "-p", "lockbox-core", "--locked", "--no-fail-fast", "--features",
      "test-internals", "--test", "*"),
    cargo("ipc", "test", "-p", "lockbox-desktop", "--locked", "--features", "custom-protocol", "--test", "ipc"),
    // The app as shipped, the built UI embedded, as CI builds it.
    cargo("release-build", "build", "-p", "lockbox-desktop", "--release", "--locked", "--features", "custom-protocol"),
  ];
  // Node expands the pattern itself, as CI's step does.
  const scanner = [{ name: "script-tests", cmd: process.execPath, args: ["--test", "scripts/*.test.mjs"] }];
  if (scan) scanner.push({ name: "scan", cmd: process.execPath, args: ["scripts/scan.mjs"] });
  return [
    [
      [
        cargo("fmt", "fmt", "--all", "--check"),
        cargo("clippy", "clippy", "--locked", "--all-targets", "--", "-D", "warnings"),
        cargo("clippy-engine", "clippy", "-p", "lockbox-core", "--locked", "--all-targets", "--features",
          "test-internals", "--", "-D", "warnings"),
        // Builds the tests while the other lanes run, so the quiet phase only runs them.
        cargo("build-tests", "test", "--locked", "--no-run"),
      ],
      // The UI's tests read the built page, and the ipc test embeds it: build before both.
      [ui("ui-lint", "run", "lint"), ui("ui-build", "run", "build"), ui("ui-tests", "test")],
      scanner,
    ],
    [rustTests],
  ];
}

async function main() {
  const scan = !process.argv.includes("--no-scan");
  const logDir = join(root, "target", "check-logs");
  const started = Date.now();
  const results = await runPhases(checks({ scan }), logDir);
  console.log(summary(results));
  console.log(`total ${((Date.now() - started) / 1000).toFixed(0)} s; logs in ${logDir}`);
  process.exitCode = results.every((r) => r.code === 0) ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
