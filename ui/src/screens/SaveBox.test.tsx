// Task 18's screens: a copied key saved with the shortcut (8a to 8e), and the paste panel's tick box that clears the clipboard. The
// shell reads the clipboard and keeps the text in a slot; the page hears only a state and an id (`lockbox://capture`) and asks for
// the value only on Reveal. These tests hold the page to that: most of them also look for the copied value in everything the page
// shows or keeps.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import App from "../App";
import { messageFor, messageText } from "../messages";
import { chooseSaveVault, debugState, makeNewRecoveryKey, openNewRecoveryKey, refreshVaults, resetStoreForTests, saveCapture, startRestore, unlockInBox } from "../store";
import { expectNoAxe } from "../testing/axe";
import {
  BACKUP_PASSWORD,
  CAPTURE_VAULT,
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

/** The labels of the box, found by what they say, in the page's order; one missing is a failure. */
function labelsOf(panel: HTMLElement, labels: string[]): Element[] {
  return labels.map((label) => {
    const found = Array.from(panel.querySelectorAll("label, .flab")).find((element) => element.textContent.trim() === label);
    if (found === undefined) throw new Error(`no ${label}`);
    return found;
  });
}

function expectInOrder(found: Element[], why: string) {
  for (let at = 1; at < found.length; at += 1) {
    expect((found[at - 1] as Element).compareDocumentPosition(found[at] as Element) & Node.DOCUMENT_POSITION_FOLLOWING, `${why}: ${String(at)}`).toBeTruthy();
  }
}

test("order_is_vault_then_password_then_name_and_folder_then_save", async () => {
  // Every vault locked (8b): the lock screen's own list comes before its password.
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
  // Copied value, Vault, Name, Folder, then Save: the design's order (folders are encrypted, so the vault is known before they are asked).
  expectInOrder([...labelsOf(panel, ["Copied value", "Vault", "Name", "Folder"]), saveButton(panel)], "from every vault locked");
});

test("8a_has_the_drawn_fields_and_the_vault_as_a_list", async () => {
  const { container } = await startUnlocked();
  await press({ text: COPIED });
  const panel = await boxPanel();
  expect(within(panel).getByText("Copied value")).toBeTruthy();
  const name = nameBox(panel);
  expect(name.autocomplete).toBe("off");
  expect(name.getAttribute("spellcheck")).toBe("false");
  expect(name.placeholder).toBe("OPENAI_API_KEY");
  expect(name.classList.contains("m")).toBe(true);
  // The vault is a list (the same part as Folder), showing the one on screen.
  expect(within(panel).getByRole("combobox", { name: "Vault" }).textContent).toBe("My vault");
  expect(within(panel).queryByLabelText("Vault", { selector: "input" })).toBeNull();
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

test("the_shown_value_cannot_be_copied_or_dragged_natively", async () => {
  await startUnlocked();
  await press({ text: COPIED });
  const panel = await boxPanel();
  fireEvent.click(within(panel).getByRole("button", { name: "Show" }));
  const value = await within(panel).findByText(COPIED);
  // As every other secret shown on the page: a native copy, cut or drag would put a second copy on the clipboard without the
  // marks that keep it out of Windows' clipboard history, its timer and its clear at a lock.
  const range = document.createRange();
  range.selectNodeContents(value);
  document.getSelection()?.removeAllRanges();
  document.getSelection()?.addRange(range);
  expect(fireEvent.copy(document.body)).toBe(false);
  expect(fireEvent.cut(document.body)).toBe(false);
  document.getSelection()?.removeAllRanges();
  expect(fireEvent.dragStart(value)).toBe(false);
  // Text beside it stays the person's to copy.
  expect(fireEvent.copy(within(panel).getByText("Copied value"))).toBe(true);
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
  expect(alert.textContent).toBe("That isn't a name Lockbox can use for a key. Use letters, digits and underscores (_) only, and don't start with a digit.");
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

// ---- Plan 4C Task 10: the box's vault choice ----

/** A folder only the second vault has, so a save into it can only have gone to that vault. */
const HOME_ONLY = itemId(0xf3);

/** The second vault: "Home", with one folder of its own and no keys. */
function homeVault(extra: Partial<FakeVault> = {}): FakeVault {
  return { id: 8, name: "Home", items: [{ id: HOME_ONLY, kind: "collection", title: "Only in Home" }], ...extra };
}

let home: FakeVault;

/**
 * The vaults of `list` on a fresh page: the first unlocked on the lock screen, each of `more` (the strip's name for it, without ", locked") unlocked from the
 * strip, which brings it to the front, and then the window named `onScreen` brought to the front. A vault not named stays locked.
 */
async function openAll(list: FakeVault[], more: string[], onScreen: string, firstName = list[0]?.name ?? "") {
  vault = list[0] as FakeVault;
  home = list[1] ?? homeVault();
  shell = installFakeShell(invoke, listen, list);
  render(<App />);
  await waitFor(() => {
    expect(shell.calls.some((call) => call.cmd === "capture_state")).toBe(true);
  });
  await unlockNow();
  let front = firstName;
  for (const label of more) {
    fireEvent.click(screen.getByRole("button", { name: `${label}, locked` }));
    const field = await screen.findByLabelText(/^Password for /);
    fireEvent.change(field, { target: { value: PASSWORD } });
    fireEvent.submit((field as HTMLInputElement).form as HTMLFormElement);
    await waitFor(() => {
      expect(screen.queryByLabelText(/^Password for /)).toBeNull();
    });
    front = label;
  }
  if (front !== onScreen) {
    fireEvent.click(screen.getByRole("button", { name: onScreen }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: onScreen }).getAttribute("aria-current")).toBe("true");
    });
  }
}

/** My vault (7) on screen and Home (8) open behind it, the copy pressed, and the box up. */
async function boxOverTwoOpen(copy: Parameters<typeof press>[0] = { text: COPIED }) {
  await openAll([{ id: 7, name: "My vault", items: withKey() }, homeVault()], ["Home"], "My vault");
  await press(copy);
  return boxPanel();
}

/** My vault (7) open on screen, Archive (9) listed and locked, the copy pressed, and the box up. */
async function boxOverOneOpen() {
  await openAll([{ id: 7, name: "My vault", items: withKey() }, { id: 9, name: "Archive", items: sampleItems() }], [], "My vault");
  await press({ text: COPIED });
  return boxPanel();
}

function vaultBox(panel: HTMLElement): HTMLElement {
  return within(panel).getByRole("combobox", { name: "Vault" });
}

async function vaultOptions(panel: HTMLElement): Promise<string[]> {
  const list = await within(panel).findByRole("combobox", { name: "Vault" });
  fireEvent.pointerDown(list, { button: 0 });
  fireEvent.click(list);
  return (await screen.findAllByRole("option")).map((one) => one.textContent);
}

/** Picks `name` in the Vault list and goes on at once (the box may be gone by the time anything could be looked at). */
async function pickVault(panel: HTMLElement, name: string) {
  const list = await within(panel).findByRole("combobox", { name: "Vault" });
  fireEvent.pointerDown(list, { button: 0 });
  fireEvent.click(list);
  const option = (await screen.findAllByRole("option")).find((one) => one.textContent === name);
  if (option === undefined) throw new Error(`no vault ${name}`);
  fireEvent.pointerDown(option);
  fireEvent.click(option);
}

async function chooseVault(panel: HTMLElement, name: string) {
  await pickVault(panel, name);
  await waitFor(() => {
    expect(vaultBox(panel).textContent).toBe(name);
  });
  // Focus stays on the Vault list when it is changed (it is not taken to the password the change may bring).
  await waitFor(() => {
    expect(document.activeElement).toBe(vaultBox(panel));
  });
}

function passwordBox(panel: HTMLElement, name: string): HTMLInputElement {
  return within(panel).getByLabelText<HTMLInputElement>(`Password for ${name}`);
}

/** Types `text` in the box's password field and presses "Unlock and continue". */
function unlockWith(panel: HTMLElement, name: string, text: string = PASSWORD) {
  fireEvent.change(passwordBox(panel, name), { target: { value: text } });
  fireEvent.click(within(panel).getByRole("button", { name: "Unlock and continue" }));
}

function liveOf(vaultId: number): { session: number; generation: number } {
  const live = shell.sessionOf(vaultId);
  if (live === undefined) throw new Error(`vault ${String(vaultId)} is not open`);
  return { session: live.session, generation: live.generation };
}

function homeKeys(): FakeItem[] {
  return (home.items ?? []).filter((item) => item.kind === "key");
}

test("save_box_offers_every_listed_vault_with_the_one_on_screen_first", async () => {
  const list: FakeVault[] = [
    { id: 7, name: "My vault", items: withKey() },
    homeVault(),
    { id: 9, name: "Archive", items: sampleItems() },
    { id: 10, name: "Offline", items: sampleItems(), available: false },
    { id: 11, name: "Reference", items: sampleItems(), readOnly: true },
  ];
  await openAll(list, ["Home", "Reference"], "Home");
  await press({ text: COPIED });
  const panel = await boxPanel();
  expect(vaultBox(panel).textContent).toBe("Home");
  // The one on screen, then the list's order; Offline (unavailable) and Reference (open, read-only) are not choices, and Archive (locked) is.
  expect(await vaultOptions(panel)).toEqual(["Home", "My vault", "Archive"]);
  // The copy was handed to the one on screen.
  await waitFor(() => {
    expect(shell.captureSlot()?.chosen).toBe(liveOf(8).session);
  });
  expectNoValue();
});

test("two_vaults_with_the_same_name_say_their_place_on_the_list", async () => {
  await openAll([{ id: 7, name: "Twin", items: withKey() }, homeVault({ name: "Twin" })], ["Twin, 2 of 2"], "Twin, 1 of 2", "Twin, 1 of 2");
  await press({ text: COPIED });
  const panel = await boxPanel();
  expect(vaultBox(panel).textContent).toBe("Twin, 1 of 2");
  expect(await vaultOptions(panel)).toEqual(["Twin, 1 of 2", "Twin, 2 of 2"]);
});

test("a_vault_that_is_listed_alone_has_a_list_of_one", async () => {
  await startUnlocked();
  await press({ text: COPIED });
  const panel = await boxPanel();
  expect(await vaultOptions(panel)).toEqual(["My vault"]);
});

test("order_is_vault_then_password_then_name_and_folder_then_save_from_a_open", async () => {
  const panel = await boxOverOneOpen();
  await chooseVault(panel, "Archive");
  // A locked vault chosen: the list, then its password, then the button that unlocks. Nothing of the name and folder is drawn before the unlock.
  const [vaultLabel] = labelsOf(panel, ["Vault"]);
  const password = passwordBox(panel, "Archive");
  const unlockButton = within(panel).getByRole("button", { name: "Unlock and continue" });
  expectInOrder([vaultLabel as Element, password, unlockButton], "locked");
  expect(within(panel).queryByLabelText("Name")).toBeNull();
  expect(within(panel).queryByRole("combobox", { name: "Folder" })).toBeNull();
  expect(within(panel).queryByText("Copied value")).toBeNull();
  expect(within(panel).queryByRole("checkbox")).toBeNull();
  expect(within(panel).queryByRole("button", { name: "Save" })).toBeNull();
  unlockWith(panel, "Archive");
  await waitFor(() => {
    expect(within(panel).queryByLabelText("Password for Archive")).toBeNull();
  });
  await waitFor(() => {
    expect(document.activeElement).toBe(nameBox(panel));
  });
  expectInOrder([...labelsOf(panel, ["Copied value", "Vault", "Name", "Folder"]), saveButton(panel)], "from A open");
});

test("choosing_a_locked_vault_unlocks_it_inside_the_box_and_keeps_the_copy", async () => {
  const panel = await boxOverOneOpen();
  const id = shell.captureSlot()?.id;
  typeName(panel, "KEPT_NAME");
  await chooseVault(panel, "Archive");
  // The locked look (8b's content in the panel): the words, the unbound copy, nothing sent to open anything yet.
  expect(within(panel).getByText("A locked vault's folders can't be read until you unlock it.")).toBeTruthy();
  expect(within(panel).getByRole("button", { name: "Cancel" })).toBeTruthy();
  expect(sent("unlock_vault")).toHaveLength(1);
  await waitFor(() => {
    expect(shell.captureSlot()?.chosen).toBeNull();
  });
  expect(shell.captureSlot()?.id).toBe(id);
  unlockWith(panel, "Archive");
  await waitFor(() => {
    expect(sent("unlock_vault")).toHaveLength(2);
  });
  expect(sent("unlock_vault")[1]).toMatchObject({ vault: { id: 9 }, password: PASSWORD });
  // Unlocking leaves the copy where it is, and hands it to the vault that opened; the window on screen is still My vault.
  await waitFor(() => {
    expect(shell.captureSlot()?.chosen).toBe(liveOf(9).session);
  });
  expect(shell.captureSlot()?.chosenGeneration).toBe(liveOf(9).generation);
  expect(shell.captureSlot()?.id).toBe(id);
  expect(debugState().sessions.at(-1)?.vaultId).toBe(7);
  expect(screen.getByRole("complementary", { name: PAGE_WORDS })).toBe(panel);
  // The look is the open one again, with what was typed.
  expect(vaultBox(panel).textContent).toBe("Archive");
  expect(nameBox(panel).value).toBe("KEPT_NAME");
  expect(within(panel).getByRole("combobox", { name: "Folder" }).textContent).toBe("No folder");
  expect(sent("capture_cancel")).toEqual([]);
  // Save goes into Archive, with the session and generation it opened with.
  fireEvent.click(saveButton(panel));
  await waitFor(() => {
    expect(sent("capture_save")).toHaveLength(1);
  });
  expect(sent("capture_save")[0]).toMatchObject({ ...liveOf(9), capture_id: id, name: "KEPT_NAME" });
});

test("a_failed_unlock_inside_the_box_keeps_the_copy_and_the_choice", async () => {
  const panel = await boxOverOneOpen();
  const id = shell.captureSlot()?.id;
  await chooseVault(panel, "Archive");
  unlockWith(panel, "Archive", "not the password");
  // The reason is said under the field, in the design's words; the field is empty, the box and its choice are as they were, the copy waits.
  expect((await within(panel).findByRole("alert")).textContent).toBe("Wrong password.");
  expect(passwordBox(panel, "Archive").value).toBe("");
  expect(vaultBox(panel).textContent).toBe("Archive");
  expect(screen.getByRole("complementary", { name: PAGE_WORDS })).toBe(panel);
  expect(shell.captureSlot()?.id).toBe(id);
  expect(shell.captureSlot()?.chosen).toBeNull();
  expect(shell.sessionOf(9)?.unlocked).not.toBe(true);
  expect(sent("capture_choose")).toHaveLength(1);
  expect(sent("capture_cancel")).toEqual([]);
  expectNoValue("not the password");
  // Typing again takes the line away, and the right password opens it.
  fireEvent.change(passwordBox(panel, "Archive"), { target: { value: "a" } });
  expect(within(panel).queryByRole("alert")).toBeNull();
  unlockWith(panel, "Archive");
  await waitFor(() => {
    expect(shell.captureSlot()?.chosen).toBe(liveOf(9).session);
  });
});

test("the_box_unlock_password_is_wiped_as_it_is_sent_and_never_kept", async () => {
  const panel = await boxOverOneOpen();
  await chooseVault(panel, "Archive");
  const release = shell.holdUnlock();
  unlockWith(panel, "Archive");
  await waitFor(() => {
    expect(sent("unlock_vault")).toHaveLength(2);
  });
  // The answer has not come: the field is already empty, cannot be typed in, and no password is on the page, in the store or in a title.
  const field = passwordBox(panel, "Archive");
  expect(field.value).toBe("");
  expect(field.readOnly).toBe(true);
  expect(sent("unlock_vault")[1]?.password).toBe(PASSWORD);
  expectNoValue(PASSWORD);
  release();
  await waitFor(() => {
    expect(shell.captureSlot()?.chosen).toBe(liveOf(9).session);
  });
  expectNoValue(PASSWORD);
});

test("the_box_unlock_password_is_wiped_by_a_change_of_choice_and_a_lock_epoch", async () => {
  const panel = await boxOverTwoLocked();
  // A change of choice.
  await chooseVault(panel, "Archive");
  fireEvent.change(passwordBox(panel, "Archive"), { target: { value: "half-typed-1" } });
  expect(passwordBox(panel, "Archive").value).toBe("half-typed-1");
  await chooseVault(panel, "Vault three");
  expect(passwordBox(panel, "Vault three").value).toBe("");
  await chooseVault(panel, "Archive");
  expect(passwordBox(panel, "Archive").value).toBe("");
  // A lock epoch, with no vault's own lock heard first.
  fireEvent.change(passwordBox(panel, "Archive"), { target: { value: "half-typed-2" } });
  expect(passwordBox(panel, "Archive").value).toBe("half-typed-2");
  act(() => {
    shell.changeLockEpoch();
  });
  await waitFor(() => {
    expect(passwordBox(panel, "Archive").value).toBe("");
  });
  expectNoValue("half-typed-1", "half-typed-2");
});

/** My vault open on screen, and two locked vaults, Archive (9) and Vault three (12). */
async function boxOverTwoLocked() {
  await openAll(
    [{ id: 7, name: "My vault", items: withKey() }, { id: 9, name: "Archive", items: sampleItems() }, { id: 12, name: "Vault three", items: sampleItems() }],
    [],
    "My vault",
  );
  await press({ text: COPIED });
  return boxPanel();
}

test("what_is_typed_in_the_box_is_wiped_when_a_step_takes_the_window_and_the_box_is_not_drawn", async () => {
  // The unlock step of another vault takes the window, so the box is not drawn: its password and an 8c value go, and Back finds them empty.
  const panel = await boxOverTwoLocked();
  await chooseVault(panel, "Archive");
  fireEvent.change(passwordBox(panel, "Archive"), { target: { value: "half-typed-3" } });
  expect(passwordBox(panel, "Archive").value).toBe("half-typed-3");
  fireEvent.click(screen.getByRole("button", { name: "Vault three, locked" }));
  await screen.findByRole("heading", { level: 1, name: "Unlock Vault three" });
  expect(screen.queryByRole("complementary", { name: PAGE_WORDS })).toBeNull();
  expectNoValue("half-typed-3");
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  const again = await boxPanel();
  expect(passwordBox(again, "Archive").value).toBe("");
  expect(vaultBox(again).textContent).toBe("Archive");

  // An 8c value typed in the Value box, with the box not drawn.
  cleanup();
  resetStoreForTests();
  invoke.mockReset();
  listen.mockReset();
  await openAll([{ id: 7, name: "My vault", items: withKey() }, { id: 9, name: "Archive", items: sampleItems() }], [], "My vault");
  await press("empty");
  const empty = await boxPanel();
  fireEvent.change(within(empty).getByLabelText("Value"), { target: { value: OTHER } });
  expect(within(empty).getByLabelText<HTMLInputElement>("Value").value).toBe(OTHER);
  typeName(empty, "STAYS_NAMED");
  fireEvent.click(screen.getByRole("button", { name: "Archive, locked" }));
  await screen.findByRole("heading", { level: 1, name: "Unlock Archive" });
  expectNoValue(OTHER);
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  const back = await boxPanel();
  expect(within(back).getByLabelText<HTMLInputElement>("Value").value).toBe("");
  expect(nameBox(back).value).toBe("STAYS_NAMED");
});

test("an_8c_value_is_wiped_by_a_lock_epoch", async () => {
  await startUnlocked();
  await press("empty");
  const panel = await boxPanel();
  fireEvent.change(within(panel).getByLabelText("Value"), { target: { value: OTHER } });
  expect(within(panel).getByLabelText<HTMLInputElement>("Value").value).toBe(OTHER);
  act(() => {
    shell.changeLockEpoch();
  });
  await waitFor(() => {
    expect(within(panel).getByLabelText<HTMLInputElement>("Value").value).toBe("");
  });
  expectNoValue(OTHER);
});

test("capture_choose_is_called_on_each_change_and_after_an_unlock_inside_the_box", async () => {
  await openAll(
    [{ id: 7, name: "My vault", items: withKey() }, homeVault(), { id: 9, name: "Archive", items: sampleItems() }],
    ["Home"],
    "My vault",
  );
  await press({ text: COPIED });
  const panel = await boxPanel();
  const id = shell.captureSlot()?.id;
  await waitFor(() => {
    expect(sent("capture_choose")).toHaveLength(1);
  });
  // Opening: the vault on screen.
  expect(sent("capture_choose")[0]).toEqual({ ...liveOf(7), capture_id: id });
  // A change to another open vault.
  await chooseVault(panel, "Home");
  await waitFor(() => {
    expect(sent("capture_choose")).toHaveLength(2);
  });
  expect(sent("capture_choose")[1]).toEqual({ ...liveOf(8), capture_id: id });
  // A change to a locked vault hands the copy to no vault.
  await chooseVault(panel, "Archive");
  await waitFor(() => {
    expect(sent("capture_unchoose")).toEqual([{ capture_id: id }]);
  });
  expect(shell.captureSlot()?.chosen).toBeNull();
  // And after the unlock inside the box, to the vault that opened.
  unlockWith(panel, "Archive");
  await waitFor(() => {
    expect(sent("capture_choose")).toHaveLength(3);
  });
  expect(sent("capture_choose")[2]).toEqual({ ...liveOf(9), capture_id: id });
  const commands = shell.calls.map((call) => call.cmd).filter((cmd) => cmd === "capture_choose" || cmd === "capture_unchoose");
  expect(commands).toEqual(["capture_choose", "capture_choose", "capture_unchoose", "capture_choose"]);
  // The copy is still the same one throughout.
  expect(shell.captureSlot()?.id).toBe(id);
  expect(shell.captureSlot()?.chosenGeneration).toBe(liveOf(9).generation);
});

test("the_rendered_save_with_a_on_screen_and_b_chosen_saves_into_b", async () => {
  // Two vaults of one name; the second holds the key that clashes, the first does not: only a save that reached the second can clash.
  const second = homeVault({ name: "Twin", items: [{ id: HOME_ONLY, kind: "collection", title: "Only in Twin" }, { id: OPENAI, kind: "key", title: "OPENAI_API_KEY", value: "old-in-b", modified_at: "2026-10-01T09:00:00Z" }] });
  await openAll([{ id: 7, name: "Twin", items: sampleItems() }, second], ["Twin, 2 of 2"], "Twin, 1 of 2", "Twin, 1 of 2");
  await press({ text: COPIED });
  const panel = await boxPanel();
  await chooseVault(panel, "Twin, 2 of 2");
  typeName(panel, "OPENAI_API_KEY");
  fireEvent.click(saveButton(panel));
  const dialog = await screen.findByRole("dialog");
  expect(dialog.textContent).toContain("This folder already has OPENAI_API_KEY");
  fireEvent.click(within(dialog).getByRole("button", { name: "Keep both" }));
  await waitFor(() => {
    expect(homeKeys().some((item) => item.title === "OPENAI_API_KEY_2")).toBe(true);
  });
  // The command named B's session and generation, and the key is on disk in B and nowhere in A.
  const live = liveOf(8);
  expect(sent("capture_save").map((call) => [call.session, call.generation])).toEqual([[live.session, live.generation], [live.session, live.generation]]);
  expect(homeKeys().find((item) => item.title === "OPENAI_API_KEY_2")?.value).toBe(COPIED);
  expect(homeKeys().find((item) => item.title === "OPENAI_API_KEY")?.value).toBe("old-in-b");
  expect((vault.items ?? []).some((item) => item.kind === "key")).toBe(false);
  expect(shell.captureSlot()).toBeNull();
});

test("saving_into_another_open_vault_says_where_and_keeps_the_vault_on_screen", async () => {
  const cases = [
    { folder: "Only in Home", clear: true, sentence: "HOME_KEY saved in Only in Home, Home. Clipboard cleared." },
    { folder: null, clear: false, sentence: "HOME_KEY saved in Home" },
  ];
  for (const one of cases) {
    again();
    const panel = await boxOverTwoOpen();
    shell.setClipboard(COPIED);
    await chooseVault(panel, "Home");
    typeName(panel, "HOME_KEY");
    if (one.folder !== null) await pickFolder(panel, one.folder);
    if (!one.clear) fireEvent.click(within(panel).getByRole("checkbox", { name: "Clear the clipboard after saving" }));
    fireEvent.click(saveButton(panel));
    await waitFor(() => {
      expect(toastText()).toContain("HOME_KEY saved in");
    });
    expect(toastText()).toBe(one.sentence);
    expect(screen.queryByRole("complementary", { name: PAGE_WORDS })).toBeNull();
    // The vault on screen is still the one that was: its window, with no key opened in it; the key is in the other vault.
    expect(debugState().sessions.at(-1)?.vaultId).toBe(7);
    expect(debugState().sessions.at(-1)?.openItem).toBeNull();
    expect(screen.queryByRole("complementary", { name: "HOME_KEY" })).toBeNull();
    expect(homeKeys().map((item) => item.title)).toEqual(["HOME_KEY"]);
    expect((vault.items ?? []).some((item) => item.title === "HOME_KEY")).toBe(false);
  }
});

test("saving_into_the_vault_on_screen_still_opens_the_key_and_says_the_old_words", async () => {
  const panel = await boxOverTwoOpen();
  typeName(panel, "HERE_KEY");
  await pickFolder(panel, "Lineproof");
  fireEvent.click(saveButton(panel));
  expect(await screen.findByRole("complementary", { name: "HERE_KEY" })).toBeTruthy();
  expect(toastText()).toContain("HERE_KEY saved in Lineproof");
  expect(toastText()).not.toContain("Lineproof, My vault");
  expect((vault.items ?? []).some((item) => item.title === "HERE_KEY")).toBe(true);
  expect(homeKeys()).toEqual([]);
});

test("folders_reveals_and_conflict_answers_follow_the_chosen_vault", async () => {
  const panel = await boxOverTwoOpen();
  // A key of that name in Lineproof, so saving there asks.
  vault.items = [...stored(), { id: itemId(60), kind: "key", title: "LINEPROOF_KEY", value: "old-lineproof", collection: FOLDER_2, modified_at: "2026-10-01T09:00:00Z" }];
  typeName(panel, "LINEPROOF_KEY");
  await pickFolder(panel, "Lineproof");
  // The shown value, and a question about the first vault's key.
  fireEvent.click(within(panel).getByRole("button", { name: "Show" }));
  await within(panel).findByText(COPIED);
  fireEvent.click(saveButton(panel));
  await screen.findByRole("dialog");
  // A change of choice drops all three: the question, the value on screen, and the folder picked.
  act(() => {
    chooseSaveVault({ kind: "open", session: liveOf(8).session });
  });
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(vaultBox(panel).textContent).toBe("Home");
  expectNoValue();
  expect(within(panel).getByRole("img", { name: "Value hidden" })).toBeTruthy();
  expect(within(panel).getByRole("combobox", { name: "Folder" }).textContent).toBe("No folder");
  // The folders are the chosen vault's own, with No folder first.
  const folders = await within(panel).findByRole("combobox", { name: "Folder" });
  fireEvent.pointerDown(folders, { button: 0 });
  fireEvent.click(folders);
  expect((await screen.findAllByRole("option")).map((one) => one.textContent)).toEqual(["No folder", "Only in Home"]);
  // What was typed in the name is kept, and Show asks again for the new choice.
  expect(nameBox(panel).value).toBe("LINEPROOF_KEY");
  expect(sent("capture_reveal")).toHaveLength(1);
});

test("a_second_capture_keeps_the_choice_and_says_the_value_changed", async () => {
  const panel = await boxOverTwoOpen();
  await chooseVault(panel, "Home");
  typeName(panel, "KEPT_KEY");
  const first = shell.captureSlot()?.id;
  await press({ text: OTHER });
  const second = shell.captureSlot()?.id;
  expect(second).not.toBe(first);
  // The same box, with the vault as it was chosen, the name as it was typed, and the note.
  expect(screen.getByRole("complementary", { name: PAGE_WORDS })).toBe(panel);
  expect(vaultBox(panel).textContent).toBe("Home");
  expect(nameBox(panel).value).toBe("KEPT_KEY");
  expect(within(panel).getByRole("status").textContent).toBe("The copied value changed. What you typed is kept.");
  // The new copy is handed to the vault that was chosen.
  await waitFor(() => {
    expect(sent("capture_choose").at(-1)).toEqual({ ...liveOf(8), capture_id: second });
  });
  fireEvent.click(saveButton(panel));
  await waitFor(() => {
    expect(homeKeys().some((item) => item.title === "KEPT_KEY" && item.value === OTHER)).toBe(true);
  });
});

test("a_second_capture_while_a_locked_vault_is_chosen_keeps_the_unlock_step_and_what_was_typed", async () => {
  const panel = await boxOverOneOpen();
  typeName(panel, "KEPT_KEY");
  await chooseVault(panel, "Archive");
  fireEvent.change(passwordBox(panel, "Archive"), { target: { value: "half-typed-4" } });
  await press({ text: OTHER });
  expect(screen.getByRole("complementary", { name: PAGE_WORDS })).toBe(panel);
  expect(vaultBox(panel).textContent).toBe("Archive");
  expect(passwordBox(panel, "Archive").value).toBe("half-typed-4");
  expect(shell.captureSlot()?.chosen).toBeNull();
  unlockWith(panel, "Archive");
  await waitFor(() => {
    expect(nameBox(panel).value).toBe("KEPT_KEY");
  });
});

test("locking_the_chosen_vault_empties_the_slot_and_closes_the_box", async () => {
  const panel = await boxOverTwoOpen();
  await chooseVault(panel, "Home");
  await waitFor(() => {
    expect(shell.captureSlot()?.chosen).toBe(liveOf(8).session);
  });
  await act(async () => {
    shell.lock(liveOf(8).session);
    await Promise.resolve();
  });
  await waitFor(() => {
    expect(screen.queryByRole("complementary", { name: PAGE_WORDS })).toBeNull();
  });
  expect(shell.captureSlot()).toBeNull();
  expect(debugState().capture).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  // The vault on screen is untouched.
  expect(await screen.findByRole("heading", { level: 1, name: "All items" })).toBeTruthy();
  expect(debugState().sessions.map((entry) => entry.vaultId)).toEqual([7]);
  expectNoValue();
  // And so does the page's own news of it, when the shell's `gone` is missed.
  again();
  const second = await boxOverTwoOpen();
  await chooseVault(second, "Home");
  shell.forgetCaptureSlot();
  await act(async () => {
    shell.lock(liveOf(8).session);
    await Promise.resolve();
  });
  await waitFor(() => {
    expect(debugState().capture).toBeNull();
  });
});

test("locking_the_chosen_vault_empties_the_slot_and_closes_the_box_and_another_vaults_lock_leaves_it_open_chosen", async () => {
  // The vault on screen locks while the copy is handed to the other one: the box stays, now over the other vault's window, and Save still works.
  const panel = await boxOverTwoOpen();
  await chooseVault(panel, "Home");
  await waitFor(() => {
    expect(shell.captureSlot()?.chosen).toBe(liveOf(8).session);
  });
  const id = shell.captureSlot()?.id;
  await act(async () => {
    shell.lock(liveOf(7).session);
    await Promise.resolve();
  });
  await waitFor(() => {
    expect(debugState().sessions.map((entry) => entry.vaultId)).toEqual([8]);
  });
  expect(screen.getByRole("complementary", { name: PAGE_WORDS })).toBe(panel);
  expect(shell.captureSlot()?.id).toBe(id);
  expect(vaultBox(panel).textContent).toBe("Home");
  typeName(panel, "AFTER_LOCK_KEY");
  fireEvent.click(saveButton(panel));
  await waitFor(() => {
    expect(homeKeys().some((item) => item.title === "AFTER_LOCK_KEY")).toBe(true);
  });
});

test("locking_the_chosen_vault_empties_the_slot_and_closes_the_box_and_another_vaults_lock_leaves_it_locked_chosen", async () => {
  // Unbound (a locked vault is chosen): the host's lock leaves it, the last open vault's lock too, and only a lock of every vault empties it.
  await openAll([{ id: 7, name: "My vault", items: withKey() }, homeVault(), { id: 9, name: "Archive", items: sampleItems() }], ["Home"], "My vault");
  await press({ text: COPIED });
  const panel = await boxPanel();
  await chooseVault(panel, "Archive");
  const id = shell.captureSlot()?.id;
  await act(async () => {
    shell.lock(liveOf(7).session);
    await Promise.resolve();
  });
  await waitFor(() => {
    expect(debugState().sessions.map((entry) => entry.vaultId)).toEqual([8]);
  });
  expect(screen.getByRole("complementary", { name: PAGE_WORDS })).toBe(panel);
  expect(passwordBox(panel, "Archive")).toBeTruthy();
  expect(shell.captureSlot()?.id).toBe(id);
  // The last open vault locks: no window, so the lock screen's save step (8b), with the copy still waiting.
  await act(async () => {
    shell.lock(liveOf(8).session);
    await Promise.resolve();
  });
  expect(await screen.findByRole("heading", { level: 1, name: PAGE_WORDS })).toBeTruthy();
  expect(shell.captureSlot()?.id).toBe(id);
  expect(debugState().capture?.id).toBe(id);
  // Every vault locking is the one that lets it go.
  await act(async () => {
    await invoke("lock_all", {});
  });
  await waitFor(() => {
    expect(debugState().capture).toBeNull();
  });
  expect(shell.captureSlot()).toBeNull();
});

test("a_switch_keeps_the_box_over_the_other_window_and_the_windows_own_panel_waits", async () => {
  // Home has Settings open; My vault is on screen when the copy comes.
  await openAll([{ id: 7, name: "My vault", items: withKey() }, homeVault()], ["Home"], "Home");
  fireEvent.click(within(screen.getByRole("navigation", { name: "Vault and folders" })).getByRole("button", { name: "Settings" }));
  await screen.findByRole("complementary", { name: "Settings" });
  fireEvent.click(screen.getByRole("button", { name: "My vault" }));
  await waitFor(() => {
    expect(screen.queryByRole("complementary", { name: "Settings" })).toBeNull();
  });
  await press({ text: COPIED });
  const panel = await boxPanel();
  typeName(panel, "SWITCHED_KEY");
  const id = shell.captureSlot()?.id;
  // A switch: the box stays, as it was, over Home's window, and Home's Settings is not drawn while it is up.
  fireEvent.click(screen.getByRole("button", { name: "Home" }));
  await waitFor(() => {
    expect(debugState().sessions.at(-1)?.vaultId).toBe(8);
  });
  expect(screen.getByRole("complementary", { name: PAGE_WORDS })).toBe(panel);
  expect(nameBox(panel).value).toBe("SWITCHED_KEY");
  expect(vaultBox(panel).textContent).toBe("My vault");
  expect(shell.captureSlot()?.id).toBe(id);
  expect(screen.queryByRole("complementary", { name: "Settings" })).toBeNull();
  // Cancel lets the copy go, and Home's own panel is back.
  fireEvent.click(within(panel).getByRole("button", { name: "Cancel" }));
  expect(await screen.findByRole("complementary", { name: "Settings" })).toBeTruthy();
  expect(shell.captureSlot()).toBeNull();
});

test("the_env_offer_is_only_for_the_vault_on_screen", async () => {
  const panel = await boxOverTwoOpen({ text: ENV_TEXT });
  expect(within(panel).getByRole("button", { name: "Save as separate keys" })).toBeTruthy();
  await chooseVault(panel, "Home");
  expect(within(panel).queryByRole("button", { name: "Save as separate keys" })).toBeNull();
  expect(within(panel).queryByText(/looks like a \.env/)).toBeNull();
  await chooseVault(panel, "My vault");
  expect(within(panel).getByRole("button", { name: "Save as separate keys" })).toBeTruthy();
});

test("a_read_only_window_opens_the_box_on_the_first_vault_it_can_save_into", async () => {
  await openAll([{ id: 7, name: "Reference", items: sampleItems(), readOnly: true }, homeVault()], ["Home"], "Reference");
  await press({ text: COPIED });
  const panel = await boxPanel();
  // No alert, no "read-only": the box offers Home (open behind) and hands the copy to it.
  expect(screen.queryByRole("alert")).toBeNull();
  expect(vaultBox(panel).textContent).toBe("Home");
  await waitFor(() => {
    expect(shell.captureSlot()?.chosen).toBe(liveOf(8).session);
  });
  expect(await vaultOptions(panel)).toEqual(["Home"]);
});

test("a_read_only_window_with_only_a_locked_vault_to_save_into_opens_on_its_password", async () => {
  await openAll([{ id: 7, name: "Reference", items: sampleItems(), readOnly: true }, homeVault()], [], "Reference");
  await press({ text: COPIED });
  const panel = await boxPanel();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(vaultBox(panel).textContent).toBe("Home");
  await waitFor(() => {
    expect(document.activeElement).toBe(passwordBox(panel, "Home"));
  });
  expect(shell.captureSlot()?.chosen).toBeNull();
  expect(sent("capture_choose")).toEqual([]);
});

test("unlocking_on_the_lock_screen_makes_that_vault_the_choice", async () => {
  await start({ vaults: [{ id: 7, name: "My vault", items: withKey() }, homeVault()] });
  await press({ text: COPIED });
  await screen.findByRole("heading", { level: 1, name: PAGE_WORDS });
  fireEvent.click(screen.getByRole("radio", { name: /Home/ }));
  const field = screen.getByLabelText("Password for Home");
  fireEvent.change(field, { target: { value: PASSWORD } });
  fireEvent.click(screen.getByRole("button", { name: "Unlock and continue" }));
  const panel = await boxPanel();
  expect(vaultBox(panel).textContent).toBe("Home");
  await waitFor(() => {
    expect(shell.captureSlot()?.chosen).toBe(liveOf(8).session);
  });
});

test("a_locked_choice_opened_elsewhere_becomes_the_open_choice", async () => {
  const panel = await boxOverOneOpen();
  await chooseVault(panel, "Archive");
  // Archive is unlocked from the strip while the box shows its password: the box has no password to ask for any more, and the copy goes to it.
  const id = shell.captureSlot()?.id;
  fireEvent.click(screen.getByRole("button", { name: "Archive, locked" }));
  const field = await screen.findByLabelText("Password for Archive");
  fireEvent.change(field, { target: { value: PASSWORD } });
  fireEvent.submit((field as HTMLInputElement).form as HTMLFormElement);
  await waitFor(() => {
    expect(shell.captureSlot()?.chosen).toBe(liveOf(9).session);
  });
  expect(shell.captureSlot()?.id).toBe(id);
  const shown = await boxPanel();
  expect(vaultBox(shown).textContent).toBe("Archive");
  expect(within(shown).queryByLabelText("Password for Archive")).toBeNull();
});

test("hand_overs_go_one_at_a_time_and_only_the_last_asked_is_sent", async () => {
  await openAll(
    [{ id: 7, name: "My vault", items: withKey() }, homeVault(), { id: 9, name: "Archive", items: sampleItems() }],
    ["Home"],
    "My vault",
  );
  const release = shell.holdCaptureChoose();
  await press({ text: COPIED });
  const panel = await boxPanel();
  // The first hand-over is out and held. Home, then Archive (locked) are chosen meanwhile: the answer for Home is never asked for.
  await chooseVault(panel, "Home");
  await chooseVault(panel, "Archive");
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  expect(sent("capture_choose")).toHaveLength(1);
  expect(sent("capture_unchoose")).toEqual([]);
  release();
  await waitFor(() => {
    expect(sent("capture_unchoose")).toHaveLength(1);
  });
  expect(sent("capture_choose")).toHaveLength(1);
  expect(sent("capture_choose")[0]).toMatchObject(liveOf(7));
  expect(shell.captureSlot()?.chosen).toBeNull();
});

test("save_waits_for_the_hand_over_and_the_unchoose_that_closes_the_box_says_nothing", async () => {
  const panel = await boxOverTwoOpen();
  await chooseVault(panel, "Home");
  typeName(panel, "WAITS_KEY");
  const release = shell.holdCaptureChoose();
  await chooseVault(panel, "My vault");
  fireEvent.click(saveButton(panel));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  // The hand-over to My vault is out: nothing is saved until it is done, and then it goes to My vault.
  expect(sent("capture_save")).toEqual([]);
  release();
  await waitFor(() => {
    expect(sent("capture_save")).toHaveLength(1);
  });
  expect(sent("capture_save")[0]).toMatchObject(liveOf(7));

  // An unchoose that finds the copy gone closes the box and says nothing.
  again();
  const second = await boxOverOneOpen();
  shell.refuseNext("capture_unchoose", { code: "not_found" });
  await pickVault(second, "Archive");
  await waitFor(() => {
    expect(screen.queryByRole("complementary", { name: PAGE_WORDS })).toBeNull();
  });
  expect(screen.queryByRole("alert")).toBeNull();
  expect(debugState().capture).toBeNull();
});

test("a_save_the_shell_refuses_as_not_handed_over_says_so_hands_over_again_and_keeps_the_box", async () => {
  const panel = await boxOverTwoOpen();
  typeName(panel, "AGAIN_KEY");
  await waitFor(() => {
    expect(sent("capture_choose")).toHaveLength(1);
  });
  shell.refuseNext("capture_save", CAPTURE_VAULT);
  fireEvent.click(saveButton(panel));
  // The words for Ariel's call; nothing was written, the copy waits, and the hand-over is sent again for the box's choice.
  expect((await within(panel).findByRole("alert")).textContent).toBe("That vault wasn't ready for the save. Press Save again.");
  expect(stored().some((item) => item.title === "AGAIN_KEY")).toBe(false);
  expect(shell.captureSlot()).not.toBeNull();
  await waitFor(() => {
    expect(sent("capture_choose")).toHaveLength(2);
  });
  fireEvent.click(saveButton(panel));
  await waitFor(() => {
    expect(stored().some((item) => item.title === "AGAIN_KEY")).toBe(true);
  });
});

test("a_save_for_a_vault_the_box_has_not_chosen_sends_nothing", async () => {
  const panel = await boxOverTwoOpen();
  await waitFor(() => {
    expect(shell.captureSlot()?.chosen).toBe(liveOf(7).session);
  });
  const before = sent("capture_choose").length;
  const other = liveOf(8);
  const result = await saveCapture(
    other.session,
    { captureId: shell.captureSlot()?.id ?? "", name: "NOT_HERE", collection: null, onClash: "ask", clearClipboard: true, typed: null },
    "Home",
  );
  expect(result).toEqual({ failed: { code: "invalid_input", what: "capture vault" } });
  expect(sent("capture_save")).toEqual([]);
  expect(homeKeys()).toEqual([]);
  expect(shell.captureSlot()).not.toBeNull();
  expect(screen.getByRole("complementary", { name: PAGE_WORDS })).toBe(panel);
  // The box's choice was handed over as it stands, not asked again.
  expect(sent("capture_choose")).toHaveLength(before);
});

test("an_unlock_for_a_choice_the_box_no_longer_has_sends_nothing", async () => {
  const panel = await boxOverOneOpen();
  await chooseVault(panel, "Archive");
  const opening = debugState().capture?.opening ?? -1;
  const before = sent("unlock_vault").length;
  // Another box's opening, another vault than the one chosen, and nothing typed: nothing is sent for any of them.
  await expect(unlockInBox(opening + 1, { kind: "locked", vault: 9, list: 1 }, PASSWORD)).resolves.toBe("stale");
  await expect(unlockInBox(opening, { kind: "locked", vault: 12, list: 1 }, PASSWORD)).resolves.toBe("stale");
  await expect(unlockInBox(opening, { kind: "locked", vault: 9, list: 1 }, "")).resolves.toBe("stale");
  expect(sent("unlock_vault")).toHaveLength(before);
});

test("the_refusal_that_a_vault_was_not_ready_has_its_words", () => {
  const message = messageFor({ code: "invalid_input", what: "capture vault" });
  expect(messageText(message)).toBe("That vault wasn't ready for the save. Press Save again.");
});

test("the_box_is_drawn_over_the_window_in_a_layer_of_its_own", async () => {
  await startUnlocked();
  await press({ text: COPIED });
  const panel = await boxPanel();
  // Over the window and not in it, so a lock of the host or the lock screen does not unmount it.
  expect(panel.closest(".win")).toBeNull();
  expect(panel.parentElement?.classList.contains("boxlayer")).toBe(true);
  expect(panel.closest(".app")).not.toBeNull();
  // The window's list makes room for it, as it does for any panel.
  expect(document.querySelector(".stage")?.classList.contains("open")).toBe(true);
});

test("save_box_vault_choice_has_no_axe_violations", async () => {
  const panel = await boxOverTwoOpen();
  await expectNoAxe(document.body);
  await chooseVault(panel, "Home");
  await expectNoAxe(document.body);
  cleanup();
  resetStoreForTests();
  invoke.mockReset();
  listen.mockReset();
  const locked = await boxOverOneOpen();
  await chooseVault(locked, "Archive");
  fireEvent.change(passwordBox(locked, "Archive"), { target: { value: "x" } });
  await expectNoAxe(document.body);
  unlockWith(locked, "Archive", "wrong");
  await within(locked).findByRole("alert");
  await expectNoAxe(document.body);
});

// ---- Plan 4C Task 10, fix round ----

// ---- Plan 4C Task 10b: the box never changes the vault by itself ----

/** The Vault list's box in the page, found through the DOM so a hidden (modal) page is not missed. */
function boxDom(): HTMLElement {
  const found = document.querySelector<HTMLElement>(".boxlayer aside");
  if (found === null) throw new Error("no box on the page");
  return found;
}

/** What the box draws besides the Vault list and its one line: nothing of the vault, so none of these may be in it (looked for in the DOM, not by role). */
function expectNothingToSave(panel: HTMLElement, why: string) {
  expect(panel.querySelector('input[type="text"]'), `${why}: no Name`).toBeNull();
  expect(panel.querySelectorAll('[role="combobox"]'), `${why}: only the Vault list`).toHaveLength(1);
  expect(panel.querySelector('input[type="password"]'), `${why}: no password`).toBeNull();
  expect(panel.querySelector('button[type="submit"], .pbar .pill-main'), `${why}: no Save and no Unlock`).toBeNull();
  expect(panel.querySelector(".cval"), `${why}: no copied value`).toBeNull();
}

const STEP_WORDS = (name: string) => `${name} needs a step before it can be used. Switch to it to finish, then save.`;
/** The read-only line names the vault it is about (the alert is read alone by a screen reader), then says the existing words. */
const READ_ONLY_WORDS = `Archive: ${messageText(messageFor({ code: "read_only" }))}`;

test("a_chosen_vault_that_opens_read_only_keeps_the_choice_on_screen_or_behind", async () => {
  const list = (): FakeVault[] => [
    { id: 7, name: "My vault", items: withKey() },
    { id: 9, name: "Archive", items: sampleItems(), readOnly: true },
    { id: 12, name: "Third", items: sampleItems() },
  ];
  for (const how of ["behind", "switched to", "host locked"]) {
    again();
    await openAll(list(), [], "My vault");
    await press({ text: COPIED });
    const panel = await boxPanel();
    await chooseVault(panel, "Archive");
    unlockWith(panel, "Archive");
    await waitFor(() => {
      expect(shell.sessionOf(9)?.unlocked).toBe(true);
    });
    expect((await within(panel).findByRole("alert")).textContent, how).toBe(READ_ONLY_WORDS);
    if (how === "switched to") fireEvent.click(screen.getByRole("button", { name: "Archive" }));
    if (how === "host locked") {
      await act(async () => {
        shell.lock(liveOf(7).session);
        await Promise.resolve();
      });
    }
    await waitFor(() => {
      expect(debugState().sessions.at(-1)?.vaultId, how).toBe(how === "behind" ? 7 : 9);
    });
    // On screen or behind: the box is on Archive still, says why, and nothing was handed to another vault.
    const now = boxDom();
    expect(now.querySelector('[role="combobox"]')?.textContent, how).toBe("Archive");
    expect(now.querySelector('[role="alert"]')?.textContent, how).toBe(READ_ONLY_WORDS);
    expectNothingToSave(now, how);
    expect(sent("capture_choose"), how).toHaveLength(1);
    expect(sent("capture_save"), how).toEqual([]);
    expect(shell.captureSlot()?.chosen, how).toBeNull();
    expect(debugState().capture?.choice, how).toMatchObject({ kind: "locked", vault: 9 });
  }
});

test("a_chosen_open_vault_that_starts_waiting_on_a_step_keeps_the_choice_and_offers_no_save", async () => {
  const panel = await boxOverTwoOpen();
  await chooseVault(panel, "Home");
  await waitFor(() => {
    expect(shell.captureSlot()?.chosen).toBe(liveOf(8).session);
  });
  typeName(panel, "TYPED_BEFORE");
  const before = sent("capture_choose").length;
  // Home, chosen and open behind the window, starts waiting on a new recovery key (asked of it while it was behind).
  act(() => {
    openNewRecoveryKey(liveOf(8).session);
    void makeNewRecoveryKey(liveOf(8).session, PASSWORD);
  });
  await waitFor(() => {
    expect(boxDom().querySelector('[role="alert"]')?.textContent).toBe(STEP_WORDS("Home"));
  });
  expect(boxDom().querySelector('[role="combobox"]')?.textContent).toBe("Home");
  expectNothingToSave(boxDom(), "starts waiting");
  // The choice stayed, nothing else was handed the copy, and nothing was saved.
  expect(sent("capture_choose")).toHaveLength(before);
  expect(sent("capture_save")).toEqual([]);
  expect(shell.captureSlot()?.chosen).toBe(liveOf(8).session);
  expect(debugState().capture?.choice).toEqual({ kind: "open", session: liveOf(8).session });
});

test("switching_to_a_chosen_vault_that_waits_on_a_step_shows_no_save_controls", async () => {
  // Archive's details were changed outside Lockbox (Ask 3): it opens waiting, behind the window.
  await openAll([{ id: 7, name: "My vault", items: withKey() }, { id: 9, name: "Archive", items: sampleItems(), headerChanged: true }], [], "My vault");
  await press({ text: COPIED });
  const panel = await boxPanel();
  await chooseVault(panel, "Archive");
  unlockWith(panel, "Archive");
  expect((await within(panel).findByRole("alert")).textContent).toBe(STEP_WORDS("Archive"));
  // The person does as the line says and switches to it: it is the window on screen now, with its own question, and the box has not moved or opened.
  fireEvent.click(screen.getByRole("button", { name: "Archive" }));
  await waitFor(() => {
    expect(debugState().sessions.at(-1)?.vaultId).toBe(9);
  });
  const now = boxDom();
  expect(now.querySelector('[role="combobox"]')?.textContent).toBe("Archive");
  expect(now.querySelector('[role="alert"]')?.textContent).toBe(STEP_WORDS("Archive"));
  expectNothingToSave(now, "switched to");
  expect(sent("capture_choose")).toHaveLength(1);
  expect(sent("capture_save")).toEqual([]);
  expect(shell.captureSlot()?.chosen).toBeNull();
  expect(debugState().capture?.choice).toMatchObject({ kind: "locked", vault: 9 });
});

test("a_chosen_vault_that_leaves_the_list_or_goes_unavailable_says_so_and_waits_for_a_pick", async () => {
  for (const how of ["unavailable", "left the list"]) {
    again();
    const panel = await boxOverOneOpen();
    await chooseVault(panel, "Archive");
    await act(async () => {
      if (how === "unavailable") shell.setAvailable(9, false);
      else await invoke("forget_vault", { vault: { list: shell.listIdentity(), id: 9 } });
      await refreshVaults();
    });
    await waitFor(() => {
      expect(boxDom().querySelector('[role="alert"]')?.textContent, how).toBe("Archive can't be reached now. Choose another vault.");
    });
    const now = boxDom();
    expect(now.querySelector('[role="combobox"]')?.textContent, how).toBe("Archive");
    expectNothingToSave(now, how);
    expect(sent("capture_choose"), how).toHaveLength(1);
    expect(shell.captureSlot()?.chosen, how).toBeNull();
    expect(debugState().capture?.choice, how).toMatchObject({ kind: "locked", vault: 9 });
    // Only the person's own pick moves it: My vault, and then a save goes there.
    await pickVault(now, "My vault");
    await waitFor(() => {
      expect(shell.captureSlot()?.chosen).toBe(liveOf(7).session);
    });
    const open = await boxPanel();
    expect(vaultBox(open).textContent, how).toBe("My vault");
    typeName(open, "PICKED_KEY");
    fireEvent.click(saveButton(open));
    await waitFor(() => {
      expect(stored().some((item) => item.title === "PICKED_KEY")).toBe(true);
    });
  }
});

test("focus_goes_to_the_vault_list_when_a_blocked_state_removes_the_focused_control", async () => {
  // A password field that has the focus goes when the unlock comes back read-only.
  const locked = await (async () => {
    await openAll([{ id: 7, name: "My vault", items: withKey() }, { id: 9, name: "Archive", items: sampleItems(), readOnly: true }], [], "My vault");
    await press({ text: COPIED });
    return boxPanel();
  })();
  await chooseVault(locked, "Archive");
  const field = passwordBox(locked, "Archive");
  fireEvent.change(field, { target: { value: PASSWORD } });
  field.focus();
  expect(document.activeElement).toBe(field);
  fireEvent.click(within(locked).getByRole("button", { name: "Unlock and continue" }));
  await within(locked).findByRole("alert");
  expect(document.activeElement).toBe(vaultBox(locked));

  // The Name box that has the focus goes when the chosen vault starts waiting on a step.
  again();
  const open = await boxOverTwoOpen();
  await chooseVault(open, "Home");
  nameBox(open).focus();
  expect(document.activeElement).toBe(nameBox(open));
  act(() => {
    openNewRecoveryKey(liveOf(8).session);
    void makeNewRecoveryKey(liveOf(8).session, PASSWORD);
  });
  await waitFor(() => {
    expect(boxDom().querySelector('[role="alert"]')).not.toBeNull();
  });
  expect(document.activeElement).toBe(vaultBox(boxDom()));

  // Focus that is somewhere else is left there.
  again();
  const away = await boxOverTwoOpen();
  await chooseVault(away, "Home");
  const outside = screen.getByRole("searchbox", { name: "Filter this list" });
  outside.focus();
  act(() => {
    openNewRecoveryKey(liveOf(8).session);
    void makeNewRecoveryKey(liveOf(8).session, PASSWORD);
  });
  await waitFor(() => {
    expect(boxDom().querySelector('[role="alert"]')).not.toBeNull();
  });
  expect(document.activeElement).toBe(outside);
});

test("a_second_press_with_the_first_unbind_held_ends_unbound_and_the_old_vaults_lock_leaves_the_box", async () => {
  const panel = await boxOverOneOpen();
  await waitFor(() => {
    expect(shell.captureSlot()?.chosen).toBe(liveOf(7).session);
  });
  const mine = liveOf(7).session;
  const release = shell.holdCaptureUnchoose();
  await chooseVault(panel, "Archive");
  const first = shell.captureSlot()?.id;
  await waitFor(() => {
    expect(sent("capture_unchoose")).toEqual([{ capture_id: first }]);
  });
  // The shell has not heard it: it still holds the copy for My vault, and the page does not call the copy unbound yet.
  expect(shell.captureSlot()?.chosen).toBe(mine);
  expect(debugState().capture?.chosen).toBe(mine);
  // A second press replaces the copy, which keeps that binding in the shell; the page asks again for the new copy (that one held too, so the in-between can be seen).
  const releaseSecond = shell.holdCaptureUnchoose();
  await press({ text: OTHER });
  const second = shell.captureSlot()?.id;
  expect(second).not.toBe(first);
  expect(shell.captureSlot()?.chosen).toBe(mine);
  await waitFor(() => {
    expect(sent("capture_unchoose").at(-1)).toEqual({ capture_id: second });
  });
  // Neither has reached the shell: it holds the replacement for My vault, and the page still counts it as handed to My vault (its lock would end it there too).
  expect(shell.captureSlot()?.chosen).toBe(mine);
  expect(debugState().capture?.chosen).toBe(mine);
  releaseSecond();
  await waitFor(() => {
    expect(shell.captureSlot()?.chosen).toBeNull();
  });
  await waitFor(() => {
    expect(debugState().capture?.chosen).toBeNull();
  });
  // The first, now let through, finds nothing: it changes nothing.
  release();
  await settle();
  expect(shell.captureSlot()?.id).toBe(second);
  expect(debugState().capture?.id).toBe(second);
  // The old vault's lock leaves the copy and the box (the lock screen has it, with the copy still waiting).
  await act(async () => {
    shell.lock(mine);
    await Promise.resolve();
  });
  expect(shell.captureSlot()?.id).toBe(second);
  expect(debugState().capture?.id).toBe(second);
  expect(debugState().capture?.choice).toMatchObject({ kind: "locked", vault: 9 });
});

test("no_save_or_choose_is_sent_for_another_vault_unless_the_person_picks_it", async () => {
  await openAll([{ id: 7, name: "My vault", items: withKey() }, { id: 9, name: "Archive", items: sampleItems(), readOnly: true }], [], "My vault");
  await press({ text: COPIED });
  const panel = await boxPanel();
  await chooseVault(panel, "Archive");
  unlockWith(panel, "Archive");
  await within(panel).findByRole("alert");
  const chooses = sent("capture_choose").length;
  // A second copy, a list read again, and the vault coming to the front change nothing about where the copy is for.
  await press({ text: OTHER });
  await act(async () => {
    await refreshVaults();
  });
  fireEvent.click(screen.getByRole("button", { name: "Archive" }));
  await settle();
  expect(sent("capture_choose")).toHaveLength(chooses);
  expect(sent("capture_save")).toEqual([]);
  expect(boxDom().querySelector('[role="combobox"]')?.textContent).toBe("Archive");
  expect(shell.captureSlot()?.chosen).toBeNull();
  // The person's own pick is the one thing that moves it, and then one hand-over goes for that vault with the new copy.
  await pickVault(boxDom(), "My vault");
  await waitFor(() => {
    expect(sent("capture_choose")).toHaveLength(chooses + 1);
  });
  expect(sent("capture_choose").at(-1)).toEqual({ ...liveOf(7), capture_id: shell.captureSlot()?.id });
});

test("an_in_box_unlock_that_opens_read_only_keeps_the_box_on_that_vault_and_says_why", async () => {
  await openAll([{ id: 7, name: "My vault", items: withKey() }, { id: 9, name: "Archive", items: sampleItems(), readOnly: true }], [], "My vault");
  await press({ text: COPIED });
  const panel = await boxPanel();
  await chooseVault(panel, "Archive");
  unlockWith(panel, "Archive");
  await waitFor(() => {
    expect(shell.sessionOf(9)?.unlocked).toBe(true);
  });
  // The existing words, in the box's line; the box stays on Archive and offers nothing to save into it.
  const alert = await within(panel).findByRole("alert");
  expect(alert.textContent).toBe(READ_ONLY_WORDS);
  expect(alert.textContent).toContain(messageText(messageFor({ code: "read_only" })));
  expect(vaultBox(panel).textContent).toBe("Archive");
  expect(within(panel).queryByLabelText("Name")).toBeNull();
  expect(within(panel).queryByRole("button", { name: "Save" })).toBeNull();
  expect(within(panel).queryByRole("button", { name: "Unlock and continue" })).toBeNull();
  expect(within(panel).queryByLabelText("Password for Archive")).toBeNull();
  expect(sent("capture_choose")).toHaveLength(1);
  expect(shell.captureSlot()?.chosen).toBeNull();
  expect(sent("capture_save")).toEqual([]);
  // The person can still go to a vault that takes a key.
  await pickVault(panel, "My vault");
  await waitFor(() => {
    expect(vaultBox(panel).textContent).toBe("My vault");
  });
  expect(nameBox(panel).value).toBe("");
  expect(within(panel).queryByRole("alert")).toBeNull();
});

test("an_in_box_unlock_that_opens_waiting_on_a_step_keeps_the_box_on_that_vault_and_says_so", async () => {
  const cases: { how: string; extra: Partial<FakeVault> }[] = [
    { how: "recovery key never confirmed (21f)", extra: { unconfirmed: true } },
    { how: "details changed (Ask 3)", extra: { headerChanged: true } },
  ];
  for (const one of cases) {
    again();
    await openAll([{ id: 7, name: "My vault", items: withKey() }, { id: 9, name: "Archive", items: sampleItems(), ...one.extra }], [], "My vault");
    await press({ text: COPIED });
    const panel = await boxPanel();
    await chooseVault(panel, "Archive");
    unlockWith(panel, "Archive");
    await waitFor(() => {
      expect(shell.sessionOf(9)?.unlocked).toBe(true);
    });
    const alert = await within(panel).findByRole("alert");
    expect(alert.textContent, one.how).toBe("Archive needs a step before it can be used. Switch to it to finish, then save.");
    expect(vaultBox(panel).textContent, one.how).toBe("Archive");
    // Nothing of the vault: no folders, no name, no Save, no password.
    expect(within(panel).queryByLabelText("Name"), one.how).toBeNull();
    expect(within(panel).queryByRole("combobox", { name: "Folder" }), one.how).toBeNull();
    expect(within(panel).queryByRole("button", { name: "Save" }), one.how).toBeNull();
    expect(within(panel).queryByLabelText("Password for Archive"), one.how).toBeNull();
    expect(sent("capture_choose"), one.how).toHaveLength(1);
    expect(sent("capture_save"), one.how).toEqual([]);
    expect(shell.captureSlot()?.chosen, one.how).toBeNull();
    expect(debugState().sessions.at(-1)?.vaultId, one.how).toBe(7);
  }
});

// ---- Plan 4C Task 10b, fix round ----

test("a_replacement_list_that_reuses_an_id_and_a_name_does_not_redirect_the_choice", async () => {
  const panel = await boxOverOneOpen();
  await chooseVault(panel, "Archive");
  const oldList = shell.listIdentity();
  // The vault list is replaced, and its Archive has the number the old Archive had, and its name: another vault.
  await act(async () => {
    shell.replaceVaultList([
      { id: 7, name: "My vault", items: withKey() },
      { id: 9, name: "Archive", items: sampleItems() },
    ]);
    await refreshVaults();
  });
  await waitFor(() => {
    expect(boxDom().querySelector('[role="alert"]')?.textContent).toBe("Archive can't be reached now. Choose another vault.");
  });
  expect(debugState().capture?.choice).toMatchObject({ kind: "locked", vault: 9, list: oldList });
  expectNothingToSave(boxDom(), "replaced list");
  // The new list's Archive, unlocked from the strip, is its own vault: the copy is not handed to it and the choice is not promoted onto it.
  fireEvent.click(screen.getByRole("button", { name: "Archive, locked" }));
  const field = await screen.findByLabelText("Password for Archive");
  fireEvent.change(field, { target: { value: PASSWORD } });
  fireEvent.submit((field as HTMLInputElement).form as HTMLFormElement);
  await waitFor(() => {
    expect(shell.sessionOf(9)?.unlocked).toBe(true);
  });
  await settle();
  expect(sent("capture_choose")).toHaveLength(1);
  expect(shell.captureSlot()?.chosen).toBeNull();
  expect(debugState().capture?.choice).toMatchObject({ kind: "locked", vault: 9, list: oldList });
  expect(boxDom().querySelector('[role="alert"]')?.textContent).toBe("Archive can't be reached now. Choose another vault.");
  expect(sent("capture_save")).toEqual([]);
});

test("a_blocked_vault_never_gets_a_save_even_from_an_open_question_or_a_queued_one", async () => {
  // An open name question, and the chosen vault starts waiting on a step.
  const home = homeVault({
    items: [
      { id: HOME_ONLY, kind: "collection", title: "Only in Home" },
      { id: OPENAI, kind: "key", title: "OPENAI_API_KEY", value: "old-in-home", modified_at: "2026-10-01T09:00:00Z" },
    ],
  });
  await openAll([{ id: 7, name: "My vault", items: withKey() }, home], ["Home"], "My vault");
  await press({ text: COPIED });
  const panel = await boxPanel();
  await chooseVault(panel, "Home");
  typeName(panel, "OPENAI_API_KEY");
  fireEvent.click(saveButton(panel));
  await screen.findByRole("dialog");
  const saves = sent("capture_save").length;
  act(() => {
    openNewRecoveryKey(liveOf(8).session);
    void makeNewRecoveryKey(liveOf(8).session, PASSWORD);
  });
  await waitFor(() => {
    expect(boxDom().querySelector('[role="alert"]')?.textContent).toBe(STEP_WORDS("Home"));
  });
  // The question goes with the choice's becoming blocked, and a save asked for anyway sends nothing.
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  const asked = { captureId: shell.captureSlot()?.id ?? "", name: "OPENAI_API_KEY", collection: null, onClash: "replace", clearClipboard: true, typed: null } as const;
  await expect(saveCapture(liveOf(8).session, asked, "Home")).resolves.toBe("stale");
  expect(sent("capture_save")).toHaveLength(saves);
  expect((home.items ?? []).find((item) => item.title === "OPENAI_API_KEY")?.value).toBe("old-in-home");

  // A Save that was queued, and a locked vault picked while the unbinding fails: the vault the shell still holds the copy for is not the choice.
  again();
  const locked = await boxOverOneOpen();
  await waitFor(() => {
    expect(shell.captureSlot()?.chosen).toBe(liveOf(7).session);
  });
  shell.refuseNext("capture_unchoose", { code: "busy" });
  await chooseVault(locked, "Archive");
  await settle();
  expect(debugState().capture?.chosen).toBe(liveOf(7).session);
  const queued = { captureId: shell.captureSlot()?.id ?? "", name: "QUEUED_KEY", collection: null, onClash: "ask", clearClipboard: true, typed: null } as const;
  await expect(saveCapture(liveOf(7).session, queued, "My vault")).resolves.toBe("stale");
  expect(sent("capture_save")).toEqual([]);
  expect(stored().some((item) => item.title === "QUEUED_KEY")).toBe(false);
});

test("unlocking_a_restored_vault_keeps_the_choice_the_box_has", async () => {
  await start({ vaults: [{ id: 7, name: "My vault", items: withKey() }, homeVault()] });
  shell.restoreIs({ replaces: true });
  await press({ text: COPIED });
  await screen.findByRole("heading", { level: 1, name: PAGE_WORDS });
  // Home is the vault chosen for the copy when a restore of My vault comes between.
  act(() => {
    chooseSaveVault({ kind: "locked", vault: 8, list: shell.listIdentity() });
  });
  await act(async () => {
    await startRestore();
  });
  await screen.findByRole("heading", { level: 1, name: "Restore a backup" });
  fireEvent.change(screen.getByLabelText("Password or recovery key from when it was made"), { target: { value: BACKUP_PASSWORD } });
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  await screen.findByRole("heading", { level: 1, name: "Where it goes" });
  fireEvent.click(screen.getByRole("button", { name: "Restore" }));
  await screen.findByRole("heading", { level: 1, name: "Replace your vault with this?" });
  fireEvent.click(screen.getByRole("button", { name: "Replace" }));
  await screen.findByRole("heading", { level: 1, name: "My vault is restored" });
  fireEvent.change(screen.getByLabelText(/^Password from /), { target: { value: BACKUP_PASSWORD } });
  fireEvent.click(screen.getByRole("button", { name: "Unlock" }));
  await screen.findByRole("heading", { level: 1, name: "All items" });
  // The restored vault is open, and the box is still on Home with its password: nothing was handed to the restored vault.
  const panel = await boxPanel();
  expect(vaultBox(panel).textContent).toBe("Home");
  expect(passwordBox(panel, "Home")).toBeTruthy();
  expect(debugState().capture?.choice).toMatchObject({ kind: "locked", vault: 8 });
  expect(sent("capture_choose")).toEqual([]);
  expect(shell.captureSlot()?.chosen).toBeNull();
});

test("a_password_typed_before_its_vault_becomes_unavailable_is_gone_when_the_vault_comes_back", async () => {
  const panel = await boxOverOneOpen();
  await chooseVault(panel, "Archive");
  fireEvent.change(passwordBox(panel, "Archive"), { target: { value: "half-typed-5" } });
  expect(passwordBox(panel, "Archive").value).toBe("half-typed-5");
  await act(async () => {
    shell.setAvailable(9, false);
    await refreshVaults();
  });
  await waitFor(() => {
    expect(boxDom().querySelector('[role="alert"]')?.textContent).toBe("Archive can't be reached now. Choose another vault.");
  });
  expect(boxDom().querySelector('input[type="password"]')).toBeNull();
  expectNoValue("half-typed-5");
  await act(async () => {
    shell.setAvailable(9, true);
    await refreshVaults();
  });
  await waitFor(() => {
    expect(boxDom().querySelector('input[type="password"]')).not.toBeNull();
  });
  expect(passwordBox(boxDom(), "Archive").value).toBe("");
  expectNoValue("half-typed-5");
});

test("the_vault_list_keeps_keyboard_focus_when_the_offers_change_while_the_box_is_blocked", async () => {
  const panel = await boxOverTwoLocked();
  await chooseVault(panel, "Archive");
  await act(async () => {
    shell.setAvailable(9, false);
    await refreshVaults();
  });
  await waitFor(() => {
    expect(boxDom().querySelector('[role="alert"]')).not.toBeNull();
  });
  const before = vaultBox(boxDom());
  before.focus();
  expect(document.activeElement).toBe(before);
  // Another vault leaves the list: the Vault list is made anew, with the same line under it, and keeps the focus.
  await act(async () => {
    await invoke("forget_vault", { vault: { list: shell.listIdentity(), id: 12 } });
    await refreshVaults();
  });
  await waitFor(() => {
    expect(vaultBox(boxDom())).not.toBe(before);
  });
  expect(before.isConnected).toBe(false);
  expect(document.activeElement).toBe(vaultBox(boxDom()));
});
