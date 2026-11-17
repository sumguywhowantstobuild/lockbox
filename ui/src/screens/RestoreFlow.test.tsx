// Plan 4B Task 5's screens: restore a backup (24a to 24e), full-screen and app-level, from Settings and from the lock screen. Every case runs through the
// real App against the pretend shell. The picked backup's path and the typed credential stay in the shell: the page holds the file's name and size, a
// choice, and the text only until it is sent.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import App from "../App";
import { debugState, resetStoreForTests } from "../store";
import { expectNoAxe } from "../testing/axe";
import { BACKUP_NAME, BACKUP_PASSWORD, installFakeShell, PASSWORD, sampleItems, type FakeOlderCopy, type FakeShell, type FakeVault } from "../testing/fakeShell";

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

const GB = 1024 ** 3;
const MB = 1024 ** 2;
const BIG = Math.round(1.2 * GB);
const LABEL = "Password or recovery key from when it was made";
const SAY = "A restore keeps your current vault beside the restored one.";
const WRONG = "Wrong password. It needs the one from the day this backup was made, which may not be today's.";
const EXPIRED = "That choice has expired. Pick the backup again.";
const CANCELLED = "The restore was cancelled. Your vault is as it was.";
const KEEP_OPEN = "Keep the laptop open. Windows locking or sleeping cancels this.";
const WAITS = "This waits for your answer, however long you take. Only Windows locking or sleeping cancels it.";
const NO_SPACE = "Not enough space. This needs 1.2 GB, and that drive has 400 MB free.";
const WRONG_DRIVE = "A vault can't live on a removable, FAT32 or network drive. Choose a folder on this PC.";
const TOO_MANY = "There are too many older copies of this vault. Delete some, then restore again.";
const FILE_ROW = `${BACKUP_NAME}, 1.2 GB`;

function mine(extra: Partial<FakeVault> = {}): FakeVault[] {
  return [{ id: 7, name: "My vault", items: sampleItems(), ...extra }];
}

function sent(cmd: string): Record<string, unknown>[] {
  return invoke.mock.calls.filter(([name]) => name === cmd).map(([, args]) => args as Record<string, unknown>);
}

function press(name: string | RegExp, within_: HTMLElement = document.body) {
  fireEvent.click(within(within_).getByRole("button", { name }));
}

function spoken(): string {
  return document.querySelector(".live")?.textContent ?? "";
}

/** The page, on the lock screen. */
async function onTheLockScreen(list: FakeVault[] = mine()) {
  shell = installFakeShell(invoke, listen, list);
  const view = render(<App />);
  await screen.findByLabelText(/^Password for /);
  return view;
}

/** The page, with the vault unlocked. */
async function unlocked(list: FakeVault[] = mine()) {
  const view = await onTheLockScreen(list);
  const field = screen.getByLabelText(/^Password for /);
  fireEvent.change(field, { target: { value: PASSWORD } });
  fireEvent.submit((field as HTMLInputElement).form as HTMLFormElement);
  await screen.findByRole("heading", { level: 1, name: "All items", hidden: true });
  return view;
}

function heading(name: string): Promise<HTMLElement> {
  return screen.findByRole("heading", { level: 1, name });
}

/** The lock screen's link, then the first step (the picker has chosen a file). */
async function restoreFromTheLockScreen() {
  press("Restore a backup");
  await heading("Restore a backup");
}

async function restoreFromSettings() {
  fireEvent.click(within(screen.getByRole("navigation", { name: "Vault and folders" })).getByRole("button", { name: "Settings" }));
  const settings = await screen.findByRole("complementary", { name: "Settings" });
  press("Restore a backup", settings);
  await heading("Restore a backup");
}

/** A line of the step itself: the polite place beside it says a refusal in the same words, so the whole page would find them twice. */
function onScreen(text: string): HTMLElement {
  return within(screen.getByRole("main")).getByText(text);
}

function box(): HTMLInputElement {
  return screen.getByLabelText<HTMLInputElement>(LABEL);
}

function type(text: string) {
  fireEvent.change(box(), { target: { value: text } });
}

async function toTheFolder(text = BACKUP_PASSWORD) {
  type(text);
  press("Continue");
  await heading("Where it goes");
}

/** The copy is running (held), its job known to the page. */
async function toTheCopy() {
  const release = shell.holdRestoreCopy();
  await toTheFolder();
  press("Restore");
  await screen.findByRole("region", { name: "Checking and unpacking" });
  return release;
}

/** From the folder step to the replace question (a vault with this one's ID is there). */
async function toTheReplaceQuestion() {
  shell.restoreIs({ replaces: true });
  await toTheFolder();
  press("Restore");
  await heading("Replace your vault with this?");
}

function theJob() {
  const [job, ...others] = shell.runningLaunchJobs();
  expect(others).toEqual([]);
  if (job === undefined) throw new Error("no job is running");
  return job;
}

async function theEpochMoves(reason: string) {
  await act(async () => {
    shell.changeLockEpoch(reason);
    await Promise.resolve();
  });
}

test("backup_first_then_password_or_key", async () => {
  await onTheLockScreen();
  await restoreFromTheLockScreen();
  // The picker opened first, with nothing sent but the pick's own: no credential travels before a file is chosen.
  expect(sent("restore_pick")).toEqual([{ choice: null, vault: null }]);
  expect(sent("restore_check")).toEqual([]);
  // 24a, as drawn: the dark side's line, the file as text with its size, Pick another, the one box, its hint, Continue and Cancel.
  expect(document.querySelector("header.field .say")?.textContent).toBe(SAY);
  expect(screen.getByText(FILE_ROW)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Pick another" })).toBeTruthy();
  expect(screen.getByText("If it's wrong, you can try again without picking the file again.")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Continue" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  // The box takes a password or a recovery key and lets the browser keep, fill in or correct neither.
  expect(box().getAttribute("type")).toBe("password");
  expect(box().getAttribute("autocomplete")).toBe("off");
  expect(box().getAttribute("spellcheck")).toBe("false");
  expect(box().getAttribute("autocorrect")).toBe("off");
  expect(box().getAttribute("autocapitalize")).toBe("off");
  // No path, in the page or in what it was told.
  expect(document.body.textContent).not.toMatch(/[A-Z]:[\\/]|\\Users/);
  expect(JSON.stringify(debugState())).not.toMatch(/[A-Z]:[\\/]|\\Users/);
  // Focus is on the step's heading.
  expect(document.activeElement).toBe(screen.getByRole("heading", { level: 1, name: "Restore a backup" }));
  // Continue is off until something is typed.
  expect(screen.getByRole("button", { name: "Continue" }).getAttribute("aria-disabled")).toBe("true");
  press("Continue");
  expect(sent("restore_check")).toEqual([]);
  // The text goes with the choice, as one box's, and nothing else.
  const choice = shell.restorePickTokens()[0];
  expect(choice).toMatch(/^[0-9a-f]{32}$/);
  await toTheFolder();
  expect(sent("restore_check")).toEqual([{ choice, credential: { password_or_key: BACKUP_PASSWORD } }]);
  expect(shell.restorePicks()).toEqual([{ name: BACKUP_NAME, size: 1_288_490_188, checked: true }]);
});

test("the_restore_is_offered_in_settings_after_test_a_backup_and_works_from_there", async () => {
  await unlocked();
  fireEvent.click(within(screen.getByRole("navigation", { name: "Vault and folders" })).getByRole("button", { name: "Settings" }));
  const settings = await screen.findByRole("complementary", { name: "Settings" });
  const group = within(settings).getByRole("heading", { name: "This vault" }).closest("section") as HTMLElement;
  expect(within(group).getAllByRole("button").map((button) => button.textContent)).toEqual(["Back up", "Test a backup", "Restore a backup"]);
  press("Restore a backup", settings);
  await heading("Restore a backup");
  // The open vault's window is not on screen while the restore is.
  expect(screen.queryByRole("heading", { level: 1, name: "All items" })).toBeNull();
  expect(sent("restore_pick")).toEqual([{ choice: null, vault: null }]);
  // Cancel goes back to the vault, with Settings still open, and lets the file go.
  const choice = shell.restorePickTokens()[0];
  press("Cancel");
  await heading("All items");
  expect(sent("forget_restore_pick")).toEqual([{ choice }]);
  expect(shell.restorePicks()).toEqual([]);
  await screen.findByRole("complementary", { name: "Settings" });
});

test("a_closed_picker_opens_nothing_and_a_second_press_while_it_is_open_sends_nothing", async () => {
  await onTheLockScreen();
  shell.dismissFileNext();
  press("Restore a backup");
  await waitFor(() => {
    expect(sent("restore_pick")).toHaveLength(1);
  });
  await act(async () => {
    await new Promise((done) => window.setTimeout(done, 5));
  });
  expect(screen.queryByRole("heading", { level: 1, name: "Restore a backup" })).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(shell.restorePicks()).toEqual([]);
  const release = shell.holdPicker();
  press("Restore a backup");
  await waitFor(() => {
    expect(screen.getByRole("button", { name: "Restore a backup" }).getAttribute("aria-disabled")).toBe("true");
  });
  press("Restore a backup");
  expect(sent("restore_pick")).toHaveLength(2);
  act(() => {
    release();
  });
  await heading("Restore a backup");
});

test("a_lock_while_the_picker_is_open_opens_nothing_and_says_nothing", async () => {
  await onTheLockScreen();
  shell.refuseNext("restore_pick", { code: "locked" });
  press("Restore a backup");
  await waitFor(() => {
    expect(sent("restore_pick")).toHaveLength(1);
  });
  await act(async () => {
    await new Promise((done) => window.setTimeout(done, 5));
  });
  expect(screen.queryByRole("heading", { level: 1, name: "Restore a backup" })).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
});

test("a_restore_already_going_is_said_on_the_first_step_with_no_file", async () => {
  await onTheLockScreen();
  shell.refuseNext("restore_pick", { code: "busy", what: "restore" });
  press("Restore a backup");
  await heading("Restore a backup");
  expect(screen.getByText("No backup picked.")).toBeTruthy();
  expect(within(screen.getByRole("alert")).getByText(/That vault is busy/)).toBeTruthy();
  // Pick a backup asks again, and the file takes the row's place.
  press("Pick a backup");
  await screen.findByText(FILE_ROW);
  expect(screen.queryByRole("alert")).toBeNull();
  expect(sent("restore_pick")[1]).toEqual({ choice: null, vault: null });
});

test("pick_another_sends_the_choice_it_has_and_swaps_the_file", async () => {
  await onTheLockScreen();
  await restoreFromTheLockScreen();
  const choice = shell.restorePickTokens()[0];
  shell.pickBackupNext("Older vault 2026-08-01.lockbox-backup", 5 * MB);
  press("Pick another");
  await screen.findByText("Older vault 2026-08-01.lockbox-backup, 5 MB");
  expect(sent("restore_pick")[1]).toEqual({ choice, vault: null });
  expect(shell.restorePicks()).toEqual([{ name: "Older vault 2026-08-01.lockbox-backup", size: 5 * MB, checked: false }]);
  // A closed picker leaves the file as it was.
  shell.dismissFileNext();
  press("Pick another");
  await waitFor(() => {
    expect(sent("restore_pick")).toHaveLength(3);
  });
  await act(async () => {
    await new Promise((done) => window.setTimeout(done, 5));
  });
  expect(screen.getByText("Older vault 2026-08-01.lockbox-backup, 5 MB")).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
});

test("wrong_password_keeps_the_picked_backup", async () => {
  await onTheLockScreen();
  await restoreFromTheLockScreen();
  const choice = shell.restorePickTokens()[0];
  type("not the one");
  press("Continue");
  const alert = await screen.findByRole("alert");
  // 23c's line, shared with Test a backup, under the box; the box is empty and the file is still picked.
  expect(alert.textContent).toBe(WRONG);
  expect(box().value).toBe("");
  expect(box().getAttribute("aria-invalid")).toBe("true");
  expect(screen.getByText(FILE_ROW)).toBeTruthy();
  expect(sent("restore_pick")).toHaveLength(1);
  expect(shell.restorePickTokens()).toEqual([choice]);
  expect(shell.restorePicks()[0]?.checked).toBe(false);
  // Typing again takes the line away, and the right one goes on with the same choice.
  type("x");
  expect(screen.queryByRole("alert")).toBeNull();
  await toTheFolder();
  expect(sent("restore_check").map((one) => one.choice)).toEqual([choice, choice]);
  expect(sent("restore_pick")).toHaveLength(1);
});

test("a_damaged_backup_is_said_in_plain_words_under_the_file_and_the_file_can_be_swapped", async () => {
  await onTheLockScreen();
  await restoreFromTheLockScreen();
  shell.damageBackup("backup: damaged file");
  type(BACKUP_PASSWORD);
  press("Continue");
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toBe(
    "A stored file in this backup doesn't match what the backup recorded, so it can't be trusted. Use another backup if you have one.",
  );
  expect(screen.getByText(FILE_ROW)).toBeTruthy();
  press("Pick another");
  await waitFor(() => {
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

test("a_choice_the_shell_let_go_takes_the_file_away_and_asks_to_pick_again", async () => {
  await onTheLockScreen();
  await restoreFromTheLockScreen();
  shell.expireRestorePicks();
  type(BACKUP_PASSWORD);
  press("Continue");
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toBe(EXPIRED);
  expect(screen.getByText("No backup picked.")).toBeTruthy();
  expect(screen.queryByText(FILE_ROW)).toBeNull();
  // Continue has nothing to go on with until a file is picked again.
  type("something");
  expect(screen.getByRole("button", { name: "Continue" }).getAttribute("aria-disabled")).toBe("true");
  press("Pick a backup");
  await screen.findByText(FILE_ROW);
  expect(sent("restore_pick")[1]).toEqual({ choice: null, vault: null });
});

test("folder_step_suggests_the_usual_folder", async () => {
  await onTheLockScreen();
  await restoreFromTheLockScreen();
  const choice = shell.restorePickTokens()[0];
  await toTheFolder();
  // 24b, as drawn: the name the backup unpacks as, in the usual folder shown as text, Choose another, Restore and Back.
  expect(document.querySelector("header.field .say")?.textContent).toBe(SAY);
  expect(screen.getByText("It unpacks as My vault, in your usual vaults folder.")).toBeTruthy();
  expect(screen.getByText("C:\\Users\\Someone\\Lockbox Vaults\\My vault")).toBeTruthy();
  expect(["Choose another", "Restore", "Back"].map((name) => screen.getByRole("button", { name }).textContent)).toEqual(["Choose another", "Restore", "Back"]);
  expect(document.activeElement).toBe(screen.getByRole("heading", { level: 1, name: "Where it goes" }));
  // Choose another sends only the choice; the shell opens its own picker. A closed one leaves the folder.
  shell.dismissFileNext();
  press("Choose another");
  await waitFor(() => {
    expect(sent("restore_choose_folder")).toHaveLength(1);
  });
  await act(async () => {
    await new Promise((done) => window.setTimeout(done, 5));
  });
  expect(screen.getByText("It unpacks as My vault, in your usual vaults folder.")).toBeTruthy();
  press("Choose another");
  await screen.findByText("It unpacks as My vault, in the folder you chose.");
  expect(sent("restore_choose_folder")).toEqual([{ choice }, { choice }]);
  expect(screen.getByText("D:\\Vaults\\My vault")).toBeTruthy();
  // Back goes to 24a with the file still picked; nothing was picked again.
  press("Back");
  await heading("Restore a backup");
  expect(screen.getByText(FILE_ROW)).toBeTruthy();
  expect(sent("restore_pick")).toHaveLength(1);
});

test("a_vault_with_this_ones_id_in_the_folder_says_it_asks_before_replacing", async () => {
  shell = installFakeShell(invoke, listen, mine());
  shell.restoreIs({ replaces: true });
  render(<App />);
  await screen.findByLabelText(/^Password for /);
  await restoreFromTheLockScreen();
  await toTheFolder();
  expect(screen.getByText("My vault is already in this folder. Lockbox asks before replacing it, and keeps your current one beside it.")).toBeTruthy();
});

test("progress_and_cancel_until_the_swap", async () => {
  await onTheLockScreen();
  await restoreFromTheLockScreen();
  const choice = shell.restorePickTokens()[0];
  const releaseCopy = shell.holdRestoreCopy();
  await toTheFolder();
  press("Restore");
  // 24c, as drawn: the name, the bar's label, its percentage, the line about the laptop, Cancel.
  const card = await screen.findByRole("region", { name: "Checking and unpacking" });
  expect(screen.getByRole("heading", { level: 1, name: "Restoring My vault" })).toBeTruthy();
  expect(document.querySelector("header.field .say")?.textContent).toBe(SAY);
  const job = theJob();
  expect(job.kind).toBe("restore");
  expect(job.scope.type).toBe("launch");
  expect(sent("restore_prepare")).toEqual([{ choice, request: expect.any(Number) as number }]);
  expect(job.request).toBe(sent("restore_prepare")[0]?.request);
  act(() => {
    shell.sendProgress(job.operation, Math.round(0.48 * BIG), BIG);
  });
  expect(within(card).getByText("48%")).toBeTruthy();
  expect(within(card).getByRole("progressbar").getAttribute("aria-valuenow")).toBe("48");
  expect(within(card).getByText(KEEP_OPEN)).toBeTruthy();
  expect(within(card).getByRole("button", { name: "Cancel" })).toBeTruthy();
  // The start is said in the screen's own polite place.
  expect(spoken()).toContain("Checking and unpacking started.");
  // Nothing typed is on the page while it works.
  expect(document.querySelectorAll("input")).toHaveLength(0);
  // Cancel stops the copy: the first step again, with nothing picked, and the vault as it was.
  fireEvent.click(within(card).getByRole("button", { name: "Cancel" }));
  await heading("Restore a backup");
  expect(screen.getByRole("alert").textContent).toBe(CANCELLED);
  expect(screen.getByText("No backup picked.")).toBeTruthy();
  expect(shell.preparedRestores()).toEqual([]);
  expect(shell.runningLaunchJobs()).toEqual([]);
  expect(sent("restore_commit")).toEqual([]);
  expect(shell.restorePicks()).toEqual([]);
  releaseCopy();
});

test("progress_after_the_copy_goes_on_to_the_swap_with_no_cancel_and_no_percentage", async () => {
  await onTheLockScreen();
  await restoreFromTheLockScreen();
  const releaseCopy = shell.holdRestoreCopy();
  const releaseSwap = shell.holdRestoreSwap();
  await toTheFolder();
  press("Restore");
  await screen.findByRole("region", { name: "Checking and unpacking" });
  act(() => {
    releaseCopy();
  });
  // A copy that replaced nothing goes straight on: no question, the swap is asked for at once (a request of its own).
  await heading("Restoring My vault");
  await screen.findByText("Putting it in place");
  const commit = sent("restore_commit");
  expect(commit).toEqual([{ restore: expect.any(Number) as number, request: expect.any(Number) as number }]);
  expect(commit[0]?.request).not.toBe(sent("restore_prepare")[0]?.request);
  // From here there is no Cancel and no percentage: the copy is made and the swap can't be stopped.
  expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  expect(screen.queryByRole("progressbar")).toBeNull();
  expect(document.body.textContent).not.toMatch(/\d+%/);
  const swap = theJob();
  expect(swap.kind).toBe("restore");
  expect(swap.request).toBe(commit[0]?.request);
  act(() => {
    releaseSwap();
  });
  await heading("My vault is restored");
  expect(spoken()).toContain("My vault is restored.");
});

test("a_refusal_that_comes_after_the_job_began_and_one_that_comes_before_are_both_said", async () => {
  await onTheLockScreen();
  await restoreFromTheLockScreen();
  await toTheFolder();
  // After the job began: its own checks failed inside it.
  shell.restoreCopyRefuses({ code: "core", kind: "not_enough_space", needed: BIG, available: 400 * MB });
  press("Restore");
  await heading("This restore can't go ahead");
  expect(onScreen(NO_SPACE)).toBeTruthy();
  expect(shell.runningLaunchJobs()).toEqual([]);
  // Before it began: the command was refused outright.
  press("OK");
  await heading("Where it goes");
  shell.refuseNext("restore_prepare", { code: "invalid_input", what: "removable drive" });
  press("Restore");
  await heading("This restore can't go ahead");
  expect(onScreen(WRONG_DRIVE)).toBeTruthy();
});

test("replace_question_says_the_current_one_is_kept", async () => {
  await onTheLockScreen();
  await restoreFromTheLockScreen();
  await toTheReplaceQuestion();
  // 24d, as drawn: nothing is swapped yet, and the person is told what stays and that it waits.
  expect(screen.getByText("My vault is already on this PC. Your current one stays beside it as My vault.before-restore, so you can still open it.")).toBeTruthy();
  expect(screen.getByText(WAITS)).toBeTruthy();
  expect(["Replace", "Cancel"].map((name) => screen.getByRole("button", { name }).textContent)).toEqual(["Replace", "Cancel"]);
  expect(document.activeElement).toBe(screen.getByRole("heading", { level: 1, name: "Replace your vault with this?" }));
  expect(sent("restore_commit")).toEqual([]);
  expect(shell.preparedRestores()).toHaveLength(1);
  // Cancel lets the finished copy go and leaves the restore.
  const [restore] = shell.preparedRestores();
  press("Cancel");
  await screen.findByLabelText(/^Password for /);
  expect(sent("restore_discard")).toEqual([{ restore }]);
  expect(shell.preparedRestores()).toEqual([]);
  expect(sent("restore_commit")).toEqual([]);
});

test("replace_goes_on_to_the_swap_with_the_copy_it_asked_about", async () => {
  await onTheLockScreen();
  await restoreFromTheLockScreen();
  await toTheReplaceQuestion();
  const [restore] = shell.preparedRestores();
  press("Replace");
  await heading("My vault is restored");
  expect(sent("restore_commit")).toEqual([{ restore, request: expect.any(Number) as number }]);
  expect(sent("restore_discard")).toEqual([]);
});

test("finish_says_unlock_with_the_backups_password", async () => {
  await onTheLockScreen();
  await restoreFromTheLockScreen();
  await toTheReplaceQuestion();
  press("Replace");
  // 24e, as drawn: the vault's name, which password it takes (and the day), one box and Unlock.
  await heading("My vault is restored");
  expect(screen.getByText("Unlock it with the password from when this backup was made, not the one you use today.")).toBeTruthy();
  const field = screen.getByLabelText<HTMLInputElement>("Password from 2 October 2026");
  expect(field.getAttribute("type")).toBe("password");
  expect(document.activeElement).toBe(screen.getByRole("heading", { level: 1, name: "My vault is restored" }));
  expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  // Today's password is refused, and the box stays for another try.
  fireEvent.change(field, { target: { value: PASSWORD } });
  press("Unlock");
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toBe("Wrong password.");
  expect(screen.getByRole("heading", { level: 1, name: "My vault is restored" })).toBeTruthy();
  // The backup's own opens the restored vault, and the restore goes.
  fireEvent.change(screen.getByLabelText("Password from 2 October 2026"), { target: { value: BACKUP_PASSWORD } });
  press("Unlock");
  await heading("All items");
  expect(sent("unlock_vault")[1]).toEqual({ id: 7, password: BACKUP_PASSWORD });
  expect(screen.queryByRole("heading", { level: 1, name: "My vault is restored" })).toBeNull();
});

test("finish_without_a_date_and_a_vault_that_was_not_there_before", async () => {
  shell = installFakeShell(invoke, listen, mine());
  shell.restoreIs({ made: null, name: "Home" });
  render(<App />);
  await screen.findByLabelText(/^Password for /);
  await restoreFromTheLockScreen();
  await toTheFolder();
  press("Restore");
  await heading("Home is restored");
  const field = screen.getByLabelText<HTMLInputElement>("Password from when this backup was made");
  fireEvent.change(field, { target: { value: BACKUP_PASSWORD } });
  press("Unlock");
  await heading("All items");
  // The restored vault was added to the list, and it is the one unlocked.
  expect(sent("unlock_vault")).toEqual([{ id: 8, password: BACKUP_PASSWORD }]);
  expect(sent("list_vaults").length).toBeGreaterThanOrEqual(2);
});

test("each_restore_refusal_shows_its_design_message", async () => {
  await onTheLockScreen();
  await restoreFromTheLockScreen();
  const choice = shell.restorePickTokens()[0];
  await toTheFolder();
  // Not enough space, with the two numbers; OK goes back to 24b, and the pick is kept for another try.
  shell.refuseNext("restore_prepare", { code: "core", kind: "not_enough_space", needed: BIG, available: 400 * MB });
  press("Restore");
  await heading("This restore can't go ahead");
  expect(onScreen(NO_SPACE)).toBeTruthy();
  expect(spoken()).toContain(NO_SPACE);
  expect(screen.queryByRole("button", { name: "Replace" })).toBeNull();
  press("OK");
  await heading("Where it goes");
  expect(shell.restorePickTokens()).toEqual([choice]);
  // Each drive a vault can't live on has the same words.
  for (const what of ["removable drive", "network drive", "drive type not supported", "file system not supported"]) {
    shell.refuseNext("restore_prepare", { code: "invalid_input", what });
    press("Restore");
    await heading("This restore can't go ahead");
    expect(onScreen(WRONG_DRIVE), what).toBeTruthy();
    press("OK");
    await heading("Where it goes");
  }
  // A file system that can't hold a file this big is the engine's own words; a refusal nobody listed is the generic ones, never its own text.
  shell.refuseNext("restore_prepare", { code: "core", kind: "file_system_limit", max_file: 4 * GB - 1 });
  press("Restore");
  await heading("This restore can't go ahead");
  expect(onScreen("That drive can't hold a file this big.")).toBeTruthy();
  press("OK");
  await heading("Where it goes");
  // Two working copies of this vault in the folder (one copied beside the other): the engine won't guess, and the words say what to do.
  shell.refuseNext("restore_prepare", { code: "core", kind: "invalid_input", what: "several copies of this vault" });
  press("Restore");
  await heading("This restore can't go ahead");
  expect(
    onScreen(
      "That folder holds more than one copy of this vault, so Lockbox can't tell which one to replace. Choose another folder, or move the extra copies out of it first.",
    ),
  ).toBeTruthy();
  press("OK");
  await heading("Where it goes");
  expect(shell.restorePickTokens()).toEqual([choice]);
  shell.refuseNext("restore_prepare", { code: "core", kind: "io", what: "C:\\Users\\Someone\\Secret" });
  press("Restore");
  await heading("This restore can't go ahead");
  expect(document.body.textContent).not.toContain("Secret");
  press("OK");
  await heading("Where it goes");
  // All the older copies' names are taken: the copy is made, the swap is refused, and the only way on is Cancel, which lets the copy go.
  shell.restoreIs({ replaces: true });
  press("Back");
  await heading("Restore a backup");
  await toTheFolder();
  press("Restore");
  await heading("Replace your vault with this?");
  const [restore] = shell.preparedRestores();
  shell.restoreCommitRefuses({ code: "core", kind: "invalid_input", what: "too many before-restore copies" });
  press("Replace");
  await within(screen.getByRole("main")).findByText(TOO_MANY);
  expect(screen.queryByRole("button", { name: "Replace" })).toBeNull();
  expect(screen.queryByRole("button", { name: "OK" })).toBeNull();
  // The design's Older copies button is beside Cancel (Task 8): the copy is made and waits, so there is nothing to go back to but Cancel.
  expect(screen.getByRole("button", { name: "Older copies" })).toBeTruthy();
  press("Cancel");
  await screen.findByLabelText(/^Password for /);
  expect(sent("restore_discard")).toEqual([{ restore }]);
});

const TOO_MANY_REFUSAL = { code: "core", kind: "invalid_input", what: "too many before-restore copies" };

/** The restore from the lock screen as far as the swap's refusal for too many older copies, with `list` kept beside the vault it would replace. */
async function toTheTooManyRefusal(list: FakeOlderCopy[]) {
  await onTheLockScreen();
  shell.olderCopies(list);
  await restoreFromTheLockScreen();
  await toTheReplaceQuestion();
  shell.restoreCommitRefuses(TOO_MANY_REFUSAL);
  press("Replace");
  await within(screen.getByRole("main")).findByText(TOO_MANY);
}

const KEPT: FakeOlderCopy[] = [
  { vault: 7, folder: "My vault.before-restore", last_written: "2026-11-04", size: 3 * MB },
  { vault: 7, folder: "My vault.before-restore-2", last_written: "2026-11-05", size: 4 * MB },
  { vault: 8, folder: "Other.before-restore", last_written: "2026-09-09", size: MB },
];

test("too_many_copies_offers_older_copies_and_replace_again", async () => {
  // From the lock screen: no vault is open, so a copy can be deleted here and none opened.
  await toTheTooManyRefusal(KEPT);
  const [restore] = shell.preparedRestores();
  press("Older copies");
  await heading("Older copies");
  const main = screen.getByRole("main");
  expect(within(main).getByText("For My vault. Kept when you restored a backup over it.")).toBeTruthy();
  expect(within(main).getByText("My vault.before-restore")).toBeTruthy();
  expect(within(main).getByText("My vault.before-restore-2")).toBeTruthy();
  expect(within(main).queryByText("Other.before-restore")).toBeNull();
  expect(within(main).getByText("From 4 November 2026 · 3 MB")).toBeTruthy();
  // Delete only: the flow can run with no vault open.
  expect(within(main).queryByRole("button", { name: "Open read-only" })).toBeNull();
  expect(within(main).getAllByRole("button", { name: "Delete" })).toHaveLength(2);
  expect(within(main).getByText("Delete asks first, because it can't be undone.")).toBeTruthy();
  await expectNoAxe(document.body);

  // Back is the refusal again, and the copy still waits.
  press("Back");
  await within(screen.getByRole("main")).findByText(TOO_MANY);
  expect(shell.preparedRestores()).toEqual([restore]);
  press("Older copies");
  await heading("Older copies");

  // Delete asks first; the yes deletes it and the flow is at 24d again, with the same finished copy.
  press("Delete", screen.getByText("My vault.before-restore").closest(".frow") as HTMLElement);
  const dialog = await screen.findByRole("dialog", { name: "Delete My vault.before-restore?" });
  expect(sent("delete_pre_restore").at(-1)?.confirm).toBe(false);
  expect(shell.deletedOlderCopies()).toEqual([]);
  press("Delete for good", dialog);
  await heading("Replace your vault with this?");
  expect(shell.deletedOlderCopies()).toEqual(["My vault.before-restore"]);
  expect(shell.preparedRestores()).toEqual([restore]);

  // Replace is pressed again, for the same finished copy, and goes through.
  press("Replace");
  await heading("My vault is restored");
  expect(sent("restore_commit").map((args) => args.restore)).toEqual([restore, restore]);
  expect(shell.discardedRestores()).toEqual([]);
});

test("the_older_copies_of_a_restore_follow_the_locks_as_the_question_does", async () => {
  await toTheTooManyRefusal(KEPT);
  press("Older copies");
  await heading("Older copies");
  // An idle lock leaves a finished restore, so the screen stays.
  await theEpochMoves("idle");
  expect(screen.getByRole("heading", { level: 1, name: "Older copies" })).toBeTruthy();
  // Any other lock ended the finished restore: the flow goes without a word.
  await theEpochMoves("manual");
  await screen.findByLabelText(/^Password for /);
  expect(screen.queryByRole("heading", { level: 1, name: "Older copies" })).toBeNull();
});

test("cancel_on_the_older_copies_screen_lets_the_finished_copy_go", async () => {
  await toTheTooManyRefusal(KEPT);
  const [restore] = shell.preparedRestores();
  press("Older copies");
  await heading("Older copies");
  press("Back");
  await within(screen.getByRole("main")).findByText(TOO_MANY);
  press("Cancel");
  await screen.findByLabelText(/^Password for /);
  expect(sent("restore_discard")).toEqual([{ restore }]);
});

test("a_cloud_folder_asks_first_in_save_a_copys_shape_and_the_yes_runs_the_same_copy", async () => {
  await onTheLockScreen();
  await restoreFromTheLockScreen();
  await toTheFolder();
  shell.restoreAsksNext("cloud");
  press("Restore");
  const dialog = await screen.findByRole("dialog", { name: "This folder is synced to the cloud" });
  expect(within(dialog).getByText(/A cloud service syncs this folder\./)).toBeTruthy();
  // The safe answer has the first focus; nothing was copied.
  await waitFor(() => {
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Choose another" }));
  });
  expect(shell.runningLaunchJobs()).toEqual([]);
  await expectNoAxe(document.body);
  // Choose another asks for a folder, and the question goes; a closed picker leaves 24b.
  fireEvent.click(within(dialog).getByRole("button", { name: "Choose another" }));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(sent("restore_choose_folder")).toHaveLength(1);
  shell.restoreAsksNext("cloud");
  press("Restore");
  const again = await screen.findByRole("dialog", { name: "This folder is synced to the cloud" });
  fireEvent.click(within(again).getByRole("button", { name: "Continue anyway" }));
  await heading("My vault is restored");
  const [question] = sent("restore_prepare_confirm");
  expect(question).toEqual({ token: expect.any(String) as string, name: null, request: expect.any(Number) as number });
  expect(shell.confirmedNames()).toEqual([null]);
});

test("a_folder_the_shell_cannot_tell_apart_asks_for_a_new_folders_name", async () => {
  await onTheLockScreen();
  await restoreFromTheLockScreen();
  await toTheFolder();
  shell.restoreAsksNext("name");
  press("Restore");
  const dialog = await screen.findByRole("dialog", { name: "Restore into a new folder?" });
  const name = within(dialog).getByRole<HTMLInputElement>("textbox", { name: "Folder name" });
  expect(name.value).toBe("My vault (restored)");
  fireEvent.change(name, { target: { value: "My vault again" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Restore here" }));
  await heading("My vault is restored");
  expect(shell.confirmedNames()).toEqual(["My vault again"]);
  // Cancel on the question goes back to 24b, with the pick kept and nothing copied.
});

test("the_name_question_dismissed_goes_back_to_the_folder_step", async () => {
  await onTheLockScreen();
  await restoreFromTheLockScreen();
  const choice = shell.restorePickTokens()[0];
  await toTheFolder();
  shell.restoreAsksNext("name");
  press("Restore");
  const dialog = await screen.findByRole("dialog", { name: "Restore into a new folder?" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  await heading("Where it goes");
  expect(shell.restorePickTokens()).toEqual([choice]);
  expect(sent("restore_prepare_confirm")).toEqual([]);
});

test("idle_lock_keeps_the_replace_question", async () => {
  await unlocked();
  const session = shell.sessionOf(7)?.session ?? -1;
  await restoreFromSettings();
  await toTheReplaceQuestion();
  const [restore] = shell.preparedRestores();
  // The idle time passes: the open vault locks, and the finished restore stays, with its question, as Rust keeps it.
  await act(async () => {
    shell.lock(session, "idle");
    shell.changeLockEpoch("idle");
    await Promise.resolve();
  });
  expect(screen.getByRole("heading", { level: 1, name: "Replace your vault with this?" })).toBeTruthy();
  expect(screen.queryByLabelText(/^Password for /)).toBeNull();
  expect(shell.preparedRestores()).toEqual([restore]);
  expect(sent("restore_discard")).toEqual([]);
  // The answer still works, however long it took; the swap closes the vault it replaces, and the restore is not taken away by that.
  press("Replace");
  await heading("My vault is restored");
  expect(sent("restore_commit")).toEqual([{ restore, request: expect.any(Number) as number }]);
});

test("windows_lock_closes_it_quietly", async () => {
  for (const reason of ["windows_locked", "sleep", "manual", "app_closing", "drive_gone"]) {
    cleanup();
    resetStoreForTests();
    invoke.mockReset();
    listen.mockReset();
    await onTheLockScreen();
    await restoreFromTheLockScreen();
    await toTheReplaceQuestion();
    const [restore] = shell.preparedRestores();
    await theEpochMoves(reason);
    // Quietly: back to what the app would show, with no message and nothing left to answer.
    await screen.findByLabelText(/^Password for /);
    expect(screen.queryByRole("heading", { level: 1, name: "Replace your vault with this?" }), reason).toBeNull();
    expect(screen.queryByRole("alert"), reason).toBeNull();
    expect(document.body.textContent, reason).not.toContain(CANCELLED);
    // Rust ended the finished restore: a late answer finds it gone.
    invoke.mockClear();
    await expect(invoke("restore_commit", { restore, request: 99 }), reason).rejects.toEqual({ code: "cancelled" });
  }
});

test("a_lock_at_the_first_two_steps_takes_the_file_away_whatever_the_reason", async () => {
  for (const reason of ["idle", "manual", "windows_locked"]) {
    cleanup();
    resetStoreForTests();
    invoke.mockReset();
    listen.mockReset();
    await onTheLockScreen();
    await restoreFromTheLockScreen();
    await theEpochMoves(reason);
    // 24a, with no file picked and the expired line: Rust drained the pick.
    expect((await screen.findByRole("alert")).textContent, reason).toBe(EXPIRED);
    expect(screen.getByText("No backup picked."), reason).toBeTruthy();
    expect(shell.restorePicks(), reason).toEqual([]);
    await toTheFolderFromScratch();
    await theEpochMoves(reason);
    expect((await screen.findByRole("alert")).textContent, reason).toBe(EXPIRED);
    expect(screen.getByRole("heading", { level: 1, name: "Restore a backup" }), reason).toBeTruthy();
  }
});

/** After a lock took the file: pick again and go to the folder step. */
async function toTheFolderFromScratch() {
  press("Pick a backup");
  await screen.findByText(FILE_ROW);
  await toTheFolder();
}

test("a_lock_during_the_copy_goes_back_to_the_first_step_with_the_cancelled_words", async () => {
  await onTheLockScreen();
  await restoreFromTheLockScreen();
  const release = await toTheCopy();
  await theEpochMoves("windows_locked");
  // The job has ended in the shell; the command's own answer (`locked`) is what sends the page back.
  expect(shell.runningLaunchJobs()).toEqual([]);
  expect(screen.getByRole("heading", { level: 1, name: "Restoring My vault" })).toBeTruthy();
  act(() => {
    release();
  });
  await heading("Restore a backup");
  expect(screen.getByRole("alert").textContent).toBe(CANCELLED);
  expect(screen.getByText("No backup picked.")).toBeTruthy();
  expect(sent("restore_commit")).toEqual([]);
  release();
});

test("the_typed_credential_is_wiped_when_sent_and_on_a_lock", async () => {
  await onTheLockScreen();
  await restoreFromTheLockScreen();
  const secret = `typed-${BACKUP_PASSWORD}`;
  // Sent: the box is empty as it goes, before the shell has answered, and the page's state never held it.
  const release = shell.holdRestoreCheck();
  type(secret);
  expect(box().value).toBe(secret);
  press("Continue");
  expect(box().value).toBe("");
  expect(sent("restore_check")).toHaveLength(1);
  expect(JSON.stringify(debugState())).not.toContain(secret);
  expect(document.body.innerHTML).not.toContain(secret);
  act(() => {
    release();
  });
  await screen.findByRole("alert");
  expect(box().value).toBe("");
  // Typed and not sent, then a lock: the text goes, and so does what showed it.
  press("Pick another");
  await screen.findByText(FILE_ROW);
  fireEvent.click(screen.getByRole("button", { name: "Show what you typed" }));
  type("half typed");
  expect(box().getAttribute("type")).toBe("text");
  await theEpochMoves("idle");
  await screen.findByText("No backup picked.");
  expect(box().value).toBe("");
  expect(box().getAttribute("type")).toBe("password");
  // And the restored vault's password at 24e, typed and not sent, goes with a lock as well.
  press("Pick a backup");
  await screen.findByText(FILE_ROW);
  await toTheFolder();
  press("Restore");
  await heading("My vault is restored");
  fireEvent.change(screen.getByLabelText<HTMLInputElement>("Password from 2 October 2026"), { target: { value: "half of the other one" } });
  await theEpochMoves("manual");
  expect(screen.getByLabelText<HTMLInputElement>("Password from 2 October 2026").value).toBe("");
  expect(document.body.innerHTML).not.toContain("half of the other one");
});

const CHANGED = "This backup changed after it was checked. Pick it again.";

test("a_backup_replaced_after_the_check_goes_back_to_the_first_step_with_nothing_picked", async () => {
  await onTheLockScreen();
  await restoreFromTheLockScreen();
  await toTheFolder();
  // The shell opened the archive and it is another vault's: the copy is refused inside its job, and the pick (and its credential) is forgotten.
  shell.restoreCopyRefuses({ code: "invalid_input", what: "backup changed" });
  press("Restore");
  await heading("Restore a backup");
  expect((await screen.findByRole("alert")).textContent).toBe(CHANGED);
  expect(screen.getByText("No backup picked.")).toBeTruthy();
  expect(screen.queryByText(FILE_ROW)).toBeNull();
  expect(screen.queryByRole("heading", { level: 1, name: "This restore can't go ahead" })).toBeNull();
  expect(box().value).toBe("");
  expect(shell.restorePicks()).toEqual([]);
  expect(shell.runningLaunchJobs()).toEqual([]);
  expect(sent("restore_commit")).toEqual([]);
  // Continue has nothing to go on with until a file is picked again; the new pick starts clean.
  type("something");
  expect(screen.getByRole("button", { name: "Continue" }).getAttribute("aria-disabled")).toBe("true");
  press("Pick a backup");
  await screen.findByText(FILE_ROW);
  expect(screen.queryByRole("alert")).toBeNull();
  expect(sent("restore_pick")[1]).toEqual({ choice: null, vault: null });
});

test("a_backup_that_changed_is_refused_the_same_way_before_the_job_and_after_a_question", async () => {
  await onTheLockScreen();
  await restoreFromTheLockScreen();
  await toTheFolder();
  // Refused outright, before any job began.
  shell.refuseNext("restore_prepare", { code: "invalid_input", what: "backup changed" });
  press("Restore");
  await heading("Restore a backup");
  expect((await screen.findByRole("alert")).textContent).toBe(CHANGED);
  expect(screen.getByText("No backup picked.")).toBeTruthy();
  // The cloud question's yes runs the same copy, and the same refusal ends it in the same place.
  press("Pick a backup");
  await screen.findByText(FILE_ROW);
  await toTheFolder();
  shell.restoreAsksNext("cloud");
  press("Restore");
  const dialog = await screen.findByRole("dialog", { name: "This folder is synced to the cloud" });
  shell.restoreCopyRefuses({ code: "invalid_input", what: "backup changed" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Continue anyway" }));
  await heading("Restore a backup");
  expect((await screen.findByRole("alert")).textContent).toBe(CHANGED);
  expect(screen.getByText("No backup picked.")).toBeTruthy();
  expect(sent("restore_commit")).toEqual([]);
});

test("every_name_after_the_copy_is_the_one_the_copy_answered_not_the_one_the_check_found", async () => {
  await onTheLockScreen();
  await restoreFromTheLockScreen();
  shell.restoreIs({ replaces: true });
  await toTheFolder();
  // Before the copy the name is the check's (24b and the bar); the copy opened the archive again and says what it is called.
  expect(screen.getByText("My vault is already in this folder. Lockbox asks before replacing it, and keeps your current one beside it.")).toBeTruthy();
  const release = shell.holdRestoreCopy();
  shell.restoreCopyNames("My vault, renamed");
  press("Restore");
  await heading("Restoring My vault");
  act(() => {
    release();
  });
  await heading("Replace your vault with this?");
  expect(screen.getByText("My vault, renamed is already on this PC. Your current one stays beside it as My vault.before-restore, so you can still open it.")).toBeTruthy();
  expect(document.body.textContent).not.toContain("My vault is already on this PC");
  press("Replace");
  await heading("My vault, renamed is restored");
  expect(spoken()).toContain("My vault, renamed is restored.");
  expect(screen.queryByRole("heading", { level: 1, name: "My vault is restored" })).toBeNull();
});

test("the_swap_without_a_question_also_names_the_vault_the_copy_answered", async () => {
  await onTheLockScreen();
  await restoreFromTheLockScreen();
  await toTheFolder();
  const releaseSwap = shell.holdRestoreSwap();
  shell.restoreCopyNames("Home");
  press("Restore");
  await heading("Restoring Home");
  expect(screen.queryByRole("heading", { level: 1, name: "Restoring My vault" })).toBeNull();
  act(() => {
    releaseSwap();
  });
  await heading("Home is restored");
});

/** From the folder step to a copy that is finished in the shell while its answer is still on its way to the page. */
async function toACopyWhoseAnswerIsOnItsWay(replaces: boolean) {
  shell.restoreIs({ replaces });
  await toTheFolder();
  const release = shell.holdRestoreAnswer();
  press("Restore");
  await waitFor(() => {
    expect(shell.preparedRestores()).toHaveLength(1);
  });
  return release;
}

async function theAnswerArrives(release: () => void) {
  await act(async () => {
    release();
    await Promise.resolve();
  });
}

test("a_copy_answer_that_arrives_after_a_lock_that_is_not_idle_is_ignored_and_the_flow_closes_quietly", async () => {
  for (const replaces of [true, false]) {
    for (const reason of ["windows_locked", "sleep", "manual", "app_closing"]) {
      const label = `${reason}, replaces ${String(replaces)}`;
      cleanup();
      resetStoreForTests();
      invoke.mockReset();
      listen.mockReset();
      await onTheLockScreen();
      await restoreFromTheLockScreen();
      const release = await toACopyWhoseAnswerIsOnItsWay(replaces);
      await theEpochMoves(reason);
      // The shell ended the finished restore; the page has not heard of the copy yet.
      expect(screen.getByRole("heading", { level: 1, name: "Restoring My vault" }), label).toBeTruthy();
      await theAnswerArrives(release);
      // Quietly: back to what the app would show, no question, no automatic swap, no message.
      await screen.findByLabelText(/^Password for /);
      expect(screen.queryByRole("heading", { level: 1, name: "Replace your vault with this?" }), label).toBeNull();
      expect(screen.queryByRole("heading", { level: 1, name: "Restoring My vault" }), label).toBeNull();
      expect(screen.queryByRole("alert"), label).toBeNull();
      expect(document.body.textContent, label).not.toContain(CANCELLED);
      expect(sent("restore_commit"), label).toEqual([]);
    }
  }
});

test("a_copy_answer_that_arrives_after_an_idle_lock_is_kept", async () => {
  // The question stays after an idle lock, as Rust keeps the finished restore.
  await onTheLockScreen();
  await restoreFromTheLockScreen();
  const release = await toACopyWhoseAnswerIsOnItsWay(true);
  const [restore] = shell.preparedRestores();
  await theEpochMoves("idle");
  await theAnswerArrives(release);
  await heading("Replace your vault with this?");
  expect(shell.preparedRestores()).toEqual([restore]);
  expect(sent("restore_discard")).toEqual([]);
  press("Replace");
  await heading("My vault is restored");
  // A copy that replaced nothing goes straight on to the swap, as it would have with no lock.
  cleanup();
  resetStoreForTests();
  invoke.mockReset();
  listen.mockReset();
  await onTheLockScreen();
  await restoreFromTheLockScreen();
  const again = await toACopyWhoseAnswerIsOnItsWay(false);
  await theEpochMoves("idle");
  await theAnswerArrives(again);
  await heading("My vault is restored");
  expect(sent("restore_commit")).toHaveLength(1);
});

test("typing_is_closed_while_the_backup_is_checked_and_what_got_in_anyway_is_gone_by_the_last_step", async () => {
  await onTheLockScreen();
  await restoreFromTheLockScreen();
  const release = shell.holdRestoreCheck();
  type(BACKUP_PASSWORD);
  expect(box().readOnly).toBe(false);
  press("Continue");
  // The box is shut while the check runs.
  expect(box().readOnly).toBe(true);
  // A keystroke that got through anyway (a paste, say) is not kept by the flow.
  const late = "typed-while-it-was-checked";
  type(late);
  act(() => {
    release();
  });
  await heading("Where it goes");
  expect(JSON.stringify(debugState())).not.toContain(late);
  // Back to 24a: the box is empty and open again.
  press("Back");
  await heading("Restore a backup");
  expect(box().value).toBe("");
  expect(box().readOnly).toBe(false);
  // And through to 24e: its password box starts empty, whatever was typed on the way.
  const releaseAgain = shell.holdRestoreCheck();
  type(BACKUP_PASSWORD);
  press("Continue");
  type(late);
  act(() => {
    releaseAgain();
  });
  await heading("Where it goes");
  press("Restore");
  await heading("My vault is restored");
  expect(screen.getByLabelText<HTMLInputElement>("Password from 2 October 2026").value).toBe("");
  expect(document.body.innerHTML).not.toContain(late);
});

test("text_typed_while_the_check_ran_is_gone_when_the_check_answers_wrong", async () => {
  await onTheLockScreen();
  await restoreFromTheLockScreen();
  const release = shell.holdRestoreCheck();
  type("not the one");
  press("Continue");
  type("typed-while-it-was-checked");
  act(() => {
    release();
  });
  expect((await screen.findByRole("alert")).textContent).toBe(WRONG);
  expect(box().value).toBe("");
  expect(box().readOnly).toBe(false);
  expect(document.body.innerHTML).not.toContain("typed-while-it-was-checked");
});

test("the_first_step_cancel_lets_the_file_go", async () => {
  await onTheLockScreen();
  await restoreFromTheLockScreen();
  const choice = shell.restorePickTokens()[0];
  press("Cancel");
  await screen.findByLabelText(/^Password for /);
  expect(sent("forget_restore_pick")).toEqual([{ choice }]);
  expect(shell.restorePicks()).toEqual([]);
});

test("no_command_carries_a_path_or_a_name_the_page_chose", async () => {
  await onTheLockScreen();
  await restoreFromTheLockScreen();
  await toTheFolder();
  press("Choose another");
  await screen.findByText("It unpacks as My vault, in the folder you chose.");
  press("Restore");
  await heading("My vault is restored");
  for (const cmd of ["restore_pick", "restore_check", "restore_choose_folder", "restore_prepare", "restore_commit"]) {
    for (const args of sent(cmd)) {
      expect(JSON.stringify(args), cmd).not.toMatch(/[A-Z]:[\\/]|\\Users|lockbox-backup/);
    }
  }
});

test("restore_screens_have_no_axe_violations", async () => {
  const { container } = await onTheLockScreen();
  await restoreFromTheLockScreen();
  await expectNoAxe(container);
  type("not the one");
  press("Continue");
  await screen.findByRole("alert");
  await expectNoAxe(container);
  await toTheFolder();
  await expectNoAxe(container);
  const release = shell.holdRestoreCopy();
  press("Restore");
  await screen.findByRole("region", { name: "Checking and unpacking" });
  await expectNoAxe(container);
  release();
  await heading("My vault is restored");
  await expectNoAxe(container);
  // The Content Security Policy refuses a `<style>` element: the page makes none.
  expect(document.querySelectorAll("style")).toHaveLength(0);
});

test("the_replace_question_and_a_refusal_have_no_axe_violations", async () => {
  const { container } = await onTheLockScreen();
  await restoreFromTheLockScreen();
  await toTheReplaceQuestion();
  await expectNoAxe(container);
  press("Replace");
  await heading("My vault is restored");
  await expectNoAxe(container);
});

test("a_refusal_screen_has_no_axe_violations", async () => {
  const { container } = await onTheLockScreen();
  await restoreFromTheLockScreen();
  await toTheFolder();
  shell.refuseNext("restore_prepare", { code: "core", kind: "not_enough_space", needed: BIG, available: 400 * MB });
  press("Restore");
  await heading("This restore can't go ahead");
  await expectNoAxe(container);
});

const PENDING_PATHS = { step: "swapping", staging: "C:\\Vaults\\SENTINEL-restore", target: "C:\\Vaults\\SENTINEL-restore", before_restore: null };

test("a_restore_refused_by_an_unfinished_one_shows_its_notice", async () => {
  await onTheLockScreen();
  await restoreFromTheLockScreen();
  const choice = shell.restorePickTokens()[0];
  await toTheFolder();
  // An unfinished restore's journal is still there: the shell ran its recovery and says what it found, instead of copying.
  shell.restoreRecoversNext({ state: "drive_missing", paths: PENDING_PATHS, folder: "E:\\Vaults" });
  press("Restore");
  await heading("A restore is waiting for a drive");
  expect(screen.getByText(/^It was using E:\\Vaults, which isn't connected\./)).toBeTruthy();
  // The restore flow is closed, with nothing of it on the screen, and the pick is let go.
  expect(screen.queryByRole("heading", { level: 1, name: "Where it goes" })).toBeNull();
  expect(screen.queryByRole("heading", { level: 1, name: "This restore can't go ahead" })).toBeNull();
  expect(sent("forget_restore_pick")).toEqual([{ choice }]);
  expect(document.body.textContent).not.toContain("SENTINEL");
  expect(JSON.stringify(debugState())).not.toContain("SENTINEL");
  // Dismiss is the way out, and it ends on the lock screen.
  press("Dismiss");
  await screen.findByLabelText(/^Password for /);
  expect(sent("dismiss_restore")).toEqual([{ confirm: true }]);
});

test("a_restore_refused_by_an_unfinished_one_shows_its_notice: also from the question's answer, and a notice that was finished or undone", async () => {
  await onTheLockScreen();
  await restoreFromTheLockScreen();
  shell.restoreAsksNext("cloud");
  await toTheFolder();
  press("Restore");
  await screen.findByRole("dialog", { name: "This folder is synced to the cloud" });
  shell.restoreRecoversNext({ state: "recovered", how: "rolled_back", vault: { id: 7, name: "My vault" } });
  press("Continue anyway");
  await heading("A restore didn't finish");
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getByText(/has put My vault back the way it was/)).toBeTruthy();
});

test("a_restore_refused_by_an_unfinished_one_shows_its_notice: from an open vault, over its window", async () => {
  await unlocked();
  await restoreFromSettings();
  await toTheFolder();
  shell.restoreRecoversNext({ state: "pending", paths: PENDING_PATHS });
  press("Restore");
  await heading("A restore is waiting");
  expect(screen.queryByRole("heading", { level: 1, name: "All items" })).toBeNull();
  press("Dismiss");
  await heading("All items");
});
