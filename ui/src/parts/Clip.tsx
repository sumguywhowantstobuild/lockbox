import { useState, type SyntheticEvent } from "react";

/**
 * A line of text that the style sheet cuts short with "…" when it does not fit. When the pointer comes over a line that
 * is cut, it gets its full text as a hint (`title`); a line that fits never does, so a hint is never a copy of what is
 * already there. What is measured is the element itself, in the window as it is now. (Only the pointer: a browser shows
 * a `title` for the pointer and not for keyboard focus, so a hint set on focus would show nothing. Someone using the
 * keyboard opens the item, and its panel has the whole title.)
 */
export function Clip({ text, className }: { text: string; className?: string }) {
  // The text the line was found cut for: if the text changes, the hint goes until the pointer comes back.
  const [cutFor, setCutFor] = useState<string | null>(null);
  const measure = (event: SyntheticEvent<HTMLElement>) => {
    const line = event.currentTarget;
    setCutFor(line.scrollWidth > line.clientWidth ? text : null);
  };
  return (
    <span className={className} title={cutFor === text ? text : undefined} onMouseEnter={measure}>
      {text}
    </span>
  );
}
