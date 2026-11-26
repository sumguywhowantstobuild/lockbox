// Plan 5, Task 2: the release guard (scripts/release-guard.mjs). The release workflow runs it from `main` before anything
// is signed or drafted. These are its tests: real git repositories in a temporary folder for the tag and `main` checks, and
// a fake GitHub (a `fetch` that answers the REST calls the guard makes, with the field names the live API sent for this
// repository's own runs, jobs, tags and releases) for the CI results and the draft release. Every value is made up.

import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  BINDING_PREDICATE_TYPE,
  CI_JOBS,
  assetNames,
  authorize,
  bindingPredicate,
  cargoVersion,
  checkBundle,
  checkCi,
  checkInstaller,
  checkInstallerVersion,
  checkVersion,
  collectBundles,
  discardDraft,
  draftRelease,
  makeApi,
  makeGit,
  parseTag,
  verifyAttestations,
  writeOutputs,
} from "./release-guard.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const GUARD = join(ROOT, "scripts", "release-guard.mjs");
const REPO = "MU-owner/MU-repo";
const TOKEN = `MU-token-${randomBytes(6).toString("hex")}`;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** A folder that is removed when the test ends. */
const cleanups = [];
function tempDir(prefix = "release-guard-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(dir);
  return dir;
}
process.on("exit", () => cleanups.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

// ---------------------------------------------------------------------------------------------------------------------
// Real git: a small history shaped like the real one.

function git(cwd, ...args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

const manifest = (version) => `[workspace]\nmembers = ["crates/*"]\n\n[workspace.package]\nversion = "${version}"\nedition = "2024"\n`;

/**
 * Commits A (0.1.0), B (0.1.1) and C (0.1.2) on `main`, `origin/main` at C, and a side commit S off A that is on no
 * branch of `main`: the shape a release has when the tag is behind `main`'s head.
 */
function history() {
  const dir = tempDir();
  git(dir, "init", "-q", "-b", "main");
  // No hooks of the person's own git setup run in this throwaway repository.
  for (const [k, v] of [["user.name", "MU tester"], ["user.email", "mu@example.invalid"], ["commit.gpgsign", "false"], ["tag.gpgsign", "false"], ["core.hooksPath", join(dir, ".no-hooks")]]) git(dir, "config", k, v);
  const commit = (version, message) => {
    writeFileSync(join(dir, "Cargo.toml"), manifest(version));
    git(dir, "add", "Cargo.toml");
    git(dir, "commit", "-q", "-m", message);
    return git(dir, "rev-parse", "HEAD");
  };
  const a = commit("0.1.0", "a");
  const b = commit("0.1.1", "b");
  const c = commit("0.1.2", "c");
  git(dir, "checkout", "-q", "-b", "side", a);
  const s = commit("0.1.1", "side");
  git(dir, "checkout", "-q", "main");
  git(dir, "update-ref", "refs/remotes/origin/main", c);
  return { dir, a, b, c, s };
}

const env = (h, over = {}) => ({
  TAG: "v0.1.1",
  GITHUB_REPOSITORY: REPO,
  GITHUB_REF: "refs/heads/main",
  GITHUB_SHA: h.c,
  GITHUB_WORKFLOW_REF: `${REPO}/.github/workflows/release.yml@refs/heads/main`,
  ...over,
});

// ---------------------------------------------------------------------------------------------------------------------
// A fake GitHub, answering the calls the guard makes.

const API = "https://api.github.com";
const UPLOADS = "https://uploads.github.com";
const BLOBS = "https://objects.example.invalid";

class FakeGitHub {
  constructor(options = {}) {
    // pageCap, ignoreFilters, failUploadAt, corruptStored, dropAsset, moveTagAfterUploads, deleteFails, publishAfterUploads,
    // retagAfterUploads, publishWhenListed, onJobsRead
    this.options = options;
    this.runs = [];
    this.jobs = new Map(); // "runId/attempt" -> jobs
    this.tags = new Map(); // name -> { type, sha }
    this.annotated = new Map(); // tag object sha -> commit sha
    this.releases = [];
    this.blobs = new Map();
    this.calls = [];
    this.blobAuth = [];
    this.nextId = 1000;
    this.uploads = 0;
  }

  json(status, body) {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }

  asset(release, a) {
    return { id: a.id, name: a.name, size: a.stored.length, state: "uploaded", digest: `sha256:${a.digest}` };
  }

  releaseJson(r) {
    return { id: r.id, tag_name: r.tag_name, name: r.name, body: r.body, draft: r.draft, prerelease: r.prerelease, target_commitish: r.target_commitish, assets: r.assets.map((a) => this.asset(r, a)) };
  }

  page(items, key, url) {
    const per = Math.min(Number(url.searchParams.get("per_page") ?? 30), this.options.pageCap ?? 100);
    const page = Number(url.searchParams.get("page") ?? 1);
    return this.json(200, { total_count: items.length, [key]: items.slice((page - 1) * per, page * per) });
  }

  fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    const headers = new Headers(init.headers ?? {});
    this.calls.push(`${method} ${url.host}${url.pathname}${url.search}`);
    if (url.origin === BLOBS) {
      this.blobAuth.push(headers.get("authorization"));
      const id = Number(url.pathname.split("/").pop());
      return new Response(this.blobs.get(id), { status: 200 });
    }
    assert.ok([API, UPLOADS].includes(url.origin), `unexpected host ${url.origin}`);
    if (headers.get("authorization") !== `Bearer ${TOKEN}`) return this.json(401, { message: "Bad credentials" });
    const base = `/repos/${REPO}/`;
    assert.ok(url.pathname.startsWith(base), `unexpected path ${url.pathname}`);
    const path = url.pathname.slice(base.length);
    let m;
    if (method === "GET" && path === "actions/workflows/ci.yml/runs") {
      let runs = this.runs;
      if (!this.options.ignoreFilters) {
        const q = (k) => url.searchParams.get(k);
        runs = runs.filter((r) => (!q("branch") || r.head_branch === q("branch")) && (!q("event") || r.event === q("event")) && (!q("head_sha") || r.head_sha === q("head_sha")));
      }
      return this.page(runs, "workflow_runs", url);
    }
    if (method === "GET" && (m = path.match(/^actions\/runs\/(\d+)\/attempts\/(\d+)\/jobs$/))) {
      const answer = this.page(this.jobs.get(`${m[1]}/${m[2]}`) ?? [], "jobs", url);
      this.options.onJobsRead?.(this); // something that happens at GitHub between this read and the next
      return answer;
    }
    if (method === "GET" && (m = path.match(/^git\/ref\/tags\/(.+)$/))) {
      const t = this.tags.get(decodeURIComponent(m[1]));
      return t ? this.json(200, { ref: `refs/tags/${m[1]}`, object: { type: t.type, sha: t.sha } }) : this.json(404, { message: "Not Found" });
    }
    if (method === "GET" && (m = path.match(/^git\/tags\/([0-9a-f]{40})$/))) {
      const commit = this.annotated.get(m[1]);
      return commit ? this.json(200, { object: { type: "commit", sha: commit } }) : this.json(404, { message: "Not Found" });
    }
    if (method === "GET" && path === "releases") return this.releasesPage(url);
    if (method === "POST" && path === "releases") {
      const body = JSON.parse(init.body);
      const r = { id: this.nextId++, tag_name: body.tag_name, name: body.name, body: body.body, draft: body.draft, prerelease: body.prerelease, target_commitish: body.target_commitish, assets: [] };
      this.releases.push(r);
      return this.json(201, this.releaseJson(r));
    }
    if ((m = path.match(/^releases\/(\d+)$/))) {
      const r = this.releases.find((x) => x.id === Number(m[1]));
      if (!r) return this.json(404, { message: "Not Found" });
      if (method === "GET") return this.json(200, this.releaseJson(r));
      if (method === "DELETE") {
        if (this.options.deleteFails) return this.json(500, { message: "boom" });
        this.releases = this.releases.filter((x) => x !== r);
        return new Response(null, { status: 204 });
      }
    }
    if (method === "GET" && (m = path.match(/^releases\/(\d+)\/assets$/))) {
      const r = this.releases.find((x) => x.id === Number(m[1]));
      return r ? this.arrayPage(r.assets.map((a) => this.asset(r, a)), url) : this.json(404, { message: "Not Found" });
    }
    if (method === "POST" && url.origin === UPLOADS && (m = path.match(/^releases\/(\d+)\/assets$/))) {
      this.uploads += 1;
      if (this.options.failUploadAt === this.uploads) return this.json(502, { message: "bad gateway" });
      const r = this.releases.find((x) => x.id === Number(m[1]));
      const name = url.searchParams.get("name");
      const bytes = Buffer.from(init.body);
      let stored = bytes;
      if (this.options.corruptStored === name) stored = Buffer.concat([bytes.subarray(0, -1), Buffer.from([bytes.at(-1) ^ 1])]);
      const a = { id: this.nextId++, name, digest: sha256(bytes), stored };
      this.blobs.set(a.id, stored);
      if (this.options.dropAsset !== name) r.assets.push(a);
      if (this.options.moveTagAfterUploads === this.uploads) this.tags.set(r.tag_name, { type: "commit", sha: "f".repeat(40) });
      if (this.options.publishAfterUploads === this.uploads) r.draft = false; // a maintainer publishes it mid-way
      if (this.options.retagAfterUploads === this.uploads) r.tag_name = "v9.9.9"; // the draft is edited to another tag; the Git ref is untouched
      return this.json(201, this.asset(r, a));
    }
    if (method === "GET" && (m = path.match(/^releases\/assets\/(\d+)$/))) {
      assert.match(headers.get("accept") ?? "", /application\/octet-stream/);
      return new Response(null, { status: 302, headers: { location: `${BLOBS}/blob/${m[1]}` } });
    }
    return this.json(404, { message: `no route for ${method} ${path}` });
  };

  /** A list answered as a bare array, a page at a time (the releases and a release's assets). */
  arrayPage(items, url) {
    const per = Math.min(Number(url.searchParams.get("per_page") ?? 30), this.options.pageCap ?? 100);
    const page = Number(url.searchParams.get("page") ?? 1);
    return this.json(200, items.slice((page - 1) * per, page * per));
  }

  releasesPage(url) {
    const answer = this.arrayPage(this.releases.map((r) => this.releaseJson(r)), url);
    // A maintainer publishes a release right after the list was read.
    const published = this.releases.find((r) => r.id === this.options.publishWhenListed);
    if (published) published.draft = false;
    return answer;
  }

  api() {
    return makeApi({ fetch: this.fetch, token: TOKEN, repository: REPO });
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Recorded-shape CI answers.

const SHA = "a1".repeat(20);

const run = (over = {}) => ({
  id: 9001,
  path: ".github/workflows/ci.yml",
  event: "push",
  head_branch: "main",
  head_sha: SHA,
  run_attempt: 1,
  status: "completed",
  conclusion: "success",
  created_at: "2026-11-26T04:02:19Z",
  repository: { full_name: REPO },
  head_repository: { full_name: REPO },
  ...over,
});

let jobId = 5000;
const job = (name, over = {}) => ({ id: jobId++, run_id: 9001, run_attempt: 1, head_sha: SHA, name, status: "completed", conclusion: "success", ...over });
const greenJobs = (over = {}) => CI_JOBS.map((name) => job(name, over[name] ?? {}));

function ciWorld(fake, { runs = [run()], jobs } = {}) {
  fake.runs = runs;
  for (const r of runs) fake.jobs.set(`${r.id}/${r.run_attempt}`, jobs?.[r.id] ?? greenJobs());
  return fake;
}

async function refusal(promise, pattern) {
  await assert.rejects(promise, (e) => {
    assert.match(e.message, pattern);
    assert.ok(!e.message.includes(TOKEN), "the token is never in a message");
    return true;
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// The tag, its version, and the checks of shape.

test("parse_tag_allows_only_plain_release_versions", () => {
  assert.equal(parseTag("v0.1.1"), "0.1.1");
  assert.equal(parseTag("v10.20.30"), "10.20.30");
  for (const bad of ["", "v", "0.1.1", "v0.1", "v0.1.1.1", "v01.1.1", "v0.1.1-rc.1", "v0.1.1+build", "V0.1.1", "v0.1.1\n", " v0.1.1", "v0.1.1 ", "refs/tags/v0.1.1", "v0.1.1/../x", "v1.2.3;rm", "v1.2.3\u0000", "v٠.1.1", "v0.1.1\r\nx=y", "v1234567890.1.1"]) {
    assert.throws(() => parseTag(bad), /tag/i, JSON.stringify(bad));
  }
  for (const bad of [undefined, null, 5, {}, ["v0.1.1"]]) assert.throws(() => parseTag(bad), /tag/i);
});

test("the_tag_check_allows_only_release_shapes_and_the_slowest_input_is_fast", () => {
  // Fuzz: a seeded generator makes many inputs that must pass and many that must not, and the slowest is timed.
  let seed = 12345;
  const rand = (n) => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed % n;
  };
  let passed = 0;
  let slowest = 0;
  const timed = (fn) => {
    const t = process.hrtime.bigint();
    const out = fn();
    slowest = Math.max(slowest, Number(process.hrtime.bigint() - t) / 1e6);
    return out;
  };
  for (let i = 0; i < 3000; i++) {
    const tag = `v${rand(1000)}.${rand(1000)}.${rand(1000)}`;
    assert.equal(timed(() => parseTag(tag)), tag.slice(1));
    passed += 1;
  }
  assert.equal(passed, 3000, "the passing inputs were counted");
  const alphabet = ["v", ".", "0", "1", "9", "-", "+", " ", "\n", "x", "/", "٠"];
  let refused = 0;
  for (let i = 0; i < 3000; i++) {
    const length = rand(40);
    let s = "";
    for (let j = 0; j < length; j++) s += alphabet[rand(alphabet.length)];
    const valid = /^v(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/.test(s);
    let accepted = true;
    try {
      timed(() => parseTag(s));
    } catch (e) {
      accepted = false;
      assert.match(e.message, /tag/i);
    }
    assert.equal(accepted, valid, `${JSON.stringify(s)}: accepted ${accepted}, valid ${valid}`);
    if (!accepted) refused += 1;
  }
  assert.ok(refused > 2000, `only ${refused} junk inputs were refused`);
  for (const long of ["v" + "1".repeat(200000), "v1." + "1".repeat(200000) + ".1", "v" + "1.".repeat(100000), "\n".repeat(200000), "v1.1.1" + "\n".repeat(100000)]) {
    assert.throws(() => timed(() => parseTag(long)), /tag/i);
  }
  // A check that could hang takes seconds on the long inputs above; the limit leaves room for a busy machine.
  assert.ok(slowest < 200, `the slowest check took ${slowest.toFixed(1)} ms`);
});

test("cargo_version_reads_the_workspace_package_version_only", () => {
  assert.equal(cargoVersion(manifest("0.1.1")), "0.1.1");
  assert.equal(cargoVersion(manifest("0.1.1").replaceAll("\n", "\r\n")), "0.1.1");
  assert.equal(cargoVersion('[package]\nversion = "9.9.9"\n[workspace.package]\nversion = "1.2.3"\n[dependencies]\nversion = "7.7.7"\n'), "1.2.3");
  assert.throws(() => cargoVersion('[package]\nversion = "9.9.9"\n'), /version/);
  assert.throws(() => cargoVersion('[workspace.package]\nversion = "1.2"\n'), /version/);
  assert.throws(() => cargoVersion('[workspace.package]\nversion.workspace = true\n'), /version/);
  assert.throws(() => cargoVersion(""), /version/);
});

test("release_refuses_a_version_mismatch", async () => {
  // The tag and Cargo.toml.
  assert.doesNotThrow(() => checkVersion({ tagVersion: "0.1.1", cargoVersion: "0.1.1" }));
  assert.throws(() => checkVersion({ tagVersion: "0.1.1", cargoVersion: "0.1.2" }), /0\.1\.1.*0\.1\.2/);
  // The built installer: its file name and the two version strings inside it.
  const ok = { version: "0.1.1", fileName: "Petalock_0.1.1_x64-setup.exe", productVersion: "0.1.1", fileVersion: "0.1.1" };
  assert.doesNotThrow(() => checkInstallerVersion(ok));
  for (const wrong of [{ fileName: "Petalock_0.1.2_x64-setup.exe" }, { productVersion: "0.1.2" }, { fileVersion: "0.1.0" }, { productVersion: "" }, { fileVersion: undefined }, { productVersion: "0.1.1.0" }]) {
    assert.throws(() => checkInstallerVersion({ ...ok, ...wrong }), /version|name/i, JSON.stringify(wrong));
  }
  // The whole guard, on a history where the tag v0.1.1 names the commit that says 0.1.1: and one where it names 0.1.0.
  const h = history();
  git(h.dir, "tag", "v0.1.1", h.b);
  git(h.dir, "tag", "v0.1.0", h.b); // names the 0.1.1 commit, claims 0.1.0
  const fake = ciWorld(new FakeGitHub(), { runs: [run({ head_sha: h.b })], jobs: { 9001: greenJobs().map((j) => ({ ...j, head_sha: h.b })) } });
  const out = await authorize({ env: env(h), git: makeGit(h.dir), api: fake.api() });
  assert.equal(out.version, "0.1.1");
  await refusal(authorize({ env: env(h, { TAG: "v0.1.0" }), git: makeGit(h.dir), api: fake.api() }), /0\.1\.0.*0\.1\.1|version/);
});

// ---------------------------------------------------------------------------------------------------------------------
// The tag is on main.

test("release_refuses_a_tag_not_on_main", async () => {
  const h = history();
  const fakeFor = (sha) => ciWorld(new FakeGitHub(), { runs: [run({ head_sha: sha })], jobs: { 9001: greenJobs().map((j) => ({ ...j, head_sha: sha })) } });
  const go = (sha, over) => authorize({ env: env(h, over), git: makeGit(h.dir), api: fakeFor(sha).api() });

  // A lightweight tag, an annotated tag (peeled to its commit), and a tag behind main's head all pass.
  git(h.dir, "tag", "v0.1.1", h.b);
  const ok = await go(h.b);
  assert.deepEqual({ tag: ok.tag, source: ok.source, version: ok.version }, { tag: "v0.1.1", source: h.b, version: "0.1.1" });
  assert.notEqual(ok.source, h.c, "the tag is behind main's head");
  git(h.dir, "tag", "-a", "v0.1.2", "-m", "annotated", h.c);
  const tagObject = git(h.dir, "rev-parse", "refs/tags/v0.1.2");
  assert.notEqual(tagObject, h.c, "the annotated tag is its own object");
  assert.equal((await go(h.c, { TAG: "v0.1.2" })).source, h.c, "the peeled commit, not the tag object");

  // A tag on a commit that is on no path of main.
  git(h.dir, "tag", "v0.2.0", h.s);
  await refusal(go(h.s, { TAG: "v0.2.0" }), /not on main|reachable/);
  // A tag that does not exist.
  await refusal(go(h.b, { TAG: "v0.3.0" }), /v0\.3\.0.*(not found|does not exist|no such)/i);
  // An annotated tag whose commit is off main.
  git(h.dir, "tag", "-a", "v0.2.1", "-m", "annotated", h.s);
  await refusal(go(h.s, { TAG: "v0.2.1" }), /not on main|reachable/);
  // A branch with the tag's name does not stand in for the tag.
  git(h.dir, "branch", "v0.4.0", h.s);
  await refusal(go(h.s, { TAG: "v0.4.0" }), /v0\.4\.0.*(not found|does not exist|no such)/i);
});

test("release_refuses_a_dispatch_that_is_not_mains_own_workflow", async () => {
  const h = history();
  git(h.dir, "tag", "v0.1.1", h.b);
  const fake = ciWorld(new FakeGitHub(), { runs: [run({ head_sha: h.b })], jobs: { 9001: greenJobs().map((j) => ({ ...j, head_sha: h.b })) } });
  const go = (over) => authorize({ env: env(h, over), git: makeGit(h.dir), api: fake.api() });
  await go({});
  await refusal(go({ GITHUB_REF: "refs/heads/plan-5-release" }), /main/);
  await refusal(go({ GITHUB_REF: "refs/tags/v0.1.1" }), /main/);
  await refusal(go({ GITHUB_WORKFLOW_REF: `${REPO}/.github/workflows/release.yml@refs/heads/plan-5-release` }), /workflow/i);
  await refusal(go({ GITHUB_WORKFLOW_REF: `${REPO}/.github/workflows/other.yml@refs/heads/main` }), /workflow/i);
  await refusal(go({ GITHUB_WORKFLOW_REF: undefined }), /workflow/i);
  // The commit the workflow runs from must be on main, and be what is checked out.
  await refusal(go({ GITHUB_SHA: h.s }), /checked out|main/);
  await refusal(go({ GITHUB_SHA: h.b }), /checked out/);
  await refusal(go({ GITHUB_SHA: "not-a-hash" }), /commit/);
  // The repository name is an allow-listed shape.
  await refusal(go({ GITHUB_REPOSITORY: "a/b/../c" }), /repository/);
  await refusal(go({ GITHUB_REPOSITORY: "owner" }), /repository/);
  // A bad tag is refused before any git or API call.
  const quiet = new FakeGitHub();
  await refusal(authorize({ env: env(h, { TAG: "v0.1.1 --upload-pack=x" }), git: makeGit(h.dir), api: quiet.api() }), /tag/i);
  assert.deepEqual(quiet.calls, []);
});

test("release_refuses_a_shallow_checkout_and_a_missing_origin_main", async () => {
  const h = history();
  git(h.dir, "tag", "v0.1.1", h.b);
  const fake = ciWorld(new FakeGitHub(), { runs: [run({ head_sha: h.b })], jobs: { 9001: greenJobs().map((j) => ({ ...j, head_sha: h.b })) } });
  // A shallow clone of the same history: ancestry cannot be trusted there.
  const parent = tempDir();
  const clone = join(parent, "shallow");
  const r = spawnSync("git", ["clone", "-q", "--depth", "1", `file:///${h.dir.replaceAll("\\", "/")}`, clone], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  await refusal(authorize({ env: env(h), git: makeGit(clone), api: fake.api() }), /shallow|full history/i);
  // No origin/main at all.
  git(h.dir, "update-ref", "-d", "refs/remotes/origin/main");
  await refusal(authorize({ env: env(h), git: makeGit(h.dir), api: fake.api() }), /origin\/main/);
});

// ---------------------------------------------------------------------------------------------------------------------
// Every CI job.

/** The CI world for the commit the guard will look up (history()'s B), built after the history exists. */
function worldFor(h, build) {
  const fake = new FakeGitHub();
  const sha = h.b;
  const r = (over) => run({ head_sha: sha, ...over });
  const j = (name, over) => job(name, { head_sha: sha, ...over });
  build(fake, { r, j, greens: (over = {}) => CI_JOBS.map((n) => j(n, over[n] ?? {})) });
  return fake;
}

test("release_refuses_unless_every_ci_job_passed", async () => {
  const h = history();
  git(h.dir, "tag", "v0.1.1", h.b);
  const attempt = async (build, pattern, options) => {
    const fake = worldFor(h, (f, w) => {
      Object.assign(f.options, options ?? {});
      build(f, w);
    });
    // The CI check by itself (the whole guard, git included, is run once below: each git call costs tens of milliseconds).
    const promise = checkCi(fake.api(), { repository: REPO, sha: h.b });
    if (pattern) await refusal(promise, pattern);
    else return { out: { ciJobs: await promise }, fake };
  };
  const world = (f, runs, jobsByRun) => {
    f.runs = runs;
    for (const r of runs) f.jobs.set(`${r.id}/${r.run_attempt}`, jobsByRun[r.id]);
  };

  // All green, through the whole guard: passes, and says which jobs it saw.
  const fake = worldFor(h, (f, w) => world(f, [w.r()], { 9001: w.greens() }));
  const out = await authorize({ env: env(h), git: makeGit(h.dir), api: fake.api() });
  assert.equal(out.ciJobs.length, 6, "all six expected jobs were found");
  assert.deepEqual([...out.ciJobs].sort(), [...CI_JOBS].sort());
  assert.ok(fake.calls.some((c) => c.includes("actions/workflows/ci.yml/runs?") && c.includes("branch=main") && c.includes("event=push") && c.includes(`head_sha=${h.b}`)), "the run is looked up by workflow, ref, event and commit");
  assert.ok(fake.calls.some((c) => c.includes("/actions/runs/9001/attempts/1/jobs")), "the jobs are those of the run's attempt");

  // A missing job: each expected one in turn (both Rust legs included).
  for (const missing of CI_JOBS) {
    await attempt((f, w) => world(f, [w.r()], { 9001: w.greens().filter((x) => x.name !== missing) }), /missing|not found|no job/i);
  }
  // A job that is skipped, cancelled, failed, neutral, timed out, in progress or queued, for each expected job in turn.
  for (const name of CI_JOBS) {
    for (const state of [{ conclusion: "skipped" }, { conclusion: "cancelled" }, { conclusion: "failure" }, { conclusion: "neutral" }, { conclusion: "timed_out" }, { conclusion: "action_required" }, { status: "in_progress", conclusion: null }, { status: "queued", conclusion: null }]) {
      await attempt((f, w) => world(f, [w.r()], { 9001: w.greens({ [name]: state }) }), /success|passed|in progress|not finished/i);
    }
  }
  // A failing job that is not on the expected list still refuses; a green extra one does not.
  await attempt((f, w) => world(f, [w.r()], { 9001: [...w.greens(), w.j("Something new", { conclusion: "failure" })] }), /Something new/);
  await attempt((f, w) => world(f, [w.r()], { 9001: [...w.greens(), w.j("Something new")] }));
  // No jobs at all: an empty list is never a pass.
  await attempt((f, w) => world(f, [w.r()], { 9001: [] }), /no job|missing/i);
  // A job name twice.
  await attempt((f, w) => world(f, [w.r()], { 9001: [...w.greens(), w.j(CI_JOBS[0])] }), /twice|more than once|duplicate/i);
  // The run itself did not conclude as success, whatever its jobs say.
  await attempt((f, w) => world(f, [w.r({ conclusion: "failure" })], { 9001: w.greens() }), /run|success/i);
  await attempt((f, w) => world(f, [w.r({ status: "in_progress", conclusion: null })], { 9001: w.greens() }), /in progress|still running|not finished/i);
  // A newer run for the commit is in progress, and a newer one that failed.
  await attempt((f, w) => world(f, [w.r(), w.r({ id: 9002, status: "in_progress", conclusion: null, created_at: "2026-11-26T05:00:00Z" })], { 9001: w.greens(), 9002: [] }), /in progress|still running|not finished/i);
  await attempt((f, w) => world(f, [w.r(), w.r({ id: 9002, conclusion: "failure", created_at: "2026-11-26T05:00:00Z" })], { 9001: w.greens(), 9002: w.greens() }), /success|failed|run/i);
  // An older run failed and the newer one passed: the newer one decides.
  const newer = await attempt((f, w) => world(f, [w.r({ conclusion: "failure" }), w.r({ id: 9002, created_at: "2026-11-26T05:00:00Z" })], { 9001: w.greens(), 9002: w.greens().map((x) => ({ ...x, run_id: 9002 })) }));
  assert.equal(newer.out.ciJobs.length, 6);
  // A green run for the same commit under another ref, or from another event, does not count; the API's filter may be ignored.
  for (const options of [undefined, { ignoreFilters: true }]) {
    await attempt((f, w) => world(f, [w.r({ head_branch: "plan-5-release" })], { 9001: w.greens() }), /no .*run|main/i, options);
    await attempt((f, w) => world(f, [w.r({ event: "pull_request" })], { 9001: w.greens() }), /no .*run|main/i, options);
    await attempt((f, w) => world(f, [w.r({ head_sha: "b2".repeat(20) })], { 9001: w.greens() }), /no .*run|main/i, options);
    await attempt((f, w) => world(f, [w.r({ head_repository: { full_name: "MU-fork/MU-repo" } })], { 9001: w.greens() }), /no .*run|main/i, options);
  }
  await attempt((f) => world(f, [], {}), /no .*run|main/i);
  // Stale: the jobs are from an older attempt than the run's latest, or from another run.
  await attempt((f, w) => world(f, [w.r({ run_attempt: 2 })], { 9001: w.greens() }), /attempt|stale/i);
  await attempt((f, w) => world(f, [w.r()], { 9001: w.greens().map((x) => ({ ...x, run_id: 1234 })) }), /run|stale/i);
  await attempt((f, w) => world(f, [w.r()], { 9001: w.greens().map((x) => ({ ...x, head_sha: "c3".repeat(20) })) }), /commit|stale/i);
  // A re-run of failed jobs lists every job again under the new attempt (as GitHub does): that passes.
  const rerun = await attempt((f, w) => {
    f.runs = [w.r({ run_attempt: 2 })];
    f.jobs.set("9001/2", w.greens().map((x) => ({ ...x, run_attempt: 2 })));
  });
  assert.equal(rerun.out.ciJobs.length, 6);
  // A newer attempt or run starts after the job list was read (the old attempt's jobs still all say success): the results
  // that were read are superseded, so the guard refuses. Also while the job pages are being read.
  const advance = (change) => ({ onJobsRead: (f) => change(f) });
  const green = (f, w) => world(f, [w.r()], { 9001: w.greens() });
  const hooks = {
    "a re-run of the run starts": [/in progress|changed|attempt/i, (f) => { f.runs = [{ ...f.runs[0], run_attempt: 2, status: "in_progress", conclusion: null }]; }],
    "a re-run has already finished green": [/changed|attempt|superseded/i, (f) => { f.runs = [{ ...f.runs[0], run_attempt: 2 }]; }],
    "a newer run for the commit starts": [/in progress|still/i, (f) => { if (f.runs.length === 1) f.runs = [...f.runs, run({ id: 9002, head_sha: h.b, status: "in_progress", conclusion: null })]; }],
    "a newer run for the commit has finished green": [/changed|newer/i, (f) => { if (f.runs.length === 1) f.runs = [...f.runs, run({ id: 9002, head_sha: h.b })]; }],
    "the run is cancelled": [/success|cancelled|changed/i, (f) => { f.runs = [{ ...f.runs[0], conclusion: "cancelled" }]; }],
  };
  for (const [what, [pattern, change]] of Object.entries(hooks)) {
    await attempt(green, pattern, advance(change));
    await attempt(green, pattern, { ...advance(change), pageCap: 2 });
    assert.ok(what);
  }
  // Nothing changing between the reads is still a pass, and the runs were read again after the jobs.
  const calm = await attempt(green, undefined, advance(() => {}));
  assert.equal(calm.out.ciJobs.length, 6);
  const reads = calm.fake.calls.filter((c) => c.includes("actions/workflows/ci.yml/runs?")).length;
  assert.equal(reads, 2, "the runs are read before the jobs and once more after them");
  // More jobs than a page holds: every page is read, and a short answer is refused.
  const many = await attempt((f, w) => world(f, [w.r()], { 9001: w.greens() }), undefined, { pageCap: 2 });
  assert.equal(many.out.ciJobs.length, 6);
  // Also when the job list is cut short against its own total.
  const real = worldFor(h, (f, w) => world(f, [w.r()], { 9001: w.greens() }));
  await refusal(
    authorize({
      env: env(h),
      git: makeGit(h.dir),
      api: makeApi({
        repository: REPO,
        token: TOKEN,
        fetch: async (url, init) => {
          const answer = await real.fetch(url, init);
          if (!String(url).includes("/jobs")) return answer;
          const body = await answer.json();
          return new Response(JSON.stringify({ ...body, total_count: body.total_count + 3 }), { status: 200 });
        },
      }),
    }),
    /incomplete|total|every job/i,
  );
});

test("the_ci_job_list_matches_ci_yml", () => {
  // Every job ci.yml defines (a matrix leg each, and a called workflow's jobs under the calling job's name) is on the list.
  const read = (path) => readFileSync(join(ROOT, path), "utf8").replace(/\r\n/g, "\n");
  const unquote = (s) => s.trim().replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
  const ci = read(".github/workflows/ci.yml");
  const jobsAt = ci.indexOf("\njobs:\n");
  assert.ok(jobsAt > 0);
  const blocks = ci.slice(jobsAt + 7).split(/^ {2}(?=[a-z][a-z0-9-]*:\n)/m).filter(Boolean);
  const expected = [];
  for (const block of blocks) {
    const key = block.match(/^([a-z][a-z0-9-]*):/)[1];
    const name = unquote(block.match(/^ {4}name: (.*)$/m)?.[1] ?? key);
    const called = block.match(/^ {4}uses: \.\/(\.github\/workflows\/[\w.-]+)$/m)?.[1];
    if (called) {
      const inner = read(called);
      const innerJobs = [...inner.matchAll(/^ {4}name: (.*)$/gm)].map((m) => unquote(m[1]));
      assert.ok(innerJobs.length >= 1, `${called} has a named job`);
      for (const n of innerJobs) expected.push(`${name} / ${n}`);
    } else if (name.includes("${{ matrix.label }}")) {
      const labels = [...block.matchAll(/^ {10}- label: (\w+)$/gm)].map((m) => m[1]);
      assert.deepEqual(labels, ["windows", "linux"], "the matrix legs");
      for (const label of labels) expected.push(name.replace("${{ matrix.label }}", label));
    } else expected.push(name);
  }
  assert.ok(expected.length >= 6, `found ${expected.length} jobs in ci.yml`);
  assert.deepEqual([...CI_JOBS].sort(), expected.sort());
});

// ---------------------------------------------------------------------------------------------------------------------
// The installer: the tested bytes are the shipped bytes.

function installerDir(version = "0.1.1", content = "MU-installer-bytes") {
  const dir = tempDir("release-installer-");
  const name = `Petalock_${version}_x64-setup.exe`;
  writeFileSync(join(dir, name), content);
  return { dir, name, sha256: sha256(content) };
}

test("the_shipped_bytes_are_the_tested_bytes", () => {
  const i = installerDir();
  const ok = checkInstaller({ dir: i.dir, version: "0.1.1", expectedSha256: i.sha256 });
  assert.deepEqual({ name: ok.name, sha256: ok.sha256, digest: ok.digest }, { name: i.name, sha256: i.sha256, digest: `sha256:${i.sha256}` });
  // A different digest: a swapped file, an uppercase or short or malformed expectation.
  for (const expected of [sha256("other"), i.sha256.toUpperCase(), i.sha256.slice(1), "", undefined, `sha256:${i.sha256}`, `${i.sha256}\n`]) {
    assert.throws(() => checkInstaller({ dir: i.dir, version: "0.1.1", expectedSha256: expected }), /digest|sha-?256|expected/i, String(expected));
  }
  // One byte changed after the build.
  writeFileSync(join(i.dir, i.name), "MU-installer-bytes!");
  assert.throws(() => checkInstaller({ dir: i.dir, version: "0.1.1", expectedSha256: i.sha256 }), /differs|digest/i);
  // No file, two files, another name, a folder, a link-less odd name.
  const empty = tempDir();
  assert.throws(() => checkInstaller({ dir: empty, version: "0.1.1", expectedSha256: i.sha256 }), /exactly one|found 0|no installer/i);
  const two = installerDir();
  writeFileSync(join(two.dir, "extra.txt"), "x");
  assert.throws(() => checkInstaller({ dir: two.dir, version: "0.1.1", expectedSha256: two.sha256 }), /exactly one|found 2/i);
  const other = installerDir("0.1.2");
  assert.throws(() => checkInstaller({ dir: other.dir, version: "0.1.1", expectedSha256: other.sha256 }), /Petalock_0\.1\.1_x64-setup\.exe/);
  const folder = tempDir();
  mkdirSync(join(folder, "Petalock_0.1.1_x64-setup.exe"));
  assert.throws(() => checkInstaller({ dir: folder, version: "0.1.1", expectedSha256: i.sha256 }), /file/i);
  assert.throws(() => checkInstaller({ dir: join(empty, "missing"), version: "0.1.1", expectedSha256: i.sha256 }), /folder|found|no installer|exactly one/i);
});

// ---------------------------------------------------------------------------------------------------------------------
// The two statements: what is signed, and what verification must find.

const NAMES = assetNames("0.1.1");
const FACTS = { tag: "v0.1.1", source: "d4".repeat(20), version: "0.1.1", repository: REPO, name: "Petalock_0.1.1_x64-setup.exe", sha256: sha256("MU-installer-bytes") };

/** A Sigstore bundle holding one in-toto statement, in the shape `gh attestation verify --format json` printed for a live one. */
function bundle(statement, over = {}) {
  const payload = Buffer.from(JSON.stringify(statement)).toString("base64");
  return JSON.stringify({
    mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
    verificationMaterial: { certificate: { rawBytes: "TVUtY2VydA==" }, tlogEntries: [{ logIndex: "1" }] },
    dsseEnvelope: { payload, payloadType: "application/vnd.in-toto+json", signatures: [{ sig: "TVUtc2ln" }] },
    ...over,
  });
}
const statement = (over = {}) => ({
  _type: "https://in-toto.io/Statement/v1",
  subject: [{ name: FACTS.name, digest: { sha256: FACTS.sha256 } }],
  predicateType: BINDING_PREDICATE_TYPE,
  predicate: bindingPredicate(FACTS),
  ...over,
});
const expectBinding = { name: FACTS.name, sha256: FACTS.sha256, predicateType: BINDING_PREDICATE_TYPE, predicate: bindingPredicate(FACTS) };
const expectProvenance = { name: FACTS.name, sha256: FACTS.sha256, predicateType: "https://slsa.dev/provenance/v1" };

test("the_bound_statement_names_tag_commit_and_digest: the predicate and bundle checks", () => {
  const p = bindingPredicate(FACTS);
  assert.deepEqual(p, { tag: "v0.1.1", sourceCommit: FACTS.source, version: "0.1.1", repository: REPO, installer: { name: FACTS.name, sha256: FACTS.sha256 } });
  assert.match(BINDING_PREDICATE_TYPE, /^https:\/\/[^\s]+\/release-binding\/v1$/);
  // A legitimate bundle passes; so does a provenance one by its own type.
  assert.doesNotThrow(() => checkBundle(bundle(statement()), expectBinding));
  const prov = statement({ predicateType: "https://slsa.dev/provenance/v1", predicate: { buildDefinition: { buildType: "MU" } } });
  assert.doesNotThrow(() => checkBundle(bundle(prov), expectProvenance));
  // Each field wrong on its own refuses.
  const wrongs = {
    tag: statement({ predicate: { ...p, tag: "v0.1.2" } }),
    source: statement({ predicate: { ...p, sourceCommit: "e5".repeat(20) } }),
    version: statement({ predicate: { ...p, version: "0.1.2" } }),
    repository: statement({ predicate: { ...p, repository: "MU-other/MU-repo" } }),
    installerDigest: statement({ predicate: { ...p, installer: { ...p.installer, sha256: sha256("other") } } }),
    installerName: statement({ predicate: { ...p, installer: { ...p.installer, name: "other.exe" } } }),
    extraField: statement({ predicate: { ...p, extra: 1 } }),
    subjectDigest: statement({ subject: [{ name: FACTS.name, digest: { sha256: sha256("other") } }] }),
    subjectName: statement({ subject: [{ name: "other.exe", digest: { sha256: FACTS.sha256 } }] }),
    twoSubjects: statement({ subject: [{ name: FACTS.name, digest: { sha256: FACTS.sha256 } }, { name: "x", digest: { sha256: FACTS.sha256 } }] }),
    noSubject: statement({ subject: [] }),
    type: statement({ predicateType: "https://slsa.dev/provenance/v1" }),
    statementType: statement({ _type: "https://in-toto.io/Statement/v0.1" }),
  };
  let refused = 0;
  for (const [what, s] of Object.entries(wrongs)) {
    assert.throws(() => checkBundle(bundle(s), expectBinding), /./, what);
    refused += 1;
  }
  assert.equal(refused, Object.keys(wrongs).length, "every wrong statement was tried");
  // A bundle that is not a signed envelope, or is cut short.
  for (const text of ["", "not json", "[]", "{}", bundle(statement(), { dsseEnvelope: undefined }), bundle(statement(), { dsseEnvelope: { payload: "!!", payloadType: "application/vnd.in-toto+json", signatures: [{ sig: "x" }] } }), bundle(statement(), { dsseEnvelope: { payload: Buffer.from("[]").toString("base64"), payloadType: "application/vnd.in-toto+json", signatures: [{ sig: "x" }] } }), bundle(statement(), { verificationMaterial: undefined })]) {
    assert.throws(() => checkBundle(text, expectBinding), /./, text.slice(0, 40));
  }
  const noSig = JSON.parse(bundle(statement()));
  noSig.dsseEnvelope.signatures = [];
  assert.throws(() => checkBundle(JSON.stringify(noSig), expectBinding), /signature/i);
  const wrongPayloadType = JSON.parse(bundle(statement()));
  wrongPayloadType.dsseEnvelope.payloadType = "text/plain";
  assert.throws(() => checkBundle(JSON.stringify(wrongPayloadType), expectBinding), /payload/i);
});

/** `gh attestation verify --format json`, as the live command printed it (field names from a real run), for made-up values. */
function ghAnswer({ facts = FACTS, predicateType = BINDING_PREDICATE_TYPE, predicate = bindingPredicate(FACTS), ref = "refs/heads/main", head = "9f".repeat(20), trigger = "workflow_dispatch", runner = "github-hosted", workflow = `${REPO}/.github/workflows/release.yml`, count = 1 } = {}) {
  const entry = {
    attestation: { bundle: JSON.parse(bundle(statement())) },
    verificationResult: {
      mediaType: "application/vnd.dev.sigstore.verificationresult+json;version=0.1",
      signature: {
        certificate: {
          issuer: "https://token.actions.githubusercontent.com",
          subjectAlternativeName: `https://github.com/${workflow}@${ref}`,
          buildSignerURI: `https://github.com/${workflow}@${ref}`,
          buildSignerDigest: head,
          githubWorkflowTrigger: trigger,
          githubWorkflowRef: ref,
          githubWorkflowRepository: REPO,
          sourceRepositoryURI: `https://github.com/${REPO}`,
          sourceRepositoryDigest: head,
          sourceRepositoryRef: ref,
          runnerEnvironment: runner,
          buildTrigger: trigger,
          runInvocationURI: `https://github.com/${REPO}/actions/runs/1/attempts/1`,
        },
      },
      verifiedTimestamps: [{ type: "Tlog", uri: "https://rekor.sigstore.dev", timestamp: "2026-11-26T04:02:19Z" }],
      statement: {
        _type: "https://in-toto.io/Statement/v1",
        subject: [{ name: facts.name, digest: { sha256: facts.sha256 } }],
        predicateType,
        predicate,
      },
    },
  };
  return JSON.stringify(Array.from({ length: count }, () => entry));
}

test("the_bound_statement_names_tag_commit_and_digest: verification passes for a tag behind main and fails for another", () => {
  const dir = tempDir("release-verify-");
  const installer = join(dir, FACTS.name);
  writeFileSync(installer, "MU-installer-bytes");
  const bundles = { provenance: join(dir, NAMES.provenance), binding: join(dir, NAMES.binding) };
  // Each bundle file says which statement it holds, as a real signed bundle does by its predicate type.
  writeFileSync(bundles.provenance, JSON.stringify({ MU: "https://slsa.dev/provenance/v1" }));
  writeFileSync(bundles.binding, JSON.stringify({ MU: BINDING_PREDICATE_TYPE }));
  const calls = [];
  /**
   * A `gh` that answers each predicate type with what GitHub's own verification printed for it, and, as the real one does,
   * fails when the bundle it is given holds a statement of another predicate type than the one asked for.
   */
  const gh = (answers) => (args) => {
    calls.push(args);
    const type = args[args.indexOf("--predicate-type") + 1];
    const held = JSON.parse(readFileSync(args[args.indexOf("--bundle") + 1], "utf8")).MU;
    if (held !== type) return { status: 1, stdout: "", stderr: `the bundle holds a ${held} statement, not ${type}` };
    const a = answers[type];
    return typeof a === "function" ? a(args) : { status: 0, stdout: a, stderr: "" };
  };
  const good = {
    "https://slsa.dev/provenance/v1": ghAnswer({ predicateType: "https://slsa.dev/provenance/v1", predicate: { buildDefinition: { buildType: "MU" } } }),
    [BINDING_PREDICATE_TYPE]: ghAnswer(),
  };
  const verify = (answers, over = {}) => verifyAttestations({ installer, bundles, repository: REPO, tag: FACTS.tag, source: FACTS.source, version: FACTS.version, runGh: gh(answers), ...over });

  // The legitimate release: main's head (the certificate's commit) is not the tag's commit.
  const ok = verify(good);
  assert.deepEqual(ok.checked, ["https://slsa.dev/provenance/v1", BINDING_PREDICATE_TYPE]);
  assert.equal(calls.length, 2, "one gh run per statement");
  for (const args of calls) {
    assert.deepEqual(args.slice(0, 3), ["attestation", "verify", installer]);
    const value = (flag) => args[args.indexOf(flag) + 1];
    assert.equal(value("--repo"), REPO);
    assert.equal(value("--signer-workflow"), `github.com/${REPO}/.github/workflows/release.yml@refs/heads/main`);
    assert.equal(value("--source-ref"), "refs/heads/main");
    assert.equal(value("--cert-oidc-issuer"), "https://token.actions.githubusercontent.com");
    assert.equal(value("--format"), "json");
    assert.ok(args.includes("--deny-self-hosted-runners"));
    // Each statement is verified against its own bundle: the provenance type with the provenance bundle, and so on.
    assert.equal(value("--bundle"), value("--predicate-type") === BINDING_PREDICATE_TYPE ? bundles.binding : bundles.provenance);
  }
  // The two bundle files swapped: gh refuses a bundle of the other statement, so the guard refuses.
  const callsBefore = calls.length;
  assert.throws(() => verify(good, { bundles: { provenance: bundles.binding, binding: bundles.provenance } }), /bundle holds|failed/i);
  assert.ok(calls.length > callsBefore, "gh was asked");
  assert.ok(!calls.some((args) => args.includes("--source-digest")), "main's head is not the tag's commit, so the certificate's commit is not pinned to it");

  // A different tag or source commit against the same installer fails.
  assert.throws(() => verify(good, { tag: "v0.1.2" }), /tag/);
  assert.throws(() => verify(good, { source: "e5".repeat(20) }), /source|commit/);
  assert.throws(() => verify(good, { version: "0.1.2" }), /version/);
  assert.throws(() => verify(good, { repository: "MU-other/MU-repo" }), /./);
  // The same installer under another digest or name inside the verified statement.
  const otherFacts = { ...FACTS, sha256: sha256("other"), name: FACTS.name };
  assert.throws(() => verify({ ...good, [BINDING_PREDICATE_TYPE]: ghAnswer({ facts: otherFacts }) }), /digest|subject/i);
  // GitHub's check failing, printing nothing, or printing no attestation at all.
  assert.throws(() => verify({ ...good, [BINDING_PREDICATE_TYPE]: () => ({ status: 1, stdout: "", stderr: "verification failed" }) }), /verification failed|exit/i);
  assert.throws(() => verify({ ...good, [BINDING_PREDICATE_TYPE]: "" }), /./);
  assert.throws(() => verify({ ...good, [BINDING_PREDICATE_TYPE]: "[]" }), /no attestation|0 attestation|found none/i);
  assert.throws(() => verify({ ...good, [BINDING_PREDICATE_TYPE]: "not json" }), /./);
  // The certificate's own facts: another ref, another trigger, a self-hosted runner, another workflow.
  assert.throws(() => verify({ ...good, [BINDING_PREDICATE_TYPE]: ghAnswer({ ref: "refs/heads/plan-5-release" }) }), /ref/i);
  assert.throws(() => verify({ ...good, [BINDING_PREDICATE_TYPE]: ghAnswer({ trigger: "push" }) }), /trigger|workflow_dispatch/i);
  assert.throws(() => verify({ ...good, [BINDING_PREDICATE_TYPE]: ghAnswer({ runner: "self-hosted" }) }), /runner|hosted/i);
  assert.throws(() => verify({ ...good, [BINDING_PREDICATE_TYPE]: ghAnswer({ workflow: `${REPO}/.github/workflows/ci.yml` }) }), /workflow|signer/i);
  assert.throws(() => verify({ ...good, "https://slsa.dev/provenance/v1": ghAnswer({ predicateType: "https://slsa.dev/provenance/v1", predicate: {}, ref: "refs/tags/v0.1.1" }) }), /ref/i);
  // The predicate type GitHub verified is the one asked for.
  assert.throws(() => verify({ ...good, [BINDING_PREDICATE_TYPE]: ghAnswer({ predicateType: "https://slsa.dev/provenance/v1" }) }), /predicate type/i);
});

test("collect_bundles_keeps_both_statements_under_fixed_names_and_refuses_a_wrong_one", () => {
  const dir = tempDir("release-bundles-");
  const write = (name, text) => {
    writeFileSync(join(dir, name), text);
    return join(dir, name);
  };
  const prov = write("p.json", bundle(statement({ predicateType: "https://slsa.dev/provenance/v1", predicate: { buildDefinition: {} } })));
  const bind = write("b.json", bundle(statement()));
  const out = join(dir, "out");
  const done = collectBundles({ provenance: prov, binding: bind, outDir: out, ...FACTS });
  assert.deepEqual(done.sort(), [NAMES.binding, NAMES.provenance].sort());
  assert.deepEqual(readdirSync(out).sort(), [NAMES.binding, NAMES.provenance].sort());
  // The wrong statement in the binding slot, or a swap, refuses and leaves nothing behind.
  const out2 = join(dir, "out2");
  assert.throws(() => collectBundles({ provenance: bind, binding: prov, outDir: out2, ...FACTS }), /./);
  assert.throws(() => collectBundles({ provenance: prov, binding: write("w.json", bundle(statement({ predicate: { ...bindingPredicate(FACTS), tag: "v9.9.9" } }))), outDir: out2, ...FACTS }), /tag/);
  assert.deepEqual(readdirSync(dir).includes("out2") ? readdirSync(out2) : [], []);
  assert.throws(() => collectBundles({ provenance: join(dir, "missing.json"), binding: bind, outDir: out2, ...FACTS }), /./);
});

// ---------------------------------------------------------------------------------------------------------------------
// The draft release.

function draftInputs(over = {}) {
  const i = installerDir("0.1.1", "MU-installer-bytes");
  const bundles = tempDir("release-draft-bundles-");
  writeFileSync(join(bundles, NAMES.provenance), bundle(statement({ predicateType: "https://slsa.dev/provenance/v1", predicate: { buildDefinition: {} } })));
  writeFileSync(join(bundles, NAMES.binding), bundle(statement()));
  const idFile = join(tempDir("release-draft-id-"), "draft-id.txt");
  return { tag: "v0.1.1", source: FACTS.source, version: "0.1.1", repository: REPO, run: { id: "123456", attempt: "2" }, sha256: i.sha256, installerDir: i.dir, bundlesDir: bundles, idFile, ...over };
}

function draftWorld(options) {
  const fake = new FakeGitHub(options);
  fake.tags.set("v0.1.1", { type: "commit", sha: FACTS.source });
  return fake;
}

const draftsOf = (fake, tag = "v0.1.1") => fake.releases.filter((r) => r.tag_name === tag && r.draft);

test("draft_is_verified_after_upload_or_deleted", async () => {
  // The good path: a fresh draft, four assets, downloaded again and compared, the id and digest returned and written.
  {
    const fake = draftWorld();
    const inputs = draftInputs();
    const result = await draftRelease({ api: fake.api(), ...inputs });
    assert.equal(result.sha256, inputs.sha256);
    assert.equal(fake.releases.length, 1);
    const [r] = fake.releases;
    assert.equal(result.id, r.id);
    assert.deepEqual({ draft: r.draft, prerelease: r.prerelease, name: r.name, tag: r.tag_name }, { draft: true, prerelease: true, name: "Petalock 0.1.1", tag: "v0.1.1" });
    assert.deepEqual(r.assets.map((a) => a.name).sort(), Object.values(NAMES).sort());
    assert.equal(r.assets.find((a) => a.name === NAMES.sha256).stored.toString(), `${inputs.sha256}  ${NAMES.installer}\n`);
    assert.equal(readFileSync(inputs.idFile, "utf8").trim(), String(r.id), "the draft's id is written down as soon as it exists");
    assert.ok(result.summary.includes(String(r.id)) && result.summary.includes(inputs.sha256), "the record lines carry the id and the digest");
    // Each asset was downloaded again, by redirect, and the second request carried no credentials to another host.
    const downloads = fake.calls.filter((c) => /releases\/assets\/\d+/.test(c));
    assert.equal(downloads.length, 4);
    assert.equal(fake.blobAuth.length, 4);
    assert.ok(fake.blobAuth.every((a) => a === null), "no Authorization header went to the other host");
    assert.ok(r.assets.every((a) => a.stored.length > 0));
  }
  // An earlier draft for the same tag is deleted first; a draft for another tag is left; the order is checked.
  {
    const fake = draftWorld();
    const old = { id: 1, tag_name: "v0.1.1", draft: true, prerelease: true, assets: [], name: "old" };
    const other = { id: 2, tag_name: "v0.1.0", draft: true, prerelease: true, assets: [], name: "other" };
    fake.releases.push(old, other);
    const result = await draftRelease({ api: fake.api(), ...draftInputs() });
    assert.ok(!fake.releases.includes(old), "the earlier draft is gone");
    assert.ok(fake.releases.includes(other), "another tag's draft is untouched");
    assert.equal(draftsOf(fake).length, 1);
    assert.notEqual(result.id, 1);
    const del = fake.calls.findIndex((c) => c === `DELETE api.github.com/repos/${REPO}/releases/1`);
    const create = fake.calls.findIndex((c) => c === `POST api.github.com/repos/${REPO}/releases`);
    assert.ok(del >= 0 && create > del, "the earlier draft is deleted before the new one is made");
  }
  // A published release for the tag stops everything: nothing is deleted or made.
  {
    const fake = draftWorld();
    fake.releases.push({ id: 3, tag_name: "v0.1.1", draft: false, prerelease: true, assets: [], name: "public" }, { id: 4, tag_name: "v0.1.1", draft: true, prerelease: true, assets: [], name: "old" });
    await refusal(draftRelease({ api: fake.api(), ...draftInputs() }), /published|already/i);
    assert.equal(fake.releases.length, 2, "nothing was deleted");
    assert.ok(!fake.calls.some((c) => c.startsWith("POST") || c.startsWith("DELETE")));
  }
  // Releases on a second page are found too.
  {
    const fake = draftWorld({ pageCap: 1 });
    fake.releases.push({ id: 5, tag_name: "v0.0.1", draft: true, prerelease: true, assets: [], name: "a" }, { id: 6, tag_name: "v0.1.1", draft: true, prerelease: true, assets: [], name: "b" });
    await draftRelease({ api: fake.api(), ...draftInputs() });
    assert.ok(!fake.releases.some((r) => r.id === 6));
    assert.equal(draftsOf(fake).length, 1);
  }
  // A failure after the first asset (the second upload is refused): the draft is deleted.
  {
    const fake = draftWorld({ failUploadAt: 2 });
    await refusal(draftRelease({ api: fake.api(), ...draftInputs() }), /502|upload/i);
    assert.equal(draftsOf(fake).length, 0, "the draft was deleted");
    assert.equal(fake.uploads, 2);
  }
  // Each asset in turn failing leaves nothing, the first included.
  for (const at of [1, 3, 4]) {
    const fake = draftWorld({ failUploadAt: at });
    await assert.rejects(draftRelease({ api: fake.api(), ...draftInputs() }));
    assert.equal(fake.releases.length, 0, `upload ${at} failing`);
  }
  // An asset stored with a changed byte, an asset that silently did not arrive, and a moved tag: each deletes the draft.
  for (const [options, pattern] of [
    [{ corruptStored: NAMES.installer }, /differs|digest|compare/i],
    [{ corruptStored: NAMES.binding }, /differs|digest|compare/i],
    [{ dropAsset: NAMES.provenance }, /assets|missing|expected/i],
    [{ moveTagAfterUploads: 4 }, /tag.*(moved|names|commit)/i],
    [{ moveTagAfterUploads: 1 }, /tag.*(moved|names|commit)/i],
  ]) {
    const fake = draftWorld(options);
    await refusal(draftRelease({ api: fake.api(), ...draftInputs() }), pattern);
    assert.equal(fake.releases.length, 0, JSON.stringify(options));
  }
  // The tag already names another commit, or does not exist: refused before any release is made.
  for (const tag of [{ type: "commit", sha: "f".repeat(40) }, null]) {
    const fake = draftWorld();
    if (tag) fake.tags.set("v0.1.1", tag);
    else fake.tags.delete("v0.1.1");
    await refusal(draftRelease({ api: fake.api(), ...draftInputs() }), /tag/i);
    assert.equal(fake.releases.length, 0);
    assert.ok(!fake.calls.some((c) => c.startsWith("POST")));
  }
  // An annotated tag is peeled to the commit.
  {
    const fake = draftWorld();
    fake.tags.set("v0.1.1", { type: "tag", sha: "7".repeat(40) });
    fake.annotated.set("7".repeat(40), FACTS.source);
    await draftRelease({ api: fake.api(), ...draftInputs() });
    assert.equal(draftsOf(fake).length, 1);
  }
  // Wrong inputs are refused before the draft is made: a digest that is not the installer's, a wrong bundle.
  {
    const fake = draftWorld();
    await refusal(draftRelease({ api: fake.api(), ...draftInputs({ sha256: sha256("other") }) }), /digest|differs/i);
    const bad = draftInputs();
    writeFileSync(join(bad.bundlesDir, NAMES.binding), bundle(statement({ predicate: { ...bindingPredicate(FACTS), tag: "v9.9.9" } })));
    await refusal(draftRelease({ api: fake.api(), ...bad }), /tag/);
    assert.equal(fake.releases.length, 0);
    assert.ok(!fake.calls.some((c) => c.startsWith("POST") || c.startsWith("DELETE")));
  }
  // A failed clean-up is said, together with what went wrong first.
  {
    const fake = draftWorld({ failUploadAt: 2, deleteFails: true });
    await refusal(draftRelease({ api: fake.api(), ...draftInputs() }), /502[\s\S]*(could not delete|not deleted)/i);
  }
});

test("draft_is_never_deleted_once_it_is_seen_public", async () => {
  const stays = (fake, id) => assert.ok(fake.releases.some((r) => r.id === id && r.draft === false), "the public release is still there");
  const noDelete = (fake) => assert.ok(!fake.calls.some((c) => c.startsWith("DELETE")), `no delete was sent: ${fake.calls.filter((c) => c.startsWith("DELETE"))}`);
  // Published during verification (after the last upload, and after the first): the check sees it public and stops; the
  // clean-up must not delete it.
  for (const publishAfterUploads of [4, 1]) {
    const fake = draftWorld({ publishAfterUploads });
    await refusal(draftRelease({ api: fake.api(), ...draftInputs() }), /public|published/i);
    stays(fake, fake.releases[0]?.id);
    noDelete(fake);
  }
  // Published, then an upload fails: the error says so and the release is left alone.
  {
    const fake = draftWorld({ publishAfterUploads: 1, failUploadAt: 2 });
    await refusal(draftRelease({ api: fake.api(), ...draftInputs() }), /502[\s\S]*(public|published)[\s\S]*(left|not deleted)/i);
    stays(fake, fake.releases[0]?.id);
    noDelete(fake);
  }
  // The earlier draft for the tag is published between the list and its deletion: it is not deleted, and no new draft is made.
  {
    const fake = draftWorld({ publishWhenListed: 1 });
    fake.releases.push({ id: 1, tag_name: "v0.1.1", draft: true, prerelease: true, assets: [], name: "earlier" });
    await refusal(draftRelease({ api: fake.api(), ...draftInputs() }), /public|published/i);
    stays(fake, 1);
    noDelete(fake);
    assert.ok(!fake.calls.some((c) => c.startsWith("POST")), "no new draft was made");
  }
  // Still deleted when it is a draft: the same clean-up deletes after a failure when nothing published it.
  {
    const fake = draftWorld({ failUploadAt: 3 });
    await assert.rejects(draftRelease({ api: fake.api(), ...draftInputs() }));
    assert.equal(fake.releases.length, 0);
    assert.ok(fake.calls.some((c) => c.startsWith("GET") && /releases\/\d+$/.test(c)), "the state was read before the delete");
  }
});

test("draft_checks_the_tag_it_belongs_to_and_names_the_run", async () => {
  // The draft is edited to another tag during the upload, the Git ref untouched: the final check refuses, and the draft goes.
  {
    const fake = draftWorld({ retagAfterUploads: 4 });
    await refusal(draftRelease({ api: fake.api(), ...draftInputs() }), /belongs to tag v9\.9\.9/);
    assert.equal(fake.releases.length, 0);
    assert.equal(fake.tags.get("v0.1.1").sha, FACTS.source, "the Git ref was never touched");
  }
  // The body names the workflow run and attempt, so a stray draft can be traced to its run.
  {
    const fake = draftWorld();
    await draftRelease({ api: fake.api(), ...draftInputs() });
    assert.match(fake.releases[0].body, /^Workflow run: 123456, attempt 2$/m);
  }
  // The run is two numbers, or the draft is not made.
  for (const run of [undefined, { id: "12; x", attempt: "1" }, { id: "1", attempt: "" }, { id: "1\n2", attempt: "1" }]) {
    const fake = draftWorld();
    await refusal(draftRelease({ api: fake.api(), ...draftInputs({ run }) }), /run/i);
    assert.ok(!fake.calls.some((c) => c.startsWith("POST") || c.startsWith("DELETE")));
  }
  // The id file cannot be written (its folder is not there): the draft that was just made is deleted, not stranded.
  {
    const fake = draftWorld();
    const inputs = draftInputs();
    await assert.rejects(draftRelease({ api: fake.api(), ...inputs, idFile: join(dirname(inputs.idFile), "no-such-folder", "draft-id.txt") }), /ENOENT|no such/i);
    assert.equal(fake.releases.length, 0, "the draft was deleted");
  }
});

test("discard_draft_deletes_only_the_recorded_draft", async () => {
  const fake = draftWorld();
  const inputs = draftInputs();
  fake.releases.push({ id: 41, tag_name: "v0.1.1", draft: true, prerelease: true, assets: [], name: "mine" }, { id: 42, tag_name: "v0.0.9", draft: true, prerelease: true, assets: [], name: "other draft" }, { id: 43, tag_name: "v0.0.8", draft: false, prerelease: false, assets: [], name: "published" });
  // No id file: nothing was made, nothing to do.
  assert.equal((await discardDraft({ api: fake.api(), idFile: inputs.idFile })).deleted, null);
  assert.equal(fake.releases.length, 3);
  // The recorded draft goes; the others stay.
  writeFileSync(inputs.idFile, "41\n");
  assert.equal((await discardDraft({ api: fake.api(), idFile: inputs.idFile })).deleted, 41);
  assert.deepEqual(fake.releases.map((r) => r.id), [42, 43]);
  // A published release is never deleted, even when its id is the recorded one.
  writeFileSync(inputs.idFile, "43\n");
  await refusal(discardDraft({ api: fake.api(), idFile: inputs.idFile }), /published|not a draft/i);
  assert.ok(fake.releases.some((r) => r.id === 43));
  // A draft that is already gone is fine; an id file with anything else in it is refused.
  writeFileSync(inputs.idFile, "99\n");
  assert.equal((await discardDraft({ api: fake.api(), idFile: inputs.idFile })).deleted, null);
  writeFileSync(inputs.idFile, "41; rm -rf\n");
  await refusal(discardDraft({ api: fake.api(), idFile: inputs.idFile }), /id/i);
});

test("the_api_client_refuses_other_hosts_and_hides_the_token", async () => {
  const fake = draftWorld();
  const api = fake.api();
  await assert.rejects(api.get("nope"), (e) => {
    assert.match(e.message, /404/);
    assert.ok(!e.message.includes(TOKEN));
    return true;
  });
  const badToken = makeApi({ fetch: fake.fetch, token: `${TOKEN}-wrong`, repository: REPO });
  await assert.rejects(badToken.get("releases"), (e) => {
    assert.match(e.message, /401/);
    assert.ok(!e.message.includes(TOKEN));
    return true;
  });
  // A download that redirects to anything but https is not followed.
  const evil = makeApi({
    repository: REPO,
    token: TOKEN,
    fetch: async () => new Response(null, { status: 302, headers: { location: "http://objects.example.invalid/blob/1" } }),
  });
  await assert.rejects(evil.download(1), /https|redirect/i);
  const direct = makeApi({ repository: REPO, token: TOKEN, fetch: async () => new Response("x", { status: 200 }) });
  assert.equal((await direct.download(1)).toString(), "x");
  assert.throws(() => makeApi({ fetch: fake.fetch, token: TOKEN, repository: "a/b/c" }), /repository/);
  assert.throws(() => makeApi({ fetch: fake.fetch, token: "", repository: REPO }), /token/);
});

// ---------------------------------------------------------------------------------------------------------------------
// The command line.

test("outputs_are_written_only_for_values_of_a_safe_shape", () => {
  const file = join(tempDir(), "out.txt");
  writeOutputs(file, { tag: "v0.1.1", source: SHA, version: "0.1.1" });
  assert.equal(readFileSync(file, "utf8"), `tag=v0.1.1\nsource=${SHA}\nversion=0.1.1\n`);
  for (const bad of ["a\nb", "a\rb", "x=y\nz=w"]) assert.throws(() => writeOutputs(file, { v: bad }), /line/i);
  assert.throws(() => writeOutputs(file, { "a=b": "c" }), /name/i);
  assert.throws(() => writeOutputs(file, { v: undefined }), /value/i);
});

function cli(args, extraEnv = {}) {
  const base = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot };
  return spawnSync(process.execPath, [GUARD, ...args], { encoding: "utf8", env: { ...base, ...extraEnv } });
}

test("the_command_line_refuses_an_unknown_command_and_a_bad_tag_before_writing_anything", () => {
  const none = cli([]);
  assert.equal(none.status, 2);
  const unknown = cli(["publish"]);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /unknown command/i);
  const out = join(tempDir(), "github-output.txt");
  const bad = cli(["authorize"], { TAG: "v0.1.1; echo x", GITHUB_OUTPUT: out, GITHUB_REPOSITORY: REPO, GITHUB_TOKEN: TOKEN });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /tag/i);
  assert.ok(!bad.stderr.includes(TOKEN) && !bad.stdout.includes(TOKEN));
  assert.throws(() => readFileSync(out), /ENOENT/, "no output was written");
});

test("the_command_line_reads_each_command_from_the_environment_names_the_workflow_sets", () => {
  // The names here are the ones release.yml's steps set; a name the guard and the workflow disagree on fails here, not in a release.
  const dir = tempDir("release-cli-");
  const i = installerDir("0.1.1", "MU-installer-bytes");
  const out = join(dir, "github-output.txt");
  const base = { GITHUB_OUTPUT: out, GITHUB_REPOSITORY: REPO, VERSION: "0.1.1" };
  const check = cli(["check-installer"], { ...base, INSTALLER_DIR: i.dir, EXPECTED_SHA256: i.sha256 });
  assert.equal(check.status, 0, check.stderr);
  assert.equal(readFileSync(out, "utf8"), `name=${i.name}\nsha256=${i.sha256}\ndigest=sha256:${i.sha256}\n`);
  const wrong = cli(["check-installer"], { ...base, INSTALLER_DIR: i.dir, EXPECTED_SHA256: sha256("other") });
  assert.equal(wrong.status, 1);
  assert.match(wrong.stderr, /differs/);
  assert.equal(cli(["check-installer"], { ...base, INSTALLER_DIR: i.dir }).status, 1, "a missing variable is refused");

  const versions = { ...base, INSTALLER_NAME: i.name, PRODUCT_VERSION: "0.1.1", FILE_VERSION: "0.1.1" };
  assert.equal(cli(["check-embedded-version"], versions).status, 0);
  assert.equal(cli(["check-embedded-version"], { ...versions, PRODUCT_VERSION: "0.1.0" }).status, 1);
  assert.equal(cli(["check-embedded-version"], { ...versions, FILE_VERSION: undefined }).status, 1);

  const facts = { ...base, TAG: FACTS.tag, SOURCE: FACTS.source, NAME: FACTS.name, SHA256: FACTS.sha256 };
  const statementFile = join(dir, "release-binding.json");
  const write = cli(["write-binding"], { ...facts, OUT: statementFile });
  assert.equal(write.status, 0, write.stderr);
  assert.deepEqual(JSON.parse(readFileSync(statementFile, "utf8")), bindingPredicate(FACTS));
  assert.equal(cli(["write-binding"], { ...facts, OUT: join(dir, "x.json"), TAG: "v0.1.2" }).status, 1, "a tag that is not the version");

  const bundleDir = join(dir, "in");
  mkdirSync(bundleDir);
  writeFileSync(join(bundleDir, "p.json"), bundle(statement({ predicateType: "https://slsa.dev/provenance/v1", predicate: { buildDefinition: {} } })));
  writeFileSync(join(bundleDir, "b.json"), bundle(statement()));
  const collected = cli(["collect-bundles"], { ...facts, PROVENANCE_BUNDLE: join(bundleDir, "p.json"), BINDING_BUNDLE: join(bundleDir, "b.json"), OUT_DIR: join(dir, "bundles") });
  assert.equal(collected.status, 0, collected.stderr);
  assert.deepEqual(readdirSync(join(dir, "bundles")).sort(), [NAMES.binding, NAMES.provenance].sort());

  // Commands that call GitHub, as far as they can go without it: the checks that come first run, and fail, before any call.
  const token = { GITHUB_TOKEN: TOKEN };
  const none = cli(["discard-draft"], { ...token, ...base, DRAFT_ID_FILE: join(dir, "no-such-file.txt") });
  assert.equal(none.status, 0, none.stderr);
  assert.match(none.stdout, /no draft/);
  const draft = cli(["draft"], { ...token, ...facts, GITHUB_RUN_ID: "123456", GITHUB_RUN_ATTEMPT: "2", EXPECTED_SHA256: sha256("other"), INSTALLER_DIR: i.dir, BUNDLES_DIR: join(dir, "bundles"), DRAFT_ID_FILE: join(dir, "draft-id.txt") });
  assert.equal(draft.status, 1);
  assert.match(draft.stderr, /differs/);
  assert.ok(!draft.stderr.includes(TOKEN));
  const emptyPath = cli(["verify"], { PATH: "", GITHUB_REPOSITORY: REPO, TAG: FACTS.tag, SOURCE: FACTS.source, VERSION: "0.1.1", INSTALLER: join(i.dir, i.name), PROVENANCE_BUNDLE: join(bundleDir, "p.json"), BINDING_BUNDLE: join(bundleDir, "b.json") });
  assert.equal(emptyPath.status, 1);
  assert.match(emptyPath.stderr, /gh attestation verify failed/);
});
