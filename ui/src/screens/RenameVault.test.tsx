// Plan 4C Task 8's screen: Rename in the open vault's menu (18d). The menu closes and a small box opens in its place, holding the vault's name; Rename saves it, and the new name is
// the menu's, the strip's and the lock screen's. Every case runs through the real App against the pretend shell, as a person reaches it. The words under the box are the
// session's (for Ariel to change), so each test holds them as literals: a refusal shown as raw text, or as other words, fails.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import App from "../App";
import { debugState, refreshVaults, renameVault, resetStoreForTests, showSession } from "../store";
import { expectNoAxe } from "../testing/axe";
import { rowReads } from "../testing/menuRows";
import {
  BACKUP_PASSWORD,
  DETAILS_UNCHECKED,
  installFakeShell,
  PASSWORD,
  PASSWORD_COPIES_DISAGREE,
  RECOVERY_KEY_COPIES_DISAGREE,
  sampleItems,
  type FakeOlderCopy,
  type FakeShell,
  type FakeVault,
} from "../testing/fakeShell";

const { invoke, listen } = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));

afterEach(cleanup);

let shell: FakeShell;

beforeEach(() => {
  for (const style of document.querySelectorAll("style")) style.remove();
  resetStoreForTests();
  invoke.mockReset();
  listen.mockReset();
});

const BACKUP = "My vault 2026-10-02";
const OLDER = "My vault.before-restore";
const TOO_LONG = "That name is too long. A vault name can have up to 200 characters.";
const NAME_FIRST = "Give the vault a name.";
const THEN_RENAME = {
  changed: "Its details were changed outside Petalock. Look at that change and accept it first, then rename it.",
  unchecked: "Lock this vault and open it again, then rename it.",
  password: "Change this vault's password once more, then rename it.",
  recovery: "Make a new recovery key for this vault, then rename it.",
};

/** A vault's menu row by its name: an open vault's row reads "<name>Unlocked" (its status line, 4C Task 13b), so either way finds it. */
function rowName(name: string | RegExp): string | RegExp | ((read: string) => boolean) {
  if (typeof name !== "string") return name;
  return (read) => read === name || read === `${name}Unlocked`;
}

function vault(id: number, name: string | null, extra: Partial<FakeVault> = {}): FakeVault {
  return { id, name, items: sampleItems(), ...extra };
}

function sent(cmd: string): Record<string, unknown>[] {
  return invoke.mock.calls.filter(([name]) => name === cmd).map(([, args]) => args as Record<string, unknown>);
}

function sessionOfVault(id: number): { session: number; generation: number } {
  const live = shell.sessionOf(id);
  if (live === undefined) throw new Error(`vault ${String(id)} is not open`);
  return { session: live.session, generation: live.generation };
}

function side(): HTMLElement {
  return screen.getByRole("navigation", { name: "Vault and folders" });
}

/** One vault of `list`, unlocked through the lock screen (the first that can be opened). */
async function unlocked(list: FakeVault[]) {
  shell = installFakeShell(invoke, listen, list);
  const view = render(<App />);
  const field = await screen.findByLabelText(/^Password for /);
  fireEvent.change(field, { target: { value: PASSWORD } });
  fireEvent.submit((field as HTMLInputElement).form as HTMLFormElement);
  await screen.findByRole("heading", { level: 1, name: "All items", hidden: true });
  return view;
}

/** The vault menu, opened as a click does. */
async function openVaultMenu(): Promise<HTMLElement> {
  // What the screen before it left to do a turn later (focus going back to the button that opened a panel) is done first: it would take focus from the menu.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
  const opener = screen.getByRole("button", { name: /, vault menu$/ });
  opener.focus();
  fireEvent.pointerDown(opener, { button: 0 });
  fireEvent.click(opener);
  return screen.findByRole("menu");
}

function rowsOf(menu: HTMLElement): HTMLElement[] {
  return within(menu).getAllByRole("menuitemradio");
}

async function unlockFromMenu(name: string): Promise<void> {
  const menu = await openVaultMenu();
  const row = rowsOf(menu).find((one) => rowReads(one, name, "Locked"));
  if (row === undefined) throw new Error(`no locked row for ${name}`);
  fireEvent.click(row);
  await waitFor(() => {
    expect(screen.queryByRole("menu")).toBeNull();
  });
  const field = await screen.findByLabelText(/^Password for /);
  fireEvent.change(field, { target: { value: PASSWORD } });
  fireEvent.submit((field as HTMLInputElement).form as HTMLFormElement);
  await screen.findByRole("button", { name: `${name}, vault menu` });
}

/** Every vault of `list` open, the first through the lock screen and the rest from the menu: the last one is on screen. */
async function allOpen(list: FakeVault[]) {
  const view = await unlocked(list);
  for (const one of list.slice(1)) await unlockFromMenu(one.name ?? "");
  return view;
}

/** A vault of the menu brought to the front. */
async function switchTo(name: string) {
  const menu = await openVaultMenu();
  fireEvent.click(within(menu).getByRole("menuitemradio", { name: rowName(name) }));
  await screen.findByRole("button", { name: `${name}, vault menu` });
}

/** Rename, chosen from the vault menu of the vault on screen, and the box that opens in its place. */
async function openBox(name: string): Promise<HTMLElement> {
  const menu = await openVaultMenu();
  fireEvent.click(within(menu).getByRole("menuitem", { name: `Rename ${name}` }));
  await waitFor(() => {
    expect(screen.queryByRole("menu")).toBeNull();
  });
  return screen.findByRole("dialog", { name: "Rename vault" });
}

function nameBox(from: string): HTMLInputElement {
  return screen.getByLabelText<HTMLInputElement>(`New name for ${from}`);
}

function press(name: string): void {
  fireEvent.click(within(screen.getByRole("dialog", { name: "Rename vault" })).getByRole("button", { name }));
}

/** Types a name in the box and presses Rename. */
function rename(from: string, to: string): void {
  fireEvent.change(nameBox(from), { target: { value: to } });
  press("Rename");
}

async function boxGone(): Promise<void> {
  await waitFor(() => {
    expect(screen.queryByRole("dialog", { name: "Rename vault" })).toBeNull();
  });
}

/** The words the box says, from the alert in it. */
async function boxSays(): Promise<string> {
  const alert = await within(screen.getByRole("dialog", { name: "Rename vault" })).findByRole("alert");
  return alert.textContent;
}

// ---- The box, as 18d draws it ----

test("rename_from_the_vault_menu_saves_and_shows_the_new_name_everywhere", async () => {
  const list = [vault(7, "My vault"), vault(8, "Home")];
  await allOpen(list);
  await switchTo("My vault");

  // The menu: Rename right after Lock, named for the vault on screen (Show and Remove follow it, Task 9).
  const menu = await openVaultMenu();
  expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
    "New vault",
    "Add existing vault folder",
    "Lock My vault",
    "Rename My vault",
    "Show My vault in Explorer",
    "Remove My vault from this list",
  ]);
  fireEvent.click(within(menu).getByRole("menuitem", { name: "Rename My vault" }));
  await waitFor(() => {
    expect(screen.queryByRole("menu")).toBeNull();
  });

  // 18d: a small box named "Rename vault" (a dialog, no title, no picture, no close button), with the label, the current name, and Cancel then Rename.
  const box = await screen.findByRole("dialog", { name: "Rename vault" });
  expect(within(box).queryByRole("heading")).toBeNull();
  expect(within(box).getAllByRole("button").map((button) => button.textContent)).toEqual(["Cancel", "Rename"]);
  expect(box.querySelector("svg, img")).toBeNull();
  const input = nameBox("My vault");
  expect(input.value).toBe("My vault");
  expect(input.type).toBe("text");
  expect(input.getAttribute("autocomplete")).toBe("off");
  expect(input.getAttribute("spellcheck")).toBe("false");
  expect(within(box).getByText("New name for My vault").tagName).toBe("LABEL");
  // Focus is in the box, the name selected, so typing replaces it.
  await waitFor(() => {
    expect(document.activeElement).toBe(input);
  });
  expect([input.selectionStart, input.selectionEnd]).toEqual([0, "My vault".length]);
  // Nothing is sent until Rename.
  expect(sent("rename_vault")).toEqual([]);

  // Typed with spaces round it: sent trimmed, for this vault's session in its own generation.
  rename("My vault", "  Family  ");
  await boxGone();
  expect(sent("rename_vault")).toEqual([{ ...sessionOfVault(7), name: "Family" }]);
  expect(list[0]?.name).toBe("Family");
  expect(list[1]?.name).toBe("Home");

  // The side menu's head, the menu's row and its items, and the strip's button.
  const head = await screen.findByRole("button", { name: "Family, vault menu" });
  expect(within(side()).getByText("Family")).toBeTruthy();
  await waitFor(() => {
    expect(document.activeElement).toBe(head);
  });
  const again = await openVaultMenu();
  expect(rowsOf(again).map((row) => row.textContent)).toEqual(["FamilyUnlocked", "HomeUnlocked"]);
  expect(within(again).getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
    "New vault",
    "Add existing vault folder",
    "Lock Family",
    "Rename Family",
    "Show Family in Explorer",
    "Remove Family from this list",
  ]);
  fireEvent.keyDown(again, { key: "Escape" });
  await waitFor(() => {
    expect(screen.queryByRole("menu")).toBeNull();
  });
  const strip = screen.getByRole("navigation", { name: "Vaults" });
  expect(within(strip).getAllByRole("button").map((button) => button.getAttribute("aria-label"))).toEqual(["Family", "Home"]);
  expect(within(strip).getByRole("button", { name: "Family" }).getAttribute("aria-current")).toBe("true");
  // The list was read again from the shell, so every screen that reads it says the same.
  expect(debugState().vaults?.map((one) => one.name)).toEqual(["Family", "Home"]);
  expect(debugState().sessions.map((one) => `${String(one.vaultId)}:${one.name}`).sort()).toEqual(["7:Family", "8:Home"]);

  // The lock screen's list, after a lock, and its unlock step for the renamed vault.
  fireEvent.click(within(side()).getByRole("button", { name: "Lock all" }));
  await screen.findByRole("radio", { name: "Family" });
  expect(screen.getAllByRole("radio").map((radio) => radio.closest("label")?.textContent)).toEqual(["Family", "Home"]);
  expect(screen.queryByText("My vault")).toBeNull();
});

test("rename_names_the_right_vault_when_two_are_named_alike", async () => {
  const list = [vault(7, "Home"), vault(8, "Home")];
  await allOpen(list);
  // The second is on screen: it is the one renamed, and the first, which has the same name, is untouched.
  await openBox("Home");
  rename("Home", "Work");
  await boxGone();
  expect(sent("rename_vault")).toEqual([{ ...sessionOfVault(8), name: "Work" }]);
  expect(list.map((one) => one.name)).toEqual(["Home", "Work"]);
  expect(debugState().sessions.map((one) => `${String(one.vaultId)}:${one.name}`).sort()).toEqual(["7:Home", "8:Work"]);
  expect(debugState().vaults?.map((one) => one.name)).toEqual(["Home", "Work"]);
  // The strip says "2 of 2" only for names that are alike: now they are not.
  const strip = screen.getByRole("navigation", { name: "Vaults" });
  expect(within(strip).getAllByRole("button").map((button) => button.getAttribute("aria-label"))).toEqual(["Home", "Work"]);
});

test("the_box_opens_where_the_menu_was_and_is_not_a_centred_dialog", async () => {
  await allOpen([vault(7, "My vault"), vault(8, "Home")]);
  const menu = await openVaultMenu();
  const menuPositioner = menu.parentElement as HTMLElement;
  const place = (element: HTMLElement) => [element.getAttribute("data-side"), element.getAttribute("data-align")];
  expect(menuPositioner.classList.contains("layer")).toBe(true);
  expect(menu.className).toContain("mwide");
  fireEvent.keyDown(menu, { key: "Escape" });
  await waitFor(() => {
    expect(screen.queryByRole("menu")).toBeNull();
  });
  const box = await openBox("Home");
  // The same layer, class and anchoring as the vault menu's own box: below the vault head button, from its left edge, beside the vault strip (18a).
  const positioner = box.parentElement as HTMLElement;
  expect(positioner.classList.contains("layer")).toBe(true);
  expect(box.classList.contains("menu")).toBe(true);
  expect(box.classList.contains("mwide")).toBe(true);
  expect(place(positioner)).toEqual(place(menuPositioner));
  expect(place(positioner)).toEqual(["bottom", "start"]);
  // Not the app's centred dialog (a scrim and a titled card).
  expect(document.querySelector(".scrim")).toBeNull();
  expect(box.classList.contains("dlg")).toBe(false);
});

test("an_empty_name_is_said_under_the_box_and_nothing_is_sent", async () => {
  await allOpen([vault(7, "My vault"), vault(8, "Home")]);
  await openBox("Home");
  for (const typed of ["", "   "]) {
    fireEvent.change(nameBox("Home"), { target: { value: typed } });
    press("Rename");
    expect(await boxSays()).toBe(NAME_FIRST);
    const input = nameBox("Home");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    const described = input.getAttribute("aria-describedby") ?? "";
    expect(document.getElementById(described)?.textContent).toBe(NAME_FIRST);
    // The next change takes the words away.
    fireEvent.change(input, { target: { value: "x" } });
    expect(within(screen.getByRole("dialog", { name: "Rename vault" })).queryByRole("alert")).toBeNull();
    expect(input.getAttribute("aria-invalid")).toBeNull();
  }
  expect(sent("rename_vault")).toEqual([]);
});

test("the_name_it_has_already_closes_the_box_and_sends_nothing", async () => {
  await allOpen([vault(7, "My vault"), vault(8, "Home")]);
  await openBox("Home");
  rename("Home", "  Home ");
  await boxGone();
  expect(sent("rename_vault")).toEqual([]);
  const head = await screen.findByRole("button", { name: "Home, vault menu" });
  await waitFor(() => {
    expect(document.activeElement).toBe(head);
  });
});

test("enter_in_the_box_renames", async () => {
  const list = [vault(7, "My vault"), vault(8, "Home")];
  await allOpen(list);
  await openBox("Home");
  fireEvent.change(nameBox("Home"), { target: { value: "Cabin" } });
  fireEvent.submit(nameBox("Home").form as HTMLFormElement);
  await boxGone();
  expect(sent("rename_vault")).toEqual([{ ...sessionOfVault(8), name: "Cabin" }]);
  expect(list[1]?.name).toBe("Cabin");
});

test("cancel_and_escape_close_the_box_and_give_focus_back_to_the_vault_button", async () => {
  const list = [vault(7, "My vault"), vault(8, "Home")];
  await allOpen(list);
  for (const how of ["Cancel", "Escape"]) {
    await openBox("Home");
    fireEvent.change(nameBox("Home"), { target: { value: "Typed and dropped" } });
    if (how === "Cancel") press("Cancel");
    else fireEvent.keyDown(nameBox("Home"), { key: "Escape" });
    await boxGone();
    const head = await screen.findByRole("button", { name: "Home, vault menu" });
    await waitFor(() => {
      expect(document.activeElement, how).toBe(head);
    });
    // The menu is not reopened.
    expect(screen.queryByRole("menu")).toBeNull();
  }
  expect(sent("rename_vault")).toEqual([]);
  expect(list.map((one) => one.name)).toEqual(["My vault", "Home"]);
  // Opened again, it holds the current name, not what was typed and dropped.
  await openBox("Home");
  expect(nameBox("Home").value).toBe("Home");
});

test("a_second_press_while_the_rename_is_out_sends_nothing", async () => {
  const list = [vault(7, "My vault"), vault(8, "Home")];
  await allOpen(list);
  await openBox("Home");
  const release = shell.holdRename();
  fireEvent.change(nameBox("Home"), { target: { value: "Cabin" } });
  press("Rename");
  await waitFor(() => {
    expect(sent("rename_vault")).toHaveLength(1);
  });
  const button = within(screen.getByRole("dialog", { name: "Rename vault" })).getByRole("button", { name: "Rename" });
  expect(button.getAttribute("aria-disabled")).toBe("true");
  press("Rename");
  fireEvent.submit(nameBox("Home").form as HTMLFormElement);
  expect(sent("rename_vault")).toHaveLength(1);
  // The box stays until the answer.
  expect(screen.queryByRole("dialog", { name: "Rename vault" })).not.toBeNull();
  act(() => {
    release();
  });
  await boxGone();
  expect(sent("rename_vault")).toHaveLength(1);
  expect(list[1]?.name).toBe("Cabin");
});

// ---- Refusals, in words ----

test("rename_refused_shows_the_reason_in_words", async () => {
  const home = vault(8, "Home");
  const list = [vault(7, "My vault"), home];
  await allOpen(list);
  await openBox("Home");
  const lists = () => sent("list_vaults").length;

  const cases: { name: string; refuse?: object; typed?: string; header?: boolean; says: string }[] = [
    { name: "the name is too long", typed: "x".repeat(201), says: TOO_LONG },
    { name: "details changed", header: true, says: THEN_RENAME.changed },
    { name: "details unchecked", refuse: DETAILS_UNCHECKED, says: THEN_RENAME.unchecked },
    { name: "password copies disagree", refuse: PASSWORD_COPIES_DISAGREE, says: THEN_RENAME.password },
    { name: "recovery key copies disagree", refuse: RECOVERY_KEY_COPIES_DISAGREE, says: THEN_RENAME.recovery },
    { name: "busy", refuse: { code: "busy", what: "operation in progress" }, says: "That vault is busy. Wait for what it's doing to finish, then try again." },
    { name: "read-only", refuse: { code: "read_only" }, says: "This vault is read-only. It was opened from a backup, so nothing in it can change." },
    { name: "unknown session", refuse: { code: "not_found" }, says: "Petalock can't find that. It may have been moved or deleted." },
    { name: "malformed", refuse: { code: "invalid_input", what: "request" }, says: "Petalock can't use that. Check what you entered and try again." },
    {
      name: "the disk (with a path the page must not show)",
      refuse: { code: "core", kind: "io", message: "C:\\Users\\MU-secret\\Home\\vault.json" },
      says: "Petalock couldn't reach that folder or file. Check that the drive is connected, then try again.",
    },
    { name: "the header too big", refuse: { code: "core", kind: "too_large", what: "vault header" }, says: "That is too big for Petalock to keep." },
  ];
  for (const one of cases) {
    const typed = one.typed ?? "Cabin";
    const before = lists();
    home.headerChanged = one.header ?? false;
    if (one.refuse !== undefined) shell.refuseNext("rename_vault", one.refuse);
    rename("Home", typed);
    // Said in the box, in these words and no others (never the shell's own text), with the box marked and tied to the line.
    expect(await boxSays(), one.name).toBe(one.says);
    expect(document.body.textContent).not.toContain("MU-secret");
    const input = nameBox("Home");
    expect(input.value, `${one.name}: what was typed stays`).toBe(typed);
    expect(input.getAttribute("aria-invalid"), one.name).toBe("true");
    const alert = within(screen.getByRole("dialog", { name: "Rename vault" })).getByRole("alert");
    expect(alert.tagName).toBe("P");
    expect(alert.className).toBe("err");
    expect(input.getAttribute("aria-describedby"), one.name).toBe(alert.id);
    // Nothing changed on disk, and the list was read again to say what is really there.
    expect(home.name, one.name).toBe("Home");
    await waitFor(() => {
      expect(lists(), one.name).toBeGreaterThan(before);
    });
    expect(debugState().sessions.find((entry) => entry.vaultId === 8)?.name).toBe("Home");
    // The next change takes the words away.
    fireEvent.change(input, { target: { value: "Cabin, changed" } });
    expect(within(screen.getByRole("dialog", { name: "Rename vault" })).queryByRole("alert"), one.name).toBeNull();
    expect(input.getAttribute("aria-invalid"), one.name).toBeNull();
  }
  // After all that the box still renames when nothing refuses it.
  home.headerChanged = false;
  rename("Home", "Cabin");
  await boxGone();
  expect(home.name).toBe("Cabin");
  expect(sent("rename_vault")).toHaveLength(cases.length + 1);
});

// ---- Locks, switches and the vault's own box ----

test("a_lock_before_or_after_the_write_says_nothing_and_the_lock_screen_has_what_is_on_disk", async () => {
  for (const [how, kept] of [
    ["lock_before_write", "Home"],
    ["lock_after_write", "Cabin"],
    ["lock_after_write_as_error", "Cabin"],
  ] as const) {
    cleanup();
    resetStoreForTests();
    invoke.mockReset();
    listen.mockReset();
    const list = [vault(7, "My vault"), vault(8, "Home")];
    await allOpen(list);
    await openBox("Home");
    shell.interruptRenameNext(how);
    rename("Home", "Cabin");
    await boxGone();
    // The vault locked: the other stays open, and nothing was said.
    await screen.findByRole("button", { name: "My vault, vault menu" });
    expect(screen.queryByRole("alert"), how).toBeNull();
    expect(list[1]?.name, how).toBe(kept);
    // The menu's row for the locked vault says what the disk says.
    const menu = await openVaultMenu();
    await waitFor(() => {
      expect(rowsOf(menu).map((row) => row.textContent), how).toEqual(["My vaultUnlocked", `${kept}Locked`]);
    });
    expect(debugState().vaults?.map((one) => one.name), how).toEqual(["My vault", kept]);
  }
});

test("the_box_belongs_to_its_vault_an_answer_after_a_switch_lands_in_that_vault", async () => {
  const list = [vault(7, "My vault"), vault(8, "Home")];
  await allOpen(list);
  await openBox("Home");
  const release = shell.holdRename();
  rename("Home", "Cabin");
  await waitFor(() => {
    expect(sent("rename_vault")).toHaveLength(1);
  });
  // The window moves to the other vault while the answer is out: the box goes with its vault, and nothing typed is left.
  act(() => {
    showSession(sessionOfVault(7).session);
  });
  await screen.findByRole("button", { name: "My vault, vault menu", hidden: true });
  await waitFor(() => {
    expect(screen.queryByRole("dialog", { name: "Rename vault" })).toBeNull();
  });
  act(() => {
    release();
  });
  await waitFor(() => {
    expect(debugState().sessions.find((one) => one.vaultId === 8)?.name).toBe("Cabin");
  });
  // The vault on screen is untouched, and the answer is the other vault's.
  expect(debugState().sessions.find((one) => one.vaultId === 7)?.name).toBe("My vault");
  expect(screen.getByRole("button", { name: "My vault, vault menu" })).toBeTruthy();
  expect(list.map((one) => one.name)).toEqual(["My vault", "Cabin"]);
  expect(screen.queryByRole("dialog", { name: "Rename vault" })).toBeNull();
  expect(sent("rename_vault")).toHaveLength(1);
});

test("a_name_is_kept_for_the_list_when_the_list_cannot_be_read_again", async () => {
  const list = [vault(7, "My vault"), vault(8, "Home")];
  await allOpen(list);
  const home = debugState().sessions.find((one) => one.vaultId === 8);
  expect(home).toBeDefined();
  shell.refuseNext("list_vaults", { code: "core", kind: "io" });
  const done = await renameVault({ session: home?.session ?? 0, generation: home?.generation ?? 0 }, "Cabin");
  expect(done).toBe("done");
  // The list could not be read, so the page patched its own: the entry of that vault's ID, and no other.
  expect(debugState().vaults?.map((one) => [one.id, one.name])).toEqual([
    [7, "My vault"],
    [8, "Cabin"],
  ]);
  expect(debugState().sessions.find((one) => one.vaultId === 8)?.name).toBe("Cabin");
  await act(async () => {
    await refreshVaults();
  });
  expect(debugState().vaults?.map((one) => one.name)).toEqual(["My vault", "Cabin"]);
});

test("a_rename_for_a_vault_that_locked_is_stale_and_changes_nothing_on_the_page", async () => {
  const list = [vault(7, "My vault"), vault(8, "Home")];
  await allOpen(list);
  const home = sessionOfVault(8);
  // Locked from outside: the page hears it, and a rename in the old generation is answered `locked`.
  act(() => {
    shell.lock(home.session);
  });
  await waitFor(() => {
    expect(debugState().sessions.map((one) => one.vaultId)).toEqual([7]);
  });
  const done = await renameVault(home, "Cabin");
  expect(done).toBe("stale");
  expect(list[1]?.name).toBe("Home");
  expect(debugState().sessions.map((one) => one.vaultId)).toEqual([7]);
});

// ---- Who is offered Rename ----

test("rename_hidden_for_read_only_and_older_copies", async () => {
  shell = installFakeShell(invoke, listen, [vault(7, "My vault")]);
  shell.olderCopies([{ vault: 7, folder: OLDER, last_written: "2026-11-04", size: 1_000_000 } satisfies FakeOlderCopy]);
  render(<App />);
  const lock = await screen.findByLabelText(/^Password for /);
  fireEvent.change(lock, { target: { value: PASSWORD } });
  fireEvent.submit((lock as HTMLInputElement).form as HTMLFormElement);
  await screen.findByRole("heading", { level: 1, name: "All items", hidden: true });
  // A writable listed vault offers Rename (and Show in Explorer and Remove from list).
  let menu = await openVaultMenu();
  expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
    "New vault",
    "Add existing vault folder",
    "Lock My vault",
    "Rename My vault",
    "Show My vault in Explorer",
    "Remove My vault from this list",
  ]);
  fireEvent.keyDown(menu, { key: "Escape" });
  await waitFor(() => {
    expect(screen.queryByRole("menu")).toBeNull();
  });
  // The older copy, opened from Settings, and then a backup from its window.
  fireEvent.click(within(side()).getByRole("button", { name: "Settings" }));
  const settings = await screen.findByRole("complementary", { name: "Settings" });
  fireEvent.click(within(settings).getByRole("button", { name: "Older copies (1)" }));
  const copies = await screen.findByRole("complementary", { name: "Older copies" });
  fireEvent.click(within(copies).getByRole("button", { name: "Open read-only" }));
  fireEvent.change(within(copies).getByLabelText("Password or recovery key for this copy"), { target: { value: PASSWORD } });
  fireEvent.click(within(copies).getByRole("button", { name: "Open" }));
  await screen.findByRole("button", { name: "My vault, older copy, read-only, vault menu" });
  menu = await openVaultMenu();
  expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
    "New vault",
    "Add existing vault folder",
    "Lock My vault, older copy",
  ]);
  fireEvent.keyDown(menu, { key: "Escape" });
  await waitFor(() => {
    expect(screen.queryByRole("menu")).toBeNull();
  });
  // A backup (Open a backup from the older copy's Settings).
  fireEvent.click(within(side()).getByRole("button", { name: "Settings" }));
  const again = await screen.findByRole("complementary", { name: "Settings" });
  fireEvent.click(within(again).getByRole("button", { name: "Open a backup" }));
  const open = await screen.findByRole("complementary", { name: "Open a backup" });
  fireEvent.change(within(open).getByLabelText("Password or recovery key from when it was made"), { target: { value: BACKUP_PASSWORD } });
  fireEvent.click(within(open).getByRole("button", { name: "Open read-only" }));
  await screen.findByRole("button", { name: `${BACKUP}, read-only, vault menu` });
  menu = await openVaultMenu();
  expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
    "New vault",
    "Add existing vault folder",
    `Lock ${BACKUP}`,
  ]);
  expect(sent("rename_vault")).toEqual([]);
});

test("rename_is_not_offered_on_a_listed_vault_opened_read_only", async () => {
  await unlocked([vault(7, "Away", { readOnly: true }), vault(8, "Home")]);
  const menu = await openVaultMenu();
  expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
    "New vault",
    "Add existing vault folder",
    "Lock Away",
  ]);
});

// ---- Axe ----

test("rename_screens_have_no_axe_violations", async () => {
  const { container } = await allOpen([vault(7, "My vault"), vault(8, "Home")]);
  const menu = await openVaultMenu();
  await expectNoAxe(menu);
  fireEvent.keyDown(menu, { key: "Escape" });
  await waitFor(() => {
    expect(screen.queryByRole("menu")).toBeNull();
  });
  // The box, as it opens, and with a refusal in it. No <style> element made for it, and no inline style in what it draws (the library places the box with the style property
  // of the DOM, which the page's policy allows; the box's own parts carry none).
  const box = await openBox("Home");
  expect(document.querySelectorAll("style")).toHaveLength(0);
  expect(box.querySelectorAll("[style]")).toHaveLength(0);
  await expectNoAxe(box);
  await expectNoAxe({ include: [document.body], exclude: [box] });
  fireEvent.change(nameBox("Home"), { target: { value: "" } });
  press("Rename");
  await boxSays();
  await expectNoAxe(box);
  fireEvent.change(nameBox("Home"), { target: { value: "x".repeat(201) } });
  press("Rename");
  expect(await boxSays()).toBe(TOO_LONG);
  await expectNoAxe(box);
  expect(box.querySelectorAll("[style]")).toHaveLength(0);
  expect(container.querySelectorAll("style")).toHaveLength(0);
});

// ---- Plan 4C Task 13b: a refusal that says what to do first offers it, as Ask 2 does ----

test("a_rename_refused_for_one_of_the_backup_reasons_offers_the_way_forward", async () => {
  const cases: { name: string; refuse?: object; header?: boolean; button: string; opens: () => Promise<unknown> }[] = [
    {
      name: "recovery key copies disagree",
      refuse: RECOVERY_KEY_COPIES_DISAGREE,
      button: "New recovery key",
      opens: () => screen.findByRole("complementary", { name: "New recovery key" }),
    },
    {
      name: "password copies disagree",
      refuse: PASSWORD_COPIES_DISAGREE,
      button: "Change password",
      opens: () => screen.findByRole("complementary", { name: "Change password" }),
    },
    {
      name: "details changed",
      header: true,
      button: "See the change",
      opens: () => screen.findByRole("dialog", { name: "Home's details were changed outside Petalock." }),
    },
  ];
  for (const one of cases) {
    cleanup();
    resetStoreForTests();
    invoke.mockReset();
    listen.mockReset();
    const home = vault(8, "Home");
    await allOpen([vault(7, "My vault"), home]);
    await openBox("Home");
    home.headerChanged = one.header ?? false;
    if (one.refuse !== undefined) shell.refuseNext("rename_vault", one.refuse);
    rename("Home", "Cabin");
    await boxSays();
    // The box offers what its words ask for (Ask 2's button for the same reason), beside Cancel; Rename waits for a new name.
    const box = screen.getByRole("dialog", { name: "Rename vault" });
    expect(within(box).getAllByRole("button").map((button) => button.textContent), one.name).toEqual(["Cancel", one.button]);
    // A new name takes the offer away and gives Rename back.
    fireEvent.change(nameBox("Home"), { target: { value: "Cabin, again" } });
    expect(within(box).getAllByRole("button").map((button) => button.textContent), one.name).toEqual(["Cancel", "Rename"]);
    if (one.refuse !== undefined) shell.refuseNext("rename_vault", one.refuse);
    press("Rename");
    await boxSays();
    // The offer closes the box and opens that form or question for this vault, the one on screen; nothing was renamed.
    press(one.button);
    await boxGone();
    await one.opens();
    expect(home.name, one.name).toBe("Home");
    // Still Home's window under it (behind a dialog, the page is hidden from a screen reader).
    expect(screen.getByRole("button", { name: "Home, vault menu", hidden: true })).toBeTruthy();
  }

  // Details that couldn't be checked: Lock this vault, as Ask 2 offers.
  cleanup();
  resetStoreForTests();
  invoke.mockReset();
  listen.mockReset();
  await allOpen([vault(7, "My vault"), vault(8, "Home")]);
  await openBox("Home");
  shell.refuseNext("rename_vault", DETAILS_UNCHECKED);
  rename("Home", "Cabin");
  await boxSays();
  press("Lock this vault");
  await boxGone();
  await waitFor(() => {
    expect(shell.sessionOf(8)?.unlocked ?? false).toBe(false);
  });
  expect(shell.sessionOf(7)?.unlocked).toBe(true);

  // Any other refusal offers nothing more: Cancel and Rename, to try again.
  cleanup();
  resetStoreForTests();
  invoke.mockReset();
  listen.mockReset();
  await allOpen([vault(7, "My vault"), vault(8, "Home")]);
  await openBox("Home");
  shell.refuseNext("rename_vault", { code: "busy", what: "operation in progress" });
  rename("Home", "Cabin");
  await boxSays();
  expect(within(screen.getByRole("dialog", { name: "Rename vault" })).getAllByRole("button").map((button) => button.textContent)).toEqual(["Cancel", "Rename"]);
});
