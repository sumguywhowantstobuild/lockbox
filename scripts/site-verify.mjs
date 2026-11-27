#!/usr/bin/env node
// The check that runs before the site is built for a deploy (Plan 5, Task 7): the installer the page would offer is downloaded
// from the same public address the page's button uses, and `gh attestation verify` is run on it with the same pins the page
// shows a visitor (scripts/site-build.mjs, ATTEST_ARGS): this repository, and the release workflow on main as the signer. A
// release whose installer and fingerprint were swapped together passes the build's own hash check, but not this one: the
// swapped file was not built by that workflow.
//
//   node scripts/site-verify.mjs --dir <folder> [--site <folder>]       the site defaults to site/
//
// `site/release.json` is read as the build reads it. Only when it is exactly `{"tag": null}` (no release offered, the page is
// "Coming soon") is there no installer, and the check ends with nothing downloaded; any other release.json that is not a valid
// choice is refused, never skipped. The installer is written into `--dir` (which must not hold it already) and given to `gh` as
// a file name, with no shell. `gh` needs a token in GH_TOKEN (the run's own, read-only). Once `gh` has accepted the file, its
// SHA-256 is written beside it (VERIFIED_FILE); the build is given that folder (`--verified-from`) and refuses to build with an
// installer whose hash differs, so the file that is verified is the file that is fingerprinted. The download follows the
// build's rule: the public address, and a redirect only to GitHub's release-storage hosts.
//
// Exit status: 0 verified, or nothing to verify; 1 refused (the reason on stderr); 2 not understood.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assetNames, parseTag } from "./release-guard.mjs";
import { ATTEST_ARGS, SiteBuildRefused, VERIFIED_FILE, downloadPublic, readReleaseChoice } from "./site-build.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

const refuse = (message) => {
  throw new SiteBuildRefused(message);
};

/**
 * Downloads the installer of the release `release.json` names and verifies its attestation. Returns `{ state: "skipped" }` for
 * exactly `{"tag": null}`, `{ state: "verified", file }` when `gh` accepted the file. Anything else throws SiteBuildRefused.
 * `fetch` and `run` (a `spawnSync`) are the outside world, replaceable for tests.
 */
export async function verifyInstaller({ siteDir, dir, fetch = globalThis.fetch, run = spawnSync }) {
  let text;
  try {
    text = readFileSync(join(siteDir, "release.json"), "utf8");
  } catch {
    text = undefined;
  }
  const { tag } = readReleaseChoice(text);
  if (tag === null) return { state: "skipped" };

  const { installer } = assetNames(parseTag(tag));
  // The build's own download, by its own rule: the public address, and a redirect only to GitHub's release storage.
  const bytes = await downloadPublic({ tag, name: installer, fetch });
  if (bytes.length === 0) refuse(`${installer} downloaded as an empty file`);

  const file = join(dir, installer);
  mkdirSync(dir, { recursive: true });
  try {
    writeFileSync(file, bytes, { flag: "wx" });
  } catch {
    return refuse(`${file} already exists or cannot be written; the check needs a folder of its own`);
  }

  const result = run("gh", ["attestation", "verify", file, ...ATTEST_ARGS], { stdio: "inherit", windowsHide: true });
  if (result?.error) refuse(`gh attestation verify could not be run for ${installer}: ${String(result.error.code ?? result.error.message)}`);
  if (result?.status !== 0) refuse(`gh attestation verify did not accept ${installer} (it ended ${result?.signal ? `with ${String(result.signal)}` : `with status ${String(result?.status)}`}); nothing is deployed`);
  // What was verified, for the build to compare with: written only now that gh accepted these bytes. The build downloads the
  // installer again to hash it for the page; a file swapped in between would hash differently and the build would stop.
  const digest = createHash("sha256").update(bytes).digest("hex");
  try {
    writeFileSync(join(dir, VERIFIED_FILE), `${digest}\n`, { flag: "wx" });
  } catch {
    return refuse(`${VERIFIED_FILE} could not be written in ${dir}`);
  }
  return { state: "verified", file, digest };
}

function parseArgs(argv) {
  const out = { site: join(ROOT, "site"), dir: undefined };
  for (let at = 0; at < argv.length; at += 2) {
    const flag = argv[at];
    const value = argv[at + 1];
    if ((flag !== "--site" && flag !== "--dir") || value === undefined || value.startsWith("-") || value === "") return null;
    out[flag.slice(2)] = resolve(value);
  }
  return out.dir === undefined ? null : out;
}

/** Runs the command; returns the exit status. */
export async function main(argv) {
  const args = parseArgs(argv);
  if (args === null) {
    process.stderr.write("usage: node scripts/site-verify.mjs --dir <folder> [--site <folder>]\n");
    return 2;
  }
  try {
    const result = await verifyInstaller({ siteDir: args.site, dir: args.dir });
    process.stdout.write(
      result.state === "skipped"
        ? "site-verify: no installer is offered (Coming soon), so there is nothing to verify\n"
        : `site-verify: gh attestation verify accepted ${result.file}\n`,
    );
    return 0;
  } catch (error) {
    if (!(error instanceof SiteBuildRefused)) process.stderr.write("site-verify: unexpected failure\n");
    process.stderr.write(`site-verify: ${String(error?.message ?? error)}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
