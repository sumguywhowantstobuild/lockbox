// Plan 4C Task 6's screens: every vault of the list is a row of the vault menu and a button of the vault strip, a locked one opens its own unlock step (with Back)
// while the others stay open, an open one is switched to, forms stay with their vault, and Copy to a vault can unlock a vault. Every case runs through the real App
// against the pretend shell, as a person reaches it. Typed passwords are made up (`MU-`), and a test of a wipe looks for them in the fields, the page and the store.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import App from "../App";
import { messageFor } from "../messages";
import { VaultMark, vaultLook } from "../parts/Pattern";
import { debugState, resetStoreForTests, showSession } from "../store";
import { expectNoAxe } from "../testing/axe";
import {
  BACKUP_NAME,
  BACKUP_PASSWORD,
  installFakeShell,
  PASSWORD,
  sampleItems,
  WRONG_PASSWORD,
  type FakeOlderCopy,
  type FakeShell,
  type FakeVault,
} from "../testing/fakeShell";
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

const NEW = "MU-new passphrase 2026";
const TYPED = "MU-typed in the step";
const ASK16 = "Your new password was saved, but the vault locked before Lockbox could say so. Unlock with the new one.";
const ASK9_HEADING = "Opened from the backup copy of this vault's details";
// The banner's body, under its heading (4C Task 13b).
const ASK9 = "If you changed this vault's password recently, it may need your previous password. Change the password again now that it's open.";
const BACKUP = "My vault 2026-10-02";
const OLDER = "My vault.before-restore";
const NOWHERE = "Unlock a vault first, then copy into it.";
const LABEL = "Password or recovery key from when it was made";

/** A vault's menu row by its name: an open vault's row reads "<name>Unlocked" (its status line, 4C Task 13b), so either way finds it. */
function rowName(name: string | RegExp): string | RegExp | ((read: string) => boolean) {
  if (typeof name !== "string") return name;
  return (read) => read === name || read === `${name}Unlocked`;
}

function vault(id: number, name: string | null, extra: Partial<FakeVault> = {}): FakeVault {
  return { id, name, items: sampleItems(), ...extra };
}

function mine(): FakeVault[] {
  return [vault(7, "My vault")];
}

function side(): HTMLElement {
  return screen.getByRole("navigation", { name: "Vault and folders" });
}

function sent(cmd: string): Record<string, unknown>[] {
  return invoke.mock.calls.filter(([name]) => name === cmd).map(([, args]) => args as Record<string, unknown>);
}

/** A row of the vault list as the shell gave it (Task 9): the list's identity and the vault's ID. */
function ref(id: number): { list: number; id: number } {
  return { list: shell.listIdentity(), id };
}

function sessionOfVault(id: number): { session: number; generation: number } {
  const live = shell.sessionOf(id);
  if (live === undefined) throw new Error(`vault ${String(id)} is not open`);
  return { session: live.session, generation: live.generation };
}

/** One vault of `list`, unlocked through the lock screen (the first that can be opened). */
async function unlocked(list: FakeVault[] = mine()) {
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

/** The vault menu's row (by its name as it reads: "Home" for an open vault, "HomeLocked" for a locked one) chosen. */
async function chooseRow(name: string | RegExp): Promise<void> {
  const menu = await openVaultMenu();
  fireEvent.click(within(menu).getByRole("menuitemradio", { name: rowName(name) }));
  await waitFor(() => {
    expect(screen.queryByRole("menu")).toBeNull();
  });
}

function field(): HTMLInputElement {
  return screen.getByLabelText<HTMLInputElement>(/^Password for /);
}

function typeAndSend(password: string) {
  fireEvent.change(field(), { target: { value: password } });
  fireEvent.submit(field().form as HTMLFormElement);
}

/** A locked vault chosen from the menu (its row reads "<name>Locked"), its password typed, and the vault open and on screen. */
async function unlockFromMenu(name: string, password = PASSWORD): Promise<void> {
  const menu = await openVaultMenu();
  const row = rowsOf(menu).find((one) => one.textContent === `${name}Locked`);
  if (row === undefined) throw new Error(`no locked row for ${name}`);
  fireEvent.click(row);
  await waitFor(() => {
    expect(screen.queryByRole("menu")).toBeNull();
  });
  await screen.findByRole("heading", { level: 1, name: `Unlock ${name}` });
  typeAndSend(password);
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
  await chooseRow(name);
  await screen.findByRole("button", { name: `${name}, vault menu` });
}

function markOf(points: number): string | null | undefined {
  const drawn = render(<VaultMark points={points} />);
  const d = drawn.container.querySelector("path")?.getAttribute("d");
  drawn.unmount();
  return d;
}

function markOnScreen(): string | null | undefined {
  return document.querySelector(".vprint path")?.getAttribute("d") ?? document.querySelector(".dvault.on svg path")?.getAttribute("d");
}

/** Whatever of a made-up password is in a field, in the words on the page or in the store: the list of where it was found. */
function foundOnPage(secrets: string[]): string[] {
  const found: string[] = [];
  const held = JSON.stringify(debugState());
  const words = document.body.textContent;
  for (const secret of secrets) {
    for (const box of document.querySelectorAll("input")) if (box.value.includes(secret)) found.push(`a field holds ${secret}`);
    if (held.includes(secret)) found.push(`the store holds ${secret}`);
    if (words.includes(secret)) found.push(`the page says ${secret}`);
  }
  return found;
}

const SECRETS = [PASSWORD, NEW, TYPED, "MU-typed pending", "MU-wrong"];

/** Settings from the side menu. */
async function settings(): Promise<HTMLElement> {
  fireEvent.click(within(side()).getByRole("button", { name: "Settings" }));
  return screen.findByRole("complementary", { name: "Settings" });
}

async function addMenu(choice: string) {
  const button = screen.getByRole("button", { name: "Add" });
  button.focus();
  fireEvent.pointerDown(button, { button: 0 });
  fireEvent.click(button);
  const menu = await screen.findByRole("menu");
  fireEvent.click(within(menu).getByRole("menuitem", { name: choice }));
}

/** The backup, opened from Settings of the vault on screen (its password is the one from the day it was made); it is the window. */
async function openTheBackup() {
  const panel = await settings();
  fireEvent.click(within(panel).getByRole("button", { name: "Open a backup" }));
  const open = await screen.findByRole("complementary", { name: "Open a backup" });
  fireEvent.change(within(open).getByLabelText(LABEL), { target: { value: BACKUP_PASSWORD } });
  fireEvent.click(within(open).getByRole("button", { name: "Open read-only" }));
  await screen.findByRole("button", { name: `${BACKUP}, read-only, vault menu` });
  await screen.findByRole("heading", { level: 1, name: "All items" });
}

async function select(title: string): Promise<HTMLElement> {
  fireEvent.click(await screen.findByRole("button", { name: new RegExp(String.raw`^(Login|Key|Note|File):\s*${title}`) }));
  return screen.findByRole("complementary", { name: title });
}

const CSS = readBeside(import.meta.url, "../styles/components.css").replace(/\/\*[\s\S]*?\*\//g, "");
const HIGH_CONTRAST = readBeside(import.meta.url, "../styles/high-contrast.css").replace(/\/\*[\s\S]*?\*\//g, "");

function declarationsFor(selector: string): string {
  for (const rule of CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if ((rule[1] ?? "").split(",").some((part) => part.replace(/\s+/g, " ").trim() === selector)) return (rule[2] ?? "").replace(/\s+/g, " ");
  }
  throw new Error(`${selector} has no rule in components.css`);
}

// ---- The menu's rows, and the unlock step ----

test("a_locked_vault_is_a_row_that_opens_its_unlock_step", async () => {
  await unlocked([vault(7, "My vault"), vault(8, "Home")]);
  const menu = await openVaultMenu();
  // Every vault of the list is a row, in the list's order: the open one marked, the locked one saying so in words. No line of notes is left.
  expect(menu.querySelectorAll(".mnote")).toHaveLength(0);
  const rows = rowsOf(menu);
  expect(rows.map((row) => row.textContent)).toEqual(["My vaultUnlocked", "HomeLocked"]);
  expect(rows.map((row) => row.getAttribute("aria-checked"))).toEqual(["true", "false"]);
  expect(within(menu).getByRole("group", { name: "Vaults" })).toBeTruthy();
  // Choosing the locked row sends nothing: its own unlock step comes, for that vault alone.
  fireEvent.click(rows[1] as HTMLElement);
  await screen.findByRole("heading", { level: 1, name: "Unlock Home" });
  expect(sent("unlock_vault")).toEqual([{ vault: ref(7), password: PASSWORD }]);
  expect(debugState().unlockStep).toMatchObject({ vault: 8, list: shell.listIdentity() });
  expect(field().getAttribute("type")).toBe("password");
  expect(screen.getByRole("button", { name: "Back" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Unlock" })).toBeTruthy();
  // It is the step of one vault: no list of vaults to choose from, Forgot password? for this vault (in the row with Unlock and Back), and Home's own colour.
  expect(screen.queryByRole("radio")).toBeNull();
  expect(screen.getByRole("button", { name: "Forgot password?" })).toBeTruthy();
  expect(document.querySelector(".app")?.classList.contains(`v-${vaultLook(1, false).accent}`)).toBe(true);
  // The vault that was open is still open, with no command sent for it.
  expect(debugState().sessions.map((one) => one.vaultId)).toEqual([7]);
  expect(sent("lock_vault")).toEqual([]);
});

test("unlocking_a_second_vault_keeps_the_first_open", async () => {
  await unlocked([vault(7, "My vault"), vault(8, "Home")]);
  const first = debugState().sessions[0];
  await chooseRow(/^Home/);
  await screen.findByRole("heading", { level: 1, name: "Unlock Home" });
  typeAndSend(PASSWORD);
  await screen.findByRole("button", { name: "Home, vault menu" });
  // Home's password went for Home (its registry ID) and no other command touched the first vault.
  expect(sent("unlock_vault")).toEqual([
    { vault: ref(7), password: PASSWORD },
    { vault: ref(8), password: PASSWORD },
  ]);
  expect(sent("lock_vault")).toEqual([]);
  expect(sent("lock_all")).toEqual([]);
  expect(shell.sessionOf(7)?.unlocked).toBe(true);
  expect(shell.sessionOf(8)?.unlocked).toBe(true);
  // The page holds both, the first exactly as it was; the step is gone and Home is the window.
  expect(debugState().sessions.map((one) => one.vaultId)).toEqual([7, 8]);
  expect(debugState().sessions[0]).toBe(first);
  expect(debugState().unlockStep).toBeNull();
  expect(screen.queryByLabelText(/^Password for /)).toBeNull();
  expect(foundOnPage([PASSWORD])).toEqual([]);
  // Back in the menu both are open, Home marked.
  const menu = await openVaultMenu();
  expect(rowsOf(menu).map((row) => row.textContent)).toEqual(["My vaultUnlocked", "HomeUnlocked"]);
  expect(rowsOf(menu).map((row) => row.getAttribute("aria-checked"))).toEqual(["false", "true"]);
});

test("back_from_the_unlock_step_returns_to_the_vault_on_screen", async () => {
  await unlocked([vault(7, "My vault"), vault(8, "Home")]);
  await chooseRow(/^Home/);
  await screen.findByRole("heading", { level: 1, name: "Unlock Home" });
  fireEvent.change(field(), { target: { value: TYPED } });
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  await screen.findByRole("button", { name: "My vault, vault menu" });
  expect(screen.getByRole("heading", { level: 1, name: "All items" })).toBeTruthy();
  expect(debugState().unlockStep).toBeNull();
  expect(sent("unlock_vault")).toEqual([{ vault: ref(7), password: PASSWORD }]);
  expect(foundOnPage([TYPED])).toEqual([]);
  // Escape is Back too, and the step opened again starts empty.
  await chooseRow(/^Home/);
  await screen.findByRole("heading", { level: 1, name: "Unlock Home" });
  expect(field().value).toBe("");
  fireEvent.change(field(), { target: { value: TYPED } });
  fireEvent.keyDown(field(), { key: "Escape" });
  await screen.findByRole("button", { name: "My vault, vault menu" });
  expect(foundOnPage([TYPED])).toEqual([]);
  expect(sent("unlock_vault")).toHaveLength(1);
});

test("back_during_an_unlock_in_flight_never_replaces_the_screen_later", async () => {
  await unlocked([vault(7, "My vault"), vault(8, "Home"), vault(9, "Work")]);
  await chooseRow(/^Home/);
  await screen.findByRole("heading", { level: 1, name: "Unlock Home" });
  const release = shell.holdUnlock();
  typeAndSend(PASSWORD);
  await waitFor(() => {
    expect(sent("unlock_vault")).toHaveLength(2);
  });
  // Back while the answer is out: the first vault is the window again, with the unlock still on its way.
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  await screen.findByRole("button", { name: "My vault, vault menu" });
  act(() => {
    release();
  });
  // The vault the shell opened is held by the page, behind the one on screen: the screen does not change.
  await waitFor(() => {
    expect(debugState().sessions.map((one) => one.vaultId)).toEqual([8, 7]);
  });
  expect(screen.getByRole("button", { name: "My vault, vault menu" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Home, vault menu" })).toBeNull();
  const menu = await openVaultMenu();
  expect(rowsOf(menu).map((row) => row.textContent)).toEqual(["My vaultUnlocked", "HomeUnlocked", "WorkLocked"]);
  expect(rowsOf(menu).map((row) => row.getAttribute("aria-checked"))).toEqual(["true", "false", "false"]);
  fireEvent.keyDown(menu, { key: "Escape" });
  await waitFor(() => {
    expect(screen.queryByRole("menu")).toBeNull();
  });
  // Another step opened for a third vault is not taken over by the late answer of the first, either.
  await chooseRow(/^Work/);
  await screen.findByRole("heading", { level: 1, name: "Unlock Work" });
  const hold = shell.holdUnlock();
  typeAndSend(PASSWORD);
  await waitFor(() => {
    expect(sent("unlock_vault")).toHaveLength(3);
  });
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  await screen.findByRole("button", { name: "My vault, vault menu" });
  await chooseRow(/^Work/);
  await screen.findByRole("heading", { level: 1, name: "Unlock Work" });
  act(() => {
    hold();
  });
  // The step that is up is for the same vault the late answer opened, so it is the one that was waited for: Work comes on screen.
  await screen.findByRole("button", { name: "Work, vault menu" });
  expect(debugState().sessions.map((one) => one.vaultId)).toEqual([8, 7, 9]);
  expect(debugState().unlockStep).toBeNull();
});

test("the_unlocked_vault_comes_on_screen_and_the_menu_marks_it", async () => {
  await allOpen([vault(7, "My vault"), vault(8, "Home"), vault(9, "Work")]);
  const accent = (position: number) => `v-${vaultLook(position, false).accent}`;
  // The third vault, by its place on the list: its colour on the window (the main button and the selected row take it), and its mark's points.
  const root = () => document.querySelector(".app");
  expect(root()?.classList.contains(accent(2))).toBe(true);
  expect(markOnScreen()).toBe(markOf(vaultLook(2, false).points));
  expect(vaultLook(2, false).points).toBe(6);
  let menu = await openVaultMenu();
  const selected = rowsOf(menu).find((row) => row.getAttribute("aria-checked") === "true");
  expect(selected?.textContent).toBe("WorkUnlocked");
  // The selected row is marked with a check mark, not by colour alone: it has one more mark than the rows beside it, which each carry only their own aria-hidden mark.
  const marks = rowsOf(menu).map((row) => row.querySelectorAll("svg").length);
  expect(marks.filter((count) => count === Math.min(...marks) + 1)).toHaveLength(1);
  expect(selected?.querySelectorAll("svg").length).toBe(Math.min(...marks) + 1);
  fireEvent.keyDown(menu, { key: "Escape" });
  await waitFor(() => {
    expect(screen.queryByRole("menu")).toBeNull();
  });
  // Another vault: its own colour and mark, and the Add button is drawn inside that window.
  await switchTo("Home");
  expect(root()?.classList.contains(accent(1))).toBe(true);
  expect(root()?.classList.contains(accent(2))).toBe(false);
  expect(markOnScreen()).toBe(markOf(vaultLook(1, false).points));
  expect(root()?.querySelector(".addb")).not.toBeNull();
  // A read-only copy has the look of its own whatever its place: the amber one with four points.
  await openTheBackup();
  expect(root()?.classList.contains("v-old")).toBe(true);
  expect(markOnScreen()).toBe(markOf(4));
  menu = await openVaultMenu();
  expect(rowsOf(menu).map((row) => row.textContent)).toEqual(["My vaultUnlocked", "HomeUnlocked", "WorkUnlocked", `${BACKUP}Backup`]);
  expect(rowsOf(menu).map((row) => row.getAttribute("aria-checked"))).toEqual(["false", "false", "false", "true"]);
});

test("with_two_open_add_and_settings_say_which_vault", async () => {
  await allOpen([vault(7, "My vault"), vault(8, "Home")]);
  // Home is on screen: a new login says where it goes, and Settings names the vault its own section is for.
  await addMenu("Login");
  let panel = await screen.findByRole("complementary", { name: "New login" });
  expect(within(panel).getByText("In Home.")).toBeTruthy();
  fireEvent.click(within(panel).getByRole("button", { name: "Cancel" }));
  await waitFor(() => {
    expect(screen.queryByRole("complementary", { name: "New login" })).toBeNull();
  });
  let open = await settings();
  expect(within(open).getByRole("heading", { level: 3, name: "This vault: Home" })).toBeTruthy();
  expect(within(open).queryByRole("heading", { level: 3, name: "This vault" })).toBeNull();
  fireEvent.click(within(open).getByRole("button", { name: "Close panel" }));
  await switchTo("My vault");
  await addMenu("Note");
  panel = await screen.findByRole("complementary", { name: "New note" });
  expect(within(panel).getByText("In My vault.")).toBeTruthy();
  open = await settings();
  expect(within(open).getByRole("heading", { level: 3, name: "This vault: My vault" })).toBeTruthy();
  // With one vault open the section is just "This vault", as before.
  cleanup();
  resetStoreForTests();
  invoke.mockReset();
  listen.mockReset();
  await unlocked([vault(7, "My vault"), vault(8, "Home")]);
  open = await settings();
  expect(within(open).getByRole("heading", { level: 3, name: "This vault" })).toBeTruthy();
});

test("a_lock_of_one_vault_leaves_the_others_forms_alone", async () => {
  await allOpen([vault(7, "My vault"), vault(8, "Home")]);
  // My vault has a filter typed and a new-login form open; Home is on screen.
  await switchTo("My vault");
  fireEvent.change(screen.getByLabelText("Filter this list"), { target: { value: "Bot" } });
  await addMenu("Login");
  await screen.findByRole("complementary", { name: "New login" });
  await switchTo("Home");
  const mineBefore = debugState().sessions.find((one) => one.vaultId === 7);
  expect(mineBefore?.tool).toEqual({ kind: "new_login", title: "" });
  // Home locks from its menu: My vault comes back with its form open and its filter as it was.
  const menu = await openVaultMenu();
  fireEvent.click(within(menu).getByRole("menuitem", { name: "Lock Home" }));
  await screen.findByRole("button", { name: "My vault, vault menu" });
  expect(shell.sessionOf(8)?.unlocked).toBe(false);
  expect(screen.getByRole("complementary", { name: "New login" })).toBeTruthy();
  expect(screen.getByLabelText<HTMLInputElement>("Filter this list").value).toBe("Bot");
  expect(debugState().sessions.find((one) => one.vaultId === 7)?.forms).toEqual(mineBefore?.forms);
  expect(sent("lock_vault")).toHaveLength(1);
  expect(sent("lock_all")).toEqual([]);
  // The other way: Home is unlocked again and on screen with a title typed in its form; My vault locks from outside, and Home's typed text stays.
  await unlockFromMenu("Home");
  await addMenu("Login");
  const form = await screen.findByRole("complementary", { name: "New login" });
  fireEvent.change(within(form).getByLabelText("Title"), { target: { value: "MU-a title" } });
  act(() => {
    shell.lock(sessionOfVault(7).session);
  });
  await waitFor(() => {
    expect(debugState().sessions.map((one) => one.vaultId)).toEqual([8]);
  });
  expect(within(screen.getByRole("complementary", { name: "New login" })).getByLabelText<HTMLInputElement>("Title").value).toBe("MU-a title");
  expect(screen.getByRole("button", { name: "Home, vault menu" })).toBeTruthy();
});

// ---- Forms belong to their vault ----

// Five forms in one test (about 1.7 s alone); timed out at 5 s twice in the full parallel run.
test("a_form_left_by_a_switch_sends_nothing", { timeout: 20_000 }, async () => {
  const vaults = [vault(7, "My vault"), vault(8, "Home", { usedBackupHeader: true })];
  await allOpen(vaults);
  // Add: a login typed in Home's form, and Home left by a switch. Nothing is sent, nothing is kept, and Home's form is empty when it is back.
  await addMenu("Login");
  let form = await screen.findByRole("complementary", { name: "New login" });
  fireEvent.change(within(form).getByLabelText("Title"), { target: { value: "MU-left behind" } });
  await switchTo("My vault");
  expect(screen.queryByRole("complementary", { name: "New login" })).toBeNull();
  expect(sent("new_item")).toEqual([]);
  expect(document.body.textContent).not.toContain("MU-left behind");
  expect(JSON.stringify(debugState())).not.toContain("MU-left behind");
  await switchTo("Home");
  form = await screen.findByRole("complementary", { name: "New login" });
  expect(within(form).getByLabelText<HTMLInputElement>("Title").value).toBe("");
  fireEvent.click(within(form).getByRole("button", { name: "Cancel" }));

  // Settings: Test a backup, a credential typed, and left by a switch.
  const panel = await settings();
  fireEvent.click(within(panel).getByRole("button", { name: "Test a backup" }));
  const test = await screen.findByRole("complementary", { name: "Test a backup" });
  fireEvent.change(within(test).getByLabelText(LABEL), { target: { value: BACKUP_PASSWORD } });
  await switchTo("My vault");
  expect(sent("test_backup")).toEqual([]);
  expect(foundOnPage([BACKUP_PASSWORD])).toEqual([]);
  await switchTo("Home");
  const again = await screen.findByRole("complementary", { name: "Test a backup" });
  expect(within(again).getByLabelText<HTMLInputElement>(LABEL).value).toBe("");
  fireEvent.click(within(again).getByRole("button", { name: "Cancel" }));

  // Ask 9 (Home's details came from the spare copy): the question is Home's own, and the form it opens is left by a switch like any other.
  expect(screen.getByRole("heading", { level: 2, name: ASK9_HEADING })).toBeTruthy();
  expect(screen.getByText(ASK9)).toBeTruthy();
  await switchTo("My vault");
  expect(screen.queryByText(ASK9)).toBeNull();
  await switchTo("Home");
  fireEvent.click(within(screen.getByText(ASK9).closest(".ask") as HTMLElement).getByRole("button", { name: "Change password" }));
  const change = await screen.findByRole("complementary", { name: "Change password" });
  fireEvent.change(within(change).getByLabelText("Current password"), { target: { value: PASSWORD } });
  fireEvent.change(within(change).getByLabelText("New password"), { target: { value: NEW } });
  await switchTo("My vault");
  expect(sent("change_password")).toEqual([]);
  expect(foundOnPage([NEW])).toEqual([]);
  expect(vaults.map((one) => one.password)).toEqual([undefined, undefined]);

  // Ask 2 (a backup refused as the two copies of the details disagree): the question is Home's, and a switch that comes at once shows it nowhere else.
  await switchTo("Home");
  fireEvent.click(within(await settings()).getByRole("button", { name: "Back up" }));
  const backup = await screen.findByRole("complementary", { name: "Back up" });
  shell.refuseNext("backup_vault", { code: "invalid_input", what: "password copies disagree" });
  fireEvent.click(within(backup).getByRole("button", { name: "Back up" }));
  act(() => {
    showSession(sessionOfVault(7).session);
  });
  await waitFor(() => {
    expect(debugState().sessions.find((one) => one.vaultId === 8)?.backup?.phase).toBe("refused");
  });
  // The backup was asked for Home's session and generation, and no other.
  expect(sent("backup_vault")).toEqual([{ ...sessionOfVault(8), request: expect.any(Number) as number }]);
  expect(debugState().sessions.find((one) => one.vaultId === 7)?.backup).toBeNull();
  expect(screen.queryByRole("dialog")).toBeNull();
  await chooseRow("Home");
  await screen.findByRole("dialog", { name: "Can't back up Home yet" });

  // Copy to a vault: the vault chosen in the form, and the window left by a switch before Copy.
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Not now" }));
  await openTheBackup();
  const item = await select("Bot admin console");
  fireEvent.click(within(item).getByRole("button", { name: "Copy to a vault" }));
  await within(item).findByRole("combobox", { name: "Vault" });
  await switchTo("My vault");
  expect(sent("copy_item_to")).toEqual([]);
  expect(shell.copiedOut).toEqual([]);
});

test("a_send_before_a_switch_answers_on_its_own_vault", async () => {
  // Two vaults with the same name: only the command's arguments and what each vault holds on disk tell them apart.
  const vaults = [vault(7, "My vault"), vault(8, "My vault", { usedBackupHeader: true })];
  await allOpen(vaults);
  const titles = (at: number) => (vaults[at]?.items ?? []).map((item) => item.title);
  const second = sessionOfVault(8);
  // Add: the second vault's login is sent, and the first vault is on screen before the answer comes.
  await addMenu("Login");
  const form = await screen.findByRole("complementary", { name: "New login" });
  fireEvent.change(within(form).getByLabelText("Title"), { target: { value: "MU-sent first" } });
  const release = shell.holdNewItem();
  fireEvent.click(within(form).getByRole("button", { name: "Save" }));
  await waitFor(() => {
    expect(sent("new_item")).toHaveLength(1);
  });
  expect(sent("new_item")[0]).toMatchObject({ ...second, kind: "login", title: "MU-sent first" });
  const first = await openVaultMenu();
  fireEvent.click(rowsOf(first)[0] as HTMLElement);
  await waitFor(() => {
    expect(screen.queryByRole("menu")).toBeNull();
  });
  act(() => {
    release();
  });
  await waitFor(() => {
    expect(titles(1)).toContain("MU-sent first");
  });
  expect(titles(0)).not.toContain("MU-sent first");
  // The first vault's window shows nothing of it; the second's list has it, with its panel open, when it is back.
  expect(screen.queryByText("MU-sent first")).toBeNull();
  const menu = await openVaultMenu();
  fireEvent.click(rowsOf(menu)[1] as HTMLElement);
  await screen.findByRole("heading", { level: 2, name: "MU-sent first" });
  expect(debugState().sessions.find((one) => one.session === second.session)?.items?.some((one) => one.title === "MU-sent first")).toBe(true);
  expect(debugState().sessions.find((one) => one.vaultId === 7 && one.session !== second.session)?.items?.some((one) => one.title === "MU-sent first")).toBe(false);

  // Ask 9 (the second vault's details came from the spare copy): its Change password carries the current password, so it is the one that must never land on the other vault.
  // The change is sent for the second vault, the first is on screen before the answer, and only the second's details and window hear of it.
  fireEvent.click(within(screen.getByText(ASK9).closest(".ask") as HTMLElement).getByRole("button", { name: "Change password" }));
  const change = await screen.findByRole("complementary", { name: "Change password" });
  fireEvent.change(within(change).getByLabelText("Current password"), { target: { value: PASSWORD } });
  fireEvent.change(within(change).getByLabelText("New password"), { target: { value: NEW } });
  fireEvent.change(within(change).getByLabelText("New password again"), { target: { value: NEW } });
  const done = shell.holdChangePassword();
  fireEvent.click(within(change).getByRole("button", { name: "Change password" }));
  await waitFor(() => {
    expect(sent("change_password")).toHaveLength(1);
  });
  expect(sent("change_password")).toEqual([{ ...second, current_password: PASSWORD, new_password: NEW }]);
  const again = await openVaultMenu();
  fireEvent.click(rowsOf(again)[0] as HTMLElement);
  await waitFor(() => {
    expect(screen.queryByRole("menu")).toBeNull();
  });
  act(() => {
    done();
  });
  await waitFor(() => {
    expect(debugState().sessions.find((one) => one.session === second.session)?.passwordChange).toEqual({ phase: "done" });
  });
  // Only the second vault's details changed; the first is untouched and shows nothing of it.
  expect(vaults.map((one) => one.password)).toEqual([undefined, NEW]);
  expect(debugState().sessions.find((one) => one.vaultId === 7 && one.session !== second.session)?.passwordChange).toBeNull();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.queryByRole("complementary", { name: "Change password" })).toBeNull();
  expect(foundOnPage([NEW, PASSWORD])).toEqual([]);
  // Back on the second vault the answer is there: the offer of a fresh backup, for it.
  const last = await openVaultMenu();
  fireEvent.click(rowsOf(last)[1] as HTMLElement);
  await screen.findByRole("dialog", { name: "Make a fresh backup now?" });
  expect(sent("change_password")).toHaveLength(1);
});

test("a_settings_test_sent_before_a_switch_answers_on_its_own_vault", async () => {
  // Two vaults with the same name: only the session the answer lands in tells them apart.
  await allOpen([vault(7, "My vault"), vault(8, "My vault")]);
  const panel = await settings();
  fireEvent.click(within(panel).getByRole("button", { name: "Test a backup" }));
  const test = await screen.findByRole("complementary", { name: "Test a backup" });
  const release = shell.holdTest();
  fireEvent.change(within(test).getByLabelText(LABEL), { target: { value: BACKUP_PASSWORD } });
  fireEvent.click(within(test).getByRole("button", { name: "Test" }));
  await waitFor(() => {
    expect(sent("test_backup")).toHaveLength(1);
  });
  // The command's arguments: the choice the shell holds the backup under, the typed text as the one box's credential, and a request number (no session: the test is
  // the panel's own, and the page keeps its answer for the session whose panel sent it).
  expect(sent("test_backup")).toEqual([
    { choice: shell.testChoiceTokens()[0], credential: { password_or_key: BACKUP_PASSWORD }, request: expect.any(Number) as number },
  ]);
  const first = await openVaultMenu();
  fireEvent.click(rowsOf(first)[0] as HTMLElement);
  await waitFor(() => {
    expect(screen.queryByRole("menu")).toBeNull();
  });
  act(() => {
    release();
  });
  const second = sessionOfVault(8).session;
  await waitFor(() => {
    expect(debugState().sessions.find((one) => one.session === second)?.test?.phase).toBe("good");
  });
  // The answer is the second vault's: the first's window shows nothing of it, and the second shows it when it is back.
  expect(debugState().sessions.find((one) => one.session !== second && one.vaultId === 7)?.test).toBeNull();
  expect(screen.queryByRole("complementary", { name: "This backup is good" })).toBeNull();
  const last = await openVaultMenu();
  fireEvent.click(rowsOf(last)[1] as HTMLElement);
  await screen.findByRole("complementary", { name: "This backup is good" });
});

test("a_copy_sent_before_a_switch_lands_in_its_own_vault", async () => {
  const vaults = [vault(7, "My vault"), vault(8, "Home")];
  await allOpen(vaults);
  await openTheBackup();
  const item = await select("Bot admin console");
  fireEvent.click(within(item).getByRole("button", { name: "Copy to a vault" }));
  await within(item).findByRole("combobox", { name: "Vault" });
  const release = shell.holdCopy();
  fireEvent.click(within(item).getByRole("button", { name: "Copy" }));
  await waitFor(() => {
    expect(sent("copy_item_to")).toHaveLength(1);
  });
  // Sent for Home (the vault chosen, the one unlocked last) from the backup's session; the person switches to My vault before the answer.
  const backup = debugState().sessions.at(-1);
  expect(sent("copy_item_to")[0]).toMatchObject({ from: backup?.session, to: sessionOfVault(8).session });
  await switchTo("My vault");
  act(() => {
    release();
  });
  await waitFor(() => {
    expect(shell.copiedOut).toHaveLength(1);
  });
  expect(shell.copiedOut[0]).toMatchObject({ from: backup?.session, to: sessionOfVault(8).session });
  await waitFor(() => {
    expect(debugState().sessions.find((one) => one.vaultId === 8)?.items?.length).toBe((vaults[1]?.items ?? []).filter((one) => one.kind !== "collection").length + (vaults[1]?.items ?? []).filter((one) => one.kind === "collection").length);
  });
  // Nothing of it is in My vault, which is on screen.
  expect((vaults[0]?.items ?? []).length).toBe(sampleItems().length);
});

// ---- Which rows offer what ----

test("rows_for_read_only_older_copies_and_sessions_not_on_the_list_offer_switch_and_lock_only", async () => {
  shell = installFakeShell(invoke, listen, [vault(7, "My vault"), vault(8, "Home")]);
  shell.olderCopies([{ vault: 7, folder: OLDER, last_written: "2026-11-04", size: 1_000_000 } satisfies FakeOlderCopy]);
  render(<App />);
  const lock = await screen.findByLabelText(/^Password for /);
  fireEvent.change(lock, { target: { value: PASSWORD } });
  fireEvent.submit((lock as HTMLInputElement).form as HTMLFormElement);
  await screen.findByRole("heading", { level: 1, name: "All items", hidden: true });
  // The older copy, opened from Settings, then a backup from the older copy's window.
  fireEvent.click(within(await settings()).getByRole("button", { name: "Older copies (1)" }));
  const list = await screen.findByRole("complementary", { name: "Older copies" });
  fireEvent.click(within(list).getByRole("button", { name: "Open read-only" }));
  fireEvent.change(within(list).getByLabelText("Password or recovery key for this copy"), { target: { value: PASSWORD } });
  fireEvent.click(within(list).getByRole("button", { name: "Open" }));
  await screen.findByRole("button", { name: "My vault, older copy, read-only, vault menu" });
  await openTheBackup();
  // On the backup: the list's vaults first (the open one, the locked one), then the sessions that are not on the list, in the order they were opened.
  let menu = await openVaultMenu();
  expect(rowsOf(menu).map((row) => row.textContent)).toEqual(["My vaultUnlocked", "HomeLocked", "My vaultOlder copy", `${BACKUP}Backup`]);
  expect(rowsOf(menu).map((row) => row.getAttribute("aria-checked"))).toEqual(["false", "false", "false", "true"]);
  // The menu's own actions are New vault and Add existing vault folder (Task 7), which belong to no session, and Lock for the session on screen.
  expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["New vault", "Add existing vault folder", `Lock ${BACKUP}`]);
  // The older copy's row switches to it, and its menu has the same two actions and its own Lock.
  fireEvent.click(rowsOf(menu)[2] as HTMLElement);
  await screen.findByRole("button", { name: "My vault, older copy, read-only, vault menu" });
  menu = await openVaultMenu();
  expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["New vault", "Add existing vault folder", "Lock My vault, older copy"]);
  expect(rowsOf(menu).map((row) => row.getAttribute("aria-checked"))).toEqual(["false", "false", "true", "false"]);
  expect(sent("lock_vault")).toEqual([]);
});

test("a_vault_with_unreadable_details_opens_ask_8_from_its_row", async () => {
  await unlocked([vault(7, "My vault"), vault(8, null, { detailsDamaged: true })]);
  const menu = await openVaultMenu();
  expect(rowsOf(menu).map((row) => row.textContent)).toEqual(["My vaultUnlocked", "A vault that can't be readLocked"]);
  fireEvent.click(rowsOf(menu)[1] as HTMLElement);
  // Ask 8, with no password box: Restore a backup for that vault, and Back to the vault on screen.
  await screen.findByRole("heading", { level: 1, name: "This vault can't be opened" });
  expect(screen.queryByLabelText(/^Password for /)).toBeNull();
  expect(screen.getByRole("button", { name: "Restore a backup" })).toBeTruthy();
  expect(sent("unlock_vault")).toEqual([{ vault: ref(7), password: PASSWORD }]);
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  await screen.findByRole("button", { name: "My vault, vault menu" });
  expect(debugState().unlockStep).toBeNull();
});

test("an_unavailable_vault_stays_a_row_marked_so", async () => {
  await unlocked([vault(7, "My vault"), vault(8, "Home", { available: false })]);
  const menu = await openVaultMenu();
  const rows = rowsOf(menu);
  expect(rows.map((row) => row.textContent)).toEqual(["My vaultUnlocked", "HomeNot available"]);
  // Choosing it opens its own box (Task 9: Try again, Remove from list) and closes the menu; it opens no unlock step, and nothing is sent.
  expect(rows[1]?.getAttribute("aria-disabled")).toBeNull();
  fireEvent.click(rows[1] as HTMLElement);
  await screen.findByRole("dialog", { name: "Home is unavailable" });
  expect(screen.queryByRole("heading", { level: 1, name: "Unlock Home" })).toBeNull();
  expect(debugState().unlockStep).toBeNull();
  expect(sent("unlock_vault")).toHaveLength(1);
  expect(screen.queryByRole("menu")).toBeNull();
});

// ---- The vault strip ----

test("vault_strip_with_one_listed_none", async () => {
  await unlocked();
  expect(screen.queryByRole("navigation", { name: "Vaults" })).toBeNull();
  expect(document.querySelector(".dock")).toBeNull();
});

test("vault_strip_two_listed_one_unlocked_shows", async () => {
  await unlocked([vault(7, "My vault"), vault(8, "Home")]);
  const strip = screen.getByRole("navigation", { name: "Vaults" });
  const buttons = within(strip).getAllByRole("button");
  // A button for each listed vault, in list order: its mark in its own colour and shape, the one on screen marked, the locked one saying so in words and a lock.
  expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual(["My vault", "Home, locked"]);
  expect(buttons.map((button) => button.getAttribute("aria-current"))).toEqual(["true", null]);
  expect(buttons.map((button) => button.classList.contains("on"))).toEqual([true, false]);
  expect(buttons.map((button) => button.classList.contains(`v-${vaultLook(0, false).accent}`) || button.classList.contains(`v-${vaultLook(1, false).accent}`))).toEqual([true, true]);
  expect(buttons.map((button) => button.querySelector("svg path")?.getAttribute("d"))).toEqual([markOf(3), markOf(5)]);
  expect(buttons[0]?.querySelector(".dlock")).toBeNull();
  expect(buttons[1]?.querySelector(".dlock")).not.toBeNull();
  // A button is the vault's row: the locked one's opens its unlock step, an open one's switches.
  fireEvent.click(buttons[1] as HTMLElement);
  await screen.findByRole("heading", { level: 1, name: "Unlock Home" });
  typeAndSend(PASSWORD);
  await screen.findByRole("button", { name: "Home, vault menu" });
  const after = within(screen.getByRole("navigation", { name: "Vaults" })).getAllByRole("button");
  expect(after.map((button) => button.getAttribute("aria-label"))).toEqual(["My vault", "Home"]);
  expect(after.map((button) => button.getAttribute("aria-current"))).toEqual([null, "true"]);
  fireEvent.click(after[0] as HTMLElement);
  await screen.findByRole("button", { name: "My vault, vault menu" });
  expect(debugState().sessions.at(-1)?.vaultId).toBe(7);
  // The strip carries the marks, so the side menu's own is not drawn beside the name (the styles say so).
  expect(declarationsFor(".dock ~ .rail .vprint")).toMatch(/display: none/);
  expect(document.querySelectorAll(".dock[style], .dvault[style], .dlock[style]")).toHaveLength(0);
});

test("vault_strip_two_named_alike_tells_them_apart", async () => {
  await unlocked([vault(7, "My vault"), vault(8, "My vault")]);
  const strip = screen.getByRole("navigation", { name: "Vaults" });
  const buttons = within(strip).getAllByRole("button");
  // Same words, so the place on the list is said as well, and the marks differ by that place.
  expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual(["My vault, 1 of 2", "My vault, 2 of 2, locked"]);
  expect(buttons.map((button) => button.getAttribute("title"))).toEqual(["My vault, 1 of 2", "My vault, 2 of 2, locked"]);
  const [first, second] = buttons.map((button) => button.querySelector("svg path")?.getAttribute("d"));
  expect(first).toBe(markOf(3));
  expect(second).toBe(markOf(5));
  expect(first).not.toBe(second);
  // The vault menu tells them apart as it always could: by the order of the list, and the locked one's word.
  const menu = await openVaultMenu();
  expect(rowsOf(menu).map((row) => row.textContent)).toEqual(["My vaultUnlocked", "My vaultLocked"]);
});

test("the_strip_has_a_look_for_every_state", () => {
  // The strip is a column of buttons beside the side menu: a button's face is the card, the one on screen has a ring (not a tint alone) and the lock is a drawn badge.
  expect(declarationsFor(".dock")).toMatch(/flex-direction: column/);
  expect(declarationsFor(".dock")).toMatch(/width: 60px/);
  expect(declarationsFor(".dvault")).toMatch(/background: var\(--card\)/);
  expect(declarationsFor(".dvault.on")).toMatch(/box-shadow: 0 0 0 2px var\(--add\)/);
  expect(declarationsFor(".dvault .dlock")).toMatch(/position: absolute/);
  // Windows' high contrast: every button has an edge in the text colour, and the one on screen a thick edge in the highlight colour.
  expect(HIGH_CONTRAST).toMatch(/\.dvault/);
  expect(HIGH_CONTRAST).toMatch(/\.dvault\.on[^{]*\{[^}]*Highlight/);
});

// ---- Copy to a vault can unlock a vault ----

test("an_open_backup_stays_open_while_a_vault_is_unlocked_to_copy_into", async () => {
  // A backup opened from the lock screen: no vault is open, so the form offers the locked vaults.
  shell = installFakeShell(invoke, listen, [vault(7, "My vault"), vault(8, "Home")]);
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "Open a backup" }));
  await screen.findByRole("heading", { level: 1, name: "Open a backup" });
  fireEvent.change(screen.getByLabelText(LABEL), { target: { value: BACKUP_PASSWORD } });
  fireEvent.click(screen.getByRole("button", { name: "Open read-only" }));
  await screen.findByRole("button", { name: `${BACKUP}, read-only, vault menu` });
  const panel = await select("Bot admin console");
  fireEvent.click(within(panel).getByRole("button", { name: "Copy to a vault" }));
  expect(within(panel).getByText(NOWHERE)).toBeTruthy();
  const offered = within(panel).getAllByRole("button").map((button) => button.textContent);
  expect(offered.slice(-3)).toEqual(["Unlock My vault", "Unlock Home", "Cancel"]);
  // The vault's own unlock step; nothing is sent until its password is.
  fireEvent.click(within(panel).getByRole("button", { name: "Unlock Home" }));
  await screen.findByRole("heading", { level: 1, name: "Unlock Home" });
  expect(sent("unlock_vault")).toEqual([]);
  // Back leaves the backup as it was.
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  await screen.findByRole("button", { name: `${BACKUP}, read-only, vault menu` });
  expect(shell.backupsOpen()).toEqual([BACKUP_NAME]);
  expect(await screen.findByRole("complementary", { name: "Bot admin console" })).toBeTruthy();
  // Unlocking it puts the person back where they were: the backup is still the window and still open, the vault is open behind it.
  const again = screen.getByRole("complementary", { name: "Bot admin console" });
  fireEvent.click(within(again).getByRole("button", { name: "Copy to a vault" }));
  fireEvent.click(within(again).getByRole("button", { name: "Unlock Home" }));
  await screen.findByRole("heading", { level: 1, name: "Unlock Home" });
  typeAndSend(PASSWORD);
  await screen.findByRole("button", { name: `${BACKUP}, read-only, vault menu` });
  expect(shell.backupsOpen()).toEqual([BACKUP_NAME]);
  expect(shell.sessionOf(8)?.unlocked).toBe(true);
  expect(debugState().sessions.map((one) => one.kind)).toEqual(["vault", "backup"]);
  expect(debugState().sessions.at(-1)?.kind).toBe("backup");
  expect(sent("lock_vault")).toEqual([]);
  // The item is still open, and the form now has the vault to copy into: Home alone.
  const item = await screen.findByRole("complementary", { name: "Bot admin console" });
  fireEvent.click(within(item).getByRole("button", { name: "Copy to a vault" }));
  expect((await within(item).findByRole("combobox", { name: "Vault" })).textContent).toBe("Home");
  fireEvent.click(within(item).getByRole("button", { name: "Copy" }));
  await waitFor(() => {
    expect(shell.copiedOut).toHaveLength(1);
  });
  expect(shell.copiedOut[0]).toMatchObject({ to: sessionOfVault(8).session });
});

// ---- The menu scrolls ----

test("the_vault_menu_scrolls_to_the_focused_row_by_keyboard", async () => {
  const many = [vault(7, "My vault"), ...Array.from({ length: 14 }, (_, at) => vault(8 + at, `Vault ${String(8 + at)}`))];
  await unlocked(many);
  const scrolled: Element[] = [];
  const original = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    writable: true,
    value(this: Element) {
      scrolled.push(this);
    },
  });
  try {
    const opener = screen.getByRole("button", { name: /, vault menu$/ });
    opener.focus();
    fireEvent.keyDown(opener, { key: "ArrowDown" });
    const menu = await screen.findByRole("menu");
    // Every vault is a row the arrow keys reach (the locked ones too): fifteen rows, all in the one area that scrolls.
    const rows = rowsOf(menu);
    expect(rows).toHaveLength(15);
    expect(new Set(rows.map((row) => row.closest(".mscroll"))).size).toBe(1);
    await waitFor(() => {
      expect(menu.contains(document.activeElement)).toBe(true);
    });
    for (let at = 0; at < 20 && document.activeElement !== rows[14]; at += 1) {
      fireEvent.keyDown(document.activeElement ?? menu, { key: "ArrowDown" });
      await waitFor(() => {
        expect(menu.contains(document.activeElement)).toBe(true);
      });
    }
    expect(document.activeElement).toBe(rows[14]);
    expect(rows[14]?.textContent).toBe("Vault 21Locked");
    // The row that has focus was brought into view of the area that scrolls.
    await waitFor(() => {
      expect(scrolled).toContain(rows[14]);
    });
  } finally {
    if (original === undefined) Reflect.deleteProperty(Element.prototype, "scrollIntoView");
    else Object.defineProperty(Element.prototype, "scrollIntoView", original);
  }
});

// ---- Ask 16, per vault, on that vault's step ----

test("ask_16_shows_on_that_vaults_unlock_step", async () => {
  const vaults = [vault(7, "My vault"), vault(8, "Home"), vault(9, "Work")];
  await unlocked(vaults);
  await unlockFromMenu("Home");
  // My vault's password is changed and the vault locks as the change lands: the note is kept for My vault, and Home stays open on screen.
  await switchTo("My vault");
  fireEvent.click(within(await settings()).getByRole("button", { name: "Change password" }));
  const form = await screen.findByRole("complementary", { name: "Change password" });
  fireEvent.change(within(form).getByLabelText("Current password"), { target: { value: PASSWORD } });
  fireEvent.change(within(form).getByLabelText("New password"), { target: { value: NEW } });
  fireEvent.change(within(form).getByLabelText("New password again"), { target: { value: NEW } });
  shell.interruptChangeNext("lock_after_write");
  fireEvent.click(within(form).getByRole("button", { name: "Change password" }));
  await screen.findByRole("button", { name: "Home, vault menu" });
  await waitFor(() => {
    expect(debugState().lockNotes.map((note) => note.vault)).toEqual([7]);
  });
  expect(screen.queryByText(ASK16)).toBeNull();
  // Its row in the menu opens its own step, and the note is there, word for word. A third vault's step has none.
  await chooseRow(/^My vault/);
  await screen.findByRole("heading", { level: 1, name: "Unlock My vault" });
  expect((await screen.findByText(ASK16)).textContent).toBe(ASK16);
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  await screen.findByRole("button", { name: "Home, vault menu" });
  expect(screen.queryByText(ASK16)).toBeNull();
  await chooseRow(/^Work/);
  await screen.findByRole("heading", { level: 1, name: "Unlock Work" });
  expect(screen.queryByText(ASK16)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  await screen.findByRole("button", { name: "Home, vault menu" });
  // The old password is refused and the note stays; the new one opens the vault and uses the note up.
  await chooseRow(/^My vault/);
  await screen.findByText(ASK16);
  typeAndSend(PASSWORD);
  expect((await screen.findByRole("alert")).textContent).toBe("Wrong password.");
  expect(screen.getByText(ASK16)).toBeTruthy();
  typeAndSend(NEW);
  await screen.findByRole("button", { name: "My vault, vault menu" });
  expect(debugState().lockNotes).toEqual([]);
  expect(vaults[0]?.password).toBe(NEW);
});

// ---- Typed secrets ----

test("the_unlock_step_wipes_the_typed_password_pending_refused_back_and_locked", async () => {
  const list = () => [vault(7, "My vault"), vault(8, "Home")];
  // Pending: the field, the page and the store are clear the moment it is sent, before the answer comes, and the field cannot be typed in meanwhile.
  await unlocked(list());
  await chooseRow(/^Home/);
  await screen.findByRole("heading", { level: 1, name: "Unlock Home" });
  const release = shell.holdUnlock();
  fireEvent.change(field(), { target: { value: PASSWORD } });
  expect(foundOnPage([PASSWORD])).toEqual([`a field holds ${PASSWORD}`]);
  expect(JSON.stringify(debugState())).toContain("My vault");
  fireEvent.submit(field().form as HTMLFormElement);
  await waitFor(() => {
    expect(sent("unlock_vault")).toHaveLength(2);
  });
  expect(field().value).toBe("");
  expect(foundOnPage(SECRETS)).toEqual([]);
  expect(field().readOnly).toBe(true);
  fireEvent.change(field(), { target: { value: "MU-typed pending" } });
  expect(field().value).toBe("");
  fireEvent.submit(field().form as HTMLFormElement);
  expect(sent("unlock_vault")).toHaveLength(2);
  act(() => {
    release();
  });
  await screen.findByRole("button", { name: "Home, vault menu" });
  expect(foundOnPage(SECRETS)).toEqual([]);

  // Refused: an empty field with the reason, and nothing of the wrong password anywhere. The right one then opens it.
  cleanup();
  resetStoreForTests();
  invoke.mockReset();
  listen.mockReset();
  await unlocked(list());
  await chooseRow(/^Home/);
  await screen.findByRole("heading", { level: 1, name: "Unlock Home" });
  typeAndSend("MU-wrong password");
  expect((await screen.findByRole("alert")).textContent).toBe("Wrong password.");
  expect(field().value).toBe("");
  expect(foundOnPage(SECRETS)).toEqual([]);
  expect(messageFor(WRONG_PASSWORD).title).toBe("Wrong password.");
  typeAndSend(PASSWORD);
  await screen.findByRole("button", { name: "Home, vault menu" });

  // Back: typed and not sent, then Back, and the step opened again is empty.
  cleanup();
  resetStoreForTests();
  invoke.mockReset();
  listen.mockReset();
  await unlocked(list());
  await chooseRow(/^Home/);
  await screen.findByRole("heading", { level: 1, name: "Unlock Home" });
  fireEvent.change(field(), { target: { value: TYPED } });
  expect(foundOnPage([TYPED])).toEqual([`a field holds ${TYPED}`]);
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  await screen.findByRole("button", { name: "My vault, vault menu" });
  expect(foundOnPage(SECRETS)).toEqual([]);

  // A lock epoch (Lock all, idle, Windows locking) that reaches the page while the step is up wipes what is typed, and ends the step.
  await chooseRow(/^Home/);
  await screen.findByRole("heading", { level: 1, name: "Unlock Home" });
  fireEvent.change(field(), { target: { value: TYPED } });
  await act(async () => {
    shell.changeLockEpoch("idle");
    await Promise.resolve();
  });
  expect(foundOnPage(SECRETS)).toEqual([]);
  expect(debugState().unlockStep).toBeNull();

  // Every open vault locks while the step is up (the lock events come): the lock screen follows with nothing typed on it, and the step is gone from the store.
  cleanup();
  resetStoreForTests();
  invoke.mockReset();
  listen.mockReset();
  await unlocked(list());
  await chooseRow(/^Home/);
  await screen.findByRole("heading", { level: 1, name: "Unlock Home" });
  fireEvent.change(field(), { target: { value: TYPED } });
  act(() => {
    shell.lock(sessionOfVault(7).session);
  });
  await screen.findByRole("heading", { level: 1, name: "Unlock a vault" });
  expect(foundOnPage(SECRETS)).toEqual([]);
  expect(debugState().unlockStep).toBeNull();
  expect(sent("unlock_vault")).toHaveLength(1);
});

// ---- Axe ----

test("switch_screens_have_no_axe_violations", async () => {
  const { container } = await unlocked([vault(7, "My vault"), vault(8, "Home"), vault(9, null, { detailsDamaged: true }), vault(10, "Away", { available: false })]);
  // The side menu with its strip, and the vault menu with locked, open, unavailable and unreadable rows.
  await expectNoAxe(container);
  const menu = await openVaultMenu();
  expect(rowsOf(menu).map((row) => row.textContent)).toEqual(["My vaultUnlocked", "HomeLocked", "A vault that can't be readLocked", "AwayNot available"]);
  await expectNoAxe(menu);
  fireEvent.keyDown(menu, { key: "Escape" });
  await waitFor(() => {
    expect(screen.queryByRole("menu")).toBeNull();
  });
  // The step, empty and with a refusal on it.
  await chooseRow(/^Home/);
  await screen.findByRole("heading", { level: 1, name: "Unlock Home" });
  await expectNoAxe(document.body);
  typeAndSend("MU-wrong password");
  await screen.findByRole("alert");
  await expectNoAxe(document.body);
  expect(container.querySelectorAll("style, [style]")).toHaveLength(0);
  // Ask 8 from its row.
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  await screen.findByRole("button", { name: "My vault, vault menu" });
  await chooseRow(/^A vault that can't be read/);
  await screen.findByRole("heading", { level: 1, name: "This vault can't be opened" });
  await expectNoAxe(document.body);
});
