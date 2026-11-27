// The small vault mark (36px, beside each vault on the lock screen): it takes its vault's colour and a line about a pixel
// and a half thick. The drawing is 200 units wide, so at 36px one pixel is 200 / 36 units.
import { expect, test } from "vitest";
import { readBeside } from "../testing/files";

const COMPONENTS = readBeside(import.meta.url, "./components.css").replace(/\/\*[\s\S]*?\*\//g, "");
const HIGH_CONTRAST = readBeside(import.meta.url, "./high-contrast.css").replace(/\/\*[\s\S]*?\*\//g, "");

function declarationsFor(selector: string): string {
  for (const rule of COMPONENTS.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if ((rule[1] ?? "").split(",").some((part) => part.trim() === selector)) return (rule[2] ?? "").replace(/\s+/g, " ");
  }
  throw new Error(`${selector} has no rule in components.css`);
}

test("the_small_mark_takes_its_vaults_colour_and_a_line_of_about_a_pixel_and_a_half", () => {
  const mark = declarationsFor(".vmini path");
  expect(mark).toMatch(/stroke: var\(--v\)/);
  const width = Number(/stroke-width: ([\d.]+)/.exec(mark)?.[1]);
  const pixels = (width * 36) / 200;
  expect(pixels).toBeGreaterThan(1.3);
  expect(pixels).toBeLessThan(1.8);
});

test("app_mark_has_a_contrast_colour", () => {
  // The app's three petals take the app's slate blue on the dark side, about a pixel and a half thick at 24px...
  const mark = declarationsFor(".appmark path");
  expect(mark).toMatch(/stroke: var\(--field-mark\)/);
  const pixels = (Number(/stroke-width: ([\d.]+)/.exec(mark)?.[1]) * 24) / 200;
  expect(pixels).toBeGreaterThan(1.3);
  expect(pixels).toBeLessThan(1.8);
  expect(declarationsFor(".appmark")).toMatch(/width: 24px/);
  // ...and a contrast theme's text colour instead, like every other mark drawn in a fixed colour.
  const rule = /\.app :is\(([^)]*)\) path\s*\{([^}]*)\}/.exec(FORCED);
  const marks = (rule?.[1] ?? "").split(",").map((each) => each.trim());
  expect(marks).toContain(".appmark");
  expect(rule?.[2] ?? "").toMatch(/stroke: CanvasText !important/);
});

const FORCED = HIGH_CONTRAST.slice(HIGH_CONTRAST.indexOf("@media (forced-colors: active)"));

/** The declarations of the rule for `selector` inside the contrast theme's block. */
function forcedDeclarationsFor(selector: string): string {
  for (const rule of FORCED.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if ((rule[1] ?? "").split(",").some((part) => part.trim() === selector)) return (rule[2] ?? "").replace(/\s+/g, " ");
  }
  throw new Error(`${selector} has no rule in high-contrast.css's forced-colors block`);
}

test("the_engraved_logo_is_filled_white_at_half_strength_and_a_contrast_theme_fills_it_in_its_text_colour", () => {
  // Plan 5 Task 9b: the large picture is filled ribbons, not lines, in the dark side's white at half strength, in the old
  // pattern's place and size (760px, 120 past the right edge and 140 past the bottom).
  const picture = declarationsFor(".rose");
  expect(picture).toMatch(/width: 760px/);
  expect(picture).toMatch(/height: 760px/);
  expect(picture).toMatch(/right: -120px/);
  expect(picture).toMatch(/bottom: -140px/);
  expect(picture).toMatch(/opacity: 0\.5/);
  const ribbons = declarationsFor(".rose path");
  expect(ribbons).toMatch(/fill: var\(--field-ink\)/);
  expect(ribbons).toMatch(/stroke: none/);
  // The app's colour stays the small mark's alone.
  expect(ribbons).not.toMatch(/--field-mark/);
  // A contrast theme fills it in its text colour, and draws no stroke round the ribbons.
  const forced = forcedDeclarationsFor(".app .rose path");
  expect(forced).toMatch(/fill: CanvasText !important/);
  expect(forced).toMatch(/stroke: none !important/);
  const strokeRule = /\.app :is\(([^)]*)\) path\s*\{([^}]*)\}/.exec(FORCED);
  expect((strokeRule?.[1] ?? "").split(",").map((each) => each.trim())).not.toContain(".rose");
});

test("the_dark_sides_words_sit_on_a_soft_patch_and_a_contrast_theme_keeps_the_box_without_the_fade", () => {
  // The words ("Your items stay encrypted…" and each step's line) on a patch of the side's own colour, its edge faded by a
  // 28px blur, so no engraved line crosses a letter; a contrast theme drops the fade (Windows removes shadows there anyway)
  // and keeps the filled box in its own background colour.
  const say = declarationsFor(".say");
  expect(say).toMatch(/background: var\(--field\)/);
  expect(say).toMatch(/box-shadow: 0 0 28px 22px var\(--field\)/);
  const forced = forcedDeclarationsFor(".app .say");
  expect(forced).toMatch(/box-shadow: none !important/);
  expect(forced).toMatch(/background: Canvas !important/);
});
