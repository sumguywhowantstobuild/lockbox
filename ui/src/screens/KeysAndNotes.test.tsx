// Task 12's screens: a key's details (3c, 3d), a note's text (3g), the empty vault and the empty folder (3e), the new-key
// and new-note forms (7a, 7b), and a key copied from a search (4b). Revealing a key is the one way its value reaches the
// page; a lock or another item takes it away.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import App from "../App";
import { debugState, resetStoreForTests } from "../store";
import { expectNoAxe } from "../testing/axe";
import { readBeside } from "../testing/files";
import {
  FOLDER,
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

beforeEach(() => {
  for (const style of document.querySelectorAll("style")) style.remove();
  resetStoreForTests();
  invoke.mockReset();
  listen.mockReset();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-06T12:00:00Z"));
});

/// Made up, and not any real key.
const BOT_TOKEN = "demo-telegram-7741-xxxx";
const OTHER_KEY = "demo-openai-0193-yyyy";
const TYPED_KEY = "demo-typed-by-hand-5521";
const SEARCH = "Search every unlocked vault";

const KEYS: FakeItem[] = [
  {
    id: itemId(20),
    kind: "key",
    title: "TELEGRAM_BOT_TOKEN",
    collection: FOLDER,
    value: BOT_TOKEN,
    modified_at: "2026-11-04T09:00:00Z",
  },
  { id: itemId(21), kind: "key", title: "OPENAI_API_KEY", collection: FOLDER, value: OTHER_KEY, modified_at: "2026-11-01T09:00:00Z" },
];

function withKeys(): FakeVault[] {
  return [{ id: 7, name: "My vault", items: [...sampleItems(), ...KEYS.map((key) => ({ ...key }))] }];
}

async function unlocked(list: FakeVault[] = withKeys()) {
  shell = installFakeShell(invoke, listen, list);
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

async function select(title: string) {
  const row = new RegExp(String.raw`^(Login|Key|Note|File):\s*${title}`);
  fireEvent.click(await screen.findByRole("button", { name: row }));
  return screen.findByRole("complementary", { name: title });
}

function sent(cmd: string): unknown[] {
  return invoke.mock.calls.filter(([name]) => name === cmd).map(([, args]): unknown => args);
}

/** Add, then the kind, as a person would with the pointer. */
async function openForm(kind: "Login" | "Key" | "Note"): Promise<HTMLElement> {
  const add = screen.getByRole("button", { name: "Add" });
  add.focus();
  fireEvent.pointerDown(add, { button: 0 });
  fireEvent.click(add);
  const menu = await screen.findByRole("menu");
  fireEvent.click(within(menu).getByRole("menuitem", { name: kind }));
  return screen.findByRole("complementary", { name: `New ${kind.toLowerCase()}` });
}

function typeInto(form: HTMLElement, label: string, value: string) {
  fireEvent.change(within(form).getByLabelText(label), { target: { value } });
}

function inputOf(form: HTMLElement, label: string): HTMLInputElement {
  return within(form).getByLabelText<HTMLInputElement>(label);
}

/** The text of every attribute on the page, which must hold no value. */
function attributeText(root: HTMLElement): string {
  const found: string[] = [];
  for (const element of root.querySelectorAll("*")) {
    for (const name of element.getAttributeNames()) found.push(element.getAttribute(name) ?? "");
  }
  return found.join("\n");
}

/** A selection that holds all of `element`'s text, as dragging over it or Select all would. */
function selectAllOf(element: HTMLElement) {
  const range = document.createRange();
  range.selectNodeContents(element);
  const selection = document.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

test("the_add_menu_offers_login_key_and_note_equally", async () => {
  await unlocked();
  const add = screen.getByRole("button", { name: "Add" });
  fireEvent.pointerDown(add, { button: 0 });
  fireEvent.click(add);
  const menu = await screen.findByRole("menu");
  // As drawn: Login, Key and Note. A file and a pasted .env come with their own tasks, and are not listed before they work.
  expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Login", "Key", "Note"]);
});

test("keys_are_listed_in_a_group_with_a_copy_button_each", async () => {
  const { container } = await unlocked();
  const list = screen.getByRole("main");
  const groups = within(list)
    .getAllByRole("heading", { level: 2 })
    .map((heading) => heading.textContent);
  expect(groups).toEqual(["Keys2", "Logins2", "Notes1", "Files1"]);
  // A key's row says it is a key, shows its name, and its button copies the value (in Rust, never through the page).
  expect(within(list).getByRole("button", { name: /^Key:\s*TELEGRAM_BOT_TOKEN/ })).toBeTruthy();
  fireEvent.click(within(list).getByRole("button", { name: "Copy key for TELEGRAM_BOT_TOKEN" }));
  await waitFor(() => {
    expect(shell.copied).toHaveLength(1);
  });
  expect(shell.copied[0]).toMatchObject({ id: itemId(20), field: "key_value" });
  await waitFor(() => {
    expect(screen.getByRole("status").textContent).toContain("Key copied");
  });
  // Nothing of the value is on the page, and the shell was never asked to send it.
  expect(container.textContent).not.toContain(BOT_TOKEN);
  expect(sent("reveal_password")).toEqual([]);
  await expectNoAxe(container);
});

test("value_hidden_until_reveal", async () => {
  const { container } = await unlocked();
  const panel = await select("TELEGRAM_BOT_TOKEN");
  expect(within(panel).getByRole("heading", { level: 2, name: "TELEGRAM_BOT_TOKEN" })).toBeTruthy();
  expect(within(panel).getByText("Key · Agency support agent · changed 2 days ago")).toBeTruthy();
  // 3c: the value is hidden, with Copy key and Reveal; the shell said only that there is a value.
  const value = (await within(panel).findByText("Value")).closest("div");
  expect(value?.textContent).toContain("••••");
  expect(within(panel).getByRole("button", { name: "Copy key" })).toBeTruthy();
  const reveal = within(panel).getByRole("button", { name: "Reveal" });
  expect(within(panel).queryByRole("textbox", { name: "Key value" })).toBeNull();
  expect(container.textContent).not.toContain(BOT_TOKEN);
  expect(sent("reveal_password")).toEqual([]);
  // A key is not a login: no password, no website, no username.
  for (const words of [/password/i, /^Open/, /username/i]) {
    expect(within(panel).queryByRole("button", { name: words })).toBeNull();
  }
  await expectNoAxe(container);

  // 3d: Reveal asks the shell for the key's value, and shows it where a screen reader can read it, with Hide in its place.
  fireEvent.click(reveal);
  const shown = await within(panel).findByRole("textbox", { name: "Key value" });
  expect(shown.textContent).toBe(BOT_TOKEN);
  const live = shell.sessionOf(7);
  expect(shell.revealed).toEqual([{ session: live?.session, generation: live?.generation, id: itemId(20), field: "key_value" }]);
  expect(sent("reveal_password")).toEqual([
    { session: live?.session, generation: live?.generation, id: itemId(20), field: "key_value" },
  ]);
  expect(within(panel).queryByRole("button", { name: "Reveal" })).toBeNull();
  expect(within(panel).getByRole("button", { name: "Copy key" })).toBeTruthy();
  // The value is in no label or title, and the panel's own words say nothing of it.
  expect(attributeText(container)).not.toContain(BOT_TOKEN);
  await expectNoAxe(container);

  // Hide puts the dots back and takes the value off the page.
  fireEvent.click(within(panel).getByRole("button", { name: "Hide" }));
  expect(within(panel).queryByRole("textbox", { name: "Key value" })).toBeNull();
  expect(container.textContent).not.toContain(BOT_TOKEN);
  expect(within(panel).getByRole("button", { name: "Reveal" })).toBeTruthy();
  expect(JSON.stringify(debugState())).not.toContain(BOT_TOKEN);
});

test("copy_key_copies_in_rust_and_says_when_it_clears", async () => {
  const { container } = await unlocked();
  const panel = await select("TELEGRAM_BOT_TOKEN");
  await within(panel).findByRole("button", { name: "Copy key" });
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-06T12:00:00Z"));
  fireEvent.click(within(panel).getByRole("button", { name: "Copy key" }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10);
  });
  const live = shell.sessionOf(7);
  expect(shell.copied).toEqual([{ session: live?.session, generation: live?.generation, id: itemId(20), field: "key_value" }]);
  const status = screen.getByRole("status");
  expect(status.textContent).toContain("Key copied");
  expect(status.textContent).toContain("clears in 30 s");
  // The value itself never came to the page for this, and the shell was never asked to reveal it.
  expect(container.textContent).not.toContain(BOT_TOKEN);
  expect(sent("reveal_password")).toEqual([]);
});

test("a_key_with_no_value_says_so", async () => {
  const items: FakeItem[] = [{ id: itemId(30), kind: "key", title: "EMPTY_KEY", value: "", modified_at: "2026-11-06T09:00:00Z" }];
  await unlocked([{ id: 7, name: "My vault", items }]);
  const panel = await select("EMPTY_KEY");
  expect(await within(panel).findByText("No value saved")).toBeTruthy();
  expect(within(panel).queryByRole("button", { name: "Reveal" })).toBeNull();
  expect(within(panel).queryByRole("button", { name: "Copy key" })).toBeNull();
});

test("mono_font_on_key_values", async () => {
  const { container } = await unlocked();
  const css = readBeside(import.meta.url, "../styles/components.css");
  // The value of a key, revealed, is in Geist Mono and cannot be selected (a native copy would skip the clipboard's marks).
  expect(/\.kval\s*\{[^}]*font-family:[^;}]*Geist Mono/.test(css)).toBe(true);
  expect(/\.kval\s*\{[^}]*user-select:\s*none/.test(css)).toBe(true);
  const panel = await select("TELEGRAM_BOT_TOKEN");
  fireEvent.click(await within(panel).findByRole("button", { name: "Reveal" }));
  const shown = await within(panel).findByRole("textbox", { name: "Key value" });
  expect(shown.classList.contains("kval")).toBe(true);
  expect(shown.getAttribute("style")).toBeNull();
  // A key's name, when it is typed, is in mono as well, and so is its value.
  fireEvent.click(within(panel).getByRole("button", { name: "Close panel" }));
  const form = await openForm("Key");
  expect(inputOf(form, "Name").classList.contains("m")).toBe(true);
  expect(inputOf(form, "Value").classList.contains("m")).toBe(true);
  expect(container.querySelectorAll("[style]:not(input[aria-hidden])")).toHaveLength(0);
});

test("revealed_value_cannot_be_copied_natively", async () => {
  await unlocked();
  const panel = await select("TELEGRAM_BOT_TOKEN");
  fireEvent.click(await within(panel).findByRole("button", { name: "Reveal" }));
  const shown = await within(panel).findByRole("textbox", { name: "Key value" });
  // Ordinary text copied with another control focused is ordinary: the value does not stand in for it.
  const copy = within(panel).getByRole("button", { name: "Copy key" });
  copy.focus();
  selectAllOf(within(panel).getByText("Value"));
  expect(fireEvent.copy(copy)).toBe(true);
  expect(fireEvent.copy(document.body)).toBe(true);
  expect(shell.copied).toEqual([]);
  document.getSelection()?.removeAllRanges();
  // Aimed at the value (focus on it, nothing else selected): stopped, and Ctrl+C does what Copy key does, through the shell.
  shown.focus();
  expect(fireEvent.cut(shown)).toBe(false);
  expect(shell.copied).toEqual([]);
  expect(fireEvent.copy(shown)).toBe(false);
  await waitFor(() => {
    expect(shell.copied).toHaveLength(1);
  });
  expect(shell.copied[0]).toMatchObject({ id: itemId(20), field: "key_value" });
  shown.blur();
  // A selection that holds the value, copied from anywhere, is stopped the same way.
  selectAllOf(shown);
  expect(fireEvent.copy(document.body)).toBe(false);
  expect(fireEvent.cut(document.body)).toBe(false);
  document.getSelection()?.removeAllRanges();
  expect(fireEvent.copy(document.body)).toBe(true);
  // Hidden again, the listener is gone and copying is left alone.
  fireEvent.click(within(panel).getByRole("button", { name: "Hide" }));
  selectAllOf(within(panel).getByText("Value"));
  expect(fireEvent.copy(document.body)).toBe(true);
});

test("reveal_cleared_on_lock", async () => {
  await unlocked();
  const panel = await select("TELEGRAM_BOT_TOKEN");
  fireEvent.click(await within(panel).findByRole("button", { name: "Reveal" }));
  expect((await within(panel).findByRole("textbox", { name: "Key value" })).textContent).toBe(BOT_TOKEN);
  expect(JSON.stringify(debugState())).toContain(BOT_TOKEN);

  // A lock takes the value away with the rest of the vault's screen, saying nothing.
  const live = shell.sessionOf(7);
  act(() => {
    shell.lock(live?.session ?? 0);
  });
  await screen.findByLabelText(/^Password for /);
  expect(document.body.textContent).not.toContain(BOT_TOKEN);
  expect(JSON.stringify(debugState())).not.toContain(BOT_TOKEN);
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByRole("complementary")).toBeNull();

  // Unlocked again, the key is hidden again until it is asked for.
  await unlockThroughTheScreen();
  const again = await select("TELEGRAM_BOT_TOKEN");
  expect(within(again).queryByRole("textbox", { name: "Key value" })).toBeNull();
  expect(within(again).getByRole("button", { name: "Reveal" })).toBeTruthy();
  expect(document.body.textContent).not.toContain(BOT_TOKEN);

  // A lock while the answer is on its way: it is dropped, and nothing is said.
  const release = shell.holdReveal();
  fireEvent.click(within(again).getByRole("button", { name: "Reveal" }));
  await waitFor(() => {
    expect(shell.revealed).toHaveLength(2);
  });
  act(() => {
    shell.lock(shell.sessionOf(7)?.session ?? 0);
  });
  await screen.findByLabelText(/^Password for /);
  await act(async () => {
    release();
    await Promise.resolve();
  });
  expect(screen.queryByRole("alert")).toBeNull();
  expect(document.body.textContent).not.toContain(BOT_TOKEN);
  expect(JSON.stringify(debugState())).not.toContain(BOT_TOKEN);
});

test("reveal_cleared_when_another_item_opens", async () => {
  await unlocked();
  const panel = await select("TELEGRAM_BOT_TOKEN");
  fireEvent.click(await within(panel).findByRole("button", { name: "Reveal" }));
  await within(panel).findByRole("textbox", { name: "Key value" });

  // Another item opens: the value is off the page and out of the store; coming back, the key is hidden.
  const other = await select("OPENAI_API_KEY");
  expect(within(other).queryByRole("textbox", { name: "Key value" })).toBeNull();
  expect(document.body.textContent).not.toContain(BOT_TOKEN);
  expect(JSON.stringify(debugState())).not.toContain(BOT_TOKEN);
  const back = await select("TELEGRAM_BOT_TOKEN");
  expect(within(back).queryByRole("textbox", { name: "Key value" })).toBeNull();
  expect(within(back).getByRole("button", { name: "Reveal" })).toBeTruthy();

  // Closing the panel does the same.
  fireEvent.click(within(back).getByRole("button", { name: "Reveal" }));
  await within(back).findByRole("textbox", { name: "Key value" });
  fireEvent.click(within(back).getByRole("button", { name: "Close panel" }));
  expect(document.body.textContent).not.toContain(BOT_TOKEN);
  expect(JSON.stringify(debugState())).not.toContain(BOT_TOKEN);

  // An answer that comes after another item was opened is not put on that item's screen, or any other.
  const first = await select("TELEGRAM_BOT_TOKEN");
  const release = shell.holdReveal();
  fireEvent.click(within(first).getByRole("button", { name: "Reveal" }));
  await waitFor(() => {
    expect(shell.revealed).toHaveLength(3);
  });
  const second = await select("OPENAI_API_KEY");
  await act(async () => {
    release();
    await Promise.resolve();
  });
  expect(within(second).queryByRole("textbox", { name: "Key value" })).toBeNull();
  expect(document.body.textContent).not.toContain(BOT_TOKEN);
  expect(JSON.stringify(debugState())).not.toContain(BOT_TOKEN);
});

test("a_reveal_the_shell_refuses_says_so_in_words", async () => {
  await unlocked();
  const panel = await select("TELEGRAM_BOT_TOKEN");
  const real = invoke.getMockImplementation();
  if (real === undefined) throw new Error("no fake shell");
  invoke.mockImplementation((cmd: string, args?: unknown) =>
    cmd === "reveal_password"
      ? // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- Tauri rejects with the plain object
        Promise.reject({ code: "core", kind: "not_found" })
      : (real(cmd, args) as Promise<unknown>),
  );
  fireEvent.click(await within(panel).findByRole("button", { name: "Reveal" }));
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("Lockbox can't find that.");
  expect(within(panel).queryByRole("textbox", { name: "Key value" })).toBeNull();
  expect(within(panel).getByRole("button", { name: "Reveal" })).toBeTruthy();
});

test("note_text_shows_when_opened", async () => {
  const { container } = await unlocked();
  const panel = await select("Rotation steps");
  // Decision A: the text is there when the note opens, with no Reveal and no question asked of the shell.
  expect(await within(panel).findByText("Made-up note")).toBeTruthy();
  expect(within(panel).getByText(/^Note · Agency support agent · changed /)).toBeTruthy();
  expect(within(panel).queryByRole("button", { name: /reveal/i })).toBeNull();
  expect(sent("reveal_password")).toEqual([]);
  // 3g's Copy copies the text, in Rust, like any copy.
  fireEvent.click(within(panel).getByRole("button", { name: "Copy text" }));
  await waitFor(() => {
    expect(shell.copied).toHaveLength(1);
  });
  expect(shell.copied[0]).toMatchObject({ id: itemId(3), field: "notes" });
  await waitFor(() => {
    expect(screen.getByRole("status").textContent).toContain("Text copied");
  });
  await expectNoAxe(container);
});

test("word_secret_kept_from_notes", async () => {
  const items: FakeItem[] = [
    { id: itemId(31), kind: "note", title: "Plans", notes: "Door code is 4471, keep it close.", modified_at: "2026-11-06T09:00:00Z" },
  ];
  const { container } = await unlocked([{ id: 7, name: "My vault", items }]);
  const everything = (root: HTMLElement) => `${root.textContent}\n${attributeText(root)}`;
  // A note's details, its row and its copy message say nothing of a secret.
  const panel = await select("Plans");
  await within(panel).findByText("Door code is 4471, keep it close.");
  fireEvent.click(within(panel).getByRole("button", { name: "Copy text" }));
  await screen.findByText("Text copied");
  expect(everything(container)).not.toMatch(/secret/i);
  fireEvent.click(within(panel).getByRole("button", { name: "Close panel" }));
  // So does the form that makes one.
  const form = await openForm("Note");
  expect(everything(form)).not.toMatch(/secret/i);
  expect(everything(container)).not.toMatch(/secret/i);
  // A key's own words are about a value, hidden; the word is kept from the note alone.
  expect(shell.copied.at(-1)).toMatchObject({ field: "notes" });
});

test("empty_vault_says_so_with_add", async () => {
  const { container } = await unlocked([{ id: 7, name: "My vault", items: [] }]);
  expect(screen.getByText("Your vault is empty")).toBeTruthy();
  // 3e: Add is right there, with the three kinds that can be made; a file and a pasted .env come with their tasks.
  const list = screen.getByRole("main").querySelector<HTMLElement>(".lscroll");
  expect(list).not.toBeNull();
  const buttons = within(list as HTMLElement).getAllByRole("button");
  expect(buttons.map((button) => button.textContent)).toEqual(["Login", "Key", "Note"]);
  expect(within(list as HTMLElement).queryByRole("button", { name: /^(File|Paste|Help)/ })).toBeNull();
  await expectNoAxe(container);

  // A button opens that kind's form, and closing it gives focus back to the button that opened it.
  const key = within(list as HTMLElement).getByRole("button", { name: "Key" });
  key.focus();
  fireEvent.click(key);
  const form = await screen.findByRole("complementary", { name: "New key" });
  await waitFor(() => {
    expect(document.activeElement).toBe(inputOf(form, "Name"));
  });
  fireEvent.click(within(form).getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("complementary")).toBeNull();
  await waitFor(() => {
    expect(document.activeElement).toBe(within(list as HTMLElement).getByRole("button", { name: "Key" }));
  });
  fireEvent.click(within(list as HTMLElement).getByRole("button", { name: "Login" }));
  expect(await screen.findByRole("complementary", { name: "New login" })).toBeTruthy();
});

test("empty_folder_says_so", async () => {
  const folderOnly: FakeItem[] = [{ id: FOLDER, kind: "collection", title: "Agency support agent" }];
  const { container } = await unlocked([{ id: 7, name: "My vault", items: folderOnly }]);
  fireEvent.click(screen.getByRole("button", { name: /^Agency support agent/ }));
  expect(await screen.findByText("Nothing in Agency support agent yet.")).toBeTruthy();
  expect(screen.getByText("Add a login, a key or a note.")).toBeTruthy();
  const list = screen.getByRole("main").querySelector<HTMLElement>(".lscroll") as HTMLElement;
  expect(within(list).getAllByRole("button").map((button) => button.textContent)).toEqual(["Login", "Key", "Note"]);
  await expectNoAxe(container);
  // The form opens in the folder on screen.
  fireEvent.click(within(list).getByRole("button", { name: "Note" }));
  const form = await screen.findByRole("complementary", { name: "New note" });
  expect(within(form).getByText("In Agency support agent, My vault.")).toBeTruthy();
});

test("a_vault_opened_from_a_backup_has_no_add_in_its_empty_places", async () => {
  await unlocked([{ id: 7, name: "My vault", readOnly: true, items: [] }]);
  expect(screen.getByText("Your vault is empty")).toBeTruthy();
  const list = screen.getByRole("main").querySelector<HTMLElement>(".lscroll") as HTMLElement;
  expect(within(list).queryAllByRole("button")).toEqual([]);
  expect(screen.queryByRole("button", { name: "Add" })).toBeNull();
});

test("key_form_hides_value", async () => {
  const { container } = await unlocked();
  const form = await openForm("Key");
  expect(within(form).getByRole("heading", { level: 2, name: "New key" })).toBeTruthy();
  expect(within(form).getByText("In My vault.")).toBeTruthy();
  const name = inputOf(form, "Name");
  await waitFor(() => {
    expect(document.activeElement).toBe(name);
  });
  expect(name.type).toBe("text");
  expect(name.autocomplete).toBe("off");
  // The rule for a name is shown as help, and the box points at it.
  const help = within(form).getByText("Letters, digits and _ only. It can't start with a digit.");
  expect(name.getAttribute("aria-describedby")).toBe(help.id);
  // The value is hidden, kept by nothing, and shown only when asked.
  const value = inputOf(form, "Value");
  expect(value.type).toBe("password");
  expect(value.autocomplete).toBe("off");
  expect(value.placeholder).toBe("Paste the key");
  expect(within(form).getByRole("combobox", { name: "Folder" }).textContent).toBe("No folder");
  expect(within(form).getByRole("button", { name: "Cancel" })).toBeTruthy();
  expect(within(form).getByRole("button", { name: "Save" })).toBeTruthy();
  expect(sent("new_item")).toEqual([]);
  await expectNoAxe(container);

  typeInto(form, "Value", TYPED_KEY);
  expect(value.type).toBe("password");
  expect(container.textContent).not.toContain(TYPED_KEY);
  const show = within(form).getByRole("button", { name: "Show" });
  fireEvent.click(show);
  expect(value.type).toBe("text");
  expect(within(form).getByRole("button", { name: "Hide" })).toBeTruthy();
  // Shown, it cannot be copied around the clipboard's protection: a copy or cut aimed at the box is stopped.
  value.focus();
  expect(fireEvent.copy(value)).toBe(false);
  expect(fireEvent.cut(value)).toBe(false);
  inputOf(form, "Name").focus();
  expect(fireEvent.copy(inputOf(form, "Name"))).toBe(true);
  expect(attributeText(container).replace(TYPED_KEY, "")).not.toContain(TYPED_KEY);
  fireEvent.click(within(form).getByRole("button", { name: "Hide" }));
  expect(value.type).toBe("password");
  expect(value.value).toBe(TYPED_KEY);

  // Cancel clears what was typed, sends nothing and gives focus back to Add.
  fireEvent.click(within(form).getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("complementary")).toBeNull();
  await waitFor(() => {
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Add" }));
  });
  expect(sent("new_item")).toEqual([]);
  expect(container.textContent).not.toContain(TYPED_KEY);
  expect(JSON.stringify(debugState())).not.toContain(TYPED_KEY);
  const again = await openForm("Key");
  expect(inputOf(again, "Name").value).toBe("");
  expect(inputOf(again, "Value").value).toBe("");
  expect(inputOf(again, "Value").type).toBe("password");
});

test("a_key_is_saved_whole_and_opens_hidden_with_saved", async () => {
  const { container } = await unlocked();
  const form = await openForm("Key");
  typeInto(form, "Name", "  STRIPE_SECRET_KEY ");
  typeInto(form, "Value", TYPED_KEY);
  fireEvent.click(within(form).getByRole("button", { name: "Save" }));

  // The key opens with its details and "Saved", and the form is gone.
  const panel = await screen.findByRole("complementary", { name: "STRIPE_SECRET_KEY" });
  expect(screen.queryByRole("complementary", { name: "New key" })).toBeNull();
  expect(await screen.findByText("Saved")).toBeTruthy();
  const live = shell.sessionOf(7);
  expect(shell.made).toEqual([
    {
      session: live?.session,
      generation: live?.generation,
      kind: "key",
      title: "STRIPE_SECRET_KEY",
      collection: null,
      fields: { value: TYPED_KEY },
    },
  ]);
  expect(sent("new_item")).toHaveLength(1);
  // Hidden as any key is: the value was sent to Rust and is not on the page.
  expect(await within(panel).findByRole("button", { name: "Reveal" })).toBeTruthy();
  expect(within(panel).getByRole("button", { name: "Copy key" })).toBeTruthy();
  expect(container.textContent).not.toContain(TYPED_KEY);
  expect(JSON.stringify(debugState())).not.toContain(TYPED_KEY);
  await waitFor(() => {
    expect(document.activeElement).toBe(within(panel).getByRole("heading", { level: 2, name: "STRIPE_SECRET_KEY" }));
  });
  // It is in the list among the keys.
  expect(within(screen.getByRole("main")).getByRole("button", { name: /^Key:\s*STRIPE_SECRET_KEY/ })).toBeTruthy();
  await expectNoAxe(container);
});

test("a_name_that_is_not_a_variable_name_is_refused_in_words_and_the_form_stays", async () => {
  const { container } = await unlocked();
  const form = await openForm("Key");
  typeInto(form, "Name", "OpenAI key");
  typeInto(form, "Value", TYPED_KEY);
  fireEvent.click(within(form).getByRole("button", { name: "Save" }));
  const alert = await within(form).findByRole("alert");
  expect(alert.textContent).toBe(
    "That isn't a name Lockbox can use for a key. Use letters, digits and _ only, and don't start with a digit.",
  );
  expect(inputOf(form, "Name").getAttribute("aria-invalid")).toBe("true");
  // Nothing was made, and the form kept what was typed, to be put right.
  expect(shell.made).toEqual([]);
  expect(inputOf(form, "Name").value).toBe("OpenAI key");
  expect(inputOf(form, "Value").value).toBe(TYPED_KEY);
  expect(container.textContent).not.toContain(TYPED_KEY);
  await expectNoAxe(container);
  typeInto(form, "Name", "OPENAI_KEY");
  fireEvent.click(within(form).getByRole("button", { name: "Save" }));
  await screen.findByRole("complementary", { name: "OPENAI_KEY" });
  expect(shell.made).toHaveLength(1);
});

const ONE_LINE_ONLY = "That value has more than one line, so it wasn't pasted. A key's value is one line here.";

/** Pastes `text` into `box` as the page hears it; false when the page stopped the paste. */
function pasteInto(box: HTMLElement, text: string): boolean {
  return fireEvent.paste(box, { clipboardData: { getData: () => text } });
}

/** Drops `text` onto `box`; false when the page stopped the drop. */
function dropOnto(box: HTMLElement, text: string): boolean {
  return fireEvent.drop(box, { dataTransfer: { getData: () => text } });
}

test("a_value_with_more_than_one_line_is_not_pasted_or_dropped_and_the_words_say_so", async () => {
  await unlocked();
  const form = await openForm("Key");
  const value = inputOf(form, "Value");
  // What the box holds; each change is to a different text, since a change to the same text is no change.
  let held = TYPED_KEY;
  typeInto(form, "Value", held);
  const change = () => {
    held = held === TYPED_KEY ? `${TYPED_KEY}x` : TYPED_KEY;
    typeInto(form, "Value", held);
  };
  for (const shown of [false, true]) {
    if (shown) fireEvent.click(within(form).getByRole("button", { name: "Show" }));
    expect(value.type).toBe(shown ? "text" : "password");
    for (const text of ["line one\r\nline two", "line one\nline two", "\nline one\nline two\n", "a\rb"]) {
      // The paste is stopped before the box can change what it holds, and the form says why, in the form's own problem line.
      expect(pasteInto(value, text), JSON.stringify(text)).toBe(false);
      expect(value.value).toBe(held);
      expect((await within(form).findByRole("alert")).textContent).toBe(ONE_LINE_ONLY);
      // The next change clears it.
      change();
      expect(within(form).queryByRole("alert")).toBeNull();
      // A drop is the same.
      expect(dropOnto(value, text), JSON.stringify(text)).toBe(false);
      expect(value.value).toBe(held);
      expect((await within(form).findByRole("alert")).textContent).toBe(ONE_LINE_ONLY);
      change();
      expect(within(form).queryByRole("alert")).toBeNull();
    }
  }
  expect(sent("new_item")).toEqual([]);
});

test("a_value_with_only_a_line_break_at_the_start_or_end_still_pastes", async () => {
  await unlocked();
  const form = await openForm("Key");
  const value = inputOf(form, "Value");
  for (const shown of [false, true]) {
    if (shown) fireEvent.click(within(form).getByRole("button", { name: "Show" }));
    for (const text of ["one-line-value\n", "one-line-value\r\n", "\none-line-value", "\r\none-line-value\r\n", "one-line-value"]) {
      // Left to the box, which drops the break as it always has: the page neither stops it nor says anything.
      expect(pasteInto(value, text), JSON.stringify(text)).toBe(true);
      expect(dropOnto(value, text), JSON.stringify(text)).toBe(true);
      expect(within(form).queryByRole("alert")).toBeNull();
    }
  }
  // A clean paste clears the words a refused one left.
  expect(pasteInto(value, "a\nb")).toBe(false);
  await within(form).findByRole("alert");
  expect(pasteInto(value, "fine")).toBe(true);
  expect(within(form).queryByRole("alert")).toBeNull();
  // A paste of no text at all (a file, a picture) is left alone too.
  expect(pasteInto(value, "")).toBe(true);
});

test("the_words_for_a_refused_paste_do_not_hide_the_saves_own", async () => {
  await unlocked();
  const form = await openForm("Key");
  typeInto(form, "Name", "OpenAI key");
  typeInto(form, "Value", TYPED_KEY);
  fireEvent.click(within(form).getByRole("button", { name: "Save" }));
  await within(form).findByRole("alert");
  // A refused paste replaces the line with its own words; Save says its own again.
  expect(pasteInto(inputOf(form, "Value"), "a\nb")).toBe(false);
  expect((await within(form).findByRole("alert")).textContent).toBe(ONE_LINE_ONLY);
  typeInto(form, "Name", "OPENAI_KEY");
  fireEvent.click(within(form).getByRole("button", { name: "Save" }));
  await screen.findByRole("complementary", { name: "OPENAI_KEY" });
  expect(shell.made.at(-1)?.fields).toEqual({ value: TYPED_KEY });
});

test("a_changed_value_does_not_clear_the_words_save_put_in_place_of_a_refused_pastes", async () => {
  await unlocked();
  const form = await openForm("Key");
  const refusedName =
    "That isn't a name Lockbox can use for a key. Use letters, digits and _ only, and don't start with a digit.";
  // A refused paste, then Save with no name: Save's words take the line over from the paste's.
  expect(pasteInto(inputOf(form, "Value"), "a\nb")).toBe(false);
  expect((await within(form).findByRole("alert")).textContent).toBe(ONE_LINE_ONLY);
  fireEvent.click(within(form).getByRole("button", { name: "Save" }));
  await waitFor(() => {
    expect(within(form).getByRole("alert").textContent).toBe("Type a name first.");
  });
  expect(inputOf(form, "Name").getAttribute("aria-invalid")).toBe("true");
  // A change to the value is not the paste's words going away: Save's words stay, and so does the mark on the Name box.
  typeInto(form, "Value", TYPED_KEY);
  expect(within(form).getByRole("alert").textContent).toBe("Type a name first.");
  expect(inputOf(form, "Name").getAttribute("aria-invalid")).toBe("true");

  // The same when the shell refuses the name: a refused paste, Save, then a change to the value.
  typeInto(form, "Name", "bad name");
  expect(pasteInto(inputOf(form, "Value"), "a\nb")).toBe(false);
  expect(within(form).getByRole("alert").textContent).toBe(ONE_LINE_ONLY);
  fireEvent.click(within(form).getByRole("button", { name: "Save" }));
  await waitFor(() => {
    expect(within(form).getByRole("alert").textContent).toBe(refusedName);
  });
  expect(inputOf(form, "Name").getAttribute("aria-invalid")).toBe("true");
  typeInto(form, "Value", `${TYPED_KEY}x`);
  expect(within(form).getByRole("alert").textContent).toBe(refusedName);
  expect(inputOf(form, "Name").getAttribute("aria-invalid")).toBe("true");
  expect(shell.made).toEqual([]);
});

test("a_name_is_needed_before_saving_a_key", async () => {
  await unlocked();
  const form = await openForm("Key");
  fireEvent.click(within(form).getByRole("button", { name: "Save" }));
  expect((await within(form).findByRole("alert")).textContent).toBe("Type a name first.");
  expect(inputOf(form, "Name").getAttribute("aria-invalid")).toBe("true");
  expect(document.activeElement).toBe(inputOf(form, "Name"));
  expect(sent("new_item")).toEqual([]);
});

test("a_key_added_in_a_folder_lands_in_it", async () => {
  await unlocked();
  fireEvent.click(within(screen.getByRole("navigation", { name: "Vault and folders" })).getByRole("button", { name: /^Agency support agent/ }));
  const form = await openForm("Key");
  expect(within(form).getByText("In Agency support agent, My vault.")).toBeTruthy();
  typeInto(form, "Name", "IN_THE_FOLDER");
  fireEvent.click(within(form).getByRole("button", { name: "Save" }));
  await screen.findByRole("complementary", { name: "IN_THE_FOLDER" });
  expect(shell.made.at(-1)?.collection).toBe(FOLDER);
  expect(screen.getByText(/^Key · Agency support agent/)).toBeTruthy();
});

test("lock_loses_the_key_form_with_no_error", async () => {
  await unlocked();
  const form = await openForm("Key");
  typeInto(form, "Name", "DRAFT_KEY");
  typeInto(form, "Value", TYPED_KEY);
  fireEvent.click(within(form).getByRole("button", { name: "Show" }));
  const live = shell.sessionOf(7);
  act(() => {
    shell.lock(live?.session ?? 0);
  });
  await screen.findByLabelText(/^Password for /);
  expect(screen.queryByRole("complementary")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  for (const secret of ["DRAFT_KEY", TYPED_KEY]) {
    expect(document.body.textContent, secret).not.toContain(secret);
    for (const input of document.querySelectorAll("input")) expect(input.value).not.toContain(secret);
  }
  expect(JSON.stringify(debugState())).not.toContain(TYPED_KEY);
  expect(sent("new_item")).toEqual([]);

  // Unlocked again, nothing of it comes back, and the value is hidden in a new form.
  await unlockThroughTheScreen();
  expect(screen.queryByRole("complementary")).toBeNull();
  const again = await openForm("Key");
  expect(inputOf(again, "Name").value).toBe("");
  expect(inputOf(again, "Value").value).toBe("");
  expect(inputOf(again, "Value").type).toBe("password");

  // A lock while the save is on its way: the key was written, the answer is dropped, and nothing is said.
  typeInto(again, "Name", "SAVED_WHILE_LOCKING");
  typeInto(again, "Value", TYPED_KEY);
  const release = shell.holdNewItem();
  fireEvent.click(within(again).getByRole("button", { name: "Save" }));
  await waitFor(() => {
    expect(shell.made).toHaveLength(1);
  });
  act(() => {
    shell.lock(shell.sessionOf(7)?.session ?? 0);
  });
  await screen.findByLabelText(/^Password for /);
  await act(async () => {
    release();
    await Promise.resolve();
  });
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByRole("complementary")).toBeNull();
  expect(document.body.textContent).not.toContain("SAVED_WHILE_LOCKING");
  expect(document.body.textContent).not.toContain(TYPED_KEY);
  expect(document.body.textContent).not.toContain("Saved");
});

test("a_note_is_saved_with_its_text_and_opens_showing_it", async () => {
  const { container } = await unlocked();
  const form = await openForm("Note");
  expect(within(form).getByRole("heading", { level: 2, name: "New note" })).toBeTruthy();
  expect(within(form).getByText("In My vault.")).toBeTruthy();
  const title = inputOf(form, "Title");
  await waitFor(() => {
    expect(document.activeElement).toBe(title);
  });
  const text = within(form).getByLabelText<HTMLTextAreaElement>("Text");
  expect(text.tagName).toBe("TEXTAREA");
  expect(within(form).getByRole("combobox", { name: "Folder" }).textContent).toBe("No folder");
  await expectNoAxe(container);

  typeInto(form, "Title", "Handover");
  fireEvent.change(text, { target: { value: "Rotate the token.\nThen tell the team." } });
  fireEvent.click(within(form).getByRole("button", { name: "Save" }));
  const panel = await screen.findByRole("complementary", { name: "Handover" });
  expect(await screen.findByText("Saved")).toBeTruthy();
  const live = shell.sessionOf(7);
  expect(shell.made).toEqual([
    {
      session: live?.session,
      generation: live?.generation,
      kind: "note",
      title: "Handover",
      collection: null,
      fields: { notes: "Rotate the token.\nThen tell the team." },
    },
  ]);
  // The text shows when the note opens (decision A), line breaks kept.
  const shown = await within(panel).findByText((content) => content.startsWith("Rotate the token."));
  expect(shown.textContent).toBe("Rotate the token.\nThen tell the team.");
  expect(within(panel).queryByRole("button", { name: /reveal/i })).toBeNull();
  await waitFor(() => {
    expect(document.activeElement).toBe(within(panel).getByRole("heading", { level: 2, name: "Handover" }));
  });
});

test("a_title_is_needed_before_saving_a_note", async () => {
  await unlocked();
  const form = await openForm("Note");
  fireEvent.click(within(form).getByRole("button", { name: "Save" }));
  expect((await within(form).findByRole("alert")).textContent).toBe("Type a title first.");
  expect(inputOf(form, "Title").getAttribute("aria-invalid")).toBe("true");
  expect(sent("new_item")).toEqual([]);
  // Cancel gives focus back to Add, and the text typed goes with the form.
  fireEvent.change(within(form).getByLabelText("Text"), { target: { value: "half a thought" } });
  fireEvent.click(within(form).getByRole("button", { name: "Cancel" }));
  await waitFor(() => {
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Add" }));
  });
  expect(document.body.textContent).not.toContain("half a thought");
  const again = await openForm("Note");
  expect(within(again).getByLabelText<HTMLTextAreaElement>("Text").value).toBe("");
});

test("lock_loses_the_note_form_with_no_error", async () => {
  await unlocked();
  const form = await openForm("Note");
  typeInto(form, "Title", "Draft note");
  fireEvent.change(within(form).getByLabelText("Text"), { target: { value: "unsaved words" } });
  const live = shell.sessionOf(7);
  act(() => {
    shell.lock(live?.session ?? 0);
  });
  await screen.findByLabelText(/^Password for /);
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByRole("complementary")).toBeNull();
  for (const typed of ["Draft note", "unsaved words"]) {
    expect(document.body.textContent, typed).not.toContain(typed);
    for (const field of document.querySelectorAll("input, textarea")) {
      expect((field as HTMLInputElement | HTMLTextAreaElement).value).not.toContain(typed);
    }
  }
  expect(sent("new_item")).toEqual([]);
  expect(shell.made).toEqual([]);
});

test("search_result_copies_a_key", async () => {
  const { container } = await unlocked();
  fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
  const dialog = await screen.findByRole("dialog", { name: SEARCH });
  fireEvent.change(within(dialog).getByRole("textbox", { name: SEARCH }), { target: { value: "telegram" } });
  const opener = await within(dialog).findByRole("button", { name: /^Key:\s*TELEGRAM_BOT_TOKEN/ });
  const row = opener.closest("li") as HTMLElement;
  // A key's result has the one action of its own: Copy key. No password, username or site.
  const group = within(row).getByRole("group");
  expect(within(group).getAllByRole("button").map((button) => button.textContent)).toEqual(["Copy key"]);
  expect(within(row).getByText("Agency support agent · My vault")).toBeTruthy();
  await expectNoAxe(container);

  fireEvent.click(within(group).getByRole("button", { name: "Copy key" }));
  await waitFor(() => {
    expect(shell.copied).toHaveLength(1);
  });
  expect(shell.copied[0]).toMatchObject({ id: itemId(20), field: "key_value" });
  // The key opens behind with the message about the copy, and the search is out of the way.
  await screen.findByRole("complementary", { name: "TELEGRAM_BOT_TOKEN" });
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  await waitFor(() => {
    expect(screen.getByRole("status").textContent).toContain("Key copied");
  });
  // Neither the value nor a request for it ever reached the page.
  expect(document.body.textContent).not.toContain(BOT_TOKEN);
  expect(sent("reveal_password")).toEqual([]);

  // A key is found by its name, and never by its value.
  fireEvent.keyDown(document.body, { key: "f", ctrlKey: true });
  const second = await screen.findByRole("dialog", { name: SEARCH });
  fireEvent.change(within(second).getByRole("textbox", { name: SEARCH }), { target: { value: "demo-telegram" } });
  expect(await within(second).findByText('Nothing for "demo-telegram"')).toBeTruthy();
  expect(within(second).queryByRole("button", { name: /^Key:/ })).toBeNull();
});

test("the_other_kinds_in_a_search_are_as_they_were", async () => {
  await unlocked();
  fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
  const dialog = await screen.findByRole("dialog", { name: SEARCH });
  fireEvent.change(within(dialog).getByRole("textbox", { name: SEARCH }), { target: { value: "agency" } });
  // Everything in the folder matches by the folder's name: the keys and the note now, the logins by their folder too.
  await within(dialog).findByRole("button", { name: /^Key:\s*OPENAI_API_KEY/ });
  const keyRow = (await within(dialog).findByRole("button", { name: /^Key:\s*OPENAI_API_KEY/ })).closest("li") as HTMLElement;
  expect(within(keyRow).getAllByRole("button").map((button) => button.textContent)).toContain("Copy key");
  const note = (await within(dialog).findByRole("button", { name: /^Note:\s*Rotation steps/ })).closest("li") as HTMLElement;
  // A note has nothing to copy from a search: its one button opens it.
  expect(within(note).getAllByRole("button")).toHaveLength(1);
  const login = (await within(dialog).findByRole("button", { name: /^Login:\s*Bot admin console/ })).closest("li") as HTMLElement;
  expect(within(within(login).getByRole("group")).getAllByRole("button").map((button) => button.textContent)).toContain("Copy password");
  // A key opens like any result.
  fireEvent.click(within(dialog).getByRole("button", { name: /^Key:\s*TELEGRAM_BOT_TOKEN/ }));
  const panel = await screen.findByRole("complementary", { name: "TELEGRAM_BOT_TOKEN" });
  expect(within(panel).getByRole("button", { name: "Reveal" })).toBeTruthy();
});
