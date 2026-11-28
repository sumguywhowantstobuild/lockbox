// Builds THIRD-PARTY-NOTICES.txt, the file of open-source licence texts the installer ships (Plan 5, Task 3).
//
//   node scripts/licences.mjs --cargo-about <cargo-about.exe> --out target/notices/THIRD-PARTY-NOTICES.txt [--config about.toml]
//
// The file is made in the installer's build and never committed. It holds, in this order: the notices of the two word lists
// that ship inside the app and of the installer's plugin (from THIRD-PARTY-NOTICES.md), the licence text of every Rust library in the app, and the licence
// text of every production package of the page (the two fonts included). For each one it holds the library's own licence
// files exactly as published, copyright lines and all, not just its name. It stops, and writes nothing, when:
//   - a library's licence is not on the accepted list (about.toml for Rust, `ACCEPTED` below for the page),
//   - a library's text can't be found, or is not the text of the licence it is used under,
//   - a library ships no licence file and the text made for it has no real copyright line where that licence asks for one
//     (the licence's template alone says nothing of who holds the copyright),
//   - cargo's own list of what ships holds a library the file does not,
//   - the file as written does not read back the same way (the second reading, `verifyNotices`, is the one the file's tests
//     run again on what the build produced).
//
// Where the texts come from. cargo-about decides which licence a crate is used under and gates the list; for the text, each
// crate's own files are read first (cargo-about only finds names it knows, and `license-mit`, `LICENSE_MIT` and a file in a
// repository but not in the package are among those it misses), and cargo-about's text is the fallback. Many crates publish
// an MIT file with no copyright line at all (the serde and syn families among them): that is the text the authors ship, and it
// is carried as it is; a text we made up for them would be a claim of ours.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ROOT = fileURLToPath(new URL("../", import.meta.url));

/**
 * The licences the plan accepts, in the order a choice is made when a library offers one ("MIT OR Apache-2.0" is taken under
 * MIT). OFL-1.1 is for the fonts only. about.toml carries the same list less OFL-1.1, and a test compares the two.
 */
export const ACCEPTED = Object.freeze(["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "Zlib", "Unicode-3.0", "MPL-2.0", "OFL-1.1"]);

/** The two libraries allowed under BSL-1.0, the Boost licence, which the plan's list did not name (about.toml says why). */
export const CRATE_EXCEPTIONS = Object.freeze({ "clipboard-win": "BSL-1.0", "error-code": "BSL-1.0" });

/** The bundled fonts' packages: the only packages allowed under OFL-1.1. */
const FONT_PACKAGE = /^@fontsource-variable\//;

/** The licences whose text must carry a real copyright line (the others, Apache-2.0, MPL-2.0 and BSL-1.0, are one standard text). */
const COPYRIGHT_REQUIRED = new Set(["MIT", "BSD-2-Clause", "BSD-3-Clause", "ISC", "Zlib", "Unicode-3.0", "OFL-1.1"]);

const TARGET = "x86_64-pc-windows-msvc";
const FEATURES = "custom-protocol";
const DESKTOP_MANIFEST = "crates/petalock-desktop/Cargo.toml";

// ---------------------------------------------------------------------------------------------------------------------
// Which licence a library is used under

/** Parses an SPDX expression (`A`, `A OR B`, `A AND B`, parentheses) into a tree; throws on anything else, `WITH` included. */
function parseExpression(expression) {
  const tokens = expression.match(/\(|\)|[^\s()]+/g) ?? [];
  let at = 0;
  const atom = () => {
    const token = tokens[at++];
    if (token === undefined || token === ")" || token === "OR" || token === "AND") throw new SyntaxError(`bad expression: ${expression}`);
    if (token === "(") {
      const inner = alternatives();
      if (tokens[at++] !== ")") throw new SyntaxError(`bad expression: ${expression}`);
      return inner;
    }
    return { op: "id", id: token };
  };
  const all = () => {
    const parts = [atom()];
    while (tokens[at] === "AND") {
      at++;
      parts.push(atom());
    }
    return { op: "and", parts };
  };
  const alternatives = () => {
    const alts = [all()];
    while (tokens[at] === "OR") {
      at++;
      alts.push(all());
    }
    return { op: "or", alts };
  };
  const tree = alternatives();
  if (at !== tokens.length) throw new SyntaxError(`bad expression: ${expression}`);
  return tree;
}

/**
 * The licence ids a library is used under: the cheapest way to satisfy its SPDX expression with the accepted list (an `OR`
 * takes the alternative whose worst licence comes first in the list; an `AND` needs all). Null when it can't be satisfied.
 * OFL-1.1 counts only with `font`.
 */
export function chooseLicences(expression, { font = false } = {}) {
  const allowed = ACCEPTED.filter((id) => font || id !== "OFL-1.1");
  let tree;
  try {
    tree = parseExpression(String(expression));
  } catch {
    return null;
  }
  const pick = (node) => {
    if (node.op === "id") return allowed.includes(node.id) ? { ids: [node.id], cost: allowed.indexOf(node.id) } : null;
    if (node.op === "and") {
      const parts = node.parts.map(pick);
      if (parts.includes(null)) return null;
      return { ids: [...new Set(parts.flatMap((p) => p.ids))], cost: Math.max(...parts.map((p) => p.cost)) };
    }
    const found = node.alts.map(pick).filter((p) => p !== null);
    return found.length === 0 ? null : found.reduce((best, p) => (p.cost < best.cost ? p : best));
  };
  return pick(tree)?.ids ?? null;
}

/** Whether `id` may be the licence a `kind` ("crate" or "package") of that name is used under. */
export function allowedLicence(kind, name, id) {
  if (kind === "crate") return (ACCEPTED.includes(id) && id !== "OFL-1.1") || CRATE_EXCEPTIONS[name] === id;
  if (kind === "package") return ACCEPTED.includes(id) && (id !== "OFL-1.1" || FONT_PACKAGE.test(name));
  return false;
}

// ---------------------------------------------------------------------------------------------------------------------
// What a licence text is

/** A text with the line endings, trailing blanks and outer empty lines removed: the form it is compared and written in. */
export function normaliseText(text) {
  const lines = String(text).replace(/^﻿/, "").replace(/\r\n?/g, "\n").split("\n").map((line) => line.trimEnd());
  while (lines.length > 0 && lines[0] === "") lines.shift();
  while (lines.length > 0 && lines.at(-1) === "") lines.pop();
  return lines.join("\n");
}

const collapse = (text) => text.replace(/\s+/g, " ").toLowerCase();
const has = (c, ...phrases) => phrases.every((phrase) => c.includes(phrase));

/** Each licence's own words, found in the text with its spacing collapsed and its case folded. */
const SIGNATURES = {
  "MIT": (c) => has(c, "permission is hereby granted, free of charge", "the above copyright notice and this permission notice shall be included"),
  "Apache-2.0": (c) => has(c, "apache license", "version 2.0, january 2004", "terms and conditions for use, reproduction, and distribution"),
  "BSD-2-Clause": (c) => has(c, "redistribution and use in source and binary forms", "redistributions of source code must retain") && !c.includes("neither the name"),
  "BSD-3-Clause": (c) => has(c, "redistribution and use in source and binary forms", "neither the name"),
  "ISC": (c) => has(c, "permission to use, copy, modify, and/or distribute this software for any purpose with or without fee"),
  "Zlib": (c) => has(c, "this software is provided 'as-is', without any express or implied warranty", "altered source versions must be plainly marked"),
  "Unicode-3.0": (c) => has(c, "unicode license v3"),
  "MPL-2.0": (c) => has(c, "mozilla public license version 2.0"),
  "OFL-1.1": (c) => has(c, "sil open font license", "version 1.1"),
  "BSL-1.0": (c) => has(c, "boost software license - version 1.0"),
};

/** Whether `text` is the text of the licence `id` (its own words, not just its name). */
export function matchesLicence(id, text) {
  const signature = SIGNATURES[id];
  return signature ? signature(collapse(String(text))) : false;
}

/** Words after "Copyright" that make the line prose about copyright, not a notice of it. */
const NOT_A_HOLDER = new Set(["and", "notice", "notices", "holder", "holders", "owner", "owners", "statement", "law", "laws", "license", "licence", "information", "interest"]);

/**
 * Whether the text has a real copyright line: a line that begins with "Copyright" or the (c) sign and names a year or a
 * holder. The template's placeholders (`<year> <copyright holders>`, `[yyyy] [name of copyright owner]`) and prose such as
 * "copyright notice, this list of conditions" are not. A line longer than 400 characters is not a notice, which also bounds the work.
 */
export function hasCopyrightLine(text) {
  for (const raw of String(text).split("\n")) {
    if (raw.length > 400) continue;
    const line = raw.trim().replace(/^[#*/\-;>\s]+/, "");
    const m = /^(?:copyright|©)(?![A-Za-z])\s*(.*)$/i.exec(line);
    if (!m) continue;
    const rest = m[1].replace(/^(?:\(c\)|©|&copy;)\s*/i, "");
    if (/[<[{]/.test(rest)) continue;
    const first = (rest.split(/[\s,]+/, 1)[0] ?? "").toLowerCase();
    if (NOT_A_HOLDER.has(first)) continue;
    if (/\b(?:19|20)\d\d\b/.test(rest) || /[A-Z][A-Za-z0-9]{2,}/.test(rest)) return true;
  }
  return false;
}

/** Whether `text` is usable as the text of `id`: its words, and a copyright line where that licence asks for one. */
const textOk = (id, text) => matchesLicence(id, text) && (!COPYRIGHT_REQUIRED.has(id) || hasCopyrightLine(text));

/**
 * A NOTICE file (Apache-2.0 asks that it is passed on) or a separate COPYRIGHT file: attribution, not a licence text. Both are
 * carried as they are, in blocks of their own.
 */
const isNoticeName = (name) => /^(?:notice|copyright)(?![a-z])/i.test(name);

/** The hex SHA-256 of a string (UTF-8). */
const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

/**
 * Whether `text` is the file whose SHA-256 is `checksum`. The checksum is of the file's bytes; a text that was read, written
 * to the notices and read back differs from them only in its line endings and its last newline, so those are tried.
 */
export function matchesChecksum(text, checksum) {
  const lf = String(text).replace(/\r\n/g, "\n");
  const crlf = lf.replace(/\n/g, "\r\n");
  return [text, `${text}\n`, lf, `${lf}\n`, crlf, `${crlf}\r\n`].some((candidate) => sha256(candidate) === checksum);
}

/**
 * The clarifications about.toml makes with a git file, as `Map(crate name -> [{ id, checksum }])`: the licence the file is the
 * text of, and the SHA-256 it must have. Read by the second reading, so the text a crate ends up with is checked against what
 * the configuration pinned, not only against its own shape.
 */
export function parseClarifications(toml) {
  const found = new Map();
  let current = null;
  for (const line of String(toml).replace(/\r\n/g, "\n").split("\n")) {
    const header = /^\[\[?([^\]]+?)\]\]?\s*$/.exec(line);
    if (header) {
      const git = /^([\w-]+)\.clarify\.git$/.exec(header[1]);
      current = git ? { name: git[1], id: "", checksum: "" } : null;
      if (current) {
        if (!found.has(current.name)) found.set(current.name, []);
        found.get(current.name).push(current);
      }
      continue;
    }
    if (!current) continue;
    const license = /^license = "([^"]+)"/.exec(line);
    const checksum = /^checksum = "([0-9a-f]{64})"/.exec(line);
    if (license) current.id = license[1];
    if (checksum) current.checksum = checksum[1];
  }
  return new Map([...found].map(([name, list]) => [name, list.map(({ id, checksum }) => ({ id, checksum }))]));
}

// ---------------------------------------------------------------------------------------------------------------------
// Reading a library's files

/** The names of licence files: LICENSE, license-mit, LICENSE_MIT, LICENSE-APACHE-2.0, LICENSE.md, COPYING, UNLICENSE, NOTICE. */
const LICENCE_FILE = /^(?:licen[cs]es?|copying|copyright|unlicense|notice)(?:[-_. ][\w.\- ]*)?$/i;

/** The largest licence or NOTICE file read. A bigger one is an error, not a file to leave out. */
const LIMIT = 1_000_000;

/**
 * The licence-like files directly in a folder, with their text: `[{ name, text }]`. A file over the size limit, or one that
 * can't be read, stops the build naming it: an attribution that is dropped without a word is the one nobody can see missing.
 * (A folder named like a licence, such as REUSE's LICENSES, is not a file. Files in folders below are not looked for.)
 */
export function harvestFiles(dir, { read = (path) => readFileSync(path, "utf8") } = {}) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !LICENCE_FILE.test(entry.name)) continue;
    const path = join(dir, entry.name);
    const size = statSync(path).size;
    if (size > LIMIT) throw new Error(`${path} is ${size} bytes, over the ${LIMIT}-byte limit for a licence or NOTICE file, and is not skipped`);
    try {
      found.push({ name: entry.name, text: read(path) });
    } catch (error) {
      throw new Error(`${path} can't be read: ${error.message}`);
    }
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------------------------------------------------
// From components to the texts that go in the file

/** The licence ids a library of that kind and name may be under: the accepted list, and its own exception where it has one. */
const allowedIds = (kind, name) => [...ACCEPTED.filter((id) => allowedLicence(kind, name, id)), ...(kind === "crate" && CRATE_EXCEPTIONS[name] ? [CRATE_EXCEPTIONS[name]] : [])];

/**
 * The texts a library's own files hold of licences it may be under, exactly as published: `[{ id, text }]`, each distinct
 * text once. A file is the text of the first of `preferred` (the licences it is used under), then the other allowed ones,
 * that its words match; a file that is none of them (a CC0 dedication, a licence not accepted) is left out. NOTICE files are
 * not licence texts.
 */
export function ownTexts(files, kind, name, preferred = []) {
  const order = [...preferred, ...allowedIds(kind, name).filter((id) => !preferred.includes(id))];
  const found = new Map();
  for (const f of files) {
    if (isNoticeName(f.name)) continue;
    const text = normaliseText(f.text);
    if (text === "" || found.has(text)) continue;
    const id = order.find((candidate) => matchesLicence(candidate, text));
    if (id) found.set(text, id);
  }
  return [...found].map(([text, id]) => ({ id, text }));
}

/** What a library's own files promise, for the second reading: its NOTICE texts and its own licence texts, as published. */
export function expectation(component, kind) {
  const notices = component.files.filter((f) => isNoticeName(f.name)).map((f) => normaliseText(f.text)).filter((t) => t !== "");
  const own = ownTexts(component.files, kind, component.name, component.ids ?? []);
  // A licence none of its files holds, whose text the configuration pinned by SHA-256: the read-back asks for that very text.
  const clarified = (component.clarified ?? []).filter((c) => !own.some((o) => o.id === c.id)).map(({ id, checksum }) => ({ id, checksum }));
  return { name: component.name, version: component.version, notices, texts: own.map((o) => o.text), clarified };
}

/**
 * `components`: `[{ name, version, ids, expression?, files: [{ name, text }], generated: [{ id, text }] }]`, all of one `kind`
 * ("crate" or "package"). Carries each licence text the library's own files hold, as published (a dual-licensed crate shows
 * both of its files), and for each licence it is used under that none of its files holds, the text cargo-about made, only when
 * that has a real copyright line where the licence asks for one (the template alone says nothing of who holds the copyright).
 * A NOTICE file is carried as it is. Returns the texts grouped (the same text for several libraries is one entry) and the
 * problems, one sentence each.
 */
export function collectNotices(components, kind) {
  const problems = [];
  const groups = new Map();
  const add = (type, licence, text, component) => {
    const key = `${type}\u0000${licence}\u0000${text}`;
    if (!groups.has(key)) groups.set(key, { kind: type, licence, text, usedBy: [] });
    const users = groups.get(key).usedBy;
    if (!users.some((u) => u.name === component.name && u.version === component.version)) users.push({ name: component.name, version: component.version });
  };
  for (const component of components) {
    const label = `${component.name} ${component.version}`;
    if (component.ids.length === 0) {
      problems.push(`${label}: its licence${component.expression ? ` (${component.expression})` : ""} is not accepted`);
      continue;
    }
    const refused = component.ids.filter((id) => !allowedLicence(kind, component.name, id));
    if (refused.length > 0) {
      problems.push(`${label}: licence ${refused.join(", ")} is not accepted`);
      continue;
    }
    const texts = ownTexts(component.files, kind, component.name, component.ids);
    for (const id of component.ids) {
      if (texts.some((t) => t.id === id)) continue;
      const pinned = (component.clarified ?? []).find((c) => c.id === id);
      if (pinned) {
        // The configuration names the file this text must be; only that file is taken.
        const exact = component.generated.find((g) => g.id === id && matchesChecksum(g.text, pinned.checksum) && matchesLicence(id, g.text));
        if (exact === undefined) problems.push(`${label}: the ${id} text does not match the checksum pinned for it in about.toml, so it is not used`);
        else texts.push({ id, text: normaliseText(exact.text) });
        continue;
      }
      const made = component.generated.filter((g) => g.id === id).map((g) => normaliseText(g.text)).find((t) => textOk(id, t));
      if (made === undefined) problems.push(`${label}: no ${id} text${COPYRIGHT_REQUIRED.has(id) ? " with a copyright line" : ""} was found in its files`);
      else texts.push({ id, text: made });
    }
    for (const t of texts) add("licence", t.id, t.text, component);
    for (const f of component.files.filter((f) => isNoticeName(f.name))) {
      const text = normaliseText(f.text);
      if (text !== "") add("notice", "", text, component);
    }
  }
  const order = (a, b) => (a.licence + a.usedBy[0].name).localeCompare(b.licence + b.usedBy[0].name) || a.kind.localeCompare(b.kind);
  const sorted = [...groups.values()].map((g) => ({ ...g, usedBy: g.usedBy.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version)) }));
  return { groups: sorted.sort(order), problems };
}

// ---------------------------------------------------------------------------------------------------------------------
// The file: written, and read back

const RULE = "=".repeat(80);
const sourceUrl = (user) => `https://crates.io/crates/${user.name}/${user.version}`;
const distinct = (groups) => new Set(groups.filter((g) => g.kind === "licence").flatMap((g) => g.usedBy.map((u) => `${u.name}\u0000${u.version}`))).size;

function renderBlock(group) {
  const header = group.kind === "licence" ? `Licence text: ${group.licence}` : "NOTICE text";
  const users = group.usedBy.map((u) => `  ${u.name} ${u.version}`);
  const body = group.text.split("\n").map((line) => (line === "" ? "" : `    ${line}`));
  return [header, `Used by (${group.usedBy.length}):`, ...users, "Text:", ...body].join("\n");
}

/** The whole file: `data` is the word lists' notice text; `crates` and `packages` are what `collectNotices` returned as groups. */
export function renderNotices({ data, crates, packages }) {
  const part = (title, blocks) => [RULE, title, RULE, "", blocks.length === 0 ? "(none)" : blocks.map(renderBlock).join("\n\n\n")].join("\n");
  // The Mozilla Public License asks that whoever gets a program built with such a library is told where its source is (3.2).
  const mozilla = crates.filter((g) => g.kind === "licence" && g.licence === "MPL-2.0").flatMap((g) => g.usedBy);
  const mozillaPart = mozilla.length === 0 ? [] : [
    "Source code of the libraries under the Mozilla Public License 2.0",
    "The licence asks that anyone who has a program built with these libraries is told where their source code is. It is",
    "published, as Petalock uses it (unchanged), at:",
    ...mozilla.map((u) => `  ${u.name} ${u.version}: ${sourceUrl(u)}`),
    "",
  ];
  return [
    "Petalock: third-party notices",
    "",
    "Petalock includes the work of others. This file carries the licence text of each library the app is built from, as its",
    "authors publish it, and the notices of the two word lists and of the installer's plugin. It is made when the installer",
    "is built, from the exact versions in Cargo.lock and ui/package-lock.json.",
    "",
    ...mozillaPart,
    RULE,
    "PART 0. WORD LISTS INSIDE THE APP, AND THE INSTALLER'S PLUGIN",
    RULE,
    "",
    normaliseText(data),
    "",
    part("PART 1. RUST LIBRARIES", crates),
    "",
    part("PART 2. PAGE PACKAGES AND FONTS", packages),
    "",
    `End of third-party notices: ${distinct(crates)} Rust libraries, ${distinct(packages)} page packages.`,
    "",
  ].join("\n");
}

/**
 * Reads a rendered file back: `{ parts: { data, crates: [block], packages: [block] }, footer, errors }`, a block being
 * `{ kind, licence, usedBy, text, raw }` (`raw` is the block exactly as written).
 */
export function parseNotices(text) {
  const lines = String(text).replace(/\r\n/g, "\n").split("\n");
  const parts = { data: "", crates: [], packages: [] };
  const errors = [];
  let part = null;
  const dataLines = [];
  const introLines = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const title = /^PART ([012])\. /.exec(line);
    if (title) {
      part = ["data", "crates", "packages"][Number(title[1])];
      continue;
    }
    if (part === null) {
      introLines.push(line);
      continue;
    }
    if (line === RULE) continue;
    if (part === "data") {
      dataLines.push(line);
      continue;
    }
    const header = /^Licence text: (\S+)$/.exec(line) ?? (line === "NOTICE text" ? [line, ""] : null);
    if (!header) {
      if (line !== "" && line !== "(none)" && !line.startsWith("End of third-party notices")) errors.push(`line ${i + 1}: unexpected text outside a block: ${line.slice(0, 60)}`);
      continue;
    }
    const start = i;
    const count = /^Used by \((\d+)\):$/.exec(lines[i + 1] ?? "");
    if (!count) {
      errors.push(`line ${i + 1}: a block without its "Used by" line`);
      continue;
    }
    i += 2;
    const usedBy = [];
    while (i < lines.length && /^ {2}\S/.test(lines[i]) && !lines[i].startsWith("    ")) {
      const m = /^ {2}(\S+) (\S+)$/.exec(lines[i]);
      if (!m) break;
      usedBy.push({ name: m[1], version: m[2] });
      i++;
    }
    if (usedBy.length !== Number(count[1])) errors.push(`line ${start + 1}: the block says ${count[1]} users and lists ${usedBy.length}`);
    if (lines[i] !== "Text:") {
      errors.push(`line ${start + 1}: a block without its "Text:" line`);
      i--;
      continue;
    }
    i++;
    const body = [];
    while (i < lines.length && (lines[i] === "" || lines[i].startsWith("    "))) body.push(lines[i++]);
    i--;
    while (body.length > 0 && body.at(-1) === "") body.pop();
    const end = start + 2 + usedBy.length + 1 + body.length;
    parts[part].push({
      kind: header[1] === "" && line === "NOTICE text" ? "notice" : "licence",
      licence: header[1],
      usedBy,
      text: normaliseText(body.map((l) => l.slice(4)).join("\n")),
      raw: lines.slice(start, end).join("\n"),
    });
  }
  parts.data = dataLines.join("\n").trim();
  const footer = /^End of third-party notices: (\d+) Rust libraries, (\d+) page packages\.$/m.exec(String(text));
  return { parts, intro: introLines.join("\n"), footer: footer ? { crates: Number(footer[1]), packages: Number(footer[2]) } : null, errors };
}

/**
 * What is wrong with a file as written, one sentence each; an empty list means it carries what it must. `expected`:
 * `{ crates: [{ name, version, notices, texts }], packages: [...], fonts: [package names], only? }` (`expectation` makes
 * each entry from a library's own files). Every list expected must be
 * non-empty (an empty one would pass on nothing); `only: "crates"` or `"packages"` leaves the other part and the fonts out.
 */
export function verifyNotices(parsed, expected) {
  const problems = [...parsed.errors];
  if (!parsed.footer) problems.push("the file has no footer line: it was cut short");
  // Where a library under the Mozilla Public License has its source (the licence asks for it).
  for (const block of parsed.parts.crates) {
    if (block.kind !== "licence" || block.licence !== "MPL-2.0") continue;
    for (const u of block.usedBy) if (!parsed.intro.includes(`${u.name} ${u.version}: ${sourceUrl(u)}`)) problems.push(`${u.name} ${u.version}: no source-code address under the Mozilla Public License heading`);
  }
  const kinds = [["crates", "crate", "Rust library", expected.crates], ["packages", "package", "page package", expected.packages]];
  for (const [part, kind, label, list] of kinds) {
    const blocks = parsed.parts[part];
    // Every block must be a licence's own text, under an accepted licence, with its notice where it asks for one.
    for (const block of blocks) {
      const who = block.usedBy.map((u) => `${u.name} ${u.version}`).join(", ");
      if (block.usedBy.length === 0) problems.push(`a block of the ${label} part lists no library`);
      if (block.kind === "notice") {
        if (block.text === "") problems.push(`a NOTICE block (${who}) is empty`);
        continue;
      }
      for (const u of block.usedBy) if (!allowedLicence(kind, u.name, block.licence)) problems.push(`${u.name} ${u.version}: licence ${block.licence} is not accepted`);
      if (!matchesLicence(block.licence, block.text)) problems.push(`the ${block.licence} block of ${who} does not hold the ${block.licence} text`);
    }
    if (expected.only && expected.only !== part) continue;
    if (!list || list.length === 0) {
      problems.push(`no ${label} was expected: the check would pass on nothing`);
      continue;
    }
    const lists = (block, who) => block.usedBy.some((u) => u.name === who.name && u.version === who.version);
    for (const who of list) {
      const label2 = `${who.name} ${who.version}`;
      const mine = blocks.filter((block) => block.kind === "licence" && matchesLicence(block.licence, block.text) && lists(block, who));
      if (mine.length === 0) {
        problems.push(`${label2}: no licence text in the file`);
      } else {
        // Its own licence files, as published, copyright lines and all: each one is in the file as written.
        for (const own of who.texts ?? []) {
          if (!mine.some((block) => block.text === own)) problems.push(`${label2}: its own licence text (${JSON.stringify(own.slice(0, 40))}...) is not in the file as published`);
        }
        // A licence none of its own files holds, whose file the configuration pinned: the text in the file is that file.
        for (const pinned of who.clarified ?? []) {
          if (!mine.some((block) => block.licence === pinned.id && matchesChecksum(block.text, pinned.checksum))) {
            problems.push(`${label2}: its text is not the clarified one (the ${pinned.id} file pinned in about.toml)`);
          }
        }
        // A library that ships no licence file of its own and has no pinned one has only a text made for it: that must name who
        // holds the copyright.
        if ((who.texts ?? []).length === 0 && (who.clarified ?? []).length === 0 && !mine.some((block) => !COPYRIGHT_REQUIRED.has(block.licence) || hasCopyrightLine(block.text))) {
          problems.push(`${label2}: it ships no licence file, and the text in the file has no copyright line`);
        }
      }
      for (const notice of (who.notices ?? []).map(normaliseText).filter((t) => t !== "")) {
        if (!blocks.some((block) => block.kind === "notice" && lists(block, who) && block.text === notice)) problems.push(`${label2}: its NOTICE text is not in the file`);
      }
    }
    // Equal, not a superset: the file names what ships and nothing else (a compiler-only crate described as a shipped library
    // is a wrong statement, and its licence has no business in the release gate).
    const shipped = new Set(list.map((who) => `${who.name} ${who.version}`));
    const named = new Set(blocks.flatMap((block) => block.usedBy.map((u) => `${u.name} ${u.version}`)));
    for (const key of [...named].sort()) if (!shipped.has(key)) problems.push(`${key}: in the file but not in the shipped set`);
  }
  if (!expected.only || expected.only === "packages") {
    const fonts = expected.fonts ?? [];
    if (fonts.length === 0 && !expected.only) problems.push("no font was expected: the check would pass on nothing");
    for (const font of fonts) {
      const found = parsed.parts.packages.some((b) => b.kind === "licence" && b.licence === "OFL-1.1" && b.usedBy.some((u) => u.name === font) && textOk("OFL-1.1", b.text));
      if (!found) problems.push(`${font}: no Open Font License text with a copyright line in the file`);
    }
  }
  if (parsed.footer) {
    const counts = { crates: distinct(parsed.parts.crates), packages: distinct(parsed.parts.packages) };
    if (counts.crates !== parsed.footer.crates || counts.packages !== parsed.footer.packages) problems.push(`the footer counts (${parsed.footer.crates}, ${parsed.footer.packages}) are not what the file holds (${counts.crates}, ${counts.packages})`);
  }
  return problems;
}

/** The word lists' part of THIRD-PARTY-NOTICES.md: everything before the table of libraries. Throws when it is not as it was. */
export function dataSection(markdown) {
  const text = String(markdown).replace(/\r\n/g, "\n");
  const at = text.indexOf("\n## Libraries the desktop app uses directly");
  if (at < 0) throw new Error("THIRD-PARTY-NOTICES.md has no '## Libraries the desktop app uses directly' heading, so the word lists' part can't be told from the rest");
  const data = text.slice(0, at).trim();
  for (const needle of ["EFF Large Wordlist", "Pavol Rusnak", "Tauri Programme within The Commons Conservancy"]) {
    if (!data.includes(needle)) throw new Error(`THIRD-PARTY-NOTICES.md has no notice for ${needle} before its table of libraries`);
  }
  return data;
}

// ---------------------------------------------------------------------------------------------------------------------
// The real inputs

function run(command, args, cwd) {
  try {
    // nosemgrep: javascript.lang.security.detect-child-process.detect-child-process -- every command and argument is a fixed string or a path this script was given, with no shell
    return execFileSync(command, args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    throw new Error(`${command} ${args.slice(0, 2).join(" ")} failed:\n${error.stdout ?? ""}${error.stderr ?? error.message}`);
  }
}

/**
 * The libraries cargo itself says are linked into the app, from `cargo tree` over the normal dependencies for the Windows
 * target with the release feature, leaving out the procedural macros and what only they use (they run in the compiler and
 * are not in the program): `[{ name, version, dir, notices, texts }]`. The plan names `cargo metadata` for this; its graph
 * holds libraries the program never links (it joins the dev-dependencies' features in, and it lists what only the
 * macros use), so it can't say what ships. The workspace's own crates are not in the list. This list is the notices' scope:
 * the file carries these libraries and no others (cargo-about covers the compiler-only crates too; they are left out), and
 * the second reading asks for equality. `config` is about.toml, for the clarifications it pins.
 */
export function shippedCrates(root = ROOT, config = join(root, "about.toml")) {
  const clarifications = parseClarifications(readFileSync(config, "utf8"));
  const tree = run("cargo", cargoTreeArgs(), root);
  const shipped = new Map();
  const workspace = resolve(root, "crates").toLowerCase().replaceAll("\\", "/");
  for (const line of tree.split("\n")) {
    const m = /^(\S+) v(\S+)(.*)$/.exec(line.trim());
    if (!m) continue;
    const source = [...m[3].matchAll(/\(([^)]*)\)/g)].map((g) => g[1]).find((g) => g !== "*" && g !== "proc-macro");
    if (source !== undefined) {
      if (source.toLowerCase().replaceAll("\\", "/").startsWith(workspace)) continue;
      throw new Error(`cargo tree lists ${m[1]} ${m[2]} from a source that is not the registry or this workspace: ${source}`);
    }
    shipped.set(`${m[1]}@${m[2]}`, { name: m[1], version: m[2] });
  }
  const metadata = JSON.parse(run("cargo", cargoMetadataArgs(), root));
  const dirs = new Map(metadata.packages.map((p) => [`${p.name}@${p.version}`, dirname(p.manifest_path)]));
  return [...shipped.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, one]) => {
    const dir = dirs.get(key);
    if (!dir) throw new Error(`cargo metadata does not know ${key}`);
    return { ...expectation({ ...one, files: harvestFiles(dir), clarified: clarifications.get(one.name) ?? [] }, "crate"), dir };
  });
}

/** The arguments of the query that says what is linked into the program (see `shippedCrates`). */
export const cargoTreeArgs = () => ["tree", "--locked", "--manifest-path", DESKTOP_MANIFEST, "-e", "normal,no-proc-macro", "--target", TARGET, "-F", FEATURES, "--prefix", "none", "--format", "{p}"];

/** The query that says where those libraries are: the same lock, target and release feature as `cargoTreeArgs`. */
export const cargoMetadataArgs = () => ["metadata", "--locked", "--format-version", "1", "--manifest-path", DESKTOP_MANIFEST, "--filter-platform", TARGET, "--features", FEATURES];

/**
 * Keeps, of the libraries cargo-about covers (`[{ name, version, ... }]`), those that ship (`shipped`, the same shape); the
 * rest, the compiler-only crates, are left out. `missing` names every shipped library cargo-about gave nothing for.
 */
export function scopeToShipped(covered, shipped) {
  if (shipped.length === 0) throw new Error("no shipped crate was given: the notices would be scoped to nothing");
  const key = (one) => `${one.name} ${one.version}`;
  const wanted = new Set(shipped.map(key));
  const have = new Set(covered.map(key));
  return { kept: covered.filter((one) => wanted.has(key(one))), missing: [...wanted].filter((k) => !have.has(k)).sort() };
}

/**
 * The page's production packages from `package-lock.json` (lockfileVersion 3): every entry that is not dev-only, each with
 * its licence from its own package.json and its files. `dirOf(key)`, `readJson(dir)` and `list(dir)` are the readers.
 */
export function packageComponents({ lock, dirOf, readJson, list }) {
  if (lock.lockfileVersion !== 3) throw new Error(`package-lock.json has lockfileVersion ${lock.lockfileVersion}; this reads version 3`);
  const found = [];
  for (const [key, entry] of Object.entries(lock.packages)) {
    if (key === "" || entry.dev || entry.devOptional) continue;
    const name = key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length);
    const dir = dirOf(key);
    let expression;
    try {
      expression = readJson(dir).license;
    } catch (error) {
      throw new Error(`${name} ${entry.version} is not installed where the lock file puts it (${key}): ${error.message}`);
    }
    found.push({
      name,
      version: entry.version,
      expression: typeof expression === "string" ? expression : "",
      ids: chooseLicences(expression, { font: FONT_PACKAGE.test(name) }) ?? [],
      files: list(dir),
      generated: [],
    });
  }
  if (found.length === 0) throw new Error("package-lock.json lists no production package");
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

/** The Rust libraries cargo-about covers, with each one's files: the answer of `cargo-about generate --format json`. */
function crateComponents(about) {
  const byKey = new Map();
  for (const licence of about.licenses) {
    for (const used of licence.used_by) {
      const pkg = used.crate;
      const key = `${pkg.name}@${pkg.version}`;
      if (!byKey.has(key)) byKey.set(key, { name: pkg.name, version: pkg.version, dir: dirname(pkg.manifest_path), ids: [], files: [], generated: [] });
      const one = byKey.get(key);
      if (!one.ids.includes(licence.id)) one.ids.push(licence.id);
      one.generated.push({ id: licence.id, text: licence.text });
    }
  }
  for (const one of byKey.values()) one.files = harvestFiles(one.dir);
  return [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

/** Makes the file. Throws, with every problem found, and writes nothing, when anything is wrong. */
export function generate({ root = ROOT, aboutExe, config = join(root, "about.toml"), out }) {
  const work = mkdtempSync(join(tmpdir(), "licences-"));
  // Written beside the output and moved over it only when everything has been checked: a run that fails leaves what was there.
  const temporary = `${out}.${process.pid}.tmp`;
  try {
    const json = join(work, "about.json");
    run(aboutExe, ["generate", "--config", config, "--manifest-path", DESKTOP_MANIFEST, "--features", FEATURES, "--locked", "--fail", "--format", "json", "--output-file", json], root);
    const about = JSON.parse(readFileSync(json, "utf8"));
    // The shipped set is cargo's (see `shippedCrates`); cargo-about covers more (the compiler-only crates), which the notices
    // leave out. cargo-about's own check of the accepted list still runs over everything it covers.
    const shipped = shippedCrates(root, config);
    const clarifications = parseClarifications(readFileSync(config, "utf8"));
    const scoped = scopeToShipped(crateComponents(about), shipped);
    const crates = scoped.kept.map((one) => ({ ...one, clarified: clarifications.get(one.name) ?? [] }));
    const problems = scoped.missing.map((key) => `${key}: it ships, and cargo-about gave it no licence`);

    const packages = packageComponents({
      lock: JSON.parse(readFileSync(join(root, "ui", "package-lock.json"), "utf8")),
      dirOf: (key) => join(root, "ui", key),
      readJson: (dir) => JSON.parse(readFileSync(join(dir, "package.json"), "utf8")),
      list: harvestFiles,
    });
    const collectedCrates = collectNotices(crates, "crate");
    const collectedPackages = collectNotices(packages, "package");
    problems.push(...collectedCrates.problems, ...collectedPackages.problems);
    if (problems.length > 0) throw new Error(`the notices can't be made:\n${problems.map((p) => `  ${p}`).join("\n")}`);

    const text = renderNotices({
      data: dataSection(readFileSync(join(root, "THIRD-PARTY-NOTICES.md"), "utf8")),
      crates: collectedCrates.groups,
      packages: collectedPackages.groups,
    });
    // The second reading: the text as written, against cargo's own list and the lock file, not against what was just built.
    const second = verifyNotices(parseNotices(text), {
      crates: shipped,
      packages: packages.map((p) => expectation(p, "package")),
      fonts: packages.filter((p) => FONT_PACKAGE.test(p.name)).map((p) => p.name),
    });
    if (second.length > 0) throw new Error(`the notices as written don't read back right:\n${second.map((p) => `  ${p}`).join("\n")}`);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(temporary, text);
    renameSync(temporary, out);
    const bare = shipped.filter((c) => c.texts.length > 0 && !c.texts.some(hasCopyrightLine)).length;
    return { crates: crates.length, shipped: shipped.length, bare, packages: packages.length, bytes: Buffer.byteLength(text) };
  } finally {
    rmSync(work, { recursive: true, force: true });
    rmSync(temporary, { force: true });
  }
}

function main(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i];
    if (!["--cargo-about", "--config", "--out"].includes(name) || argv[i + 1] === undefined) {
      console.error(`licences: unknown or incomplete argument: ${name}`);
      return 2;
    }
    options[name.slice(2)] = argv[i + 1];
  }
  if (!options["cargo-about"] || !options.out) {
    console.error("licences: --cargo-about <exe> and --out <file> are required");
    return 2;
  }
  try {
    const done = generate({ aboutExe: resolve(options["cargo-about"]), config: options.config ? resolve(options.config) : undefined, out: resolve(options.out) });
    console.log(`licences: ${done.shipped} Rust libraries shipped (${done.bare} publish their licence file with no copyright line), ${done.packages} page packages, ${done.bytes} bytes -> ${options.out}`);
    return 0;
  } catch (error) {
    console.error(`licences: ${error.message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
