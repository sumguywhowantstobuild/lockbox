// jsdom draws nothing, so the page's height is read from the style sheet itself: the screens fill the window only if
// every element between the window and `.app` is as tall as it (found in the release build: `#root` had no height, so
// the app was as tall as its content and left a band below it).
import { expect, test } from "vitest";
import { readBeside } from "../testing/files";

const BASE = readBeside(import.meta.url, "./base.css").replace(/\/\*[\s\S]*?\*\//g, "");

/** The declarations of the first rule (outside any @media) whose selector list holds `selector`. */
function declarationsFor(selector: string): string | undefined {
  const outside = BASE.replace(/@media[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "");
  for (const rule of outside.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = (rule[1] ?? "").split(",").map((part) => part.trim());
    if (selectors.includes(selector)) return rule[2];
  }
  return undefined;
}

test("html_body_and_root_are_as_tall_as_the_window", () => {
  for (const selector of ["html", "body", "#root"]) {
    const declarations = declarationsFor(selector);
    expect(declarations, `${selector} has a rule in base.css`).toBeDefined();
    expect(declarations?.replace(/\s+/g, " "), selector).toMatch(/height: 100%/);
  }
  // The app itself fills what holds it.
  expect(declarationsFor(".app")?.replace(/\s+/g, " ")).toMatch(/height: 100%/);
});

test("the_page_leaves_the_scroll_bars_to_windows", () => {
  // The window asks WebView2 for Windows 11's own overlay scroll bars (window.rs). A scrollbar style on the page is drawn over
  // them (it brought back Windows' arrows and a full-height bar on the line between the list and the panel), so no style sheet
  // of the app sets one.
  for (const sheet of ["base", "components", "high-contrast", "print", "short-window", "tokens"]) {
    const css = readBeside(import.meta.url, `./${sheet}.css`).replace(/\/\*[\s\S]*?\*\//g, "");
    expect(css, `${sheet}.css`).not.toMatch(/scrollbar-(width|color|gutter)|::-webkit-scrollbar/);
  }
});
