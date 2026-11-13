// Buttons as the approved screens draw them (2b, 13b, 13d, 10b, 14d, 15b): a dangerous answer in a question is a filled red
// button (focus still starts on Cancel), Move to trash and the Trash's two answers are full-width rows of a card, and a
// picked choice is a filled pill, not a ring that looks like keyboard focus.
import { expect, test } from "vitest";
import { readBeside } from "../testing/files";

const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");
const COMPONENTS = strip(readBeside(import.meta.url, "./components.css"));
const HIGH_CONTRAST = strip(readBeside(import.meta.url, "./high-contrast.css"));

function declarationsFor(css: string, selector: string): string {
  for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if ((rule[1] ?? "").split(",").some((part) => part.trim() === selector)) return (rule[2] ?? "").replace(/\s+/g, " ");
  }
  throw new Error(`${selector} has no rule`);
}

test("a_dangerous_answer_is_a_filled_red_button", () => {
  const fill = declarationsFor(COMPONENTS, ".pill.dfill");
  expect(fill).toMatch(/background: var\(--danger-fill\)/);
  expect(fill).toMatch(/color: var\(--danger-fill-ink\)/);
});

test("move_to_trash_and_the_trash_answers_are_rows_of_a_card", () => {
  const row = declarationsFor(COMPONENTS, ".dgr");
  expect(row).toMatch(/width: 100%/);
  expect(row).toMatch(/height: 44px/);
  expect(row).toMatch(/color: var\(--danger\)/);
  expect(declarationsFor(COMPONENTS, ".dgr.calm")).toMatch(/color: var\(--v\)/);
  // The second row of the card has a line above it and square top corners.
  expect(declarationsFor(COMPONENTS, ".dgr + .dgr")).toMatch(/box-shadow: inset 0 1px 0 var\(--line\)/);
  expect(declarationsFor(COMPONENTS, ".dcap")).toMatch(/text-align: center/);
});

test("a_picked_choice_is_a_filled_pill_with_an_edge_not_an_accent_ring", () => {
  // Found at stage 7: the picked choice had a 2px ring in the accent, which reads as keyboard focus. Drawn as a filled pill;
  // its thin edge in the quiet text colour keeps the 3 to 1 a state needs against the bar (tokens.contrast.test.ts).
  const picked = declarationsFor(COMPONENTS, '.seg[aria-pressed="true"]');
  expect(picked).toMatch(/background: var\(--card\)/);
  expect(picked).toMatch(/box-shadow: 0 0 0 1px var\(--ink2\)/);
  expect(picked).not.toMatch(/var\(--v\)/);
});

/** The declarations of the high-contrast rule whose `:is(...)` list names `part`. */
function highContrastRuleNaming(part: string): string {
  for (const rule of HIGH_CONTRAST.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const list = /:is\(([^)]*)\)\s*$/.exec((rule[1] ?? "").trim())?.[1] ?? "";
    if (list.split(",").some((one) => one.trim() === part)) return (rule[2] ?? "").replace(/\s+/g, " ");
  }
  throw new Error(`no high-contrast rule names ${part}`);
}

test("in_high_contrast_the_filled_answer_stands_out_and_card_rows_have_one_line_between", () => {
  // The dangerous answer takes the main button's fill, so it never looks like Cancel beside it.
  expect(highContrastRuleNaming(".pill.dfill")).toMatch(/background: ButtonText/);
  // The card's rows sit inside the card's own edge: a line between two rows, never a box round each.
  expect(() => highContrastRuleNaming(".dgr")).toThrow();
  expect(declarationsFor(HIGH_CONTRAST, ".app .dgr + .dgr")).toMatch(/border-top: 1px solid CanvasText/);
});

test("a_card_rows_focus_ring_stays_inside_it", () => {
  expect(declarationsFor(COMPONENTS, ".dgr:focus-visible")).toMatch(/outline-offset: -2px/);
});
