// Draws the band at the top of the installer's one screen (Plan 5, Task 9e, design D, "Plain terms") and writes
// crates/petalock-desktop/windows/band.bmp, a 952 x 104 bitmap (twice the 476 x 52 the window shows, so the installer scales
// it down sharply at 100, 125, 150 and 200 %).
//
//   node scripts/make-installer-art.mjs            writes the files (band.bmp and, from Task 9h, sidebar.bmp)
//   node scripts/make-installer-art.mjs --check    exits 1 when a file differs from what the script draws
//
// What it draws, in the design's own units (476 x 52): Petalock's mark (the two crossing lines, 22 px), the engraved logo whole
// and small (47 px across, the app's own rule: twenty-six ribbons of r = 100 (0.62 + a sin(3t + phi)), a = 0.16 + 0.156 i / 25,
// phi = i pi / 26, each ribbon's width swelling with its petal; ui/src/parts/Intaglio.tsx), and the same twenty-six ribbons
// unrolled from a circle of 62 units into a straight band that fades in to the right and runs off the edge. The name "Petalock"
// is not in the picture: the installer paints it as text beside the mark (Segoe UI, so it follows the system's text rendering),
// because no font is rasterised here (no new package).
//
// A pixel's colour is how much of it the drawing covers (nine samples a pixel) blended onto white; the file is written by hand
// (24 bits, bottom-up rows, no compression: what LoadImage reads everywhere). The same input always gives the same bytes.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Petalock's slate blue, as the icon and the page use it. */
export const SLATE = [0x5b, 0x7b, 0xa8];
export const SCALE = 2;
export const WIDTH = 476 * SCALE;
export const HEIGHT = 52 * SCALE;
const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "crates", "petalock-desktop", "windows", "band.bmp");

const SAMPLES = 3;
const LOGO = { cx: 150, cy: 26, unit: 0.235, weight: 1.25 }; // the small logo: centre, px per logo unit, ribbon weight
const MARK = { cx: 11, cy: 26, unit: 22 / 200 }; // the two-line mark, 22 px across
const BAND = { x0: 168, x1: 478, cy: 26, s: 0.633, weight: 1.35, r0: 62 }; // the unrolled ribbons
const FADE = { from: 166, to: 250 }; // the band is clear until x = 166 and solid from x = 250

/** How wide a ribbon is at angle t (its full width, in logo units, before the weight). */
const swell = (t, phase) => 0.18 + 1.05 * Math.pow(0.5 + 0.5 * Math.sin(3 * t + phase), 2.2);

/** Whether a point (in logo units from its centre) lies on one of the logo's ribbons at `weight`. */
function onLogo(dx, dy, weight) {
  const r = Math.hypot(dx, dy);
  if (r > 100) return false;
  const t = Math.atan2(dy, dx);
  for (let i = 0; i < 26; i += 1) {
    const a = 0.16 + (0.156 * i) / 25;
    const phase = (i * Math.PI) / 26;
    const R = 100 * (0.62 + a * Math.sin(3 * t + phase));
    const slope = 100 * a * 3 * Math.cos(3 * t + phase);
    if ((Math.abs(r - R) * R) / Math.hypot(R, slope) <= (weight * swell(t, phase)) / 2) return true;
  }
  return false;
}

/** Whether a point (in mark units from its centre) lies on the mark's two lines (13 units wide). */
function onMark(dx, dy) {
  const r = Math.hypot(dx, dy);
  const t = Math.atan2(dy, dx);
  for (let k = 0; k < 2; k += 1) {
    const phase = k * Math.PI;
    const R = 100 * (0.62 + 0.17 * Math.sin(3 * t + phase));
    const slope = 100 * 0.17 * 3 * Math.cos(3 * t + phase);
    if ((Math.abs(r - R) * R) / Math.hypot(R, slope) <= 6.5) return true;
  }
  return false;
}

/**
 * Whether the point `along` (the distance along the unrolled ribbons, in design pixels) and `across` (the distance across them) lies
 * on one of the twenty-six ribbons unrolled as `r` says ({ x0, x1, cy, s, weight, r0 }: where they start and end along, the centre
 * line across, the scale, the weight and the circle's radius they were unrolled from).
 */
function onRibbons(along, across, r) {
  if (along < r.x0 || along > r.x1) return false;
  const t = (along - r.x0) / (r.r0 * r.s);
  for (let i = 0; i < 26; i += 1) {
    const a = 0.16 + (0.156 * i) / 25;
    const phase = (i * Math.PI) / 26;
    const centre = r.cy - 100 * a * r.s * Math.sin(3 * t + phase);
    const slope = (-300 * a * Math.cos(3 * t + phase)) / r.r0;
    const half = (r.s * r.weight * swell(t, phase)) / 2;
    if (Math.abs(across - centre) / Math.hypot(1, slope) <= half) return true;
  }
  return false;
}

/** How much of the unrolled band is at (x, y) in design pixels: 0 or 1 before the fade, which is applied by the caller. */
function onBand(x, y) {
  return onRibbons(x, y, BAND);
}

/** The picture's pixels, top row first, as how much of each the drawing covers (0 to 1). */
export function coverage() {
  const out = new Float64Array(WIDTH * HEIGHT);
  for (let py = 0; py < HEIGHT; py += 1) {
    for (let px = 0; px < WIDTH; px += 1) {
      let hits = 0;
      for (let sy = 0; sy < SAMPLES; sy += 1) {
        for (let sx = 0; sx < SAMPLES; sx += 1) {
          const x = (px + (sx + 0.5) / SAMPLES) / SCALE;
          const y = (py + (sy + 0.5) / SAMPLES) / SCALE;
          if (onMark((x - MARK.cx) / MARK.unit, (y - MARK.cy) / MARK.unit)) hits += 1;
          else if (Math.abs(x - LOGO.cx) < 25 && Math.abs(y - LOGO.cy) < 25 && onLogo((x - LOGO.cx) / LOGO.unit, (y - LOGO.cy) / LOGO.unit, LOGO.weight)) hits += 1;
          else if (x > FADE.from && onBand(x, y)) hits += Math.min(1, Math.max(0, (x - FADE.from) / (FADE.to - FADE.from)));
        }
      }
      out[py * WIDTH + px] = hits / (SAMPLES * SAMPLES);
    }
  }
  return out;
}

/** A BMP file of `width` x `height` pixels from how much of each the drawing covers: 24 bits, bottom-up rows, slate blue on white. */
function encode(cover, width, height) {
  const rowBytes = width * 3; // both pictures' rows are already a multiple of four bytes (2856 and 984)
  const size = 54 + rowBytes * height;
  const file = Buffer.alloc(size);
  file.write("BM", 0, "latin1");
  file.writeUInt32LE(size, 2);
  file.writeUInt32LE(54, 10);
  file.writeUInt32LE(40, 14);
  file.writeInt32LE(width, 18);
  file.writeInt32LE(height, 22);
  file.writeUInt16LE(1, 26);
  file.writeUInt16LE(24, 28);
  file.writeUInt32LE(0, 30);
  file.writeUInt32LE(rowBytes * height, 34);
  file.writeInt32LE(3780, 38); // 96 dpi
  file.writeInt32LE(3780, 42);
  for (let y = 0; y < height; y += 1) {
    const at = 54 + (height - 1 - y) * rowBytes;
    for (let x = 0; x < width; x += 1) {
      const c = cover[y * width + x];
      file[at + x * 3] = Math.round(255 + (SLATE[2] - 255) * c);
      file[at + x * 3 + 1] = Math.round(255 + (SLATE[1] - 255) * c);
      file[at + x * 3 + 2] = Math.round(255 + (SLATE[0] - 255) * c);
    }
  }
  return file;
}

/** The band's BMP file. */
export function bmp() {
  return encode(coverage(), WIDTH, HEIGHT);
}

/**
 * Why `bytes` is not a `width` x `height` picture like `wanted`, or undefined when it is: the size and depth are read from the header
 * and every colour must be within one step of the drawing's (the same arithmetic gives the same pixels, but a different maths library
 * may round a sine differently in the last place).
 */
function differs(bytes, wanted, width, height) {
  if (bytes.subarray(0, 2).toString("latin1") !== "BM") return "not a BMP file";
  if (bytes.readInt32LE(18) !== width || Math.abs(bytes.readInt32LE(22)) !== height) return `not ${String(width)} x ${String(height)}`;
  if (bytes.readUInt16LE(28) !== 24 || bytes.readUInt32LE(30) !== 0) return "not 24 bits uncompressed";
  if (bytes.length !== wanted.length) return "its length differs from the drawing";
  let worst = 0;
  for (let i = 54; i < bytes.length; i += 1) worst = Math.max(worst, Math.abs(bytes[i] - wanted[i]));
  return worst > 1 ? `its pixels differ from the drawing (by up to ${String(worst)} of 255)` : undefined;
}

/** Why `bytes` is not the band the script draws, or undefined when it is. */
export function problem(bytes, wanted = bmp()) {
  return differs(bytes, wanted, WIDTH, HEIGHT);
}

// ---------------------------------------------------------------------------------------------------------------------
// The sidebar of the uninstaller's finish page (Plan 5, Task 9h). NSIS's stock page shows a blue "computer" picture there. This one
// is 164 x 314 design pixels at twice the size (328 x 628): the page stretches it to its control, whose size follows the window's
// scale. The same engraved artwork as the band: the logo whole, then its twenty-six ribbons unrolled and running down the page,
// fading in under the logo and off the bottom edge, slate blue on white.
// ---------------------------------------------------------------------------------------------------------------------
export const SIDEBAR_WIDTH = 164 * SCALE;
export const SIDEBAR_HEIGHT = 314 * SCALE;
const SIDEBAR_OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "crates", "petalock-desktop", "windows", "sidebar.bmp");
// the logo whole (100 px across, its ribbons as fine as the band's logo's) and the unrolled ribbons: along the page from y 132, across it
// about the page's middle (x 82), a circle of 62 units unrolled at one pixel a unit
const SIDE_LOGO = { cx: 82, cy: 72, unit: 0.5, weight: 0.6 };
const SIDE_RIBBONS = { x0: 132, x1: 330, cy: 82, s: 1, weight: 1.35, r0: 62 };
const SIDE_FADE = { from: 132, to: 214 };

/** The sidebar's pixels, top row first, as how much of each the drawing covers (0 to 1). */
export function sidebarCoverage() {
  const out = new Float64Array(SIDEBAR_WIDTH * SIDEBAR_HEIGHT);
  for (let py = 0; py < SIDEBAR_HEIGHT; py += 1) {
    for (let px = 0; px < SIDEBAR_WIDTH; px += 1) {
      let hits = 0;
      for (let sy = 0; sy < SAMPLES; sy += 1) {
        for (let sx = 0; sx < SAMPLES; sx += 1) {
          const x = (px + (sx + 0.5) / SAMPLES) / SCALE;
          const y = (py + (sy + 0.5) / SAMPLES) / SCALE;
          if (Math.abs(x - SIDE_LOGO.cx) < 51 && Math.abs(y - SIDE_LOGO.cy) < 51 && onLogo((x - SIDE_LOGO.cx) / SIDE_LOGO.unit, (y - SIDE_LOGO.cy) / SIDE_LOGO.unit, SIDE_LOGO.weight)) hits += 1;
          else if (y > SIDE_FADE.from && onRibbons(y, x, SIDE_RIBBONS)) hits += Math.min(1, Math.max(0, (y - SIDE_FADE.from) / (SIDE_FADE.to - SIDE_FADE.from)));
        }
      }
      out[py * SIDEBAR_WIDTH + px] = hits / (SAMPLES * SAMPLES);
    }
  }
  return out;
}

/** The sidebar's BMP file. */
export function sidebarBmp() {
  return encode(sidebarCoverage(), SIDEBAR_WIDTH, SIDEBAR_HEIGHT);
}

/** Why `bytes` is not the sidebar the script draws, or undefined when it is. */
export function sidebarProblem(bytes, wanted = sidebarBmp()) {
  return differs(bytes, wanted, SIDEBAR_WIDTH, SIDEBAR_HEIGHT);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.includes("--check")) {
    const found = [
      ["band.bmp", problem(readFileSync(OUT))],
      ["sidebar.bmp", sidebarProblem(readFileSync(SIDEBAR_OUT))],
    ];
    for (const [name, why] of found) {
      if (why !== undefined) console.error(`${name}: ${why}; run node scripts/make-installer-art.mjs to remake it`);
      else console.log(`${name} matches the drawing`);
    }
    process.exit(found.every(([, why]) => why === undefined) ? 0 : 1);
  }
  const bytes = bmp();
  writeFileSync(OUT, bytes);
  console.log(`wrote band.bmp (${String(bytes.length)} bytes)`);
  const side = sidebarBmp();
  writeFileSync(SIDEBAR_OUT, side);
  console.log(`wrote sidebar.bmp (${String(side.length)} bytes)`);
}
