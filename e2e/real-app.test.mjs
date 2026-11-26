// Tests that need the built app and the drivers. `node scripts/e2e.mjs` runs this file (with PETALOCK_E2E_REAL=1 and the
// paths it found) after it has built the release app and swapped the test state in; run any other way it is skipped,
// and says so. Each test starts what it needs and stops it again by process ID. Every comparison counts what it
// compared and fails on zero.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import * as app from "./lib/app.mjs";

const ENABLED = process.env.PETALOCK_E2E_REAL === "1";
const SKIP = ENABLED ? false : "needs the built app and the drivers: run node scripts/e2e.mjs";
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DESKTOP = join(ROOT, "crates", "petalock-desktop");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const setting = (name) => {
  const value = process.env[name];
  assert.ok(value, `${name} is not set: this file is run by scripts/e2e.mjs`);
  return value;
};

/** Every command the page may call, written out here on purpose: a command added or removed fails this test until it is changed here too. */
const PERMITTED_COMMANDS = [
  "app_info", "launch_notices", "list_sessions", "lock_vault", "lock_all", "close_explained_ok", "close_answer", "clear_copied",
  "list_vaults", "start_new_vault_list", "add_existing_vault", "add_existing_vault_confirm", "forget_vault", "show_vault_in_explorer",
  "create_vault", "create_vault_confirm", "unlock_vault", "recover_check", "recover_finish", "recover_forget", "change_password",
  "new_recovery_key", "regenerate_recovery", "recovery_confirmed", "accept_header", "rename_vault", "list_items", "get_item",
  "reveal_password", "copy_field", "new_item", "update_item", "trash_item", "restore_item", "delete_collection", "purge_item",
  "old_trash", "empty_trash", "search_all", "open_url", "list_orphans", "delete_orphans", "save_file_copy", "save_file_copy_confirm",
  "add_file", "attach_file", "pick_files_to_add", "remove_picked_file", "add_files", "save_all_files", "save_all_files_confirm",
  "save_all_start", "show_output_in_explorer", "close_output", "replace_file", "open_file", "retry_open_cleanup",
  "reset_output_journal", "cancel_operation", "save_recovery_pdf", "save_readable_confirm", "export_csv", "export_repick",
  "list_printers", "print_recovery_key", "env_read", "env_save", "env_copy", "env_save_file", "capture_state", "capture_choose",
  "capture_unchoose", "capture_reveal", "capture_save", "capture_cancel", "capture_env", "backup_vault", "vault_backup_due",
  "test_backup_pick", "test_backup", "forget_test_backup", "open_backup_pick", "forget_open_backup", "open_backup_read_only",
  "copy_item_to", "restore_pick", "restore_check", "restore_choose_folder", "forget_restore_pick", "restore_prepare",
  "restore_prepare_confirm", "restore_commit", "restore_discard", "restore_notice", "retry_restore_recovery", "dismiss_restore",
  "list_pre_restore", "delete_pre_restore", "open_pre_restore_read_only", "generate_password", "generate_passphrase",
  "copy_generated", "get_settings", "set_settings", "get_startup", "set_startup", "open_help",
];

const readJson = (...parts) => JSON.parse(readFileSync(join(...parts), "utf8"));

// ---- what the shipped app is --------------------------------------------------------------------------------------

test("shipped_grants_and_config_allow_only_the_listed_commands", { skip: SKIP, timeout: 60_000 }, () => {
  assert.equal(PERMITTED_COMMANDS.length, new Set(PERMITTED_COMMANDS).size, "the explicit list has no repeats");
  const sorted = (list) => [...list].sort();
  const granted = PERMITTED_COMMANDS.map((command) => `allow-${command.replaceAll("_", "-")}`);

  // the sources the release build is made from
  const listSource = readFileSync(join(DESKTOP, "src", "commands", "list.rs"), "utf8");
  const block = /pub const COMMANDS: &\[&str\] = &\[([\s\S]*?)\];/.exec(listSource);
  assert.ok(block, "COMMANDS is found in list.rs");
  const commands = [...block[1].matchAll(/"([a-z0-9_]+)"/g)].map((match) => match[1]);
  assert.deepEqual(sorted(commands), sorted(PERMITTED_COMMANDS), "COMMANDS is exactly the permitted list");

  const capabilityFiles = readdirSync(join(DESKTOP, "capabilities"));
  assert.deepEqual(capabilityFiles, ["main.json"], "one capability file, and no other");
  const main = readJson(DESKTOP, "capabilities", "main.json");
  assert.deepEqual(Object.keys(main).sort(), ["description", "identifier", "permissions", "windows"], "the capability has no remote, webview or platform extras");
  assert.deepEqual(main.windows, ["main"]);
  assert.deepEqual(main.permissions, ["core:event:allow-listen", "core:event:allow-unlisten", ...granted], "the window is granted the listed commands and two event permissions, in that order");

  // what the release build resolved from them (written by the build this run just made)
  const resolved = readJson(DESKTOP, "gen", "schemas", "capabilities.json");
  assert.deepEqual(Object.keys(resolved), ["main"], "the build resolved one capability");
  assert.deepEqual(resolved.main.permissions, main.permissions, "the build resolved exactly the granted permissions");
  assert.deepEqual(resolved.main.windows, ["main"]);
  assert.equal(resolved.main.local, true);
  assert.equal(resolved.main.remote, undefined, "no remote origin is granted anything");
  // (the build's permission set may still hold the definition of a command that was removed, from an earlier build in
  // this folder: a definition grants nothing. What counts is that every permitted command has one, and the grants above.)
  const manifests = readJson(DESKTOP, "gen", "schemas", "acl-manifests.json");
  const definitions = manifests["__app-acl__"].permissions;
  for (const command of PERMITTED_COMMANDS) {
    const definition = definitions[`allow-${command.replaceAll("_", "-")}`];
    assert.deepEqual(definition?.commands, { allow: [command], deny: [] }, `the build defines allow-${command} for that command alone`);
  }
  // the commands the app registers (its invoke handler) are the permitted ones, no more and no fewer
  const modSource = readFileSync(join(DESKTOP, "src", "commands", "mod.rs"), "utf8");
  const handler = /tauri::generate_handler!\[([\s\S]*?)\]/.exec(modSource);
  assert.ok(handler, "the invoke handler is found in commands/mod.rs");
  const registered = handler[1].split(",").map((entry) => entry.trim().split("::").pop()).filter(Boolean);
  assert.deepEqual(sorted(registered), sorted(PERMITTED_COMMANDS), "the invoke handler registers exactly the permitted commands");

  // the artifact itself
  const exe = readFileSync(setting("PETALOCK_E2E_APP")).toString("latin1");
  assert.ok(exe.length > 1_000_000, "the built app was read");
  let found = 0;
  for (const command of PERMITTED_COMMANDS) {
    assert.ok(exe.includes(command), `the built app holds the command ${command}`);
    found += 1;
  }
  assert.equal(found, PERMITTED_COMMANDS.length);
  for (const never of ["remote-debugging-port", "enable-automation", "test-type=webdriver", "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", "WEBVIEW2_USER_DATA_FOLDER"]) {
    assert.equal(exe.includes(never), false, `the built app carries no "${never}"`);
  }

  // the configuration and the features it is built with
  const conf = readJson(DESKTOP, "tauri.conf.json");
  assert.deepEqual(Object.keys(conf).sort(), ["app", "build", "bundle", "identifier", "mainBinaryName", "productName"]);
  assert.equal(conf.mainBinaryName, "petalock", "the program name the scripts' PROGRAM expects");
  // The installer's bundle (Plan 5, Task 1): the NSIS installer for the current user, from this folder's template and hooks.
  assert.deepEqual(conf.bundle, {
    active: true,
    targets: ["nsis"],
    publisher: "Petalock",
    icon: ["icons/icon.ico", "icons/icon.png"],
    useLocalToolsDir: true,
    windows: {
      webviewInstallMode: { type: "embedBootstrapper", silent: true },
      nsis: {
        installMode: "currentUser",
        languages: ["English"],
        installerIcon: "icons/icon.ico",
        uninstallerIcon: "icons/icon.ico",
        template: "windows/installer.nsi",
        installerHooks: "windows/hooks.nsh",
      },
    },
  });
  assert.deepEqual(Object.keys(conf.app).sort(), ["security", "windows", "withGlobalTauri"], "app has only its listed keys");
  assert.deepEqual(Object.keys(conf.app.security).sort(), ["csp", "freezePrototype"]);
  assert.equal(conf.app.withGlobalTauri, false);
  assert.deepEqual(conf.app.windows, [], "no window is declared in the configuration; the app makes its own");
  const confText = readFileSync(join(DESKTOP, "tauri.conf.json"), "utf8");
  assert.doesNotMatch(confText, /devtools|automation|remote-debugging|webdriver/i, "the configuration carries no devtools or automation setting");
  const cargo = readFileSync(join(DESKTOP, "Cargo.toml"), "utf8");
  assert.doesNotMatch(cargo, /devtools|automation|webdriver/i, "no devtools or automation feature is turned on");
  assert.match(cargo, /^tauri = \{ version = "[0-9.]+", features = \["tray-icon"\] \}$/m, "tauri is built with the tray icon feature and nothing else");
  assert.match(cargo, /^custom-protocol = \["tauri\/custom-protocol"\]$/m);
  let scannedSources = 0;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".rs")) {
        scannedSources += 1;
        assert.doesNotMatch(readFileSync(full, "utf8"), /devtools|additional_browser_args|remote-debugging|\bWEBVIEW2_(ADDITIONAL_BROWSER_ARGUMENTS|USER_DATA_FOLDER)\b/i, `${entry.name} sets no web-view debugging option`);
      }
    }
  };
  walk(join(DESKTOP, "src"));
  assert.ok(scannedSources >= 20, `scanned the app's sources (${scannedSources})`);

  // the page the app embeds
  let scannedPage = 0;
  const dist = join(ROOT, "ui", "dist");
  const walkPage = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walkPage(full);
      else if (/\.(html|js|css)$/.test(entry.name)) {
        scannedPage += 1;
        assert.doesNotMatch(readFileSync(full, "utf8"), /remote-debugging|TAURI_WEBVIEW_AUTOMATION|TAURI_AUTOMATION|WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS|enable-automation/, `${entry.name} carries no automation setting`);
      }
    }
  };
  walkPage(dist);
  assert.ok(scannedPage >= 3, `scanned the embedded page's files (${scannedPage})`);
});

// ---- what a launch opens -------------------------------------------------------------------------------------------

/**
 * Waits until the process tree of `root` has at least `count` processes and has stayed that size for `settleMs`.
 * `onSnapshot` is called with each look at the machine's processes on the way, so a listener that opens and closes during
 * start-up is seen too, not only what is left once the tree has settled.
 */
async function waitForTree(root, count, settleMs, timeoutMs, onSnapshot = () => {}) {
  const until = Date.now() + timeoutMs;
  let size = 0;
  let since = Date.now();
  while (Date.now() < until) {
    const snapshot = app.snapshotProcesses();
    onSnapshot(snapshot);
    const now = app.treeOf([root], snapshot).length;
    if (now !== size) {
      size = now;
      since = Date.now();
    }
    if (size >= count && Date.now() - since >= settleMs) return size;
    await sleep(500);
  }
  throw new Error(`the app's processes did not settle (${size} seen)`);
}

/** How many entries are under `dir` (a folder this run made), so that "it filled" can fail on none. */
function countEntries(dir) {
  let files = 0;
  const walk = (current) => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      files += 1;
      if (entry.isDirectory()) walk(join(current, entry.name));
    }
  };
  walk(dir);
  return files;
}

/** The folders named by `--user-data-dir=` in command lines (a web view's data folder), as the Map `lines` gives them. */
function dataFolders(lines) {
  const found = [];
  for (const line of lines.values()) {
    const match = /--user-data-dir=(?:"([^"]+)"|(\S+))/.exec(line);
    if (match) found.push(match[1] ?? match[2]);
  }
  return found;
}

/** A folder spelled in its long form (a temp folder may be spelled `RUNNER~1` by one program and `runneradmin` by another). */
const longForm = (folder) => {
  try {
    return realpathSync.native(folder);
  } catch {
    return folder;
  }
};

const isUnder = (child, parent) => longForm(child).toLowerCase().startsWith(`${longForm(parent).toLowerCase()}${sep}`);

/**
 * Every web-view process in `tree` (found by the process tree of the app this run started) carries the run-owned folder as its
 * `--user-data-dir`: none writes anywhere else, the real cache included. Counts them, and fails on too few.
 */
function assertRunOwnedWebViews(tree, lines, owned, what) {
  const views = tree.filter((entry) => entry.name.toLowerCase() === "msedgewebview2.exe");
  assert.ok(views.length >= 4, `${what}: the app's web-view processes were found (${views.length})`);
  for (const view of views) {
    const named = dataFolders(new Map([[view.pid, lines.get(view.pid) ?? ""]]));
    assert.equal(named.length, 1, `${what}: web-view process ${view.pid} names one data folder`);
    assert.ok(isUnder(named[0], owned), `${what}: web-view process ${view.pid} keeps its data inside the run's own folder`);
  }
}

const runFolder = (name) => {
  const dir = join(setting("PETALOCK_E2E_RUN_ROOT"), name);
  mkdirSync(join(dir, "temp"), { recursive: true });
  mkdirSync(join(dir, "webview"), { recursive: true });
  return { temp: join(dir, "temp"), webview: join(dir, "webview"), log: join(dir, "driver.log") };
};

test("a_normal_launch_opens_no_debugging_port", { skip: SKIP, timeout: 120_000 }, async () => {
  const exe = setting("PETALOCK_E2E_APP");
  const folders = runFolder("normal");
  const { spawn } = await import("node:child_process");
  // started as a person starts it: no driver, and the run's own web-view folder so that no real cache is written
  // nosemgrep: javascript.lang.security.detect-child-process.detect-child-process -- the built app's path, no arguments
  const child = spawn(exe, [], { env: app.runEnvironment(process.env, { tempDir: folders.temp, webviewDir: folders.webview }), stdio: "ignore", windowsHide: true });
  try {
    const me = await (async () => {
      for (let tries = 0; tries < 20; tries += 1) {
        const found = app.snapshotProcesses().find((entry) => entry.pid === child.pid);
        if (found) return found;
        await sleep(250);
      }
      throw new Error("the app did not start");
    })();
    const root = { pid: me.pid, created: me.created };
    // off the screen of whoever is at this PC, as soon as the window is there
    if (process.env.PETALOCK_E2E_OFFSCREEN === "1") assert.ok(app.moveOffScreen(me.pid) >= 1, "the app's window was moved off screen");
    // looked at on the way up as well as once settled: IPv4 and IPv6, the app and every process below it
    let looks = 0;
    const onTheWay = [];
    const size = await waitForTree(root, 4, 4000, 60_000, (snapshot) => {
      looks += 1;
      onTheWay.push(...app.listenersOfTree([root], snapshot, app.tcpListeners()));
    });
    const snapshot = app.snapshotProcesses();
    const tree = app.treeOf([root], snapshot);
    assert.ok(size >= 4 && tree.length >= 4, `the probe looked at the app and its web-view processes (${tree.length})`);
    assert.ok(looks >= 3, `the probe looked at the machine while the app started (${looks} times)`);
    assert.deepEqual(onTheWay, [], "no listener of the app or its processes was seen while it started");
    const listeners = app.tcpListeners();
    assert.ok(listeners.length >= 3, "the probe read the machine's listeners");
    assert.deepEqual(app.listenersOfTree([root], snapshot, listeners), [], "neither the app nor any web-view process listens on any port");
    const lines = app.commandLines(tree.map((entry) => entry.pid));
    assert.ok(lines.size >= 4, `the probe read the command lines of the tree (${lines.size})`);
    for (const [pid, line] of lines) assert.doesNotMatch(line, /remote-debugging|enable-automation|test-type=webdriver/, `process ${pid} has no debugging or automation option`);
    // and its web-view data went to the run's own folder, not the real cache
    assertRunOwnedWebViews(tree, lines, folders.webview, "normal launch");
  } finally {
    app.stopTree([{ pid: child.pid, created: app.snapshotProcesses().find((entry) => entry.pid === child.pid)?.created ?? "0" }]);
  }
});

/** The app's, the web view's and the drivers' processes now, with their command lines: one line each. */
function driverProcesses() {
  try {
    const running = app.snapshotProcesses().filter((entry) => /^(petalock|msedgewebview2|msedgedriver|tauri-driver)\.exe$/i.test(entry.name));
    const lines = app.commandLines(running.map((entry) => entry.pid));
    return running.map((entry) => `  ${entry.pid} (parent ${entry.ppid}) ${entry.name}: ${(lines.get(entry.pid) ?? "?").slice(0, 1500)}`).join("\n") || "  (none)";
  } catch (error) {
    return `  (could not be read: ${error.message})`;
  }
}

/**
 * The files under `dir` as paths relative to it, level by level (so a folder's own files come before what is deep inside
 * its subfolders), three levels deep and at most `cap` of them, with a last line when the list was cut; and every file
 * named DevToolsActivePort six levels deep, found or not: the file msedgedriver waits for.
 */
function filesUnder(dir, cap = 80) {
  const out = [];
  const ready = [];
  let cut = false;
  let level = [{ path: dir, rel: "" }];
  for (let depth = 1; depth <= 6 && level.length > 0; depth += 1) {
    const next = [];
    for (const folder of level) {
      let entries;
      try {
        entries = readdirSync(folder.path, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const rel = folder.rel ? `${folder.rel}${sep}${entry.name}` : entry.name;
        if (entry.name === "DevToolsActivePort") ready.push(rel);
        if (depth <= 3) {
          if (out.length < cap) out.push(entry.isDirectory() ? `${rel}${sep}` : rel);
          else cut = true;
        }
        if (entry.isDirectory()) next.push({ path: join(folder.path, entry.name), rel });
      }
    }
    level = next;
  }
  if (cut) out.push(`(cut at ${cap} entries)`);
  out.push(ready.length > 0 ? `DevToolsActivePort: ${ready.join("; ")}` : "DevToolsActivePort: none, six levels deep");
  return out;
}

/**
 * What a driven launch that made no session left behind, to read in the failure: the processes seen while the driver
 * waited, the processes now, the end of the driver's log (tauri-driver's, msedgedriver's and the app's own output) and
 * what is in the run's temp folder. Made-up test state only; nothing secret is in any of it.
 */
function drivenLaunchReport(folders, whileWaiting) {
  let logTail;
  try {
    logTail = readFileSync(folders.log, "utf8").split(/\r?\n/).slice(-40).join("\n");
  } catch (error) {
    logTail = `(could not be read: ${error.message})`;
  }
  return [
    `processes while the driver waited:\n${whileWaiting ?? "  (the answer came first)"}`,
    `processes now:\n${driverProcesses()}`,
    `the driver's log, last 40 lines:\n${logTail}`,
    `the run's temp folder (${folders.temp}):\n${filesUnder(folders.temp).map((path) => `  ${path}`).join("\n")}`,
    `the run's web-view folder (${folders.webview}):\n${filesUnder(folders.webview).map((path) => `  ${path}`).join("\n")}`,
  ].join("\n\n");
}

test("the_driver_attaches_only_to_the_instance_it_started", { skip: SKIP, timeout: 180_000 }, async (t) => {
  const exe = setting("PETALOCK_E2E_APP");
  const folders = runFolder("driven");
  const handle = await app.startPetalock({ tauriDriver: setting("PETALOCK_E2E_TAURI_DRIVER"), nativeDriver: setting("PETALOCK_E2E_NATIVE_DRIVER"), tempDir: folders.temp, webviewDir: folders.webview, logFile: folders.log });
  const base = `http://127.0.0.1:${handle.port}`;
  let session;
  let passed = false;
  try {
    // a look at the processes 20 seconds into the wait, read only when no session is made
    let whileWaiting;
    const look = setTimeout(() => {
      whileWaiting = driverProcesses();
    }, 20_000);
    let status;
    let text;
    try {
      const response = await fetch(`${base}/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ capabilities: { alwaysMatch: { "tauri:options": { application: exe } } } }),
      });
      status = response.status;
      text = await response.text();
    } catch (error) {
      text = `(no answer: ${error.message})`;
    } finally {
      clearTimeout(look);
    }
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    if (status !== 200 || body?.value?.sessionId === undefined) {
      assert.fail(`a session was made: ${String(status)} (${text.slice(0, 300)})\n\n${drivenLaunchReport(folders, whileWaiting)}`);
    }
    session = body.value.sessionId;
    const caps = body.value.capabilities;
    if (process.env.PETALOCK_E2E_OFFSCREEN === "1") {
      const moved = await fetch(`${base}/session/${session}/window/rect`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ x: -4000, y: -4000 }),
      });
      assert.equal(moved.status, 200, "the window was moved off screen through WebDriver");
    }
    const snapshot = app.snapshotProcesses();
    const listeners = app.tcpListeners();
    const attached = app.checkAttached({
      debuggerAddress: caps["ms:edgeOptions"]?.debuggerAddress,
      processId: caps["goog:processID"],
      driver: { pid: handle.pid, created: handle.created },
      snapshot,
      listeners,
    });
    // the same probe as the normal launch's sees the port here, so it can fire
    const appRoot = { pid: attached.pid, created: snapshot.find((entry) => entry.pid === attached.pid).created };
    const seen = app.listenersOfTree([appRoot], snapshot, listeners);
    assert.ok(seen.some((entry) => entry.port === attached.port && entry.address === "127.0.0.1"), "driven, the probe sees the debugging port, on loopback");
    assert.ok(seen.every((entry) => entry.address === "127.0.0.1"), "and nothing the app tree listens on is reachable from outside this PC");
    // the driver's own ports belong to the driver and msedgedriver, not to the app
    assert.equal(seen.some((entry) => entry.port === handle.port || entry.port === handle.nativePort), false);
    // the app has what the driver gives it, and its web-view data is in the run's own folder
    const lines = app.commandLines(app.treeOf([appRoot], snapshot).map((entry) => entry.pid));
    assert.ok([...lines.values()].some((line) => /remote-debugging-port=0/.test(line)), "the web view of the driven app has the debugging option");
    // msedgedriver keeps the web view's data in a folder named for its own process: inside the run's temp folder, or,
    // elevated (the GitHub job), in Windows' SystemTemp, where an elevated msedgedriver puts it whatever TEMP says
    const msedgedriver = app.treeOf([{ pid: handle.pid, created: handle.created }], snapshot).filter((entry) => entry.name.toLowerCase() === "msedgedriver.exe");
    assert.equal(msedgedriver.length, 1, "one msedgedriver runs below the driver this run started");
    const named = dataFolders(lines);
    assert.ok(named.length >= 1, "the driven app's web view names its data folder");
    const driverFolder = dirname(named[0]);
    assert.match(basename(driverFolder), new RegExp(`^scoped_dir${msedgedriver[0].pid}_\\d+$`), "the data folder is inside the folder of this run's msedgedriver");
    const expectedParent = handle.elevated ? join(process.env.SystemRoot ?? "C:\\Windows", "SystemTemp") : folders.temp;
    assert.equal(longForm(dirname(driverFolder)).toLowerCase(), longForm(expectedParent).toLowerCase(), `msedgedriver's folder is in ${handle.elevated ? "SystemTemp (elevated)" : "the run's temp folder"}`);
    assertRunOwnedWebViews(app.treeOf([appRoot], snapshot), lines, driverFolder, "driven launch");
    assert.ok(existsSync(join(driverFolder, "EBWebView")), "the web view's data folder (EBWebView) is inside msedgedriver's folder");
    const filled = countEntries(join(driverFolder, "EBWebView"));
    assert.ok(filled >= 5, `the run's web-view folder filled (${filled} entries)`);
    t.diagnostic(`the run's web-view folder holds ${filled} entries; every web-view process of the driven app names it${handle.elevated ? " (elevated: msedgedriver's folder is in SystemTemp, the switch came from the machine policy)" : ""}`);
    // ending the session ends the app and its web view
    await fetch(`${base}/session/${session}`, { method: "DELETE" });
    session = undefined;
    let left = app.treeOf([appRoot], app.snapshotProcesses());
    for (let tries = 0; left.length > 0 && tries < 30; tries += 1) {
      await sleep(500);
      left = app.treeOf([appRoot], app.snapshotProcesses());
    }
    assert.equal(left.length, 0, "ending the session closed the app and its web view");
    passed = true;
  } finally {
    if (session) await fetch(`${base}/session/${session}`, { method: "DELETE" }).catch(() => {});
    const outcome = app.stopPetalock(handle);
    // after a failure, a leftover is said and the failure itself stays the one reported
    if (passed) assert.deepEqual(outcome.remaining, [], "the driver and what it started are stopped");
    else if (outcome.remaining.length > 0) t.diagnostic(`left running after the failure: ${outcome.remaining.join(", ")}`);
  }
});
