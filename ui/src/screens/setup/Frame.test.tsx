import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { Pattern } from "../../parts/Pattern";
import { Frame } from "./Frame";

afterEach(cleanup);

/** The path a drawing makes, to compare one drawing with another. */
function drawn(element: Element | null): string {
  return element?.querySelector("path")?.getAttribute("d") ?? "";
}

function reference(points: number): string {
  const { container, unmount } = render(<Pattern points={points} />);
  const d = drawn(container.querySelector("svg"));
  unmount();
  return d;
}

test("setup_panel_shows_the_app_pattern", () => {
  const three = reference(3);
  // A drawing exists, so the comparison below can't pass on two empty ones.
  expect(three).not.toBe("");
  const { container } = render(<Frame say="A line.">steps</Frame>);
  const pattern = container.querySelector(".field svg.rose");
  // 21a's dark side shows the app's own three petals, in the white lines every pattern takes, not a vault's look...
  expect(pattern?.getAttribute("class")).toBe("rose");
  expect(drawn(pattern)).toBe(three);
  // ...and the app's small mark beside its name, as on the lock screen: the only place its colour shows.
  const name = container.querySelector(".field .mark");
  expect(name?.textContent).toBe("Petalock");
  expect(name?.querySelector("svg.appmark")).not.toBeNull();
  cleanup();

  // A new vault begun from the vault menu (18b) still shows the look of the place it will take.
  const { container: placed } = render(
    <Frame say="A line." points={6}>
      steps
    </Frame>,
  );
  const vault = placed.querySelector(".field svg.rose");
  expect(vault?.getAttribute("class")).toBe("rose");
  expect(drawn(vault)).toBe(reference(6));
});
