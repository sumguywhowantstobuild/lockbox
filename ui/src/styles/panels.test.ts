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

test.each([".win", ".stage", ".boxlayer"])("%s_clips_the_sliding_panel_without_being_scrollable", (selector) => {
  const rules = rulesFor(selector);
  expect(rules.length, `${selector} has a rule`).toBeGreaterThan(0);
  expect(rules.join(" ")).toMatch(/overflow: clip/);
  for (const rule of rules) expect(rule, `${selector} never goes back to a scrollable overflow`).not.toMatch(/overflow(-x)?: (hidden|auto|scroll)/);
});

// The save box is the app's, drawn over whichever window is on screen (Plan 4C Task 10). Its panel has the width the window's own panels have, so
// `--pw` is on `.app` (which holds both), the 1000px override is on `.app` too, and the layer lets a click through everywhere but the panel.
test("the_panel_width_is_one_for_the_window_and_the_box_over_it", () => {
  const base = readBeside(import.meta.url, "./base.css").replace(/\/\*[\s\S]*?\*\//g, "");
  const app = [...base.matchAll(/(?:^|\})\s*\.app\s*\{([^{}]*)\}/g)].map((rule) => rule[1] ?? "").join(" ");
  expect(app, "--pw is set on .app").toMatch(/--pw: clamp\(340px, 30vw, 420px\)/);
  expect(rulesFor(".win").join(" "), "not on .win, which would hide it from the box").not.toMatch(/--pw:/);
  const small = rulesFor(".app").filter((rule) => rule.includes("--pw:")).join(" ");
  expect(small, "the 1000px override is on .app").toMatch(/--pw: 320px/);
});

test("the_box_layer_covers_the_app_above_the_window_and_lets_clicks_through", () => {
  const layer = rulesFor(".boxlayer").join(" ");
  expect(layer).toMatch(/position: absolute/);
  expect(layer).toMatch(/inset: 0/);
  expect(layer).toMatch(/z-index: 10/);
  expect(layer).toMatch(/pointer-events: none/);
  expect(rulesFor(".boxlayer > .panel").join(" ")).toMatch(/pointer-events: auto/);
});
