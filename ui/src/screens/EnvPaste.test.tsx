// Task 17's screens, in: a pasted `.env` (15a to 15c). The text goes from the paste to Rust once and the box stays empty; what comes
// back is names only (rows, bad line numbers, and which names clash in which folder), and the values wait in Rust under a token that
// Cancel, a lock or a late answer lets go of. A value never reaches the page, so most of these tests also look for one.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import App from "../App";
import { debugState, openPasteEnv, resetStoreForTests, unlock } from "../store";
import { expectNoAxe } from "../testing/axe";
import {
  ENV_KEYS_TOO_MANY,
  ENV_ROWS_CHANGED,
  ENV_TEXT_TOO_LARGE,
  ENV_TWICE,
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
/** The fake vault, so a test can look at its items as a save left them (the fake makes a new list for each write). */
let vault: FakeVault;

function stored(): FakeItem[] {
  return vault.items ?? [];
}

beforeEach(() => {
  for (const style of document.querySelectorAll("style")) style.remove();
  resetStoreForTests();
  invoke.mockReset();
  listen.mockReset();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-10T12:00:00Z"));
});

/** Made up, and built here, so no value is written in a file as a literal: each name gets its own, which no page word contains. */
const valueOf = (name: string): string => ["demo", name.toLowerCase(), "value", String(name.length * 1111)].join("-");

const NAMES = ["TELEGRAM_BOT_TOKEN", "WEBHOOK_URL", "REDIS_URL"];
const TEXT = NAMES.map((name) => `${name}=${valueOf(name)}`).join("\n");
/** A line that is no pair at all, with something in it that must never reach the page. */
const BAD_LINE = ["this", "line", "is", "not", "a", "pair", "demo-bad-line-text"].join(" ");

const OPENAI = itemId(30);
const TELEGRAM = itemId(31);
const REDIS_2 = itemId(32);

/** The sample vault with three keys: two in Agency support agent (FOLDER), one in Lineproof (FOLDER_2). */
function withKeys(): FakeItem[] {
  return [
    ...sampleItems(),
    { id: OPENAI, kind: "key", title: "OPENAI_API_KEY", collection: FOLDER, value: "old-openai", notes: "keep these notes" },
    { id: TELEGRAM, kind: "key", title: "TELEGRAM_BOT_TOKEN", collection: FOLDER, value: "old-telegram" },
    { id: REDIS_2, kind: "key", title: "REDIS_URL", collection: FOLDER_2, value: "old-redis" },
  ];
}

async function unlocked(options: { readOnly?: boolean; only?: FakeItem[] } = {}) {
  vault = { id: 7, name: "My vault", items: options.only ?? withKeys(), readOnly: options.readOnly ?? false };
  shell = installFakeShell(invoke, listen, [vault]);
  const view = render(<App />);
  const field = await screen.findByLabelText(/^Password for /);
  fireEvent.change(field, { target: { value: PASSWORD } });
  fireEvent.submit((field as HTMLInputElement).form as HTMLFormElement);
  await screen.findByRole("heading", { level: 1, name: "All items" });
  return view;
}

function sent(
  cmd: string,
): { token?: string; choices?: { index: number; action: string }[]; collection?: string | null; text?: string; clear_clipboard?: boolean }[] {
  return invoke.mock.calls.filter(([name]) => name === cmd).map(([, args]) => args as Record<string, never>);
}

function rail(): HTMLElement {
  return screen.getByRole("navigation", { name: "Vault and folders" });
}

async function openFolder(name: string) {
  fireEvent.click(within(rail()).getByRole("button", { name: new RegExp(`^${name}\\s+\\d+$`) }));
  await screen.findByRole("heading", { level: 1, name });
}

/** Opens a menu the way a click does. */
async function openMenu(button: HTMLElement): Promise<HTMLElement> {
  button.focus();
  fireEvent.pointerDown(button, { button: 0 });
  fireEvent.click(button);
  return screen.findByRole("menu");
}

/** Add, then Paste a .env, as a person would with the pointer. */
async function openPanel(): Promise<HTMLElement> {
  const menu = await openMenu(screen.getByRole("button", { name: "Add" }));
  fireEvent.click(within(menu).getByRole("menuitem", { name: "Paste a .env" }));
  return screen.findByRole("complementary", { name: "Paste a .env" });
}

function boxOf(panel: HTMLElement): HTMLTextAreaElement {
  return within(panel).getByLabelText<HTMLTextAreaElement>("Paste your .env here");
}

/** Pastes `text` into the box as the page hears it; false when the page stopped the paste from landing in the box. */
function pasteInto(box: HTMLElement, text: string): boolean {
  return fireEvent.paste(box, { clipboardData: { getData: () => text } });
}

/** Pastes and waits for the rows. */
async function pasteRows(panel: HTMLElement, text = TEXT): Promise<void> {
  pasteInto(boxOf(panel), text);
  await within(panel).findByRole("heading", { level: 3 });
  // The folder list names itself a moment after it is drawn.
  await within(panel).findByRole("combobox", { name: "Folder" });
}

function rowOf(panel: HTMLElement, name: string): HTMLElement {
  const found = within(panel)
    .getAllByRole("listitem")
    .find((item) => item.textContent.startsWith(name));
  if (found === undefined) throw new Error(`no row for ${name}`);
  return found;
}

/**
 * The bad-line sentence when rows were found: the results heading's description, read with the heading as it takes focus.
 * It is not an alert as well, or a screen reader says it twice (heard in NVDA, stage 7).
 */
async function badLineNote(panel: HTMLElement): Promise<HTMLElement> {
  const heading = within(panel).getByRole("heading", { level: 3 });
  // Read only because the heading takes focus: without that, the sentence would not be heard at all.
  await waitFor(() => {
    expect(document.activeElement).toBe(heading);
  });
  const id = heading.getAttribute("aria-describedby");
  expect(id, "the results heading has a description").not.toBeNull();
  const note = document.getElementById(id ?? "");
  expect(note, "its description is on the page").not.toBeNull();
  expect(within(panel).queryAllByRole("alert"), "and no alert says it again").toEqual([]);
  return note as HTMLElement;
}

function rowNames(panel: HTMLElement): string[] {
  return within(panel)
    .queryAllByRole("listitem")
    .map((item) => item.querySelector(".en")?.textContent ?? "");
}

function saveButton(panel: HTMLElement): HTMLElement {
  return within(panel).getByRole("button", { name: /^Save/ });
}

function isOff(button: HTMLElement): boolean {
  return button.getAttribute("aria-disabled") === "true";
}

/** Picks a folder in the panel's Folder list, as a person would with the pointer. */
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

/** The words of the toast at the foot of the window. */
function toastText(): string {
  return document.querySelector(".tstack")?.textContent ?? "";
}

/** No style element, and no style attribute in what the page draws but the library's own hidden inputs for its lists, which it sets by script. */
function expectNoStyle(container: Element) {
  const styled = Array.from(container.querySelectorAll("[style]")).filter(
    (element) => !(element instanceof HTMLInputElement && element.getAttribute("aria-hidden") === "true"),
  );
  expect(styled.map((element) => element.outerHTML)).toEqual([]);
  expect(container.querySelectorAll("style")).toHaveLength(0);
}

/** Every attribute value on the page, joined. */
function attributeText(root: Element): string {
  const found: string[] = [];
  for (const element of root.querySelectorAll("*")) {
    for (const name of element.getAttributeNames()) found.push(element.getAttribute(name) ?? "");
  }
  return found.join("\n");
}

/** Everything a person or a screen reader could be given of the page now, and everything the store holds: none of it may hold a value. */
function expectNoValue(values: string[] = NAMES.map(valueOf)) {
  const page = [
    document.documentElement.outerHTML,
    document.body.textContent,
    attributeText(document.documentElement),
    ...Array.from(document.querySelectorAll("input, textarea"), (box) => (box as HTMLInputElement).value),
    document.title,
    JSON.stringify(debugState()),
  ].join("\n");
  for (const value of values) expect(page, value).not.toContain(value);
  expect(page).not.toContain("demo-bad-line-text");
}

async function lockNow() {
  const live = shell.sessionOf(7);
  expect(live).toBeDefined();
  await act(async () => {
    shell.lock(live?.session ?? 0);
    await Promise.resolve();
  });
  await screen.findByLabelText(/^Password for /);
}

test("the_add_menu_lists_paste_a_env_after_note_set_apart", async () => {
  await unlocked();
  const menu = await openMenu(screen.getByRole("button", { name: "Add" }));
  expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Login", "Key", "Note", "File", "Paste a .env"]);
  // Set apart as drawn: one divider, before it and after File.
  const parts = Array.from(menu.querySelectorAll('[role="menuitem"], [role="separator"]')).map((part) => part.getAttribute("role"));
  expect(parts).toEqual(["menuitem", "menuitem", "menuitem", "menuitem", "separator", "menuitem"]);
});

test("paste_a_env_opens_the_empty_box_in_the_panel", async () => {
  const { container } = await unlocked();
  const panel = await openPanel();
  expect(within(panel).getByRole("heading", { level: 2, name: "Paste a .env" })).toBeTruthy();
  const box = boxOf(panel);
  expect(box.tagName).toBe("TEXTAREA");
  expect(box.placeholder).toBe("NAME=value");
  expect(box.getAttribute("spellcheck")).toBe("false");
  expect(box.autocomplete).toBe("off");
  expect(box.classList.contains("m")).toBe(true);
  expect(box.value).toBe("");
  await waitFor(() => {
    expect(document.activeElement).toBe(box);
  });
  expect(within(panel).getByText("What you paste is read into rows straight away, with the values hidden.")).toBeTruthy();
  expect(within(panel).getAllByRole("button").map((button) => button.getAttribute("aria-label") ?? button.textContent)).toEqual(["Close panel", "Cancel", "Save"]);
  expect(isOff(saveButton(panel))).toBe(true);
  // Nothing has gone to the shell, and the page draws no style of its own.
  expect(sent("env_read")).toEqual([]);
  expectNoStyle(container);
  await expectNoAxe(container);
});

test("paste_box_empties_at_once", async () => {
  await unlocked();
  const panel = await openPanel();
  const box = boxOf(panel);
  // The paste is stopped before it can land in the box, and the box is empty as the event returns: before any answer comes.
  const release = shell.holdEnvRead();
  expect(pasteInto(box, TEXT)).toBe(false);
  expect(box.value).toBe("");
  expectNoValue();
  // The text went to Rust once, as the paste's own text and with nothing else.
  const reads = sent("env_read");
  expect(reads).toHaveLength(1);
  expect(reads[0]?.text).toBe(TEXT);
  expect(Object.keys(reads[0] ?? {}).sort()).toEqual(["generation", "session", "text"]);
  release();
  await within(panel).findByRole("heading", { level: 3, name: "3 keys found" });
  expect(within(panel).queryByLabelText("Paste your .env here")).toBeNull();
  expectNoValue();
});

test("typed_characters_and_a_drop_are_not_taken", async () => {
  await unlocked();
  const panel = await openPanel();
  const box = boxOf(panel);
  fireEvent.change(box, { target: { value: `A=${valueOf("A")}` } });
  expect(box.value).toBe("");
  fireEvent.input(box, { target: { value: "B=1" } });
  expect(box.value).toBe("");
  expect(fireEvent.drop(box, { dataTransfer: { getData: () => TEXT, files: [] } })).toBe(false);
  expect(box.value).toBe("");
  expect(sent("env_read")).toEqual([]);
  // A paste of no text at all (a file, a picture) is not a paste to read.
  pasteInto(box, "");
  expect(sent("env_read")).toEqual([]);
  expect(within(panel).queryByRole("alert")).toBeNull();
});

test("rows_show_names_with_values_hidden", async () => {
  const { container } = await unlocked();
  const panel = await openPanel();
  await pasteRows(panel);
  expect(within(panel).getByRole("heading", { level: 3, name: "3 keys found" })).toBeTruthy();
  expect(rowNames(panel)).toEqual(NAMES);
  for (const name of NAMES) {
    const row = rowOf(panel, name);
    expect(row.querySelector(".en")?.textContent).toBe(name);
    // The dots stand for the value, and say so; nothing here can reveal it.
    expect(within(row).getByRole("img", { name: "Value hidden" })).toBeTruthy();
    expect(within(row).getByRole("button", { name: `Leave out ${name}` })).toBeTruthy();
    expect(within(row).queryByText("Already here")).toBeNull();
  }
  expect(within(panel).queryByRole("button", { name: /Reveal|Show/ })).toBeNull();
  // The folder, with No folder in it (All items is on screen, so it is the first and chosen), then Cancel and Save 3 keys.
  expect(within(panel).getByRole("combobox", { name: "Folder" }).textContent).toBe("No folder");
  expect(within(panel).getAllByRole("button").map((button) => button.getAttribute("aria-label") ?? button.textContent)).toEqual([
    "Close panel",
    "Leave out TELEGRAM_BOT_TOKEN",
    "Leave out WEBHOOK_URL",
    "Leave out REDIS_URL",
    "Cancel",
    "Save 3 keys",
  ]);
  expect(isOff(saveButton(panel))).toBe(false);
  expect(within(panel).queryByRole("alert")).toBeNull();
  expectNoValue();
  expectNoStyle(container);
  await expectNoAxe(container);
});

test("one_key_says_1_key_found_and_save_1_key", async () => {
  await unlocked();
  const panel = await openPanel();
  await pasteRows(panel, `ONLY_ONE=${valueOf("ONLY_ONE")}`);
  expect(within(panel).getByRole("heading", { level: 3, name: "1 key found" })).toBeTruthy();
  expect(saveButton(panel).textContent).toBe("Save 1 key");
});

test("leaving_a_row_out_changes_the_count_and_turns_save_off_at_none", async () => {
  await unlocked();
  const panel = await openPanel();
  await pasteRows(panel);
  fireEvent.click(within(rowOf(panel, "WEBHOOK_URL")).getByRole("button", { name: "Leave out WEBHOOK_URL" }));
  expect(rowNames(panel)).toEqual(["TELEGRAM_BOT_TOKEN", "REDIS_URL"]);
  expect(saveButton(panel).textContent).toBe("Save 2 keys");
  fireEvent.click(within(rowOf(panel, "REDIS_URL")).getByRole("button", { name: "Leave out REDIS_URL" }));
  expect(saveButton(panel).textContent).toBe("Save 1 key");
  // Focus does not fall to the page when the button that had it goes: it moves to the next one left.
  await waitFor(() => {
    expect(document.activeElement).toBe(within(rowOf(panel, "TELEGRAM_BOT_TOKEN")).getByRole("button", { name: "Leave out TELEGRAM_BOT_TOKEN" }));
  });
  fireEvent.click(within(rowOf(panel, "TELEGRAM_BOT_TOKEN")).getByRole("button", { name: "Leave out TELEGRAM_BOT_TOKEN" }));
  expect(rowNames(panel)).toEqual([]);
  expect(saveButton(panel).textContent).toBe("Save");
  expect(isOff(saveButton(panel))).toBe(true);
  await waitFor(() => {
    expect(document.activeElement).toBe(within(panel).getByRole("button", { name: "Cancel" }));
  });
  // Save is off: pressing it sends nothing.
  fireEvent.click(saveButton(panel));
  expect(sent("env_save")).toEqual([]);
});

test("bad_line_by_number", async () => {
  const { container } = await unlocked();
  const panel = await openPanel();
  const lines = ["A_ONE=1", "A_TWO=2", "# a comment", BAD_LINE, "A_THREE=3"].join("\n");
  await pasteRows(panel, lines);
  // The number only: never what the line said.
  expect((await badLineNote(panel)).textContent).toBe("Line 4 can't be read, so it was left out. Check it in your .env.");
  expect(rowNames(panel)).toEqual(["A_ONE", "A_TWO", "A_THREE"]);
  expectNoValue();
  await expectNoAxe(container);
});

test("several_bad_lines_say_their_numbers_up_to_five_and_then_how_many_more", async () => {
  await unlocked();
  const sayings: [number[], string][] = [
    [[4, 9], "Lines 4 and 9 can't be read, so they were left out. Check them in your .env."],
    [[4, 9, 12], "Lines 4, 9 and 12 can't be read, so they were left out. Check them in your .env."],
    [[1, 3, 5, 7, 9], "Lines 1, 3, 5, 7 and 9 can't be read, so they were left out. Check them in your .env."],
    [[1, 3, 5, 7, 9, 11], "Lines 1, 3, 5, 7, 9 and 1 more can't be read, so they were left out. Check them in your .env."],
    [[1, 2, 3, 4, 5, 6, 7, 8], "Lines 1, 2, 3, 4, 5 and 3 more can't be read, so they were left out. Check them in your .env."],
  ];
  for (const [bad, words] of sayings) {
    const panel = await openPanel();
    // One good line, then the bad ones at their numbers (line 1 is the good one when 1 is not a bad number).
    const total = Math.max(...bad) + 1;
    const text = Array.from({ length: total }, (_, at) => (bad.includes(at + 1) ? BAD_LINE : `KEY_${String(at + 1)}=${valueOf("K")}`)).join("\n");
    await pasteRows(panel, text);
    expect((await badLineNote(panel)).textContent, JSON.stringify(bad)).toBe(words);
    fireEvent.click(within(panel).getByRole("button", { name: "Cancel" }));
    await waitFor(() => {
      expect(screen.queryByRole("complementary")).toBeNull();
    });
  }
});

test("nothing_read_stays_on_the_box_and_says_so", async () => {
  await unlocked();
  const panel = await openPanel();
  pasteInto(boxOf(panel), "# only a comment\n\n");
  await waitFor(() => {
    expect(within(panel).getAllByRole("alert").map((alert) => alert.textContent)).toEqual(["No keys were found in what you pasted."]);
  });
  expect(boxOf(panel).value).toBe("");
  expect(isOff(saveButton(panel))).toBe(true);
  // With a line that can't be read, the bad-line sentence comes too.
  pasteInto(boxOf(panel), `# comment\n${BAD_LINE}\n`);
  await waitFor(() => {
    expect(within(panel).getAllByRole("alert").map((alert) => alert.textContent)).toEqual([
      "No keys were found in what you pasted.",
      "Line 2 can't be read, so it was left out. Check it in your .env.",
    ]);
  });
  // Nothing waits in Rust, so Cancel has nothing to let go of.
  expect(shell.envHeld()).toBe(0);
  fireEvent.click(within(panel).getByRole("button", { name: "Cancel" }));
  expect(sent("env_save")).toEqual([]);
  expectNoValue();
});

test("a_paste_over_the_limit_says_so_and_stays_on_the_box", async () => {
  await unlocked();
  const panel = await openPanel();
  shell.refuseNext("env_read", ENV_TEXT_TOO_LARGE);
  pasteInto(boxOf(panel), TEXT);
  await waitFor(() => {
    expect(within(panel).getByRole("alert").textContent).toBe("That's too much to paste at once. A pasted .env can be up to 1 MB.");
  });
  expect(boxOf(panel).value).toBe("");
  shell.refuseNext("env_read", ENV_KEYS_TOO_MANY);
  pasteInto(boxOf(panel), TEXT);
  await waitFor(() => {
    expect(within(panel).getByRole("alert").textContent).toBe("That's too many keys to paste at once. A pasted .env can hold up to 500 keys.");
  });
  expectNoValue();
});

test("clash_offers_replace_keep_both_cancel", async () => {
  const { container } = await unlocked();
  await openFolder("Agency support agent");
  const panel = await openPanel();
  expect(within(panel).queryByRole("combobox", { name: "Folder" })).toBeNull();
  await pasteRows(panel, ["OPENAI_API_KEY=" + valueOf("OPENAI_API_KEY"), "WEBHOOK_URL=" + valueOf("WEBHOOK_URL"), "REDIS_URL=" + valueOf("REDIS_URL")].join("\n"));
  // The folder on screen is chosen, and OPENAI_API_KEY is in it already.
  expect(within(panel).getByRole("combobox", { name: "Folder" }).textContent).toBe("Agency support agent");
  const clash = rowOf(panel, "OPENAI_API_KEY");
  expect(within(clash).getByText("Already here")).toBeTruthy();
  const group = within(clash).getByRole("group", { name: "What to do with this key" });
  expect(within(group).getAllByRole("button").map((button) => button.textContent)).toEqual(["Replace", "Keep both", "Cancel"]);
  // Replace is chosen to start with, and the choice is said in more than colour.
  const pressed = () => within(group).getAllByRole("button").filter((button) => button.getAttribute("aria-pressed") === "true").map((button) => button.textContent);
  expect(pressed()).toEqual(["Replace"]);
  expect(within(clash).queryByText(/Saves as/)).toBeNull();
  // The other rows are plain.
  expect(within(rowOf(panel, "WEBHOOK_URL")).queryByText("Already here")).toBeNull();
  expect(within(rowOf(panel, "REDIS_URL")).queryByText("Already here")).toBeNull();
  await expectNoAxe(container);

  // Keep both says the name it would be saved under, from the shell's `saved_as`.
  fireEvent.click(within(group).getByRole("button", { name: "Keep both" }));
  expect(pressed()).toEqual(["Keep both"]);
  expect(within(clash).getByText("Saves as OPENAI_API_KEY_2")).toBeTruthy();
  fireEvent.click(within(group).getByRole("button", { name: "Replace" }));
  expect(pressed()).toEqual(["Replace"]);
  expect(within(clash).queryByText(/Saves as/)).toBeNull();

  // Cancel on a row leaves that key out, as its X does.
  fireEvent.click(within(group).getByRole("button", { name: "Cancel" }));
  expect(rowNames(panel)).toEqual(["WEBHOOK_URL", "REDIS_URL"]);
  expect(saveButton(panel).textContent).toBe("Save 2 keys");
});

test("keep_both_takes_the_next_free_number_and_a_name_twice_in_one_paste_clashes", async () => {
  await unlocked({ only: [...withKeys(), { id: itemId(33), kind: "key", title: "OPENAI_API_KEY_2", collection: FOLDER, value: "taken" }] });
  await openFolder("Agency support agent");
  const panel = await openPanel();
  await pasteRows(panel, ["OPENAI_API_KEY=1", "NEW_ONE=2", "NEW_ONE=3"].join("\n"));
  const first = rowOf(panel, "OPENAI_API_KEY");
  fireEvent.click(within(first).getByRole("button", { name: "Keep both" }));
  // OPENAI_API_KEY_2 is a live key there, so the next free number is 3.
  expect(within(first).getByText("Saves as OPENAI_API_KEY_3")).toBeTruthy();
  // The second NEW_ONE clashes with the first, an earlier row of the same paste.
  const rows = within(panel).getAllByRole("listitem");
  expect(within(rows[1] as HTMLElement).queryByText("Already here")).toBeNull();
  expect(within(rows[2] as HTMLElement).getByText("Already here")).toBeTruthy();
  fireEvent.click(within(rows[2] as HTMLElement).getByRole("button", { name: "Keep both" }));
  expect(within(rows[2] as HTMLElement).getByText("Saves as NEW_ONE_2")).toBeTruthy();
});

test("changing_the_folder_moves_already_here_with_no_call_sent", async () => {
  await unlocked();
  const panel = await openPanel();
  await pasteRows(panel, ["OPENAI_API_KEY=1", "WEBHOOK_URL=2", "REDIS_URL=3"].join("\n"));
  // No folder: nothing clashes.
  expect(within(panel).queryAllByText("Already here")).toHaveLength(0);
  expect(sent("env_read")).toHaveLength(1);

  await pickFolder(panel, "Agency support agent");
  expect(within(rowOf(panel, "OPENAI_API_KEY")).getByText("Already here")).toBeTruthy();
  expect(within(rowOf(panel, "REDIS_URL")).queryByText("Already here")).toBeNull();
  // A row that newly clashes starts on Replace.
  expect(within(rowOf(panel, "OPENAI_API_KEY")).getByRole("button", { name: "Replace" }).getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(within(rowOf(panel, "OPENAI_API_KEY")).getByRole("button", { name: "Keep both" }));

  // Another folder: the mark moves to the name that is there, and the Keep both is worked out afresh.
  await pickFolder(panel, "Lineproof");
  expect(within(rowOf(panel, "OPENAI_API_KEY")).queryByText("Already here")).toBeNull();
  expect(within(rowOf(panel, "REDIS_URL")).getByText("Already here")).toBeTruthy();
  expect(within(rowOf(panel, "REDIS_URL")).getByRole("button", { name: "Replace" }).getAttribute("aria-pressed")).toBe("true");
  // And back to none: every row is a plain save again.
  await pickFolder(panel, "No folder");
  expect(within(panel).queryAllByText("Already here")).toHaveLength(0);
  // None of it asked Rust anything: the one read is the only call.
  expect(sent("env_read")).toHaveLength(1);
  expect(sent("env_save")).toEqual([]);
});

test("picking_the_folder_already_chosen_keeps_the_picks", async () => {
  await unlocked();
  await openFolder("Agency support agent");
  const panel = await openPanel();
  await pasteRows(panel, ["OPENAI_API_KEY=1", "FRESH_KEY=2"].join("\n"));
  const clash = rowOf(panel, "OPENAI_API_KEY");
  fireEvent.click(within(clash).getByRole("button", { name: "Keep both" }));
  expect(within(clash).getByText("Saves as OPENAI_API_KEY_2")).toBeTruthy();
  // Opening the Folder list and choosing the folder that is already chosen is no change: Keep both stays.
  await pickFolder(panel, "Agency support agent");
  expect(within(rowOf(panel, "OPENAI_API_KEY")).getByRole("button", { name: "Keep both" }).getAttribute("aria-pressed")).toBe("true");
  expect(within(rowOf(panel, "OPENAI_API_KEY")).getByText("Saves as OPENAI_API_KEY_2")).toBeTruthy();
  // So the save sends Keep both, and the key that is there is not overwritten.
  fireEvent.click(saveButton(panel));
  await waitFor(() => {
    expect(sent("env_save")).toHaveLength(1);
  });
  expect(sent("env_save")[0]?.choices).toEqual([
    { index: 0, action: "keep_both" },
    { index: 1, action: "save" },
  ]);
  await waitFor(() => {
    expect(stored().some((item) => item.title === "OPENAI_API_KEY_2")).toBe(true);
  });
  expect(stored().find((item) => item.id === OPENAI)?.value).toBe("old-openai");
});

test("a_save_gives_focus_back_to_add_where_the_panel_was_opened_from_it", async () => {
  await unlocked();
  const panel = await openPanel();
  await pasteRows(panel, `ADD_OPENED=${valueOf("ADD_OPENED")}`);
  fireEvent.click(saveButton(panel));
  await waitFor(() => {
    expect(toastText()).toContain("Saved 1 key to No folder");
  });
  expect(screen.queryByRole("complementary", { name: "Paste a .env" })).toBeNull();
  await waitFor(() => {
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Add" }));
  });
});

test("a_save_gives_focus_back_to_the_folders_menu_where_the_panel_was_opened_from_it", async () => {
  await unlocked();
  await openFolder("Lineproof");
  const menu = await openMenu(screen.getByRole("button", { name: "More for this folder" }));
  fireEvent.click(within(menu).getByRole("menuitem", { name: "Paste a .env" }));
  const panel = await screen.findByRole("complementary", { name: "Paste a .env" });
  await pasteRows(panel, `MENU_OPENED=${valueOf("MENU_OPENED")}`);
  fireEvent.click(saveButton(panel));
  await waitFor(() => {
    expect(toastText()).toContain("Saved 1 key to Lineproof");
  });
  expect(screen.queryByRole("complementary", { name: "Paste a .env" })).toBeNull();
  await waitFor(() => {
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "More for this folder" }));
  });
});

test("a_save_that_ends_after_the_person_went_to_another_vault_does_not_take_focus", async () => {
  vault = { id: 7, name: "My vault", items: withKeys() };
  shell = installFakeShell(invoke, listen, [vault, { id: 8, name: "Home", items: sampleItems() }]);
  render(<App />);
  const field = await screen.findByLabelText(/^Password for /);
  fireEvent.change(field, { target: { value: PASSWORD } });
  fireEvent.submit((field as HTMLInputElement).form as HTMLFormElement);
  await screen.findByRole("heading", { level: 1, name: "All items" });
  const panel = await openPanel();
  await pasteRows(panel, `SLOW_SAVE=${valueOf("SLOW_SAVE")}`);
  const release = shell.holdEnvSave();
  fireEvent.click(saveButton(panel));
  await waitFor(() => {
    expect(sent("env_save")).toHaveLength(1);
  });
  // While the shell still has the save, the person unlocks another vault, which is the one on screen now; the first vault's panel
  // is gone from the screen, though its record keeps the tool.
  await act(async () => {
    expect(await unlock(8, PASSWORD)).toBe("opened");
  });
  await waitFor(() => {
    expect(screen.queryByRole("complementary", { name: "Paste a .env" })).toBeNull();
  });
  const filter = screen.getByLabelText<HTMLInputElement>("Filter this list");
  filter.focus();
  release();
  await waitFor(() => {
    expect(debugState().sessions.find((entry) => entry.vaultId === 7)?.tool).toBeNull();
  });
  // Let any move of focus that was asked for happen.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  expect(document.activeElement).toBe(filter);
  expect(stored().some((item) => item.title === "SLOW_SAVE")).toBe(true);
});

test("save_sends_one_choice_per_row_with_the_right_actions_and_the_folder", async () => {
  await unlocked();
  await openFolder("Agency support agent");
  const panel = await openPanel();
  const text = ["OPENAI_API_KEY=" + valueOf("OPENAI_API_KEY"), "FRESH_KEY=" + valueOf("FRESH_KEY"), "TELEGRAM_BOT_TOKEN=" + valueOf("TELEGRAM_BOT_TOKEN"), "LEFT_OUT=" + valueOf("LEFT_OUT")].join("\n");
  await pasteRows(panel, text);
  // Row 0 clashes and replaces, row 1 is plain, row 2 clashes and keeps both, row 3 is left out.
  fireEvent.click(within(rowOf(panel, "TELEGRAM_BOT_TOKEN")).getByRole("button", { name: "Keep both" }));
  fireEvent.click(within(rowOf(panel, "LEFT_OUT")).getByRole("button", { name: "Leave out LEFT_OUT" }));
  expect(saveButton(panel).textContent).toBe("Save 3 keys");
  const listReads = sent("list_items").length;
  fireEvent.click(saveButton(panel));
  await waitFor(() => {
    expect(screen.queryByRole("complementary", { name: "Paste a .env" })).toBeNull();
  });
  const saves = sent("env_save");
  expect(saves).toHaveLength(1);
  const [save] = saves;
  expect(Object.keys(save ?? {}).sort()).toEqual(["choices", "clear_clipboard", "collection", "generation", "session", "token"]);
  expect(save?.collection).toBe(FOLDER);
  // The tick box ("Clear the clipboard after saving") is on to begin with, and is sent as it stands.
  expect(save?.clear_clipboard).toBe(true);
  expect(save?.choices).toEqual([
    { index: 0, action: "replace" },
    { index: 1, action: "save" },
    { index: 2, action: "keep_both" },
    { index: 3, action: "leave_out" },
  ]);
  // What the shell wrote: the replaced key kept its notes, the plain one is new, the kept-both one is under its other name.
  expect(stored().find((item) => item.id === OPENAI)?.value).toBe(valueOf("OPENAI_API_KEY"));
  expect(stored().find((item) => item.id === OPENAI)?.notes).toBe("keep these notes");
  expect(stored().find((item) => item.title === "FRESH_KEY")?.collection).toBe(FOLDER);
  expect(stored().find((item) => item.title === "TELEGRAM_BOT_TOKEN_2")?.value).toBe(valueOf("TELEGRAM_BOT_TOKEN"));
  expect(stored().some((item) => item.title === "LEFT_OUT")).toBe(false);
  // The panel is gone, the list was read again, and the message says how many and where.
  expect(sent("list_items").length).toBeGreaterThan(listReads);
  expect(toastText()).toContain("Saved 3 keys to Agency support agent");
  expect(shell.envHeld()).toBe(0);
  await waitFor(() => {
    expect(within(screen.getByRole("main")).getByText("FRESH_KEY")).toBeTruthy();
  });
  expectNoValue(NAMES.map(valueOf).concat(["OPENAI_API_KEY", "FRESH_KEY", "LEFT_OUT"].map(valueOf)));
});

test("save_to_no_folder_and_one_key_say_it_in_the_singular", async () => {
  await unlocked();
  const panel = await openPanel();
  await pasteRows(panel, `SOLO_KEY=${valueOf("SOLO_KEY")}`);
  fireEvent.click(saveButton(panel));
  await waitFor(() => {
    expect(toastText()).toContain("Saved 1 key to No folder");
  });
  expect(sent("env_save")[0]?.collection).toBeNull();
  expect(stored().find((item) => item.title === "SOLO_KEY")?.collection ?? null).toBeNull();
});

test("a_refusal_shows_its_words_returns_to_the_empty_box_and_sends_no_second_save", async () => {
  await unlocked();
  await openFolder("Agency support agent");
  const panel = await openPanel();
  await pasteRows(panel);
  const listReads = sent("list_items").length;
  shell.refuseNext("env_save", ENV_ROWS_CHANGED);
  fireEvent.click(saveButton(panel));
  // The refusal is said in the panel as an alert, in the table's words; the rows, the token and the marks are forgotten.
  const alert = await within(panel).findByRole("alert");
  expect(alert.textContent).toBe("This folder changed while you were choosing. Paste the .env again.");
  expect(boxOf(panel).value).toBe("");
  expect(within(panel).queryAllByRole("listitem")).toHaveLength(0);
  expect(isOff(saveButton(panel))).toBe(true);
  await waitFor(() => {
    expect(document.activeElement).toBe(boxOf(panel));
  });
  // A save cut short can have written some, so the list is read again.
  await waitFor(() => {
    expect(sent("list_items").length).toBeGreaterThan(listReads);
  });
  // Nothing more is sent: no second save, and Cancel has no token to let go of.
  fireEvent.click(saveButton(panel));
  fireEvent.click(within(panel).getByRole("button", { name: "Cancel" }));
  expect(sent("env_save")).toHaveLength(1);
  expectNoValue();

  // Another refusal has its own words: Replace found the name twice.
  const again = await openPanel();
  await pasteRows(again);
  shell.refuseNext("env_save", ENV_TWICE);
  fireEvent.click(saveButton(again));
  expect((await within(again).findByRole("alert")).textContent).toBe("A key name is in this folder twice. Rename or move one, then try again.");
});

test("a_token_the_shell_let_go_of_says_so_and_asks_for_the_paste_again", async () => {
  await unlocked();
  const panel = await openPanel();
  await pasteRows(panel);
  shell.expireEnvTokens();
  fireEvent.click(saveButton(panel));
  const alert = await within(panel).findByRole("alert");
  expect(alert.textContent).toBe("Lockbox let go of the pasted keys after 5 minutes. Paste the .env again.");
  expect(boxOf(panel).value).toBe("");
  expect(sent("env_save")).toHaveLength(1);
});

test("cancel_sends_the_all_leave_out_save_once_and_gives_focus_back_to_add", async () => {
  await unlocked();
  const panel = await openPanel();
  await pasteRows(panel);
  expect(shell.envHeld()).toBe(1);
  fireEvent.click(within(panel).getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("complementary", { name: "Paste a .env" })).toBeNull();
  const saves = sent("env_save");
  expect(saves).toHaveLength(1);
  expect(saves[0]?.choices).toEqual([
    { index: 0, action: "leave_out" },
    { index: 1, action: "leave_out" },
    { index: 2, action: "leave_out" },
  ]);
  expect(saves[0]?.collection).toBeNull();
  // Rust let the values go at once, and nothing of the outcome is shown.
  await waitFor(() => {
    expect(shell.envHeld()).toBe(0);
  });
  expect(toastText()).toBe("");
  await waitFor(() => {
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Add" }));
  });
});

test("the_panels_close_and_escape_let_go_of_the_values_too", async () => {
  await unlocked();
  const first = await openPanel();
  await pasteRows(first);
  fireEvent.click(within(first).getByRole("button", { name: "Close panel" }));
  expect(screen.queryByRole("complementary", { name: "Paste a .env" })).toBeNull();
  expect(sent("env_save")).toHaveLength(1);
  expect(shell.envHeld()).toBe(0);

  const second = await openPanel();
  await pasteRows(second);
  fireEvent.keyDown(within(second).getByRole("button", { name: "Cancel" }), { key: "Escape" });
  expect(screen.queryByRole("complementary", { name: "Paste a .env" })).toBeNull();
  expect(sent("env_save")).toHaveLength(2);
  expect(shell.envHeld()).toBe(0);
});

test("escape_in_the_folder_list_closes_the_list_and_not_the_panel", async () => {
  await unlocked();
  const panel = await openPanel();
  await pasteRows(panel);
  const list = within(panel).getByRole("combobox", { name: "Folder" });
  fireEvent.pointerDown(list, { button: 0 });
  fireEvent.click(list);
  const options = await screen.findAllByRole("option");
  fireEvent.keyDown(options[0] as HTMLElement, { key: "Escape" });
  expect(screen.queryByRole("complementary", { name: "Paste a .env" })).not.toBeNull();
  expect(sent("env_save")).toEqual([]);
});

test("opening_another_tool_lets_go_of_the_values", async () => {
  await unlocked();
  const panel = await openPanel();
  await pasteRows(panel);
  const menu = await openMenu(screen.getByRole("button", { name: "Add" }));
  fireEvent.click(within(menu).getByRole("menuitem", { name: "Key" }));
  await screen.findByRole("complementary", { name: "New key" });
  expect(screen.queryByRole("complementary", { name: "Paste a .env" })).toBeNull();
  const saves = sent("env_save");
  expect(saves).toHaveLength(1);
  expect(saves[0]?.choices?.every((choice) => choice.action === "leave_out")).toBe(true);
  await waitFor(() => {
    expect(shell.envHeld()).toBe(0);
  });
});

test("picking_an_item_lets_go_of_the_values", async () => {
  await unlocked();
  const panel = await openPanel();
  await pasteRows(panel);
  fireEvent.click(await screen.findByRole("button", { name: /^Note:\s*Rotation steps/ }));
  await screen.findByRole("complementary", { name: "Rotation steps" });
  expect(sent("env_save")).toHaveLength(1);
  expect(shell.envHeld()).toBe(0);
});

test("a_lock_loses_the_panel_with_no_alert_and_sends_nothing", async () => {
  await unlocked();
  const panel = await openPanel();
  await pasteRows(panel);
  expect(shell.envHeld()).toBe(1);
  await lockNow();
  expect(screen.queryByRole("complementary")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  // The lock itself let go of the values in Rust: the page sends nothing more, and says nothing.
  expect(sent("env_save")).toEqual([]);
  expect(shell.envHeld()).toBe(0);
  expectNoValue();
});

test("a_lock_while_a_read_is_in_flight_shows_nothing_and_sends_nothing", async () => {
  await unlocked();
  const panel = await openPanel();
  const release = shell.holdEnvRead();
  pasteInto(boxOf(panel), TEXT);
  await lockNow();
  release();
  await act(async () => {
    await Promise.resolve();
  });
  expect(screen.queryByRole("alert")).toBeNull();
  expect(sent("env_save")).toEqual([]);
  expectNoValue();
});

test("a_lock_while_a_save_is_in_flight_says_nothing", async () => {
  await unlocked();
  const panel = await openPanel();
  await pasteRows(panel);
  const release = shell.holdEnvSave();
  fireEvent.click(saveButton(panel));
  await lockNow();
  release();
  await act(async () => {
    await Promise.resolve();
  });
  expect(screen.queryByRole("alert")).toBeNull();
  expect(sent("env_save")).toHaveLength(1);
});

test("a_late_read_after_the_panel_closed_is_dropped_and_its_token_let_go", async () => {
  await unlocked();
  const panel = await openPanel();
  const release = shell.holdEnvRead();
  pasteInto(boxOf(panel), TEXT);
  // Nothing is held yet, so closing sends nothing.
  fireEvent.click(within(panel).getByRole("button", { name: "Cancel" }));
  expect(sent("env_save")).toEqual([]);
  expect(shell.envHeld()).toBe(1);
  release();
  // The answer arrives: it is dropped, nothing shows, and its token is let go the way Cancel does it.
  await waitFor(() => {
    expect(sent("env_save")).toHaveLength(1);
  });
  expect(sent("env_save")[0]?.choices).toEqual([
    { index: 0, action: "leave_out" },
    { index: 1, action: "leave_out" },
    { index: 2, action: "leave_out" },
  ]);
  await waitFor(() => {
    expect(shell.envHeld()).toBe(0);
  });
  expect(screen.queryByRole("complementary")).toBeNull();
  expectNoValue();
});

test("a_late_read_after_a_newer_paste_is_dropped_and_its_token_let_go", async () => {
  await unlocked();
  const panel = await openPanel();
  const release = shell.holdEnvRead();
  pasteInto(boxOf(panel), `OLDER_ONE=${valueOf("OLDER_ONE")}`);
  pasteInto(boxOf(panel), `NEWER_ONE=${valueOf("NEWER_ONE")}\nNEWER_TWO=${valueOf("NEWER_TWO")}`);
  expect(shell.envHeld()).toBe(2);
  release();
  await within(panel).findByRole("heading", { level: 3, name: "2 keys found" });
  // Only the newer paste's rows show, and the older one's token was let go.
  expect(rowNames(panel)).toEqual(["NEWER_ONE", "NEWER_TWO"]);
  await waitFor(() => {
    expect(shell.envHeld()).toBe(1);
  });
  expect(sent("env_save")).toHaveLength(1);
  expect(sent("env_save")[0]?.choices).toEqual([{ index: 0, action: "leave_out" }]);
  // Saving sends the newer paste's token and its two rows.
  fireEvent.click(saveButton(panel));
  await waitFor(() => {
    expect(sent("env_save")).toHaveLength(2);
  });
  expect(sent("env_save")[1]?.choices).toHaveLength(2);
  expect(sent("env_save")[1]?.token).not.toBe(sent("env_save")[0]?.token);
});

test("reopening_paste_from_another_folder_starts_afresh_and_lets_go_of_the_old_rows", async () => {
  await unlocked();
  await openFolder("Agency support agent");
  const first = await openPanel();
  await pasteRows(first, `FIRST_ROWS=${valueOf("FIRST_ROWS")}`);
  expect(shell.envHeld()).toBe(1);
  // With the panel still open, another folder is picked and that folder's own Paste a .env is chosen.
  await openFolder("Lineproof");
  const menu = await openMenu(screen.getByRole("button", { name: "More for this folder" }));
  fireEvent.click(within(menu).getByRole("menuitem", { name: "Paste a .env" }));
  await waitFor(() => {
    expect(within(screen.getByRole("complementary", { name: "Paste a .env" })).queryAllByRole("listitem")).toHaveLength(0);
  });
  const second = screen.getByRole("complementary", { name: "Paste a .env" });
  // The old rows and their destination are gone, an empty box is there, and the old values were let go.
  expect(boxOf(second).value).toBe("");
  expect(within(second).queryByRole("combobox", { name: "Folder" })).toBeNull();
  expect(sent("env_save")).toHaveLength(1);
  expect(sent("env_save")[0]?.choices).toEqual([{ index: 0, action: "leave_out" }]);
  await waitFor(() => {
    expect(shell.envHeld()).toBe(0);
  });
  // The new paste is for the folder now on screen.
  await pasteRows(second, `SECOND_ROWS=${valueOf("SECOND_ROWS")}`);
  expect(within(second).getByRole("combobox", { name: "Folder" }).textContent).toBe("Lineproof");
  fireEvent.click(saveButton(second));
  await waitFor(() => {
    expect(toastText()).toContain("Saved 1 key to Lineproof");
  });
  expect(sent("env_save")[1]?.collection).toBe(FOLDER_2);
  expect(stored().some((item) => item.title === "FIRST_ROWS")).toBe(false);
});

test("the_results_heading_takes_focus_and_the_bad_lines_are_read_once_with_it", async () => {
  await unlocked();
  const panel = await openPanel();
  await pasteRows(panel, ["A_ONE=1", BAD_LINE, "A_TWO=2"].join("\n"));
  const heading = within(panel).getByRole("heading", { level: 3, name: "2 keys found" });
  // The box with focus went when the rows came: focus goes to the results heading, not to the page.
  await waitFor(() => {
    expect(document.activeElement).toBe(heading);
  });
  // The heading carries the sentence about the line as its description, so it is read once, with the heading; an alert as
  // well made NVDA say it twice.
  const note = await badLineNote(panel);
  expect(note.textContent).toBe("Line 2 can't be read, so it was left out. Check it in your .env.");
  expect(note.id).not.toBe("");
  // Without a bad line there is nothing to describe, and the focus is still on the heading.
  fireEvent.click(within(panel).getByRole("button", { name: "Cancel" }));
  const again = await openPanel();
  await pasteRows(again, "ONLY_ROW=1");
  const next = within(again).getByRole("heading", { level: 3, name: "1 key found" });
  await waitFor(() => {
    expect(document.activeElement).toBe(next);
  });
  expect(next.hasAttribute("aria-describedby")).toBe(false);
});

test("no_value_ever_in_the_dom_after_paste", async () => {
  await unlocked();
  await openFolder("Agency support agent");
  const panel = await openPanel();
  // Before: nothing. Every stage after: the pasted text is in no node, no attribute, no box, and not in the store.
  expectNoValue();
  const release = shell.holdEnvRead();
  pasteInto(boxOf(panel), `${TEXT}\nOPENAI_API_KEY=${valueOf("OPENAI_API_KEY")}\n${BAD_LINE}`);
  expectNoValue([...NAMES, "OPENAI_API_KEY"].map(valueOf));
  release();
  await within(panel).findByRole("heading", { level: 3 });
  expectNoValue([...NAMES, "OPENAI_API_KEY"].map(valueOf));
  fireEvent.click(within(rowOf(panel, "OPENAI_API_KEY")).getByRole("button", { name: "Keep both" }));
  fireEvent.click(within(rowOf(panel, "WEBHOOK_URL")).getByRole("button", { name: "Leave out WEBHOOK_URL" }));
  await pickFolder(panel, "Lineproof");
  expectNoValue([...NAMES, "OPENAI_API_KEY"].map(valueOf));
  // After a refusal, after Cancel and after a save.
  shell.refuseNext("env_save", ENV_ROWS_CHANGED);
  fireEvent.click(saveButton(panel));
  await within(panel).findByRole("alert");
  expectNoValue([...NAMES, "OPENAI_API_KEY"].map(valueOf));
  pasteInto(boxOf(panel), TEXT);
  await within(panel).findByRole("heading", { level: 3 });
  fireEvent.click(saveButton(panel));
  await waitFor(() => {
    expect(toastText()).toContain("Saved 3 keys");
  });
  expectNoValue([...NAMES, "OPENAI_API_KEY"].map(valueOf));
  // What the pasted text reached is the command and nothing else: the shell holds it, the page does not.
  expect(JSON.stringify(debugState())).not.toContain("demo-");
});

test("a_read_only_vault_offers_none_of_it", async () => {
  await unlocked({ readOnly: true });
  expect(screen.queryByRole("button", { name: "Add" })).toBeNull();
  await openFolder("Agency support agent");
  expect(screen.queryByRole("button", { name: "More for this folder" })).toBeNull();
  // And the store refuses to open it: nothing opens, nothing is sent.
  act(() => {
    openPasteEnv(shell.sessionOf(7)?.session ?? 0);
  });
  expect(debugState().sessions[0]?.tool).toBeNull();
  expect(screen.queryByRole("complementary")).toBeNull();
  expect(sent("env_read")).toEqual([]);
});

test("the_folders_menu_opens_it_with_that_folder_chosen_and_focus_returns_there", async () => {
  await unlocked();
  await openFolder("Lineproof");
  const more = screen.getByRole("button", { name: "More for this folder" });
  const menu = await openMenu(more);
  fireEvent.click(within(menu).getByRole("menuitem", { name: "Paste a .env" }));
  const panel = await screen.findByRole("complementary", { name: "Paste a .env" });
  await waitFor(() => {
    expect(document.activeElement).toBe(boxOf(panel));
  });
  await pasteRows(panel, `A_NEW_NAME=${valueOf("A_NEW_NAME")}`);
  expect(within(panel).getByRole("combobox", { name: "Folder" }).textContent).toBe("Lineproof");
  fireEvent.click(within(panel).getByRole("button", { name: "Cancel" }));
  await waitFor(() => {
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "More for this folder" }));
  });
});
