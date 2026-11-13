// jsdom draws nothing, so a menu's room is read from the style sheet. A menu can hold more than the window (Move lists every
// folder, and the smallest window is 534px tall): it is never taller than the room Base UI says it has, and scrolls inside it,
// so the last choice can still be reached, by keyboard too.
import { expect, test } from "vitest";
import { readBeside } from "../testing/files";

const COMPONENTS = readBeside(import.meta.url, "./components.css").replace(/\/\*[\s\S]*?\*\//g, "");

function declarationsFor(selector: string): string {
  for (const rule of COMPONENTS.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if ((rule[1] ?? "").split(",").some((part) => part.trim() === selector)) return (rule[2] ?? "").replace(/\s+/g, " ");
  }
  throw new Error(`${selector} has no rule in components.css`);
}

test("a_menu_taller_than_the_window_scrolls_inside_the_room_it_has", () => {
  const menu = declarationsFor(".menu");
  expect(menu).toMatch(/max-height: var\(--available-height/);
  expect(menu).toMatch(/overflow-y: auto/);
});
