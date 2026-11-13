// Found at stage 7 (2026-11-13, the group 1 walk): at the default window, 1280 by 800, the recovery key screens (21c,
// 21d's wrong pick, 21f) were about 90px taller than the window, so Continue started out of sight. The tighter spacing
// only began under 700px. Now the right side's space shrinks with the window's height, down to a floor, and the key's
// rows sit closer under 880px. jsdom draws nothing, so the rules are read from the style sheets; the release build was
// measured by hand.
import { expect, test } from "vitest";
import { readBeside } from "../testing/files";

const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");
const components = strip(readBeside(import.meta.url, "./components.css"));
const short = strip(readBeside(import.meta.url, "./short-window.css"));

/** The declarations of the first top-level rule whose selector list holds exactly `selector`. */
function topRule(sheet: string, selector: string): string {
  let depth = 0;
  let start = 0;
  for (let i = 0; i < sheet.length; i++) {
    const ch = sheet[i];
    if (ch === "{") {
      if (depth === 0) {
        const head = sheet.slice(start, i);
        if (head.split(",").some((part) => part.trim() === selector)) {
          const end = sheet.indexOf("}", i);
          return sheet.slice(i + 1, end).replace(/\s+/g, " ");
        }
      }
      depth++;
    } else if (ch === "}") {
      depth--;
      start = i + 1;
    } else if (ch === ";" && depth === 0) start = i + 1;
  }
  return "";
}

/** The body of the `@media (max-height: <px>px)` block. */
function heightBlock(sheet: string, px: number): string {
  const at = sheet.indexOf(`@media (max-height: ${String(px)}px)`);
  if (at < 0) return "";
  let depth = 0;
  for (let i = sheet.indexOf("{", at); i < sheet.length; i++) {
    if (sheet[i] === "{") depth++;
    else if (sheet[i] === "}" && --depth === 0) return sheet.slice(sheet.indexOf("{", at) + 1, i);
  }
  return "";
}

/** A `clamp(<min>px, <a>vh <+|-> <b>px, <max>px)` from a declaration, worked out for a page `height` px high. */
function clampAt(declaration: string, height: number): number {
  const m = /clamp\((\d+)px, ([\d.]+)vh ([+-]) (\d+)px, (\d+)px\)/.exec(declaration);
  if (m === null) throw new Error(`no clamp(min, a vh ± b, max) in: ${declaration}`);
  const [min, a, sign, b, max] = [Number(m[1]), Number(m[2]), m[3], Number(m[4]), Number(m[5])];
  const middle = (a * height) / 100 + (sign === "+" ? b : -b);
  return Math.min(max, Math.max(min, middle));
}

const near = (value: number, expected: number) => Math.abs(value - expected) < 1;

test("the_right_side_keeps_its_full_space_on_a_tall_window_and_gives_it_back_on_a_shorter_one", () => {
  const padding = topRule(components, ".plate");
  expect(padding).toMatch(/padding: clamp\([^;]*\) 48px;/);
  // The default window's page (1280 by 800 at 125%) is 763px high; the 700px rules take over at 20px.
  expect(clampAt(padding, 1200)).toBe(56);
  expect(clampAt(padding, 915)).toBe(56);
  expect(near(clampAt(padding, 763), 24)).toBe(true);
  expect(clampAt(padding, 700)).toBe(20);
});

test("the_steps_gaps_shrink_with_the_window_down_to_10px", () => {
  for (const selector of [".fu", ".fu-print"]) {
    const gap = topRule(components, selector);
    expect(gap).toMatch(/gap: clamp\(/);
    expect(clampAt(gap, 900), selector).toBe(14);
    expect(clampAt(gap, 763), selector).toBe(10);
  }
});

test("the_880px_block_comes_before_the_700px_one_so_the_smallest_windows_keep_the_tighter_rules", () => {
  const at880 = short.indexOf("@media (max-height: 880px)");
  const at700 = short.indexOf("@media (max-height: 700px)");
  expect(at880).toBeGreaterThanOrEqual(0);
  expect(at880).toBeLessThan(at700);
});

test("the_keys_rows_sit_closer_under_880px_so_continue_shows_at_1280_by_800", () => {
  const block = heightBlock(short, 880);
  expect(block, "a max-height: 880px block").not.toBe("");
  const key = topRule(block, ".fu-key");
  expect(key).toMatch(/font-size: 15px;/);
  expect(key).toMatch(/line-height: 1\.4;/);
});
