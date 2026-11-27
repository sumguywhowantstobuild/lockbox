// Tests for scripts/webview-driver.mjs: the step that fetches the Edge WebDriver matching the runner's WebView2 runtime.
// Nothing here uses the network: the download, the unpacking and the version calls are handed in as stand-ins. The two
// checks that call Windows itself (the signature of a real signed file and of an unsigned one) run only on Windows. Every
// comparison counts what it compared and fails on zero; the workflow checks run on the real file and on copies with one thing
// changed, which they must refuse.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import * as e2e from "./e2e.mjs";
import * as wd from "./webview-driver.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const sandbox = (label) => mkdtempSync(join(tmpdir(), `webview-driver-test-${label}-`));
const GOOD = "157.0.4341.60";
const MICROSOFT = "CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US";
const signature = (status, subject) => JSON.stringify({ Status: status, Subject: subject });

// ---- the address ----------------------------------------------------------------------------------------------------

test("the_address_is_built_only_from_four_numeric_parts", () => {
  const bad = ["", "1.2.3", "a.b.c.d", "157.0.4341.x", "..", "../../x", "1.2.3.4/5", "/1.2.3.4", "1.2.3.4.5", "1.2.3.4/", "1.2.3.4\n", " 1.2.3.4", "1.2.3.-4", "1.2.3.4?x=1", "1.2.3.4#x", "1.2.3.", ".1.2.3", "1..2.3", "１.２.３.４", "1234567890.1.2.3", undefined, null, 157, {}];
  let refused = 0;
  for (const version of bad) {
    assert.throws(() => wd.driverAddress(version), (error) => error instanceof wd.WebviewDriverError, `${JSON.stringify(version)} is refused`);
    refused += 1;
  }
  assert.equal(refused, bad.length);
  assert.ok(refused >= 20);
  assert.equal(wd.driverAddress(GOOD), "https://msedgedriver.microsoft.com/157.0.4341.60/edgedriver_win64.zip");
  assert.equal(wd.driverAddress("1.0.0.0"), "https://msedgedriver.microsoft.com/1.0.0.0/edgedriver_win64.zip");
});

test("the_runtime_version_comes_from_the_registry_text_the_existing_parser_reads", () => {
  // `reg query <key> /v pv` prints a blank line, the key, then the value (made-up key; the version is the value's)
  const text = `\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\{MU-00000000-0000-0000-0000-000000000000}\r\n    pv    REG_SZ    ${GOOD}\r\n\r\n`;
  const version = e2e.parseRegistryVersion(text);
  assert.equal(version, GOOD);
  assert.equal(wd.driverAddress(version), `https://msedgedriver.microsoft.com/${GOOD}/edgedriver_win64.zip`);
  // a query that found nothing, or a value of another shape, reads as no version, and no address is built from it
  let refused = 0;
  for (const none of ["", "ERROR: The system was unable to find the specified registry key or value.\r\n", "    pv    REG_SZ    157.0.4341\r\n", "    pv    REG_DWORD    0x9d\r\n"]) {
    const read = e2e.parseRegistryVersion(none);
    assert.equal(read, null, `${JSON.stringify(none)} reads as no version`);
    assert.throws(() => wd.driverAddress(read), (error) => error instanceof wd.WebviewDriverError);
    refused += 1;
  }
  assert.equal(refused, 4);
});

// ---- the signature --------------------------------------------------------------------------------------------------

test("only_a_valid_signature_by_microsoft_corporation_passes", () => {
  assert.deepEqual(wd.signatureVerdict(signature("Valid", MICROSOFT)), { ok: true, reason: "" });
  assert.deepEqual(wd.signatureVerdict(signature("Valid", "CN=Microsoft Windows, O=Microsoft Corporation, L=Redmond, S=Washington, C=US")), { ok: true, reason: "" });
  const refusals = {
    "valid, another signer": [signature("Valid", "CN=Someone Else, O=Someone Else Ltd, C=US"), /not signed by Microsoft Corporation/],
    "not signed": [signature("NotSigned", ""), /NotSigned/],
    "hash mismatch": [signature("HashMismatch", MICROSOFT), /HashMismatch/],
    "not trusted": [signature("UnknownError", MICROSOFT), /UnknownError/],
    "status in another case": [signature("valid", MICROSOFT), /valid/],
    "a lookalike organisation": [signature("Valid", "CN=Microsoft Corporation, O=Microsoft Corporation Evil, C=US"), /not signed by Microsoft Corporation/],
    "the name only inside another field": [signature("Valid", 'CN="x, O=Microsoft Corporation", O=Evil Ltd, C=US'), /not signed by Microsoft Corporation/],
    "the name only as a common name": [signature("Valid", "CN=Microsoft Corporation, O=Evil Ltd, C=US"), /not signed by Microsoft Corporation/],
    "two organisations": [signature("Valid", "O=Microsoft Corporation, O=Evil Ltd"), /not signed by Microsoft Corporation/],
    "no subject": [signature("Valid", ""), /not signed by Microsoft Corporation/],
    "no subject field": [JSON.stringify({ Status: "Valid" }), /not signed by Microsoft Corporation/],
    "empty output": ["", /could not be read/],
    "output that is not JSON": ["Valid", /could not be read/],
    "JSON that is not an object": ["[]", /could not be read/],
    "a status that is not text": [JSON.stringify({ Status: 0, Subject: MICROSOFT }), /could not be read/],
  };
  let refused = 0;
  for (const [name, [output, why]] of Object.entries(refusals)) {
    const verdict = wd.signatureVerdict(output);
    assert.equal(verdict.ok, false, name);
    assert.match(verdict.reason, why, name);
    refused += 1;
  }
  assert.equal(refused, Object.keys(refusals).length);
  assert.ok(refused >= 10);
});

test("the_signature_call_reaches_windows_powershell_under_a_powershell_7_module_path", { skip: process.platform !== "win32" }, () => {
  const dir = sandbox("signature");
  const saved = process.env.PSModulePath;
  try {
    // What CI's default shell (PowerShell 7) leaves in the environment: a module path that comes first and holds its own
    // Microsoft.PowerShell.Security. Here a decoy of that module whose Get-AuthenticodeSignature says Valid, Microsoft, for
    // anything: if the call kept this path, the unsigned file below would pass.
    const decoy = join(dir, "modules", "Microsoft.PowerShell.Security");
    mkdirSync(decoy, { recursive: true });
    writeFileSync(
      join(decoy, "Microsoft.PowerShell.Security.psm1"),
      "function Get-AuthenticodeSignature { param($LiteralPath) [pscustomobject]@{ Status = 'Valid'; SignerCertificate = [pscustomobject]@{ Subject = 'O=Microsoft Corporation' } } }\n",
    );
    process.env.PSModulePath = `${join(dir, "modules")};${saved ?? ""}`;
    const signed = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
    const verdict = wd.signatureVerdict(wd.readSignature(signed));
    assert.deepEqual(verdict, { ok: true, reason: "" }, `a file Microsoft signed: ${verdict.reason}`);
    const plain = join(dir, "msedgedriver.exe");
    writeFileSync(plain, "MU-not a program");
    // The decoy is live: the same script, run in Windows PowerShell 5.1 with the decoy path left in, says Valid, Microsoft for
    // the plain file. Without this the test below could pass with nothing to catch.
    const kept = spawnSync(
      join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(wd.SIGNATURE_SCRIPT, "utf16le").toString("base64")],
      { encoding: "utf8", env: { ...process.env, PETALOCK_DRIVER_FILE: plain }, windowsHide: true, timeout: 60_000 },
    );
    assert.equal(kept.status, 0, `the decoy run: ${String(kept.stderr).slice(0, 300)}`);
    assert.deepEqual(wd.signatureVerdict(String(kept.stdout).trim()), { ok: true, reason: "" }, "with the decoy path kept, the plain file reads as Microsoft's");
    // (a text file named like a program is not even a program: Windows says UnknownError, a real unsigned one NotSigned)
    const unsigned = wd.signatureVerdict(wd.readSignature(plain));
    assert.equal(unsigned.ok, false);
    assert.match(unsigned.reason, /^the signature is \w+, not Valid$/);
    // a path with a quote, a bracket and a $( ) is data, never parsed
    const odd = join(dir, "O'Brien [1] $(Write-Output boom)");
    mkdirSync(odd);
    writeFileSync(join(odd, "msedgedriver.exe"), "MU-not a program");
    assert.match(wd.signatureVerdict(wd.readSignature(join(odd, "msedgedriver.exe"))).reason, /^the signature is \w+, not Valid$/);
  } finally {
    if (saved === undefined) delete process.env.PSModulePath;
    else process.env.PSModulePath = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- the zip --------------------------------------------------------------------------------------------------------

test("the_zip_must_hold_exactly_one_driver", () => {
  assert.equal(wd.pickDriver(["msedgedriver.exe", "Driver_Notes/credits.html", "Driver_Notes/license.txt"]), "msedgedriver.exe");
  assert.equal(wd.pickDriver(["x/MSEDGEDRIVER.EXE"]), "x/MSEDGEDRIVER.EXE");
  assert.equal(wd.pickDriver(["msedgedriver.exe.txt", "old-msedgedriver.exe", "msedgedriver.exe"]), "msedgedriver.exe");
  let refused = 0;
  for (const [files, why] of [
    [[], /no msedgedriver\.exe/],
    [["Driver_Notes/license.txt", "msedgedriver.exe.txt", "old-msedgedriver.exe"], /no msedgedriver\.exe/],
    [["msedgedriver.exe", "other/msedgedriver.exe"], /more than one/],
    [["msedgedriver.exe", "MSEDGEDRIVER.exe"], /more than one/],
  ]) {
    assert.throws(() => wd.pickDriver(files), (error) => error instanceof wd.WebviewDriverError && why.test(error.message), JSON.stringify(files));
    refused += 1;
  }
  assert.equal(refused, 4);
});

test("a_folder_is_listed_by_file_and_a_link_in_it_is_refused", { skip: process.platform !== "win32" }, () => {
  const dir = sandbox("list");
  try {
    mkdirSync(join(dir, "Driver_Notes"));
    writeFileSync(join(dir, "msedgedriver.exe"), "MU-a");
    writeFileSync(join(dir, "Driver_Notes", "license.txt"), "MU-b");
    assert.deepEqual(wd.listFiles(dir).sort(), ["Driver_Notes/license.txt", "msedgedriver.exe"]);
    // a junction (mklink /J needs no privilege) is a link, not a folder to enter
    const target = sandbox("target");
    try {
      writeFileSync(join(target, "msedgedriver.exe"), "MU-elsewhere");
      const made = spawnSync(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe"), ["/c", "mklink", "/J", join(dir, "linked"), target], { windowsHide: true });
      assert.equal(made.status, 0, "the junction was made");
      assert.throws(() => wd.listFiles(dir), (error) => error instanceof wd.WebviewDriverError && /link/.test(error.message));
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- the output line ------------------------------------------------------------------------------------------------

test("the_output_line_is_the_full_path", () => {
  const full = process.platform === "win32" ? String.raw`C:\runner\temp\petalock-webdriver-ab12\driver\msedgedriver.exe` : "/runner/temp/driver/msedgedriver.exe";
  assert.equal(wd.outputLine(full), `path=${full}\n`);
  let refused = 0;
  for (const bad of ["", "msedgedriver.exe", "driver\\msedgedriver.exe", `${full}\nother=1`, `${full}\r`, undefined, 5]) {
    assert.throws(() => wd.outputLine(bad), (error) => error instanceof wd.WebviewDriverError, JSON.stringify(bad));
    refused += 1;
  }
  assert.equal(refused, 7);
});

// ---- the download ---------------------------------------------------------------------------------------------------

function fakeResponse({ status = 200, url = "https://msedgedriver.microsoft.com/x", length, chunks = [] } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    headers: { get: (name) => (name.toLowerCase() === "content-length" && length !== undefined ? String(length) : null) },
    body: new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }),
  };
}

test("the_download_is_one_https_request_with_a_time_and_a_size_limit", async () => {
  const address = wd.driverAddress(GOOD);
  const seen = [];
  const fetchFn = async (url, options) => {
    seen.push({ url, options });
    return fakeResponse({ url, chunks: [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])] });
  };
  const bytes = await wd.downloadZip(address, { fetchFn });
  assert.deepEqual([...bytes], [1, 2, 3, 4, 5]);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, address);
  assert.ok(seen[0].options.signal instanceof AbortSignal, "the request has a time limit");

  const refuse = async (name, response, why, limits = {}) => {
    await assert.rejects(wd.downloadZip(address, { fetchFn: async () => response, maxBytes: 10, ...limits }), (error) => error instanceof wd.WebviewDriverError && why.test(error.message), name);
  };
  await refuse("an error status", fakeResponse({ status: 404 }), /404/);
  await refuse("a length over the limit", fakeResponse({ length: 11, chunks: [new Uint8Array(1)] }), /too large/);
  await refuse("a body over the limit that said nothing", fakeResponse({ chunks: [new Uint8Array(6), new Uint8Array(6)] }), /too large/);
  await refuse("an address that is not https at the end", fakeResponse({ url: "http://msedgedriver.microsoft.com/x", chunks: [new Uint8Array(1)] }), /https/);
  await refuse("an empty body", fakeResponse({ chunks: [] }), /empty/);
  await assert.rejects(
    wd.downloadZip(address, { fetchFn: async () => { throw new TypeError("fetch failed"); } }),
    (error) => error instanceof wd.WebviewDriverError && /fetch failed/.test(error.message),
  );
  await assert.rejects(wd.downloadZip("http://msedgedriver.microsoft.com/x", { fetchFn }), (error) => error instanceof wd.WebviewDriverError);
  await assert.rejects(wd.downloadZip("https://example.invalid/x", { fetchFn }), (error) => error instanceof wd.WebviewDriverError);
  assert.equal(seen.length, 1, "a refused address makes no request");
});

// ---- the whole step -------------------------------------------------------------------------------------------------

/** Stand-ins for the network and Windows: a zip that holds `files`, a signature answer, the driver's `--version` output. */
function world({ runtime = GOOD, files = ["msedgedriver.exe", "Driver_Notes/license.txt"], sign = signature("Valid", MICROSOFT), version = `Microsoft Edge WebDriver ${GOOD} (abc)` } = {}) {
  const calls = { download: [], signature: [], driverOutput: [] };
  const steps = {
    readRuntime: () => runtime,
    download: async (url) => {
      calls.download.push(url);
      return Buffer.from("MU-zip");
    },
    extract: (zip, into) => {
      assert.equal(readFileSync(zip, "utf8"), "MU-zip");
      for (const file of files) {
        mkdirSync(join(into, file, ".."), { recursive: true });
        writeFileSync(join(into, file), `MU-${file}`);
      }
    },
    signature: (file) => {
      calls.signature.push(file);
      return sign;
    },
    driverOutput: (file) => {
      calls.driverOutput.push(file);
      return version;
    },
  };
  return { steps, calls };
}

async function runStep(options) {
  const base = sandbox("base");
  const out = join(base, "github-output.txt");
  const temp = join(base, "temp");
  mkdirSync(temp);
  const { steps, calls } = world(options);
  const logged = [];
  const env = { RUNNER_TEMP: temp, GITHUB_OUTPUT: out };
  let result;
  let error;
  try {
    result = await wd.installDriver({ env, steps: { ...steps, ...(options?.override ?? {}) }, log: (line) => logged.push(line) });
  } catch (caught) {
    error = caught;
  }
  return { base, temp, out, calls, logged, result, error, left: readdirSync(temp), cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

test("a_good_driver_is_kept_and_its_full_path_is_written_to_the_step_output", async () => {
  const run = await runStep();
  try {
    assert.equal(run.error, undefined);
    assert.equal(run.left.length, 1, "one new folder under RUNNER_TEMP");
    assert.ok(run.result.path.startsWith(join(run.temp, run.left[0])), "the driver is inside it");
    assert.ok(existsSync(run.result.path));
    assert.equal(readFileSync(run.out, "utf8"), `path=${run.result.path}\n`);
    assert.deepEqual(run.calls.download, [`https://msedgedriver.microsoft.com/${GOOD}/edgedriver_win64.zip`]);
    assert.deepEqual(run.calls.signature, [run.result.path], "the file that was checked is the file that is handed on");
    assert.deepEqual(run.calls.driverOutput, [run.result.path]);
    assert.ok(run.logged.some((line) => line.includes(`Microsoft Edge WebDriver ${GOOD}`)), "the driver's version line is printed");
  } finally {
    run.cleanup();
  }
});

test("a_driver_that_fails_a_check_is_deleted_and_nothing_is_handed_on", async () => {
  const cases = {
    "an unsigned file": [{ sign: signature("NotSigned", "") }, /NotSigned/],
    "a signature that is valid for someone else": [{ sign: signature("Valid", "CN=Other, O=Other Ltd, C=US") }, /not signed by Microsoft Corporation/],
    "a changed file": [{ sign: signature("HashMismatch", MICROSOFT) }, /HashMismatch/],
    "no driver in the zip": [{ files: ["Driver_Notes/license.txt"] }, /no msedgedriver\.exe/],
    "two drivers in the zip": [{ files: ["msedgedriver.exe", "x/msedgedriver.exe"] }, /more than one/],
    "a driver of another version": [{ version: "Microsoft Edge WebDriver 158.0.4370.33 (abc)" }, /do not match/],
    "a driver that tells no version": [{ version: "hello" }, /version of the Edge WebDriver/],
  };
  let checked = 0;
  for (const [name, [options, why]] of Object.entries(cases)) {
    const run = await runStep(options);
    try {
      assert.ok(run.error instanceof wd.WebviewDriverError || run.error?.name === "E2eRefused", `${name}: refused (${String(run.error)})`);
      assert.match(run.error.message, why, name);
      assert.deepEqual(run.left, [], `${name}: the folder is gone`);
      assert.equal(existsSync(run.out), false, `${name}: nothing was written to the step output`);
      checked += 1;
    } finally {
      run.cleanup();
    }
  }
  assert.equal(checked, Object.keys(cases).length);
  assert.ok(checked >= 7);
});

test("a_missing_or_odd_runtime_version_stops_before_any_request", async () => {
  let checked = 0;
  for (const runtime of [null, 0, "", "157.0.4341", "157.0.4341.60.1", "157.0.4341.x", "../x"]) {
    const run = await runStep({ runtime });
    try {
      assert.ok(run.error instanceof wd.WebviewDriverError, `${JSON.stringify(runtime)} is refused`);
      assert.deepEqual(run.calls.download, [], "no request");
      assert.deepEqual(run.left, [], "no folder");
      checked += 1;
    } finally {
      run.cleanup();
    }
  }
  assert.equal(checked, 7);
});

test("a_failed_download_leaves_no_folder", async () => {
  const run = await runStep({ override: { download: async () => { throw new wd.WebviewDriverError("the download failed (test)"); } } });
  try {
    assert.match(run.error.message, /download failed/);
    assert.deepEqual(run.left, []);
  } finally {
    run.cleanup();
  }
});

test("the_folder_is_never_inside_the_repository", async () => {
  const { steps, calls } = world();
  await assert.rejects(
    wd.installDriver({ env: { RUNNER_TEMP: join(ROOT, "target") }, steps, log: () => {} }),
    (error) => error instanceof wd.WebviewDriverError && /repository/.test(error.message),
  );
  assert.deepEqual(calls.download, []);
  // a relative RUNNER_TEMP is not trusted either; the operating system's temp folder is used then (by hand: no RUNNER_TEMP)
  const before = readdirSync(tmpdir()).filter((name) => name.startsWith("petalock-webdriver-")).length;
  const world2 = world();
  const result = await wd.installDriver({ env: { RUNNER_TEMP: "relative" }, steps: world2.steps, log: () => {} });
  try {
    assert.ok(result.path.startsWith(tmpdir()), "the OS temp folder");
    assert.equal(readdirSync(tmpdir()).filter((name) => name.startsWith("petalock-webdriver-")).length, before + 1);
  } finally {
    rmSync(join(result.path, "..", ".."), { recursive: true, force: true });
  }
});

// ---- the workflow ---------------------------------------------------------------------------------------------------

const wfRead = (path) => readFileSync(join(ROOT, path), "utf8").replace(/\r\n/g, "\n");

/** The e2e job's steps, as `{ name, id, text }` in order, read by indentation (there is no YAML library here). */
function e2eSteps(text) {
  const start = text.indexOf("\n  e2e:\n");
  assert.ok(start >= 0, "the e2e job is in the file");
  const rest = text.slice(start + 1);
  const next = rest.slice(1).search(/^ {2}[A-Za-z0-9_-]+:/m);
  const job = next === -1 ? rest : rest.slice(0, next + 1);
  const stepsAt = job.indexOf("\n    steps:\n");
  assert.ok(stepsAt >= 0, "the job has steps");
  const steps = job
    .slice(stepsAt + "\n    steps:\n".length)
    .split(/^(?= {6}- )/m)
    .filter((chunk) => /^ {6}- /.test(chunk))
    .map((chunk) => ({
      text: chunk,
      name: /^ {6}- name:\s*(.*)$/m.exec(chunk)?.[1].replace(/^"|"$/g, "") ?? "",
      id: /^ {8}id:\s*(\S+)\s*$/m.exec(chunk)?.[1] ?? "",
    }));
  return { job, steps };
}

const codeLines = (text) => text.split("\n").filter((line) => !line.trim().startsWith("#"));

function checkEdgeDriverHandOver(text) {
  const { job, steps } = e2eSteps(text);
  assert.ok(steps.length >= 8, `only ${String(steps.length)} steps were read`);
  const mentions = codeLines(text).filter((line) => line.includes("PETALOCK_EDGEDRIVER"));
  assert.equal(mentions.length, 1, "PETALOCK_EDGEDRIVER is named once in the workflow");
  assert.ok(!codeLines(job.slice(0, job.indexOf("\n    steps:\n"))).some((line) => line.includes("PETALOCK_EDGEDRIVER")), "not job-wide");
  assert.ok(!codeLines(text).some((line) => /GITHUB_ENV/.test(line) && line.includes("EDGEDRIVER")), "not through GITHUB_ENV");
  const at = steps.findIndex((step) => step.text.includes("PETALOCK_EDGEDRIVER"));
  assert.ok(at >= 0);
  const end = steps[at];
  assert.equal(end.name, "End-to-end tests", "only the End-to-end step gets it");
  assert.match(end.text, /^ {8}run: node scripts\/e2e\.mjs\s*$/m);
  const given = /^ {8}env:\n(?: {10}\S.*\n)*? {10}PETALOCK_EDGEDRIVER: (\$\{\{ steps\.([A-Za-z0-9_-]+)\.outputs\.path \}\})\s*$/m.exec(end.text);
  assert.ok(given, "its value is a step output named path");
  const source = steps.findIndex((step) => step.id === given[2]);
  assert.ok(source >= 0 && source < at, "the step it comes from has that id and runs before");
  assert.equal(source, at - 1, "the download is the step just before the End-to-end step, so a failed download does not stop the site's tests");
  assert.match(steps[source].text, /^ {8}run: node scripts\/webview-driver\.mjs\s*$/m, "that step runs the script");
  // the site's browser tests keep the image's driver
  const site = steps.find((step) => step.name === "The site in a real browser");
  assert.ok(site && !site.text.includes("PETALOCK_EDGEDRIVER"), "the site step is untouched");
  assert.ok(!/share a major version/.test(text), "the versions step no longer claims a major version is enough");
}

test("the_driver_path_goes_to_the_end_to_end_step_alone", () => {
  const text = wfRead(".github/workflows/ci.yml");
  checkEdgeDriverHandOver(text);
  const id = /^ {8}id:\s*(\S+)\s*\n(?: {8}.*\n)*? {8}run: node scripts\/webview-driver\.mjs/m.exec(text)?.[1];
  assert.ok(id, "the step that runs the script has an id");
  const refused = (changed) => assert.throws(() => checkEdgeDriverHandOver(changed), { name: "AssertionError" });
  const value = `PETALOCK_EDGEDRIVER: \${{ steps.${id}.outputs.path }}`;
  assert.ok(text.includes(value));
  let mutations = 0;
  for (const changed of [
    text.replace(value, `PETALOCK_EDGEDRIVER: \${{ steps.other.outputs.path }}`),
    text.replace(value, "PETALOCK_EDGEDRIVER: C:\\somewhere\\msedgedriver.exe"),
    text.replace(value, `PETALOCK_EDGEDRIVER: \${{ steps.${id}.outputs.folder }}`),
    // job-wide: moved to the job's env
    text.replace(value, "PETALOCK_E2E_X: 1").replace('      PETALOCK_E2E_CI: "1"\n', `      PETALOCK_E2E_CI: "1"\n      ${value}\n`),
    // on the site step instead
    text.replace(`        env:\n          ${value}\n`, "").replace('          PETALOCK_SITE_BROWSER: "1"\n', `          PETALOCK_SITE_BROWSER: "1"\n          ${value}\n`),
    // through GITHUB_ENV
    text.replace(value, "PETALOCK_X: 1").replace("        run: node scripts/webview-driver.mjs\n", `        run: |\n          node scripts/webview-driver.mjs\n          "PETALOCK_EDGEDRIVER=x" >> $env:GITHUB_ENV\n`),
    // named twice
    text.replace('        run: node --test scripts/site.test.mjs\n', `        run: node --test scripts/site.test.mjs\n        # ${value}\n`).replace("        env:\n          PETALOCK_SITE_BROWSER", `        env:\n          ${value}\n          PETALOCK_SITE_BROWSER`),
    // the download moved up before the site's browser tests
    (() => {
      const step = `      - name: Download the Edge WebDriver that matches the web-view runtime\n        id: ${id}\n        run: node scripts/webview-driver.mjs\n`;
      assert.ok(text.includes(step), "the download step is in the file as written");
      return text.replace(step, "").replace("      # The download page,", `${step}      # The download page,`);
    })(),
    // the step the output comes from does not run the script
    text.replace("        run: node scripts/webview-driver.mjs\n", "        run: node scripts/something-else.mjs\n"),
    // the old comment
    text.replace("# The driver and the web-view runtime", "# The driver and the web-view runtime share a major version; they"),
  ]) {
    assert.notEqual(changed, text, "the mutation changed the text");
    refused(changed);
    mutations += 1;
  }
  assert.equal(mutations, 10);
});
