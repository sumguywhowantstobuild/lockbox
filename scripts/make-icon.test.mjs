import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { deflateSync } from "node:zlib";

import {
  COLOUR,
  COLOUR_ON_DARK,
  FRAMES,
  PNG_FRAME,
  frameProblem,
  icoFrames,
  png,
  problems,
  rawRows,
  readPng,
} from "./make-icon.mjs";

const SCRIPT = fileURLToPath(new URL("./make-icon.mjs", import.meta.url));
const ICONS = join(dirname(SCRIPT), "..", "crates", "lockbox-desktop", "icons");
const ICO = readFileSync(join(ICONS, "icon.ico"));
const PNG = readFileSync(join(ICONS, "icon.png"));
const DARK_ICO = readFileSync(join(ICONS, "icon-dark-taskbar.ico"));

/** The pixels of a PNG's rows, as [red, green, blue, alpha], skipping each row's filter byte. */
function pixels({ size, rows }) {
  const out = [];
  for (let y = 0; y < size; y += 1) {
    const row = y * (1 + size * 4);
    for (let x = 0; x < size; x += 1) out.push([...rows.subarray(row + 1 + x * 4, row + 5 + x * 4)]);
  }
  return out;
}

// Drawing every frame takes a while, so the script draws once (its own --check) and the other tests read the files it
// has just proved equal to its drawing, or draw only the smallest frame.
test("icon_files_match_the_script: the committed icons and icon.png are what make-icon.mjs draws", () => {
  const run = spawnSync(process.execPath, [SCRIPT, "--check"], { encoding: "utf8" });
  assert.equal(run.status, 0, `${run.stderr}run node scripts/make-icon.mjs to remake the icon`);
  // It said so, so it really compared (a script that skipped its work would exit 0 silently).
  assert.match(run.stdout, /icon\.ico, icon\.png and icon-dark-taskbar\.ico match the drawing/);
});

test("icon_check_compares_pixels: other compression passes, one changed pixel or a wrong size fails", () => {
  const frame = FRAMES[0];
  const rows = rawRows(frame);
  const header = readPng(png(frame));
  assert.equal(frameProblem(png(frame), frame), undefined);
  // The same pixels compressed another way (as another zlib might) still match.
  const repack = (data) => {
    const made = png(frame);
    const idat = made.indexOf("IDAT", 0, "ascii") - 4;
    const body = deflateSync(data, { level: 1 });
    const length = Buffer.alloc(4);
    length.writeUInt32BE(body.length, 0);
    return Buffer.concat([made.subarray(0, idat), length, Buffer.from("IDAT"), body, Buffer.alloc(4), Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82])]);
  };
  assert.equal(header.size, frame.size);
  assert.equal(frameProblem(repack(rows), frame), undefined);
  // One pixel's alpha changed is caught.
  const changed = Buffer.from(rows);
  changed[1 + 3] ^= 0xff;
  assert.equal(frameProblem(repack(changed), frame), "its pixels differ from the drawing");
  // A frame of the wrong size, or a file that is no PNG, is caught without drawing anything else.
  assert.equal(frameProblem(png(frame), FRAMES[1]), "not a 20 px PNG");
  assert.equal(frameProblem(Buffer.from("not a png"), frame), "not a 16 px PNG");
  // The same pixels in the other icon's colour are caught: the two icons can't be swapped.
  assert.equal(frameProblem(png(frame, COLOUR_ON_DARK), frame), "its pixels differ from the drawing");
  assert.equal(frameProblem(png(frame, COLOUR_ON_DARK), frame, COLOUR_ON_DARK), undefined);
  // The whole check: an .ico with a frame missing is named, for either icon.
  const short = Buffer.from(ICO);
  short.writeUInt16LE(FRAMES.length - 1, 4);
  const found = problems(short, png(frame), short).join("\n");
  assert.match(found, /icon\.ico: 7 frames, 8 drawn/);
  assert.match(found, /icon-dark-taskbar\.ico: 7 frames, 8 drawn/);
});

test("icon_holds_each_frame_once: each .ico lists every size, smallest first, each a PNG of that size", () => {
  for (const ico of [ICO, DARK_ICO]) {
    assert.equal(ico.readUInt16LE(2), 1);
    const frames = icoFrames(ico);
    assert.equal(frames.length, FRAMES.length);
    frames.forEach(({ listed, png: bytes }, i) => {
      const { size } = FRAMES[i];
      assert.equal(listed, size >= 256 ? 0 : size);
      assert.equal(readPng(bytes)?.size, size);
    });
  }
  assert.equal(readPng(PNG)?.size, PNG_FRAME.size);
});

test("icon_is_the_solid_petals_up_to_64: the tray, title bar, taskbar and Alt+Tab show one shape", () => {
  // Ariel's pick on board H (2026-11-25): the two crossing lines read as six loops on the taskbar button.
  for (const { size, drawing } of FRAMES) assert.equal(drawing, size <= 64 ? "solid" : "pattern", `the ${String(size)} frame`);
  assert.equal(PNG_FRAME.drawing, "pattern");
});

test("dark_icon_matches_the_apps_mark: the dark taskbar's icon and the lock screen's small mark are one colour", () => {
  const tokens = readFileSync(join(dirname(SCRIPT), "..", "ui", "src", "styles", "tokens.css"), "utf8");
  const found = [...tokens.matchAll(/--field-mark:\s*#([0-9a-f]{6});/gi)].map(([, hex]) => hex.toLowerCase());
  // Both modes set it; none found would pass the loop below without checking anything.
  assert.equal(found.length, 2);
  const hex = COLOUR_ON_DARK.map((c) => c.toString(16).padStart(2, "0")).join("");
  for (const value of found) assert.equal(value, hex);
});

test("icon_frames_are_drawn_in_the_apps_colour: slate blue for a light taskbar, light slate blue for a dark one", () => {
  assert.deepEqual(COLOUR, [0x5b, 0x7b, 0xa8]);
  assert.deepEqual(COLOUR_ON_DARK, [0xbc, 0xd0, 0xec]);
  const icons = [
    [[...icoFrames(ICO).map((frame) => frame.png), PNG], COLOUR],
    [icoFrames(DARK_ICO).map((frame) => frame.png), COLOUR_ON_DARK],
  ];
  for (const [pngs, colour] of icons) {
    for (const bytes of pngs) {
      const read = readPng(bytes);
      assert.ok(read !== undefined);
      const seen = pixels(read).filter(([, , , alpha]) => alpha > 0);
      assert.ok(seen.length > 0, `the ${String(read.size)} frame is empty`);
      for (const [r, g, b] of seen) assert.deepEqual([r, g, b], colour);
    }
  }
});

/** WCAG's relative luminance of an sRGB colour. */
function luminance([r, g, b]) {
  const linear = (c) => (c / 255 <= 0.04045 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4);
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

test("icon_colours_stand_out_on_their_taskbar: 3 to 1 at least, a line drawing's minimum", () => {
  // Windows 11's taskbar colours, light and dark.
  assert.ok(contrast(COLOUR, [0xf3, 0xf3, 0xf3]) >= 3);
  assert.ok(contrast(COLOUR_ON_DARK, [0x20, 0x20, 0x20]) >= 3);
  // And the dark one is the brighter pick there: the reason it exists.
  assert.ok(contrast(COLOUR_ON_DARK, [0x20, 0x20, 0x20]) > contrast(COLOUR, [0x20, 0x20, 0x20]) + 3);
});
