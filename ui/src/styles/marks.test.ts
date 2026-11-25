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
  // The patterns stay white lines: the app's colour is the small mark's alone.
  expect(declarationsFor(".rose path")).toMatch(/stroke: var\(--field-ink\)/);
  // ...and a contrast theme's text colour instead, like every other mark drawn in a fixed colour.
  const forced = HIGH_CONTRAST.slice(HIGH_CONTRAST.indexOf("@media (forced-colors: active)"));
  const rule = /\.app :is\(([^)]*)\) path\s*\{([^}]*)\}/.exec(forced);
  const marks = (rule?.[1] ?? "").split(",").map((each) => each.trim());
  expect(marks).toContain(".appmark");
  expect(marks).toContain(".rose");
  expect(rule?.[2] ?? "").toMatch(/stroke: CanvasText !important/);
});
