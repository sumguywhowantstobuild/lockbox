import { cleanup, render } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, expect, test } from "vitest";
import { Pattern, VaultMark, vaultLook } from "./Pattern";

afterEach(cleanup);

test("each_listed_vault_has_its_own_number_of_points_and_the_colours_take_turns", () => {
  expect(vaultLook(0, false)).toEqual({ accent: "work", points: 3 });
  expect(vaultLook(1, false)).toEqual({ accent: "home", points: 5 });
  expect(vaultLook(2, false)).toEqual({ accent: "work", points: 6 });
  expect(vaultLook(3, false)).toEqual({ accent: "home", points: 7 });
  expect(vaultLook(4, false)).toEqual({ accent: "work", points: 8 });
  expect(vaultLook(5, false)).toEqual({ accent: "home", points: 9 });
  expect(vaultLook(10, false)).toEqual({ accent: "work", points: 14 });
});

test("no_two_listed_vaults_share_a_shape_and_none_takes_the_amber_ones_four", () => {
  const points = Array.from({ length: 40 }, (_, position) => vaultLook(position, false).points);
  expect(new Set(points).size).toBe(points.length);
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

test("the_pattern_is_fourteen_lines_and_a_mark_is_two", () => {
  const { container } = render(
    <>
      <Pattern points={3} className="rose" />
      <VaultMark points={5} className="vprint" />
    </>,
  );
  const [pattern, mark] = [...container.querySelectorAll("svg")];
  const subpaths = (svg: SVGElement | undefined) => (svg?.querySelector("path")?.getAttribute("d") ?? "").split("M").length - 1;
  expect(subpaths(pattern)).toBe(14);
  expect(subpaths(mark)).toBe(2);
  // Drawn for the eye only, coloured by the style sheet, and no style written into the page.
  for (const svg of [pattern, mark]) {
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
    expect(svg?.getAttribute("style")).toBeNull();
    expect(svg?.querySelector("path")?.getAttribute("stroke")).toBeNull();
  }
});

test("the_small_mark_is_shallower_than_the_big_pattern_so_many_points_stay_clear", () => {
  // The farthest a line strays from the middle circle, in the drawing's own units (the circle is at 62).
  const reach = (element: ReactElement) => {
    const { container, unmount } = render(element);
    const d = container.querySelector("path")?.getAttribute("d") ?? "";
    unmount();
    const radii = [...d.matchAll(/[ML]([\d.]+) ([\d.]+)/g)].map((m) => Math.hypot(Number(m[1]) - 100, Number(m[2]) - 100));
    return Math.max(...radii) - 62;
  };
  expect(reach(<VaultMark points={9} />)).toBeLessThan(20);
  expect(reach(<VaultMark points={9} />)).toBeLessThan(reach(<Pattern points={9} />));
});

test("different_points_draw_different_lines", () => {
  const draw = (points: number) => {
    const { container, unmount } = render(<Pattern points={points} />);
    const d = container.querySelector("path")?.getAttribute("d");
    unmount();
    return d;
  };
  expect(draw(3)).not.toBe(draw(5));
  expect(draw(3)).toBe(draw(3));
});
