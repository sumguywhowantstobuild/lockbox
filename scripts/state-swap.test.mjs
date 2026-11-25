// Tests for e2e/lib/state.mjs. Every test builds its own disposable folders under the system's temp folder and hands
// them to the helpers as the locations; nothing here is ever called with the real locations. Every comparison counts
// what it compared and fails on zero.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import * as state from "../e2e/lib/state.mjs";

const MODULE = fileURLToPath(new URL("../e2e/lib/state.mjs", import.meta.url));
const KEYS = state.LOCATION_KEYS;
const SENTINEL = ".lockbox-test-swap.json";
const RUN = "t1";

// ---- disposable worlds --------------------------------------------------------------------------------------------

/** A few files and a subfolder, so a comparison has something to count. Everything here is made up. */
function fillFolder(dir, label) {
  mkdirSync(join(dir, "sub", "deeper"), { recursive: true });
  mkdirSync(join(dir, "sub", "MU-empty-folder"));
  writeFileSync(join(dir, "MU-note.txt"), `Made-up note for ${label}\n`);
  writeFileSync(join(dir, "sub", "MU-data.bin"), Buffer.from(Array.from({ length: 256 }, (_, i) => (i + label.length) % 256)));
  writeFileSync(join(dir, "sub", "deeper", "MU-empty.txt"), "");
}

/**
 * Four locations (as defaultLocations lays them out) under a new temp folder, each filled except those in `absent`.
 * `kept` lists locations that also have a kept test state for RUN. The root is checked to be inside the temp folder.
 */
function makeWorld({ absent = [], kept = [] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "state-swap-"));
  assert.ok(root.startsWith(tmpdir()), "the world must sit inside the temp folder");
  const env = { LOCALAPPDATA: join(root, "local"), APPDATA: join(root, "roaming"), USERPROFILE: join(root, "profile") };
  for (const dir of Object.values(env)) mkdirSync(dir);
  const locations = state.locationsFrom({ localAppData: env.LOCALAPPDATA, roamingAppData: env.APPDATA, profile: env.USERPROFILE });
  for (const key of KEYS) {
    assert.ok(locations[key].startsWith(root), `${key} must sit inside the world`);
    if (!absent.includes(key)) fillFolder(locations[key], key);
    if (kept.includes(key)) {
      fillFolder(`${locations[key]}.test-${RUN}`, `kept-${key}`);
      writeFileSync(join(`${locations[key]}.test-${RUN}`, "MU-from-an-earlier-run.txt"), `Made-up test state ${key}\n`);
    }
  }
  // beside the vaults folder in the profile: the one place every terminal sees alike (a packaged app's AppData is private)
  const journal = join(env.USERPROFILE, "Petalock Vaults.swap-journal.json");
  const links = [];
  const world = {
    root,
    env,
    locations,
    journal,
    links,
    options: (extra = {}) => ({ locations, journal, isRunning: () => false, ...extra }),
    swapIn: (run = RUN, extra) => state.swapIn(run, world.options(extra)),
    swapBack: (run = RUN, extra) => state.swapBack(run, world.options(extra)),
    recover: (extra) => state.recover(world.options(extra)),
    status: (extra) => state.status(world.options(extra)),
    aside: (key, run = RUN) => `${locations[key]}.aside-${run}`,
    kept: (key, run = RUN) => `${locations[key]}.test-${run}`,
  };
  return world;
}

function withWorld(config, fn) {
  const world = makeWorld(config);
  try {
    return fn(world);
  } finally {
    // every junction and link goes first, on its own, so that removing the folders can never reach what it points to
    removeLinks(world.root);
    rmSync(world.root, { recursive: true, force: true });
  }
}

/** Removes the links under `dir` (a link is never followed), wherever a test left them, even after one was renamed. */
function removeLinks(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const info = lstatSync(full);
    if (info.isSymbolicLink()) {
      try {
        unlinkSync(full);
      } catch {
        rmdirSync(full);
      }
    } else if (info.isDirectory()) {
      removeLinks(full);
    }
  }
}

const FAMILY = "Claude_MUfamily0test";

/**
 * Makes `keys` look like the packaged app's private copy: the folder lives at
 * `Packages/<family>/LocalCache/{Local|Roaming}/<leaf>` under the local root, and the spelled location is a junction to
 * it, which is how a test fakes "the same folder by identity" on disk. Returns each key's copy path.
 */
function packageLocations(world, keys, family = FAMILY) {
  const copies = {};
  for (const key of keys) {
    const part = key === "appRoaming" ? "Roaming" : "Local";
    const copy = join(world.env.LOCALAPPDATA, "Packages", family, "LocalCache", part, basename(world.locations[key]));
    mkdirSync(dirname(copy), { recursive: true });
    if (existsSync(world.locations[key])) renameSync(world.locations[key], copy);
    else fillFolder(copy, key);
    symlinkSync(copy, world.locations[key], "junction");
    copies[key] = copy;
  }
  return copies;
}

/** Every entry under `dir` (links not followed): relative path to "dir", "link" or "file:<size>:<sha256>". */
function snapshot(dir) {
  const found = new Map();
  const walk = (current) => {
    for (const name of readdirSync(current).sort()) {
      const full = join(current, name);
      const key = relative(dir, full);
      const info = lstatSync(full);
      if (info.isSymbolicLink()) found.set(key, "link");
      else if (info.isDirectory()) {
        found.set(key, "dir");
        walk(full);
      } else {
        const bytes = readFileSync(full);
        found.set(key, `file:${bytes.length}:${createHash("sha256").update(bytes).digest("hex")}`);
      }
    }
  };
  walk(dir);
  return found;
}

/** Fails when the two snapshots differ, or when there is nothing in them to compare. Returns how many entries matched. */
function assertSame(before, after, what) {
  assert.ok(before.size >= 3, `${what}: compared only ${before.size} entries, nothing to trust`);
  assert.deepEqual([...after].sort(), [...before].sort(), `${what}: differs`);
  return before.size;
}

/** What a test run would leave in each place: a made-up file in every location, the folder created when it was absent. */
function simulateTestRun(world) {
  for (const key of KEYS) {
    fillFolder(world.locations[key], `test-${key}`);
    writeFileSync(join(world.locations[key], `MU-test-${key}.txt`), `Made-up test data for ${key}\n`);
  }
}

class Interrupted extends Error {}

/** An afterStep hook that throws at the `n`th step (counting from 1), and counts every step it sees. */
function interruptAt(n) {
  const hook = (label) => {
    hook.count += 1;
    hook.labels.push(label);
    if (hook.count === n) throw new Interrupted(label);
  };
  hook.count = 0;
  hook.labels = [];
  return hook;
}

/** Runs `fn`; true when it was cut short by the hook. */
function wasInterrupted(fn) {
  try {
    fn();
  } catch (error) {
    if (error instanceof Interrupted) return true;
    throw error;
  }
  return false;
}

/** Runs `recover` in a separate node process: a new process that has only the journal and the sentinels to go on. */
function recoverInNewProcess(world, extra = {}) {
  const code = [
    "const m = await import(process.argv[1]);",
    "const o = JSON.parse(process.argv[2]);",
    "try { const r = m.recover({ ...o, isRunning: () => false });",
    "console.log(JSON.stringify(r.lines)); }",
    "catch (e) { console.log(JSON.stringify(e.lines ?? [String(e)])); process.exitCode = 1; }",
  ].join(" ");
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", code, pathToFileURL(MODULE).href, JSON.stringify({ locations: world.locations, journal: world.journal, ...extra })],
    { encoding: "utf8" },
  );
  return { status: result.status, lines: JSON.parse(result.stdout.trim().split("\n").pop()), stderr: result.stderr };
}

const refusedWith = (fn, pattern) =>
  assert.throws(fn, (error) => error instanceof state.SwapRefused && pattern.test(error.lines.join("\n")));

// ---- the checks of the checks -------------------------------------------------------------------------------------

test("the comparison fails on a changed byte, on a rename and on nothing at all", () =>
  withWorld({}, (world) => {
    const dir = world.locations.state;
    const before = snapshot(dir);
    assert.ok(assertSame(before, snapshot(dir), "same tree") >= 3);
    const file = join(dir, "sub", "MU-data.bin");
    const bytes = readFileSync(file);
    bytes[0] ^= 1;
    writeFileSync(file, bytes);
    assert.throws(() => assertSame(before, snapshot(dir), "a flipped byte"), /differs/);
    const empty = join(world.root, "empty");
    mkdirSync(empty);
    assert.throws(() => assertSame(snapshot(empty), snapshot(empty), "two empty folders"), /nothing to trust/);
  }));

// ---- locations, names, the running check ---------------------------------------------------------------------------

test("default locations are the four real places, from Windows' folders, and match the app's identifier", () => {
  const env = { LOCALAPPDATA: join(tmpdir(), "MU-local"), APPDATA: join(tmpdir(), "MU-roaming"), USERPROFILE: join(tmpdir(), "MU-profile") };
  const lookup = () => ({ localAppData: env.LOCALAPPDATA, roamingAppData: env.APPDATA, profile: env.USERPROFILE });
  const found = state.defaultLocations({ env, lookup });
  assert.deepEqual(Object.keys(found), ["state", "appLocal", "appRoaming", "vaults"]);
  const config = JSON.parse(readFileSync(new URL("../crates/petalock-desktop/tauri.conf.json", import.meta.url), "utf8"));
  assert.ok(typeof config.identifier === "string" && config.identifier.length > 0);
  assert.equal(found.state, join(env.LOCALAPPDATA, "Petalock"));
  assert.equal(found.appLocal, join(env.LOCALAPPDATA, config.identifier));
  assert.equal(found.appRoaming, join(env.APPDATA, config.identifier));
  assert.equal(found.vaults, join(env.USERPROFILE, "Petalock Vaults"));
  // The folders the swap sets aside are the new product's: the identifier ends in petalock, not the old name.
  assert.equal(config.identifier, "io.github.sumguywhowantstobuild.petalock");
  assert.deepEqual(state.locationsFrom(lookup()), found);
  if (process.platform === "win32") {
    const shouty = Object.fromEntries(Object.entries(env).map(([k, v]) => [k, v.toUpperCase()]));
    assert.deepEqual(state.defaultLocations({ env: shouty, lookup }), found, "the case of a path makes no difference on Windows");
  }
});

test("a variable that disagrees with Windows' folder, is missing or is relative is refused, naming the variable", () => {
  const env = { LOCALAPPDATA: join(tmpdir(), "MU-local"), APPDATA: join(tmpdir(), "MU-roaming"), USERPROFILE: join(tmpdir(), "MU-profile") };
  const lookup = () => ({ localAppData: env.LOCALAPPDATA, roamingAppData: env.APPDATA, profile: env.USERPROFILE });
  let refused = 0;
  for (const name of Object.keys(env)) {
    for (const value of [undefined, "", "relative", join(tmpdir(), "MU-stale")]) {
      assert.throws(
        () => state.defaultLocations({ env: { ...env, [name]: value }, lookup }),
        (e) => e instanceof state.SwapRefused && e.message.includes(name),
      );
      refused += 1;
    }
  }
  assert.equal(refused, 12);
  // a lookup that can't answer refuses too
  assert.throws(() => state.defaultLocations({ env, lookup: () => { throw new state.SwapRefused("no answer"); } }), /no answer/);
});

test("the real known-folder lookup answers with full paths that agree with this shell's environment", { skip: process.platform !== "win32" }, () => {
  // a read-only question to Windows: nothing is opened, renamed or written at these paths
  const folders = state.knownFolders();
  assert.deepEqual(Object.keys(folders), ["localAppData", "roamingAppData", "profile"]);
  for (const value of Object.values(folders)) assert.ok(isAbsolute(value));
  const found = state.defaultLocations();
  assert.deepEqual(Object.keys(found), ["state", "appLocal", "appRoaming", "vaults"]);
  for (const value of Object.values(found)) assert.ok(isAbsolute(value));
});

test("system programs are named by their full path under System32, whatever the search path says", () => {
  assert.equal(state.systemTool("tasklist.exe", { SystemRoot: "D:\\Win" }), join("D:\\Win", "System32", "tasklist.exe"));
  for (const bad of [undefined, "", "relative", ".", "System32"]) {
    assert.equal(state.systemTool("tasklist.exe", { SystemRoot: bad }), join("C:\\Windows", "System32", "tasklist.exe"));
  }
  for (const found of [state.systemTool("tasklist.exe"), state.systemTool(join("WindowsPowerShell", "v1.0", "powershell.exe"))]) {
    assert.ok(isAbsolute(found), found);
  }
});

test("a run name is 1 to 40 of a-z, 0-9 and -, else refused with nothing renamed", () =>
  withWorld({}, (world) => {
    const before = snapshot(world.root);
    let refused = 0;
    for (const bad of ["", "A", "a b", "../x", "a_b", "a.b", "x".repeat(41), "é", null, 7]) {
      refusedWith(() => world.swapIn(bad), /run name/);
      refusedWith(() => world.swapBack(bad), /run name/);
      refused += 2;
    }
    assert.equal(refused, 20);
    assertSame(before, snapshot(world.root), "after refused names");
    world.swapIn("a-1");
    world.swapBack("a-1");
    world.swapIn("x".repeat(40));
    world.swapBack("x".repeat(40));
  }));

test("swap_refuses_while_petalock_runs", () =>
  withWorld({}, (world) => {
    const before = snapshot(world.root);
    for (const isRunning of [() => true, () => { throw new Error("tasklist is gone"); }, () => undefined, () => "no", () => 0]) {
      refusedWith(() => world.swapIn(RUN, { isRunning }), /running|could not check/);
      assertSame(before, snapshot(world.root), "swap in refused");
    }
    assert.ok(!existsSync(world.journal));

    world.swapIn();
    const during = snapshot(world.root);
    for (const isRunning of [() => true, () => { throw new Error("no"); }]) {
      refusedWith(() => world.swapBack(RUN, { isRunning }), /running|could not check/);
      assertSame(during, snapshot(world.root), "swap back refused");
      refusedWith(() => world.recover({ isRunning }), /running|could not check/);
      assertSame(during, snapshot(world.root), "recover refused");
    }
    world.swapBack();
    assertSame(before, snapshot(world.root), "round trip afterwards");
  }));

test("recover with no journal says nothing to recover and changes nothing, even while Petalock runs", () =>
  withWorld({}, (world) => {
    const before = snapshot(world.root);
    const result = world.recover({ isRunning: () => true });
    assert.deepEqual(result.lines, ["nothing to recover"]);
    assertSame(before, snapshot(world.root), "after recover with no journal");
  }));

test("program_name_is_the_built_exe: the scripts look for the program file the build makes", () => {
  // Plan 5 Task 0c's review: the running-app check was proved only on a copy of Node given the old name. The name it
  // looks for is the one Cargo builds (`[[bin]]`) and Tauri bundles (`mainBinaryName`).
  const cargo = readFileSync(new URL("../crates/petalock-desktop/Cargo.toml", import.meta.url), "utf8");
  const bin = /\[\[bin\]\]\s*\nname = "([^"]+)"/.exec(cargo);
  assert.ok(bin !== null, "Cargo.toml names its program file");
  const config = JSON.parse(readFileSync(new URL("../crates/petalock-desktop/tauri.conf.json", import.meta.url), "utf8"));
  assert.equal(`${bin[1]}.exe`, state.PROGRAM);
  assert.equal(`${config.mainBinaryName}.exe`, state.PROGRAM);
  assert.equal(state.PROGRAM, "petalock.exe");
});

test("the real check for a running Petalock reads tasklist's answer", () => {
  assert.equal(state.parseTasklist('"petalock.exe","4242","Console","1","90,000 K"\r\n'), true);
  assert.equal(state.parseTasklist('"PETALOCK.EXE","4242","Console","1","90,000 K"'), true);
  assert.equal(state.parseTasklist("INFO: No tasks are running which match the specified criteria.\r\n"), false);
  assert.equal(state.parseTasklist('"notepad.exe","1","Console","1","1 K"'), false);
  if (process.platform === "win32") assert.equal(typeof state.isPetalockRunning(), "boolean");
});

// ---- swapping in --------------------------------------------------------------------------------------------------

test("swap_in_sets_aside_with_a_sentinel", () =>
  withWorld({ absent: ["appRoaming"] }, (world) => {
    const originals = Object.fromEntries(KEYS.filter((k) => k !== "appRoaming").map((k) => [k, snapshot(world.locations[k])]));
    world.swapIn();
    let compared = 0;
    for (const key of KEYS) {
      if (key === "appRoaming") {
        assert.ok(!existsSync(world.locations[key]) && !existsSync(world.aside(key)), "an absent original stays absent");
        continue;
      }
      assert.ok(!existsSync(world.locations[key]), `${key}: the place is empty, the app starts fresh`);
      const sentinel = JSON.parse(readFileSync(join(world.aside(key), SENTINEL), "utf8"));
      assert.deepEqual(sentinel, { lockboxTestSwap: 1, run: RUN, key });
      const aside = snapshot(world.aside(key));
      assert.ok(aside.delete(SENTINEL));
      compared += assertSame(originals[key], aside, `${key} set aside`);
    }
    assert.ok(compared >= 9);
    const journal = JSON.parse(readFileSync(world.journal, "utf8"));
    assert.equal(journal.run, RUN);
    assert.deepEqual(journal.locations.map((l) => [l.key, l.original]), [
      ["state", "present"], ["appLocal", "present"], ["appRoaming", "absent"], ["vaults", "present"],
    ]);
    assert.ok(!existsSync(`${world.journal}.tmp`));
  }));

test("a junction or symlink is refused before any rename", () => {
  for (const linked of KEYS) {
    withWorld({}, (world) => {
      const target = join(world.root, "elsewhere");
      fillFolder(target, "target");
      rmSync(world.locations[linked], { recursive: true });
      symlinkSync(target, world.locations[linked], "junction");
      world.links.push(world.locations[linked]);
      const before = snapshot(world.root);
      refusedWith(() => world.swapIn(), new RegExp(`${linked} is a link`));
      assertSame(before, snapshot(world.root), `junction at ${linked}`);
      assert.ok(!existsSync(world.journal));
      assert.ok(!existsSync(join(target, SENTINEL)), "the link's target was not marked");
    });
  }
});

test("a kept test state that is a link, or a folder already at an aside name, is refused before any rename", () =>
  withWorld({}, (world) => {
    const target = join(world.root, "elsewhere");
    fillFolder(target, "target");
    symlinkSync(target, world.kept("vaults"), "junction");
    world.links.push(world.kept("vaults"));
    const before = snapshot(world.root);
    refusedWith(() => world.swapIn(), /kept test state of vaults/);
    assertSame(before, snapshot(world.root), "a kept state that is a link");
    unlinkSync(world.kept("vaults"));
    world.links.pop();

    fillFolder(world.aside("appLocal"), "stray");
    const strayed = snapshot(world.root);
    refusedWith(() => world.swapIn(), /already at the set-aside name of appLocal/);
    assertSame(strayed, snapshot(world.root), "a folder at an aside name");
  }));

test("locations that nest, a missing parent, a taken sentinel name and a journal inside a location are refused", () => {
  withWorld({}, (world) => {
    const before = snapshot(world.root);
    const inner = { ...world.locations, vaults: join(world.locations.state, "Petalock Vaults") };
    refusedWith(() => state.swapIn(RUN, world.options({ locations: inner })), /inside the other/);
    refusedWith(() => state.swapIn(RUN, world.options({ locations: { state: world.locations.state } })), /exactly/);
    refusedWith(() => state.swapIn(RUN, world.options({ locations: { ...world.locations, vaults: "relative" } })), /full path/);
    refusedWith(() => state.swapIn(RUN, world.options({ journal: join(world.locations.state, "journal.json") })), /journal would sit inside state/);
    const orphan = { ...world.locations, vaults: join(world.root, "no-such-parent", "Petalock Vaults") };
    refusedWith(() => state.swapIn(RUN, world.options({ locations: orphan })), /does not exist/);
    assertSame(before, snapshot(world.root), "after refused layouts");
  });
  withWorld({}, (world) => {
    writeFileSync(join(world.locations.appLocal, SENTINEL), "not ours\n");
    const before = snapshot(world.root);
    refusedWith(() => world.swapIn(), /appLocal already holds a swap sentinel/);
    assertSame(before, snapshot(world.root), "a sentinel name already taken");
  });
});

test("a swap already in progress refuses another, for the same run or any other", () =>
  withWorld({}, (world) => {
    world.swapIn();
    const during = snapshot(world.root);
    refusedWith(() => world.swapIn(RUN), /already in progress/);
    refusedWith(() => world.swapIn("other"), /already in progress \(run t1\)/);
    assertSame(during, snapshot(world.root), "second swap in");
    refusedWith(() => world.swapBack("other"), /for run t1, not other/);
    assertSame(during, snapshot(world.root), "swap back of another run");
    world.swapBack();
    refusedWith(() => world.swapBack(), /no swap is in progress/);
  }));

// ---- round trips ---------------------------------------------------------------------------------------------------

test("swap in then swap back puts every original back byte for byte and keeps the test state for the next time", () =>
  withWorld({ absent: ["appRoaming"] }, (world) => {
    const before = snapshot(world.root);
    const originals = Object.fromEntries(KEYS.filter((k) => k !== "appRoaming").map((k) => [k, snapshot(world.locations[k])]));

    world.swapIn();
    simulateTestRun(world);
    world.swapBack();

    let compared = 0;
    for (const key of KEYS.filter((k) => k !== "appRoaming")) {
      compared += assertSame(originals[key], snapshot(world.locations[key]), `${key} after the round trip`);
      assert.ok(!existsSync(join(world.locations[key], SENTINEL)), `${key}: the sentinel is gone`);
    }
    assert.ok(compared >= 9);
    assert.ok(!existsSync(world.journal) && !existsSync(`${world.journal}.tmp`), "the journal is gone");
    // the originally absent location holds a test-created folder, which was kept and nothing was put back
    assert.ok(!existsSync(world.locations.appRoaming));
    const keptStates = new Map();
    for (const key of KEYS) {
      assert.ok(existsSync(join(world.kept(key), `MU-test-${key}.txt`)), `${key}: test state kept`);
      keptStates.set(key, snapshot(world.kept(key)));
    }
    assert.equal(keptStates.size, 4);
    for (const key of KEYS) assert.ok(!existsSync(world.aside(key)), `${key}: no aside folder is left`);

    // the same run again: the kept test state goes into place, and everything is put back once more
    world.swapIn();
    for (const key of KEYS) {
      assertSame(keptStates.get(key), snapshot(world.locations[key]), `${key}: the kept test state is reused`);
      assert.ok(!existsSync(world.kept(key)));
    }
    world.swapBack();
    for (const key of KEYS.filter((k) => k !== "appRoaming")) assertSame(originals[key], snapshot(world.locations[key]), `${key} again`);
    for (const key of KEYS) assertSame(keptStates.get(key), snapshot(world.kept(key)), `${key}: kept again`);
    assert.notDeepEqual([...snapshot(world.root)], [...before], "the kept test state is the only difference");
  }));

test("the journal and the lock sit beside the vaults folder in the profile by default, where every terminal sees them", () =>
  withWorld({}, (world) => {
    const options = {
      locations: world.locations,
      isRunning: () => false,
      afterStep: (step) => {
        if (step === "journal written") {
          assert.ok(existsSync(join(world.env.USERPROFILE, "Petalock Vaults.swap-journal.json.lock")), "the lock is beside the journal");
        }
      },
    };
    state.swapIn(RUN, options);
    assert.ok(existsSync(join(world.env.USERPROFILE, "Petalock Vaults.swap-journal.json")));
    assert.ok(!existsSync(join(world.env.LOCALAPPDATA, "Petalock.swap-journal.json")), "nothing in AppData");
    assert.ok(!existsSync(join(world.env.USERPROFILE, "Petalock Vaults.swap-journal.json.lock")));
    state.swapBack(RUN, options);
    assert.ok(!existsSync(join(world.env.USERPROFILE, "Petalock Vaults.swap-journal.json")));
  }));

test("a vaults folder that puts the default journal inside another location is refused", () =>
  withWorld({}, (world) => {
    const before = snapshot(world.root);
    const inside = { ...world.locations, vaults: join(world.locations.appLocal, "Petalock Vaults") };
    refusedWith(() => state.swapIn(RUN, { locations: inside, isRunning: () => false }), /journal would sit inside appLocal/);
    assertSame(before, snapshot(world.root), "the layout is refused");
  }));

test("swap back keeps another run's test state alone", () =>
  withWorld({}, (world) => {
    fillFolder(world.kept("state", "other"), "other-run");
    const other = snapshot(world.kept("state", "other"));
    world.swapIn();
    assert.ok(!existsSync(world.locations.state), "a different run's state is not used");
    world.swapBack();
    assertSame(other, snapshot(world.kept("state", "other")), "another run's kept state");
  }));

// ---- interruptions ------------------------------------------------------------------------------------------------

test("interrupted_between_the_two_renames_recovers", () =>
  withWorld({ absent: ["appRoaming"], kept: ["state", "appRoaming"] }, (world) => {
    const before = snapshot(world.root);
    const originals = Object.fromEntries(KEYS.filter((k) => k !== "appRoaming").map((k) => [k, snapshot(world.locations[k])]));
    // the original is renamed aside, and the process dies before the test state goes into its place
    assert.ok(wasInterrupted(() => world.swapIn(RUN, { afterStep: (label) => { if (label === "state: original set aside") throw new Interrupted(label); } })));
    assert.ok(!existsSync(world.locations.state) && existsSync(world.aside("state")) && existsSync(world.kept("state")));
    assert.ok(existsSync(join(world.aside("state"), SENTINEL)), "the sentinel was written before the rename");

    const recovered = recoverInNewProcess(world);
    assert.equal(recovered.status, 0, recovered.lines.join("\n"));
    let compared = 0;
    for (const key of KEYS.filter((k) => k !== "appRoaming")) {
      compared += assertSame(originals[key], snapshot(world.locations[key]), `${key} after a new process recovered`);
    }
    assert.ok(compared >= 9);
    assertSame(before, snapshot(world.root), "the whole tree after recovery");
    assert.ok(!existsSync(world.journal));
  }));

test("interrupted_during_swap_back_recovers", () =>
  withWorld({ absent: ["appRoaming"] }, (world) => {
    const originals = Object.fromEntries(KEYS.filter((k) => k !== "appRoaming").map((k) => [k, snapshot(world.locations[k])]));
    world.swapIn();
    simulateTestRun(world);
    // the test state is kept and the process dies before the original is renamed back
    assert.ok(wasInterrupted(() => world.swapBack(RUN, { afterStep: (label) => { if (label === "appLocal: test state kept") throw new Interrupted(label); } })));
    assert.ok(!existsSync(world.locations.appLocal) && existsSync(world.aside("appLocal")), "stopped between the two renames");

    const recovered = recoverInNewProcess(world);
    assert.equal(recovered.status, 0, recovered.lines.join("\n"));
    let compared = 0;
    for (const key of KEYS.filter((k) => k !== "appRoaming")) {
      compared += assertSame(originals[key], snapshot(world.locations[key]), `${key} after a new process recovered`);
      assert.ok(!existsSync(join(world.locations[key], SENTINEL)), `${key}: the sentinel is gone`);
    }
    assert.ok(compared >= 9);
    for (const key of KEYS) assert.ok(existsSync(join(world.kept(key), `MU-test-${key}.txt`)), `${key}: test state kept`);
    assert.ok(!existsSync(world.journal));
  }));

test("an interruption after any step of swap in is recovered", () => {
  const config = { absent: ["appRoaming"], kept: ["state", "appRoaming"] };
  const total = withWorld(config, (world) => {
    const counter = interruptAt(Infinity);
    world.swapIn(RUN, { afterStep: counter });
    return counter.count;
  });
  // the journal, then marked + set aside + test state in for state, appLocal's two, appRoaming's one and vaults' two
  assert.equal(total, 9, `counted ${total} steps`);
  let interruptions = 0;
  for (let n = 1; n <= total; n += 1) {
    withWorld(config, (world) => {
      const before = snapshot(world.root);
      assert.ok(wasInterrupted(() => world.swapIn(RUN, { afterStep: interruptAt(n) })), `step ${n} did not interrupt`);
      interruptions += 1;
      world.recover();
      assertSame(before, snapshot(world.root), `recovered after step ${n} of swap in`);
      assert.ok(!existsSync(world.journal));
    });
  }
  assert.equal(interruptions, total);
});

test("an interruption after any step of swap back is recovered", () => {
  const config = { absent: ["appRoaming"] };
  const setUp = (world) => {
    world.swapIn();
    simulateTestRun(world);
  };
  const total = withWorld(config, (world) => {
    setUp(world);
    const counter = interruptAt(Infinity);
    world.swapBack(RUN, { afterStep: counter });
    return counter.count;
  });
  // kept + put back + cleared for each of the three originals, and one kept for the location that had no original
  assert.equal(total, 10, `counted ${total} steps`);
  let interruptions = 0;
  for (let n = 1; n <= total; n += 1) {
    withWorld(config, (world) => {
      const originals = Object.fromEntries(KEYS.filter((k) => k !== "appRoaming").map((k) => [k, snapshot(world.locations[k])]));
      // the originals are the ones set aside, so read them from there after the swap in
      setUp(world);
      for (const key of Object.keys(originals)) {
        const aside = snapshot(world.aside(key));
        assert.ok(aside.delete(SENTINEL));
        originals[key] = aside;
      }
      assert.ok(wasInterrupted(() => world.swapBack(RUN, { afterStep: interruptAt(n) })), `step ${n} did not interrupt`);
      interruptions += 1;
      world.recover();
      let compared = 0;
      for (const key of Object.keys(originals)) {
        compared += assertSame(originals[key], snapshot(world.locations[key]), `${key} after step ${n} of swap back`);
        assert.ok(!existsSync(join(world.locations[key], SENTINEL)));
      }
      assert.ok(compared >= 9);
      for (const key of KEYS) assert.ok(existsSync(join(world.kept(key), `MU-test-${key}.txt`)), `${key}: test state kept after step ${n}`);
      assert.ok(!existsSync(world.journal));
    });
  }
  assert.equal(interruptions, total);
});

test("recover can run twice: the second finds nothing to do", () =>
  withWorld({}, (world) => {
    const before = snapshot(world.root);
    assert.ok(wasInterrupted(() => world.swapIn(RUN, { afterStep: (label) => { if (label === "vaults: marked") throw new Interrupted(label); } })));
    assert.ok(existsSync(join(world.locations.vaults, SENTINEL)), "stopped with a sentinel written and nothing renamed there");
    assert.match(world.recover().lines.join("\n"), /vaults: original was in place; its marker is cleared/);
    assertSame(before, snapshot(world.root), "after the first recover");
    assert.deepEqual(world.recover().lines, ["nothing to recover"]);
    assertSame(before, snapshot(world.root), "after the second recover");
  }));

// ---- what recover must not touch ----------------------------------------------------------------------------------

test("recover_never_deletes_what_it_did_not_create", () => {
  // part 1: strays beside the aside names survive an interrupted swap in and its recovery, untouched
  withWorld({ kept: ["vaults"] }, (world) => {
    fillFolder(`${world.locations.state}.aside-other`, "stray-folder");
    writeFileSync(`${world.aside("appLocal")}.note`, "Made-up stray file\n");
    fillFolder(`${world.locations.appLocal}.test-other`, "stray-test");
    writeFileSync(join(world.root, "local", "MU-stray-file.txt"), "Made-up\n");
    const before = snapshot(world.root);
    assert.ok(before.size >= 20);
    assert.ok(wasInterrupted(() => world.swapIn(RUN, { afterStep: (label) => { if (label === "state: original set aside") throw new Interrupted(label); } })));
    world.recover();
    assertSame(before, snapshot(world.root), "strays and originals after recovery (no folder is gone)");
    assert.ok(existsSync(`${world.locations.state}.aside-other`) && existsSync(`${world.aside("appLocal")}.note`));
  });

  // part 2: a folder at an aside name with no matching sentinel, or another run's, is left in place and reported
  for (const [tamper, testStateInPlace] of [["removed", false], ["other run", false], ["removed", true], ["other run", true]]) {
    withWorld({}, (world) => {
      const originals = Object.fromEntries(KEYS.map((k) => [k, snapshot(world.locations[k])]));
      world.swapIn();
      // with the test state in place, any folder there must not be taken for the original
      if (testStateInPlace) simulateTestRun(world);
      const sentinelFile = join(world.aside("state"), SENTINEL);
      if (tamper === "removed") unlinkSync(sentinelFile);
      else writeFileSync(sentinelFile, `${JSON.stringify({ lockboxTestSwap: 1, run: "other", key: "state" })}\n`);
      const asideBefore = snapshot(world.aside("state"));

      assert.throws(
        () => world.recover(),
        (error) => {
          assert.ok(error instanceof state.SwapRefused);
          const text = error.lines.join("\n");
          assert.match(text, /state: .*no folder set aside by run t1 was found.*no sentinel for this run/);
          assert.ok(!text.includes(world.root), "no path in the words");
          return true;
        },
      );
      assertSame(asideBefore, snapshot(world.aside("state")), `the unmarked folder (${tamper}) is left where it is`);
      if (testStateInPlace) {
        assert.ok(existsSync(join(world.locations.state, "MU-test-state.txt")), "the test state was not mistaken for the original and not moved");
        assert.ok(!existsSync(world.kept("state")));
      } else {
        assert.ok(!existsSync(world.locations.state));
      }
      assert.ok(existsSync(world.journal), "the journal stays while something is unresolved");
      for (const key of KEYS.filter((k) => k !== "state")) assertSame(originals[key], snapshot(world.locations[key]), `${key} was put back`);

      // once a person restores the sentinel, recovery finishes
      writeFileSync(sentinelFile, `${JSON.stringify({ lockboxTestSwap: 1, run: RUN, key: "state" })}\n`);
      world.recover();
      assertSame(originals.state, snapshot(world.locations.state), "state after the sentinel was restored");
      assert.ok(!existsSync(world.journal));
    });
  }

  // part 3: a stray at an aside name while the original never moved: the original stays, the stray is reported and left
  withWorld({}, (world) => {
    const originals = Object.fromEntries(KEYS.map((k) => [k, snapshot(world.locations[k])]));
    assert.ok(wasInterrupted(() => world.swapIn(RUN, { afterStep: interruptAt(1) })));
    fillFolder(world.aside("state"), "stray-at-aside");
    const stray = snapshot(world.aside("state"));
    const result = world.recover();
    assert.match(result.lines.join("\n"), /state: original is in place; a folder at the set-aside name has no sentinel/);
    assertSame(stray, snapshot(world.aside("state")), "the stray folder");
    for (const key of KEYS) assertSame(originals[key], snapshot(world.locations[key]), `${key} untouched`);
    assert.ok(!existsSync(world.journal));
  });
});

test("recover refuses a journal it cannot trust, renaming nothing", () => {
  const cases = [
    ["garbage", () => "not json at all"],
    ["another path", (j) => JSON.stringify({ ...j, locations: j.locations.map((l, i) => (i === 0 ? { ...l, path: join(tmpdir(), "MU-elsewhere") } : l)) })],
    ["a bad run", (j) => JSON.stringify({ ...j, run: "../x" })],
    ["a missing location", (j) => JSON.stringify({ ...j, locations: j.locations.slice(1) })],
    ["a wrong state word", (j) => JSON.stringify({ ...j, locations: j.locations.map((l) => ({ ...l, original: "maybe" })) })],
    ["another key order", (j) => JSON.stringify({ ...j, locations: [...j.locations].reverse() })],
    ["a missing identity", (j) => JSON.stringify({ ...j, locations: j.locations.map(({ identity, ...rest }) => rest) })],
    ["an identity of another shape", (j) => JSON.stringify({ ...j, locations: j.locations.map((l) => (l.identity ? { ...l, identity: { dev: "x", ino: 1 } } : l)) })],
    ["the previous journal version", (j) => JSON.stringify({ ...j, lockboxTestSwapJournal: 2 })],
    ["a redirect on the vaults", (j) => JSON.stringify({ ...j, locations: j.locations.map((l) => (l.key === "vaults" ? { ...l, redirect: FAMILY } : l)) })],
    ["a redirect with a path in it", (j) => JSON.stringify({ ...j, locations: j.locations.map((l) => (l.key === "state" ? { ...l, redirect: "..\\x" } : l)) })],
    ["a shown-through folder on an absent original", (j) => JSON.stringify({ ...j, locations: j.locations.map((l) => (l.key === "state" ? { key: l.key, path: l.path, original: "absent", shownThrough: { dev: "1", ino: "2" } } : l)) })],
    ["a shown-through folder of another shape", (j) => JSON.stringify({ ...j, locations: j.locations.map((l) => (l.key === "appLocal" ? { ...l, redirect: FAMILY, shownThrough: { dev: "x", ino: 2 } } : l)) })],
    ["a redirect that is not text", (j) => JSON.stringify({ ...j, locations: j.locations.map((l) => (l.key === "state" ? { ...l, redirect: 5 } : l)) })],
    ["an identity on an absent original", (j) => JSON.stringify({ ...j, locations: j.locations.map((l) => ({ ...l, original: "absent" })) })],
  ];
  let refused = 0;
  for (const [name, change] of cases) {
    withWorld({}, (world) => {
      world.swapIn();
      writeFileSync(world.journal, change(JSON.parse(readFileSync(world.journal, "utf8"))));
      const during = snapshot(world.root);
      refusedWith(() => world.recover(), /journal is not readable or does not match/);
      assertSame(during, snapshot(world.root), `a journal with ${name}`);
      refused += 1;
    });
  }
  assert.equal(refused, cases.length);
});

test("a folder in the original's place that is not the recorded original is never accepted as it", () =>
  withWorld({}, (world) => {
    const originals = Object.fromEntries(KEYS.map((k) => [k, snapshot(world.locations[k])]));
    assert.ok(wasInterrupted(() => world.swapIn(RUN, { afterStep: interruptAt(1) })));
    // the journal is written and nothing moved; then another folder takes the original's place
    const moved = join(world.root, "moved-state");
    renameSync(world.locations.state, moved);
    fillFolder(world.locations.state, "imposter");
    const imposter = snapshot(world.locations.state);
    assert.throws(
      () => world.recover(),
      (error) => error instanceof state.SwapRefused && /state: the original is not in its place/.test(error.lines.join("\n")),
    );
    assertSame(imposter, snapshot(world.locations.state), "the imposter stays where it is");
    assert.ok(existsSync(world.journal), "the journal is kept");
    // put things right by hand, and recovery finishes
    renameSync(world.locations.state, join(world.root, "moved-imposter"));
    renameSync(moved, world.locations.state);
    world.recover();
    assertSame(originals.state, snapshot(world.locations.state), "the real original, found by its identity");
    assert.ok(!existsSync(world.journal));
  }));

// ---- the journal's temp file ---------------------------------------------------------------------------------------

test("an unrelated file at the old temp name of the journal is never overwritten, followed or deleted", () =>
  withWorld({}, (world) => {
    const old = `${world.journal}.tmp`;
    writeFileSync(old, "Made-up unrelated file\n");
    const bytes = readFileSync(old);
    const unchanged = (when) => assert.deepEqual(readFileSync(old), bytes, `the file at the old temp name, ${when}`);
    world.swapIn();
    unchanged("after swap in");
    world.swapBack();
    unchanged("after swap back");
    assert.ok(wasInterrupted(() => world.swapIn(RUN, { afterStep: interruptAt(3) })));
    world.recover();
    unchanged("after recover");
    // nothing of this tool's was left beside it
    assert.deepEqual(readdirSync(world.env.USERPROFILE).filter((n) => n.includes("swap-journal")), ["Petalock Vaults.swap-journal.json.tmp"]);

    // a link at that name must not be followed either (a file link needs a privilege some machines don't grant)
    const target = join(world.root, "elsewhere.txt");
    writeFileSync(target, "Made-up target\n");
    unlinkSync(old);
    try {
      symlinkSync(target, old, "file");
    } catch {
      return;
    }
    world.links.push(old);
    world.swapIn();
    world.swapBack();
    assert.equal(readFileSync(target, "utf8"), "Made-up target\n");
    assert.ok(lstatSync(old).isSymbolicLink());
  }));

// ---- one command at a time ---------------------------------------------------------------------------------------

const lockFile = (world) => `${world.journal}.lock`;
const writeLock = (world, pid) => writeFileSync(lockFile(world), `${JSON.stringify({ lockboxTestSwapLock: 1, pid })}\n`);

test("a lock held by a live process refuses swap in, swap back and recover, renaming nothing", () =>
  withWorld({}, (world) => {
    const before = snapshot(world.root);
    writeLock(world, process.pid);
    const locked = snapshot(world.root);
    refusedWith(() => world.swapIn(), /another swap command is running/);
    assertSame(locked, snapshot(world.root), "swap in refused by a lock");
    unlinkSync(lockFile(world));
    assertSame(before, snapshot(world.root), "back to the start");

    world.swapIn();
    writeLock(world, process.ppid);
    const during = snapshot(world.root);
    refusedWith(() => world.swapBack(), /another swap command is running/);
    refusedWith(() => world.recover(), /another swap command is running/);
    assertSame(during, snapshot(world.root), "swap back and recover refused by a lock");
    unlinkSync(lockFile(world));
    world.swapBack();
    assertSame(before, snapshot(world.root), "after the lock was gone");
  }));

test("a lock whose process is gone is taken over, and the result says so", () => {
  const gone = spawnSync(process.execPath, ["-e", ""]).pid;
  assert.ok(Number.isInteger(gone) && gone > 0 && gone !== process.pid);
  withWorld({}, (world) => {
    const before = snapshot(world.root);
    writeLock(world, gone);
    const entered = world.swapIn();
    assert.match(entered.lines[0], /took over a lock left by a swap command that is no longer running/);
    assert.ok(!existsSync(lockFile(world)), "the lock is removed afterwards");
    writeLock(world, gone);
    assert.match(world.recover().lines[0], /took over a lock/);
    assertSame(before, snapshot(world.root), "after recover");
    world.swapIn();
    writeLock(world, gone);
    assert.match(world.swapBack().lines[0], /took over a lock/);
    assertSame(before, snapshot(world.root), "after swap back");
    assert.ok(!existsSync(lockFile(world)));
  });
});

test("a lock that can't be read is never deleted, and the command refuses", () =>
  withWorld({}, (world) => {
    for (const text of ["not json", JSON.stringify({ lockboxTestSwapLock: 1, pid: "12" }), JSON.stringify({ lockboxTestSwapLock: 1, pid: -3 }), "{}"]) {
      writeFileSync(lockFile(world), text);
      const before = snapshot(world.root);
      refusedWith(() => world.swapIn(), /lock file beside the journal is not readable/);
      assertSame(before, snapshot(world.root), `a lock of ${text.length} characters`);
    }
  }));

test("the lock is removed after a success, a refusal and an interruption, and only if it still holds this process's id", () =>
  withWorld({}, (world) => {
    world.swapIn();
    assert.ok(!existsSync(lockFile(world)));
    refusedWith(() => world.swapBack("other"), /not other/);
    assert.ok(!existsSync(lockFile(world)));
    refusedWith(() => world.swapBack(RUN, { isRunning: () => true }), /running/);
    assert.ok(!existsSync(lockFile(world)));
    world.swapBack();
    assert.ok(wasInterrupted(() => world.swapIn(RUN, { afterStep: interruptAt(2) })));
    assert.ok(!existsSync(lockFile(world)), "released when the command was cut short");
    world.recover();

    // a lock that another process has taken meanwhile is left alone
    world.swapIn(RUN, { afterStep: (label) => { if (label === "journal written") writeLock(world, process.ppid); } });
    assert.equal(JSON.parse(readFileSync(lockFile(world), "utf8")).pid, process.ppid);
    unlinkSync(lockFile(world));
    world.swapBack();
  }));

test("a recover started while swap in is moving folders is refused and leaves the journal alone", () =>
  withWorld({}, (world) => {
    const before = snapshot(world.root);
    let refusals = 0;
    world.swapIn(RUN, {
      afterStep: (label) => {
        if (label !== "state: original set aside") return;
        // a second terminal, in the middle of the first command's work
        for (const other of [() => world.recover(), () => world.swapBack(), () => world.swapIn("other-run")]) {
          refusedWith(other, /another swap command is running/);
          refusals += 1;
        }
      },
    });
    assert.equal(refusals, 3);
    assert.equal(JSON.parse(readFileSync(world.journal, "utf8")).run, RUN, "the journal is the first run's");
    world.swapBack();
    assertSame(before, snapshot(world.root), "everything back");
  }));

// ---- Petalock starting during a swap -------------------------------------------------------------------------------

/** A running check that answers false for its first `from - 1` calls and true from call number `from` on. */
function runningFrom(from) {
  const check = () => {
    check.calls += 1;
    return check.calls >= from;
  };
  check.calls = 0;
  return check;
}

test("Petalock appearing during swap in stops it with the journal kept, and recover puts everything back", () => {
  // call 1 is the first check; calls 2 to 5 come just before each of the four locations
  for (let from = 2; from <= 5; from += 1) {
    withWorld({ absent: ["appRoaming"], kept: ["state"] }, (world) => {
      const before = snapshot(world.root);
      const isRunning = runningFrom(from);
      refusedWith(() => world.swapIn(RUN, { isRunning }), /stopped with the journal kept/);
      assert.equal(isRunning.calls, from, "the check ran again before the location");
      assert.ok(existsSync(world.journal), "the journal is kept");
      assert.ok(!existsSync(lockFile(world)));
      world.recover();
      assertSame(before, snapshot(world.root), `recovered after Petalock appeared at check ${from}`);
    });
  }
  withWorld({}, (world) => {
    const isRunning = runningFrom(Infinity);
    world.swapIn(RUN, { isRunning });
    assert.equal(isRunning.calls, 5, "one check before the first look and one before each location");
  });
});

test("Petalock appearing during swap back or recover stops it with the journal kept", () => {
  for (const operation of ["swap back", "recover"]) {
    for (let from = 2; from <= 5; from += 1) {
      withWorld({ absent: ["appRoaming"] }, (world) => {
        world.swapIn();
        simulateTestRun(world);
        const originals = Object.fromEntries(KEYS.filter((k) => k !== "appRoaming").map((k) => [k, snapshot(world.aside(k))]));
        for (const snap of Object.values(originals)) assert.ok(snap.delete(SENTINEL));
        const isRunning = runningFrom(from);
        refusedWith(() => (operation === "recover" ? world.recover({ isRunning }) : world.swapBack(RUN, { isRunning })), /stopped with the journal kept/);
        assert.equal(isRunning.calls, from);
        assert.ok(existsSync(world.journal), "the journal is kept");
        world.recover();
        let compared = 0;
        for (const key of Object.keys(originals)) compared += assertSame(originals[key], snapshot(world.locations[key]), `${key} after ${operation} stopped at check ${from}`);
        assert.ok(compared >= 9);
        assert.ok(!existsSync(world.journal));
      });
    }
  }
});

// ---- overlap through a link on the way to a location ---------------------------------------------------------------

test("locations that overlap through a junction on the way are refused before any rename, absent ones included", () => {
  // 1: vaults is reached through a junction that points into the state folder
  withWorld({ absent: ["vaults"] }, (world) => {
    const via = join(world.root, "profile", "via");
    symlinkSync(world.locations.state, via, "junction");
    world.links.push(via);
    const before = snapshot(world.root);
    const locations = { ...world.locations, vaults: join(via, "Petalock Vaults") };
    refusedWith(() => state.swapIn(RUN, world.options({ locations })), /vaults and state are the same place or one is inside/);
    assertSame(before, snapshot(world.root), "vaults through a junction into state");
    assert.ok(!existsSync(world.journal));
  });
  // 2: two locations spelled differently that are one place
  withWorld({}, (world) => {
    const alias = join(world.root, "profile", "alias");
    symlinkSync(join(world.root, "local"), alias, "junction");
    world.links.push(alias);
    const before = snapshot(world.root);
    const locations = { ...world.locations, appRoaming: join(alias, basename(world.locations.appLocal)) };
    refusedWith(() => state.swapIn(RUN, world.options({ locations })), /appLocal and appRoaming are the same place/);
    assertSame(before, snapshot(world.root), "two spellings of one place");
  });
  // 3: the journal reached through a junction into a location
  withWorld({}, (world) => {
    const via = join(world.root, "profile", "via");
    symlinkSync(world.locations.state, via, "junction");
    world.links.push(via);
    const before = snapshot(world.root);
    refusedWith(() => state.swapIn(RUN, world.options({ journal: join(via, "journal.json") })), /journal would sit inside state/);
    assertSame(before, snapshot(world.root), "a journal through a junction");
  });
});

// ---- the packaged app's private copy ------------------------------------------------------------------------------

const sameFolder = (a, b) => {
  const x = statSync(a, { bigint: true });
  const y = statSync(b, { bigint: true });
  return x.dev === y.dev && x.ino === y.ino && x.ino !== 0n;
};

const journalOf = (world) => JSON.parse(readFileSync(world.journal, "utf8"));

test("a_private_copy_seen_through_a_link_is_accepted_and_round_trips_byte_for_byte", () =>
  withWorld({}, (world) => {
    const copies = packageLocations(world, ["state", "appLocal", "appRoaming"]);
    const before = snapshot(world.root);
    const copiesBefore = Object.fromEntries(Object.entries(copies).map(([key, path]) => [key, snapshot(path)]));

    const entered = world.swapIn();
    const journal = journalOf(world);
    assert.equal(journal.lockboxTestSwapJournal, 3);
    assert.deepEqual(
      journal.locations.map((l) => [l.key, l.redirect]),
      [["state", FAMILY], ["appLocal", FAMILY], ["appRoaming", FAMILY], ["vaults", undefined]],
    );
    for (const key of ["state", "appLocal", "appRoaming"]) {
      assert.ok(entered.lines.some((line) => line.startsWith(`${key}: the ${FAMILY} app's private copy`)), `${key} named in swap in`);
      assert.deepEqual(JSON.parse(readFileSync(join(world.aside(key), SENTINEL), "utf8")), { lockboxTestSwap: 1, run: RUN, key });
      assert.ok(!existsSync(world.locations[key]), `${key}: the place is empty`);
    }
    assert.ok(!entered.lines.find((line) => line.startsWith("vaults:")).includes("private copy"));
    const shown = world.status().lines;
    for (const key of ["state", "appLocal", "appRoaming"]) {
      assert.ok(shown.some((line) => line.startsWith(`${key}: the ${FAMILY} app's private copy`)), `${key} named in status`);
    }
    assert.match(shown.find((line) => line.startsWith("state:")), /set aside: a folder with this run's sentinel/);

    world.swapBack();
    let compared = 0;
    for (const key of ["state", "appLocal", "appRoaming"]) {
      compared += assertSame(copiesBefore[key], snapshot(copies[key]), `${key}'s private copy`);
      assert.ok(lstatSync(world.locations[key]).isSymbolicLink() && sameFolder(world.locations[key], copies[key]), `${key} is back`);
    }
    assert.ok(compared >= 15);
    assertSame(before, snapshot(world.root), "the whole tree");
    assert.ok(!existsSync(world.journal));
  }));

test("an interruption after any step of a private-copy swap is recovered", () => {
  const setUp = () => {
    const world = makeWorld({});
    packageLocations(world, ["state", "appLocal", "appRoaming"]);
    return world;
  };
  const run = (fn) => {
    const world = setUp();
    try {
      return fn(world);
    } finally {
      removeLinks(world.root);
      rmSync(world.root, { recursive: true, force: true });
    }
  };
  const total = run((world) => {
    const counter = interruptAt(Infinity);
    world.swapIn(RUN, { afterStep: counter });
    return counter.count;
  });
  // the journal, then marked and set aside for each of the four originals
  assert.equal(total, 9, `counted ${total} steps`);
  for (let n = 1; n <= total; n += 1) {
    run((world) => {
      const before = snapshot(world.root);
      assert.ok(wasInterrupted(() => world.swapIn(RUN, { afterStep: interruptAt(n) })), `step ${n} did not interrupt`);
      world.recover();
      assertSame(before, snapshot(world.root), `recovered after step ${n} of swap in`);
      assert.ok(!existsSync(world.journal));
    });
  }
  // and swap back: the originals are the folders the aside links point to
  const totalBack = run((world) => {
    world.swapIn();
    simulateTestRun(world);
    const counter = interruptAt(Infinity);
    world.swapBack(RUN, { afterStep: counter });
    return counter.count;
  });
  // kept, put back and cleared for each of the four originals
  assert.equal(totalBack, 12, `counted ${totalBack} steps`);
  for (let n = 1; n <= totalBack; n += 1) {
    run((world) => {
      const copies = Object.fromEntries(["state", "appLocal", "appRoaming"].map((key) => [key, join(world.env.LOCALAPPDATA, "Packages", FAMILY, "LocalCache", key === "appRoaming" ? "Roaming" : "Local", basename(world.locations[key]))]));
      const copiesBefore = Object.fromEntries(Object.entries(copies).map(([key, path]) => [key, snapshot(path)]));
      world.swapIn();
      simulateTestRun(world);
      assert.ok(wasInterrupted(() => world.swapBack(RUN, { afterStep: interruptAt(n) })), `step ${n} did not interrupt`);
      world.recover();
      let compared = 0;
      for (const key of Object.keys(copies)) {
        // the sentinel went in through the link and must be gone again
        compared += assertSame(copiesBefore[key], snapshot(copies[key]), `${key} after step ${n} of swap back`);
        assert.ok(lstatSync(world.locations[key]).isSymbolicLink() && sameFolder(world.locations[key], copies[key]));
      }
      assert.ok(compared >= 15);
      assert.ok(!existsSync(world.journal));
    });
  }
});

test("a link to anywhere but the matching private copy is still refused before any rename", () => {
  const refusedAt = (build, key, pattern) =>
    withWorld({}, (world) => {
      build(world);
      const before = snapshot(world.root);
      refusedWith(() => world.swapIn(), pattern);
      assertSame(before, snapshot(world.root), `a refused link at ${key}`);
      assert.ok(!existsSync(world.journal));
    });
  const elsewhere = (world, key) => {
    const target = join(world.root, "elsewhere");
    fillFolder(target, "target");
    rmSync(world.locations[key], { recursive: true });
    symlinkSync(target, world.locations[key], "junction");
  };
  // 1: a package copy exists for the leaf, but the link goes somewhere else
  refusedAt(
    (world) => {
      packageLocations(world, ["state"]);
      const other = join(world.root, "elsewhere");
      fillFolder(other, "other");
      unlinkSync(world.locations.state);
      symlinkSync(other, world.locations.state, "junction");
    },
    "state",
    /state is a link or junction/,
  );
  // 2: a link to a folder of the right name in the wrong family or part of the package (Local for a roaming location)
  refusedAt(
    (world) => {
      const wrong = join(world.env.LOCALAPPDATA, "Packages", FAMILY, "LocalCache", "Local", basename(world.locations.appRoaming));
      fillFolder(wrong, "wrong-part");
      rmSync(world.locations.appRoaming, { recursive: true });
      symlinkSync(wrong, world.locations.appRoaming, "junction");
    },
    "appRoaming",
    /appRoaming is a link or junction/,
  );
  // 3: a link into a package whose folder name is not a family name
  refusedAt(
    (world) => {
      packageLocations(world, ["appLocal"], "bad family name");
    },
    "appLocal",
    /appLocal is a link or junction/,
  );
  // 4: a link to a package copy of another leaf
  refusedAt(
    (world) => {
      const wrong = join(world.env.LOCALAPPDATA, "Packages", FAMILY, "LocalCache", "Local", "Another");
      fillFolder(wrong, "another-leaf");
      rmSync(world.locations.appLocal, { recursive: true });
      symlinkSync(wrong, world.locations.appLocal, "junction");
    },
    "appLocal",
    /appLocal is a link or junction/,
  );
  // 5: plain links elsewhere, with no Packages folder at all (all three AppData locations)
  for (const key of ["state", "appLocal", "appRoaming"]) {
    refusedAt((world) => elsewhere(world, key), key, new RegExp(`${key} is a link or junction`));
  }
});

test("the vaults location never accepts a private copy", () =>
  withWorld({}, (world) => {
    const copy = join(world.env.LOCALAPPDATA, "Packages", FAMILY, "LocalCache", "Local", basename(world.locations.vaults));
    mkdirSync(dirname(copy), { recursive: true });
    renameSync(world.locations.vaults, copy);
    symlinkSync(copy, world.locations.vaults, "junction");
    const before = snapshot(world.root);
    refusedWith(() => world.swapIn(), /vaults is a link or junction/);
    assertSame(before, snapshot(world.root), "vaults as a package-shaped link");
    assert.ok(!existsSync(world.journal));
  }));

test("a_folder_that_shows_through_after_the_set_aside_stops_the_swap_and_puts_everything_back", () => {
  // the folder that shows through is made by a hook right after the rename, as the system would show it
  for (const [label, packaged, key] of [
    ["a plain state folder", false, "state"],
    ["a private copy", true, "state"],
    ["a later location, so earlier ones are undone", true, "appRoaming"],
    ["a plain appLocal, which is not a private copy", false, "appLocal"],
    ["the last original", false, "vaults"],
  ]) {
    withWorld({}, (world) => {
      if (packaged) packageLocations(world, ["state", "appLocal", "appRoaming"]);
      const originalOf = (k) => (packaged && k !== "vaults" ? copyPath(world, k) : world.locations[k]);
      const originals = Object.fromEntries(KEYS.map((k) => [k, snapshot(originalOf(k))]));
      const place = world.locations[key];
      const calls = [];
      const rename = (from, to) => {
        calls.push([from, to]);
        renameSync(from, to);
      };
      let shown = null;
      assert.throws(
        () =>
          world.swapIn(RUN, {
            rename,
            afterStep: (step) => {
              if (step === `${key}: original set aside`) {
                fillFolder(place, "shows-through");
                shown = snapshot(place);
              }
            },
          }),
        (error) => {
          assert.ok(error instanceof state.SwapRefused);
          const text = error.lines.join("\n");
          // the folder that shows through cannot be moved, so the set-aside copy stays set aside and the journal stays
          assert.match(text, new RegExp(`a ${key} folder outside the app's private copy shows through; the set-aside copy could not be put back`));
          assert.ok(!text.includes(world.root), "no path in the words");
          return true;
        },
      );
      assert.ok(shown !== null, label);
      // the folder that showed through is never moved: it is byte for byte in place, and nothing was renamed from there
      assertSame(shown, snapshot(place), `${label}: the shown folder is untouched where it shows`);
      assert.ok(!existsSync(world.kept(key, RUN)), `${label}: nothing was kept under the test name`);
      const asideAt = calls.findIndex(([, to]) => to === world.aside(key));
      assert.ok(asideAt >= 0);
      assert.ok(!calls.slice(asideAt + 1).some(([from]) => from === place), `${label}: no rename started from the shown folder`);
      assert.ok(existsSync(join(world.aside(key), SENTINEL)), `${label}: the set-aside copy stays aside`);
      assert.ok(existsSync(world.journal), "the journal is kept");
      assert.ok(!existsSync(`${world.journal}.lock`));
      // the locations before it were put back; the ones after it were never touched
      let compared = 0;
      for (const k of KEYS) {
        if (k === key) continue;
        compared += assertSame(originals[k], snapshot(originalOf(k)), `${label}: ${k}`);
        assert.ok(!existsSync(world.aside(k)), `${label}: ${k} is not left set aside`);
      }
      assert.ok(compared >= 15);
      // recover finds the same blocked place, and still moves nothing
      const recovering = calls.length;
      refusedWith(() => world.recover({ rename }), /could not be renamed back because a folder outside the app's private copy shows through|Windows would not put/);
      assertSame(shown, snapshot(place), `${label}: untouched after recover`);
      assert.ok(!calls.slice(recovering).some(([from]) => from === place), `${label}: recover never moved the shown folder`);
      // once the folder that shows is gone from the place (by whoever owns it), recover finishes
      renameSync(place, join(world.root, "taken-away"));
      world.recover();
      assertSame(originals[key], snapshot(originalOf(key)), `${label}: ${key} after recover`);
      assert.ok(!existsSync(world.journal));
    });
  }
});

test("a show-through where the system lets the copy go back is undone completely, without moving the shown folder", () => {
  for (const key of ["state", "appRoaming"]) {
    withWorld({}, (world) => {
      const copies = packageLocations(world, ["state", "appLocal", "appRoaming"]);
      const copiesBefore = Object.fromEntries(Object.entries(copies).map(([k, p]) => [k, snapshot(p)]));
      const model = showThroughModel(world, key);
      assert.throws(
        () => world.swapIn(RUN, { afterStep: model.hook, rename: model.rename }),
        (error) => error instanceof state.SwapRefused && new RegExp(`a ${key} folder outside the app's private copy shows through; nothing was set aside`).test(error.lines.join("\n")),
      );
      assert.deepEqual(model.violations, []);
      assertSame(model.snap, snapshot(model.hidden), "the real folder is untouched, hidden again behind the private copy");
      for (const k of ["state", "appLocal", "appRoaming"]) {
        assertSame(copiesBefore[k], snapshot(copies[k]), `${k}'s private copy`);
        assert.ok(lstatSync(world.locations[k]).isSymbolicLink() && sameFolder(world.locations[k], copies[k]), `${k} is back`);
        assert.ok(!existsSync(world.kept(k)), "nothing was kept as test state");
      }
      assert.ok(!existsSync(world.journal), "the swap is undone, so the journal is gone");
    });
  }
});

/** The private copy's folder for a location (the Packages layout `packageLocations` makes). */
function copyPath(world, key) {
  return join(world.env.LOCALAPPDATA, "Packages", FAMILY, "LocalCache", key === "appRoaming" ? "Roaming" : "Local", basename(world.locations[key]));
}

test("a crash right after the set aside, with a folder showing through, is recovered", () =>
  withWorld({}, (world) => {
    const copies = packageLocations(world, ["state", "appLocal", "appRoaming"]);
    const copyBefore = snapshot(copies.state);
    assert.ok(
      wasInterrupted(() =>
        world.swapIn(RUN, {
          afterStep: (step) => {
            if (step !== "state: original set aside") return;
            fillFolder(world.locations.state, "shows-through");
            throw new Interrupted(step);
          },
        }),
      ),
    );
    world.recover();
    assertSame(copyBefore, snapshot(copies.state), "state's private copy");
    assert.ok(lstatSync(world.locations.state).isSymbolicLink() && sameFolder(world.locations.state, copies.state));
    assert.ok(existsSync(join(world.kept("state"), "MU-note.txt")), "the shown folder is kept, not deleted");
    assert.ok(!existsSync(world.journal));
  }));

// ---- the web-view cache that shows through the private appLocal copy ------------------------------------------------

const idOf = (path) => {
  const info = statSync(path, { bigint: true });
  return { dev: String(info.dev), ino: String(info.ino) };
};

const SHOWN_LINE = "appLocal: a web-view folder outside the app's private copy shows through (cache only)";
const SHOWN_NOW_LINE = "appLocal: a web-view folder outside the app's private copy shows through now (cache only)";
const SHOWN_BEFORE_LINE = "appLocal: a web-view folder outside the app's private copy showed through when the swap started; it is not showing now";

/**
 * A model of what Windows does for a packaged app's appLocal, on temp folders. The real web-view folder outside the
 * private copy is made to show at the place right after the set-aside (`hook`); it is hidden again whenever the private
 * copy (or the test state the app wrote) is at the place, and shows again when the place is emptied. The model is the
 * only thing that ever moves that folder: `violations` collects every time the code under test tried to rename it.
 */
function showThroughModel(world, key = "appLocal") {
  const place = world.locations[key];
  const hidden = join(world.root, "hidden-real-cache");
  const model = { place, hidden, calls: [], violations: [], snap: null, id: null, visible: false, failBack: false };
  model.hook = (step) => {
    if (step !== `${key}: original set aside`) return;
    fillFolder(place, "real-cache");
    model.snap = snapshot(place);
    model.id = idOf(place);
    model.visible = true;
  };
  model.appWritesTestState = () => {
    renameSync(place, hidden);
    model.visible = false;
    fillFolder(place, "test-cache");
    writeFileSync(join(place, "MU-test-appLocal.txt"), "Made-up test data for appLocal\n");
  };
  model.rename = (from, to) => {
    model.calls.push([from, to]);
    if (model.visible && from === place) {
      model.violations.push("the folder that shows through was the source of a rename");
      throw new Error("refused: the shown-through folder must never be moved");
    }
    if (to === place && model.failBack) throw Object.assign(new Error("the system refuses"), { code: "EPERM" });
    if (to === place && model.visible) {
      renameSync(place, hidden); // the private copy takes the place, and the real folder is hidden behind it
      model.visible = false;
    }
    renameSync(from, to);
    if (from === place && !model.visible && existsSync(hidden) && !existsSync(place)) {
      renameSync(hidden, place); // the place is empty again, so the real folder shows
      model.visible = true;
    }
  };
  return model;
}

/** Everything a finished swap back (or recover) must have done for the cache case. */
function assertCacheCaseRestored(world, model, copies, copiesBefore) {
  assert.deepEqual(model.violations, []);
  assert.ok(model.calls.length >= 1);
  assertSame(model.snap, snapshot(model.hidden), "the real web-view folder, byte for byte");
  let compared = 0;
  for (const key of ["state", "appLocal", "appRoaming"]) {
    compared += assertSame(copiesBefore[key], snapshot(copies[key]), `${key}'s private copy`);
    assert.ok(lstatSync(world.locations[key]).isSymbolicLink() && sameFolder(world.locations[key], copies[key]), `${key} is back`);
  }
  assert.ok(compared >= 15);
  assert.ok(!existsSync(world.journal));
}

test("a_web_view_folder_showing_through_appLocal_is_allowed_recorded_and_never_moved", () => {
  const setUp = (extra) =>
    withWorld({}, (world) => {
      const copies = packageLocations(world, ["state", "appLocal", "appRoaming"]);
      const copiesBefore = Object.fromEntries(Object.entries(copies).map(([key, path]) => [key, snapshot(path)]));
      const model = showThroughModel(world);
      const entered = world.swapIn(RUN, { afterStep: model.hook, rename: model.rename });
      assert.ok(model.visible, "the real folder shows after the set aside");
      return extra({ world, copies, copiesBefore, model, entered });
    });

  // 1: allowed, said in the swap in and in status, recorded with the shown folder's identity; swap back puts the copy back
  setUp(({ world, copies, copiesBefore, model, entered }) => {
    assert.ok(entered.lines.includes(SHOWN_LINE), entered.lines.join("\n"));
    // what is visible now is reported by identity: the cache shows, so the place is not called empty
    const mainLine = entered.lines.find((line) => line.startsWith(`appLocal: the ${FAMILY}`));
    assert.ok(mainLine && !/empty/.test(mainLine), mainLine);
    assert.ok(entered.lines.filter((line) => /empty/.test(line)).every((line) => !line.startsWith("appLocal")));
    assert.ok(world.status().lines.includes(SHOWN_NOW_LINE), world.status().lines.join("\n"));
    assert.ok(!world.status().lines.some((line) => /showed through when the swap started/.test(line)));
    const recorded = journalOf(world).locations.find((l) => l.key === "appLocal");
    assert.deepEqual(recorded.shownThrough, model.id);
    assert.deepEqual(recorded.identity, idOf(world.aside("appLocal")), "the original's identity is its own");
    assert.notDeepEqual(recorded.identity, recorded.shownThrough);
    for (const l of journalOf(world).locations.filter((x) => x.key !== "appLocal")) assert.equal(l.shownThrough, undefined);
    const duringSwapIn = model.calls.length;
    world.swapBack(RUN, { rename: model.rename });
    assertCacheCaseRestored(world, model, copies, copiesBefore);
    const putBack = model.calls.slice(duringSwapIn).filter(([, to]) => to === model.place);
    assert.equal(putBack.length, 1, "the private copy went back with one rename");
    assert.ok(!model.calls.slice(duringSwapIn).some(([from]) => from === model.place), "no rename in swap back started from the place");
  });

  // 2: the app wrote a test state into the private copy: it is kept under the test name, the shown folder stays
  setUp(({ world, copies, copiesBefore, model }) => {
    model.appWritesTestState();
    const testState = snapshot(model.place);
    // the test state hides the cache now: status says it showed through at swap in, and not that it shows now
    const hiddenStatus = world.status().lines;
    assert.ok(hiddenStatus.includes(SHOWN_BEFORE_LINE), hiddenStatus.join("\n"));
    assert.ok(!hiddenStatus.includes(SHOWN_NOW_LINE) && !hiddenStatus.includes(SHOWN_LINE));
    world.swapBack(RUN, { rename: model.rename });
    assertCacheCaseRestored(world, model, copies, copiesBefore);
    assertSame(testState, snapshot(world.kept("appLocal")), "the test state is kept for the next run");
    assert.ok(model.calls.some(([from, to]) => from === model.place && to === world.kept("appLocal")));
  });

  // 3: a crash right after the test state was kept, then recover in a fresh call
  setUp(({ world, copies, copiesBefore, model }) => {
    model.appWritesTestState();
    const testState = snapshot(model.place);
    assert.ok(
      wasInterrupted(() =>
        world.swapBack(RUN, {
          rename: model.rename,
          afterStep: (step) => {
            if (step === "appLocal: test state kept") throw new Interrupted(step);
          },
        }),
      ),
    );
    assert.ok(model.visible, "the real folder shows again once the test state is gone");
    assertSame(model.snap, snapshot(model.place), "still untouched at the place");
    world.recover({ rename: model.rename });
    assertCacheCaseRestored(world, model, copies, copiesBefore);
    assertSame(testState, snapshot(world.kept("appLocal")), "the test state is kept");
  });

  // 4: a crash right after the shown folder was seen, before anything else: recover puts everything back
  withWorld({}, (world) => {
    const copies = packageLocations(world, ["state", "appLocal", "appRoaming"]);
    const copiesBefore = Object.fromEntries(Object.entries(copies).map(([key, path]) => [key, snapshot(path)]));
    const model = showThroughModel(world);
    assert.ok(
      wasInterrupted(() =>
        world.swapIn(RUN, {
          rename: model.rename,
          afterStep: (step) => {
            model.hook(step);
            if (step === "appLocal: show-through recorded") throw new Interrupted(step);
          },
        }),
      ),
    );
    world.recover({ rename: model.rename });
    assertCacheCaseRestored(world, model, copies, copiesBefore);
  });
});

test("when the system will not put the private copy back over the shown folder, swap back stops with the journal kept", () =>
  withWorld({}, (world) => {
    const copies = packageLocations(world, ["state", "appLocal", "appRoaming"]);
    const copiesBefore = Object.fromEntries(Object.entries(copies).map(([key, path]) => [key, snapshot(path)]));
    const model = showThroughModel(world);
    world.swapIn(RUN, { afterStep: model.hook, rename: model.rename });
    model.failBack = true;
    assert.throws(
      () => world.swapBack(RUN, { rename: model.rename }),
      (error) => {
        assert.ok(error instanceof state.SwapRefused);
        const text = error.lines.join("\n");
        assert.match(text, /appLocal: Windows would not put the app's private copy back over the web-view folder that shows through/);
        assert.ok(!text.includes(world.root), "no path in the words");
        return true;
      },
    );
    assert.deepEqual(model.violations, []);
    assertSame(model.snap, snapshot(model.place), "the shown folder is untouched where it shows");
    assert.ok(existsSync(join(world.aside("appLocal"), SENTINEL)), "the private copy stays set aside");
    assert.ok(existsSync(world.journal), "the journal is kept");
    assert.ok(lstatSync(world.locations.state).isSymbolicLink(), "state, before it, was put back");
    // the restore ends at the refusal: appRoaming and vaults were not touched, and nothing was renamed after it
    for (const key of ["appRoaming", "vaults"]) {
      assert.ok(existsSync(join(world.aside(key), SENTINEL)), `${key} is still set aside`);
      assert.ok(!existsSync(world.locations[key]));
    }
    const last = model.calls[model.calls.length - 1];
    assert.deepEqual(last, [world.aside("appLocal"), model.place], "the refused put-back was the last rename");
    // once the system allows it, recover finishes
    model.failBack = false;
    world.recover({ rename: model.rename });
    assertCacheCaseRestored(world, model, copies, copiesBefore);
  }));

// ---- two views of one disk ----------------------------------------------------------------------------------------

/**
 * Two terminals see different things under the same spelled AppData paths: inside the packaged app the places are
 * junctions to the private copy, outside they are not there (or are something else). On one disk that is faked by moving
 * the spelled names (place, aside and kept) of `keys` out of sight (`hide`) and back (`show`). The journal, the lock, the
 * vaults folder and the Packages tree are the same in both views.
 */
function viewSwitch(world, keys) {
  const stash = join(world.root, "stash");
  const moved = [];
  return {
    stash,
    hide() {
      mkdirSync(stash, { recursive: true });
      for (const key of keys) {
        for (const name of [world.locations[key], world.aside(key), world.kept(key)]) {
          try {
            lstatSync(name);
          } catch {
            continue;
          }
          const to = join(stash, `${key}-${basename(name)}`);
          renameSync(name, to);
          moved.push([name, to]);
        }
      }
    },
    show() {
      for (const [name, to] of moved.reverse()) renameSync(to, name);
      moved.length = 0;
    },
  };
}

test("a terminal that does not see the private copy refuses to recover or swap back, says so, and changes nothing", () => {
  const said = new RegExp(`this swap was started inside the ${FAMILY} app; run recover from a terminal inside that app`);
  for (const outsideHasRealFolder of [false, true]) {
    withWorld({}, (world) => {
      const keys = ["state", "appLocal", "appRoaming"];
      const copies = packageLocations(world, keys);
      const copiesBefore = Object.fromEntries(Object.entries(copies).map(([key, path]) => [key, snapshot(path)]));
      world.swapIn();
      const view = viewSwitch(world, keys);
      view.hide();
      if (outsideHasRealFolder) fillFolder(world.locations.state, "real-outside");
      const outside = snapshot(world.root);
      assert.ok(outside.size >= 20);

      // the journal and the lock are in the shared profile, so this terminal sees the swap and does not start another
      refusedWith(() => world.recover(), said);
      refusedWith(() => world.swapBack(), said);
      refusedWith(() => world.swapIn("other-run"), /already in progress \(run t1\)/);
      const seen = world.status();
      assert.equal(seen.inProgress, true);
      assert.ok(seen.lines.some((line) => said.test(line)), seen.lines.join("\n"));
      assert.deepEqual(state.cli(["status"], world.options()).code, 0);
      assert.ok(!existsSync(`${world.journal}.lock`), "no lock is left behind by a refusal");
      assertSame(outside, snapshot(world.root), "nothing changed in the outside view");

      // back inside the app, recovery works
      if (outsideHasRealFolder) renameSync(world.locations.state, join(view.stash, "outside-real"));
      view.show();
      world.recover();
      let compared = 0;
      for (const key of keys) {
        compared += assertSame(copiesBefore[key], snapshot(copies[key]), `${key}'s private copy`);
        assert.ok(lstatSync(world.locations[key]).isSymbolicLink() && sameFolder(world.locations[key], copies[key]), `${key} is back`);
      }
      assert.ok(compared >= 15);
      assert.ok(!existsSync(world.journal));
    });
  }
});

// ---- reading out and the command line -----------------------------------------------------------------------------

test("status says in words what is set aside, naming locations and the run but no path", () =>
  withWorld({ absent: ["appRoaming"] }, (world) => {
    assert.deepEqual(world.status().lines, ["no swap is in progress"]);
    world.swapIn();
    const { inProgress, run, lines } = world.status();
    assert.equal(inProgress, true);
    assert.equal(run, RUN);
    assert.equal(lines.length, 5);
    assert.match(lines[0], /run t1/);
    for (const [index, key] of KEYS.entries()) assert.ok(lines[index + 1].startsWith(`${key}: `));
    assert.match(lines[1], /in place: nothing; set aside: a folder with this run's sentinel/);
    assert.match(lines[3], /did not exist/);
    assert.ok(!lines.join("\n").includes(world.root));
    world.swapBack();
    assert.deepEqual(world.status().lines, ["no swap is in progress"]);
  }));

test("the command line: in, status, back and recover, and nothing else", () =>
  withWorld({}, (world) => {
    const before = snapshot(world.root);
    const stateBefore = snapshot(world.locations.state);
    const opts = world.options();
    for (const bad of [[], ["bogus"], ["in"], ["in", "BAD NAME"], ["in", "ok", "extra"], ["back"], ["status", "x"], ["recover", "x"], ["--help"]]) {
      const result = state.cli(bad, opts);
      assert.equal(result.code, 2, bad.join(" "));
      assert.match(result.lines[0], /^usage: /);
    }
    assertSame(before, snapshot(world.root), "after refused commands");
    assert.equal(state.cli(["status"], opts).code, 0);
    assert.equal(state.cli(["in", RUN], opts).code, 0);
    assert.match(state.cli(["status"], opts).lines[0], /run t1/);
    assert.equal(state.cli(["in", RUN], opts).code, 1, "a second swap in is refused");
    assert.equal(state.cli(["recover"], { ...opts, isRunning: () => true }).code, 1);
    assert.equal(state.cli(["back", RUN], opts).code, 0);
    assert.deepEqual(state.cli(["recover"], opts), { code: 0, lines: ["nothing to recover"] });
    assertSame(stateBefore, snapshot(world.locations.state), "state after the command line round trip");
  }));

test("the command line as a program: usage errors exit 2, and an environment that disagrees with Windows is refused", () =>
  withWorld({}, (world) => {
    const run = (args, env) => spawnSync(process.execPath, [MODULE, ...args], { encoding: "utf8", env: { ...process.env, ...env } });
    const before = snapshot(world.root);
    assert.equal(run(["bogus"], world.env).status, 2);
    assert.equal(run(["in"], world.env).status, 2);
    assert.equal(run([], world.env).status, 2);
    // the disposable folders are not where Windows says the app's folders are, so every command refuses and touches nothing
    if (process.platform === "win32") {
      for (const args of [["status"], ["recover"], ["in", RUN], ["back", RUN]]) {
        const refused = run(args, world.env);
        assert.equal(refused.status, 1, args.join(" "));
        assert.match(refused.stderr, /LOCALAPPDATA is missing or names a different folder/);
        assert.equal(refused.stdout, "");
      }
    }
    assertSame(before, snapshot(world.root), "after the programs ran");
  }));

test("a filesystem error in status is worded without a path and exits non-zero", () =>
  withWorld({}, (world) => {
    // a journal name too long for the filesystem: looking at it fails with ENAMETOOLONG, whose raw text carries the path
    const options = world.options({ journal: join(world.root, "x".repeat(40000)) });
    assert.throws(() => state.status(options), (error) => !(error instanceof state.SwapRefused) && error.message.includes(world.root));
    const result = state.cli(["status"], options);
    assert.equal(result.code, 1);
    assert.deepEqual(result.lines, ["could not read what is set aside (ENAMETOOLONG)"]);
    for (const command of [["recover"], ["in", RUN], ["back", RUN]]) {
      const other = state.cli(command, options);
      assert.equal(other.code, 1);
      assert.ok(!other.lines.join("\n").includes(world.root), "no path in the words");
    }
    // an unreadable journal is a non-zero status too
    writeFileSync(world.journal, "not json");
    const unreadable = state.cli(["status"], world.options());
    assert.equal(unreadable.code, 1);
    assert.match(unreadable.lines.join("\n"), /journal is not readable/);
  }));
