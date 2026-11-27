import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { Intaglio, LOCK_WEIGHT } from "./Intaglio";

afterEach(cleanup);

/** The outlines of each ribbon: per path, its two closed outlines as lists of points. */
function ribbons(): [number, number][][][] {
  const { container } = render(<Intaglio className="rose" />);
  return [...container.querySelectorAll("path")].map((path) =>
    (path.getAttribute("d") ?? "")
      .split("Z")
      .map((outline) => outline.replace("M", "").trim())
      .filter((outline) => outline !== "")
      .map((outline) => {
        const numbers = outline.split(/\s+/).map(Number);
        const points: [number, number][] = [];
        for (let k = 0; k < numbers.length; k += 2) points.push([numbers[k] ?? NaN, numbers[k + 1] ?? NaN]);
        return points;
      }),
  );
}

// The design's rule ("The opening picture" of the download page design, drawn here at the lock screen's weight), worked out
// on its own: line i follows r = 100 (0.62 + a sin(3t + phi)) round (100, 100), a = 0.16 + 0.156 i / 25, phi = i pi / 26;
// its ribbon's full width at t is weight (0.18 + 1.05 (0.5 + 0.5 sin(3t + phi)) ^ 2.2), set out along the line's normal.
function expected(i: number, degrees: number): { centre: [number, number]; normal: [number, number]; width: number } {
  const a = 0.16 + (0.156 * i) / 25;
  const phi = (i * Math.PI) / 26;
  const t = (degrees * Math.PI) / 180;
  const r = 100 * (0.62 + a * Math.sin(3 * t + phi));
  const dr = 100 * a * 3 * Math.cos(3 * t + phi);
  const dx = dr * Math.cos(t) - r * Math.sin(t);
  const dy = dr * Math.sin(t) + r * Math.cos(t);
  const length = Math.hypot(dx, dy);
  return {
    centre: [100 + r * Math.cos(t), 100 + r * Math.sin(t)],
    normal: [-dy / length, dx / length],
    width: LOCK_WEIGHT * (0.18 + 1.05 * Math.pow(0.5 + 0.5 * Math.sin(3 * t + phi), 2.2)),
  };
}

test("the_engraved_logo_follows_the_page_rule", () => {
  expect(LOCK_WEIGHT).toBe(0.62);
  const lines = ribbons();
  // Twenty-six lines, each a ribbon of two closed outlines with a point every 1.5 degrees.
  expect(lines).toHaveLength(26);
  for (const line of lines) {
    expect(line).toHaveLength(2);
    expect(line[0]).toHaveLength(240);
    expect(line[1]).toHaveLength(240);
  }
  // Sample points of the first, a middle and the last line, against the rule: each outline lies half the ribbon's width
  // either side of the line, along its normal (the drawing writes two decimals, so within 0.02 of a unit).
  let checked = 0;
  for (const i of [0, 13, 25]) {
    for (const degrees of [0, 37.5, 90, 181.5, 300]) {
      const k = degrees / 1.5;
      const { centre, normal, width } = expected(i, degrees);
      const left = lines[i]?.[0]?.[k];
      const right = lines[i]?.[1]?.[k];
      if (left === undefined || right === undefined) throw new Error(`line ${String(i)} has no point at ${String(degrees)} degrees`);
      expect(left[0]).toBeCloseTo(centre[0] + (normal[0] * width) / 2, 1);
      expect(left[1]).toBeCloseTo(centre[1] + (normal[1] * width) / 2, 1);
      expect(right[0]).toBeCloseTo(centre[0] - (normal[0] * width) / 2, 1);
      expect(right[1]).toBeCloseTo(centre[1] - (normal[1] * width) / 2, 1);
      // The ribbon's width: the distance between its two outlines.
      expect(Math.abs(Math.hypot(left[0] - right[0], left[1] - right[1]) - width)).toBeLessThan(0.03);
      checked += 1;
    }
  }
  expect(checked).toBe(15);
});

test("the_engraved_logo_is_for_the_eye_only_and_coloured_by_the_style_sheet", () => {
  const { container } = render(<Intaglio className="rose" />);
  const svg = container.querySelector("svg");
  expect(svg?.getAttribute("class")).toBe("rose");
  expect(svg?.getAttribute("viewBox")).toBe("0 0 200 200");
  expect(svg?.getAttribute("aria-hidden")).toBe("true");
  expect(svg?.getAttribute("style")).toBeNull();
  for (const path of container.querySelectorAll("path")) {
    // Each ribbon is the space between its two outlines.
    expect(path.getAttribute("fill-rule")).toBe("evenodd");
    expect(path.getAttribute("fill")).toBeNull();
    expect(path.getAttribute("stroke")).toBeNull();
  }
});
