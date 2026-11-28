// Plan 5, Task 3: the open-source licence texts inside the installer. `scripts/licences.mjs` builds THIRD-PARTY-NOTICES.txt in
// the installer's build (never committed): the full licence text and copyright lines of every Rust library and page package
// the app ships, the fonts' licences, and the two word lists' notices. These are its tests.
//
// Two kinds. The first run on made-up components (MU-) and need nothing installed: they prove each rule, and that each check
// fires on a wrong result and on no change at all. The second read the real file the build generated (`NOTICES_FILE`) and the
// real tools (`CARGO_ABOUT`), and are skipped where those are not set: `build-installer.yml` sets both and runs this file, so
// they run on every push; `node scripts/licences.mjs` and the two variables run them on a PC with the pinned binary.
// `installed_copy_has_the_notices_file`, which reads the installed file on the runner, is in installer-smoke.test.mjs with
// the other checks of that script.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  ACCEPTED,
  CRATE_EXCEPTIONS,
  allowedLicence,
  chooseLicences,
  collectNotices,
  dataSection,
  expectation,
  harvestFiles,
  hasCopyrightLine,
  matchesLicence,
  normaliseText,
  cargoMetadataArgs,
  cargoTreeArgs,
  packageComponents,
  parseClarifications,
  parseNotices,
  renderNotices,
  scopeToShipped,
  shippedCrates,
  verifyNotices,
} from "./licences.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(ROOT, path), "utf8").replace(/\r\n/g, "\n");
const BUILD = ".github/workflows/build-installer.yml";

// ---------------------------------------------------------------------------------------------------------------------
// Made-up components. The licence texts are the standard ones; the holders and names are invented.

const MIT_BODY = `Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
documentation files (the "Software"), to deal in the Software without restriction, including without limitation the
rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit
persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the
Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED.
`;
const mit = (holder) => `MIT License\n\nCopyright (c) 2026 ${holder}\n\n${MIT_BODY}`;
const MIT_PLACEHOLDER = `MIT License\n\nCopyright (c) <year> <copyright holders>\n\n${MIT_BODY}`;
const APACHE = `                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

   "License" shall mean the terms and conditions for use, reproduction, and distribution as defined by Sections 1
   through 9 of this document. "Licensor" shall mean the copyright owner or entity authorized by the copyright owner
   that is granting the License.

   APPENDIX: How to apply the Apache License to your work.

   Copyright [yyyy] [name of copyright owner]

   Licensed under the Apache License, Version 2.0 (the "License");
`;
const OFL = (holder) => `Copyright (c) 2026 ${holder} (https://mu-fonts.invalid)

This Font Software is licensed under the SIL Open Font License, Version 1.1.

-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide development of collaborative font projects.
`;
const NOTICE = "MU-notice: this product includes software developed by MU-Foundation (https://mu-foundation.invalid).\n";

const file = (name, text) => ({ name, text });
const component = (name, version, ids, files, generated = [], clarified = []) => ({ name, version, ids, files, generated, clarified });
const sha = (text) => createHash("sha256").update(text).digest("hex");

/** Four made-up crates: two with one MIT text (one group), one dual-licensed MIT-or-Apache, one Apache with a NOTICE file. */
function crates() {
  return [
    component("MU-alpha", "1.0.0", ["MIT"], [file("LICENSE-MIT", mit("MU-Holder Alpha"))]),
    component("MU-delta", "0.4.2", ["MIT"], [file("LICENSE", mit("MU-Holder Alpha"))]),
    component("MU-beta", "2.1.0", ["MIT"], [file("LICENSE-MIT", mit("MU-Holder Beta")), file("LICENSE-APACHE", APACHE)]),
    component("MU-gamma", "3.0.0", ["Apache-2.0"], [file("LICENSE", APACHE), file("NOTICE", NOTICE)]),
  ];
}

function packages() {
  return [
    component("MU-pkg", "5.0.1", ["MIT"], [file("LICENSE", mit("MU-Holder Pkg"))]),
    component("@fontsource-variable/MU-serif", "5.3.0", ["OFL-1.1"], [file("LICENSE", OFL("MU-Font Authors"))]),
  ];
}

const MPL = `Mozilla Public License Version 2.0
==================================

1. Definitions
--------------

1.1. "Contributor" means each individual or legal entity that creates, contributes to the creation of, or owns Covered Software.
`;

/** The made-up file, rendered as the generator renders it, with the made-up data section. */
function madeUpFile(extraCrates = []) {
  const all = [...crates(), ...extraCrates];
  const c = collectNotices(all, "crate");
  const p = collectNotices(packages(), "package");
  assert.deepEqual([...c.problems, ...p.problems], []);
  const text = renderNotices({ data: "# MU-data\n\n## MU-wordlist\nMU-credit\n", crates: c.groups, packages: p.groups });
  return {
    text,
    expected: {
      crates: all.map((one) => expectation(one, "crate")),
      packages: packages().map((one) => expectation(one, "package")),
      fonts: ["@fontsource-variable/MU-serif"],
    },
  };
}

const check = (text, expected) => verifyNotices(parseNotices(text), expected);

/** The real pinned binary, where `CARGO_ABOUT` names it; the tests that run it are skipped without. */
const realTool = { skip: process.env.CARGO_ABOUT && existsSync(process.env.CARGO_ABOUT) ? false : "CARGO_ABOUT is not set" };

// ---------------------------------------------------------------------------------------------------------------------

test("notices_carry_every_shipped_crates_licence_text: a made-up set carries each text, copyright line and NOTICE", () => {
  const { text, expected } = madeUpFile();
  assert.deepEqual(check(text, expected), []);
  const parsed = parseNotices(text);
  assert.equal(parsed.parts.crates.length >= 4, true, "one block per distinct text, a NOTICE block included");
  for (const needle of ["Copyright (c) 2026 MU-Holder Alpha", "Copyright (c) 2026 MU-Holder Beta", NOTICE.trim(), "TERMS AND CONDITIONS FOR USE"]) {
    assert.ok(text.includes(needle), `the file carries: ${needle}`);
  }
  const alpha = parsed.parts.crates.find((b) => b.kind === "licence" && b.usedBy.some((u) => u.name === "MU-alpha"));
  assert.deepEqual(alpha.usedBy.map((u) => u.name).sort(), ["MU-alpha", "MU-delta"], "one text, two crates, one block");
  // The dual-licensed crate shows both files it publishes, each as published; the Apache text is one block for both users.
  const beta = parsed.parts.crates.filter((b) => b.usedBy.some((u) => u.name === "MU-beta"));
  assert.deepEqual(beta.map((b) => b.licence).sort(), ["Apache-2.0", "MIT"]);
  assert.deepEqual(beta.find((b) => b.licence === "Apache-2.0").usedBy.map((u) => u.name), ["MU-beta", "MU-gamma"]);
  assert.match(text, /Used by \(2\):/);
});

test("notices_carry_every_shipped_crates_licence_text: a library under the Mozilla licence has its source address given", () => {
  const mozilla = component("MU-moz", "7.1.0", ["MPL-2.0"], [file("LICENSE", MPL)]);
  const { text, expected } = madeUpFile([mozilla]);
  assert.deepEqual(check(text, expected), []);
  assert.match(text, /Source code of the libraries under the Mozilla Public License 2\.0/);
  assert.ok(text.includes("MU-moz 7.1.0: https://crates.io/crates/MU-moz/7.1.0"));
  // The address taken out: the second reading names the library.
  assert.match(check(text.replace("https://crates.io/crates/MU-moz/7.1.0", ""), expected).join("\n"), /MU-moz 7\.1\.0.*source-code address/);
  // A file with no Mozilla library has no such heading.
  assert.ok(!madeUpFile().text.includes("Mozilla Public License 2.0\nThe licence asks"));
});

test("notices_carry_every_shipped_crates_licence_text: the check fires on a wrong result, and passes on none", () => {
  const { text, expected } = madeUpFile();
  // No change: nothing found.
  assert.deepEqual(check(text, expected), []);
  // A crate's block removed: it is named.
  const parsed = parseNotices(text);
  const betaBlock = parsed.parts.crates.find((b) => b.licence === "MIT" && b.usedBy.some((u) => u.name === "MU-beta"));
  const without = text.replace(betaBlock.raw, "");
  assert.notEqual(without, text);
  assert.match(check(without, expected).join("\n"), /MU-beta 2\.1\.0: its own licence text/);
  // A crate whose only block is gone has no licence text at all.
  const alphaBlock = parsed.parts.crates.find((b) => b.usedBy.some((u) => u.name === "MU-alpha"));
  assert.match(check(text.replace(alphaBlock.raw, ""), expected).join("\n"), /MU-alpha 1\.0\.0: no licence text/);
  // The copyright line turned into the template's placeholder: refused.
  const placeholder = text.replace("Copyright (c) 2026 MU-Holder Beta", "Copyright (c) <year> <copyright holders>");
  assert.match(check(placeholder, expected).join("\n"), /MU-beta/);
  // The NOTICE text dropped: named.
  assert.match(check(text.replace(NOTICE.trim(), "MU-gone"), expected).join("\n"), /MU-gamma 3\.0\.0.*NOTICE/);
  // A file that holds no crate at all, and an expectation of none, are not a pass.
  assert.match(check(text, { ...expected, crates: [] }).join("\n"), /no Rust library was expected/);
  const empty = renderNotices({ data: "# MU-data\n", crates: [], packages: [] });
  assert.match(check(empty, expected).join("\n"), /no licence text/);
  // A truncated file (the footer line cut off) is refused.
  assert.match(check(text.slice(0, text.lastIndexOf("End of third-party notices")), expected).join("\n"), /footer/);
});

test("notices_carry_every_shipped_page_package_text: a made-up set carries each package, and the check fires", () => {
  const { text, expected } = madeUpFile();
  assert.deepEqual(check(text, expected), []);
  const parsed = parseNotices(text);
  assert.ok(parsed.parts.packages.some((b) => b.usedBy.some((u) => u.name === "MU-pkg")));
  const block = parsed.parts.packages.find((b) => b.usedBy.some((u) => u.name === "MU-pkg"));
  assert.match(check(text.replace(block.raw, ""), expected).join("\n"), /MU-pkg 5\.0\.1.*no licence text/);
  assert.match(check(text, { ...expected, packages: [] }).join("\n"), /no page package was expected/);
  assert.match(check(text.replace("Copyright (c) 2026 MU-Holder Pkg", "(c) MU-Holder Pkg"), expected).join("\n"), /MU-pkg/);
});

test("notices_carry_every_shipped_page_package_text: the production packages come from the lock file, never the dev ones", () => {
  const lock = {
    lockfileVersion: 3,
    packages: {
      "": { name: "MU-app" },
      "node_modules/MU-prod": { version: "1.0.0", license: "MIT" },
      "node_modules/MU-prod/node_modules/MU-nested": { version: "2.0.0", license: "MIT" },
      "node_modules/MU-dev": { version: "3.0.0", license: "MIT", dev: true },
      "node_modules/MU-devopt": { version: "4.0.0", license: "MIT", devOptional: true },
    },
  };
  const found = packageComponents({ lock, dirOf: (key) => `/MU/${key}`, readJson: () => ({ license: "MIT" }), list: () => [] });
  assert.deepEqual(found.map((c) => `${c.name}@${c.version}`).sort(), ["MU-nested@2.0.0", "MU-prod@1.0.0"]);
  assert.throws(() => packageComponents({ lock: { lockfileVersion: 2, packages: {} }, dirOf: () => "", readJson: () => ({}), list: () => [] }), /lockfileVersion/);
  assert.throws(() => packageComponents({ lock: { lockfileVersion: 3, packages: { "": {} } }, dirOf: () => "", readJson: () => ({}), list: () => [] }), /no production package/);
});

test("notices_carry_the_fonts_licences: each font package carries the Open Font License text with its copyright line", () => {
  const { text, expected } = madeUpFile();
  assert.deepEqual(check(text, expected), []);
  assert.match(text, /SIL OPEN FONT LICENSE Version 1\.1/);
  assert.match(text, /Copyright \(c\) 2026 MU-Font Authors/);
  // A font whose block is gone, or holds another licence, or no copyright line, fails; the check must name it.
  const block = parseNotices(text).parts.packages.find((b) => b.licence === "OFL-1.1");
  assert.match(check(text.replace(block.raw, ""), expected).join("\n"), /@fontsource-variable\/MU-serif 5\.3\.0/);
  assert.match(check(text.replace("Copyright (c) 2026 MU-Font Authors", "MU-Font Authors"), expected).join("\n"), /@fontsource-variable\/MU-serif/);
  assert.match(check(text, { ...expected, fonts: [] }).join("\n"), /no font was expected/);
  assert.match(check(text, { ...expected, fonts: ["@fontsource-variable/MU-missing"] }).join("\n"), /@fontsource-variable\/MU-missing/);
  // The font licence is for fonts alone.
  assert.equal(allowedLicence("package", "MU-pkg", "OFL-1.1"), false);
  assert.equal(allowedLicence("package", "@fontsource-variable/geist", "OFL-1.1"), true);
  assert.equal(allowedLicence("crate", "@fontsource-variable/geist", "OFL-1.1"), false);
});

test("notices_carry_the_fonts_licences: the word lists' notices ride along from the repository's own notice file", () => {
  const md = read("THIRD-PARTY-NOTICES.md");
  const data = dataSection(md);
  assert.match(data, /EFF Large Wordlist/);
  assert.match(data, /Creative Commons Attribution 3\.0/);
  assert.match(data, /Copyright \(c\) 2013-2016 Pavol Rusnak/);
  // The plugin built into Setup itself (tauri-bundler 2.10.5 fetches nsis_tauri_utils 0.5.3), whose MIT notice must
  // travel with every copy of the installer.
  assert.match(data, /nsis_tauri_utils\.dll` 0\.5\.3/);
  assert.match(data, /Copyright \(c\) 2019 - 2022 Tauri Programme within The Commons Conservancy/);
  assert.ok(!data.includes("## Libraries the desktop app uses directly"), "the library table is not part of it");
  assert.throws(() => dataSection("# Third-party notices\n\nnothing here\n"), /heading/);
  assert.throws(() => dataSection(md.replace("EFF Large Wordlist", "A list")), /EFF/);
});

test("a_dependency_named_but_without_its_text_fails", () => {
  // The negative fixture: the name is there, the text is not. Every way of having a name and no text stops the build.
  const cases = {
    "no licence file at all": component("MU-bare", "1.0.0", ["MIT"], [file("README.md", "MU-readme")]),
    "a file that is another licence": component("MU-wrong", "1.0.0", ["MIT"], [file("LICENSE", APACHE)]),
    "only the template's placeholder": component("MU-template", "1.0.0", ["MIT"], [], [{ id: "MIT", text: MIT_PLACEHOLDER }]),
    "a file with only the licence's name": component("MU-name", "1.0.0", ["MIT"], [file("LICENSE", "MIT")]),
    "an empty file": component("MU-empty", "1.0.0", ["MIT"], [file("LICENSE", "")]),
  };
  for (const [what, one] of Object.entries(cases)) {
    const { problems } = collectNotices([one], "crate");
    assert.equal(problems.length, 1, `${what}: ${problems.join("; ")}`);
    assert.match(problems[0], new RegExp(`${one.name} 1\\.0\\.0`), what);
  }
  // The same fixtures pass once the text is there (the failures above are the missing text, not the fixture's shape).
  const fixed = component("MU-ok", "1.0.0", ["MIT"], [file("LICENSE", mit("MU-Holder"))]);
  assert.deepEqual(collectNotices([fixed], "crate").problems, []);
  // A text cargo-about found by itself is accepted when it carries a real copyright line.
  const generated = component("MU-gen", "1.0.0", ["MIT"], [], [{ id: "MIT", text: mit("MU-Holder Generated") }]);
  assert.deepEqual(collectNotices([generated], "crate").problems, []);
  // An MIT file that the authors publish with no copyright line (the serde and syn families do) is carried as published: it
  // is their text, and a line made up for them would be a claim of ours. The second reading accepts it the same way.
  const bare = component("MU-nocopy", "1.0.0", ["MIT"], [file("LICENSE-MIT", `${MIT_BODY}`)]);
  const carried = collectNotices([bare], "crate");
  assert.deepEqual(carried.problems, []);
  assert.equal(carried.groups[0].text, MIT_BODY.trim());
  const bareFile = madeUpFile([bare]);
  assert.deepEqual(check(bareFile.text, bareFile.expected), []);
  // But where the library ships no file at all, a made text without a real copyright line is not good enough, in either reading.
  const noFile = madeUpFile([component("MU-nofile", "1.0.0", ["MIT"], [], [{ id: "MIT", text: mit("MU-Holder Made") }])]);
  assert.deepEqual(check(noFile.text, noFile.expected), []);
  const swapped = noFile.text.replace("Copyright (c) 2026 MU-Holder Made", "Copyright (c) <year> <copyright holders>");
  assert.match(check(swapped, noFile.expected).join("\n"), /MU-nofile 1\.0\.0: it ships no licence file/);
  // And a rendered file whose block has a name but no text is refused by the second check, which reads the file.
  const { text, expected } = madeUpFile();
  const block = parseNotices(text).parts.crates.find((b) => b.usedBy.some((u) => u.name === "MU-alpha"));
  const hollow = text.replace(block.raw, `${block.raw.split("\nText:\n")[0]}\nText:\n\n`);
  assert.notEqual(hollow, text);
  assert.match(check(hollow, expected).join("\n"), /MU-alpha/);
});

test("notices_refuse_an_unaccepted_licence", () => {
  assert.deepEqual(ACCEPTED, ["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "Zlib", "Unicode-3.0", "MPL-2.0", "OFL-1.1"]);
  assert.deepEqual(chooseLicences("MIT"), ["MIT"]);
  assert.deepEqual(chooseLicences("Apache-2.0 OR MIT"), ["MIT"], "the plan's order prefers MIT");
  assert.deepEqual(chooseLicences("MIT OR GPL-3.0-only"), ["MIT"]);
  assert.deepEqual(chooseLicences("(MIT OR Apache-2.0) AND Unicode-3.0"), ["MIT", "Unicode-3.0"]);
  assert.deepEqual(chooseLicences("OFL-1.1", { font: true }), ["OFL-1.1"]);
  for (const bad of ["GPL-3.0-only", "MIT AND GPL-3.0-only", "LGPL-2.1-or-later", "BSL-1.0", "CC0-1.0", "MIT-0", "0BSD", "Unlicense",
    "OFL-1.1", "Apache-2.0 WITH LLVM-exception", "MIT+", "", "MIT OR", "(MIT", "MIT)", "SEE LICENSE IN LICENSE.txt", "AGPL-3.0-or-later OR GPL-2.0-only"]) {
    assert.equal(chooseLicences(bad), null, `refused: ${JSON.stringify(bad)}`);
  }
  // The same decision where a crate or a package carries the licence.
  for (const [kind, name, id, ok] of [
    ["crate", "MU-x", "MIT", true], ["crate", "MU-x", "GPL-3.0-only", false], ["crate", "MU-x", "BSL-1.0", false],
    ["crate", "clipboard-win", "BSL-1.0", true], ["crate", "error-code", "BSL-1.0", true], ["crate", "clipboard-win", "GPL-3.0-only", false],
    ["package", "MU-x", "BSL-1.0", false], ["package", "clipboard-win", "BSL-1.0", false], ["crate", "MU-x", "OFL-1.1", false],
  ]) {
    assert.equal(allowedLicence(kind, name, id), ok, `${kind} ${name} ${id}`);
  }
  assert.deepEqual(CRATE_EXCEPTIONS, { "clipboard-win": "BSL-1.0", "error-code": "BSL-1.0" });
  // A component that arrives with a licence outside the list stops the build.
  const gpl = component("MU-gpl", "1.0.0", ["GPL-3.0-only"], [file("LICENSE", "MU- GNU GENERAL PUBLIC LICENSE Version 3")]);
  assert.match(collectNotices([gpl], "crate").problems.join("\n"), /MU-gpl 1\.0\.0.*GPL-3\.0-only.*not accepted/);
  // A block in a rendered file under a licence outside the list is refused as well.
  const { text, expected } = madeUpFile();
  assert.match(check(text.replace(/^Licence text: Apache-2\.0$/m, "Licence text: GPL-3.0-only"), expected).join("\n"), /GPL-3\.0-only/);
});

test("notices_refuse_an_unaccepted_licence: about.toml carries exactly the plan's list and the two named exceptions", () => {
  const lines = read("about.toml").split("\n");
  const sections = new Map([["", []]]);
  let current = "";
  for (const line of lines) {
    const header = line.match(/^\[([^\]]+)\]\s*$/);
    if (header) {
      current = header[1];
      sections.set(current, []);
    } else if (!/^\s*(#.*)?$/.test(line) && !line.startsWith("[[")) {
      sections.get(current).push(line);
    }
  }
  const listOf = (body) => [...(body.join("\n").match(/^accepted\s*=\s*\[([^\]]*)\]/m)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  // The plan's list in the plan's order, less the fonts' licence (no Rust library may use it).
  assert.deepEqual(listOf(sections.get("")), ACCEPTED.filter((id) => id !== "OFL-1.1"));
  const perCrate = [...sections].filter(([name, body]) => name && !name.includes(".") && listOf(body).length > 0);
  assert.deepEqual(Object.fromEntries(perCrate.map(([name, body]) => [name, listOf(body)])), { "clipboard-win": ["BSL-1.0"], "error-code": ["BSL-1.0"] });
  const text = read("about.toml");
  assert.match(text, /^targets = \["x86_64-pc-windows-msvc"\]$/m);
  assert.match(text, /^ignore-build-dependencies = true$/m);
  assert.match(text, /^ignore-dev-dependencies = true$/m);
  // Every clarification is pinned to the file's SHA-256 and names the licence it clarifies.
  const clarified = [...text.matchAll(/^\[\[([\w-]+)\.clarify\.git\]\]\npath = "([^"]+)"\nlicense = "([^"]+)"\nchecksum = "([0-9a-f]{64})"$/gm)];
  // The macro crate (webview2-com-macros) is compiled by the compiler and not shipped: it has no clarification any more.
  assert.deepEqual(clarified.map((m) => m[1]).sort(), ["alloc-stdlib", "webview2-com", "webview2-com-sys"]);
  assert.ok(!/webview2-com-macros/.test(text.replace(/#[^\n]*/g, "")), "no rule for a crate that is not shipped");
  assert.deepEqual([...parseClarifications(text)].map(([name, list]) => `${name}:${list.map((c) => c.id).join()}`).sort(), ["alloc-stdlib:BSD-3-Clause", "webview2-com-sys:MIT", "webview2-com:MIT"]);
  for (const m of clarified) assert.ok(ACCEPTED.includes(m[3]), `${m[1]} clarifies an accepted licence`);
});

test("copyright lines are real ones, and the checks are quick on a large hostile text", () => {
  for (const real of ["Copyright (c) 2014 Alex Crichton", "Copyright (c) Microsoft Corporation.", "Copyright © 1991-2023 Unicode, Inc.",
    "  Copyright 2020 MU-Holder", " * Copyright (c) 2016 Dropbox, Inc.", "COPYRIGHT (C) 2019 MU-Holder"]) {
    assert.ok(hasCopyrightLine(`Header\n${real}\nBody`), real);
  }
  for (const not of ["Copyright (c) <year> <copyright holders>", "Copyright [yyyy] [name of copyright owner]", "copyright notice, this list of conditions",
    "copyright owner or entity authorized by the copyright owner", "COPYRIGHT AND PERMISSION NOTICE", "(c) You must retain, in the Source form",
    "the above copyright notice shall be included", "copyright license to reproduce", "Copyright", "Copyright (c)", ""]) {
    assert.ok(!hasCopyrightLine(`Header\n${not}\nBody`), `refused: ${not}`);
  }
  const hostile = `${"copyright ".repeat(100_000)}\n${" ".repeat(200_000)}x\n${"(c)".repeat(100_000)}`;
  const slowest = [() => hasCopyrightLine(hostile), () => matchesLicence("MIT", hostile), () => matchesLicence("Apache-2.0", hostile),
    () => normaliseText(hostile)].map((run) => {
    const started = process.hrtime.bigint();
    run();
    return Number(process.hrtime.bigint() - started) / 1e6;
  });
  assert.ok(Math.max(...slowest) < 1500, `slowest ${Math.max(...slowest)} ms`);
  // Each licence is recognised by its own words and not another's.
  assert.ok(matchesLicence("MIT", mit("MU")) && !matchesLicence("MIT", APACHE) && !matchesLicence("Apache-2.0", mit("MU")));
  assert.ok(matchesLicence("OFL-1.1", OFL("MU")) && !matchesLicence("OFL-1.1", mit("MU")));
  assert.ok(!matchesLicence("MIT", "MIT") && !matchesLicence("MIT", ""));
});

// ---------------------------------------------------------------------------------------------------------------------
// The workflow: the tool is pinned, its digest checked before use, and the file is made before the build that bundles it.

// ---------------------------------------------------------------------------------------------------------------------
// The review's fix round (Codex, 2026-11-26): one test or more for each finding fixed, each written to fail before the fix.

test("fix_2_a_third_library_under_BSL_1_0_still_stops_the_build_with_the_shipping_configuration", () => {
  // The exceptions are in place (Ariel approved them): the two named crates pass, any other name under BSL-1.0 does not.
  const boost = [file("LICENSE", "Boost Software License - Version 1.0 - August 17th, 2003\n\nMU-text")];
  const allowed = [component("clipboard-win", "5.4.3", ["BSL-1.0"], boost), component("error-code", "3.4.0", ["BSL-1.0"], boost)];
  assert.deepEqual(collectNotices(allowed, "crate").problems, []);
  const third = component("MU-third", "1.0.0", ["BSL-1.0"], boost);
  assert.match(collectNotices([...allowed, third], "crate").problems.join("\n"), /MU-third 1\.0\.0: licence BSL-1\.0 is not accepted/);
  // The same crate names under a different licence, or at a changed name, get no exception.
  assert.match(collectNotices([component("clipboard-win-ng", "1.0.0", ["BSL-1.0"], boost)], "crate").problems.join("\n"), /not accepted/);
});

test("fix_4_a_separate_COPYRIGHT_file_is_carried_into_the_notices", () => {
  const holder = "Copyright (c) 2026 MU-Holder Separate\nAll rights reserved by MU-Holder Separate.";
  const one = component("MU-copy", "1.0.0", ["MIT"], [file("LICENSE-MIT", `${MIT_BODY}`), file("COPYRIGHT", holder)]);
  const carried = collectNotices([one], "crate");
  assert.deepEqual(carried.problems, []);
  assert.ok(carried.groups.some((g) => g.kind === "notice" && g.text.includes("MU-Holder Separate") && g.usedBy[0].name === "MU-copy"), "the file is a block of its own");
  assert.ok(!carried.groups.some((g) => g.kind === "licence" && g.text.includes("MU-Holder Separate")), "and not taken for a licence text");
  const made = madeUpFile([one]);
  assert.deepEqual(check(made.text, made.expected), []);
  // Dropped from the file, or changed there: the second reading names the crate.
  assert.match(check(made.text.replaceAll("MU-Holder Separate", "MU-Holder Gone"), made.expected).join("\n"), /MU-copy 1\.0\.0: its NOTICE text is not in the file/);
  // Crates that publish no attribution at all stay as published (the serde and syn families): nothing is made up for them.
  const bare = collectNotices([component("MU-serde-like", "1.0.0", ["MIT"], [file("LICENSE-MIT", MIT_BODY)])], "crate");
  assert.deepEqual(bare.problems, []);
  assert.deepEqual(bare.groups.map((g) => g.kind), ["licence"]);
});

test("fix_5_a_licence_file_over_the_size_limit_or_unreadable_fails_instead_of_being_skipped", () => {
  const dir = mkdtempSync(join(tmpdir(), "harvest-"));
  try {
    writeFileSync(join(dir, "LICENSE-MIT"), mit("MU-Holder"));
    mkdirSync(join(dir, "LICENSES"));
    assert.deepEqual(harvestFiles(dir).map((f) => f.name), ["LICENSE-MIT"], "a folder named like a licence is not a file");
    // One byte over the limit: named, not skipped.
    writeFileSync(join(dir, "NOTICE"), "x".repeat(1_000_001));
    assert.throws(() => harvestFiles(dir), /NOTICE.*1000001 bytes.*limit/);
    rmSync(join(dir, "NOTICE"));
    writeFileSync(join(dir, "NOTICE"), "x".repeat(1_000_000));
    assert.deepEqual(harvestFiles(dir).map((f) => f.name), ["LICENSE-MIT", "NOTICE"], "exactly at the limit is read");
    // A file that can't be read is named too.
    assert.throws(() => harvestFiles(dir, { read: () => { throw new Error("EACCES: permission denied"); } }), /LICENSE-MIT.*can't be read.*EACCES/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fix_6_the_notices_are_scoped_to_the_shipped_crate_set_and_equal_to_it", () => {
  const key = (name, version) => ({ name, version });
  const about = [key("MU-a", "1.0.0"), key("MU-b", "2.0.0"), key("MU-macro", "9.9.9")];
  const scoped = scopeToShipped(about, [key("MU-a", "1.0.0"), key("MU-b", "2.0.0")]);
  assert.deepEqual(scoped.kept.map((c) => c.name), ["MU-a", "MU-b"], "the compiler-only crate is left out");
  assert.deepEqual(scoped.missing, []);
  // A shipped crate cargo-about gave nothing for is named; nothing shipped at all is not a pass.
  assert.deepEqual(scopeToShipped(about, [key("MU-a", "1.0.0"), key("MU-c", "3.0.0")]).missing, ["MU-c 3.0.0"]);
  assert.throws(() => scopeToShipped(about, []), /no shipped crate/);
  // A version that is not the shipped one is not the crate.
  assert.deepEqual(scopeToShipped(about, [key("MU-a", "1.0.1")]).missing, ["MU-a 1.0.1"]);
  // The second reading: a block that names a crate outside the shipped set is a finding, in the crate and the package part.
  const { text, expected } = madeUpFile([component("MU-macro", "9.9.9", ["MIT"], [file("LICENSE", mit("MU-Holder Macro"))])]);
  const shipped = { ...expected, crates: expected.crates.filter((c) => c.name !== "MU-macro") };
  assert.deepEqual(check(text, expected), []);
  assert.match(check(text, shipped).join("\n"), /MU-macro 9\.9\.9: in the file but not in the shipped set/);
  const withoutPkg = { ...expected, packages: expected.packages.filter((p) => p.name !== "MU-pkg") };
  assert.match(check(text, withoutPkg).join("\n"), /MU-pkg 5\.0\.1: in the file but not in the shipped set/);
});

test("fix_9_the_read_back_knows_the_clarified_licence_and_its_checksum_so_swapped_attributions_fail", () => {
  const rawA = mit("MU-Holder Alice");
  const rawB = mit("MU-Holder Bob");
  const a = component("MU-clar-a", "1.0.0", ["MIT"], [], [{ id: "MIT", text: rawA }], [{ id: "MIT", checksum: sha(rawA) }]);
  const b = component("MU-clar-b", "1.0.0", ["MIT"], [], [{ id: "MIT", text: rawB }], [{ id: "MIT", checksum: sha(rawB) }]);
  const made = madeUpFile([a, b]);
  assert.deepEqual(check(made.text, made.expected), [], "as generated, it passes");
  assert.deepEqual(made.expected.crates.find((c) => c.name === "MU-clar-a").clarified, [{ id: "MIT", checksum: sha(rawA) }]);
  // Swap the two holders in the file: each crate now has a complete MIT text naming the other's holder.
  const swapped = made.text.replaceAll("MU-Holder Alice", "MU-Holder TMP").replaceAll("MU-Holder Bob", "MU-Holder Alice").replaceAll("MU-Holder TMP", "MU-Holder Bob");
  assert.notEqual(swapped, made.text);
  // The block texts are still whole MIT texts with real copyright lines: only the pinned checksum tells.
  const problems = check(swapped, made.expected).join("\n");
  assert.match(problems, /MU-clar-a 1\.0\.0: its text is not the clarified one/);
  assert.match(problems, /MU-clar-b 1\.0\.0: its text is not the clarified one/);
  // A text that doesn't match the pinned checksum is refused when the notices are made, not trusted for being whole.
  const wrong = component("MU-clar-w", "1.0.0", ["MIT"], [], [{ id: "MIT", text: rawA }], [{ id: "MIT", checksum: sha(rawB) }]);
  assert.match(collectNotices([wrong], "crate").problems.join("\n"), /MU-clar-w 1\.0\.0: .*does not match the checksum/);
  // CRLF or no final newline in the source do not change what the checksum is of.
  const crlf = component("MU-clar-c", "1.0.0", ["MIT"], [], [{ id: "MIT", text: rawA.replace(/\n/g, "\r\n") }], [{ id: "MIT", checksum: sha(rawA.replace(/\n/g, "\r\n")) }]);
  assert.deepEqual(collectNotices([crlf], "crate").problems, []);
  const crlfFile = madeUpFile([crlf]);
  assert.deepEqual(check(crlfFile.text, crlfFile.expected), []);
});

test("fix_13_the_metadata_query_has_the_same_target_features_and_lock_settings_as_the_tree", () => {
  const tree = cargoTreeArgs();
  const metadata = cargoMetadataArgs();
  const after = (list, flag) => list[list.indexOf(flag) + 1];
  for (const list of [tree, metadata]) {
    assert.ok(list.includes("--locked"), "locked");
    assert.equal(after(list, "--manifest-path"), "crates/petalock-desktop/Cargo.toml");
  }
  assert.equal(after(tree, "--target"), "x86_64-pc-windows-msvc");
  assert.equal(after(metadata, "--filter-platform"), "x86_64-pc-windows-msvc");
  assert.equal(after(tree, "-F"), "custom-protocol");
  assert.equal(after(metadata, "--features"), "custom-protocol");
  assert.equal(after(tree, "-e"), "normal,no-proc-macro");
});

test("fix_12_a_failed_run_keeps_the_output_that_was_there_and_leaves_no_temporary_file", realTool, () => {
  const dir = mkdtempSync(join(tmpdir(), "about-"));
  try {
    const mutated = join(dir, "about.toml");
    writeFileSync(mutated, read("about.toml").replace("0dcf41516e608bbcb6cdc5229feb7b86fe4a643b85e7df251133c93408fdac73", "0".repeat(64)));
    const out = join(dir, "notices.txt");
    writeFileSync(out, "MU-previous output, to be kept byte for byte\r\n");
    const before = readFileSync(out);
    const failed = spawnSync(process.execPath, [join(ROOT, "scripts", "licences.mjs"), "--cargo-about", process.env.CARGO_ABOUT, "--config", mutated, "--out", out], { cwd: ROOT, encoding: "utf8", timeout: 300_000 });
    assert.notEqual(failed.status, 0, failed.stdout + failed.stderr);
    assert.ok(readFileSync(out).equals(before), "the earlier file is as it was");
    assert.deepEqual(readdirSync(dir).sort(), ["about.toml", "notices.txt"], "no temporary file is left beside it");
    // A run that works replaces it.
    const good = spawnSync(process.execPath, [join(ROOT, "scripts", "licences.mjs"), "--cargo-about", process.env.CARGO_ABOUT, "--out", out], { cwd: ROOT, encoding: "utf8", timeout: 300_000 });
    assert.equal(good.status, 0, good.stdout + good.stderr);
    assert.match(readFileSync(out, "utf8"), /^Petalock: third-party notices/);
    assert.deepEqual(readdirSync(dir).sort(), ["about.toml", "notices.txt"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fix_2_the_real_cargo_about_with_the_shipping_configuration_stops_on_a_third_BSL_1_0_crate", realTool, () => {
  const dir = mkdtempSync(join(tmpdir(), "about-"));
  try {
    const make = (license) => {
      const crate = join(dir, `mu-${license.toLowerCase().replace(/\W/g, "")}`);
      mkdirSync(crate);
      writeFileSync(join(crate, "Cargo.toml"), `[package]\nname = "mu-${license.toLowerCase().replace(/\W/g, "")}"\nversion = "0.1.0"\nedition = "2021"\nlicense = "${license}"\n\n[lib]\npath = "lib.rs"\n`);
      writeFileSync(join(crate, "lib.rs"), "");
      writeFileSync(join(crate, "Cargo.lock"), `version = 4\n\n[[package]]\nname = "mu-${license.toLowerCase().replace(/\W/g, "")}"\nversion = "0.1.0"\n`);
      return join(crate, "Cargo.toml");
    };
    const shipping = join(dir, "about.toml");
    writeFileSync(shipping, read("about.toml"));
    const run = (manifest) => spawnSync(process.env.CARGO_ABOUT, ["generate", "--config", shipping, "--manifest-path", manifest, "--locked", "--fail", "--format", "json", "--output-file", join(dir, "out.json")], { cwd: ROOT, encoding: "utf8", timeout: 300_000 });
    // The control: a made-up crate under MIT passes the same configuration, so the refusal below is the licence's.
    const ok = run(make("MIT"));
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    rmSync(join(dir, "out.json"), { force: true });
    const bad = run(make("BSL-1.0"));
    assert.notEqual(bad.status, 0, "a third crate under BSL-1.0 is refused");
    assert.match(bad.stdout + bad.stderr, /failed to satisfy license requirements/);
    assert.match(bad.stdout + bad.stderr, /mu-bsl10/);
    assert.ok(!existsSync(join(dir, "out.json")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cargo_about_is_pinned_and_checked_by_digest_before_it_runs", () => {
  const text = read(BUILD);
  const url = "https://github.com/EmbarkStudios/cargo-about/releases/download/0.9.3/cargo-about-0.9.3-x86_64-pc-windows-msvc.tar.gz";
  const lines = text.split("\n");
  const at = lines.findIndex((line) => line.includes(url));
  assert.ok(at >= 0, "the pinned release URL");
  // The digest of that exact archive, beside its URL (read from GitHub's release API and from the .sha256 file beside it).
  assert.ok(lines.slice(at, at + 3).join(" ").includes("9e2942533ef1c592c4a70bdb384cae1550a3f5fc9ae40379b6662e3d2f16fe02"), "its SHA-256");
  assert.ok(!/cargo install[^\n]*cargo-about/.test(text), "no install from a moving index");
  assert.ok(!/cache[^\n]*cargo-about|cargo-about[^\n]*cache/i.test(text.replace(/#[^\n]*/g, "")), "no cache holds the tool");
  const verify = text.indexOf("Get-Verified $env:ABOUT_URL");
  const extract = text.search(/tar\.exe"\s+-xzf/);
  const generate = text.indexOf("node scripts/licences.mjs");
  const build = text.indexOf("cargo tauri build");
  assert.ok(verify > 0 && extract > verify, "the digest is checked before the archive is opened");
  assert.ok(generate > extract && build > generate, "the notices are made after the tool is in place and before the bundle");
  const provision = text.slice(text.indexOf("Provision cargo-about"), text.indexOf("Generate the third-party notices"));
  assert.ok(provision.length > 100, "a provisioning step of its own");
  assert.match(provision, /throw "SHA-256 mismatch for \$url"/, "a wrong digest stops the step");
  assert.match(provision, /cargo-about 0\.9\.3/, "the extracted tool's own version is checked");
  // Only the one pinned tool: no new action, and nothing but the actions the file already pins.
  for (const action of [...text.matchAll(/^\s*(?:-\s+)?uses:\s*(\S+)/gm)].map((m) => m[1])) assert.match(action, /@[0-9a-f]{40}$/);
});

test("the_notices_are_generated_in_the_build_and_bundled_from_there", () => {
  const text = read(BUILD);
  const step = text.slice(text.indexOf("Generate the third-party notices"), text.indexOf("Build the installer"));
  assert.ok(step.length > 100, "a generate step sits before the build");
  assert.match(step, /node scripts\/licences\.mjs --cargo-about \$env:CARGO_ABOUT --out target\/notices\/THIRD-PARTY-NOTICES\.txt/);
  assert.match(step, /target\\notices\\THIRD-PARTY-NOTICES\.txt/);
  // The same file's own tests run on what was just generated (the second, independent reading).
  assert.match(step, /NOTICES_FILE/);
  assert.match(step, /CARGO_ABOUT/);
  assert.match(step, /node --test scripts\/licences\.test\.mjs/);
  assert.match(step, /\$LASTEXITCODE/, "a failing step stops the run");
  // The bundle step merges the resource in; the file is the one generated.
  const build = text.slice(text.indexOf("Build the installer"), text.indexOf("Check the bundler fetched nothing"));
  assert.match(build, /cargo tauri build --config tauri\.notices\.conf\.json --ci --bundles nsis/);
  const config = JSON.parse(read("crates/petalock-desktop/tauri.notices.conf.json"));
  assert.deepEqual(config, { bundle: { resources: { "../../target/notices/THIRD-PARTY-NOTICES.txt": "THIRD-PARTY-NOTICES.txt" } } });
  // Never committed: the folder is ignored, and no file of that name is tracked.
  assert.match(read(".gitignore"), /^target\/$/m);
  const tracked = spawnSync("git", ["ls-files", "--", "*THIRD-PARTY-NOTICES.txt"], { cwd: ROOT, encoding: "utf8" });
  if (tracked.status === 0) assert.equal(tracked.stdout.trim(), "", "the generated file is not in the repository");
  // The main config names no resource: a plain `cargo build` or test (CI's Rust jobs, the end-to-end job) needs no generated file
  // (tauri-build stops on a resource that is not there).
  assert.ok(!("resources" in (JSON.parse(read("crates/petalock-desktop/tauri.conf.json")).bundle ?? {})), "tauri.conf.json stays free of the generated file");
});

// ---------------------------------------------------------------------------------------------------------------------
// The real thing: the file the build generated, read against what cargo and npm say ships.

const generated = process.env.NOTICES_FILE;
const real = { skip: generated && existsSync(generated) ? false : "NOTICES_FILE is not set: the build's own run reads the generated file" };

const productionPackages = () => packageComponents({
  lock: JSON.parse(readFileSync(join(ROOT, "ui", "package-lock.json"), "utf8")),
  dirOf: (key) => join(ROOT, "ui", key),
  readJson: (dir) => JSON.parse(readFileSync(join(dir, "package.json"), "utf8")),
  list: harvestFiles,
});

test("notices_carry_every_shipped_crates_licence_text: the generated file against cargo's own list of what ships", real, () => {
  const parsed = parseNotices(readFileSync(generated, "utf8"));
  const expected = shippedCrates(ROOT);
  assert.ok(expected.length > 100, `cargo lists ${expected.length} libraries: too few to be the Tauri app's tree`);
  for (const name of ["tauri", "serde", "windows-sys", "clipboard-win", "webview2-com", "alloc-stdlib", "option-ext"]) {
    assert.ok(expected.some((c) => c.name === name), `${name} is in the list`);
  }
  // Most of them publish a licence file of their own, and the file carries each one as published.
  assert.ok(expected.filter((c) => c.texts.length > 0).length > 100, "their own licence files were read");
  const problems = verifyNotices(parsed, { crates: expected, packages: [], fonts: [], only: "crates" });
  assert.deepEqual(problems, []);
  assert.ok(parsed.parts.crates.length > 20);
  // Equal, not a superset: the file names the shipped crates and nothing else (no procedural macro, no build-only crate).
  const inFile = [...new Set(parsed.parts.crates.flatMap((b) => b.usedBy.map((u) => `${u.name} ${u.version}`)))].sort();
  assert.deepEqual(inFile, expected.map((c) => `${c.name} ${c.version}`).sort());
  assert.ok(!inFile.some((x) => /^(serde_derive|webview2-com-macros|syn|quote|proc-macro2) /.test(x)), "no compiler-only crate");
  // The libraries under the Mozilla licence have their source address in the file's own words.
  assert.match(readFileSync(generated, "utf8"), /option-ext 0\.2\.0: https:\/\/crates\.io\/crates\/option-ext\/0\.2\.0/);
});

test("notices_carry_every_shipped_page_package_text: the generated file against the lock file's production packages", real, () => {
  const parsed = parseNotices(readFileSync(generated, "utf8"));
  const expected = productionPackages().map((p) => expectation(p, "package"));
  assert.ok(expected.length >= 10, `${expected.length} production packages`);
  assert.ok(expected.every((p) => p.texts.length > 0), "every package publishes a licence file, and the notices carry it as published");
  for (const name of ["react", "react-dom", "@base-ui/react", "@tauri-apps/api"]) assert.ok(expected.some((p) => p.name === name), `${name} is in the list`);
  assert.deepEqual(verifyNotices(parsed, { crates: [], packages: expected, fonts: [], only: "packages" }), []);
});

test("notices_carry_the_fonts_licences: the generated file holds both Geist licences", real, () => {
  const text = readFileSync(generated, "utf8");
  const parsed = parseNotices(text);
  const fonts = ["@fontsource-variable/geist", "@fontsource-variable/geist-mono"];
  assert.deepEqual(verifyNotices(parsed, { crates: [], packages: productionPackages().map((p) => expectation(p, "package")), fonts, only: "packages" }), []);
  for (const font of fonts) {
    const block = parsed.parts.packages.find((b) => b.licence === "OFL-1.1" && b.usedBy.some((u) => u.name === font));
    assert.ok(block, `${font} has an OFL-1.1 block`);
    assert.match(block.text, /SIL OPEN FONT LICENSE Version 1\.1/i);
  }
  assert.match(text, /EFF Large Wordlist/);
  assert.match(text, /Pavol Rusnak/);
});

test("the_page_the_build_makes_holds_no_package_the_notices_lack", { ...real, skip: real.skip || (existsSync(join(ROOT, "ui", "node_modules", "vite", "package.json")) ? false : "ui/node_modules is not installed"), timeout: 180_000 }, async () => {
  const { buildPage } = await import("./shipped-page-check.mjs");
  const parsed = parseNotices(readFileSync(generated, "utf8"));
  const listed = new Set(parsed.parts.packages.flatMap((b) => b.usedBy.map((u) => u.name)));
  const used = new Set();
  for (const item of await buildPage()) {
    if (item.type !== "chunk") continue;
    for (const id of item.moduleIds) {
      const parts = id.replaceAll("\\", "/").split("/");
      const at = parts.lastIndexOf("node_modules");
      if (at < 0 || at + 1 >= parts.length) continue;
      used.add(parts[at + 1].startsWith("@") ? `${parts[at + 1]}/${parts[at + 2]}` : parts[at + 1]);
    }
  }
  assert.ok(used.size >= 3, `the built page holds ${used.size} packages`);
  assert.deepEqual([...used].filter((name) => !listed.has(name)), []);
});

test("notices_refuse_an_unaccepted_licence: the real cargo-about stops on a library outside the list", realTool, () => {
  const dir = mkdtempSync(join(tmpdir(), "about-"));
  try {
    // The shipped config with the two BSL-1.0 exceptions taken out: the same tree now holds two libraries outside the list.
    const config = read("about.toml").replace(/^\[clipboard-win\]\naccepted = \["BSL-1\.0"\]\n\n\[error-code\]\naccepted = \["BSL-1\.0"\]\n/m, "");
    assert.ok(!config.includes('accepted = ["BSL-1.0"]'), "the exceptions were taken out");
    const mutated = join(dir, "about.toml");
    writeFileSync(mutated, config);
    const run = spawnSync(process.env.CARGO_ABOUT, ["generate", "--config", mutated, "--manifest-path", "crates/petalock-desktop/Cargo.toml",
      "--features", "custom-protocol", "--locked", "--fail", "--format", "json", "--output-file", join(dir, "out.json")], { cwd: ROOT, encoding: "utf8", timeout: 300_000 });
    assert.notEqual(run.status, 0, "cargo-about refused");
    assert.match(run.stdout + run.stderr, /clipboard-win/);
    assert.match(run.stdout + run.stderr, /failed to satisfy license requirements/);
    assert.ok(!existsSync(join(dir, "out.json")), "and wrote nothing");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a_dependency_named_but_without_its_text_fails: the real generator stops when a clarification no longer matches its file", { ...realTool, timeout: 600_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), "about-"));
  try {
    // One clarification's checksum is wrong, so cargo-about drops it and falls back to its own template text, which has no
    // copyright line: the generator has to refuse, naming the library, and leave no file behind.
    const config = read("about.toml").replace("0dcf41516e608bbcb6cdc5229feb7b86fe4a643b85e7df251133c93408fdac73", "0".repeat(64));
    assert.ok(config.includes("0".repeat(64)));
    const mutated = join(dir, "about.toml");
    writeFileSync(mutated, config);
    const out = join(dir, "notices.txt");
    const run = spawnSync(process.execPath, [join(ROOT, "scripts", "licences.mjs"), "--cargo-about", process.env.CARGO_ABOUT, "--config", mutated, "--out", out],
      { cwd: ROOT, encoding: "utf8", timeout: 580_000 });
    assert.notEqual(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout + run.stderr, /webview2-com/);
    assert.ok(!existsSync(out), "no notices file was written");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
