// Fetches the Edge WebDriver that matches the WebView2 runtime this PC (the CI runner) has, for the end-to-end job: the
// image's own driver follows the image's Edge browser, and the runtime updates separately, so the two can drift apart.
//
//   node scripts/webview-driver.mjs
//
// In order, stopping at the first refusal (and then deleting everything it made): reads the runtime's version from the
// registry; builds the download address from that version alone (four numeric parts, nothing else) on Microsoft's driver
// host; downloads the zip over HTTPS with a time limit and a size limit into a new folder under RUNNER_TEMP (the operating
// system's temp folder by hand), never inside the repository; unpacks it with Windows' own tar.exe; requires exactly one
// msedgedriver.exe in it and uses only that file; requires its Authenticode signature to be Valid and to name Microsoft
// Corporation as the one organisation; runs `msedgedriver.exe --version` and requires the first three parts of its version to
// equal the runtime's (scripts/e2e.mjs checks the same again before it uses the driver). On success it prints the driver's
// version line and, when GITHUB_OUTPUT is set, writes `path=<full path of msedgedriver.exe>` to it. Exit code: 0 done, 1 refused.

import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { systemTool } from "../e2e/lib/state.mjs";
import { checkVersions, parseDriverVersion, readRuntimeVersion } from "./e2e.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DRIVER_HOST = "https://msedgedriver.microsoft.com/";
const FOUR_PARTS = /^[0-9]{1,9}(\.[0-9]{1,9}){3}$/;
const DRIVER_NAME = "msedgedriver.exe";
const MAX_ZIP_BYTES = 64 * 1024 * 1024; // the real zip is about 12 MB
const DOWNLOAD_MS = 120_000;
// The signature check as Windows PowerShell 5.1 runs it: the path comes in an environment variable and is data, never
// parsed; Status is turned to text (as an enum it would be printed as a number); one line of JSON comes out.
export const SIGNATURE_SCRIPT =
  "$ErrorActionPreference = 'Stop'; $s = Get-AuthenticodeSignature -LiteralPath $env:PETALOCK_DRIVER_FILE; $subject = ''; " +
  "if ($s.SignerCertificate) { $subject = $s.SignerCertificate.Subject }; " +
  "[pscustomobject]@{ Status = [string]$s.Status; Subject = $subject } | ConvertTo-Json -Compress";

/** A reason the driver was not fetched; whatever was made has been deleted. */
export class WebviewDriverError extends Error {}

// ---- the pure parts -----------------------------------------------------------------------------------------------

/** The download address for a runtime version, only from exactly four numeric parts. */
export function driverAddress(version) {
  if (typeof version !== "string" || !FOUR_PARTS.test(version)) {
    throw new WebviewDriverError(`the WebView2 runtime's version is not four numbers joined by dots (${JSON.stringify(version)}); nothing was requested`);
  }
  return `${DRIVER_HOST}${version}/edgedriver_win64.zip`;
}

/** The value of the field `key` for each such field of a certificate subject (`CN=a, O="b, c"`): quotes keep a comma in one field. */
function subjectValues(subject, key) {
  const parts = [];
  let current = "";
  let quoted = false;
  for (const char of subject) {
    if (char === '"') quoted = !quoted;
    if (char === "," && !quoted) {
      parts.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  parts.push(current);
  const found = [];
  for (const part of parts) {
    const at = part.indexOf("=");
    if (at < 0 || part.slice(0, at).trim().toUpperCase() !== key) continue;
    let value = part.slice(at + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1).replaceAll('""', '"');
    found.push(value);
  }
  return found;
}

/**
 * The verdict on PowerShell's JSON answer (`{ Status, Subject }`): `{ ok: true, reason: "" }` only when the status is exactly
 * `Valid` and the subject has one organisation, Microsoft Corporation. Anything else is `{ ok: false, reason }`.
 */
export function signatureVerdict(output) {
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch {
    return { ok: false, reason: "the answer of the signature check could not be read" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed) || typeof parsed.Status !== "string") {
    return { ok: false, reason: "the answer of the signature check could not be read" };
  }
  if (parsed.Status !== "Valid") return { ok: false, reason: `the signature is ${parsed.Status}, not Valid` };
  const subject = typeof parsed.Subject === "string" ? parsed.Subject : "";
  const organisations = subjectValues(subject, "O");
  if (organisations.length !== 1 || organisations[0] !== "Microsoft Corporation") {
    return { ok: false, reason: "the file is not signed by Microsoft Corporation" };
  }
  return { ok: true, reason: "" };
}

/** The one `msedgedriver.exe` among the unpacked files (any folder, any letter case); none or several is refused. */
export function pickDriver(files) {
  const found = files.filter((file) => file.split(/[\\/]/).pop().toLowerCase() === DRIVER_NAME);
  if (found.length === 0) throw new WebviewDriverError(`the zip holds no ${DRIVER_NAME}`);
  if (found.length > 1) throw new WebviewDriverError(`the zip holds more than one ${DRIVER_NAME} (${String(found.length)})`);
  return found[0];
}

/** `path=<full path>` and a newline: the step output's line. */
export function outputLine(path) {
  // (a line break or any other control character would start another output line)
  if (typeof path !== "string" || !isAbsolute(path) || /\p{Cc}/u.test(path)) {
    throw new WebviewDriverError("the step output must be one full path on one line");
  }
  return `path=${path}\n`;
}

// ---- the parts that touch the network and Windows -----------------------------------------------------------------

/** The zip's bytes: one HTTPS request with a time limit, ending at an https address, within `maxBytes`. */
export async function downloadZip(url, { fetchFn = fetch, timeoutMs = DOWNLOAD_MS, maxBytes = MAX_ZIP_BYTES } = {}) {
  if (typeof url !== "string" || !url.startsWith(DRIVER_HOST)) throw new WebviewDriverError("the download address is not on Microsoft's driver host");
  const why = (error) => `${error.message}${error.cause?.code ? ` (${error.cause.code})` : ""}`;
  let response;
  try {
    response = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs), redirect: "follow" });
  } catch (error) {
    throw new WebviewDriverError(`the download failed: ${why(error)}`);
  }
  if (!response.ok) throw new WebviewDriverError(`the download failed: the host answered ${String(response.status)}`);
  let finalProtocol = "";
  try {
    finalProtocol = new URL(response.url).protocol;
  } catch {
    // an address that can't be read is refused below
  }
  if (finalProtocol !== "https:") throw new WebviewDriverError("the download ended at an address that is not https");
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > maxBytes) throw new WebviewDriverError(`the download is too large (${String(length)} bytes; the limit is ${String(maxBytes)})`);
  if (!response.body) throw new WebviewDriverError("the download is empty");
  const chunks = [];
  let total = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new WebviewDriverError(`the download is too large (over ${String(maxBytes)} bytes)`);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof WebviewDriverError) throw error;
    throw new WebviewDriverError(`the download failed: ${why(error)}`);
  }
  if (total === 0) throw new WebviewDriverError("the download is empty");
  return Buffer.concat(chunks);
}

/** Unpacks `zipFile` into `into` with Windows' own tar.exe, which refuses a name that climbs out of the folder. */
export function extractZip(zipFile, into) {
  mkdirSync(into, { recursive: true });
  // nosemgrep: javascript.lang.security.detect-child-process.detect-child-process -- Windows' tar by its full path; the file and folder are ones this script just made
  const result = spawnSync(systemTool("tar.exe"), ["-xf", zipFile, "-C", into], { encoding: "utf8", windowsHide: true, timeout: 120_000 });
  if (result.error || result.status !== 0) {
    throw new WebviewDriverError(`the zip could not be unpacked${result.stderr ? `: ${String(result.stderr).trim().split("\n")[0]}` : ""}`);
  }
}

/** Every file under `dir` as a `/`-joined path; a link of any kind (a junction included) or a special entry is refused. */
export function listFiles(dir, prefix = "") {
  const files = [];
  for (const entry of readdirSync(join(dir, prefix), { withFileTypes: true })) {
    const name = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) files.push(...listFiles(dir, name));
    else if (entry.isFile()) files.push(name);
    else throw new WebviewDriverError(`the zip made a link or another special entry (${name}); it is refused`);
  }
  return files;
}

/** PowerShell's JSON answer for the file's signature. Windows PowerShell 5.1 by its full path, without PowerShell 7's module path. */
export function readSignature(file) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toUpperCase() !== "PSMODULEPATH"));
  env.PETALOCK_DRIVER_FILE = file;
  const encoded = Buffer.from(SIGNATURE_SCRIPT, "utf16le").toString("base64");
  // nosemgrep: javascript.lang.security.detect-child-process.detect-child-process -- Windows PowerShell by its full path with a fixed script; the file comes in the environment, not the script
  const result = spawnSync(systemTool(join("WindowsPowerShell", "v1.0", "powershell.exe")), ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
    encoding: "utf8",
    env,
    windowsHide: true,
    timeout: 60_000,
  });
  if (result.error || result.status !== 0) throw new WebviewDriverError("Windows PowerShell could not check the driver's signature");
  return String(result.stdout).trim();
}

/** The output of `msedgedriver.exe --version`, or "" when it does not run. */
export function readDriverOutput(file) {
  // nosemgrep: javascript.lang.security.detect-child-process.detect-child-process -- the driver this script just unpacked and checked, with a fixed argument
  const result = spawnSync(file, ["--version"], { encoding: "utf8", windowsHide: true, timeout: 30_000 });
  return result.status === 0 ? String(result.stdout) : "";
}

// ---- the run ------------------------------------------------------------------------------------------------------

/** Where the new folder goes: RUNNER_TEMP when it is a full path, else the temp folder; never inside the repository. */
function tempBase(env) {
  const base = typeof env.RUNNER_TEMP === "string" && isAbsolute(env.RUNNER_TEMP) ? env.RUNNER_TEMP : tmpdir();
  const from = relative(ROOT, resolve(base));
  if (from === "" || (!from.startsWith("..") && !isAbsolute(from))) throw new WebviewDriverError("the temp folder is inside the repository; the driver is never put there");
  return base;
}

/**
 * Fetches, unpacks and checks the driver; returns `{ path, runtime, versionLine }`. `steps` replaces the runtime read, the
 * download, the unpacking, the signature check and the driver's `--version` in tests.
 */
export async function installDriver({ env = process.env, steps = {}, log = console.log } = {}) {
  const step = { readRuntime: readRuntimeVersion, download: downloadZip, extract: extractZip, signature: readSignature, driverOutput: readDriverOutput, ...steps };
  const runtime = step.readRuntime();
  if (!runtime) throw new WebviewDriverError("the WebView2 runtime's version was not found in the registry");
  const address = driverAddress(runtime);
  const folder = mkdtempSync(join(tempBase(env), "petalock-webdriver-"));
  try {
    log(`webview-driver: the WebView2 runtime is ${runtime}; downloading ${address}`);
    const zipFile = join(folder, "driver.zip");
    writeFileSync(zipFile, await step.download(address), { flag: "wx" });
    const unpacked = join(folder, "driver");
    step.extract(zipFile, unpacked);
    const path = join(unpacked, pickDriver(listFiles(unpacked)));
    const verdict = signatureVerdict(step.signature(path));
    if (!verdict.ok) throw new WebviewDriverError(`the downloaded driver is refused: ${verdict.reason}`);
    const output = step.driverOutput(path);
    try {
      checkVersions(parseDriverVersion(output), runtime);
    } catch (error) {
      throw new WebviewDriverError(error.message);
    }
    const versionLine = output.split(/\r?\n/).find((line) => line.trim() !== "")?.trim() ?? "";
    const line = outputLine(path);
    if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, line);
    log(`webview-driver: ${versionLine}`);
    log(`webview-driver: kept at ${path}`);
    return { path, runtime, versionLine };
  } catch (error) {
    rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    throw error;
  }
}

async function main() {
  try {
    await installDriver();
  } catch (error) {
    console.error(`webview-driver: ${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
