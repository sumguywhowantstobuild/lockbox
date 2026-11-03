import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const scan = fileURLToPath(new URL("./scan.mjs", import.meta.url));
const shim = (name) => fileURLToPath(new URL(`./fixtures/${name}.mjs`, import.meta.url));

// Every tool clean unless a test overrides it.
const clean = {
  LOCKBOX_GITLEAKS: shim("gitleaks"),
  LOCKBOX_SEMGREP: shim("semgrep"),
  LOCKBOX_OSV: shim("osv"),
  FAKE_GITLEAKS_REPORT: "[]",
  FAKE_GITLEAKS_STAGED_REPORT: "[]",
  FAKE_SEMGREP_REPORT: '{"results":[],"errors":[]}',
  FAKE_OSV_REPORT: '{"results":[]}',
};

const run = (overrides = {}, args = []) => {
  const r = spawnSync(process.execPath, [scan, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...clean, ...overrides },
  });
  return { code: r.status, out: r.stdout };
};

const semgrepResult = (severity) =>
  JSON.stringify({
    results: [{ check_id: "rules.demo", path: "src/a.rs", start: { line: 7 }, extra: { severity } }],
    errors: [],
  });

const osvResult = (score) =>
  JSON.stringify({
    results: [
      {
        packages: [
          {
            package: { name: "time", version: "0.1.43" },
            groups: [{ ids: ["RUSTSEC-2020-0071"], max_severity: score }],
          },
        ],
      },
    ],
  });

test("all tools clean -> exit 0 and CLEAN", () => {
  const { code, out } = run();
  assert.equal(code, 0);
  assert.match(out, /CLEAN/);
});

test("gitleaks finding -> exit 1, shown without the secret value", () => {
  const leak = [{ RuleID: "generic-api-key", File: "src/a.rs", StartLine: 3, Secret: "hunter2-visible" }]; // gitleaks:allow (fake value)
  const { code, out } = run({ FAKE_GITLEAKS_EXIT: "1", FAKE_GITLEAKS_REPORT: JSON.stringify(leak) });
  assert.equal(code, 1);
  assert.match(out, /generic-api-key/);
  assert.match(out, /src\/a\.rs:3/);
  assert.doesNotMatch(out, /hunter2/);
});

test("semgrep missing -> exit 2 and INCOMPLETE", () => {
  const { code, out } = run({ LOCKBOX_SEMGREP: "no-such-semgrep-binary" });
  assert.equal(code, 2);
  assert.match(out, /INCOMPLETE: semgrep not found/);
});

test("gitleaks finding in uncommitted changes -> exit 1, labelled as uncommitted", () => {
  const leak = [{ RuleID: "generic-api-key", File: "src/new.rs", StartLine: 9 }];
  const { code, out } = run({ FAKE_GITLEAKS_STAGED_EXIT: "1", FAKE_GITLEAKS_STAGED_REPORT: JSON.stringify(leak) });
  assert.equal(code, 1);
  assert.match(out, /\[gitleaks-uncommitted\] generic-api-key at src\/new\.rs:9/);
});

test("gitleaks exit 1 with no findings (its fatal-error code) -> exit 2, never clean", () => {
  const { code, out } = run({ FAKE_GITLEAKS_EXIT: "1" });
  assert.equal(code, 2);
  assert.match(out, /INCOMPLETE: gitleaks exited with 1 but reported no findings/);
});

test("osv-scanner exit 128 (no packages) -> exit 2, this workspace always has packages", () => {
  const { code, out } = run({ FAKE_OSV_EXIT: "128", FAKE_OSV_REPORT: undefined });
  assert.equal(code, 2);
  assert.match(out, /INCOMPLETE: osv-scanner found no packages to scan/);
});

test("missing Cargo.lock -> exit 2, dependencies would go unchecked", () => {
  const { code, out } = run({ LOCKBOX_CARGO_LOCK: "no/such/Cargo.lock" });
  assert.equal(code, 2);
  assert.match(out, /INCOMPLETE: osv-scanner needs Cargo\.lock, which is missing/);
});

test("osv_reads_ui_lockfile: osv-scanner is given ui/package-lock.json next to Cargo.lock", () => {
  // A one-off osv stand-in that records the arguments it was called with, then behaves like the clean fake.
  const dir = mkdtempSync(join(tmpdir(), "lockbox-scan-"));
  try {
    const argsFile = join(dir, "args.json");
    const recorder = join(dir, "osv-recorder.mjs");
    writeFileSync(
      recorder,
      `import { writeFileSync } from "node:fs";
import { fake } from ${JSON.stringify(new URL("./fixtures/fake.mjs", import.meta.url).href)};
writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));
fake("OSV");
`,
    );
    const { code } = run({ LOCKBOX_OSV: recorder });
    assert.equal(code, 0);
    const args = JSON.parse(readFileSync(argsFile, "utf8"));
    const lockfiles = args.flatMap((a, i) => (a === "-L" ? [args[i + 1]] : []));
    assert.deepEqual(lockfiles, ["Cargo.lock", "ui/package-lock.json"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("missing_ui_lockfile_fails: ui/package.json without its lockfile -> exit 2", () => {
  const { code, out } = run({ LOCKBOX_UI_LOCK: "no/such/package-lock.json" });
  assert.equal(code, 2);
  assert.match(out, /INCOMPLETE: osv-scanner needs ui\/package-lock\.json, which is missing/);
});

test("semgrep scan errors -> exit 2, files it could not scan are not clean", () => {
  const errors = JSON.stringify({ results: [], errors: [{ type: "PartialParsing", level: "warn" }] });
  const { code, out } = run({ FAKE_SEMGREP_REPORT: errors });
  assert.equal(code, 2);
  assert.match(out, /INCOMPLETE: semgrep reported 1 scan error/);
  // A report with no errors list at all is not trusted either.
  const bare = run({ FAKE_SEMGREP_REPORT: '{"results":[]}' });
  assert.equal(bare.code, 2);
  assert.match(bare.out, /semgrep wrote no readable report/);
});

test("git failing to list files -> exit 2, semgrep would scan nothing", () => {
  const { code, out } = run({ GIT_DIR: "no/such/git/dir" });
  assert.equal(code, 2);
  assert.match(out, /semgrep could not list the files to scan/);
});

test("a tool exiting 2 -> exit 2, never clean", () => {
  const { code, out } = run({ FAKE_GITLEAKS_EXIT: "2" });
  assert.equal(code, 2);
  assert.match(out, /INCOMPLETE: gitleaks exited with 2/);
  assert.doesNotMatch(out, /^CLEAN/m);
});

test("a tool that exits 0 but writes no report -> exit 2", () => {
  const { code, out } = run({ FAKE_SEMGREP_REPORT: undefined });
  assert.equal(code, 2);
  assert.match(out, /INCOMPLETE: semgrep wrote no readable report/);
});

test("semgrep ERROR and WARNING fail, INFO is only listed", () => {
  assert.equal(run({ FAKE_SEMGREP_REPORT: semgrepResult("ERROR") }).code, 1);
  assert.equal(run({ FAKE_SEMGREP_REPORT: semgrepResult("WARNING") }).code, 1);
  const info = run({ FAKE_SEMGREP_REPORT: semgrepResult("INFO") });
  assert.equal(info.code, 0);
  assert.match(info.out, /rules\.demo/);
});

test("osv score 4 and above fails, below 4 is only listed", () => {
  const high = run({ FAKE_OSV_EXIT: "1", FAKE_OSV_REPORT: osvResult("7.5") });
  assert.equal(high.code, 1);
  assert.match(high.out, /RUSTSEC-2020-0071/);
  assert.equal(run({ FAKE_OSV_EXIT: "1", FAKE_OSV_REPORT: osvResult("4.0") }).code, 1);
  assert.equal(run({ FAKE_OSV_EXIT: "1", FAKE_OSV_REPORT: osvResult("3.9") }).code, 0);
  assert.equal(run({ FAKE_OSV_EXIT: "1", FAKE_OSV_REPORT: osvResult("") }).code, 1);
});

test("--json prints one machine-readable result", () => {
  const { code, out } = run({ FAKE_SEMGREP_REPORT: semgrepResult("ERROR") }, ["--json"]);
  const result = JSON.parse(out);
  assert.equal(code, 1);
  assert.equal(result.status, "FINDINGS");
  assert.equal(result.findings[0].tool, "semgrep");
});
