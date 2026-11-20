// Plan 4C Task 7's screens: New vault and Add existing vault folder in the vault menu. New vault is setup's two steps (the form, then the key and its three questions) with
// Cancel, begun while other vaults stay open; the new session's vault is the one the create answered with, never one found by comparing lists. Every case runs through the
// real App against the pretend shell, as a person reaches it. Typed passwords are made up (`MU-`), and a test of a wipe looks for them in the fields, the page and the store.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import App from "../App";
import { Pattern } from "../parts/Pattern";
import { debugState, resetStoreForTests } from "../store";
import { expectNoAxe } from "../testing/axe";
import {
  installFakeShell,
  PASSWORD,
  sampleItems,
  VAULT_LIST_FULL,
  VAULT_NOT_LISTED,
  type FakeShell,
  type FakeVault,
} from "../testing/fakeShell";
import { CreateVault } from "./setup/CreateVault";
import { wordsOf } from "./setup/keyWords";

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

const NEW = "MU-new vault passphrase";
const TYPED = "MU-typed in the form";
const PENDING = "MU-typed pending";
const NOT_LISTED_INSIDE = "Your new vault is on disk but couldn't be added to the list. Use Add existing vault folder, then make a new recovery key.";
const FIRST_RUN_NOT_LISTED = "Your new vault is on disk but couldn't be added to the list. Use “I already have a vault or a backup” on the first screen to add it.";
const LIST_FULL = "Lockbox's list of vaults is full. It holds up to 1,000 vaults. Nothing was changed.";
const LOCKED_BEFORE = "Your new vault was made, but it locked before Lockbox could show its recovery key. Unlock it with its password, and Lockbox will make a recovery key to write down.";
const DRIVE = "A vault can't live on a removable, FAT32 or network drive. Choose a folder on this PC.";
// 18b and 18c's words, as the approved screens have them (design/round8-build/moved_9_18.py).
const SAY_NEW_VAULT = "A new vault has its own password and its own recovery key.";
const NAME_HINT = "The name isn't encrypted, so don't put secrets in it.";
const CLOUD_WARNING = "A cloud service syncs this folder. Lockbox doesn't support vaults in cloud folders. Choose a folder on this PC, or continue anyway.";
const SECRETS = [PASSWORD, NEW, TYPED, PENDING, "MU-wrong"];

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

/** One of the menu's actions (not a vault's row) chosen, and the menu gone. */
async function chooseAction(name: string): Promise<void> {
  const menu = await openVaultMenu();
  fireEvent.click(within(menu).getByRole("menuitem", { name }));
  await waitFor(() => {
    expect(screen.queryByRole("menu")).toBeNull();
  });
}

async function chooseRow(name: string | RegExp): Promise<void> {
  const menu = await openVaultMenu();
  fireEvent.click(within(menu).getByRole("menuitemradio", { name: rowName(name) }));
  await waitFor(() => {
    expect(screen.queryByRole("menu")).toBeNull();
  });
}

function rowsOf(menu: HTMLElement): HTMLElement[] {
  return within(menu).getAllByRole("menuitemradio");
}

function lockedFieldBox(): HTMLInputElement {
  return screen.getByLabelText<HTMLInputElement>(/^Password for /);
}

function typeAndSendUnlock(password: string) {
  fireEvent.change(lockedFieldBox(), { target: { value: password } });
  fireEvent.submit(lockedFieldBox().form as HTMLFormElement);
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
  typeAndSendUnlock(password);
  await screen.findByRole("button", { name: `${name}, vault menu` });
}

/** Every vault of `list` open, the first through the lock screen and the rest from the menu: the last one is on screen. */
async function allOpen(list: FakeVault[]) {
  const view = await unlocked(list);
  for (const one of list.slice(1)) await unlockFromMenu(one.name ?? "");
  return view;
}

function nameBox(): HTMLInputElement {
  return screen.getByLabelText<HTMLInputElement>("Vault name");
}

function passwordBox(): HTMLInputElement {
  return screen.getByLabelText<HTMLInputElement>("Password");
}

function againBox(): HTMLInputElement {
  return screen.getByLabelText<HTMLInputElement>("Repeat the password");
}

function fill(name = "Home", password = NEW, again = password): void {
  fireEvent.change(nameBox(), { target: { value: name } });
  fireEvent.change(passwordBox(), { target: { value: password } });
  fireEvent.change(againBox(), { target: { value: again } });
}

/** 18b: the vault menu's New vault chosen, and the form up. */
async function toTheForm() {
  await chooseAction("New vault");
  await screen.findByRole("heading", { level: 1, name: "New vault" });
}

/** 18b's Continue. */
function create(): void {
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
}

/** 18c: the cloud warning is on the New vault screen, with its own Continue anyway. */
async function cloudWarning(): Promise<void> {
  await screen.findByRole("button", { name: "Continue anyway" });
  expect(screen.getByRole("heading", { level: 1, name: "New vault" })).toBeTruthy();
  expect(screen.getByText(CLOUD_WARNING)).toBeTruthy();
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

/** Every word of the key found anywhere on the page, in its text or in an attribute. */
function keyWordsOnPage(key: string): string[] {
  const found = new Set<string>();
  const add = (text: string) => {
    for (const token of text.toLowerCase().split(/[^a-z]+/)) if (token !== "") found.add(token);
  };
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) add(node.textContent ?? "");
  for (const element of document.body.querySelectorAll("*")) for (const attr of Array.from(element.attributes)) add(attr.value);
  return [...new Set(wordsOf(key))].filter((word) => found.has(word));
}

/** The key the fake made for the vault, which must be one of 24 words: a check that looks for its words on the page is never a look for nothing. */
function madeKey(vaultId: number): string {
  const key = shell.keyOf(vaultId) ?? "";
  expect(wordsOf(key), `a key was made for vault ${String(vaultId)}`).toHaveLength(24);
  return key;
}

/** The question the key step asks now, and the right word picked. */
function pickRight(key: string): void {
  const label = screen.getByText(/^Which word is number \d+\?$/);
  const group = screen.getByRole("group", { name: label.textContent });
  const position = Number.parseInt(/(\d+)/.exec(label.textContent)?.[1] ?? "0", 10);
  const word = wordsOf(key)[position - 1];
  const choice = within(group)
    .getAllByRole<HTMLButtonElement>("button")
    .find((one) => one.textContent === word);
  if (choice === undefined) throw new Error("no right choice");
  fireEvent.click(choice);
}

/** From the key to the vault's window: Continue, then three right picks. */
async function confirmKey(vaultId: number): Promise<void> {
  const key = madeKey(vaultId);
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  await screen.findByRole("heading", { level: 1, name: "Check your recovery key" });
  for (let n = 0; n < 3; n += 1) pickRight(key);
  await screen.findByRole("heading", { level: 1, name: "All items" });
}

// ---- The two steps, from the menu ----

test("new_vault_from_the_menu_runs_setups_two_steps", async () => {
  await unlocked([vault(7, "My vault")]);
  // The vault menu has both actions, beside Lock and Rename (Task 8).
  const menu = await openVaultMenu();
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

  // 18b, in the approved screen's words: not the first screens' (no "Create your vault", no "Most people only need one", no Back); nothing has been sent.
  await toTheForm();
  expect(screen.getByText("Step 1 of 2")).toBeTruthy();
  expect(screen.getByText(SAY_NEW_VAULT)).toBeTruthy();
  expect(screen.getByText(NAME_HINT)).toBeTruthy();
  expect(screen.getByText("At least 12 characters.")).toBeTruthy();
  expect(screen.getByLabelText("Vault name")).toBeTruthy();
  expect(screen.getByLabelText("Password")).toBeTruthy();
  expect(screen.getByLabelText("Repeat the password")).toBeTruthy();
  expect(screen.getByText("Where it lives")).toBeTruthy();
  expect(screen.getByText("Kept in your Lockbox Vaults folder on this PC.")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Choose another" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Continue" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  for (const first of ["Create your vault", "Create vault", "Back", "Password again", "Change"]) {
    expect(screen.queryByRole("heading", { name: first }), first).toBeNull();
    expect(screen.queryByRole("button", { name: first }), first).toBeNull();
    expect(screen.queryByLabelText(first), first).toBeNull();
  }
  expect(screen.queryByText(/Most people only need one/)).toBeNull();
  expect(sent("create_vault")).toEqual([]);
  expect(debugState().newVault).not.toBeNull();
  fill("Home", NEW);
  create();

  // 21c: the key, as step 2 of 2, for the new vault, which is on screen.
  await screen.findByRole("heading", { level: 1, name: "Save your recovery key" });
  expect(screen.getByText("Step 2 of 2")).toBeTruthy();
  expect(sent("create_vault")).toEqual([{ name: "Home", password: NEW, choose_folder: false }]);
  const key = madeKey(8);
  for (const word of wordsOf(key)) expect(screen.getAllByText(word).length, word).toBeGreaterThan(0);
  // The look for the key's words on the page finds them while the key is shown (so a clean result later means something).
  expect(keyWordsOnPage(key).length).toBeGreaterThan(0);
  expect(debugState().newVault).toBeNull();
  expect(foundOnPage([NEW])).toEqual([]);

  // 21d: three questions, and the vault opens.
  await confirmKey(8);
  expect(screen.getByRole("button", { name: "Home, vault menu" })).toBeTruthy();
  expect(keyWordsOnPage(key)).toEqual([]);
  expect(shell.unconfirmed(8)).toBe(false);
  // Both vaults are on the menu, open, and the new one is the one on screen.
  const after = await openVaultMenu();
  expect(rowsOf(after).map((row) => row.textContent)).toEqual(["My vaultUnlocked", "HomeUnlocked"]);
  expect(rowsOf(after).map((row) => row.getAttribute("aria-checked"))).toEqual(["false", "true"]);
});

test("the_new_session_carries_the_id_from_the_answer", async () => {
  // A list that can't be read again after the create does not leave the session without its vault: the answer's ID is the session's, and the vault is put on the list.
  await unlocked([vault(7, "My vault")]);
  await toTheForm();
  fill("Home", NEW);
  shell.refuseNext("list_vaults", { code: "core", kind: "io" });
  create();
  await screen.findByRole("heading", { level: 1, name: "Save your recovery key" });
  await waitFor(() => {
    expect(debugState().vaults?.map((entry) => entry.id)).toEqual([7, 8]);
  });
  expect(debugState().sessions.map((one) => one.vaultId)).toEqual([7, 8]);
  expect(debugState().vaults?.find((entry) => entry.id === 8)).toEqual({ list: shell.listIdentity(), id: 8, name: "Home", available: true, details_damaged: false });
  await confirmKey(8);
  const menu = await openVaultMenu();
  expect(rowsOf(menu).map((row) => row.textContent)).toEqual(["My vaultUnlocked", "HomeUnlocked"]);
  expect(rowsOf(menu).map((row) => row.getAttribute("aria-checked"))).toEqual(["false", "true"]);
});

test("the_new_session_takes_its_own_id_when_another_vault_was_listed_at_once", async () => {
  // An add in another window lands on the list right after the create: a page that took the newest vault of the list would take that one.
  await unlocked([vault(7, "My vault")]);
  await toTheForm();
  fill("Home", NEW);
  shell.listAlongsideNextCreate(vault(0, "Other window's vault"));
  create();
  await screen.findByRole("heading", { level: 1, name: "Save your recovery key" });
  await waitFor(() => {
    expect(debugState().vaults?.map((entry) => entry.id)).toEqual([7, 8, 9]);
  });
  expect(debugState().sessions.map((one) => [one.vaultId, one.name])).toEqual([
    [7, "My vault"],
    [8, "Home"],
  ]);
  await confirmKey(8);
  const menu = await openVaultMenu();
  expect(rowsOf(menu).map((row) => row.textContent)).toEqual(["My vaultUnlocked", "HomeUnlocked", "Other window's vaultLocked"]);
  expect(rowsOf(menu).map((row) => row.getAttribute("aria-checked"))).toEqual(["false", "true", "false"]);
});

test("the_other_vaults_stay_open_through_creation", async () => {
  await allOpen([vault(7, "My vault"), vault(8, "Home")]);
  const first = debugState().sessions[0];
  const release = shell.holdCreate();
  await toTheForm();
  fill("Work", NEW);
  create();
  await waitFor(() => {
    expect(sent("create_vault")).toHaveLength(1);
  });
  // While the answer is out, nothing of the open vaults is touched.
  expect(shell.sessionOf(7)?.unlocked).toBe(true);
  expect(shell.sessionOf(8)?.unlocked).toBe(true);
  act(() => {
    release();
  });
  await screen.findByRole("heading", { level: 1, name: "Save your recovery key" });
  expect(sent("lock_vault")).toEqual([]);
  expect(sent("lock_all")).toEqual([]);
  expect(shell.sessionOf(7)?.unlocked).toBe(true);
  expect(shell.sessionOf(8)?.unlocked).toBe(true);
  expect(shell.sessionOf(9)?.unlocked).toBe(true);
  expect(debugState().sessions.map((one) => one.vaultId)).toEqual([7, 8, 9]);
  expect(debugState().sessions[0]).toBe(first);
  await confirmKey(9);
  // All three are open on the menu; the first one is exactly as it was, and switching to it shows its items.
  const menu = await openVaultMenu();
  expect(rowsOf(menu).map((row) => row.textContent)).toEqual(["My vaultUnlocked", "HomeUnlocked", "WorkUnlocked"]);
  fireEvent.click(rowsOf(menu)[0] as HTMLElement);
  await screen.findByRole("button", { name: "My vault, vault menu" });
  expect(screen.getByRole("heading", { level: 1, name: "All items" })).toBeTruthy();
  expect(debugState().sessions[2]).toBe(first);
});

// ---- 18c and the refusals ----

test("a_cloud_folder_warns_and_a_removable_fat32_or_network_drive_is_refused", async () => {
  await unlocked([vault(7, "My vault")]);
  await toTheForm();
  // A removable, FAT32 or network drive (or any folder the location check refuses): said under "Where it lives", with the passwords empty and nothing made.
  for (const what of ["removable drive", "network drive", "drive type not supported", "file system not supported"]) {
    fill("Home", NEW);
    shell.refuseNext("create_vault", { code: "invalid_input", what });
    create();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent, what).toBe(DRIVE);
    // 18c puts it in the part about where the vault lives, beside Choose another.
    expect(alert.parentElement?.textContent, what).toContain("Where it lives");
    expect(passwordBox().value).toBe("");
    expect(againBox().value).toBe("");
    expect(foundOnPage(SECRETS)).toEqual([]);
    expect(debugState().sessions.map((one) => one.vaultId)).toEqual([7]);
    expect(screen.getByRole("heading", { level: 1, name: "New vault" })).toBeTruthy();
  }
  expect(shell.keyOf(8)).toBeUndefined();

  fill("Home", NEW);
  shell.cloudNext();
  create();
  // 18c: the warning is on the New vault screen, as step 1 of 2, and nothing made.
  await cloudWarning();
  expect(screen.getByText("Step 1 of 2")).toBeTruthy();
  expect(screen.getByText(SAY_NEW_VAULT)).toBeTruthy();
  expect(shell.keyOf(8)).toBeUndefined();
  expect(sent("create_vault_confirm")).toEqual([]);
  expect(foundOnPage([NEW])).toEqual([]);
  // No: back to the form with the name kept, and the passwords empty (they were sent and are gone).
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await screen.findByRole("button", { name: "Continue" });
  expect(nameBox().value).toBe("Home");
  expect(passwordBox().value).toBe("");
  expect(againBox().value).toBe("");
  expect(sent("create_vault_confirm")).toEqual([]);

  // Choose another: back to the form, set to pick the folder, with the passwords to type again.
  fill("Home", NEW);
  shell.cloudNext();
  create();
  await cloudWarning();
  fireEvent.click(screen.getByRole("button", { name: "Choose another" }));
  await screen.findByRole("button", { name: "Continue" });
  expect(screen.getByText("You'll pick the folder when you press Continue.")).toBeTruthy();
  expect(passwordBox().value).toBe("");
  // Four refused drives, then the two sends that asked about the cloud.
  expect(sent("create_vault")).toHaveLength(6);
  fill("Home", NEW);
  create();
  await screen.findByRole("heading", { level: 1, name: "Save your recovery key" });
  expect(sent("create_vault")[6]).toEqual({ name: "Home", password: NEW, choose_folder: true });
});

test("a_cloud_folder_that_is_confirmed_makes_the_vault_with_the_token", async () => {
  await unlocked([vault(7, "My vault")]);
  await toTheForm();
  fill("Home", NEW);
  shell.cloudNext();
  create();
  await cloudWarning();
  fireEvent.click(screen.getByRole("button", { name: "Continue anyway" }));
  await screen.findByRole("heading", { level: 1, name: "Save your recovery key" });
  expect(sent("create_vault_confirm")).toEqual([{ token: expect.stringMatching(/^create-token-/) as unknown }]);
  expect(debugState().sessions.map((one) => one.vaultId)).toEqual([7, 8]);
  expect(foundOnPage([NEW])).toEqual([]);
});

// The warning replaces the form on the same screen, so the button that was pressed is gone: focus goes to Continue anyway (the screen reader reads its name, and the
// warning, which the button is described by), and back to the password box on the way back, which is where the person types again.
test("the_cloud_warning_takes_focus_to_continue_anyway_and_is_read_with_it", async () => {
  await unlocked([vault(7, "My vault")]);
  await toTheForm();
  fill("Home", NEW);
  shell.cloudNext();
  create();
  await cloudWarning();
  const go = screen.getByRole("button", { name: "Continue anyway" });
  await waitFor(() => {
    expect(document.activeElement).toBe(go);
  });
  // The warning is read with the button: it is the button's description.
  const described = go.getAttribute("aria-describedby") ?? "";
  expect(described).not.toBe("");
  expect(document.getElementById(described)?.textContent).toBe(CLOUD_WARNING);
});

test("cancel_and_choose_another_on_the_cloud_warning_give_focus_to_the_password_box", async () => {
  await unlocked([vault(7, "My vault")]);
  await toTheForm();
  for (const way of ["Cancel", "Choose another"]) {
    fill("Home", NEW);
    shell.cloudNext();
    create();
    await cloudWarning();
    fireEvent.click(screen.getByRole("button", { name: way }));
    await screen.findByRole("button", { name: "Continue" });
    await waitFor(() => {
      expect(document.activeElement, way).toBe(passwordBox());
    });
    expect(passwordBox().value).toBe("");
  }
});

test("vault_made_but_not_listed_says_so_and_add_existing_is_reachable", async () => {
  await unlocked([vault(7, "My vault")]);
  await toTheForm();
  fill("Home", NEW);
  shell.refuseNext("create_vault", VAULT_NOT_LISTED);
  create();
  // From inside, the words point at a control that is there: the vault menu's Add existing vault folder.
  expect((await screen.findByRole("alert")).textContent).toBe(NOT_LISTED_INSIDE);
  expect(screen.getByRole("heading", { level: 1, name: "New vault" })).toBeTruthy();
  expect(debugState().sessions.map((one) => one.vaultId)).toEqual([7]);
  expect(foundOnPage(SECRETS)).toEqual([]);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await screen.findByRole("button", { name: "My vault, vault menu" });

  // The vault on the disk is added from the menu, with the other vault still open; its unlock step opens, and 21f follows its unlock.
  shell.offerExisting(vault(9, "Home", { password: NEW, unconfirmed: true }));
  await chooseAction("Add existing vault folder");
  await screen.findByRole("heading", { level: 1, name: "Unlock Home" });
  expect(sent("add_existing_vault")).toHaveLength(1);
  // The list gives the added row its own next ID (the vault that was made and not listed took none): 8, whatever the folder's old number was.
  expect(debugState().unlockStep).toMatchObject({ vault: 8 });
  expect(debugState().sessions.map((one) => one.vaultId)).toEqual([7]);
  typeAndSendUnlock(NEW);
  await screen.findByRole("heading", { level: 1, name: "Finish your recovery key" });
  expect(debugState().sessions.map((one) => one.vaultId)).toEqual([7, 8]);
  expect(sent("lock_vault")).toEqual([]);
});

test("the_first_screens_keep_their_own_words_for_a_vault_made_but_not_listed", async () => {
  shell = installFakeShell(invoke, listen, []);
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "Create a vault" }));
  await screen.findByRole("heading", { level: 1, name: "Create your vault" });
  // The first screen keeps its own words (21b): not 18b's.
  expect(screen.queryByText(SAY_NEW_VAULT)).toBeNull();
  fireEvent.change(screen.getByLabelText("Vault name"), { target: { value: "Home" } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: NEW } });
  fireEvent.change(screen.getByLabelText("Password again"), { target: { value: NEW } });
  shell.refuseNext("create_vault", VAULT_NOT_LISTED);
  fireEvent.click(screen.getByRole("button", { name: "Create vault" }));
  expect((await screen.findByRole("alert")).textContent).toBe(FIRST_RUN_NOT_LISTED);
});

test("a_full_list_is_said_with_its_own_words_and_nothing_is_made", async () => {
  await unlocked([vault(7, "My vault")]);
  await toTheForm();
  fill("Home", NEW);
  shell.refuseNext("create_vault", VAULT_LIST_FULL);
  create();
  expect((await screen.findByRole("alert")).textContent).toBe(LIST_FULL);
  expect(debugState().sessions.map((one) => one.vaultId)).toEqual([7]);
  expect(passwordBox().value).toBe("");
  expect(foundOnPage(SECRETS)).toEqual([]);
});

test("add_existing_vault_folder_from_the_menu_asks_about_a_cloud_folder_and_says_a_refusal", async () => {
  await unlocked([vault(7, "My vault")]);
  // A folder that is not a vault: said on the window that is up (the shell's refusal, in words), and nothing changes.
  await chooseAction("Add existing vault folder");
  expect((await screen.findByRole("alert")).textContent).toContain("That folder isn't a Lockbox vault.");
  expect(debugState().addFolder).toBeNull();
  expect(screen.getByRole("button", { name: "My vault, vault menu" })).toBeTruthy();

  // A closed picker says nothing.
  shell.dismissPickerNext();
  await chooseAction("Add existing vault folder");
  await waitFor(() => {
    expect(sent("add_existing_vault")).toHaveLength(2);
  });
  expect(debugState().addFolder).toBeNull();
  expect(debugState().unlockStep).toBeNull();

  // A cloud folder asks first, with the first screens' question; No leaves the window as it was, Continue anyway adds it and opens its unlock step.
  shell.offerExisting(vault(9, "Old vault"));
  shell.cloudNext();
  await chooseAction("Add existing vault folder");
  expect(await screen.findByRole("heading", { level: 1, name: "This folder is synced to the cloud" })).toBeTruthy();
  expect(screen.queryByText(/^Step \d of \d$/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await screen.findByRole("button", { name: "My vault, vault menu" });
  expect(sent("add_existing_vault_confirm")).toEqual([]);
  shell.cloudNext();
  await chooseAction("Add existing vault folder");
  await screen.findByRole("heading", { level: 1, name: "This folder is synced to the cloud" });
  fireEvent.click(screen.getByRole("button", { name: "Continue anyway" }));
  await screen.findByRole("heading", { level: 1, name: "Unlock Old vault" });
  expect(sent("add_existing_vault_confirm")).toEqual([{ token: expect.stringMatching(/^add-token-/) as unknown }]);
  expect(debugState().sessions.map((one) => one.vaultId)).toEqual([7]);
});

test("a_lock_epoch_takes_the_cloud_question_of_an_add", async () => {
  await unlocked([vault(7, "My vault")]);
  shell.offerExisting(vault(9, "Old vault"));
  shell.cloudNext();
  await chooseAction("Add existing vault folder");
  await screen.findByRole("heading", { level: 1, name: "This folder is synced to the cloud" });
  expect(debugState().addFolder).toMatchObject({ phase: "cloud" });
  await act(async () => {
    shell.changeLockEpoch("idle");
    await Promise.resolve();
  });
  expect(debugState().addFolder).toBeNull();
  expect(screen.queryByRole("heading", { name: "This folder is synced to the cloud" })).toBeNull();
  expect(debugState().unlockStep).toBeNull();
});

// ---- Cancel ----

test("back_from_new_vault_returns_to_the_vault_on_screen", async () => {
  await allOpen([vault(7, "My vault"), vault(8, "Home")]);
  await toTheForm();
  fill("Work", TYPED);
  expect(foundOnPage([TYPED])).toEqual([`a field holds ${TYPED}`, `a field holds ${TYPED}`]);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  // The vault that was on screen is back, as it was; nothing was sent, and nothing typed is left.
  await screen.findByRole("button", { name: "Home, vault menu" });
  expect(screen.getByRole("heading", { level: 1, name: "All items" })).toBeTruthy();
  expect(debugState().newVault).toBeNull();
  expect(sent("create_vault")).toEqual([]);
  expect(foundOnPage(SECRETS)).toEqual([]);
  expect(debugState().sessions.map((one) => one.vaultId)).toEqual([7, 8]);
  // Focus goes back to the vault menu's button, which opened the form, not to the page's heading.
  await waitFor(() => {
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Home, vault menu" }));
  });

  // Escape is Cancel too, and the form opened again starts empty.
  await toTheForm();
  expect(passwordBox().value).toBe("");
  expect(againBox().value).toBe("");
  fireEvent.change(passwordBox(), { target: { value: TYPED } });
  fireEvent.keyDown(passwordBox(), { key: "Escape" });
  await screen.findByRole("button", { name: "Home, vault menu" });
  await waitFor(() => {
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Home, vault menu" }));
  });
  expect(foundOnPage(SECRETS)).toEqual([]);
  expect(sent("create_vault")).toEqual([]);
});

// ---- A lock overtaking the create ----

test("locked_before_creation_could_say_says_so_on_the_new_vaults_unlock", async () => {
  // Two vaults of the same name: the words must land on the new one (ID 8) by its ID, never on the old "My vault" (ID 7) by its name.
  await unlocked([vault(7, "My vault")]);
  await toTheForm();
  fill("My vault", NEW);
  shell.interruptCreateNext("lock_after_create_as_error");
  create();
  // The vault was made and listed, then everything locked: the lock screen, with the list read again.
  await screen.findByRole("heading", { level: 1, name: "Unlock a vault" });
  await waitFor(() => {
    expect(debugState().vaults?.map((entry) => entry.id)).toEqual([7, 8]);
  });
  expect(debugState().sessions).toEqual([]);
  expect(debugState().newVault).toBeNull();
  expect(debugState().lockNotes).toEqual([{ vault: 8, refusal: { code: "locked_after_change", what: "vault created", vault: 8 } }]);
  // The words are on that vault's unlock alone: not on the first row, which has the same name, and on the second.
  const rows = screen.getAllByRole("radio", { name: /My vault/ });
  expect(rows).toHaveLength(2);
  expect(screen.queryByText(LOCKED_BEFORE)).toBeNull();
  fireEvent.click(rows[0] as HTMLElement);
  expect(screen.queryByText(LOCKED_BEFORE)).toBeNull();
  fireEvent.click(rows[1] as HTMLElement);
  expect((await screen.findByText(LOCKED_BEFORE)).textContent).toBe(LOCKED_BEFORE);
  expect(screen.queryByText(/The change was made/)).toBeNull();
  // Its unlock uses the note up, and 21f makes the key that was never seen.
  typeAndSendUnlock(NEW);
  await screen.findByRole("heading", { level: 1, name: "Finish your recovery key" });
  expect(debugState().lockNotes).toEqual([]);
  expect(foundOnPage([NEW])).toEqual([]);
});

test("a_lock_that_overtakes_a_create_with_other_vaults_open_says_it_on_the_unlock_step_from_the_menu", async () => {
  // The same words on the unlock step: a vault that was unlocked again first, then the new vault's row.
  await unlocked([vault(7, "My vault")]);
  await toTheForm();
  fill("Home", NEW);
  shell.interruptCreateNext("lock_after_create_as_error");
  create();
  await screen.findByRole("heading", { level: 1, name: "Unlock a vault" });
  fireEvent.click(screen.getByRole("radio", { name: /My vault/ }));
  typeAndSendUnlock(PASSWORD);
  await screen.findByRole("button", { name: "My vault, vault menu" });
  expect(debugState().lockNotes).toHaveLength(1);
  await chooseRow(/^Home/);
  await screen.findByRole("heading", { level: 1, name: "Unlock Home" });
  expect((await screen.findByText(LOCKED_BEFORE)).textContent).toBe(LOCKED_BEFORE);
});

test("a_lock_before_the_vault_was_made_or_a_good_answer_the_bridge_drops_says_nothing", async () => {
  // Before anything was made: no vault, no key, nothing said.
  await unlocked([vault(7, "My vault")]);
  await toTheForm();
  fill("Home", NEW);
  shell.interruptCreateNext("lock_before_create");
  create();
  await screen.findByRole("heading", { level: 1, name: "Unlock My vault" });
  expect(debugState().vaults?.map((entry) => entry.id)).toEqual([7]);
  expect(debugState().lockNotes).toEqual([]);
  expect(debugState().sessions).toEqual([]);
  expect(screen.queryByRole("alert")).toBeNull();

  // Made and opened, then locked, the good answer dropped as stale: the list is read again, the key never reaches the page, nothing is said.
  cleanup();
  resetStoreForTests();
  invoke.mockReset();
  listen.mockReset();
  await unlocked([vault(7, "My vault")]);
  await toTheForm();
  fill("Home", NEW);
  shell.interruptCreateNext("lock_after_create");
  create();
  await screen.findByRole("heading", { level: 1, name: "Unlock a vault" });
  await waitFor(() => {
    expect(debugState().vaults?.map((entry) => entry.id)).toEqual([7, 8]);
  });
  expect(debugState().lockNotes).toEqual([]);
  expect(debugState().sessions).toEqual([]);
  // A key was made (so the look below is for 24 real words), and none of them is on the page.
  expect(keyWordsOnPage(madeKey(8))).toEqual([]);
  expect(screen.queryByRole("alert")).toBeNull();
});

// ---- Typed secrets ----

test("new_vault_wipes_the_typed_passwords_pending_refused_back_and_locked", async () => {
  const list = () => [vault(7, "My vault"), vault(8, "Home")];
  // Pending: the fields, the page and the store are clear the moment it is sent, before the answer comes, and the fields can't be typed in meanwhile.
  await allOpen(list());
  const release = shell.holdCreate();
  await toTheForm();
  fill("Work", NEW);
  expect(foundOnPage([NEW])).toEqual([`a field holds ${NEW}`, `a field holds ${NEW}`]);
  create();
  await waitFor(() => {
    expect(sent("create_vault")).toHaveLength(1);
  });
  expect(passwordBox().value).toBe("");
  expect(againBox().value).toBe("");
  expect(foundOnPage(SECRETS)).toEqual([]);
  expect(passwordBox().readOnly).toBe(true);
  expect(againBox().readOnly).toBe(true);
  fireEvent.change(passwordBox(), { target: { value: PENDING } });
  expect(passwordBox().value).toBe("");
  fireEvent.submit(passwordBox().form as HTMLFormElement);
  expect(sent("create_vault")).toHaveLength(1);
  act(() => {
    release();
  });
  await screen.findByRole("heading", { level: 1, name: "Save your recovery key" });
  expect(foundOnPage(SECRETS)).toEqual([]);

  // Refused: empty fields with the reason, and nothing of the typed password anywhere. Typed again, it goes through.
  cleanup();
  resetStoreForTests();
  invoke.mockReset();
  listen.mockReset();
  await allOpen(list());
  await toTheForm();
  fill("Work", TYPED);
  shell.refuseNext("create_vault", { code: "core", kind: "io" });
  create();
  expect((await screen.findByRole("alert")).textContent).toBe("Lockbox couldn't reach that folder or file. Check that the drive is connected, then try again.");
  expect(passwordBox().value).toBe("");
  expect(againBox().value).toBe("");
  expect(passwordBox().readOnly).toBe(false);
  expect(foundOnPage(SECRETS)).toEqual([]);
  fill("Work", NEW);
  create();
  await screen.findByRole("heading", { level: 1, name: "Save your recovery key" });

  // Cancel: typed and not sent, then Cancel, and nothing is left.
  cleanup();
  resetStoreForTests();
  invoke.mockReset();
  listen.mockReset();
  await allOpen(list());
  await toTheForm();
  fill("Work", TYPED);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await screen.findByRole("button", { name: "Home, vault menu" });
  expect(foundOnPage(SECRETS)).toEqual([]);

  // A lock epoch (Lock all, idle, Windows locking) that reaches the page while the form is up wipes what is typed, and ends the form.
  await toTheForm();
  fill("Work", TYPED);
  await act(async () => {
    shell.changeLockEpoch("idle");
    await Promise.resolve();
  });
  expect(foundOnPage(SECRETS)).toEqual([]);
  expect(debugState().newVault).toBeNull();

  // Every open vault locks while the form is up (the lock events come): the lock screen follows with nothing typed on it, and the form is gone from the store.
  cleanup();
  resetStoreForTests();
  invoke.mockReset();
  listen.mockReset();
  await unlocked(list());
  await toTheForm();
  fill("Work", TYPED);
  act(() => {
    shell.lock(shell.sessionOf(7)?.session ?? 0);
  });
  await screen.findByRole("heading", { level: 1, name: "Unlock a vault" });
  expect(foundOnPage(SECRETS)).toEqual([]);
  expect(debugState().newVault).toBeNull();
  expect(sent("create_vault")).toEqual([]);

  // A lock after the send, before the answer is read: the key that the late answer carries never reaches the page, and the typed text is gone.
  cleanup();
  resetStoreForTests();
  invoke.mockReset();
  listen.mockReset();
  await unlocked(list());
  const late = shell.holdCreate();
  await toTheForm();
  fill("Work", NEW);
  create();
  await waitFor(() => {
    expect(sent("create_vault")).toHaveLength(1);
  });
  act(() => {
    shell.lock(shell.sessionOf(7)?.session ?? 0);
    shell.lock(shell.sessionOf(9)?.session ?? 0);
  });
  await screen.findByRole("heading", { level: 1, name: "Unlock a vault" });
  act(() => {
    late();
  });
  await act(async () => {
    await Promise.resolve();
  });
  expect(foundOnPage(SECRETS)).toEqual([]);
  expect(keyWordsOnPage(madeKey(9))).toEqual([]);
  expect(screen.queryByRole("heading", { name: "Save your recovery key" })).toBeNull();
});

// ---- Axe ----

test("new_vault_screens_have_no_axe_violations", async () => {
  const { container } = await unlocked([vault(7, "My vault")]);
  // The vault menu with its two actions.
  const menu = await openVaultMenu();
  await expectNoAxe(menu);
  fireEvent.keyDown(menu, { key: "Escape" });
  await waitFor(() => {
    expect(screen.queryByRole("menu")).toBeNull();
  });
  // The form, empty and with a refusal on it.
  await toTheForm();
  await expectNoAxe(document.body);
  fill("Home", NEW);
  shell.refuseNext("create_vault", VAULT_NOT_LISTED);
  create();
  await screen.findByRole("alert");
  await expectNoAxe(document.body);
  // A drive refused, said under "Where it lives".
  fill("Home", NEW);
  shell.refuseNext("create_vault", { code: "invalid_input", what: "removable drive" });
  create();
  await screen.findByText(DRIVE);
  await expectNoAxe(document.body);
  // The cloud warning, on the same screen.
  fill("Home", NEW);
  shell.cloudNext();
  create();
  await cloudWarning();
  await expectNoAxe(document.body);
  fireEvent.click(screen.getByRole("button", { name: "Continue anyway" }));
  // The key, and its questions.
  await screen.findByRole("heading", { level: 1, name: "Save your recovery key" });
  await expectNoAxe(document.body);
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  await screen.findByRole("heading", { level: 1, name: "Check your recovery key" });
  await expectNoAxe(document.body);
  expect(container.querySelectorAll("style, [style]")).toHaveLength(0);
});

test("the_inside_new_vault_form_draws_its_places_pattern", async () => {
  // 18b draws the new vault's own pattern, by the place it will take at the end of the list: with two listed, the third
  // place's six points (as the unlock step draws a vault's), on the form and on its cloud warning; the first-use screens
  // keep the setup screens' nine.
  const drawn = () => document.querySelector("svg.rose path")?.getAttribute("d");
  const pattern = (points: number) => {
    const { container, unmount } = render(<Pattern points={points} />);
    const d = container.querySelector("path")?.getAttribute("d");
    unmount();
    return d;
  };
  await unlocked([vault(7, "My vault"), vault(8, "Home")]);
  await toTheForm();
  expect(drawn()).toBe(pattern(6));
  fill("Work", NEW);
  shell.cloudNext();
  create();
  await cloudWarning();
  expect(drawn()).toBe(pattern(6));
  cleanup();
  resetStoreForTests();
  render(<CreateVault onBack={() => undefined} />);
  expect(drawn()).toBe(pattern(9));
});

// ---- Plan 4C Task 13b: 18c names the service and says where the folder is ----

test("the_cloud_warning_names_the_service_the_shell_found_and_where_the_folder_is", async () => {
  await unlocked([vault(7, "My vault")]);
  await toTheForm();
  const names = [
    ["OneDrive", "OneDrive"],
    ["GoogleDrive", "Google Drive"],
    ["Dropbox", "Dropbox"],
    ["Other", "A cloud service"],
  ] as const;
  for (const [provider, said] of names) {
    fill("Home", NEW);
    shell.cloudNext(provider);
    create();
    await screen.findByRole("button", { name: "Continue anyway" });
    // 18c's words, with the service by its everyday name ("A cloud service" only when the shell can't name it), never the shell's spelling.
    const warning = `${said} syncs this folder. Lockbox doesn't support vaults in cloud folders. Choose a folder on this PC, or continue anyway.`;
    expect(screen.getByText(warning), provider).toBeTruthy();
    expect(document.body.textContent).not.toContain("GoogleDrive");
    // Where the path was drawn, the folder's place in words (as 18b says it), beside Choose another: here the usual folder.
    const place = screen.getByText("Kept in your Lockbox Vaults folder.");
    expect(place.parentElement?.contains(screen.getByRole("button", { name: "Choose another" }))).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await screen.findByRole("button", { name: "Continue" });
  }
  // A folder the person picked says so.
  fireEvent.click(screen.getByRole("button", { name: "Choose another" }));
  fill("Home", NEW);
  shell.cloudNext("OneDrive");
  create();
  await screen.findByRole("button", { name: "Continue anyway" });
  expect(screen.getByText("Kept in the folder you picked.")).toBeTruthy();
  expect(screen.queryByText("Kept in your Lockbox Vaults folder.")).toBeNull();
});
