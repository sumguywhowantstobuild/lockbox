// jsdom draws nothing, so where a message sits and how its words sit in it are read from the style sheet (found on the real window
// in Plan 4A's by-eye check: "Saved" sat off-centre in its box, and a message moved with the item panel, so it landed in a different
// place after each save or delete; Ariel chose one fixed place, the bottom centre of the window).
import { expect, test } from "vitest";
import { readBeside } from "../testing/files";

const COMPONENTS = readBeside(import.meta.url, "./components.css").replace(/\/\*[\s\S]*?\*\//g, "");

function declarationsFor(selector: string): string {
  for (const rule of COMPONENTS.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if ((rule[1] ?? "").split(",").some((part) => part.trim() === selector)) return (rule[2] ?? "").replace(/\s+/g, " ");
  }
  throw new Error(`${selector} has no rule in components.css`);
}

test("a_message_has_the_same_room_on_both_sides", () => {
  // Words alone ("Saved", a copy's countdown) sit in the middle of their box.
  expect(declarationsFor(".toast")).toMatch(/padding: 9px 16px;/);
  // A message with a button keeps the button as near the edge as drawn.
  expect(declarationsFor(".toast > .tb2:last-child")).toMatch(/margin-right: -6px/);
});

test("a_message_always_sits_at_the_bottom_centre_of_the_window", () => {
  // One place: the middle of what holds it (the window, MainWindow.test), whatever is open.
  const stack = declarationsFor(".tstack");
  expect(stack).toMatch(/left: 50%;/);
  expect(stack).toMatch(/transform: translateX\(-50%\)/);
  expect(stack).not.toMatch(/transition/);
  // Nothing moves it when an item or a tool opens.
  expect(COMPONENTS).not.toMatch(/\.open[^{}]*\.tstack/);
  // Never so wide that it reaches the side menu, even on the smallest window (960px, the menu 212px at most beside it).
  expect(stack).toMatch(/max-width: min\(540px, calc\(100% - 44px\)\)/);
});

test("a_message_sits_above_the_list_and_panel_but_under_search_menus_and_dialogs", () => {
  // Above the panel (10) and the toolbar (12); under the scrim of dialogs and search (40), the search palette (41) and the floating
  // menus and lists (`.layer`, 50), so it never covers a result or takes a click meant for them.
  const z = (selector: string) => Number(/z-index: (\d+)/.exec(declarationsFor(selector))?.[1]);
  const stack = z(".tstack");
  expect(Number.isFinite(stack)).toBe(true);
  for (const below of [".panel", ".tb"]) expect(stack, below).toBeGreaterThan(z(below));
  for (const above of [".scrim", ".pal", ".layer"]) expect(stack, above).toBeLessThan(z(above));
});
