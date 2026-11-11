// Task 18's screens: a copied key saved with the shortcut (8a to 8e), and the paste panel's tick box that clears the clipboard. The
// shell reads the clipboard and keeps the text in a slot; the page hears only a state and an id (`lockbox://capture`) and asks for
// the value only on Reveal. These tests hold the page to that: most of them also look for the copied value in everything the page
// shows or keeps.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import App from "../App";
import { debugState, resetStoreForTests, saveCapture } from "../store";
import { expectNoAxe } from "../testing/axe";
import {
  FOLDER,
  FOLDER_2,
  installFakeShell,
  itemId,
  PASSWORD,
  sampleItems,
  type FakeItem,
  type FakeShell,
  type FakeVault,
} from "../testing/fakeShell";

const { invoke, listen } = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

let shell: FakeShell;
let vault: FakeVault;

beforeEach(() => {
  for (const style of document.querySelectorAll("style")) style.remove();
  resetStoreForTests();
  invoke.mockReset();
  listen.mockReset();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-11T12:00:00Z"));
});

/** Made up and built here, so no value is written in a file as a literal; no word of the page is in any of them. */
const COPIED = ["demo", "copied", "token", "4821"].join("-");
const OTHER = ["demo", "second", "token", "9137"].join("-");
const OPENAI = itemId(40);
const OPENAI_2 = itemId(41);

const PAGE_WORDS = "Save what you copied";

/** The sample vault and a key named OPENAI_API_KEY in no folder (so saving under that name clashes). */
function withKey(): FakeItem[] {
  return [...sampleItems(), { id: OPENAI, kind: "key", title: "OPENAI_API_KEY", value: "old-openai", notes: "keep these notes", modified_at: "2026-10-01T09:00:00Z" }];
}

/** Renders the app on the lock screen and waits until the page is listening for the shortcut and has asked what waits. */
async function start(options: { vaults?: FakeVault[]; before?: (made: FakeShell) => void } = {}) {
  vault = { id: 7, name: "My vault", items: withKey() };
  shell = installFakeShell(invoke, listen, options.vaults ?? [vault]);
  options.before?.(shell);
  const view = render(<App />);
  await waitFor(() => {
    expect(shell.calls.some((call) => call.cmd === "capture_state")).toBe(true);
  });
  return view;
}

async function unlockNow() {
  const field = await screen.findByLabelText(/^Password for /);
  fireEvent.change(field, { target: { value: PASSWORD } });
  fireEvent.submit((field as HTMLInputElement).form as HTMLFormElement);
  await screen.findByRole("heading", { level: 1, name: "All items" });
}

async function startUnlocked(options: Parameters<typeof start>[0] = {}) {
  const view = await start(options);
  await unlockNow();
  return view;
}

/** The save shortcut pressed with `what` on the clipboard, as the page hears it. */
async function press(what: Parameters<FakeShell["press"]>[0]) {
  await act(async () => {
    shell.press(what);
    await Promise.resolve();
  });
}

async function boxPanel(): Promise<HTMLElement> {
  return screen.findByRole("complementary", { name: PAGE_WORDS });
}

function sent(cmd: string): Record<string, unknown>[] {
  return invoke.mock.calls.filter(([name]) => name === cmd).map(([, args]) => args as Record<string, unknown>);
}

function nameBox(panel: HTMLElement): HTMLInputElement {
  return within(panel).getByLabelText<HTMLInputElement>("Name");
}

function typeName(panel: HTMLElement, name: string) {
  fireEvent.change(nameBox(panel), { target: { value: name } });
}

function saveButton(panel: HTMLElement): HTMLElement {
  return within(panel).getByRole("button", { name: "Save" });
}

function toastText(): string {
  return document.querySelector(".tstack")?.textContent ?? "";
}

/** Everything a person or a screen reader could be given of the page now, and everything the store holds. */
function pageText(): string {
  const found: string[] = [document.documentElement.outerHTML, document.body.textContent, document.title, JSON.stringify(debugState())];
  for (const box of document.querySelectorAll("input, textarea")) found.push((box as HTMLInputElement).value);
  for (const element of document.querySelectorAll("*")) {
    for (const name of element.getAttributeNames()) found.push(element.getAttribute(name) ?? "");
  }
  return found.join("\n");
}

function expectNoValue(...values: string[]) {
  for (const value of values.length === 0 ? [COPIED] : values) expect(pageText(), value).not.toContain(value);
}

async function openMenu(button: HTMLElement): Promise<HTMLElement> {
  button.focus();
  fireEvent.pointerDown(button, { button: 0 });
  fireEvent.click(button);
  return screen.findByRole("menu");
}

async function pickFolder(panel: HTMLElement, name: string) {
  const list = await within(panel).findByRole("combobox", { name: "Folder" });
  fireEvent.pointerDown(list, { button: 0 });
  fireEvent.click(list);
  const options = await screen.findAllByRole("option");
  const option = options.find((one) => one.textContent === name);
  if (option === undefined) throw new Error(`no folder ${name}`);
  fireEvent.pointerDown(option);
  fireEvent.click(option);
  await waitFor(() => {
    expect(within(panel).getByRole("combobox", { name: "Folder" }).textContent).toBe(name);
  });
}

/** An event sent to the page as the shell would, whatever the fake's own slot holds. */
function fireCapture(event: object) {
  const registered = listen.mock.calls.find(([name]) => name === "lockbox://capture");
  const handler = registered?.[1] as ((event: { payload: unknown }) => void) | undefined;
  if (handler === undefined) throw new Error("the page is not listening for the shortcut");
  act(() => {
    handler({ payload: event });
  });
}

function stored(): FakeItem[] {
  return vault.items ?? [];
}

/** A fresh page and a fresh pretend shell for the next round of a test that goes round more than once. */
function again() {
  cleanup();
  resetStoreForTests();
  invoke.mockReset();
  listen.mockReset();
}

test("locked_shows_lock_screen_first", async () => {
  const { container } = await start();
  await press({ text: COPIED });
  // 8b: the lock screen with the save step, in the vault's place. No vault is open, so nothing is asked of any vault yet.
  expect(await screen.findByRole("heading", { level: 1, name: PAGE_WORDS })).toBeTruthy();
  expect(screen.getByText("Your copied key is held here until you save it or cancel.")).toBeTruthy();
  expect(screen.getByLabelText("Password for My vault")).toBeTruthy();
  expect(screen.getByText("A locked vault's folders can't be read until you unlock it.")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Unlock and continue" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  expect(screen.queryByRole("complementary")).toBeNull();
  expect(sent("capture_choose")).toEqual([]);
  expect(sent("capture_reveal")).toEqual([]);
  expectNoValue();
  await expectNoAxe(container);

  // After the unlock: 8a, and the copy is handed to the vault that opened.
  await unlockNow();
  const panel = await boxPanel();
  const live = shell.sessionOf(7);
  await waitFor(() => {
    expect(sent("capture_choose")).toEqual([{ session: live?.session, generation: live?.generation, capture_id: shell.captureSlot()?.id }]);
  });
  expect(shell.captureSlot()?.chosen).toBe(live?.session);
  expect(within(panel).getByRole("heading", { level: 2, name: PAGE_WORDS })).toBeTruthy();
  expectNoValue();
});

test("order_is_vault_then_password_then_name", async () => {
  const second: FakeVault = { id: 8, name: "Home", items: sampleItems() };
  await start({ vaults: [{ id: 7, name: "My vault", items: withKey() }, second] });
  await press({ text: COPIED });
  await screen.findByRole("heading", { level: 1, name: PAGE_WORDS });
  const vaultPick = screen.getAllByRole("radio")[0] as HTMLElement;
  const password = screen.getByLabelText("Password for My vault");
  // The vault comes before the password in the page, so it is reached first by keyboard and read first.
  expect(vaultPick.compareDocumentPosition(password) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  await unlockNow();
  const panel = await boxPanel();
  // Then the name, with focus: the vault is already known.
  await waitFor(() => {
    expect(document.activeElement).toBe(nameBox(panel));
  });
  // Copied value, Name, Vault, Folder, in that order.
  const order = ["Copied value", "Name", "Vault", "Folder"].map((label) => {
    const found = Array.from(panel.querySelectorAll("label, .flab")).find((element) => element.textContent.trim() === label);
    if (found === undefined) throw new Error(`no ${label}`);
    return found;
  });
  for (let at = 1; at < order.length; at += 1) {
    expect((order[at - 1] as Element).compareDocumentPosition(order[at] as Element) & Node.DOCUMENT_POSITION_FOLLOWING, String(at)).toBeTruthy();
  }
});

test("8a_has_the_drawn_fields_and_the_vault_as_text", async () => {
  const { container } = await startUnlocked();
  await press({ text: COPIED });
  const panel = await boxPanel();
  expect(within(panel).getByText("Copied value")).toBeTruthy();
  const name = nameBox(panel);
  expect(name.autocomplete).toBe("off");
  expect(name.getAttribute("spellcheck")).toBe("false");
  expect(name.placeholder).toBe("OPENAI_API_KEY");
  expect(name.classList.contains("m")).toBe(true);
  // The vault is the active one's name, as text and not a list to pick from (two open vaults is a later plan's).
  const vaultField = within(panel).getByLabelText<HTMLInputElement>("Vault");
  expect(vaultField.value).toBe("My vault");
  expect(vaultField.readOnly).toBe(true);
  expect(within(panel).getByRole("combobox", { name: "Folder" }).textContent).toBe("No folder");
  expect(within(panel).getAllByRole("button").map((button) => button.getAttribute("aria-label") ?? button.textContent)).toEqual([
    "Close panel",
    "Show",
    "Cancel",
    "Save",
  ]);
  // No style element, and no style attribute but the library's own hidden inputs for its lists, which it sets by script.
  const styled = Array.from(container.querySelectorAll("[style]")).filter(
    (element) => !(element instanceof HTMLInputElement && element.getAttribute("aria-hidden") === "true"),
  );
  expect(styled.map((element) => element.outerHTML)).toEqual([]);
  expect(container.querySelectorAll("style")).toHaveLength(0);
  await expectNoAxe(container);
});

test("value_hidden_until_reveal", async () => {
  await startUnlocked();
  // The copy has spaces and a line break around it, as a terminal or a web page can add: what is saved and shown is the trimmed text.
  await press({ text: `  ${COPIED}\r\n` });
  const panel = await boxPanel();
  expect(within(panel).getByRole("img", { name: "Value hidden" })).toBeTruthy();
  expect(sent("capture_reveal")).toEqual([]);
  expectNoValue();
  // Show asks the shell by the capture's id, and only now does the value come.
  fireEvent.click(within(panel).getByRole("button", { name: "Show" }));
  expect(await within(panel).findByText(COPIED)).toBeTruthy();
  expect(sent("capture_reveal")).toEqual([{ capture_id: shell.captureSlot()?.id }]);
  expect(within(panel).queryByRole("img", { name: "Value hidden" })).toBeNull();
  // Hide takes it off the page and out of the store.
  fireEvent.click(within(panel).getByRole("button", { name: "Hide" }));
  await waitFor(() => {
    expect(within(panel).getByRole("img", { name: "Value hidden" })).toBeTruthy();
  });
  expectNoValue();
});

test("stale_reveal_answer_dropped", async () => {
  await startUnlocked();
  await press({ text: COPIED });
  const panel = await boxPanel();
  const release = shell.holdCaptureReveal();
  fireEvent.click(within(panel).getByRole("button", { name: "Show" }));
  // A new value comes while the answer is on its way: the answer is for the old capture and must not show.
  await press({ text: OTHER });
  release();
  await act(async () => {
    await Promise.resolve();
  });
  expectNoValue(COPIED, OTHER);
  expect(within(panel).getByRole("img", { name: "Value hidden" })).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
});

test("slot_gone_wipes_the_box", async () => {
  await startUnlocked();
  await press({ text: COPIED });
  const panel = await boxPanel();
  typeName(panel, "TYPED_NAME");
  fireEvent.click(within(panel).getByRole("button", { name: "Show" }));
  await within(panel).findByText(COPIED);
  act(() => {
    shell.emptyCaptureSlot();
  });
  // The box closes with the value on it and nothing is said: a lock or another window took the copy.
  await waitFor(() => {
    expect(screen.queryByRole("complementary", { name: PAGE_WORDS })).toBeNull();
  });
  expectNoValue();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(toastText()).toBe("");
  expect(debugState().sessions[0]?.tool).toBeNull();
});

test("late_reveal_after_gone_is_dropped", async () => {
  await startUnlocked();
  await press({ text: COPIED });
  const panel = await boxPanel();
  const release = shell.holdCaptureReveal();
  fireEvent.click(within(panel).getByRole("button", { name: "Show" }));
  act(() => {
    shell.emptyCaptureSlot();
  });
  release();
  await act(async () => {
    await Promise.resolve();
  });
  expect(screen.queryByRole("complementary", { name: PAGE_WORDS })).toBeNull();
  expectNoValue();
  expect(screen.queryByRole("alert")).toBeNull();
});

test("gone_for_another_id_is_ignored", async () => {
  await startUnlocked();
  await press({ text: COPIED });
  const panel = await boxPanel();
  fireCapture({ capture_id: "f".repeat(32), state: "gone", changed: false, env_keys: null });
  expect(screen.getByRole("complementary", { name: PAGE_WORDS })).toBe(panel);
  expect(shell.captureSlot()).not.toBeNull();
});

test("a_revealed_value_is_wiped_by_a_lock", async () => {
  // Once with the shell's `gone` after the lock, as it sends it, and once with that event missed: the page ends the copy by the lock alone.
  for (const heardGone of [true, false]) {
    again();
    await startUnlocked();
    await press({ text: COPIED });
    const panel = await boxPanel();
    fireEvent.click(within(panel).getByRole("button", { name: "Show" }));
    await within(panel).findByText(COPIED);
    if (!heardGone) shell.forgetCaptureSlot();
    await act(async () => {
      shell.lock(shell.sessionOf(7)?.session ?? 0);
      await Promise.resolve();
    });
    // The lock screen, and not the save step: the copy went with the lock. Nothing of the value, no error.
    expect(await screen.findByRole("heading", { level: 1, name: "Unlock My vault" }), String(heardGone)).toBeTruthy();
    expect(screen.queryByRole("heading", { name: PAGE_WORDS })).toBeNull();
    expectNoValue();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(shell.captureSlot()).toBeNull();
    expect(debugState().capture).toBeNull();
  }
});

test("a_revealed_value_is_dropped_when_a_new_value_comes", async () => {
  await startUnlocked();
  await press({ text: COPIED });
  const panel = await boxPanel();
  fireEvent.click(within(panel).getByRole("button", { name: "Show" }));
  await within(panel).findByText(COPIED);
  await press({ text: OTHER });
  await waitFor(() => {
    expect(within(panel).getByRole("img", { name: "Value hidden" })).toBeTruthy();
  });
  expectNoValue(COPIED, OTHER);
});

test("changed_value_keeps_what_was_typed", async () => {
  await startUnlocked();
  await press({ text: COPIED });
  const panel = await boxPanel();
  typeName(panel, "MY_KEY");
  await pickFolder(panel, "Lineproof");
  const first = shell.captureSlot()?.id;
  await press({ text: OTHER });
  const second = shell.captureSlot()?.id;
  // The same panel, with the name and the folder as they were, and a note that says why the value is different.
  expect(screen.getByRole("complementary", { name: PAGE_WORDS })).toBe(panel);
  expect(nameBox(panel).value).toBe("MY_KEY");
  expect(within(panel).getByRole("combobox", { name: "Folder" }).textContent).toBe("Lineproof");
  expect(within(panel).getByRole("status").textContent).toBe("The copied value changed. What you typed is kept.");
  expect(second).not.toBe(first);
  // Save goes by the new id.
  fireEvent.click(saveButton(panel));
  await waitFor(() => {
    expect(sent("capture_save")).toHaveLength(1);
  });
  expect(sent("capture_save")[0]?.capture_id).toBe(second);
});

test("the_same_value_pressed_again_says_nothing_new", async () => {
  await startUnlocked();
  await press({ text: COPIED });
  const panel = await boxPanel();
  typeName(panel, "MY_KEY");
  await press({ text: ` ${COPIED} ` });
  expect(within(panel).getByRole("status").textContent).toBe("");
  expect(nameBox(panel).value).toBe("MY_KEY");
  fireEvent.click(saveButton(panel));
  await waitFor(() => {
    expect(sent("capture_save")).toHaveLength(1);
  });
  expect(sent("capture_save")[0]?.capture_id).toMatch(/^[0-9a-f]{32}$/);
});

test("clear_wording_matches_the_win_v_result", async () => {
  await startUnlocked();
  await press({ text: COPIED });
  const panel = await boxPanel();
  const tick = within(panel).getByRole<HTMLInputElement>("checkbox", { name: "Clear the clipboard after saving" });
  // On to begin with, and the hint says what Windows may still hold.
  expect(tick.checked).toBe(true);
  const hint = "Windows clipboard history may keep its own copy, if you've turned it on.";
  expect(within(panel).getByText(hint)).toBeTruthy();
  const describedBy = tick.getAttribute("aria-describedby") ?? "";
  expect(document.getElementById(describedBy)?.textContent).toBe(hint);
  // What the tick says is what is sent.
  typeName(panel, "SOME_KEY");
  fireEvent.click(tick);
  fireEvent.click(saveButton(panel));
  await waitFor(() => {
    expect(sent("capture_save")).toHaveLength(1);
  });
  expect(sent("capture_save")[0]?.clear_clipboard).toBe(false);
});

test("empty_box_says_so", async () => {
  const { container } = await startUnlocked();
  await press("empty");
  const panel = await boxPanel();
  expect(within(panel).getByText("Nothing to save was copied. Paste or type the value here.")).toBeTruthy();
  // 8c: no Copied value row and no clear tick box; a Value box that hides what is typed instead.
  expect(within(panel).queryByText("Copied value")).toBeNull();
  expect(within(panel).queryByRole("checkbox")).toBeNull();
  const value = within(panel).getByLabelText<HTMLInputElement>("Value");
  expect(value.type).toBe("password");
  expect(value.placeholder).toBe("Paste the key");
  await waitFor(() => {
    expect(document.activeElement).toBe(value);
  });
  await expectNoAxe(container);

  // Saving with nothing typed is said in words, from the shell's refusal; nothing was written.
  typeName(panel, "TYPED_KEY");
  fireEvent.click(saveButton(panel));
  expect((await within(panel).findByRole("alert")).textContent).toBe("Paste or type the value first.");
  expect(sent("capture_save")[0]?.typed).toBe("");
  expect(stored().some((item) => item.title === "TYPED_KEY")).toBe(false);

  // Typed, it goes as `typed`, and there is no clipboard to clear.
  fireEvent.change(value, { target: { value: COPIED } });
  fireEvent.click(saveButton(panel));
  await waitFor(() => {
    expect(stored().some((item) => item.title === "TYPED_KEY" && item.value === COPIED)).toBe(true);
  });
  const calls = sent("capture_save");
  expect(calls[1]?.typed).toBe(COPIED);
  expect(calls[1]?.clear_clipboard).toBe(false);
  expectNoValue();
});

test("too_large_says_so_and_takes_a_typed_value", async () => {
  await startUnlocked();
  await press("too_large");
  const panel = await boxPanel();
  expect(within(panel).getByText("What you copied is too big to save as a key. Paste or type the value here.")).toBeTruthy();
  expect(within(panel).queryByText("Copied value")).toBeNull();
  expect(within(panel).getByLabelText("Value")).toBeTruthy();
});

test("a_value_that_arrives_after_an_empty_box_is_saved_as_the_capture", async () => {
  await startUnlocked();
  await press("empty");
  const panel = await boxPanel();
  fireEvent.change(within(panel).getByLabelText("Value"), { target: { value: OTHER } });
  typeName(panel, "LATER_KEY");
  await press({ text: COPIED });
  // The copy now is a value: the Copied value row is back, and what was typed in the Value box is not sent.
  expect(within(panel).getByText("Copied value")).toBeTruthy();
  expect(within(panel).queryByLabelText("Value")).toBeNull();
  expect(nameBox(panel).value).toBe("LATER_KEY");
  fireEvent.click(saveButton(panel));
  await waitFor(() => {
    expect(stored().some((item) => item.title === "LATER_KEY" && item.value === COPIED)).toBe(true);
  });
  expect(sent("capture_save")[0]?.typed).toBeNull();
});

test("saved_shows_8e", async () => {
  await startUnlocked();
  shell.setClipboard(COPIED);
  await press({ text: COPIED });
  const panel = await boxPanel();
  typeName(panel, "BRAND_NEW_KEY");
  fireEvent.click(saveButton(panel));
  // The box closes and the new key is the one selected, in its panel, with the toast above the list.
  await waitFor(() => {
    expect(screen.queryByRole("complementary", { name: PAGE_WORDS })).toBeNull();
  });
  expect(await screen.findByRole("complementary", { name: "BRAND_NEW_KEY" })).toBeTruthy();
  const row = (await screen.findAllByText("BRAND_NEW_KEY")).map((found) => found.closest("[aria-current]")).find((found) => found !== null);
  expect(row?.getAttribute("aria-current")).toBe("true");
  expect(toastText()).toContain("BRAND_NEW_KEY saved in My vault. Clipboard cleared.");
  // The shell wrote it, with the trimmed text, emptied the slot, and cleared the clipboard it had just read.
  expect(stored().find((item) => item.title === "BRAND_NEW_KEY")?.value).toBe(COPIED);
  expect(shell.clipboard()).toBeNull();
  expect(shell.captureSlot()).toBeNull();
  expectNoValue();
  const call = sent("capture_save")[0];
  expect(Object.keys(call ?? {}).sort()).toEqual(["capture_id", "clear_clipboard", "collection", "generation", "name", "on_clash", "session", "typed"]);
  expect(call).toMatchObject({ name: "BRAND_NEW_KEY", collection: null, on_clash: "ask", clear_clipboard: true, typed: null });
});

test("saved_in_a_folder_says_the_folder", async () => {
  await startUnlocked();
  await press({ text: COPIED });
  const panel = await boxPanel();
  typeName(panel, "FOLDER_KEY");
  await pickFolder(panel, "Lineproof");
  fireEvent.click(saveButton(panel));
  await waitFor(() => {
    expect(toastText()).toContain("FOLDER_KEY saved in Lineproof");
  });
  expect(stored().find((item) => item.title === "FOLDER_KEY")?.collection).toBe(FOLDER_2);
  expect(sent("capture_save")[0]?.collection).toBe(FOLDER_2);
});

test("the_toast_says_what_became_of_the_clipboard", async () => {
  const cases: { how: string; before: () => void; untick: boolean; sentence: string }[] = [
    { how: "cleared", before: () => undefined, untick: false, sentence: "KEY_ONE saved in My vault. Clipboard cleared." },
    {
      how: "not_ours",
      before: () => {
        shell.setClipboard(OTHER);
      },
      untick: false,
      sentence: "KEY_ONE saved in My vault. The clipboard had changed, so it was left alone.",
    },
    {
      how: "failed",
      before: () => {
        shell.failClipboardClearNext();
      },
      untick: false,
      sentence: "KEY_ONE saved in My vault. The clipboard couldn't be cleared.",
    },
    { how: "not_asked", before: () => undefined, untick: true, sentence: "KEY_ONE saved in My vault" },
  ];
  for (const one of cases) {
    again();
    await startUnlocked();
    shell.setClipboard(COPIED);
    await press({ text: COPIED });
    const panel = await boxPanel();
    one.before();
    typeName(panel, "KEY_ONE");
    if (one.untick) fireEvent.click(within(panel).getByRole("checkbox", { name: "Clear the clipboard after saving" }));
    fireEvent.click(saveButton(panel));
    await waitFor(() => {
      expect(toastText(), one.how).toContain("KEY_ONE saved in");
    });
    expect(toastText(), one.how).toBe(one.sentence);
    // The text on the clipboard stays unless it was cleared.
    expect(shell.clipboard() === null, one.how).toBe(one.how === "cleared");
    if (one.how === "failed") expect(screen.getByRole("alert").textContent).toContain("couldn't be cleared");
  }
});

test("name_clash_offers_replace_keep_both_cancel", async () => {
  const { container } = await startUnlocked();
  await press({ text: COPIED });
  const panel = await boxPanel();
  typeName(panel, "OPENAI_API_KEY");
  fireEvent.click(saveButton(panel));
  const dialog = await screen.findByRole("dialog");
  // 8d: the title names the key, the body says what each button does with the name Keep both would give, and nothing is written.
  expect(within(dialog).getByText("This folder already has OPENAI_API_KEY")).toBeTruthy();
  expect(dialog.textContent).toContain("Replace puts this value in the old one's place. Keep both saves this as OPENAI_API_KEY_2.");
  expect(within(dialog).getAllByRole("button").map((button) => button.textContent)).toEqual(["Cancel", "Keep both", "Replace"]);
  expect(stored().filter((item) => item.title.startsWith("OPENAI_API_KEY"))).toHaveLength(1);
  expect(sent("capture_save")[0]?.on_clash).toBe("ask");
  expectNoValue();
  await expectNoAxe(container);

  // Cancel closes the question only: the box is still there with what was typed, and the copy is still waiting.
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(screen.getByRole("complementary", { name: PAGE_WORDS })).toBe(panel);
  expect(nameBox(panel).value).toBe("OPENAI_API_KEY");
  expect(sent("capture_cancel")).toEqual([]);
  expect(shell.captureSlot()).not.toBeNull();
});

test("replace_sends_replace_and_keeps_the_notes", async () => {
  await startUnlocked();
  await press({ text: COPIED });
  const panel = await boxPanel();
  typeName(panel, "OPENAI_API_KEY");
  fireEvent.click(saveButton(panel));
  fireEvent.click(await within(await screen.findByRole("dialog")).findByRole("button", { name: "Replace" }));
  await waitFor(() => {
    expect(toastText()).toContain("OPENAI_API_KEY saved in My vault");
  });
  expect(sent("capture_save").map((call) => call.on_clash)).toEqual(["ask", "replace"]);
  const key = stored().find((item) => item.title === "OPENAI_API_KEY");
  expect(key?.value).toBe(COPIED);
  expect(key?.notes).toBe("keep these notes");
  expect(stored().filter((item) => item.title === "OPENAI_API_KEY")).toHaveLength(1);
});

test("keep_both_sends_the_name_it_showed", async () => {
  await startUnlocked();
  await press({ text: COPIED });
  const panel = await boxPanel();
  typeName(panel, "OPENAI_API_KEY");
  fireEvent.click(saveButton(panel));
  fireEvent.click(await within(await screen.findByRole("dialog")).findByRole("button", { name: "Keep both" }));
  await waitFor(() => {
    expect(toastText()).toContain("OPENAI_API_KEY_2 saved in My vault");
  });
  expect(sent("capture_save")[1]?.on_clash).toEqual({ keep_both: "OPENAI_API_KEY_2" });
  expect(stored().find((item) => item.title === "OPENAI_API_KEY")?.value).toBe("old-openai");
  expect(stored().find((item) => item.title === "OPENAI_API_KEY_2")?.value).toBe(COPIED);
});

test("a_second_clash_updates_the_name_in_the_dialog", async () => {
  await startUnlocked();
  await press({ text: COPIED });
  const panel = await boxPanel();
  typeName(panel, "OPENAI_API_KEY");
  fireEvent.click(saveButton(panel));
  const dialog = await screen.findByRole("dialog");
  // Another key lands on the number the dialog showed while it was open: Keep both writes nothing and shows the next free one.
  vault.items = [...stored(), { id: OPENAI_2, kind: "key", title: "OPENAI_API_KEY_2", value: "other", modified_at: "2026-10-02T09:00:00Z" }];
  fireEvent.click(within(dialog).getByRole("button", { name: "Keep both" }));
  await waitFor(() => {
    expect(dialog.textContent).toContain("Keep both saves this as OPENAI_API_KEY_3.");
  });
  expect(screen.getByRole("dialog")).toBe(dialog);
  expect(stored().filter((item) => item.title.startsWith("OPENAI_API_KEY"))).toHaveLength(2);
  // The panel is still there behind the question (a dialog hides the page from a screen reader, so it is not looked up by role now).
  expect(panel.isConnected).toBe(true);
  // Pressed again, it sends the number it now shows.
  fireEvent.click(within(dialog).getByRole("button", { name: "Keep both" }));
  await waitFor(() => {
    expect(toastText()).toContain("OPENAI_API_KEY_3 saved in My vault");
  });
  expect(sent("capture_save").map((call) => call.on_clash)).toEqual(["ask", { keep_both: "OPENAI_API_KEY_2" }, { keep_both: "OPENAI_API_KEY_3" }]);
});

test("a_name_the_shell_refuses_is_marked_and_the_box_stays", async () => {
  await startUnlocked();
  await press({ text: COPIED });
  const panel = await boxPanel();
  typeName(panel, "9 bad name");
  fireEvent.click(saveButton(panel));
  const alert = await within(panel).findByRole("alert");
  expect(alert.textContent).toBe("That isn't a name Lockbox can use for a key. Use letters, digits and _ only, and don't start with a digit.");
  expect(nameBox(panel).getAttribute("aria-invalid")).toBe("true");
  expect(shell.captureSlot()).not.toBeNull();
  // Nothing typed at all is asked for before anything is sent.
  typeName(panel, "  ");
  fireEvent.click(saveButton(panel));
  expect((await within(panel).findByRole("alert")).textContent).toBe("Type a name first.");
  expect(sent("capture_save")).toHaveLength(1);
});

test("cancel_on_the_lock_screen_lets_go_of_the_copy", async () => {
  await start();
  await press({ text: COPIED });
  await screen.findByRole("heading", { level: 1, name: PAGE_WORDS });
  const id = shell.captureSlot()?.id;
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(await screen.findByRole("heading", { level: 1, name: "Unlock My vault" })).toBeTruthy();
  expect(sent("capture_cancel")).toEqual([{ capture_id: id }]);
  expect(shell.captureSlot()).toBeNull();
  expectNoValue();
});

test("cancel_the_close_button_and_escape_let_go_of_the_copy", async () => {
  for (const how of ["Cancel", "Close panel", "Escape"]) {
    again();
    await startUnlocked();
    await press({ text: COPIED });
    const panel = await boxPanel();
    const id = shell.captureSlot()?.id;
    if (how === "Escape") fireEvent.keyDown(nameBox(panel), { key: "Escape" });
    else fireEvent.click(within(panel).getByRole("button", { name: how }));
    await waitFor(() => {
      expect(screen.queryByRole("complementary", { name: PAGE_WORDS })).toBeNull();
    });
    expect(sent("capture_cancel"), how).toEqual([{ capture_id: id }]);
    expect(shell.captureSlot(), how).toBeNull();
  }
});

test("another_panel_taking_the_place_lets_go_of_the_copy", async () => {
  await startUnlocked();
  await press({ text: COPIED });
  await boxPanel();
  const id = shell.captureSlot()?.id;
  const menu = await openMenu(screen.getByRole("button", { name: "Add" }));
  fireEvent.click(within(menu).getByRole("menuitem", { name: "Note" }));
  await screen.findByRole("complementary", { name: "New note" });
  await waitFor(() => {
    expect(sent("capture_cancel")).toEqual([{ capture_id: id }]);
  });
  expect(shell.captureSlot()).toBeNull();
});

test("the_box_opening_in_strict_mode_does_not_let_go_of_the_copy", async () => {
  vault = { id: 7, name: "My vault", items: withKey() };
  shell = installFakeShell(invoke, listen, [vault]);
  render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
  await waitFor(() => {
    expect(shell.calls.some((call) => call.cmd === "capture_state")).toBe(true);
  });
  await unlockNow();
  await press({ text: COPIED });
  await boxPanel();
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(sent("capture_cancel")).toEqual([]);
  expect(shell.captureSlot()).not.toBeNull();
  expect(screen.getByRole("complementary", { name: PAGE_WORDS })).toBeTruthy();
});

test("capture_state_is_asked_on_start_and_a_waiting_copy_is_shown", async () => {
  await start({
    before: (made) => {
      made.press({ text: COPIED });
    },
  });
  // Heard after the listener was set, so a press that comes between is not lost.
  const order = shell.calls.map((call) => call.cmd);
  expect(order.indexOf("listen:lockbox://capture")).toBeGreaterThanOrEqual(0);
  expect(order.indexOf("listen:lockbox://capture")).toBeLessThan(order.indexOf("capture_state"));
  expect(await screen.findByRole("heading", { level: 1, name: PAGE_WORDS })).toBeTruthy();
  expectNoValue();
});

test("no_vault_at_all_cancels_the_capture_and_shows_nothing", async () => {
  await start({ vaults: [] });
  await press({ text: COPIED });
  await waitFor(() => {
    expect(sent("capture_cancel")).toHaveLength(1);
  });
  expect(shell.captureSlot()).toBeNull();
  expect(screen.queryByText(PAGE_WORDS)).toBeNull();
  expectNoValue();
});

test("a_read_only_vault_cannot_take_the_copy", async () => {
  await startUnlocked({ vaults: [{ id: 7, name: "My vault", items: sampleItems(), readOnly: true }] });
  await press({ text: COPIED });
  expect((await screen.findByRole("alert")).textContent).toContain("This vault is read-only.");
  expect(screen.queryByRole("complementary", { name: PAGE_WORDS })).toBeNull();
  expect(sent("capture_choose")).toEqual([]);
  expect(shell.captureSlot()).toBeNull();
});

test("a_slot_the_shell_no_longer_has_closes_the_box_quietly", async () => {
  await startUnlocked();
  await press({ text: COPIED });
  const panel = await boxPanel();
  typeName(panel, "SOME_KEY");
  // The page missed the `gone` event: the save finds nothing, asks what waits, and the box goes with nothing said.
  shell.forgetCaptureSlot();
  fireEvent.click(saveButton(panel));
  await waitFor(() => {
    expect(screen.queryByRole("complementary", { name: PAGE_WORDS })).toBeNull();
  });
  expect(screen.queryByRole("alert")).toBeNull();
  expect(sent("capture_state").length).toBeGreaterThanOrEqual(2);
  expectNoValue();
});

test("a_folder_that_is_gone_says_so_and_the_box_stays", async () => {
  await startUnlocked();
  await press({ text: COPIED });
  const panel = await boxPanel();
  typeName(panel, "SOME_KEY");
  await pickFolder(panel, "Lineproof");
  vault.items = stored().filter((item) => item.id !== FOLDER_2);
  fireEvent.click(saveButton(panel));
  // The shell said not found, but the copy is still waiting: it was the folder.
  expect((await within(panel).findByRole("alert")).textContent).toBe("Lockbox can't find that. It may have been moved or deleted.");
  expect(screen.getByRole("complementary", { name: PAGE_WORDS })).toBe(panel);
  expect(shell.captureSlot()).not.toBeNull();
});

test("a_lock_during_a_save_says_nothing_and_leaves_nothing_of_the_value", async () => {
  await startUnlocked();
  await press({ text: COPIED });
  const panel = await boxPanel();
  typeName(panel, "SOME_KEY");
  const release = shell.holdNewItem();
  fireEvent.click(saveButton(panel));
  await act(async () => {
    shell.lock(shell.sessionOf(7)?.session ?? 0);
    await Promise.resolve();
  });
  release();
  expect(await screen.findByRole("heading", { level: 1, name: "Unlock My vault" })).toBeTruthy();
  await act(async () => {
    await Promise.resolve();
  });
  expect(screen.queryByRole("alert")).toBeNull();
  expect(toastText()).toBe("");
  expectNoValue();
});

test("a_save_that_a_lock_overtook_comes_back_stale_and_says_nothing", async () => {
  await startUnlocked();
  await press({ text: COPIED });
  await boxPanel();
  const live = shell.sessionOf(7);
  const release = shell.holdNewItem();
  const result = saveCapture(
    live?.session ?? 0,
    { captureId: shell.captureSlot()?.id ?? "", name: "SOME_KEY", collection: null, onClash: "ask", clearClipboard: true, typed: null },
    "My vault",
  );
  await act(async () => {
    shell.lock(live?.session ?? 0);
    await Promise.resolve();
  });
  release();
  // What the store hands back is the screen's only news of it: a lock, with nothing said and nothing opened.
  await expect(result).resolves.toBe("stale");
  expect(toastText()).toBe("");
  expect(debugState().toast).toBeNull();
});

test("the_value_never_reaches_a_log_a_title_or_a_label", async () => {
  const logs = [vi.spyOn(console, "log"), vi.spyOn(console, "error"), vi.spyOn(console, "warn"), vi.spyOn(console, "info")];
  await startUnlocked();
  await press({ text: COPIED });
  const panel = await boxPanel();
  fireEvent.click(within(panel).getByRole("button", { name: "Show" }));
  await within(panel).findByText(COPIED);
  // Everything but the one place the person asked it to be shown.
  const rest = pageText().split(COPIED);
  expect(rest.length).toBeLessThanOrEqual(3);
  expect(document.title).not.toContain(COPIED);
  for (const element of document.querySelectorAll("*")) {
    for (const name of element.getAttributeNames()) expect(element.getAttribute(name) ?? "", name).not.toContain(COPIED);
  }
  for (const spy of logs) expect(JSON.stringify(spy.mock.calls)).not.toContain(COPIED);
  for (const spy of logs) spy.mockRestore();
});

test("shortcut_taken_notice_shows", async () => {
  const { container } = await start({
    before: (made) => {
      made.setLaunchNotices([{ kind: "shortcut_taken" }]);
    },
  });
  const words = "Ctrl+Shift+L is used by another app, so the save shortcut is off. Close that app and restart Lockbox to use it.";
  // On the lock screen, as the other launch notices are, and again in the vault once it opens, until it is closed.
  expect(await screen.findByText(words)).toBeTruthy();
  await expectNoAxe(container);
  await unlockNow();
  expect(screen.getByText(words)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(screen.queryByText(words)).toBeNull();
});

test("shortcut_not_set_notice_shows", async () => {
  await start();
  act(() => {
    shell.tell({ kind: "shortcut_not_set" });
  });
  const words = "The save shortcut couldn't be turned on. Restart Lockbox to try again.";
  expect(await screen.findByText(words)).toBeTruthy();
  // Not the "taken" words: it is never called taken for another reason.
  expect(screen.queryByText(/used by another app/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(screen.queryByText(words)).toBeNull();
});

/** The text of a `.env` of made-up values, built here so none is written as a literal. */
const ENV_NAMES = ["TELEGRAM_BOT_TOKEN", "WEBHOOK_URL", "REDIS_URL"];
const envValue = (name: string): string => ["demo", name.toLowerCase(), String(name.length * 1111)].join("-");
const ENV_TEXT = ENV_NAMES.map((name) => `${name}=${envValue(name)}`).join("\n");

test("env_keys_offers_save_as_separate_keys", async () => {
  await startUnlocked();
  await press({ text: ENV_TEXT });
  const panel = await boxPanel();
  expect(within(panel).getByText("This looks like a .env file with 3 keys.")).toBeTruthy();
  expect(within(panel).getByRole("button", { name: "Save as separate keys" })).toBeTruthy();
  // One key says "1 key", and a plain value (no .env in it) offers nothing.
  await press({ text: "ONLY_ONE=demo-only-1" });
  expect(within(panel).getByText("This looks like a .env file with 1 key.")).toBeTruthy();
  await press({ text: COPIED });
  expect(within(panel).queryByText(/looks like a \.env/)).toBeNull();
  expect(within(panel).queryByRole("button", { name: "Save as separate keys" })).toBeNull();
  // Nor does a copy with no value at all.
  await press("empty");
  expect(within(panel).queryByRole("button", { name: "Save as separate keys" })).toBeNull();
});

test("save_as_separate_keys_opens_the_paste_panel_on_the_rows", async () => {
  const { container } = await startUnlocked();
  shell.setClipboard(ENV_TEXT);
  await press({ text: ENV_TEXT });
  const panel = await boxPanel();
  await pickFolder(panel, "Agency support agent");
  fireEvent.click(within(panel).getByRole("button", { name: "Save as separate keys" }));
  const paste = await screen.findByRole("complementary", { name: "Paste a .env" });
  const live = shell.sessionOf(7);
  expect(sent("capture_env")).toHaveLength(1);
  expect(sent("capture_env")[0]).toMatchObject({ session: live?.session, generation: live?.generation });
  // The rows as if they had been pasted: names, values hidden, no paste box, and the folder that was chosen.
  expect(within(paste).getByRole("heading", { level: 3, name: "3 keys found" })).toBeTruthy();
  expect(within(paste).queryByLabelText("Paste your .env here")).toBeNull();
  expect(within(paste).getAllByRole("img", { name: "Value hidden" })).toHaveLength(3);
  expect(within(paste).getByRole("combobox", { name: "Folder" }).textContent).toBe("Agency support agent");
  // The copy moved into the paste, so the shell's slot is empty and the save box is gone.
  expect(shell.captureSlot()).toBeNull();
  expect(screen.queryByRole("complementary", { name: PAGE_WORDS })).toBeNull();
  expect(shell.envHeld()).toBe(1);
  expectNoValue(...ENV_NAMES.map(envValue));
  await expectNoAxe(container);
  // Saving it is the paste panel's save, with the tick as it stands (on), and the clipboard is cleared.
  fireEvent.click(within(paste).getByRole("button", { name: "Save 3 keys" }));
  await waitFor(() => {
    expect(toastText()).toContain("Saved 3 keys to Agency support agent. Clipboard cleared.");
  });
  expect(sent("env_save")[0]?.clear_clipboard).toBe(true);
  expect(shell.clipboard()).toBeNull();
  expect(stored().filter((item) => ENV_NAMES.includes(item.title) && item.collection === FOLDER)).toHaveLength(3);
});

test("save_as_separate_keys_then_cancel_lets_go_of_the_values", async () => {
  await startUnlocked();
  await press({ text: ENV_TEXT });
  const panel = await boxPanel();
  fireEvent.click(within(panel).getByRole("button", { name: "Save as separate keys" }));
  const paste = await screen.findByRole("complementary", { name: "Paste a .env" });
  await within(paste).findByRole("heading", { level: 3, name: "3 keys found" });
  fireEvent.click(within(paste).getByRole("button", { name: "Cancel" }));
  await waitFor(() => {
    expect(shell.envHeld()).toBe(0);
  });
  expect(sent("env_save")[0]).toMatchObject({ clear_clipboard: false });
  expect(stored().some((item) => ENV_NAMES.includes(item.title))).toBe(false);
});

test("the_paste_panel_opened_from_a_copy_keeps_its_values_in_strict_mode", async () => {
  vault = { id: 7, name: "My vault", items: withKey() };
  shell = installFakeShell(invoke, listen, [vault]);
  render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
  await waitFor(() => {
    expect(shell.calls.some((call) => call.cmd === "capture_state")).toBe(true);
  });
  await unlockNow();
  await press({ text: ENV_TEXT });
  const panel = await boxPanel();
  fireEvent.click(within(panel).getByRole("button", { name: "Save as separate keys" }));
  await screen.findByRole("complementary", { name: "Paste a .env" });
  await new Promise((resolve) => setTimeout(resolve, 30));
  // React's trial unmount in development must not let the values go.
  expect(shell.envHeld()).toBe(1);
  expect(sent("env_save")).toEqual([]);
});

/** Opens Paste a .env on the folder's menu, as the existing tests do, and pastes `text`. */
async function pasteInPanel(text: string): Promise<HTMLElement> {
  const menu = await openMenu(screen.getByRole("button", { name: "Add" }));
  fireEvent.click(within(menu).getByRole("menuitem", { name: "Paste a .env" }));
  const panel = await screen.findByRole("complementary", { name: "Paste a .env" });
  fireEvent.paste(within(panel).getByLabelText("Paste your .env here"), { clipboardData: { getData: () => text } });
  await within(panel).findByRole("heading", { level: 3 });
  await within(panel).findByRole("combobox", { name: "Folder" });
  return panel;
}

test("the_paste_panel_has_the_clear_tick_on_by_default", async () => {
  await startUnlocked();
  shell.setClipboard(ENV_TEXT);
  const panel = await pasteInPanel(ENV_TEXT);
  const tick = within(panel).getByRole<HTMLInputElement>("checkbox", { name: "Clear the clipboard after saving" });
  expect(tick.checked).toBe(true);
  const hint = "Windows clipboard history may keep its own copy, if you've turned it on.";
  expect(document.getElementById(tick.getAttribute("aria-describedby") ?? "")?.textContent).toBe(hint);
  fireEvent.click(within(panel).getByRole("button", { name: "Save 3 keys" }));
  await waitFor(() => {
    expect(toastText()).toContain("Saved 3 keys to No folder. Clipboard cleared.");
  });
  expect(sent("env_save")[0]?.clear_clipboard).toBe(true);
  expect(shell.clipboard()).toBeNull();
});

test("the_paste_panel_says_what_became_of_the_clipboard", async () => {
  const cases: { how: string; before: () => void; untick: boolean; sentence: string }[] = [
    {
      how: "not_ours",
      before: () => {
        shell.setClipboard(OTHER);
      },
      untick: false,
      sentence: "Saved 3 keys to No folder. The clipboard had changed, so it was left alone.",
    },
    {
      how: "failed",
      before: () => {
        shell.failClipboardClearNext();
      },
      untick: false,
      sentence: "Saved 3 keys to No folder. The clipboard couldn't be cleared.",
    },
    { how: "not_asked", before: () => undefined, untick: true, sentence: "Saved 3 keys to No folder" },
  ];
  for (const one of cases) {
    again();
    await startUnlocked();
    shell.setClipboard(ENV_TEXT);
    const panel = await pasteInPanel(ENV_TEXT);
    one.before();
    if (one.untick) fireEvent.click(within(panel).getByRole("checkbox", { name: "Clear the clipboard after saving" }));
    fireEvent.click(within(panel).getByRole("button", { name: "Save 3 keys" }));
    await waitFor(() => {
      expect(toastText(), one.how).toContain("Saved 3 keys");
    });
    expect(toastText(), one.how).toBe(one.sentence);
    expect(sent("env_save")[0]?.clear_clipboard, one.how).toBe(!one.untick);
  }
});

test("the_paste_panel_reads_a_windows_clipboard_with_crlf", async () => {
  await startUnlocked();
  // Windows' clipboard has CRLF; the page's paste may have LF: the clear still finds them the same.
  shell.setClipboard(ENV_TEXT.replace(/\n/g, "\r\n"));
  const panel = await pasteInPanel(ENV_TEXT);
  fireEvent.click(within(panel).getByRole("button", { name: "Save 3 keys" }));
  await waitFor(() => {
    expect(toastText()).toContain("Clipboard cleared.");
  });
  expect(shell.clipboard()).toBeNull();
});

test("cancelling_the_paste_panel_never_asks_for_a_clear", async () => {
  await startUnlocked();
  shell.setClipboard(ENV_TEXT);
  const panel = await pasteInPanel(ENV_TEXT);
  fireEvent.click(within(panel).getByRole("button", { name: "Cancel" }));
  await waitFor(() => {
    expect(shell.envHeld()).toBe(0);
  });
  expect(sent("env_save")[0]?.clear_clipboard).toBe(false);
  expect(shell.clipboard()).toBe(ENV_TEXT);
});

test("every_capture_command_is_sent_in_the_shape_the_connection_names", async () => {
  await startUnlocked();
  await press({ text: COPIED });
  const panel = await boxPanel();
  typeName(panel, "SHAPE_KEY");
  fireEvent.click(within(panel).getByRole("button", { name: "Show" }));
  await within(panel).findByText(COPIED);
  fireEvent.click(saveButton(panel));
  await waitFor(() => {
    expect(toastText()).toContain("SHAPE_KEY saved");
  });
  const live = shell.sessionOf(7);
  const id = sent("capture_reveal")[0]?.capture_id;
  expect(id).toMatch(/^[0-9a-f]{32}$/);
  expect(sent("capture_state")[0]).toEqual({});
  expect(sent("capture_choose")[0]).toEqual({ session: live?.session, generation: live?.generation, capture_id: id });
  expect(sent("capture_save")[0]).toEqual({
    session: live?.session,
    generation: live?.generation,
    capture_id: id,
    name: "SHAPE_KEY",
    collection: null,
    on_clash: "ask",
    clear_clipboard: true,
    typed: null,
  });
  // Saved: the slot is empty, so no cancel goes after it.
  expect(sent("capture_cancel")).toEqual([]);
});

test("the_folder_list_is_the_vaults_folders_and_no_folder", async () => {
  await startUnlocked();
  await press({ text: COPIED });
  const panel = await boxPanel();
  const list = await within(panel).findByRole("combobox", { name: "Folder" });
  fireEvent.pointerDown(list, { button: 0 });
  fireEvent.click(list);
  const options = await screen.findAllByRole("option");
  expect(options.map((one) => one.textContent)).toEqual(["No folder", "Agency support agent", "Lineproof"]);
});

// ---- The fix round: the review's five findings, and Esc on the lock screen's save step ----

/** Lets what is on its way settle: answers that were held and released, and the effects they cause. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

test("a_second_press_closes_the_clash_question_and_replace_needs_a_fresh_save", async () => {
  await startUnlocked();
  await press({ text: COPIED });
  const panel = await boxPanel();
  typeName(panel, "OPENAI_API_KEY");
  fireEvent.click(saveButton(panel));
  await screen.findByRole("dialog");
  // Another copy comes while the question is open: it was asked about the first value, so it goes, and nothing is sent for the second.
  await press({ text: OTHER });
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(sent("capture_save")).toHaveLength(1);
  expect(stored().find((item) => item.title === "OPENAI_API_KEY")?.value).toBe("old-openai");
  // The person saves again, and is asked again, about the new copy; only then does Replace mean anything.
  fireEvent.click(saveButton(panel));
  const dialog = await screen.findByRole("dialog");
  expect(sent("capture_save").map((call) => call.on_clash)).toEqual(["ask", "ask"]);
  expect(sent("capture_save")[1]?.capture_id).toBe(shell.captureSlot()?.id);
  fireEvent.click(within(dialog).getByRole("button", { name: "Replace" }));
  await waitFor(() => {
    expect(stored().find((item) => item.title === "OPENAI_API_KEY")?.value).toBe(OTHER);
  });
});

test("a_clash_answer_that_comes_after_a_second_press_opens_no_question", async () => {
  await startUnlocked();
  await press({ text: COPIED });
  const panel = await boxPanel();
  typeName(panel, "OPENAI_API_KEY");
  const release = shell.holdNewItem();
  fireEvent.click(saveButton(panel));
  await press({ text: OTHER });
  release();
  await settle();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(sent("capture_save")).toHaveLength(1);
  // The box is free again: Save works at once.
  fireEvent.click(saveButton(panel));
  await screen.findByRole("dialog");
  expect(sent("capture_save")).toHaveLength(2);
});

test("a_save_that_finishes_after_a_new_copy_does_not_take_its_box", async () => {
  await startUnlocked();
  await press({ text: COPIED });
  const first = await boxPanel();
  typeName(first, "FIRST_KEY");
  const release = shell.holdNewItem();
  fireEvent.click(saveButton(first));
  // The first copy is saved and gone; a second is copied and its box opens, with a name typed in it, before the first save is answered.
  await waitFor(() => {
    expect(shell.captureSlot()).toBeNull();
  });
  await press({ text: OTHER });
  await waitFor(() => {
    expect(first.isConnected).toBe(false);
  });
  const second = await boxPanel();
  typeName(second, "SECOND_KEY");
  release();
  await settle();
  // The first is saved and said, and the second box is as it was: its copy still waiting, nothing let go.
  expect(toastText()).toContain("FIRST_KEY saved in My vault");
  expect(stored().some((item) => item.title === "FIRST_KEY")).toBe(true);
  expect(screen.getByRole("complementary", { name: PAGE_WORDS })).toBe(second);
  expect(nameBox(second).value).toBe("SECOND_KEY");
  expect(screen.queryByRole("complementary", { name: "FIRST_KEY" })).toBeNull();
  expect(shell.captureSlot()?.state).toBe("value");
  expect(sent("capture_cancel")).toEqual([]);
});

test("a_save_that_finishes_after_another_form_opened_leaves_that_form", async () => {
  await startUnlocked();
  await press({ text: COPIED });
  const panel = await boxPanel();
  typeName(panel, "FIRST_KEY");
  const release = shell.holdNewItem();
  fireEvent.click(saveButton(panel));
  await waitFor(() => {
    expect(shell.captureSlot()).toBeNull();
  });
  const menu = await openMenu(screen.getByRole("button", { name: "Add" }));
  fireEvent.click(within(menu).getByRole("menuitem", { name: "Note" }));
  const note = await screen.findByRole("complementary", { name: "New note" });
  release();
  await settle();
  expect(toastText()).toContain("FIRST_KEY saved in My vault");
  expect(screen.getByRole("complementary", { name: "New note" })).toBe(note);
  expect(screen.queryByRole("complementary", { name: "FIRST_KEY" })).toBeNull();
});

test("a_late_env_conversion_keeps_the_newer_copy", async () => {
  await startUnlocked();
  await press({ text: ENV_TEXT });
  const panel = await boxPanel();
  const release = shell.holdEnvRead();
  fireEvent.click(within(panel).getByRole("button", { name: "Save as separate keys" }));
  // The shell has read the first copy (its slot is empty) when a second is copied, and only then does the answer come.
  await waitFor(() => {
    expect(shell.captureSlot()).toBeNull();
  });
  await press({ text: COPIED });
  const newer = shell.captureSlot()?.id;
  release();
  await settle();
  // The paste panel does not open over the second copy's box, and the values the first read parked are let go.
  expect(screen.queryByRole("complementary", { name: "Paste a .env" })).toBeNull();
  expect(screen.getByRole("complementary", { name: PAGE_WORDS })).toBeTruthy();
  expect(within(screen.getByRole("complementary", { name: PAGE_WORDS })).getByRole("button", { name: "Show" })).toBeTruthy();
  expect(shell.envHeld()).toBe(0);
  expect(shell.captureSlot()?.id).toBe(newer);
  expect(sent("capture_cancel")).toEqual([]);
  expect(debugState().capture?.id).toBe(newer);
});

test("a_startup_snapshot_does_not_replace_a_newer_copy", async () => {
  let release: () => void = () => undefined;
  await start({
    before: (made) => {
      made.press({ text: COPIED });
      release = made.holdCaptureState();
    },
  });
  // The page asked what waits and the answer is held; a newer copy comes by the event first.
  await press({ text: OTHER });
  const newer = shell.captureSlot()?.id;
  await screen.findByRole("heading", { level: 1, name: PAGE_WORDS });
  expect(debugState().capture?.id).toBe(newer);
  release();
  await settle();
  expect(debugState().capture?.id).toBe(newer);
  await unlockNow();
  await boxPanel();
  await waitFor(() => {
    expect(sent("capture_choose").at(-1)?.capture_id).toBe(newer);
  });
  expect(shell.captureSlot()?.id).toBe(newer);
});

test("a_startup_snapshot_does_not_undo_a_gone", async () => {
  let release: () => void = () => undefined;
  await start({
    before: (made) => {
      made.press({ text: COPIED });
      release = made.holdCaptureState();
    },
  });
  // The copy goes while the answer about it is on its way: the snapshot is older than that, and brings nothing back.
  act(() => {
    shell.emptyCaptureSlot();
  });
  release();
  await settle();
  expect(debugState().capture).toBeNull();
  expect(screen.queryByRole("heading", { name: PAGE_WORDS })).toBeNull();
  expect(screen.getByRole("heading", { level: 1, name: "Unlock My vault" })).toBeTruthy();
});

test("show_waits_for_the_copy_to_be_handed_to_the_vault", async () => {
  await startUnlocked();
  const release = shell.holdCaptureChoose();
  await press({ text: COPIED });
  const panel = await boxPanel();
  fireEvent.click(within(panel).getByRole("button", { name: "Show" }));
  await settle();
  // The shell has not handed the copy to the vault yet, so it would call the vault locked: nothing is asked, and nothing is dropped.
  expect(sent("capture_reveal")).toEqual([]);
  expect(screen.getByRole("complementary", { name: PAGE_WORDS })).toBe(panel);
  expect(screen.queryByRole("alert")).toBeNull();
  release();
  expect(await within(panel).findByText(COPIED)).toBeTruthy();
  expect(sent("capture_reveal")).toHaveLength(1);
  expect(screen.getByRole("complementary", { name: PAGE_WORDS })).toBe(panel);
  expect(screen.queryByRole("alert")).toBeNull();
});

test("a_hand_over_that_fails_does_not_reveal_and_does_not_look_like_a_lock", async () => {
  await startUnlocked();
  shell.refuseNext("capture_choose", { code: "busy" });
  await press({ text: COPIED });
  const panel = await boxPanel();
  await screen.findByRole("alert");
  fireEvent.click(within(panel).getByRole("button", { name: "Show" }));
  await settle();
  // The refusal was said once; Show asks nothing of a copy that was not handed over, and the vault stays open.
  expect(sent("capture_reveal")).toEqual([]);
  expect(screen.getByRole("complementary", { name: PAGE_WORDS })).toBe(panel);
  expectNoValue();
});

test("escape_on_the_lock_screen_save_step_cancels_the_copy", async () => {
  await start();
  await press({ text: COPIED });
  await screen.findByRole("heading", { level: 1, name: PAGE_WORDS });
  const id = shell.captureSlot()?.id;
  fireEvent.keyDown(screen.getByLabelText("Password for My vault"), { key: "Escape" });
  expect(await screen.findByRole("heading", { level: 1, name: "Unlock My vault" })).toBeTruthy();
  expect(sent("capture_cancel")).toEqual([{ capture_id: id }]);
  expect(shell.captureSlot()).toBeNull();
});

test("escape_on_the_plain_lock_screen_does_nothing", async () => {
  await start();
  fireEvent.keyDown(screen.getByLabelText("Password for My vault"), { key: "Escape" });
  expect(sent("capture_cancel")).toEqual([]);
  expect(screen.getByRole("heading", { level: 1, name: "Unlock My vault" })).toBeTruthy();
});
