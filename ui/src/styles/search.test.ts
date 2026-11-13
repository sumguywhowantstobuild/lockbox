// jsdom draws nothing, so the search's focus marks are read from the style sheets. The box's own mark is a line under it
// (a shadow), and a result's is a tint behind it; Windows' high contrast mode removes shadows and backgrounds, so each
// needs an outline of a system colour there.
import { expect, test } from "vitest";
import { readBeside } from "../testing/files";

const CONTRAST = readBeside(import.meta.url, "./high-contrast.css").replace(/\/\*[\s\S]*?\*\//g, "");

/** The declarations of the rules inside the `forced-colors: active` block whose selector list holds `selector`. */
function forced(selector: string): string[] {
  const block = /@media \(forced-colors: active\) \{([\s\S]*)\}\s*$/.exec(CONTRAST)?.[1] ?? "";
  const found: string[] = [];
  for (const rule of block.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = (rule[1] ?? "").split(",").map((part) => part.trim());
    if (selectors.includes(selector)) found.push((rule[2] ?? "").replace(/\s+/g, " "));
  }
  return found;
}

test("the_search_boxs_focus_mark_survives_high_contrast", () => {
  const box = forced(".app .stop:focus-within").join(" ");
  expect(box, "the box has a high-contrast focus rule").toMatch(/outline: 2px solid (Highlight|CanvasText)/);
});

test("a_result_with_focus_or_the_pointer_shows_in_high_contrast", () => {
  for (const selector of [".app .res:hover", ".app .res:focus-within"]) {
    expect(forced(selector).join(" "), selector).toMatch(/outline: 2px solid (Highlight|CanvasText)/);
  }
});
