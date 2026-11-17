// The box a password or a recovery key is typed into (Plan 4B Task 4; Tasks 5, 7 and 9 reuse it): hidden, never kept or corrected by the
// browser or the keyboard, with a Show and Hide beside it. It holds no text of its own: the screen's state is the text.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, test } from "vitest";
import { expectNoAxe } from "../testing/axe";
import { CredentialField } from "./CredentialField";

afterEach(cleanup);

const LABEL = "Password or recovery key from when it was made";

function Probe({ error = null }: { error?: string | null }) {
  const [value, setValue] = useState("");
  return (
    <main>
      <CredentialField label={LABEL} value={value} onChange={setValue} error={error} />
    </main>
  );
}

test("password_or_key_field_turns_off_spellcheck_and_autocomplete", () => {
  render(<Probe />);
  const box = screen.getByLabelText(LABEL);
  // All four, as attributes the browser and the on-screen keyboard read, and the box is hidden to begin with.
  expect(box.getAttribute("type")).toBe("password");
  expect(box.getAttribute("autocomplete")).toBe("off");
  expect(box.getAttribute("spellcheck")).toBe("false");
  expect(box.getAttribute("autocorrect")).toBe("off");
  expect(box.getAttribute("autocapitalize")).toBe("off");
});

test("show_and_hide_change_how_it_reads_and_nothing_else", () => {
  render(<Probe />);
  const box = screen.getByLabelText<HTMLInputElement>(LABEL);
  fireEvent.change(box, { target: { value: "some typed text" } });
  fireEvent.click(screen.getByRole("button", { name: "Show what you typed" }));
  expect(box.getAttribute("type")).toBe("text");
  // The four attributes stay off while it shows, and the text is as it was.
  expect(box.getAttribute("autocomplete")).toBe("off");
  expect(box.getAttribute("spellcheck")).toBe("false");
  expect(box.getAttribute("autocorrect")).toBe("off");
  expect(box.getAttribute("autocapitalize")).toBe("off");
  expect(box.value).toBe("some typed text");
  fireEvent.click(screen.getByRole("button", { name: "Hide what you typed" }));
  expect(box.getAttribute("type")).toBe("password");
});

test("a_refusal_is_an_alert_tied_to_the_box", async () => {
  render(<Probe error="Wrong password." />);
  const box = screen.getByLabelText(LABEL);
  const alert = screen.getByRole("alert");
  expect(alert.textContent).toBe("Wrong password.");
  expect(box.getAttribute("aria-invalid")).toBe("true");
  expect(box.getAttribute("aria-describedby")?.split(" ")).toContain(alert.id);
  await expectNoAxe(document.body);
});

test("a_read_only_box_can_be_read_and_shown_but_not_typed_in", () => {
  render(<CredentialField label={LABEL} value="kept" onChange={() => undefined} readOnly />);
  const box = screen.getByLabelText<HTMLInputElement>(LABEL);
  expect(box.readOnly).toBe(true);
  expect(box.value).toBe("kept");
  fireEvent.click(screen.getByRole("button", { name: "Show what you typed" }));
  expect(box.getAttribute("type")).toBe("text");
  // By default it is open.
  cleanup();
  render(<Probe />);
  expect(screen.getByLabelText<HTMLInputElement>(LABEL).readOnly).toBe(false);
});

test("caps_lock_is_said_as_a_hint", () => {
  render(<Probe />);
  const box = screen.getByLabelText(LABEL);
  fireEvent.keyDown(box, { key: "a", modifierCapsLock: true });
  expect(screen.getByText("Caps Lock is on.")).toBeTruthy();
  fireEvent.keyUp(box, { key: "a", modifierCapsLock: false });
  expect(screen.queryByText("Caps Lock is on.")).toBeNull();
});
