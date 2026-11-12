// The list's rows as the approved screens draw them (1d, 3a): each kind's tile holds its line drawing in the tile's own
// colour, so a key reads amber and a login blue, not the vault's green.
import { expect, test } from "vitest";
import { readBeside } from "../testing/files";

const COMPONENTS = readBeside(import.meta.url, "./components.css").replace(/\/\*[\s\S]*?\*\//g, "");

function declarationsFor(selector: string): string {
  for (const rule of COMPONENTS.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if ((rule[1] ?? "").split(",").some((part) => part.trim() === selector)) return (rule[2] ?? "").replace(/\s+/g, " ");
  }
  throw new Error(`${selector} has no rule in components.css`);
}

test("a_rows_tile_draws_its_icon_in_the_tiles_colour", () => {
  // Found at stage 7: the tile's icon took the drawing's default stroke, the vault's green, on every kind.
  expect(declarationsFor(".ktile")).toMatch(/color: color-mix\(in srgb, rgb\(var\(--tc\)\) var\(--icon-mix\), var\(--ink\)\)/);
  expect(declarationsFor(".ktile .ki")).toMatch(/stroke: currentColor/);
});

test("hidden_value_dots_are_spaced_as_drawn", () => {
  expect(declarationsFor(".rdet.dots")).toMatch(/letter-spacing: 0\.12em/);
});

test("key_names_in_mono_take_the_drawn_sizes", () => {
  // The mono face runs wider, so each place a key's name shows in mono has its own size, as approved.
  const row = declarationsFor(".rname.m");
  expect(row).toMatch(/font-size: 13\.5px/);
  expect(row).toMatch(/letter-spacing: -0\.01em/);
  const heading = declarationsFor(".ptitle.m");
  expect(heading).toMatch(/font-size: 17\.5px/);
  expect(heading).toMatch(/line-height: 1\.3/);
  expect(heading).toMatch(/font-weight: 500/);
  expect(heading).toMatch(/letter-spacing: -0\.015em/);
  const result = declarationsFor(".ht.m");
  expect(result).toMatch(/font-size: 13px/);
  expect(result).toMatch(/font-weight: 500/);
});
