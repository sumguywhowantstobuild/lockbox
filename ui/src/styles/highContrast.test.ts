// Windows high contrast replaces the page's own colours, so a button greyed by colour alone looks live there. Every button the
// style sheet greys while it can't be pressed (`aria-disabled`) is greyed in the high-contrast sheet too, with Windows' own grey.
import { expect, test } from "vitest";
import { readBeside } from "../testing/files";

const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");
const COMPONENTS = strip(readBeside(import.meta.url, "./components.css"));
const HIGH_CONTRAST = strip(readBeside(import.meta.url, "./high-contrast.css"));

/**
 * The class chains (".pill.t") that a rule greys by colour with `[aria-disabled="true"]`, outside hover and active states. A rule
 * that only changes the pointer (the Start with Windows switch, whose hint says why it can't be pressed) greys nothing.
 */
function offButtons(css: string): Set<string> {
  const found = new Set<string>();
  for (const [, selectors = "", body = ""] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!/(^|[\s;])(color|background(-color)?)\s*:/.test(body)) continue;
    for (const selector of selectors.split(",")) {
      const match = /(\.[\w-]+(?:\.[\w-]+)*)\[aria-disabled="true"\]\s*$/.exec(selector.trim());
      if (match?.[1] !== undefined) found.add(match[1]);
    }
  }
  return found;
}

test("every_greyed_button_is_greyed_in_high_contrast", () => {
  const greyed = offButtons(COMPONENTS);
  expect(greyed.size, "the style sheet's greyed buttons were found").toBeGreaterThan(2);
  for (const button of greyed) {
    const rule = new RegExp(String.raw`\.app ${button.replaceAll(".", String.raw`\.`)}\[aria-disabled="true"\][^{]*\{[^}]*color:\s*GrayText`);
    expect(HIGH_CONTRAST, `${button} while it can't be pressed`).toMatch(rule);
  }
});
