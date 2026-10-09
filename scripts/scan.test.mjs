import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
  FAKE_SEMGREP_REPORT: '{"results":[]}',
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
  const leak = [{ RuleID: "generic-api-key", File: "src/a.rs", StartLine: 3, Secret: "hunter2-visible" }];
  const { code, out } = run({ FAKE_GITLEAKS_EXIT: "1", FAKE_GITLEAKS_REPORT: JSON.stringify(leak) });
  assert.equal(code, 1);
  assert.match(out, /generic-api-key/);
  assert.match(out, /src\/a\.rs:3/);
  assert.doesNotMatch(out, /hunter2/);
});

test("semgrep missing -> exit 2 and INCOMPLETE", () => {
  const { code, out } = run({ LOCKBOX_SEMGREP: "C:\no\such\dir\semgrep.exe" });
  assert.equal(code, 2);
  assert.match(out, /INCOMPLETE: semgrep not found/);
});

test("osv-scanner exit 128 (no packages) counts as clean", () => {
  const { code, out } = run({ FAKE_OSV_EXIT: "128", FAKE_OSV_REPORT: undefined });
  assert.equal(code, 0);
  assert.match(out, /CLEAN/);
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
