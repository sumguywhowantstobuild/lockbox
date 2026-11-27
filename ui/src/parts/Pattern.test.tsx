import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { VaultMark, vaultLook } from "./Pattern";

afterEach(cleanup);

test("vaults_start_at_five", () => {
  // Three points are the app's own mark (Petalock's three petals), so the first vault takes five, and the colours take turns.
  expect(vaultLook(0, false)).toEqual({ accent: "work", points: 5 });
  expect(vaultLook(1, false)).toEqual({ accent: "home", points: 6 });
  expect(vaultLook(2, false)).toEqual({ accent: "work", points: 7 });
  expect(vaultLook(3, false)).toEqual({ accent: "home", points: 8 });
  expect(vaultLook(10, false)).toEqual({ accent: "work", points: 15 });
  expect(vaultLook(0, true)).toEqual({ accent: "old", points: 4 });
});

test("no_two_listed_vaults_share_a_shape_and_none_takes_the_apps_three_or_the_amber_ones_four", () => {
  const points = Array.from({ length: 40 }, (_, position) => vaultLook(position, false).points);
  expect(new Set(points).size).toBe(points.length);
  expect(points).not.toContain(3);
  expect(points).not.toContain(4);
  // Only the colour repeats.
  expect(new Set(Array.from({ length: 40 }, (_, position) => vaultLook(position, false).accent))).toEqual(
    new Set(["work", "home"]),
  );
});

test("a_read_only_vault_is_amber_wherever_it_is_listed", () => {
  for (const position of [0, 1, 2, 7]) {
    expect(vaultLook(position, true)).toEqual({ accent: "old", points: 4 });
  }
});

test("a_mark_is_two_lines_for_the_eye_only", () => {
  const { container } = render(<VaultMark points={5} className="vprint" />);
  const mark = container.querySelector("svg");
  expect((mark?.querySelector("path")?.getAttribute("d") ?? "").split("M").length - 1).toBe(2);
  // Drawn for the eye only, coloured by the style sheet, and no style written into the page.
  expect(mark?.getAttribute("aria-hidden")).toBe("true");
  expect(mark?.getAttribute("style")).toBeNull();
  expect(mark?.querySelector("path")?.getAttribute("stroke")).toBeNull();
});

test("the_small_mark_is_shallow_so_many_points_stay_clear", () => {
  // The farthest a line strays from the middle circle, in the drawing's own units (the circle is at 62).
  const { container } = render(<VaultMark points={9} />);
  const d = container.querySelector("path")?.getAttribute("d") ?? "";
  const radii = [...d.matchAll(/[ML]([\d.]+) ([\d.]+)/g)].map((m) => Math.hypot(Number(m[1]) - 100, Number(m[2]) - 100));
  expect(radii.length).toBeGreaterThan(0);
  expect(Math.max(...radii) - 62).toBeLessThan(20);
});

test("different_points_draw_different_lines", () => {
  const draw = (points: number) => {
    const { container, unmount } = render(<VaultMark points={points} />);
    const d = container.querySelector("path")?.getAttribute("d");
    unmount();
    return d;
  };
  expect(draw(3)).not.toBe(draw(5));
  expect(draw(3)).toBe(draw(3));
});

test("marks_are_drawn_finely_enough_to_look_smooth", () => {
  // At nine points a petal spans 40 degrees; drawn a point every 3 degrees its corners showed at the lock screen's size
  // (Ariel, 2026-11-19). Every line has a point at least every degree.
  const { container } = render(<VaultMark points={9} />);
  const d = container.querySelector("path")?.getAttribute("d") ?? "";
  const lines = d.split("M").slice(1);
  expect(lines.length).toBeGreaterThan(0);
  for (const line of lines) expect(line.split("L").length).toBeGreaterThanOrEqual(361);
});
