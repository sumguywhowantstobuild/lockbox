// Answers the native "choose a folder" box of the first-time setup. WebDriver cannot reach a Windows file box, so
// `folderbox.ps1` finds it (by its title and by the process that owns it), moves it off the screen and answers it by
// window messages, the way the hands-on tools do. The folder is checked first: it must be one the run made, never the
// default vault folder or anything inside the app's own folders.

import { spawn } from "node:child_process";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { systemTool } from "./state.mjs";

const SCRIPT = fileURLToPath(new URL("./folderbox.ps1", import.meta.url));
const lower = (path) => resolve(path).toLowerCase();
const isInside = (child, parent) => {
  const rel = relative(lower(parent), lower(child));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
};

/**
 * Returns `folder` when it is a plain full path inside `runRoot` (the folder this run made, and not that folder itself)
 * and outside every one of the app's `locations` (state, web-view folders, default vault folder); throws otherwise.
 * Messages never repeat the path.
 */
export function checkPickable(folder, { runRoot, locations }) {
  if (typeof folder !== "string" || !/^[A-Za-z]:\\/.test(folder)) throw new Error("the folder to pick must be a full path on a drive");
  if (folder.split(/[\\/]/).includes("..")) throw new Error("the folder to pick must not climb with ..");
  if (!isInside(folder, runRoot)) throw new Error("the folder to pick is not inside the run's own folder");
  for (const where of Object.values(locations)) {
    if (lower(folder) === lower(where) || isInside(folder, where) || isInside(where, folder)) {
      throw new Error("the folder to pick is never the default vault folder or one of the app's own folders");
    }
  }
  return folder;
}

/** The arguments PowerShell gets to run `folderbox.ps1`. */
export function dialogArguments({ title, pid, folder, timeoutSeconds }) {
  if (typeof title !== "string" || title === "") throw new Error("the box's title is needed");
  if (!Number.isInteger(pid) || pid <= 0) throw new Error("the process that owns the box is needed");
  if (typeof folder !== "string" || folder === "") throw new Error("the folder is needed");
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 120) throw new Error("the wait must be 1 to 120 seconds");
  return ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", SCRIPT, "-Title", title, "-ProcessId", String(pid), "-Folder", folder, "-TimeoutSeconds", String(timeoutSeconds)];
}

/** Answers the box titled like `title` that process `pid` shows, with `folder`. Resolves once it was pressed. */
export function pickFolder({ title, pid, folder, runRoot, locations, timeoutSeconds = 20 }) {
  checkPickable(folder, { runRoot, locations });
  const args = dialogArguments({ title, pid, folder, timeoutSeconds });
  return new Promise((resolvePicked, reject) => {
    // nosemgrep: javascript.lang.security.detect-child-process.detect-child-process -- a fixed program by its full path and this repository's script; every argument is checked above
    const child = spawn(systemTool(join("WindowsPowerShell", "v1.0", "powershell.exe")), args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (data) => {
      out += String(data);
    });
    child.stderr.on("data", (data) => {
      out += String(data);
    });
    child.once("error", () => reject(new Error("could not start PowerShell for the folder box")));
    child.once("close", (code) => {
      if (code === 0 && /pressed/.test(out)) resolvePicked();
      else reject(new Error(`the folder box was not answered (exit ${String(code)}): ${out.trim().split(/\r?\n/).slice(-1)[0] ?? ""}`));
    });
  });
}
