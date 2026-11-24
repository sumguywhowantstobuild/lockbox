// Windows high contrast replaces the page's own colours, so a button greyed by colour alone looks live there. Every button the
// style sheet greys while it can't be pressed (`aria-disabled`) is greyed in the high-contrast sheet too, with Windows' own grey.
import { expect, test } from "vitest";
import { listBelow, readBeside } from "../testing/files";

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

/** The classes the screens give the words of an error (`err`, `ferr`), read from every `.tsx` file's class names. */
function errorClasses(): Set<string> {
  const found = new Set<string>();
  for (const path of listBelow(import.meta.url, "../").filter((each) => each.endsWith(".tsx") && !each.endsWith(".test.tsx"))) {
    const source = readBeside(import.meta.url, `../${path}`);
    for (const [, classes = ""] of source.matchAll(/className="([^"]*)"/g)) {
      for (const name of classes.split(/\s+/)) if (name === "err" || name === "ferr") found.add(name);
    }
  }
  return found;
}

test("errors_in_high_contrast_are_marked_beyond_position", () => {
  const classes = errorClasses();
  expect([...classes].sort(), "the screens' error classes were found").toEqual(["err", "ferr"]);
  const rule = /\.app :is\(([^)]*)\):not\(:empty\)::before\s*\{([^}]*)\}/.exec(HIGH_CONTRAST);
  expect(rule, "a mark goes before an error's words in high contrast").not.toBeNull();
  // Only in high contrast: the rule sits inside the sheet's one forced-colors block (the normal look has the red).
  const block = HIGH_CONTRAST.indexOf("@media (forced-colors: active)");
  expect(block, "the forced-colors block").toBeGreaterThan(-1);
  expect(HIGH_CONTRAST.indexOf("@media", block + 1), "one block, holding every rule after it").toBe(-1);
  expect(rule?.index ?? -1).toBeGreaterThan(block);
  const marked = (rule?.[1] ?? "").split(",").map((each) => each.trim());
  for (const name of classes) expect(marked, `.${name} is marked`).toContain(`.${name}`);
  // Help text and notes stay unmarked, so the mark tells an error apart.
  for (const name of [".note", ".fhint", ".snote"]) expect(marked).not.toContain(name);
  const body = rule?.[2] ?? "";
  // A mark that shows (not empty), with empty alternative text: a screen reader reads the words alone.
  expect(body).toMatch(/content:\s*"[^"]+"\s*\/\s*""/);
});

test("every_greyed_button_is_greyed_in_high_contrast", () => {
  const greyed = offButtons(COMPONENTS);
  expect(greyed.size, "the style sheet's greyed buttons were found").toBeGreaterThan(2);
  for (const button of greyed) {
    const rule = new RegExp(String.raw`\.app ${button.replaceAll(".", String.raw`\.`)}\[aria-disabled="true"\][^{]*\{[^}]*color:\s*GrayText`);
    expect(HIGH_CONTRAST, `${button} while it can't be pressed`).toMatch(rule);
  }
});
