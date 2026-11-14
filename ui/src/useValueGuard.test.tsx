import { render } from "@testing-library/react";
import { useLayoutEffect, useRef } from "react";
import { expect, test } from "vitest";
import { useValueGuard } from "./useValueGuard";

function Shown({ value }: { value: string }) {
  const box = useRef<HTMLSpanElement>(null);
  useValueGuard(box);
  return <span ref={box}>{value}</span>;
}

test("the_guard_is_on_in_the_commit_that_shows_the_value", () => {
  const copies: boolean[] = [];
  // The parent's layout effect runs in the same commit, right after the child's: a copy made there stands for one made the
  // instant the value is on the page, before any passive effect has run.
  function Parent() {
    const holder = useRef<HTMLDivElement>(null);
    useLayoutEffect(() => {
      const range = document.createRange();
      range.selectNodeContents(holder.current as HTMLDivElement);
      document.getSelection()?.removeAllRanges();
      document.getSelection()?.addRange(range);
      const copy = new Event("copy", { bubbles: true, cancelable: true });
      document.body.dispatchEvent(copy);
      copies.push(copy.defaultPrevented);
      document.getSelection()?.removeAllRanges();
    }, []);
    return (
      <div ref={holder}>
        <Shown value="s3cret" />
      </div>
    );
  }
  render(<Parent />);
  expect(copies).toEqual([true]);
});
