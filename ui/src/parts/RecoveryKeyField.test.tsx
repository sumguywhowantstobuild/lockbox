// The box a recovery key alone is typed into (Plan 4C Task 13c, forgot password's 28a): several lines, the words shown and wrapping, so 24 words can be
// read back against the written copy, and never kept, filled in or corrected by the browser or the on-screen keyboard. It holds no text of its own.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState, type SyntheticEvent } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { expectNoAxe } from "../testing/axe";
import { readBeside } from "../testing/files";
import { RecoveryKeyField } from "./RecoveryKeyField";

afterEach(cleanup);

const LABEL = "Recovery key";
const HINT = "The 24 words you saved when this key was made.";

function Probe({ error = null, readOnly = false, onSend = () => undefined }: { error?: string | null; readOnly?: boolean; onSend?: () => void }) {
  const [value, setValue] = useState("");
  return (
    <main>
      <form
        onSubmit={(event: SyntheticEvent) => {
          event.preventDefault();
          onSend();
        }}
      >
        <RecoveryKeyField label={LABEL} hint={HINT} value={value} onChange={setValue} error={error} readOnly={readOnly} />
      </form>
    </main>
  );
}

function box(): HTMLTextAreaElement {
  return screen.getByLabelText<HTMLTextAreaElement>(LABEL);
}

test("the_key_box_is_several_lines_shown_and_wrapping_with_every_aid_off", () => {
  render(<Probe />);
  const field = box();
  // The drawn box: a text area, its words in the mono face, as tall as a whole key at the form's width, wrapping (never `wrap="off"`).
  expect(field.tagName).toBe("TEXTAREA");
  expect(field.rows).toBe(4);
  expect(field.classList.contains("m")).toBe(true);
  expect(field.getAttribute("wrap")).toBeNull();
  // All four, as attributes the browser and the on-screen keyboard read.
  expect(field.getAttribute("autocomplete")).toBe("off");
  expect(field.getAttribute("spellcheck")).toBe("false");
  expect(field.getAttribute("autocorrect")).toBe("off");
  expect(field.getAttribute("autocapitalize")).toBe("off");
  // Shown as typed: there is nothing to show or hide, and the line under it describes it.
  expect(screen.queryAllByRole("button")).toEqual([]);
  fireEvent.change(field, { target: { value: "abandon ability able" } });
  expect(field.value).toBe("abandon ability able");
  const described = (field.getAttribute("aria-describedby") ?? "").split(" ");
  expect(described.map((id) => document.getElementById(id)?.textContent)).toEqual([HINT]);
});

test("a_refusal_is_said_under_the_box_and_tied_to_it", async () => {
  const { container } = render(<Probe error="That recovery key has a typo. Check it against the one you saved." />);
  const field = box();
  expect(field.getAttribute("aria-invalid")).toBe("true");
  const alert = screen.getByRole("alert");
  expect(alert.textContent).toBe("That recovery key has a typo. Check it against the one you saved.");
  // The refusal is read first, then the hint.
  expect((field.getAttribute("aria-describedby") ?? "").split(" ")).toEqual([alert.id, expect.any(String)]);
  await expectNoAxe(container);
});

test("enter_sends_the_key_and_shift_enter_or_a_word_being_composed_does_not", () => {
  // A key never needs a line break (line breaks count as spaces when it is read), so Enter sends it, as it did in the one-line box. Shift+Enter is a line
  // break, for a key copied out line by line; Enter that ends a word in an input method's composition is that method's own.
  const onSend = vi.fn();
  render(<Probe onSend={onSend} />);
  const field = box();
  fireEvent.change(field, { target: { value: "abandon ability able" } });
  fireEvent.keyDown(field, { key: "Enter", shiftKey: true });
  fireEvent.keyDown(field, { key: "Enter", isComposing: true });
  expect(onSend).not.toHaveBeenCalled();
  fireEvent.keyDown(field, { key: "Enter" });
  expect(onSend).toHaveBeenCalledTimes(1);
});

test("a_read_only_box_is_read_and_not_typed_in", () => {
  render(<Probe readOnly />);
  expect(box().readOnly).toBe(true);
});

test("the_key_box_grows_to_show_a_whole_key", () => {
  // Found on the release build: a 24-word key takes five or six lines at the form's width, and four rows scrolled its last line out of sight. The box starts
  // at four lines (not a note's height) and grows with what is typed; a hand-drawn size would undo that.
  const css = readBeside(import.meta.url, "../styles/components.css");
  const rule = (/\.farea\.fkey\s*\{([^}]*)\}/.exec(css)?.[1] ?? "").replace(/\s+/g, " ");
  expect(rule).toMatch(/min-height: calc\(4lh \+ 20px\)/);
  expect(rule).toMatch(/field-sizing: content/);
  expect(rule).toMatch(/resize: none/);
});
