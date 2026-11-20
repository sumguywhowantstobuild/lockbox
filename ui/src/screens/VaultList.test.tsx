// Plan 4C Task 9's screens: Remove from list and Show in Explorer on the vault menu (18a, 18g), the unavailable vault's row and box (Try again, Remove), Add existing vault
// folder and the unavailable rows on the lock screen (30a, 30b), and Show and Remove on a locked vault's unlock step and on Ask 8. Every case runs through the real App
// against the pretend shell, as a person reaches it. The words are the design's (18g, 30a, 30b) and the session's (the rest, for Ariel to change), so each test holds them
// as literals: a refusal shown as raw text, or as other words, fails. A made-up value carries `MU-`.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import App from "../App";
import { debugState, refreshVaults, removeVault, resetStoreForTests, sayOnLockScreen, tryVaultAgain } from "../store";
import { expectNoAxe } from "../testing/axe";
import { installFakeShell, PASSWORD, sampleItems, type FakeOlderCopy, type FakeShell, type FakeVault } from "../testing/fakeShell";
import { readBeside } from "../testing/files";

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

const OLDER = "My vault.before-restore";
const LABEL = "Password or recovery key from when it was made";
const BUSY = { code: "busy", what: "operation in progress" };
const BUSY_WORDS = "That vault is busy. Wait for what it's doing to finish, then try again.";
const IO_WORDS = "Lockbox couldn't reach that folder or file. Check that the drive is connected, then try again.";
const NOT_A_FOLDER = "Lockbox won't open that in Explorer. That vault's place on the list isn't a plain folder.";
const STILL = "Still unavailable. Connect its drive or put its folder back, then try again.";
const UNAVAILABLE_LINE = "Unavailable: its folder or drive isn't there";
const NOT_A_VAULT = "That folder isn't a Lockbox vault. Choose the vault's own folder.";
const REMOVABLE = "That folder is on a removable drive. Copy it to this PC first, then choose the copy.";
const SENTINEL = "MU-SENTINEL-C:\\Users\\secret";

function removeWords(name: string): string {
  return `Remove ${name} from this list? Its folder and everything in it stay on your PC. You can bring it back with Add existing vault folder.`;
}
function removeWordsLast(name: string): string {
  return `Remove ${name} from this list? Its folder and everything in it stay on your PC. You can bring it back with "I already have a vault or a backup" on the first screen.`;
}

function vault(id: number, name: string | null, extra: Partial<FakeVault> = {}): FakeVault {
  return { id, name, items: sampleItems(), ...extra };
}

function sent(cmd: string): Record<string, unknown>[] {
  return invoke.mock.calls.filter(([name]) => name === cmd).map(([, args]) => args as Record<string, unknown>);
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
  // What the screen before it left to do a turn later (focus going back to the button that opened a box) is done first: it would take focus from the menu.
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

function actionsOf(menu: HTMLElement): string[] {
  return within(menu)
    .getAllByRole("menuitem")
    .map((item) => item.textContent);
}

async function unlockFromMenu(name: string): Promise<void> {
  const menu = await openVaultMenu();
  const row = rowsOf(menu).find((one) => one.textContent === `${name}Locked`);
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

/** An action of the vault menu, chosen as a click does; the menu closes. */
async function chooseAction(name: string): Promise<void> {
  const menu = await openVaultMenu();
  fireEvent.click(within(menu).getByRole("menuitem", { name }));
  await waitFor(() => {
    expect(screen.queryByRole("menu")).toBeNull();
  });
}

/** 18g, the box that asks before a vault leaves the list. */
function removeBox(): HTMLElement {
  return screen.getByRole("alertdialog", { name: "Remove vault from this list" });
}

async function findRemoveBox(): Promise<HTMLElement> {
  return screen.findByRole("alertdialog", { name: "Remove vault from this list" });
}

async function boxGone(): Promise<void> {
  await waitFor(() => {
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
}

function pressIn(box: HTMLElement, name: string): void {
  fireEvent.click(within(box).getByRole("button", { name }));
}

async function focusIs(element: HTMLElement | null, why: string): Promise<void> {
  await waitFor(() => {
    expect(document.activeElement, why).toBe(element);
  });
}

// ---- Remove from list (18a, 18g) ----

test("remove_says_the_folder_stays_and_can_be_added_back", async () => {
  await allOpen([vault(7, "My vault"), vault(8, "Home")]);
  const list = shell.listIdentity();

  // 18a's order: Show and Remove right after Rename, named for the vault on screen, and no line before them (the line that set Delete apart waits for v1.1).
  const menu = await openVaultMenu();
  expect(actionsOf(menu)).toEqual([
    "New vault",
    "Add existing vault folder",
    "Lock Home",
    "Rename Home",
    "Show Home in Explorer",
    "Remove Home from this list",
  ]);
  expect(within(menu).getAllByRole("separator")).toHaveLength(1);
  expect(within(menu).getAllByRole("menuitem")[2]?.previousElementSibling?.getAttribute("role")).toBe("separator");
  fireEvent.click(within(menu).getByRole("menuitem", { name: "Remove Home from this list" }));
  await waitFor(() => {
    expect(screen.queryByRole("menu")).toBeNull();
  });

  // 18g, in the menu's place: the design's words, Cancel and Remove, focus on the choice that changes nothing, and nothing sent yet.
  const box = await findRemoveBox();
  expect(box.className).toContain("mwide");
  expect(box.querySelector("p")?.textContent).toBe(removeWords("Home"));
  expect(within(box).getAllByRole("button").map((button) => button.textContent)).toEqual(["Cancel", "Remove"]);
  await focusIs(within(box).getByRole("button", { name: "Cancel" }), "focus starts on Cancel");
  expect(sent("forget_vault")).toEqual([]);

  // Cancel and Escape close it, give focus back to the vault button, and send nothing.
  for (const how of ["Cancel", "Escape"]) {
    if (how === "Cancel") pressIn(removeBox(), "Cancel");
    else fireEvent.keyDown(removeBox(), { key: "Escape" });
    await boxGone();
    const head = await screen.findByRole("button", { name: "Home, vault menu" });
    await focusIs(head, how);
    expect(sent("forget_vault")).toEqual([]);
    await chooseAction("Remove Home from this list");
    await findRemoveBox();
  }

  // Remove sends the row as the shell gave it, locks Home, and leaves My vault open and on screen.
  pressIn(removeBox(), "Remove");
  await boxGone();
  expect(sent("forget_vault")).toEqual([{ vault: { list, id: 8 } }]);
  await screen.findByRole("button", { name: "My vault, vault menu" });
  expect(debugState().sessions.map((one) => one.vaultId)).toEqual([7]);
  expect(debugState().vaults?.map((one) => one.id)).toEqual([7]);
  expect(shell.sessionOf(8)?.unlocked ?? false).toBe(false);
  expect(sent("lock_all")).toEqual([]);

  // Its folder stayed, so it can be added back from the menu: it is a new row, never the old row's ID.
  shell.offerExisting(vault(8, "Home"));
  await chooseAction("Add existing vault folder");
  await screen.findByRole("heading", { level: 1, name: "Unlock Home" });
  expect(debugState().vaults?.map((one) => one.id)).toEqual([7, 9]);
  expect(debugState().unlockStep).toMatchObject({ vault: 9 });
});

test("remove_names_the_vault_on_screen_when_two_are_named_alike", async () => {
  await allOpen([vault(7, "Home"), vault(8, "Home")]);
  const list = shell.listIdentity();
  await chooseAction("Remove Home from this list");
  await findRemoveBox();
  pressIn(removeBox(), "Remove");
  await boxGone();
  // The second Home was on screen: its row went, the first stayed.
  expect(sent("forget_vault")).toEqual([{ vault: { list, id: 8 } }]);
  expect(debugState().vaults?.map((one) => one.id)).toEqual([7]);
  expect(debugState().sessions.map((one) => one.vaultId)).toEqual([7]);
});

test("remove_refused_says_so_in_words_and_the_box_stays", async () => {
  await allOpen([vault(7, "My vault"), vault(8, "Home")]);
  await chooseAction("Remove Home from this list");
  await findRemoveBox();
  // A refusal as the shell sends it, with text no screen may show.
  shell.refuseNext("forget_vault", { code: "core", kind: "io", what: SENTINEL });
  pressIn(removeBox(), "Remove");
  const said = await within(removeBox()).findByRole("alert");
  expect(said.textContent).toBe(IO_WORDS);
  expect(document.body.textContent).not.toContain("SENTINEL");
  expect(document.body.textContent).not.toContain("secret");
  // Still there, still open, still listed.
  expect(removeBox()).toBeTruthy();
  expect(debugState().sessions.map((one) => one.vaultId)).toEqual([7, 8]);
  expect(debugState().vaults?.map((one) => one.id)).toEqual([7, 8]);

  // Busy has its own words, and the list was read again after each refusal.
  const before = sent("list_vaults").length;
  shell.refuseNext("forget_vault", BUSY);
  pressIn(removeBox(), "Remove");
  await waitFor(() => {
    expect(within(removeBox()).getByRole("alert").textContent).toBe(BUSY_WORDS);
  });
  expect(sent("list_vaults").length).toBeGreaterThan(before);
});

test("remove_sends_one_command_while_the_answer_is_out", async () => {
  // A vault that is not open (an open one's window goes with its lock the moment the command lands), so its box is still there while the answer is out.
  await unlocked([vault(7, "My vault"), vault(8, "Home", { available: false })]);
  const menu = await openVaultMenu();
  fireEvent.click(rowsOf(menu)[1] as HTMLElement);
  pressIn(await screen.findByRole("dialog", { name: "Home is unavailable" }), "Remove from list");
  await findRemoveBox();
  const release = shell.holdForget();
  const remove = within(removeBox()).getByRole("button", { name: "Remove" });
  fireEvent.click(remove);
  await waitFor(() => {
    expect(remove.getAttribute("aria-disabled")).toBe("true");
  });
  fireEvent.click(remove);
  fireEvent.click(remove);
  expect(sent("forget_vault")).toHaveLength(1);
  await act(async () => {
    release();
    await Promise.resolve();
  });
  await boxGone();
  expect(sent("forget_vault")).toHaveLength(1);
});

test("remove_of_the_only_vault_points_at_the_first_screen_and_leaves_it", async () => {
  await unlocked([vault(7, "My vault")]);
  await chooseAction("Remove My vault from this list");
  const box = await findRemoveBox();
  expect(box.querySelector("p")?.textContent).toBe(removeWordsLast("My vault"));
  pressIn(box, "Remove");
  // No vault is listed and none is open: 21a, which has the way back.
  await screen.findByRole("heading", { level: 1, name: "Welcome to Lockbox" });
  expect(screen.getByRole("button", { name: "I already have a vault or a backup" })).toBeTruthy();
  expect(debugState().sessions).toEqual([]);
});

test("remove_of_one_of_two_keeps_the_words_that_name_the_menu", async () => {
  // Another vault stays open, so the first screen is not where the person ends up: 18g's own words.
  await allOpen([vault(7, "My vault"), vault(8, "Home", { available: true })]);
  await chooseAction("Remove Home from this list");
  expect((await findRemoveBox()).querySelector("p")?.textContent).toBe(removeWords("Home"));
});

test("remove_lets_go_of_what_the_page_held_for_that_vault_only", async () => {
  await unlocked([vault(7, "My vault"), vault(8, "Home"), vault(9, "Away")]);
  const list = shell.listIdentity();
  // Home's unlock step is up, and the lock screen has words saved for Home and for Away.
  const menu = await openVaultMenu();
  fireEvent.click(rowsOf(menu)[1] as HTMLElement);
  await screen.findByRole("heading", { level: 1, name: "Unlock Home" });
  act(() => {
    sayOnLockScreen({ code: "locked_after_change", what: "password", vault: 8 }, 8);
    sayOnLockScreen({ code: "locked_after_change", what: "password", vault: 9 }, 9);
  });
  expect(debugState().lockNotes.map((note) => note.vault)).toEqual([8, 9]);
  let outcome: unknown;
  await act(async () => {
    outcome = await removeVault({ list, id: 8 });
  });
  expect(outcome).toBe("done");
  // The step for Home went with it, and the window that was on screen is back; Away's words stay for Away's own unlock.
  expect(debugState().unlockStep).toBeNull();
  await screen.findByRole("button", { name: "My vault, vault menu" });
  expect(debugState().lockNotes.map((note) => note.vault)).toEqual([9]);
  expect(debugState().vaults?.map((one) => one.id)).toEqual([7, 9]);
  // A row the list no longer has: refused, said by the shell, and the list read again.
  const reads = sent("list_vaults").length;
  await act(async () => {
    outcome = await removeVault({ list, id: 8 });
  });
  expect(outcome).toEqual({ failed: { code: "not_found" } });
  expect(sent("list_vaults").length).toBe(reads + 1);
  // A row from another list is refused the same way, and nothing changes.
  await act(async () => {
    outcome = await removeVault({ list: list + 1, id: 9 });
  });
  expect(outcome).toEqual({ failed: { code: "not_found" } });
  expect(debugState().vaults?.map((one) => one.id)).toEqual([7, 9]);
});

test("remove_that_locked_the_vault_but_failed_to_write_leaves_it_locked_and_listed", async () => {
  await allOpen([vault(7, "My vault"), vault(8, "Home")]);
  shell.forgetFailsAfterLockNext({ code: "core", kind: "io", what: SENTINEL });
  await chooseAction("Remove Home from this list");
  pressIn(await findRemoveBox(), "Remove");
  // The vault locked (its window, and the box with it, is gone), the list still has it, and the person is told in words on the window that is left.
  await screen.findByRole("button", { name: "My vault, vault menu" });
  expect((await screen.findByRole("alert")).textContent).toContain(IO_WORDS);
  expect(document.body.textContent).not.toContain("SENTINEL");
  expect(debugState().sessions.map((one) => one.vaultId)).toEqual([7]);
  expect(debugState().vaults?.map((one) => one.id)).toEqual([7, 8]);
  // It is a locked vault of the list, as any other: its row opens its unlock step.
  const menu = await openVaultMenu();
  expect(rowsOf(menu).map((row) => row.textContent)).toEqual(["My vault", "HomeLocked"]);
});

// ---- Show in Explorer (18a) ----

test("show_in_explorer_on_the_vault_menu_rows", async () => {
  await allOpen([vault(7, "Home"), vault(8, "Home")]);
  const list = shell.listIdentity();
  // The second Home is on screen: the command names its row, and the right folder is the one shown.
  await chooseAction("Show Home in Explorer");
  await waitFor(() => {
    expect(sent("show_vault_in_explorer")).toEqual([{ vault: { list, id: 8 } }]);
  });
  expect(shell.openedVaults).toEqual([8]);
  // Nothing is drawn on success, and the window is as it was.
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(screen.getByRole("button", { name: "Home, vault menu" })).toBeTruthy();

  // The first Home, brought to the front, opens its own folder.
  const menu = await openVaultMenu();
  fireEvent.click(rowsOf(menu)[0] as HTMLElement);
  await waitFor(() => {
    expect(debugState().sessions.at(-1)?.vaultId).toBe(7);
  });
  await chooseAction("Show Home in Explorer");
  await waitFor(() => {
    expect(shell.openedVaults).toEqual([8, 7]);
  });
});

test("show_in_explorer_refusals_are_said_in_words", async () => {
  await allOpen([vault(7, "My vault"), vault(8, "Home")]);
  // Explorer could not start: the shell's `core` `io`.
  shell.explorerFailsNext();
  await chooseAction("Show Home in Explorer");
  expect((await screen.findByRole("alert")).textContent).toContain(IO_WORDS);
  // A list entry that is not a plain folder.
  shell.refuseNext("show_vault_in_explorer", { code: "invalid_input", what: "folder" });
  await chooseAction("Show Home in Explorer");
  await waitFor(() => {
    expect(screen.getByRole("alert").textContent).toContain(NOT_A_FOLDER);
  });
  // A folder that is gone: the list is read again, and the row reads Not available.
  shell.setAvailable(8, false);
  const reads = sent("list_vaults").length;
  await chooseAction("Show Home in Explorer");
  await waitFor(() => {
    expect(debugState().vaults?.find((one) => one.id === 8)?.available).toBe(false);
  });
  expect(sent("list_vaults").length).toBeGreaterThan(reads);
  expect(shell.openedVaults).toEqual([]);
  expect(document.body.textContent).not.toContain("not_found");
});

test("show_and_remove_come_on_the_unlock_step_of_a_locked_row_not_in_the_menu", async () => {
  await unlocked([vault(7, "My vault"), vault(8, "Home")]);
  const menu = await openVaultMenu();
  // Only the vault on screen has them in the menu; a locked row opens its unlock step.
  expect(actionsOf(menu)).toEqual(["New vault", "Add existing vault folder", "Lock My vault", "Rename My vault", "Show My vault in Explorer", "Remove My vault from this list"]);
  expect(rowsOf(menu).map((row) => row.textContent)).toEqual(["My vault", "HomeLocked"]);
});

// ---- The unavailable vault in the vault menu ----

test("the_vault_menus_unavailable_row_offers_try_again_and_remove", async () => {
  await unlocked([vault(7, "My vault"), vault(8, "Home", { available: false })]);
  const menu = await openVaultMenu();
  const row = rowsOf(menu)[1] as HTMLElement;
  expect(row.textContent).toBe("HomeNot available");
  // It can be chosen now: no longer disabled, its line stays "Not available".
  expect(row.getAttribute("aria-disabled")).toBeNull();
  fireEvent.click(row);
  await waitFor(() => {
    expect(screen.queryByRole("menu")).toBeNull();
  });

  // The box, in the menu's place: its sentence, then Cancel, Remove from list and Try again, with focus on Try again.
  const box = await screen.findByRole("dialog", { name: "Home is unavailable" });
  expect(box.className).toContain("mwide");
  expect(box.querySelector("p")?.textContent).toBe("Home is unavailable: its folder or drive isn't there.");
  expect(within(box).getAllByRole("button").map((button) => button.textContent)).toEqual(["Cancel", "Remove from list", "Try again"]);
  await focusIs(within(box).getByRole("button", { name: "Try again" }), "focus starts on Try again");
  expect(sent("forget_vault")).toEqual([]);

  // Try again reads the list again; still unavailable says so under the sentence, in a status line, and the box stays.
  const reads = sent("list_vaults").length;
  pressIn(box, "Try again");
  await waitFor(() => {
    expect(within(box).getByRole("status").textContent).toBe(STILL);
  });
  expect(sent("list_vaults").length).toBe(reads + 1);
  expect(screen.getByRole("dialog", { name: "Home is unavailable" })).toBeTruthy();

  // Once the folder is back, Try again closes the box and opens Home's unlock step.
  shell.setAvailable(8, true);
  pressIn(box, "Try again");
  await screen.findByRole("heading", { level: 1, name: "Unlock Home" });
  expect(screen.queryByRole("dialog", { name: "Home is unavailable" })).toBeNull();
  expect(debugState().unlockStep).toMatchObject({ vault: 8 });
});

test("the_unavailable_box_removes_through_18g_in_the_same_place", async () => {
  await unlocked([vault(7, "My vault"), vault(8, "Home", { available: false })]);
  const list = shell.listIdentity();
  const menu = await openVaultMenu();
  fireEvent.click(rowsOf(menu)[1] as HTMLElement);
  const box = await screen.findByRole("dialog", { name: "Home is unavailable" });
  pressIn(box, "Remove from list");
  // 18g replaces it, for that vault (not the one on screen).
  const ask = await findRemoveBox();
  expect(screen.queryByRole("dialog", { name: "Home is unavailable" })).toBeNull();
  expect(ask.querySelector("p")?.textContent).toBe(removeWords("Home"));
  expect(sent("forget_vault")).toEqual([]);
  pressIn(ask, "Cancel");
  await boxGone();
  await focusIs(screen.getByRole("button", { name: "My vault, vault menu" }), "Cancel gives focus back to the vault button");

  const again = await openVaultMenu();
  fireEvent.click(rowsOf(again)[1] as HTMLElement);
  pressIn(await screen.findByRole("dialog", { name: "Home is unavailable" }), "Remove from list");
  pressIn(await findRemoveBox(), "Remove");
  await boxGone();
  expect(sent("forget_vault")).toEqual([{ vault: { list, id: 8 } }]);
  expect(debugState().vaults?.map((one) => one.id)).toEqual([7]);
  // The vault on screen was not touched, and focus is on the vault button.
  expect(debugState().sessions.map((one) => one.vaultId)).toEqual([7]);
  await focusIs(screen.getByRole("button", { name: "My vault, vault menu" }), "focus goes to the vault button");
});

test("a_row_that_leaves_the_list_under_the_unavailable_box_closes_it_and_gives_focus_to_the_vault_button", async () => {
  const list = [vault(7, "My vault"), vault(8, "Home", { available: false })];
  await unlocked(list);
  const menu = await openVaultMenu();
  fireEvent.click(rowsOf(menu)[1] as HTMLElement);
  const box = await screen.findByRole("dialog", { name: "Home is unavailable" });
  // The list loses Home (removed elsewhere) after the box opened: Try again reads that, and the box can't go on.
  list.splice(1, 1);
  pressIn(box, "Try again");
  await boxGone();
  // Nothing of the box is left behind, and focus is back on the vault button, not lost.
  const head = screen.getByRole("button", { name: "My vault, vault menu" });
  await focusIs(head, "focus goes to the vault button");
  expect(debugState().vaults?.map((one) => one.id)).toEqual([7]);
  // No box state is left behind: when a row with that ID is listed again, the box does not come back by itself.
  list.push(vault(8, "Home", { available: false }));
  await act(async () => {
    await refreshVaults();
  });
  expect(debugState().vaults?.map((one) => one.id)).toEqual([7, 8]);
  expect(screen.queryByRole("dialog")).toBeNull();
  const again = await openVaultMenu();
  expect(rowsOf(again).map((row) => row.textContent)).toEqual(["My vault", "HomeNot available"]);
});

test("the_unavailable_box_says_a_refused_read_and_a_row_that_has_gone", async () => {
  await unlocked([vault(7, "My vault"), vault(8, "Home", { available: false })]);
  const menu = await openVaultMenu();
  fireEvent.click(rowsOf(menu)[1] as HTMLElement);
  const box = await screen.findByRole("dialog", { name: "Home is unavailable" });
  // The list can't be read: the words, never the shell's text.
  shell.refuseNext("list_vaults", { code: "core", kind: "io", what: SENTINEL });
  pressIn(box, "Try again");
  await waitFor(() => {
    expect(within(box).getByRole("alert").textContent).toBe(IO_WORDS);
  });
  expect(document.body.textContent).not.toContain("SENTINEL");
  // A row the list no longer has: nothing to try; the box closes.
  shell.setAvailable(8, true);
  expect(await tryVaultAgain(99)).toBe("gone");
  expect(await tryVaultAgain(8)).toBe("back");
  expect(await tryVaultAgain(8)).toBe("back");
  shell.setAvailable(8, false);
  expect(await tryVaultAgain(8)).toBe("still");
});

test("a_drive_that_goes_while_a_vault_is_open_reads_unavailable_at_once", async () => {
  await allOpen([vault(7, "My vault"), vault(8, "Home")]);
  const reads = sent("list_vaults").length;
  act(() => {
    shell.driveGone(8);
  });
  await waitFor(() => {
    expect(debugState().vaults?.find((one) => one.id === 8)?.available).toBe(false);
  });
  expect(sent("list_vaults").length).toBeGreaterThan(reads);
  // Home locked alone; My vault was on screen behind it and stays open.
  expect(debugState().sessions.map((one) => one.vaultId)).toEqual([7]);
  const menu = await openVaultMenu();
  expect(rowsOf(menu).map((row) => row.textContent)).toEqual(["My vault", "HomeNot available"]);
});

// ---- The lock screen (30a, 30b) ----

async function lockScreen(list: FakeVault[]) {
  shell = installFakeShell(invoke, listen, list);
  const view = render(<App />);
  await screen.findByRole("heading", { level: 1, name: /^Unlock/ });
  return view;
}

function rowOf(name: string): HTMLElement {
  return screen.getByRole("group", { name });
}

test("an_unavailable_vault_shows_try_again_and_remove", async () => {
  const { container } = await lockScreen([vault(7, "My vault"), vault(8, "Home", { available: false })]);
  expect(screen.getByRole("heading", { level: 1, name: "Unlock a vault" })).toBeTruthy();
  // The vault that can be opened is a radio, chosen; the other is not a radio at all: its row says why and has the two buttons.
  expect(screen.getAllByRole("radio")).toHaveLength(1);
  expect(screen.getByRole<HTMLInputElement>("radio", { name: /My vault/ }).checked).toBe(true);
  const row = rowOf("Home");
  expect(row.className).toContain("vbtn");
  expect(row.className).toContain("off");
  expect(within(row).getByText("Home").tagName).toBe("B");
  expect(within(row).getByText(UNAVAILABLE_LINE)).toBeTruthy();
  expect(within(row).getAllByRole("button").map((button) => button.textContent)).toEqual(["Try again", "Remove from list"]);
  expect(within(row).getAllByRole("button").every((button) => button.className === "lnk")).toBe(true);
  // "Not available" is the menu's word; this screen has 30b's.
  expect(screen.queryByText("Not available")).toBeNull();
  // No red line: the row says it.
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByLabelText("Password for My vault")).toBeTruthy();
  await expectNoAxe(container);
});

test("an_unavailable_vault_shows_try_again_and_remove_also_when_it_is_the_only_vault", async () => {
  const { container } = await lockScreen([vault(8, "Home", { available: false })]);
  expect(screen.getByRole("heading", { level: 1, name: "Unlock a vault" })).toBeTruthy();
  const row = rowOf("Home");
  expect(within(row).getByText(UNAVAILABLE_LINE)).toBeTruthy();
  expect(within(row).getAllByRole("button").map((button) => button.textContent)).toEqual(["Try again", "Remove from list"]);
  // No password form while no vault can be chosen, and no red sentence in its place.
  expect(screen.queryByLabelText(/^Password for /)).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  await expectNoAxe(container);

  // Remove from list: 18g, with the first screen's words since nothing else is left, anchored to that button.
  const remove = within(row).getByRole("button", { name: "Remove from list" });
  fireEvent.click(remove);
  const box = await findRemoveBox();
  expect(box.querySelector("p")?.textContent).toBe(removeWordsLast("Home"));
  expect(sent("forget_vault")).toEqual([]);
  // Cancel and Escape give focus back to that Remove from list button.
  pressIn(box, "Cancel");
  await boxGone();
  await focusIs(remove, "Cancel gives focus back to the row's Remove from list");
  fireEvent.click(remove);
  await findRemoveBox();
  fireEvent.keyDown(removeBox(), { key: "Escape" });
  await boxGone();
  await focusIs(remove, "Escape gives focus back to the row's Remove from list");

  fireEvent.click(remove);
  pressIn(await findRemoveBox(), "Remove");
  await screen.findByRole("heading", { level: 1, name: "Welcome to Lockbox" });
  expect(sent("forget_vault")).toEqual([{ vault: { list: shell.listIdentity(), id: 8 } }]);
});

test("remove_from_the_lock_screen_names_the_row_and_puts_focus_on_the_chosen_vault", async () => {
  await lockScreen([vault(7, "Home"), vault(8, "Home", { available: false }), vault(9, "Home", { available: false })]);
  const list = shell.listIdentity();
  const rows = screen.getAllByRole("group", { name: "Home" });
  expect(rows).toHaveLength(2);
  // The second unavailable one: its own button, its own row.
  fireEvent.click(within(rows[1] as HTMLElement).getByRole("button", { name: "Remove from list" }));
  const box = await findRemoveBox();
  expect(box.querySelector("p")?.textContent).toBe(removeWords("Home"));
  pressIn(box, "Remove");
  await boxGone();
  expect(sent("forget_vault")).toEqual([{ vault: { list, id: 9 } }]);
  expect(debugState().vaults?.map((one) => one.id)).toEqual([7, 8]);
  // Focus goes to the chosen vault's password box.
  await focusIs(screen.getByLabelText("Password for Home"), "the password box");
});

test("remove_from_the_lock_screen_without_a_vault_to_choose_puts_focus_on_the_heading", async () => {
  await lockScreen([vault(8, "Home", { available: false }), vault(9, "Away", { available: false })]);
  fireEvent.click(within(rowOf("Home")).getByRole("button", { name: "Remove from list" }));
  pressIn(await findRemoveBox(), "Remove");
  await boxGone();
  expect(debugState().vaults?.map((one) => one.id)).toEqual([9]);
  await focusIs(screen.getByRole("heading", { level: 1 }), "the heading");
});

test("try_again_reads_the_list_again_and_the_row_opens_once_back", async () => {
  await lockScreen([vault(7, "My vault"), vault(8, "Home", { available: false })]);
  const row = rowOf("Home");
  const reads = sent("list_vaults").length;
  fireEvent.click(within(row).getByRole("button", { name: "Try again" }));
  // Still unavailable: said under that row, in a status line.
  await waitFor(() => {
    expect(within(rowOf("Home")).getByRole("status").textContent).toBe(STILL);
  });
  expect(sent("list_vaults").length).toBe(reads + 1);
  expect(screen.getByRole<HTMLInputElement>("radio", { name: /My vault/ }).checked).toBe(true);

  // The folder is back: Try again chooses that vault, and its password box has focus.
  shell.setAvailable(8, true);
  fireEvent.click(within(rowOf("Home")).getByRole("button", { name: "Try again" }));
  await waitFor(() => {
    expect(screen.getByRole<HTMLInputElement>("radio", { name: /Home/ }).checked).toBe(true);
  });
  const field = screen.getByLabelText("Password for Home");
  await focusIs(field, "the password box");
  expect(screen.queryByRole("group", { name: "Home" })).toBeNull();
  // And it opens, with the row the list gave (the same list, the same ID).
  fireEvent.change(field, { target: { value: PASSWORD } });
  fireEvent.submit((field as HTMLInputElement).form as HTMLFormElement);
  await screen.findByRole("button", { name: "Home, vault menu" });
  expect(sent("unlock_vault")).toEqual([{ vault: { list: shell.listIdentity(), id: 8 }, password: PASSWORD }]);
});

test("a_list_that_cannot_be_read_on_try_again_says_so_in_words", async () => {
  await lockScreen([vault(7, "My vault"), vault(8, "Home", { available: false })]);
  shell.refuseNext("list_vaults", { code: "core", kind: "io", what: SENTINEL });
  fireEvent.click(within(rowOf("Home")).getByRole("button", { name: "Try again" }));
  await waitFor(() => {
    expect(screen.getByRole("alert").textContent).toBe(IO_WORDS);
  });
  expect(document.body.textContent).not.toContain("SENTINEL");
});

// ---- 30b's row says the vault's name (Task 9b) ----

/** The declarations of the rule written as exactly `selector { ... }` in the stylesheet (comments already taken out), as a map; `null` when there is no such rule. */
function declarations(selector: string): Map<string, string> | null {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const found = new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(CSS);
  if (found === null) return null;
  const body = found[1] ?? "";
  return new Map(
    body
      .split(";")
      .map((line) => line.trim())
      .filter((line) => line !== "")
      .map((line): [string, string] => {
        const at = line.indexOf(":");
        return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
      }),
  );
}

test("an_unavailable_vault_shows_its_name_with_try_again_and_remove_beside_it", async () => {
  // The list kept the name of a vault whose folder is gone: the row says it, as 30b draws it, and not "A vault that can't be read".
  const { container } = await lockScreen([vault(7, "My vault"), vault(8, "Home", { available: false })]);
  const row = rowOf("Home");
  expect(screen.queryByText("A vault that can't be read")).toBeNull();
  // The row's parts in 30b's order: the mark, the name with its line in one column, then the two links, and the status line last.
  const parts = [...row.children].map((part) => `${part.tagName.toLowerCase()}.${part.getAttribute("class") ?? ""}`);
  expect(parts).toEqual(["svg.vmini", "span.vgrow", "button.lnk", "button.lnk", "p.vstill"]);
  const column = row.querySelector(".vgrow") as HTMLElement;
  expect([...column.children].map((part) => `${part.tagName}:${part.textContent}`)).toEqual(["B:Home", `SMALL:${UNAVAILABLE_LINE}`]);
  expect([...row.querySelectorAll("button")].map((button) => button.textContent)).toEqual(["Try again", "Remove from list"]);
  expect(row.lastElementChild?.getAttribute("role")).toBe("status");
  // A layout takes no inline style.
  expect(container.querySelector("[style]")).toBeNull();

  // The layout, as the stylesheet draws it (a browser lays it out, jsdom does not): the row wraps, but the name's column asks for little, so the links fit beside it on the
  // plate's 440px (344 inside its padding) and wrap under only when the plate is narrower; the status line takes a line of its own, last.
  const off = declarations(".vbtn.off");
  expect(off?.get("flex-wrap")).toBe("wrap");
  const grow = declarations(".vgrow");
  const basis = /^1 1 ([\d.]+)em$/.exec(grow?.get("flex") ?? "");
  expect(basis, `the name's column is "flex: 1 1 <a few em>", not its whole line's width (flex: ${grow?.get("flex") ?? "none"})`).not.toBeNull();
  // At 14px, a basis up to 8em (112) leaves room for the mark (36), three gaps of 12 (36), and the two links at 13px, each at most 5em and breaking onto two lines when its
  // words need it (about 58 and 65): 36 + 36 + 112 + 58 + 65 = 307, inside 318 (the row's 344 less its padding and border). A browser measures it (the session did, at 1280 by 800 and
  // 1093 by 534); this only keeps the declarations that measurement was made with.
  expect(Number(basis?.[1])).toBeLessThanOrEqual(8);
  expect(grow?.get("min-width")).toBe("0");
  expect(grow?.get("overflow-wrap")).toBe("break-word");
  const links = declarations(".vbtn.off .lnk");
  expect([links?.get("height"), links?.get("max-width"), links?.get("font-size")]).toEqual(["auto", "5em", "13px"]);
  const still = declarations(".vstill");
  expect(still?.get("flex")).toBe("1 0 100%");
  await expectNoAxe(container);
});

test("remove_from_an_unavailable_row_names_the_vault", async () => {
  // 18g from the lock screen's row: the sentence names the vault the list kept the name of.
  await lockScreen([vault(7, "My vault"), vault(8, "Home", { available: false })]);
  fireEvent.click(within(rowOf("Home")).getByRole("button", { name: "Remove from list" }));
  const box = await findRemoveBox();
  expect(box.querySelector("p")?.textContent).toBe(removeWords("Home"));
  expect(box.textContent).not.toContain("A vault that can't be read");
  pressIn(box, "Cancel");
  await boxGone();
  cleanup();

  // The vault menu's unavailable row and box say it too, and its Remove goes through 18g with the name.
  resetStoreForTests();
  invoke.mockReset();
  listen.mockReset();
  await unlocked([vault(7, "My vault"), vault(8, "Home", { available: false })]);
  const menu = await openVaultMenu();
  expect((rowsOf(menu)[1] as HTMLElement).textContent).toBe("HomeNot available");
  fireEvent.click(rowsOf(menu)[1] as HTMLElement);
  const unavailable = await screen.findByRole("dialog", { name: "Home is unavailable" });
  expect(unavailable.querySelector("p")?.textContent).toBe("Home is unavailable: its folder or drive isn't there.");
  pressIn(unavailable, "Remove from list");
  expect((await findRemoveBox()).querySelector("p")?.textContent).toBe(removeWords("Home"));
});

test("a_row_the_list_never_named_says_a_vault_that_cant_be_read", async () => {
  // No name was ever kept (the folder never gave one): the row, 18g and the menu's box all say the old words.
  const NAMELESS = "A vault that can't be read";
  await lockScreen([vault(7, "My vault"), vault(8, null, { available: false })]);
  const row = rowOf(NAMELESS);
  expect(within(row).getByText(NAMELESS).tagName).toBe("B");
  expect(within(row).getByText(UNAVAILABLE_LINE)).toBeTruthy();
  expect(within(row).getAllByRole("button").map((button) => button.textContent)).toEqual(["Try again", "Remove from list"]);
  fireEvent.click(within(row).getByRole("button", { name: "Remove from list" }));
  const box = await findRemoveBox();
  expect(box.querySelector("p")?.textContent).toBe(removeWords(NAMELESS));
  pressIn(box, "Cancel");
  await boxGone();
  cleanup();

  resetStoreForTests();
  invoke.mockReset();
  listen.mockReset();
  await unlocked([vault(7, "My vault"), vault(8, null, { available: false })]);
  const menu = await openVaultMenu();
  expect((rowsOf(menu)[1] as HTMLElement).textContent).toBe(`${NAMELESS}Not available`);
  fireEvent.click(rowsOf(menu)[1] as HTMLElement);
  const unavailable = await screen.findByRole("dialog", { name: `${NAMELESS} is unavailable` });
  expect(unavailable.querySelector("p")?.textContent).toBe(`${NAMELESS} is unavailable: its folder or drive isn't there.`);
});

test("add_existing_vault_folder_from_the_lock_screen", async () => {
  await lockScreen([vault(7, "My vault")]);
  const links = screen.getAllByRole("button").map((button) => button.textContent);
  // 01a's second row: after Restore a backup, before Open a backup.
  expect(links.slice(links.indexOf("Restore a backup"))).toEqual(["Restore a backup", "Add existing vault folder", "Open a backup"]);

  // A folder that is not a vault: 30a's words, in the plate right under the password form, as an alert; nothing changed.
  fireEvent.click(screen.getByRole("button", { name: "Add existing vault folder" }));
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toBe(NOT_A_VAULT);
  const form = screen.getByLabelText("Password for My vault").closest("form") as HTMLFormElement;
  expect(form.compareDocumentPosition(alert) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(alert.closest("main")).toBe(form.closest("main"));
  expect(form.contains(alert)).toBe(false);
  expect(screen.getByLabelText("Password for My vault").getAttribute("aria-invalid")).toBeNull();
  expect(sent("add_existing_vault")).toEqual([{}]);
  expect(debugState().vaults?.map((one) => one.id)).toEqual([7]);

  // A removable drive: 26b's words, as the first screens say them. The next add takes the old line away first.
  shell.refuseNext("add_existing_vault", { code: "invalid_input", what: "removable drive" });
  fireEvent.click(screen.getByRole("button", { name: "Add existing vault folder" }));
  await waitFor(() => {
    expect(screen.getByRole("alert").textContent).toBe(REMOVABLE);
  });
  expect(screen.getAllByRole("alert")).toHaveLength(1);

  // A closed picker says nothing, and takes the line.
  shell.dismissPickerNext();
  fireEvent.click(screen.getByRole("button", { name: "Add existing vault folder" }));
  await waitFor(() => {
    expect(screen.queryByRole("alert")).toBeNull();
  });
  expect(sent("add_existing_vault")).toHaveLength(3);

  // A refusal with text no screen may show.
  shell.refuseNext("add_existing_vault", { code: "core", kind: "io", what: SENTINEL });
  fireEvent.click(screen.getByRole("button", { name: "Add existing vault folder" }));
  await waitFor(() => {
    expect(screen.getByRole("alert").textContent).toBe(IO_WORDS);
  });
  expect(document.body.textContent).not.toContain("SENTINEL");
  // An unlock attempt takes the line away.
  const field = screen.getByLabelText("Password for My vault");
  fireEvent.change(field, { target: { value: "MU-wrong password here" } });
  fireEvent.submit((field as HTMLInputElement).form as HTMLFormElement);
  await waitFor(() => {
    expect(screen.getAllByRole("alert").map((one) => one.textContent)).toEqual(["Wrong password."]);
  });
});

test("add_existing_vault_folder_from_the_lock_screen_chooses_the_vault_it_added", async () => {
  await lockScreen([vault(7, "My vault")]);
  shell.offerExisting(vault(40, "Old vault"));
  fireEvent.click(screen.getByRole("button", { name: "Add existing vault folder" }));
  // The new row is the shell's own (the next ID of the list), chosen, with focus in its password box.
  const field = await screen.findByLabelText("Password for Old vault");
  await focusIs(field, "its password box");
  expect(screen.getByRole<HTMLInputElement>("radio", { name: /Old vault/ }).checked).toBe(true);
  expect(debugState().vaults?.map((one) => one.id)).toEqual([7, 8]);
  fireEvent.change(field, { target: { value: PASSWORD } });
  fireEvent.submit((field as HTMLInputElement).form as HTMLFormElement);
  await screen.findByRole("button", { name: "Old vault, vault menu" });
  expect(sent("unlock_vault")).toEqual([{ vault: { list: shell.listIdentity(), id: 8 }, password: PASSWORD }]);
});

test("the_lock_screens_add_asks_about_a_cloud_folder_and_a_dismissal_leaves_the_screen_as_it_was", async () => {
  await lockScreen([vault(7, "My vault")]);
  shell.offerExisting(vault(40, "Old vault"));
  shell.cloudNext();
  fireEvent.click(screen.getByRole("button", { name: "Add existing vault folder" }));
  // The first screens' question takes the lock screen's place.
  await screen.findByRole("heading", { level: 1, name: "This folder is synced to the cloud" });
  expect(screen.queryByLabelText(/^Password for /)).toBeNull();
  expect(sent("add_existing_vault_confirm")).toEqual([]);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await screen.findByRole("heading", { level: 1, name: "Unlock My vault" });
  expect(sent("add_existing_vault_confirm")).toEqual([]);
  expect(debugState().addFolder).toBeNull();
  expect(debugState().vaults?.map((one) => one.id)).toEqual([7]);

  // Choose another opens the picker again; Continue anyway sends the token it was given.
  shell.cloudNext();
  fireEvent.click(screen.getByRole("button", { name: "Add existing vault folder" }));
  await screen.findByRole("heading", { level: 1, name: "This folder is synced to the cloud" });
  fireEvent.click(screen.getByRole("button", { name: "Choose another" }));
  await screen.findByLabelText("Password for Old vault");
  expect(sent("add_existing_vault")).toHaveLength(3);

  shell.offerExisting(vault(41, "Newer vault"));
  shell.cloudNext();
  fireEvent.click(screen.getByRole("button", { name: "Add existing vault folder" }));
  await screen.findByRole("heading", { level: 1, name: "This folder is synced to the cloud" });
  fireEvent.click(screen.getByRole("button", { name: "Continue anyway" }));
  await screen.findByLabelText("Password for Newer vault");
  expect(sent("add_existing_vault_confirm")).toEqual([{ token: expect.stringMatching(/^add-token-/) as unknown }]);
});

test("the_lock_screens_add_sends_nothing_more_while_its_picker_is_open", async () => {
  await lockScreen([vault(7, "My vault")]);
  const real = invoke.getMockImplementation();
  if (real === undefined) throw new Error("no fake shell");
  let open: (() => void) | undefined;
  invoke.mockImplementation((cmd: string, args?: unknown) =>
    cmd === "add_existing_vault"
      ? new Promise((resolve) => {
          open = () => {
            resolve("Dismissed");
          };
        })
      : (real(cmd, args) as Promise<unknown>),
  );
  const add = screen.getByRole("button", { name: "Add existing vault folder" });
  fireEvent.click(add);
  await waitFor(() => {
    expect(add.getAttribute("aria-disabled")).toBe("true");
  });
  // A second press sends nothing while the picker is open.
  fireEvent.click(add);
  fireEvent.click(add);
  expect(sent("add_existing_vault")).toHaveLength(1);
  await act(async () => {
    open?.();
    await Promise.resolve();
  });
  await waitFor(() => {
    expect(add.getAttribute("aria-disabled")).toBeNull();
  });
});

// ---- Read-only copies and older copies ----

test("remove_and_show_hidden_for_read_only_and_older_copies", async () => {
  shell = installFakeShell(invoke, listen, [vault(7, "My vault"), vault(8, "Home")]);
  shell.olderCopies([{ vault: 7, folder: OLDER, last_written: "2026-11-04", size: 1_000_000 } satisfies FakeOlderCopy]);
  render(<App />);
  const lock = await screen.findByLabelText(/^Password for /);
  fireEvent.change(lock, { target: { value: PASSWORD } });
  fireEvent.submit((lock as HTMLInputElement).form as HTMLFormElement);
  await screen.findByRole("heading", { level: 1, name: "All items", hidden: true });
  // A writable vault of the list has both.
  let menu = await openVaultMenu();
  expect(actionsOf(menu)).toContain("Show My vault in Explorer");
  expect(actionsOf(menu)).toContain("Remove My vault from this list");
  fireEvent.keyDown(menu, { key: "Escape" });
  await waitFor(() => {
    expect(screen.queryByRole("menu")).toBeNull();
  });

  // The older copy, opened from Settings, then a backup from its window.
  fireEvent.click(within(side()).getByRole("button", { name: "Settings" }));
  const settings = await screen.findByRole("complementary", { name: "Settings" });
  fireEvent.click(within(settings).getByRole("button", { name: "Older copies (1)" }));
  const copies = await screen.findByRole("complementary", { name: "Older copies" });
  fireEvent.click(within(copies).getByRole("button", { name: "Open read-only" }));
  fireEvent.change(within(copies).getByLabelText("Password or recovery key for this copy"), { target: { value: PASSWORD } });
  fireEvent.click(within(copies).getByRole("button", { name: "Open" }));
  await screen.findByRole("button", { name: "My vault, older copy, read-only, vault menu" });
  menu = await openVaultMenu();
  expect(actionsOf(menu)).toEqual(["New vault", "Add existing vault folder", "Lock My vault, older copy"]);
  fireEvent.keyDown(menu, { key: "Escape" });
  await waitFor(() => {
    expect(screen.queryByRole("menu")).toBeNull();
  });

  fireEvent.click(within(side()).getByRole("button", { name: "Settings" }));
  const again = await screen.findByRole("complementary", { name: "Settings" });
  fireEvent.click(within(again).getByRole("button", { name: "Open a backup" }));
  const open = await screen.findByRole("complementary", { name: "Open a backup" });
  fireEvent.change(within(open).getByLabelText(LABEL), { target: { value: "MU-backup password" } });
  fireEvent.click(within(open).getByRole("button", { name: "Open read-only" }));
  // Whether the backup opens depends on the fake's backup password; either way the window on screen is read-only and has neither action.
  await waitFor(() => {
    expect(screen.getByRole("button", { name: /, vault menu$/ })).toBeTruthy();
  });
  menu = await openVaultMenu();
  expect(actionsOf(menu).some((name) => /in Explorer$|from this list$/.test(name))).toBe(false);
  expect(sent("show_vault_in_explorer")).toEqual([]);
  expect(sent("forget_vault")).toEqual([]);
});

test("remove_and_show_hidden_on_a_listed_vault_that_opens_read_only", async () => {
  // A read-only session that does have a place on the list (its registry ID is above 0): the condition is the session's own, not only the list's.
  await unlocked([vault(7, "My vault", { readOnly: true }), vault(8, "Home")]);
  const menu = await openVaultMenu();
  expect(actionsOf(menu)).toEqual(["New vault", "Add existing vault folder", "Lock My vault"]);
  expect(debugState().sessions.map((one) => [one.vaultId, one.readOnly])).toEqual([[7, true]]);
});

// ---- The unlock step and Ask 8 ----

async function toTheStepOf(name: string, index = 0): Promise<void> {
  const menu = await openVaultMenu();
  const locked = rowsOf(menu).filter((one) => one.textContent === `${name}Locked`);
  fireEvent.click(locked[index] as HTMLElement);
  await screen.findByRole("heading", { level: 1, name: `Unlock ${name}` });
}

test("the_unlock_step_and_ask_8_offer_show_and_remove", async () => {
  await unlocked([vault(7, "My vault"), vault(8, "Home"), vault(9, "Home"), vault(10, null, { detailsDamaged: true })]);
  const list = shell.listIdentity();

  // The unlock step of the second Home: Back first, then Show and Remove, in 18a's words, as quiet links.
  await toTheStepOf("Home", 1);
  const links = screen.getAllByRole("button").map((button) => button.textContent);
  expect(links.slice(links.indexOf("Unlock"))).toEqual(["Unlock", "Back", "Show Home in Explorer", "Remove Home from this list"]);
  for (const name of ["Show Home in Explorer", "Remove Home from this list"]) {
    expect(screen.getByRole("button", { name }).className).toBe("lnk");
  }
  // Show names that row (the second Home, 9), and a refusal is said on this screen.
  fireEvent.click(screen.getByRole("button", { name: "Show Home in Explorer" }));
  await waitFor(() => {
    expect(sent("show_vault_in_explorer")).toEqual([{ vault: { list, id: 9 } }]);
  });
  expect(shell.openedVaults).toEqual([9]);
  shell.explorerFailsNext();
  fireEvent.click(screen.getByRole("button", { name: "Show Home in Explorer" }));
  await waitFor(() => {
    expect(screen.getByRole("alert").textContent).toBe(IO_WORDS);
  });
  // 18g, anchored to that Remove button; Cancel and Escape give focus back to it.
  const remove = screen.getByRole("button", { name: "Remove Home from this list" });
  fireEvent.click(remove);
  const box = await findRemoveBox();
  expect(box.querySelector("p")?.textContent).toBe(removeWords("Home"));
  await focusIs(within(box).getByRole("button", { name: "Cancel" }), "focus starts on Cancel");
  pressIn(box, "Cancel");
  await boxGone();
  await focusIs(remove, "Cancel");
  fireEvent.click(remove);
  await findRemoveBox();
  fireEvent.keyDown(removeBox(), { key: "Escape" });
  await boxGone();
  await focusIs(remove, "Escape");
  expect(sent("forget_vault")).toEqual([]);
  // Remove: that row goes, the step closes, the list is read again, and focus goes to the vault button.
  fireEvent.click(remove);
  pressIn(await findRemoveBox(), "Remove");
  await screen.findByRole("button", { name: "My vault, vault menu" });
  expect(sent("forget_vault")).toEqual([{ vault: { list, id: 9 } }]);
  expect(debugState().unlockStep).toBeNull();
  expect(debugState().vaults?.map((one) => one.id)).toEqual([7, 8, 10]);
  await focusIs(screen.getByRole("button", { name: "My vault, vault menu" }), "the vault button");
  expect(debugState().sessions.map((one) => one.vaultId)).toEqual([7]);

  // Ask 8, from the menu's row: Restore a backup and Back as before, then the same two links.
  const menu = await openVaultMenu();
  const row = rowsOf(menu).find((one) => one.textContent === "A vault that can't be readLocked");
  fireEvent.click(row as HTMLElement);
  await screen.findByRole("heading", { level: 1, name: "This vault can't be opened" });
  const ask = screen.getAllByRole("button").map((button) => button.textContent);
  expect(ask.slice(ask.indexOf("Restore a backup"))).toEqual(["Restore a backup", "Back", "Show A vault that can't be read in Explorer", "Remove A vault that can't be read from this list"]);
  fireEvent.click(screen.getByRole("button", { name: "Show A vault that can't be read in Explorer" }));
  await waitFor(() => {
    expect(sent("show_vault_in_explorer").at(-1)).toEqual({ vault: { list, id: 10 } });
  });
  const removeAsk = screen.getByRole("button", { name: "Remove A vault that can't be read from this list" });
  fireEvent.click(removeAsk);
  pressIn(await findRemoveBox(), "Cancel");
  await boxGone();
  await focusIs(removeAsk, "Cancel on Ask 8");
  fireEvent.click(removeAsk);
  pressIn(await findRemoveBox(), "Remove");
  await screen.findByRole("button", { name: "My vault, vault menu" });
  expect(sent("forget_vault").at(-1)).toEqual({ vault: { list, id: 10 } });
  expect(debugState().unlockStep).toBeNull();
  expect(debugState().vaults?.map((one) => one.id)).toEqual([7, 8]);
});

test("ask_8_from_the_lock_screen_offers_show_and_remove", async () => {
  await lockScreen([vault(9, null, { detailsDamaged: true }), vault(7, "My vault")]);
  const list = shell.listIdentity();
  // The vault that can be opened is chosen first; picking the damaged one puts Ask 8 in the place of the box.
  fireEvent.click(screen.getByRole("radio", { name: /A vault that can't be read/ }));
  await screen.findByRole("heading", { level: 1, name: "This vault can't be opened" });
  const ask = screen.getAllByRole("button").map((button) => button.textContent);
  expect(ask.slice(ask.indexOf("Restore a backup"))).toEqual(["Restore a backup", "Back", "Show A vault that can't be read in Explorer", "Remove A vault that can't be read from this list"]);
  fireEvent.click(screen.getByRole("button", { name: "Show A vault that can't be read in Explorer" }));
  await waitFor(() => {
    expect(sent("show_vault_in_explorer")).toEqual([{ vault: { list, id: 9 } }]);
  });
  fireEvent.click(screen.getByRole("button", { name: "Remove A vault that can't be read from this list" }));
  pressIn(await findRemoveBox(), "Remove");
  // The list is read again; the vault that can be opened is what is left.
  await screen.findByLabelText("Password for My vault");
  expect(sent("forget_vault")).toEqual([{ vault: { list, id: 9 } }]);
  expect(debugState().vaults?.map((one) => one.id)).toEqual([7]);
});

test("ask_8_says_the_kept_name_of_a_named_vault_whose_details_are_damaged", async () => {
  // The list kept the name (Task 9b): Ask 8's row, its actions and the Remove confirmation say it, not the nameless words.
  await lockScreen([vault(9, "Home", { detailsDamaged: true }), vault(7, "My vault")]);
  const list = shell.listIdentity();
  expect(screen.queryByText("A vault that can't be read")).toBeNull();
  fireEvent.click(screen.getByRole("radio", { name: /Home/ }));
  await screen.findByRole("heading", { level: 1, name: "Home can't be opened" });
  const ask = screen.getAllByRole("button").map((button) => button.textContent);
  expect(ask.slice(ask.indexOf("Restore a backup"))).toEqual(["Restore a backup", "Back", "Show Home in Explorer", "Remove Home from this list"]);
  fireEvent.click(screen.getByRole("button", { name: "Show Home in Explorer" }));
  await waitFor(() => {
    expect(sent("show_vault_in_explorer")).toEqual([{ vault: { list, id: 9 } }]);
  });
  fireEvent.click(screen.getByRole("button", { name: "Remove Home from this list" }));
  const box = await findRemoveBox();
  expect(box.querySelector("p")?.textContent).toBe(removeWords("Home"));
  expect(document.body.textContent).not.toContain("A vault that can't be read");
  pressIn(box, "Remove");
  await screen.findByLabelText("Password for My vault");
  expect(sent("forget_vault")).toEqual([{ vault: { list, id: 9 } }]);
});

// ---- Words, looks and the look of every box ----

const CSS = readBeside(import.meta.url, "../styles/components.css").replace(/\/\*[\s\S]*?\*\//g, "");

test("the_new_boxes_draw_with_classes_and_no_styles_of_their_own", async () => {
  await unlocked([vault(7, "My vault"), vault(8, "Home", { available: false })]);
  const menu = await openVaultMenu();
  fireEvent.click(rowsOf(menu)[1] as HTMLElement);
  const box = await screen.findByRole("dialog", { name: "Home is unavailable" });
  expect(box.querySelector("[style]")).toBeNull();
  expect(box.getAttribute("style")).toBeNull();
  expect(document.querySelectorAll("style")).toHaveLength(0);
  // The classes the boxes use are in the stylesheet.
  for (const selector of [".mwarn", ".vbtn.off", ".vstill"]) expect(CSS).toContain(selector);
});

test("vault_list_screens_have_no_axe_violations", async () => {
  // The menu with Show and Remove, the unavailable box, 18g in the menu.
  const first = await unlocked([vault(7, "My vault"), vault(8, "Home", { available: false })]);
  const menu = await openVaultMenu();
  await expectNoAxe(first.container);
  fireEvent.click(rowsOf(menu)[1] as HTMLElement);
  const box = await screen.findByRole("dialog", { name: "Home is unavailable" });
  await expectNoAxe(first.container);
  pressIn(box, "Try again");
  await waitFor(() => {
    expect(within(box).getByRole("status").textContent).toBe(STILL);
  });
  await expectNoAxe(first.container);
  pressIn(box, "Remove from list");
  await findRemoveBox();
  await expectNoAxe(first.container);
  cleanup();

  // The lock screen with one unavailable row, with 18g, with two, and with the add's refusal.
  resetStoreForTests();
  invoke.mockReset();
  listen.mockReset();
  const one = await lockScreen([vault(8, "Home", { available: false })]);
  await expectNoAxe(one.container);
  fireEvent.click(within(rowOf("Home")).getByRole("button", { name: "Remove from list" }));
  await findRemoveBox();
  await expectNoAxe(one.container);
  cleanup();

  resetStoreForTests();
  invoke.mockReset();
  listen.mockReset();
  const two = await lockScreen([vault(7, "My vault"), vault(8, "Home", { available: false }), vault(9, "Away", { available: false })]);
  fireEvent.click(within(rowOf("Home")).getByRole("button", { name: "Try again" }));
  await waitFor(() => {
    expect(within(rowOf("Home")).getByRole("status").textContent).toBe(STILL);
  });
  await expectNoAxe(two.container);
  fireEvent.click(screen.getByRole("button", { name: "Add existing vault folder" }));
  await screen.findByRole("alert");
  await expectNoAxe(two.container);
  await act(async () => {
    await refreshVaults();
  });
});
