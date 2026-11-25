import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { deflateSync } from "node:zlib";

import { COLOUR, FRAMES, PNG_FRAME, frameProblem, icoFrames, png, problems, rawRows, readPng } from "./make-icon.mjs";

const SCRIPT = fileURLToPath(new URL("./make-icon.mjs", import.meta.url));
const ICONS = join(dirname(SCRIPT), "..", "crates", "lockbox-desktop", "icons");
const ICO = readFileSync(join(ICONS, "icon.ico"));
const PNG = readFileSync(join(ICONS, "icon.png"));

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
test("icon_files_match_the_script: the committed icon.ico and icon.png are what make-icon.mjs draws", () => {
  const run = spawnSync(process.execPath, [SCRIPT, "--check"], { encoding: "utf8" });
  assert.equal(run.status, 0, `${run.stderr}run node scripts/make-icon.mjs to remake the icon`);
  // It said so, so it really compared (a script that skipped its work would exit 0 silently).
  assert.match(run.stdout, /icon\.ico and icon\.png match the drawing/);
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
  // The whole check: an .ico with a frame missing is named.
  const short = Buffer.from(ICO);
  short.writeUInt16LE(FRAMES.length - 1, 4);
  assert.match(problems(short, png(frame)).join("\n"), /icon\.ico: 7 frames, 8 drawn/);
});

test("icon_holds_each_frame_once: the .ico lists every size, smallest first, each a PNG of that size", () => {
  assert.equal(ICO.readUInt16LE(2), 1);
  const frames = icoFrames(ICO);
  assert.equal(frames.length, FRAMES.length);
  frames.forEach(({ listed, png: bytes }, i) => {
    const { size } = FRAMES[i];
    assert.equal(listed, size >= 256 ? 0 : size);
    assert.equal(readPng(bytes)?.size, size);
  });
  assert.equal(readPng(PNG)?.size, PNG_FRAME.size);
});

test("icon_frames_are_drawn_in_the_apps_colour: every frame is the slate blue, with nothing else in it", () => {
  assert.deepEqual(COLOUR, [0x5b, 0x7b, 0xa8]);
  for (const bytes of [...icoFrames(ICO).map((frame) => frame.png), PNG]) {
    const read = readPng(bytes);
    assert.ok(read !== undefined);
    const seen = pixels(read).filter(([, , , alpha]) => alpha > 0);
    assert.ok(seen.length > 0, `the ${String(read.size)} frame is empty`);
    for (const [r, g, b] of seen) assert.deepEqual([r, g, b], COLOUR);
  }
});
