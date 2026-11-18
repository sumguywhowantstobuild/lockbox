// Plan 4B Task 3's screens: back up a vault (22a to 22d), the refusals that stop one (Ask 2 and the three beside it), and the 30-day
// reminder (Ask 1). Every case runs through the lock screen, Settings and the pretend shell, as a person would reach it.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import App from "../App";
import { debugState, resetStoreForTests } from "../store";
import { expectNoAxe } from "../testing/axe";
import { installFakeShell, PASSWORD, sampleItems, type FakeShell, type FakeVault } from "../testing/fakeShell";

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
const GB = 1024 ** 3;
/** 1.2 GB as a whole number of bytes, so the words say "1.2 GB". */
const BIG = Math.round(1.2 * GB);

const KEEP_IT = "Keep it on another drive. A backup on this drive is lost with this drive.";
const KEEP_OPEN = "Keep the laptop open. Windows locking or sleeping cancels this, and nothing half-made is left behind.";
const NOT_FINISHED = "The backup didn't finish. Nothing half-made was left.";
const NO_SPACE = "Not enough space. This backup needs 1.2 GB, and that drive has 400 MB free.";
const OVERDUE = "My vault hasn't been backed up in 30 days";
const CANT = "Can't back up My vault yet";

const CHANGED = "Its details were changed outside Lockbox, so a backup made now might not open. Look at that change and accept it first, then back up.";
const PASSWORD_COPIES = "Change this vault's password once more, then back up.";
const KEY_COPIES = "Make a new recovery key for this vault, then back up.";
const UNCHECKED = "Lock this vault and open it again, then back up.";

/** What the shell sends for each of the four refusals (the frozen connection's wire strings). */
const REFUSED_CHANGED = { code: "invalid_input", what: "details changed" };
const REFUSED_PASSWORD = { code: "invalid_input", what: "password copies disagree" };
const REFUSED_KEY = { code: "invalid_input", what: "recovery key copies disagree" };
const REFUSED_UNCHECKED = { code: "invalid_input", what: "details unchecked" };
/** The engine's refusal when the drive is too small (`error.rs`: `not_enough_space` with its two numbers). */
const REFUSED_SPACE = { code: "core", kind: "not_enough_space", needed: BIG, available: 400 * MB };

function mine(extra: Partial<FakeVault> = {}): FakeVault[] {
  return [{ id: 7, name: "My vault", items: sampleItems(), ...extra }];
}

async function unlockThroughTheScreen() {
  const field = await screen.findByLabelText(/^Password for /);
  fireEvent.change(field, { target: { value: PASSWORD } });
  fireEvent.submit((field as HTMLInputElement).form as HTMLFormElement);
  // A question that opens with the vault (the reminder) holds the page behind it out of reach, so the heading is found even then.
  await screen.findByRole("heading", { level: 1, name: "All items", hidden: true });
}

async function unlocked(list: FakeVault[] = mine()) {
  shell = installFakeShell(invoke, listen, list);
  const view = render(<App />);
  await unlockThroughTheScreen();
  return view;
}

function side(): HTMLElement {
  return screen.getByRole("navigation", { name: "Vault and folders" });
}

function sent(cmd: string): Record<string, unknown>[] {
  return invoke.mock.calls.filter(([name]) => name === cmd).map(([, args]) => args as Record<string, unknown>);
}

function session(): number {
  const live = shell.sessionOf(7);
  if (live === undefined) throw new Error("the vault is not open");
  return live.session;
}

/** The message at the foot of the window, as text. */
function toast(): string {
  return document.querySelector(".tstack")?.textContent ?? "";
}

/** Settings from the side menu, then its Back up. Gives the Back up panel (22a). */
async function openBackup() {
  fireEvent.click(within(side()).getByRole("button", { name: "Settings" }));
  const settings = await screen.findByRole("complementary", { name: "Settings" });
  fireEvent.click(within(settings).getByRole("button", { name: "Back up" }));
  return screen.findByRole("complementary", { name: "Back up" });
}

/** The names of the buttons in a place, in order, as a screen reader says them. */
function buttonsIn(place: HTMLElement): (string | null)[] {
  return within(place)
    .getAllByRole("button")
    .map((button) => button.getAttribute("aria-label") ?? button.textContent);
}

function press(panel: HTMLElement, name: string) {
  fireEvent.click(within(panel).getByRole("button", { name }));
}

/** The one job the shell says is running. */
function theJob(): { request: number; operation: number; kind: string } {
  const [job, ...others] = shell.runningJobs();
  expect(others).toEqual([]);
  if (job === undefined) throw new Error("no job is running");
  return job;
}

test("backup_says_keep_it_on_another_drive", async () => {
  await unlocked();
  const settings = await (async () => {
    fireEvent.click(within(side()).getByRole("button", { name: "Settings" }));
    return screen.findByRole("complementary", { name: "Settings" });
  })();
  // Back up is in its own group for this vault, in Settings.
  expect(within(settings).getByRole("heading", { name: "This vault" })).toBeTruthy();
  fireEvent.click(within(settings).getByRole("button", { name: "Back up" }));
  const panel = await screen.findByRole("complementary", { name: "Back up" });
  // 22a: whose backup it is, and the advice; nothing has been sent, and no path is on the page (Windows' own dialog picks it).
  expect(within(panel).getByText("For My vault.")).toBeTruthy();
  expect(within(panel).getByText(KEEP_IT)).toBeTruthy();
  expect(buttonsIn(panel)).toEqual(["Close panel", "Cancel", "Back up"]);
  expect(sent("backup_vault")).toEqual([]);
  expect(document.body.textContent).not.toMatch(/lockbox-backup|[A-Z]:\//);
  // Cancel leaves with nothing sent.
  press(panel, "Cancel");
  await waitFor(() => {
    expect(screen.queryByRole("complementary", { name: "Back up" })).toBeNull();
  });
  expect(sent("backup_vault")).toEqual([]);
});

test("back_up_panel_closes_on_escape", async () => {
  await unlocked();
  // 22a closes on Escape, as Settings, Test a backup, Open a backup, Add files and Save all do; nothing is sent, and focus goes back to Settings.
  let panel = await openBackup();
  fireEvent.keyDown(within(panel).getByRole("button", { name: "Back up" }), { key: "Escape" });
  await waitFor(() => {
    expect(screen.queryByRole("complementary", { name: "Back up" })).toBeNull();
  });
  expect(sent("backup_vault")).toEqual([]);
  await waitFor(() => {
    expect(document.activeElement).toBe(within(side()).getByRole("button", { name: "Settings" }));
  });
  // While the backup runs (22b) a stray Escape leaves the bar where it is, as Test a backup does: Cancel and Close panel are the ways out.
  panel = await openBackup();
  const release = shell.holdFiles();
  press(panel, "Back up");
  const card = await screen.findByRole("region", { name: "Backing up My vault" });
  fireEvent.keyDown(within(card).getByRole("button", { name: "Cancel" }), { key: "Escape" });
  expect(screen.getByRole("complementary", { name: "Back up" })).toBeTruthy();
  expect(screen.getByRole("region", { name: "Backing up My vault" })).toBe(card);
  // The saved summary (22c) closes on Escape too.
  act(() => {
    release();
  });
  const saved = await screen.findByRole("complementary", { name: "Backup saved" });
  fireEvent.keyDown(within(saved).getByRole("button", { name: "Done" }), { key: "Escape" });
  await waitFor(() => {
    expect(screen.queryByRole("complementary", { name: "Backup saved" })).toBeNull();
  });
});

test("backup_sends_this_vaults_session_generation_and_a_request_and_nothing_else", async () => {
  await unlocked();
  const panel = await openBackup();
  press(panel, "Back up");
  await screen.findByRole("complementary", { name: "Backup saved" });
  const generation = debugState().sessions.find((entry) => entry.session === session())?.generation;
  expect(sent("backup_vault")).toEqual([{ session: session(), generation, request: expect.any(Number) as number }]);
});

test("backup_shows_progress_and_cancel", async () => {
  await unlocked();
  const panel = await openBackup();
  const release = shell.holdFiles();
  press(panel, "Back up");
  // The shell says the work started (`lockbox://job-started`, matched to the request the page sent); 22b is the bar, in words.
  const card = await screen.findByRole("region", { name: "Backing up My vault" });
  const job = theJob();
  expect(job.kind).toBe("backup");
  expect(job.request).toBe(sent("backup_vault")[0]?.request);
  act(() => {
    shell.sendProgress(job.operation, 750 * MB, BIG);
  });
  expect(within(card).getByText("750 MB of 1.2 GB")).toBeTruthy();
  expect(within(card).getByRole("progressbar").getAttribute("aria-valuenow")).toBe("61");
  expect(within(card).getByText(KEEP_OPEN)).toBeTruthy();
  // The auto-lock note does not say the Windows part a second time beside the card.
  expect(document.body.textContent.match(/Windows locking or sleeping/g)).toHaveLength(1);
  // Cancel stops this one operation, and nothing is saved.
  fireEvent.click(within(card).getByRole("button", { name: "Cancel" }));
  expect(await screen.findByText(NOT_FINISHED)).toBeTruthy();
  expect(screen.queryByRole("region", { name: "Backing up My vault" })).toBeNull();
  expect(shell.fileOps.filter((op) => op.cmd === "backup_vault")).toEqual([]);
  act(() => {
    release();
  });
});

test("finished_backup_shows_what_it_left_out", async () => {
  await unlocked(mine({ backupView: { items: 26, files: 7, damaged_items: 2, damaged_files: 1, missing_files: 3 } }));
  const panel = await openBackup();
  const release = shell.holdFiles();
  press(panel, "Back up");
  await screen.findByRole("region", { name: "Backing up My vault" });
  act(() => {
    release();
  });
  const done = await screen.findByRole("complementary", { name: "Backup saved" });
  const rows = [...done.querySelectorAll(".fld")].map((row) => row.textContent);
  expect(rows).toEqual(["Items26", "Files7", "Size1.2 GB"]);
  // Counts, in words, and no name of any item or file.
  expect(within(done).getByText("Left out: 2 damaged items, 1 damaged file and 3 missing files. Items that use a left-out file are saved without it.")).toBeTruthy();
  expect(done.textContent).not.toMatch(/contract-demo|Client contract|Bot admin/);
  // "Test this backup" (Task 4) is beside Done, and has its own tests in `TestBackup.test.tsx`.
  expect(buttonsIn(done)).toEqual(["Close panel", "Test this backup", "Done"]);
  press(done, "Done");
  await waitFor(() => {
    expect(screen.queryByRole("complementary", { name: "Backup saved" })).toBeNull();
  });
});

test("a_backup_that_left_nothing_out_says_nothing_about_it", async () => {
  await unlocked(mine({ backupView: { damaged_items: 0, damaged_files: 0, missing_files: 0 } }));
  const panel = await openBackup();
  press(panel, "Back up");
  const done = await screen.findByRole("complementary", { name: "Backup saved" });
  expect(done.textContent).not.toContain("Left out");
});

test("one_kind_left_out_is_said_with_its_own_count_and_words", async () => {
  await unlocked(mine({ backupView: { damaged_items: 1, damaged_files: 0, missing_files: 0 } }));
  const panel = await openBackup();
  press(panel, "Back up");
  const done = await screen.findByRole("complementary", { name: "Backup saved" });
  // An item left out has no file to name: the sentence about files is not said.
  expect(within(done).getByText("Left out: 1 damaged item.")).toBeTruthy();
});

test("no_space_shows_22d_numbers", async () => {
  await unlocked();
  const panel = await openBackup();
  shell.refuseNext("backup_vault", REFUSED_SPACE);
  press(panel, "Back up");
  const alert = await within(panel).findByRole("alert");
  expect(alert.textContent).toBe(NO_SPACE);
  // Refused before anything was written: no job, no "didn't finish", and the panel is still 22a, so another drive can be tried.
  expect(shell.runningJobs()).toEqual([]);
  expect(screen.queryByText(NOT_FINISHED)).toBeNull();
  expect(screen.queryByRole("region", { name: "Backing up My vault" })).toBeNull();
  press(panel, "Back up");
  await screen.findByRole("complementary", { name: "Backup saved" });
  expect(sent("backup_vault")).toHaveLength(2);
});

test("a_refusal_before_writing_is_said_on_22a_in_the_tables_words_and_never_the_shells_own", async () => {
  await unlocked();
  const panel = await openBackup();
  shell.refuseNext("backup_vault", { code: "invalid_input", what: "state folder", detail: "E:/Backups/secret-folder" });
  press(panel, "Back up");
  const alert = await within(panel).findByRole("alert");
  expect(alert.textContent).toBe("Lockbox won't save that in its own settings folder. Choose another folder.");
  expect(document.body.textContent).not.toContain("secret-folder");
  expect(screen.queryByText(NOT_FINISHED)).toBeNull();
});

test("a_closed_save_dialog_says_nothing", async () => {
  await unlocked();
  const panel = await openBackup();
  shell.dismissFileNext();
  press(panel, "Back up");
  await waitFor(() => {
    expect(sent("backup_vault")).toHaveLength(1);
  });
  // Back at 22a, with nothing said, and Back up works again.
  await waitFor(() => {
    expect(within(panel).getByRole("button", { name: "Back up" }).getAttribute("aria-disabled")).toBeNull();
  });
  expect(within(panel).queryByRole("alert")).toBeNull();
  expect(within(panel).getByText(KEEP_IT)).toBeTruthy();
});

test("failed_or_cancelled_says_nothing_half_made_was_left", async () => {
  await unlocked();
  // Cancelled: the sentence, and OK.
  let panel = await openBackup();
  let release = shell.holdFiles();
  press(panel, "Back up");
  const card = await screen.findByRole("region", { name: "Backing up My vault" });
  fireEvent.click(within(card).getByRole("button", { name: "Cancel" }));
  expect(await screen.findByText(NOT_FINISHED)).toBeTruthy();
  panel = screen.getByRole("complementary", { name: "Back up" });
  expect(buttonsIn(panel)).toEqual(["Close panel", "OK"]);
  // A stop is the person's own press: nothing is said about an error.
  expect(within(panel).queryByRole("alert")).toBeNull();
  act(() => {
    release();
  });
  press(panel, "OK");
  await waitFor(() => {
    expect(screen.queryByRole("complementary", { name: "Back up" })).toBeNull();
  });

  // Failed after the work started (the drive went away): the same sentence, then the table's words for it.
  panel = await openBackup();
  release = shell.holdFiles();
  shell.refuseNext("backup_vault", { code: "core", kind: "io", what: "backup" });
  press(panel, "Back up");
  await screen.findByRole("region", { name: "Backing up My vault" });
  act(() => {
    release();
  });
  expect(await screen.findByText(NOT_FINISHED)).toBeTruthy();
  panel = screen.getByRole("complementary", { name: "Back up" });
  expect(within(panel).getByText("Lockbox couldn't reach that folder or file. Check that the drive is connected, then try again.")).toBeTruthy();
  expect(shell.fileOps.filter((op) => op.cmd === "backup_vault")).toEqual([]);

  // A failure the table has no words for says the sentence alone, never the generic "Something went wrong".
  press(panel, "OK");
  await waitFor(() => {
    expect(screen.queryByRole("complementary", { name: "Back up" })).toBeNull();
  });
  panel = await openBackup();
  release = shell.holdFiles();
  shell.refuseNext("backup_vault", { code: "core", kind: "never_seen_before" });
  press(panel, "Back up");
  await screen.findByRole("region", { name: "Backing up My vault" });
  act(() => {
    release();
  });
  expect(await screen.findByText(NOT_FINISHED)).toBeTruthy();
  expect(document.body.textContent).not.toContain("Something went wrong");
});

test("each_refusal_shows_its_design_message", async () => {
  await unlocked();
  // Ask 2, and the three beside it. Each leaves 22a, names the vault, and says what the design says, word for word.
  const cases = [
    { refusal: REFUSED_CHANGED, words: CHANGED, buttons: ["Not now", "See the change"] },
    // "Change password" and "New recovery key" are 4C's screens: until they exist, these two show "Not now" alone.
    { refusal: REFUSED_PASSWORD, words: PASSWORD_COPIES, buttons: ["Not now"] },
    { refusal: REFUSED_KEY, words: KEY_COPIES, buttons: ["Not now"] },
    { refusal: REFUSED_UNCHECKED, words: UNCHECKED, buttons: ["Not now", "Lock this vault"] },
  ];
  for (const one of cases) {
    const panel = await openBackup();
    shell.refuseNext("backup_vault", one.refusal);
    press(panel, "Back up");
    const dialog = await screen.findByRole("dialog", { name: CANT });
    expect(within(dialog).getByText(one.words)).toBeTruthy();
    expect(buttonsIn(dialog)).toEqual(one.buttons);
    // It has left 22a, and nothing says the backup "didn't finish": it was refused before anything was written.
    expect(screen.queryByRole("complementary", { name: "Back up" })).toBeNull();
    expect(screen.queryByText(NOT_FINISHED)).toBeNull();
    if (one === cases[3]) break;
    fireEvent.click(within(dialog).getByRole("button", { name: "Not now" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: CANT })).toBeNull();
    });
  }
  // The last one: Lock this vault locks that one vault.
  const dialog = screen.getByRole("dialog", { name: CANT });
  fireEvent.click(within(dialog).getByRole("button", { name: "Lock this vault" }));
  await screen.findByLabelText(/^Password for /);
  expect(sent("lock_vault")).toEqual([{ session: expect.any(Number) as number }]);
});

test("see_the_change_opens_ask_3_for_that_vault", async () => {
  await unlocked();
  const panel = await openBackup();
  shell.refuseNext("backup_vault", REFUSED_CHANGED);
  press(panel, "Back up");
  const dialog = await screen.findByRole("dialog", { name: CANT });
  fireEvent.click(within(dialog).getByRole("button", { name: "See the change" }));
  // The existing question (Ask 3), for the same vault, and the refusal's own dialog is gone.
  const ask = await screen.findByRole("dialog", { name: "My vault's details were changed outside Lockbox." });
  expect(within(ask).getByRole("button", { name: "Accept" })).toBeTruthy();
  expect(within(ask).getByRole("button", { name: "Lock this vault" })).toBeTruthy();
  expect(screen.queryByRole("dialog", { name: CANT })).toBeNull();
  fireEvent.click(within(ask).getByRole("button", { name: "Accept" }));
  await waitFor(() => {
    expect(sent("accept_header")).toEqual([{ session: session(), generation: expect.any(Number) as number }]);
  });
});

test("a_lock_while_backing_up_leaves_nothing_on_screen", async () => {
  await unlocked();
  const panel = await openBackup();
  const release = shell.holdFiles();
  press(panel, "Back up");
  await screen.findByRole("region", { name: "Backing up My vault" });
  act(() => {
    shell.lock(session());
  });
  await screen.findByLabelText(/^Password for /);
  act(() => {
    release();
  });
  await act(async () => {
    await new Promise((done) => window.setTimeout(done, 10));
  });
  const page = document.body.textContent;
  for (const words of [NOT_FINISHED, "Backup saved", "My vault's backup"]) expect(page).not.toContain(words);
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByRole("complementary")).toBeNull();
});

test("closing_the_panel_while_it_runs_still_says_the_result", async () => {
  await unlocked(mine({ backupView: { damaged_files: 1 } }));
  const panel = await openBackup();
  const release = shell.holdFiles();
  press(panel, "Back up");
  await screen.findByRole("region", { name: "Backing up My vault" });
  press(panel, "Close panel");
  await waitFor(() => {
    expect(screen.queryByRole("complementary", { name: "Back up" })).toBeNull();
  });
  act(() => {
    release();
  });
  await waitFor(() => {
    expect(toast()).toContain("Backup saved. Left out: 1 damaged file. Items that use a left-out file are saved without it.");
  });
  // Opening Back up again starts from 22a, not from the old result.
  fireEvent.click(within(document.body).getByRole("button", { name: "Got it" }));
  const again = await openBackup();
  expect(within(again).getByText(KEEP_IT)).toBeTruthy();
});

test("reopening_back_up_while_it_runs_shows_the_running_one_and_starts_no_second", async () => {
  await unlocked();
  const panel = await openBackup();
  const release = shell.holdFiles();
  press(panel, "Back up");
  await screen.findByRole("region", { name: "Backing up My vault" });
  press(panel, "Close panel");
  const again = await openBackup();
  expect(within(again).getByRole("region", { name: "Backing up My vault" })).toBeTruthy();
  expect(sent("backup_vault")).toHaveLength(1);
  act(() => {
    release();
  });
  await screen.findByRole("complementary", { name: "Backup saved" });
});

test("reminder_shows_after_30_days_with_later_and_back_up_now", async () => {
  await unlocked(mine({ backupDays: 31 }));
  const ask = await screen.findByRole("dialog", { name: OVERDUE });
  expect(within(ask).getByText("A backup on another drive is what saves you if this PC fails.")).toBeTruthy();
  expect(buttonsIn(ask)).toEqual(["Later", "Back up now"]);
  // Asked once, for this vault, at this generation.
  const generation = debugState().sessions.find((entry) => entry.session === session())?.generation;
  expect(sent("vault_backup_due")).toEqual([{ session: session(), generation }]);
  // Back up now opens 22a for this vault, and sends nothing yet.
  fireEvent.click(within(ask).getByRole("button", { name: "Back up now" }));
  const panel = await screen.findByRole("complementary", { name: "Back up" });
  expect(within(panel).getByText("For My vault.")).toBeTruthy();
  expect(screen.queryByRole("dialog", { name: OVERDUE })).toBeNull();
  expect(sent("backup_vault")).toEqual([]);
  press(panel, "Back up");
  await screen.findByRole("complementary", { name: "Backup saved" });
  expect(sent("backup_vault")).toEqual([{ session: session(), generation, request: expect.any(Number) as number }]);
});

test("no_reminder_when_the_last_backup_is_recent_or_the_vault_is_read_only", async () => {
  await unlocked(mine({ backupDays: 29 }));
  await waitFor(() => {
    expect(sent("vault_backup_due")).toHaveLength(1);
  });
  expect(screen.queryByRole("dialog")).toBeNull();
  cleanup();
  resetStoreForTests();
  invoke.mockReset();
  listen.mockReset();
  await unlocked(mine({ backupDays: 99, readOnly: true }));
  await act(async () => {
    await new Promise((done) => window.setTimeout(done, 10));
  });
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("later_hides_the_reminder_until_the_next_unlock", async () => {
  await unlocked(mine({ backupDays: 40 }));
  const ask = await screen.findByRole("dialog", { name: OVERDUE });
  fireEvent.click(within(ask).getByRole("button", { name: "Later" }));
  await waitFor(() => {
    expect(screen.queryByRole("dialog", { name: OVERDUE })).toBeNull();
  });
  // It stays away while the vault stays open, in whatever the person does.
  fireEvent.click(within(side()).getByRole("button", { name: "Settings" }));
  await screen.findByRole("complementary", { name: "Settings" });
  expect(screen.queryByRole("dialog", { name: OVERDUE })).toBeNull();
  // The next unlock asks again.
  act(() => {
    shell.lock(session());
  });
  await unlockThroughTheScreen();
  expect(await screen.findByRole("dialog", { name: OVERDUE })).toBeTruthy();
  expect(sent("vault_backup_due")).toHaveLength(2);
});

test("escape_on_the_reminder_is_later_and_not_a_backup", async () => {
  await unlocked(mine({ backupDays: 40 }));
  const ask = await screen.findByRole("dialog", { name: OVERDUE });
  fireEvent.keyDown(ask, { key: "Escape" });
  await waitFor(() => {
    expect(screen.queryByRole("dialog", { name: OVERDUE })).toBeNull();
  });
  expect(sent("backup_vault")).toEqual([]);
  expect(screen.queryByRole("complementary", { name: "Back up" })).toBeNull();
});

test("the_reminder_waits_behind_ask_3_so_two_questions_never_stack", async () => {
  shell = installFakeShell(invoke, listen, mine({ backupDays: 40, headerChanged: true }));
  render(<App />);
  const field = await screen.findByLabelText(/^Password for /);
  fireEvent.change(field, { target: { value: PASSWORD } });
  fireEvent.submit((field as HTMLInputElement).form as HTMLFormElement);
  await screen.findByRole("dialog", { name: "My vault's details were changed outside Lockbox." });
  await waitFor(() => {
    expect(sent("vault_backup_due")).toHaveLength(1);
  });
  expect(screen.queryByRole("dialog", { name: OVERDUE })).toBeNull();
  // Once that is answered, the reminder is next.
  fireEvent.click(screen.getByRole("button", { name: "Accept" }));
  expect(await screen.findByRole("dialog", { name: OVERDUE })).toBeTruthy();
});

test("back_up_hidden_on_a_read_only_vault", async () => {
  await unlocked(mine({ readOnly: true }));
  fireEvent.click(within(side()).getByRole("button", { name: "Settings" }));
  const settings = await screen.findByRole("complementary", { name: "Settings" });
  // Settings is the app's own, so it opens; Back up is not there (a read-only copy has nothing of its own to back up). The vault's group
  // is: Test a backup works from any vault (`TestBackup.test.tsx`).
  expect(within(settings).getByRole("heading", { name: "Appearance" })).toBeTruthy();
  expect(within(settings).getByRole("heading", { name: "This vault" })).toBeTruthy();
  expect(within(settings).queryByRole("button", { name: "Back up" })).toBeNull();
  expect(within(settings).getByRole("button", { name: "Test a backup" })).toBeTruthy();
});

test("backup_screens_have_no_axe_violations", async () => {
  // 22a, 22b, 22c, 22d, and the two questions (a dialog is checked on its own, and the page around it without it).
  await unlocked(mine({ backupDays: 40 }));
  const reminder = await screen.findByRole("dialog", { name: OVERDUE });
  await expectNoAxe(reminder);
  await expectNoAxe({ include: [document.body], exclude: [reminder] });
  fireEvent.click(within(reminder).getByRole("button", { name: "Back up now" }));
  const first = await screen.findByRole("complementary", { name: "Back up" });
  await expectNoAxe(document.body);

  shell.refuseNext("backup_vault", REFUSED_SPACE);
  press(first, "Back up");
  await within(first).findByRole("alert");
  await expectNoAxe(document.body);

  const release = shell.holdFiles();
  press(first, "Back up");
  await screen.findByRole("region", { name: "Backing up My vault" });
  act(() => {
    shell.sendProgress(theJob().operation, 750 * MB, BIG);
  });
  await expectNoAxe(document.body);
  act(() => {
    release();
  });
  await screen.findByRole("complementary", { name: "Backup saved" });
  await expectNoAxe(document.body);
  press(screen.getByRole("complementary", { name: "Backup saved" }), "Done");

  const panel = await openBackup();
  shell.refuseNext("backup_vault", REFUSED_CHANGED);
  press(panel, "Back up");
  const refused = await screen.findByRole("dialog", { name: CANT });
  await expectNoAxe(refused);
  await expectNoAxe({ include: [document.body], exclude: [refused] });
});
