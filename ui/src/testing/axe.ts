// axe-core on a rendered screen: every screen test ends with `await expectNoAxe(container)`. axe-core is a test tool
// only; it never ships.
import axe from "axe-core";
import { expect } from "vitest";

/**
 * Runs axe-core on `container` and fails with a readable list when it finds a violation.
 *
 * Colour contrast is switched off here: jsdom has no layout and no style sheet, so axe cannot measure it. The colours
 * are checked from the tokens by `tokens.contrast.test.ts` instead. Nothing else is switched off.
 */
export async function expectNoAxe(container: Element): Promise<void> {
  const results = await axe.run(container, {
    rules: { "color-contrast": { enabled: false } },
    resultTypes: ["violations"],
  });
  const found = results.violations.map(
    (violation) =>
      `${violation.id}: ${violation.help} (${violation.nodes.map((node) => node.target.join(" ")).join("; ")})`,
  );
  expect(found, "axe-core found violations").toEqual([]);
}
