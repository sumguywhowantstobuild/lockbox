// Plan 5, Task 9h: the installer's pages render as drawn at every scale. The Task 9e pictures (a GitHub runner at 100, 125, 150 and
// 175 %) showed six display faults and one stock picture; each test here fails on the files as they were and says which fault it
// guards. Like `installer-ui.test.mjs` these read the installer's source; the words' sizes are not guessed: the table
// `scripts/installer-text-measures.json` holds what Windows' own text drawing measured (made by `scripts/installer-measure-text.ps1`,
// which each test below names the keys for when a word is missing from it). A check that compares counts what it found and fails on
// none; the ones that guard against a fault are also run on the fault (a mutant) and must fire.

import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import * as art from "./make-installer-art.mjs";

const bandProblem = (bytes) => art.problem(bytes);
let drawn;
const sidebarProblem = (bytes) => {
  assert.equal(typeof art.sidebarProblem, "function", "make-installer-art.mjs draws the sidebar too");
  drawn ??= art.sidebarBmp(); // drawn once: it takes a couple of seconds
  return art.sidebarProblem(bytes, drawn);
};

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATE = "crates/petalock-desktop/windows/installer.nsi";
const HOOKS = "crates/petalock-desktop/windows/hooks.nsh";
const UI = "crates/petalock-desktop/windows/setup-ui.nsh";
const CONFIG = "crates/petalock-desktop/tauri.conf.json";
const SMOKE = "scripts/installer-smoke.ps1";
const SIDEBAR = "crates/petalock-desktop/windows/sidebar.bmp";
const MEASURES = "scripts/installer-text-measures.json";

const read = (path) => readFileSync(join(ROOT, path), "utf8").replace(/\r\n/g, "\n");
const code = (text) => text.split("\n").map((line) => line.replace(/^\s*[;#].*$/, "").trimEnd()).filter((line) => line.trim() !== "");
const ui = () => read(UI);
const template = () => read(TEMPLATE);
/** The body of one NSIS function in `text`'s code lines, or "". */
function fn(text, name) {
  return code(text).join("\n").match(new RegExp(`Function ${name}(?: ;[^\\n]*)?\\n([\\s\\S]*?)\\nFunctionEnd`))?.[1] ?? "";
}
/** The body of one NSIS macro in `text`'s code lines, or "". */
function macro(text, name) {
  return code(text).join("\n").match(new RegExp(`!macro ${name}[^\\n]*\\n([\\s\\S]*?)\\n!macroend`))?.[1] ?? "";
}

/** The five scales the pictures were taken at: 100, 125, 150, 175 and 200 % (dpi 96 to 192). */
const DPIS = [96, 120, 144, 168, 192];
/** A design pixel at 100 % to the window's pixels: PETALOCK_PX (IN * dpi / 96, rounded down), and the same rounded up for PETALOCK_PXU. */
const px = (value, dpi) => Math.floor((value * dpi) / 96);
const pxUp = (value, dpi) => Math.floor((value * dpi + 95) / 96);
/** The longest version the words are measured with: a seven-character one (0.10.10); the layout is checked to that. */
const VERSION = "0.10.10";

const defines = () => Object.fromEntries([...code(ui()).join("\n").matchAll(/^!define (PL_\w+) (?:"([^"]*)"|(\d+))$/gm)].map((m) => [m[1], m[2] ?? Number(m[3])]));
const DEFS = defines();
/** The words as the window shows them, with the build's and the installed version, the old name and the space numbers filled in. */
function expand(text) {
  const out = text
    .replace(/\$\{(PL_\w+)\}/g, (_, key) => String(DEFS[key]))
    .replaceAll("${VERSION}", VERSION)
    .replaceAll("$PetalockOldVer", VERSION)
    .replaceAll("$PetalockName", `Petalock ${VERSION}`)
    .replaceAll("$PetalockA", `Petalock ${VERSION}`)
    .replaceAll("$PetalockNeed", "120")
    .replaceAll("$PetalockFree", "119")
    .replaceAll("$PetalockDrive", "C:");
  assert.ok(!out.includes("$"), `a variable is left in the words: ${text}`);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// The measured words
// ---------------------------------------------------------------------------------------------------------------------
const table = existsSync(join(ROOT, MEASURES)) ? JSON.parse(read(MEASURES)) : [];
const wanted = new Map();
const missing = [];
/** What Windows measured for these words at these settings (five numbers each for "w", "h" and "pitch"); a word nobody measured is listed and fails. */
function measured(text, weight, em, width) {
  const key = { text, weight, em, width };
  wanted.set(JSON.stringify(key), key);
  const found = table.find((entry) => entry.text === text && entry.weight === weight && entry.em === em && entry.width === width);
  if (found === undefined) {
    missing.push(key);
    return { w: DPIS.map(() => 0), h: DPIS.map(() => 0), pitch: DPIS.map(() => 0) };
  }
  return found;
}
/** Fails, naming the keys to measure, when any word asked for is not in the table. */
function allMeasured() {
  if (process.env.PETALOCK_KEYS_OUT) writeFileSync(process.env.PETALOCK_KEYS_OUT, JSON.stringify([...wanted.values()], null, 1));
  assert.deepEqual(missing.splice(0), [], `these words are not in ${MEASURES}: measure them with scripts/installer-measure-text.ps1 (keys in PETALOCK_KEYS_OUT)`);
}

// ---------------------------------------------------------------------------------------------------------------------
// 1. Fonts (README item 1): scaled once
// ---------------------------------------------------------------------------------------------------------------------
test("fault_1_fonts_are_made_once_from_a_pixel_height_and_nothing_scales_a_scaled_size_again", () => {
  // NSIS's own CreateFont takes points and turns them into pixels with the screen's resolution (exec.c, EW_CREATEFONT:
  // lfHeight = -MulDiv(size, GetDeviceCaps(hdc, LOGPIXELSY), 72)). Handing it PETALOCK_PX's pixels scaled the font by the scale
  // twice (and a negative size turned the height positive: a cell height, not an em). No such call is left: the fonts come from
  // gdi32::CreateFontW with a negative pixel height, once.
  const all = code(template() + "\n" + read(HOOKS) + "\n" + ui()).join("\n");
  assert.ok(!/^\s*CreateFont\s/m.test(all), "no NSIS CreateFont instruction (it scales its size by the resolution itself)");
  const body = macro(ui(), "PETALOCK_FONT");
  assert.ok(body.length > 50, "the font macro is there");
  assert.match(body, /PETALOCK_PX \$R6 \$\{SIZE\}\n\s*IntOp \$R6 0 - \$R6\n/, "the size is scaled once and negated (an em height)");
  assert.match(body, /gdi32::CreateFontW\(i r16, i 0, i 0, i 0, i \$\{WEIGHT\}, i 0, i 0, i 0, i 1, i 0, i 0, i 0, i 0, w "Segoe UI"\)/);
  assert.equal((body.match(/PETALOCK_PX/g) ?? []).length, 1, "scaled once");
  const make = fn(ui(), "PetalockMakeFonts");
  const fonts = [...make.matchAll(/!insertmacro PETALOCK_FONT (\$\w+) (\d+) (\d+)/g)].map((m) => [m[1], Number(m[2]), Number(m[3])]);
  assert.deepEqual(fonts, [
    ["$PetalockFBody", 12, 400], ["$PetalockFBold", 12, 600], ["$PetalockFSent", 15, 400], ["$PetalockFSentB", 15, 600], ["$PetalockFHead", 20, 600], ["$PetalockFName", 19, 600],
  ]);
  assert.ok(!/PETALOCK_PX/.test(make), "no size is scaled outside the font macro");
  // The comparison fires on the fault: the old function, a scaled size handed to CreateFont, is found.
  const old = all.replace(body, "  CreateFont ${OUT} \"Segoe UI\" $R6 ${WEIGHT}");
  assert.ok(/^\s*CreateFont\s/m.test(old), "the fault is found");
});

// ---------------------------------------------------------------------------------------------------------------------
// 2. The progress page (README item 2): the white page is the whole client area
// ---------------------------------------------------------------------------------------------------------------------
test("fault_2_the_progress_pages_inner_dialog_is_resized_to_the_client_area_before_anything_is_laid_out", () => {
  // NSIS places a stock page and never sizes it (Ui.c, the page's creation: SetWindowPos(m_curwnd, 0, r.left, r.top, 0, 0,
  // SWP_NOACTIVATE | SWP_NOSIZE | SWP_NOZORDER)), so it keeps its template's size in dialog units; a custom page (nsDialogs::Create 1018)
  // is sized to the placeholder, which PetalockSizeWindow made the whole client area. The show function sizes the stock one itself.
  const show = fn(ui(), "PetalockProgressShow");
  assert.ok(show.length > 200, "the progress page's show function is there");
  const find = show.indexOf("FindWindow $PetalockInner");
  const fill = show.indexOf("Call PetalockFillClient");
  const chrome = show.indexOf("Call PetalockChrome");
  assert.ok(find >= 0 && fill > find && fill < chrome, "the inner dialog is found, then sized, then the band, the rows and the bar are laid out in it");
  const fillBody = fn(ui(), "PetalockFillClient");
  assert.match(fillBody, /PETALOCK_PX \$R5 500/);
  assert.match(fillBody, /PETALOCK_PX \$R6 358/);
  // SWP_NOZORDER | SWP_NOACTIVATE (0x14): the size is applied (SWP_NOSIZE, 0x1, is not set), at the origin of the client area.
  const call = fillBody.match(/SetWindowPos\(p \$PetalockInner, p 0, i 0, i 0, i r15, i r16, i (0x\w+)\)/);
  assert.ok(call, "SetWindowPos gives the inner dialog the whole client area");
  assert.equal(Number(call[1]) & 0x1, 0, "SWP_NOSIZE is not set");
  // The comparison fires on the fault (no call) and on a size left out.
  assert.ok(!show.replace("Call PetalockFillClient", "").includes("PetalockFillClient"), "without the call the fault is found");
  // The page's rows, band and bar are laid out in design pixels of that area (500 x 358): the band's rectangle is inside it.
  assert.match(fn(ui(), "PetalockBand"), /PETALOCK_LABEL \$PetalockHBand \$PetalockInner 0 306 500 52/);
});

// ---------------------------------------------------------------------------------------------------------------------
// 3. The footer (README item 3): separate rectangles
// ---------------------------------------------------------------------------------------------------------------------
/** The rectangles (design pixels) of the footer's four controls as the source makes them: Licence, the version, and the two wizard buttons. */
function footerRects(text = ui()) {
  const lines = fn(text, "PetalockMainShow").split("\n").map((line) => line.trim());
  let regs = {};
  const rects = {};
  lines.forEach((line, i) => {
    let m;
    if ((m = line.match(/^!insertmacro PETALOCK_PX \$(R[6-9]) (\d+)$/))) regs[m[1]] = Number(m[2]);
    else if ((m = line.match(/^!insertmacro PETALOCK_LABEL \$PetalockHVer \$\w+ (\d+) (\d+) (\d+) (\d+) /))) rects.version = { x: +m[1], y: +m[2], w: +m[3], h: +m[4] };
    else if ((m = line.match(/^!insertmacro PETALOCK_LABEL \$\w+ \$\w+ (\d+) (\d+) (\d+) (\d+) /))) regs = {};
    else if (/^\$\{NSD_CreateLink\} \$R6 \$R7 \$R8 \$R9 "Licence \(MIT\)"$/.test(line)) rects.licence = { x: regs.R6, y: regs.R7, w: regs.R8, h: regs.R9 };
    void i;
  });
  const frame = fn(text, "PetalockFrame");
  const buttons = [...frame.matchAll(/PETALOCK_MOVE \$0 (\d+) (\d+) (\d+) (\d+)/g)].map((m) => ({ x: +m[1], y: +m[2], w: +m[3], h: +m[4] }));
  assert.equal(buttons.length, 2, "the two wizard buttons are placed");
  rects.install = buttons[0];
  rects.cancel = buttons[1];
  return rects;
}
/** Problems with the footer: a control overlapping another, or the version words wider than their box, at each of the five scales. */
function footerProblems(text = ui()) {
  const rects = footerRects(text);
  const problems = [];
  const names = ["licence", "version", "install", "cancel"];
  for (const name of names) if (rects[name] === undefined || Object.values(rects[name]).some((v) => !Number.isInteger(v))) problems.push(`${name}: no rectangle found`);
  if (problems.length > 0) return problems;
  const licence = measured("Licence (MIT)", 400, 12, 0);
  const version = measured(`Version ${VERSION} · Public preview`, 400, 12, 0);
  let pairs = 0;
  DPIS.forEach((dpi, at) => {
    const box = (r) => ({ x0: px(r.x, dpi), x1: px(r.x, dpi) + px(r.w, dpi), y0: px(r.y, dpi), y1: px(r.y, dpi) + px(r.h, dpi) });
    for (let a = 0; a < names.length; a++) {
      for (let b = a + 1; b < names.length; b++) {
        pairs++;
        const p = box(rects[names[a]]);
        const q = box(rects[names[b]]);
        if (p.x0 < q.x1 && q.x0 < p.x1 && p.y0 < q.y1 && q.y0 < p.y1) problems.push(`at ${dpi} dpi ${names[a]} overlaps ${names[b]}`);
      }
    }
    if (version.w[at] > px(rects.version.w, dpi)) problems.push(`at ${dpi} dpi the version words are ${version.w[at]} wide in a box of ${px(rects.version.w, dpi)}`);
    if (licence.w[at] > px(rects.licence.w, dpi)) problems.push(`at ${dpi} dpi the Licence link is ${licence.w[at]} wide in a box of ${px(rects.licence.w, dpi)}`);
    if (version.h[at] > px(rects.version.h, dpi)) problems.push(`at ${dpi} dpi the version words are ${version.h[at]} high in a box of ${px(rects.version.h, dpi)}`);
  });
  assert.equal(pairs, 6 * DPIS.length, "every pair of footer controls was compared at every scale");
  return problems;
}
test("fault_3_the_footers_controls_never_share_a_rectangle_and_the_version_words_fit_their_own", () => {
  assert.deepEqual(footerProblems(), []);
  allMeasured();
  // The faults are found: the Licence box as wide as it was (24 to 124, over the version words), the version box as wide as it was
  // (112 to 442, under Install), the version box too narrow for its words.
  const mutants = [
    ui().replace(/(PETALOCK_PX \$R8 )80(\n\s*!insertmacro PETALOCK_PX \$R9 20\n\s*\$\{NSD_CreateLink\} \$R6 \$R7 \$R8 \$R9 "Licence)/, "$1100$2"),
    ui().replace(/(PETALOCK_LABEL \$PetalockHVer \$PetalockInner 112 324 )\d+/, "$1330"),
    ui().replace(/(PETALOCK_LABEL \$PetalockHVer \$PetalockInner 112 324 )\d+/, "$1120"),
  ];
  for (const mutant of mutants) {
    assert.notEqual(mutant, ui(), "the mutant differs");
    assert.ok(footerProblems(mutant).length >= 1, "the fault is found");
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// 4. The slot below the rows (README item 4) and the lines of every state
// ---------------------------------------------------------------------------------------------------------------------
/** The main page's slot states: the words of the first slot line and the height its box has in that state (design pixels). */
function mainSlotStates(text = ui()) {
  const render = fn(text, "PetalockRender");
  const start = render.indexOf('${If} $PetalockProblem == "space"\n    SendMessage $PetalockHSlot1');
  const end = render.indexOf("GetDlgItem $0 $HWNDPARENT 1\n  ${If} $PetalockNoDown");
  assert.ok(start > 0 && end > start, "the slot's states are found");
  const homeMove = [...render.slice(0, start).matchAll(/PETALOCK_MOVE \$PetalockHSlot1 \d+ (\d+) (\d+) (\d+)/g)];
  assert.equal(homeMove.length, 1, "the slot's home rectangle is set once before the states");
  const home = { y: +homeMove[0][1], w: +homeMove[0][2], h: +homeMove[0][3] };
  const heads = {
    space: '${If} $PetalockProblem == "space"',
    running: '${ElseIf} $PetalockProblem == "running"',
    added: '${ElseIf} $PetalockProblem == "added"',
    write: '${ElseIf} $PetalockProblem != ""\n  ${AndIf} $PetalockCase != "new"',
    keep: '${ElseIf} $PetalockCase != "new"\n    !insertmacro PETALOCK_MOVE $PetalockHSlot1',
  };
  const at = Object.fromEntries(Object.entries(heads).map(([name, head]) => [name, render.indexOf(head, start)]));
  for (const [name, i] of Object.entries(at)) assert.ok(i >= start, `the ${name} state is found`);
  const order = Object.keys(at).sort((a, b) => at[a] - at[b]);
  const states = [];
  order.forEach((name, i) => {
    const branch = render.slice(at[name], i + 1 < order.length ? at[order[i + 1]] : end);
    const words = branch.match(/SendMessage \$PetalockHSlot1 \$\{WM_SETTEXT\} 0 "STR:([^"]*)"/)?.[1];
    const move = branch.match(/PETALOCK_MOVE \$PetalockHSlot1 \d+ (\d+) (\d+) (\d+)/);
    states.push({ state: name, words, y: move ? +move[1] : home.y, w: move ? +move[2] : home.w, h: move ? +move[3] : home.h });
  });
  return states;
}
/** Labels (every PETALOCK_LABEL in the file) whose box is shorter than one line of their font at some scale. The band and its rule are no text. */
function labelProblems(text = ui()) {
  const sizes = { PetalockFBody: [12, 400], PetalockFBold: [12, 600], PetalockFSent: [15, 400], PetalockFSentB: [15, 600], PetalockFHead: [20, 600], PetalockFName: [19, 600] };
  const problems = [];
  let looked = 0;
  for (const m of code(text).join("\n").matchAll(/!insertmacro PETALOCK_LABEL \$(\w+) \$\w+ (\S+) (\S+) (\S+) (\d+) 0x\w+ \$(\w+) /g)) {
    if (m[1] === "PetalockHBand" || m[1] === "PetalockHLine") continue;
    const [em, weight] = sizes[m[6]];
    const line = measured("Ag", weight, em, 0);
    DPIS.forEach((dpi, at) => {
      looked++;
      if (px(Number(m[5]), dpi) < line.pitch[at]) problems.push(`${m[1]} (${m[5]} high) at ${dpi} dpi: a line of its font is ${line.pitch[at]} px`);
    });
  }
  assert.ok(looked >= 25 * DPIS.length, `${looked} label heights were compared with a line`);
  return problems;
}
/** The last page's slot labels: the words, their font and their rectangle, as the source makes them. */
function endSlotLabels(text = ui()) {
  const end = fn(text, "PetalockEndShow");
  return [...end.matchAll(/PETALOCK_LABEL \$PetalockHSlot1 \$PetalockInner (\d+) (\d+) (\d+) (\d+) 0x\w+ \$(\w+) "([^"]*)"/g)].map((m) => ({ x: +m[1], y: +m[2], w: +m[3], h: +m[4], font: m[5], words: m[6] }));
}
/** Problems with the slots: the words need more lines than the box holds, at any of the five scales. Counts what it looked at. */
function slotProblems(text = ui()) {
  const problems = [];
  let looked = 0;
  const check = (what, words, weight, y, w, h, bottom) => {
    const m = measured(expand(words), weight, 12, w);
    DPIS.forEach((dpi, at) => {
      looked++;
      if (m.h[at] > px(h, dpi)) problems.push(`${what} at ${dpi} dpi: the words need ${m.h[at]} px and the box has ${px(h, dpi)}`);
      if (px(y, dpi) + px(h, dpi) > px(bottom, dpi)) problems.push(`${what} at ${dpi} dpi: the box runs past ${bottom}`);
    });
  };
  // The main page: the slot's own first words are bold (made with the bold font), and a state ends where the next control starts:
  // "space" and "running" and the plain ones above the band (306), "added" above its box (272), "write" above its field (275).
  const bottoms = { space: 306, running: 306, added: 272, write: 275, keep: 306 };
  const states = mainSlotStates(text);
  assert.equal(states.length, 5);
  assert.match(fn(text, "PetalockMainShow"), /PETALOCK_LABEL \$PetalockHSlot1 \$PetalockInner 24 236 452 48 0x54000080 \$PetalockFBold ""/, "the first words are made bold");
  for (const s of states) {
    assert.ok(s.words !== undefined, `${s.state}: its words are found`);
    check(`main page, ${s.state}`, s.words, 600, s.y, s.w, s.h, bottoms[s.state]);
  }
  // The last page: the failure's words in the regular font, above the details box (275).
  const labels = endSlotLabels(text);
  assert.ok(labels.length >= 7, `${labels.length} slot labels on the last page`);
  for (const l of labels) {
    const bold = l.font === "PetalockFBold";
    check(`last page, ${l.words.slice(0, 24)}`, l.words, bold ? 600 : 400, l.y, l.w, l.h, l.y === 236 && bold ? 262 : 275);
  }
  assert.ok(looked >= 5 * DPIS.length + 7 * DPIS.length, `${looked} fits were measured`);
  return problems;
}
test("fault_4_every_slot_state_holds_the_lines_its_words_need_at_five_scales_bold_included", () => {
  assert.deepEqual(slotProblems(), []);
  // Every label's box holds at least one line of its font at every scale (the folder label's 16 did not at 150 and 175 %).
  assert.deepEqual(labelProblems(), []);
  const shortBox = ui().replace(/(PETALOCK_LABEL \$PetalockHFLab \$PetalockInner 24 )\d+( 452 )\d+/, "$1258$216");
  assert.notEqual(shortBox, ui());
  assert.ok(labelProblems(shortBox).length >= 1, "a box too short for a line is found");
  allMeasured();
  // The faults are found: "Petalock is open" in the 64 px box it had (the fourth bold line is hidden from 150 %), the refusal's
  // words in 32, the failure's words in 32.
  const mutants = [
    ui().replace(/(\$\{ElseIf\} \$PetalockProblem == "running"\n(?:\s*;[^\n]*\n)*\s*!insertmacro PETALOCK_MOVE \$PetalockHSlot1 24 236 452 )\d+/, "$164"),
    ui().replace(/(\$\{ElseIf\} \$PetalockProblem == "added"\n(?:\s*;[^\n]*\n)*\s*!insertmacro PETALOCK_MOVE \$PetalockHSlot1 24 236 452 )\d+/, "$132"),
    ui().replace(/(PETALOCK_LABEL \$PetalockHSlot1 \$PetalockInner 24 236 452 )\d+( 0x54000080 \$PetalockFBody "Setup couldn’t write)/, "$132$2"),
  ];
  for (const mutant of mutants) {
    assert.notEqual(mutant, ui(), "the mutant differs");
    assert.ok(slotProblems(mutant).length >= 1, "the fault is found");
    missing.splice(0);
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// 5. The rows (README items 5 and 6)
// ---------------------------------------------------------------------------------------------------------------------
/** The state words' column widths and the gap between them and the row's own words, in design pixels. */
function stateColumns(text = ui()) {
  const sw = Object.fromEntries([...code(text).join("\n").matchAll(/^!define PL_SW_(\w+) (\d+)$/gm)].map((m) => [m[1], Number(m[2])]));
  assert.deepEqual(Object.keys(sw).sort(), ["DONE", "FAILED", "NEXT", "NOTSTARTED", "NOW", "REMOVED"], "a column for each state word");
  const gap = Number(code(text).join("\n").match(/^!define PL_GAP (\d+)$/m)?.[1]);
  assert.ok(Number.isInteger(gap), "the gap between the words and the state column is defined");
  return { sw, gap, plain: 432 };
}
const STATE_WORD = { DONE: ["Done", 400], NOW: ["Now", 600], NEXT: ["Next", 400], FAILED: ["Failed", 600], NOTSTARTED: ["Not started", 400], REMOVED: ["Removed", 400] };

/** Every row's words with the states they can be in: [text, states], from the source's own words. */
function rowWords(source = ui()) {
  const out = [];
  // The plan (no state word, Next while the checks run, Not started after a failure): regular.
  const plan = fn(source, "PetalockPlanRows");
  const texts = [...plan.matchAll(/StrCpy \$PetalockT([123]) "([^"]*)"/g)].map((m) => ({ row: Number(m[1]), text: m[2], layout2: false }));
  const layout2 = plan.slice(plan.indexOf("$PetalockLayout = 2"), plan.indexOf("${EndIf}", plan.indexOf("$PetalockLayout = 2")));
  const l2texts = new Set([...layout2.matchAll(/StrCpy \$PetalockT([123]) "([^"]*)"/g)].map((m) => m[2]));
  for (const t of texts) {
    // The remove-first row's long words are only ever plain or Next (nothing runs before the old uninstaller, so it is never Not started).
    const states = t.text.startsWith("Remove ") ? ["PLAIN", "NEXT"] : ["PLAIN", "NEXT", "NOTSTARTED"];
    out.push({ kind: "words", row: t.row, text: t.text, weight: 400, states, source: `plan row ${t.row}${l2texts.has(t.text) ? " (remove first)" : ""}` });
  }
  out.push({ kind: "detail", text: DEFS.PL_PLAN_WV_D, weight: 400, source: "plan detail" });
  // The step words: Now (bold), Done (regular) or Failed (bold), by step.
  const step = fn(source, "PetalockStepText").split("\n");
  let current = null;
  let state = null;
  let bIndent = -1;
  for (const line of step) {
    let m;
    const indent = line.length - line.trimStart().length;
    if ((m = line.match(/^\s*\$\{(?:If|ElseIf)\} \$PetalockStep == "(\w+)"$/))) { current = m[1]; state = null; bIndent = -1; continue; }
    if (/^ {2}\$\{Else\}$/.test(line)) { current = "entries"; state = null; bIndent = -1; continue; }
    if ((m = line.match(/^(\s*)\$\{(?:If|ElseIf)\} \$PetalockB == "(\w+)"$/))) { state = m[2]; bIndent = m[1].length; continue; }
    if (bIndent >= 0 && indent === bIndent && /^\s*\$\{(Else|ElseIf)\}/.test(line)) { state = "failed"; continue; }
    if ((m = line.match(/^\s*StrCpy \$PetalockA "([^"]*)"$/))) {
      if (current === null || state === null) continue;
      if (current === "entries") {
        // Row 3 (the entries): the words of a Done row can be shown Failed (a shortcut that could not be made), in bold; the row has two lines.
        out.push({ kind: "words", row: 3, text: m[1], weight: 600, states: ["NOW", "FAILED"], source: `entries ${state}`, entries: true });
      } else {
        const done = state === "done";
        out.push({ kind: "words", row: 0, text: m[1], weight: done ? 400 : 600, states: [done ? "DONE" : state === "now" ? "NOW" : "FAILED"], source: `${current} ${state}` });
      }
    } else if ((m = line.match(/^\s*StrCpy \$PetalockR "([^"$]*)"$/)) && current !== null && m[1] !== "") {
      out.push({ kind: "detail", text: m[1], weight: 400, source: `${current} ${state} detail` });
    }
  }
  // After a failure: the words of a file step that was taken out again, and the reasons the WebView2 step gives.
  const fail = fn(source, "PetalockFailRows");
  for (const m of fail.matchAll(/StrCpy \$PetalockT2 "([^"$]*)"/g)) out.push({ kind: "words", row: 2, text: m[1], weight: 400, states: ["REMOVED"], source: "failure rows" });
  for (const m of fn(source, "PetalockWebviewReason").matchAll(/StrCpy \$PetalockDetail "([^"]*)"/g)) out.push({ kind: "detail", text: m[1].replace("$2", "1234567"), weight: 400, source: "webview reason" });
  return out;
}
/** Problems with the rows: words that need more than their room in one line (rows 1 and 2) or two (row 3, which has the room), or a state word wider than its column. */
function rowProblems(text = ui()) {
  const { sw, gap, plain } = stateColumns(text);
  const problems = [];
  let looked = 0;
  const room = (state) => (state === "PLAIN" ? plain : plain - sw[state] - gap);
  const words = rowWords(text);
  assert.ok(words.length >= 25, `${words.length} row words were found`);
  for (const r of words) {
    const wants = r.states ?? ["DETAIL"];
    for (const state of wants) {
      const width = r.kind === "detail" ? 446 : room(state);
      // One line for rows 1 and 2 and the detail line: the words' measured one-line width against the room. Row 3 may take two: the
      // height Windows measured for the words wrapped in the room's width, at each scale, against the box's height (rounded up).
      const twoLines = r.kind !== "detail" && (r.entries || r.row === 3);
      const m = twoLines ? measured(expand(r.text), r.weight, 12, width) : measured(expand(r.text), r.weight, 12, 0);
      const row3 = Number(code(text).join("\n").match(/PETALOCK_PAINT 3 \$\{PL_ROW3\} (\d+)$/m)?.[1]);
      assert.ok(Number.isInteger(row3), "row 3's box height is found");
      DPIS.forEach((dpi, at) => {
        looked++;
        const roomPx = px(width, dpi);
        const fits = twoLines ? m.h[at] <= pxUp(row3, dpi) : m.w[at] <= roomPx && m.pitch[at] <= px(20, dpi);
        if (!fits) problems.push(`${r.source} (${state}) at ${dpi} dpi: "${r.text.slice(0, 30)}" is ${twoLines ? `${m.h[at]} high wrapped` : `${m.w[at]} wide (a line is ${m.pitch[at]} high)`} in ${roomPx}`);
      });
    }
  }
  assert.ok(looked >= 60 * DPIS.length / 2, `${looked} row fits were measured`);
  // The state words fit their columns, and the columns are the state box's own width (the box and the words never share a rectangle).
  for (const [key, [word, weight]] of Object.entries(STATE_WORD)) {
    const m = measured(word, weight, 12, 0);
    DPIS.forEach((dpi, at) => {
      looked++;
      if (m.w[at] > px(sw[key], dpi)) problems.push(`the state word "${word}" is ${m.w[at]} wide at ${dpi} dpi in a column of ${px(sw[key], dpi)}`);
    });
  }
  return problems;
}
test("fault_5_no_row_words_are_cut_with_dots_and_each_row_has_the_room_its_words_need", () => {
  const all = code(ui()).join("\n");
  // The label style 0x54004080 has SS_ENDELLIPSIS (0x4000): words that do not fit end in dots. No row or detail label has it now.
  assert.ok(!/0x54004080/.test(all), "no label ends its words with dots");
  const build = fn(ui(), "PetalockBuildRows");
  const n = String.raw`(?:\d+|\$\{\w+\})`;
  for (const id of ["HT1", "HT2", "HT3", "HD1"]) assert.match(build, new RegExp(String.raw`PETALOCK_LABEL \$Petalock${id} \$PetalockInner ${n} ${n} ${n} ${n} 0x54000080 `), `${id} wraps instead of cutting`);
  // The room: each row's words get the width left by the state word's column, row 3 two lines (its box is 34 high, down to the slot at 236).
  const paint = macro(ui(), "PETALOCK_PAINT");
  assert.match(paint, /IntOp \$PetalockTW 432 - \$PetalockSW\n\s*IntOp \$PetalockTW \$PetalockTW - \$\{PL_GAP\}/);
  assert.match(paint, /PETALOCK_MOVEU \$PetalockHT\$\{N\} 44 \$\{Y\} \$PetalockTW \$\{H\}/, "the words' box is as wide as the state word leaves it, and rounded up in height");
  assert.match(paint, /IntOp \$PetalockTX 476 - \$PetalockSW/, "the state word's box starts where its column does");
  assert.match(code(ui()).join("\n"), /!insertmacro PETALOCK_PAINT 3 \$\{PL_ROW3\} 34$/m, "row 3's box is 34 high (two lines)");
  assert.equal(DEFS.PL_ROW3 + 34, 236, "row 3's box ends where the slot starts");
  assert.deepEqual(rowProblems(), []);
  allMeasured();
  // The faults are found: Not started in a column too narrow for it, the Next column so wide that the remove-first row's words no longer
  // fit beside it, a gap so wide that the same words do not fit.
  const mutants = [
    ui().replace(/^!define PL_SW_NOTSTARTED \d+$/m, "!define PL_SW_NOTSTARTED 40"),
    ui().replace(/^!define PL_SW_NEXT \d+$/m, "!define PL_SW_NEXT 100"),
    ui().replace(/^!define PL_GAP \d+$/m, "!define PL_GAP 60"),
    // row 3's box one line high: its wrapped words (measured) no longer fit
    ui().replace("PETALOCK_PAINT 3 ${PL_ROW3} 34", () => "PETALOCK_PAINT 3 ${PL_ROW3} 20"),
  ];
  for (const mutant of mutants) {
    assert.notEqual(mutant, ui(), "the mutant differs");
    assert.ok(rowProblems(mutant).length >= 1, "the fault is found");
    missing.splice(0);
  }
});

test("fault_6_remove_first_rows_follow_the_run_order_with_no_empty_line_and_webview2_keeps_its_second_line", () => {
  const rowOf = fn(ui(), "PetalockRowOf");
  const rows = (layout) => {
    const block = layout === 2 ? rowOf.slice(rowOf.indexOf("$PetalockLayout = 2"), rowOf.indexOf("${Else}")) : rowOf.slice(rowOf.indexOf("${Else}"));
    const fallback = Number(rowOf.match(/^\s*StrCpy \$0 (\d)$/m)[1]);
    return ["remove_old", "webview2", "files", "entries"].map((id) => {
      const at = block.indexOf(`$PetalockStep == "${id}"`);
      return at < 0 ? fallback : Number(block.slice(at).match(/StrCpy \$0 (\d)/)[1]);
    });
  };
  // The steps run remove_old, webview2, files, entries (D-amendments, "Settled in the build": state 14's rows follow that order), so
  // the rows go down in that order and Now and Next never run backwards.
  const steps = ["remove_old", "webview2", "files", "entries"];
  assert.deepEqual(rows(2), [1, 2, 3, 3], "remove first: the old uninstaller is row 1, WebView2 row 2, the files and the entries row 3");
  assert.deepEqual(rows(1).slice(1), [1, 2, 3], "a normal run: one row each");
  for (const layout of [1, 2]) {
    const order = layout === 1 ? rows(1).slice(1) : rows(2);
    order.forEach((row, i) => assert.ok(i === 0 || row >= order[i - 1], `layout ${layout}: ${steps[layout === 1 ? i + 1 : i]} does not come before the step that ran before it`));
  }
  // No empty line: remove-first's three rows all have words, and WebView2's second line sits directly under ITS row (row 2), the rows
  // being contiguous: the removal at 142, WebView2 at 162, its line at 182, the install at 202 (the old layout left 160 empty).
  const plan = fn(ui(), "PetalockPlanRows");
  const layoutAt = plan.indexOf("${If} $PetalockLayout = 2\n    StrCpy $PetalockT");
  assert.ok(layoutAt > 0, "the layout-2 words are found");
  assert.match(plan.slice(0, layoutAt), /StrCpy \$PetalockD1 "\$\{PL_PLAN_WV_D\}"/, "WebView2's second line is set for both layouts");
  const l2 = plan.slice(layoutAt, plan.indexOf("Return", layoutAt));
  assert.match(l2, /StrCpy \$PetalockT1 "Remove \$PetalockA first, with its temporary copies of opened files"/);
  assert.match(l2, /StrCpy \$PetalockT2 "\$\{PL_PLAN_WV\}"/);
  assert.match(l2, /StrCpy \$PetalockT3 "Install \$\{VERSION\} in the same folder; keep its Start menu shortcut"/);
  assert.ok(!DEFS.PL_PLAN_WV_L2, "the one-line WebView2 words for remove-first (which left no second line) are gone");
  const paintRows = fn(ui(), "PetalockPaintRows");
  assert.match(paintRows, /\$\{If\} \$PetalockLayout = 2\n\s*StrCpy \$PetalockRY2 \$\{PL_L2_ROW2\}\n\s*StrCpy \$PetalockRYD \$\{PL_L2_DETAIL\}/);
  assert.match(paintRows, /PETALOCK_MOVE \$PetalockHD1 44 \$PetalockRYD 446 20/, "the second line follows its row");
  assert.match(paintRows, /PETALOCK_MOVE \$PetalockHN2 24 \$PetalockRY2 14 20/, "so does row 2's number");
  assert.match(paintRows, /PETALOCK_PAINT 2 \$PetalockRY2 20/);
  assert.deepEqual([DEFS.PL_ROW1, DEFS.PL_L2_ROW2, DEFS.PL_L2_DETAIL, DEFS.PL_ROW3], [142, 162, 182, 202], "remove-first's rows are 20 apart with nothing between");
  assert.equal(DEFS.PL_ROW1 + 20, DEFS.PL_L2_ROW2);
  assert.equal(DEFS.PL_L2_ROW2 + 20, DEFS.PL_L2_DETAIL);
  assert.equal(DEFS.PL_L2_DETAIL + 20, DEFS.PL_ROW3);
  // Only WebView2's step sets that line, wherever its row is (the old code set it from whichever step was on row 1).
  for (const name of ["PetalockStepBegin", "PetalockStepDone", "PetalockRowAs"]) {
    const body = fn(ui(), name);
    assert.match(body, /\$\{If\} \$PetalockStep == "webview2"\n\s*StrCpy \$PetalockD1 \$PetalockR\n\s*\$\{EndIf\}/, `${name} sets the second line for the WebView2 step`);
    assert.ok(!/\$\{If\} \$0 = 1\n\s*StrCpy \$PetalockT1 \$PetalockA\n\s*StrCpy \$PetalockD1/.test(body), `${name} does not set it from row 1`);
  }
  // The receipt and the failure rows put each step on its row by the table, WebView2's result on its own second line in both layouts.
  const receipt = fn(ui(), "PetalockReceiptRows");
  assert.ok(!receipt.includes('"$PetalockA: $PetalockR"'), "WebView2's result is not folded into a row's words any longer");
  assert.ok(receipt.includes('StrCpy $PetalockStep "webview2"\n  Call PetalockRowAs'), "WebView2's row is set first");
  assert.ok(receipt.indexOf('StrCpy $PetalockStep "webview2"') < receipt.indexOf("$PetalockLayout"), "WebView2's row is set for both layouts");
  const rowAs = fn(ui(), "PetalockRowAs");
  assert.match(rowAs, /Call PetalockRowOf\n\s*Call PetalockStepText/, "a step goes on the row the table gives it");
  const fail = fn(ui(), "PetalockFailRows");
  assert.ok(fail.includes("Call PetalockRowAs") && !/Call PetalockRowOf/.test(fail), "the failure's rows are put by the table too");
  assert.ok(!/\$1 >= 2/.test(fail), "the rows before the failed one are by the order the steps ran, not by row number");
  // The steps that ran before the failed one are Done in either layout: the removal (remove-first, unless it is the one that failed),
  // WebView2 (the files or the entries failed), the files (the entries failed).
  assert.match(fail, /\$\{If\} \$PetalockLayout = 2\n\s*\$\{AndIf\} \$PetalockFailStep != "remove_old"\n\s*StrCpy \$PetalockStep "remove_old"\n\s*Call PetalockRowAs/);
  assert.match(fail, /\$\{If\} \$PetalockFailStep == "files"\n\s*\$\{OrIf\} \$PetalockFailStep == "entries"\n\s*StrCpy \$PetalockStep "webview2"\n\s*Call PetalockRowAs/);
  assert.match(fail, /\$\{If\} \$PetalockFailStep == "entries"\n\s*StrCpy \$PetalockStep "files"/);
});

// ---------------------------------------------------------------------------------------------------------------------
// Fix round (the retaken pictures): the rows' ink after a refusal
// ---------------------------------------------------------------------------------------------------------------------
test("fix_round_1_a_rows_colour_is_repainted_after_it_is_set_so_the_plan_is_ink_again_after_a_refusal", () => {
  // SetCtlColors only stores the colours a static is drawn with; nothing repaints it (NSIS, exec.c EW_SETCTLCOLORS stores a pointer in the
  // window's user data). PETALOCK_PAINT set the text and the font first and the colours last, so a row painted Next (the checking moment:
  // grey) and then painted as the plan again (ink, after Petalock open / a folder or space refusal) kept showing the grey one: the number
  // labels' words never change, so nothing else repaints them. Every control whose colour the macro sets is invalidated after the last
  // colour is set.
  const paint = macro(ui(), "PETALOCK_PAINT");
  assert.ok(paint.length > 500, "the paint macro is there");
  /** The controls whose colour the macro sets and that are not invalidated after the last colour is set (empty when all are). */
  const notRepainted = (body) => {
    const colours = [...body.matchAll(/PETALOCK_(?:INK|DIM) |Call PetalockColour/g)].map((m) => m.index);
    assert.ok(colours.length >= 4, `${colours.length} colour settings were found in the macro`);
    const lastColour = Math.max(...colours);
    return ["HT", "HN", "HS"].filter((control) => body.indexOf(`user32::InvalidateRect(p $Petalock${control}\${N}, p 0, i 1)`) <= lastColour);
  };
  assert.deepEqual(notRepainted(paint), []);
  // The comparison fires on the fault: the macro as it was (no repaint at all) and a repaint put before the colours.
  const withoutRepaint = paint.replace(/\n\s*System::Call 'user32::InvalidateRect[^\n]*/g, "");
  assert.notEqual(withoutRepaint, paint);
  assert.deepEqual(notRepainted(withoutRepaint), ["HT", "HN", "HS"]);
  const early = `  System::Call 'user32::InvalidateRect(p $PetalockHT\${N}, p 0, i 1)'\n  System::Call 'user32::InvalidateRect(p $PetalockHN\${N}, p 0, i 1)'\n  System::Call 'user32::InvalidateRect(p $PetalockHS\${N}, p 0, i 1)'\n${withoutRepaint}`;
  assert.deepEqual(notRepainted(early), ["HT", "HN", "HS"]);
  // A plan painted again (after a refusal) goes through the same macro with no state: the ink branch, not the dim one.
  assert.match(paint, /\$\{If\} \$PetalockS\$\{N\} == "next"\n\s*\$\{OrIf\} \$PetalockS\$\{N\} == "ns"\n\s*!insertmacro PETALOCK_DIM \$PetalockHT\$\{N\}\n\s*!insertmacro PETALOCK_DIM \$PetalockHN\$\{N\}\n\s*\$\{Else\}\n\s*!insertmacro PETALOCK_INK \$PetalockHT\$\{N\}\n\s*!insertmacro PETALOCK_INK \$PetalockHN\$\{N\}/);
  // The refusal paints the plan (no state word) by Render, which is the path that ends in the macro.
  const render = fn(ui(), "PetalockRender");
  assert.match(render, /Call PetalockPlanRows[\s\S]*Call PetalockPaintRows/);
});

// ---------------------------------------------------------------------------------------------------------------------
// 7. The uninstaller's sidebar (README item 9)
// ---------------------------------------------------------------------------------------------------------------------
test("fault_7_the_uninstallers_finish_page_has_petalocks_own_sidebar_art_made_by_the_script", () => {
  const conf = JSON.parse(read(CONFIG));
  assert.equal(conf.bundle.windows.nsis.sidebarImage, "windows/sidebar.bmp");
  assert.ok(existsSync(join(ROOT, SIDEBAR)), "the sidebar bitmap is committed");
  const bytes = readFileSync(join(ROOT, SIDEBAR));
  assert.equal(bytes.subarray(0, 2).toString("latin1"), "BM");
  assert.equal(bytes.readInt32LE(18), 328, "twice the 164 px of the stock sidebar (the page stretches it to its control at every scale)");
  assert.equal(Math.abs(bytes.readInt32LE(22)), 628, "twice the 314 px");
  assert.equal(bytes.readUInt16LE(28), 24);
  assert.equal(bytes.readUInt32LE(30), 0);
  // The template hands the build's sidebar image to the uninstaller's welcome and finish pages (its own define: MUI_UNWELCOMEFINISHPAGE_BITMAP).
  const text = code(template()).join("\n");
  assert.match(text, /!if "\$\{SIDEBARIMAGE\}" != ""\n\s*!define MUI_WELCOMEFINISHPAGE_BITMAP "\$\{SIDEBARIMAGE\}"\n\s*!define MUI_UNWELCOMEFINISHPAGE_BITMAP "\$\{SIDEBARIMAGE\}"\n!endif/);
  // The picture is what the script draws (and holds ink: a blank picture would equal a blank drawing), and the comparison fires on a wrong file.
  assert.equal(sidebarProblem(bytes), undefined);
  const ink = [...bytes.subarray(54)].filter((value) => value !== 255).length;
  assert.ok(ink > 20000, `the picture holds ${ink} coloured bytes`);
  const blank = Buffer.from(bytes);
  blank.fill(255, 54);
  assert.match(sidebarProblem(blank) ?? "", /differ from the drawing/);
  const changed = Buffer.from(bytes);
  for (let i = 54; i < 54 + 6000; i += 1) changed[i] = (changed[i] + 40) % 256;
  assert.match(sidebarProblem(changed) ?? "", /differ from the drawing/);
  assert.match(sidebarProblem(bytes.subarray(0, bytes.length - 3)) ?? "", /length differs/);
  assert.match(sidebarProblem(Buffer.from("MU- not a picture")) ?? "", /not a BMP file/);
  // The band's own file is not mistaken for the sidebar's (different size).
  assert.match(sidebarProblem(readFileSync(join(ROOT, "crates/petalock-desktop/windows/band.bmp"))) ?? "", /not 328 x 628/);
  assert.match(bandProblem(bytes) ?? "", /not 952 x 104/);
  // The uninstaller keeps its layout and words (Task 9e's test pins them); only the picture is new.
  assert.ok(template().includes("Your vaults stay where they are."));
});

// ---------------------------------------------------------------------------------------------------------------------
// The smoke check on the runner reads the progress page's inner dialog against the client area (cheap, one assertion)
// ---------------------------------------------------------------------------------------------------------------------
test("the_smoke_script_compares_the_progress_pages_inner_dialog_with_the_client_area", () => {
  const smoke = read(SMOKE);
  assert.match(smoke, /public static int\[\] InnerAgainstClient\(IntPtr outer\)/);
  const check = smoke.slice(smoke.indexOf('$Checks["a_completed_step_puts_words_in_the_status_line"]'), smoke.indexOf('$Checks["a_refused_registration_keeps_everything_but_the_files_this_attempt_wrote"]'));
  assert.ok(check.length > 500, "the check is found");
  assert.match(check, /\[SmokeDlg\]::InnerAgainstClient\(\$d\.Handle\)/);
  assert.match(check, /the progress page's inner dialog is not the whole client area/);
});
