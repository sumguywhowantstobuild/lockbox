// Starting and stopping the app under test, and proving that what is driven is what this run started.
//
// How the real app is driven (read from tauri-driver 2.1.0, tauri-runtime-wry 2.12.3 and observed, Windows):
//   - the binary is the release build with `custom-protocol`, as shipped, started by Microsoft Edge WebDriver
//     (msedgedriver) on behalf of `tauri-driver`, which this run starts (`startLockbox`) with its own ports;
//   - msedgedriver starts the app with WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS holding `--remote-debugging-port=0` and
//     WEBVIEW2_USER_DATA_FOLDER set to a temporary folder of its own (inside TEMP, which this run points at a folder it
//     made), and tauri-driver adds TAURI_AUTOMATION and TAURI_WEBVIEW_AUTOMATION. All of that is on the app's process
//     alone: nothing is set for the machine, and the app started any other way has none of it;
//   - except on the GitHub job, which runs elevated: WebView2 (Runtime 150 on) ignores WEBVIEW2_* settings in an
//     elevated app, so there `startLockbox` sets the debugging switch as WebView2's machine policy for lockbox-desktop.exe
//     and `stopLockbox` removes it. An elevated msedgedriver also keeps its folder in Windows' SystemTemp, whatever TEMP
//     says. An elevated run anywhere else is refused, so a PC's policy is never touched;
//   - the debugging port is opened by the app's own web-view process, on 127.0.0.1, only in that driven launch.
// The processes of a run are found and stopped by process ID (a creation time guards against a reused ID), never by
// image name: other programs run web views too.

import { spawn, spawnSync } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { systemTool } from "./state.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- processes ----------------------------------------------------------------------------------------------------

/** Reads `pid,ppid,created,name` lines (one process each) into entries. `created` is Windows' file time, as text. */
export function parseProcessList(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^(\d+),(\d+),(\d+),(.+)$/.exec(line);
    if (match) out.push({ pid: Number(match[1]), ppid: Number(match[2]), created: match[3], name: match[4] });
  }
  return out;
}

/** Every running process: `{ pid, ppid, created, name }`. Throws when Windows can't be asked or answers nothing. */
export function snapshotProcesses() {
  const script =
    "Get-CimInstance Win32_Process | Where-Object { $_.CreationDate } | ForEach-Object { '{0},{1},{2},{3}' -f $_.ProcessId, $_.ParentProcessId, $_.CreationDate.ToFileTimeUtc(), $_.Name }";
  // nosemgrep: javascript.lang.security.detect-child-process.detect-child-process -- a fixed program by its full path and a fixed script
  const result = spawnSync(systemTool(join("WindowsPowerShell", "v1.0", "powershell.exe")), ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  const found = result.status === 0 ? parseProcessList(result.stdout) : [];
  if (found.length === 0) throw new Error("could not ask Windows which processes are running");
  return found;
}

/**
 * The processes of `roots` (`{ pid, created }`) and everything below them, deepest first. A root counts only while a
 * process with that ID and creation time runs (an ID reused by another program is not ours), and a child counts only
 * when it was created after its parent (a parent ID that was reused does not make a child ours).
 */
export function treeOf(roots, snapshot) {
  const byPid = new Map(snapshot.map((entry) => [entry.pid, entry]));
  const depth = new Map();
  for (const root of roots) {
    const found = byPid.get(root.pid);
    if (found !== undefined && found.created === String(root.created)) depth.set(found.pid, 0);
  }
  for (let changed = true; changed; ) {
    changed = false;
    for (const entry of snapshot) {
      const parent = byPid.get(entry.ppid);
      if (depth.has(entry.pid) || parent === undefined || !depth.has(parent.pid)) continue;
      if (BigInt(entry.created) < BigInt(parent.created)) continue;
      depth.set(entry.pid, depth.get(parent.pid) + 1);
      changed = true;
    }
  }
  return snapshot.filter((entry) => depth.has(entry.pid)).sort((a, b) => depth.get(b.pid) - depth.get(a.pid));
}

/** The command line of each process in `pids`, as a Map from process ID. */
export function commandLines(pids) {
  const ids = pids.filter((pid) => Number.isInteger(pid) && pid > 0);
  if (ids.length === 0) return new Map();
  const script = `$ids = @(${ids.join(",")}); Get-CimInstance Win32_Process | Where-Object { $ids -contains $_.ProcessId } | ForEach-Object { '{0}|{1}' -f $_.ProcessId, $_.CommandLine }`;
  // nosemgrep: javascript.lang.security.detect-child-process.detect-child-process -- a fixed program by its full path; the script holds only integers
  const result = spawnSync(systemTool(join("WindowsPowerShell", "v1.0", "powershell.exe")), ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  const found = new Map();
  if (result.status !== 0) return found;
  for (const line of result.stdout.split(/\r?\n/)) {
    const at = line.indexOf("|");
    if (at > 0 && /^\d+$/.test(line.slice(0, at))) found.set(Number(line.slice(0, at)), line.slice(at + 1));
  }
  return found;
}

function killPid(pid) {
  // nosemgrep: javascript.lang.security.detect-child-process.detect-child-process -- a fixed program by its full path; the argument is a number
  spawnSync(systemTool("taskkill.exe"), ["/PID", String(pid), "/F"], { windowsHide: true, stdio: "ignore" });
}

/**
 * Stops the processes of `roots` and everything below them, deepest first, by process ID, and looks again until none is
 * left (a process may start another while it is being stopped). Every process found is kept as a root of the later
 * looks, by ID and creation time, so a child that outlives its stopped parent is still found and a reused ID is not.
 * Returns `{ killed, remaining }`, both lists of IDs.
 */
export function stopTree(roots, { snapshot = snapshotProcesses, kill = killPid, rounds = 6 } = {}) {
  const killed = [];
  const known = new Map(roots.map((root) => [`${root.pid}@${root.created}`, root]));
  let remaining = [];
  for (let round = 0; round < rounds; round += 1) {
    remaining = treeOf([...known.values()], snapshot());
    if (remaining.length === 0) break;
    for (const entry of remaining) {
      known.set(`${entry.pid}@${entry.created}`, { pid: entry.pid, created: entry.created });
      kill(entry.pid);
      killed.push(entry.pid);
    }
  }
  return { killed, remaining: remaining.map((entry) => entry.pid) };
}

// ---- ports --------------------------------------------------------------------------------------------------------

/** The TCP listeners in `netstat -ano -p tcp` output: `{ address, port, pid }`. IPv4 and IPv6 rows alike. */
export function parseListeners(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*TCP\s+(\S+)\s+\S+\s+LISTENING\s+(\d+)\s*$/.exec(line);
    if (!match) continue;
    const at = match[1].lastIndexOf(":");
    out.push({ address: match[1].slice(0, at), port: Number(match[1].slice(at + 1)), pid: Number(match[2]) });
  }
  return out;
}

/**
 * Every TCP listener on this PC now, IPv4 and IPv6: `netstat -p tcp` lists IPv4 only, so IPv6 is asked for on its own
 * (`-p tcpv6`). Throws when either can't be asked, or when IPv4 lists none (some always exist).
 */
export function tcpListeners() {
  const ask = (protocol) => {
    // nosemgrep: javascript.lang.security.detect-child-process.detect-child-process -- a fixed program by its full path; the protocol is one of two fixed words
    const result = spawnSync(systemTool("NETSTAT.EXE"), ["-ano", "-p", protocol], { encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    if (result.status !== 0) throw new Error("could not ask Windows which ports are listening");
    return parseListeners(result.stdout);
  };
  const four = ask("tcp");
  if (four.length === 0) throw new Error("could not ask Windows which ports are listening");
  return [...four, ...ask("tcpv6")];
}

/** The listeners owned by the processes of `roots` (a process and everything below it). */
export function listenersOfTree(roots, snapshot, listeners) {
  const pids = new Set(treeOf(roots, snapshot).map((entry) => entry.pid));
  return listeners.filter((entry) => pids.has(entry.pid));
}

/** Proof that a session is attached to the instance this run started, or an Error saying what is not so. */
export function checkAttached({ debuggerAddress, processId, driver, snapshot, listeners }) {
  const fail = (why) => {
    throw new Error(`the session is not attached to the instance this run started: ${why}`);
  };
  const port = Number(/:(\d+)$/.exec(String(debuggerAddress))?.[1]);
  if (!Number.isInteger(port) || port <= 0) fail("no debugging port was reported");
  if (!Number.isInteger(processId)) fail("no process ID was reported");
  const underDriver = treeOf([driver], snapshot);
  const app = underDriver.find((entry) => entry.pid === processId);
  if (app === undefined) fail("the app's process is not below the driver this run started");
  const appTree = treeOf([{ pid: app.pid, created: app.created }], snapshot);
  const owner = listeners.find((entry) => entry.port === port && appTree.some((p) => p.pid === entry.pid));
  if (owner === undefined) fail("the debugging port is not listened on by the app this run started");
  return { pid: app.pid, port };
}

/** Resolves once something accepts a connection on 127.0.0.1:`port`, or throws after `timeoutMs`. */
export async function waitForPort(port, timeoutMs, alive = () => true) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (!alive()) throw new Error("the driver stopped before it listened");
    const up = await new Promise((resolve) => {
      const socket = net.connect({ host: "127.0.0.1", port });
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
    });
    if (up) return;
    await sleep(200);
  }
  throw new Error(`nothing listened on port ${String(port)} in time`);
}

/** A port nothing listens on now, asked of the system (loopback only). */
export function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

// ---- starting and stopping ----------------------------------------------------------------------------------------

/**
 * The environment for what this run starts: the caller's, minus any web-view or automation setting of the caller's own
 * (those are set by the driver for the app it starts, and by nothing else), with TEMP and TMP in the run's folder so
 * that msedgedriver's own web-view folder lands there, and WEBVIEW2_USER_DATA_FOLDER in the run's folder for a launch
 * with no driver. Never changes `process.env`.
 */
export function runEnvironment(base, { tempDir, webviewDir }) {
  const drop = new Set(["WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", "WEBVIEW2_USER_DATA_FOLDER", "TAURI_AUTOMATION", "TAURI_WEBVIEW_AUTOMATION", "TEMP", "TMP"]);
  const env = Object.fromEntries(Object.entries(base).filter(([name]) => !drop.has(name.toUpperCase())));
  return { ...env, TEMP: tempDir, TMP: tempDir, WEBVIEW2_USER_DATA_FOLDER: webviewDir };
}

// ---- an elevated run (the GitHub job) -----------------------------------------------------------------------------

/** Whether `whoami /groups` output names a high (administrator) or system integrity level. */
export function elevatedFromGroups(text) {
  return /\bS-1-16-(12288|16384)\b/.test(text);
}

/** Whether this process runs elevated, as Windows' own `whoami /groups` says. */
export function isElevated() {
  // nosemgrep: javascript.lang.security.detect-child-process.detect-child-process -- a fixed program by its full path and a fixed argument
  const result = spawnSync(systemTool("whoami.exe"), ["/groups"], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error("could not ask Windows whether this run is elevated");
  return elevatedFromGroups(result.stdout);
}

/** WebView2's machine policy keys, outermost first: the switch is a value named for the app's program file. */
export const POLICY_KEYS = [
  "HKLM\\SOFTWARE\\Policies\\Microsoft\\Edge",
  "HKLM\\SOFTWARE\\Policies\\Microsoft\\Edge\\WebView2",
  "HKLM\\SOFTWARE\\Policies\\Microsoft\\Edge\\WebView2\\AdditionalBrowserArguments",
];
export const POLICY_VALUE = "lockbox-desktop.exe";
export const POLICY_DATA = "--remote-debugging-port=0";

/**
 * What a driven launch needs from the machine: "nothing" when the run is not elevated (msedgedriver's settings reach the
 * app on its own process), "policy" when it is elevated on the GitHub job. Elevated anywhere else is refused: the machine
 * policy is used only on a runner that is thrown away after the job.
 */
export function drivenLaunchNeeds({ elevated, ci }) {
  if (!elevated) return "nothing";
  if (ci) return "policy";
  throw new Error(
    "this run is elevated (run as administrator): WebView2 ignores the driver's settings in an elevated app, and the machine-wide way round it is used only on the GitHub job. Run from a shell that is not elevated",
  );
}

/** reg.exe with `args`; its exit code (0 found or done, 1 not found or failed). */
function runReg(args) {
  // nosemgrep: javascript.lang.security.detect-child-process.detect-child-process -- a fixed program by its full path; every argument is a constant above
  return spawnSync(systemTool("reg.exe"), [...args, "/reg:64"], { stdio: "ignore", windowsHide: true }).status;
}

/** `error`, with what of the policy could not be removed added to its message (a removal that failed is never silent). */
function withPolicyLeft(error, left) {
  if (left.length > 0 && error instanceof Error) error.message += ` (and the WebView2 policy could not be removed: ${left.join(", ")})`;
  return error;
}

/**
 * Sets the debugging switch as WebView2's machine policy for lockbox-desktop.exe, refusing when the machine already has
 * one for it (it is left as it is). Returns what `removeDebuggingPolicy` undoes: the keys this made. `reg` runs reg.exe.
 */
export function setDebuggingPolicy(reg = runReg) {
  const existed = POLICY_KEYS.map((key) => reg(["query", key]) === 0);
  if (existed[2] && reg(["query", POLICY_KEYS[2], "/v", POLICY_VALUE]) === 0) {
    throw new Error(`the machine already has a WebView2 policy for ${POLICY_VALUE}: it is left as it is, and nothing is driven`);
  }
  const undo = { created: POLICY_KEYS.filter((_, index) => !existed[index]) };
  if (reg(["add", POLICY_KEYS[2], "/v", POLICY_VALUE, "/t", "REG_SZ", "/d", POLICY_DATA, "/f"]) !== 0) {
    throw withPolicyLeft(new Error("could not set the WebView2 policy for the driven launch"), removeDebuggingPolicy(undo, reg));
  }
  return undo;
}

/** Removes what `setDebuggingPolicy` set: the value, then the keys it made, innermost first. Returns what is left. */
export function removeDebuggingPolicy(undo, reg = runReg) {
  reg(["delete", POLICY_KEYS[2], "/v", POLICY_VALUE, "/f"]);
  for (const key of [...undo.created].reverse()) reg(["delete", key, "/f"]);
  const left = [];
  if (reg(["query", POLICY_KEYS[2], "/v", POLICY_VALUE]) === 0) left.push(`${POLICY_KEYS[2]}\\${POLICY_VALUE}`);
  for (const key of undo.created) if (reg(["query", key]) === 0) left.push(key);
  return left;
}

/**
 * Starts tauri-driver (and so, in time, msedgedriver and the app) with ports of its own, for this run only. Returns the
 * handle `stopLockbox` takes. The app itself starts when a session is created. Elevated on the GitHub job, it also sets
 * WebView2's machine policy for the driven launch (the handle's `policy` says what `stopLockbox` removes); elevated
 * anywhere else, it refuses before anything starts. `reg` runs reg.exe (a fake in tests).
 */
export async function startLockbox({ tauriDriver, nativeDriver, tempDir, webviewDir, logFile, base = process.env, elevated = isElevated(), reg = runReg }) {
  const needs = drivenLaunchNeeds({ elevated, ci: base.LOCKBOX_E2E_CI === "1" });
  mkdirSync(tempDir, { recursive: true });
  mkdirSync(webviewDir, { recursive: true });
  const port = await freePort();
  const nativePort = await freePort();
  const policy = needs === "policy" ? setDebuggingPolicy(reg) : undefined;
  let child;
  try {
    const log = openSync(logFile, "w");
    try {
      // nosemgrep: javascript.lang.security.detect-child-process.detect-child-process -- the program and driver are paths this run was given or found; every other argument is a number
      child = spawn(tauriDriver, ["--port", String(port), "--native-port", String(nativePort), "--native-driver", nativeDriver], {
        env: runEnvironment(base, { tempDir, webviewDir }),
        stdio: ["ignore", log, log],
        windowsHide: true,
      });
    } finally {
      closeSync(log);
    }
    let exited = false;
    child.once("exit", () => {
      exited = true;
    });
    child.once("error", () => {
      exited = true;
    });
    await waitForPort(port, 20_000, () => !exited);
    const me = snapshotProcesses().find((entry) => entry.pid === child.pid);
    if (me === undefined) throw new Error("the driver is not running");
    return { pid: child.pid, created: me.created, port, nativePort, tempDir, webviewDir, elevated, policy };
  } catch (error) {
    if (child?.pid !== undefined) killPid(child.pid);
    throw policy === undefined ? error : withPolicyLeft(error, removeDebuggingPolicy(policy, reg));
  }
}

/**
 * Stops the driver this run started, and what it started (msedgedriver, the app, its web-view processes), then removes
 * the machine policy the run set, if any, even when stopping failed. `remaining` lists the IDs still running and any
 * policy key or value left.
 */
export function stopLockbox(handle, { stop = stopTree, removePolicy = removeDebuggingPolicy } = {}) {
  if (handle.policy === undefined) return stop([{ pid: handle.pid, created: handle.created }]);
  let outcome;
  try {
    outcome = stop([{ pid: handle.pid, created: handle.created }]);
  } catch (error) {
    throw withPolicyLeft(error, removePolicy(handle.policy));
  }
  return { ...outcome, remaining: [...outcome.remaining, ...removePolicy(handle.policy)] };
}

// ---- what runs where -----------------------------------------------------------------------------------------------

/**
 * Whether the steps that use the clipboard (and the keyboard shortcut) run. They change what is on the PC's clipboard,
 * so they run on the GitHub end-to-end job (which sets LOCKBOX_E2E_CI=1 itself; the generic CI=true that shells and local
 * tools set grants nothing), and on a PC only when its owner has said it is free (LOCKBOX_E2E_PC_FREE=1).
 */
export function clipboardSteps(env) {
  if (env.LOCKBOX_E2E_CI === "1") return { run: true, why: "on the GitHub end-to-end job" };
  if (env.LOCKBOX_E2E_PC_FREE === "1") return { run: true, why: "LOCKBOX_E2E_PC_FREE=1" };
  return { run: false, why: "skipped here: they use the clipboard of this PC; set LOCKBOX_E2E_PC_FREE=1 when it is free" };
}

// ---- the clipboard ------------------------------------------------------------------------------------------------

const powershell = () => systemTool(join("WindowsPowerShell", "v1.0", "powershell.exe"));

/** The text on the clipboard now ("" when there is none). Only for steps `clipboardSteps` allows. */
export function readClipboard() {
  // nosemgrep: javascript.lang.security.detect-child-process.detect-child-process -- a fixed program by its full path and a fixed script
  const result = spawnSync(powershell(), ["-NoProfile", "-NonInteractive", "-Command", "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $t = Get-Clipboard -Raw; if ($null -ne $t) { [Console]::Out.Write($t) }"], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error("could not read the clipboard");
  return result.stdout;
}

/** Empties the clipboard. Only for steps `clipboardSteps` allows. */
export function clearClipboard() {
  // nosemgrep: javascript.lang.security.detect-child-process.detect-child-process -- a fixed program by its full path and a fixed script
  spawnSync(powershell(), ["-NoProfile", "-NonInteractive", "-Command", "Set-Clipboard -Value $null"], { windowsHide: true, stdio: "ignore" });
}

/**
 * Puts `text` (a made-up value) on the clipboard, as a person's copy does. The text goes in on standard input, never on a
 * command line. Only for steps `clipboardSteps` allows.
 */
export function writeClipboard(text) {
  if (typeof text !== "string" || text === "") throw new Error("writeClipboard needs the text to put there");
  // nosemgrep: javascript.lang.security.detect-child-process.detect-child-process -- a fixed program by its full path and a fixed script; the text goes on stdin
  const result = spawnSync(powershell(), ["-NoProfile", "-NonInteractive", "-Command", "[Console]::InputEncoding = [System.Text.Encoding]::UTF8; Set-Clipboard -Value ([Console]::In.ReadToEnd())"], {
    input: text,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error("could not set the clipboard");
}

// ---- the keyboard -------------------------------------------------------------------------------------------------

/**
 * Presses the save shortcut (Ctrl+Shift+L, the default) as real keyboard input: Windows gives it to Lockbox wherever its
 * window is. Only for steps `clipboardSteps` allows: it is this PC's keyboard.
 */
export function pressSaveShortcut() {
  // nosemgrep: javascript.lang.security.detect-child-process.detect-child-process -- a fixed program by its full path and a script of this repository, with no arguments
  const result = spawnSync(powershell(), ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", here("shortcut.ps1")], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0 || !/pressed/.test(result.stdout ?? "")) throw new Error("the save shortcut could not be pressed");
}

// ---- the idle clock -----------------------------------------------------------------------------------------------

/**
 * Lockbox locks when Windows says the session has had no keyboard or mouse input for the auto-lock time, however
 * recently the vault was unlocked (it reads GetLastInputInfo). On a PC nobody has touched for minutes, and on CI's
 * runner, an unlocked vault would lock within one tick of the 5-second timer. WebDriver's events are not input to Windows,
 * so a run starts the idle clock from zero by sending one mouse event that moves nothing (no key, no click, no move).
 * Returns the idle time in milliseconds before and after, and throws if the clock did not restart.
 */
export function restartIdleClock() {
  const [before, after] = idleClock(true);
  if (after > 2000) throw new Error("the idle clock did not restart");
  return { before, after };
}

/** The session's idle time now, in seconds (read only: nothing is sent). */
export function idleSeconds() {
  return Math.round(idleClock(false)[0] / 1000);
}

/** Runs the idle clock script: the idle milliseconds before and after the nudge (which is sent only when `nudge`). */
function idleClock(nudge) {
  const script = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class IdleClock {
  [StructLayout(LayoutKind.Sequential)] struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LASTINPUTINFO info);
  [DllImport("user32.dll")] static extern void mouse_event(uint flags, int dx, int dy, uint data, UIntPtr extra);
  public static uint IdleMs() {
    var info = new LASTINPUTINFO(); info.cbSize = (uint)Marshal.SizeOf(info);
    GetLastInputInfo(ref info);
    return (uint)Environment.TickCount - info.dwTime;
  }
  // MOUSEEVENTF_MOVE (0x1) by 0, 0: input as far as the session's idle time goes, and nothing moves
  public static void Nudge() { mouse_event(0x1, 0, 0, 0, UIntPtr.Zero); }
}
"@
$before = [IdleClock]::IdleMs()
${nudge ? "[IdleClock]::Nudge()\nStart-Sleep -Milliseconds 100" : ""}
"$before $([IdleClock]::IdleMs())"
`;
  // nosemgrep: javascript.lang.security.detect-child-process.detect-child-process -- a fixed program by its full path and a script that is fixed but for one switch
  const result = spawnSync(powershell(), ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true });
  const match = /^(\d+) (\d+)\s*$/m.exec(result.stdout ?? "");
  if (result.status !== 0 || !match) throw new Error("could not read the idle clock");
  return [Number(match[1]), Number(match[2])];
}

// ---- the window ---------------------------------------------------------------------------------------------------

const here = (name) => fileURLToPath(new URL(name, import.meta.url));

/**
 * Moves every visible window of the process `pid` off the screen without activating it (waiting up to `seconds` for one
 * to appear). Returns how many were moved. Used for a launch with no driver; a driven app is moved by its window rect.
 */
export function moveOffScreen(pid, seconds = 20) {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error("moveOffScreen needs a process ID");
  // nosemgrep: javascript.lang.security.detect-child-process.detect-child-process -- a fixed program by its full path and a script of this repository; the argument is a number
  const result = spawnSync(
    systemTool(join("WindowsPowerShell", "v1.0", "powershell.exe")),
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", here("offscreen.ps1"), "-ProcessId", String(pid), "-TimeoutSeconds", String(seconds)],
    { encoding: "utf8", windowsHide: true },
  );
  if (result.status !== 0) throw new Error("no window of the app could be moved off screen");
  return result.stdout.split(/\r?\n/).filter((line) => line.startsWith("moved")).length;
}

// ---- the page, for the specs ---------------------------------------------------------------------------------------

/** A role-and-name selector in WebdriverIO's own words: `by("button", "Create vault")`. Never a class or an ID. */
export const by = (role, name) => `role/${role}[name="${name}"]`;

/** A box that has no ARIA role (a password box) found by its accessible name alone. */
export const named = (name) => `aria/${name}`;

/** Types into a box found by its name, replacing what it held. */
export async function typeInto(selector, text) {
  const { $ } = await import("@wdio/globals");
  const box = await $(selector);
  await box.waitForDisplayed({ timeout: 15_000 });
  await box.setValue(text);
}

/** Presses a button found by role and name once it can be pressed. */
export async function press(name) {
  const { $ } = await import("@wdio/globals");
  const button = await $(by("button", name));
  await button.waitForClickable({ timeout: 15_000 });
  await button.click();
}

/** Unlocks the vault `name` on the lock screen with `password`, and waits until the lock screen has gone. */
export async function unlock(name, password) {
  const { $, expect } = await import("@wdio/globals");
  await typeInto(named(`Password for ${name}`), password);
  await press("Unlock");
  await $(by("button", "Unlock")).waitForExist({ timeout: 30_000, reverse: true });
  await expect($(by("heading", `Unlock ${name}`))).not.toExist();
}
