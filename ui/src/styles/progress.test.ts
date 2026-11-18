// The progress bar's colours are measured in `tokens.contrast.test.ts` (fill = the text colour, track = 10 per cent of it, on the card);
// this holds the style sheets to what was measured, and gives Windows' high contrast mode a bar it can see: the track gets an edge and
// the fill takes the system's highlight, since both are only colours otherwise and the forced palette would erase their difference.
import { expect, test } from "vitest";
import { readBeside } from "../testing/files";

const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");
const COMPONENTS = strip(readBeside(import.meta.url, "./components.css"));
const HIGH_CONTRAST = strip(readBeside(import.meta.url, "./high-contrast.css"));

function declarations(css: string, selector: string): string {
  const found: string[] = [];
  for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if ((rule[1] ?? "").split(",").some((part) => part.trim() === selector)) found.push((rule[2] ?? "").replace(/\s+/g, " "));
  }
  return found.join(" ");
}

test("the_bars_colours_are_the_ones_the_contrast_test_measured", () => {
  expect(declarations(COMPONENTS, ".prog")).toMatch(/background:\s*rgba\(var\(--sh\),\s*0?\.1\)/);
  expect(declarations(COMPONENTS, ".prog span")).toMatch(/background:\s*var\(--ink\)/);
  // The fill grows by the width script sets, and may not animate past what is true.
  expect(declarations(COMPONENTS, ".prog")).toMatch(/overflow:\s*hidden/);
});

test("the_bar_is_visible_in_high_contrast", () => {
  expect(HIGH_CONTRAST).toMatch(/\.app \.prog\b[^{]*\{[^}]*border:\s*1px solid CanvasText/);
  expect(HIGH_CONTRAST).toMatch(/\.app \.prog span\s*\{[^}]*forced-color-adjust:\s*none[^}]*background:\s*Highlight/);
});
