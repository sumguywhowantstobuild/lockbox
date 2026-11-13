// Found at stage 7 (Ariel, 2026-11-13): opening Settings, the Generator or an Add form threw the list about 390px to the
// left and slid it back. Each of them moves focus into the panel as it opens, while the panel still starts off the right
// edge, and the browser scrolled the clipped window and right side sideways to show the focused control. `overflow: clip`
// cuts off the same overflow but leaves no box to scroll, so no focus, now or in a later panel, can move the screen.
// jsdom draws nothing, so the rule is read from the style sheet.
import { expect, test } from "vitest";
import { readBeside } from "../testing/files";

const SHEETS = ["./components.css", "./short-window.css", "./high-contrast.css"].map((path) =>
  readBeside(import.meta.url, path).replace(/\/\*[\s\S]*?\*\//g, ""),
);

/** The declarations of every rule, in every sheet, whose selector list holds exactly `selector`. */
function rulesFor(selector: string): string[] {
  const found: string[] = [];
  for (const sheet of SHEETS) {
    for (const rule of sheet.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if ((rule[1] ?? "").split(",").some((part) => part.trim() === selector)) found.push((rule[2] ?? "").replace(/\s+/g, " "));
    }
  }
  return found;
}

// Found at stage 7 (Ariel, 2026-11-13): at 0.28s the panel read as a snap, since --ease (Vaul's curve, which Vaul runs over
// 0.5s) does most of its travel at the start. One --slide time, 0.4s, for the panel and the list that makes room for it,
// so the two always move together.
test("the_panel_and_the_list_beside_it_slide_together_over_0.4s", () => {
  const base = readBeside(import.meta.url, "./base.css").replace(/\/\*[\s\S]*?\*\//g, "");
  expect(base).toMatch(/--slide: 0\.4s;/);
  expect(rulesFor(".panel").join(" ")).toMatch(/animation: slide var\(--slide\) var\(--ease\) both/);
  expect(rulesFor(".lscroll").join(" ")).toMatch(/transition: right var\(--slide\) var\(--ease\)/);
});

test.each([".win", ".stage"])("%s_clips_the_sliding_panel_without_being_scrollable", (selector) => {
  const rules = rulesFor(selector);
  expect(rules.length, `${selector} has a rule`).toBeGreaterThan(0);
  expect(rules.join(" ")).toMatch(/overflow: clip/);
  for (const rule of rules) expect(rule, `${selector} never goes back to a scrollable overflow`).not.toMatch(/overflow(-x)?: (hidden|auto|scroll)/);
});
