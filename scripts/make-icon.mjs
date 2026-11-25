// Draws Petalock's app icon, the three petals in slate blue, from the same formula as the page's line drawings
// (ui/src/parts/Pattern.tsx), and writes crates/lockbox-desktop/icons/icon.ico and icon.png.
//
//   node scripts/make-icon.mjs            writes both files
//   node scripts/make-icon.mjs --check    exits 1 when the files differ from what the script draws
//
// Each frame of the .ico is drawn at its own size rather than shrunk from a big picture, so the small ones stay
// sharp: 16 and 20 pixels take the solid trefoil, 24 and 32 the bolder small drawing (deeper petals, thicker lines),
// 40 to 64 the two-line mark, 256 the fourteen-line pattern. Windows picks the frame for each place and scaling: 16, 20, 24 and 32 by the clock
// and in lists at 100 to 200 %, 32, 40, 48 and 64 for the window and the taskbar, 256 in Explorer's large views.
// One colour serves a light and a dark taskbar: the design's slate blue #5B7BA8 measures 3.8 to 1 on Windows' dark
// taskbar (#202020) and 3.9 to 1 on its light one (#F3F3F3), above the 3 to 1 a line drawing needs.
//
// No package is used: a pixel's colour is how much of it the drawing covers (64 samples a pixel), and the PNG and
// ICO files are written by hand (zlib comes with Node). The same input always gives the same bytes.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync, inflateSync } from "node:zlib";

export const COLOUR = [0x5b, 0x7b, 0xa8];
const ICONS = join(dirname(fileURLToPath(import.meta.url)), "..", "crates", "lockbox-desktop", "icons");

// The drawings, in the formula's own units (a circle of 62 in a 200 square): radius = 100 (base + amp sin(points
// angle + phase)) for each line. `small` is the design's bold drawing for 16 to 24 pixels (board D's "lines"),
// `mark` the two-line mark, `pattern` the lock screen's fourteen lines.
const DRAWINGS = {
  small: { base: 0.6, lines: [0, 1].map((i) => ({ amp: 0.26, phase: i * Math.PI })) },
  mark: { base: 0.62, lines: [0, 1].map((i) => ({ amp: 0.17, phase: i * Math.PI })) },
  pattern: { base: 0.62, lines: Array.from({ length: 14 }, (_, i) => ({ amp: 0.16 + i * 0.012, phase: (i * Math.PI) / 14 })) },
  // Board D's "solid": one deep trefoil, filled, with a round hole of 15 in the middle (see-through here).
  solid: { base: 0.56, lines: [{ amp: 0.34, phase: 0 }], fill: true, hole: 15 },
};

/** Each frame: its size in pixels, its drawing and the width of its lines in pixels (tuned by eye at each size). */
export const FRAMES = [
  // At 16 and 20 the two crossing lines run into a grid, so these take the design's solid trefoil instead.
  { size: 16, drawing: "solid", stroke: 0 },
  { size: 20, drawing: "solid", stroke: 0 },
  { size: 24, drawing: "small", stroke: 1.75 },
  { size: 32, drawing: "small", stroke: 2.1 },
  { size: 40, drawing: "mark", stroke: 2.2 },
  { size: 48, drawing: "mark", stroke: 2.4 },
  { size: 64, drawing: "mark", stroke: 2.8 },
  { size: 256, drawing: "pattern", stroke: 1.9 },
];

/** The large picture beside the .ico (Tauri's bundle lists it): the pattern at 512 pixels. */
export const PNG_FRAME = { size: 512, drawing: "pattern", stroke: 3.2 };

const POINTS = 3;
const SAMPLES = 8;

/**
 * How far a point is from one line, in the formula's units: the gap between its radius and the line's at its angle,
 * turned toward the line's normal (a polar curve r = R(angle) leans by R' / R there). Exact on the line, and close
 * within a pixel of it, which is all the edge's shading needs.
 */
function distance(r, angle, base, { amp, phase }) {
  const R = 100 * (base + amp * Math.sin(POINTS * angle + phase));
  const slope = 100 * amp * POINTS * Math.cos(POINTS * angle + phase);
  return (Math.abs(r - R) * R) / Math.hypot(R, slope);
}

/** The frame's pixels, top row first, as how much of each the drawing covers (0 to 1). */
export function coverage({ size, drawing, stroke }) {
  const { base, lines, fill = false, hole = 0 } = DRAWINGS[drawing];
  const half = (stroke / 2) * (200 / size);
  const inside = fill
    ? (r, angle) => r >= hole && r <= 100 * (base + lines[0].amp * Math.sin(POINTS * angle + lines[0].phase))
    : (r, angle) => lines.some((line) => distance(r, angle, base, line) <= half);
  const out = new Float64Array(size * size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let hits = 0;
      for (let sy = 0; sy < SAMPLES; sy += 1) {
        for (let sx = 0; sx < SAMPLES; sx += 1) {
          const dx = ((x + (sx + 0.5) / SAMPLES) * 200) / size - 100;
          const dy = ((y + (sy + 0.5) / SAMPLES) * 200) / size - 100;
          const r = Math.hypot(dx, dy);
          const angle = Math.atan2(dy, dx);
          if (inside(r, angle)) hits += 1;
        }
      }
      out[y * size + x] = hits / (SAMPLES * SAMPLES);
    }
  }
  return out;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/**
 * A frame's pixels as a PNG holds them before compression: each row a filter byte (0, none) then red, green, blue and
 * alpha per pixel, the icon's colour everywhere and its cover as the alpha (straight, not premultiplied, as PNG wants).
 */
export function rawRows(frame) {
  const { size } = frame;
  const cover = coverage(frame);
  const rows = Buffer.alloc(size * (1 + size * 4));
  for (let y = 0; y < size; y += 1) {
    const row = y * (1 + size * 4);
    rows[row] = 0;
    for (let x = 0; x < size; x += 1) {
      const at = row + 1 + x * 4;
      const alpha = Math.round((cover[y * size + x] ?? 0) * 255);
      rows[at] = alpha === 0 ? 0 : COLOUR[0];
      rows[at + 1] = alpha === 0 ? 0 : COLOUR[1];
      rows[at + 2] = alpha === 0 ? 0 : COLOUR[2];
      rows[at + 3] = alpha;
    }
  }
  return rows;
}

/** A frame as a PNG file. */
export function png(frame) {
  const { size } = frame;
  const rows = rawRows(frame);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bits per channel
  header[9] = 6; // red, green, blue and alpha
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** The .ico: every frame as a PNG inside it (Windows reads PNG frames since Vista), smallest first. */
export function ico(frames = FRAMES) {
  const images = frames.map(png);
  const head = Buffer.alloc(6 + 16 * frames.length);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2); // an icon
  head.writeUInt16LE(frames.length, 4);
  let offset = head.length;
  frames.forEach(({ size }, i) => {
    const at = 6 + 16 * i;
    head[at] = size >= 256 ? 0 : size; // 0 means 256
    head[at + 1] = size >= 256 ? 0 : size;
    head.writeUInt16LE(1, at + 4); // colour planes
    head.writeUInt16LE(32, at + 6); // bits per pixel
    head.writeUInt32LE(images[i].length, at + 8);
    head.writeUInt32LE(offset, at + 12);
    offset += images[i].length;
  });
  return Buffer.concat([head, ...images]);
}

/** What the files should hold: the icon and the large picture. */
export function files() {
  return { "icon.ico": ico(), "icon.png": png(PNG_FRAME) };
}

/** A PNG file's size and its rows before compression (the IDAT chunks joined, then inflated). */
export function readPng(bytes) {
  if (!bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return undefined;
  const parts = [];
  let size = 0;
  for (let at = 8; at + 8 <= bytes.length; ) {
    const length = bytes.readUInt32BE(at);
    const type = bytes.toString("ascii", at + 4, at + 8);
    if (type === "IHDR") size = bytes.readUInt32BE(at + 8);
    if (type === "IDAT") parts.push(bytes.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  return { size, rows: inflateSync(Buffer.concat(parts)) };
}

/** The .ico file's frames: the size each lists (0 for 256) and its PNG's bytes, in the file's order. */
export function icoFrames(bytes) {
  return Array.from({ length: bytes.readUInt16LE(4) }, (_, i) => {
    const at = 6 + 16 * i;
    const length = bytes.readUInt32LE(at + 8);
    const offset = bytes.readUInt32LE(at + 12);
    return { listed: bytes[at], png: bytes.subarray(offset, offset + length) };
  });
}

/** Why one PNG is not the frame the script draws, or undefined when it is. */
export function frameProblem(bytes, frame) {
  const read = readPng(bytes);
  if (read === undefined || read.size !== frame.size) return `not a ${String(frame.size)} px PNG`;
  if (!read.rows.equals(rawRows(frame))) return "its pixels differ from the drawing";
  return undefined;
}

/**
 * Why the committed files are not what the script draws, one line a problem, or none. The pixels are compared, not the
 * compressed bytes: zlib's output may differ between Node builds and processors while the picture is the same.
 */
export function problems(icoBytes, pngBytes) {
  const found = [];
  const same = (bytes, frame, name) => {
    const problem = frameProblem(bytes, frame);
    if (problem !== undefined) found.push(`${name}: ${problem}`);
  };
  const frames = icoFrames(icoBytes);
  if (icoBytes.readUInt16LE(2) !== 1 || frames.length !== FRAMES.length) {
    found.push(`icon.ico: ${String(frames.length)} frames, ${String(FRAMES.length)} drawn`);
  } else {
    FRAMES.forEach((frame, i) => {
      const listed = frame.size >= 256 ? 0 : frame.size;
      if (frames[i].listed !== listed) found.push(`icon.ico frame ${String(i + 1)}: lists ${String(frames[i].listed)}, drawn ${String(listed)}`);
      else same(frames[i].png, frame, `icon.ico ${String(frame.size)} px`);
    });
  }
  same(pngBytes, PNG_FRAME, "icon.png");
  return found;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.includes("--check")) {
    const found = problems(readFileSync(join(ICONS, "icon.ico")), readFileSync(join(ICONS, "icon.png")));
    for (const line of found) console.error(`${line}; run node scripts/make-icon.mjs to remake the icon`);
    if (found.length === 0) console.log("icon.ico and icon.png match the drawing");
    process.exit(found.length === 0 ? 0 : 1);
  }
  const wanted = files();
  for (const [name, bytes] of Object.entries(wanted)) {
    writeFileSync(join(ICONS, name), bytes);
    console.log(`wrote ${name} (${bytes.length} bytes)`);
  }
}
