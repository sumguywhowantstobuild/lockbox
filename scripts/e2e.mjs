// End-to-end tests on the real app: builds the release app once, then drives it through tauri-driver and Microsoft Edge
// WebDriver with WebdriverIO, on a test state that is swapped in for the run and put back at its end.
//
//   node scripts/e2e.mjs [--edgedriver <full path to msedgedriver.exe>] [spec ...]
//
// `spec` is a name in e2e/specs (`thin-path` for e2e/specs/thin-path.e2e.mjs); none means all of them. The Edge driver is
// the flag, else LOCKBOX_EDGEDRIVER, else (on CI only) the runner image's EDGEWEBDRIVER folder; its major version must
// equal the WebView2 runtime's. tauri-driver is %CARGO_HOME%\bin\tauri-driver.exe (LOCKBOX_TAURI_DRIVER overrides):
// `cargo install tauri-driver --locked --version 2.1.0`. Steps that use the clipboard or this PC's keyboard (the save
// shortcut) run on CI, and on a PC only with LOCKBOX_E2E_PC_FREE=1.
//
// What a run does, in order, stopping at the first refusal: refuses while any `lockbox-desktop.exe` runs; finds the
// drivers and checks their versions; builds the release app (the page, then the app with `custom-protocol`, as the full
// check does); makes a folder of its own in the temp folder (the web-view data, a vault and a files folder per spec,
// logs); swaps a test state in (`e2e/lib/state.mjs`; CI's runner must start with none, so there nothing is set aside);
// runs the app-level tests (`e2e/real-app.test.mjs`) and then each WebdriverIO spec on a fresh test state of its own,
// stopping at the first that fails; and in `finally` stops what it started by process ID, swaps the real state back, keeps
// each test state beside the real folders (named in the output, to delete by hand) and deletes its own folder. A run cut
// short is put right by `node e2e/lib/state.mjs recover`.
// Exit code: 0 all passed, 1 something failed, 2 refused (nothing was started or changed).

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import * as app from "../e2e/lib/app.mjs";
import * as state from "../e2e/lib/state.mjs";
import { checks } from "./check.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const EDGE_CLIENT_KEY = String.raw`HKLM\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}`;
const SPEC_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const USAGE = "usage: node scripts/e2e.mjs [--edgedriver <full path to msedgedriver.exe>] [spec ...]";

/** A reason the run does not start; nothing was changed. */
export class E2eRefused extends Error {}

// ---- the command line ---------------------------------------------------------------------------------------------

/** `{ edgedriver, specs }`, or `{ error }`. */
export function parseArgs(argv) {
  let edgedriver;
  const specs = [];
  for (let at = 0; at < argv.length; at += 1) {
    const arg = argv[at];
    if (arg === "--edgedriver") {
      edgedriver = argv[at + 1];
      if (edgedriver === undefined || edgedriver.startsWith("-")) return { error: "--edgedriver needs the full path to msedgedriver.exe" };
      at += 1;
    } else if (arg.startsWith("-")) {
      return { error: `unknown argument: ${arg}` };
    } else if (SPEC_NAME.test(arg)) {
      specs.push(arg);
    } else {
      return { error: "a spec name is lower-case words joined by - (a file in e2e/specs, without .e2e.mjs)" };
    }
  }
  return { edgedriver, specs };
}

// ---- the drivers --------------------------------------------------------------------------------------------------

/**
 * True only on the GitHub end-to-end job, which sets LOCKBOX_E2E_CI=1 itself. The generic CI=true that developer shells and
 * local tools set grants nothing: this marker is what skips the swap (a fresh runner has no state to protect) and allows
 * the clipboard steps.
 */
export const onCiJob = (env) => env.LOCKBOX_E2E_CI === "1";

/** The Edge driver: the flag, else LOCKBOX_EDGEDRIVER, else (on the CI job) the runner image's folder. */
export function findNativeDriver({ flag, env }) {
  const candidate =
    flag ?? env.LOCKBOX_EDGEDRIVER ?? (onCiJob(env) && env.EDGEWEBDRIVER ? join(env.EDGEWEBDRIVER, "msedgedriver.exe") : undefined);
  if (candidate === undefined || candidate === "") {
    throw new E2eRefused("no Edge WebDriver given: pass --edgedriver <full path to msedgedriver.exe> or set LOCKBOX_EDGEDRIVER");
  }
  if (!isAbsolute(candidate)) throw new E2eRefused("the Edge WebDriver must be given as a full path");
  if (basename(candidate).toLowerCase() !== "msedgedriver.exe") throw new E2eRefused("the Edge WebDriver must be a file named msedgedriver.exe");
  if (!existsSync(candidate) || !statSync(candidate).isFile()) throw new E2eRefused("the Edge WebDriver was not found where it was given");
  return candidate;
}

/** `tauri-driver.exe`: LOCKBOX_TAURI_DRIVER, else cargo's bin folder. */
export function findTauriDriver(env) {
  const cargoHome = env.CARGO_HOME ?? (env.USERPROFILE ? join(env.USERPROFILE, ".cargo") : undefined);
  const candidate = env.LOCKBOX_TAURI_DRIVER ?? (cargoHome ? join(cargoHome, "bin", "tauri-driver.exe") : undefined);
  if (candidate === undefined || !isAbsolute(candidate) || !existsSync(candidate)) {
    throw new E2eRefused("tauri-driver was not found: run `cargo install tauri-driver --locked --version 2.1.0` (or set LOCKBOX_TAURI_DRIVER)");
  }
  return candidate;
}

/** The version in `msedgedriver --version` output, or null. */
export function parseDriverVersion(text) {
  return /WebDriver (\d+\.\d+\.\d+\.\d+)/.exec(text)?.[1] ?? null;
}

/** The version in `reg query ... /v pv` output, or null. */
export function parseRegistryVersion(text) {
  return /\bpv\s+REG_SZ\s+(\d+\.\d+\.\d+\.\d+)/.exec(text)?.[1] ?? null;
}

/**
 * Throws unless the driver and the runtime are known and match in their first three parts (Microsoft's rule: only the last
 * part, the patch, may differ). The same major with another build branch is refused too.
 */
export function checkVersions(driver, runtime) {
  if (!driver) throw new E2eRefused("could not read the version of the Edge WebDriver");
  if (!runtime) throw new E2eRefused("could not read the version of the WebView2 runtime");
  const firstThree = (version) => version.split(".").slice(0, 3).join(".");
  if (firstThree(driver) !== firstThree(runtime)) {
    throw new E2eRefused(
      `the Edge WebDriver ${driver} and the WebView2 runtime ${runtime} do not match in their first three parts; use the driver that matches the runtime`,
    );
  }
}

function readDriverVersion(driver) {
  // nosemgrep: javascript.lang.security.detect-child-process.detect-child-process -- the Edge driver the person gave (checked to be a file named msedgedriver.exe), with a fixed argument
  const result = spawnSync(driver, ["--version"], { encoding: "utf8", windowsHide: true, timeout: 30_000 });
  return result.status === 0 ? parseDriverVersion(result.stdout) : null;
}

/** The WebView2 runtime's version: from the registry, else from the folder name its installer makes. */
export function readRuntimeVersion() {
  // nosemgrep: javascript.lang.security.detect-child-process.detect-child-process -- a fixed program by its full path and fixed arguments
  const result = spawnSync(state.systemTool("reg.exe"), ["query", EDGE_CLIENT_KEY, "/v", "pv"], { encoding: "utf8", windowsHide: true });
  const fromRegistry = result.status === 0 ? parseRegistryVersion(result.stdout) : null;
  if (fromRegistry) return fromRegistry;
  const base = join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Microsoft", "EdgeWebView", "Application");
  try {
    return readdirSync(base).filter((name) => /^\d+\.\d+\.\d+\.\d+$/.test(name)).sort().pop() ?? null;
  } catch {
    return null;
  }
}

function defaultCheckTools({ flag, env }) {
  const nativeDriver = findNativeDriver({ flag, env });
  const tauriDriver = findTauriDriver(env);
  const driverVersion = readDriverVersion(nativeDriver);
  const runtimeVersion = readRuntimeVersion();
  checkVersions(driverVersion, runtimeVersion);
  return { nativeDriver, tauriDriver, driverVersion, runtimeVersion };
}

// ---- building -----------------------------------------------------------------------------------------------------

/** The two builds, as the full check makes them: the page, then the app that embeds it (`custom-protocol`, as shipped). */
export function buildCommands() {
  const all = checks({ scan: false, areas: null }).flat(2);
  const pick = (name) => {
    const step = all.find((candidate) => candidate.name === name);
    if (!step) throw new Error(`scripts/check.mjs has no step ${name}`);
    return step;
  };
  return [pick("ui-build"), pick("release-build")];
}

/** Runs one build step with its output in `logFile`; resolves with its exit code (127 when it could not start). */
export function runLogged(step, logFile) {
  mkdirSync(dirname(logFile), { recursive: true });
  const fd = openSync(logFile, "w");
  return new Promise((resolve) => {
    const [cmd, args] = step.shell ? [[step.cmd, ...step.args].join(" "), []] : [step.cmd, step.args];
    // nosemgrep: javascript.lang.security.detect-child-process.detect-child-process -- every command and argument is a fixed string in scripts/check.mjs
    const child = spawn(cmd, args, { cwd: step.cwd ?? root, stdio: ["ignore", fd, fd], shell: step.shell ?? false, windowsHide: true });
    // `error` and `close` can both come for one program that did not start: the first settles it, once
    let settled = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      closeSync(fd);
      resolve(code);
    };
    child.once("error", () => finish(127));
    child.once("close", (code) => finish(code ?? 1));
  });
}

async function defaultBuild({ say }) {
  const logDir = join(root, "target", "e2e-logs");
  for (const step of buildCommands()) {
    say(`building: ${step.name} (log: ${join(logDir, `${step.name}.log`)})`);
    const code = await runLogged(step, join(logDir, `${step.name}.log`));
    if (code !== 0) throw new Error(`${step.name} failed (exit ${String(code)}); see its log`);
  }
}

// ---- the suites ---------------------------------------------------------------------------------------------------

function readTap(file) {
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const count = (name) => Number(new RegExp(`^# ${name} (\\d+)`, "m").exec(text)?.[1] ?? Number.NaN);
  return { pass: count("pass"), fail: count("fail"), skipped: count("skipped") };
}

function runNode(args, { cwd, env }) {
  return new Promise((resolve) => {
    // nosemgrep: javascript.lang.security.detect-child-process.detect-child-process -- this Node and scripts of this repository
    const child = spawn(process.execPath, args, { cwd, env, stdio: "inherit", windowsHide: true });
    child.once("error", () => resolve(127));
    child.once("close", (code) => resolve(code ?? 1));
  });
}

/** What the suites are told, in the environment of the processes they run in. */
function sharedEnvironment(ctx) {
  const exe = join(root, "target", "release", "lockbox-desktop.exe");
  if (!existsSync(exe)) throw new Error("the release build is missing");
  return {
    ...ctx.env,
    LOCKBOX_E2E_APP: exe,
    LOCKBOX_E2E_TAURI_DRIVER: ctx.tools.tauriDriver,
    LOCKBOX_E2E_NATIVE_DRIVER: ctx.tools.nativeDriver,
    LOCKBOX_E2E_RUN_ROOT: ctx.runRoot,
    LOCKBOX_E2E_DEFAULT_VAULTS: ctx.locations.vaults,
    // on a PC the app's window is kept off the screen; on CI nobody is looking
    LOCKBOX_E2E_OFFSCREEN: ctx.ci ? "0" : "1",
  };
}

/** The app-level tests, then the WebdriverIO specs. Returns 0 when every test passed and none was skipped by mistake. */
async function defaultSuites(ctx) {
  const first = await runAppTests(ctx);
  return first === 0 ? runSpecs(ctx) : first;
}

/** `e2e/real-app.test.mjs` on the built app; 0 when every one of them passed and none was skipped. */
export async function runAppTests(ctx) {
  const { say, tools } = ctx;
  const shared = sharedEnvironment(ctx);
  say(`the Edge WebDriver ${tools.driverVersion} matches the WebView2 runtime ${tools.runtimeVersion}`);
  const tap = join(ctx.logDir, "real-app.tap");
  const first = await runNode(
    ["--test", "--test-reporter=spec", "--test-reporter-destination=stdout", "--test-reporter=tap", `--test-reporter-destination=${tap}`, join(root, "e2e", "real-app.test.mjs")],
    { cwd: root, env: { ...shared, LOCKBOX_E2E_REAL: "1" } },
  );
  const counted = readTap(tap);
  if (first !== 0 || counted === null || counted.fail !== 0 || counted.skipped !== 0 || !(counted.pass >= 3)) {
    say(`the app-level tests did not all pass (exit ${String(first)}; ${counted ? `${String(counted.pass)} passed, ${String(counted.fail)} failed, ${String(counted.skipped)} skipped` : "no result"})`);
    return 1;
  }
  say(`the app-level tests passed (${String(counted.pass)})`);
  return 0;
}

/**
 * What the specs wrote (`pass <step>`, `fail <step>`, `skip <step: reason>`, one per line) and WebdriverIO's exit code,
 * judged: a run that passed nothing, failed a step or exited non-zero is not a pass, and on the CI job a skipped step fails
 * the run (the job has no PC to share, so nothing may be left unobserved). Elsewhere a skip is said, not failed.
 */
export function judgeSpecResults(lines, { ci, code }) {
  const passed = lines.filter((line) => line.startsWith("pass ")).length;
  const failed = lines.filter((line) => line.startsWith("fail ")).length;
  const skipped = lines.filter((line) => line.startsWith("skip ")).map((line) => line.slice(5));
  const reasons = [];
  if (code !== 0) reasons.push(`exit ${String(code)}`);
  if (passed === 0) reasons.push("nothing passed");
  if (ci && skipped.length > 0) reasons.push(`${String(skipped.length)} step(s) skipped on CI: ${skipped.join(" | ")}`);
  return { passed, failed, skipped, reasons, ok: code === 0 && failed === 0 && passed > 0 && !(ci && skipped.length > 0) };
}

/** The design's end-to-end paths: a run with no spec named runs them all, and refuses when one of them is missing. */
export const REQUIRED_SPECS = ["back-up-then-restore", "save-copied-key", "sign-in", "thin-path"];

/**
 * The specs a run runs: the ones named, else every `*.e2e.mjs` in e2e/specs, by name. Throws for a name with no file, for
 * a run with none, and, when none is named, for a required path whose spec is missing (a renamed or deleted file would
 * otherwise drop that path and still pass).
 */
export function specNames(named, dir = join(root, "e2e", "specs"), required = REQUIRED_SPECS) {
  const names = named.length > 0 ? named : readdirSync(dir).filter((file) => file.endsWith(".e2e.mjs")).map((file) => file.slice(0, -".e2e.mjs".length)).sort();
  for (const name of names) if (!existsSync(join(dir, `${name}.e2e.mjs`))) throw new Error(`no such spec: ${name}.e2e.mjs`);
  if (named.length === 0) for (const name of required) if (!names.includes(name)) throw new Error(`a required spec is missing: ${name}.e2e.mjs`);
  if (names.length === 0) throw new Error("no spec to run");
  return names;
}

/** Waits up to `seconds` for every `lockbox-desktop.exe` to be gone (a stopped app takes a moment); true once none runs. */
async function lockboxGone(seconds) {
  const until = Date.now() + seconds * 1000;
  for (;;) {
    if (state.isLockboxRunning() === false) return true;
    if (Date.now() > until) return false;
    await new Promise((done) => setTimeout(done, 250));
  }
}

/**
 * The WebdriverIO specs, one at a time, each on a fresh test state (`ctx.freshState`) with its own vault folder and files
 * folder, against a driver started and stopped for it. A spec that fails does not stop the rest, so each push records every
 * path's result; a fresh state that can't be made, or a stop that leaves a process or the machine policy behind, stops the
 * run there, since what comes after could no longer be trusted. 0 when every spec passed.
 */
export async function runSpecs(ctx) {
  const { say, env, tools, locations } = ctx;
  const shared = sharedEnvironment(ctx);
  const wdio = join(root, "e2e", "node_modules", "@wdio", "cli", "bin", "wdio.js");
  if (!existsSync(wdio)) throw new Error("WebdriverIO is not installed: run `npm ci --ignore-scripts` in e2e/");
  const names = specNames(ctx.specs);
  let passed = 0;
  const failed = [];
  let leftBehind = false;
  for (const [at, name] of names.entries()) {
    if (leftBehind) {
      say(`the spec ${name} did not run: the last spec's stop left something behind`);
      failed.push(name);
      continue;
    }
    const label = `s${String(at + 1)}`;
    // the app of the suite before must be gone before its state is put back
    if (!(await lockboxGone(15))) throw new Error("Lockbox was still running after the last spec");
    await ctx.freshState(label);
    const vaultFolder = join(ctx.runRoot, `vaults-${label}`);
    const filesFolder = join(ctx.runRoot, `files-${label}`);
    mkdirSync(vaultFolder);
    mkdirSync(filesFolder);
    const handle = await app.startLockbox({
      tauriDriver: tools.tauriDriver,
      nativeDriver: tools.nativeDriver,
      tempDir: join(ctx.runRoot, `driver-temp-${label}`),
      webviewDir: join(ctx.runRoot, `driver-webview-${label}`),
      logFile: join(ctx.logDir, `tauri-driver-${label}.log`),
      base: env,
    });
    try {
      const results = join(ctx.logDir, `specs-${label}.txt`);
      const code = await runNode([wdio, "run", "wdio.conf.mjs", "--spec", join(root, "e2e", "specs", `${name}.e2e.mjs`)], {
        cwd: join(root, "e2e"),
        env: {
          ...shared,
          LOCKBOX_E2E_DRIVER_PORT: String(handle.port),
          LOCKBOX_E2E_DRIVER_PID: String(handle.pid),
          LOCKBOX_E2E_DRIVER_CREATED: handle.created,
          LOCKBOX_E2E_VAULT_FOLDER: vaultFolder,
          LOCKBOX_E2E_FILES_FOLDER: filesFolder,
          LOCKBOX_E2E_RESULTS: results,
          LOCKBOX_E2E_LOCATIONS: JSON.stringify(locations),
        },
      });
      const lines = existsSync(results) ? readFileSync(results, "utf8").split(/\r?\n/).filter(Boolean) : [];
      const verdict = judgeSpecResults(lines, { ci: ctx.ci, code });
      for (const line of verdict.skipped) say(`skipped (${name}): ${line}`);
      if (verdict.ok) {
        say(`the spec ${name} passed (${String(verdict.passed)} steps)`);
        passed += verdict.passed;
      } else {
        say(`the spec ${name} did not pass (exit ${String(code)}; ${String(verdict.passed)} passed, ${String(verdict.failed)} failed${verdict.reasons.length ? `; ${verdict.reasons.join("; ")}` : ""})`);
        failed.push(name);
      }
    } finally {
      const outcome = app.stopLockbox(handle);
      if (outcome.remaining.length > 0) {
        say(`could not stop every process this run started, or remove the policy it set (${outcome.remaining.length} left)`);
        leftBehind = true;
        if (!failed.includes(name)) failed.push(name);
      }
    }
  }
  if (failed.length > 0) {
    say(`the specs did not all pass (${String(names.length - failed.length)} of ${String(names.length)}; not passed: ${failed.join(", ")})`);
    return 1;
  }
  say(`the specs passed (${String(names.length)} specs, ${String(passed)} steps)`);
  return 0;
}

// ---- the run ------------------------------------------------------------------------------------------------------

/**
 * Copies a run's logs out of its own folder into `dest` before the folder is removed: the files of `logs/` and each test's
 * `driver.log` (as `<test>-driver.log`). Nothing else: the web-view data and the vault folder stay behind. Returns the
 * line to say.
 */
export function keepRunLogs(runRoot, dest) {
  mkdirSync(dest, { recursive: true });
  const kept = [];
  const logs = join(runRoot, "logs");
  for (const entry of existsSync(logs) ? readdirSync(logs, { withFileTypes: true }) : []) {
    if (!entry.isFile()) continue;
    copyFileSync(join(logs, entry.name), join(dest, entry.name));
    kept.push(entry.name);
  }
  for (const entry of readdirSync(runRoot, { withFileTypes: true })) {
    const driverLog = join(runRoot, entry.name, "driver.log");
    if (!entry.isDirectory() || entry.name === "logs" || !existsSync(driverLog)) continue;
    copyFileSync(driverLog, join(dest, `${entry.name}-driver.log`));
    kept.push(`${entry.name}-driver.log`);
  }
  return [kept.length > 0 ? `e2e: the run's logs are kept in ${dest} (${kept.join(", ")})` : "e2e: the run left no logs to keep"];
}

/**
 * One run. `steps` and `stateOptions` are replaced only in tests. Returns `{ code, lines }`: 0 passed, 1 failed, 2 refused
 * before anything was started or changed.
 */
export async function runE2e({ env = process.env, specs = [], edgedriver, stateOptions = {}, steps = {}, log = console.log } = {}) {
  const lines = [];
  const say = (line) => {
    lines.push(line);
    log(line);
  };
  const refused = (message) => {
    say(`e2e: ${message}; nothing was started or changed`);
    return { code: 2, lines };
  };
  const ci = onCiJob(env);

  let running;
  try {
    running = (steps.isRunning ?? state.isLockboxRunning)();
  } catch {
    return refused("could not check whether Lockbox is running");
  }
  if (running !== false) return refused("Lockbox is running; close it first (a launch would hand over to it)");

  let tools;
  try {
    tools = (steps.checkTools ?? (() => defaultCheckTools({ flag: edgedriver, env })))();
  } catch (error) {
    if (error instanceof E2eRefused) return refused(error.message);
    throw error;
  }

  let locations;
  try {
    locations = stateOptions.locations ?? state.defaultLocations();
  } catch (error) {
    if (error instanceof state.SwapRefused) return refused(error.message);
    throw error;
  }
  if (ci) {
    for (const key of state.LOCATION_KEYS) {
      if (existsSync(locations[key])) return refused(`on CI the state folders must be fresh, but the ${key} folder is already there`);
    }
  }

  try {
    await (steps.build ?? defaultBuild)({ say });
  } catch (error) {
    say(`e2e: the build failed: ${error.message}`);
    return { code: 1, lines };
  }

  const runName = `e2e-${Date.now().toString(36)}-${randomBytes(2).toString("hex")}`;
  const runRoot = mkdtempSync(join(tmpdir(), "lockbox-e2e-"));
  const context = {
    runName,
    runRoot,
    tempDir: join(runRoot, "temp"),
    webviewDir: join(runRoot, "webview"),
    logDir: join(runRoot, "logs"),
    locations,
    tools,
    specs,
    env,
    ci,
    say,
  };
  for (const dir of [context.tempDir, context.webviewDir, context.logDir]) mkdirSync(dir);

  let code = 1;
  // The test state in place: `name` is its swap's run name (this run's, or this run's with a suite's label), and `phase` is
  // "starting" while swapIn runs (it may stop part-way, with its journal kept), "in" once it has finished. CI's runner is
  // swapped like a PC: there the real folders are missing, so nothing is set aside and each swap starts the app fresh.
  const swap = { phase: "none", name: runName };
  const swapIn = (name) => {
    swap.name = name;
    swap.phase = "starting";
    for (const line of state.swapIn(name, stateOptions).lines) say(`swap: ${line}`);
    swap.phase = "in";
  };
  // Puts the real state back from the swap in place; throws when it is not back. What is undone depends on whose swap it
  // is. A swap that stopped part-way is put right by recover, but only when the journal names this swap: a run refused
  // because another run owns the journal must leave that run's swap alone.
  const putBack = () => {
    let undo = swap.phase === "in" ? "back" : "none";
    if (swap.phase === "starting") {
      let owner = null;
      let inProgress = false;
      try {
        ({ inProgress, run: owner } = state.status(stateOptions));
      } catch {
        // the journal can't be read: nothing is touched
      }
      if (inProgress && owner === swap.name) undo = "recover";
      else if (inProgress) say(`e2e: a swap of another run (${owner ?? "unreadable"}) is in progress; left alone`);
    }
    if (undo === "none") {
      swap.phase = "none";
      return;
    }
    const done = undo === "back" ? state.swapBack(swap.name, stateOptions) : state.recover(stateOptions);
    for (const line of done.lines) say(`swap: ${line}`);
    // Nothing the swap parked is deleted: what was written into the substituted folders (by the app, or by a person who
    // opened Lockbox meanwhile) stays where swap back put it. The run names them in one line.
    const kept = state.LOCATION_KEYS.map((key) => `${locations[key]}.test-${swap.name}`).filter((folder) => existsSync(folder));
    if (kept.length > 0) say(`swap: the test state of this run is kept, not deleted, beside the real folders; delete it by hand when you are done: ${kept.join("; ")}`);
    if (state.status(stateOptions).inProgress) throw new Error("a swap is still in progress");
    swap.phase = "none";
  };
  // A suite that needs the app as on a new PC asks for it: the test state in place is put back and kept, and a new, empty one
  // (this run's name and `label`) is swapped in. A failure to put back stops the run before anything else is swapped. A real
  // folder that was just put back can be held for a moment by Windows (the search indexer or a virus scan of the renamed
  // folder), so a rename the system refused as busy is put right by recover and tried again, up to three times in all.
  context.freshState = async (label) => {
    if (typeof label !== "string" || !/^[a-z0-9]{1,8}$/.test(label)) throw new Error("a fresh state's label is 1 to 8 of a-z and 0-9");
    putBack();
    for (let attempt = 1; ; attempt += 1) {
      try {
        swapIn(`${runName}-${label}`);
        return;
      } catch (error) {
        const busy = error instanceof Error && ["EPERM", "EBUSY", "EACCES"].includes(error.code);
        if (!busy || attempt >= 3) throw error;
        say(`swap: a folder was busy (${error.code}); putting everything back and trying again`);
        putBack();
        await new Promise((done) => setTimeout(done, 2000 * attempt));
      }
    }
  };
  try {
    swapIn(runName);
    code = await (steps.suites ?? defaultSuites)(context);
  } catch (error) {
    say(`e2e: ${error instanceof state.SwapRefused ? error.message : `the run failed: ${error.message}`}`);
    // refused (2) only when this run's first swap was: nothing had been started or changed
    code = error instanceof state.SwapRefused && swap.phase === "starting" && swap.name === runName ? 2 : 1;
  } finally {
    try {
      putBack();
    } catch (error) {
      say(`e2e: the real state could not be put back (${error.message}); run: node e2e/lib/state.mjs recover`);
      code = 1;
    }
    // On the CI job, a run that did not pass keeps its logs (never the web-view data) in target/e2e-logs/run, which the
    // job uploads: the run's own folder is about to go, and with it the only record of why.
    if (ci && code !== 0) {
      try {
        for (const line of keepRunLogs(runRoot, join(root, "target", "e2e-logs", "run"))) say(line);
      } catch (error) {
        say(`e2e: the run's logs could not be kept (${error.message})`);
      }
    }
    try {
      rmSync(runRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      say("e2e: the run's own temporary folder could not be removed");
    }
  }
  return { code, lines };
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.error) {
    console.error(`e2e: ${parsed.error}\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  const result = await runE2e({ specs: parsed.specs, edgedriver: parsed.edgedriver });
  process.exitCode = result.code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
