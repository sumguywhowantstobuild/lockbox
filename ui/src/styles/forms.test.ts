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

test("the_recovery_key_sits_in_a_soft_grey_box_as_drawn", () => {
  // Found at stage 7 (21c): the key was in a white box with a dark edge; drawn as a soft grey box with a hairline round it.
  const box = declarationsFor(".fu-key");
  expect(box).toMatch(/background: var\(--well\);/);
  expect(box).toMatch(/box-shadow: inset 0 0 0 1px var\(--line\);/);
  expect(box).toMatch(/border-radius: 10px;/);
  expect(box).not.toMatch(/border: /);
});

test("a_list_in_a_settings_row_is_filled_with_no_edge_at_its_own_width_as_drawn", () => {
  // As 31a draws it: filled with the quiet pill's shade, no edge, as wide as its words. The review found the older outlined
  // rule for the row's wrapper still reaching the list and winning, so that rule is gone and the list has its own class.
  const list = declarationsFor(".ssort.sfill");
  expect(list).toMatch(/background: rgba\(var\(--sh\), 0\.07\);/);
  expect(list).toMatch(/box-shadow: none;/);
  expect(list).toMatch(/width: auto;/);
  expect(() => declarationsFor(".ssel .ssort")).toThrow();
  expect(declarationsFor(".ssel")).not.toMatch(/width:/);
});

test("a_settings_row_too_narrow_for_its_keys_puts_them_under_its_words", () => {
  // Found at stage 7 at 1093 by 534: the save shortcut's words were squeezed into a column about 85px wide beside the key
  // and its pill. The words keep a floor, so in a narrow panel the key and pill drop to the line under them, at the right.
  expect(declarationsFor(".swords:has(+ .skeys)")).toMatch(/flex: 1 1 112px;/);
  expect(declarationsFor(".skeys")).toMatch(/margin-left: auto;/);
});
