import { useLayoutEffect, type RefObject } from "react";

/**
 * Keeps a value that is shown on the page (a generated password, a revealed key) from being copied natively. A native copy
 * or cut would put it on the clipboard without the marks that keep it out of Windows' clipboard history, its timer and its
 * clearing at a lock. So while the value is on screen, a copy or cut aimed at it is stopped: a selection that touches it, or
 * focus on its box with nothing else selected. `onCopyKey` then does what the Copy button does (through the shell), for a
 * copy; with none, nothing is copied. Anything else is left alone, ordinary text selected beside a focused control
 * included: the value never stands in for text the person meant to copy.
 *
 * A layout effect, so the guard is on in the same commit that puts the value on the page: a passive effect runs a moment
 * later, and a copy in that moment went through.
 */
export function useValueGuard(valueBox: RefObject<HTMLElement | null>, onCopyKey?: () => void): void {
  useLayoutEffect(() => {
    const guard = (event: Event) => {
      const value = valueBox.current;
      if (value === null) return;
      const selection = document.getSelection();
      const ranges = selection === null ? [] : Array.from({ length: selection.rangeCount }, (_, at) => selection.getRangeAt(at));
      const touches = ranges.some((range) => range.intersectsNode(value));
      const onTheValue = document.activeElement === value && ranges.every((range) => range.collapsed);
      if (!touches && !onTheValue) return;
      event.preventDefault();
      if (event.type === "copy") onCopyKey?.();
    };
    document.addEventListener("copy", guard);
    document.addEventListener("cut", guard);
    return () => {
      document.removeEventListener("copy", guard);
      document.removeEventListener("cut", guard);
    };
  }, [valueBox, onCopyKey]);
}
