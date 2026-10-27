import { renderHook } from "@testing-library/react";
import { act } from "react";
import { expect, test } from "vitest";
import { installDropGuard } from "./dropGuard";
import { installDropProbe, useDroppedFileReachedPage } from "./dropProbe";

// jsdom has no DataTransfer, so the drop carries a stand-in with one file.
function dropWithFile(): Event {
  const event = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: { files: [{}], types: ["Files"] } });
  return event;
}

test("dropped_file_is_reported_even_behind_the_guard", () => {
  installDropProbe();
  installDropGuard();
  const { result } = renderHook(() => useDroppedFileReachedPage());
  expect(result.current).toBe(false);

  const event = dropWithFile();
  act(() => {
    document.body.dispatchEvent(event);
  });
  expect(event.defaultPrevented).toBe(true);
  expect(result.current).toBe(true);
});
