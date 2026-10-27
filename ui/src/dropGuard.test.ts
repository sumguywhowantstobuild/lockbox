import { expect, test } from "vitest";
import { installDropGuard } from "./dropGuard";

test("drops_are_cancelled", () => {
  installDropGuard();
  // An element that stops the event on its way: the guard must still cancel it.
  const child = document.createElement("div");
  document.body.append(child);
  for (const type of ["dragover", "drop"]) {
    child.addEventListener(type, (event) => {
      event.stopPropagation();
    });
    const event = new Event(type, { bubbles: true, cancelable: true });
    child.dispatchEvent(event);
    expect(event.defaultPrevented, type).toBe(true);
  }
});
