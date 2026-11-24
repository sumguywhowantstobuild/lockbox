// Tests for scripts/e2e.mjs and e2e/lib/app.mjs, e2e/lib/folderbox.mjs: the end-to-end runner's own logic. Nothing here
// starts Lockbox or a driver, and nothing touches the real state folders: every run is handed disposable folders. The
// tests that need the built app are in e2e/real-app.test.mjs, which scripts/e2e.mjs runs. Every comparison counts what
// it compared and fails on zero.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import net from "node:net";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import * as app from "../e2e/lib/app.mjs";
import * as folderbox from "../e2e/lib/folderbox.mjs";
import * as state from "../e2e/lib/state.mjs";
import { checks } from "./check.mjs";
import * as e2e from "./e2e.mjs";

const E2E_MODULE = fileURLToPath(new URL("./e2e.mjs", import.meta.url));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- disposable worlds --------------------------------------------------------------------------------------------

function fingerprint(dir) {
  const found = new Map();
  const walk = (current) => {
    for (const name of readdirSync(current).sort()) {
      const full = join(current, name);
      const info = lstatSync(full);
      if (info.isDirectory()) {
        found.set(relative(dir, full), "dir");
        walk(full);
      } else {
        const bytes = readFileSync(full);
        found.set(relative(dir, full), `file:${bytes.length}:${createHash("sha256").update(bytes).digest("hex")}`);
      }
    }
  };
  walk(dir);
  return found;
}

/** Four locations under a new temp folder, each holding made-up files, in the layout `defaultLocations` gives. */
function makeWorld() {
  const root = mkdtempSync(join(tmpdir(), "e2e-test-"));
  const env = { LOCALAPPDATA: join(root, "local"), APPDATA: join(root, "roaming"), USERPROFILE: join(root, "profile") };
  for (const dir of Object.values(env)) mkdirSync(dir);
  const locations = state.locationsFrom({ localAppData: env.LOCALAPPDATA, roamingAppData: env.APPDATA, profile: env.USERPROFILE });
  for (const key of state.LOCATION_KEYS) {
    mkdirSync(join(locations[key], "sub"), { recursive: true });
    writeFileSync(join(locations[key], "MU-note.txt"), `Made-up note for ${key}\n`);
    writeFileSync(join(locations[key], "sub", "MU-data.bin"), Buffer.from(Array.from({ length: 64 }, (_, i) => (i + key.length) % 256)));
  }
  const journal = join(env.USERPROFILE, "Lockbox Vaults.swap-journal.json");
  return {
    root,
    locations,
    journal,
    stateOptions: { locations, journal, isRunning: () => false },
    prints: () => Object.fromEntries(state.LOCATION_KEYS.map((key) => [key, fingerprint(locations[key])])),
    done: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** Fails when the two sets of fingerprints differ, or when there was nothing in them to compare. */
function assertSamePrints(before, after, what) {
  let counted = 0;
  for (const key of state.LOCATION_KEYS) {
    assert.ok(before[key].size >= 3, `${what}: ${key} had only ${before[key].size} entries, nothing to trust`);
    assert.deepEqual([...after[key]].sort(), [...before[key]].sort(), `${what}: ${key} differs`);
    counted += before[key].size;
  }
  assert.ok(counted >= 12, `${what}: compared only ${counted} entries`);
}

/** A run with every step a spy; `suites` is what the test wants the run to do. */
function fakeRun(world, { suites, build, isRunning = () => false, env = {}, specs = [] } = {}) {
  const calls = [];
  const steps = {
    isRunning: () => {
      calls.push("isRunning");
      return isRunning();
    },
    checkTools: () => {
      calls.push("checkTools");
      return {};
    },
    build: async () => {
      calls.push("build");
      if (build) await build();
    },
    suites: async (context) => {
      calls.push("suites");
      return suites ? suites(context) : 0;
    },
  };
  const lines = [];
  const promise = e2e.runE2e({ env, specs, stateOptions: world.stateOptions, steps, log: (line) => lines.push(line) });
  return { calls, lines, promise };
}

// ---- the refusal ---------------------------------------------------------------------------------------------------

test("e2e_refuses_to_start_while_lockbox_runs", async () => {
  const world = makeWorld();
  try {
    const before = world.prints();
    const run = fakeRun(world, { isRunning: () => true });
    const result = await run.promise;
    assert.equal(result.code, 2, "a refusal ends with code 2");
    assert.match(result.lines.join("\n"), /Lockbox is running/);
    assert.deepEqual(run.calls, ["isRunning"], "nothing else ran: no tool check, no build, no swap, no suites");
    assertSamePrints(before, world.prints(), "the state after a refusal");
    assert.equal(existsSync(world.journal), false, "no swap was begun");
  } finally {
    world.done();
  }
});

test("e2e_refuses_to_start_while_lockbox_runs: a process that really has the program's name", async () => {
  // A copy of node.exe named like the app, left running: the real Windows question (tasklist) says Lockbox runs.
  const world = makeWorld();
  const holder = mkdtempSync(join(tmpdir(), "e2e-name-"));
  const imitation = join(holder, "lockbox-desktop.exe");
  copyFileSync(process.execPath, imitation);
  const child = spawn(imitation, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
  try {
    await sleep(500);
    assert.equal(state.isLockboxRunning(), true, "the imitation shows to Windows as Lockbox");
    const calls = [];
    const result = await e2e.runE2e({
      env: {},
      stateOptions: world.stateOptions,
      steps: {
        // the real question, with nothing else faked
        checkTools: () => calls.push("checkTools"),
        build: () => calls.push("build"),
        suites: () => calls.push("suites"),
      },
      log: () => {},
    });
    assert.equal(result.code, 2);
    assert.deepEqual(calls, [], "no step ran");
  } finally {
    child.kill();
    await sleep(300);
    rmSync(holder, { recursive: true, force: true });
    world.done();
  }
});

// ---- the swap around a run -----------------------------------------------------------------------------------------

test("a_failed_run_swaps_back", async () => {
  for (const how of ["throws", "returns 1"]) {
    const world = makeWorld();
    try {
      const before = world.prints();
      const seen = {};
      const run = fakeRun(world, {
        suites: (context) => {
          seen.runName = context.runName;
          // the run's own test state is in place now: the originals are set aside
          assert.equal(existsSync(world.journal), true, "a swap is in progress while the suites run");
          assert.equal(existsSync(join(world.locations.state, "MU-note.txt")), false, "the original is not in place");
          assert.equal(existsSync(join(`${world.locations.state}.aside-${context.runName}`, "MU-note.txt")), true, "the original is set aside");
          // (the place is empty: the app makes its own folder when it starts)
          mkdirSync(world.locations.state, { recursive: true });
          writeFileSync(join(world.locations.state, "MU-test-state.txt"), "Made-up state the app wrote\n");
          // what someone who opened Lockbox during the run would have made in the substituted default vault folder
          mkdirSync(world.locations.vaults, { recursive: true });
          writeFileSync(join(world.locations.vaults, "MU-vault-made-by-someone.txt"), "Made-up vault made during the run\n");
          if (how === "throws") throw new Error("a suite failed");
          return 1;
        },
      });
      const result = await run.promise;
      assert.notEqual(result.code, 0, `a failed run (${how}) does not pass`);
      assert.deepEqual(run.calls, ["isRunning", "checkTools", "build", "suites"]);
      assert.equal(existsSync(world.journal), false, "the swap is over");
      assertSamePrints(before, world.prints(), `the originals after a run that ${how}`);
      for (const key of state.LOCATION_KEYS) {
        assert.equal(existsSync(`${world.locations[key]}.aside-${seen.runName}`), false, `${key}: nothing is left set aside`);
      }
      // nothing the swap parked is deleted: what the app (or a person) wrote stays where swap back put it, and the run says where
      for (const [key, file] of [["state", "MU-test-state.txt"], ["vaults", "MU-vault-made-by-someone.txt"]]) {
        assert.equal(existsSync(join(`${world.locations[key]}.test-${seen.runName}`, file)), true, `${key}: the parked folder and what is in it are kept`);
      }
      const said = result.lines.filter((line) => line.includes(`.test-${seen.runName}`));
      assert.equal(said.length, 1, "one line names the parked folders");
      for (const key of ["state", "vaults"]) assert.ok(said[0].includes(`${world.locations[key]}.test-${seen.runName}`), `the line names ${key}'s`);
      assert.equal(state.status(world.stateOptions).inProgress, false);
    } finally {
      world.done();
    }
  }
});

test("a_failed_run_swaps_back: a failed build touches nothing", async () => {
  const world = makeWorld();
  try {
    const before = world.prints();
    const run = fakeRun(world, {
      build: () => {
        throw new Error("the build failed");
      },
    });
    const result = await run.promise;
    assert.notEqual(result.code, 0);
    assert.deepEqual(run.calls, ["isRunning", "checkTools", "build"], "the suites never ran");
    assert.equal(existsSync(world.journal), false, "no swap was begun for a build that failed");
    assertSamePrints(before, world.prints(), "the state after a failed build");
  } finally {
    world.done();
  }
});

test("a_swap_that_stops_part_way_is_put_right_by_the_run", async () => {
  const world = makeWorld();
  try {
    const before = world.prints();
    let steps = 0;
    const stopAtThird = () => {
      steps += 1;
      if (steps === 3) throw new Error("the swap stopped part-way (a test's own failure)");
    };
    const calls = [];
    const result = await e2e.runE2e({
      env: {},
      stateOptions: { ...world.stateOptions, afterStep: stopAtThird },
      steps: { isRunning: () => false, checkTools: () => ({}), build: () => {}, suites: () => calls.push("suites") },
      log: () => {},
    });
    assert.ok(steps >= 5, `the swap's steps were counted (${steps}), and recover's came after the third`);
    assert.notEqual(result.code, 0);
    assert.deepEqual(calls, [], "the suites never ran on a half-made swap");
    assert.equal(existsSync(world.journal), false, "recover finished the swap's undoing");
    assertSamePrints(before, world.prints(), "the originals after a swap that stopped part-way");
  } finally {
    world.done();
  }
});

test("a_run_refused_by_another_runs_swap_leaves_that_swap_alone", async () => {
  // Two local runs can overlap (the build comes before the swap). The second is refused by the first's swap, and its
  // cleanup must not undo the first's: the first is mid-run, in a gap with no Lockbox process.
  const world = makeWorld();
  try {
    const before = world.prints();
    let release;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    let reachedSuites;
    const reached = new Promise((resolve) => {
      reachedSuites = resolve;
    });
    const first = fakeRun(world, {
      suites: async (context) => {
        reachedSuites(context.runName);
        await held;
        return 0;
      },
    });
    const firstName = await reached;
    const second = fakeRun(world, {});
    const refused = await second.promise;
    // the first run's swap is intact: its journal, its parked originals
    assert.equal(existsSync(world.journal), true, "the first run's journal is still there");
    assert.equal(state.status(world.stateOptions).run, firstName);
    for (const key of state.LOCATION_KEYS) {
      assert.equal(existsSync(`${world.locations[key]}.aside-${firstName}`), true, `${key}: the first run's parked original is still parked`);
    }
    assert.equal(refused.code, 2, "the second run is refused");
    assert.match(refused.lines.join("\n"), /already in progress/);
    assert.match(refused.lines.join("\n"), new RegExp(`another run \\(${firstName}\\).*left alone`), "it says whose swap it left alone");
    assert.ok(!second.calls.includes("suites"), "the second run's suites never ran");
    release();
    const done = await first.promise;
    assert.equal(done.code, 0, "the first run finishes and puts everything back itself");
    assert.equal(existsSync(world.journal), false);
    assertSamePrints(before, world.prints(), "the originals after both runs");
  } finally {
    world.done();
  }
});

test("a_killed_run_is_recovered_by_recover", async () => {
  const world = makeWorld();
  const holder = mkdtempSync(join(tmpdir(), "e2e-kill-"));
  try {
    const before = world.prints();
    const ready = join(holder, "ready");
    const runner = join(holder, "runner.mjs");
    writeFileSync(
      runner,
      `import { writeFileSync } from "node:fs";
import { runE2e } from ${JSON.stringify(pathToFileURL(E2E_MODULE).href)};
const world = JSON.parse(process.env.E2E_TEST_WORLD);
await runE2e({
  env: {},
  stateOptions: { locations: world.locations, journal: world.journal, isRunning: () => false },
  steps: {
    isRunning: () => false,
    checkTools: () => ({}),
    build: async () => {},
    suites: async () => {
      writeFileSync(world.ready, "ready");
      await new Promise(() => {});
    },
  },
  log: () => {},
});
`,
    );
    // the killed run cannot clean up after itself, so its own temp folder is made inside this test's folder
    const child = spawn(process.execPath, [runner], {
      env: { ...process.env, TEMP: holder, TMP: holder, E2E_TEST_WORLD: JSON.stringify({ locations: world.locations, journal: world.journal, ready }) },
      stdio: "ignore",
      windowsHide: true,
    });
    for (let waited = 0; !existsSync(ready) && waited < 20_000; waited += 100) await sleep(100);
    assert.equal(existsSync(ready), true, "the run reached its suites");
    assert.equal(state.status(world.stateOptions).inProgress, true, "a swap is in progress while the run is alive");
    child.kill("SIGKILL");
    await sleep(500);
    assert.equal(state.status(world.stateOptions).inProgress, true, "the killed run left its swap");
    const recovered = state.recover(world.stateOptions);
    assert.ok(recovered.lines.length >= 4, "recover said what it did for each location");
    assert.equal(state.status(world.stateOptions).inProgress, false);
    assertSamePrints(before, world.prints(), "the originals after recover");
  } finally {
    rmSync(holder, { recursive: true, force: true });
    world.done();
  }
});

test("on_ci_the_state_folders_must_be_fresh", async () => {
  // CI's runner has no state: a folder that is already there is refused. The swap is used as on a PC (it sets nothing aside
  // there), so that each spec can have a fresh state of its own.
  const fresh = makeWorld();
  try {
    for (const key of state.LOCATION_KEYS) rmSync(fresh.locations[key], { recursive: true, force: true });
    let swapping = null;
    const run = fakeRun(fresh, {
      env: { LOCKBOX_E2E_CI: "1" },
      suites: () => {
        swapping = existsSync(fresh.journal);
        return 0;
      },
    });
    const result = await run.promise;
    assert.equal(result.code, 0);
    assert.deepEqual(run.calls, ["isRunning", "checkTools", "build", "suites"]);
    assert.equal(swapping, true, "the suites run on a swapped test state on CI too");
    assert.equal(existsSync(fresh.journal), false, "the swap is over after the run");
    for (const key of state.LOCATION_KEYS) assert.equal(existsSync(fresh.locations[key]), false, `${key}: nothing is made where nothing was`);
  } finally {
    fresh.done();
  }
  const used = makeWorld();
  try {
    const before = used.prints();
    const run = fakeRun(used, { env: { LOCKBOX_E2E_CI: "1" } });
    const result = await run.promise;
    assert.equal(result.code, 2);
    assert.match(result.lines.join("\n"), /already there/);
    assert.ok(!run.calls.includes("suites") && !run.calls.includes("build"), "nothing was built or run");
    assertSamePrints(before, used.prints(), "the state CI refused to run over");
  } finally {
    used.done();
  }
});

test("ci_equal_true_alone_grants_nothing", async () => {
  // Developer shells and local CI tools set CI=true. Only the GitHub e2e job's own marker asks for fresh folders or allows the clipboard.
  const world = makeWorld();
  try {
    const before = world.prints();
    let swapInProgress = null;
    const run = fakeRun(world, {
      env: { CI: "true" },
      suites: () => {
        swapInProgress = existsSync(world.journal);
        return 0;
      },
    });
    const result = await run.promise;
    assert.equal(result.code, 0);
    assert.equal(swapInProgress, true, "with CI=true alone the run still swaps the test state in");
    assertSamePrints(before, world.prints(), "the originals after a CI=true run");
  } finally {
    world.done();
  }
  assert.equal(app.clipboardSteps({ CI: "true" }).run, false, "CI=true alone leaves the clipboard alone");
  assert.equal(app.clipboardSteps({ CI: "true", GITHUB_ACTIONS: "true" }).run, false);
  assert.equal(app.clipboardSteps({ LOCKBOX_E2E_CI: "true" }).run, false, "only the marker's own value counts");
  assert.deepEqual(app.clipboardSteps({ LOCKBOX_E2E_CI: "1" }), { run: true, why: "on the GitHub end-to-end job" });
  assert.throws(() => e2e.findNativeDriver({ env: { EDGEWEBDRIVER: "C:\\SeleniumWebDrivers\\EdgeDriver", CI: "true" } }), /--edgedriver|LOCKBOX_EDGEDRIVER/, "the image's driver folder is not taken on CI=true alone");
});

test("each_spec_gets_a_fresh_state_and_every_test_state_is_kept", async () => {
  const world = makeWorld();
  try {
    const before = world.prints();
    const names = [];
    const run = fakeRun(world, {
      suites: async (context) => {
        names.push(context.runName);
        for (const label of ["s1", "s2"]) {
          // the app wrote into the state in place: the next fresh state must not show it
          mkdirSync(world.locations.state, { recursive: true });
          writeFileSync(join(world.locations.state, "MU-written.txt"), `Made-up state before ${label}\n`);
          await context.freshState(label);
          names.push(`${context.runName}-${label}`);
          assert.equal(state.status(world.stateOptions).run, `${context.runName}-${label}`, "the journal names the new swap");
          assert.equal(existsSync(world.locations.state), false, `${label}: the place is empty, as on a new PC`);
          assert.equal(existsSync(join(`${world.locations.state}.aside-${context.runName}-${label}`, "MU-note.txt")), true, "the original is set aside under the new swap");
        }
        await assert.rejects(() => context.freshState("Bad label"), /label/);
        return 0;
      },
    });
    const result = await run.promise;
    assert.equal(result.code, 0);
    assert.equal(existsSync(world.journal), false, "no swap is left in progress");
    assertSamePrints(before, world.prints(), "the originals after a run of fresh states");
    // the test state each swap held is kept beside the real folder, and named in the run's output
    for (const name of names.slice(0, 2)) {
      assert.equal(existsSync(join(`${world.locations.state}.test-${name}`, "MU-written.txt")), true, `${name}: its test state is kept`);
      assert.ok(result.lines.some((line) => line.includes(`.test-${name}`)), `${name}: the output names it`);
    }
    for (const name of names) assert.equal(existsSync(`${world.locations.state}.aside-${name}`), false, `${name}: nothing is left set aside`);
  } finally {
    world.done();
  }
});

test("a_fresh_state_that_cannot_be_swapped_in_fails_the_run_and_puts_the_real_state_back", async () => {
  const world = makeWorld();
  try {
    const before = world.prints();
    let running = false;
    world.stateOptions.isRunning = () => running;
    const run = fakeRun(world, {
      suites: async (context) => {
        running = true;
        try {
          await context.freshState("s1");
        } finally {
          running = false;
        }
        return 0;
      },
    });
    const result = await run.promise;
    assert.equal(result.code, 1, "a refusal after the first swap is a failure, not a refusal");
    assert.equal(existsSync(world.journal), false);
    assertSamePrints(before, world.prints(), "the originals after a refused fresh state");
  } finally {
    world.done();
  }
});

test("a_folder_busy_for_a_moment_is_put_right_and_the_fresh_state_tried_again", async () => {
  // Windows can hold a real folder for a moment just after it is put back (EPERM on the rename). The swap that stopped
  // part-way is recovered, and the same fresh state is swapped in again; a folder still busy on the third try fails the run.
  for (const busyTimes of [1, 3]) {
    const world = makeWorld();
    try {
      const before = world.prints();
      let failures = 0;
      let armed = false;
      const seen = [];
      // EPERM part-way through the suite's swap, the first `busyTimes` times: right after the first location (state) is set
      // aside, before the others are touched, as when Windows holds a folder that was just put back.
      world.stateOptions.afterStep = (step) => {
        if (!armed) return;
        seen.push(step);
        if (step === "state: original set aside" && failures < busyTimes) {
          failures += 1;
          const busy = new Error("operation not permitted, rename");
          busy.code = "EPERM";
          throw busy;
        }
      };
      let reached = false;
      const run = fakeRun(world, {
        suites: async (context) => {
          armed = true;
          await context.freshState("s1");
          reached = true;
          return 0;
        },
      });
      const result = await run.promise;
      if (busyTimes === 1) {
        assert.equal(result.code, 0, "a folder busy once is tried again and the run goes on");
        assert.equal(reached, true);
        assert.ok(result.lines.some((line) => /a folder was busy \(EPERM\)/.test(line)), "the retry is said");
      } else {
        assert.equal(result.code, 1, "a folder busy three times fails the run");
        assert.equal(reached, false);
      }
      assert.equal(failures, busyTimes, "the swap stopped part-way as often as asked");
      assert.ok(!seen.includes("vaults: original set aside") || busyTimes === 1, "a swap that stopped never reached the later locations");
      assert.equal(existsSync(world.journal), false, "no swap is left in progress");
      assertSamePrints(before, world.prints(), `the originals after a folder busy ${String(busyTimes)} time(s)`);
      for (const key of state.LOCATION_KEYS) {
        const parent = dirname(world.locations[key]);
        assert.deepEqual(readdirSync(parent).filter((entry) => entry.includes(".aside-")), [], `${key}: nothing is left set aside`);
      }
    } finally {
      world.done();
    }
  }
});

test("spec_names_are_the_ones_asked_for_or_every_spec_file", () => {
  const dir = mkdtempSync(join(tmpdir(), "e2e-specs-"));
  try {
    const required = ["back-up", "thin-path"];
    assert.throws(() => e2e.specNames([], dir, required), /no spec to run|required spec is missing/, "an empty folder runs nothing and fails");
    for (const file of ["thin-path.e2e.mjs", "back-up.e2e.mjs", "notes.txt"]) writeFileSync(join(dir, file), "// made up\n");
    assert.deepEqual(e2e.specNames([], dir, required), ["back-up", "thin-path"]);
    assert.deepEqual(e2e.specNames(["thin-path"], dir, required), ["thin-path"]);
    assert.throws(() => e2e.specNames(["missing"], dir, required), /no such spec/);
    // a required path whose file is gone fails a default run, and a single named spec still runs alone
    rmSync(join(dir, "back-up.e2e.mjs"));
    assert.throws(() => e2e.specNames([], dir, required), /a required spec is missing: back-up\.e2e\.mjs/);
    assert.deepEqual(e2e.specNames(["thin-path"], dir, required), ["thin-path"]);
    rmSync(join(dir, "thin-path.e2e.mjs"));
    assert.throws(() => e2e.specNames([], dir, []), /no spec to run/, "no spec files at all is a failure, not a pass");
    // the repository's own specs are the required ones
    assert.deepEqual(e2e.specNames([]), e2e.REQUIRED_SPECS);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- the folders a run makes ---------------------------------------------------------------------------------------

test("the_vault_folder_chosen_in_setup_is_a_temporary_folder_the_run_made", async () => {
  const world = makeWorld();
  try {
    let context;
    const run = fakeRun(world, {
      suites: (made) => {
        context = made;
        for (const folder of [made.tempDir, made.webviewDir, made.logDir]) {
          assert.equal(existsSync(folder), true, "the run made its folder before the suites");
          assert.ok(relative(made.runRoot, folder).split("\\")[0] !== "..", "inside the run's own folder");
        }
        // each spec's vault and files folders are made by runSpecs under these names, inside the run's own folder
        for (const name of ["vaults-s1", "files-s1"]) folderbox.checkPickable(join(made.runRoot, name), { runRoot: made.runRoot, locations: world.locations });
        return 0;
      },
    });
    const result = await run.promise;
    assert.equal(result.code, 0);
    assert.ok(context, "the suites ran");
    assert.ok(context.runRoot.startsWith(tmpdir()), "the run's folder is in the system's temp folder");
    assert.equal(existsSync(context.runRoot), false, "the run's folder is gone after the run");
    // never the default vault folder, never anywhere inside the app's own folders
    for (const key of state.LOCATION_KEYS) {
      assert.throws(() => folderbox.checkPickable(world.locations[key], { runRoot: context.runRoot, locations: world.locations }), /not inside the run's own folder|never/, `${key}`);
    }
  } finally {
    world.done();
  }
});

test("the_folder_box_helper_picks_only_a_folder_the_run_made", () => {
  const runRoot = mkdtempSync(join(tmpdir(), "e2e-pick-"));
  try {
    const locations = state.locationsFrom({ localAppData: join(runRoot, "l"), roamingAppData: join(runRoot, "r"), profile: join(runRoot, "p") });
    const inside = join(runRoot, "vaults");
    mkdirSync(inside);
    const ok = { runRoot, locations };
    assert.equal(folderbox.checkPickable(inside, ok), inside);
    let refused = 0;
    for (const bad of [
      locations.vaults, // the default folder: never
      join(locations.vaults, "x"),
      locations.state,
      join(tmpdir(), "somewhere-else"),
      runRoot, // the run's folder itself is not a vault folder
      join(runRoot, "..", "elsewhere"),
      "vaults",
      "",
      `${inside}\\..\\..`,
      42,
    ]) {
      assert.throws(() => folderbox.checkPickable(bad, ok), Error, String(bad));
      refused += 1;
    }
    assert.equal(refused, 10, "every bad shape was tried and refused");
    assert.deepEqual(folderbox.dialogArguments({ title: "Choose where to create the vault", pid: 1234, folder: inside, timeoutSeconds: 7 }).slice(-8), [
      "-Title",
      "Choose where to create the vault",
      "-ProcessId",
      "1234",
      "-Folder",
      inside,
      "-TimeoutSeconds",
      "7",
    ]);
    assert.throws(() => folderbox.dialogArguments({ title: "", pid: 1, folder: inside, timeoutSeconds: 7 }));
    assert.throws(() => folderbox.dialogArguments({ title: "x", pid: 0, folder: inside, timeoutSeconds: 7 }));
  } finally {
    rmSync(runRoot, { recursive: true, force: true });
  }
});

// ---- processes and ports -------------------------------------------------------------------------------------------

const FILE_TIME = (n) => String(133_000_000_000_000_000n + BigInt(n) * 10_000_000n);
const proc = (pid, ppid, at, name = "x.exe") => ({ pid, ppid, created: FILE_TIME(at), name });

test("parse_listeners_counts_what_it_found", () => {
  const text = [
    "",
    "Active Connections",
    "",
    "  Proto  Local Address          Foreign Address        State           PID",
    "  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1984",
    "  TCP    127.0.0.1:4444         0.0.0.0:0              LISTENING       3001",
    "  TCP    [::1]:4445             [::]:0                 LISTENING       3002",
    "  TCP    127.0.0.1:49700        0.0.0.0:0              LISTENING       3005",
    "  TCP    127.0.0.1:4444         127.0.0.1:50711        ESTABLISHED     3001",
    "  TCP    127.0.0.1:50711        127.0.0.1:4444         TIME_WAIT       0",
    "",
  ].join("\r\n");
  const found = app.parseListeners(text);
  assert.equal(found.length, 4, "four listening rows, and the established and waiting ones left out");
  assert.deepEqual(found[2], { address: "[::1]", port: 4445, pid: 3002 });
  assert.deepEqual(found[1], { address: "127.0.0.1", port: 4444, pid: 3001 });
});

test("the_listener_probe_reads_both_address_families", async (t) => {
  // `netstat -p tcp` lists IPv4 only; a debugging listener on [::1] would pass unseen. Two real listeners of this process:
  // one on each family, both found by the real probe, by this process's ID.
  const listen = (host) =>
    new Promise((resolve, reject) => {
      const server = net.createServer();
      server.once("error", reject);
      server.listen(0, host, () => resolve(server));
    });
  const four = await listen("127.0.0.1");
  let six = null;
  try {
    six = await listen("::1");
  } catch {
    t.diagnostic("this PC has no IPv6 loopback; the IPv6 half is skipped");
  }
  try {
    const found = app.tcpListeners();
    assert.ok(found.some((l) => l.pid === process.pid && l.port === four.address().port), "the IPv4 listener of this process is found");
    if (six !== null) {
      assert.ok(
        found.some((l) => l.pid === process.pid && l.port === six.address().port && l.address.includes(":")),
        "the IPv6 listener of this process is found",
      );
    }
  } finally {
    four.close();
    six?.close();
  }
});

test("the_probe_sees_a_port_only_the_processes_of_the_run_own", () => {
  // the run's driver 100 -> edge driver 101 -> app 102 -> web view 103 (listens on the debugging port); 200 is a bystander
  const snapshot = [proc(4, 0, 0), proc(100, 4, 10), proc(101, 100, 11), proc(102, 101, 12), proc(103, 102, 13), proc(200, 4, 5)];
  const listeners = [
    { address: "127.0.0.1", port: 4444, pid: 100 },
    { address: "127.0.0.1", port: 49700, pid: 103 },
    { address: "127.0.0.1", port: 9333, pid: 200 },
  ];
  const app102 = { pid: 102, created: FILE_TIME(12) };
  const driven = app.listenersOfTree([app102], snapshot, listeners);
  assert.deepEqual(driven.map((l) => l.port), [49700], "driven: the probe finds the debugging port, and only that");
  // the same probe on a launch with no driver: no listener below the app
  const plain = app.listenersOfTree([app102], snapshot, listeners.filter((l) => l.port !== 49700));
  assert.deepEqual(plain, [], "not driven: nothing listens below the app");
  // a wrong root finds nothing and says nothing wrong
  assert.deepEqual(app.listenersOfTree([{ pid: 102, created: FILE_TIME(99) }], snapshot, listeners), [], "a reused process ID is not the app");
});

test("tree_of_ignores_a_reused_parent_and_a_reused_id", () => {
  const snapshot = [proc(100, 4, 10), proc(101, 100, 11), proc(102, 101, 12), proc(300, 101, 5, "born-before-its-parent.exe")];
  const tree = app.treeOf([{ pid: 100, created: FILE_TIME(10) }], snapshot);
  assert.deepEqual(tree.map((p) => p.pid), [102, 101, 100], "deepest first; the process created before its parent is left out");
  assert.deepEqual(app.treeOf([{ pid: 100, created: FILE_TIME(11) }], snapshot), [], "a root whose creation time differs is not ours");
});

test("stop_tree_keeps_stopping_a_child_whose_parent_was_stopped_first", () => {
  // app 100 -> web view 101 -> renderer 102; 200 is a bystander. The first stop of 101 fails; 100 and 102 stop.
  let alive = [proc(100, 4, 10), proc(101, 100, 11), proc(102, 101, 12), proc(200, 4, 5)];
  let refusals = 1;
  const kill = (pid) => {
    if (pid === 101 && refusals > 0) {
      refusals -= 1;
      return;
    }
    alive = alive.filter((p) => p.pid !== pid);
  };
  const outcome = app.stopTree([{ pid: 100, created: FILE_TIME(10) }], { snapshot: () => alive, kill });
  assert.deepEqual(outcome.remaining, [], "nothing of the tree is reported left");
  assert.deepEqual(alive.map((p) => p.pid), [200], "the orphaned child was stopped on the next pass; the bystander still runs");
  assert.deepEqual(outcome.killed.filter((pid) => pid === 101).length, 2, "the child was tried again after its parent was gone");
});

test("stop_tree_does_not_follow_a_reused_id_of_a_stopped_child", () => {
  // 101 is stopped; its process ID is then reused by an unrelated program created later, with no parent in the tree.
  let alive = [proc(100, 4, 10), proc(101, 100, 11)];
  const kill = (pid) => {
    alive = alive.filter((p) => p.pid !== pid);
    if (pid === 100) alive.push(proc(101, 4, 50, "someone-else.exe"));
  };
  const outcome = app.stopTree([{ pid: 100, created: FILE_TIME(10) }], { snapshot: () => alive, kill });
  assert.deepEqual(outcome.remaining, []);
  assert.equal(alive.some((p) => p.pid === 101 && p.created === FILE_TIME(50)), true, "the program that reused the ID still runs");
});

test("the_driver_attaches_only_to_the_instance_it_started", () => {
  const driver = { pid: 100, created: FILE_TIME(10) };
  // driver 100 -> edge driver 101 -> app 102 -> web view 103 (debugging port 49700); a second, foreign instance 500 -> 501 on port 49701
  const snapshot = [proc(100, 4, 10), proc(101, 100, 11), proc(102, 101, 12), proc(103, 102, 13), proc(500, 4, 20), proc(501, 500, 21)];
  const listeners = [
    { address: "127.0.0.1", port: 49700, pid: 103 },
    { address: "127.0.0.1", port: 49701, pid: 501 },
  ];
  const good = app.checkAttached({ debuggerAddress: "localhost:49700", processId: 102, driver, snapshot, listeners });
  assert.deepEqual(good, { pid: 102, port: 49700 });
  const refusals = [
    // a session on the other instance (the one a person started): its process is not below the run's driver
    { debuggerAddress: "localhost:49701", processId: 500 },
    // the right app but a port that belongs to the other instance
    { debuggerAddress: "localhost:49701", processId: 102 },
    // a port nothing listens on
    { debuggerAddress: "localhost:49999", processId: 102 },
    // nothing reported
    { debuggerAddress: undefined, processId: 102 },
    { debuggerAddress: "localhost:49700", processId: undefined },
    { debuggerAddress: "localhost:49700", processId: 999 },
  ];
  let refused = 0;
  for (const claim of refusals) {
    assert.throws(() => app.checkAttached({ ...claim, driver, snapshot, listeners }), /not attached to the instance this run started/, JSON.stringify(claim));
    refused += 1;
  }
  assert.equal(refused, 6);
});

test("teardown_stops_only_the_processes_it_started", async () => {
  // Two real process trees: ours (a program that starts a child that starts a grandchild) and a bystander of the same
  // program. Stopping ours by process ID leaves the bystander running.
  const sleeper = "setInterval(() => {}, 1000);";
  const holder = mkdtempSync(join(tmpdir(), "e2e-tree-"));
  const childFile = join(holder, "child.mjs");
  const parentFile = join(holder, "parent.mjs");
  writeFileSync(
    childFile,
    `import { spawn } from "node:child_process";
const grandchild = spawn(process.execPath, ["-e", ${JSON.stringify(sleeper)}], { stdio: "ignore" });
console.log(grandchild.pid);
${sleeper}
`,
  );
  writeFileSync(
    parentFile,
    `import { spawn } from "node:child_process";
const child = spawn(process.execPath, [${JSON.stringify(childFile)}], { stdio: ["ignore", "pipe", "ignore"] });
child.stdout.once("data", (data) => console.log(child.pid + " " + String(data).trim()));
${sleeper}
`,
  );
  const ours = spawn(process.execPath, [parentFile], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
  const bystander = spawn(process.execPath, ["-e", sleeper], { stdio: "ignore", windowsHide: true });
  try {
    const line = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("the process tree did not start")), 15_000);
      ours.stdout.once("data", (data) => {
        clearTimeout(timer);
        resolve(String(data).trim());
      });
    });
    const [childPid, grandPid] = line.split(" ").map(Number);
    assert.ok(Number.isInteger(childPid) && Number.isInteger(grandPid), `the tree reported its processes (${line})`);
    const here = app.snapshotProcesses();
    const mine = here.find((p) => p.pid === ours.pid);
    const theirs = here.find((p) => p.pid === bystander.pid);
    assert.ok(mine && theirs && here.some((p) => p.pid === grandPid), "all of them show to Windows");
    // what Windows says is below ours: the three, and perhaps a console host Windows made for one of them
    const expected = app.treeOf([{ pid: ours.pid, created: mine.created }], here).map((p) => p.pid);
    for (const pid of [ours.pid, childPid, grandPid]) assert.ok(expected.includes(pid), `${pid} is below ours`);
    assert.equal(expected.includes(bystander.pid), false, "the bystander is not below ours");
    const outcome = app.stopTree([{ pid: ours.pid, created: mine.created }]);
    assert.deepEqual([...outcome.killed].sort(), [...expected].sort(), "exactly what was below ours was stopped");
    assert.deepEqual(outcome.remaining, []);
    await sleep(500);
    const after = app.snapshotProcesses();
    for (const pid of [ours.pid, childPid, grandPid]) assert.equal(after.some((p) => p.pid === pid), false, `${pid} is gone`);
    assert.equal(after.some((p) => p.pid === bystander.pid && p.created === theirs.created), true, "the bystander still runs");
  } finally {
    bystander.kill();
    try {
      // whatever of our tree is still there (a failed assertion above), by the same routine under test
      const mine = app.snapshotProcesses().find((p) => p.pid === ours.pid);
      if (mine) app.stopTree([{ pid: ours.pid, created: mine.created }]);
    } catch {
      ours.kill();
    }
    await sleep(300);
    rmSync(holder, { recursive: true, force: true });
  }
});

test("the_environment_for_a_run_is_for_the_child_only", () => {
  const base = {
    PATH: "C:\\Windows",
    TEMP: "C:\\Users\\Someone\\Temp",
    Tmp: "C:\\Users\\Someone\\Temp",
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=9333",
    webview2_user_data_folder: "C:\\Users\\Someone\\real-cache",
    TAURI_WEBVIEW_AUTOMATION: "true",
    KEEP: "yes",
  };
  const copy = { ...base };
  const env = app.runEnvironment(base, { tempDir: "C:\\run\\temp", webviewDir: "C:\\run\\webview" });
  assert.deepEqual(base, copy, "the caller's environment is unchanged");
  assert.equal(env.TEMP, "C:\\run\\temp");
  assert.equal(env.TMP, "C:\\run\\temp");
  assert.equal(env.WEBVIEW2_USER_DATA_FOLDER, "C:\\run\\webview");
  assert.equal(env.KEEP, "yes");
  assert.equal(env.PATH, "C:\\Windows");
  const names = Object.keys(env).map((name) => name.toUpperCase());
  assert.equal(names.filter((name) => name === "TEMP").length, 1, "one TEMP, the run's");
  assert.equal(names.includes("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS"), false, "a debugging argument of the caller's is not passed on");
  assert.equal(names.includes("TAURI_WEBVIEW_AUTOMATION"), false);
});

// ---- an elevated run (the GitHub job) ------------------------------------------------------------------------------

/** A fake reg.exe over a set of keys and `key\value` entries; records every call. */
const WINDOWS_KEYS = ["HKLM\\SOFTWARE", "HKLM\\SOFTWARE\\Policies", "HKLM\\SOFTWARE\\Policies\\Microsoft"];
function fakeRegistry(keys = [], values = [], { failAdd = false } = {}) {
  const k = new Set([...WINDOWS_KEYS, ...keys].map((key) => key.toLowerCase()));
  const v = new Set(values.map((value) => value.toLowerCase()));
  const calls = [];
  const parents = (key) => key.split("\\").map((_, index, parts) => parts.slice(0, index + 1).join("\\")).slice(1);
  const reg = (args) => {
    calls.push(args.join(" "));
    const [verb, key] = args;
    const name = args.includes("/v") ? `${key}\\${args[args.indexOf("/v") + 1]}`.toLowerCase() : undefined;
    if (verb === "query") return (name ? v.has(name) : k.has(key.toLowerCase())) ? 0 : 1;
    if (verb === "add") {
      if (failAdd) return 1;
      for (const parent of parents(key)) k.add(parent.toLowerCase());
      v.add(name);
      return 0;
    }
    if (verb === "delete" && name) return v.delete(name) ? 0 : 1;
    if (verb === "delete") {
      const lower = key.toLowerCase();
      if (!k.has(lower)) return 1;
      for (const each of [...k]) if (each === lower || each.startsWith(`${lower}\\`)) k.delete(each);
      for (const each of [...v]) if (each.startsWith(`${lower}\\`)) v.delete(each);
      return 0;
    }
    throw new Error(`unexpected reg call: ${args.join(" ")}`);
  };
  return { reg, calls, keys: k, values: v };
}

test("an_elevated_run_is_known_from_its_integrity_level", () => {
  const groups = (level) => `BUILTIN\\Administrators  Alias  S-1-5-32-544  Mandatory group\r\nMandatory Label\\${level}`;
  assert.equal(app.elevatedFromGroups(groups("High Mandatory Level  Label  S-1-16-12288")), true, "high: elevated");
  assert.equal(app.elevatedFromGroups(groups("System Mandatory Level  Label  S-1-16-16384")), true, "system: elevated");
  assert.equal(app.elevatedFromGroups(groups("Medium Mandatory Level  Label  S-1-16-8192")), false, "medium (an administrator without elevation): not");
  assert.equal(app.elevatedFromGroups("S-1-16-122880"), false, "a longer number is not the level");
  assert.equal(typeof app.isElevated(), "boolean", "Windows answered for this run");
});

test("the_machine_policy_is_used_only_elevated_on_the_github_job", () => {
  assert.equal(app.drivenLaunchNeeds({ elevated: false, ci: false }), "nothing");
  assert.equal(app.drivenLaunchNeeds({ elevated: false, ci: true }), "nothing", "a job that is not elevated sets nothing");
  assert.equal(app.drivenLaunchNeeds({ elevated: true, ci: true }), "policy");
  assert.throws(() => app.drivenLaunchNeeds({ elevated: true, ci: false }), /elevated.*not elevated/, "an elevated PC run is refused");
});

test("start_lockbox_refuses_an_elevated_run_off_the_job_before_anything_starts", async () => {
  const holder = mkdtempSync(join(tmpdir(), "lockbox-e2e-elevated-"));
  try {
    const where = { tauriDriver: join(holder, "no-such-driver.exe"), nativeDriver: join(holder, "no-such-native.exe"), tempDir: join(holder, "temp"), webviewDir: join(holder, "webview"), logFile: join(holder, "driver.log") };
    await assert.rejects(app.startLockbox({ ...where, base: { LOCKBOX_E2E_CI: "true" }, elevated: true }), /elevated/, "only the marker's own value is the job");
    assert.deepEqual(readdirSync(holder), [], "no folder, log or process was made");
  } finally {
    rmSync(holder, { recursive: true, force: true });
  }
});

test("start_lockbox_sets_the_policy_only_elevated_on_the_job_and_a_failed_start_removes_it", async () => {
  const holder = mkdtempSync(join(tmpdir(), "lockbox-e2e-policy-"));
  try {
    const where = (name) => ({ tauriDriver: join(holder, "no-such-driver.exe"), nativeDriver: join(holder, "no-such-native.exe"), tempDir: join(holder, name, "temp"), webviewDir: join(holder, name, "webview"), logFile: join(holder, `${name}.log`) });
    // not elevated: reg.exe is never asked
    const plain = fakeRegistry();
    await assert.rejects(app.startLockbox({ ...where("plain"), base: { LOCKBOX_E2E_CI: "1" }, elevated: false, reg: plain.reg }));
    assert.deepEqual(plain.calls, [], "a run that is not elevated touches no policy");
    // elevated on the job: set before the driver starts, and gone again when it does not start
    const job = fakeRegistry();
    await assert.rejects(app.startLockbox({ ...where("job"), base: { LOCKBOX_E2E_CI: "1" }, elevated: true, reg: job.reg }));
    assert.ok(job.calls.some((call) => call.startsWith("add ")), "the policy was set");
    assert.equal(job.keys.size - WINDOWS_KEYS.length + job.values.size, 0, "the failed start left no policy");
    // a removal that fails is said in the error
    const stuck = fakeRegistry();
    const stuckReg = (args) => (args[0] === "delete" ? 1 : stuck.reg(args));
    await assert.rejects(app.startLockbox({ ...where("stuck"), base: { LOCKBOX_E2E_CI: "1" }, elevated: true, reg: stuckReg }), /policy could not be removed/);
  } finally {
    rmSync(holder, { recursive: true, force: true });
  }
});

test("the_policy_is_set_for_the_app_and_removed_with_the_keys_it_made", () => {
  const [edge, webview2, args] = app.POLICY_KEYS;
  // a fresh runner: none of the keys exists
  const fresh = fakeRegistry();
  const undo = app.setDebuggingPolicy(fresh.reg);
  assert.deepEqual(undo.created, [edge, webview2, args], "all three keys were made by this run");
  assert.ok(fresh.calls.includes(`add ${args} /v lockbox-desktop.exe /t REG_SZ /d --remote-debugging-port=0 /f`), "the switch is set for lockbox-desktop.exe alone");
  assert.equal(fresh.values.size, 1);
  assert.deepEqual(app.removeDebuggingPolicy(undo, fresh.reg), [], "nothing is left");
  assert.equal(fresh.keys.size - WINDOWS_KEYS.length + fresh.values.size, 0, "the machine is as it was");
  // a machine with Edge policies of its own: only what this run made goes
  const kept = fakeRegistry([edge, webview2, args], [`${args}\\other.exe`]);
  const undoKept = app.setDebuggingPolicy(kept.reg);
  assert.deepEqual(undoKept.created, [], "no key was made");
  assert.deepEqual(app.removeDebuggingPolicy(undoKept, kept.reg), []);
  assert.deepEqual([...kept.keys].sort(), [...WINDOWS_KEYS, edge, webview2, args].map((key) => key.toLowerCase()).sort(), "the machine's own keys stay");
  assert.deepEqual([...kept.values], [`${args}\\other.exe`.toLowerCase()], "another program's policy stays");
});

test("a_policy_already_there_is_left_alone_and_a_failed_set_leaves_nothing", () => {
  const [edge, webview2, args] = app.POLICY_KEYS;
  const theirs = fakeRegistry([edge, webview2, args], [`${args}\\lockbox-desktop.exe`]);
  assert.throws(() => app.setDebuggingPolicy(theirs.reg), /already has a WebView2 policy/);
  assert.equal(theirs.calls.some((call) => call.startsWith("add ") || call.startsWith("delete ")), false, "nothing was changed");
  const failing = fakeRegistry([], [], { failAdd: true });
  assert.throws(() => app.setDebuggingPolicy(failing.reg), /could not set/);
  assert.equal(failing.keys.size - WINDOWS_KEYS.length + failing.values.size, 0, "nothing is left");
});

test("stop_lockbox_removes_the_policy_after_the_processes_and_says_what_is_left", () => {
  const order = [];
  const stop = () => {
    order.push("stop");
    return { killed: [7], remaining: [] };
  };
  const removePolicy = (policy) => {
    order.push("policy");
    return policy.left;
  };
  assert.deepEqual(app.stopLockbox({ pid: 7, created: "1" }, { stop, removePolicy }), { killed: [7], remaining: [] }, "no policy: none removed");
  assert.deepEqual(order, ["stop"]);
  order.length = 0;
  assert.deepEqual(app.stopLockbox({ pid: 7, created: "1", policy: { created: [], left: [] } }, { stop, removePolicy }).remaining, []);
  assert.deepEqual(order, ["stop", "policy"], "the app is stopped before its policy goes");
  const left = app.stopLockbox({ pid: 7, created: "1", policy: { created: [], left: ["HKLM\\x"] } }, { stop, removePolicy });
  assert.deepEqual(left.remaining, ["HKLM\\x"], "a policy left behind is reported as left running");
  order.length = 0;
  const broken = () => {
    order.push("stop");
    throw new Error("Windows did not answer");
  };
  assert.throws(() => app.stopLockbox({ pid: 7, created: "1", policy: { created: [], left: ["HKLM\\x"] } }, { stop: broken, removePolicy }), /did not answer.*could not be removed: HKLM\\x/);
  assert.deepEqual(order, ["stop", "policy"], "the policy goes even when stopping failed");
});

test("clipboard_and_shortcut_steps_run_on_ci_and_locally_only_when_the_pc_is_free", () => {
  assert.deepEqual(app.clipboardSteps({ LOCKBOX_E2E_CI: "1" }), { run: true, why: "on the GitHub end-to-end job" });
  const local = app.clipboardSteps({});
  assert.equal(local.run, false);
  assert.match(local.why, /skipped here.*LOCKBOX_E2E_PC_FREE=1/);
  assert.equal(app.clipboardSteps({ LOCKBOX_E2E_PC_FREE: "0" }).run, false);
  assert.equal(app.clipboardSteps({ LOCKBOX_E2E_PC_FREE: "true" }).run, false, "only 1 counts");
  assert.deepEqual(app.clipboardSteps({ LOCKBOX_E2E_PC_FREE: "1" }), { run: true, why: "LOCKBOX_E2E_PC_FREE=1" });
});

// ---- the driver and its version ------------------------------------------------------------------------------------

test("the_driver_is_found_from_the_flag_then_the_environment_then_the_ci_image", () => {
  const dir = mkdtempSync(join(tmpdir(), "e2e-driver-"));
  try {
    const make = (name) => {
      mkdirSync(join(dir, name));
      const file = join(dir, name, "msedgedriver.exe");
      writeFileSync(file, "not a program, a stand-in file");
      return file;
    };
    const flag = make("flag");
    const fromEnv = make("env");
    const ciDir = join(dir, "ci");
    mkdirSync(ciDir);
    const ci = join(ciDir, "msedgedriver.exe");
    writeFileSync(ci, "x");
    assert.equal(e2e.findNativeDriver({ flag, env: { LOCKBOX_EDGEDRIVER: fromEnv, EDGEWEBDRIVER: ciDir, LOCKBOX_E2E_CI: "1" } }), flag);
    assert.equal(e2e.findNativeDriver({ env: { LOCKBOX_EDGEDRIVER: fromEnv, EDGEWEBDRIVER: ciDir, LOCKBOX_E2E_CI: "1" } }), fromEnv);
    assert.equal(e2e.findNativeDriver({ env: { EDGEWEBDRIVER: ciDir, LOCKBOX_E2E_CI: "1" } }), ci);
    assert.throws(() => e2e.findNativeDriver({ env: { EDGEWEBDRIVER: ciDir } }), /--edgedriver|LOCKBOX_EDGEDRIVER/, "the CI image's folder is used on CI only");
    assert.throws(() => e2e.findNativeDriver({ env: {} }), /--edgedriver|LOCKBOX_EDGEDRIVER/);
    assert.throws(() => e2e.findNativeDriver({ flag: join(dir, "missing", "msedgedriver.exe"), env: {} }), /not found|does not exist/);
    assert.throws(() => e2e.findNativeDriver({ flag: "msedgedriver.exe", env: {} }), /full path/);
    const wrongName = join(dir, "flag", "other.exe");
    writeFileSync(wrongName, "x");
    assert.throws(() => e2e.findNativeDriver({ flag: wrongName, env: {} }), /msedgedriver\.exe/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a_driver_of_another_major_version_than_the_web_view_runtime_is_refused", () => {
  // the shapes are from this PC's real answers (msedgedriver --version, and the registry value `pv`)
  assert.equal(e2e.parseDriverVersion("Microsoft Edge WebDriver 158.0.4370.33 (56b8f691820060b6e15f702165117f203442943f)\r\n"), "158.0.4370.33");
  assert.equal(e2e.parseDriverVersion("garbage"), null);
  const reg = [
    "",
    "HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
    "    pv    REG_SZ    158.0.4370.33",
    "",
  ].join("\r\n");
  assert.equal(e2e.parseRegistryVersion(reg), "158.0.4370.33");
  assert.equal(e2e.parseRegistryVersion("nothing here"), null);
  // Microsoft's rule: the first three parts match (only the last, the patch, may differ)
  assert.doesNotThrow(() => e2e.checkVersions("158.0.4370.33", "158.0.4370.40"));
  assert.throws(() => e2e.checkVersions("157.0.4341.60", "158.0.4370.33"), /157\.0\.4341\.60.*158\.0\.4370\.33|158\.0\.4370\.33.*157\.0\.4341\.60/);
  // the same major with another build branch is refused too
  assert.throws(() => e2e.checkVersions("158.0.4370.33", "158.0.4381.2"), /158\.0\.4370\.33.*158\.0\.4381\.2|158\.0\.4381\.2.*158\.0\.4370\.33/);
  assert.throws(() => e2e.checkVersions("158.1.4370.33", "158.0.4370.33"), /first three/);
  assert.throws(() => e2e.checkVersions(null, "158.0.4370.33"), /Edge WebDriver/);
  assert.throws(() => e2e.checkVersions("158.0.4370.33", null), /runtime/);
});

test("the_release_build_is_built_as_the_check_builds_it", () => {
  const commands = e2e.buildCommands();
  assert.deepEqual(commands.map((c) => c.name), ["ui-build", "release-build"], "the page first, then the app that embeds it");
  const phases = checks({ scan: false, areas: null });
  const all = phases.flat(2);
  const theirs = all.find((step) => step.name === "release-build");
  const uiBuild = all.find((step) => step.name === "ui-build");
  assert.ok(theirs && uiBuild, "the check has both steps");
  assert.equal(commands[1].cmd, theirs.cmd);
  assert.deepEqual(commands[1].args, theirs.args, "the same cargo command as the full check's release build");
  assert.deepEqual(commands[0].args, uiBuild.args);
  assert.ok(commands[1].args.includes("--release") && commands[1].args.includes("--locked") && commands[1].args.includes("custom-protocol"));
});

test("a_build_that_cannot_start_is_reported_once", async () => {
  // Node emits `error` and then `close` when a program cannot be started; the log must be closed once and the answer given once.
  const holder = mkdtempSync(join(tmpdir(), "e2e-build-"));
  try {
    const code = await e2e.runLogged({ name: "no-such-program", cmd: join(holder, "no-such-program.exe"), args: [] }, join(holder, "logs", "x.log"));
    assert.equal(code, 127, "the failure to start is answered as 127");
    assert.equal(existsSync(join(holder, "logs", "x.log")), true, "its log was made");
  } finally {
    rmSync(holder, { recursive: true, force: true });
  }
});

test("a_skipped_step_fails_a_run_on_ci_and_is_only_said_elsewhere", () => {
  const lines = ["pass creates the vault", "pass unlocks", "skip the clipboard check: skipped here", "skip the auto-lock check: the PC was in use"];
  const here = e2e.judgeSpecResults(lines, { ci: false, code: 0 });
  assert.equal(here.ok, true, "locally a skip is said, not failed");
  assert.deepEqual([here.passed, here.failed, here.skipped.length], [2, 0, 2]);
  const ci = e2e.judgeSpecResults(lines, { ci: true, code: 0 });
  assert.equal(ci.ok, false, "on CI a skipped step fails the run");
  assert.match(ci.reasons.join(" "), /skipped on CI/);
  assert.equal(e2e.judgeSpecResults(["pass a", "pass b"], { ci: true, code: 0 }).ok, true);
  assert.equal(e2e.judgeSpecResults(["pass a", "fail b"], { ci: false, code: 0 }).ok, false, "a failed step fails the run");
  assert.equal(e2e.judgeSpecResults([], { ci: false, code: 0 }).ok, false, "a run that passed nothing is not a pass");
  assert.equal(e2e.judgeSpecResults(["pass a"], { ci: false, code: 1 }).ok, false, "a non-zero exit fails the run");
});

test("arguments_are_read_as_documented", () => {
  assert.deepEqual(e2e.parseArgs([], {}), { edgedriver: undefined, specs: [] });
  assert.deepEqual(e2e.parseArgs(["--edgedriver", "C:\\tools\\msedgedriver.exe", "thin-path"], {}), { edgedriver: "C:\\tools\\msedgedriver.exe", specs: ["thin-path"] });
  assert.match(e2e.parseArgs(["--edgedriver"], {}).error, /--edgedriver needs/);
  assert.match(e2e.parseArgs(["--nope"], {}).error, /unknown argument/);
  assert.match(e2e.parseArgs(["..\\..\\x"], {}).error, /spec name/);
});

test("a_failed_ci_run_keeps_its_logs_and_nothing_else", () => {
  const holder = mkdtempSync(join(tmpdir(), "lockbox-e2e-keep-"));
  try {
    const runRoot = join(holder, "run");
    for (const dir of ["logs", "driven/temp/scoped_dir1/EBWebView", "normal/webview", "vaults"]) mkdirSync(join(runRoot, dir), { recursive: true });
    writeFileSync(join(runRoot, "logs", "real-app.tap"), "TAP");
    writeFileSync(join(runRoot, "logs", "tauri-driver.log"), "driver");
    writeFileSync(join(runRoot, "driven", "driver.log"), "driven driver");
    writeFileSync(join(runRoot, "driven", "temp", "scoped_dir1", "EBWebView", "Local State"), "web view data");
    writeFileSync(join(runRoot, "vaults", "made-up.lbx"), "vault");
    const dest = join(holder, "kept");
    const [line] = e2e.keepRunLogs(runRoot, dest);
    assert.deepEqual(readdirSync(dest).sort(), ["driven-driver.log", "real-app.tap", "tauri-driver.log"], "only the logs are kept");
    assert.equal(readFileSync(join(dest, "driven-driver.log"), "utf8"), "driven driver");
    assert.match(line, /kept in/);
    const empty = join(holder, "empty");
    mkdirSync(empty);
    assert.deepEqual(e2e.keepRunLogs(empty, join(holder, "kept-empty")), ["e2e: the run left no logs to keep"]);
  } finally {
    rmSync(holder, { recursive: true, force: true });
  }
});
