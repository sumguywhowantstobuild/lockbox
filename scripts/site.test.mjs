// Plan 5, Task 6: the download page, the guide and the not-found page (site/), and the build that fills them from the one
// published release site/release.json names (scripts/site-build.mjs). Every test sits beside the line of the approved design
// (docs/design/2026-11-26-download-page-design.md) or the plan it pins. GitHub is a fake `fetch` that answers with the field
// names the live API sent for a real public release (url, id, name, state, size, digest, browser_download_url; draft,
// prerelease, published_at; a 302 to https storage for an asset), and every value in it is made up (MU-).
//
// The browser tests load the built pages in headless Edge through Edge WebDriver (scripts/site-browser.mjs) and run axe-core
// from the UI's dev dependency. They run when the driver is given (PETALOCK_EDGEDRIVER, or EDGEWEBDRIVER on GitHub Actions)
// and are skipped, said so in the output, when it is not; PETALOCK_SITE_BROWSER=1 turns a missing driver or a missing
// axe-core into a failure instead, as CI sets it.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { findAxe, findEdgeDriver, openBrowser, parseHeaders, runAxe, serve } from "./site-browser.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SITE = join(ROOT, "site");
const BUILD = join(ROOT, "scripts", "site-build.mjs");
const REPO = "sumguywhowantstobuild/petalock";
const GITHUB = `https://github.com/${REPO}`;
/** The one signer the guide pins for GitHub's build record: the release workflow, on main (certificate identity). */
const IDENTITY = `${GITHUB}/.github/workflows/release.yml@refs/heads/main`;
const TAG = "v0.1.0";
const VERSION = "0.1.0";
const INSTALLER = `Petalock_${VERSION}_x64-setup.exe`;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const lib = () => import("./site-build.mjs");
const picture = () => import("./site-picture.mjs");

const cleanups = [];
const tempDir = (prefix = "site-test-") => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(dir);
  return dir;
};
process.on("exit", () => cleanups.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

// ---------------------------------------------------------------------------------------------------------------------
// A fake GitHub for one release

const INSTALLER_BYTES = Buffer.concat([Buffer.from("MZ MU-made-up installer bytes "), randomBytes(1_234_567)]);
// A second made-up release, of another version, size and bytes: nothing of the first may leak into its page.
const TAG2 = "v1.4.2";
const VERSION2 = "1.4.2";
const INSTALLER2 = `Petalock_${VERSION2}_x64-setup.exe`;
const INSTALLER2_BYTES = Buffer.concat([Buffer.from("MZ MU-second made-up installer "), randomBytes(2_345_678)]);
const sidecarFor = (bytes, name = INSTALLER) => `${sha256(bytes)}  ${name}\n`;

const asset = (id, name, size, extra = {}, tag = TAG) => ({
  url: `https://api.github.com/repos/${REPO}/releases/assets/${String(id)}`,
  id,
  node_id: `MU_RA_${String(id)}`,
  name,
  label: "",
  content_type: "application/octet-stream",
  state: "uploaded",
  size,
  digest: null,
  download_count: 0,
  created_at: "2026-12-08T09:20:00Z",
  updated_at: "2026-12-08T09:20:00Z",
  browser_download_url: `${GITHUB}/releases/download/${tag}/${name}`,
  ...extra,
});

/**
 * A `fetch` that answers the calls the build makes: the release's metadata at the API, and the two files at the PUBLIC
 * tag-and-filename address (a 302 to https storage, as GitHub answers). `change` edits the scenario before it is served:
 * `release` (the release object), `installer` and `sidecar` (what the public address serves), `apiInstaller` and `apiSidecar`
 * (what the API's asset-by-id address would serve: never asked for by the build, and different bytes unless a test says
 * otherwise), `apiStatus`, `storage` (the redirect's base address), `storageStatus`. `calls` lists every address asked for and
 * `seen` each one with the headers sent.
 */
function fakeGithub(change = () => {}, { tag = TAG, bytes = INSTALLER_BYTES, published = "2026-12-08T09:30:00Z" } = {}) {
  const file = `Petalock_${tag.slice(1)}_x64-setup.exe`;
  const scenario = {
    release: {
      url: `https://api.github.com/repos/${REPO}/releases/1`,
      html_url: `${GITHUB}/releases/tag/${tag}`,
      id: 1,
      tag_name: tag,
      name: "MU-release",
      draft: false,
      immutable: false,
      prerelease: true,
      created_at: "2026-12-08T09:00:00Z",
      published_at: published,
      // a size of 0 means "the real size of what is served", filled in after the scenario has changed what is served
      assets: [asset(1001, file, 0, {}, tag), asset(1002, `${file}.sha256`, 0, {}, tag)],
    },
    installer: bytes,
    sidecar: sidecarFor(bytes, file),
    apiInstaller: Buffer.from("MU decoy: the API's asset address serves other bytes than the public one"),
    apiSidecar: "MU decoy sidecar\n",
    apiStatus: 200,
    storage: "https://release-assets.githubusercontent.com/MU",
    storageStatus: 200,
  };
  change(scenario);
  if (scenario.release.assets[0]?.size === 0) scenario.release.assets[0].size = scenario.installer.length;
  if (scenario.release.assets[1]?.size === 0) scenario.release.assets[1].size = Buffer.byteLength(scenario.sidecar);
  const calls = [];
  const seen = [];
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push(url);
    seen.push({ url, headers: Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])) });
    if (url === `https://api.github.com/repos/${REPO}/releases/tags/${tag}`) {
      return scenario.apiStatus === 200 ? json(200, scenario.release) : json(scenario.apiStatus, { message: "Not Found" });
    }
    const publicCall = new RegExp(`^${GITHUB.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/releases/download/${tag.replace(/\./g, "\\.")}/([A-Za-z0-9_.-]+)$`).exec(url);
    if (publicCall) {
      assert.equal(init.redirect, "manual", "a download must not follow a redirect by itself");
      return new Response(null, { status: 302, headers: { location: `${scenario.storage}/public/${publicCall[1]}` } });
    }
    if (/^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+\/releases\/assets\/\d+$/.test(url)) {
      return new Response(null, { status: 302, headers: { location: `${scenario.storage}/api/${url.split("/").pop()}` } });
    }
    if (url.startsWith(`${scenario.storage}/`)) {
      if (scenario.storageStatus !== 200) return new Response("no", { status: scenario.storageStatus });
      const [, kind, leaf] = /^\/(?:[^/]+)\/(public|api)\/([^/]+)$/.exec(new URL(url).pathname) ?? [];
      if (kind === "public") return new Response(leaf.endsWith(".sha256") ? scenario.sidecar : scenario.installer, { status: 200 });
      if (kind === "api") return new Response(leaf === "1002" ? scenario.apiSidecar : scenario.apiInstaller, { status: 200 });
    }
    return new Response("unexpected", { status: 599 });
  };
  return { fetch, calls, seen, scenario };
}

/** A copy of site/ with the given release.json text (or none when `null`), and a build into a folder that does not exist yet. */
function siteWith(releaseText) {
  const root = tempDir();
  const siteDir = join(root, "site");
  cpSync(SITE, siteDir, { recursive: true });
  rmSync(join(siteDir, "release.json"), { force: true });
  if (releaseText !== null) writeFileSync(join(siteDir, "release.json"), releaseText);
  return { root, siteDir, outDir: join(root, "out") };
}

const choose = (tag) => `{"tag": ${JSON.stringify(tag)}}\n`;

async function build(releaseText, github = fakeGithub(), token) {
  const { buildSite } = await lib();
  const where = siteWith(releaseText);
  const result = await buildSite({ siteDir: where.siteDir, outDir: where.outDir, fetch: github.fetch, token });
  return { ...where, result, github };
}

/** The build must refuse with a SiteBuildRefused (its message matching `message`) and leave nothing; `edit(siteDir)` changes the site copy first. */
async function refused(releaseText, github, message, edit = () => {}) {
  const { buildSite, SiteBuildRefused } = await lib();
  const where = siteWith(releaseText);
  edit(where.siteDir);
  await assert.rejects(
    () => buildSite({ siteDir: where.siteDir, outDir: where.outDir, fetch: github.fetch }),
    (error) => {
      assert.ok(error instanceof SiteBuildRefused, `expected a SiteBuildRefused, got ${String(error?.stack ?? error)}`);
      if (message) assert.match(error.message, message);
      return true;
    },
  );
  assert.equal(existsSync(where.outDir), false, "a refused build leaves no output");
  assert.deepEqual(readdirSync(where.root).sort(), ["site"], "a refused build leaves nothing beside the site either");
}

// The two built states, made once.
let builtPromise;
const built = () => (builtPromise ??= (async () => ({ release: await build(choose(TAG)), soon: await build('{"tag": null}\n') }))());
const read = (dir, file) => readFileSync(join(dir, file), "utf8");
const PAGES = ["index.html", "guide/index.html", "404.html"];
const appendCss = (dir, css) => writeFileSync(join(dir, "styles.css"), `${read(dir, "styles.css")}\n${css}\n`);

// ---------------------------------------------------------------------------------------------------------------------
// A small reader of the built pages: tags, attributes and the visible words

/** Every tag of `html` as `{ name, attrs, closing }`; throws when a `<` starts anything it cannot read. */
function tags(html) {
  const out = [];
  // `<\!--`, not `<!--`: semgrep's parser reads the latter in a regular expression as an HTML comment.
  const tag = /<\!--[\s\S]*?-->|<!doctype html>|<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^\s"'<>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*\/?>/g;
  const rest = html.replace(tag, (whole, closing, name, attrText) => {
    if (name === undefined) return "";
    const attrs = {};
    for (const m of (attrText ?? "").matchAll(/([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
      attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? "";
    }
    out.push({ name: name.toLowerCase(), attrs, closing: closing === "/" });
    return "";
  });
  assert.equal(rest.includes("<"), false, `a "<" in the page starts something this reader cannot read: ${rest.slice(Math.max(0, rest.indexOf("<") - 20), rest.indexOf("<") + 40)}`);
  return out;
}

const INLINE = /<\/?(?:a|strong|em|span|code|b|i|small|label|abbr|kbd)(?:\s[^>]*)?>/gi;
const decode = (s) =>
  s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
/** Text compared as the design says: straight and curly quotes the same, white space collapsed. */
const norm = (s) => s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ").trim();
/** The words a visitor reads, and the text boxes' words, from one page. */
function visibleText(html) {
  const body = html
    .replace(/<\!--[\s\S]*?-->/g, "")
    .replace(/<head[\s\S]*?<\/head>/i, "")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(INLINE, "")
    .replace(/<[^>]*>/g, " ");
  return norm(decode(body));
}
const titleOf = (html) => norm(decode(/<title>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? ""));
const idsOf = (html) => tags(html).flatMap((t) => (t.attrs.id === undefined ? [] : [t.attrs.id]));

// ---------------------------------------------------------------------------------------------------------------------
// The picture (design: "The opening picture"; Task 6: "may be generated by a repo script from the rule, with a test that
// checks sample points against the design's formula")

/** Numbers of one subpath of a path written with implicit line-tos. */
const numbers = (d) => (d.match(/-?\d*\.?\d+/g) ?? []).map(Number);

test("the_picture_follows_the_designs_rule", async () => {
  const { intaglio } = await picture();
  for (const weight of [1, 1.4, 2.45 / 1.6]) {
    // each line is one path of two outlines filled evenodd (without it the ribbons fill solid)
    const paths = [...intaglio(weight).matchAll(/<path d="([^"]+)" fill-rule="evenodd"\/>/g)].map((m) => m[1]);
    assert.equal(paths.length, 26, "twenty-six lines");
    let checked = 0;
    paths.forEach((d, i) => {
      const [left, right, ...extra] = d.split("Z").filter((part) => part.trim() !== "").map((part) => numbers(part.replace(/^\s*M/, "")));
      assert.equal(extra.length, 0, "two outlines per line (one each side of it)");
      assert.equal(left.length, 2 * 240, "a point every 1.5 degrees");
      assert.equal(right.length, 2 * 240);
      const amp = 0.16 + (0.156 * i) / 25;
      const phase = (i * Math.PI) / 26;
      for (let k = 0; k < 240; k += 7) {
        const t = ((1.5 * k) * Math.PI) / 180;
        const r = 100 * (0.62 + amp * Math.sin(3 * t + phase));
        const dr = 100 * amp * 3 * Math.cos(3 * t + phase);
        const x = 100 + r * Math.cos(t);
        const y = 100 + r * Math.sin(t);
        const tx = dr * Math.cos(t) - r * Math.sin(t);
        const ty = dr * Math.sin(t) + r * Math.cos(t);
        const len = Math.hypot(tx, ty);
        const half = (weight * (0.18 + 1.05 * Math.pow(0.5 + 0.5 * Math.sin(3 * t + phase), 2.2))) / 2;
        const want = { left: [x + (-ty / len) * half, y + (tx / len) * half], right: [x - (-ty / len) * half, y - (tx / len) * half] };
        for (const [side, got] of [["left", left], ["right", right]]) {
          assert.ok(Math.abs(got[2 * k] - want[side][0]) < 0.02 && Math.abs(got[2 * k + 1] - want[side][1]) < 0.02, `line ${String(i)} ${side} point ${String(k)}: ${String(got[2 * k])},${String(got[2 * k + 1])} is not ${want[side].map((n) => n.toFixed(2)).join(",")}`);
          checked += 1;
        }
      }
    });
    assert.ok(checked > 26 * 30, `only ${String(checked)} sample points were compared`);
  }
});

test("the_band_follows_the_designs_rule", async () => {
  const { band } = await picture();
  const rows = [...band({ step: 10, height: 110 }).matchAll(/<path d="M(-?[\d.]+) ([\d.]+)H([\d.]+)" stroke-width="([\d.]+)" stroke-dasharray="0 10" stroke-linecap="round"\/>/g)];
  assert.equal(rows.length, 11, "110 px tall at 10 px a row");
  rows.forEach((m, j) => {
    const radius = 5 * 1.45 * Math.pow((j + 1) / 11, 1.3);
    assert.equal(Number(m[1]), j % 2 === 0 ? 0 : 5, `row ${String(j)} offset`);
    assert.equal(Number(m[2]), j * 10 + 5, `row ${String(j)} height`);
    assert.ok(Number(m[3]) >= 1280 + 10, "the row runs past the right edge");
    assert.ok(Math.abs(Number(m[4]) - 2 * radius) < 0.011, `row ${String(j)}: dots of diameter ${m[4]}, not ${(2 * radius).toFixed(2)}`);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Which release the page offers

test("deploy_build_hashes_the_real_installer", async () => {
  const github = fakeGithub();
  const token = `MU-token-${randomBytes(6).toString("hex")}`;
  const { outDir, github: used } = await build(choose(TAG), github, token);
  const page = readFileSync(join(outDir, "index.html"), "utf8");
  const fingerprint = sha256(INSTALLER_BYTES);
  // the fingerprint on the page, in groups of eight, is the hash of the bytes the storage served
  const groups = [...page.matchAll(/<span class="fp-group">([0-9a-f]{8})<\/span>/g)].map((m) => m[1]);
  assert.equal(groups.length, 8, "eight groups of eight");
  assert.equal(groups.join(""), fingerprint);
  // and the PowerShell line carries it in capitals with the real file name
  assert.ok(visibleText(page).includes(`(Get-FileHash -LiteralPath "$HOME\\Downloads\\${INSTALLER}").Hash -eq "${fingerprint.toUpperCase()}"`));
  // size, date and version come from the release and the bytes
  const size = `${(Math.round(INSTALLER_BYTES.length / 100_000) / 10).toFixed(1)} MB`;
  assert.ok(visibleText(page).includes(`Version ${VERSION} · ${size} · 8 December 2026 · Release notes`), `the version line is wrong: ${visibleText(page).slice(0, 600)}`);
  // the installer and its sidecar were taken from the public tag-and-filename address the buttons use (finding 2), never
  // from the API's asset-by-id address, and no request but the API's own carried the token (finding 10)
  assert.ok(used.calls.includes(`${GITHUB}/releases/download/${TAG}/${INSTALLER}`), "the installer was downloaded from the public address");
  assert.ok(used.calls.includes(`${GITHUB}/releases/download/${TAG}/${INSTALLER}.sha256`), "the sidecar too");
  assert.deepEqual(used.calls.filter((url) => url.includes("/releases/assets/")), [], "the API's asset address was not used");
  const withToken = used.seen.filter((c) => JSON.stringify(c.headers).includes(token));
  assert.ok(withToken.length >= 1 && withToken.every((c) => new URL(c.url).host === "api.github.com"), "the token went to the API and nowhere else");
  const storage = used.seen.filter((c) => new URL(c.url).host.endsWith("githubusercontent.com"));
  assert.equal(storage.length, 2, "the two files were fetched from storage");
  assert.ok(used.seen.filter((c) => new URL(c.url).host !== "api.github.com").every((c) => c.headers.authorization === undefined), "no credentials left api.github.com");
  // the guide shows the same line
  assert.ok(visibleText(readFileSync(join(outDir, "guide/index.html"), "utf8")).includes(fingerprint.toUpperCase()));
});

test("the_public_address_is_what_is_hashed", async () => {
  // The API's asset address serves a consistent genuine pair; the public address (the one the buttons use) serves other bytes.
  // Hashing through the API would build the page; the build must refuse because it never looked there.
  const other = Buffer.concat([INSTALLER_BYTES, Buffer.from("MU-swapped")]);
  await refused(
    choose(TAG),
    fakeGithub((s) => {
      s.apiInstaller = INSTALLER_BYTES;
      s.apiSidecar = sidecarFor(INSTALLER_BYTES);
      s.installer = other;
      s.release.assets[0].size = INSTALLER_BYTES.length;
    }),
    /size|fingerprint|sidecar/i,
  );
  // and with a decoy at the API address and the genuine pair at the public address, the page carries the public bytes' hash
  const { outDir } = await build(choose(TAG), fakeGithub((s) => (s.apiInstaller = other)));
  assert.ok(read(outDir, "index.html").includes(sha256(INSTALLER_BYTES).slice(0, 8)));
});

test("a_download_redirect_goes_only_to_githubs_release_storage", async () => {
  // finding 10: any other https host is refused before it is fetched
  for (const foreign of ["https://downloads.example.invalid/MU", "https://release-assets.githubusercontent.com.example.invalid/MU", "https://githubusercontent.com/MU", "https://evil-release-assets.githubusercontent.com/MU"]) {
    const github = fakeGithub((s) => (s.storage = foreign));
    await refused(choose(TAG), github, /storage|host|not allowed/i);
    assert.equal(github.calls.some((url) => url.startsWith(foreign)), false, `${foreign} was fetched`);
  }
  // the hosts GitHub's release downloads use are accepted
  for (const host of ["https://release-assets.githubusercontent.com/MU", "https://objects.githubusercontent.com/MU"]) {
    const built = await build(choose(TAG), fakeGithub((s) => (s.storage = host)));
    assert.ok(existsSync(join(built.outDir, "index.html")), host);
  }
});

test("a_second_tagged_release_fills_its_own_page", async () => {
  // finding 14: another version, file name, size, date and digest; nothing of the first fixture may appear
  const github = fakeGithub(() => {}, { tag: TAG2, bytes: INSTALLER2_BYTES, published: "2027-03-02T23:59:59Z" });
  const { outDir } = await build(choose(TAG2), github);
  const page = read(outDir, "index.html");
  const text = visibleText(page);
  const size = `${(Math.round(INSTALLER2_BYTES.length / 100_000) / 10).toFixed(1)} MB`;
  assert.ok(text.includes(`Version ${VERSION2} · ${size} · 2 March 2027 · Release notes`), text.slice(0, 500));
  assert.ok(text.includes(`(Get-FileHash -LiteralPath "$HOME\\Downloads\\${INSTALLER2}").Hash -eq "${sha256(INSTALLER2_BYTES).toUpperCase()}"`));
  for (const file of PAGES) {
    const html = read(outDir, file);
    assert.equal(html.includes(VERSION), false, `${file} still names the first fixture's version`);
    assert.equal(html.includes(sha256(INSTALLER_BYTES)), false);
  }
  const buttons = tags(page).filter((t) => t.name === "a" && t.attrs.href?.includes("/releases/download/"));
  assert.deepEqual(buttons.map((b) => b.attrs.href), [`${GITHUB}/releases/download/${TAG2}/${INSTALLER2}`, `${GITHUB}/releases/download/${TAG2}/${INSTALLER2}`]);
  assert.ok(tags(page).some((t) => t.name === "a" && t.attrs.href === `${GITHUB}/releases/tag/${TAG2}`));
  const guide = visibleText(read(outDir, "guide/index.html"));
  assert.ok(guide.includes(`PowerShell line to check the file, for version ${VERSION2}`));
  // the certificate identity pins the workflow file on main (--signer-workflow cannot be combined with it, and has no ref)
  assert.ok(guide.includes(`gh attestation verify "$HOME\\Downloads\\${INSTALLER2}" --repo ${REPO} --cert-identity "${IDENTITY}" --source-ref refs/heads/main`));
  assert.ok(guide.includes(`gh attestation verify $f --repo ${REPO} --cert-identity "${IDENTITY}" --source-ref refs/heads/main`));
  assert.ok(guide.includes(`$f = Read-Host "Full path of the downloaded file" (Get-FileHash -LiteralPath $f).Hash -eq "${sha256(INSTALLER2_BYTES).toUpperCase()}"`));
  assert.equal(guide.includes("--signer-workflow"), false);
  // the checked-in release.json is one of the two supported shapes (the first release's change will replace the null)
  const { readReleaseChoice } = await lib();
  const choice = readReleaseChoice(readFileSync(join(SITE, "release.json"), "utf8"));
  assert.ok(choice.tag === null || /^v\d+\.\d+\.\d+$/.test(choice.tag));
});

/** Every file under `dir`, as sorted relative paths with forward slashes. */
function walk(dir, base = dir) {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name), base) : [relative(base, join(dir, e.name)).replaceAll("\\", "/")]))
    .sort();
}

const EXPECTED_FILES = ["404.html", "_headers", "fonts/LICENSE-geist-mono.txt", "fonts/LICENSE-geist.txt", "fonts/geist-latin-wght-normal.woff2", "fonts/geist-mono-latin-wght-normal.woff2", "guide/index.html", "index.html", "styles.css"];

test("only_the_expected_files_are_copied_and_each_must_be_a_regular_file", async () => {
  // finding 13: exactly two fonts and two licences; an extra file is not published; a missing file or a link is refused
  const { buildSite } = await lib();
  const extra = siteWith('{"tag": null}\n');
  writeFileSync(join(extra.siteDir, "fonts", "extra.html"), "<p>MU</p>");
  writeFileSync(join(extra.siteDir, "extra.html"), "<p>MU</p>");
  mkdirSync(join(extra.siteDir, "more"));
  writeFileSync(join(extra.siteDir, "more", "x.txt"), "MU");
  await buildSite({ siteDir: extra.siteDir, outDir: extra.outDir, fetch: fakeGithub().fetch });
  assert.deepEqual(walk(extra.outDir), EXPECTED_FILES);

  const none = fakeGithub();
  for (const file of ["fonts/LICENSE-geist.txt", "fonts/LICENSE-geist-mono.txt", "fonts/geist-latin-wght-normal.woff2", "fonts/geist-mono-latin-wght-normal.woff2", "styles.css", "_headers", "index.html", "guide/index.html", "404.html"]) {
    await refused('{"tag": null}\n', none, /site\/.*(missing|regular)/i, (siteDir) => rmSync(join(siteDir, ...file.split("/")))).catch((error) => {
      error.message = `${file} missing: ${error.message}`;
      throw error;
    });
  }
  // a folder where a file belongs
  await refused('{"tag": null}\n', none, /regular|missing/i, (siteDir) => {
    rmSync(join(siteDir, "fonts", "LICENSE-geist.txt"));
    mkdirSync(join(siteDir, "fonts", "LICENSE-geist.txt"));
  });
  // the site folder itself as a junction to another complete tree: everything below it would pass, so the root is checked first
  const tree = siteWith('{"tag": null}\n');
  const linked = join(tree.root, "linked-site");
  symlinkSync(tree.siteDir, linked, "junction");
  await assert.rejects(
    () => buildSite({ siteDir: linked, outDir: tree.outDir, fetch: none.fetch }),
    (error) => /site folder|regular folder|link/i.test(error.message) && error.name !== "AssertionError",
  );
  assert.equal(existsSync(tree.outDir), false, "a linked site folder leaves no output");
  assert.deepEqual(none.calls, [], "and nothing was asked of GitHub");
  // a link: the fonts folder as a junction to a folder outside the site (a link needs no privilege), and a file symlink where
  // this account may make one; at least the junction must have run
  const outside = tempDir("outside-");
  for (const file of EXPECTED_FILES.filter((f) => f.startsWith("fonts/"))) writeFileSync(join(outside, file.slice(6)), "MU-outside");
  await refused('{"tag": null}\n', none, /regular|link|missing/i, (siteDir) => {
    rmSync(join(siteDir, "fonts"), { recursive: true });
    symlinkSync(outside, join(siteDir, "fonts"), "junction");
  });
  let fileLink = "not tried";
  try {
    await refused('{"tag": null}\n', none, /regular|link|missing/i, (siteDir) => {
      writeFileSync(join(outside, "secret.txt"), "MU-secret");
      rmSync(join(siteDir, "fonts", "LICENSE-geist.txt"));
      symlinkSync(join(outside, "secret.txt"), join(siteDir, "fonts", "LICENSE-geist.txt"), "file");
    });
    fileLink = "refused";
  } catch (error) {
    if (error?.code === "EPERM" || error?.code === "EACCES") fileLink = "this account may not make file links";
    else throw error;
  }
  console.log(`# file symlink case: ${fileLink}`);
});

test("the_powershell_line_takes_the_path_literally", async () => {
  // finding 7: Get-FileHash -LiteralPath, so brackets in a folder name are not a wildcard; the line is built and shown unchanged
  const { powershellLine, renderTemplate } = await lib();
  const path = String.raw`$HOME\Downloads\[MU] files\Petalock_0.1.0_x64-setup.exe`;
  const line = powershellLine({ path, fingerprint: "AB".repeat(32) });
  assert.equal(line, `(Get-FileHash -LiteralPath "${path}").Hash -eq "${"AB".repeat(32)}"`);
  const html = renderTemplate('<textarea id="x">{{ps_line}}</textarea>', { text: { ps_line: line }, raw: {} }, "release");
  assert.equal(decode(/<textarea[^>]*>([\s\S]*)<\/textarea>/.exec(html)[1]), line);
  assert.equal(/Get-FileHash\s+"/.test(line), false, "never the wildcard -Path form");
});

test("the_two_line_alternative_takes_the_path_as_data", async (t) => {
  // correction 3: for a file saved elsewhere or renamed, the path is typed once, at a prompt, and used for both checks
  const { powershellAlternative, attestationAlternative, attestationLine, renderTemplate } = await lib();
  const fingerprint = "AB".repeat(32);
  const alt = powershellAlternative({ fingerprint });
  assert.equal(alt, `$f = Read-Host "Full path of the downloaded file"\n(Get-FileHash -LiteralPath $f).Hash -eq "${fingerprint}"`);
  const html = renderTemplate('<textarea id="x">{{ps_alt}}</textarea>', { text: { ps_alt: alt }, raw: {} }, "release");
  assert.equal(decode(/<textarea[^>]*>([\s\S]*)<\/textarea>/.exec(html)[1]), alt, "the rendered box holds the two lines unchanged");
  assert.equal(attestationAlternative(), `gh attestation verify $f --repo ${REPO} --cert-identity "${IDENTITY}" --source-ref refs/heads/main`);
  assert.equal(attestationLine(INSTALLER), `gh attestation verify "$HOME\\Downloads\\${INSTALLER}" --repo ${REPO} --cert-identity "${IDENTITY}" --source-ref refs/heads/main`);
  assert.equal(attestationLine(INSTALLER).includes("--signer-workflow"), false, "the signer is pinned by the certificate identity, with its ref, alone");

  if (process.platform !== "win32") return t.skip("Windows PowerShell is needed to run the lines");
  // and the two lines, run in Windows PowerShell: two real files, the one at the path typed and a decoy elsewhere; folder names
  // with brackets, a $( ) and a backtick are data, never parsed
  const dir = tempDir("alt-");
  const odd = join(dir, "[MU] a [1] $(Write-Output boom) `tick");
  mkdirSync(odd);
  const chosen = join(odd, "chosen file.bin");
  const decoy = join(dir, "decoy.bin");
  writeFileSync(chosen, "MU chosen bytes");
  writeFileSync(decoy, "MU decoy bytes");
  // Windows PowerShell 5.1 by its full path, without the module path of the PowerShell 7 that may have started node (CI's
  // default shell): 5.1 would autoload 7's Microsoft.PowerShell.Utility for Get-FileHash and fail; it works its own out
  const exe = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const env = { ...process.env };
  delete env.PSModulePath;
  const run = (typed, lines) => {
    const encoded = Buffer.from(lines.replace(/\n/g, "; "), "utf16le").toString("base64");
    const r = spawnSync(exe, ["-NoProfile", "-EncodedCommand", encoded], { input: `${typed}\n`, encoding: "utf8", env, windowsHide: true, timeout: 60_000 });
    const out = `${r.stdout}`.replace(/^Full path of the downloaded file:\s*/, "").trim();
    // PowerShell's own errors (CLIXML on stderr) beside the output, so a failure says why
    const errors = `${r.stderr}`.replace(/_x000D__x000A_/g, "\n").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    return { out, why: `status ${r.status}${r.error ? `; spawn: ${r.error.code ?? r.error.message}` : ""}; stderr: ${errors.slice(-1500)}` };
  };
  const right = powershellAlternative({ fingerprint: sha256(readFileSync(chosen)).toUpperCase() });
  const ok = run(chosen, right);
  assert.match(ok.out, /True$/, `the file at the typed path matches its own digest (${ok.why})`);
  const other = run(decoy, right);
  assert.match(other.out, /False$/, `another file does not (${other.why})`);
  // (had `$( )` in the folder name been run, the path would not name the file and the first check would print False)
});

test("a_swapped_or_malformed_release_is_refused", async () => {
  const other = Buffer.concat([INSTALLER_BYTES, Buffer.from("x")]);
  const good = INSTALLER_BYTES;
  const hash = sha256(good);
  const withAssets = (s, edit) => edit(s.release.assets);
  const scenarios = {
    "a sidecar for other bytes": [(s) => (s.sidecar = sidecarFor(other)), /fingerprint|sidecar|hash/i],
    "a hash of 63 characters": [(s) => (s.sidecar = `${hash.slice(1)}  ${INSTALLER}\n`), /sidecar/i],
    "a hash of 65 characters": [(s) => (s.sidecar = `${hash}0  ${INSTALLER}\n`), /sidecar/i],
    "a hash that is not hex": [(s) => (s.sidecar = `${"g".repeat(64)}  ${INSTALLER}\n`), /sidecar/i],
    "a sidecar naming another file": [(s) => (s.sidecar = sidecarFor(good, "Petalock_0.1.1_x64-setup.exe")), /sidecar/i],
    "a sidecar with a path in the name": [(s) => (s.sidecar = sidecarFor(good, `dist/${INSTALLER}`)), /sidecar/i],
    "a second line in the sidecar": [(s) => (s.sidecar = `${sidecarFor(good)}${sidecarFor(other)}`), /sidecar/i],
    "an empty sidecar": [(s) => (s.sidecar = ""), /sidecar/i],
    "text after the file name": [(s) => (s.sidecar = `${hash}  ${INSTALLER} extra\n`), /sidecar/i],
    "one space instead of two": [(s) => (s.sidecar = `${hash} ${INSTALLER}\n`), /sidecar/i],
    "two installers of one name": [(s) => withAssets(s, (a) => a.push(asset(1003, INSTALLER, good.length))), /installer/i],
    "a second installer of another name": [(s) => withAssets(s, (a) => a.push(asset(1003, "Petalock_0.1.1_x64-setup.exe", good.length))), /installer/i],
    "an installer with the wrong name": [(s) => withAssets(s, (a) => (a[0] = asset(1001, "Petalock_0.1.1_x64-setup.exe", good.length))), /installer/i],
    "no installer": [(s) => withAssets(s, (a) => a.splice(0, 1)), /installer/i],
    "no sidecar": [(s) => withAssets(s, (a) => a.splice(1, 1)), /sidecar/i],
    "two sidecars": [(s) => withAssets(s, (a) => a.push(asset(1004, `${INSTALLER}.sha256`, 10))), /sidecar/i],
    "a wrong tag in the answer": [(s) => (s.release.tag_name = "v0.1.1"), /tag/i],
    "a draft": [(s) => (s.release.draft = true), /draft|published/i],
    "no publish date": [(s) => (s.release.published_at = null), /published/i],
    "an unfinished upload": [(s) => (s.release.assets[0].state = "starter"), /upload|state/i],
    "a size that is not the bytes": [(s) => (s.release.assets[0].size = good.length + 1), /size/i],
    "a release GitHub does not have": [(s) => (s.apiStatus = 404), /release|404/i],
    "storage that answers an error": [(s) => (s.storageStatus = 500), /download|500/i],
    "storage over plain http": [(s) => (s.storage = "http://release-assets.githubusercontent.com/MU"), /https/i],
    "storage on a foreign https host": [(s) => (s.storage = "https://downloads.example.invalid/MU"), /storage|host/i],
    // finding 11: the extra installer may be any Windows installer format
    "a setup exe and an msi": [(s) => withAssets(s, (a) => a.push(asset(1005, "Petalock_0.1.0_x64.msi", good.length))), /installer/i],
    "a setup exe and an msix": [(s) => withAssets(s, (a) => a.push(asset(1006, "Petalock_0.1.0_x64.MSIX", good.length))), /installer/i],
    "a setup exe and an appx": [(s) => withAssets(s, (a) => a.push(asset(1007, "Petalock_0.1.0_x64.appx", good.length))), /installer/i],
    "a setup exe and an appinstaller": [(s) => withAssets(s, (a) => a.push(asset(1009, "Petalock.appinstaller", 400))), /installer/i],
    "a setup exe and an msixbundle": [(s) => withAssets(s, (a) => a.push(asset(1008, "Petalock_0.1.0.msixbundle", good.length))), /installer/i],
    // finding 12: a sidecar whose listed size is not its bytes, and a GitHub digest that is not the bytes' hash
    "a sidecar of another size than listed": [(s) => (s.release.assets[1].size = 5), /size/i],
    "an installer digest that is not the bytes' hash": [(s) => (s.release.assets[0].digest = `sha256:${sha256(other)}`), /digest/i],
    "a sidecar digest that is not the sidecar's hash": [(s) => (s.release.assets[1].digest = `sha256:${sha256(other)}`), /digest/i],
    "a digest in a shape that is not sha256": [(s) => (s.release.assets[0].digest = "md5:abc"), /digest/i],
    // finding 19: a date that JavaScript would quietly move to another day
    "an impossible publish date": [(s) => (s.release.published_at = "2026-02-31T09:30:00Z"), /published/i],
    "a publish date with a zone offset": [(s) => (s.release.published_at = "2026-12-08T09:30:00+02:00"), /published/i],
  };
  let refusedCount = 0;
  for (const [what, [edit, message]] of Object.entries(scenarios)) {
    await refused(choose(TAG), fakeGithub(edit), message).catch((error) => {
      error.message = `${what}: ${error.message}`;
      throw error;
    });
    refusedCount += 1;
  }
  assert.ok(refusedCount >= 35, `only ${String(refusedCount)} refusals were tried`);
  // and the same harness lets the good release through, so a refusal above is about the fault and not the harness
  const control = await build(choose(TAG));
  assert.ok(existsSync(join(control.outDir, "index.html")));
  // the matching digests GitHub supplies are accepted, and so is a sidecar in capitals (finding 20: PowerShell prints them so;
  // the file name and the single line stay strict, which the refusals above show)
  const agreeing = await build(
    choose(TAG),
    fakeGithub((s) => {
      s.release.assets[0].digest = `sha256:${hash}`;
      s.sidecar = `${hash.toUpperCase()}  ${INSTALLER}\n`;
      s.release.assets[1].digest = `sha256:${sha256(s.sidecar)}`;
    }),
  );
  // the eight displayed groups, joined, are the computed digest in lower case (compared whole: no case-based negative check,
  // which a digest whose first characters are all digits would defeat)
  const shown = [...read(agreeing.outDir, "index.html").matchAll(/<span class="fp-group">([0-9a-fA-F]{8})<\/span>/g)].map((m) => m[1]);
  assert.equal(shown.length, 8);
  assert.equal(shown.join(""), hash);
  // a release.json that names no real tag shape is refused before GitHub is asked
  for (const bad of ["v1.2", "1.2.3", "v1.2.3-rc1", "v01.2.3", "../v1.2.3", "v1.2.3 ", "V1.2.3", "v1.2.3\n"]) {
    const github = fakeGithub();
    await refused(`{"tag": ${JSON.stringify(bad)}}`, github, /tag/i);
    assert.deepEqual(github.calls, [], `${bad}: GitHub was asked for a tag of the wrong shape`);
  }
});

test("coming_soon_only_from_an_explicit_null", async () => {
  const { soon, release } = await built();
  assert.equal(soon.github.calls.length, 0, "no tag, no question to GitHub");
  const page = read(soon.outDir, "index.html");
  const text = visibleText(page);
  assert.ok(text.includes("Coming soon"));
  assert.ok(text.includes("The first preview isn't out yet."));
  assert.ok(text.includes("The fingerprint appears here with the first release."));
  assert.ok(text.includes(`(Get-FileHash -LiteralPath "$HOME\\Downloads\\Petalock_<version>_x64-setup.exe").Hash -eq "<fingerprint>"`));
  assert.equal(page.includes("/releases/download/"), false, "no download address on the Coming soon page");
  // "Coming soon" is a label, not a link or a button
  const soonLabels = [...page.matchAll(/<(\w+)[^>]*>\s*Coming soon\s*<\/\1>/g)];
  assert.equal(soonLabels.length, 2, "both download buttons become the label");
  assert.ok(soonLabels.every((m) => m[1] === "span"), "the label is plain text");
  // the build with a tag differs
  assert.ok(visibleText(read(release.outDir, "index.html")).includes("Download for Windows"));
  assert.equal(visibleText(read(release.outDir, "index.html")).includes("Coming soon"), false);

  // the only file that gives this page is exactly {"tag": null}; everything else stops the build with no output
  const never = fakeGithub();
  const bad = {
    "a missing file": null,
    "an empty file": "",
    "only white space": " \n",
    "an empty object": "{}",
    "an empty tag": '{"tag": ""}',
    "the word null": '{"tag": "null"}',
    "false": '{"tag": false}',
    "zero": '{"tag": 0}',
    "an extra key": '{"tag": null, "other": 1}',
    "an extra key first": '{"other": 1, "tag": null}',
    "another key": '{"version": null}',
    "a repeated key": '{"tag": "v0.1.0", "tag": null}',
    "a repeated key the other way": '{"tag": null, "tag": "v0.1.0"}',
    "an array": "[null]",
    "a bare null": "null",
    "not JSON": "tag: null",
    "cut short": '{"tag": nul',
    "two objects": '{"tag": null}{"tag": null}',
    "a comment": '{"tag": null} // soon',
  };
  let count = 0;
  for (const [what, text] of Object.entries(bad)) {
    await refused(text, never).catch((error) => {
      error.message = `${what}: ${error.message}`;
      throw error;
    });
    count += 1;
  }
  assert.ok(count >= 18);
  assert.deepEqual(never.calls, [], "nothing was asked of GitHub");
  // (the checked-in release.json is checked to be a supported shape in a_second_tagged_release_fills_its_own_page: the
  // change that selects the first release must not turn this test red)
});

test("download_link_is_the_fixed_github_release_address", async () => {
  // The answer carries an address of an attacker's choosing; the page must not use it.
  const github = fakeGithub((s) => {
    s.release.assets[0].browser_download_url = "https://downloads.example.invalid/MU/Petalock.exe";
    s.release.html_url = "https://example.invalid/MU/release";
  });
  const { outDir } = await build(choose(TAG), github);
  const want = `${GITHUB}/releases/download/${TAG}/${INSTALLER}`;
  const page = read(outDir, "index.html");
  const buttons = tags(page).filter((t) => t.name === "a" && t.attrs.href?.includes("/releases/download/"));
  assert.equal(buttons.length, 2, "the opening's button and step 1's");
  for (const b of buttons) assert.equal(b.attrs.href, want);
  for (const file of PAGES) assert.equal(read(outDir, file).includes("example.invalid"), false, `${file} carries the planted address`);
  assert.equal(visibleText(page).includes(INSTALLER), true);
});

// ---------------------------------------------------------------------------------------------------------------------
// Nothing from elsewhere

/**
 * Reads every page and the style sheet of a built site and returns what it counted and every fault: no script, no handler,
 * no style attribute or element, no `src`-like attribute, no `@import`, no `url()` but the two fonts of this site, no
 * protocol-relative address, no `link` but this site's style sheet; links to other sites are only to this repository.
 */
function checkNothingFromElsewhere(dir) {
  const faults = [];
  const counted = { tags: 0, attributes: 0, urls: 0, pages: 0 };
  for (const file of PAGES) {
    counted.pages += 1;
    const html = read(dir, file);
    if (/\/\/[A-Za-z0-9.-]+\.[a-z]/.test(html.replace(/https:\/\/github\.com\/sumguywhowantstobuild\/petalock/g, ""))) {
      faults.push(`${file}: an address to another site in the text`);
    }
    for (const t of tags(html)) {
      if (t.closing) continue;
      counted.tags += 1;
      if (["script", "iframe", "object", "embed", "base", "form", "style", "img", "audio", "video", "source", "track", "frame", "frameset", "applet", "portal", "svg:use"].includes(t.name)) faults.push(`${file}: a <${t.name}>`);
      if (t.name === "meta" && /refresh|content-security|set-cookie/i.test(`${t.attrs["http-equiv"] ?? ""}`)) faults.push(`${file}: a meta ${t.attrs["http-equiv"]}`);
      if (t.name === "use" || t.name === "image" || t.name === "foreignobject") faults.push(`${file}: an svg <${t.name}>`);
      if (t.name === "link" && !(t.attrs.rel === "stylesheet" && t.attrs.href === "/styles.css")) faults.push(`${file}: a <link> other than the site's style sheet: ${JSON.stringify(t.attrs)}`);
      for (const [name, value] of Object.entries(t.attrs)) {
        counted.attributes += 1;
        if (/^on/.test(name)) faults.push(`${file}: an ${name} handler`);
        if (["style", "src", "srcset", "poster", "data", "ping", "background", "manifest", "formaction", "action", "xlink:href", "imagesrcset", "integrity"].includes(name)) faults.push(`${file}: a ${name} attribute on <${t.name}>`);
        if (/url\s*\(/i.test(value) || /^\s*(?:javascript|data|blob|file|ftp|http):/i.test(value) || /^\s*\/\//.test(value)) faults.push(`${file}: ${name}="${value.slice(0, 50)}" on <${t.name}>`);
        if (name === "href") {
          counted.urls += 1;
          const ok = value.startsWith("#") || value.startsWith("/") || (t.name === "a" && (value === GITHUB || value.startsWith(`${GITHUB}/`)));
          if (!ok) faults.push(`${file}: a link to ${value.slice(0, 60)}`);
        }
      }
    }
  }
  const css = read(dir, "styles.css");
  if (/@import/i.test(css)) faults.push("styles.css: an @import");
  if (/image-set|expression\s*\(|-moz-binding|behavior\s*:/i.test(css)) faults.push("styles.css: an image-set or script-like value");
  if (/\/\/[A-Za-z0-9.-]+\.[a-z]/.test(css)) faults.push("styles.css: an address to another site");
  for (const m of css.matchAll(/url\(\s*([^)]*?)\s*\)/gi)) {
    counted.urls += 1;
    if (!/^["']?\/fonts\/[a-z0-9-]+\.woff2["']?$/.test(m[1])) faults.push(`styles.css: url(${m[1].slice(0, 60)})`);
  }
  for (const m of css.matchAll(/src\s*:[^;}]*/gi)) {
    if (!/^src\s*:\s*url\(["']?\/fonts\/[a-z0-9-]+\.woff2["']?\)\s*format\(["']woff2["']\)\s*$/.test(m[0].trim())) faults.push(`styles.css: a font source other than this site's: ${m[0].slice(0, 80)}`);
  }
  return { counted, faults };
}

test("site_loads_nothing_from_elsewhere", async () => {
  const { release, soon } = await built();
  for (const which of [release, soon]) {
    const { counted, faults } = checkNothingFromElsewhere(which.outDir);
    assert.deepEqual(faults, []);
    assert.equal(counted.pages, 3);
    assert.ok(counted.tags > 300 && counted.attributes > 300 && counted.urls > 20, `the check looked at too little: ${JSON.stringify(counted)}`);
  }
  // the check fires on a planted fault: an outside font in the style sheet, then an outside script and an inline style
  const planted = tempDir();
  cpSync(release.outDir, planted, { recursive: true });
  const css = read(planted, "styles.css");
  const fonts = css.match(/src\s*:\s*url\(["']?\/fonts\/[^)]*\)/g);
  assert.ok(fonts && fonts.length >= 2, "the style sheet loads the two fonts");
  writeFileSync(join(planted, "styles.css"), css.replace(fonts[0], 'src:url("https://fonts.example.invalid/geist.woff2")'));
  const first = checkNothingFromElsewhere(planted);
  assert.ok(first.faults.length >= 1 && first.faults.some((f) => /fonts\.example\.invalid|font source|another site/.test(f)), `the outside font was not caught: ${JSON.stringify(first.faults)}`);
  writeFileSync(join(planted, "styles.css"), css);
  assert.deepEqual(checkNothingFromElsewhere(planted).faults, [], "undoing the fault is clean again");
  const page = read(planted, "index.html");
  // nosemgrep: javascript.lang.security.audit.unknown-value-with-script-tag.unknown-value-with-script-tag -- a planted fault in a temporary copy, which the check must catch
  writeFileSync(join(planted, "index.html"), page.replace("</body>", '<script src="https://x.example.invalid/a.js"></script><p style="color:red">x</p></body>'));
  const second = checkNothingFromElsewhere(planted);
  assert.ok(second.faults.some((f) => /<script>/.test(f)) && second.faults.some((f) => /style attribute/.test(f)) && second.faults.some((f) => /src attribute/.test(f)), JSON.stringify(second.faults));
  // the picture and the band are drawn in the page, not fetched
  assert.ok(counted_svg(read(release.outDir, "index.html")) >= 3, "the download page draws its picture, its band and two marks inline");
});

/** How many inline `<svg>` a page has. */
function counted_svg(html) {
  return tags(html).filter((t) => t.name === "svg" && !t.closing).length;
}

test("site_headers_are_exact", async () => {
  const { release } = await built();
  const rules = parseHeaders(read(SITE, "_headers"));
  assert.deepEqual(rules, [
    {
      path: "/*",
      headers: [
        ["Content-Security-Policy", "default-src 'none'; style-src 'self'; img-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"],
        ["Strict-Transport-Security", "max-age=31536000"],
        ["X-Content-Type-Options", "nosniff"],
        ["Referrer-Policy", "no-referrer"],
      ],
    },
  ]);
  assert.equal(read(release.outDir, "_headers"), read(SITE, "_headers"), "the build ships the file as it is");
  // a changed value, an added header and a second rule each break the equality the test above relies on
  for (const text of [read(SITE, "_headers").replace("max-age=31536000", "max-age=31536001"), `${read(SITE, "_headers")}  X-Frame-Options: DENY\n`, `${read(SITE, "_headers")}/guide/*\n  Cache-Control: no-store\n`]) {
    assert.notDeepEqual(parseHeaders(text), rules);
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// The words

const WORDS = {
  common: [
    "Early preview · Unsigned and not independently audited.",
    "Your secrets, in print only you can read.",
    "A password manager and file vault for Windows. Your vaults stay on your PC, encrypted.",
    "Made by Ariel Maningas. It’s unsigned, so your browser and Windows will warn you. Check the file before you open it.",
    "Windows 11, 64-bit",
    "An early preview, said plainly",
    "Unsigned Petalock has no code-signing certificate yet, so Windows can't tell who made the file. Your browser and Windows will warn you before it runs.",
    "Not independently audited No outside security firm has checked Petalock's code yet. The code is public, so anyone can read it.",
    "Three steps to install",
    "Get Petalock only from petalock.arielmaningas.com or github.com/sumguywhowantstobuild/petalock.",
    "Setup needs the internet only if your PC lacks Microsoft Edge WebView2, which Windows 11 includes: setup then gets it from Microsoft. Petalock has no online features: it sends nothing about you or your vaults anywhere.",
    "Check the file is ours Before you open it, check that the file you got is the one we published. Open PowerShell and paste this line (click in the box, press Ctrl+A, then Ctrl+C):",
    "PowerShell line to check the file",
    // correction 3: a path typed once, as data, instead of an edited string
    "If you saved it somewhere else, or your browser renamed it (for example with “(1)” at the end), use these two lines instead. Paste both, then type or paste the file’s full path when PowerShell asks, without quotation marks.",
    "PowerShell lines for a file saved elsewhere or renamed",
    "It should print True.",
    "If it prints False, stop. Don't open the file: delete it and download it again from this page.",
    "See the fingerprint",
    "Open it Because the file is unsigned and new, you'll see warnings. The exact words may differ on your PC.",
    // finding 4: the order is explicit: keep only for that notice, check the saved file, Run anyway only after True
    "Your browser may say the file isn't commonly downloaded. Choose to keep it, and only for that notice. Then check the saved file in step 2.",
    "Windows may show “Windows protected your PC”. Only after step 2 printed True, choose More info, then Run anyway, and only for that screen.",
    // correction 2: any form of administrator permission
    "Stop and delete the file if your browser or a security product says it found malware or a virus, or if Windows asks for administrator permission in any form (a password or a Yes/No prompt): setup never needs it.",
    "These warnings mean Windows doesn't know the file yet, not that it found something wrong. A fake copy would bring the same warnings, which is why checking the fingerprint matters.",
    "If Smart App Control is on, Windows may block Petalock with no Run anyway option. This preview can’t run on that PC until Petalock is signed; we don’t suggest turning Smart App Control off for it.",
    "What happens to your vaults",
    "Installing Petalock goes into your own user folder; no administrator needed. It makes no vault until you create one.",
    "Updating Install the new version over the old one. Your vaults, settings and “start with Windows” stay as they are. Petalock doesn’t update itself or tell you about new versions: check this page or the releases list.",
    "Uninstalling Removes the program and its temporary copies of opened files. Your vaults are never deleted, and nor are Petalock’s settings and list of vaults; the guide shows how to remove those too.",
    "Going back Older versions stay on the releases list. Setup lets you install one over a newer version, but going back hasn’t been tested: an older version may not open vaults or settings a newer one has changed, so keep a tested backup before you try. If a release is withdrawn, this page goes back to the last good one and the withdrawn release’s notes say why.",
    "Deleting a vault on purpose Petalock can't delete a vault for you yet. First note the vault's exact folder (in Petalock, choose Show in File Explorer). If you might want the vault back, make sure you have a tested backup you can restore. Then remove it from the list in Petalock, then delete that folder in File Explorer. Step by step in the guide.",
    "What you need Windows 11, 64-bit. Windows 10 (64-bit) should work but hasn't been tested. Setup needs the internet only if your PC lacks Microsoft Edge WebView2, which Windows 11 includes: setup then gets it from Microsoft. Petalock has no online features: it sends nothing about you or your vaults anywhere.",
    "No code signature (Authenticode or PGP), no package managers and no automatic updates in this preview: the fingerprint above is how you check a file (the guide also shows GitHub’s build record).",
    "Release notes · Older versions · Source code · Security policy",
    "Petalock is free and open source (MIT). Made by Ariel Maningas.",
  ],
  release: (v) => [
    "Download for Windows",
    `Version ${v.version} · ${v.size} · ${v.date} · Release notes`,
    `Download Version ${v.version} · ${v.size} · ${v.date}. Get Petalock only from`,
    `(Get-FileHash -LiteralPath "$HOME\\Downloads\\${INSTALLER}").Hash -eq "${v.fingerprint.toUpperCase()}"`,
    `$f = Read-Host "Full path of the downloaded file" (Get-FileHash -LiteralPath $f).Hash -eq "${v.fingerprint.toUpperCase()}"`,
  ],
  soon: [
    "Coming soon",
    "The first preview isn't out yet.",
    "The fingerprint appears here with the first release.",
    `(Get-FileHash -LiteralPath "$HOME\\Downloads\\Petalock_<version>_x64-setup.exe").Hash -eq "<fingerprint>"`,
    `$f = Read-Host "Full path of the downloaded file" (Get-FileHash -LiteralPath $f).Hash -eq "<fingerprint>"`,
  ],
  guide: [
    "Guide",
    // finding 8: before the install instructions, in both states
    "Petalock is an early preview: it is unsigned and has not been independently audited.",
    "Get Petalock only from petalock.arielmaningas.com or github.com/sumguywhowantstobuild/petalock.",
    "Windows 11, 64-bit is the only tested setup. Windows 10 (64-bit) should work but hasn't been tested.",
    "Every release lists the file's fingerprint. Paste the PowerShell line from the download page; it prints True when the file is ours.",
    // correction 3
    "If you saved the file somewhere other than Downloads, or your browser renamed it, use these two lines instead. Paste both, then type or paste the file’s full path when PowerShell asks, without quotation marks.",
    "If it prints False, stop and delete the file.",
    "For a file saved elsewhere or renamed, run this in the same PowerShell window right after the two lines above, so it checks the same file:",
    // finding 5, corrections 7 and 8
    "First note the vault's exact folder (in Petalock, choose Show in File Explorer). If you might want the vault back, make sure you have a tested backup you can restore. Then remove the vault from Petalock's list, then delete that folder in File Explorer. It usually goes to the Recycle Bin; a very large folder or some drives delete it for good, so if Windows says it will delete it permanently and you didn't expect that, cancel. If the deleted folder appears in the Recycle Bin, you can select that entry only and delete it permanently.",
    "release workflow on main",
    "if it reports anything else or fails, stop and delete the file",
    "No administrator password",
    "your own user folder",
    "quit it from its icon by the clock",
    "Retry and Cancel",
    "it never closes Petalock itself",
    // finding 4, on the guide
    "They mean Windows doesn't know the file yet, not that it found something wrong",
    "A matching fingerprint shows the file is the one we published. It does not mean no security product will object to it.",
    "Your browser may say the file isn't commonly downloaded: choose to keep it, and only for that notice. Then check the saved file (the section above). Windows may show “Windows protected your PC”: only after the check printed True, choose More info, then Run anyway, and only for that screen.",
    "Stop and delete the file if your browser or a security product says it found malware or a virus, or if Windows asks for administrator permission in any form (a password or a Yes/No prompt): setup never needs it.",
    "Smart App Control",
    "This preview can’t run on that PC until Petalock is signed",
    // finding 18
    "only when Microsoft Edge WebView2 is missing, to get it from Microsoft",
    "Microsoft installs a shared WebView2 Runtime that other apps use too; Petalock’s uninstall leaves it installed.",
    "If setup’s download fails, install Microsoft’s official “Evergreen Standalone” WebView2 Runtime from Microsoft’s website, then run setup again.",
    "What the WebView2 installer itself changes on the PC is Microsoft’s, not Petalock’s.",
    "Your vaults, settings and “start with Windows” stay as they are.",
    "Petalock doesn’t update itself",
    "Settings",
    "the program and the temporary copies of opened files go; your vaults stay",
    // finding 17
    "If the uninstaller says some opened copies of your files are still in use or could not be removed, close whatever holds them, then choose Retry. Cancel stops there and leaves Petalock installed. Some copies may already have been removed by then.",
    "Delete the application data",
    // finding 3, correction 1: the two prerequisites come before the uninstall steps; the deletion stays after
    "Before you uninstall, note where your vaults are: new vaults go in %USERPROFILE%\\Petalock Vaults\\, and a vault you made somewhere else stays there. Finish any restore that is in progress, because you need Petalock for both.",
    "Optionally, once the uninstall has finished, you can also remove Petalock’s own records by deleting the folder %LOCALAPPDATA%\\Petalock: it holds the settings, the list of vaults and the restore and output records, never the vaults.",
    "If the deleted folder appears in the Recycle Bin, you can select that entry only and delete it permanently",
    // finding 6
    "Older versions stay on the releases list. Each release lists its own installer and its own fingerprint (the .sha256 file on its page). Check the exact file you will open against that release's fingerprint, not against this page's",
    "going back hasn’t been tested",
    "Restart your PC and try again.",
    "icon by the clock",
    "Microsoft Edge WebView2 Runtime is installed",
    "Your vaults stay safe in their folders",
  ],
  // what only a release state or the Coming soon state says in the guide (findings 6, 7, 9)
  guideRelease: (v) => [
    `PowerShell line to check the file, for version ${v.version}`,
    `the PowerShell line above is for version ${v.version} only`,
    `(Get-FileHash -LiteralPath "$HOME\\Downloads\\${INSTALLER}").Hash -eq "${v.fingerprint.toUpperCase()}"`,
    `PowerShell lines for a file saved elsewhere or renamed, for version ${v.version}`,
    `$f = Read-Host "Full path of the downloaded file" (Get-FileHash -LiteralPath $f).Hash -eq "${v.fingerprint.toUpperCase()}"`,
    `gh attestation verify "$HOME\\Downloads\\${INSTALLER}" --repo ${REPO} --cert-identity "${IDENTITY}" --source-ref refs/heads/main`,
    `gh attestation verify $f --repo ${REPO} --cert-identity "${IDENTITY}" --source-ref refs/heads/main`,
  ],
  guideSoon: [
    "PowerShell line to check the file, for the first release",
    "the PowerShell line above is for the first release only",
    `(Get-FileHash -LiteralPath "$HOME\\Downloads\\Petalock_<version>_x64-setup.exe").Hash -eq "<fingerprint>"`,
    "PowerShell lines for a file saved elsewhere or renamed, for the first release",
    `$f = Read-Host "Full path of the downloaded file" (Get-FileHash -LiteralPath $f).Hash -eq "<fingerprint>"`,
    `gh attestation verify "$HOME\\Downloads\\Petalock_<version>_x64-setup.exe" --repo ${REPO} --cert-identity "${IDENTITY}" --source-ref refs/heads/main`,
    `gh attestation verify $f --repo ${REPO} --cert-identity "${IDENTITY}" --source-ref refs/heads/main`,
  ],
  notFound: [
    "404 · Page not found",
    "This page isn't here.",
    "The address may be mistyped, or the page has moved. Download Petalock only from this site or its GitHub releases.",
    "Go to the download page",
    "Read the guide",
  ],
};

/** The pinned words that a page does not hold (each compared as the design says), and how many were looked for. */
function missingWords(html, expected) {
  const text = visibleText(html);
  return { looked: expected.length, missing: expected.filter((words) => !text.includes(norm(words))) };
}

const releaseFacts = () => {
  const size = `${(Math.round(INSTALLER_BYTES.length / 100_000) / 10).toFixed(1)} MB`;
  return { version: VERSION, size, date: "8 December 2026", fingerprint: sha256(INSTALLER_BYTES) };
};

test("pages_say_what_the_design_says", async () => {
  const { release, soon } = await built();
  const facts = releaseFacts();
  const downloadRelease = read(release.outDir, "index.html");
  const downloadSoon = read(soon.outDir, "index.html");
  const guide = read(release.outDir, "guide/index.html");
  const guideSoon = read(soon.outDir, "guide/index.html");
  const notFound = read(release.outDir, "404.html");
  const checks = [
    [downloadRelease, [...WORDS.common, ...WORDS.release(facts)]],
    [downloadSoon, [...WORDS.common, ...WORDS.soon]],
    [guide, [...WORDS.guide, ...WORDS.guideRelease(facts)]],
    [guideSoon, [...WORDS.guide, ...WORDS.guideSoon]],
    [notFound, WORDS.notFound],
  ];
  let looked = 0;
  for (const [html, words] of checks) {
    const result = missingWords(html, words);
    assert.deepEqual(result.missing, [], "words of the design that the page does not carry");
    looked += result.looked;
  }
  assert.ok(looked >= 100, `only ${String(looked)} phrases were compared`);
  // the order of the warnings' instructions is part of the words (finding 4): keep, then check, then Run anyway, then stop
  const inOrder = (html, phrases, where) => {
    const text = visibleText(html);
    let at = -1;
    for (const p of phrases) {
      const found = text.indexOf(norm(p), at + 1);
      assert.ok(found > at, `${where}: "${p}" is missing or out of order`);
      at = found;
    }
  };
  const warningOrder = ["Choose to keep it, and only for that notice", "Then check the saved file in step 2", "Only after step 2 printed True, choose More info, then Run anyway", "Stop and delete the file if your browser or a security product"];
  inOrder(downloadRelease, warningOrder, "download");
  inOrder(downloadSoon, warningOrder, "download (soon)");
  const guideOrder = ["Petalock is an early preview", "Get Petalock only from", "Windows 11, 64-bit is the only tested setup", "No administrator password", "choose to keep it, and only for that notice", "only after the check printed True, choose More info, then Run anyway", "Stop and delete the file if your browser or a security product"];
  inOrder(guide, guideOrder, "guide");
  inOrder(guideSoon, guideOrder, "guide (soon)");
  // correction 1: the vault locations and any restore come first, before the steps that open Settings and uninstall
  const uninstallOrder = ["Before you uninstall, note where your vaults are", "Finish any restore that is in progress", "Open Settings, then Apps", "Optionally, once the uninstall has finished"];
  inOrder(guide, uninstallOrder, "guide uninstall");
  inOrder(guideSoon, uninstallOrder, "guide uninstall (soon)");
  // the promises the review found false or too strong are gone (findings 3, 5, 17)
  for (const html of [guide, guideSoon]) {
    const text = visibleText(html);
    for (const gone of ["no trace", "It goes to the Recycle Bin", "before removing anything else", "close it and run the uninstall again", "empty it", "until you empty", "empty just that folder", "check any backup you want to keep", "administrator password: setup", "change the line to match", "--signer-workflow"]) assert.equal(text.includes(gone), false, `the guide still says "${gone}"`);
  }
  for (const html of [downloadRelease, downloadSoon]) {
    const text = visibleText(html);
    for (const gone of ["administrator password: setup", "change the line to match", "check any backup you want to keep"]) assert.equal(text.includes(gone), false, `the download page still says "${gone}"`);
  }
  // titles, as the design pins them
  assert.equal(titleOf(downloadRelease), "Petalock: download for Windows");
  assert.equal(titleOf(guide), "Petalock: guide");
  assert.equal(titleOf(notFound), "Page not found · Petalock");
  // the maker, the warning and the fingerprint check come before the opening's button (the plan's decision 1)
  assert.ok(downloadRelease.indexOf("Made by Ariel Maningas") < downloadRelease.indexOf("Download for Windows"));
  assert.ok(downloadRelease.indexOf("Early preview") < downloadRelease.indexOf("Download for Windows"));
  // the guide's sections, in the design's order, each with its anchor
  const sections = ["install", "check-the-file", "the-warnings", "internet-and-webview2", "update", "uninstall", "going-back", "delete-a-vault", "if-petalock-won-t-start"];
  const ids = idsOf(guide);
  assert.deepEqual(ids.filter((id) => sections.includes(id)), sections);
  // the download page's own links to the guide's anchors
  assert.ok(tags(downloadRelease).some((t) => t.name === "a" && t.attrs.href === "/guide/#delete-a-vault"));

  // the check fires on one changed word, and is quiet on no change
  const changed = downloadRelease.replace("Your secrets, in print only you can read.", "Your secrets, in print only you can read!");
  assert.notEqual(changed, downloadRelease);
  assert.deepEqual(missingWords(changed, WORDS.common).missing, ["Your secrets, in print only you can read."]);
  assert.deepEqual(missingWords(downloadRelease, WORDS.common).missing, []);
  const oneWord = guide.replace("then delete its folder in File Explorer", "then delete its folder in File Explorer");
  assert.deepEqual(missingWords(oneWord, WORDS.guide).missing, []);
  const swapped = guide.replace("If it prints False, stop and delete the file.", "If it prints False, carry on and open the file.");
  assert.equal(missingWords(swapped, WORDS.guide).missing.length, 1);
  assert.equal(missingWords("", WORDS.common).missing.length, WORDS.common.length, "an empty page says none of it");
});

test("every_link_resolves", async () => {
  const { release, soon } = await built();
  const externalFor = (tag) => ({
    download: `${GITHUB}/releases/download/${tag}/${INSTALLER}`,
    notes: `${GITHUB}/releases/tag/${tag}`,
    releases: `${GITHUB}/releases`,
    source: GITHUB,
    security: `${GITHUB}/blob/main/SECURITY.md`,
  });
  const allowed = { release: new Set(Object.values(externalFor(TAG))), soon: new Set([externalFor(TAG).releases, externalFor(TAG).source, externalFor(TAG).security]) };
  const siteFiles = (dir) => new Set(PAGES.concat(["styles.css"]).map((f) => f.replace(/index\.html$/, "")).map((f) => `/${f}`));
  let internal = 0;
  let external = 0;
  for (const [name, where] of [["release", release], ["soon", soon]]) {
    const idsByPath = { "/": idsOf(read(where.outDir, "index.html")), "/guide/": idsOf(read(where.outDir, "guide/index.html")), "/404.html": idsOf(read(where.outDir, "404.html")) };
    const exists = siteFiles(where.outDir);
    for (const file of PAGES) {
      const here = file === "index.html" ? "/" : file === "guide/index.html" ? "/guide/" : "/404.html";
      for (const t of tags(read(where.outDir, file))) {
        const href = t.attrs.href;
        if (t.closing || href === undefined || t.name === "link") continue;
        if (href.startsWith("https://")) {
          external += 1;
          assert.ok(allowed[name].has(href), `${name} ${file}: ${href} is not one of the addresses this page may link to`);
          assert.ok(href.startsWith(`${GITHUB}`), href);
        } else {
          internal += 1;
          const [path, fragment] = href.startsWith("#") ? [here, href.slice(1)] : [href.split("#")[0], href.split("#")[1]];
          assert.ok(exists.has(path), `${name} ${file}: ${href} points at a page that does not exist`);
          if (fragment !== undefined) assert.ok(idsByPath[path].includes(fragment), `${name} ${file}: ${href} points at an anchor that does not exist`);
        }
      }
    }
  }
  assert.ok(internal >= 30 && external >= 8, `too few links were looked at: ${String(internal)} and ${String(external)}`);
  // finding 21: each named link goes where its name says, wherever it appears (not merely to an allowed address)
  const byName = (tag) => ({ "Release notes": externalFor(tag).notes, "Older versions": externalFor(tag).releases, "releases list": externalFor(tag).releases, "Source code": externalFor(tag).source, "Security policy": externalFor(tag).security, "download page": "/", "Download": "/", "Guide": "/guide/", "Read the guide": "/guide/", "Go to the download page": "/", "Step by step in the guide": "/guide/#delete-a-vault" });
  let named = 0;
  for (const [name, where, tag] of [["release", release, TAG], ["soon", soon, null]]) {
    const expect = byName(tag ?? TAG);
    if (tag === null) expect["Release notes"] = externalFor(TAG).releases;
    for (const file of PAGES) {
      for (const m of read(where.outDir, file).matchAll(/<a\s([^>]*)>([\s\S]*?)<\/a>/g)) {
        const label = norm(decode(m[2].replace(/<[^>]*>/g, "")));
        const href = /href="([^"]*)"/.exec(m[1])?.[1];
        if (!(label in expect)) continue;
        if (label === "Download" && href?.includes("/releases/download/")) continue; // step 1's button
        assert.equal(href, expect[label], `${name} ${file}: "${label}" goes to ${String(href)}, not ${expect[label]}`);
        named += 1;
      }
    }
  }
  assert.ok(named >= 30, `only ${String(named)} named links were checked`);
  // and a swap is caught: the guide's Security policy sent to the releases list fails the same comparison
  const swapped = read(release.outDir, "guide/index.html").replace(`href="${externalFor(TAG).security}"`, `href="${externalFor(TAG).releases}"`);
  const swappedLink = [...swapped.matchAll(/<a\s([^>]*)>([\s\S]*?)<\/a>/g)].find((m) => m[2].includes("Security policy"));
  assert.notEqual(/href="([^"]*)"/.exec(swappedLink[1])[1], externalFor(TAG).security);
  // the release's own page is the one GitHub's answer names, and SECURITY.md is in the repository the link names
  const github = fakeGithub();
  assert.equal(github.scenario.release.html_url, externalFor(TAG).notes);
  assert.ok(existsSync(join(ROOT, "SECURITY.md")));
  // every link of the page named in the design is there: notes, older versions, source, security (footer), in this order
  const footer = read(release.outDir, "index.html").split("<footer")[1];
  const order = [...footer.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(order, [externalFor(TAG).notes, externalFor(TAG).releases, externalFor(TAG).source, externalFor(TAG).security]);
});

test("the_guide_document_points_to_the_page", () => {
  const text = readFileSync(join(ROOT, "docs", "GUIDE.md"), "utf8");
  assert.match(text, /https:\/\/petalock\.arielmaningas\.com\/guide\//);
});

test("the_command_builds_and_refuses_as_the_function_does", () => {
  const where = siteWith('{"tag": null}\n');
  const run = (siteDir, outDir, extra = []) => spawnSync(process.execPath, [BUILD, "--site", siteDir, "--out", outDir, ...extra], { encoding: "utf8", windowsHide: true, env: { ...process.env, GITHUB_TOKEN: "" } });
  const ok = run(where.siteDir, where.outDir);
  assert.equal(ok.status, 0, ok.stderr);
  assert.ok(existsSync(join(where.outDir, "index.html")));
  // a second run into the folder that now holds output is refused, and leaves it as it was
  const again = run(where.siteDir, where.outDir);
  assert.equal(again.status, 1);
  assert.match(again.stderr, /exists/);
  // a broken release.json is refused with no output
  const broken = siteWith("{}");
  const refusedRun = run(broken.siteDir, broken.outDir);
  assert.equal(refusedRun.status, 1);
  assert.equal(existsSync(broken.outDir), false);
  assert.equal(run(broken.siteDir, broken.outDir, ["--nonsense"]).status, 2);
});

// ---------------------------------------------------------------------------------------------------------------------
// In a real browser

const driver = findEdgeDriver(process.env);
const axePath = findAxe(ROOT);
const forced = process.env.PETALOCK_SITE_BROWSER === "1";
if (forced && !driver) throw new Error("PETALOCK_SITE_BROWSER=1 but no Edge WebDriver was given (PETALOCK_EDGEDRIVER)");
if (!driver) console.log("# the browser tests are skipped: no Edge WebDriver given (PETALOCK_EDGEDRIVER)");
if (forced && !axePath) throw new Error("PETALOCK_SITE_BROWSER=1 but axe-core is not installed (npm ci in ui/)");

const VIEWS = [
  { name: "1280x800", width: 1280, height: 800 },
  { name: "390x844", width: 390, height: 844 },
];
const SCHEMES = ["light", "dark"];

describe("in a real browser", { skip: driver ? false : "no Edge WebDriver given (PETALOCK_EDGEDRIVER)" }, () => {
  let browser;
  const servers = [];
  let headers;

  before(async () => {
    headers = parseHeaders(readFileSync(join(SITE, "_headers"), "utf8"));
    browser = await openBrowser({ driver });
  });
  after(async () => {
    await browser?.quit();
    await Promise.all(servers.map((s) => s.close()));
  });

  const pageUrls = async () => {
    const { release, soon } = await built();
    const sr = await serve(release.outDir, { headers });
    const ss = await serve(soon.outDir, { headers });
    servers.push(sr, ss);
    return [
      ["download", `${sr.origin}/`, sr],
      ["download-soon", `${ss.origin}/`, ss],
      ["guide", `${sr.origin}/guide/`, sr],
      ["notfound", `${sr.origin}/404.html`, sr],
    ];
  };

  /** The guide in the Coming soon state (the other page lists carry it only in the released state). */
  const guideSoonUrl = async () => {
    const { soon } = await built();
    const server = await serve(soon.outDir, { headers });
    servers.push(server);
    return ["guide-soon", `${server.origin}/guide/`, server];
  };

  const open = async (url, { width = 1280, height = 800, scheme = "light", forced: forcedColors = false } = {}) => {
    await browser.viewport(width, height);
    await browser.media({ scheme, forced: forcedColors });
    await browser.requests();
    await browser.console();
    await browser.goto(url);
  };

  test("site_loads_nothing_from_elsewhere (browser load: every request recorded)", async () => {
    let total = 0;
    for (const [name, url, server] of await pageUrls()) {
      await open(url);
      const { requests, failed } = await browser.requests();
      const origin = new URL(url).origin;
      assert.ok(requests.length >= 3, `${name}: only ${String(requests.length)} requests were recorded (the page, its style sheet and a font at least)`);
      assert.ok(requests.filter((r) => r.url.endsWith(".woff2")).length >= (name === "notfound" ? 1 : 2), `${name}: the fonts were not requested (text font, and the mono font where a line of code is shown)`);
      for (const r of requests) assert.ok(r.url.startsWith(`${origin}/`), `${name}: a request to ${r.url}`);
      assert.deepEqual(failed, [], `${name}: a request failed or was blocked`);
      const severe = (await browser.console()).filter((m) => m.level === "SEVERE" && !/favicon/.test(m.message) && !(name === "notfound" && /404/.test(m.message)));
      assert.deepEqual(severe, [], `${name}: the console holds errors (a blocked request reads like this)`);
      assert.ok(await browser.run("return document.fonts.check('16px Geist')"), `${name}: the text font is not used`);
      if (name !== "notfound") assert.ok(await browser.run("return document.fonts.check('16px \"Geist Mono\"')"), `${name}: the mono font is not used`);
      assert.equal(server.requests.every((p) => !p.includes("..")), true);
      total += requests.length;
    }
    assert.ok(total >= 16);
  });

  test("the browser load's recorder sees a request to another site (planted fault)", async () => {
    const other = await serve(tempDir(), {});
    servers.push(other);
    const planted = tempDir();
    writeFileSync(join(planted, "index.html"), `<!doctype html><html><head><title>MU</title></head><body><img src="${other.origin}/elsewhere.png" alt=""></body></html>`);
    const here = await serve(planted, {});
    servers.push(here);
    await open(`${here.origin}/`);
    const { requests } = await browser.requests();
    assert.ok(requests.some((r) => r.url.startsWith(other.origin)), "the request to the other site was not recorded");
    assert.ok(other.requests.includes("/elsewhere.png"), "the other site was not reached, so the recorder was not tested");
    // and the same recorder over a clean page has nothing from another site
    await open(`${here.origin}/`);
    await browser.requests();
    const clean = tempDir();
    writeFileSync(join(clean, "index.html"), "<!doctype html><html><head><title>MU</title></head><body><p>MU</p></body></html>");
    const quiet = await serve(clean, {});
    servers.push(quiet);
    await open(`${quiet.origin}/`);
    const second = await browser.requests();
    assert.ok(second.requests.length >= 1 && second.requests.every((r) => r.url.startsWith(quiet.origin)));
  });

  test("the recorder keeps every hop of a redirect, one that leaves the site and comes back included", async () => {
    // finding 16: Chromium reuses a request id across redirect hops; a map keyed by it kept only the last (same-site) hop
    // The page (no Content-Security-Policy, so the request happens) asks its own site for /hop; the site redirects to a second
    // origin; that origin redirects back to the first. Three origins' worth of hops under one request id.
    const home = createServer((req, res) => {
      const path = new URL(req.url ?? "/", "http://x.invalid").pathname;
      if (path === "/hop") {
        res.statusCode = 302;
        res.setHeader("location", `${bounceOrigin}/leave`);
        res.end();
      } else if (path === "/back") {
        res.setHeader("content-type", "image/svg+xml");
        res.end('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>');
      } else {
        res.setHeader("content-type", "text/html");
        res.end('<!doctype html><html><head><title>MU</title></head><body><img src="/hop" alt=""></body></html>');
      }
    });
    const bounce = createServer((req, res) => {
      res.statusCode = 302;
      res.setHeader("location", `${homeOrigin}/back`);
      res.end();
    });
    await Promise.all([home, bounce].map((s) => new Promise((resolve) => s.listen(0, "127.0.0.1", resolve))));
    const homeOrigin = `http://127.0.0.1:${String(home.address().port)}`;
    const bounceOrigin = `http://127.0.0.1:${String(bounce.address().port)}`;
    try {
      await open(`${homeOrigin}/`);
      const { requests } = await browser.requests();
      const origins = requests.map((r) => new URL(r.url).origin);
      assert.ok(origins.includes(bounceOrigin), `the hop to the other site was lost: ${JSON.stringify(requests.map((r) => r.url))}`);
      assert.ok(requests.some((r) => r.url === `${homeOrigin}/back`), "the hop back to the site was not recorded");
      assert.ok(requests.filter((r) => r.url.startsWith(homeOrigin)).length >= 3, "the page, the first hop and the return were all recorded");
    } finally {
      await Promise.all([home, bounce].map((s) => new Promise((resolve) => { s.close(resolve); s.closeAllConnections(); })));
    }
  });

  /** Words of the safety instructions that must be on screen, by page; each found in the smallest paragraph that holds it. */
  const SAFETY = {
    download: ["If it prints False, stop.", "Your browser may say the file isn't commonly downloaded", "Windows may show", "Stop and delete the file if your browser", "If Smart App Control is on"],
    guide: ["If it prints False, stop and delete the file", "Your browser may say the file isn't commonly downloaded", "Stop and delete the file if your browser", "If Smart App Control is on", "Petalock is an early preview", "Get Petalock only from", "Windows 11, 64-bit is the only tested setup"],
  };
  /** What is wrong with the safety instructions on the page now loaded: `[]` when each is on screen, in a box, in order. */
  const safetyProblems = (phrases) =>
    browser.run(
      `const problems = []; const tops = [];
       for (const phrase of arguments[0]) {
         const holders = [...document.querySelectorAll('p')].filter((p) => p.textContent.replace(/\\s+/g, ' ').includes(phrase));
         if (holders.length === 0) { problems.push('missing: ' + phrase); continue; }
         const p = holders[0];
         const r = p.getBoundingClientRect();
         const shown = p.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true, contentVisibilityAuto: true });
         if (!shown) problems.push('not shown: ' + phrase);
         if (r.width < 20 || r.height < 8) problems.push('no box: ' + phrase);
         if (getComputedStyle(p).fontSize === '0px') problems.push('no size: ' + phrase);
         if (r.right < 0 || r.left > innerWidth) problems.push('off the screen: ' + phrase);
         tops.push([phrase, r.top + scrollY]);
       }
       return { problems, tops };`,
      phrases,
    );

  test("the safety instructions are on screen, in order, in both themes and sizes (and a hidden one is caught)", async () => {
    let looked = 0;
    for (const [name, url] of await pageUrls()) {
      const phrases = SAFETY[name === "guide" ? "guide" : name === "notfound" ? "" : "download"];
      if (!phrases) continue;
      for (const view of VIEWS) {
        for (const scheme of SCHEMES) {
          await open(url, { width: view.width, height: view.height, scheme });
          const { problems, tops } = await safetyProblems(phrases);
          assert.deepEqual(problems, [], `${name} ${view.name} ${scheme}`);
          // the warnings' sequence reads top to bottom: the browser notice, then Windows' screen, then the stop line
          const order = tops.filter(([p]) => /^(Your browser may say|Windows may show|Stop and delete the file if)/.test(p)).map(([, top]) => top);
          assert.deepEqual([...order].sort((a, b) => a - b), order, `${name} ${view.name} ${scheme}: the warnings are out of order on screen`);
          looked += phrases.length;
        }
      }
    }
    assert.ok(looked >= 60, `only ${String(looked)} instructions were looked at`);

    // negative fixtures: the stop line hidden by CSS (display, visibility, size) and by the hidden attribute
    const { release } = await built();
    for (const [what, edit] of [
      ["display:none", (dir) => appendCss(dir, ".stop{display:none}")],
      ["visibility:hidden", (dir) => appendCss(dir, ".stop{visibility:hidden}")],
      ["font-size:0", (dir) => appendCss(dir, ".stop{font-size:0;height:0;overflow:hidden}")],
      ["the hidden attribute", (dir) => writeFileSync(join(dir, "index.html"), read(dir, "index.html").replaceAll('<p class="stop">', '<p class="stop" hidden>'))],
    ]) {
      const copy = tempDir();
      cpSync(release.outDir, copy, { recursive: true });
      edit(copy);
      const hidden = await serve(copy, { headers });
      servers.push(hidden);
      await open(`${hidden.origin}/`);
      const { problems } = await safetyProblems(SAFETY.download);
      assert.ok(problems.length >= 1, `a stop line hidden by ${what} was not caught`);
    }
    // and the same fixture without the fault is clean
    const clean = tempDir();
    cpSync(release.outDir, clean, { recursive: true });
    const quiet = await serve(clean, { headers });
    servers.push(quiet);
    await open(`${quiet.origin}/`);
    assert.deepEqual((await safetyProblems(SAFETY.download)).problems, []);
  });

  /** The stop lines: the bold text itself, by its words, and the section each belongs in. */
  const STOPS = {
    download: [["If it prints False, stop.", "#check"], ["Stop and delete the file if your browser", "#open"]],
    guide: [["If it prints False, stop and delete the file.", "#check-the-file"], ["Stop and delete the file if your browser", "#the-warnings"]],
  };
  /** What is wrong with the stop lines' own text on the page now loaded: `[]` when each is shown, readable and in its section. */
  const stopProblems = (items) =>
    browser.run(
      `const problems = [];
       for (const [text, section] of arguments[0]) {
         const hits = [...document.querySelectorAll('strong')].filter((s) => s.textContent.replace(/\\s+/g, ' ').trim().startsWith(text));
         if (hits.length !== 1) { problems.push(hits.length + ' bold texts start "' + text + '"'); continue; }
         const s = hits[0];
         const r = s.getBoundingClientRect();
         const css = getComputedStyle(s);
         if (!s.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true, contentVisibilityAuto: true })) problems.push('not shown: ' + text);
         if (r.width < 20 || r.height < 8) problems.push('no box: ' + text);
         if (css.fontSize === '0px') problems.push('no size: ' + text);
         if (/^(rgba\\(\\d+, \\d+, \\d+, 0\\)|transparent)$/.test(css.color)) problems.push('transparent text: ' + text);
         if (s.closest(section) === null) problems.push('not inside ' + section + ': ' + text);
       }
       return problems;`,
      items,
    );

  test("each stop line's own text is shown inside its section, in both guide states (and a hidden or moved one is caught)", async () => {
    const pages = [...(await pageUrls()), await guideSoonUrl()].filter(([name]) => name !== "notfound");
    let looked = 0;
    for (const [name, url] of pages) {
      const items = STOPS[name.startsWith("guide") ? "guide" : "download"];
      for (const view of VIEWS) {
        for (const scheme of SCHEMES) {
          await open(url, { width: view.width, height: view.height, scheme });
          assert.deepEqual(await stopProblems(items), [], `${name} ${view.name} ${scheme}`);
          looked += items.length;
        }
      }
    }
    assert.equal(looked, 4 * 2 * 2 * 2, "four pages, two stop lines each, both sizes, both themes");

    // negative fixtures: only the bold text hidden (the paragraph around it still passes the paragraph test), and the stop
    // line moved to another section
    const { release } = await built();
    const moveStop = (dir, file, text, from, into) => {
      const html = read(dir, file);
      const stop = [...html.matchAll(/<p class="stop"><strong>[\s\S]*?<\/strong><\/p>/g)].map((m) => m[0]).find((p) => p.includes(text));
      assert.ok(stop, `${file}: no stop paragraph "${text}"`);
      const without = html.replace(stop, "");
      assert.notEqual(without, html);
      assert.ok(without.includes(into), `${file}: ${into} not found`);
      writeFileSync(join(dir, file), without.replace(into, `${stop}${into}`));
      assert.ok(from);
    };
    const fixtures = [
      ["visibility:hidden on the bold text only", "download", (dir) => appendCss(dir, ".stop strong{visibility:hidden}")],
      ["transparent bold text", "download", (dir) => appendCss(dir, ".stop strong{color:transparent}")],
      ["zero-size bold text", "download", (dir) => appendCss(dir, ".stop strong{font-size:0}")],
      ["the guide's bold text hidden", "guide", (dir) => appendCss(dir, ".stop strong{visibility:hidden}")],
      ["the download page's step 3 stop line moved to step 1", "download", (dir) => moveStop(dir, "index.html", "Stop and delete the file if your browser", "#open", '</li>\n<li id="check">')],
      ["the guide's warning stop line moved to Install", "guide", (dir) => moveStop(dir, "guide/index.html", "Stop and delete the file if your browser", "#the-warnings", '</section>\n<section id="check-the-file">')],
    ];
    for (const [what, kind, edit] of fixtures) {
      const copy = tempDir();
      cpSync(release.outDir, copy, { recursive: true });
      edit(copy);
      const fixture = await serve(copy, { headers });
      servers.push(fixture);
      await open(`${fixture.origin}${kind === "guide" ? "/guide/" : "/"}`);
      assert.ok((await stopProblems(STOPS[kind])).length >= 1, `${what} was not caught`);
    }
    // and the same fixture without a fault is clean
    const clean = tempDir();
    cpSync(release.outDir, clean, { recursive: true });
    const quiet = await serve(clean, { headers });
    servers.push(quiet);
    for (const [path, kind] of [["/", "download"], ["/guide/", "guide"]]) {
      await open(`${quiet.origin}${path}`);
      assert.deepEqual(await stopProblems(STOPS[kind]), []);
    }
  });

  test("axe finds nothing on each page at 1280x800 and 390x844, light and dark", { skip: axePath ? false : "axe-core is not installed (npm ci in ui/)" }, async () => {
    const source = readFileSync(axePath, "utf8");
    let runs = 0;
    const tally = { passes: 0, inapplicable: 0, incomplete: [] };
    for (const [name, url] of await pageUrls()) {
      for (const view of VIEWS) {
        for (const scheme of SCHEMES) {
          await open(url, { width: view.width, height: view.height, scheme });
          assert.equal(await browser.run("return matchMedia('(prefers-color-scheme: dark)').matches"), scheme === "dark", "the colour scheme was not applied");
          const result = await runAxe(browser, source);
          assert.deepEqual(result.violations, [], `${name} ${view.name} ${scheme}: axe violations`);
          assert.ok(result.passes > 20, `${name} ${view.name} ${scheme}: axe passed only ${String(result.passes)} rules`);
          tally.passes += result.passes;
          tally.inapplicable += result.inapplicable;
          for (const item of result.incomplete) tally.incomplete.push(`${name} ${view.name} ${scheme}: ${item.id} (${item.targets.map((t) => t.split(" :: ")[0]).join(" | ")})`);
          runs += 1;
        }
      }
    }
    assert.equal(runs, 16);
    // the skipped count the plan asks to record: rules axe could not decide ("incomplete") and rules that did not apply
    console.log(`# axe: ${String(runs)} runs, ${String(tally.passes)} rule passes, ${String(tally.inapplicable)} not applicable, ${String(tally.incomplete.length)} could not be decided${tally.incomplete.length ? `: ${tally.incomplete.join("; ")}` : ""}`);
  });

  test("no page scrolls sideways, and the guide's picture shows only from 1024 px", async () => {
    let looked = 0;
    for (const [name, url] of await pageUrls()) {
      for (const width of [320, 390, 640, 641, 900, 901, 1023, 1024, 1280, 1536]) {
        await open(url, { width, height: 800 });
        const [scrollWidth, clientWidth] = await browser.run("return [document.documentElement.scrollWidth, document.documentElement.clientWidth]");
        assert.ok(scrollWidth <= clientWidth, `${name} at ${String(width)}: the page is ${String(scrollWidth)} wide in a window of ${String(clientWidth)}`);
        // Task 12: the words keep the side margin (16 px on a phone, more above), never touching the window's edge
        const [checked, touching] = await browser.run(
          `const out = []; let n = 0;
           for (const e of document.querySelectorAll('main p, main h1, main h2, main h3, main li, .hc p, .hc h1, .ghero h1, .ghero p, footer p, footer a')) {
             // the lines of words themselves (a range over the element's contents), not the box that holds them and its padding
             const range = document.createRange(); range.selectNodeContents(e);
             const lines = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0); if (lines.length === 0) continue; n += 1;
             for (const r of lines) if (r.left < 16 || r.right > document.documentElement.clientWidth - 16) { out.push(e.textContent.trim().slice(0, 30) + ' ' + Math.round(r.left) + '..' + Math.round(r.right)); break; }
           }
           return [n, out.slice(0, 3)];`,
        );
        assert.ok(checked >= (name === "notfound" ? 2 : 5), `${name} at ${String(width)}: only ${String(checked)} blocks of words were measured`);
        assert.deepEqual(touching, [], `${name} at ${String(width)}: words touch the window's edge`);
        looked += 1;
        if (name === "guide") {
          const shown = await browser.run("const p = document.querySelector('.ghero .ht'); return p !== null && getComputedStyle(p).display !== 'none'");
          assert.equal(shown, width >= 1024, `the guide's picture at ${String(width)}`);
        }
      }
    }
    assert.equal(looked, 40);
  });

  test("no text sits on the picture's lines", async () => {
    const box = `(selector) => { const r = document.querySelector(selector).getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom]; }`;
    const meets = (a, b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
    let compared = 0;
    for (const [name, url] of await pageUrls()) {
      if (name === "download-soon") continue;
      for (const width of [320, 390, 641, 820, 900, 901, 1023, 1024, 1180, 1280, 1536, 1920]) {
        await open(url, { width, height: 900 });
        const lines = await browser.run(`return (${box})(${JSON.stringify(name === "guide" ? ".ghero .ht g" : name === "download" ? ".hero .ht-d" : ".nf .ht")})`).catch(() => null);
        if (name === "guide" && width < 1024) continue;
        assert.ok(lines, `${name} at ${String(width)}: no picture to measure`);
        if (width === 1280) {
          const rule = await browser.run(`return [...document.querySelectorAll(${JSON.stringify(name === "guide" ? ".ghero .ht path" : name === "download" ? ".hero .ht-d path" : ".nf .ht path")})].map((p) => getComputedStyle(p).fillRule)`);
          assert.equal(rule.length, 26, `${name}: twenty-six lines are drawn`);
          assert.ok(rule.every((r) => r === "evenodd"), `${name}: the lines are filled solid, not as ribbons`);
        }
        // the lines of text themselves (a range over each element's words), not the boxes that hold them
        const words = await browser.run(
          `const out = [];
           for (const e of document.querySelectorAll(${JSON.stringify(name === "guide" ? ".ghero h1, .ghero p span, .top a" : name === "download" ? ".hero .ht-text > *, .hero .ht-text a, .hero .btn, .top a" : ".nf .box > *, .nf .btn, .top a")})) {
             const range = document.createRange();
             range.selectNodeContents(e);
             for (const r of range.getClientRects()) if (r.width > 0 && r.height > 0) out.push([e.textContent.trim().slice(0, 20), r.left, r.top, r.right, r.bottom]);
           }
           return out;`,
        );
        assert.ok(words.length >= 3, `${name}: only ${String(words.length)} text lines were found`);
        for (const [text, ...rect] of words) {
          assert.equal(meets(lines, rect), false, `${name} at ${String(width)}: "${String(text)}" sits on the picture (${JSON.stringify(lines.map(Math.round))} and ${JSON.stringify(rect.map(Math.round))})`);
          compared += 1;
        }
      }
    }
    assert.ok(compared > 200, `only ${String(compared)} comparisons`);
  });

  test("the PowerShell box shows its whole line and the fingerprint folds open", async () => {
    const pages = [...(await pageUrls()), await guideSoonUrl()];
    for (const [name, url] of pages) {
      if (name === "notfound") continue;
      const isGuide = name.startsWith("guide");
      const version = /^PowerShell lines? .*, for (version \d+\.\d+\.\d+|the first release)$/;
      for (const view of VIEWS) {
        await open(url, { width: view.width, height: view.height });
        const boxes = await browser.run("return [...document.querySelectorAll('textarea')].map((t) => ({ readOnly: t.readOnly, rows: t.rows, label: t.labels.length > 0 ? t.labels[0].textContent.trim() : '', clipped: t.scrollHeight > t.clientHeight + 1, text: t.value }))");
        assert.equal(boxes.length, isGuide ? 4 : 2, `${name}: the text boxes`);
        for (const b of boxes) {
          assert.equal(b.readOnly, true);
          assert.equal(b.clipped, false, `${name} at ${view.name}: "${b.label}" is cut off inside its box`);
        }
        const [box, alt, gh, ghAlt] = boxes;
        assert.equal(box.rows, 3);
        // the page's own line has the plain label; the guide's names its version (finding 6)
        assert.match(box.label, isGuide ? /^PowerShell line to check the file, for (version \d+\.\d+\.\d+|the first release)$/ : /^PowerShell line to check the file$/);
        assert.ok(box.text.startsWith('(Get-FileHash -LiteralPath "$HOME\\Downloads\\Petalock_'), box.text);
        // the two-line alternative: a path typed once, as data (correction 3)
        assert.match(alt.label, isGuide ? /^PowerShell lines for a file saved elsewhere or renamed, for (version \d+\.\d+\.\d+|the first release)$/ : /^PowerShell lines for a file saved elsewhere or renamed$/);
        const lines = alt.text.split("\n");
        assert.equal(lines.length, 2, `${name}: the alternative is two lines`);
        assert.equal(lines[0], '$f = Read-Host "Full path of the downloaded file"');
        assert.ok(lines[1].startsWith('(Get-FileHash -LiteralPath $f).Hash -eq "'), lines[1]);
        assert.equal(alt.text.includes("Downloads"), false, "the alternative names no default path");
        if (isGuide) {
          assert.ok(version.test(box.label) && version.test(alt.label));
          assert.match(gh.label, /^GitHub build record check/);
          assert.ok(gh.text.startsWith('gh attestation verify "$HOME\\Downloads\\Petalock_'), gh.text);
          assert.ok(gh.text.includes(`--cert-identity "${IDENTITY}"`), gh.text);
          assert.match(ghAlt.label, /^GitHub build record check for the file at that path/);
          assert.ok(ghAlt.text.startsWith("gh attestation verify $f --repo "), ghAlt.text);
          assert.ok(ghAlt.text.includes(`--cert-identity "${IDENTITY}"`), ghAlt.text);
        }
      }
    }
    await open((await pageUrls())[0][1]);
    const folded = await browser.run("const d = document.querySelector('details'); const before = d.open; d.querySelector('summary').click(); return [before, d.open]");
    assert.deepEqual(folded, [false, true]);
  });

  test("high contrast: the picture takes the system's text colour and the band is not drawn", async () => {
    for (const [name, url] of await pageUrls()) {
      if (name === "download-soon") continue;
      await open(url, { width: 1280, height: 800, forced: true });
      const seen = await browser.run(
        `const pic = document.querySelector('.hero .ht-d, .ghero .ht, .nf .ht'); const band = document.querySelector('.band');
         const probe = document.createElement('span'); probe.style.color = 'CanvasText'; document.body.append(probe);
         const text = getComputedStyle(probe).color; probe.remove();
         return { forcedOn: matchMedia('(forced-colors: active)').matches, fill: getComputedStyle(pic.querySelector('path')).fill, text, band: band === null ? 'none' : getComputedStyle(band).display };`,
      );
      assert.equal(seen.forcedOn, true);
      assert.equal(seen.fill, seen.text, `${name}: the picture's fill is ${seen.fill}, not the system text colour ${seen.text}`);
      if (name === "download") assert.equal(seen.band, "none");
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The deploy workflow (Plan 5, Task 7): .github/workflows/site.yml, read as text. There is no YAML library in the repository,
// so it is read by indentation, one job and one step at a time, the way release-workflow.test.mjs reads the release workflow.
// Each check is a function of the workflow's text, run on the real file (it must pass) and on copies with one thing changed
// (it must fail), so a check that has gone blind shows up here. These tests need no browser and no network, so they stay
// outside the PETALOCK_SITE_BROWSER gate and the scan job runs them too. What only GitHub can show (the environment's
// deployment rule, the variable, the token) is checked live in Plan 5 Task 13.

const SITE_WORKFLOW = ".github/workflows/site.yml";
const wfRead = (path) => readFileSync(join(ROOT, path), "utf8").replace(/\r\n/g, "\n");
const wfIndent = (line) => line.match(/^ */)[0].length;
const wfBlank = (line) => line.trim() === "" || line.trim().startsWith("#");

/** The lines under `lines[at]`: every following line indented deeper than it (blank and comment lines included). */
function wfUnder(lines, at) {
  const indent = wfIndent(lines[at]);
  const out = [];
  for (let i = at + 1; i < lines.length; i++) {
    if (!wfBlank(lines[i]) && wfIndent(lines[i]) <= indent) break;
    out.push(lines[i]);
  }
  while (out.length > 0 && wfBlank(out.at(-1))) out.pop();
  return out;
}

/** The jobs: name -> { lines, text }. Fails when none are found. */
function wfJobs(text) {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => l === "jobs:");
  assert.ok(at >= 0, "no jobs: section");
  const block = wfUnder(lines, at);
  const jobs = new Map();
  block.forEach((line, i) => {
    const m = line.match(/^ {2}([a-z][a-z0-9-]*):\s*$/);
    if (m) {
      const own = wfUnder(block, i);
      jobs.set(m[1], { lines: own, text: own.join("\n") });
    }
  });
  assert.ok(jobs.size >= 1, "no jobs found");
  return jobs;
}

/** A job's own key at four spaces: its inline value, or null when absent. */
const wfField = (job, key) => job.lines.find((l) => l.startsWith(`    ${key}:`))?.slice(`    ${key}:`.length).trim() ?? null;

/** A job's permissions as an object, or undefined when it declares none. */
function wfPermissions(job) {
  const at = job.lines.findIndex((l) => /^ {4}permissions:/.test(l));
  if (at < 0) return undefined;
  const inline = job.lines[at].replace(/^ {4}permissions:/, "").trim();
  if (inline === "{}") return {};
  assert.equal(inline, "", `permissions written inline: ${inline}`);
  const out = {};
  for (const l of wfUnder(job.lines, at)) {
    const m = l.match(/^ {6}([a-z-]+): (read|write|none)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

/** A job's steps: { lines, text }. */
function wfSteps(job) {
  const at = job.lines.findIndex((l) => /^ {4}steps:\s*$/.test(l));
  if (at < 0) return [];
  const steps = [];
  for (const line of wfUnder(job.lines, at)) {
    if (/^ {6}- /.test(line)) steps.push([line]);
    else if (steps.length > 0) steps.at(-1).push(line);
  }
  return steps.map((lines) => ({ lines, text: lines.join("\n") }));
}

const wfUses = (step) => step.text.match(/^\s*(?:- )?uses: (\S+)/m)?.[1] ?? null;
const wfStepKey = (step, key) => step.lines.find((l) => new RegExp(`^(?: {6}- | {8})${key}:`).test(l))?.replace(new RegExp(`^(?: {6}- | {8})${key}:`), "").trim() ?? null;
function wfRun(step) {
  const at = step.lines.findIndex((l) => /^(?: {6}- | {8})run:/.test(l));
  if (at < 0) return null;
  const inline = step.lines[at].replace(/^(?: {6}- | {8})run:/, "").trim();
  return inline === "|" ? wfUnder(step.lines, at).map((l) => l.trim()).join("\n") : inline;
}
/** A key inside a step's `with:` block. */
const wfWith = (step, key) => step.text.match(new RegExp(`^ {10}${key}: (.*)$`, "m"))?.[1]?.trim() ?? null;
/** A step's own `env:` block: name -> value text. */
function wfEnv(step) {
  const at = step.lines.findIndex((l) => /^ {8}env:\s*$/.test(l));
  const out = new Map();
  if (at < 0) return out;
  for (const l of wfUnder(step.lines, at)) {
    const m = l.match(/^ {10}([A-Za-z_][A-Za-z0-9_]*): (.*)$/);
    if (m) out.set(m[1], m[2].trim());
  }
  return out;
}

/** The workflow's text without the lines that are only a comment. */
const wfCode = (text) => text.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");

/** One part of the text replaced by another: the part must be there, so a mutation that matches nothing is itself a failure. */
function wfMutate(text, from, to) {
  assert.ok(text.includes(from), `the mutation target ${JSON.stringify(from)} is not in the workflow`);
  return text.replace(from, to);
}

/**
 * The check must refuse the workflow with `from` changed to `to`. The change is made first, outside the assertion, so a target
 * that is not in the file fails the test for that reason; and what the check throws must be one of its own assertions, not
 * an accident of the changed text (a TypeError from a reader that no longer finds a step).
 */
function wfRefuses(check, text, from, to, ...rest) {
  const changed = wfMutate(text, from, to);
  assert.notEqual(changed, text, "the mutation changed nothing");
  assert.throws(() => check(changed, ...rest), { name: "AssertionError" }, `the check passed a workflow with ${JSON.stringify(from)} changed to ${JSON.stringify(to)}`);
}

/** The `on:` block: the trigger names and the lines under them. */
function wfTriggers(text) {
  const lines = text.split("\n");
  const on = lines.findIndex((l) => l === "on:");
  assert.ok(on >= 0, "no on: block");
  const block = wfUnder(lines, on);
  return { block, triggers: block.filter((l) => /^ {2}[a-z_]+:/.test(l)).map((l) => l.trim().replace(/:.*$/, "")) };
}

/** The items of the block list under `    <key>:` (four spaces), without quotes. Fails when the list is empty or written inline. */
function wfList(lines, key) {
  const at = lines.findIndex((l) => new RegExp(`^ {4}${key}:\\s*$`).test(l));
  assert.ok(at >= 0, `no block list ${key}:`);
  const items = wfUnder(lines, at).filter((l) => !wfBlank(l)).map((l) => {
    const m = l.match(/^ {6}- (.+?)\s*$/);
    assert.ok(m, `not a list item: ${l}`);
    return m[1].replace(/^(["'])(.*)\1$/, "$2");
  });
  assert.ok(items.length >= 1, `${key} is empty`);
  return items;
}

/** The `./x.mjs` files a script reads, and theirs in turn (static imports and `import("./x.mjs")`), as repository paths. */
function wfImportClosure(entry) {
  const seen = new Set();
  const todo = [entry];
  while (todo.length > 0) {
    const file = todo.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const code = readFileSync(join(ROOT, file), "utf8");
    for (const m of code.matchAll(/(?:\bfrom\s+|\bimport\(\s*)"(\.\/[A-Za-z0-9_.-]+\.mjs)"/g)) todo.push(`scripts/${m[1].slice(2)}`);
  }
  return [...seen].sort();
}

/** The workflow-file facts every check needs; `text` may be a changed copy. */
const siteYml = () => wfRead(SITE_WORKFLOW);

// ---- 1. runs only from main, in the site environment ----

function checkRunsOnlyFromMain(text) {
  const { block, triggers } = wfTriggers(text);
  assert.deepEqual(triggers, ["push"], "the only trigger is a push (no release, dispatch, pull request, schedule or workflow_run)");
  const push = wfUnder(block, block.findIndex((l) => l === "  push:"));
  assert.deepEqual(push.filter((l) => /^ {4}[a-z-]+:/.test(l)).map((l) => l.trim()), ["branches:", "paths:"], "a push filtered by branch and by path, nothing else");
  assert.deepEqual(wfList(push, "branches"), ["main"], "only main");
  // Every file the page is built from, and the files that make the verify and the deploy: a change to any of them redeploys.
  // The import closure is read from the scripts themselves, so a new import cannot slip past the list.
  const closure = [...new Set([...wfImportClosure("scripts/site-build.mjs"), ...wfImportClosure("scripts/site-verify.mjs")])];
  for (const needed of ["scripts/site-build.mjs", "scripts/site-verify.mjs", "scripts/release-guard.mjs", "scripts/site-picture.mjs"]) assert.ok(closure.includes(needed), `the import walk found ${needed}`);
  // site-deploy/ holds the uploader's package.json and lockfile: a change to the uploader redeploys too.
  assert.deepEqual(wfList(push, "paths").sort(), ["site/**", "site-deploy/**", SITE_WORKFLOW, ...closure].sort(), "the paths are site/**, site-deploy/**, this file and everything the build and the verify import");

  const jobs = wfJobs(text);
  assert.deepEqual([...jobs.keys()].sort(), ["build", "deploy"]);
  assert.equal(wfField(jobs.get("deploy"), "environment"), "site", "the upload job runs in the site environment");
  assert.equal(wfField(jobs.get("build"), "environment"), null, "the build job holds no environment, so no secret");
  assert.equal([...text.matchAll(/^\s+environment:/gm)].length, 1, "one environment in the file");
  const own = wfField(jobs.get("deploy"), "if");
  assert.ok(own, "the upload job has its own if:");
  assert.match(own, /github\.ref == 'refs\/heads\/main'/, "the upload job refuses any ref but main in its own if:");
}

test("deploy_runs_only_from_main_in_the_site_environment", () => {
  const text = siteYml();
  checkRunsOnlyFromMain(text);
  // planted faults: each must be seen
  for (const [from, to] of [
    ["on:\n  push:", "on:\n  workflow_dispatch:\n  push:"],
    ["on:\n  push:", "on:\n  pull_request:\n  push:"],
    ["on:\n  push:", "on:\n  release:\n    types: [published]\n  push:"],
    ["on:\n  push:", "on:\n  schedule:\n    - cron: \"0 3 * * *\"\n  push:"],
    ["      - main\n", "      - main\n      - plan-5-release\n"],
    ["    environment: site\n", "    environment: release\n"],
    ["    environment: site\n", ""],
    ["github.ref == 'refs/heads/main'", "github.ref != 'refs/heads/other'"],
    ["      - scripts/site-build.mjs\n", ""],
    ["      - scripts/site-verify.mjs\n", ""],
    ["      - scripts/release-guard.mjs\n", ""],
    ["      - site/**\n", ""],
    ["      - site-deploy/**\n", ""],
  ]) wfRefuses(checkRunsOnlyFromMain, text, from, to);
});

// ---- 2. off until activated ----

/** Evaluates the one shape the upload job's condition may have: `a == 'x' && b == 'y' && ...`, nothing else. */
function wfEvalIf(condition, context) {
  const body = condition.match(/^\$\{\{ (.*) \}\}$/)?.[1];
  assert.ok(body, `not an expression: ${condition}`);
  const clauses = body.split(" && ").map((clause) => {
    const m = clause.match(/^([A-Za-z_.]+) == '([^']*)'$/);
    assert.ok(m, `a condition this test does not read: ${clause}`);
    return { path: m[1], value: m[2] };
  });
  return { paths: clauses.map((c) => `${c.path}=${c.value}`).sort(), result: clauses.every((c) => (context[c.path] ?? "") === c.value) };
}

function checkOffUntilActivated(text) {
  const jobs = wfJobs(text);
  const condition = wfField(jobs.get("deploy"), "if");
  assert.ok(condition, "the upload job has an if:");
  const setting = { "github.event_name": "push", "github.ref": "refs/heads/main", "vars.SITE_DEPLOY": "on" };
  const { paths, result } = wfEvalIf(condition, setting);
  assert.deepEqual(paths, ["github.event_name=push", "github.ref=refs/heads/main", "vars.SITE_DEPLOY=on"], "the upload runs on a push to main with SITE_DEPLOY on, and on nothing less");
  assert.equal(result, true, "on, on main: it runs");
  for (const [what, change] of [
    ["the variable unset", { "vars.SITE_DEPLOY": undefined }],
    ["the variable off", { "vars.SITE_DEPLOY": "off" }],
    ["the variable empty", { "vars.SITE_DEPLOY": "" }],
    ["another branch", { "github.ref": "refs/heads/plan-5-release" }],
    ["a pull request's ref", { "github.ref": "refs/pull/1/merge" }],
    ["a dispatch", { "github.event_name": "workflow_dispatch" }],
  ]) assert.equal(wfEvalIf(condition, { ...setting, ...change }).result, false, `${what}: nothing is uploaded`);
  // With the variable unset the build and the tests still run: the build job has no condition of its own and waits for nothing.
  const build = jobs.get("build");
  assert.equal(wfField(build, "if"), null, "the build job has no if:");
  assert.equal(wfField(build, "needs"), null, "the build job waits for nothing");
  assert.equal([...wfCode(text).matchAll(/SITE_DEPLOY/g)].length, 1, "the variable is named once, in the upload job's if:");
  // Nothing that uploads is in the build job, whatever the variable says.
  assert.ok(!/wrangler|pages deploy|CLOUDFLARE|secrets\./i.test(wfCode(build.text)), "the build job holds nothing that uploads");
}

test("deploy_is_off_until_activated", () => {
  const text = siteYml();
  checkOffUntilActivated(text);
  for (const [from, to] of [
    ["vars.SITE_DEPLOY == 'on'", "vars.SITE_DEPLOY != 'off'"],
    ["vars.SITE_DEPLOY == 'on'", "vars.SITE_DEPLOY == 'off'"],
    [" && vars.SITE_DEPLOY == 'on'", ""],
    [" && vars.SITE_DEPLOY == 'on'", " || vars.SITE_DEPLOY == 'on'"],
    ["github.ref == 'refs/heads/main' && ", ""],
    [" && github.event_name == 'push'", ""],
    [" && github.event_name == 'push'", " || github.event_name == 'push'"],
  ]) wfRefuses(checkOffUntilActivated, text, from, to);
  // a build job gated on the variable would stop the tests from running while the deploy is off
  wfRefuses(checkOffUntilActivated, text, "  build:\n", "  build:\n    if: ${{ vars.SITE_DEPLOY == 'on' }}\n");
  wfRefuses(checkOffUntilActivated, text, "  build:\n", "  build:\n    needs: deploy\n");
});

// ---- 3. waits for the site tests ----

function checkWaitsForTheTests(text) {
  const jobs = wfJobs(text);
  const build = jobs.get("build");
  const deploy = jobs.get("deploy");
  assert.equal(wfField(deploy, "needs"), "build", "the upload job waits for the job that built and tested");
  assert.equal(wfField(build, "runs-on"), "windows-2025-vs2026", "the job with the browser tests runs where CI runs them");
  assert.equal(wfField(build, "continue-on-error"), null);
  assert.equal(wfField(deploy, "continue-on-error"), null);
  const steps = wfSteps(build);
  assert.ok(steps.length >= 6, `the build job's steps were found (${String(steps.length)})`);
  const at = (predicate, what) => {
    const i = steps.findIndex(predicate);
    assert.ok(i >= 0, `the build job has ${what}`);
    return i;
  };
  const axe = at((s) => wfRun(s) === "npm ci --ignore-scripts" && wfStepKey(s, "working-directory") === "ui", "the UI install that brings axe-core");
  const verify = at((s) => /^node scripts\/site-verify\.mjs\b/.test(wfRun(s) ?? ""), "the verify step");
  const make = at((s) => /^node scripts\/site-build\.mjs\b/.test(wfRun(s) ?? ""), "the build step");
  const test = at((s) => wfRun(s) === "node --test scripts/site.test.mjs", "the site tests");
  const upload = at((s) => wfUses(s)?.startsWith("actions/upload-artifact@") && wfWith(s, "name") === "site", "the artifact upload of the built site");
  const tools = at((s) => wfUses(s)?.startsWith("actions/upload-artifact@") && wfWith(s, "name") === "site-deploy-tools", "the artifact upload of the uploader's package files");
  assert.ok(axe < test && verify < make && make < test && test < upload, "install, verify, build, test, then keep the folder");
  // The uploader's package files are kept straight after the checkout, before any step that runs repository code (setup-node, npm,
  // the scripts, the tests): nothing that runs later can rewrite the lockfile the deploy job installs from.
  const checkout = at((s) => wfUses(s)?.startsWith("actions/checkout@"), "the checkout");
  assert.equal(tools, checkout + 1, "the uploader's package files are kept in the step right after the checkout");
  assert.ok(tools < axe && tools < verify, "and before anything runs");
  assert.equal(wfEnv(steps[test]).get("PETALOCK_SITE_BROWSER"), '"1"', "the browser tests are required to run, not skipped");
  for (const i of [tools, verify, make, test, upload]) {
    assert.equal(wfStepKey(steps[i], "if"), null, "no step that decides what is deployed can be skipped");
    assert.equal(wfStepKey(steps[i], "continue-on-error"), null, "no step that decides what is deployed may fail quietly");
  }
  // What is kept is the folder the build step wrote, and the upload job takes that artifact, never a rebuild. (The browser
  // tests run on the test suite's own fixture builds, not on this folder: the check says only what is true.)
  const out = /--out (\S+)/.exec(wfRun(steps[make]))?.[1];
  assert.ok(out, "the build names its output folder");
  assert.equal(wfWith(steps[upload], "path"), out, "the folder that is kept is the folder the build step wrote");
  assert.equal(wfWith(steps[upload], "if-no-files-found"), "error");
  assert.equal(wfWith(steps[tools], "path"), "site-deploy", "the uploader's package files are kept from their own folder");
  assert.equal(wfWith(steps[tools], "if-no-files-found"), "error");
  const deploySteps = wfSteps(deploy);
  const downloads = deploySteps.filter((s) => wfUses(s)?.startsWith("actions/download-artifact@"));
  assert.deepEqual(downloads.map((s) => wfWith(s, "name")).sort(), ["site", "site-deploy-tools"], "it downloads the two artifacts the build job kept");
  assert.ok(!/actions\/checkout@/.test(deploy.text), "the upload job checks out nothing: no repository code runs beside the token");
  assert.ok(!/site-build|site-verify|site\.test/.test(wfCode(deploy.text)), "the upload job never rebuilds or re-tests");
}

test("deploy_waits_for_the_site_tests", () => {
  const text = siteYml();
  checkWaitsForTheTests(text);
  for (const [from, to] of [
    ["    needs: build\n", ""],
    ["    needs: build\n", "    needs: []\n"],
    ["run: node --test scripts/site.test.mjs", "run: node --test scripts/release-guard.test.mjs"],
    ['PETALOCK_SITE_BROWSER: "1"', 'PETALOCK_SITE_BROWSER: "0"'],
    ["    runs-on: windows-2025-vs2026", "    runs-on: ubuntu-24.04"],
    ["--out target/site", "--out target/other"],
    ["          name: site\n          path: target/site", "          name: site\n          path: site"],
  ]) wfRefuses(checkWaitsForTheTests, text, from, to);
  // the uploader's package files kept late (after the code that runs in the job), as the first version of this workflow did
  {
    const keep = text.match(/      # The uploader's package\.json and lockfile exactly as checked out[\s\S]*?          if-no-files-found: error\n/)?.[0];
    assert.ok(keep, "the step that keeps the package files was found");
    const step = keep.split("\n").slice(2).join("\n"); // without its two comment lines
    const after = "          path: target/site\n          retention-days: 7\n          if-no-files-found: error\n";
    const late = wfMutate(wfMutate(text, keep, ""), after, `${after}${step}`);
    assert.throws(() => checkWaitsForTheTests(late), { name: "AssertionError", message: /right after the checkout/ });
  }
  // the package files' upload may not be skipped or fail quietly either
  wfRefuses(checkWaitsForTheTests, text, "      - name: Keep the uploader's package files for the upload\n", "      - name: Keep the uploader's package files for the upload\n        if: ${{ always() }}\n");
  wfRefuses(checkWaitsForTheTests, text, "          name: site-deploy-tools\n          path: site-deploy\n          retention-days: 7\n          if-no-files-found: error", "          name: site-deploy-tools\n          path: site-deploy\n          retention-days: 7\n          if-no-files-found: ignore");
  // a tests step that may fail quietly, or be skipped, is refused
  wfRefuses(checkWaitsForTheTests, text, "      - name: The site in a real browser\n", "      - name: The site in a real browser\n        continue-on-error: true\n");
  wfRefuses(checkWaitsForTheTests, text, "      - name: The site in a real browser\n", "      - name: The site in a real browser\n        if: ${{ always() }}\n");
  // a second build in the upload job
  wfRefuses(checkWaitsForTheTests, text, "        run: node \"$RUNNER_TEMP/wrangler", "        run: node scripts/site-build.mjs && node \"$RUNNER_TEMP/wrangler");
});

// ---- 4. only the upload step sees the token ----

function checkTokenOnlyInTheUploadStep(text) {
  const code = wfCode(text);
  assert.equal([...code.matchAll(/\bsecrets\b/g)].length, 1, "the word secrets appears once in the file's code");
  assert.equal([...code.matchAll(/secrets\.CLOUDFLARE_API_TOKEN/g)].length, 1, "and it is the Cloudflare token");
  assert.equal([...code.matchAll(/CLOUDFLARE_API_TOKEN/g)].length, 2, "the token's name appears twice: the variable and the secret it is read from, in one line");
  const jobs = wfJobs(text);
  const holders = [];
  for (const [jobName, job] of jobs) {
    assert.ok(!/^ {4}env:/m.test(job.text), `${jobName}: no job-level env (it would reach every step)`);
    for (const step of wfSteps(job)) if (/secrets\./.test(step.text)) holders.push({ jobName, step });
  }
  assert.equal(holders.length, 1, "one step holds the secret");
  const { jobName, step } = holders[0];
  assert.equal(jobName, "deploy");
  assert.equal(wfEnv(step).get("CLOUDFLARE_API_TOKEN"), "${{ secrets.CLOUDFLARE_API_TOKEN }}", "in its env, under the name Wrangler reads");
  assert.ok(!/^ {10}[A-Za-z-]+: .*secrets\./m.test(step.text.replace(/^ {10}CLOUDFLARE_API_TOKEN: .*$/m, "")), "nowhere else in the step, a with: included");
  assert.ok(!/^env:/m.test(text), "no workflow-level env");
  assert.ok(/pages deploy/.test(wfRun(step) ?? ""), "the step that holds the token is the one that uploads");
  assert.ok(!/TOKEN|\$\{\{/.test(wfRun(step)), "the token's name is not in the command, and nothing is interpolated into it");
  // The account id is not a secret: a variable.
  assert.match(code, /CLOUDFLARE_ACCOUNT_ID: \$\{\{ vars\.CLOUDFLARE_ACCOUNT_ID \}\}/);
  assert.ok(!/CLOUDFLARE_ACCOUNT_ID.*secrets\./.test(code));
  // No script of the repository is run with an expression pasted into it, in any job.
  for (const job of jobs.values()) for (const s of wfSteps(job)) assert.ok(!/\$\{\{/.test(wfRun(s) ?? ""), `a run: with an expression in it: ${wfRun(s)}`);
  // The step is the last one: nothing runs after it with the token still around (a step's env ends with the step, but a later step is later code to review).
  assert.equal(wfSteps(jobs.get("deploy")).at(-1).text, step.text, "the upload is the job's last step");
}

test("only_the_upload_step_sees_the_token", () => {
  const text = siteYml();
  assert.doesNotThrow(() => checkTokenOnlyInTheUploadStep(text));
  const tokenLine = "          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}\n";
  for (const [what, from, to] of [
    ["at job level", "    environment: site\n", `    environment: site\n    env:\n      ${tokenLine.trimStart()}`],
    ["at workflow level", "permissions: {}\n", `permissions: {}\n\nenv:\n  CLOUDFLARE_API_TOKEN: \${{ secrets.CLOUDFLARE_API_TOKEN }}\n`],
    ["in a second step", "      - name: Install Wrangler", `      - name: Look\n        env:\n${tokenLine}        run: echo hi\n      - name: Install Wrangler`],
    ["in the install step's env", "      - name: Install Wrangler from the lockfile\n", `      - name: Install Wrangler from the lockfile\n        env:\n${tokenLine}`],
    ["in a with:", "      - name: Upload the site to Cloudflare Pages\n", `      - name: Upload the site to Cloudflare Pages\n        with:\n          apiToken: \${{ secrets.CLOUDFLARE_API_TOKEN }}\n`],
    ["as a second secret", tokenLine, `${tokenLine}          OTHER: \${{ secrets.OTHER }}\n`],
    ["pasted into the command", "pages deploy", "pages deploy --token ${{ secrets.CLOUDFLARE_API_TOKEN }}"],
    ["under another name", "          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}\n", "          CF_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}\n"],
    ["as the account id", "CLOUDFLARE_ACCOUNT_ID: ${{ vars.CLOUDFLARE_ACCOUNT_ID }}", "CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}"],
    ["with an expression in a run:", "      - name: Install Wrangler from the lockfile\n", "      - name: Install Wrangler from the lockfile\n        run: echo ${{ github.ref_name }}\n"],
  ]) {
    assert.ok(what);
    wfRefuses(checkTokenOnlyInTheUploadStep, text, from, to);
  }
  // the file really has the one secret, so a check that finds none is not passing on an empty file
  assert.equal([...text.matchAll(/secrets\.CLOUDFLARE_API_TOKEN/g)].length, 1);
});

// ---- 5. permissions ----

function checkPermissions(text) {
  assert.match(text, /^permissions: \{\}$/m, "the workflow's default permissions are none");
  const jobs = wfJobs(text);
  assert.deepEqual([...jobs.keys()].sort(), ["build", "deploy"]);
  assert.deepEqual(wfPermissions(jobs.get("build")), { contents: "read", attestations: "read" }, "the build job reads the repository and the attestations of the release it checks");
  assert.deepEqual(wfPermissions(jobs.get("deploy")), {}, "the upload job reads nothing of the repository: it has no checkout");
  const code = wfCode(text);
  assert.ok(!/:\s*write\b/.test(code), "no write permission anywhere");
  assert.ok(!/id-token/.test(code), "no id-token anywhere");
  assert.equal([...code.matchAll(/^ +permissions:/gm)].length, 2, "two permissions blocks: the jobs'");
  assert.ok(!/\bpackages:|\bactions: |\bdeployments:|\bpages:|\bcontents: write/.test(code));
}

test("deploy_job_permissions_are_read_only", () => {
  const text = siteYml();
  checkPermissions(text);
  for (const [from, to] of [
    ["permissions: {}\n", "permissions:\n  contents: read\n"],
    ["permissions: {}\n", ""],
    ["      contents: read\n", "      contents: write\n"],
    ["      attestations: read\n", "      attestations: write\n"],
    ["      attestations: read\n", "      attestations: read\n      id-token: write\n"],
    ["      attestations: read\n", "      attestations: read\n      id-token: read\n"],
    ["    permissions: {}\n", "    permissions:\n      contents: read\n"],
    ["    permissions: {}\n", "    permissions:\n      deployments: write\n"],
    ["    permissions: {}\n", ""],
  ]) wfRefuses(checkPermissions, text, from, to);
});

// ---- 6. every action pinned ----

function wfUsesLines(text) {
  return [...text.matchAll(/^\s*(?:-\s+)?uses:\s*(\S+)(?:\s+(#.*))?$/gm)].map((m) => ({ action: m[1], comment: m[2] ?? "" }));
}

function checkPinned(text, known) {
  const uses = wfUsesLines(text);
  assert.ok(uses.length >= 5, `only ${String(uses.length)} uses: lines found`);
  assert.equal(uses.length, [...text.matchAll(/^\s*(?:-\s+)?uses:/gm)].length, "every uses: line was read");
  for (const { action, comment } of uses) {
    assert.match(action, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[0-9a-f]{40}$/, `${action} is not pinned by a full commit hash`);
    assert.match(comment, /^# v\d+(\.\d+){0,2}$/, `${action} has no version comment`);
    // the same pin and version the other workflows use for the same action: nothing new and unreviewed
    assert.ok(known.includes(`${action} ${comment}`), `${action} ${comment} is not a pin the other workflows use`);
  }
}

test("every_action_is_pinned_by_sha", () => {
  const text = siteYml();
  const known = [".github/workflows/ci.yml", ".github/workflows/release.yml", ".github/workflows/build-installer.yml"].flatMap((f) => wfUsesLines(wfRead(f)).map((u) => `${u.action} ${u.comment}`));
  assert.ok(known.length >= 25, "the other workflows' pins were read");
  checkPinned(text, known);
  const sha = (text.match(/uses: actions\/checkout@([0-9a-f]{40})/) ?? [])[1];
  assert.ok(sha, "the checkout is in the file");
  for (const [from, to] of [
    [`actions/checkout@${sha} # v7`, "actions/checkout@v7"],
    [`actions/checkout@${sha} # v7`, `actions/checkout@${sha.slice(0, 39)} # v7`],
    [`actions/checkout@${sha} # v7`, `actions/checkout@${sha}`],
    [`actions/checkout@${sha} # v7`, `actions/checkout@${sha} # latest`],
    [`actions/checkout@${sha} # v7`, `actions/checkout@${"0".repeat(40)} # v7`],
    [`actions/checkout@${sha} # v7`, `evil/checkout@${sha} # v7`],
  ]) wfRefuses(checkPinned, text, from, to, known);
  // an action the other workflows do not use, even pinned and commented, is refused
  assert.throws(() => checkPinned(`${text}\n      - uses: cloudflare/wrangler-action@${sha} # v4.1.3\n`, known), { name: "AssertionError", message: /not a pin the other workflows use/ });
});

// ---- 7. the installer's attestation ----

/** The workflow's side: the verify runs first in the build job, cannot be skipped, and holds the token it needs. */
function checkVerifyStep(text) {
  const build = wfJobs(text).get("build");
  const steps = wfSteps(build);
  const verify = steps.findIndex((s) => /^node scripts\/site-verify\.mjs\b/.test(wfRun(s) ?? ""));
  const make = steps.findIndex((s) => /^node scripts\/site-build\.mjs\b/.test(wfRun(s) ?? ""));
  assert.ok(verify >= 0 && make >= 0, "the verify and the build steps were found");
  assert.ok(verify < make, "the installer is verified before the site is built");
  assert.ok(steps.findIndex((s) => wfUses(s)?.startsWith("actions/checkout@")) < verify, "from the checked-out release choice");
  assert.equal(wfStepKey(steps[verify], "if"), null, "the verify cannot be skipped");
  assert.equal(wfStepKey(steps[verify], "continue-on-error"), null, "the verify cannot fail quietly");
  assert.equal(wfStepKey(steps[verify], "shell"), "bash", "bash expands the folder below the same way on every runner");
  assert.equal(wfEnv(steps[verify]).get("GH_TOKEN"), "${{ github.token }}", "gh reads the run's own token, nothing else");
  assert.match(wfRun(steps[verify]), / --dir "\$RUNNER_TEMP\/[A-Za-z0-9-]+"$/, "the installer is downloaded into the runner's temp folder, outside the checkout");
  assert.ok(!/\bsite-verify\b.*(?:\|\||;|&&)/.test(wfRun(steps[verify])), "nothing after the verify in the same line can hide its status");
  // The build hashes its own download of the installer; it must be handed the digest of the file that was verified, from the
  // folder the verify wrote it to, and refuses when they differ (the swap between the two downloads, Task 7 review finding 1).
  const dir = /--dir "(\$RUNNER_TEMP\/[A-Za-z0-9-]+)"$/.exec(wfRun(steps[verify]))?.[1];
  assert.ok(dir, "the verify's folder was read");
  assert.equal(wfStepKey(steps[make], "shell"), "bash");
  assert.equal(wfStepKey(steps[make], "if"), null);
  assert.ok(wfRun(steps[make]).endsWith(` --verified-from "${dir}"`), `the build is told to take the verified digest from ${dir}: ${wfRun(steps[make])}`);
  assert.equal(wfPermissions(build).attestations, "read", "the token may read the attestations");
  // the identity is written once, in the build's code, never a second time in the workflow
  assert.ok(!/release\.yml|cert-identity|source-ref|signer-workflow/.test(wfCode(text)), "the pins are not spelled in the workflow");
}

/** What the verify script is given by a test: a fake download and a fake `gh`. */
function fakeTools({ status = 200, bytes = INSTALLER_BYTES, gh = { status: 0 } } = {}) {
  const fetched = [];
  const ran = [];
  return {
    fetched,
    ran,
    fetch: async (url, init = {}) => {
      fetched.push({ url: String(url), init });
      return new Response(status === 200 ? bytes : "no", { status });
    },
    run: (command, args, options) => {
      ran.push({ command, args, options });
      return gh;
    },
  };
}

const verifyLib = () => import("./site-verify.mjs");

/** The pins the page shows beside its own check, as the words a program is given (the quotes are the shell's, not data). */
const PAGE_PINS = ["--repo", REPO, "--cert-identity", IDENTITY, "--source-ref", "refs/heads/main"];

async function runVerify(releaseText, tools, { dir } = {}) {
  const { verifyInstaller } = await verifyLib();
  const where = siteWith(releaseText);
  const target = dir ?? join(where.root, "installer");
  return { where, target, outcome: await verifyInstaller({ siteDir: where.siteDir, dir: target, fetch: tools.fetch, run: tools.run }) };
}

async function verifyRefuses(releaseText, tools, message) {
  const { SiteBuildRefused } = await lib();
  await assert.rejects(
    () => runVerify(releaseText, tools),
    (error) => {
      assert.ok(error instanceof SiteBuildRefused, `expected a SiteBuildRefused, got ${String(error?.stack ?? error)}`);
      if (message) assert.match(error.message, message);
      return true;
    },
  );
}

test("deploy_verifies_the_installer_attestation", async () => {
  // the workflow runs the verify before the build, and nothing can skip it
  const text = siteYml();
  checkVerifyStep(text);
  for (const [from, to] of [
    ["      - name: Verify the offered installer", "      - name: Verify the offered installer\n        if: ${{ false }}"],
    ["      - name: Verify the offered installer", "      - name: Verify the offered installer\n        continue-on-error: true"],
    ["          GH_TOKEN: ${{ github.token }}\n", ""],
    ["      attestations: read\n", ""],
    [' --verified-from "$RUNNER_TEMP/installer"', ""],
    [' --verified-from "$RUNNER_TEMP/installer"', ' --verified-from "$RUNNER_TEMP/other"'],
  ]) wfRefuses(checkVerifyStep, text, from, to);
  assert.throws(() => checkVerifyStep(`${text}\n        run: gh attestation verify x --cert-identity y\n`), { name: "AssertionError", message: /pins are not spelled/ });
  {
    // swapping the two steps: the build first, the verify after
    const lines = text.split("\n");
    const v = lines.findIndex((l) => l.includes("node scripts/site-verify.mjs"));
    const b = lines.findIndex((l) => l.includes("node scripts/site-build.mjs"));
    assert.ok(v > 0 && b > v);
    const swapped = lines.slice();
    swapped[v] = lines[b];
    swapped[b] = lines[v];
    assert.throws(() => checkVerifyStep(swapped.join("\n")), { name: "AssertionError", message: /verified before the site is built/ });
  }

  // the script: the one public address, the pins the page shows, a refusal on any failure
  const { attestationLine } = await lib();
  const shown = attestationLine(INSTALLER);
  const pinsAsShown = PAGE_PINS.map((word) => (word === IDENTITY ? `"${word}"` : word)).join(" ");
  assert.ok(shown.endsWith(` ${pinsAsShown}`), `the pins this check holds are the ones the page shows: ${shown}`);
  const { ATTEST_ARGS } = await lib();
  assert.deepEqual([...ATTEST_ARGS], PAGE_PINS, "the build's own pins are the words the verify passes");

  const good = fakeTools();
  const { target, outcome } = await runVerify(choose(TAG), good);
  assert.equal(outcome.state, "verified");
  assert.deepEqual(good.fetched.map((c) => c.url), [`${GITHUB}/releases/download/${TAG}/${INSTALLER}`], "one download, from the public tag-and-file-name address");
  assert.ok(!Object.keys(good.fetched[0].init.headers ?? {}).some((h) => h.toLowerCase() === "authorization"), "no credentials go with the download");
  assert.equal(good.ran.length, 1);
  assert.equal(good.ran[0].command, "gh");
  assert.deepEqual(good.ran[0].args, ["attestation", "verify", join(target, INSTALLER), ...PAGE_PINS], "gh attestation verify on the downloaded file with the page's pins");
  assert.ok(!("shell" in (good.ran[0].options ?? {})) || good.ran[0].options.shell === false, "no shell between the file name and gh");
  assert.deepEqual(readFileSync(join(target, INSTALLER)), INSTALLER_BYTES, "gh is given exactly the bytes that came");
  const { VERIFIED_FILE } = await lib();
  assert.equal(readFileSync(join(target, VERIFIED_FILE), "utf8"), `${sha256(INSTALLER_BYTES)}\n`, "the digest of the verified bytes is written for the build to compare with");
  // a failed check leaves no digest behind for a later step to take as verified
  const failing = fakeTools({ gh: { status: 1 } });
  const failedWhere = siteWith(choose(TAG));
  await assert.rejects(async () => (await verifyLib()).verifyInstaller({ siteDir: failedWhere.siteDir, dir: join(failedWhere.root, "installer"), fetch: failing.fetch, run: failing.run }));
  assert.equal(existsSync(join(failedWhere.root, "installer", VERIFIED_FILE)), false, "no digest is written unless gh accepted the file");
  // it checks the file for the tag the choice names, not another
  const second = fakeTools({ bytes: INSTALLER2_BYTES });
  await runVerify(choose(TAG2), second);
  assert.deepEqual(second.fetched.map((c) => c.url), [`${GITHUB}/releases/download/${TAG2}/${INSTALLER2}`]);
  assert.match(second.ran[0].args[2], new RegExp(`${INSTALLER2.replace(/\./g, "\\.")}$`));

  // a failing verify refuses, whatever the status looks like
  for (const gh of [{ status: 1 }, { status: 2 }, { status: null, signal: "SIGTERM" }, { error: new Error("spawn gh ENOENT"), status: null }, { status: undefined }, {}]) {
    await verifyRefuses(choose(TAG), fakeTools({ gh }), /attestation|gh/i);
  }
  // no installer to check is not a pass
  await verifyRefuses(choose(TAG), fakeTools({ status: 404 }), /404/);
  await verifyRefuses(choose(TAG), fakeTools({ status: 500 }), /500/);
  await verifyRefuses(choose(TAG), fakeTools({ bytes: Buffer.alloc(0) }), /empty/);
  const none = fakeTools({ status: 404 });
  await assert.rejects(() => runVerify(choose(TAG), none));
  assert.equal(none.ran.length, 0, "gh is not run when there is nothing to check");

  // the skip is only for the explicit null (as the build's own Coming soon state is)
  const soon = fakeTools();
  const skipped = await runVerify('{"tag": null}\n', soon);
  assert.equal(skipped.outcome.state, "skipped");
  assert.equal(soon.fetched.length + soon.ran.length, 0, "nothing is fetched or run when no release is offered");
  const { SiteBuildRefused } = await lib();
  for (const bad of [null, "", "{}", "{}\n", '{"tag": "null"}', '{"tag": ""}', '{"tag": false}', '{"tag": 0}', '{"tag": null, "x": 1}', '{"tag": nul}', "null", "[]", '{"tag": [null]}', '{"Tag": null}', '{"tag": "v1.2"}', '{"tag": "v0.1.0-rc.1"}']) {
    const tools = fakeTools();
    await assert.rejects(
      () => runVerify(bad, tools),
      (error) => {
        assert.ok(error instanceof SiteBuildRefused, `${JSON.stringify(bad)}: refused, not skipped (${String(error?.stack ?? error)})`);
        return true;
      },
      `${JSON.stringify(bad)} must not skip the verify`,
    );
    assert.equal(tools.ran.length + tools.fetched.length, 0, `${JSON.stringify(bad)}: nothing fetched or run`);
  }
  // a file already in the folder is never overwritten or trusted
  const again = fakeTools();
  const where = siteWith(choose(TAG));
  const dir = join(where.root, "installer");
  mkdirSync(dir);
  writeFileSync(join(dir, INSTALLER), "MU-planted");
  await assert.rejects(async () => (await verifyLib()).verifyInstaller({ siteDir: where.siteDir, dir, fetch: again.fetch, run: again.run }));
  assert.equal(again.ran.length, 0);
});

test("the_build_refuses_an_installer_that_is_not_the_one_verified", async () => {
  const { buildSite, SiteBuildRefused, VERIFIED_FILE } = await lib();
  const { verifyInstaller } = await verifyLib();
  const SWAPPED = Buffer.concat([Buffer.from("MZ MU-swapped installer "), randomBytes(2048)]);

  /** The verify step: the real function, with a fake download of `bytes` and a `gh` that accepts; returns the folder it wrote. */
  async function verified(bytes) {
    const tools = fakeTools({ bytes });
    const where = siteWith(choose(TAG));
    const dir = join(where.root, "installer");
    await verifyInstaller({ siteDir: where.siteDir, dir, fetch: tools.fetch, run: tools.run });
    return dir;
  }
  /** The build step, handed the verified folder (or nothing), against a GitHub that serves `bytes`. */
  const buildWith = (releaseText, bytes, verifiedFrom) => {
    const where = siteWith(releaseText);
    return { where, run: () => buildSite({ siteDir: where.siteDir, outDir: where.outDir, fetch: fakeGithub(() => {}, { bytes }).fetch, verifiedFrom }) };
  };
  const refusedBuild = async (attempt, message) => {
    await assert.rejects(attempt.run, (error) => {
      assert.ok(error instanceof SiteBuildRefused, `expected a SiteBuildRefused, got ${String(error?.stack ?? error)}`);
      assert.match(error.message, message);
      return true;
    });
    assert.equal(existsSync(attempt.where.outDir), false, "a refused build leaves no output");
    assert.deepEqual(readdirSync(attempt.where.root).sort(), ["site"], "and nothing beside the site");
  };

  // the same bytes in both downloads: built, with the fingerprint of the verified file
  const same = buildWith(choose(TAG), INSTALLER_BYTES, await verified(INSTALLER_BYTES));
  const result = await same.run();
  assert.equal(result.release.fingerprint, sha256(INSTALLER_BYTES));

  // THE SWAP: the file that was verified is not the file the build then downloads (and whose sidecar agrees with it). The build
  // alone cannot tell (the control), the verified digest makes it refuse, and nothing is written.
  const control = buildWith(choose(TAG), SWAPPED, undefined);
  assert.equal((await control.run()).release.fingerprint, sha256(SWAPPED), "without the verified digest the swapped pair would be accepted");
  const swapped = buildWith(choose(TAG), SWAPPED, await verified(INSTALLER_BYTES));
  await refusedBuild(swapped, new RegExp(`${sha256(SWAPPED)}.*${sha256(INSTALLER_BYTES)}|not the file that was verified`, "s"));

  // no digest, or one that is not exactly a digest: refused, never taken as "nothing to compare"
  const folder = (text) => {
    const dir = tempDir();
    if (text !== null) writeFileSync(join(dir, VERIFIED_FILE), text);
    return dir;
  };
  const good = sha256(INSTALLER_BYTES);
  for (const bad of [null, "", "\n", good.slice(1), `${good}0`, good.toUpperCase(), `sha256:${good}`, `${good}  ${INSTALLER}`, `${good}\n${good}\n`, ` ${good}`, `${good}\r\n`, "0".repeat(64)]) {
    await refusedBuild(buildWith(choose(TAG), INSTALLER_BYTES, folder(bad)), /verif/i);
  }
  await refusedBuild(buildWith(choose(TAG), INSTALLER_BYTES, join(tempDir(), "no-such-folder")), /verif/i);
  assert.equal((await buildWith(choose(TAG), INSTALLER_BYTES, folder(`${good}\n`)).run()).release.fingerprint, good, "the exact form the verify writes is accepted");
  assert.equal((await buildWith(choose(TAG), INSTALLER_BYTES, folder(good)).run()).release.fingerprint, good, "a digest with no final newline too");

  // Coming soon offers no installer, so there is nothing that was verified: the folder is not read
  assert.equal((await buildWith('{"tag": null}\n', INSTALLER_BYTES, join(tempDir(), "no-such-folder")).run()).state, "soon");

  // the command takes the flag (a flag with no value is not understood)
  const soon = siteWith('{"tag": null}\n');
  const command = (extra) => spawnSync(process.execPath, [BUILD, "--site", soon.siteDir, "--out", soon.outDir, ...extra], { encoding: "utf8", windowsHide: true, env: { ...process.env, GITHUB_TOKEN: "" } });
  assert.equal(command(["--verified-from"]).status, 2);
  assert.equal(command(["--verified-from", join(tempDir(), "x")]).status, 0);
});

test("the_verify_follows_redirects_only_to_githubs_release_storage", async () => {
  const attempt = async (change, message) => {
    const github = fakeGithub(change);
    const tools = fakeTools();
    const job = runVerify(choose(TAG), { fetch: github.fetch, run: tools.run });
    if (message === null) return { outcome: (await job).outcome, github, tools };
    await assert.rejects(job, (error) => {
      assert.match(error.message, message);
      return true;
    });
    assert.equal(tools.ran.length, 0, "gh is not run on a file that did not come from GitHub's storage");
    return { github, tools };
  };
  // as GitHub answers: the public address, a 302 to the release-storage host, nothing else asked for
  const ok = await attempt(() => {}, null);
  assert.equal(ok.outcome.state, "verified");
  assert.deepEqual(ok.github.calls, [`${GITHUB}/releases/download/${TAG}/${INSTALLER}`, `https://release-assets.githubusercontent.com/MU/public/${INSTALLER}`]);
  assert.equal(ok.tools.ran.length, 1);
  for (const storage of ["https://evil.invalid/MU", "http://release-assets.githubusercontent.com/MU", "https://release-assets.githubusercontent.com:8443/MU", "https://user@release-assets.githubusercontent.com/MU", "https://release-assets.githubusercontent.com.evil.invalid/MU", "https://api.github.com/MU"]) {
    const bad = await attempt((s) => { s.storage = storage; }, /storage|redirect|address/i);
    assert.deepEqual(bad.github.calls, [`${GITHUB}/releases/download/${TAG}/${INSTALLER}`], `${storage}: nothing but the public address was fetched`);
  }
  await attempt((s) => { s.storageStatus = 500; }, /500/);
});

test("the_verify_command_runs_and_refuses_as_the_function_does", () => {
  const SCRIPT = join(ROOT, "scripts", "site-verify.mjs");
  const run = (args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", windowsHide: true, env: { ...process.env, GH_TOKEN: "", GITHUB_TOKEN: "" } });
  const soon = siteWith('{"tag": null}\n');
  const skipped = run(["--site", soon.siteDir, "--dir", join(soon.root, "installer")]);
  assert.equal(skipped.status, 0, skipped.stderr);
  assert.match(skipped.stdout, /no installer|nothing to verify/i);
  assert.equal(existsSync(join(soon.root, "installer")), false, "nothing is downloaded when no release is offered");
  const broken = siteWith("{}");
  const refusedRun = run(["--site", broken.siteDir, "--dir", join(broken.root, "installer")]);
  assert.equal(refusedRun.status, 1);
  assert.match(refusedRun.stderr, /release\.json/);
  assert.equal(run(["--nonsense"]).status, 2);
  assert.equal(run(["--site", soon.siteDir]).status, 2, "the folder for the download is required");
  assert.equal(run(["--dir"]).status, 2);
});

// ---- 8. the uploader ----

/**
 * The uploader's own package folder: kept by the build job (no secret) and installed from by the deploy job. It is outside
 * site/ because everything in site/ is a candidate for what is published (the build copies named files only, but a folder that
 * holds package files does not belong beside the pages); it is not under a dot folder because the artifact upload leaves
 * hidden folders out by default; and its lockfile is read by the dependency scan (scripts/scan.mjs).
 */
const UPLOADER_DIR = "site-deploy";

/** The package files: exactly one dependency at one exact version, and a lockfile that pins it and everything under it by hash. */
function checkUploaderPackage(packageText, lockText, files) {
  assert.deepEqual([...files].sort(), ["package-lock.json", "package.json"], "the folder holds the two files, nothing that could change where npm installs from (no .npmrc)");
  const pkg = JSON.parse(packageText);
  const lock = JSON.parse(lockText);
  assert.deepEqual(Object.keys(pkg).sort(), ["dependencies", "description", "name", "private", "version"], "no scripts, no overrides, no other dependency kinds");
  assert.equal(pkg.private, true);
  assert.deepEqual(Object.keys(pkg.dependencies), ["wrangler"], "one dependency");
  const version = pkg.dependencies.wrangler;
  assert.match(version, /^\d+\.\d+\.\d+$/, "one exact version, no range and no tag");
  assert.equal(lock.lockfileVersion, 3);
  assert.deepEqual(lock.packages[""].dependencies, pkg.dependencies, "the lockfile was made from this package.json");
  assert.equal(lock.packages["node_modules/wrangler"]?.version, version, "and pins the same version");
  const entries = Object.entries(lock.packages).filter(([path]) => path !== "");
  assert.ok(entries.length >= 20, `the lockfile's packages were found (${String(entries.length)})`);
  for (const [path, entry] of entries) {
    assert.match(entry.resolved ?? "", /^https:\/\/registry\.npmjs\.org\/[^\s]+\.tgz$/, `${path}: comes from the npm registry`);
    assert.match(entry.integrity ?? "", /^sha512-[A-Za-z0-9+/]+={0,2}$/, `${path}: has an integrity hash`);
  }
}

/** The workflow's side: installed from the lockfile in a step with no token, then run in the one step that has it. */
function checkUploader(text) {
  const deploy = wfJobs(text).get("deploy");
  const steps = wfSteps(deploy);
  const code = wfCode(text);
  assert.ok(!/cloudflare\/wrangler-action/.test(text), "no third-party action holds the token");
  assert.ok(!/wrangler@|npm install\b|npx\b|\s-g\b|--global/.test(code), "no version, range, tag or install of a package named in the workflow: the lockfile decides");
  assert.ok([...code.matchAll(/\bwrangler\b/gi)].length >= 3);
  // the two artifacts the build kept: the pages, and the uploader's package files into the folder the install runs in
  const tools = steps.find((s) => wfUses(s)?.startsWith("actions/download-artifact@") && wfWith(s, "name") === "site-deploy-tools");
  assert.ok(tools, "the package files are downloaded");
  assert.equal(wfWith(tools, "path"), "${{ runner.temp }}/wrangler");
  const install = steps.findIndex((s) => /^npm ci\b/.test(wfRun(s) ?? ""));
  assert.ok(install >= 0, "the install step is npm ci, which refuses a lockfile that does not match package.json");
  const run = wfRun(steps[install]);
  assert.match(run, /^npm ci --prefix "\$RUNNER_TEMP\/wrangler" --ignore-scripts /, "from the folder the package files were downloaded to, with no install script run");
  assert.ok(!/TOKEN|CLOUDFLARE/.test(steps[install].text), "the install step never sees the token");
  const upload = steps.findIndex((s) => /pages deploy/.test(wfRun(s) ?? ""));
  assert.equal(upload, steps.length - 1, "the upload is the last step");
  assert.ok(steps.indexOf(tools) < install && install < upload, "download, install from the lockfile, then run");
  assert.ok(steps.findIndex((s) => wfUses(s)?.startsWith("actions/download-artifact@") && wfWith(s, "name") === "site") < upload);
  const command = wfRun(steps[upload]);
  assert.ok(command.startsWith('node "$RUNNER_TEMP/wrangler/node_modules/wrangler/bin/wrangler.js" pages deploy '), "it runs the copy that was installed from the lockfile");
  assert.match(command, /--project-name petalock-site(?=\s|$)/, "the one project");
  assert.match(command, /--branch main(?=\s|$)/, "the production branch");
  assert.ok(!/--project-name (?!petalock-site)/.test(command));
  assert.equal(wfEnv(steps[upload]).get("WRANGLER_SEND_METRICS"), '"false"', "no usage report goes out");
  assert.equal([...code.matchAll(/pages deploy/g)].length, 1, "one upload command in the file");
}

test("the_uploader_is_installed_from_a_lockfile_without_the_token", () => {
  const text = siteYml();
  checkUploader(text);
  for (const [from, to] of [
    ["run: npm ci --prefix", "run: npm install --prefix"],
    ["npm ci --prefix \"$RUNNER_TEMP/wrangler\" --ignore-scripts", "npm ci --prefix \"$RUNNER_TEMP/wrangler\""],
    ["npm ci --prefix \"$RUNNER_TEMP/wrangler\"", "npm ci --prefix \"$RUNNER_TEMP/other\""],
    ["--no-fund", "--no-fund wrangler@latest"],
    ["--no-fund", "--no-fund wrangler@4.168.0"],
    ["          name: site-deploy-tools\n          path: ${{ runner.temp }}/wrangler", "          name: site-deploy-tools\n          path: ${{ runner.temp }}/other"],
    ["--project-name petalock-site", "--project-name other"],
    [" --branch main", ""],
    ['WRANGLER_SEND_METRICS: "false"', 'WRANGLER_SEND_METRICS: "true"'],
    ["        run: node \"$RUNNER_TEMP/wrangler/node_modules/wrangler/bin/wrangler.js\"", "        run: npx wrangler"],
  ]) wfRefuses(checkUploader, text, from, to);
  // the install step must not hold the token
  wfRefuses(checkUploader, text, "      - name: Install Wrangler from the lockfile\n", "      - name: Install Wrangler from the lockfile\n        env:\n          CLOUDFLARE_API_TOKEN: x\n");

  // the package files
  const dir = join(ROOT, UPLOADER_DIR);
  const files = readdirSync(dir);
  const packageText = readFileSync(join(dir, "package.json"), "utf8");
  const lockText = readFileSync(join(dir, "package-lock.json"), "utf8");
  checkUploaderPackage(packageText, lockText, files);
  const version = JSON.parse(packageText).dependencies.wrangler;
  const breaks = (what, packageChange, lockChange, filesChange = files) => {
    const p = packageChange ? wfMutate(packageText, packageChange[0], packageChange[1]) : packageText;
    const l = lockChange ? wfMutate(lockText, lockChange[0], lockChange[1]) : lockText;
    assert.throws(() => checkUploaderPackage(p, l, filesChange), { name: "AssertionError" }, `${what}: the check passed`);
  };
  breaks("a range", [`"wrangler": "${version}"`, `"wrangler": "^${version}"`], [`"wrangler": "${version}"\n      }`, `"wrangler": "^${version}"\n      }`]);
  breaks("a tag", [`"wrangler": "${version}"`, '"wrangler": "latest"'], [`"wrangler": "${version}"\n      }`, '"wrangler": "latest"\n      }']);
  breaks("a package.json the lockfile was not made from", [`"wrangler": "${version}"`, '"wrangler": "4.0.0"'], null);
  breaks("a second dependency", [`"dependencies": {`, `"dependencies": {\n    "left-pad": "1.3.0",`], null);
  breaks("a script", [`"private": true,`, `"private": true,\n  "scripts": { "install": "node x.js" },`], null);
  breaks("a package without a hash", null, [/"integrity": "sha512-[^"]+",?\s*/.exec(lockText)?.[0] ?? "no integrity found", ""]);
  breaks("a package from another address", null, ["https://registry.npmjs.org/", "http://registry.npmjs.org/"]);
  breaks("a package from git", null, [/"resolved": "https:\/\/registry\.npmjs\.org\/[^"]+"/.exec(lockText)?.[0] ?? "no resolved found", '"resolved": "git+https://example.invalid/x.git"']);
  breaks("an .npmrc beside them", null, null, [...files, ".npmrc"]);
  breaks("a missing lockfile", null, null, ["package.json"]);
});
