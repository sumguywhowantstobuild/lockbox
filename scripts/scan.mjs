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

// gitleaks exit 1 means "leaks found" but is also its fatal-error code, hence findingsExit below.
const gitleaks = {
  env: "LOCKBOX_GITLEAKS",
  bin: "gitleaks",
  okExit: [0, 1],
  findingsExit: 1,
  args: (out, mode) => ["git", ...mode, "--redact", "--no-banner", "--report-format", "json", "--report-path", out, "."],
  // Never print f.Secret or f.Match, even though --redact already hides them.
  findings: (r) =>
    r.map((f) => ({
      fail: true,
      text: `${f.RuleID} at ${f.File}:${f.StartLine}${f.Commit ? ` (commit ${f.Commit.slice(0, 8)})` : ""}`,
    })),
};

// One entry per tool. okExit: exit codes that mean "ran fine". emptyExit: an ok code that writes no report.
// findingsExit: an ok code that promises findings, so an empty list with it is a failure, not a clean scan.
const tools = [
  { ...gitleaks, name: "gitleaks", args: (out) => gitleaks.args(out, []) }, // committed history
  {
    // Staged, unstaged and new files, all diffed against HEAD. They are staged into a throwaway copy of the index
    // (gitIndex), so the real index is untouched and `git add` before scanning isn't needed.
    ...gitleaks,
    name: "gitleaks-uncommitted",
    gitIndex: join(outDir, "index"),
    args: (out) => gitleaks.args(out, ["--staged"]),
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
    findingsExit: 1,
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
// shortcut: the whole list goes on the command line, and Windows caps that near 32k characters; switch to scanning
// the directory (semgrep already honours .gitignore) once the repo has a few hundred files.
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
  if (tool.gitIndex) {
    env.GIT_INDEX_FILE = tool.gitIndex;
    for (const gitArgs of [["read-tree", "HEAD"], ["add", "-A"]]) {
      const g = spawnSync("git", gitArgs, { cwd: root, env, encoding: "utf8" });
      if (g.status !== 0) return { incomplete: `${tool.name} could not stage changes (git ${gitArgs[0]} failed)` };
    }
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
  let findings;
  try {
    findings = tool.findings(JSON.parse(readFileSync(join(root, reportPath), "utf8")));
  } catch {
    return { incomplete: `${tool.name} wrote no readable report` };
  }
  if (res.status === tool.findingsExit && !findings.length) {
    return { incomplete: `${tool.name} exited with ${res.status} but reported no findings` };
  }
  return { findings };
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
