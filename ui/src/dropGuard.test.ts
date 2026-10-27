import { expect, test } from "vitest";
import { installDropGuard } from "./dropGuard";

test("drops_are_cancelled", () => {
  installDropGuard();
  for (const type of ["dragover", "drop"]) {
    const event = new Event(type, { cancelable: true });
    document.dispatchEvent(event);
    expect(event.defaultPrevented, type).toBe(true);
  }
});
