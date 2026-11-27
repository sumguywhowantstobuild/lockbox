import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { Intaglio } from "../../parts/Intaglio";
import { Frame } from "./Frame";

afterEach(cleanup);

/** The engraved logo's ribbons, joined, as drawn in `root`'s large picture. */
function drawn(root: ParentNode | null): string {
  return [...(root?.querySelectorAll("svg.rose path") ?? [])].map((path) => path.getAttribute("d")).join("|");
}

function engraving(): string {
  const { container, unmount } = render(<Intaglio />);
  const d = [...container.querySelectorAll("path")].map((path) => path.getAttribute("d")).join("|");
  unmount();
  return d;
}

test("setup_panel_shows_the_app_mark_and_the_engraved_logo", () => {
  const logo = engraving();
  // A drawing exists, so the comparison below can't pass on two empty ones.
  expect(logo.split("|")).toHaveLength(26);
  const { container } = render(<Frame say="A line.">steps</Frame>);
  const picture = container.querySelector(".field svg.rose");
  // 21a's dark side shows Petalock's engraved logo (Plan 5 Task 9b), as the lock screen does...
  expect(picture?.getAttribute("class")).toBe("rose");
  expect(picture?.getAttribute("aria-hidden")).toBe("true");
  expect(drawn(container.querySelector(".field"))).toBe(logo);
  // ...and the app's small mark beside its name, as on the lock screen: the only place its colour shows.
  const name = container.querySelector(".field .mark");
  expect(name?.textContent).toBe("Petalock");
  expect(name?.querySelector("svg.appmark")).not.toBeNull();
});

test("lock_and_setup_screens_show_the_engraved_logo", () => {
  // Every full-screen step draws the one picture: the frame takes no vault's look any more (a new vault's place showed its
  // shape here before Task 9b; its small mark shows it once the vault is made).
  const logo = engraving();
  const { container } = render(<Frame say="A line.">steps</Frame>);
  expect(drawn(container.querySelector(".field"))).toBe(logo);
  expect(container.querySelectorAll(".field svg.rose")).toHaveLength(1);
});
