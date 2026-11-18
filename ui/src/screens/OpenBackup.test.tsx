// Plan 4B Task 7's screens: open a backup read-only (25a), browse it labelled read-only (25b), copy an item out into a vault in use (25c), and the question
// when the backup lacks some of the item's files (25d); the vault menu's rows for every open session; the buttons that lead here. Every case runs through the
// real App against the pretend shell, as a person reaches it. The picked backup's path is only ever in the shell: the page holds its name and size, and the choice
// it waits under. The typed password or recovery key is the box's own state, wiped as it is sent and on every lock.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import App from "../App";
import { debugState, resetStoreForTests, unlock } from "../store";
import { expectNoAxe } from "../testing/axe";
import {
  BACKUP_NAME,
  BACKUP_PASSWORD,
  FOLDER_2,
  installFakeShell,
  itemId,
  PASSWORD,
  sampleItems,
  type FakeItem,
  type FakeOlderCopy,
  type FakeShell,
  type FakeVault,
} from "../testing/fakeShell";

const { invoke, listen } = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));

afterEach(() => {
  cleanup();
});

let shell: FakeShell;

beforeEach(() => {
  for (const style of document.querySelectorAll("style")) style.remove();
  resetStoreForTests();
  invoke.mockReset();
  listen.mockReset();
});

const MB = 1024 ** 2;
const BIG = Math.round(1.2 * 1024 ** 3);
const LABEL = "Password or recovery key from when it was made";
const WRONG = "Wrong password. It needs the one from the day this backup was made, which may not be today's.";
const EXPIRED = "That choice has expired. Pick the backup again.";
/** What the backup's session is called: the file's name without `.lockbox-backup`. */
const BACKUP = "My vault 2026-10-02";
const BACKUP_MENU = `${BACKUP}, read-only, vault menu`;
/** The lock screen's step says the file and its size as one line. */
const LOCK_ROW = `${BACKUP_NAME}, 1.2 GB`;
const PUT_BACK = "Put this item back in a vault you're using.";
const NOWHERE = "Unlock a vault first, then copy into it.";
const OLDER = "My vault.before-restore";
const ANY_REQUEST = expect.any(Number) as number;

function mine(): FakeVault {
  return { id: 7, name: "My vault", items: sampleItems() };
}

/** A second vault with two folders of its own, neither named as the login's folder in the backup. */
function home(): FakeVault {
  return {
    id: 8,
    name: "Home",
    items: [
      { id: FOLDER_2, kind: "collection", title: "Lineproof" },
      { id: itemId(0xf3), kind: "collection", title: "Slotted" },
    ],
  };
}

async function typePassword(password = PASSWORD) {
  const field = await screen.findByLabelText(/^Password for /);
  fireEvent.change(field, { target: { value: password } });
  fireEvent.submit((field as HTMLInputElement).form as HTMLFormElement);
}

/** One vault, unlocked through the lock screen. */
async function unlocked(list: FakeVault[] = [mine()]) {
  shell = installFakeShell(invoke, listen, list);
  const view = render(<App />);
  await typePassword();
  await screen.findByRole("heading", { level: 1, name: "All items" });
  return view;
}

/** Two vaults open: My vault first, then Home, which is the one on screen. */
async function twoVaults() {
  const view = await unlocked([mine(), home()]);
  await act(async () => {
    expect(await unlock(8, PASSWORD)).toBe("opened");
  });
  await screen.findByRole("button", { name: "Home, vault menu" });
  return view;
}

function side(): HTMLElement {
  return screen.getByRole("navigation", { name: "Vault and folders" });
}

function sent(cmd: string): Record<string, unknown>[] {
  return invoke.mock.calls.filter(([name]) => name === cmd).map(([, args]) => args as Record<string, unknown>);
}

function press(inside: HTMLElement, name: string | RegExp) {
  fireEvent.click(within(inside).getByRole("button", { name }));
}

function buttonsIn(place: HTMLElement): (string | null)[] {
  return within(place)
    .getAllByRole("button")
    .map((button) => button.getAttribute("aria-label") ?? button.textContent);
}

function box(inside: HTMLElement = document.body): HTMLInputElement {
  return within(inside).getByLabelText<HTMLInputElement>(LABEL);
}

function type(text: string, inside: HTMLElement = document.body) {
  fireEvent.change(box(inside), { target: { value: text } });
}

/** The one launch-scoped job the shell says is running (the open). */
function theJob() {
  const [job, ...others] = shell.runningLaunchJobs();
  expect(others).toEqual([]);
  if (job === undefined) throw new Error("no job is running");
  return job;
}

function toast(): string {
  return document.querySelector(".tstack")?.textContent ?? "";
}

/** Opens a menu the way a click does, and gives the menu. */
async function openMenu(button: HTMLElement): Promise<HTMLElement> {
  button.focus();
  fireEvent.pointerDown(button, { button: 0 });
  fireEvent.click(button);
  return screen.findByRole("menu");
}

/** Settings, then its Open a backup row: the picker (the pretend shell's) chooses a file, and 25a opens on it. */
async function openPanel(): Promise<HTMLElement> {
  fireEvent.click(within(side()).getByRole("button", { name: "Settings" }));
  const settings = await screen.findByRole("complementary", { name: "Settings" });
  press(settings, "Open a backup");
  return screen.findByRole("complementary", { name: "Open a backup" });
}

/** The whole way in from a window: the panel, the right password, and the backup is the window. */
async function openTheBackup(): Promise<void> {
  const panel = await openPanel();
  type(BACKUP_PASSWORD, panel);
  press(panel, "Open read-only");
  await screen.findByRole("button", { name: BACKUP_MENU });
  await screen.findByRole("heading", { level: 1, name: "All items" });
}

async function select(title: string): Promise<HTMLElement> {
  fireEvent.click(await screen.findByRole("button", { name: new RegExp(String.raw`^(Login|Key|Note|File):\s*${title}`) }));
  return screen.findByRole("complementary", { name: title });
}

async function pickOption(panel: HTMLElement, list: "Vault" | "Folder", name: string) {
  const trigger = await within(panel).findByRole("combobox", { name: list });
  fireEvent.pointerDown(trigger, { button: 0 });
  fireEvent.click(trigger);
  const options = await screen.findAllByRole("option");
  const option = options.find((one) => one.textContent === name);
  if (option === undefined) throw new Error(`no ${list} named ${name}`);
  fireEvent.pointerDown(option);
  fireEvent.click(option);
  await waitFor(() => {
    expect(within(panel).getByRole("combobox", { name: list }).textContent).toBe(name);
  });
}

function backupSession(): number {
  const live = shell.sessionOfBackup(BACKUP_NAME);
  if (live === undefined) throw new Error("the backup is not open");
  return live.session;
}

// ---- 25a: the panel ----

test("settings_open_a_backup_picks_first_and_shows_the_file_and_the_box", async () => {
  await unlocked();
  const panel = await openPanel();
  // The picker opened first, with nothing sent but the pick's own (no choice yet): the credential waits for a file.
  expect(sent("open_backup_pick")).toEqual([{ choice: null }]);
  expect(sent("open_backup_read_only")).toEqual([]);
  // 25a: the file's name and size as text, Pick another, the one box, Cancel and Open read-only.
  expect(within(panel).getByRole("heading", { level: 2, name: "Open a backup" })).toBeTruthy();
  expect(within(panel).getByText(BACKUP_NAME)).toBeTruthy();
  expect(within(panel).getByText("1.2 GB")).toBeTruthy();
  expect(within(panel).getAllByText("BAK")).toHaveLength(1);
  expect(buttonsIn(panel)).toEqual(["Close panel", "Pick another", "Show what you typed", "Cancel", "Open read-only"]);
  expect(box(panel).getAttribute("type")).toBe("password");
  // No path, in the page or in what it was told.
  expect(document.body.textContent).not.toMatch(/[A-Z]:[\\/]|\\Users/);
  expect(JSON.stringify(debugState())).not.toMatch(/[A-Z]:[\\/]|\\Users/);
  // Focus is on the step's heading, and Open read-only is off until something is typed.
  expect(document.activeElement).toBe(within(panel).getByRole("heading", { level: 2, name: "Open a backup" }));
  expect(within(panel).getByRole("button", { name: "Open read-only" }).getAttribute("aria-disabled")).toBe("true");
  press(panel, "Open read-only");
  expect(sent("open_backup_read_only")).toEqual([]);
  type("x", panel);
  expect(within(panel).getByRole("button", { name: "Open read-only" }).getAttribute("aria-disabled")).toBeNull();
});

test("open_backup_field_turns_off_spellcheck_and_autocomplete", async () => {
  await unlocked();
  const panel = await openPanel();
  const field = box(panel);
  expect(field.getAttribute("autocomplete")).toBe("off");
  expect(field.getAttribute("spellcheck")).toBe("false");
  expect(field.getAttribute("autocorrect")).toBe("off");
  expect(field.getAttribute("autocapitalize")).toBe("off");
  // Shown, the same box: it is a text box then, still never kept or corrected.
  press(panel, "Show what you typed");
  expect(box(panel).getAttribute("type")).toBe("text");
  expect(box(panel).getAttribute("autocomplete")).toBe("off");
  expect(box(panel).getAttribute("spellcheck")).toBe("false");
  // And on the lock screen's own steps.
  cleanup();
  resetStoreForTests();
  invoke.mockReset();
  listen.mockReset();
  shell = installFakeShell(invoke, listen, [mine()]);
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "Open a backup" }));
  await screen.findByRole("heading", { level: 1, name: "Open a backup" });
  expect(box().getAttribute("autocomplete")).toBe("off");
  expect(box().getAttribute("spellcheck")).toBe("false");
  expect(box().getAttribute("autocorrect")).toBe("off");
  expect(box().getAttribute("autocapitalize")).toBe("off");
});

test("a_closed_picker_opens_nothing_and_says_nothing", async () => {
  await unlocked();
  fireEvent.click(within(side()).getByRole("button", { name: "Settings" }));
  const settings = await screen.findByRole("complementary", { name: "Settings" });
  shell.dismissFileNext();
  press(settings, "Open a backup");
  await waitFor(() => {
    expect(sent("open_backup_pick")).toHaveLength(1);
  });
  await act(async () => {
    await new Promise((done) => window.setTimeout(done, 5));
  });
  // Settings is as it was, and Open a backup can be pressed again.
  expect(screen.queryByRole("complementary", { name: "Open a backup" })).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(debugState().openBackup).toBeNull();
  expect(shell.openChoices()).toEqual([]);
  press(settings, "Open a backup");
  await screen.findByRole("complementary", { name: "Open a backup" });
});

test("a_second_press_while_the_picker_is_open_sends_nothing", async () => {
  await unlocked();
  fireEvent.click(within(side()).getByRole("button", { name: "Settings" }));
  const settings = await screen.findByRole("complementary", { name: "Settings" });
  const release = shell.holdPicker();
  press(settings, "Open a backup");
  await waitFor(() => {
    expect(debugState().openBackup?.phase).toBe("picking");
  });
  press(settings, "Open a backup");
  expect(sent("open_backup_pick")).toHaveLength(1);
  act(() => {
    release();
  });
  await screen.findByRole("complementary", { name: "Open a backup" });
  expect(sent("open_backup_pick")).toHaveLength(1);
});

test("pick_another_sends_the_choice_it_has_and_swaps_the_file", async () => {
  await unlocked();
  const panel = await openPanel();
  const choice = shell.openChoiceTokens()[0];
  expect(choice).toMatch(/^[0-9a-f]{32}$/);
  shell.pickBackupNext("Older vault 2026-08-01.lockbox-backup", 5 * MB);
  press(panel, "Pick another");
  await within(panel).findByText("Older vault 2026-08-01.lockbox-backup");
  expect(sent("open_backup_pick")[1]).toEqual({ choice });
  expect(within(panel).getByText("5 MB")).toBeTruthy();
  expect(within(panel).queryByText(BACKUP_NAME)).toBeNull();
  // The shell forgot the first choice and holds the new one; the page never touched the test's commands.
  expect(shell.openChoices()).toEqual([{ name: "Older vault 2026-08-01.lockbox-backup", size: 5 * MB }]);
  expect(sent("test_backup_pick")).toEqual([]);
  // A closed picker leaves the file as it was.
  shell.dismissFileNext();
  press(panel, "Pick another");
  await waitFor(() => {
    expect(sent("open_backup_pick")).toHaveLength(3);
  });
  await act(async () => {
    await new Promise((done) => window.setTimeout(done, 5));
  });
  expect(within(panel).getByText("Older vault 2026-08-01.lockbox-backup")).toBeTruthy();
  expect(within(panel).queryByRole("alert")).toBeNull();
});

test("open_sends_the_choice_the_typed_text_as_one_box_and_a_request_and_nothing_else", async () => {
  await unlocked();
  const panel = await openPanel();
  const choice = shell.openChoiceTokens()[0];
  type(BACKUP_PASSWORD, panel);
  press(panel, "Open read-only");
  await screen.findByRole("button", { name: BACKUP_MENU });
  expect(sent("open_backup_read_only")).toEqual([{ choice, credential: { password_or_key: BACKUP_PASSWORD }, request: ANY_REQUEST }]);
  // The session is new and read-only, a backup, named as its file and on no vault list; it is the window now, and the panel is gone.
  const opened = debugState().sessions.at(-1);
  expect(opened?.name).toBe(BACKUP);
  expect(opened?.readOnly).toBe(true);
  expect(opened?.kind).toBe("backup");
  expect(opened?.vaultId).toBeLessThan(0);
  expect(debugState().sessions).toHaveLength(2);
  expect(screen.queryByRole("complementary", { name: "Open a backup" })).toBeNull();
  expect(debugState().openBackup).toBeNull();
  // A session opened uses the choice up: the shell holds none and the page asks it to forget none.
  expect(shell.openChoiceTokens()).toEqual([]);
  expect(sent("forget_open_backup")).toEqual([]);
  expect(shell.backupsOpen()).toEqual([BACKUP_NAME]);
  // Nothing typed is on the page.
  expect(document.body.textContent).not.toContain(BACKUP_PASSWORD);
});

test("enter_in_the_box_opens_and_escape_closes_the_panel", async () => {
  await unlocked();
  let panel = await openPanel();
  const choice = shell.openChoiceTokens()[0];
  fireEvent.keyDown(panel, { key: "Escape" });
  await waitFor(() => {
    expect(screen.queryByRole("complementary", { name: "Open a backup" })).toBeNull();
  });
  expect(sent("forget_open_backup")).toEqual([{ choice }]);
  panel = await openPanel();
  type(BACKUP_PASSWORD, panel);
  fireEvent.submit(box(panel).form as HTMLFormElement);
  await screen.findByRole("button", { name: BACKUP_MENU });
  expect(sent("open_backup_read_only")).toHaveLength(1);
});

test("open_backup_keeps_the_pick_through_a_wrong_password", async () => {
  await unlocked();
  const panel = await openPanel();
  const choice = shell.openChoiceTokens()[0];
  type("today's password", panel);
  press(panel, "Open read-only");
  const alert = await within(panel).findByRole("alert");
  expect(alert.textContent).toBe(WRONG);
  // The box is empty and marked, the file is still picked and Open read-only is off until something is typed again.
  expect(box(panel).value).toBe("");
  expect(box(panel).getAttribute("aria-invalid")).toBe("true");
  expect(within(panel).getByText(BACKUP_NAME)).toBeTruthy();
  expect(within(panel).getByRole("button", { name: "Open read-only" }).getAttribute("aria-disabled")).toBe("true");
  // The shell keeps the choice (and the page told it to forget nothing); no session was made.
  expect(sent("forget_open_backup")).toEqual([]);
  expect(shell.openChoiceTokens()).toEqual([choice]);
  expect(debugState().sessions).toHaveLength(1);
  expect(document.body.textContent).not.toContain("today's password");
  expect(document.activeElement).toBe(within(panel).getByRole("heading", { level: 2, name: "Open a backup" }));
  // Typing again takes the line away.
  type("n", panel);
  expect(within(panel).queryByRole("alert")).toBeNull();
  expect(box(panel).getAttribute("aria-invalid")).toBeNull();
  // The right one, on the same choice, with no new pick; the choice is then used up.
  type(BACKUP_PASSWORD, panel);
  press(panel, "Open read-only");
  await screen.findByRole("button", { name: BACKUP_MENU });
  expect(sent("open_backup_read_only").map((call) => call.choice)).toEqual([choice, choice]);
  expect(sent("open_backup_pick")).toHaveLength(1);
  expect(shell.openChoiceTokens()).toEqual([]);
});

test("a_damaged_backup_says_so_under_the_row_and_keeps_the_pick", async () => {
  await unlocked();
  const panel = await openPanel();
  const choice = shell.openChoiceTokens()[0];
  shell.damageBackup("backup: damaged item");
  type(BACKUP_PASSWORD, panel);
  press(panel, "Open read-only");
  const alert = await within(panel).findByRole("alert");
  expect(alert.textContent).toBe(
    "An item in this backup doesn't match what the backup recorded, so it can't be trusted. Use another backup if you have one.",
  );
  expect(within(panel).getByText(BACKUP_NAME)).toBeTruthy();
  expect(shell.openChoiceTokens()).toEqual([choice]);
  expect(document.body.textContent).not.toMatch(/"kind"|"code"|backup: damaged item/);
});

test("progress_names_the_file_shows_the_bytes_and_stop_goes_back_to_the_file", async () => {
  await unlocked();
  const panel = await openPanel();
  const release = shell.holdOpen();
  type(BACKUP_PASSWORD, panel);
  press(panel, "Open read-only");
  const card = await screen.findByRole("region", { name: `Opening ${BACKUP_NAME}` });
  const job = theJob();
  // A launch-scoped job of kind "open_backup", matched to the request the page sent.
  expect(job.kind).toBe("open_backup");
  expect(job.scope.type).toBe("launch");
  expect(job.request).toBe(sent("open_backup_read_only")[0]?.request);
  act(() => {
    shell.sendProgress(job.operation, 750 * MB, BIG);
  });
  expect(within(card).getByText("750 MB of 1.2 GB")).toBeTruthy();
  // The box is gone while it works: nothing typed is on the page.
  expect(document.querySelectorAll("aside.panel input")).toHaveLength(0);
  // As drawn: the bar's card, with Stop in the panel's foot.
  expect(within(card).queryByRole("button")).toBeNull();
  fireEvent.click(within(panel.querySelector(".pbar") as HTMLElement).getByRole("button", { name: "Stop" }));
  // A stop is the person's own: back to 25a, the file still picked, the box empty, nothing said.
  const again = await screen.findByLabelText(LABEL);
  expect((again as HTMLInputElement).value).toBe("");
  expect(screen.getByText(BACKUP_NAME)).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(sent("cancel_operation")).toEqual([{ operation: job.operation, scope: job.scope }]);
  expect(sent("forget_open_backup")).toEqual([]);
  expect(shell.openChoiceTokens()).toHaveLength(1);
  expect(debugState().sessions).toHaveLength(1);
  act(() => {
    release();
  });
});

test("a_choice_the_shell_let_go_takes_the_file_with_it", async () => {
  await unlocked();
  const panel = await openPanel();
  shell.expireOpenChoices();
  type(BACKUP_PASSWORD, panel);
  press(panel, "Open read-only");
  const alert = await within(panel).findByRole("alert");
  expect(alert.textContent).toBe(EXPIRED);
  expect(within(panel).getByText("No backup picked.")).toBeTruthy();
  expect(within(panel).queryByText(BACKUP_NAME)).toBeNull();
  expect(within(panel).getByRole("button", { name: "Open read-only" }).getAttribute("aria-disabled")).toBe("true");
  // Pick a backup starts again.
  press(panel, "Pick a backup");
  await within(panel).findByText(BACKUP_NAME);
  expect(sent("open_backup_pick")[1]).toEqual({ choice: null });
  expect(within(panel).queryByRole("alert")).toBeNull();
});

test("cancel_lets_the_pick_go_and_closes_the_panel", async () => {
  await unlocked();
  const panel = await openPanel();
  const choice = shell.openChoiceTokens()[0];
  type("something typed", panel);
  press(panel, "Cancel");
  await waitFor(() => {
    expect(screen.queryByRole("complementary", { name: "Open a backup" })).toBeNull();
  });
  expect(sent("forget_open_backup")).toEqual([{ choice }]);
  expect(shell.openChoiceTokens()).toEqual([]);
  expect(debugState().openBackup).toBeNull();
  expect(document.body.textContent).not.toContain("something typed");
  // Focus goes back to Settings, where it began.
  await waitFor(() => {
    expect(document.activeElement).toBe(within(side()).getByRole("button", { name: "Settings" }));
  });
  // A second Open a backup is a new pick, with nothing of the first.
  const second = await openPanel();
  expect(box(second).value).toBe("");
  expect(sent("open_backup_pick")).toHaveLength(2);
});

test("another_panel_taking_the_window_lets_the_pick_go", async () => {
  await unlocked();
  await openPanel();
  const choice = shell.openChoiceTokens()[0];
  fireEvent.click(await screen.findByRole("button", { name: /^Login:\s*Bot admin console/ }));
  await screen.findByRole("complementary", { name: "Bot admin console" });
  expect(screen.queryByRole("complementary", { name: "Open a backup" })).toBeNull();
  await waitFor(() => {
    expect(sent("forget_open_backup")).toEqual([{ choice }]);
  });
  expect(debugState().openBackup).toBeNull();
});

test("a_lock_of_every_vault_wipes_the_typed_text_and_ends_the_flow", async () => {
  await unlocked();
  const panel = await openPanel();
  type("typed and not sent", panel);
  press(side(), "Lock all");
  await screen.findByLabelText(/^Password for /);
  expect(document.body.textContent).not.toContain("typed and not sent");
  expect(debugState().openBackup).toBeNull();
  expect(shell.openChoiceTokens()).toEqual([]);
  expect(screen.queryByRole("complementary", { name: "Open a backup" })).toBeNull();
  // Unlocked again, nothing of it comes back.
  await typePassword();
  await screen.findByRole("heading", { level: 1, name: "All items" });
  expect(screen.queryByRole("complementary", { name: "Open a backup" })).toBeNull();
  expect(document.body.textContent).not.toContain("typed and not sent");
});

test("a_lock_while_it_opens_ends_the_flow_and_shows_no_session", async () => {
  await unlocked();
  const panel = await openPanel();
  const release = shell.holdOpen();
  type(BACKUP_PASSWORD, panel);
  press(panel, "Open read-only");
  await screen.findByRole("region", { name: `Opening ${BACKUP_NAME}` });
  fireEvent.click(within(side()).getByRole("button", { name: "Lock all" }));
  await screen.findByLabelText(/^Password for /);
  act(() => {
    release();
  });
  await act(async () => {
    await new Promise((done) => window.setTimeout(done, 5));
  });
  // The shell answered `locked`: nothing is shown, nothing is said, and no backup session is open.
  expect(debugState().sessions).toEqual([]);
  expect(shell.backupsOpen()).toEqual([]);
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByLabelText(/^Password for /)).toBeTruthy();
});

test("an_open_that_ends_after_its_panel_closed_is_not_shown_and_is_locked_again", async () => {
  await unlocked();
  const panel = await openPanel();
  const release = shell.holdOpen();
  type(BACKUP_PASSWORD, panel);
  press(panel, "Open read-only");
  await screen.findByRole("region", { name: `Opening ${BACKUP_NAME}` });
  // The panel is closed while the shell works; the shell is asked to stop, but it had finished: it opens the session all the same.
  fireEvent.click(within(panel).getByRole("button", { name: "Close panel" }));
  await waitFor(() => {
    expect(debugState().openBackup).toBeNull();
  });
  act(() => {
    release();
  });
  await waitFor(() => {
    expect(shell.backupsOpen()).toEqual([]);
  });
  expect(debugState().sessions).toHaveLength(1);
});

test("a_second_open_of_the_same_backup_brings_it_to_the_front_as_it_is", async () => {
  await unlocked();
  await openTheBackup();
  const first = debugState().sessions.at(-1);
  // Back to the live vault through the menu, then the same file again: the shell answers the session it has, and the page shows that one.
  const menu = await openMenu(screen.getByRole("button", { name: BACKUP_MENU }));
  fireEvent.click(within(menu).getByRole("menuitemradio", { name: "My vault" }));
  await screen.findByRole("button", { name: "My vault, vault menu" });
  await openPanel();
  const panel = screen.getByRole("complementary", { name: "Open a backup" });
  type(BACKUP_PASSWORD, panel);
  press(panel, "Open read-only");
  await screen.findByRole("button", { name: BACKUP_MENU });
  expect(debugState().sessions).toHaveLength(2);
  expect(debugState().sessions.at(-1)).toBe(first);
});

// ---- The lock screen's own steps ----

test("open_backup_from_the_lock_screen_shows_full_screen", async () => {
  shell = installFakeShell(invoke, listen, [mine()]);
  const { container } = render(<App />);
  await screen.findByLabelText(/^Password for /);
  // A link beside Restore a backup, under the form.
  const links = screen.getAllByRole("button").map((button) => button.textContent);
  expect(links).toEqual(["Unlock", "Restore a backup", "Open a backup"]);
  fireEvent.click(screen.getByRole("button", { name: "Open a backup" }));
  // The same steps, full-screen on the setup frame: no panel, no window, the page's banner and one heading.
  const heading = await screen.findByRole("heading", { level: 1, name: "Open a backup" });
  expect(sent("open_backup_pick")).toEqual([{ choice: null }]);
  expect(screen.queryByRole("complementary")).toBeNull();
  expect(screen.queryByRole("navigation", { name: "Vault and folders" })).toBeNull();
  expect(container.querySelector(".lock")).not.toBeNull();
  expect(screen.getByRole("banner").textContent).toContain("Lockbox");
  expect(document.activeElement).toBe(heading);
  // The file's name and size as one line of text, as the restore's first step has them.
  expect(screen.getByText(LOCK_ROW)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Pick another" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Open read-only" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  // A wrong password is said under the box and keeps the file.
  type("nope");
  fireEvent.click(screen.getByRole("button", { name: "Open read-only" }));
  expect((await screen.findByRole("alert")).textContent).toBe(WRONG);
  expect(box().value).toBe("");
  expect(screen.getByText(LOCK_ROW)).toBeTruthy();
  // Cancel goes back to the lock screen and lets the file go.
  const choice = shell.openChoiceTokens()[0];
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await screen.findByLabelText(/^Password for /);
  expect(sent("forget_open_backup")).toEqual([{ choice }]);
  // Again, and now the right password: the backup is the window, and the lock screen is gone.
  fireEvent.click(screen.getByRole("button", { name: "Open a backup" }));
  await screen.findByRole("heading", { level: 1, name: "Open a backup" });
  type(BACKUP_PASSWORD);
  fireEvent.click(screen.getByRole("button", { name: "Open read-only" }));
  await screen.findByRole("button", { name: BACKUP_MENU });
  expect(screen.queryByLabelText(/^Password for /)).toBeNull();
  expect(debugState().sessions.map((one) => one.kind)).toEqual(["backup"]);
  expect(debugState().openBackup).toBeNull();
});

test("the_lock_screens_steps_show_progress_and_a_lock_ends_them", async () => {
  shell = installFakeShell(invoke, listen, [mine()]);
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "Open a backup" }));
  await screen.findByRole("heading", { level: 1, name: "Open a backup" });
  const release = shell.holdOpen();
  type(BACKUP_PASSWORD);
  fireEvent.click(screen.getByRole("button", { name: "Open read-only" }));
  const card = await screen.findByRole("region", { name: `Opening ${BACKUP_NAME}` });
  expect(screen.getByRole("heading", { level: 1, name: `Opening ${BACKUP_NAME}` })).toBeTruthy();
  fireEvent.click(within(card).getByRole("button", { name: "Stop" }));
  await screen.findByLabelText(LABEL);
  expect(screen.getByText(LOCK_ROW)).toBeTruthy();
  act(() => {
    release();
  });
  // Typed and not sent, then every vault locks (the lock screen has none open: a lock epoch is all the shell sends): the text and the flow go.
  type("typed and not sent");
  act(() => {
    shell.changeLockEpoch("idle");
  });
  await screen.findByLabelText(/^Password for /);
  expect(document.body.textContent).not.toContain("typed and not sent");
  expect(debugState().openBackup).toBeNull();
});

// ---- 25b: the opened backup ----

test("read_only_label_on_every_screen_of_that_session", async () => {
  await unlocked();
  await openTheBackup();
  // The header: the session's name, which is the file's, and the Read-only chip; the live vault's own name is not on it.
  const head = screen.getByRole("button", { name: BACKUP_MENU });
  expect(within(head).getByText(BACKUP)).toBeTruthy();
  expect(head.querySelector(".chip")?.textContent).toBe("Read-only");
  expect(within(side()).queryByText("My vault", { selector: "b" })).toBeNull();
  // No writing: no Add, no New folder.
  expect(screen.queryByRole("button", { name: "Add" })).toBeNull();
  expect(within(side()).queryByRole("button", { name: "New folder" })).toBeNull();
  // The item's panel: the chip, and the line under the title says where it is from, not a folder and a date.
  const panel = await select("Bot admin console");
  expect(within(panel).getByText("Read-only", { selector: ".chip" })).toBeTruthy();
  expect(within(panel).getByText("Login · from this backup")).toBeTruthy();
  expect(within(panel).queryByRole("button", { name: "Edit" })).toBeNull();
  expect(within(panel).queryByRole("button", { name: "Move to trash" })).toBeNull();
  // The Trash: a picked row's panel carries the chip too.
  fireEvent.click(within(side()).getByRole("button", { name: /^Trash\s+\d+$/ }));
  fireEvent.click(await screen.findByRole("button", { name: /Old login in the trash/ }));
  const trashed = await screen.findByRole("complementary", { name: "Old login in the trash" });
  expect(within(trashed).getByText("Read-only", { selector: ".chip" })).toBeTruthy();
  // Settings.
  fireEvent.click(within(side()).getByRole("button", { name: "Settings" }));
  const settings = await screen.findByRole("complementary", { name: "Settings" });
  expect(within(settings).getByText("Read-only", { selector: ".chip" })).toBeTruthy();
  // The live vault's own screens carry no chip: back to it through the menu.
  const menu = await openMenu(screen.getByRole("button", { name: BACKUP_MENU }));
  fireEvent.click(within(menu).getByRole("menuitemradio", { name: "My vault" }));
  await screen.findByRole("button", { name: "My vault, vault menu" });
  expect(document.querySelector(".chip")).toBeNull();
});

test("older_copy_header_says_older_copy", async () => {
  shell = installFakeShell(invoke, listen, [mine()]);
  shell.olderCopies([{ vault: 7, folder: OLDER, last_written: "2026-11-04", size: 1_000_000 } satisfies FakeOlderCopy]);
  render(<App />);
  await typePassword();
  await screen.findByRole("heading", { level: 1, name: "All items" });
  fireEvent.click(within(side()).getByRole("button", { name: "Settings" }));
  const settings = await screen.findByRole("complementary", { name: "Settings" });
  fireEvent.click(await within(settings).findByRole("button", { name: "Older copies (1)" }));
  const list = await screen.findByRole("complementary", { name: "Older copies" });
  press(list, "Open read-only");
  fireEvent.change(within(list).getByLabelText<HTMLInputElement>("Password or recovery key for this copy"), { target: { value: PASSWORD } });
  press(list, "Open");
  // The header names what it is, with the chip: today it looks like the live vault.
  const head = await screen.findByRole("button", { name: "My vault, older copy, read-only, vault menu" });
  expect(within(head).getByText("My vault, older copy")).toBeTruthy();
  expect(head.querySelector(".chip")?.textContent).toBe("Read-only");
  expect(debugState().sessions.at(-1)?.kind).toBe("older_copy");
  const panel = await select("Bot admin console");
  expect(within(panel).getByText("Login · from this older copy")).toBeTruthy();
  expect(within(panel).getByText("Read-only", { selector: ".chip" })).toBeTruthy();
  // The vault menu says so too, under its name.
  const menu = await openMenu(head);
  const rows = within(menu).getAllByRole("menuitemradio");
  expect(rows.map((row) => row.textContent)).toEqual(["My vault", "My vault" + "Older copy"]);
});

test("save_a_copy_works_on_a_read_only_backup", async () => {
  await unlocked();
  await openTheBackup();
  const panel = await select("Client contract");
  // Read-only has no Replace file, and still has Open and Save a copy.
  expect(within(panel).queryByRole("button", { name: /^Replace file/ })).toBeNull();
  expect(within(panel).getByRole("button", { name: "Open contract-demo.pdf" })).toBeTruthy();
  const session = backupSession();
  const generation = shell.sessionOfBackup(BACKUP_NAME)?.generation;
  fireEvent.click(within(panel).getByRole("button", { name: "Save a copy of contract-demo.pdf" }));
  await waitFor(() => {
    expect(toast()).toContain("Saved a copy. It isn't encrypted. Delete it when you're finished.");
  });
  // The ids of the backup's own session go, and the shell wrote the copy.
  expect(sent("save_file_copy")).toEqual([{ session, generation, id: itemId(4), file_id: itemId(0xa1), request: ANY_REQUEST }]);
  expect(shell.fileOps).toEqual([{ cmd: "save_file_copy", id: itemId(4), file_id: itemId(0xa1) }]);
  expect(await screen.findByRole("button", { name: BACKUP_MENU })).toBeTruthy();
});

// ---- 25c: copy to a vault ----

test("copy_to_a_vault_sends_the_chosen_vault_and_folder", async () => {
  await twoVaults();
  await openTheBackupFrom("Home, vault menu");
  const panel = await select("Bot admin console");
  // As drawn (25b): the sentence and the button, in every read-only session's item.
  expect(within(panel).getByText(PUT_BACK)).toBeTruthy();
  fireEvent.click(within(panel).getByRole("button", { name: "Copy to a vault" }));
  // 25c: Vault first, with the vault most recently unlocked chosen; Folder lists that vault's folders and No folder, "No folder" chosen because Home has none
  // named as the item's folder in the backup.
  expect(within(panel).getByRole("combobox", { name: "Vault" }).textContent).toBe("Home");
  expect(within(panel).getByRole("combobox", { name: "Folder" }).textContent).toBe("No folder");
  expect(buttonsIn(panel).slice(-2)).toEqual(["Cancel", "Copy"]);
  // Another vault: its folder named as the item's folder in the backup is chosen, and the form never lists the backup itself.
  await pickOption(panel, "Vault", "My vault");
  expect(within(panel).getByRole("combobox", { name: "Folder" }).textContent).toBe("Agency support agent");
  fireEvent.pointerDown(within(panel).getByRole("combobox", { name: "Vault" }), { button: 0 });
  fireEvent.click(within(panel).getByRole("combobox", { name: "Vault" }));
  expect((await screen.findAllByRole("option")).map((option) => option.textContent)).toEqual(["Home", "My vault"]);
  fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
  await waitFor(() => {
    expect(screen.queryAllByRole("option")).toEqual([]);
  });
  await pickOption(panel, "Folder", "Lineproof");
  press(panel, "Copy");
  await waitFor(() => {
    expect(toast()).toContain("Copied to My vault.");
  });
  const mineSession = shell.sessionOf(7);
  expect(sent("copy_item_to")).toEqual([
    {
      from: backupSession(),
      from_generation: shell.sessionOfBackup(BACKUP_NAME)?.generation,
      id: itemId(1),
      to: mineSession?.session,
      to_generation: mineSession?.generation,
      folder: FOLDER_2,
      skip_missing: false,
    },
  ]);
  expect(shell.copiedOut).toHaveLength(1);
  expect(shell.copiedOut[0]).toMatchObject({ id: itemId(1), folder: FOLDER_2, skipMissing: false });
  // Done: the form is closed and the window stays on the backup.
  expect(within(panel).queryByRole("combobox", { name: "Vault" })).toBeNull();
  expect(screen.getByRole("button", { name: BACKUP_MENU })).toBeTruthy();
  expect(debugState().sessions.at(-1)?.kind).toBe("backup");
  // The vault the item went into reads its list again, so the copy is there when it is looked at.
  await waitFor(() => {
    expect(debugState().sessions.find((one) => one.vaultId === 7)?.items?.some((one) => one.title === "Bot admin console" && one.collection === FOLDER_2)).toBe(true);
  });
});

test("the_folder_of_the_same_name_is_chosen_and_cancel_closes_the_form_with_nothing_sent", async () => {
  await twoVaults();
  await openTheBackupFrom("Home, vault menu");
  const panel = await select("Bot admin console");
  fireEvent.click(within(panel).getByRole("button", { name: "Copy to a vault" }));
  await pickOption(panel, "Vault", "My vault");
  // "Agency support agent" is the folder the login is in, in the backup, and My vault has one of that name.
  expect(within(panel).getByRole("combobox", { name: "Folder" }).textContent).toBe("Agency support agent");
  press(panel, "Cancel");
  expect(within(panel).queryByRole("combobox", { name: "Vault" })).toBeNull();
  expect(sent("copy_item_to")).toEqual([]);
  // Opened again, the form starts again from its own defaults.
  fireEvent.click(within(panel).getByRole("button", { name: "Copy to a vault" }));
  expect(within(panel).getByRole("combobox", { name: "Vault" }).textContent).toBe("Home");
});

test("a_refusal_of_the_copy_is_said_in_the_form_through_the_words_table", async () => {
  await twoVaults();
  await openTheBackupFrom("Home, vault menu");
  const panel = await select("Bot admin console");
  fireEvent.click(within(panel).getByRole("button", { name: "Copy to a vault" }));
  shell.refuseNext("copy_item_to", { code: "core", kind: "invalid_input", what: "collection" });
  press(panel, "Copy");
  const alert = await within(panel).findByRole("alert");
  expect(alert.textContent).not.toMatch(/collection|invalid_input|"code"/);
  expect(alert.textContent.length).toBeGreaterThan(10);
  // The form stays for another try, and nothing is said as done.
  expect(within(panel).getByRole("combobox", { name: "Vault" })).toBeTruthy();
  expect(toast()).not.toContain("Copied");
  expect(shell.copiedOut).toEqual([]);
});

test("copy_asks_before_leaving_files_out", async () => {
  await twoVaults();
  shell.backupHolds(withMissing(["console-access-demo.pdf"]));
  await openTheBackupFrom("Home, vault menu");
  const panel = await select("Bot admin console");
  fireEvent.click(within(panel).getByRole("button", { name: "Copy to a vault" }));
  press(panel, "Copy");
  // 25d: nothing is copied, and the question names the file and the kind of item.
  const dialog = await screen.findByRole("dialog", { name: "Copy without these files?" });
  expect(
    within(dialog).getByText("This backup doesn't have console-access-demo.pdf, which is attached to this item. The login will copy without it."),
  ).toBeTruthy();
  expect(buttonsIn(dialog)).toEqual(["Cancel", "Copy without them"]);
  expect(shell.copiedOut).toEqual([]);
  expect(sent("copy_item_to")).toHaveLength(1);
  expect(sent("copy_item_to")[0]?.skip_missing).toBe(false);
  // Cancel leaves the form as it was, with nothing copied.
  press(dialog, "Cancel");
  await waitFor(() => {
    expect(screen.queryByRole("dialog", { name: "Copy without these files?" })).toBeNull();
  });
  expect(within(panel).getByRole("combobox", { name: "Vault" }).textContent).toBe("Home");
  expect(shell.copiedOut).toEqual([]);
  expect(sent("copy_item_to")).toHaveLength(1);
  // Copy again, and Copy without them sends it again with `skip_missing`, to the same vault and folder.
  press(panel, "Copy");
  const second = await screen.findByRole("dialog", { name: "Copy without these files?" });
  press(second, "Copy without them");
  await waitFor(() => {
    expect(toast()).toContain("Copied to Home, without the files the backup doesn't have.");
  });
  // Three sends: the first Copy, the second (each asked), and Copy without them, which is the second sent again with `skip_missing`.
  const all = sent("copy_item_to");
  expect(all.map((args) => args.skip_missing)).toEqual([false, false, true]);
  expect(all[2]).toEqual({ ...all[1], skip_missing: true });
  expect(shell.copiedOut).toHaveLength(1);
  expect(shell.copiedOut[0]).toMatchObject({ skipMissing: true, folder: null });
  expect(within(panel).queryByRole("combobox", { name: "Vault" })).toBeNull();
});

test("copy_without_them_goes_to_the_vault_the_question_was_about", async () => {
  // The question is asked about Home; Home locks while it is open. Copy without them must not go to the vault the form would pick now (My vault).
  await twoVaults();
  shell.backupHolds(withMissing(["console-access-demo.pdf"]));
  await openTheBackupFrom("Home, vault menu");
  const panel = await select("Bot admin console");
  fireEvent.click(within(panel).getByRole("button", { name: "Copy to a vault" }));
  press(panel, "Copy");
  const dialog = await screen.findByRole("dialog", { name: "Copy without these files?" });
  expect(sent("copy_item_to")).toHaveLength(1);
  act(() => {
    shell.lock(shell.sessionOf(8)?.session ?? 0);
  });
  await waitFor(() => {
    expect(debugState().sessions.map((one) => one.vaultId)).not.toContain(8);
  });
  press(dialog, "Copy without them");
  await act(async () => {
    await new Promise((done) => window.setTimeout(done, 5));
  });
  // Nothing was sent to anyone, nothing was copied, and nothing is said.
  expect(sent("copy_item_to")).toHaveLength(1);
  expect(shell.copiedOut).toEqual([]);
  expect(toast()).not.toContain("Copied");
  expect(screen.queryByRole("alert")).toBeNull();
});

test("a_missing_files_answer_for_another_backup_opens_no_question_and_sends_nothing", async () => {
  // Two backups share every item ID. The question is asked about the second; the person switches to the first before the answer reaches the page.
  await unlocked();
  shell.backupHolds(withMissing(["console-access-demo.pdf"]));
  await openTheBackup();
  const first = backupSession();
  // The login is open in the first backup too, so switching back finds the same item ID open: the panel must not be the second's.
  await select("Bot admin console");
  const live = await openMenu(screen.getByRole("button", { name: BACKUP_MENU }));
  fireEvent.click(within(live).getByRole("menuitemradio", { name: "My vault" }));
  await screen.findByRole("button", { name: "My vault, vault menu" });
  shell.pickBackupNext("Other 2026-09-01.lockbox-backup", MB);
  const panel = await openPanel();
  type(BACKUP_PASSWORD, panel);
  press(panel, "Open read-only");
  await screen.findByRole("button", { name: "Other 2026-09-01, read-only, vault menu" });
  const second = shell.sessionOfBackup("Other 2026-09-01.lockbox-backup")?.session;
  expect(second).not.toBe(first);
  const item = await select("Bot admin console");
  fireEvent.click(within(item).getByRole("button", { name: "Copy to a vault" }));
  const release = shell.holdCopy();
  press(item, "Copy");
  await waitFor(() => {
    expect(sent("copy_item_to")).toHaveLength(1);
  });
  // To the first backup, and its own login (the same ID): a form of its own, nothing of the second's.
  const menu = await openMenu(screen.getByRole("button", { name: "Other 2026-09-01, read-only, vault menu" }));
  fireEvent.click(within(menu).getByRole("menuitemradio", { name: new RegExp(`^${BACKUP}`) }));
  await screen.findByRole("button", { name: BACKUP_MENU });
  const mine_ = await screen.findByRole("complementary", { name: "Bot admin console" });
  expect(within(mine_).queryByRole("combobox", { name: "Vault" })).toBeNull();
  act(() => {
    release();
  });
  await act(async () => {
    await new Promise((done) => window.setTimeout(done, 5));
  });
  // No question opens here, nothing more is sent (and so nothing is copied from the wrong backup), nothing is said.
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(within(mine_).queryByRole("combobox", { name: "Vault" })).toBeNull();
  expect(sent("copy_item_to")).toHaveLength(1);
  expect(sent("copy_item_to")[0]?.from).toBe(second);
  expect(shell.copiedOut).toEqual([]);
  expect(toast()).not.toContain("Copied");
});

test("cancel_and_the_toggle_are_off_while_a_copy_is_sent_and_the_form_shows_the_answer", async () => {
  await twoVaults();
  shell.backupHolds(withMissing(["console-access-demo.pdf"]));
  await openTheBackupFrom("Home, vault menu");
  const panel = await select("Bot admin console");
  fireEvent.click(within(panel).getByRole("button", { name: "Copy to a vault" }));
  const release = shell.holdCopy();
  press(panel, "Copy");
  await waitFor(() => {
    expect(sent("copy_item_to")).toHaveLength(1);
  });
  const form = within(panel).getByRole("form", { name: "Copy to a vault" });
  // There is no Stop for a copy: Copy, Cancel and the button that opened the form are all off, and the form says what is happening.
  await waitFor(() => {
    expect(within(form).getByRole("button", { name: "Copy" }).getAttribute("aria-disabled")).toBe("true");
  });
  expect(within(form).getByRole("button", { name: "Cancel" }).getAttribute("aria-disabled")).toBe("true");
  expect(within(panel).getByRole("button", { name: "Copy to a vault" }).getAttribute("aria-disabled")).toBe("true");
  expect(within(form).getByText("Copying the item.")).toBeTruthy();
  fireEvent.click(within(form).getByRole("button", { name: "Cancel" }));
  fireEvent.click(within(panel).getByRole("button", { name: "Copy to a vault" }));
  fireEvent.click(within(form).getByRole("button", { name: "Copy" }));
  expect(within(panel).getByRole("form", { name: "Copy to a vault" })).toBe(form);
  expect(sent("copy_item_to")).toHaveLength(1);
  act(() => {
    release();
  });
  // The answer is a question here: the form is still there under it, and Cancel works again once it has answered.
  const dialog = await screen.findByRole("dialog", { name: "Copy without these files?" });
  // (The window under a question is hidden from the tree, so the form is read as it is in the page.)
  expect(form.isConnected).toBe(true);
  expect(within(form).getByRole("button", { name: "Cancel", hidden: true }).getAttribute("aria-disabled")).toBeNull();
  press(dialog, "Cancel");
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  // A copy that is let through closes the form when it answers, and says it.
  const again = shell.holdCopy();
  press(panel, "Copy");
  await waitFor(() => {
    expect(sent("copy_item_to")).toHaveLength(2);
  });
  act(() => {
    again();
  });
  const second = await screen.findByRole("dialog", { name: "Copy without these files?" });
  const done = shell.holdCopy();
  press(second, "Copy without them");
  await waitFor(() => {
    expect(sent("copy_item_to")).toHaveLength(3);
  });
  expect(within(panel).getByRole("button", { name: "Copy to a vault" }).getAttribute("aria-disabled")).toBe("true");
  act(() => {
    done();
  });
  await waitFor(() => {
    expect(toast()).toContain("Copied to Home, without the files the backup doesn't have.");
  });
  expect(within(panel).queryByRole("form", { name: "Copy to a vault" })).toBeNull();
  expect(within(panel).getByRole("button", { name: "Copy to a vault" }).getAttribute("aria-disabled")).toBeNull();
});

test("a_copy_for_a_session_that_locked_unheard_says_nothing_and_copies_nothing", async () => {
  // Either side of the copy locked and the page has not heard: the shell refuses as locked, and the page says nothing (the lock's own event is what clears the window).
  for (const side_ of ["target", "source"] as const) {
    cleanup();
    resetStoreForTests();
    invoke.mockReset();
    listen.mockReset();
    await twoVaults();
    await openTheBackupFrom("Home, vault menu");
    const panel = await select("Bot admin console");
    fireEvent.click(within(panel).getByRole("button", { name: "Copy to a vault" }));
    shell.lockWithoutEvent(side_ === "target" ? (shell.sessionOf(8)?.session ?? 0) : backupSession());
    press(panel, "Copy");
    await waitFor(() => {
      expect(sent("copy_item_to")).toHaveLength(1);
    });
    await act(async () => {
      await new Promise((done) => window.setTimeout(done, 5));
    });
    expect(shell.copiedOut, side_).toEqual([]);
    expect(toast(), side_).not.toContain("Copied");
    expect(screen.queryByRole("alert"), side_).toBeNull();
  }
});

test("the_question_for_several_files_and_for_each_kind_of_item", async () => {
  await twoVaults();
  const lacking = (names: string[]) => ({
    attachments: names.map((name, at) => ({ file_id: itemId(0xc0 + at), name, length: 1024, media_type: "application/pdf" })),
    missingFiles: names,
  });
  shell.backupHolds([
    ...withMissing(["a.pdf", "b.pdf", "c.pdf"]).map((item) => {
      if (item.title === "Rotation steps") return { ...item, ...lacking(["n.pdf", "m.pdf"]) };
      // A file item holds its stored file beside the one the backup lacks.
      if (item.title === "Client contract") return { ...item, attachments: [...(item.attachments ?? []), ...lacking(["f.pdf"]).attachments], missingFiles: ["f.pdf"] };
      return item;
    }),
    { id: itemId(41), kind: "key", title: "OPENAI_API_KEY", collection: null, value: "v", ...lacking(["k.pdf"]) },
  ]);
  await openTheBackupFrom("Home, vault menu");
  const expectations: [string, string][] = [
    ["Bot admin console", "This backup doesn't have a.pdf, b.pdf and c.pdf, which are attached to this item. The login will copy without them."],
    ["Rotation steps", "This backup doesn't have n.pdf and m.pdf, which are attached to this item. The note will copy without them."],
    ["OPENAI_API_KEY", "This backup doesn't have k.pdf, which is attached to this item. The key will copy without it."],
    ["Client contract", "This backup doesn't have f.pdf, which is attached to this item. The file will copy without it."],
  ];
  for (const [title, words] of expectations) {
    const panel = await select(title);
    fireEvent.click(within(panel).getByRole("button", { name: "Copy to a vault" }));
    press(panel, "Copy");
    const dialog = await screen.findByRole("dialog", { name: "Copy without these files?" });
    expect(within(dialog).getByText(words)).toBeTruthy();
    press(dialog, "Cancel");
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
  }
  expect(shell.copiedOut).toEqual([]);
});

test("nowhere_to_copy_to_says_unlock_a_vault_first", async () => {
  // Opened from the lock screen: no vault is open, so there is nowhere to copy to.
  shell = installFakeShell(invoke, listen, [mine()]);
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "Open a backup" }));
  await screen.findByRole("heading", { level: 1, name: "Open a backup" });
  type(BACKUP_PASSWORD);
  fireEvent.click(screen.getByRole("button", { name: "Open read-only" }));
  await screen.findByRole("button", { name: BACKUP_MENU });
  const panel = await select("Bot admin console");
  fireEvent.click(within(panel).getByRole("button", { name: "Copy to a vault" }));
  // The form shows only the sentence and Cancel: no lists, no Copy.
  expect(within(panel).getByText(NOWHERE)).toBeTruthy();
  expect(within(panel).queryByRole("combobox")).toBeNull();
  expect(within(panel).queryByRole("button", { name: "Copy" })).toBeNull();
  expect(buttonsIn(panel).slice(-1)).toEqual(["Cancel"]);
  press(panel, "Cancel");
  expect(within(panel).queryByText(NOWHERE)).toBeNull();
  expect(sent("copy_item_to")).toEqual([]);
});

test("an_older_copy_and_a_backup_are_never_a_place_to_copy_to", async () => {
  // A live vault, an older copy of it and a backup are all open: the form lists the vault alone.
  shell = installFakeShell(invoke, listen, [mine()]);
  shell.olderCopies([{ vault: 7, folder: OLDER, last_written: "2026-11-04", size: MB } satisfies FakeOlderCopy]);
  render(<App />);
  await typePassword();
  await screen.findByRole("heading", { level: 1, name: "All items" });
  fireEvent.click(within(side()).getByRole("button", { name: "Settings" }));
  const settings = await screen.findByRole("complementary", { name: "Settings" });
  fireEvent.click(await within(settings).findByRole("button", { name: "Older copies (1)" }));
  const list = await screen.findByRole("complementary", { name: "Older copies" });
  press(list, "Open read-only");
  fireEvent.change(within(list).getByLabelText<HTMLInputElement>("Password or recovery key for this copy"), { target: { value: PASSWORD } });
  press(list, "Open");
  await screen.findByRole("button", { name: "My vault, older copy, read-only, vault menu" });
  // Another backup, opened from the older copy's window: its panel is that window's.
  await openTheBackup();
  const panel = await select("Bot admin console");
  fireEvent.click(within(panel).getByRole("button", { name: "Copy to a vault" }));
  const vaultList = await within(panel).findByRole("combobox", { name: "Vault" });
  expect(vaultList.textContent).toBe("My vault");
  fireEvent.pointerDown(vaultList, { button: 0 });
  fireEvent.click(vaultList);
  expect((await screen.findAllByRole("option")).map((option) => option.textContent)).toEqual(["My vault"]);
});

test("the_form_follows_a_vault_that_locks_while_it_is_open", async () => {
  await twoVaults();
  await openTheBackupFrom("Home, vault menu");
  const panel = await select("Bot admin console");
  fireEvent.click(within(panel).getByRole("button", { name: "Copy to a vault" }));
  expect(within(panel).getByRole("combobox", { name: "Vault" }).textContent).toBe("Home");
  // Home locks (its lock event is heard): the vault chosen is gone, and the first that is left is chosen.
  act(() => {
    shell.lock(shell.sessionOf(8)?.session ?? 0);
  });
  await waitFor(() => {
    expect(within(panel).getByRole("combobox", { name: "Vault" }).textContent).toBe("My vault");
  });
  // The last vault locks: the form says there is nowhere to go.
  act(() => {
    shell.lock(shell.sessionOf(7)?.session ?? 0);
  });
  await waitFor(() => {
    expect(within(panel).getByText(NOWHERE)).toBeTruthy();
  });
});

test("a_busy_copy_says_copying_the_item", async () => {
  await unlocked();
  await openTheBackup();
  const handler = listen.mock.calls.find(([name]) => name === "lockbox://busy")?.[1] as ((event: { payload: unknown }) => void) | undefined;
  if (handler === undefined) throw new Error("the page is not listening for busy");
  act(() => {
    handler({ payload: { session: backupSession(), operations: ["copy_item"] } });
  });
  expect(await screen.findByText("Copying the item.")).toBeTruthy();
  expect(screen.queryByText("Working.")).toBeNull();
});

// ---- The vault menu ----

test("vault_menu_lists_open_read_only_sessions", async () => {
  await unlocked();
  await openTheBackup();
  const menu = await openMenu(screen.getByRole("button", { name: BACKUP_MENU }));
  // A row for each open session, in a group of their own: the live vault, then the backup (the one on screen), each a menu item that says whether it is the current one.
  const group = within(menu).getByRole("group", { name: "Open now" });
  const rows = within(group).getAllByRole("menuitemradio");
  // Each vault is there once: an open one is a row only, with no "Unlocked" note beside it.
  expect(menu.querySelectorAll(".mnote")).toHaveLength(0);
  expect(menu.textContent).not.toContain("Unlocked");
  expect(rows.map((row) => row.textContent)).toEqual(["My vault", `${BACKUP}Backup`]);
  expect(rows.map((row) => row.getAttribute("aria-checked"))).toEqual(["false", "true"]);
  // Lock stays the menu's action, for the session on screen.
  expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual([`Lock ${BACKUP}`]);
  await expectNoAxe(menu);
  // Choosing the live vault's row brings it to the front: the window is the vault's, and the menu is shut.
  fireEvent.click(within(menu).getByRole("menuitemradio", { name: "My vault" }));
  await screen.findByRole("button", { name: "My vault, vault menu" });
  expect(screen.queryByRole("menu")).toBeNull();
  expect(debugState().sessions.at(-1)?.vaultId).toBe(7);
  expect(sent("lock_vault")).toEqual([]);
  // The marked one changed with it; the backup is still open, and its row is there.
  const again = await openMenu(screen.getByRole("button", { name: "My vault, vault menu" }));
  const next = within(again).getAllByRole("menuitemradio");
  expect(next.map((row) => row.getAttribute("aria-checked"))).toEqual(["true", "false"]);
  // Back to the backup, and Lock closes it on its own: the live vault is the window again, and no lock-all was sent.
  fireEvent.click(within(again).getByRole("menuitemradio", { name: new RegExp(`^${BACKUP}`) }));
  const third = await openMenu(await screen.findByRole("button", { name: BACKUP_MENU }));
  const closing = backupSession();
  fireEvent.click(within(third).getByRole("menuitem", { name: `Lock ${BACKUP}` }));
  await screen.findByRole("button", { name: "My vault, vault menu" });
  expect(sent("lock_vault")).toEqual([{ session: closing }]);
  expect(sent("lock_all")).toEqual([]);
  expect(shell.backupsOpen()).toEqual([]);
  expect(shell.sessionOf(7)?.unlocked).toBe(true);
  expect(debugState().sessions.map((one) => one.vaultId)).toEqual([7]);
  // The closed backup has no row any more.
  const last = await openMenu(screen.getByRole("button", { name: "My vault, vault menu" }));
  expect(within(last).queryAllByRole("menuitemradio").map((row) => row.textContent)).toEqual(["My vault"]);
});

test("a_locked_backup_has_no_row_and_a_locked_vault_stays_a_note", async () => {
  await unlocked([mine(), home()]);
  await openTheBackup();
  // Home was never unlocked: it is a note, not a row. Locking the live vault from outside leaves the backup, the only row.
  act(() => {
    shell.lock(shell.sessionOf(7)?.session ?? 0);
  });
  await waitFor(() => {
    expect(debugState().sessions.map((one) => one.kind)).toEqual(["backup"]);
  });
  const menu = await openMenu(screen.getByRole("button", { name: BACKUP_MENU }));
  expect(within(menu).getAllByRole("menuitemradio").map((row) => row.textContent)).toEqual([`${BACKUP}Backup`]);
  expect([...menu.querySelectorAll(".mnote")].map((row) => row.textContent)).toEqual(["My vaultLocked", "HomeLocked"]);
  // The backup is closed by its own lock; the live vault is not in the list now, so the lock screen follows.
  fireEvent.click(within(menu).getByRole("menuitem", { name: `Lock ${BACKUP}` }));
  await screen.findByLabelText(/^Password for /);
  expect(shell.backupsOpen()).toEqual([]);
});

test("the_vault_menu_rows_work_from_the_keyboard", async () => {
  await unlocked();
  await openTheBackup();
  const opener = screen.getByRole("button", { name: BACKUP_MENU });
  expect(opener.getAttribute("aria-haspopup")).toBe("menu");
  opener.focus();
  fireEvent.keyDown(opener, { key: "ArrowDown" });
  const menu = await screen.findByRole("menu");
  // A row is a menu item the arrow keys reach, and Enter (or Space) chooses it: the menu shuts and the window changes.
  await waitFor(() => {
    expect(menu.contains(document.activeElement)).toBe(true);
  });
  const rows = within(menu).getAllByRole("menuitemradio");
  const first = rows[0] as HTMLElement;
  first.focus();
  fireEvent.keyDown(first, { key: "Enter" });
  fireEvent.click(first);
  await screen.findByRole("button", { name: "My vault, vault menu" });
  expect(screen.queryByRole("menu")).toBeNull();
  // Escape shuts it with nothing changed, and focus is on the button again.
  const again = screen.getByRole("button", { name: "My vault, vault menu" });
  await openMenu(again);
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
  await waitFor(() => {
    expect(screen.queryByRole("menu")).toBeNull();
  });
  await waitFor(() => {
    expect(document.activeElement).toBe(again);
  });
  expect(debugState().sessions.at(-1)?.vaultId).toBe(7);
});

// ---- Every screen, axe ----

test("open_backup_screens_have_no_axe_violations", async () => {
  const { container } = await twoVaults();
  shell.backupHolds(withMissing(["console-access-demo.pdf"]));
  // 25a, with a wrong password under the box.
  const panel = await openPanel();
  await expectNoAxe(container);
  type("not it", panel);
  press(panel, "Open read-only");
  await within(panel).findByRole("alert");
  await expectNoAxe(container);
  // The bar.
  const release = shell.holdOpen();
  type(BACKUP_PASSWORD, panel);
  press(panel, "Open read-only");
  await screen.findByRole("region", { name: `Opening ${BACKUP_NAME}` });
  await expectNoAxe(container);
  act(() => {
    release();
  });
  await screen.findByRole("button", { name: BACKUP_MENU });
  // 25b, the item with its button, and 25c's form.
  const item = await select("Bot admin console");
  await expectNoAxe(container);
  fireEvent.click(within(item).getByRole("button", { name: "Copy to a vault" }));
  await within(item).findByRole("combobox", { name: "Vault" });
  await expectNoAxe(container);
  // 25d, over the window.
  press(item, "Copy");
  const dialog = await screen.findByRole("dialog", { name: "Copy without these files?" });
  await expectNoAxe(dialog);
  await expectNoAxe({ include: [document.body], exclude: [dialog] });
  press(dialog, "Cancel");
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  // Nowhere to copy to, and the vault menu with its rows.
  press(item, "Cancel");
  await expectNoAxe(container);
  const menu = await openMenu(screen.getByRole("button", { name: BACKUP_MENU }));
  await expectNoAxe(menu);
  fireEvent.keyDown(menu, { key: "Escape" });
});

test("the_lock_screens_steps_have_no_axe_violations", async () => {
  shell = installFakeShell(invoke, listen, [mine()]);
  const { container } = render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "Open a backup" }));
  await screen.findByRole("heading", { level: 1, name: "Open a backup" });
  await expectNoAxe(container);
  type("not it");
  fireEvent.click(screen.getByRole("button", { name: "Open read-only" }));
  await screen.findByRole("alert");
  await expectNoAxe(container);
  const release = shell.holdOpen();
  type(BACKUP_PASSWORD);
  fireEvent.click(screen.getByRole("button", { name: "Open read-only" }));
  await screen.findByRole("region", { name: `Opening ${BACKUP_NAME}` });
  await expectNoAxe(container);
  act(() => {
    release();
  });
});

// ---- helpers that need the above ----

/** The sample items, with the login's stored file (and the extra names) missing from the backup. */
function withMissing(names: string[]): FakeItem[] {
  return sampleItems().map((item) =>
    item.id === itemId(1)
      ? {
          ...item,
          attachments: names.map((name, at) => ({ file_id: itemId(0xb0 + at), name, length: 18_432, media_type: "application/pdf" })),
          missingFiles: names,
        }
      : item,
  );
}

/** The backup opened from Settings of the vault on screen (named by its menu button). */
async function openTheBackupFrom(menuName: string): Promise<void> {
  expect(screen.getByRole("button", { name: menuName })).toBeTruthy();
  await openTheBackup();
}
