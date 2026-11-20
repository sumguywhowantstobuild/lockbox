// Plan 4C Task 10a: a key's value keeps its line breaks. A private key file pasted as a key's value is kept exactly as given (CRLF and
// LF alike), hidden until Reveal in a box that does not show its shape, copied through Rust with the clipboard's marks and timer, and
// written to a `.env` in double quotes. A login's password is still one line.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import App from "../App";
import { debugState, resetStoreForTests } from "../store";
import { expectNoAxe } from "../testing/axe";
import { FOLDER, installFakeShell, itemId, PASSWORD, sampleItems, type FakeItem, type FakeShell } from "../testing/fakeShell";

const { invoke, listen } = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

let shell: FakeShell;
/** The fake vault's own items, so a test can read what was stored. */
let stored: FakeItem[];

beforeEach(() => {
  for (const style of document.querySelectorAll("style")) style.remove();
  resetStoreForTests();
  invoke.mockReset();
  listen.mockReset();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-20T12:00:00Z"));
});

/// Made up, and not any real key: every line carries the marker.
const LINES = ["-----BEGIN MU-TEST KEY-----", "MU-line-two-aaaa", "MU-line-three-bbbb", "-----END MU-TEST KEY-----"];
/** A key file as Windows writes it: CRLF between the lines and after the last. */
const CRLF_KEY = `${LINES.join("\r\n")}\r\n`;
/** The same lines with LF, and none after the last. */
const LF_KEY = LINES.join("\n");
/** CRLF, LF and a lone CR in one value, with a break at each end. */
const MIXED_KEY = "\nMU-mixed-one\r\nMU-mixed-two\nMU-mixed-three\r\n\r\nMU-mixed-four\r";
const OTHER_KEY = "demo-openai-0193-yyyy";
const PASSWORD_ONE_LINE = "That password has more than one line, so it wasn't pasted. A password is one line here.";
const MORE_THAN_ONE_LINE =
  "This value has more than one line, so it isn't shown here. Leave the box empty to keep it, or type a new one.";

function keys(): FakeItem[] {
  return [
    ...sampleItems(),
    { id: itemId(40), kind: "key", title: "PRIVATE_KEY_FILE", collection: FOLDER, value: CRLF_KEY, modified_at: "2026-11-04T09:00:00Z" },
    { id: itemId(41), kind: "key", title: "OPENAI_API_KEY", collection: FOLDER, value: OTHER_KEY, modified_at: "2026-11-01T09:00:00Z" },
  ];
}

async function unlocked() {
  stored = keys();
  shell = installFakeShell(invoke, listen, [{ id: 7, name: "My vault", items: stored }]);
  const view = render(<App />);
  await unlockThroughTheScreen();
  return view;
}

async function unlockThroughTheScreen() {
  const field = await screen.findByLabelText(/^Password for /);
  fireEvent.change(field, { target: { value: PASSWORD } });
  fireEvent.submit((field as HTMLInputElement).form as HTMLFormElement);
  await screen.findByRole("heading", { level: 1, name: "All items" });
}

function sent(cmd: string): Record<string, unknown>[] {
  return invoke.mock.calls.filter(([name]) => name === cmd).map(([, args]) => args as Record<string, unknown>);
}

async function openForm(kind: "Login" | "Key"): Promise<HTMLElement> {
  const add = screen.getByRole("button", { name: "Add" });
  add.focus();
  fireEvent.pointerDown(add, { button: 0 });
  fireEvent.click(add);
  const menu = await screen.findByRole("menu");
  fireEvent.click(within(menu).getByRole("menuitem", { name: kind }));
  return screen.findByRole("complementary", { name: `New ${kind.toLowerCase()}` });
}

async function select(title: string): Promise<HTMLElement> {
  fireEvent.click(await screen.findByRole("button", { name: new RegExp(String.raw`^(Login|Key|Note|File):\s*${title}`) }));
  const panel = await screen.findByRole("complementary", { name: title });
  await waitFor(() => {
    expect(within(panel).queryByRole("button", { name: "Edit" })).not.toBeNull();
  });
  return panel;
}

async function openEdit(title: string, name: string): Promise<HTMLElement> {
  const panel = await select(title);
  fireEvent.click(within(panel).getByRole("button", { name: "Edit" }));
  return screen.findByRole("complementary", { name });
}

function typeInto(form: HTMLElement, label: string, value: string) {
  fireEvent.change(within(form).getByLabelText(label), { target: { value } });
}

/** The one-line Value box, which is there until a value with line breaks is in it. */
function oneLineBox(form: HTMLElement): HTMLInputElement {
  return within(form).getByLabelText<HTMLInputElement>("Value");
}

/** The box a value with line breaks is in: a read-only text box, which no one-line box is. */
function lineBox(form: HTMLElement): HTMLElement {
  return within(form).getByRole("textbox", { name: "Value" });
}

function pasteInto(box: HTMLElement, text: string): boolean {
  return fireEvent.paste(box, { clipboardData: { getData: () => text } });
}

function dropOnto(box: HTMLElement, text: string): boolean {
  return fireEvent.drop(box, { dataTransfer: { getData: () => text } });
}

/** Whether `piece` is anywhere on the page a person or a program can read: its text, any attribute, or what a box holds. */
function pageHolds(piece: string): boolean {
  if (document.body.textContent.includes(piece)) return true;
  for (const element of document.querySelectorAll("*")) {
    for (const name of element.getAttributeNames()) {
      if ((element.getAttribute(name) ?? "").includes(piece)) return true;
    }
    if ((element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) && element.value.includes(piece)) return true;
  }
  return false;
}

/** Every line of the key is off the page and out of the store. It counts what it looked for, so an empty list cannot pass. */
function noLineOnThePage(lines: readonly string[] = [...LINES, "MU-mixed-one", "MU-mixed-two"]) {
  expect(lines.length).toBeGreaterThan(0);
  for (const line of lines) {
    expect(pageHolds(line), line).toBe(false);
    expect(JSON.stringify(debugState()), line).not.toContain(line);
  }
}

function saveForm(form: HTMLElement) {
  fireEvent.click(within(form).getByRole("button", { name: "Save" }));
}

test("a_multi_line_paste_is_kept_and_hidden", async () => {
  await unlocked();
  const form = await openForm("Key");
  typeInto(form, "Name", "MULTI_KEY");
  // Nothing in the box yet: it is the one-line box, and a read-only text box is not on the page.
  expect(within(form).queryByRole("textbox", { name: "Value" })).toBeNull();
  // What the one-line box is given is kept as given: a paste of CRLF lines is the same bytes once shown, and one pasted where something
  // is typed already goes in at the cursor, in place of what was selected.
  expect(pasteInto(oneLineBox(form), CRLF_KEY)).toBe(false);
  fireEvent.click(within(form).getByRole("button", { name: "Show" }));
  expect(lineBox(form).textContent).toBe(CRLF_KEY);
  fireEvent.click(within(form).getByRole("button", { name: "Hide" }));
  fireEvent.click(within(form).getByRole("button", { name: "Clear value" }));
  typeInto(form, "Value", "MU-head-");
  expect(pasteInto(oneLineBox(form), LF_KEY)).toBe(false);
  fireEvent.click(within(form).getByRole("button", { name: "Show" }));
  expect(lineBox(form).textContent).toBe(`MU-head-${LF_KEY}`);
  fireEvent.click(within(form).getByRole("button", { name: "Hide" }));
  fireEvent.click(within(form).getByRole("button", { name: "Clear value" }));
  expect(within(form).queryByRole("textbox", { name: "Value" })).toBeNull();
  const sizes = new Set<string>();
  for (const text of [CRLF_KEY, LF_KEY, MIXED_KEY, `\n${LF_KEY}\n`, `${LINES[0] ?? ""}\n${"MU-more-line-cccc\n".repeat(60)}`]) {
    // The paste is taken whole by the page, so the box cannot change it, and nothing says it was refused.
    const aim = within(form).queryByRole("textbox", { name: "Value" }) ?? oneLineBox(form);
    expect(pasteInto(aim, text), JSON.stringify(text.slice(0, 30))).toBe(false);
    expect(within(form).queryByRole("alert")).toBeNull();
    // It is in a box that shows no line of it, and nothing of it is in the page's text, attributes or fields.
    const box = lineBox(form);
    expect(box.getAttribute("aria-readonly")).toBe("true");
    expect(box.getAttribute("aria-multiline")).toBe("true");
    expect(box.hasAttribute("style")).toBe(false);
    expect(box.querySelector("[style]")).toBeNull();
    noLineOnThePage([...text.split(/[\r\n]+/).filter((line) => line !== "")]);
    // Its shape tells nothing: the same markup whether the value has 2 lines or 60.
    sizes.add(box.outerHTML);
    expect(within(form).queryByLabelText("Value", { selector: "input" })).toBeNull();
  }
  expect(sizes.size, "the hidden box looks different for different values").toBe(1);

  // A drop onto the box is the same as a paste; the line count is still not shown.
  const box = lineBox(form);
  expect(dropOnto(box, CRLF_KEY)).toBe(false);
  expect(within(form).queryByRole("alert")).toBeNull();
  expect(lineBox(form).outerHTML).toBe([...sizes][0]);
  noLineOnThePage();

  // Saved: the value goes to Rust exactly as given, CRLF kept, and the key opens hidden.
  saveForm(form);
  const panel = await screen.findByRole("complementary", { name: "MULTI_KEY" });
  const live = shell.sessionOf(7);
  expect(shell.made).toEqual([
    { session: live?.session, generation: live?.generation, kind: "key", title: "MULTI_KEY", collection: null, fields: { value: CRLF_KEY } },
  ]);
  expect(await within(panel).findByRole("button", { name: "Reveal" })).toBeTruthy();
  noLineOnThePage();
});

test("a_hidden_multi_line_box_is_replaced_by_a_paste_and_emptied_by_clear", async () => {
  await unlocked();
  const form = await openForm("Key");
  typeInto(form, "Name", "MULTI_KEY");
  pasteInto(oneLineBox(form), LF_KEY);
  // A paste of one line replaces it, and the one-line box is back with that line in it, hidden.
  expect(pasteInto(lineBox(form), "MU-one-line-dddd")).toBe(false);
  expect(within(form).queryByRole("textbox", { name: "Value" })).toBeNull();
  expect(oneLineBox(form).value).toBe("MU-one-line-dddd");
  expect(oneLineBox(form).type).toBe("password");
  await waitFor(() => {
    expect(document.activeElement).toBe(oneLineBox(form));
  });
  // Clear is only there while the box for lines holds a value.
  expect(within(form).queryByRole("button", { name: "Clear value" })).toBeNull();
  pasteInto(oneLineBox(form), CRLF_KEY);
  await waitFor(() => {
    expect(document.activeElement).toBe(lineBox(form));
  });
  // Typing into the hidden box changes nothing, and Clear empties it, with focus on the one-line box that takes its place.
  fireEvent.keyDown(lineBox(form), { key: "a" });
  expect(within(form).getByRole("textbox", { name: "Value" })).toBeTruthy();
  fireEvent.click(within(form).getByRole("button", { name: "Clear value" }));
  expect(within(form).queryByRole("textbox", { name: "Value" })).toBeNull();
  expect(within(form).queryByRole("button", { name: "Clear value" })).toBeNull();
  expect(oneLineBox(form).value).toBe("");
  await waitFor(() => {
    expect(document.activeElement).toBe(oneLineBox(form));
  });
  // A paste of one line with no break, or of no text, is left to the one-line box as it always was.
  expect(pasteInto(oneLineBox(form), "MU-plain-line-eeee")).toBe(true);
  expect(pasteInto(oneLineBox(form), "")).toBe(true);
});

test("a_paste_into_a_shown_field_leaves_the_new_value_hidden", async () => {
  await unlocked();
  const form = await openForm("Key");
  // Show was pressed on the empty box: a multi-line paste into it is hidden, and the button says Show again.
  fireEvent.click(within(form).getByRole("button", { name: "Show" }));
  expect(pasteInto(oneLineBox(form), CRLF_KEY)).toBe(false);
  expect(within(form).getByRole("button", { name: "Show" })).toBeTruthy();
  expect(lineBox(form).textContent).not.toContain("MU-line");
  noLineOnThePage();
  // Shown, a paste or a drop that replaces it is hidden too, and Show has to be pressed again to read it.
  for (const how of [pasteInto, dropOnto]) {
    fireEvent.click(within(form).getByRole("button", { name: "Show" }));
    expect(pageHolds(LINES[1] ?? "")).toBe(true);
    expect(how(lineBox(form), MIXED_KEY)).toBe(false);
    expect(within(form).getByRole("button", { name: "Show" })).toBeTruthy();
    noLineOnThePage();
    fireEvent.click(within(form).getByRole("button", { name: "Show" }));
    expect(lineBox(form).textContent).toBe(MIXED_KEY);
    expect(how(lineBox(form), LF_KEY)).toBe(false);
    noLineOnThePage(["MU-mixed-one", "MU-mixed-two", ...LINES]);
    fireEvent.click(within(form).getByRole("button", { name: "Show" }));
    expect(lineBox(form).textContent).toBe(LF_KEY);
    fireEvent.click(within(form).getByRole("button", { name: "Hide" }));
  }
  // A one-line paste into the shown box that takes it back to the one-line box is hidden as well (a password box, not text).
  fireEvent.click(within(form).getByRole("button", { name: "Show" }));
  expect(pasteInto(lineBox(form), "MU-one-line-dddd")).toBe(false);
  expect(oneLineBox(form).type).toBe("password");
  expect(within(form).getByRole("button", { name: "Show" })).toBeTruthy();

  // In the edit form with its older value shown, the replacement is hidden the same way.
  fireEvent.click(within(form).getByRole("button", { name: "Cancel" }));
  const edit = await openEdit("PRIVATE_KEY_FILE", "Edit key");
  await waitFor(() => {
    expect(within(edit).getByRole("textbox", { name: "Value" })).toBeTruthy();
  });
  fireEvent.click(within(edit).getByRole("button", { name: "Show" }));
  expect(pageHolds(LINES[1] ?? "")).toBe(true);
  expect(pasteInto(lineBox(edit), MIXED_KEY)).toBe(false);
  expect(within(edit).getByRole("button", { name: "Show" })).toBeTruthy();
  noLineOnThePage();
});

test("a_paste_with_line_breaks_only_at_the_edges_is_kept_exactly", async () => {
  await unlocked();
  let at = 0;
  for (const text of ["MU-edge-one\n", "MU-edge-one\r\n", "\nMU-edge-one", "\r\nMU-edge-one\r\n", "MU-edge-one\r"]) {
    at += 1;
    const form = await openForm("Key");
    typeInto(form, "Name", `EDGE_KEY_${String(at)}`);
    // The one-line box would drop those breaks, so the page takes the paste and keeps them: what Save sends is what was pasted.
    expect(pasteInto(oneLineBox(form), text), JSON.stringify(text)).toBe(false);
    expect(within(form).queryByRole("alert")).toBeNull();
    expect(lineBox(form).textContent).not.toContain("MU-edge-one");
    saveForm(form);
    await screen.findByRole("complementary", { name: `EDGE_KEY_${String(at)}` });
    expect(shell.made.at(-1)?.fields).toEqual({ value: text });
    expect(shell.made).toHaveLength(at);
  }
  // A drop is the same, and in the edit form the same paste is kept the same way, whatever was in the box before.
  const form = await openForm("Key");
  typeInto(form, "Name", "EDGE_DROP");
  expect(dropOnto(oneLineBox(form), "MU-edge-two\r\n")).toBe(false);
  saveForm(form);
  await screen.findByRole("complementary", { name: "EDGE_DROP" });
  expect(shell.made.at(-1)?.fields).toEqual({ value: "MU-edge-two\r\n" });
  const edit = await openEdit("OPENAI_API_KEY", "Edit key");
  await waitFor(() => {
    expect(oneLineBox(edit).value).toBe(OTHER_KEY);
  });
  expect(pasteInto(oneLineBox(edit), "MU-edge-three\r\n")).toBe(false);
  saveForm(edit);
  await screen.findByRole("complementary", { name: "OPENAI_API_KEY" });
  await waitFor(() => {
    expect(shell.edited).toHaveLength(1);
  });
  // It went in at the cursor (the end), after what was there, exactly.
  expect(shell.edited[0]?.edit.key_value).toBe(`${OTHER_KEY}MU-edge-three\r\n`);
  // No break at all, or none to keep (nothing pasted), is left to the one-line box.
  const last = await openForm("Key");
  expect(pasteInto(oneLineBox(last), "MU-no-break")).toBe(true);
  expect(pasteInto(oneLineBox(last), "")).toBe(true);
});

test("no_keystroke_clears_the_multi_line_box_and_clear_value_does", async () => {
  await unlocked();
  const form = await openEdit("PRIVATE_KEY_FILE", "Edit key");
  await waitFor(() => {
    expect(within(form).getByRole("textbox", { name: "Value" })).toBeTruthy();
  });
  const box = lineBox(form);
  // The box says it is read-only and how to change it, in a hint tied to it.
  expect(box.getAttribute("aria-readonly")).toBe("true");
  const hint = within(form).getByText("Paste to replace it.");
  expect(box.getAttribute("aria-describedby")).toContain(hint.id);
  expect(box.hasAttribute("style")).toBe(false);
  // None of these takes the value away: not Delete, Backspace, Shift+Delete (Windows' Cut), Ctrl+X, nor a cut.
  box.focus();
  for (const keys of [{ key: "Delete" }, { key: "Backspace" }, { key: "Delete", shiftKey: true }, { key: "x", ctrlKey: true }, { key: "a" }]) {
    // Not even stopped: nothing on the box listens for keys.
    expect(fireEvent.keyDown(box, keys), JSON.stringify(keys)).toBe(true);
    expect(within(form).getByRole("textbox", { name: "Value" })).toBe(box);
  }
  expect(fireEvent.cut(box)).toBe(false);
  expect(within(form).getByRole("textbox", { name: "Value" })).toBe(box);
  noLineOnThePage();
  // Save with only the name changed: the value is not sent, and what is stored is the same bytes.
  typeInto(form, "Name", "PRIVATE_KEY_FILE_2");
  saveForm(form);
  await screen.findByRole("complementary", { name: "PRIVATE_KEY_FILE_2" });
  expect(shell.edited[0]?.edit).not.toHaveProperty("key_value");
  expect(stored.find((item) => item.id === itemId(40))?.value).toBe(CRLF_KEY);

  // The new-key form sends the value unchanged after the same keys.
  const made = await openForm("Key");
  typeInto(made, "Name", "KEPT_KEY");
  pasteInto(oneLineBox(made), CRLF_KEY);
  for (const keys of [{ key: "Delete" }, { key: "Backspace" }, { key: "Delete", shiftKey: true }]) fireEvent.keyDown(lineBox(made), keys);
  saveForm(made);
  await screen.findByRole("complementary", { name: "KEPT_KEY" });
  expect(shell.made.at(-1)?.fields).toEqual({ value: CRLF_KEY });

  // Clear value is the one way to empty it: in the Value row, beside Show; the box goes, focus is on the one-line box, and Save sends nothing.
  const again = await openEdit("PRIVATE_KEY_FILE_2", "Edit key");
  await waitFor(() => {
    expect(within(again).getByRole("textbox", { name: "Value" })).toBeTruthy();
  });
  const clear = within(again).getByRole("button", { name: "Clear value" });
  expect(clear.closest(".flrow")?.contains(within(again).getByRole("button", { name: "Show" }))).toBe(true);
  expect(clear.getAttribute("aria-label")).toBe("Clear value");
  fireEvent.click(clear);
  expect(within(again).queryByRole("textbox", { name: "Value" })).toBeNull();
  expect(within(again).queryByText("Paste to replace it.")).toBeNull();
  expect(oneLineBox(again).value).toBe("");
  await waitFor(() => {
    expect(document.activeElement).toBe(oneLineBox(again));
  });
  saveForm(again);
  await screen.findByRole("complementary", { name: "PRIVATE_KEY_FILE_2" });
  await waitFor(() => {
    expect(shell.edited).toHaveLength(2);
  });
  expect(shell.edited[1]?.edit.key_value).toBe("");
});

test("only_a_key_value_is_announced_as_multi_line_when_revealed", async () => {
  stored = [
    ...keys(),
    {
      id: itemId(42),
      kind: "login",
      title: "Multi-line login",
      username: "m@example.com",
      urls: ["https://multi.example"],
      has_password: true,
      password: "MU-pw-one\nMU-pw-two",
      previous: [{ password: "MU-old-one\r\nMU-old-two", replaced_at: "2026-11-20T09:00:00Z" }],
      modified_at: "2026-11-04T09:00:00Z",
    },
  ];
  shell = installFakeShell(invoke, listen, [{ id: 7, name: "My vault", items: stored }]);
  render(<App />);
  await unlockThroughTheScreen();
  const login = await select("Multi-line login");
  fireEvent.click(within(login).getByRole("button", { name: "Reveal" }));
  const password = await within(login).findByRole("textbox", { name: "Password" });
  expect(password.textContent).toBe("MU-pw-one\nMU-pw-two");
  expect(password.hasAttribute("aria-multiline")).toBe(false);
  fireEvent.click(within(login).getByRole("button", { name: "Reveal earlier password, until today" }));
  const earlier = await within(login).findByRole("textbox", { name: "Earlier password, until today" });
  expect(earlier.textContent).toBe("MU-old-one\r\nMU-old-two");
  expect(earlier.hasAttribute("aria-multiline")).toBe(false);
  // A key's value with line breaks is announced as multi-line, and one without is not.
  const key = await select("PRIVATE_KEY_FILE");
  fireEvent.click(within(key).getByRole("button", { name: "Reveal" }));
  expect((await within(key).findByRole("textbox", { name: "Key value" })).getAttribute("aria-multiline")).toBe("true");
  const plain = await select("OPENAI_API_KEY");
  fireEvent.click(within(plain).getByRole("button", { name: "Reveal" }));
  expect((await within(plain).findByRole("textbox", { name: "Key value" })).hasAttribute("aria-multiline")).toBe(false);
});

test("edit_loads_a_stored_multi_line_value_hidden", async () => {
  await unlocked();
  const form = await openEdit("PRIVATE_KEY_FILE", "Edit key");
  await waitFor(() => {
    expect(within(form).getByRole("textbox", { name: "Value" })).toBeTruthy();
  });
  const live = shell.sessionOf(7);
  expect(shell.revealed).toEqual([{ session: live?.session, generation: live?.generation, id: itemId(40), field: "key_value" }]);
  // It is loaded, hidden, in the box that shows no shape; the old words that said it could not be shown are gone.
  expect(lineBox(form).hasAttribute("style")).toBe(false);
  expect(within(form).queryByText(MORE_THAN_ONE_LINE)).toBeNull();
  expect(within(form).queryByLabelText("Value", { selector: "input" })).toBeNull();
  noLineOnThePage();

  // Only the name changed: the value is not sent, and what is stored is the same bytes.
  typeInto(form, "Name", "PRIVATE_KEY_FILE_2");
  saveForm(form);
  const panel = await screen.findByRole("complementary", { name: "PRIVATE_KEY_FILE_2" });
  expect(shell.edited[0]?.edit).not.toHaveProperty("key_value");
  expect(stored.find((item) => item.id === itemId(40))?.value).toBe(CRLF_KEY);

  // A paste into the hidden box replaces the value, exactly as given; Save sends it, and only then.
  fireEvent.click(await within(panel).findByRole("button", { name: "Edit" }));
  const again = await screen.findByRole("complementary", { name: "Edit key" });
  await waitFor(() => {
    expect(within(again).getByRole("textbox", { name: "Value" })).toBeTruthy();
  });
  expect(pasteInto(lineBox(again), MIXED_KEY)).toBe(false);
  expect(within(again).queryByRole("alert")).toBeNull();
  noLineOnThePage();
  saveForm(again);
  await screen.findByRole("complementary", { name: "PRIVATE_KEY_FILE_2" });
  await waitFor(() => {
    expect(shell.edited).toHaveLength(2);
  });
  expect(shell.edited[1]?.edit.key_value).toBe(MIXED_KEY);
  expect(stored.find((item) => item.id === itemId(40))?.value).toBe(MIXED_KEY);

  // A lock takes the form with it, and nothing of the value is left on the page.
  const last = await openEdit("PRIVATE_KEY_FILE_2", "Edit key");
  await waitFor(() => {
    expect(within(last).getByRole("textbox", { name: "Value" })).toBeTruthy();
  });
  act(() => {
    shell.lock(shell.sessionOf(7)?.session ?? 0);
  });
  await screen.findByLabelText(/^Password for /);
  noLineOnThePage(["MU-mixed-one", "MU-mixed-two", "MU-mixed-three", "MU-mixed-four"]);
});

test("reveal_shows_every_line_and_hide_hides_them", async () => {
  await unlocked();
  const panel = await select("PRIVATE_KEY_FILE");
  // Hidden as any key is: not a line of it on the page.
  expect(within(panel).queryByRole("textbox", { name: "Key value" })).toBeNull();
  noLineOnThePage();
  fireEvent.click(within(panel).getByRole("button", { name: "Reveal" }));
  const value = await within(panel).findByRole("textbox", { name: "Key value" });
  // Every line, with its breaks exactly as stored; and the detector sees them here, so its silence elsewhere means something.
  expect(value.textContent).toBe(CRLF_KEY);
  expect(value.getAttribute("aria-multiline")).toBe("true");
  for (const line of LINES) expect(pageHolds(line), line).toBe(true);
  expect(sent("reveal_password").at(-1)).toMatchObject({ id: itemId(40), field: "key_value" });
  // Copy key sends the item and the field, and no text: the copy is made in Rust.
  fireEvent.click(within(panel).getByRole("button", { name: "Copy key" }));
  await waitFor(() => {
    expect(shell.copied).toHaveLength(1);
  });
  expect(Object.keys(sent("copy_field")[0] ?? {}).sort()).toEqual(["field", "generation", "id", "session"]);
  expect(shell.copied[0]).toMatchObject({ id: itemId(40), field: "key_value" });
  // Hide takes every line off the page.
  fireEvent.click(within(panel).getByRole("button", { name: "Hide" }));
  await waitFor(() => {
    expect(within(panel).queryByRole("textbox", { name: "Key value" })).toBeNull();
  });
  noLineOnThePage();

  // Another item takes a revealed one away.
  fireEvent.click(within(panel).getByRole("button", { name: "Reveal" }));
  await within(panel).findByRole("textbox", { name: "Key value" });
  const other = await select("OPENAI_API_KEY");
  expect(within(other).queryByRole("textbox", { name: "Key value" })).toBeNull();
  noLineOnThePage();

  // A lock takes it away too.
  fireEvent.click(await within(await select("PRIVATE_KEY_FILE")).findByRole("button", { name: "Reveal" }));
  await screen.findByRole("textbox", { name: "Key value" });
  act(() => {
    shell.lock(shell.sessionOf(7)?.session ?? 0);
  });
  await screen.findByLabelText(/^Password for /);
  noLineOnThePage();

  // In the edit form, Show reads every line in the box and Hide takes them off again.
  await unlockThroughTheScreen();
  const form = await openEdit("PRIVATE_KEY_FILE", "Edit key");
  await waitFor(() => {
    expect(within(form).getByRole("textbox", { name: "Value" })).toBeTruthy();
  });
  fireEvent.click(within(form).getByRole("button", { name: "Show" }));
  expect(lineBox(form).textContent).toBe(CRLF_KEY);
  expect(pageHolds(LINES[1] ?? "")).toBe(true);
  // A copy, a cut or a drag aimed at the shown value is stopped: the copy that keeps the marks is Copy key.
  expect(fireEvent.copy(lineBox(form))).toBe(false);
  expect(fireEvent.cut(lineBox(form))).toBe(false);
  expect(fireEvent.dragStart(lineBox(form))).toBe(false);
  fireEvent.click(within(form).getByRole("button", { name: "Hide" }));
  expect(lineBox(form).textContent).not.toContain("MU-line");
  noLineOnThePage();
  // A lock while it is shown takes it away.
  fireEvent.click(within(form).getByRole("button", { name: "Show" }));
  expect(pageHolds(LINES[2] ?? "")).toBe(true);
  act(() => {
    shell.lock(shell.sessionOf(7)?.session ?? 0);
  });
  await screen.findByLabelText(/^Password for /);
  noLineOnThePage();
});

test("a_password_stays_one_line", async () => {
  await unlocked();
  const form = await openForm("Login");
  const password = within(form).getByLabelText<HTMLInputElement>("Password");
  expect(PASSWORD_ONE_LINE).toBe("That password has more than one line, so it wasn't pasted. A password is one line here.");
  for (const text of [CRLF_KEY.trimEnd(), LF_KEY, MIXED_KEY.trim()]) {
    expect(pasteInto(password, text), JSON.stringify(text.slice(0, 20))).toBe(false);
    expect((await within(form).findByRole("alert")).textContent).toBe(PASSWORD_ONE_LINE);
    expect(password.value).toBe("");
    typeInto(form, "Password", "demo-one-line-pass");
    typeInto(form, "Password", "");
    expect(within(form).queryByRole("alert")).toBeNull();
  }
  // No read-only multi-line box came of it: a password is one line in the new login form and in the edit form.
  expect(within(form).queryByRole("textbox", { name: "Value" })).toBeNull();
  expect(within(form).queryByRole("textbox", { name: "Password" })).toBeNull();
  expect(password.value).toBe("");
});

test("copy_out_as_env_quotes_a_multi_line_value", async () => {
  await unlocked();
  // The key is in the Agency support agent folder, with a value of CRLF, LF and a lone CR in one.
  const key = stored.find((item) => item.id === itemId(40));
  if (key === undefined) throw new Error("the sample key is missing");
  key.value = MIXED_KEY;
  fireEvent.click(within(screen.getByRole("navigation", { name: "Vault and folders" })).getByRole("button", { name: /^Agency support agent\s+\d+$/ }));
  await screen.findByRole("heading", { level: 1, name: "Agency support agent" });
  const more = screen.getByRole("button", { name: "More for this folder" });
  more.focus();
  fireEvent.pointerDown(more, { button: 0 });
  fireEvent.click(more);
  fireEvent.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: "Copy all as .env" }));
  await waitFor(() => {
    expect(shell.envCopied).toEqual([FOLDER]);
  });
  // The page sent the folder and nothing else; the text was made in Rust (the existing writer) and is on the clipboard: the value in
  // double quotes, each break as `\r` or `\n`, so reading the line back gives the value exactly as stored.
  expect(Object.keys(sent("env_copy")[0] ?? {}).sort()).toEqual(["collection", "generation", "session"]);
  expect(shell.clipboard()).toBe(
    'OPENAI_API_KEY=demo-openai-0193-yyyy\nPRIVATE_KEY_FILE="\\nMU-mixed-one\\r\\nMU-mixed-two\\nMU-mixed-three\\r\\n\\r\\nMU-mixed-four\\r"\n',
  );
  noLineOnThePage();
});

test("multi_line_value_field_has_no_axe_violations", async () => {
  const { container } = await unlocked();
  const form = await openForm("Key");
  await expectNoAxe(container);
  pasteInto(oneLineBox(form), CRLF_KEY);
  // Hidden, then shown (the form's Show), in the new-key form.
  expect(lineBox(form)).toBeTruthy();
  await expectNoAxe(container);
  fireEvent.click(within(form).getByRole("button", { name: "Show" }));
  expect(lineBox(form).textContent).toBe(CRLF_KEY);
  await expectNoAxe(container);
  fireEvent.click(within(form).getByRole("button", { name: "Cancel" }));

  // And in the edit form, hidden and shown, and the key's details with the value revealed.
  const edit = await openEdit("PRIVATE_KEY_FILE", "Edit key");
  await waitFor(() => {
    expect(within(edit).getByRole("textbox", { name: "Value" })).toBeTruthy();
  });
  await expectNoAxe(container);
  fireEvent.click(within(edit).getByRole("button", { name: "Show" }));
  await expectNoAxe(container);
  fireEvent.click(within(edit).getByRole("button", { name: "Cancel" }));
  const panel = await screen.findByRole("complementary", { name: "PRIVATE_KEY_FILE" });
  fireEvent.click(within(panel).getByRole("button", { name: "Reveal" }));
  await within(panel).findByRole("textbox", { name: "Key value" });
  await expectNoAxe(container);
});
