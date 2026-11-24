// Small windows (4D Task 8, from 4C's audit, V20 and V21). Measured on the release build laid out at 1093 by 534 and 960 by
// 460 (the hands-on note): a question covered the page's heading, which ends about 103px down, and the new recovery key's
// Continue sat below the fold, because the whole screen scrolled instead of its right side. jsdom lays nothing out, so the
// rules are read from the style sheet here; the hands-on measures them.
import { expect, test } from "vitest";
import { readBeside } from "../testing/files";

const SHEET = readBeside(import.meta.url, "./short-window.css").replace(/\/\*[\s\S]*?\*\//g, "");

/** The block of `@media (max-height: 700px)`, the rules for windows under 700px high. */
function shortBlock(): string {
  const start = SHEET.indexOf("@media (max-height: 700px)");
  expect(start, "the short-window block was found").toBeGreaterThan(-1);
  let depth = 0;
  for (let at = SHEET.indexOf("{", start); at < SHEET.length; at += 1) {
    if (SHEET[at] === "{") depth += 1;
    if (SHEET[at] === "}") depth -= 1;
    if (depth === 0) return SHEET.slice(start, at);
  }
  return "";
}

/** The declarations of the rule in the short block whose selector is exactly `selector`. */
function rule(selector: string): string {
  const block = shortBlock();
  for (const [, selectors = "", body = ""] of block.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (selectors.trim() === selector) return body.replace(/\s+/g, " ");
  }
  return "";
}

test("small_size_dialogs_sit_below_the_page_heading", () => {
  const body = rule(".pal.dlg");
  const top = Number(/top:\s*(\d+)px/.exec(body)?.[1]);
  // The page's heading ends at 103px at these sizes (measured); a question starts below it.
  expect(top, "a question's top").toBeGreaterThanOrEqual(108);
  expect(body, "a tall question scrolls inside itself, not past the window").toMatch(/max-height:\s*calc\(100% - \d+px\)/);
  expect(body).toMatch(/overflow-y:\s*auto/);
});

test("the_right_side_scrolls_and_a_steps_last_row_stays_in_sight", () => {
  // The right side is the box that scrolls, as tall as the window; without that the whole screen scrolled.
  const plate = rule(".plate");
  expect(plate).toMatch(/max-height:\s*100%/);
  expect(plate).toMatch(/overflow-y:\s*auto/);
  // A control Tab reaches is scrolled clear of the row kept at the foot (about 64px tall, measured), not left behind it.
  expect(Number(/scroll-padding-bottom:\s*(\d+)px/.exec(plate)?.[1]), "room kept at the foot when scrolling to focus").toBeGreaterThanOrEqual(64);
  // The step's last row keeps to the foot of that box, on the page's ground, and the recovery key's Print row does not.
  const row = rule(".plate .fu > .fu-row:last-child");
  expect(row).toMatch(/position:\s*sticky/);
  expect(row).toMatch(/bottom:\s*0/);
  expect(row).toMatch(/background:\s*var\(--ground\)/);
});
