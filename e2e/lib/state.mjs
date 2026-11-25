// Sets Petalock's real state aside while a hands-on check or an end-to-end run uses a test state, and puts it back.
//
// Where the release app keeps its state on Windows (read from the code, not guessed):
//   state       <LocalAppData>\Petalock  the vault list, the journals and the "open" folders
//                                        (crates/lockbox-desktop/src/paths.rs, state_paths)
//   appLocal    <LocalAppData>\io.github.sumguywhowantstobuild.petalock
//                                        Tauri's app-local folder (app_local_data_dir). It holds WebView2's profile
//                                        (EBWebView), Tauri's default web-view data folder, as the app sets no
//                                        data_directory of its own
//   appRoaming  <RoamingAppData>\io.github.sumguywhowantstobuild.petalock
//                                        Tauri's app-data folder (app_data_dir, lib.rs). It may not exist
//   vaults      <Profile>\Petalock Vaults
//                                        the default folder new vaults are made in (paths.rs)
// The identifier comes from crates/lockbox-desktop/tauri.conf.json; a test compares the two. The three roots are asked
// of Windows (its known-folder lookup, as the app does), and a command refuses when %LOCALAPPDATA%, %APPDATA% or
// %USERPROFILE% in the environment says something else, so a stale shell can't point a swap at the wrong folders.
//
//   node e2e/lib/state.mjs status       what is set aside now, in words
//   node e2e/lib/state.mjs recover      puts everything back, from wherever a swap stopped
//   node e2e/lib/state.mjs in <run>     sets the real folders aside and puts the run's test state in place
//   node e2e/lib/state.mjs back <run>   keeps the test state beside the real folders and puts the real ones back
//
// How a swap works. `in` checks every location first (none may be a link, or the same as or inside another once the
// links on the way to it are resolved; nothing may sit at a name it will use) and refuses, renaming nothing, if any
// check fails or if Petalock runs. Then it writes a journal beside the vaults folder in the profile (the one place every
// terminal sees alike; a uniquely named temp file made exclusively, renamed into place), recording each existing folder's identity (volume and file ID), and for each location
// that exists puts a sentinel file naming the run inside it, renames it to `<folder>.aside-<run>`, and moves a kept
// `<folder>.test-<run>` into its place if there is one; otherwise the place stays empty so the app starts fresh. `back`
// and `recover` are one routine: they look at what is on disk, and finish putting each original back from whichever
// step a swap stopped at. The test state in place is renamed to `<folder>.test-<run>` and kept (it holds made-up data
// only), the aside folder is renamed back, its sentinel removed, and the journal removed last.
//
// A packaged app's private copy. An app installed as a package (MSIX), and every program it starts, sees its own copy of
// AppData: `<LocalAppData>\Petalock` is really `<LocalAppData>\Packages\<family>\LocalCache\Local\Petalock`, and the
// roaming folder is the same under `LocalCache\Roaming`. A run started from such an app therefore swaps that app's
// private copy, which is the one the release app started from the same place opens. Whether a location is seen that way
// is decided by identity (the same device and file ID as a package copy of the same leaf, any family), because the real
// path is not a reliable witness; the journal then records the family, and a link to the copy is accepted for that
// location (any other link is refused). The vaults folder is never redirected. Right after each set-aside rename the
// place must be empty: if a real folder outside the private copy shows through there, its identity is recorded in the
// journal and the swap stops at once. The folder that shows is never moved, by this command or by recover. The set-aside
// copy is renamed back over it and everything before it is put back; if the system refuses that rename, the swap stops
// there with the journal kept and nothing after that location is touched. The one exception is appLocal, where that
// real folder holds only the web-view cache: it is allowed, said in `in` and `status` (by identity, as it is visible
// now), and swap back and recover treat a folder at the place with the recorded identity as not test state (a different
// one is the test state the app wrote, and is kept) before renaming the private copy back over it, stopping the same way
// if the system refuses.
//
// Seen from outside the app. The journal and the lock are shared by every terminal, but the places a packaged app moved
// are spelled differently outside it. A terminal where neither the place nor the aside name shows the folder recorded as
// a private copy's original refuses `recover` and `back` and changes nothing; `status` says so: "this swap was started
// inside the <family> app; run recover from a terminal inside that app".
//
// One command at a time. `in`, `back` and `recover` hold a lock file (`<journal>.lock`, made exclusively, holding the
// process id) from before they read the journal to after their last rename. A lock whose process is alive refuses the
// command; a lock whose process is gone is taken over, and the result says so. A lock is removed only if it still holds
// this process's id. A lock whose process id has been reused by an unrelated program refuses until it is deleted by hand.
// Petalock is looked for again before each location is touched; if it appears, the command stops with the journal kept.
//
// What recover touches. It moves a folder out of the way only to keep a test state, and treats a folder as the original
// only when its identity is the one recorded; an aside folder is put back only when the sentinel inside it also names
// the journal's run. A folder at an aside name without that sentinel is never moved: it is reported. The only things
// deleted are files this tool made: its sentinels, the journal and the lock. No folder is ever deleted. Messages name
// the location and the run, never a path or a file's contents.

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** The order locations are handled in, and the only keys there are. */
export const LOCATION_KEYS = ["state", "appLocal", "appRoaming", "vaults"];

const IDENTIFIER = "io.github.sumguywhowantstobuild.petalock";
const SHOWN_THROUGH_LINE = "appLocal: a web-view folder outside the app's private copy shows through (cache only)";
const SENTINEL = ".lockbox-test-swap.json";
const RUN_NAME = /^[a-z0-9-]{1,40}$/;
const MAX_SMALL_FILE = 10_000;
const USAGE = "usage: node e2e/lib/state.mjs status | recover | in <run> | back <run>   (a run is 1-40 of a-z, 0-9, -)";

/** A refusal in plain words. `lines` holds everything worth showing, the reason included. */
export class SwapRefused extends Error {
  constructor(message, lines = [message]) {
    super(message);
    this.name = "SwapRefused";
    this.lines = lines;
  }
}

const refuse = (message) => {
  throw new SwapRefused(message);
};

// ---- Windows' answers ---------------------------------------------------------------------------------------------

/** The full path of a program in Windows' System32 folder, never found by searching the path. */
export function systemTool(relativePath, env = process.env) {
  const root = typeof env.SystemRoot === "string" && isAbsolute(env.SystemRoot) ? env.SystemRoot : "C:\\Windows";
  return join(root, "System32", relativePath);
}

/** The three roots, as Windows' known-folder lookup gives them: `{ localAppData, roamingAppData, profile }`. */
export function knownFolders() {
  const powershell = systemTool(join("WindowsPowerShell", "v1.0", "powershell.exe"));
  const ask = (script, extraEnv) => {
    // Windows expands the app-data known folders with the caller's %USERPROFILE%, and a child process always gets that
    // variable, so it is set here on purpose in every call and never passed on from the shell: the answer must not
    // depend on what a stale shell says, and PowerShell's own start-up files go where it is told, not into a stale folder.
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !["LOCALAPPDATA", "APPDATA", "USERPROFILE"].includes(name.toUpperCase())),
    );
    // nosemgrep: javascript.lang.security.detect-child-process.detect-child-process -- a fixed program by its full path and a fixed script
    const result = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${script}`], {
      encoding: "utf8",
      env: { ...env, ...extraEnv },
      windowsHide: true,
    });
    return result.status === 0 ? result.stdout.split(/\r?\n/).filter((line) => line !== "") : [];
  };
  // the profile folder comes from the account itself; the others are asked with that profile in the environment
  const profile = ask("[Environment]::GetFolderPath('UserProfile')", { USERPROFILE: tmpdir() });
  const apps = profile.length === 1 && isAbsolute(profile[0])
    ? ask("[Environment]::GetFolderPath('LocalApplicationData'); [Environment]::GetFolderPath('ApplicationData')", { USERPROFILE: profile[0] })
    : [];
  if (apps.length !== 2 || !apps.every((line) => isAbsolute(line))) {
    refuse("could not ask Windows where the app's folders are, so nothing was changed");
  }
  return { localAppData: apps[0], roamingAppData: apps[1], profile: profile[0] };
}

/** The four locations as absolute paths, each under its short key, from the three roots. */
export function locationsFrom({ localAppData, roamingAppData, profile }) {
  return {
    state: join(resolve(localAppData), "Petalock"),
    appLocal: join(resolve(localAppData), IDENTIFIER),
    appRoaming: join(resolve(roamingAppData), IDENTIFIER),
    vaults: join(resolve(profile), "Petalock Vaults"),
  };
}

/**
 * The real locations: the roots from Windows' lookup, refused when an environment variable names a different folder or
 * none. `env` and `lookup` are replaced only in tests.
 */
export function defaultLocations({ env = process.env, lookup = knownFolders } = {}) {
  const known = lookup();
  const pairs = [
    ["LOCALAPPDATA", known.localAppData],
    ["APPDATA", known.roamingAppData],
    ["USERPROFILE", known.profile],
  ];
  for (const [name, folder] of pairs) {
    const value = env[name];
    if (typeof value !== "string" || value === "" || !isAbsolute(value) || normal(value) !== normal(folder)) {
      refuse(`${name} is missing or names a different folder than Windows gives for it, so nothing was changed`);
    }
  }
  return locationsFrom(known);
}

/** True when `tasklist`'s CSV answer lists a Petalock process (the name only, so the language of Windows doesn't matter). */
export function parseTasklist(output) {
  return /"lockbox-desktop\.exe"/i.test(output);
}

/** Asks Windows whether `lockbox-desktop.exe` runs. Throws when it can't ask: the callers then refuse. */
export function isLockboxRunning() {
  // nosemgrep: javascript.lang.security.detect-child-process.detect-child-process -- a fixed program by its full path and fixed arguments
  const result = spawnSync(systemTool("tasklist.exe"), ["/FI", "IMAGENAME eq lockbox-desktop.exe", "/NH", "/FO", "CSV"], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error || result.status !== 0) throw new Error("could not ask Windows which programs are running");
  return parseTasklist(result.stdout);
}

// ---- looking at the disk ------------------------------------------------------------------------------------------

const same = (a, b) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);
const normal = (p) => (process.platform === "win32" ? resolve(p).toLowerCase() : resolve(p));

const isInside = (child, parent) => {
  const rel = relative(normal(parent), normal(child));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
};

/** "absent", "dir", "file", "link" (a symlink or junction) or "other", never following a link. */
function kindOf(path) {
  let info;
  try {
    info = lstatSync(path);
  } catch (error) {
    if (error.code === "ENOENT") return "absent";
    throw error;
  }
  if (info.isSymbolicLink()) return "link";
  if (info.isDirectory()) return "dir";
  return info.isFile() ? "file" : "other";
}

/** A folder's identity on its volume (device and file ID, as text), or null when it can't be read. */
function identityOf(path) {
  try {
    const info = statSync(path, { bigint: true });
    return { dev: String(info.dev), ino: String(info.ino) };
  } catch {
    return null;
  }
}

const identityIs = (path, id) => {
  const found = identityOf(path);
  return found !== null && found.dev === id.dev && found.ino === id.ino;
};

const identityMatches = (path, entry) => identityIs(path, entry.identity);

/** A package family name as Windows writes it, e.g. `Name_publisherid`: letters, digits, dot, dash, underscore. */
const FAMILY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * A packaged (MSIX) app and the programs it starts see their own private copy of AppData: the folder spelled
 * `<LocalAppData>\Petalock` is really `<LocalAppData>\Packages\<family>\LocalCache\Local\Petalock`. Whether a location is
 * seen that way is decided by identity, never by the realpath (which is not reliable here): the spelled folder and one
 * package copy of the same leaf (`Local` for state and appLocal, `Roaming` for appRoaming) must be the same folder by
 * device and file ID. Returns `{ family, copy }` or undefined. The vaults folder is never redirected.
 */
function findRedirect(key, ctx) {
  if (key === "vaults") return undefined;
  const path = ctx.locations[key];
  const spelled = identityOf(path);
  if (spelled === null || spelled.ino === "0") return undefined;
  const packages = join(dirname(ctx.locations.state), "Packages");
  let families;
  try {
    families = readdirSync(packages).sort();
  } catch {
    return undefined;
  }
  for (const family of families) {
    if (!FAMILY.test(family)) continue;
    const copy = join(packages, family, "LocalCache", key === "appRoaming" ? "Roaming" : "Local", basename(path));
    try {
      if (kindOf(copy) !== "dir") continue;
    } catch {
      continue;
    }
    const found = identityOf(copy);
    if (found !== null && found.dev === spelled.dev && found.ino === spelled.ino) return { family, copy };
  }
  return undefined;
}

const asidePath = (path, run) => `${path}.aside-${run}`;
const testPath = (path, run) => `${path}.test-${run}`;

function readSmallJson(path) {
  try {
    if (kindOf(path) !== "file" || statSync(path).size > MAX_SMALL_FILE) return null;
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** True when `dir` holds this tool's sentinel naming this run and this location. */
function ownsSentinel(dir, run, key) {
  const found = readSmallJson(join(dir, SENTINEL));
  return found !== null && found.lockboxTestSwap === 1 && found.run === run && found.key === key;
}

function removeSentinel(dir, run, key) {
  if (ownsSentinel(dir, run, key)) unlinkSync(join(dir, SENTINEL));
}

// ---- the options every operation reads ----------------------------------------------------------------------------

function context(options) {
  const locations = options.locations ?? defaultLocations();
  const keys = Object.keys(locations);
  if (keys.length !== LOCATION_KEYS.length || !LOCATION_KEYS.every((key) => keys.includes(key))) {
    refuse(`the locations must be exactly: ${LOCATION_KEYS.join(", ")}`);
  }
  for (const key of LOCATION_KEYS) {
    if (typeof locations[key] !== "string" || !isAbsolute(locations[key])) refuse(`location ${key} is not a full path`);
  }
  // Beside the vaults folder in the profile: the one place every terminal sees alike. A packaged app and its children
  // see a private copy of AppData, so a journal or lock kept there would be invisible from any other terminal.
  const journal = options.journal ?? join(dirname(locations.vaults), `${basename(locations.vaults)}.swap-journal.json`);
  return {
    locations,
    journal,
    isRunning: options.isRunning ?? isLockboxRunning,
    step: options.afterStep ?? (() => {}),
    // every move of a location's folder goes through this one name (replaced only in tests)
    rename: options.rename ?? renameSync,
  };
}

function checkRunName(run) {
  if (typeof run !== "string" || !RUN_NAME.test(run)) refuse("a run name is 1 to 40 of a-z, 0-9 and -");
}

/**
 * Refuses unless the answer is exactly `false`: a question that couldn't be asked counts as running. `midway` is for the
 * checks made while folders are being moved, which say that the journal is kept.
 */
function refuseWhileRunning(ctx, midway = false) {
  let running;
  try {
    running = ctx.isRunning();
  } catch {
    refuse(
      midway
        ? "could not check whether Petalock is running; stopped with the journal kept. Close Petalock, then run recover"
        : "could not check whether Petalock is running, so nothing was changed",
    );
  }
  if (running !== false) {
    refuse(
      midway
        ? "Petalock is running; stopped with the journal kept. Close Petalock, then run recover"
        : "Petalock is running; close it first. Nothing was changed",
    );
  }
}

/** A path with its parent's links resolved (the leaf itself is checked separately). */
const canonical = (path) => join(realpathSync.native(dirname(path)), basename(path));

/** Checks that the locations can be swapped safely: distinct, apart from each other and from the journal, links resolved. */
function checkLayout(ctx) {
  const missing = (what) => refuse(`the folder that holds ${what} does not exist; nothing was changed`);
  const exists = (parent) => {
    try {
      return statSync(parent).isDirectory();
    } catch {
      return false;
    }
  };
  for (const key of LOCATION_KEYS) if (!exists(dirname(ctx.locations[key]))) missing(key);
  if (!exists(dirname(ctx.journal))) missing("the journal");
  const real = Object.fromEntries(LOCATION_KEYS.map((key) => [key, canonical(ctx.locations[key])]));
  const realJournal = canonical(ctx.journal);
  for (const a of LOCATION_KEYS) {
    if (normal(realJournal) === normal(real[a]) || isInside(realJournal, real[a])) {
      refuse(`the journal would sit inside ${a}; nothing was changed`);
    }
    for (const b of LOCATION_KEYS) {
      if (a === b) continue;
      if (normal(real[a]) === normal(real[b]) || isInside(real[a], real[b])) {
        refuse(`${a} and ${b} are the same place or one is inside the other; nothing was changed`);
      }
    }
  }
}

/** The journal as an object, or null when there is none. Refuses a file that isn't this tool's own, matching the locations. */
function readJournal(ctx) {
  const kind = kindOf(ctx.journal);
  if (kind === "absent") return null;
  const found = kind === "file" ? readSmallJson(ctx.journal) : null;
  const digits = (value) => typeof value === "string" && /^[0-9]{1,40}$/.test(value);
  const valid =
    found !== null &&
    found.lockboxTestSwapJournal === 3 &&
    typeof found.run === "string" &&
    RUN_NAME.test(found.run) &&
    Array.isArray(found.locations) &&
    found.locations.length === LOCATION_KEYS.length &&
    found.locations.every(
      (entry, index) =>
        entry !== null &&
        typeof entry === "object" &&
        entry.key === LOCATION_KEYS[index] &&
        typeof entry.path === "string" &&
        same(normal(entry.path), normal(ctx.locations[entry.key])) &&
        (entry.redirect === undefined ||
          (typeof entry.redirect === "string" && FAMILY.test(entry.redirect) && entry.key !== "vaults" && entry.original === "present")) &&
        (entry.shownThrough === undefined ||
          (entry.original === "present" &&
            entry.shownThrough !== null &&
            typeof entry.shownThrough === "object" &&
            digits(entry.shownThrough.dev) &&
            digits(entry.shownThrough.ino))) &&
        ((entry.original === "absent" && entry.identity === undefined) ||
          (entry.original === "present" &&
            entry.identity !== null &&
            typeof entry.identity === "object" &&
            digits(entry.identity.dev) &&
            digits(entry.identity.ino))),
    );
  if (!valid) {
    refuse("the swap journal is not readable or does not match these locations; nothing was changed, look at it by hand");
  }
  return {
    run: found.run,
    locations: found.locations.map(({ key, path, original, identity, redirect, shownThrough }) => ({
      key,
      path,
      original,
      identity: identity === undefined ? undefined : { dev: identity.dev, ino: identity.ino },
      redirect,
      shownThrough: shownThrough === undefined ? undefined : { dev: shownThrough.dev, ino: shownThrough.ino },
    })),
  };
}

/** Writes the journal through a temp file made for this call alone (exclusive, uniquely named) and renamed into place. */
function writeJournal(ctx, run, entries) {
  const data = {
    lockboxTestSwapJournal: 3,
    run,
    locations: entries.map(({ key, path, original, identity, redirect, shownThrough }) => ({
      key,
      path,
      original,
      identity,
      redirect,
      shownThrough,
    })),
  };
  const temp = `${ctx.journal}.${process.pid}-${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, { flag: "wx" });
  try {
    renameSync(temp, ctx.journal);
  } catch (error) {
    unlinkSync(temp);
    throw error;
  }
}

// ---- one command at a time ----------------------------------------------------------------------------------------

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

/** Runs `fn` holding the lock beside the journal. A lock left by a process that is gone is taken over and said so. */
function withLock(ctx, fn) {
  const lockPath = `${ctx.journal}.lock`;
  const mine = `${JSON.stringify({ lockboxTestSwapLock: 1, pid: process.pid, started: new Date().toISOString() })}\n`;
  let tookOver = false;
  let held = false;
  for (let attempt = 0; attempt < 2 && !held; attempt += 1) {
    try {
      writeFileSync(lockPath, mine, { flag: "wx" });
      held = true;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const other = readSmallJson(lockPath);
      const pid = other !== null && other.lockboxTestSwapLock === 1 && Number.isInteger(other.pid) && other.pid > 0 ? other.pid : null;
      if (pid === null) refuse("a lock file beside the journal is not readable; nothing was changed, delete it by hand if no swap command is running");
      if (processIsAlive(pid)) refuse(`another swap command is running (process ${pid}); nothing was changed`);
      unlinkSync(lockPath);
      tookOver = true;
    }
  }
  if (!held) refuse("could not take the lock beside the journal; nothing was changed");
  const note = "took over a lock left by a swap command that is no longer running";
  try {
    const result = fn();
    return tookOver ? { ...result, lines: [note, ...result.lines] } : result;
  } catch (error) {
    if (tookOver && error instanceof SwapRefused) error.lines = [note, ...error.lines];
    throw error;
  } finally {
    try {
      if (readSmallJson(lockPath)?.pid === process.pid) unlinkSync(lockPath);
    } catch {
      // the lock stays; the next command takes it over once this process is gone
    }
  }
}

// ---- swapping in --------------------------------------------------------------------------------------------------

/** Looks at one location before any rename; returns what to do with it, or refuses. */
function resolveLocation(key, ctx, run) {
  const path = ctx.locations[key];
  const kind = kindOf(path);
  if (kind !== "absent" && kind !== "dir" && kind !== "link") refuse(`${key} is not a folder; nothing was renamed`);
  // a link is accepted only as the app's private copy of the folder, found by identity (see findRedirect)
  const redirect = kind === "absent" ? undefined : findRedirect(key, ctx);
  if (kind === "link" && redirect === undefined) refuse(`${key} is a link or junction; nothing was renamed`);
  let identity;
  if (kind !== "absent") {
    const real = join(realpathSync.native(dirname(path)), basename(path));
    const resolved = realpathSync.native(path);
    if (!same(resolved, real) && !(redirect !== undefined && same(resolved, realpathSync.native(redirect.copy)))) {
      refuse(`${key} is reached through a link; nothing was renamed`);
    }
    if (!statSync(path).isDirectory()) refuse(`${key} is not a folder; nothing was renamed`);
    if (kindOf(join(path, SENTINEL)) !== "absent") refuse(`${key} already holds a swap sentinel; nothing was renamed`);
    identity = identityOf(path);
    if (identity === null || identity.ino === "0") refuse(`the identity of ${key} can't be read; nothing was renamed`);
  }
  if (kindOf(asidePath(path, run)) !== "absent") {
    refuse(`something is already at the set-aside name of ${key} for run ${run}; nothing was renamed`);
  }
  const kept = kindOf(testPath(path, run));
  if (kept !== "absent" && kept !== "dir") refuse(`the kept test state of ${key} for run ${run} is not a folder; nothing was renamed`);
  return {
    key,
    path,
    original: kind === "absent" ? "absent" : "present",
    identity,
    redirect: redirect?.family,
    hasKept: kept === "dir",
  };
}

/** Sets every real location aside and puts the run's kept test state in place (or leaves the place empty). */
export function swapIn(run, options = {}) {
  checkRunName(run);
  const ctx = context(options);
  checkLayout(ctx);
  return withLock(ctx, () => {
    refuseWhileRunning(ctx);
    if (kindOf(ctx.journal) !== "absent") {
      let other = "";
      try {
        other = ` (run ${readJournal(ctx).run})`;
      } catch {
        // the journal can't be read; the refusal below still stands
      }
      refuse(`a swap is already in progress${other}; run recover first. Nothing was changed`);
    }
    const plan = LOCATION_KEYS.map((key) => resolveLocation(key, ctx, run));

    writeJournal(ctx, run, plan);
    ctx.step("journal written");
    const lines = [];
    for (const entry of plan) {
      const { key, path, original, hasKept, redirect } = entry;
      refuseWhileRunning(ctx, true);
      if (original === "present") {
        writeFileSync(join(path, SENTINEL), `${JSON.stringify({ lockboxTestSwap: 1, run, key })}\n`, { flag: "wx" });
        ctx.step(`${key}: marked`);
        ctx.rename(path, asidePath(path, run));
        ctx.step(`${key}: original set aside`);
        if (kindOf(path) !== "absent") {
          // A folder still shows at the place: under a packaged app's private copy, the real folder outside it now
          // falls through. For appLocal that folder is only the web-view cache: it is recorded (its identity, so that
          // putting back never takes it for test state) and the swap goes on. Anywhere else it may hold Petalock's own
          // data, so nothing may go on from here: this location goes back (the folder that shows is kept under the
          // test name by the routine that puts things back), and so does everything done before it.
          // Either way the folder that shows is recorded by identity first, so that no later step can take it for test
          // state; it is never moved, here or by recover.
          const seen = kindOf(path) === "dir" ? identityOf(path) : null;
          if (seen !== null && seen.ino !== "0") {
            entry.shownThrough = seen;
            writeJournal(ctx, run, plan);
            ctx.step(`${key}: show-through recorded`);
          }
          if (!(seen !== null && seen.ino !== "0" && key === "appLocal" && redirect !== undefined)) {
            const base = `a ${key} folder outside the app's private copy shows through`;
            try {
              ctx.rename(asidePath(path, run), path);
            } catch {
              // the place is taken, as expected: the routine below stops there and keeps the journal
            }
            let undone;
            try {
              undone = restoreAll({ run, locations: plan }, ctx);
            } catch (error) {
              if (!(error instanceof SwapRefused)) throw error;
              const blocked = `${base}; the set-aside copy could not be put back, so the swap stopped with the journal kept and the folder that shows was not moved`;
              throw new SwapRefused(blocked, [blocked, ...error.lines]);
            }
            const message = `${base}; nothing was set aside`;
            throw new SwapRefused(message, [message, ...undone.lines]);
          }
        }
      }
      if (hasKept) {
        try {
          ctx.rename(testPath(path, run), path);
        } catch (error) {
          if (entry.shownThrough === undefined) throw error;
          refuse(`${key}: the kept test state could not be put in place over the web-view folder that shows through; stopped with the journal kept. Run recover`);
        }
        ctx.step(`${key}: test state in place`);
      }
      const where = redirect === undefined ? "" : `the ${redirect} app's private copy; `;
      // what is visible at the place now, by identity: a recorded folder from outside the private copy still shows only
      // while nothing else is at the place
      const showsNow = entry.shownThrough !== undefined && kindOf(path) === "dir" && identityIs(path, entry.shownThrough);
      const tail = hasKept
        ? `; the kept test state of run ${run} is in place`
        : showsNow
          ? ""
          : "; the place is empty, the app starts fresh";
      lines.push(`${key}: ${where}${original === "present" ? "original set aside" : "there was no original"}${tail}`);
      if (showsNow) lines.push(SHOWN_THROUGH_LINE);
    }
    return { lines };
  });
}

// ---- putting back -------------------------------------------------------------------------------------------------

/** Puts one location right from whatever step a swap stopped at. Returns its report lines and its problems. */
function restoreOne(entry, run, ctx) {
  refuseWhileRunning(ctx, true);
  const { key, path, original } = entry;
  const aside = asidePath(path, run);
  const kept = testPath(path, run);
  const placeKind = kindOf(path);
  const asideKind = kindOf(aside);
  const keptKind = kindOf(kept);
  const lines = [];
  const problems = [];
  const done = (text) => {
    lines.push(`${key}: ${text}`);
    return { lines, problems };
  };
  // `halt` ends the whole restore here: nothing after this location is touched
  const stuck = (text, halt = false) => {
    problems.push(`${key}: ${text}`);
    return { lines, problems, halt };
  };
  const keepTestState = () => {
    ctx.rename(path, kept);
    ctx.step(`${key}: test state kept`);
  };

  if (original === "absent") {
    if (placeKind === "absent") return done("nothing to put back, it did not exist before");
    if (placeKind !== "dir") return stuck("a link or a file is in its place; left alone");
    if (keptKind !== "absent") return stuck(`the kept name for run ${run} is taken, so the test state stays where it is`);
    keepTestState();
    return done(`the test state is kept for run ${run}; nothing existed before`);
  }

  // A location seen as the app's private copy may be a link to that copy (identity is what counts, and it is checked
  // below); any other location is only ever a plain folder.
  const folderLike = (kind) => kind === "dir" || (entry.redirect !== undefined && kind === "link");
  const asideIsOurs = folderLike(asideKind) && ownsSentinel(aside, run, key);
  const placeIsOurs = folderLike(placeKind) && ownsSentinel(path, run, key);
  const placeIsOriginal = folderLike(placeKind) && identityMatches(path, entry);
  const strayNote = asideKind !== "absent" && !asideIsOurs ? "; a folder at the set-aside name has no sentinel for this run and was left alone" : "";

  if (asideIsOurs) {
    if (placeIsOurs) return stuck("both the place and the set-aside folder carry this run's sentinel; nothing was moved");
    if (!identityMatches(aside, entry)) return stuck(`the folder set aside by run ${run} is not the folder that was recorded; nothing was moved`);
    let keptNow = false;
    // For a location where a real folder shows through the private copy, a folder at the place that has the recorded
    // identity of that real folder is not test state: it is never moved, and the private copy goes back over it.
    const shownThrough = entry.shownThrough;
    if (placeKind === "dir" && shownThrough !== undefined && identityIs(path, shownThrough)) {
      // nothing to keep: the real folder shows because the place is otherwise empty
    } else if (placeKind === "dir") {
      if (keptKind !== "absent") return stuck(`the kept name for run ${run} is taken, so nothing was moved`);
      keepTestState();
      keptNow = true;
    } else if (placeKind !== "absent") {
      return stuck("a link or a file is in its place; nothing was moved");
    }
    try {
      ctx.rename(aside, path);
    } catch (error) {
      if (shownThrough === undefined) throw error;
      // never tried again by moving the folder that shows through, and nothing after this location is touched
      return stuck(
        key === "appLocal"
          ? "Windows would not put the app's private copy back over the web-view folder that shows through; the folder that shows was not moved"
          : "the set-aside folder could not be renamed back because a folder outside the app's private copy shows through at its place; that folder was not moved",
        true,
      );
    }
    ctx.step(`${key}: original put back`);
    removeSentinel(path, run, key);
    ctx.step(`${key}: marker cleared`);
    return done(`original put back${keptNow ? `, test state kept for run ${run}` : ""}`);
  }
  if (placeIsOriginal && placeIsOurs) {
    removeSentinel(path, run, key);
    ctx.step(`${key}: marker cleared`);
    return done(`original was in place; its marker is cleared${strayNote}`);
  }
  if (placeIsOriginal) return done(`original is in place${strayNote}`);
  return stuck(`the original is not in its place and no folder set aside by run ${run} was found${strayNote}`);
}

function restoreAll(journal, ctx) {
  const lines = [];
  const problems = [];
  let halted = false;
  for (const entry of journal.locations) {
    const result = restoreOne(entry, journal.run, ctx);
    lines.push(...result.lines);
    problems.push(...result.problems);
    if (result.halt) {
      halted = true;
      break;
    }
  }
  if (problems.length > 0) {
    const all = [
      ...lines,
      ...problems,
      ...(halted ? ["the restore stopped there: the locations after it were not touched"] : []),
      "the journal is kept; nothing was deleted. Look at the folders named above",
    ];
    throw new SwapRefused(`some locations could not be put back (${problems.length})`, all);
  }
  unlinkSync(ctx.journal);
  return { lines };
}

/**
 * The family of a private copy this process does not see, or null when it sees them all. A swap started inside a
 * packaged app is recorded in the shared journal, but the places it moved are spelled differently outside the app: if
 * neither the place nor the aside name shows the folder recorded as the original, nothing may be moved from here.
 */
function unseenFamily(journal) {
  for (const entry of journal.locations) {
    if (entry.redirect === undefined) continue;
    const names = [entry.path, asidePath(entry.path, journal.run)];
    if (!names.some((name) => identityMatches(name, entry))) return entry.redirect;
  }
  return null;
}

const outsideMessage = (family) => `this swap was started inside the ${family} app; run recover from a terminal inside that app`;

/** Keeps the test state beside the real folders and puts the real ones back. */
export function swapBack(run, options = {}) {
  checkRunName(run);
  const ctx = context(options);
  checkLayout(ctx);
  return withLock(ctx, () => {
    refuseWhileRunning(ctx);
    const journal = readJournal(ctx);
    if (journal === null) refuse("no swap is in progress; nothing was changed");
    if (journal.run !== run) refuse(`the swap in progress is for run ${journal.run}, not ${run}; nothing was changed`);
    const unseen = unseenFamily(journal);
    if (unseen !== null) refuse(outsideMessage(unseen));
    return restoreAll(journal, ctx);
  });
}

/** Finishes putting every original back from whatever point a swap stopped at. Needs only the journal and sentinels. */
export function recover(options = {}) {
  const ctx = context(options);
  const nothing = { nothing: true, lines: ["nothing to recover"] };
  if (readJournal(ctx) === null) return nothing;
  checkLayout(ctx);
  return withLock(ctx, () => {
    const journal = readJournal(ctx);
    if (journal === null) return nothing;
    const unseen = unseenFamily(journal);
    if (unseen !== null) refuse(outsideMessage(unseen));
    refuseWhileRunning(ctx);
    return restoreAll(journal, ctx);
  });
}

// ---- reading out --------------------------------------------------------------------------------------------------

const describe = (kind, ours) => {
  if (kind === "dir") return ours === undefined ? "a folder" : ours ? "a folder with this run's sentinel" : "a folder without this run's sentinel";
  return { absent: "nothing", link: "a link", file: "a file", other: "something else" }[kind];
};

/** What is set aside now, in words. Changes nothing. A filesystem error is not caught here: the caller words it. */
export function status(options = {}) {
  const ctx = context(options);
  let journal;
  try {
    journal = readJournal(ctx);
  } catch (error) {
    if (error instanceof SwapRefused) return { inProgress: true, run: null, unreadable: true, lines: error.lines };
    throw error;
  }
  if (journal === null) return { inProgress: false, run: null, lines: ["no swap is in progress"] };
  const lines = [`a swap is in progress for run ${journal.run}`];
  const unseen = unseenFamily(journal);
  if (unseen !== null) return { inProgress: true, run: journal.run, lines: [...lines, outsideMessage(unseen)] };
  for (const { key, path, original, redirect, shownThrough } of journal.locations) {
    // a link to the app's private copy is a folder for these words
    const folderKind = (kind) => (redirect !== undefined && kind === "link" ? "dir" : kind);
    const place = folderKind(kindOf(path));
    const aside = folderKind(kindOf(asidePath(path, journal.run)));
    const kept = kindOf(testPath(path, journal.run));
    const where = redirect === undefined ? "" : `the ${redirect} app's private copy; `;
    lines.push(
      `${key}: ${where}the original ${original === "present" ? "existed" : "did not exist"}; in place: ${describe(
        place,
        place === "dir" ? ownsSentinel(path, journal.run, key) : undefined,
      )}; set aside: ${describe(aside, aside === "dir" ? ownsSentinel(asidePath(path, journal.run), journal.run, key) : undefined)}; kept test state: ${describe(kept)}`,
    );
    if (shownThrough !== undefined) {
      const showsNow = place === "dir" && identityIs(path, shownThrough);
      const what = key === "appLocal" ? "a web-view folder" : "a folder";
      const cache = key === "appLocal" ? " (cache only)" : "";
      lines.push(
        showsNow
          ? `${key}: ${what} outside the app's private copy shows through now${cache}`
          : `${key}: ${what} outside the app's private copy showed through when the swap started; it is not showing now`,
      );
    }
  }
  return { inProgress: true, run: journal.run, lines };
}

// ---- the command line ---------------------------------------------------------------------------------------------

/** Runs one command line; returns the exit code (0 done, 1 refused or failed, 2 not understood) and the lines to show. */
export function cli(argv, options = {}) {
  const [command, run] = argv;
  const wellFormed =
    ((command === "status" || command === "recover") && argv.length === 1) ||
    ((command === "in" || command === "back") && argv.length === 2 && typeof run === "string" && RUN_NAME.test(run));
  if (!wellFormed) return { code: 2, lines: [USAGE] };
  try {
    if (command === "status") {
      const found = status(options);
      return { code: found.unreadable ? 1 : 0, lines: found.lines };
    }
    if (command === "recover") return { code: 0, lines: recover(options).lines };
    if (command === "in") return { code: 0, lines: swapIn(run, options).lines };
    return { code: 0, lines: swapBack(run, options).lines };
  } catch (error) {
    if (error instanceof SwapRefused) return { code: 1, lines: error.lines };
    // only the error's code is shown: its text can carry a path
    const code = typeof error?.code === "string" ? error.code : "no code";
    return {
      code: 1,
      lines: [
        command === "status"
          ? `could not read what is set aside (${code})`
          : `stopped by an unexpected error (${code}); run "node e2e/lib/state.mjs recover" to put everything back`,
      ],
    };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = cli(process.argv.slice(2));
  for (const line of result.lines) (result.code === 0 ? console.log : console.error)(line);
  process.exitCode = result.code;
}
