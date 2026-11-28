#!/usr/bin/env node
// The release guard (Plan 5, Task 2). The release workflow (.github/workflows/release.yml) runs this file, from `main`'s
// own commit, before anything is signed or drafted, and again inside the two jobs that hold rights (`attest` and `draft`,
// which have no checkout: they receive this one file as an artifact and check its digest first).
//
//   node scripts/release-guard.mjs <command>      every input comes from an environment variable, never from the
//                                                 command line, so a value is never part of a script's text
//
//   authorize            the tag is a plain release tag, the run is main's own, the tag's commit is on main with full
//                        history fetched, the version agrees, and every job of ci.yml's push run on main for that commit
//                        succeeded on the run's latest attempt
//   check-installer      the downloaded installer is the one file with the expected name and the digest the build output
//   check-embedded-version  the installer's own version strings agree with the tag
//   write-binding        the statement that binds tag, source commit and installer digest (what the second attestation signs)
//   collect-bundles      both attestation bundles checked against what was signed, kept under fixed names
//   draft                an earlier draft for the tag is deleted, a new draft is made, the assets are uploaded and
//                        downloaded again and compared; any failure deletes the draft
//   discard-draft        deletes the recorded draft, only if it is still a draft (the job's clean-up step)
//   verify               `gh attestation verify` for both statements on a downloaded installer (run by a person)
//
// Exit status: 0 done, 1 refused (the reason on stderr), 2 not understood. No value that reaches a message here is a
// secret; the token is only ever in a request header, and is masked in any message that would hold it.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";

/** The jobs of ci.yml's push run that must all have succeeded (the names GitHub's API lists them under). */
export const CI_JOBS = [
  "Rust: format, lint, test (windows)",
  "Rust: format, lint, test (linux)",
  "UI: lint, test, build",
  "Security scan",
  "End-to-end: the real app (windows)",
  "Installer / Installer: build and smoke test (windows)",
];

/** The type of the signed statement that binds the tag, the source commit and the installer. */
export const BINDING_PREDICATE_TYPE = "https://github.com/sumguywhowantstobuild/petalock/release-binding/v1";
const PROVENANCE_TYPE = "https://slsa.dev/provenance/v1";
const STATEMENT_TYPE = "https://in-toto.io/Statement/v1";
const OIDC_ISSUER = "https://token.actions.githubusercontent.com";
const MAIN = "refs/heads/main";

const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** A value for a message: short, with control characters escaped. */
const show = (v) => (typeof v === "string" ? JSON.stringify(v.slice(0, 60)) : typeof v);

// ---------------------------------------------------------------------------------------------------------------------
// Shapes. Each allows what a real value looks like today and refuses everything else.

const TAG = /^v(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/;

/** The version of a release tag `v<major>.<minor>.<patch>` (plain numbers, no suffix); throws for anything else. */
export function parseTag(tag) {
  if (typeof tag !== "string" || tag.length > 40 || !TAG.test(tag)) {
    throw new Error(`the release tag must be v<major>.<minor>.<patch> with plain numbers (got ${show(tag)})`);
  }
  return tag.slice(1);
}

/** `owner/name`, each part made of letters, digits, `_`, `.` and `-`, and neither `.` nor `..`. */
export function checkRepository(repository) {
  const ok = typeof repository === "string" && /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(repository) && repository.split("/").every((p) => !/^\.{1,2}$/.test(p));
  if (!ok) throw new Error(`the repository must be owner/name (got ${show(repository)})`);
  return repository;
}

/** The workspace's version in Cargo.toml: `version = "x.y.z"` under `[workspace.package]`. */
export function cargoVersion(text) {
  let inTable = false;
  let found = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    const header = line.match(/^\[+([^\]]+)\]+\s*(#.*)?$/);
    if (header) {
      inTable = header[1].trim() === "workspace.package";
      continue;
    }
    const m = inTable ? line.match(/^version\s*=\s*"([^"]*)"\s*(#.*)?$/) : null;
    if (m) {
      found = m[1];
      break;
    }
  }
  if (found === null || !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(found)) {
    throw new Error("Cargo.toml has no plain x.y.z version under [workspace.package]");
  }
  return found;
}

export const installerName = (version) => `Petalock_${version}_x64-setup.exe`;

/** The four files of a draft release, by role. */
export function assetNames(version) {
  const installer = installerName(version);
  return {
    installer,
    sha256: `${installer}.sha256`,
    provenance: `${installer}.provenance.sigstore.json`,
    binding: `${installer}.release-binding.sigstore.json`,
  };
}

export function checkVersion({ tagVersion, cargoVersion: cargo }) {
  if (tagVersion !== cargo) throw new Error(`the tag says version ${tagVersion} but Cargo.toml says ${cargo}`);
}

/** The built installer's file name and its two embedded version strings all say the tag's version. */
export function checkInstallerVersion({ version, fileName, productVersion, fileVersion }) {
  if (fileName !== installerName(version)) throw new Error(`the installer's name is ${show(fileName)}, not the name for version ${version}`);
  if (productVersion !== version) throw new Error(`the installer's ProductVersion is ${show(productVersion)}, not version ${version}`);
  if (fileVersion !== version) throw new Error(`the installer's FileVersion is ${show(fileVersion)}, not version ${version}`);
}

// ---------------------------------------------------------------------------------------------------------------------
// git: the checkout.

/** git in `cwd`: `out(...args)` is the output (throws on failure); `test(...args)` is true for exit 0, false for 1. */
export function makeGit(cwd) {
  // nosemgrep: javascript.lang.security.detect-child-process.detect-child-process -- the command is `git` and every argument is a fixed word or a value checked against a strict shape
  const run = (args) => spawnSync("git", args, { cwd, encoding: "utf8" });
  const fail = (args, r) => new Error(`git ${args[0]} failed${r.stderr ? `: ${r.stderr.trim().split("\n").at(-1)}` : ""}`);
  return {
    out(...args) {
      const r = run(args);
      if (r.status !== 0) throw fail(args, r);
      return r.stdout.trim();
    },
    test(...args) {
      const r = run(args);
      if (r.status === 0) return true;
      if (r.status === 1) return false;
      throw fail(args, r);
    },
  };
}

function peelTagGit(git, tag) {
  if (!git.test("rev-parse", "--verify", "--quiet", `refs/tags/${tag}`)) throw new Error(`the tag ${tag} was not found in the checkout`);
  const commit = git.out("rev-parse", "--verify", `refs/tags/${tag}^{commit}`);
  if (!HEX40.test(commit)) throw new Error(`the tag ${tag} does not name a commit`);
  return commit;
}

// ---------------------------------------------------------------------------------------------------------------------
// GitHub's REST API.

/** The calls the guard makes. `fetch` is injected so the tests answer instead of GitHub. */
export function makeApi({ fetch: doFetch = globalThis.fetch, token, repository }) {
  if (typeof token !== "string" || token === "") throw new Error("no GitHub token was given");
  checkRepository(repository);
  const base = `https://api.github.com/repos/${repository}/`;
  const headers = (extra = {}) => ({
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "release-guard",
    ...extra,
  });
  const where = (url) => new URL(url).pathname;

  async function call(method, url, { body, extra, expect = [200, 201, 204] } = {}) {
    const res = await doFetch(url, { method, headers: headers(extra), body, redirect: "manual" });
    if (!expect.includes(res.status)) {
      let detail = "";
      try {
        detail = String((await res.json())?.message ?? "").slice(0, 120);
      } catch {
        // no JSON body
      }
      const error = new Error(`${method} ${where(url)} answered ${res.status}${detail ? ` (${detail})` : ""}`);
      error.status = res.status;
      throw error;
    }
    return res;
  }
  const get = async (path) => (await call("GET", base + path)).json();
  const integer = (n, what) => {
    if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`${what} is not an id`);
    return n;
  };

  return {
    get,
    /** Every item of a list: an object's `key` (with its `total_count`), or a bare array read until an empty page. */
    async list(path, key) {
      const sep = path.includes("?") ? "&" : "?";
      const items = [];
      let total = null;
      for (let page = 1; ; page++) {
        if (page > 30) throw new Error(`${path}: more than 30 pages`);
        const data = await get(`${path}${sep}per_page=100&page=${page}`);
        const part = key ? data?.[key] : data;
        if (!Array.isArray(part)) throw new Error(`${path}: the answer holds no list`);
        if (key && Number.isSafeInteger(data.total_count)) total = data.total_count;
        items.push(...part);
        if (part.length === 0 || (total !== null && items.length >= total)) break;
      }
      if (total !== null && items.length < total) throw new Error(`${path}: incomplete: ${items.length} of ${total} read`);
      return items;
    },
    async post(path, body) {
      return (await call("POST", base + path, { body: JSON.stringify(body), extra: { "content-type": "application/json" }, expect: [201] })).json();
    },
    async del(path) {
      await call("DELETE", base + path, { expect: [204] });
    },
    async upload(releaseId, name, bytes) {
      if (!/^[A-Za-z0-9_.-]{1,120}$/.test(name)) throw new Error(`${show(name)} is not a name this guard uploads`);
      const url = `https://uploads.github.com/repos/${repository}/releases/${integer(releaseId, "the release")}/assets?name=${encodeURIComponent(name)}`;
      return (await call("POST", url, { body: bytes, extra: { "content-type": "application/octet-stream" }, expect: [201] })).json();
    },
    /** An asset's bytes. GitHub answers with a redirect to its storage: followed by hand, to https only, without the token. */
    async download(assetId) {
      const res = await call("GET", `${base}releases/assets/${integer(assetId, "the asset")}`, { extra: { accept: "application/octet-stream" }, expect: [200, 302] });
      if (res.status === 200) return Buffer.from(await res.arrayBuffer());
      let target;
      try {
        target = new URL(res.headers.get("location") ?? "");
      } catch {
        throw new Error("a download redirected to no usable address");
      }
      if (target.protocol !== "https:") throw new Error("a download redirected to an address that is not https, and was not followed");
      const blob = await doFetch(target, { method: "GET", headers: { "user-agent": "release-guard" }, redirect: "manual" });
      if (blob.status !== 200) throw new Error(`the download from storage answered ${blob.status}`);
      return Buffer.from(await blob.arrayBuffer());
    },
  };
}

/** The commit a tag names, by GitHub's API (an annotated tag is peeled). */
export async function peelTagApi(api, tag) {
  parseTag(tag);
  let ref;
  try {
    ref = await api.get(`git/ref/tags/${tag}`);
  } catch (e) {
    if (e.status === 404) throw new Error(`the tag ${tag} was not found on GitHub`);
    throw e;
  }
  let object = ref?.object;
  for (let depth = 0; depth < 5 && object?.type === "tag"; depth++) object = (await api.get(`git/tags/${object.sha}`))?.object;
  if (object?.type !== "commit" || !HEX40.test(object.sha)) throw new Error(`the tag ${tag} does not name a commit`);
  return object.sha;
}

// ---------------------------------------------------------------------------------------------------------------------
// authorize: the checks before anything is built, signed or drafted.

/**
 * The newest push run of ci.yml on main for `sha`, once every such run has finished and the newest one succeeded. A run of
 * another ref, event or repository does not count, whatever the API's filter did.
 */
async function settledNewestRun(api, { repository, sha }) {
  if (!HEX40.test(sha)) throw new Error("the commit is not a full commit hash");
  const all = await api.list(`actions/workflows/ci.yml/runs?branch=main&event=push&head_sha=${sha}`, "workflow_runs");
  const runs = all.filter((r) => r.head_sha === sha && r.event === "push" && r.head_branch === "main" && r.repository?.full_name === repository && r.head_repository?.full_name === repository);
  if (runs.length === 0) throw new Error(`no push run of ci.yml on main for commit ${sha}`);
  const going = runs.find((r) => r.status !== "completed");
  if (going) throw new Error(`CI run ${going.id} for this commit is still in progress`);
  const newest = runs.reduce((a, b) => (Number(b.id) > Number(a.id) ? b : a));
  if (!Number.isSafeInteger(newest.id) || !Number.isSafeInteger(newest.run_attempt) || newest.run_attempt < 1) throw new Error("the CI run has no usable id or attempt");
  if (newest.conclusion !== "success") throw new Error(`the newest CI run (${newest.id}) ended as ${newest.conclusion}, not success`);
  return newest;
}

/**
 * Every job of ci.yml's push run on main for `sha` ran to success on the run's latest attempt. A missing, skipped,
 * cancelled, failed, stale or unfinished job, a newer run still going, or a green run under another ref or event, refuses.
 * Returns the names of the jobs that were checked.
 */
export async function checkCi(api, { repository, sha }) {
  const newest = await settledNewestRun(api, { repository, sha });
  const attempt = newest.run_attempt;
  const jobs = await api.list(`actions/runs/${newest.id}/attempts/${attempt}/jobs`, "jobs");
  // A re-run or a newer run can start while the jobs are read, and the old attempt's jobs still say success: the runs
  // are read again, and the same run and attempt must still be the newest, finished and successful.
  const again = await settledNewestRun(api, { repository, sha });
  if (again.id !== newest.id || again.run_attempt !== attempt) {
    throw new Error(`CI changed while it was being read: run ${newest.id} attempt ${attempt} is now run ${again.id} attempt ${again.run_attempt}; start the release again once CI has settled`);
  }
  if (jobs.length === 0) throw new Error(`CI run ${newest.id} lists no jobs`);
  const problems = [];
  const count = new Map();
  for (const j of jobs) {
    count.set(j.name, (count.get(j.name) ?? 0) + 1);
    if (j.run_id !== newest.id) problems.push(`job "${j.name}" belongs to run ${j.run_id}, not run ${newest.id} (stale)`);
    if (j.run_attempt !== attempt) problems.push(`job "${j.name}" is from attempt ${j.run_attempt}, the run's latest is ${attempt} (stale)`);
    if (j.head_sha !== sha) problems.push(`job "${j.name}" is for another commit (stale)`);
    if (j.status !== "completed") problems.push(`job "${j.name}" is not finished (status ${j.status})`);
    else if (j.conclusion !== "success") problems.push(`job "${j.name}" ended as ${j.conclusion}, not success`);
  }
  for (const name of CI_JOBS) {
    const n = count.get(name) ?? 0;
    if (n === 0) problems.push(`job "${name}" is missing from the run`);
    else if (n > 1) problems.push(`job "${name}" appears twice`);
  }
  // "Re-run failed jobs" leaves the jobs it didn't re-run on an earlier attempt, which reads as stale here: the way back is
  // "Re-run all jobs", so every job is on one attempt.
  if (problems.length > 0) {
    throw new Error(`CI is not clean for ${sha}: ${problems.join("; ")}. If a job failed and was re-run, use "Re-run all jobs" on that CI run (not "Re-run failed jobs"), then start the release again`);
  }
  return [...CI_JOBS];
}

/**
 * Main's own release run, for a tag on main, whose version and CI results are right. `env` is the process environment
 * (TAG, GITHUB_REPOSITORY, GITHUB_REF, GITHUB_SHA, GITHUB_WORKFLOW_REF); `git` runs in the checkout of the workflow's commit.
 */
export async function authorize({ env, git, api }) {
  const tag = env.TAG;
  const version = parseTag(tag);
  const repository = checkRepository(env.GITHUB_REPOSITORY);
  if (env.GITHUB_REF !== MAIN) throw new Error(`the release runs only from main's own workflow, not from ${show(env.GITHUB_REF)}; start it on main`);
  if (env.GITHUB_WORKFLOW_REF !== `${repository}/.github/workflows/release.yml@${MAIN}`) {
    throw new Error(`the running workflow is not release.yml on main (${show(env.GITHUB_WORKFLOW_REF)})`);
  }
  const workflowSha = env.GITHUB_SHA;
  if (!HEX40.test(workflowSha ?? "")) throw new Error("GITHUB_SHA is not a full commit hash");
  const head = git.out("rev-parse", "HEAD");
  if (head !== workflowSha) throw new Error(`the commit checked out is ${head}, not the workflow's commit ${workflowSha}`);
  if (git.out("rev-parse", "--is-shallow-repository") !== "false") throw new Error("the checkout is shallow; the history must be fetched in full to check the tag is on main");
  if (!git.test("rev-parse", "--verify", "--quiet", "refs/remotes/origin/main^{commit}")) throw new Error("origin/main is missing from the checkout");
  if (!git.test("merge-base", "--is-ancestor", workflowSha, "refs/remotes/origin/main")) throw new Error("the workflow's commit is not on main");
  const source = peelTagGit(git, tag);
  if (!git.test("merge-base", "--is-ancestor", source, "refs/remotes/origin/main")) {
    throw new Error(`the tag ${tag} names ${source}, which is not on main (not reachable from origin/main)`);
  }
  checkVersion({ tagVersion: version, cargoVersion: cargoVersion(git.out("show", `${source}:Cargo.toml`)) });
  const ciJobs = await checkCi(api, { repository, sha: source });
  return { tag, source, version, ciJobs };
}

// ---------------------------------------------------------------------------------------------------------------------
// The installer and the two statements.

/** The one file in `dir` is the installer for `version`, and its SHA-256 is the digest the build output. */
export function checkInstaller({ dir, version, expectedSha256 }) {
  if (!HEX64.test(String(expectedSha256))) throw new Error("the expected SHA-256 is not 64 lowercase hex digits");
  const name = installerName(version);
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    throw new Error("found no installer folder");
  }
  if (entries.length !== 1) throw new Error(`expected exactly one file in the installer folder, found ${entries.length}`);
  const [entry] = entries;
  if (!entry.isFile()) throw new Error(`${show(entry.name)} is not a file`);
  if (entry.name !== name) throw new Error(`the installer is named ${show(entry.name)}, expected ${name}`);
  const bytes = readFileSync(join(dir, name));
  const actual = sha256(bytes);
  if (actual !== expectedSha256) throw new Error(`the installer's SHA-256 ${actual} differs from the digest the build output, ${expectedSha256}`);
  return { name, path: join(dir, name), sha256: actual, digest: `sha256:${actual}`, bytes };
}

/** What the second attestation signs: the tag, the peeled source commit and the installer's digest, bound together. */
export function bindingPredicate({ tag, source, version, repository, name, sha256: digest }) {
  return { tag, sourceCommit: source, version, repository, installer: { name, sha256: digest } };
}

/** The first difference between a statement's predicate and the expected one, as a sentence, or null. */
function firstDifference(actual, expected, path = "predicate") {
  if (isObject(expected)) {
    if (!isObject(actual)) return `the statement's ${path} is not an object`;
    for (const key of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
      const d = firstDifference(actual[key], expected[key], `${path}.${key}`);
      if (d) return d;
    }
    return null;
  }
  return actual === expected ? null : `the statement's ${path} is ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`;
}

/**
 * A Sigstore bundle holds a signed in-toto statement for exactly the installer, of the type expected (and with the
 * predicate expected, when one is given). This checks what was signed; that the signature is genuine is `gh attestation
 * verify`'s check, run on the draft by a person.
 */
export function checkBundle(text, expect) {
  let bundle;
  try {
    bundle = JSON.parse(text);
  } catch {
    throw new Error("the bundle is not JSON");
  }
  const envelope = bundle?.dsseEnvelope;
  if (!isObject(bundle) || !isObject(envelope)) throw new Error("the bundle holds no signed envelope");
  if (!isObject(bundle.verificationMaterial)) throw new Error("the bundle holds no verification material");
  if (envelope.payloadType !== "application/vnd.in-toto+json") throw new Error(`the envelope's payload type is ${show(envelope.payloadType)}, not an in-toto statement`);
  if (!Array.isArray(envelope.signatures) || envelope.signatures.length === 0 || !envelope.signatures.every((s) => typeof s?.sig === "string" && s.sig !== "")) {
    throw new Error("the envelope holds no signature");
  }
  if (typeof envelope.payload !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(envelope.payload)) throw new Error("the envelope's payload is not base64");
  let statement;
  try {
    statement = JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8"));
  } catch {
    throw new Error("the envelope's payload is not JSON");
  }
  if (!isObject(statement) || statement._type !== STATEMENT_TYPE) throw new Error("the payload is not an in-toto v1 statement");
  if (statement.predicateType !== expect.predicateType) throw new Error(`the statement's predicate type is ${show(statement.predicateType)}, expected ${expect.predicateType}`);
  const subject = statement.subject;
  if (!Array.isArray(subject) || subject.length !== 1) throw new Error("the statement must have exactly one subject");
  const digests = Object.keys(subject[0]?.digest ?? {});
  if (subject[0].name !== expect.name || digests.length !== 1 || subject[0].digest.sha256 !== expect.sha256) {
    throw new Error(`the statement's subject is not ${expect.name} with digest ${expect.sha256}`);
  }
  if (expect.predicate !== undefined) {
    const d = firstDifference(statement.predicate, expect.predicate);
    if (d) throw new Error(d);
  }
  return statement;
}

const expectations = ({ tag, source, version, repository, name, sha256: digest }) => ({
  provenance: { name, sha256: digest, predicateType: PROVENANCE_TYPE },
  binding: { name, sha256: digest, predicateType: BINDING_PREDICATE_TYPE, predicate: bindingPredicate({ tag, source, version, repository, name, sha256: digest }) },
});

function checkFacts(facts) {
  const version = parseTag(facts.tag);
  checkRepository(facts.repository);
  if (version !== facts.version) throw new Error(`the tag says version ${version}, not ${facts.version}`);
  if (!HEX40.test(facts.source ?? "")) throw new Error("the source is not a full commit hash");
  if (!HEX64.test(facts.sha256 ?? "")) throw new Error("the digest is not 64 lowercase hex digits");
  if (facts.name !== installerName(version)) throw new Error(`the installer's name is ${show(facts.name)}, not the name for version ${version}`);
}

/** Both bundles, checked, kept under fixed names in `outDir`; nothing is written unless both pass. Returns the names. */
export function collectBundles({ provenance, binding, outDir, ...facts }) {
  checkFacts(facts);
  const names = assetNames(facts.version);
  const want = expectations(facts);
  const texts = [
    [names.provenance, readFileSync(provenance, "utf8"), want.provenance],
    [names.binding, readFileSync(binding, "utf8"), want.binding],
  ];
  for (const [, text, expect] of texts) checkBundle(text, expect);
  mkdirSync(outDir, { recursive: true });
  for (const [name, text] of texts) writeFileSync(join(outDir, name), text.endsWith("\n") ? text : `${text}\n`);
  return texts.map(([name]) => name);
}

// ---------------------------------------------------------------------------------------------------------------------
// The draft release.

async function requireTag(api, tag, source) {
  const now = await peelTagApi(api, tag);
  if (now !== source) throw new Error(`the tag ${tag} now names commit ${now}, not the source commit ${source}: it moved`);
}

/**
 * Deletes release `id` only while it is still a draft, judged by its state right now: "deleted", "gone" (already absent) or
 * "public" (not deleted). The one deletion both the replacement of an earlier draft and the failure clean-up go through.
 */
async function deleteIfDraft(api, id) {
  let release;
  try {
    release = await api.get(`releases/${id}`);
  } catch (e) {
    if (e.status === 404) return "gone";
    throw e;
  }
  if (release.draft !== true) return "public";
  await api.del(`releases/${id}`);
  return "deleted";
}

/**
 * Makes the draft release for the tag with the four files, and checks it. An earlier draft for the tag is deleted first
 * (a published release for the tag stops everything). The draft's id is written to `idFile` as soon as it exists, and its
 * body names the workflow run and attempt (`run`). After the
 * uploads, the assets are listed and each is downloaded again and compared with the file that was uploaded; the tag is
 * checked to still name the source commit right before the uploads and again after. Any failure after the draft exists
 * deletes it.
 */
export async function draftRelease({ api, tag, source, version, repository, run, sha256: expected, installerDir, bundlesDir, idFile }) {
  if (!isObject(run) || !/^[0-9]{1,20}$/.test(String(run.id)) || !/^[0-9]{1,6}$/.test(String(run.attempt))) throw new Error("the workflow run's id and attempt must be numbers");
  const installer = checkInstaller({ dir: installerDir, version, expectedSha256: expected });
  const names = assetNames(version);
  checkFacts({ tag, source, version, repository, name: names.installer, sha256: expected });
  const want = expectations({ tag, source, version, repository, name: names.installer, sha256: expected });
  const found = readdirSync(bundlesDir).sort();
  if (JSON.stringify(found) !== JSON.stringify([names.binding, names.provenance].sort())) throw new Error(`the bundles folder holds ${JSON.stringify(found)}, expected the two bundles`);
  const provenanceText = readFileSync(join(bundlesDir, names.provenance), "utf8");
  const bindingText = readFileSync(join(bundlesDir, names.binding), "utf8");
  checkBundle(provenanceText, want.provenance);
  checkBundle(bindingText, want.binding);
  const files = [
    [names.installer, installer.bytes],
    [names.sha256, Buffer.from(`${expected}  ${names.installer}\n`)],
    [names.provenance, Buffer.from(provenanceText)],
    [names.binding, Buffer.from(bindingText)],
  ];

  await requireTag(api, tag, source);
  const mine = (await api.list("releases")).filter((r) => r.tag_name === tag);
  const published = mine.find((r) => r.draft !== true);
  if (published) throw new Error(`a release for ${tag} is already published (id ${published.id}); nothing was changed`);
  for (const earlier of mine) {
    // The state is read again right before each deletion: a release published since the list was read is left alone.
    if ((await deleteIfDraft(api, earlier.id)) === "public") throw new Error(`release ${earlier.id} for ${tag} is public (published since it was listed) and was left alone; nothing more was changed`);
  }

  const created = await api.post("releases", {
    tag_name: tag,
    target_commitish: source,
    name: `Petalock ${version}`,
    // The run and attempt that made the draft, so a draft left behind can be traced to its run.
    body: `SHA-256 of ${names.installer}: ${expected}\nSource commit: ${source}\nWorkflow run: ${run.id}, attempt ${run.attempt}\n`,
    draft: true,
    prerelease: true,
  });
  const id = created?.id;
  if (!Number.isSafeInteger(id) || created.draft !== true) throw new Error("GitHub did not answer with a draft release");
  try {
    // Inside the protected block: a failed write must not leave the draft without its clean-up.
    writeFileSync(idFile, `${id}\n`);
    await requireTag(api, tag, source);
    for (const [name, bytes] of files) await api.upload(id, name, bytes);
    const assets = await api.list(`releases/${id}/assets`);
    const listed = assets.map((a) => a.name).sort();
    const wanted = files.map(([name]) => name).sort();
    if (JSON.stringify(listed) !== JSON.stringify(wanted)) throw new Error(`the draft's assets are ${JSON.stringify(listed)}, expected ${JSON.stringify(wanted)}`);
    for (const [name, bytes] of files) {
      const asset = assets.find((a) => a.name === name);
      const back = await api.download(asset.id);
      if (sha256(back) !== sha256(bytes)) throw new Error(`${name} downloaded again differs from the file that was uploaded`);
      if (asset.digest !== undefined && asset.digest !== `sha256:${sha256(bytes)}`) throw new Error(`GitHub's digest for ${name} differs from the file that was uploaded`);
    }
    const final = await api.get(`releases/${id}`);
    if (final.draft !== true) throw new Error("the release is public, no longer a draft");
    if (final.tag_name !== tag) throw new Error(`the draft now belongs to tag ${String(final.tag_name).slice(0, 60)}, not ${tag}`);
    await requireTag(api, tag, source);
  } catch (error) {
    let state;
    try {
      state = await deleteIfDraft(api, id);
    } catch (cleanup) {
      throw new Error(`${error.message}; the draft ${id} was not deleted (${cleanup.message}); delete it by hand`);
    }
    // A release seen public is terminal: it is never deleted, whatever else went wrong.
    if (state === "public") throw new Error(`${error.message}; release ${id} is public (published meanwhile) and was left alone, not deleted`);
    throw error;
  }
  const summary = [`Draft release id: ${id}`, `Tag: ${tag}`, `Source commit: ${source}`, `Installer: ${names.installer}`, `SHA-256: ${expected}`].join("\n");
  return { id, tag, source, name: names.installer, sha256: expected, assets: files.map(([name]) => name), summary };
}

/** Deletes the draft recorded in `idFile`, only while it is still a draft. Nothing recorded, or already gone: nothing to do. */
export async function discardDraft({ api, idFile }) {
  let text;
  try {
    text = readFileSync(idFile, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return { deleted: null };
    throw e;
  }
  const id = text.trim();
  if (!/^[0-9]{1,15}$/.test(id)) throw new Error("the draft's id file holds no id");
  let release;
  try {
    release = await api.get(`releases/${id}`);
  } catch (e) {
    if (e.status === 404) return { deleted: null };
    throw e;
  }
  if (release.draft !== true) throw new Error(`release ${id} is published, not a draft, and is not deleted`);
  await api.del(`releases/${id}`);
  return { deleted: Number(id) };
}

// ---------------------------------------------------------------------------------------------------------------------
// gh attestation verify.

// nosemgrep: javascript.lang.security.detect-child-process.detect-child-process -- the command is `gh` and the arguments are built here from checked values
const defaultGh = (args) => spawnSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

function checkVerified(result, { type, name, digest, predicate, repository, signer }) {
  const cert = result?.signature?.certificate;
  const statement = result?.statement;
  if (!isObject(cert) || !isObject(statement)) throw new Error("the verification result holds no certificate or statement");
  if (statement.predicateType !== type) throw new Error(`the verified predicate type is ${show(statement.predicateType)}, expected ${type}`);
  const subject = statement.subject;
  if (!Array.isArray(subject) || subject.length !== 1 || subject[0]?.name !== name || subject[0]?.digest?.sha256 !== digest) {
    throw new Error(`the verified statement's subject is not ${name} with digest ${digest}`);
  }
  if (cert.sourceRepositoryRef !== MAIN) throw new Error(`the certificate's ref is ${show(cert.sourceRepositoryRef)}, expected ${MAIN}`);
  if (cert.buildSignerURI !== `https://${signer}`) throw new Error(`the signer workflow is ${show(cert.buildSignerURI)}, expected https://${signer}`);
  if (cert.githubWorkflowTrigger !== "workflow_dispatch") throw new Error(`the workflow was triggered by ${show(cert.githubWorkflowTrigger)}, expected workflow_dispatch`);
  if (cert.runnerEnvironment !== "github-hosted") throw new Error(`the runner was ${show(cert.runnerEnvironment)}, expected github-hosted`);
  if (cert.sourceRepositoryURI !== `https://github.com/${repository}`) throw new Error(`the certificate's repository is ${show(cert.sourceRepositoryURI)}`);
  if (cert.issuer !== OIDC_ISSUER) throw new Error(`the certificate's issuer is ${show(cert.issuer)}`);
  if (predicate !== null) {
    const d = firstDifference(statement.predicate, predicate);
    if (d) throw new Error(d);
  }
}

/**
 * `gh attestation verify` on the installer for both statements, against the draft's own bundles: the repository, the
 * signer workflow (release.yml on main), main's ref, a dispatch on a GitHub-hosted runner, each predicate type; then the
 * verified statements are read: the subject is this installer, and the bound statement names this tag, source commit and
 * version. The certificate's commit is main's head at the dispatch, not the tag's commit, so it is not pinned to it.
 */
export function verifyAttestations({ installer, bundles, repository, tag, source, version, runGh = defaultGh }) {
  checkRepository(repository);
  const name = basename(installer);
  checkFacts({ tag, source, version, repository, name, sha256: "0".repeat(64) });
  const digest = sha256(readFileSync(installer));
  const signer = `github.com/${repository}/.github/workflows/release.yml@${MAIN}`;
  const predicate = bindingPredicate({ tag, source, version, repository, name, sha256: digest });
  const checked = [];
  for (const [type, bundle, expected] of [
    [PROVENANCE_TYPE, bundles.provenance, null],
    [BINDING_PREDICATE_TYPE, bundles.binding, predicate],
  ]) {
    const args = ["attestation", "verify", installer, "--bundle", bundle, "--repo", repository, "--signer-workflow", signer, "--source-ref", MAIN, "--cert-oidc-issuer", OIDC_ISSUER, "--predicate-type", type, "--deny-self-hosted-runners", "--format", "json"];
    const answer = runGh(args);
    if (answer.status !== 0) throw new Error(`gh attestation verify failed for ${type} (exit ${answer.status}): ${String(answer.stderr ?? "").trim().slice(0, 300)}`);
    let results;
    try {
      results = JSON.parse(answer.stdout);
    } catch {
      throw new Error(`gh attestation verify printed no JSON for ${type}`);
    }
    if (!Array.isArray(results) || results.length === 0) throw new Error(`gh attestation verify found no attestation for ${type}`);
    for (const entry of results) checkVerified(entry?.verificationResult, { type, name, digest, predicate: expected, repository, signer });
    checked.push(type);
  }
  return { checked, name, sha256: digest };
}

// ---------------------------------------------------------------------------------------------------------------------
// The command line.

/** Appends `name=value` lines to the workflow's output file: a name of safe characters, a value on one line. */
export function writeOutputs(file, values) {
  const lines = Object.entries(values).map(([name, value]) => {
    if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error(`${show(name)} is not an output name`);
    if (typeof value !== "string") throw new Error(`the value of ${name} is not text`);
    if (/[\r\n]/.test(value)) throw new Error(`the value of ${name} is not on one line`);
    return `${name}=${value}\n`;
  });
  appendFileSync(file, lines.join(""));
}

const need = (env, name) => {
  const value = env[name];
  if (typeof value !== "string" || value === "") throw new Error(`${name} is not set`);
  return value;
};

function apiFromEnv(env) {
  return makeApi({ token: need(env, "GITHUB_TOKEN"), repository: need(env, "GITHUB_REPOSITORY") });
}

const factsFromEnv = (env) => ({ tag: need(env, "TAG"), source: need(env, "SOURCE"), version: need(env, "VERSION"), repository: need(env, "GITHUB_REPOSITORY"), name: need(env, "NAME"), sha256: need(env, "SHA256") });

const say = (line) => process.stdout.write(`${line}\n`);

const commands = {
  async authorize(env) {
    parseTag(env.TAG);
    const result = await authorize({ env, git: makeGit(process.cwd()), api: apiFromEnv(env) });
    say(`tag ${result.tag} is on main at ${result.source}, version ${result.version}; ${result.ciJobs.length} CI jobs succeeded`);
    if (env.GITHUB_OUTPUT) writeOutputs(env.GITHUB_OUTPUT, { tag: result.tag, source: result.source, version: result.version });
  },
  async "check-installer"(env) {
    const result = checkInstaller({ dir: need(env, "INSTALLER_DIR"), version: need(env, "VERSION"), expectedSha256: need(env, "EXPECTED_SHA256") });
    say(`${result.name} has the digest the build output: ${result.sha256}`);
    if (env.GITHUB_OUTPUT) writeOutputs(env.GITHUB_OUTPUT, { name: result.name, sha256: result.sha256, digest: result.digest });
  },
  async "check-embedded-version"(env) {
    checkInstallerVersion({ version: need(env, "VERSION"), fileName: need(env, "INSTALLER_NAME"), productVersion: env.PRODUCT_VERSION, fileVersion: env.FILE_VERSION });
    say(`the installer's name and its embedded versions say ${env.VERSION}`);
  },
  async "write-binding"(env) {
    const facts = factsFromEnv(env);
    checkFacts(facts);
    writeFileSync(need(env, "OUT"), `${JSON.stringify(bindingPredicate(facts))}\n`);
    say(`wrote the statement binding ${facts.tag}, ${facts.source} and ${facts.sha256}`);
  },
  async "collect-bundles"(env) {
    const done = collectBundles({ provenance: need(env, "PROVENANCE_BUNDLE"), binding: need(env, "BINDING_BUNDLE"), outDir: need(env, "OUT_DIR"), ...factsFromEnv(env) });
    say(`both bundles name this installer, tag and commit: ${done.join(", ")}`);
  },
  async draft(env) {
    const api = apiFromEnv(env);
    const result = await draftRelease({
      api,
      tag: need(env, "TAG"),
      source: need(env, "SOURCE"),
      version: need(env, "VERSION"),
      repository: need(env, "GITHUB_REPOSITORY"),
      run: { id: need(env, "GITHUB_RUN_ID"), attempt: need(env, "GITHUB_RUN_ATTEMPT") },
      sha256: need(env, "EXPECTED_SHA256"),
      installerDir: need(env, "INSTALLER_DIR"),
      bundlesDir: need(env, "BUNDLES_DIR"),
      idFile: need(env, "DRAFT_ID_FILE"),
    });
    say(result.summary);
    if (env.GITHUB_OUTPUT) writeOutputs(env.GITHUB_OUTPUT, { "draft-id": String(result.id), sha256: result.sha256 });
    if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `### Draft release\n\n${result.summary.split("\n").map((l) => `- ${l}`).join("\n")}\n`);
  },
  async "discard-draft"(env) {
    const result = await discardDraft({ api: apiFromEnv(env), idFile: need(env, "DRAFT_ID_FILE") });
    say(result.deleted === null ? "no draft to delete" : `deleted draft ${result.deleted}`);
  },
  async verify(env) {
    const result = verifyAttestations({
      installer: need(env, "INSTALLER"),
      bundles: { provenance: need(env, "PROVENANCE_BUNDLE"), binding: need(env, "BINDING_BUNDLE") },
      repository: need(env, "GITHUB_REPOSITORY"),
      tag: need(env, "TAG"),
      source: need(env, "SOURCE"),
      version: need(env, "VERSION"),
    });
    say(`verified ${result.name} (${result.sha256}) for: ${result.checked.join(", ")}`);
  },
};

/** Runs one command; returns the exit status. */
export async function main(argv, env = process.env) {
  const command = Object.hasOwn(commands, argv[0] ?? "") ? commands[argv[0]] : null;
  if (!command || argv.length !== 1) {
    process.stderr.write(`release-guard: unknown command ${show(argv[0] ?? "")}; use one of ${Object.keys(commands).join(", ")}\n`);
    return 2;
  }
  try {
    await command(env);
    return 0;
  } catch (error) {
    let message = String(error?.message ?? error);
    if (env.GITHUB_TOKEN) message = message.split(env.GITHUB_TOKEN).join("***");
    process.stderr.write(`release-guard: ${message}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
