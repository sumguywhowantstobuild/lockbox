#!/usr/bin/env node
// Security scan: gitleaks (secrets in git history), semgrep (risky code), osv-scanner (vulnerable dependencies).
// Exit 0 = CLEAN, 1 = FINDINGS, 2 = INCOMPLETE (a tool is missing or failed, so "clean" can't be claimed).
// Usage: node scripts/scan.mjs [--json]
// Env LOCKBOX_GITLEAKS / LOCKBOX_SEMGREP / LOCKBOX_OSV point at a tool; a .mjs path is run with this Node (tests use that).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { delimiter, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, ".scan");
// pip installs semgrep here (not on PATH); see docs/SETUP.md troubleshooting.
const semgrepDir = process.env.APPDATA && join(process.env.APPDATA, "Python", "Python311", "Scripts");

// One entry per tool. okExit: exit codes that mean "ran fine". emptyExit: an ok code that writes no report.
const tools = [
  {
    name: "gitleaks",
    env: "LOCKBOX_GITLEAKS",
    bin: "gitleaks",
    okExit: [0, 1],
    args: (out) => ["git", "--redact", "--no-banner", "--report-format", "json", "--report-path", out, "."],
    // Never print f.Secret or f.Match, even though --redact already hides them.
    findings: (r) =>
      r.map((f) => ({ fail: true, text: `${f.RuleID} at ${f.File}:${f.StartLine} (commit ${f.Commit?.slice(0, 8)})` })),
  },
  {
    name: "semgrep",
    env: "LOCKBOX_SEMGREP",
    bin: semgrepDir ? join(semgrepDir, "semgrep.exe") : "semgrep",
    pathPrefix: semgrepDir,
    okExit: [0],
    args: (out) => [
      "scan", "--metrics=off", "--disable-version-check",
      ...["rust", "typescript", "secrets", "security-audit"].flatMap((p) => ["--config", `p/${p}`]),
      "--json", "--output", out,
      ...repoFiles(),
    ],
    findings: (r) =>
      r.results.map((f) => ({
        fail: f.extra.severity !== "INFO",
        text: `${f.extra.severity} ${f.check_id} at ${f.path}:${f.start.line}`,
      })),
  },
  {
    name: "osv-scanner",
    env: "LOCKBOX_OSV",
    bin: "osv-scanner",
    okExit: [0, 1, 128],
    emptyExit: 128, // no packages found
    args: (out) => [
      "scan", "source",
      ...["Cargo.lock", "package-lock.json"].filter((f) => existsSync(join(root, f))).flatMap((f) => ["-L", f]),
      "--format", "json", "--output-file", out,
    ],
    findings: (r) =>
      r.results.flatMap((res) =>
        res.packages.flatMap((p) =>
          p.groups.map((g) => {
            const score = parseFloat(g.max_severity);
            return {
              // Below 4 is only listed. An unknown score (NaN or 0) fails: don't wave through what we can't rate.
              fail: !(score > 0 && score < 4),
              text: `${g.ids[0]} in ${p.package.name} ${p.package.version} (CVSS ${g.max_severity || "unknown"})`,
            };
          }),
        ),
      ),
  },
];

// Files git knows about or would add (tracked + new, minus ignored), skipping ones deleted from disk.
function repoFiles() {
  const r = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8" });
  return r.stdout.split("\n").filter((f) => f && existsSync(join(root, f)));
}

function run(tool) {
  const bin = process.env[tool.env] ?? tool.bin;
  const [cmd, prefix] = extname(bin) === ".mjs" ? [process.execPath, [bin]] : [bin, []];
  const env = { ...process.env };
  if (tool.pathPrefix) {
    const key = Object.keys(env).find((k) => k.toLowerCase() === "path") ?? "PATH";
    env[key] = tool.pathPrefix + delimiter + (env[key] ?? "");
  }
  const reportPath = join(".scan", `${tool.name}.json`);
  // nosemgrep: javascript.lang.security.detect-child-process.detect-child-process -- cmd is a fixed tool name or an env override set by whoever runs the scan
  const res = spawnSync(cmd, [...prefix, ...tool.args(reportPath)], { cwd: root, env, encoding: "utf8" });

  if (res.error?.code === "ENOENT") return { incomplete: `${tool.name} not found` };
  if (res.error) return { incomplete: `${tool.name} could not start (${res.error.message})` };
  if (!tool.okExit.includes(res.status)) {
    const why = (res.stderr ?? "").trim().split("\n").slice(-1)[0];
    return { incomplete: `${tool.name} exited with ${res.status}${why ? ` (${why})` : ""}` };
  }
  if (res.status === tool.emptyExit) return { findings: [] };
  try {
    return { findings: tool.findings(JSON.parse(readFileSync(join(root, reportPath), "utf8"))) };
  } catch {
    return { incomplete: `${tool.name} wrote no readable report` };
  }
}

rmSync(outDir, { recursive: true, force: true }); // never read a stale report
mkdirSync(outDir);

const findings = [];
const incomplete = [];
for (const tool of tools) {
  const result = run(tool);
  if (result.incomplete) incomplete.push(result.incomplete);
  else findings.push(...result.findings.map((f) => ({ tool: tool.name, ...f })));
}

const failing = findings.filter((f) => f.fail).length;
const status = incomplete.length ? "INCOMPLETE" : failing ? "FINDINGS" : "CLEAN";

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ status, findings, incomplete }, null, 2));
} else {
  for (const f of findings) console.log(`${f.fail ? "FINDING" : "note   "} [${f.tool}] ${f.text}`);
  if (status === "INCOMPLETE") console.log(`INCOMPLETE: ${incomplete.join("; ")}`);
  else if (status === "FINDINGS") console.log(`FINDINGS: ${failing} to fix`);
  else console.log("CLEAN");
}
process.exitCode = { CLEAN: 0, FINDINGS: 1, INCOMPLETE: 2 }[status];
