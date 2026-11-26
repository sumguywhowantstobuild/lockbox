// Plan 5, Task 2: the release workflow (.github/workflows/release.yml), read as text. There is no YAML library in the
// repository, so the files are read the way installer-smoke.test.mjs reads them: by indentation, one job and one step at
// a time. Each check is a function of the workflow's text, run on the real file (it must pass) and on copies with one
// thing changed (it must fail), so a check that has gone blind shows up here. The checks that need GitHub itself (a
// dispatch from another branch being refused entry to the `release` environment) run after the merge; see the last test.

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { BINDING_PREDICATE_TYPE } from "./release-guard.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RELEASE = ".github/workflows/release.yml";
const BUILD = ".github/workflows/build-installer.yml";
const CI = ".github/workflows/ci.yml";
const read = (path) => readFileSync(join(ROOT, path), "utf8").replace(/\r\n/g, "\n");

// ---------------------------------------------------------------------------------------------------------------------
// Reading a workflow by indentation.

const indentOf = (line) => line.match(/^ */)[0].length;
const isBlank = (line) => line.trim() === "" || line.trim().startsWith("#");

/** The lines under `lines[at]`: every following line indented deeper than it (blank and comment lines included). */
function under(lines, at) {
  const indent = indentOf(lines[at]);
  const out = [];
  for (let i = at + 1; i < lines.length; i++) {
    if (!isBlank(lines[i]) && indentOf(lines[i]) <= indent) break;
    out.push(lines[i]);
  }
  while (out.length > 0 && isBlank(out.at(-1))) out.pop();
  return out;
}

/** The jobs: name -> { lines, text }. Fails when none are found. */
function jobsOf(text) {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => l === "jobs:");
  assert.ok(at >= 0, "no jobs: section");
  const block = under(lines, at);
  const jobs = new Map();
  block.forEach((line, i) => {
    const m = line.match(/^ {2}([a-z][a-z0-9-]*):\s*$/);
    if (m) {
      const own = under(block, i);
      jobs.set(m[1], { lines: own, text: own.join("\n") });
    }
  });
  assert.ok(jobs.size >= 1, "no jobs found");
  return jobs;
}

/** A job's own key at four spaces: its inline value (`runs-on: x` -> "x"), or null when absent. */
const field = (job, key) => job.lines.find((l) => l.startsWith(`    ${key}:`))?.slice(`    ${key}:`.length).trim() ?? null;

/** A job's permissions as an object, or undefined when it declares none. */
function permissionsOf(job) {
  const at = job.lines.findIndex((l) => /^ {4}permissions:/.test(l));
  if (at < 0) return undefined;
  const inline = job.lines[at].replace(/^ {4}permissions:/, "").trim();
  if (inline === "{}") return {};
  assert.equal(inline, "", `permissions written inline: ${inline}`);
  const out = {};
  for (const l of under(job.lines, at)) {
    const m = l.match(/^ {6}([a-z-]+): (read|write|none)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

/** A job's steps: { text, lines }. */
function stepsOf(job) {
  const at = job.lines.findIndex((l) => /^ {4}steps:\s*$/.test(l));
  if (at < 0) return [];
  const block = under(job.lines, at);
  const steps = [];
  for (const line of block) {
    if (/^ {6}- /.test(line)) steps.push([line]);
    else if (steps.length > 0) steps.at(-1).push(line);
  }
  return steps.map((lines) => ({ lines, text: lines.join("\n") }));
}

const stepUses = (step) => step.text.match(/^\s*(?:- )?uses: (\S+)/m)?.[1] ?? null;
const stepRun = (step) => {
  const at = step.lines.findIndex((l) => /^\s*(?:- )?run:/.test(l));
  if (at < 0) return null;
  const inline = step.lines[at].replace(/^\s*(?:- )?run:/, "").trim();
  return inline === "|" ? under(step.lines, at).map((l) => l.trim()).join("\n") : inline;
};
const stepIf = (step) => step.lines.map((l) => l.match(/^(?: {6}- | {8})if: (.*)$/)?.[1]?.trim()).find((v) => v !== undefined) ?? null;
const stepWith = (step, key) => step.text.match(new RegExp(`^ +${key}: (.*)$`, "m"))?.[1]?.trim() ?? null;

/** Replaces one job's text by `fn(text)`. */
function mapJob(text, name, fn) {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => l === `  ${name}:`);
  assert.ok(at >= 0, `no job ${name}`);
  const own = under(lines, at);
  return [...lines.slice(0, at + 1), ...fn(own.join("\n")).split("\n"), ...lines.slice(at + 1 + own.length)].join("\n");
}

const GUARD_STEP_RUN = 'node scripts/release-guard.mjs authorize';
const CLEANUP_IF = "${{ (failure() || cancelled()) && steps.guard-check.outcome == 'success' && steps.draft.outcome != 'skipped' }}";

// ---------------------------------------------------------------------------------------------------------------------
// The checks. Each takes the workflow's text and throws when it is wrong.

function checkRunsOnlyFromMain(text) {
  const lines = text.split("\n");
  const on = lines.findIndex((l) => l === "on:");
  assert.ok(on >= 0, "no on: block");
  const triggers = under(lines, on).filter((l) => /^ {2}[a-z_]+:/.test(l)).map((l) => l.trim().replace(/:.*$/, ""));
  assert.deepEqual(triggers, ["workflow_dispatch"], "the only trigger is a dispatch");
  assert.ok(!/^\s*tags:/m.test(text) && !/^\s*push:/m.test(text), "no tag or push trigger");
  const inputs = under(lines, lines.findIndex((l) => l === "    inputs:"));
  assert.deepEqual(inputs.filter((l) => /^ {6}[a-z]/.test(l)).map((l) => l.trim()), ["tag:"], "one input, the tag");
  assert.match(inputs.join("\n"), /required: true/);
  assert.match(inputs.join("\n"), /type: string/);

  const jobs = jobsOf(text);
  for (const name of ["attest", "draft"]) {
    assert.ok(jobs.has(name), `job ${name}`);
    assert.equal(field(jobs.get(name), "environment"), "release", `${name} runs in the release environment`);
  }
  for (const name of ["authorize", "build", "inspect"]) {
    assert.ok(jobs.has(name), `job ${name}`);
    assert.equal(field(jobs.get(name), "environment"), null, `${name} holds no environment`);
  }
  // The order: the guard first, then the build, then the checks of what was built, then the two jobs in the environment.
  const needs = (name) => (field(jobs.get(name), "needs") ?? "").replace(/[[\]]/g, "").split(",").map((s) => s.trim()).filter(Boolean).sort();
  assert.deepEqual(needs("authorize"), []);
  assert.deepEqual(needs("build"), ["authorize"]);
  assert.deepEqual(needs("inspect"), ["authorize", "build"]);
  assert.deepEqual(needs("attest"), ["authorize", "build", "inspect"]);
  assert.deepEqual(needs("draft"), ["attest", "authorize", "build", "inspect"]);

  // `authorize` checks out main's own commit (the workflow's), then runs the guard from it; the tag is never checked out.
  const steps = stepsOf(jobs.get("authorize"));
  const checkout = steps.findIndex((s) => stepUses(s)?.startsWith("actions/checkout@"));
  const guard = steps.findIndex((s) => stepRun(s) === GUARD_STEP_RUN);
  assert.ok(checkout >= 0, "authorize checks out main's commit");
  assert.ok(guard > checkout, "the guard runs after that checkout, from it");
  assert.equal(stepWith(steps[checkout], "ref"), "${{ github.sha }}");
  assert.equal(stepWith(steps[checkout], "fetch-depth"), "0", "full history, for the reachability check");
  assert.equal(stepWith(steps[checkout], "persist-credentials"), "false");
  assert.equal([...text.matchAll(/actions\/checkout@/g)].length, 1, "one checkout in the whole workflow");
  assert.deepEqual([...text.matchAll(/^\s+ref: (.*)$/gm)].map((m) => m[1].trim()), ["${{ github.sha }}"], "no ref but the workflow's own commit");
  // The tag input reaches the guard through an environment variable, once, and nowhere else.
  assert.deepEqual([...text.matchAll(/^.*\binputs\.tag\b.*$/gm)].map((m) => m[0].trim()), ["TAG: ${{ inputs.tag }}"]);
  assert.match(steps[guard].text, /env:\n(?: +.*\n)*? +TAG: \$\{\{ inputs\.tag \}\}/);
  assert.ok(!/secrets\./.test(text), "no secret but the job's own token");
}

const EXPECTED_PERMISSIONS = {
  authorize: { contents: "read", actions: "read" },
  build: { contents: "read" },
  inspect: {},
  attest: { "id-token": "write", attestations: "write" },
  draft: { contents: "write" },
};

function checkPermissions(text) {
  assert.match(text, /^permissions: \{\}$/m, "the workflow's default permissions are none");
  const jobs = jobsOf(text);
  assert.deepEqual([...jobs.keys()].sort(), Object.keys(EXPECTED_PERMISSIONS).sort());
  for (const [name, expected] of Object.entries(EXPECTED_PERMISSIONS)) {
    assert.deepEqual(permissionsOf(jobs.get(name)), expected, `${name}'s permissions`);
  }
  for (const name of ["inspect", "attest", "draft"]) {
    assert.ok(!/actions\/checkout@/.test(jobs.get(name).text), `${name} checks out nothing`);
    assert.ok(stepsOf(jobs.get(name)).length >= 4, `${name}'s steps were found`);
  }
  // The build is a call of the reusable workflow, with no steps of its own, read-only.
  assert.equal(field(jobs.get("build"), "uses"), "./.github/workflows/build-installer.yml");
  assert.deepEqual(stepsOf(jobs.get("build")), []);
  for (const name of ["authorize", "build"]) assert.ok(Object.values(permissionsOf(jobs.get(name))).every((v) => v === "read"), `${name} is read-only`);
  // Nothing but the two signing permissions anywhere else in the file.
  const writes = [...text.matchAll(/^ +([a-z-]+): write$/gm)].map((m) => `${m.input.slice(0, m.index).split("\n").length}:${m[1]}`);
  assert.equal(writes.length, 3, `write permissions: ${writes.join(" ")}`);
}

function usesLines(text) {
  return [...text.matchAll(/^\s*(?:-\s+)?uses:\s*(\S+)(?:\s+(#.*))?$/gm)].map((m) => ({ action: m[1], comment: m[2] ?? "" }));
}

function checkPinned(texts) {
  let found = 0;
  for (const [name, text] of Object.entries(texts)) {
    for (const { action, comment } of usesLines(text)) {
      found += 1;
      if (action === "./.github/workflows/build-installer.yml") continue;
      assert.match(action, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[0-9a-f]{40}$/, `${name}: ${action} is not pinned by a full commit hash`);
      assert.match(comment, /^# v\d+(\.\d+){0,2}$/, `${name}: ${action} has no version comment`);
    }
  }
  assert.ok(found >= 25, `only ${found} uses: lines found`);
}

function runnersOf(text) {
  const direct = [...text.matchAll(/^\s+runs-on: (\S+)$/gm)].map((m) => m[1]);
  const matrix = [...text.matchAll(/^\s+os: (\S+)$/gm)].map((m) => m[1]);
  return [...direct, ...matrix].filter((r) => !r.startsWith("${{"));
}

function checkRunners(text, ci) {
  const allowed = new Set(runnersOf(ci));
  assert.ok(allowed.has("windows-2025-vs2026") && allowed.has("ubuntu-24.04"), "the labels CI uses were found");
  const used = runnersOf(text);
  assert.equal(used.length, 4, `runners found: ${used.join(", ")}`);
  for (const r of used) {
    assert.ok(allowed.has(r), `${r} is not a label CI uses`);
    assert.ok(!/latest/.test(r), `${r} floats`);
  }
  const jobs = jobsOf(text);
  assert.equal(field(jobs.get("inspect"), "runs-on"), "windows-2025-vs2026");
  for (const name of ["authorize", "attest", "draft"]) assert.equal(field(jobs.get(name), "runs-on"), "ubuntu-24.04");
}

const guardStep = (steps, id) => steps.find((s) => new RegExp(`^\\s*(?:- )?id: ${id}$`, "m").test(s.text));

function checkShippedBytes(text) {
  const jobs = jobsOf(text);
  for (const name of ["inspect", "attest", "draft"]) {
    const steps = stepsOf(jobs.get(name));
    // The installer comes from the artifact the build named, and is checked against the digest the build output.
    const download = steps.findIndex((s) => stepUses(s)?.startsWith("actions/download-artifact@") && stepWith(s, "name") === "${{ needs.build.outputs.artifact }}");
    assert.ok(download >= 0, `${name} downloads the artifact the build named`);
    const check = steps.findIndex((s) => /\bcheck-installer\b/.test(stepRun(s) ?? ""));
    assert.ok(check > download, `${name} checks the installer after downloading it`);
    assert.match(steps[check].text, /EXPECTED_SHA256: \$\{\{ needs\.build\.outputs\.sha256 \}\}/, `${name} compares with the build's digest`);
    assert.match(steps[check].text, /VERSION: \$\{\{ needs\.authorize\.outputs\.version \}\}/, `${name} names the version it expects`);
    // The guard that does the check is the file `authorize` ran, by its digest.
    const fetchGuard = steps.findIndex((s) => stepUses(s)?.startsWith("actions/download-artifact@") && stepWith(s, "name") === "release-guard");
    const checkGuard = steps.findIndex((s) => /GUARD_SHA256: \$\{\{ needs\.authorize\.outputs\.guard-sha256 \}\}/.test(s.text));
    assert.ok(fetchGuard >= 0 && checkGuard > fetchGuard && check > checkGuard, `${name} verifies the guard's digest before using it`);
  }
  // The statements and the draft use the digest the check printed, never a path or a pattern.
  const attest = stepsOf(jobs.get("attest"));
  for (const s of attest.filter((x) => stepUses(x)?.startsWith("actions/attest@"))) {
    assert.equal(stepWith(s, "subject-digest"), "${{ steps.installer.outputs.digest }}");
    assert.equal(stepWith(s, "subject-name"), "${{ steps.installer.outputs.name }}");
    assert.equal(stepWith(s, "subject-path"), null);
  }
  const draft = guardStep(stepsOf(jobs.get("draft")), "draft");
  assert.ok(draft && /\bdraft\b/.test(stepRun(draft)), "the draft step");
  assert.match(draft.text, /EXPECTED_SHA256: \$\{\{ needs\.build\.outputs\.sha256 \}\}/);
  assert.match(text, /^permissions: \{\}$/m);
}

function checkAttestSteps(text) {
  const steps = stepsOf(jobsOf(text).get("attest"));
  const attests = steps.filter((s) => stepUses(s)?.startsWith("actions/attest@"));
  assert.equal(attests.length, 2, "two statements");
  const [provenance, binding] = ["provenance", "binding"].map((id) => guardStep(steps, id));
  assert.deepEqual(attests, [provenance, binding], "provenance first, then the bound statement");
  for (const key of ["predicate-type", "predicate", "predicate-path", "sbom-path"]) assert.equal(stepWith(provenance, key), null, `provenance has no ${key}`);
  assert.equal(stepWith(binding, "predicate-type"), BINDING_PREDICATE_TYPE);
  assert.equal(stepWith(binding, "predicate-path"), "${{ runner.temp }}/release-binding.json");
  assert.equal(stepWith(binding, "predicate"), null);
  for (const s of attests) {
    assert.equal(stepWith(s, "push-to-registry"), null);
    assert.equal(stepWith(s, "create-storage-record"), null);
  }
  // The bound statement's file is written from validated values by the guard, before it is signed, and both bundles are
  // collected and checked by the guard after.
  const write = steps.findIndex((s) => /\bwrite-binding\b/.test(stepRun(s) ?? ""));
  const collect = steps.findIndex((s) => /\bcollect-bundles\b/.test(stepRun(s) ?? ""));
  const upload = steps.findIndex((s) => stepUses(s)?.startsWith("actions/upload-artifact@"));
  assert.ok(write >= 0 && write < steps.indexOf(binding), "the statement's file is written before it is signed");
  assert.ok(collect > steps.indexOf(binding) && upload > collect, "bundles are collected and checked, then kept");
  const env = steps[write].text;
  for (const [key, value] of [["TAG", "needs.authorize.outputs.tag"], ["SOURCE", "needs.authorize.outputs.source"], ["VERSION", "needs.authorize.outputs.version"]]) {
    assert.match(env, new RegExp(`${key}: \\$\\{\\{ ${value.replaceAll(".", "\\.")} \\}\\}`), `${key} comes from authorize's validated outputs`);
  }
  assert.match(steps[collect].text, /PROVENANCE_BUNDLE: \$\{\{ steps\.provenance\.outputs\.bundle-path \}\}/);
  assert.match(steps[collect].text, /BINDING_BUNDLE: \$\{\{ steps\.binding\.outputs\.bundle-path \}\}/);
}

/**
 * Evaluates a step condition of the only shape the workflow uses: `failure()`, `cancelled()`, `steps.<id>.outcome`
 * compared with a quoted word by `==` or `!=`, joined by `&&`, `||` and parentheses (`&&` binds tighter). Anything else throws.
 */
function evalIf(condition, { failure, cancelled, steps }) {
  const body = condition.match(/^\$\{\{ (.*) \}\}$/)?.[1];
  assert.ok(body, `not an expression: ${condition}`);
  const tokens = body.match(/\(|\)|&&|\|\||==|!=|failure\(\)|cancelled\(\)|steps\.[a-z-]+\.outcome|'[a-z]+'|\s+/g) ?? [];
  assert.equal(tokens.join(""), body, `an expression this test does not read: ${body}`);
  const list = tokens.filter((t) => t.trim() !== "");
  let at = 0;
  const value = () => {
    const t = list[at++];
    if (t === "(") {
      const v = or();
      assert.equal(list[at++], ")");
      return v;
    }
    if (t === "failure()") return failure;
    if (t === "cancelled()") return cancelled;
    const m = t?.match(/^steps\.([a-z-]+)\.outcome$/);
    assert.ok(m, `unexpected ${t}`);
    const op = list[at++];
    assert.ok(op === "==" || op === "!=", `unexpected ${op}`);
    const word = list[at++].slice(1, -1);
    assert.ok(m[1] in steps, `no step ${m[1]} in the scenario`);
    return op === "==" ? steps[m[1]] === word : steps[m[1]] !== word;
  };
  const and = () => {
    let v = value();
    while (list[at] === "&&") {
      at++;
      const r = value();
      v = v && r;
    }
    return v;
  };
  const or = () => {
    let v = and();
    while (list[at] === "||") {
      at++;
      const r = and();
      v = v || r;
    }
    return v;
  };
  const result = or();
  assert.equal(at, list.length, "trailing tokens");
  return result;
}

function checkDraftCleanup(text) {
  const steps = stepsOf(jobsOf(text).get("draft"));
  const draft = steps.findIndex((s) => /^\s*(?:- )?id: draft$/m.test(s.text));
  const discard = steps.findIndex((s) => /\bdiscard-draft\b/.test(stepRun(s) ?? ""));
  const guardCheck = steps.findIndex((s) => /^\s*(?:- )?id: guard-check$/m.test(s.text) && /GUARD_SHA256:/.test(s.text));
  assert.ok(guardCheck >= 0 && guardCheck < draft, "the guard's digest check has an id and comes before the draft step");
  assert.ok(draft >= 0 && discard > draft, "the clean-up follows the draft step");
  assert.equal(discard, steps.length - 1, "nothing runs after the clean-up");
  // The clean-up runs the downloaded guard with the write token: never when that guard failed its digest check, and only
  // once the draft step has started.
  const condition = stepIf(steps[discard]);
  assert.ok(condition, "the clean-up has a condition");
  // The digest check's own success is required by name, whatever order the steps run in.
  assert.ok(condition.includes("steps.guard-check.outcome == 'success'"), "the clean-up requires the guard's digest check to have passed");
  assert.ok(!/continue-on-error/.test(text), "no step lets a failure pass");
  const scenarios = [
    ["the guard's digest check fails (the draft step is skipped)", { failure: true, cancelled: false, steps: { "guard-check": "failure", draft: "skipped" } }, false],
    ["the guard check fails and the run is cancelled", { failure: false, cancelled: true, steps: { "guard-check": "cancelled", draft: "skipped" } }, false],
    ["the digest check never ran", { failure: true, cancelled: false, steps: { "guard-check": "skipped", draft: "skipped" } }, false],
    ["a step between the check and the draft fails", { failure: true, cancelled: false, steps: { "guard-check": "success", draft: "skipped" } }, false],
    ["the draft step fails", { failure: true, cancelled: false, steps: { "guard-check": "success", draft: "failure" } }, true],
    ["the job is cancelled during the draft step", { failure: false, cancelled: true, steps: { "guard-check": "success", draft: "cancelled" } }, true],
    ["everything succeeds", { failure: false, cancelled: false, steps: { "guard-check": "success", draft: "success" } }, false],
  ];
  for (const [what, scenario, expected] of scenarios) assert.equal(evalIf(condition, scenario), expected, `the clean-up when ${what}`);
  const file = (s) => s.text.match(/DRAFT_ID_FILE: (.*)$/m)?.[1];
  assert.ok(file(steps[draft]) && file(steps[draft]) === file(steps[discard]), "both name the same id file");
  assert.equal(stepIf(steps[draft]), null, "the draft step itself always runs when reached");
  // Only the clean-up and the draft step hold the token.
  assert.deepEqual(steps.filter((s) => /GITHUB_TOKEN:/.test(s.text)).map((s) => s.lines[0].trim()), [steps[draft].lines[0].trim(), steps[discard].lines[0].trim()]);
}

function checkNoExpressionInRunText(text) {
  let blocks = 0;
  for (const job of jobsOf(text).values()) {
    for (const step of stepsOf(job)) {
      const run = stepRun(step);
      if (run === null) continue;
      blocks += 1;
      assert.ok(!run.includes("${{"), `an expression inside a script: ${run.split("\n")[0]}`);
    }
  }
  assert.ok(blocks >= 10, `only ${blocks} scripts found`);
}

function checkNodeVersion(text, nodeVersion) {
  const jobs = jobsOf(text);
  for (const name of ["inspect", "attest", "draft"]) {
    const setups = stepsOf(jobs.get(name)).filter((s) => stepUses(s)?.startsWith("actions/setup-node@"));
    assert.equal(setups.length, 1, `${name} sets up node once`);
    assert.equal(stepWith(setups[0], "node-version"), `"${nodeVersion}"`, `${name}'s node is the repository's`);
  }
  const authorize = stepsOf(jobs.get("authorize")).find((s) => stepUses(s)?.startsWith("actions/setup-node@"));
  assert.equal(stepWith(authorize, "node-version-file"), "ui/.node-version");
}

const ALL = { release: RELEASE, build: BUILD, ci: CI };

/** The mutation proof: the check passes on the file as it is, and fails on each of these changes (each must change something). */
function proves(check, text, mutations, ...rest) {
  assert.doesNotThrow(() => check(text, ...rest), "the check passes on the real file");
  let tried = 0;
  for (const [label, mutate] of Object.entries(mutations)) {
    const bad = mutate(text);
    assert.notEqual(bad, text, `${label}: the mutation changed nothing`);
    assert.throws(() => check(bad, ...rest), undefined, `${label}: the check did not fire`);
    tried += 1;
  }
  assert.equal(tried, Object.keys(mutations).length);
  assert.ok(tried >= 3, "the check was tried on wrong files");
}

const replaceOnce = (from, to) => (text) => {
  assert.ok(text.includes(from), `the file does not contain ${JSON.stringify(from)}`);
  return text.replace(from, to);
};

// ---------------------------------------------------------------------------------------------------------------------
// The tests, named as the plan names them.

test("release_runs_only_from_mains_workflow", () => {
  const text = read(RELEASE);
  checkRunsOnlyFromMain(text);
  proves(checkRunsOnlyFromMain, text, {
    "a tag trigger": replaceOnce("on:\n  workflow_dispatch:", 'on:\n  push:\n    tags: ["v*"]\n  workflow_dispatch:'),
    "a second trigger": replaceOnce("on:\n  workflow_dispatch:", "on:\n  workflow_call:\n  workflow_dispatch:"),
    "attest without the environment": (t) => mapJob(t, "attest", (j) => j.replace("    environment: release\n", "")),
    "draft in another environment": (t) => mapJob(t, "draft", (j) => j.replace("    environment: release\n", "    environment: site\n")),
    "an environment on the build checks": (t) => mapJob(t, "inspect", (j) => j.replace("    runs-on:", "    environment: release\n    runs-on:")),
    "the tag checked out": replaceOnce("ref: ${{ github.sha }}", "ref: ${{ inputs.tag }}"),
    "another script as the guard": replaceOnce("node scripts/release-guard.mjs authorize", "node scripts/other.mjs authorize"),
    "the draft not waiting for the attestation": (t) => mapJob(t, "draft", (j) => j.replace(/needs: \[.*\]/, "needs: [authorize, build, inspect]")),
    "the tag used in a script": replaceOnce("node scripts/release-guard.mjs authorize", 'echo "${{ inputs.tag }}"; node scripts/release-guard.mjs authorize'),
    "a branch trigger added": replaceOnce("workflow_dispatch:\n", "workflow_dispatch:\n  pull_request:\n"),
  });
});

test("jobs_hold_only_their_own_permissions", () => {
  const text = read(RELEASE);
  checkPermissions(text);
  proves(checkPermissions, text, {
    "default permissions": replaceOnce("permissions: {}\n", "permissions:\n  contents: read\n"),
    "attest with contents": (t) => mapJob(t, "attest", (j) => j.replace("      attestations: write\n", "      attestations: write\n      contents: write\n")),
    "attest without attestations": (t) => mapJob(t, "attest", (j) => j.replace("      attestations: write\n", "")),
    "draft with a second write": (t) => mapJob(t, "draft", (j) => j.replace("      contents: write\n", "      contents: write\n      packages: write\n")),
    "draft read only": (t) => mapJob(t, "draft", (j) => j.replace("contents: write", "contents: read")),
    "authorize with a write": (t) => mapJob(t, "authorize", (j) => j.replace("      actions: read\n", "      actions: write\n")),
    "the build with a write": (t) => mapJob(t, "build", (j) => j.replace("      contents: read\n", "      contents: write\n")),
    "a checkout in attest": (t) => mapJob(t, "attest", (j) => j.replace("    steps:\n", "    steps:\n      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7\n")),
    "a job with no permissions of its own": (t) => mapJob(t, "inspect", (j) => j.replace("    permissions: {}\n", "")),
  });
});

/** Every workflow file in the folder, by name: a workflow added later is covered without editing this test. */
function discoveredWorkflows() {
  const names = readdirSync(join(ROOT, ".github", "workflows")).filter((f) => /\.ya?ml$/.test(f)).sort();
  return Object.fromEntries(names.map((n) => [n, read(`.github/workflows/${n}`)]));
}

test("every_action_is_pinned_by_sha", () => {
  const found = discoveredWorkflows();
  // The files this plan's tasks rely on are among those found (a missing one would be a vacuous pass).
  for (const name of ["build-installer.yml", "ci.yml", "release.yml"]) assert.ok(name in found, `${name} was found`);
  checkPinned(found);
  // A workflow added later is checked too: pinned, it passes without any edit here; unpinned, it fails.
  const pinned = "name: Site\non:\n  push:\njobs:\n  deploy:\n    runs-on: ubuntu-24.04\n    steps:\n      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7\n";
  assert.doesNotThrow(() => checkPinned({ ...found, "site.yml": pinned }));
  assert.throws(() => checkPinned({ ...found, "site.yml": pinned.replace(/@[0-9a-f]{40}/, "@v7") }), /site\.yml/);
});

test("every_action_is_pinned_by_sha_fires_on_a_moving_reference", () => {
  const texts = Object.fromEntries(Object.entries(ALL).map(([k, p]) => [k, read(p)]));
  const bad = (name, from, to) => {
    const changed = { ...texts, [name]: texts[name].replace(from, to) };
    assert.notEqual(changed[name], texts[name], `${name}: nothing changed`);
    assert.throws(() => checkPinned(changed), undefined, `${name}: ${to}`);
  };
  assert.doesNotThrow(() => checkPinned(texts));
  bad("release", /actions\/attest@[0-9a-f]{40}/, "actions/attest@v4");
  bad("release", /actions\/download-artifact@[0-9a-f]{40}/, "actions/download-artifact@main");
  bad("release", /actions\/attest@([0-9a-f]{40}) # v[\d.]+/, "actions/attest@$1");
  bad("release", /actions\/attest@([0-9a-f]{40}) # v[\d.]+/, "actions/attest@$1 # latest");
  bad("release", /actions\/setup-node@[0-9a-f]{40}/, "actions/setup-node@" + "a".repeat(39));
  bad("ci", /actions\/checkout@[0-9a-f]{40}/, "actions/checkout@v7");
  bad("build", /Swatinem\/rust-cache@[0-9a-f]{40}/, "Swatinem/rust-cache@v2");
  bad("release", "uses: ./.github/workflows/build-installer.yml", "uses: ./.github/workflows/other.yml");
});

test("runners_are_pinned", () => {
  const text = read(RELEASE);
  const ci = read(CI);
  checkRunners(text, ci);
  proves(checkRunners, text, {
    "a floating label": (t) => mapJob(t, "attest", (j) => j.replace("ubuntu-24.04", "ubuntu-latest")),
    "a label CI does not use": (t) => mapJob(t, "draft", (j) => j.replace("ubuntu-24.04", "ubuntu-22.04")),
    "the check job on linux": (t) => mapJob(t, "inspect", (j) => j.replace("windows-2025-vs2026", "ubuntu-24.04")),
    "a self-hosted runner": (t) => mapJob(t, "authorize", (j) => j.replace("ubuntu-24.04", "self-hosted")),
  }, ci);
});

test("the_shipped_bytes_are_the_tested_bytes: the workflow checks the digest the build output, in each job", () => {
  const text = read(RELEASE);
  checkShippedBytes(text);
  proves(checkShippedBytes, text, {
    "attest comparing with nothing": (t) => mapJob(t, "attest", (j) => j.replace(/EXPECTED_SHA256: .*\n/, "")),
    "draft comparing with another digest": (t) => mapJob(t, "draft", (j) => j.replace("EXPECTED_SHA256: ${{ needs.build.outputs.sha256 }}", "EXPECTED_SHA256: ${{ needs.authorize.outputs.tag }}")),
    "inspect not checking": (t) => mapJob(t, "inspect", (j) => j.replaceAll("check-installer", "echo")),
    "a subject by path": (t) => mapJob(t, "attest", (j) => j.replace("subject-digest: ${{ steps.installer.outputs.digest }}", "subject-path: installer/*.exe")),
    "an artifact by another name": (t) => mapJob(t, "draft", (j) => j.replace("name: ${{ needs.build.outputs.artifact }}", "name: petalock-installer")),
    "the guard not checked": (t) => mapJob(t, "attest", (j) => j.replace("GUARD_SHA256: ${{ needs.authorize.outputs.guard-sha256 }}", "GUARD_SHA256: x")),
  });
});

test("the_release_attests_by_digest_twice_and_collects_what_it_signed", () => {
  const text = read(RELEASE);
  checkAttestSteps(text);
  proves(checkAttestSteps, text, {
    "one statement": (t) => mapJob(t, "attest", (j) => j.replace(/ {6}- name: Attest the bound statement\n[\s\S]*?(?=\n {6}- )\n/, "")),
    "a push to a registry": (t) => mapJob(t, "attest", (j) => j.replace("subject-name:", "push-to-registry: true\n          subject-name:")),
    "another predicate type": (t) => mapJob(t, "attest", (j) => j.replace(BINDING_PREDICATE_TYPE, "https://example.invalid/other/v1")),
    "an inline predicate": (t) => mapJob(t, "attest", (j) => j.replace("predicate-path:", "predicate:")),
    "a tag from the input": (t) => mapJob(t, "attest", (j) => j.replace("TAG: ${{ needs.authorize.outputs.tag }}", "TAG: ${{ inputs.tag }}")),
    "bundles not collected": (t) => mapJob(t, "attest", (j) => j.replaceAll("collect-bundles", "echo")),
  });
});

test("draft_is_verified_after_upload_or_deleted: the workflow deletes a draft the job did not finish", () => {
  const text = read(RELEASE);
  checkDraftCleanup(text);
  proves(checkDraftCleanup, text, {
    "no clean-up": (t) => mapJob(t, "draft", (j) => j.replace("discard-draft", "echo")),
    "a clean-up only on failure": replaceOnce(CLEANUP_IF, "${{ failure() && steps.guard-check.outcome == 'success' && steps.draft.outcome != 'skipped' }}"),
    "a clean-up that always runs": replaceOnce(CLEANUP_IF, "${{ always() }}"),
    "a clean-up that ignores the guard's digest check": replaceOnce(CLEANUP_IF, "${{ (failure() || cancelled()) && steps.draft.outcome != 'skipped' }}"),
    "a clean-up that runs when the draft step was skipped": replaceOnce(CLEANUP_IF, "${{ (failure() || cancelled()) && steps.guard-check.outcome == 'success' }}"),
    "a digest check without an id": (t) => mapJob(t, "draft", (j) => j.replace("        id: guard-check\n", "")),
    "another id file": (t) => mapJob(t, "draft", (j) => j.replace(/DRAFT_ID_FILE: [^\n]*(?![\s\S]*DRAFT_ID_FILE)/, "DRAFT_ID_FILE: other.txt")),
    "a step after the clean-up": (t) => mapJob(t, "draft", (j) => j + "\n      - run: echo done"),
    "a conditional draft step": (t) => mapJob(t, "draft", (j) => j.replace("        id: draft\n", "        id: draft\n        if: ${{ success() }}\n")),
  });
});

// Finding 8: the privileged jobs wait for a person's approval, so what they download must outlive the wait as long as the
// tested installer does.
function uploadsOf(text) {
  const out = [];
  for (const job of jobsOf(text).values()) {
    for (const s of stepsOf(job)) if (stepUses(s)?.startsWith("actions/upload-artifact@")) out.push({ name: stepWith(s, "name"), days: stepWith(s, "retention-days") });
  }
  return out;
}

function checkRetention(release, build) {
  const installer = uploadsOf(build).find((u) => u.name === "petalock-installer");
  assert.ok(installer, "the tested installer's upload was found");
  assert.match(installer.days ?? "", /^[1-9][0-9]*$/);
  const ours = uploadsOf(release);
  assert.deepEqual(ours.map((u) => u.name).sort(), ["attestation-bundles", "release-guard"], "the release's uploads were found");
  for (const u of ours) assert.equal(u.days, installer.days, `${u.name} is kept as long as the tested installer (${installer.days} days)`);
}

test("approval_does_not_outlive_the_artifacts_it_needs", () => {
  const release = read(RELEASE);
  const build = read(BUILD);
  assert.doesNotThrow(() => checkRetention(release, build));
  assert.equal(uploadsOf(build).find((u) => u.name === "petalock-installer").days, "7", "the installer's existing window");
  for (const [label, mutate] of Object.entries({
    "the guard kept one day": (t) => mapJob(t, "authorize", (j) => j.replace("retention-days: 7", "retention-days: 1")),
    "the bundles kept one day": (t) => mapJob(t, "attest", (j) => j.replace("retention-days: 7", "retention-days: 1")),
    "the bundles with no window": (t) => mapJob(t, "attest", (j) => j.replace("          retention-days: 7\n", "")),
  })) {
    const bad = mutate(release);
    assert.notEqual(bad, release, label);
    assert.throws(() => checkRetention(bad, build), undefined, label);
  }
  assert.throws(() => checkRetention(release, build.replace(/retention-days: 7\n( +if-no-files-found: error\n +overwrite: true\n +# A run that did not pass)/, "retention-days: 3\n$1")), undefined, "the installer's own window changing makes the release's differ");
});

// Finding 10: the version inside the installer is read from the installer's own Windows metadata, in `inspect`, and a step
// that does not run (or whose failure is let through) must not leave the gate looking present.
function checkEmbeddedVersionGate(text) {
  assert.ok(!/continue-on-error/.test(text), "no step lets a failure pass");
  const steps = stepsOf(jobsOf(text).get("inspect"));
  const installer = steps.findIndex((s) => /^\s*(?:- )?id: installer$/m.test(s.text));
  const gate = steps.findIndex((s) => /\bcheck-embedded-version\b/.test(stepRun(s) ?? ""));
  assert.ok(installer >= 0 && gate > installer, "the version check follows the installer's digest check");
  const step = steps[gate];
  assert.equal(stepIf(step), null, "the version check has no condition");
  assert.match(step.text, /shell: pwsh/);
  const run = stepRun(step);
  assert.match(run, /\(Get-Item -LiteralPath \$env:INSTALLER_PATH\)\.VersionInfo/, "read from the installer file's own metadata");
  assert.match(run, /\$env:PRODUCT_VERSION = \$info\.ProductVersion/);
  assert.match(run, /\$env:FILE_VERSION = \$info\.FileVersion/);
  assert.match(step.text, /VERSION: \$\{\{ needs\.authorize\.outputs\.version \}\}/, "against the tag's version");
  assert.match(step.text, /INSTALLER_NAME: \$\{\{ steps\.installer\.outputs\.name \}\}/);
  assert.match(step.text, /INSTALLER_PATH: \$\{\{ runner\.temp \}\}\/installer\/\$\{\{ steps\.installer\.outputs\.name \}\}/, "of the file that was checked");
  assert.equal(steps.length - 1, gate, "the gate is the job's last step, so the job fails if it does");
}

test("the_embedded_version_gate_cannot_disappear_without_a_failing_test", () => {
  const text = read(RELEASE);
  proves(checkEmbeddedVersionGate, text, {
    "the step removed": (t) => mapJob(t, "inspect", (j) => j.slice(0, j.indexOf("      # The version inside the installer"))),
    "the step skipped": (t) => mapJob(t, "inspect", (j) => j.replace("      - name: Check the version inside the installer\n", "      - name: Check the version inside the installer\n        if: ${{ false }}\n")),
    "the step's failure let through": (t) => mapJob(t, "inspect", (j) => j.replace("      - name: Check the version inside the installer\n", "      - name: Check the version inside the installer\n        continue-on-error: true\n")),
    "the guard not called": (t) => mapJob(t, "inspect", (j) => j.replace("node $env:GUARD check-embedded-version", "echo skipped")),
    "no metadata read": (t) => mapJob(t, "inspect", (j) => j.replace(".VersionInfo", ".Length")),
    "the file version taken from the product version": (t) => mapJob(t, "inspect", (j) => j.replace("$env:FILE_VERSION = $info.FileVersion", "$env:FILE_VERSION = $info.ProductVersion")),
    "another version to compare with": (t) => mapJob(t, "inspect", (j) => j.replace("VERSION: ${{ needs.authorize.outputs.version }}\n          INSTALLER_NAME", "VERSION: 0.1.0\n          INSTALLER_NAME")),
  });
});

test("no_expression_reaches_a_script_as_text", () => {
  const text = read(RELEASE);
  checkNoExpressionInRunText(text);
  proves(checkNoExpressionInRunText, text, {
    "the tag in a script": replaceOnce("node scripts/release-guard.mjs authorize", 'node scripts/release-guard.mjs authorize "${{ inputs.tag }}"'),
    "an output in a script": (t) => mapJob(t, "draft", (j) => j.replace(/run: node "\$GUARD" draft/, 'run: node "$GUARD" draft ${{ needs.authorize.outputs.tag }}')),
    "an expression in a script block": replaceOnce('echo "sha256=$hash" >> "$GITHUB_OUTPUT"', 'echo "sha256=${{ github.sha }}" >> "$GITHUB_OUTPUT"'),
  });
});

test("the_release_workflow_uses_the_repositorys_node_version", () => {
  const text = read(RELEASE);
  const version = read("ui/.node-version").trim();
  assert.match(version, /^\d+\.\d+\.\d+$/);
  checkNodeVersion(text, version);
  proves(checkNodeVersion, text, {
    "another version": (t) => t.replace(`"${version}"`, '"22.1.1"'),
    "a range": (t) => t.replace(`"${version}"`, '"24"'),
    "no version, the runner image's own": (t) => mapJob(t, "draft", (j) => j.replace(`node-version: "${version}"`, "node-version-file: ui/.node-version")),
  }, version);
});

// The tools: a release builds the Tauri CLI and the app's dependencies from source, restoring no cache.
function checkFreshTools(release, build, ci) {
  const call = jobsOf(release).get("build");
  assert.match(call.text, /^ {6}source: \$\{\{ needs\.authorize\.outputs\.source \}\}$/m);
  assert.match(call.text, /^ {6}fresh-tools: true$/m);
  assert.match(build, /^ {6}fresh-tools:\n {8}description: [^\n]+\n {8}required: false\n {8}type: boolean\n {8}default: false$/m);
  const steps = stepsOf(jobsOf(build).get("build"));
  const restoring = steps.filter((s) => /^(Swatinem\/rust-cache|actions\/cache)@/.test(stepUses(s) ?? ""));
  assert.equal(restoring.length, 2, "the two steps that restore a cache");
  for (const s of restoring) assert.equal(stepIf(s), "${{ !inputs.fresh-tools }}", `${stepUses(s)} is skipped for a release`);
  const install = steps.find((s) => /cargo install tauri-cli/.test(stepRun(s) ?? ""));
  assert.equal(stepIf(install), "steps.tauri-cli.outputs.cache-hit != 'true'", "the CLI is built when no cache entry was restored");
  // CI still keeps its caches: it does not set the input.
  assert.ok(!/fresh-tools/.test(ci), "CI's installer job does not ask for fresh tools");
}

test("the_release_builds_its_tools_fresh", () => {
  const release = read(RELEASE);
  const build = read(BUILD);
  const ci = read(CI);
  checkFreshTools(release, build, ci);
  const fires = (label, mutated) => assert.throws(() => checkFreshTools(...mutated), undefined, label);
  const [mutRelease, mutBuild, mutCi] = [release.replace("      fresh-tools: true\n", ""), build.replace(/ {6}fresh-tools:\n {8}description: [^\n]+\n/, "      fresh-tools:\n        description: x\n").replace("type: boolean\n        default: false", "type: string\n        default: x"), ci.replace("source: ${{ github.sha }}", "source: ${{ github.sha }}\n      fresh-tools: true")];
  assert.notEqual(mutRelease, release);
  assert.notEqual(mutBuild, build);
  assert.notEqual(mutCi, ci);
  fires("the release not asking", [mutRelease, build, ci]);
  fires("the input not a boolean", [release, mutBuild, ci]);
  fires("CI asking", [release, build, mutCi]);
  // A cache step left unconditional.
  const unconditional = build.replace(/ {8}if: \$\{\{ !inputs\.fresh-tools \}\}\n( {8}uses: actions\/cache@)/, "$1");
  assert.notEqual(unconditional, build, "the conditional was found");
  fires("a cache restored in a release", [release, unconditional, ci]);
});

test("the_contributing_guide_points_at_the_release_guide", () => {
  const text = read("CONTRIBUTING.md");
  assert.match(text, /\(RELEASING\.md\)/);
  assert.match(text, /release/i);
});

test.todo("a_branch_dispatch_cannot_attest_or_draft: runs once after the merge, in Task 13 Step 5, before the first candidate (a dispatch needs the workflow on main)");
