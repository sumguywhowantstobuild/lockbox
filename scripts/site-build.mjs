#!/usr/bin/env node
// Builds the public site (Plan 5, Task 6): the download page, the guide and the not-found page, from the templates in site/
// and the one published release that site/release.json names.
//
//   node scripts/site-build.mjs [--site <folder>] [--out <folder>] [--verified-from <folder>]     defaults: site/ and target/site/
//
// `--verified-from` names the folder scripts/site-verify.mjs wrote (the deploy workflow gives it): for a named release the
// installer this build downloads must hash to the digest found there, or the build stops. Without the flag nothing is compared.
//
// `site/release.json` is read strictly. Only when it is exactly `{"tag": null}` is the page built in its "Coming soon" state,
// with no question to GitHub. With `{"tag": "v<major>.<minor>.<patch>"}` the build asks GitHub for that PUBLISHED release of
// the fixed repository, requires exactly one installer named `Petalock_<version>_x64-setup.exe` and its `.sha256`, strictly
// parses the sidecar (64 hex digits in either case, read as lower case, two spaces, the exact file name), downloads the installer, hashes it, and fills
// the size, date and fingerprint from that result only; the links are built from the tag and the file name, never taken from
// the answer. The two files are fetched from the same public address the page's button uses
// (`https://github.com/<repository>/releases/download/<tag>/<file>`), without credentials, and the redirect from there is
// followed by hand to GitHub's release-storage hosts only. Any other release.json, any answer that is not as described, a
// sidecar for other bytes: the build stops with the reason and writes nothing, so a deploy of it leaves the last good page
// live. The output folder must not hold anything yet; the pages are written beside it and moved into place only when all
// of them are made. Only the three templates, the style sheet, `_headers`, two fonts and their two licences are read from
// site/, each as a regular file (never a link).
//
// Exit status: 0 built, 1 refused (the reason on stderr), 2 not understood. The GitHub token (GITHUB_TOKEN, optional: the
// repository is public) is only ever a request header to api.github.com and is masked in any message.

import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assetNames, parseTag } from "./release-guard.mjs";
import { band, guidePicture, heroPicture, icon, notFoundPicture } from "./site-picture.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

/** The one repository the site offers downloads from. */
export const REPOSITORY = "sumguywhowantstobuild/petalock";
const GITHUB = `https://github.com/${REPOSITORY}`;

/** A reason the build stops; nothing was written. */
export class SiteBuildRefused extends Error {}

const refuse = (message) => {
  throw new SiteBuildRefused(message);
};

/** A value for a message: short, with control characters escaped. */
const show = (v) => (typeof v === "string" ? JSON.stringify(v.slice(0, 60)) : typeof v);

// ---------------------------------------------------------------------------------------------------------------------
// release.json

const WS = "[ \\t\\r\\n]*";
const NULL_CHOICE = new RegExp(`^${WS}\\{${WS}"tag"${WS}:${WS}null${WS}\\}${WS}$`);
const TAG_CHOICE = new RegExp(`^${WS}\\{${WS}"tag"${WS}:${WS}("[^"\\\\]*")${WS}\\}${WS}$`);

/** `{ tag: null }` for exactly `{"tag": null}`, `{ tag }` for exactly `{"tag": "v1.2.3"}`; anything else is refused. */
export function readReleaseChoice(text) {
  if (typeof text !== "string") refuse("site/release.json is missing or unreadable");
  if (NULL_CHOICE.test(text)) return { tag: null };
  const named = TAG_CHOICE.exec(text);
  if (named) {
    const tag = JSON.parse(named[1]);
    try {
      parseTag(tag);
    } catch (error) {
      refuse(`site/release.json: ${error.message}`);
    }
    return { tag };
  }
  refuse('site/release.json must be exactly {"tag": null} or {"tag": "v<major>.<minor>.<patch>"}');
}

// ---------------------------------------------------------------------------------------------------------------------
// The release

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The sidecar's fingerprint: `<64 hex digits>  <file name>`, one line, in lower or upper case (PowerShell prints capitals);
 * returned in lower case. The file name and the single line are strict; anything else is refused.
 */
export function parseSidecar(text, name) {
  const m = new RegExp(`^([0-9a-fA-F]{64})  ${escapeRegExp(name)}\\n?$`).exec(text);
  if (!m) refuse(`the sidecar ${name}.sha256 is not "<64 hex digits>  ${name}" on one line`);
  return m[1].toLowerCase();
}

/** The hosts GitHub's release downloads redirect to (seen live: release-assets; objects is its earlier host). Any other is refused. */
export const STORAGE_HOSTS = Object.freeze(["release-assets.githubusercontent.com", "objects.githubusercontent.com"]);

/** Windows installer formats: exactly one of any of them, the expected setup .exe, may be in a release. */
const INSTALLER_FORMAT = /\.(?:exe|msi|msix|appx|msixbundle|appxbundle|appinstaller)$/i;

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "8 December 2026" for a publish time, in UTC. */
export function formatDate(iso) {
  const m = typeof iso === "string" ? /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}Z$/.exec(iso) : null;
  const date = m ? new Date(iso) : null;
  // a date JavaScript would move (31 February becomes March) does not read back as the same UTC time: refused
  if (!date || Number.isNaN(date.getTime()) || date.toISOString().replace(".000Z", "Z") !== iso) refuse(`the release has no usable published time (${show(iso)})`);
  return `${String(date.getUTCDate())} ${MONTHS[date.getUTCMonth()]} ${String(date.getUTCFullYear())}`;
}

/** The size as the page shows it: bytes divided by 1,000,000, one decimal, "MB". */
export const formatSize = (bytes) => `${(bytes / 1_000_000).toFixed(1)} MB`;

/**
 * A file's bytes from the PUBLIC address the page's button uses, with no credentials (the token is for the API only). GitHub
 * answers with a redirect to its release storage, followed by hand: https, one of GitHub's storage hosts, no port or
 * user name, and nothing else is fetched. The deploy's verify (scripts/site-verify.mjs) downloads through this same function,
 * so the file that is verified came by the same rule as the file that is hashed.
 */
export async function downloadPublic({ tag, name, fetch = globalThis.fetch }) {
  const plain = async (url) => {
    try {
      return await fetch(url, { method: "GET", headers: { "user-agent": "petalock-site-build" }, redirect: "manual" });
    } catch (error) {
      return refuse(`${new URL(url).host} could not be reached for ${name}: ${String(error?.cause?.code ?? error?.message ?? error)}`);
    }
  };
  const first = await plain(publicUrl(tag, name));
  if (first.status === 200) return Buffer.from(await first.arrayBuffer());
  if (first.status !== 302) refuse(`the download of ${name} answered ${String(first.status)}`);
  let target;
  try {
    target = new URL(first.headers.get("location") ?? "");
  } catch {
    refuse(`the download of ${name} was redirected to no usable address`);
  }
  if (target.protocol !== "https:") refuse(`the download of ${name} was redirected to an address that is not https, and was not followed`);
  if (!STORAGE_HOSTS.includes(target.hostname) || target.port !== "" || target.username !== "" || target.password !== "") {
    refuse(`the download of ${name} was redirected to ${show(target.host)}, which is not one of GitHub's release storage hosts, and was not fetched`);
  }
  const stored = await plain(target.href);
  if (stored.status !== 200) refuse(`the download of ${name} from storage answered ${String(stored.status)}`);
  return Buffer.from(await stored.arrayBuffer());
}

/**
 * What the page is filled from: `{ tag, version, file, size, date, fingerprint }`, from the published release `tag` of the
 * fixed repository and the real bytes of its installer. Throws SiteBuildRefused for anything that is not as described. When
 * `verified` (a SHA-256, lower-case hex) is given, the installer that came must hash to it: it is the digest of the file the
 * deploy's verify checked the attestation of, so a file swapped between the two downloads is refused.
 */
export async function resolveRelease({ tag, fetch = globalThis.fetch, token, verified }) {
  let version;
  try {
    version = parseTag(tag);
  } catch (error) {
    refuse(error.message);
  }
  const names = assetNames(version);
  const api = `https://api.github.com/repos/${REPOSITORY}`;
  const headers = {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "petalock-site-build",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
  const get = async (url, extra = {}) => {
    try {
      return await fetch(url, { method: "GET", headers: { ...headers, ...extra }, redirect: "manual" });
    } catch (error) {
      return refuse(`GitHub could not be reached for ${new URL(url).pathname}: ${String(error?.cause?.code ?? error?.message ?? error)}`);
    }
  };

  const answer = await get(`${api}/releases/tags/${tag}`);
  if (answer.status !== 200) refuse(`the release ${tag} could not be read: GitHub answered ${String(answer.status)}`);
  let release;
  try {
    release = await answer.json();
  } catch {
    refuse(`the answer for release ${tag} is not JSON`);
  }
  if (release === null || typeof release !== "object" || Array.isArray(release)) refuse(`the answer for release ${tag} is not an object`);
  if (release.tag_name !== tag) refuse(`the answer is for tag ${show(release.tag_name)}, not ${tag}`);
  if (release.draft !== false) refuse(`the release ${tag} is a draft or not marked published; only a published release is offered`);
  const date = formatDate(release.published_at);
  if (!Array.isArray(release.assets)) refuse(`the release ${tag} lists no assets`);

  const installers = release.assets.filter((a) => typeof a?.name === "string" && INSTALLER_FORMAT.test(a.name));
  if (installers.length !== 1 || installers[0].name !== names.installer) {
    refuse(`the release must hold exactly one installer, named ${names.installer} (it holds ${String(installers.length)} installer files: .exe, .msi, .msix, .appx or a bundle)`);
  }
  const sidecars = release.assets.filter((a) => a?.name === names.sha256);
  if (sidecars.length !== 1) refuse(`the release must hold exactly one sidecar named ${names.sha256} (it holds ${String(sidecars.length)})`);
  const [installer] = installers;
  const [sidecar] = sidecars;
  for (const a of [installer, sidecar]) {
    if (a.state !== "uploaded") refuse(`${a.name}: its upload is not finished (state ${show(a.state)})`);
  }

  const download = (name) => downloadPublic({ tag, name, fetch });

  /** What GitHub lists for an asset must agree with the bytes that came: the size, and the sha256 digest when it gives one. */
  const agrees = (a, bytes) => {
    if (a.size !== bytes.length) refuse(`${a.name}: GitHub lists a size of ${String(a.size)} bytes but ${String(bytes.length)} came`);
    if (a.digest !== null && a.digest !== undefined) {
      if (typeof a.digest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(a.digest)) refuse(`${a.name}: GitHub's digest is not in the form sha256:<64 hex digits>`);
      if (a.digest !== `sha256:${sha256(bytes)}`) refuse(`${a.name}: GitHub's digest is not the hash of the bytes that came`);
    }
  };

  const sidecarBytes = await download(sidecar.name);
  agrees(sidecar, sidecarBytes);
  const claimed = parseSidecar(sidecarBytes.toString("utf8"), names.installer);
  const bytes = await download(installer.name);
  if (bytes.length === 0) refuse(`${names.installer} downloaded as an empty file`);
  agrees(installer, bytes);
  const fingerprint = sha256(bytes);
  if (fingerprint !== claimed) refuse(`the sidecar's fingerprint is not the hash of the installer's bytes (sidecar ${claimed}, bytes ${fingerprint})`);
  if (verified !== undefined && fingerprint !== verified) {
    refuse(`the installer that came is not the file that was verified (verified ${verified}, downloaded ${fingerprint}); the release changed while the deploy ran`);
  }
  return { tag, version, file: names.installer, size: formatSize(bytes.length), date, fingerprint };
}

/** The file the deploy's verify writes, inside its folder, when `gh attestation verify` accepted the installer: the installer's SHA-256. */
export const VERIFIED_FILE = "verified-sha256.txt";

/** The digest the verify wrote in `dir`: exactly 64 lower-case hex digits and an optional final newline. Missing or anything else is refused. */
function readVerifiedDigest(dir) {
  let text;
  try {
    text = readFileSync(join(dir, VERIFIED_FILE), "utf8");
  } catch {
    return refuse(`${VERIFIED_FILE} is missing from ${dir}: the installer was not verified, so the site is not built`);
  }
  if (!/^[0-9a-f]{64}\n?$/.test(text)) refuse(`${VERIFIED_FILE} is not one SHA-256 (64 lower-case hex digits): the installer was not verified, so the site is not built`);
  return text.trim();
}

/** The one public address of a release file: what the page's buttons point at and what the build downloads. */
export const publicUrl =(tag, file) => `${GITHUB}/releases/download/${tag}/${file}`;

/** The path the page's PowerShell line assumes: the Downloads folder of the person running it. */
export const downloadsPath = (file) => `$HOME\\Downloads\\${file}`;

/** The check the page shows: `-LiteralPath`, so brackets in a path are not wildcards. `fingerprint` is shown in capitals. */
export const powershellLine = ({ path, fingerprint }) => `(Get-FileHash -LiteralPath "${path}").Hash -eq "${fingerprint}"`;

/**
 * For a file saved elsewhere or renamed: the path is typed once, at a prompt, and so is data (never parsed as PowerShell
 * code); the fingerprint check then uses it as `$f`. Two lines, to be pasted together. `fingerprint` is shown in capitals.
 */
export const powershellAlternative = ({ fingerprint }) =>
  `$f = Read-Host "Full path of the downloaded file"\n(Get-FileHash -LiteralPath $f).Hash -eq "${fingerprint}"`;

/**
 * The signer GitHub's build record must show: the certificate identity of the release workflow file on main. (`--signer-workflow`
 * names the file without a ref and cannot be combined with this; `--source-ref` also constrains the source ref. Flags checked
 * against `gh attestation verify --help`, gh 2.103.3.)
 */
const ATTEST_IDENTITY = `${GITHUB}/.github/workflows/release.yml@refs/heads/main`;
const ATTEST_PINS = `--repo ${REPOSITORY} --cert-identity "${ATTEST_IDENTITY}" --source-ref refs/heads/main`;

/**
 * The same pins as the words a program is given (no shell quoting): what the deploy's own check (scripts/site-verify.mjs) passes
 * to `gh attestation verify`, so the check that runs before a deploy is the check the page tells a visitor to run.
 */
export const ATTEST_ARGS = Object.freeze(["--repo", REPOSITORY, "--cert-identity", ATTEST_IDENTITY, "--source-ref", "refs/heads/main"]);

/** GitHub's build record for the file in Downloads, pinned to the release workflow on main. */
export const attestationLine = (file) => `gh attestation verify "${downloadsPath(file)}" ${ATTEST_PINS}`;

/** The same check for the file at the path held in `$f` by `powershellAlternative`'s first line. */
export const attestationAlternative = () => `gh attestation verify $f ${ATTEST_PINS}`;

// ---------------------------------------------------------------------------------------------------------------------
// The pages

const PAGES = ["index.html", "guide/index.html", "404.html"];
const PLACEHOLDER_FILE = "Petalock_<version>_x64-setup.exe";

const escapeHtml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** What the templates may use: `text` is escaped where it is written, `raw` is markup this script made. */
function variables(release) {
  const links = {
    repo_url: GITHUB,
    releases_url: `${GITHUB}/releases`,
    security_url: `${GITHUB}/blob/main/SECURITY.md`,
  };
  const raw = {
    picture_hero: heroPicture(),
    picture_guide: guidePicture(),
    picture_404: notFoundPicture(),
    band: band(),
    icon_menu: icon(22),
    icon_foot: icon(18),
    arrow: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11m0 0-4.5-4.5M12 15l4.5-4.5M5 19h14"/></svg>',
  };
  if (release === null) {
    return {
      text: {
        ...links,
        notes_url: links.releases_url,
        ps_line: powershellLine({ path: downloadsPath(PLACEHOLDER_FILE), fingerprint: "<fingerprint>" }),
        ps_alt: powershellAlternative({ fingerprint: "<fingerprint>" }),
        gh_line: attestationLine(PLACEHOLDER_FILE),
        gh_alt: attestationAlternative(),
      },
      raw,
    };
  }
  return {
    text: {
      ...links,
      version: release.version,
      size: release.size,
      date: release.date,
      file: release.file,
      download_url: publicUrl(release.tag, release.file),
      notes_url: `${GITHUB}/releases/tag/${release.tag}`,
      ps_line: powershellLine({ path: downloadsPath(release.file), fingerprint: release.fingerprint.toUpperCase() }),
      ps_alt: powershellAlternative({ fingerprint: release.fingerprint.toUpperCase() }),
      gh_line: attestationLine(release.file),
      gh_alt: attestationAlternative(),
    },
    raw: { ...raw, fingerprint_groups: release.fingerprint.match(/.{8}/g).map((group) => `<span class="fp-group">${group}</span>`).join(" ") },
  };
}

/** One template filled for a state (`release` or `soon`); throws when a name is unknown or a marker is left over. */
export function renderTemplate(template, vars, state) {
  // `<\!--` (not `<!--`) in these patterns: semgrep's parser reads `<!--` inside a regular expression as an old-style
  // HTML comment and stops scanning the file.
  const kept = template.replace(/<\!--if:(release|soon)-->([\s\S]*?)<\!--\/if-->/g, (_, which, body) => (which === state ? body : ""));
  const filled = kept.replace(/\{\{\{([a-z_0-9]+)\}\}\}|\{\{([a-z_0-9]+)\}\}/g, (whole, rawName, textName) => {
    const value = rawName === undefined ? vars.text[textName] : vars.raw[rawName];
    if (typeof value !== "string") refuse(`a template uses ${whole}, which this build does not have`);
    return rawName === undefined ? escapeHtml(value) : value;
  });
  if (/\{\{|\}\}|<\!--\/?if/.test(filled)) refuse("a template marker was left over after the page was filled");
  return filled;
}

/** The files copied as they are: the style sheet, the headers, the two fonts and their two licences. Nothing else in site/ ships. */
const COPIED = ["styles.css", "_headers", "fonts/geist-latin-wght-normal.woff2", "fonts/geist-mono-latin-wght-normal.woff2", "fonts/LICENSE-geist.txt", "fonts/LICENSE-geist-mono.txt"];

/** The site folder itself must be a real folder: a link or junction to another tree would let every file below it pass the checks. */
function requireRealSiteFolder(siteDir) {
  let stat;
  try {
    stat = lstatSync(siteDir);
  } catch {
    refuse("the site folder is missing");
  }
  if (!stat.isDirectory()) refuse(`the site folder ${siteDir} is not a regular folder (a link, a junction or a file)`);
}

/** The bytes of `site/<path>`, which must be a regular file in real folders: a missing file, a folder or a link is refused. */
function readRegular(siteDir, path) {
  const parts = path.split("/");
  let at = siteDir;
  for (const folder of parts.slice(0, -1)) {
    at = join(at, folder);
    let stat;
    try {
      stat = lstatSync(at);
    } catch {
      refuse(`site/${parts.slice(0, parts.indexOf(folder) + 1).join("/")} is missing or not a regular folder`);
    }
    if (!stat.isDirectory()) refuse(`site/${parts.slice(0, parts.indexOf(folder) + 1).join("/")} is not a regular folder (a link or a file)`);
  }
  let stat;
  try {
    stat = lstatSync(join(at, parts.at(-1)));
  } catch {
    refuse(`site/${path} is missing or not a regular file`);
  }
  if (!stat.isFile()) refuse(`site/${path} is missing or not a regular file (it is a link or a folder)`);
  return readFileSync(join(at, parts.at(-1)));
}

/** Every file of the site as `Map(path -> Buffer)`: the three pages filled for `release` (or null: Coming soon), and the six copied files. */
export function renderSite({ siteDir, release }) {
  requireRealSiteFolder(siteDir);
  const files = new Map();
  const vars = variables(release);
  const state = release === null ? "soon" : "release";
  for (const page of PAGES) files.set(page, Buffer.from(renderTemplate(readRegular(siteDir, page).toString("utf8"), vars, state)));
  for (const name of COPIED) files.set(name, readRegular(siteDir, name));
  return files;
}

/**
 * Reads release.json, resolves the release if it names one, makes every page, and only then writes them into `outDir`
 * (beside it first, then moved). Returns `{ state, release, files }`.
 */
export async function buildSite({ siteDir, outDir, fetch = globalThis.fetch, token, verifiedFrom }) {
  requireRealSiteFolder(siteDir);
  if (existsSync(outDir) && readdirSync(outDir).length > 0) refuse(`the output folder ${outDir} already exists and is not empty; remove it first`);
  let text;
  try {
    text = readFileSync(join(siteDir, "release.json"), "utf8");
  } catch {
    text = undefined;
  }
  const choice = readReleaseChoice(text);
  // With `verifiedFrom` (the folder scripts/site-verify.mjs wrote to) a named release is built only if its installer is the one
  // that was verified; with none named there is no installer, so nothing was verified and the folder is not read.
  const verified = choice.tag !== null && verifiedFrom !== undefined ? readVerifiedDigest(verifiedFrom) : undefined;
  const release = choice.tag === null ? null : await resolveRelease({ tag: choice.tag, fetch, token, verified });
  const files = renderSite({ siteDir, release });

  mkdirSync(dirname(resolve(outDir)), { recursive: true });
  const staging = mkdtempSync(`${resolve(outDir)}.partial-`);
  try {
    for (const [path, bytes] of files) {
      const target = join(staging, ...path.split("/"));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, bytes);
    }
    if (existsSync(outDir)) rmdirSync(outDir);
    renameSync(staging, outDir);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  return { state: release === null ? "soon" : "release", release, files: [...files.keys()] };
}

// ---------------------------------------------------------------------------------------------------------------------
// The command

function parseArgs(argv) {
  const out = { site: join(ROOT, "site"), out: join(ROOT, "target", "site"), verifiedFrom: undefined };
  for (let at = 0; at < argv.length; at += 2) {
    const flag = argv[at];
    const value = argv[at + 1];
    if ((flag !== "--site" && flag !== "--out" && flag !== "--verified-from") || value === undefined || value.startsWith("-") || value === "") return null;
    out[flag === "--verified-from" ? "verifiedFrom" : flag.slice(2)] = resolve(value);
  }
  return out;
}

/** Runs the command; returns the exit status. */
export async function main(argv, env = process.env) {
  const args = parseArgs(argv);
  if (args === null) {
    process.stderr.write("usage: node scripts/site-build.mjs [--site <folder>] [--out <folder>] [--verified-from <folder>]\n");
    return 2;
  }
  try {
    const result = await buildSite({ siteDir: args.site, outDir: args.out, token: env.GITHUB_TOKEN || undefined, verifiedFrom: args.verifiedFrom });
    const what = result.release === null ? "the Coming soon page" : `${result.release.file} (${result.release.size}, ${result.release.date}, SHA-256 ${result.release.fingerprint})`;
    process.stdout.write(`site-build: built ${what}; ${String(result.files.length)} files in ${args.out}\n`);
    return 0;
  } catch (error) {
    if (!(error instanceof SiteBuildRefused)) process.stderr.write("site-build: unexpected failure\n");
    let message = String(error?.message ?? error);
    if (env.GITHUB_TOKEN) message = message.split(env.GITHUB_TOKEN).join("***");
    process.stderr.write(`site-build: ${message}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
