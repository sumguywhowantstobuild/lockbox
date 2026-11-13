import { useEffect, useState } from "react";

/** How long typing (or any change to the line) must pause before the line is said. */
export const SETTLE_MS = 500;
/** How long a said line stays in its place before the place empties again. */
export const SAID_FOR_MS = 7000;

/**
 * What a polite live place should hold for a line that can change on every key typed (how a list is narrowed). The screen shows
 * the line at once; a screen reader would start a sentence per change, so the place takes the line only once it has stayed the
 * same for `SETTLE_MS`, and is emptied `SAID_FOR_MS` after that, so someone reading down the page doesn't meet it twice (the line
 * is still on screen to read). Emptying a polite place is not spoken. No line (null) empties it once things have settled.
 */
export function useSpokenLine(line: string | null): string {
  const [said, setSaid] = useState("");
  useEffect(() => {
    let clear: number | undefined;
    const settle = window.setTimeout(() => {
      setSaid(line ?? "");
      if (line !== null) {
        clear = window.setTimeout(() => {
          setSaid("");
        }, SAID_FOR_MS);
      }
    }, SETTLE_MS);
    return () => {
      window.clearTimeout(settle);
      window.clearTimeout(clear);
    };
  }, [line]);
  return said;
}
