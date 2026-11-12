// Task 14's screens: Move (12a), Move to trash with Undo (13a), the Trash view (13b, 13c), Restore and Delete for good (13d), and
// folders: a new one (14a), the folder's menu (14b), Rename (14c) and Delete (14d). A move is an edit with a new folder, a
// rename is an edit of the folder with a new title, a new folder is `new_item` of kind folder: every one is a command the shell
// already has. Nothing here ever removes anything by time.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import App from "../App";
import { debugState, resetStoreForTests } from "../store";
import { expectNoAxe } from "../testing/axe";
import {
  FOLDER,
  FOLDER_2,
  installFakeShell,
  itemId,
  PASSWORD,
  sampleItems,
  STALE_REVISION,
  type FakeItem,
  type FakeShell,
} from "../testing/fakeShell";

const { invoke, listen } = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

let shell: FakeShell;
/** The fake vault's own items, so a test can change one the way another program would. */
let stored: FakeItem[];

beforeEach(() => {
  for (const style of document.querySelectorAll("style")) style.remove();
  resetStoreForTests();
  invoke.mockReset();
  listen.mockReset();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-10T12:00:00Z"));
});

const NOTHING_REMOVED = "Nothing here is removed until you say so. Lockbox never empties the trash by itself.";
const CHANGED_MEANWHILE = "This item changed while you were editing it. Nothing was saved. Cancel, then open it again to see the change.";
const GONE_FOLDER = itemId(40);
const MEMBER_A = itemId(41);
const MEMBER_B = itemId(42);
const MEMBER_C = itemId(43);
const EARLIER = itemId(44);
const OLD_CRM = itemId(45);
const LOOSE_TRASHED = itemId(5);

/** The sample vault and a trash: a folder deleted two days ago with three items that went with it, one item trashed before that, one loose, and one that was in a live folder. */
function items(): FakeItem[] {
  return [
    ...sampleItems(),
    { id: GONE_FOLDER, kind: "collection", title: "Slotted", trashed: true, trashedAt: "2026-11-08T09:00:00Z" },
    ...[MEMBER_A, MEMBER_B, MEMBER_C].map(
      (id, at): FakeItem => ({
        id,
        kind: "note",
        title: `Slotted note ${"ABC"[at] ?? ""}`,
        collection: GONE_FOLDER,
        trashed: true,
        trashedWith: GONE_FOLDER,
        trashedAt: "2026-11-08T09:00:00Z",
      }),
    ),
    { id: EARLIER, kind: "note", title: "Earlier note", collection: GONE_FOLDER, trashed: true, trashedAt: "2026-10-01T09:00:00Z" },
    {
      id: OLD_CRM,
      kind: "login",
      title: "Old CRM login",
      username: "crm@example.com",
      collection: FOLDER,
      trashed: true,
      trashedAt: "2026-09-20T09:00:00Z",
      has_password: true,
    },
  ];
}

async function unlocked(options: { readOnly?: boolean; extra?: FakeItem[]; only?: FakeItem[] } = {}) {
  stored = options.only ?? [...items(), ...(options.extra ?? [])];
  shell = installFakeShell(invoke, listen, [{ id: 7, name: "My vault", items: stored, readOnly: options.readOnly ?? false }]);
  const view = render(<App />);
  const field = await screen.findByLabelText(/^Password for /);
  fireEvent.change(field, { target: { value: PASSWORD } });
  fireEvent.submit((field as HTMLInputElement).form as HTMLFormElement);
  await screen.findByRole("heading", { level: 1, name: "All items" });
  return view;
}

function sent(cmd: string): unknown[] {
  return invoke.mock.calls.filter(([name]) => name === cmd).map(([, args]): unknown => args);
}

/** The edits the fake shell accepted, as the page sent them. */
function edits(): Record<string, unknown>[] {
  return shell.edited.map((one) => one.edit);
}

/** Opens a menu the way a click does. */
function pointerOpen(button: HTMLElement) {
  button.focus();
  fireEvent.pointerDown(button, { button: 0 });
  fireEvent.click(button);
}

async function openMenu(button: HTMLElement, name?: string): Promise<HTMLElement> {
  pointerOpen(button);
  return name === undefined ? screen.findByRole("menu") : screen.findByRole("menu", { name });
}

function rail(): HTMLElement {
  return screen.getByRole("navigation", { name: "Vault and folders" });
}

function railButton(name: RegExp | string): HTMLElement {
  return within(rail()).getByRole("button", { name });
}

function trashEntry(): HTMLElement {
  return railButton(/^Trash\s+\d+$/);
}

async function openTrash() {
  fireEvent.click(trashEntry());
  await screen.findByRole("heading", { level: 1, name: "Trash" });
}

async function openFolder(name: string) {
  fireEvent.click(railButton(new RegExp(`^${name}\\s+\\d+$`)));
  await screen.findByRole("heading", { level: 1, name });
}

/** A row of the list or the Trash view, by its kind word and title. */
function row(kind: string, title: string): HTMLElement {
  return screen.getByRole("button", { name: new RegExp(`^${kind}:\\s*${title}`) });
}

async function openItem(title: string, kind = "Login"): Promise<HTMLElement> {
  fireEvent.click(await screen.findByRole("button", { name: new RegExp(`^${kind}:\\s*${title}`) }));
  const panel = await screen.findByRole("complementary", { name: title });
  await waitFor(() => {
    expect(within(panel).queryByRole("button", { name: "Edit" })).not.toBeNull();
  });
  return panel;
}

async function openTrashed(kind: string, title: string): Promise<HTMLElement> {
  fireEvent.click(row(kind, title));
  return screen.findByRole("complementary", { name: title });
}

function toastText(): string {
  return document.querySelector(".tstack")?.textContent ?? "";
}

function statusText(): string {
  return screen.getByRole("status").textContent;
}

function thePage(): string {
  return document.body.textContent;
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

// ---- Move (12a) ----

test("move_shows_a_short_message", async () => {
  await unlocked();
  const panel = await openItem("Bot admin console");
  const move = within(panel).getByRole("button", { name: "Move" });
  expect(move.getAttribute("aria-haspopup")).toBe("menu");
  // Beside Edit, in the panel's top bar.
  expect(move.parentElement).toBe(within(panel).getByRole("button", { name: "Edit" }).parentElement);

  const menu = await openMenu(move, "Move to folder");
  // No folder, then each folder by its name; the one the item is in is marked, in words and not by colour.
  const choices = within(menu).getAllByRole("menuitemradio");
  expect(choices.map((choice) => choice.textContent)).toEqual(["No folder", "Agency support agent", "Lineproof"]);
  expect(choices.map((choice) => choice.getAttribute("aria-checked"))).toEqual(["false", "true", "false"]);
  expect(within(menu).queryByText("Slotted")).toBeNull();

  fireEvent.click(within(menu).getByRole("menuitemradio", { name: "Lineproof" }));
  await waitFor(() => {
    expect(statusText()).toContain("Moved to Lineproof");
  });
  expect(edits()).toEqual([
    { id: itemId(1), revision: 2, title: "Bot admin console", notes: "", collection: FOLDER_2 },
  ]);
  expect(stored.find((item) => item.id === itemId(1))?.collection).toBe(FOLDER_2);
  // The menu is closed, the panel says where it is now, and the folder's count moved.
  await waitFor(() => {
    expect(screen.queryByRole("menu")).toBeNull();
  });
  await waitFor(() => {
    expect(within(panel).getByText(/Login · Lineproof/)).toBeTruthy();
  });
  expect(railButton(/^Lineproof\s+2$/)).toBeTruthy();
  expect(railButton(/^Agency support agent\s+1$/)).toBeTruthy();
});

test("move_to_no_folder_works", async () => {
  await unlocked();
  const panel = await openItem("Bot admin console");
  const menu = await openMenu(within(panel).getByRole("button", { name: "Move" }));
  fireEvent.click(within(menu).getByRole("menuitemradio", { name: "No folder" }));
  await waitFor(() => {
    expect(statusText()).toContain("Moved to No folder");
  });
  expect(edits()).toEqual([{ id: itemId(1), revision: 2, title: "Bot admin console", notes: "", collection: null }]);
  expect(stored.find((item) => item.id === itemId(1))?.collection).toBeNull();
  await waitFor(() => {
    expect(within(panel).getByText(/^Login · changed today$/)).toBeTruthy();
  });
  // Picking the folder it is in again changes nothing and sends nothing.
  const again = await openMenu(within(panel).getByRole("button", { name: "Move" }));
  expect(within(again).getByRole("menuitemradio", { name: "No folder" }).getAttribute("aria-checked")).toBe("true");
  fireEvent.click(within(again).getByRole("menuitemradio", { name: "No folder" }));
  await waitFor(() => {
    expect(screen.queryByRole("menu")).toBeNull();
  });
  expect(sent("update_item")).toHaveLength(1);
});

test("a_move_of_an_item_that_changed_meanwhile_says_so_and_moves_nothing", async () => {
  await unlocked();
  const panel = await openItem("Bot admin console");
  // Another program saved it after the page read it.
  const item = stored.find((one) => one.id === itemId(1));
  if (item !== undefined) item.revision = 9;
  const menu = await openMenu(within(panel).getByRole("button", { name: "Move" }));
  fireEvent.click(within(menu).getByRole("menuitemradio", { name: "Lineproof" }));
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain(CHANGED_MEANWHILE);
  expect(item?.collection).toBe(FOLDER);
  expect(shell.edited).toEqual([]);
  expect(statusText()).not.toContain("Moved to");
  expect(JSON.stringify(STALE_REVISION)).toContain("stale revision");
});

test("a_move_is_refused_in_words_for_a_folder_that_went_to_the_trash_meanwhile", async () => {
  await unlocked();
  const panel = await openItem("Bot admin console");
  const menu = await openMenu(within(panel).getByRole("button", { name: "Move" }));
  const target = stored.find((one) => one.id === FOLDER_2);
  if (target !== undefined) target.trashed = true;
  fireEvent.click(within(menu).getByRole("menuitemradio", { name: "Lineproof" }));
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).not.toContain("Moved to");
  expect(alert.textContent).toContain("Lockbox can't use that.");
  expect(stored.find((one) => one.id === itemId(1))?.collection).toBe(FOLDER);
});

test("an_item_that_is_a_folder_less_vault_still_moves_to_no_folder_only", async () => {
  await unlocked({ only: [{ id: itemId(1), kind: "note", title: "Plans", notes: "x", modified_at: "2026-11-04T09:00:00Z" }] });
  const panel = await openItem("Plans", "Note");
  const menu = await openMenu(within(panel).getByRole("button", { name: "Move" }));
  expect(within(menu).getAllByRole("menuitemradio").map((choice) => choice.textContent)).toEqual(["No folder"]);
});

// ---- Move to trash (13a) ----

test("trash_goes_at_once_with_undo", async () => {
  await unlocked();
  const panel = await openItem("Bot admin console");
  // The button is at the foot of the details, with its sentence under it, as drawn.
  const button = within(panel).getByRole("button", { name: "Move to trash" });
  expect(within(panel).getByText("You can restore it from Trash.")).toBeTruthy();
  expect(button.compareDocumentPosition(within(panel).getByText("You can restore it from Trash.")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

  fireEvent.click(button);
  // At once, with no question.
  expect(screen.queryByRole("dialog")).toBeNull();
  await waitFor(() => {
    expect(sent("trash_item")).toHaveLength(1);
  });
  expect(sent("trash_item")[0]).toMatchObject({ id: itemId(1) });
  // The panel closes, the item leaves the list, and the message says so with an Undo.
  await waitFor(() => {
    expect(screen.queryByRole("complementary", { name: "Bot admin console" })).toBeNull();
  });
  expect(screen.queryByRole("button", { name: /^Login:\s*Bot admin console/ })).toBeNull();
  expect(statusText()).toContain("Moved to Trash");
  const undo = within(screen.getByRole("status")).getByRole("button", { name: "Undo" });
  // Focus goes to the list, which is still there to carry on from.
  await waitFor(() => {
    expect(document.activeElement?.closest(".lgroups")).not.toBeNull();
  });
  // The Trash entry counts it.
  expect(trashEntry().textContent).toBe("Trash 8");
  expect(railButton(/^Agency support agent\s+1$/)).toBeTruthy();

  fireEvent.click(undo);
  await waitFor(() => {
    expect(sent("restore_item")).toHaveLength(1);
  });
  // The item that went is the one that comes back: the id is held with the message, not found again from a title.
  expect(sent("restore_item")[0]).toMatchObject({ id: itemId(1) });
  await screen.findByRole("button", { name: /^Login:\s*Bot admin console/ });
  await waitFor(() => {
    expect(statusText()).toContain("Restored");
  });
  expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  expect(stored.find((item) => item.id === itemId(1))?.trashed).toBe(false);
  await expectNoAxe(document.body);
});

test("a_second_item_trashed_takes_the_place_of_the_first_message_and_undo_undoes_the_newer", async () => {
  await unlocked();
  for (const title of ["Bot admin console", "Error tracker"]) {
    const panel = await openItem(title);
    fireEvent.click(within(panel).getByRole("button", { name: "Move to trash" }));
    await waitFor(() => {
      expect(screen.queryByRole("complementary", { name: title })).toBeNull();
    });
  }
  expect(screen.getAllByRole("button", { name: "Undo" })).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  await screen.findByRole("button", { name: /^Login:\s*Error tracker/ });
  expect(sent("restore_item")).toEqual([expect.objectContaining({ id: itemId(2) })]);
  expect(screen.queryByRole("button", { name: /^Login:\s*Bot admin console/ })).toBeNull();
});

test("a_copy_message_takes_the_place_of_the_trash_message", async () => {
  await unlocked();
  const panel = await openItem("Bot admin console");
  fireEvent.click(within(panel).getByRole("button", { name: "Move to trash" }));
  await waitFor(() => {
    expect(statusText()).toContain("Moved to Trash");
  });
  fireEvent.click(screen.getByRole("button", { name: "Copy password for Error tracker" }));
  await waitFor(() => {
    expect(statusText()).toContain("Password copied");
  });
  expect(statusText()).not.toContain("Moved to Trash");
  expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
});

test("the_trash_message_stays_ten_seconds_and_waits_while_the_pointer_or_focus_is_on_it", async () => {
  await unlocked();
  const panel = await openItem("Bot admin console");
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  fireEvent.click(within(panel).getByRole("button", { name: "Move to trash" }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(statusText()).toContain("Moved to Trash");

  await act(async () => {
    await vi.advanceTimersByTimeAsync(9_000);
  });
  expect(statusText()).toContain("Moved to Trash");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_500);
  });
  expect(toastText()).not.toContain("Moved to Trash");
  expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();

  // Again: the pointer resting on it holds the time, and when it leaves the ten seconds begin again.
  const second = await openItemWithFakeTimers("Error tracker");
  fireEvent.click(within(second).getByRole("button", { name: "Move to trash" }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  const message = screen.getByRole("button", { name: "Undo" }).closest(".toast") as HTMLElement;
  fireEvent.mouseEnter(message);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60_000);
  });
  expect(screen.queryByRole("button", { name: "Undo" })).not.toBeNull();
  fireEvent.mouseLeave(message);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(9_000);
  });
  expect(screen.queryByRole("button", { name: "Undo" })).not.toBeNull();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_500);
  });
  expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();

  // And with focus on Undo.
  const third = await openItemWithFakeTimers("Rotation steps", "Note");
  fireEvent.click(within(third).getByRole("button", { name: "Move to trash" }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  const undo = screen.getByRole("button", { name: "Undo" });
  act(() => {
    undo.focus();
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60_000);
  });
  expect(screen.queryByRole("button", { name: "Undo" })).not.toBeNull();
  act(() => {
    undo.blur();
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_500);
  });
  expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
});

/** Opens an item while the timers are faked: no waiting helper that needs a real timer. */
async function openItemWithFakeTimers(title: string, kind = "Login"): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${kind}:\\s*${title}`) }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  return screen.getByRole("complementary", { name: title });
}

test("undo_can_be_reached_and_used_by_keyboard", async () => {
  await unlocked();
  const panel = await openItem("Bot admin console");
  fireEvent.click(within(panel).getByRole("button", { name: "Move to trash" }));
  const undo = await screen.findByRole("button", { name: "Undo" });
  // A real button in the page's order, not taken out of the tab order, and named by its word.
  expect(undo.tagName).toBe("BUTTON");
  expect(undo.getAttribute("tabindex")).toBeNull();
  undo.focus();
  expect(document.activeElement).toBe(undo);
  fireEvent.click(undo);
  await screen.findByRole("button", { name: /^Login:\s*Bot admin console/ });
  // The button had focus and went with the message: focus goes to the list, not to the top of the page.
  await waitFor(() => {
    expect(document.activeElement?.closest(".lgroups")).not.toBeNull();
  });
});

test("ctrl_z_undoes_the_trash_while_its_message_shows", async () => {
  // Task 21's keyboard pass: Undo sits after the whole list in the Tab order, so in a long list its time could run out
  // before the keyboard reaches it. Ctrl+Z does what Undo does, from anywhere, while the message is up.
  await unlocked();
  const panel = await openItem("Bot admin console");
  fireEvent.click(within(panel).getByRole("button", { name: "Move to trash" }));
  const undo = await screen.findByRole("button", { name: "Undo" });
  // The button names its shortcut to a screen reader, the message shows it, and the place that announces it says it once.
  expect(undo.getAttribute("aria-keyshortcuts")).toBe("Control+Z");
  const hint = [...document.querySelectorAll(".tstack span")].find((span) => span.textContent === "Ctrl+Z");
  expect(hint?.getAttribute("aria-hidden")).toBe("true");

  // Inside a text box, Ctrl+Z is the box's own undo of typing: the item stays in the Trash.
  const filter = screen.getByRole("searchbox");
  filter.focus();
  fireEvent.keyDown(filter, { key: "z", ctrlKey: true });
  // With Shift or Alt it is another key.
  fireEvent.keyDown(document.body, { key: "Z", ctrlKey: true, shiftKey: true });
  fireEvent.keyDown(document.body, { key: "z", ctrlKey: true, altKey: true });
  expect(sent("restore_item")).toHaveLength(0);

  // Anywhere else: the item comes back, once, as Undo brings it back.
  const row = await screen.findByRole("button", { name: /^Login:\s*Error tracker/ });
  row.focus();
  const notStopped = fireEvent.keyDown(row, { key: "z", ctrlKey: true });
  expect(notStopped).toBe(false);
  await screen.findByRole("button", { name: /^Login:\s*Bot admin console/ });
  await waitFor(() => {
    expect(toastText()).toContain("Restored");
  });
  expect(sent("restore_item")).toHaveLength(1);
  // Focus was not in the message, so it stays where it was.
  expect(document.activeElement).toBe(row);

  // Once the message is gone, Ctrl+Z does nothing.
  fireEvent.keyDown(document.body, { key: "z", ctrlKey: true });
  expect(sent("restore_item")).toHaveLength(1);
});

test("ctrl_z_held_or_pressed_twice_restores_once", async () => {
  // From the review: the message stays up until the restore is answered, so a held key (repeats) or a second press meanwhile
  // must not send a second restore for an item already on its way back. Undo pressed after Ctrl+Z neither.
  await unlocked();
  const panel = await openItem("Bot admin console");
  fireEvent.click(within(panel).getByRole("button", { name: "Move to trash" }));
  const undo = await screen.findByRole("button", { name: "Undo" });
  const release = shell.holdTrash();
  fireEvent.keyDown(document.body, { key: "z", ctrlKey: true });
  fireEvent.keyDown(document.body, { key: "z", ctrlKey: true, repeat: true });
  fireEvent.keyDown(document.body, { key: "z", ctrlKey: true });
  fireEvent.click(undo);
  release();
  await screen.findByRole("button", { name: /^Login:\s*Bot admin console/ });
  await waitFor(() => {
    expect(toastText()).toContain("Restored");
  });
  expect(sent("restore_item")).toHaveLength(1);
  expect(screen.queryByRole("alert")).toBeNull();
});

test("ctrl_z_waits_while_a_question_is_up", async () => {
  await unlocked();
  const panel = await openItem("Bot admin console");
  fireEvent.click(within(panel).getByRole("button", { name: "Move to trash" }));
  await screen.findByRole("button", { name: "Undo" });
  // A question over the page has the keyboard: Ctrl+Z is not an answer to it, and nothing behind it changes.
  await openFolder("Agency support agent");
  const menu = await openMenu(screen.getByRole("button", { name: "More for this folder" }));
  fireEvent.click(within(menu).getByRole("menuitem", { name: "Rename folder" }));
  const dialog = await screen.findByRole("dialog", { name: "Rename folder" });
  // The message is still up behind the question (a role query can't see behind the dialog, so the page is read as it is).
  expect(document.querySelector(".tstack")?.textContent).toContain("Moved to Trash");
  fireEvent.keyDown(dialog, { key: "z", ctrlKey: true });
  expect(sent("restore_item")).toHaveLength(0);
  // Once the question is gone, Ctrl+Z works again.
  fireEvent.keyDown(dialog, { key: "Escape" });
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  fireEvent.keyDown(document.body, { key: "z", ctrlKey: true });
  await waitFor(() => {
    expect(sent("restore_item")).toHaveLength(1);
  });
});

test("the_trash_message_is_spoken_once_through_the_place_that_announces_copies", async () => {
  await unlocked();
  const panel = await openItem("Bot admin console");
  fireEvent.click(within(panel).getByRole("button", { name: "Move to trash" }));
  await screen.findByRole("button", { name: "Undo" });
  const places = screen.getAllByRole("status");
  expect(places).toHaveLength(1);
  expect(places[0]?.textContent).toContain("Moved to Trash");
  expect(places[0]?.className).toBe("live");
  // The words are in that place once, and not again in a place that would speak them a second time.
  expect(document.querySelectorAll('[role="alert"], [aria-live="assertive"]')).toHaveLength(0);
  expect((thePage().match(/Moved to Trash/g) ?? []).length).toBe(1);
  expect(document.body.innerHTML).not.toContain("Bot admin console\"");
});

test("after_a_lock_undo_is_gone_and_nothing_shows_an_error", async () => {
  await unlocked();
  const panel = await openItem("Bot admin console");
  fireEvent.click(within(panel).getByRole("button", { name: "Move to trash" }));
  await screen.findByRole("button", { name: "Undo" });
  await lockNow();
  expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(thePage()).not.toContain("Moved to Trash");
  expect(JSON.stringify(debugState().toast)).toBe("null");
  nothingOfTheVaultOnScreen();
});

function nothingOfTheVaultOnScreen() {
  const page = thePage();
  for (const word of ["Bot admin console", "Error tracker", "Slotted", "Old CRM login", "Lineproof"]) {
    expect(page, word).not.toContain(word);
  }
}

test("a_lock_while_the_trash_answer_is_on_its_way_shows_nothing_and_no_error", async () => {
  await unlocked();
  const panel = await openItem("Bot admin console");
  const release = shell.holdTrash();
  fireEvent.click(within(panel).getByRole("button", { name: "Move to trash" }));
  await waitFor(() => {
    expect(sent("trash_item")).toHaveLength(1);
  });
  await lockNow();
  await act(async () => {
    release();
    await Promise.resolve();
  });
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  expect(thePage()).not.toContain("Moved to Trash");
  nothingOfTheVaultOnScreen();
});

test("a_late_trash_answer_leaves_the_panel_the_person_has_moved_on_to", async () => {
  await unlocked();
  const first = await openItem("Bot admin console");
  const release = shell.holdTrash();
  fireEvent.click(within(first).getByRole("button", { name: "Move to trash" }));
  await waitFor(() => {
    expect(sent("trash_item")).toHaveLength(1);
  });
  // The person opens another item before the answer: that panel stays as they have it.
  fireEvent.click(screen.getByRole("button", { name: /^Login:\s*Error tracker/ }));
  await screen.findByRole("complementary", { name: "Error tracker" });
  await act(async () => {
    release();
    await Promise.resolve();
  });
  await screen.findByRole("button", { name: "Undo" });
  expect(screen.getByRole("complementary", { name: "Error tracker" })).toBeTruthy();
});

test("the_panel_of_an_item_that_went_to_the_trash_is_never_left_open", async () => {
  await unlocked();
  const panel = await openItem("Bot admin console");
  // Another program trashed it and the page read the list again: the panel does not outlive the item.
  const item = stored.find((one) => one.id === itemId(1));
  if (item !== undefined) item.trashed = true;
  fireEvent.click(within(panel).getByRole("button", { name: "Move to trash" }));
  await waitFor(() => {
    expect(screen.queryByRole("complementary", { name: "Bot admin console" })).toBeNull();
  });
});

// ---- The Trash view (13b) ----

test("the_trash_entry_counts_every_item_in_the_trash_folders_included", async () => {
  await unlocked();
  // The foot of the side menu, with its count: the loose one, the folder, its three, the earlier one, and the one from a folder.
  expect(trashEntry().textContent).toBe("Trash 7");
  expect(trashEntry().closest(".rfoot")).not.toBeNull();
  expect(trashEntry().getAttribute("aria-current")).toBeNull();
  // The folders and All items do not count them.
  expect(railButton(/^All items\s+4$/)).toBeTruthy();
  expect(railButton(/^Agency support agent\s+2$/)).toBeTruthy();
  expect(within(rail()).queryByText("Slotted")).toBeNull();
});

test("the_trash_view_lists_folders_first_then_newest_deleted_first", async () => {
  await unlocked();
  await openTrash();
  expect(trashEntry().getAttribute("aria-current")).toBe("page");
  expect(screen.getByText(NOTHING_REMOVED)).toBeTruthy();
  const rows = screen.getAllByRole("button").filter((button) => /^(Folder|Login|Key|Note|File):/.test(button.textContent));
  const named = rows.map((button) => button.textContent.replace(/\s+/g, " ").trim());
  expect(named).toEqual([
    "Folder: Slotted Folder · deleted 2 days ago",
    // Newest first: two days ago (the three that went with the folder), then this month, last month and September.
    "Note: Slotted note A Deleted 2 days ago",
    "Note: Slotted note B Deleted 2 days ago",
    "Note: Slotted note C Deleted 2 days ago",
    "Login: Old login in the trash Deleted this month",
    "Note: Earlier note Deleted last month",
    "Login: Old CRM login Deleted in September",
  ]);
  // Items that went with a folder are rows too, and no filter, sort, Add or copy buttons are here.
  expect(screen.queryByRole("button", { name: "Add" })).toBeNull();
  expect(screen.queryByLabelText("Filter this list")).toBeNull();
  expect(screen.queryByRole("button", { name: /^Copy / })).toBeNull();
  expect(screen.queryByText(/Empty trash/)).toBeNull();
  await expectNoAxe(document.body);
});

test("an_empty_trash_says_so", async () => {
  await unlocked({ only: sampleItems().filter((item) => item.trashed !== true) });
  expect(trashEntry().textContent).toBe("Trash 0");
  await openTrash();
  expect(screen.getByText("Trash is empty.")).toBeTruthy();
  expect(screen.getByText(NOTHING_REMOVED)).toBeTruthy();
});

test("a_picked_trash_row_opens_a_panel_with_restore_and_delete_for_good_and_nothing_else", async () => {
  await unlocked();
  await openTrash();
  const panel = await openTrashed("Login", "Old CRM login");
  expect(within(panel).getByRole("heading", { level: 2, name: "Old CRM login" })).toBeTruthy();
  // "was in" its folder, which is still there, and when it went.
  expect(within(panel).getByText("Login · was in Agency support agent · deleted in September")).toBeTruthy();
  const buttons = within(panel)
    .getAllByRole("button")
    .map((button) => button.textContent || button.getAttribute("aria-label"));
  expect(buttons).toEqual(["Close panel", "Restore", "Delete for good"]);
  for (const word of ["Reveal", "Copy", "Edit", "Move", "Open", "Password", "Username", "Website"]) {
    expect(within(panel).queryByText(new RegExp(word)), word).toBeNull();
  }
  // Nothing of the item is asked of the shell for it: not its details, not its password.
  expect(sent("get_item")).toEqual([]);
  expect(sent("reveal_password")).toEqual([]);
  // One that had no folder says no "was in", and one whose folder is in the trash too still names it.
  fireEvent.click(row("Login", "Old login in the trash"));
  const loose = await screen.findByRole("complementary", { name: "Old login in the trash" });
  expect(within(loose).getByText("Login · deleted this month")).toBeTruthy();
  fireEvent.click(row("Note", "Earlier note"));
  const earlier = await screen.findByRole("complementary", { name: "Earlier note" });
  expect(within(earlier).getByText("Note · was in Slotted · deleted last month")).toBeTruthy();
  await expectNoAxe(document.body);
});

test("move_to_trash_and_the_trash_answers_are_full_width_rows_of_a_card_as_drawn", async () => {
  // Found at stage 7: Move to trash was a small pill at the left, and the Trash's Restore and Delete for good two pills.
  // Drawn (2b, 13b): a card whose rows fill its width, Move to trash in red with its note centred under it, and in the
  // Trash, Restore in the accent above Delete for good in red.
  await unlocked();
  const panel = await openItem("Bot admin console");
  const trash = within(panel).getByRole("button", { name: "Move to trash" });
  expect(trash.classList.contains("dgr")).toBe(true);
  expect(trash.parentElement?.classList.contains("grp")).toBe(true);
  expect(trash.closest(".gapart")?.querySelector(".dcap")?.textContent).toBe("You can restore it from Trash.");
  await openTrash();
  const trashed = await openTrashed("Login", "Old CRM login");
  const restore = within(trashed).getByRole("button", { name: "Restore" });
  const forGood = within(trashed).getByRole("button", { name: "Delete for good" });
  expect(restore.classList.contains("dgr")).toBe(true);
  expect(restore.classList.contains("calm")).toBe(true);
  expect(forGood.classList.contains("dgr")).toBe(true);
  expect(forGood.classList.contains("calm")).toBe(false);
  expect(restore.parentElement).toBe(forGood.parentElement);
  expect(restore.parentElement?.classList.contains("grp")).toBe(true);
  await expectNoAxe(document.body);
});

test("a_trashed_keys_name_is_in_mono_in_its_row_and_heading_as_in_the_list", async () => {
  // The list, its details and search set a key's name in mono (as drawn); the Trash shows the same key the same way.
  await unlocked({
    extra: [{ id: itemId(61), kind: "key", title: "OLD_API_KEY", value: "made-up-old-key", trashed: true, trashedAt: "2026-11-09T09:00:00Z" }],
  });
  await openTrash();
  expect(row("Key", "OLD_API_KEY").querySelector(".rname")?.classList.contains("m")).toBe(true);
  expect(row("Login", "Old CRM login").querySelector(".rname")?.classList.contains("m")).toBe(false);
  const panel = await openTrashed("Key", "OLD_API_KEY");
  expect(within(panel).getByRole("heading", { level: 2, name: "OLD_API_KEY" }).classList.contains("m")).toBe(true);
  const login = await openTrashed("Login", "Old CRM login");
  expect(within(login).getByRole("heading", { level: 2, name: "Old CRM login" }).classList.contains("m")).toBe(false);
});

test("a_folder_that_is_gone_is_not_named_in_was_in", async () => {
  await unlocked({ extra: [{ id: itemId(60), kind: "note", title: "Orphan note", collection: itemId(99), trashed: true, trashedAt: "2026-11-09T09:00:00Z" }] });
  await openTrash();
  const panel = await openTrashed("Note", "Orphan note");
  expect(within(panel).getByText("Note · deleted yesterday")).toBeTruthy();
});

test("restore_from_trash", async () => {
  await unlocked();
  await openTrash();
  const panel = await openTrashed("Login", "Old login in the trash");
  fireEvent.click(within(panel).getByRole("button", { name: "Restore" }));
  await waitFor(() => {
    expect(sent("restore_item")).toEqual([expect.objectContaining({ id: LOOSE_TRASHED })]);
  });
  // It says so, the panel closes, and the row leaves the Trash view and the count.
  await waitFor(() => {
    expect(statusText()).toContain("Restored");
  });
  expect(screen.queryByRole("complementary", { name: "Old login in the trash" })).toBeNull();
  expect(screen.queryByRole("button", { name: /^Login:\s*Old login in the trash/ })).toBeNull();
  expect(trashEntry().textContent).toBe("Trash 6");
  expect(stored.find((item) => item.id === LOOSE_TRASHED)?.trashed).toBe(false);
  // Back in All items.
  fireEvent.click(railButton(/^All items\s+5$/));
  await screen.findByRole("button", { name: /^Login:\s*Old login in the trash/ });
});

test("restoring_an_item_whose_folder_is_in_the_trash_brings_the_folder_back_too", async () => {
  await unlocked();
  await openTrash();
  const panel = await openTrashed("Note", "Earlier note");
  fireEvent.click(within(panel).getByRole("button", { name: "Restore" }));
  await waitFor(() => {
    expect(statusText()).toContain("Restored");
  });
  // The folder is back in the side menu (alone: its other items stay in the trash), with the one item.
  expect(railButton(/^Slotted\s+1$/)).toBeTruthy();
  expect(screen.getByRole("button", { name: /^Note:\s*Slotted note A/ })).toBeTruthy();
  expect(stored.find((item) => item.id === MEMBER_A)?.trashed).toBe(true);
});

test("a_folder_in_the_trash_says_what_restore_brings_back", async () => {
  await unlocked();
  await openTrash();
  const panel = await openTrashed("Folder", "Slotted");
  expect(within(panel).getByText("Folder · deleted 2 days ago")).toBeTruthy();
  expect(
    within(panel).getByText(
      "Restore brings back the folder and the 3 items that went with it. Items you trashed before that stay in the Trash.",
    ),
  ).toBeTruthy();
  expect(within(panel).getAllByRole("button").map((button) => button.textContent || button.getAttribute("aria-label"))).toEqual([
    "Close panel",
    "Restore",
    "Delete for good",
  ]);
  fireEvent.click(within(panel).getByRole("button", { name: "Restore" }));
  await waitFor(() => {
    expect(statusText()).toContain("Restored");
  });
  // What it said is what came back: the folder and the three, and the earlier note stays in the Trash.
  expect(stored.filter((item) => item.collection === GONE_FOLDER && item.trashed !== true).map((item) => item.id)).toEqual([
    MEMBER_A,
    MEMBER_B,
    MEMBER_C,
  ]);
  expect(stored.find((item) => item.id === GONE_FOLDER)?.trashed).toBe(false);
  expect(stored.find((item) => item.id === EARLIER)?.trashed).toBe(true);
  expect(trashEntry().textContent).toBe("Trash 3");
  expect(railButton(/^Slotted\s+3$/)).toBeTruthy();
});

test("what_a_folder_restore_says_is_what_it_brings_back_when_one_item_is_being_deleted_for_good", async () => {
  await unlocked({
    extra: [{ id: itemId(61), kind: "note", title: "Frozen note", collection: GONE_FOLDER, trashed: true, trashedWith: GONE_FOLDER, purging: true }],
  });
  await openTrash();
  const panel = await openTrashed("Folder", "Slotted");
  // Four went with it, one of them is being deleted for good and does not come back: the page says 3.
  expect(within(panel).getByText(/the 3 items that went with it/)).toBeTruthy();
  const before = stored.filter((item) => item.trashed === true).map((item) => item.id);
  fireEvent.click(within(panel).getByRole("button", { name: "Restore" }));
  await waitFor(() => {
    expect(statusText()).toContain("Restored");
  });
  const brought = before.filter((id) => stored.find((item) => item.id === id)?.trashed !== true && id !== GONE_FOLDER);
  expect(brought).toHaveLength(3);
});

test("a_folder_with_one_item_or_none_says_so_in_its_words", async () => {
  await unlocked({
    extra: [
      { id: itemId(62), kind: "collection", title: "One thing", trashed: true, trashedAt: "2026-11-09T09:00:00Z" },
      { id: itemId(63), kind: "note", title: "The one", collection: itemId(62), trashed: true, trashedWith: itemId(62), trashedAt: "2026-11-09T09:00:00Z" },
      { id: itemId(64), kind: "collection", title: "No things", trashed: true, trashedAt: "2026-11-09T09:00:00Z" },
    ],
  });
  await openTrash();
  const one = await openTrashed("Folder", "One thing");
  expect(
    within(one).getByText("Restore brings back the folder and the 1 item that went with it. Items you trashed before that stay in the Trash."),
  ).toBeTruthy();
  const none = await openTrashed("Folder", "No things");
  expect(within(none).getByText("Restore brings back the folder. Items you trashed before that stay in the Trash.")).toBeTruthy();
});

// ---- Delete for good (13d) ----

test("delete_for_good_asks_first", async () => {
  await unlocked();
  await openTrash();
  const panel = await openTrashed("Login", "Old CRM login");
  const open = within(panel).getByRole("button", { name: "Delete for good" });
  open.focus();
  fireEvent.click(open);
  const dialog = await screen.findByRole("dialog", { name: "Delete Old CRM login for good?" });
  expect(
    within(dialog).getByText("Its attached files go too. This can't be undone. Backups you already made still hold it."),
  ).toBeTruthy();
  // Nothing has gone yet; Cancel has focus.
  expect(sent("purge_item")).toEqual([]);
  const cancel = within(dialog).getByRole("button", { name: "Cancel" });
  await waitFor(() => {
    expect(document.activeElement).toBe(cancel);
  });
  expect(within(dialog).getAllByRole("button").map((button) => button.textContent)).toEqual(["Cancel", "Delete for good"]);
  // The dangerous answer is a filled red button, as drawn (13d); Cancel is the quiet one, and has focus.
  expect(within(dialog).getByRole("button", { name: "Delete for good" }).classList.contains("dfill")).toBe(true);
  expect(cancel.classList.contains("dfill")).toBe(false);
  await expectNoAxe(document.body);

  // Cancel closes it, deletes nothing, and focus goes back to the panel's button.
  fireEvent.click(cancel);
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  await waitFor(() => {
    expect(document.activeElement).toBe(open);
  });
  expect(sent("purge_item")).toEqual([]);
  expect(screen.getByRole("complementary", { name: "Old CRM login" })).toBeTruthy();

  // Asked again and answered: it goes, and the panel and the row with it.
  fireEvent.click(open);
  const again = await screen.findByRole("dialog", { name: "Delete Old CRM login for good?" });
  fireEvent.click(within(again).getByRole("button", { name: "Delete for good" }));
  await waitFor(() => {
    expect(sent("purge_item")).toEqual([expect.objectContaining({ id: OLD_CRM })]);
  });
  await waitFor(() => {
    expect(screen.queryByRole("complementary", { name: "Old CRM login" })).toBeNull();
  });
  expect(screen.queryByRole("button", { name: /^Login:\s*Old CRM login/ })).toBeNull();
  expect(trashEntry().textContent).toBe("Trash 6");
  expect(statusText()).toContain("Deleted for good");
  // The title was on screen as text and nowhere else: not in an attribute the app made.
  for (const element of document.querySelectorAll("[aria-label],[title],[href],[src]")) {
    for (const name of ["aria-label", "title", "href", "src"]) {
      expect(element.getAttribute(name) ?? "", name).not.toContain("Old CRM");
    }
  }
});

test("escape_closes_the_delete_question_and_deletes_nothing", async () => {
  await unlocked();
  await openTrash();
  const panel = await openTrashed("Login", "Old CRM login");
  const open = within(panel).getByRole("button", { name: "Delete for good" });
  open.focus();
  fireEvent.click(open);
  const dialog = await screen.findByRole("dialog", { name: "Delete Old CRM login for good?" });
  fireEvent.keyDown(dialog, { key: "Escape" });
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(sent("purge_item")).toEqual([]);
  await waitFor(() => {
    expect(document.activeElement).toBe(open);
  });
});

test("delete_for_good_of_a_folder_says_only_the_folder_goes", async () => {
  await unlocked();
  await openTrash();
  const panel = await openTrashed("Folder", "Slotted");
  fireEvent.click(within(panel).getByRole("button", { name: "Delete for good" }));
  const dialog = await screen.findByRole("dialog", { name: "Delete Slotted for good?" });
  expect(
    within(dialog).getByText(
      "Only the folder goes. Items in the Trash stay there. This can't be undone. Backups you already made still hold it.",
    ),
  ).toBeTruthy();
  expect(within(dialog).queryByText(/attached files/)).toBeNull();
  fireEvent.click(within(dialog).getByRole("button", { name: "Delete for good" }));
  await waitFor(() => {
    expect(sent("purge_item")).toEqual([expect.objectContaining({ id: GONE_FOLDER })]);
  });
  // Its items stay in the Trash, with no folder to name any more.
  await waitFor(() => {
    expect(screen.queryByRole("button", { name: /^Folder:\s*Slotted/ })).toBeNull();
  });
  expect(screen.getByRole("button", { name: /^Note:\s*Slotted note A/ })).toBeTruthy();
  const member = await openTrashed("Note", "Slotted note A");
  expect(within(member).getByText("Note · deleted 2 days ago")).toBeTruthy();
});

test("a_refused_delete_for_good_is_said_in_words_and_the_row_stays", async () => {
  await unlocked();
  await openTrash();
  const panel = await openTrashed("Login", "Old CRM login");
  shell.refuseNext("purge_item", { code: "core", kind: "io" });
  fireEvent.click(within(panel).getByRole("button", { name: "Delete for good" }));
  const dialog = await screen.findByRole("dialog", { name: "Delete Old CRM login for good?" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Delete for good" }));
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("Lockbox couldn't reach that folder or file.");
  expect(screen.getByRole("button", { name: /^Login:\s*Old CRM login/ })).toBeTruthy();
});

// ---- Never by time ----

test("trash_never_empties_by_itself", async () => {
  await unlocked();
  await openTrash();
  const before = screen.getAllByRole("button").filter((button) => /^(Folder|Login|Key|Note|File):/.test(button.textContent)).length;
  expect(before).toBe(7);
  // A year later, and an hour of every timer the page has: nothing was asked of the shell, nothing left the view.
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2027-11-10T12:00:00Z"));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
  });
  vi.useRealTimers();
  for (const cmd of ["purge_item", "restore_item", "trash_item", "delete_collection"]) {
    expect(sent(cmd), cmd).toEqual([]);
  }
  const after = screen.getAllByRole("button").filter((button) => /^(Folder|Login|Key|Note|File):/.test(button.textContent)).length;
  expect(after).toBe(before);
  expect(stored.filter((item) => item.trashed === true)).toHaveLength(7);
  // No Empty trash, no "30 days" group, no "Delete these permanently": none of that is built yet.
  expect(screen.queryByText(/Empty trash/i)).toBeNull();
  expect(screen.queryByText(/30 days/)).toBeNull();
  expect(screen.queryByText(/permanently/i)).toBeNull();
});

// ---- Folders (14a to 14d) ----

test("new_folder_appears", async () => {
  await unlocked();
  const nav = rail();
  const start = within(nav).getByRole("button", { name: "New folder" });
  // Under the folders, in the list of them.
  const lastFolder = within(nav).getByRole("button", { name: /^Lineproof\s+1$/ });
  expect(lastFolder.compareDocumentPosition(start) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  fireEvent.click(start);

  // It becomes a one-line name box, with focus in it.
  const box = within(nav).getByRole("textbox", { name: "New folder name" });
  await waitFor(() => {
    expect(document.activeElement).toBe(box);
  });
  expect(within(nav).queryByRole("button", { name: "New folder" })).toBeNull();
  fireEvent.change(box, { target: { value: "  Quote parser " } });
  fireEvent.keyDown(box, { key: "Enter" });

  await waitFor(() => {
    expect(shell.made).toEqual([
      expect.objectContaining({ kind: "collection", title: "Quote parser", collection: null, fields: null }),
    ]);
  });
  // The folder is in the list in its place (by name), and opened: a person makes a folder to put something in it.
  const made = await screen.findByRole("button", { name: /^Quote parser\s+0$/ });
  expect(made.getAttribute("aria-current")).toBe("page");
  expect(screen.getByRole("heading", { level: 1, name: "Quote parser" })).toBeTruthy();
  const names = within(nav)
    .getAllByRole("button")
    .map((button) => button.textContent)
    .filter((text) => /\d$/.test(text) && !/^(All items|Trash)/.test(text));
  expect(names).toEqual(["AAgency support agent 2", "LLineproof 1", "QQuote parser 0"]);
  expect(within(nav).queryByRole("textbox")).toBeNull();
  expect(within(nav).getByRole("button", { name: "New folder" })).toBeTruthy();
  expect(screen.getByText("Nothing in Quote parser yet.")).toBeTruthy();
  await expectNoAxe(document.body);
});

test("a_new_folder_box_is_cancelled_by_escape_or_by_leaving_it_empty", async () => {
  await unlocked();
  const nav = rail();
  fireEvent.click(within(nav).getByRole("button", { name: "New folder" }));
  let box = within(nav).getByRole("textbox", { name: "New folder name" });
  fireEvent.change(box, { target: { value: "Half typed" } });
  fireEvent.keyDown(box, { key: "Escape" });
  expect(within(nav).queryByRole("textbox")).toBeNull();
  expect(sent("new_item")).toEqual([]);
  expect(within(nav).getByRole("button", { name: "New folder" })).toBeTruthy();

  // Enter on nothing, or on spaces, cancels; and so does leaving the box while it is empty.
  for (const typed of ["", "   "]) {
    fireEvent.click(within(nav).getByRole("button", { name: "New folder" }));
    box = within(nav).getByRole("textbox", { name: "New folder name" });
    fireEvent.change(box, { target: { value: typed } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(within(nav).queryByRole("textbox"), JSON.stringify(typed)).toBeNull();
    // Focus goes back to New folder, as Escape gives it, not to the top of the page (Task 21's keyboard pass).
    await waitFor(() => {
      expect(document.activeElement, JSON.stringify(typed)).toBe(within(nav).getByRole("button", { name: "New folder" }));
    });
  }
  fireEvent.click(within(nav).getByRole("button", { name: "New folder" }));
  box = within(nav).getByRole("textbox", { name: "New folder name" });
  fireEvent.blur(box);
  expect(within(nav).queryByRole("textbox")).toBeNull();
  expect(sent("new_item")).toEqual([]);
});

test("a_refused_folder_name_is_said_in_words_under_the_box", async () => {
  await unlocked();
  const nav = rail();
  fireEvent.click(within(nav).getByRole("button", { name: "New folder" }));
  const box = within(nav).getByRole("textbox", { name: "New folder name" });
  fireEvent.change(box, { target: { value: "Quote parser" } });
  shell.refuseNext("new_item", { code: "too_large", what: "title" });
  fireEvent.keyDown(box, { key: "Enter" });
  const alert = await within(nav).findByRole("alert");
  expect(alert.textContent).toContain("That is too big for Lockbox to keep.");
  // The box keeps what was typed, is marked, and points to the words.
  expect((box as HTMLInputElement).value).toBe("Quote parser");
  expect(box.getAttribute("aria-invalid")).toBe("true");
  expect(box.getAttribute("aria-describedby")).toBe(alert.id);
  expect(shell.made).toEqual([]);
  // A change takes the words away, and Enter tries again.
  fireEvent.change(box, { target: { value: "Quote parser 2" } });
  expect(within(nav).queryByRole("alert")).toBeNull();
  fireEvent.keyDown(box, { key: "Enter" });
  await screen.findByRole("heading", { level: 1, name: "Quote parser 2" });
});

test("the_same_name_as_another_folder_is_allowed", async () => {
  await unlocked();
  const nav = rail();
  fireEvent.click(within(nav).getByRole("button", { name: "New folder" }));
  const box = within(nav).getByRole("textbox", { name: "New folder name" });
  fireEvent.change(box, { target: { value: "Lineproof" } });
  fireEvent.keyDown(box, { key: "Enter" });
  await waitFor(() => {
    expect(within(nav).getAllByRole("button", { name: /^Lineproof\s+\d+$/ })).toHaveLength(2);
  });
});

test("the_folders_menu_has_the_env_entries_rename_and_delete_and_nothing_a_later_plan_builds", async () => {
  await unlocked();
  // Not on All items, and not on Trash.
  expect(screen.queryByRole("button", { name: "More for this folder" })).toBeNull();
  await openTrash();
  expect(screen.queryByRole("button", { name: "More for this folder" })).toBeNull();
  await openFolder("Lineproof");
  const more = screen.getByRole("button", { name: "More for this folder" });
  expect(more.getAttribute("aria-haspopup")).toBe("menu");
  const menu = await openMenu(more);
  // Lineproof holds no key, so only what leads somewhere: Paste a .env first, then the folder's own two.
  expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Paste a .env", "Rename folder", "Delete folder"]);
  expect(within(menu).queryByText(/Save all/i)).toBeNull();
  await expectNoAxe(menu);
});

test("save_all_not_in_folder_menu_until_4b", async () => {
  await unlocked({ extra: [{ id: itemId(60), kind: "key", title: "A_KEY", collection: FOLDER, value: "demo-4b" }] });
  await openFolder("Agency support agent");
  const menu = await openMenu(screen.getByRole("button", { name: "More for this folder" }));
  const names = within(menu).getAllByRole("menuitem").map((item) => item.textContent);
  // With a key in the folder the two taking-out entries show; the files' own "Save all files" is 4B's.
  expect(names).toEqual(["Paste a .env", "Copy all as .env", "Save as .env file", "Rename folder", "Delete folder"]);
  expect(thePage()).not.toMatch(/Save all files|Save all/);
  expect(screen.queryByRole("button", { name: /Save all/ })).toBeNull();
});

test("rename_folder_from_its_menu", async () => {
  await unlocked();
  await openFolder("Lineproof");
  const more = screen.getByRole("button", { name: "More for this folder" });
  const menu = await openMenu(more);
  fireEvent.click(within(menu).getByRole("menuitem", { name: "Rename folder" }));
  const dialog = await screen.findByRole("dialog", { name: "Rename folder" });
  const box = within(dialog).getByLabelText<HTMLInputElement>("Folder name");
  expect(box.value).toBe("Lineproof");
  await waitFor(() => {
    expect(document.activeElement).toBe(box);
  });
  expect(within(dialog).getAllByRole("button").map((button) => button.textContent)).toEqual(["Cancel", "Rename"]);
  await expectNoAxe(document.body);

  // A stale folder (changed meanwhile) is said in words and nothing changes; the dialog stays.
  const folder = stored.find((item) => item.id === FOLDER_2);
  if (folder !== undefined) folder.revision = 9;
  fireEvent.change(box, { target: { value: "Proofline" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Rename" }));
  const alert = await within(dialog).findByRole("alert");
  expect(alert.textContent).toContain(CHANGED_MEANWHILE);
  expect(folder?.title).toBe("Lineproof");
  expect(shell.edited).toEqual([]);

  // Said fresh: the page reads the folder again as the dialog opens, so the revision it sends is the one stored then.
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  await waitFor(() => {
    expect(document.activeElement).toBe(more);
  });
  const again = await openMenu(more);
  fireEvent.click(within(again).getByRole("menuitem", { name: "Rename folder" }));
  const second = await screen.findByRole("dialog", { name: "Rename folder" });
  const field = within(second).getByLabelText<HTMLInputElement>("Folder name");
  fireEvent.change(field, { target: { value: "  Proofline " } });
  fireEvent.submit(field.closest("form") as HTMLFormElement);
  await waitFor(() => {
    expect(edits()).toEqual([{ id: FOLDER_2, revision: 9, title: "Proofline", notes: "", collection: null }]);
  });
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(await screen.findByRole("heading", { level: 1, name: "Proofline" })).toBeTruthy();
  expect(railButton(/^Proofline\s+1$/)).toBeTruthy();
  await waitFor(() => {
    expect(document.activeElement).toBe(more);
  });
});

test("rename_asks_for_a_name_and_says_when_it_is_empty", async () => {
  await unlocked();
  await openFolder("Lineproof");
  const menu = await openMenu(screen.getByRole("button", { name: "More for this folder" }));
  fireEvent.click(within(menu).getByRole("menuitem", { name: "Rename folder" }));
  const dialog = await screen.findByRole("dialog", { name: "Rename folder" });
  const box = within(dialog).getByLabelText<HTMLInputElement>("Folder name");
  fireEvent.change(box, { target: { value: "   " } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Rename" }));
  const alert = await within(dialog).findByRole("alert");
  expect(alert.textContent).toBe("Type a name first.");
  expect(box.getAttribute("aria-invalid")).toBe("true");
  expect(sent("update_item")).toEqual([]);
});

test("delete_folder_says_how_many", async () => {
  await unlocked();
  await openFolder("Agency support agent");
  const more = screen.getByRole("button", { name: "More for this folder" });
  const menu = await openMenu(more);
  fireEvent.click(within(menu).getByRole("menuitem", { name: "Delete folder" }));
  const dialog = await screen.findByRole("dialog", { name: "Delete Agency support agent?" });
  expect(within(dialog).getByText("Its 2 items move to Trash, and you can restore them from there.")).toBeTruthy();
  expect(within(dialog).getAllByRole("button").map((button) => button.textContent)).toEqual(["Cancel", "Delete"]);
  expect(within(dialog).getByRole("button", { name: "Delete" }).classList.contains("dfill")).toBe(true);
  await expectNoAxe(document.body);

  // Cancel changes nothing, and focus goes back to the folder's menu.
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(sent("delete_collection")).toEqual([]);
  await waitFor(() => {
    expect(document.activeElement).toBe(more);
  });

  const again = await openMenu(more);
  fireEvent.click(within(again).getByRole("menuitem", { name: "Delete folder" }));
  const second = await screen.findByRole("dialog", { name: "Delete Agency support agent?" });
  fireEvent.click(within(second).getByRole("button", { name: "Delete" }));
  await waitFor(() => {
    expect(sent("delete_collection")).toEqual([expect.objectContaining({ id: FOLDER })]);
  });
  // The view goes to All items, the same message shows with Undo, and the folder and its items are in the Trash.
  await screen.findByRole("heading", { level: 1, name: "All items" });
  await waitFor(() => {
    expect(statusText()).toContain("Moved to Trash");
  });
  expect(screen.getByRole("button", { name: "Undo" })).toBeTruthy();
  expect(within(rail()).queryByRole("button", { name: /^Agency support agent/ })).toBeNull();
  expect(screen.queryByRole("button", { name: /^Login:\s*Bot admin console/ })).toBeNull();
  expect(trashEntry().textContent).toBe("Trash 10");
  await waitFor(() => {
    expect(document.activeElement?.closest(".lgroups, .lscroll")).not.toBeNull();
  });

  // Undo restores the folder with what went with it.
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  await waitFor(() => {
    expect(sent("restore_item")).toEqual([expect.objectContaining({ id: FOLDER })]);
  });
  await screen.findByRole("button", { name: /^Login:\s*Bot admin console/ });
  expect(railButton(/^Agency support agent\s+2$/)).toBeTruthy();
  await waitFor(() => {
    expect(statusText()).toContain("Restored");
  });
  // The one that was in the Trash on its own before stays there (Old CRM login was in this folder).
  expect(stored.find((item) => item.id === OLD_CRM)?.trashed).toBe(true);
  expect(trashEntry().textContent).toBe("Trash 7");
});

test("delete_folder_with_one_item_or_none_says_so_in_its_words", async () => {
  await unlocked();
  await openFolder("Lineproof");
  let menu = await openMenu(screen.getByRole("button", { name: "More for this folder" }));
  fireEvent.click(within(menu).getByRole("menuitem", { name: "Delete folder" }));
  const one = await screen.findByRole("dialog", { name: "Delete Lineproof?" });
  expect(within(one).getByText("Its 1 item moves to Trash, and you can restore it from there.")).toBeTruthy();
  fireEvent.click(within(one).getByRole("button", { name: "Cancel" }));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  // A folder with nothing in it.
  const nav = rail();
  fireEvent.click(within(nav).getByRole("button", { name: "New folder" }));
  const box = within(nav).getByRole("textbox", { name: "New folder name" });
  fireEvent.change(box, { target: { value: "Empty" } });
  fireEvent.keyDown(box, { key: "Enter" });
  await screen.findByRole("heading", { level: 1, name: "Empty" });
  menu = await openMenu(screen.getByRole("button", { name: "More for this folder" }));
  fireEvent.click(within(menu).getByRole("menuitem", { name: "Delete folder" }));
  const none = await screen.findByRole("dialog", { name: "Delete Empty?" });
  expect(within(none).getByText("It has no items.")).toBeTruthy();
  expect(within(none).queryByText(/move to Trash/)).toBeNull();
});

test("items_in_the_trash_before_a_folder_delete_are_not_counted_in_what_goes", async () => {
  await unlocked();
  await openFolder("Agency support agent");
  const menu = await openMenu(screen.getByRole("button", { name: "More for this folder" }));
  fireEvent.click(within(menu).getByRole("menuitem", { name: "Delete folder" }));
  // "Old CRM login" is in the Trash already, so two go, not three.
  expect(await screen.findByText("Its 2 items move to Trash, and you can restore them from there.")).toBeTruthy();
});

// ---- Read-only ----

test("a_read_only_vault_has_no_move_trash_folder_or_restore_buttons_but_the_trash_lists", async () => {
  await unlocked({ readOnly: true });
  const panel = await screen.findByRole("button", { name: /^Login:\s*Bot admin console/ });
  fireEvent.click(panel);
  const details = await screen.findByRole("complementary", { name: "Bot admin console" });
  expect(within(details).queryByRole("button", { name: "Move" })).toBeNull();
  expect(within(details).queryByRole("button", { name: "Move to trash" })).toBeNull();
  expect(within(details).queryByText("You can restore it from Trash.")).toBeNull();
  expect(within(rail()).queryByRole("button", { name: "New folder" })).toBeNull();
  await openFolder("Lineproof");
  expect(screen.queryByRole("button", { name: "More for this folder" })).toBeNull();

  await openTrash();
  expect(screen.getByText(NOTHING_REMOVED)).toBeTruthy();
  const trashed = await openTrashed("Login", "Old CRM login");
  expect(within(trashed).queryByRole("button", { name: "Restore" })).toBeNull();
  expect(within(trashed).queryByRole("button", { name: "Delete for good" })).toBeNull();
  expect(within(trashed).getByText("Read-only")).toBeTruthy();
  expect(within(trashed).getByText("Login · was in Agency support agent · deleted in September")).toBeTruthy();
  expect(shell.calls.filter((call) => ["trash_item", "restore_item", "purge_item", "delete_collection"].includes(call.cmd))).toEqual([]);
  await expectNoAxe(document.body);
});

// ---- A lock at any moment ----

test("a_lock_with_a_menu_a_dialog_or_a_name_box_open_leaves_nothing_and_no_error", async () => {
  await unlocked();
  // The Move menu open.
  const panel = await openItem("Bot admin console");
  await openMenu(within(panel).getByRole("button", { name: "Move" }));
  await lockNow();
  expect(screen.queryByRole("menu")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  nothingOfTheVaultOnScreen();
  expect(sent("update_item")).toEqual([]);
});

test("a_lock_with_the_delete_dialog_open_goes_with_no_error_and_nothing_deleted", async () => {
  await unlocked();
  await openFolder("Agency support agent");
  const menu = await openMenu(screen.getByRole("button", { name: "More for this folder" }));
  fireEvent.click(within(menu).getByRole("menuitem", { name: "Delete folder" }));
  await screen.findByRole("dialog", { name: "Delete Agency support agent?" });
  await lockNow();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(sent("delete_collection")).toEqual([]);
  nothingOfTheVaultOnScreen();
});

test("a_lock_with_the_rename_dialog_or_the_trash_dialog_open_goes_with_no_error", async () => {
  await unlocked();
  await openFolder("Lineproof");
  const menu = await openMenu(screen.getByRole("button", { name: "More for this folder" }));
  fireEvent.click(within(menu).getByRole("menuitem", { name: "Rename folder" }));
  const dialog = await screen.findByRole("dialog", { name: "Rename folder" });
  fireEvent.change(within(dialog).getByLabelText("Folder name"), { target: { value: "Half typed" } });
  await lockNow();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(thePage()).not.toContain("Half typed");
  expect(shell.edited).toEqual([]);
});

test("a_lock_with_the_new_folder_box_open_drops_what_was_typed", async () => {
  await unlocked();
  fireEvent.click(within(rail()).getByRole("button", { name: "New folder" }));
  fireEvent.change(within(rail()).getByRole("textbox", { name: "New folder name" }), { target: { value: "Half typed" } });
  await lockNow();
  expect(thePage()).not.toContain("Half typed");
  expect(screen.queryByRole("alert")).toBeNull();
  expect(sent("new_item")).toEqual([]);
  // Unlocked again: nothing of it is there.
  const field = await screen.findByLabelText(/^Password for /);
  fireEvent.change(field, { target: { value: PASSWORD } });
  fireEvent.submit((field as HTMLInputElement).form as HTMLFormElement);
  await screen.findByRole("heading", { level: 1, name: "All items" });
  expect(within(rail()).queryByRole("textbox")).toBeNull();
});

test("a_lock_in_the_trash_view_and_a_late_answer_show_nothing", async () => {
  await unlocked();
  await openTrash();
  const panel = await openTrashed("Login", "Old CRM login");
  const release = shell.holdTrash();
  fireEvent.click(within(panel).getByRole("button", { name: "Restore" }));
  await waitFor(() => {
    expect(sent("restore_item")).toHaveLength(1);
  });
  await lockNow();
  await act(async () => {
    release();
    await Promise.resolve();
  });
  expect(screen.queryByRole("alert")).toBeNull();
  expect(thePage()).not.toContain("Restored");
  nothingOfTheVaultOnScreen();
});

test("a_late_restore_answer_leaves_the_panel_the_person_has_moved_on_to", async () => {
  await unlocked();
  await openTrash();
  const first = await openTrashed("Login", "Old CRM login");
  const release = shell.holdTrash();
  fireEvent.click(within(first).getByRole("button", { name: "Restore" }));
  await waitFor(() => {
    expect(sent("restore_item")).toHaveLength(1);
  });
  fireEvent.click(row("Note", "Earlier note"));
  await screen.findByRole("complementary", { name: "Earlier note" });
  await act(async () => {
    release();
    await Promise.resolve();
  });
  await waitFor(() => {
    expect(statusText()).toContain("Restored");
  });
  expect(screen.getByRole("complementary", { name: "Earlier note" })).toBeTruthy();
});

test("a_late_folder_delete_answer_does_not_move_a_view_the_person_has_left", async () => {
  await unlocked();
  await openFolder("Agency support agent");
  const menu = await openMenu(screen.getByRole("button", { name: "More for this folder" }));
  fireEvent.click(within(menu).getByRole("menuitem", { name: "Delete folder" }));
  const dialog = await screen.findByRole("dialog", { name: "Delete Agency support agent?" });
  const release = shell.holdTrash();
  fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
  await waitFor(() => {
    expect(sent("delete_collection")).toHaveLength(1);
  });
  // The person goes to the Trash while the answer is on its way: they stay there.
  fireEvent.click(trashEntry());
  await screen.findByRole("heading", { level: 1, name: "Trash" });
  await act(async () => {
    release();
    await Promise.resolve();
  });
  await waitFor(() => {
    expect(statusText()).toContain("Moved to Trash");
  });
  expect(screen.getByRole("heading", { level: 1, name: "Trash" })).toBeTruthy();
});

// ---- Trashed items never show outside the Trash view ----

test("a_trashed_item_never_shows_outside_the_trash_view", async () => {
  await unlocked();
  // The list, the counts, the folder menu, and the folder pickers of the forms: none holds the trash.
  const everything = thePage();
  for (const gone of ["Old login in the trash", "Old CRM login", "Slotted", "Earlier note"]) {
    expect(everything, gone).not.toContain(gone);
  }
  expect(railButton(/^All items\s+4$/)).toBeTruthy();
  // Search finds none of it either.
  fireEvent.click(railButton(/^Search/));
  const dialog = await screen.findByRole("dialog", { name: "Search every unlocked vault" });
  for (const word of ["old", "Slotted", "Earlier"]) {
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Search every unlocked vault" }), { target: { value: word } });
    await within(dialog).findByText(new RegExp(`Nothing for "${word}"`));
  }
  fireEvent.keyDown(dialog, { key: "Escape" });
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  // The Add form's folder list names only live folders.
  const add = await screen.findByRole("button", { name: "Add" });
  pointerOpen(add);
  const menu = await screen.findByRole("menu");
  fireEvent.click(within(menu).getByRole("menuitem", { name: "Note" }));
  const form = await screen.findByRole("complementary", { name: "New note" });
  const folder = within(form).getByRole("combobox", { name: "Folder" });
  fireEvent.pointerDown(folder, { button: 0 });
  fireEvent.click(folder);
  const options = (await screen.findAllByRole("option")).map((option) => option.textContent);
  expect(options).toEqual(["No folder", "Agency support agent", "Lineproof"]);
});

test("a_folder_moved_to_the_trash_leaves_the_move_menu", async () => {
  await unlocked();
  const panel = await openItem("Error tracker");
  const menu = await openMenu(within(panel).getByRole("button", { name: "Move" }));
  expect(within(menu).getAllByRole("menuitemradio").map((choice) => choice.textContent)).toEqual([
    "No folder",
    "Agency support agent",
    "Lineproof",
  ]);
});

// ---- Words and parts ----

test("no_item_content_is_in_an_aria_label_beyond_what_the_screens_have", async () => {
  await unlocked();
  const labels = () =>
    Array.from(document.querySelectorAll("[aria-label]"))
      .map((element) => element.getAttribute("aria-label") ?? "")
      .join("\n");
  await openTrash();
  await openTrashed("Login", "Old CRM login");
  // The trash rows and panel are named by their words: no folder name, no username, no other title in a label.
  for (const secret of ["crm@example.com", "Slotted", "Earlier note", "Agency support agent"]) {
    expect(labels(), secret).not.toContain(secret);
  }
  const panel = screen.getByRole("complementary", { name: "Old CRM login" });
  // The one label with the title is the panel's own name, which is its title, as every panel's is.
  expect(panel.getAttribute("aria-label")).toBe("Old CRM login");
  expect(labels().split("\n").filter((label) => label.includes("Old CRM"))).toEqual(["Old CRM login"]);
  fireEvent.click(within(panel).getByRole("button", { name: "Delete for good" }));
  await screen.findByRole("dialog", { name: "Delete Old CRM login for good?" });
});

test("the_closed_side_menu_names_the_trash_and_new_folder_buttons", async () => {
  await unlocked();
  fireEvent.click(screen.getByRole("button", { name: "Close side menu" }));
  const nav = rail();
  expect(within(nav).getByRole("button", { name: "Trash, 7 items" })).toBeTruthy();
  const add = within(nav).getByRole("button", { name: "New folder" });
  fireEvent.click(add);
  // The box has no room in the strip, so the side menu opens for it.
  await waitFor(() => {
    expect(within(nav).getByRole("textbox", { name: "New folder name" })).toBeTruthy();
  });
  expect(within(nav).getByRole("button", { name: "Close side menu" })).toBeTruthy();
});

test("every_new_part_passes_the_accessibility_check", async () => {
  await unlocked();
  const panel = await openItem("Bot admin console");
  const move = await openMenu(within(panel).getByRole("button", { name: "Move" }), "Move to folder");
  await expectNoAxe(move);
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
  await waitFor(() => {
    expect(screen.queryByRole("menu")).toBeNull();
  });
  fireEvent.click(within(panel).getByRole("button", { name: "Move to trash" }));
  await screen.findByRole("button", { name: "Undo" });
  await expectNoAxe(document.body);
  await openTrash();
  await expectNoAxe(document.body);
});

test("no_style_element_or_inline_style_is_made_by_the_new_parts", async () => {
  const { container } = await unlocked();
  // The list's toolbar has the kind and sort lists (Task 15), each with the library's own hidden input inside it, set by script.
  expect([...container.querySelectorAll("[style]")].filter((element) => element.closest(".tb .sortw") === null)).toEqual([]);
  await openTrash();
  await openTrashed("Folder", "Slotted");
  // The page itself, with the Trash view and its panel, writes none (what a part sets by script while a dialog is open is its own).
  expect(container.querySelectorAll("[style]")).toHaveLength(0);
  fireEvent.click(within(screen.getByRole("complementary", { name: "Slotted" })).getByRole("button", { name: "Delete for good" }));
  await screen.findByRole("dialog");
  expect(document.querySelectorAll("style")).toHaveLength(0);
});

// ---- The fix round: a write that fails partway, an older list answer, a cancelled dialog, and Undo's focus ----

const IO_WORDS = "Lockbox couldn't reach that folder or file.";

/** Waits for the shell to have been sent `count` of `cmd`. */
async function sentTimes(cmd: string, count: number) {
  await waitFor(() => {
    expect(sent(cmd)).toHaveLength(count);
  });
}

test("a_folder_delete_that_fails_partway_shows_what_was_written_and_still_says_why", async () => {
  await unlocked();
  await openFolder("Agency support agent");
  const panel = await openItem("Bot admin console");
  fireEvent.click(within(panel).getByRole("button", { name: "Reveal" }));
  await within(panel).findByRole("textbox", { name: "Password" });
  expect(thePage()).toContain("Pw-from-the-fake-shell");

  // The first item is written, the second write is refused: what was written stays written.
  shell.failPartwayNext("delete_collection", 1, { code: "core", kind: "io" });
  const menu = await openMenu(screen.getByRole("button", { name: "More for this folder" }));
  fireEvent.click(within(menu).getByRole("menuitem", { name: "Delete folder" }));
  const dialog = await screen.findByRole("dialog", { name: "Delete Agency support agent?" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

  // The refusal is said in its own words, and the page agrees with the vault: the item that went is gone from the list, its
  // panel is gone, and the value revealed in it is nowhere on the page. The Trash counts it, so it can be restored.
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain(IO_WORDS);
  await waitFor(() => {
    expect(screen.queryByRole("button", { name: /^Login:\s*Bot admin console/ })).toBeNull();
  });
  expect(screen.queryByRole("complementary", { name: "Bot admin console" })).toBeNull();
  expect(thePage()).not.toContain("Pw-from-the-fake-shell");
  expect(JSON.stringify(debugState())).not.toContain("Pw-from-the-fake-shell");
  expect(trashEntry().textContent).toBe("Trash 8");
  // What was not written is still where it was, and the folder is still a folder.
  expect(screen.getByRole("button", { name: /^Note:\s*Rotation steps/ })).toBeTruthy();
  expect(railButton(/^Agency support agent\s+1$/)).toBeTruthy();
  expect(screen.getByRole("heading", { level: 1, name: "Agency support agent" })).toBeTruthy();
  // No message says it moved to the Trash: it did not all go.
  expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
});

test("a_folder_restore_that_fails_partway_shows_what_came_back_and_still_says_why", async () => {
  await unlocked();
  await openTrash();
  const panel = await openTrashed("Folder", "Slotted");
  expect(within(panel).getByText(/the 3 items that went with it/)).toBeTruthy();
  shell.failPartwayNext("restore_item", 1, { code: "core", kind: "io" });
  fireEvent.click(within(panel).getByRole("button", { name: "Restore" }));
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain(IO_WORDS);
  // One item came back, so the Trash lost it, and the folder's panel counts what is left to bring back.
  await waitFor(() => {
    expect(trashEntry().textContent).toBe("Trash 6");
  });
  expect(screen.getByRole("button", { name: /^Folder:\s*Slotted/ })).toBeTruthy();
  expect(await screen.findByText(/the 2 items that went with it/)).toBeTruthy();
});

test("a_refused_change_whose_refresh_is_refused_too_still_says_the_first_thing", async () => {
  await unlocked();
  const panel = await openItem("Bot admin console");
  shell.refuseNext("trash_item", { code: "core", kind: "io" });
  shell.refuseNext("list_items", { code: "busy" });
  fireEvent.click(within(panel).getByRole("button", { name: "Move to trash" }));
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain(IO_WORDS);
  await sentTimes("trash_item", 1);
  await waitFor(() => {
    expect(sent("list_items")).toHaveLength(2);
  });
  // The second refusal says nothing over the first, and the page keeps what it had: the list and the panel.
  expect(screen.getAllByRole("alert")).toHaveLength(1);
  expect(screen.getByRole("alert").textContent).not.toContain("busy");
  expect(screen.getByRole("button", { name: /^Login:\s*Bot admin console/ })).toBeTruthy();
  expect(screen.getByRole("complementary", { name: "Bot admin console" })).toBeTruthy();
});

test("an_older_list_answer_never_replaces_a_newer_one", async () => {
  await unlocked();
  const panel = await openItem("Bot admin console");
  const release = shell.holdListItems(true);
  // A move, whose list is read and held; then, before it answers, the item goes to the Trash, whose list is read and held.
  const menu = await openMenu(within(panel).getByRole("button", { name: "Move" }));
  fireEvent.click(within(menu).getByRole("menuitemradio", { name: "Lineproof" }));
  await sentTimes("update_item", 1);
  await waitFor(() => {
    expect(sent("list_items")).toHaveLength(2);
  });
  fireEvent.click(within(panel).getByRole("button", { name: "Move to trash" }));
  await sentTimes("trash_item", 1);
  await waitFor(() => {
    expect(sent("list_items")).toHaveLength(3);
  });
  // The newer answer arrives first (the item is in the Trash), and the older one, read before that, comes after it.
  await act(async () => {
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  expect(screen.queryByRole("button", { name: /^Login:\s*Bot admin console/ })).toBeNull();
  expect(trashEntry().textContent).toBe("Trash 8");
  expect(railButton(/^Lineproof\s+1$/)).toBeTruthy();
  expect(railButton(/^All items\s+3$/)).toBeTruthy();
});

test("a_cancelled_rename_that_answers_late_does_not_close_the_next_dialog", async () => {
  await unlocked();
  await openFolder("Lineproof");
  const more = screen.getByRole("button", { name: "More for this folder" });
  const first = await openMenu(more);
  fireEvent.click(within(first).getByRole("menuitem", { name: "Rename folder" }));
  const rename = await screen.findByRole("dialog", { name: "Rename folder" });
  await sentTimes("get_item", 1);
  // Rename is ready once the folder has been read.
  await waitFor(() => {
    expect(within(rename).getByRole("button", { name: "Rename" }).getAttribute("aria-disabled")).toBeNull();
  });
  fireEvent.change(within(rename).getByLabelText("Folder name"), { target: { value: "Proofline" } });
  const release = shell.holdUpdate();
  fireEvent.click(within(rename).getByRole("button", { name: "Rename" }));
  await sentTimes("update_item", 1);
  // Cancel while the answer is on its way, and ask the next question.
  fireEvent.click(within(rename).getByRole("button", { name: "Cancel" }));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  const second = await openMenu(more);
  fireEvent.click(within(second).getByRole("menuitem", { name: "Delete folder" }));
  const dialog = await screen.findByRole("dialog", { name: "Delete Lineproof?" });
  const cancel = within(dialog).getByRole("button", { name: "Cancel" });
  await waitFor(() => {
    expect(document.activeElement).toBe(cancel);
  });

  await act(async () => {
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  // The old rename was written, and it changes nothing about this question: still open, focus still in it.
  expect(stored.find((item) => item.id === FOLDER_2)?.title).toBe("Proofline");
  expect(screen.getByRole("dialog", { name: "Delete Lineproof?" })).toBeTruthy();
  expect(dialog.contains(document.activeElement)).toBe(true);
});

test("a_new_folder_box_that_is_gone_opens_nothing_when_its_answer_comes", async () => {
  await unlocked();
  const nav = rail();
  fireEvent.click(within(nav).getByRole("button", { name: "New folder" }));
  const box = within(nav).getByRole("textbox", { name: "New folder name" });
  fireEvent.change(box, { target: { value: "Quote parser" } });
  const release = shell.holdNewItem();
  fireEvent.keyDown(box, { key: "Enter" });
  await sentTimes("new_item", 1);
  fireEvent.keyDown(box, { key: "Escape" });
  expect(within(nav).queryByRole("textbox")).toBeNull();
  await act(async () => {
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  // The folder was made, and is in the list; the view stays where the person left it.
  await screen.findByRole("button", { name: /^Quote parser\s+0$/ });
  expect(screen.getByRole("heading", { level: 1, name: "All items" })).toBeTruthy();
});

test("undo_gives_focus_to_the_list_or_to_the_heading_when_it_removes_the_button_that_had_it", async () => {
  // A folder with nothing in it: after it is deleted and the delete undone there is no list, so focus goes to the heading.
  await unlocked({ only: [{ id: FOLDER, kind: "collection", title: "Empty one" }] });
  await openFolder("Empty one");
  const menu = await openMenu(screen.getByRole("button", { name: "More for this folder" }));
  fireEvent.click(within(menu).getByRole("menuitem", { name: "Delete folder" }));
  const dialog = await screen.findByRole("dialog", { name: "Delete Empty one?" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
  const undo = await screen.findByRole("button", { name: "Undo" });
  await screen.findByRole("heading", { level: 1, name: "All items" });
  act(() => {
    undo.focus();
  });
  expect(document.activeElement).toBe(undo);
  fireEvent.click(undo);
  await waitFor(() => {
    expect(statusText()).toContain("Restored");
  });
  expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  await waitFor(() => {
    expect(document.activeElement).toBe(screen.getByRole("heading", { level: 1, name: "All items" }));
  });
});

test("an_undo_that_did_not_have_focus_does_not_take_it", async () => {
  await unlocked();
  const panel = await openItem("Bot admin console");
  fireEvent.click(within(panel).getByRole("button", { name: "Move to trash" }));
  const undo = await screen.findByRole("button", { name: "Undo" });
  // The person is somewhere else (the filter box) when the answer comes: focus stays there.
  const filter = screen.getByLabelText("Filter this list");
  act(() => {
    filter.focus();
  });
  fireEvent.click(undo);
  await waitFor(() => {
    expect(statusText()).toContain("Restored");
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(document.activeElement).toBe(filter);
});
