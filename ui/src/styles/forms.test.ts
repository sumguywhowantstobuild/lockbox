// jsdom draws nothing, so a form row's spacing is read from the style sheet (found on the real window in Plan 4A's by-eye check:
// the Password row lined its label and Generate up by their feet with no gap, so the pill sat on the box below it).
import { expect, test } from "vitest";
import { readBeside } from "../testing/files";

const COMPONENTS = readBeside(import.meta.url, "./components.css").replace(/\/\*[\s\S]*?\*\//g, "");

function declarationsFor(selector: string): string {
  for (const rule of COMPONENTS.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if ((rule[1] ?? "").split(",").some((part) => part.trim() === selector)) return (rule[2] ?? "").replace(/\s+/g, " ");
  }
  throw new Error(`${selector} has no rule in components.css`);
}

test("a_label_with_a_button_beside_it_sits_as_drawn_above_its_box", () => {
  // As 6b and 11a draw it: the label and its button centred on one row, 5px above the box.
  const row = declarationsFor(".flrow");
  expect(row).toMatch(/align-items: center;/);
  expect(row).toMatch(/margin: 6px 0 5px;/);
  expect(declarationsFor(".flrow .flab")).toMatch(/margin: 0 0 0 2px;/);
});
