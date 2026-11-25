// Plan 4B Task 4's screens: test a backup (23a to 23d), from Settings and from 22c. Every case runs through the lock screen, Settings and the
// pretend shell, as a person would reach it. The picked backup's path is only ever in the shell: the page holds its name and size and the
// choice it waits under.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import App from "../App";
import { debugState, resetStoreForTests } from "../store";
import { expectNoAxe } from "../testing/axe";
import { BACKUP_NAME, BACKUP_PASSWORD, installFakeShell, PASSWORD, sampleItems, type FakeShell, type FakeVault } from "../testing/fakeShell";

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
const WRONG = "Wrong password. It needs the one from the day this backup was made, which may not be today's.";
const USE_ANOTHER = "Use another backup if you have one.";
const STORED_FILE = `A stored file in this backup doesn't match what the backup recorded, so it can't be trusted. ${USE_ANOTHER}`;
const AN_ITEM = `An item in this backup doesn't match what the backup recorded, so it can't be trusted. ${USE_ANOTHER}`;
const OTHER_VAULT = `This backup was made from a different vault. ${USE_ANOTHER}`;
const NOT_WHOLE = `This file isn't a whole Petalock backup, or its contents were changed after it was made, so it can't be trusted. ${USE_ANOTHER}`;
const EXPIRED = "That choice has expired. Pick the backup again.";
const GOOD_WORDS = "Every item and file checked out. Nothing was changed.";

function mine(extra: Partial<FakeVault> = {}): FakeVault[] {
  return [{ id: 7, name: "My vault", items: sampleItems(), ...extra }];
}

async function unlockThroughTheScreen() {
  const field = await screen.findByLabelText(/^Password for /);
  fireEvent.change(field, { target: { value: PASSWORD } });
  fireEvent.submit((field as HTMLInputElement).form as HTMLFormElement);
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

/** The text of the page's one spoken place. */
function spoken(): string {
  return document.querySelector(".live")?.textContent ?? "";
}

function buttonsIn(place: HTMLElement): (string | null)[] {
  return within(place)
    .getAllByRole("button")
    .map((button) => button.getAttribute("aria-label") ?? button.textContent);
}

function press(panel: HTMLElement, name: string) {
  fireEvent.click(within(panel).getByRole("button", { name }));
}

async function settingsPanel(): Promise<HTMLElement> {
  fireEvent.click(within(side()).getByRole("button", { name: "Settings" }));
  return screen.findByRole("complementary", { name: "Settings" });
}

/** Settings, then Test a backup: the picker (the pretend shell's) chooses a file, and 23a opens on it. */
async function openTest(): Promise<HTMLElement> {
  const settings = await settingsPanel();
  fireEvent.click(within(settings).getByRole("button", { name: "Test a backup" }));
  return screen.findByRole("complementary", { name: "Test a backup" });
}

function box(panel: HTMLElement): HTMLInputElement {
  return within(panel).getByLabelText<HTMLInputElement>(LABEL);
}

function type(panel: HTMLElement, text: string) {
  fireEvent.change(box(panel), { target: { value: text } });
}

/** Types a credential and presses Test. */
function test_(panel: HTMLElement, text: string) {
  type(panel, text);
  press(panel, "Test");
}

/** The one launch-scoped job the shell says is running (a test of a backup). */
function theJob() {
  const [job, ...others] = shell.runningLaunchJobs();
  expect(others).toEqual([]);
  if (job === undefined) throw new Error("no job is running");
  return job;
}

test("settings_offers_test_a_backup_beside_back_up_and_the_pick_comes_first", async () => {
  await unlocked();
  const settings = await settingsPanel();
  const group = within(settings).getByRole("heading", { name: "This vault" }).closest("section") as HTMLElement;
  expect(buttonsIn(group)).toEqual(["Back up", "Test a backup", "Open a backup", "Restore a backup", "Export", "Change password", "New recovery key"]);
  fireEvent.click(within(group).getByRole("button", { name: "Test a backup" }));
  const panel = await screen.findByRole("complementary", { name: "Test a backup" });
  // The picker opened first, with nothing sent but the pick's own (no choice yet): the credential waits for a file.
  expect(sent("test_backup_pick")).toEqual([{ choice: null }]);
  expect(sent("test_backup")).toEqual([]);
  // 23a: the file's name and size as text, Pick another, the box, Cancel and Test.
  expect(within(panel).getByRole("heading", { level: 2, name: "Test a backup" })).toBeTruthy();
  expect(within(panel).getByText(BACKUP_NAME)).toBeTruthy();
  expect(within(panel).getByText("1.2 GB")).toBeTruthy();
  expect(buttonsIn(panel)).toEqual(["Close panel", "Pick another", "Show what you typed", "Cancel", "Test"]);
  expect(box(panel).getAttribute("type")).toBe("password");
  // No path, in the page or in what it was told.
  expect(document.body.textContent).not.toMatch(/[A-Z]:[\\/]|\\Users|petalock-test-folder/);
  expect(JSON.stringify(debugState())).not.toMatch(/[A-Z]:[\\/]|\\Users/);
  // Focus is on the step's heading.
  expect(document.activeElement).toBe(within(panel).getByRole("heading", { level: 2, name: "Test a backup" }));
});

test("a_closed_picker_opens_nothing_and_says_nothing", async () => {
  await unlocked();
  const settings = await settingsPanel();
  shell.dismissFileNext();
  fireEvent.click(within(settings).getByRole("button", { name: "Test a backup" }));
  await waitFor(() => {
    expect(sent("test_backup_pick")).toHaveLength(1);
  });
  await act(async () => {
    await new Promise((done) => window.setTimeout(done, 5));
  });
  // Settings is as it was, and Test a backup can be pressed again.
  expect(screen.queryByRole("complementary", { name: "Test a backup" })).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(within(settings).getByRole("button", { name: "Test a backup" }).getAttribute("aria-disabled")).toBeNull();
  expect(shell.testChoices()).toEqual([]);
});

test("a_second_press_while_the_picker_is_open_sends_nothing", async () => {
  await unlocked();
  const settings = await settingsPanel();
  const release = shell.holdPicker();
  fireEvent.click(within(settings).getByRole("button", { name: "Test a backup" }));
  await waitFor(() => {
    expect(within(settings).getByRole("button", { name: "Test a backup" }).getAttribute("aria-disabled")).toBe("true");
  });
  fireEvent.click(within(settings).getByRole("button", { name: "Test a backup" }));
  expect(sent("test_backup_pick")).toHaveLength(1);
  act(() => {
    release();
  });
  await screen.findByRole("complementary", { name: "Test a backup" });
  expect(sent("test_backup_pick")).toHaveLength(1);
});

test("pick_another_sends_the_choice_it_has_and_swaps_the_file", async () => {
  await unlocked();
  const panel = await openTest();
  const [first] = sent("test_backup_pick");
  expect(first).toEqual({ choice: null });
  const choice = shell.testChoiceTokens()[0];
  expect(choice).toMatch(/^[0-9a-f]{32}$/);
  shell.pickBackupNext("Older vault 2026-08-01.petalock-backup", 5 * MB);
  press(panel, "Pick another");
  await within(panel).findByText("Older vault 2026-08-01.petalock-backup");
  expect(sent("test_backup_pick")[1]).toEqual({ choice });
  expect(within(panel).getByText("5 MB")).toBeTruthy();
  expect(within(panel).queryByText(BACKUP_NAME)).toBeNull();
  // The shell forgot the first choice and holds the new one.
  expect(shell.testChoices()).toEqual([{ name: "Older vault 2026-08-01.petalock-backup", size: 5 * MB }]);
  // A closed picker leaves the file as it was.
  shell.dismissFileNext();
  press(panel, "Pick another");
  await waitFor(() => {
    expect(sent("test_backup_pick")).toHaveLength(3);
  });
  await act(async () => {
    await new Promise((done) => window.setTimeout(done, 5));
  });
  expect(within(panel).getByText("Older vault 2026-08-01.petalock-backup")).toBeTruthy();
  expect(within(panel).queryByRole("alert")).toBeNull();
});

test("test_sends_the_choice_and_the_typed_text_as_one_box_and_a_request_and_nothing_else", async () => {
  await unlocked();
  const panel = await openTest();
  const choice = shell.testChoiceTokens()[0];
  test_(panel, BACKUP_PASSWORD);
  await screen.findByRole("complementary", { name: "This backup is good" });
  expect(sent("test_backup")).toEqual([{ choice, credential: { password_or_key: BACKUP_PASSWORD }, request: expect.any(Number) as number }]);
});

test("test_is_off_until_something_is_typed", async () => {
  await unlocked();
  const panel = await openTest();
  expect(within(panel).getByRole("button", { name: "Test" }).getAttribute("aria-disabled")).toBe("true");
  press(panel, "Test");
  expect(sent("test_backup")).toEqual([]);
  type(panel, "x");
  expect(within(panel).getByRole("button", { name: "Test" }).getAttribute("aria-disabled")).toBeNull();
});

test("enter_in_the_box_tests_and_escape_closes_the_panel", async () => {
  await unlocked();
  const panel = await openTest();
  type(panel, BACKUP_PASSWORD);
  fireEvent.submit(box(panel).form as HTMLFormElement);
  await screen.findByRole("complementary", { name: "This backup is good" });
  expect(sent("test_backup")).toHaveLength(1);
  const good = screen.getByRole("complementary", { name: "This backup is good" });
  fireEvent.keyDown(good, { key: "Escape" });
  await waitFor(() => {
    expect(screen.queryByRole("complementary", { name: "This backup is good" })).toBeNull();
  });
});

test("progress_names_the_file_shows_the_bytes_and_cancel_goes_back_to_the_file", async () => {
  await unlocked();
  const panel = await openTest();
  const release = shell.holdTest();
  test_(panel, BACKUP_PASSWORD);
  const card = await screen.findByRole("region", { name: `Testing ${BACKUP_NAME}` });
  // As drawn: the bar's card, with Cancel in the panel's foot.
  const foot = panel.querySelector(".pbar") as HTMLElement;
  const job = theJob();
  // A launch-scoped job of kind "test", matched to the request the page sent.
  expect(job.kind).toBe("test");
  expect(job.scope.type).toBe("launch");
  expect(job.request).toBe(sent("test_backup")[0]?.request);
  act(() => {
    shell.sendProgress(job.operation, 750 * MB, BIG);
  });
  expect(within(card).getByText("750 MB of 1.2 GB")).toBeTruthy();
  // The box is gone while it works: nothing typed is on the page.
  expect(document.querySelectorAll("aside.panel input")).toHaveLength(0);
  expect(within(card).queryByRole("button")).toBeNull();
  fireEvent.click(within(foot).getByRole("button", { name: "Cancel" }));
  // A stop is the person's own: back to 23a, the file still picked, the box empty, nothing said.
  const again = await screen.findByLabelText(LABEL);
  expect((again as HTMLInputElement).value).toBe("");
  expect(screen.getByText(BACKUP_NAME)).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(sent("cancel_operation")).toEqual([{ operation: job.operation, scope: job.scope }]);
  expect(sent("forget_test_backup")).toEqual([]);
  act(() => {
    release();
  });
});

test("good_backup_shows_date_size_and_counts", async () => {
  await unlocked();
  shell.backupSummary({ created_at: "2026-10-02T12:00:00Z", items: 24, files: 6, size_on_disk: BIG });
  const panel = await openTest();
  test_(panel, BACKUP_PASSWORD);
  const good = await screen.findByRole("complementary", { name: "This backup is good" });
  expect(within(good).getByRole("heading", { level: 2, name: "This backup is good" })).toBeTruthy();
  expect(within(good).getByText(BACKUP_NAME)).toBeTruthy();
  expect([...good.querySelectorAll(".fld")].map((row) => row.textContent)).toEqual(["Made2 October 2026", "Size1.2 GB", "Items24", "Files6"]);
  expect(within(good).getByText(GOOD_WORDS)).toBeTruthy();
  expect(good.textContent).not.toContain("missing");
  expect(buttonsIn(good)).toEqual(["Close panel", "Done"]);
  // Said through the page's spoken place, and focus is on the heading.
  expect(spoken()).toContain("This backup is good.");
  expect(document.activeElement).toBe(within(good).getByRole("heading", { level: 2 }));
  // Nothing in the answer or on the page names an item.
  expect(good.textContent).not.toMatch(/Client contract|Bot admin/);
  // Done lets the file go.
  const choice = sent("test_backup")[0]?.choice;
  press(good, "Done");
  await waitFor(() => {
    expect(screen.queryByRole("complementary", { name: "This backup is good" })).toBeNull();
  });
  expect(sent("forget_test_backup")).toEqual([{ choice }]);
});

test("a_good_backup_with_files_missing_says_how_many", async () => {
  await unlocked();
  shell.backupSummary({ missing_files: 3 });
  let panel = await openTest();
  test_(panel, BACKUP_PASSWORD);
  let good = await screen.findByRole("complementary", { name: "This backup is good" });
  expect(within(good).getByText("3 files were missing when this backup was made.")).toBeTruthy();
  expect(within(good).getByText(GOOD_WORDS)).toBeTruthy();
  press(good, "Done");
  await waitFor(() => {
    expect(screen.queryByRole("complementary", { name: "This backup is good" })).toBeNull();
  });
  shell.backupSummary({ missing_files: 1 });
  panel = await openTest();
  test_(panel, BACKUP_PASSWORD);
  good = await screen.findByRole("complementary", { name: "This backup is good" });
  expect(within(good).getByText("1 file was missing when this backup was made.")).toBeTruthy();
});

test("wrong_password_says_the_one_from_that_day_and_keeps_the_file", async () => {
  await unlocked();
  const panel = await openTest();
  const choice = shell.testChoiceTokens()[0];
  test_(panel, "today's password");
  const alert = await within(panel).findByRole("alert");
  expect(alert.textContent).toBe(WRONG);
  // 23c: the box is empty and the file is still picked; Test is off until something is typed again.
  expect(box(panel).value).toBe("");
  expect(box(panel).getAttribute("aria-invalid")).toBe("true");
  expect(within(panel).getByText(BACKUP_NAME)).toBeTruthy();
  expect(within(panel).getByRole("button", { name: "Test" }).getAttribute("aria-disabled")).toBe("true");
  expect(sent("forget_test_backup")).toEqual([]);
  expect(shell.testChoiceTokens()).toEqual([choice]);
  expect(document.body.textContent).not.toContain("today's password");
  expect(document.activeElement).toBe(within(panel).getByRole("heading", { level: 2, name: "Test a backup" }));
  // The right one, on the same choice, with no new pick.
  test_(panel, BACKUP_PASSWORD);
  await screen.findByRole("complementary", { name: "This backup is good" });
  expect(sent("test_backup").map((call) => call.choice)).toEqual([choice, choice]);
  expect(sent("test_backup_pick")).toHaveLength(1);
  // Typing again takes the line away.
});

test("typing_again_takes_the_wrong_password_line_away", async () => {
  await unlocked();
  const panel = await openTest();
  test_(panel, "nope");
  await within(panel).findByRole("alert");
  type(panel, "n");
  expect(within(panel).queryByRole("alert")).toBeNull();
  expect(box(panel).getAttribute("aria-invalid")).toBeNull();
});

test("the_typed_text_is_wiped_after_every_send_and_when_the_panel_closes", async () => {
  await unlocked();
  const secret = "typed-secret-for-this-test";
  const panel = await openTest();
  const release = shell.holdTest();
  test_(panel, secret);
  await screen.findByRole("region", { name: `Testing ${BACKUP_NAME}` });
  // Sent: it is in no input, in no text and nowhere the store keeps.
  expect(document.querySelectorAll("aside.panel input")).toHaveLength(0);
  expect(document.body.textContent).not.toContain(secret);
  expect(JSON.stringify(debugState())).not.toContain(secret);
  act(() => {
    release();
  });
  // It was a wrong one: 23c, with the box empty (the wrong password's text is the page's own, never the typed text).
  await within(panel).findByRole("alert");
  expect(box(panel).value).toBe("");
  expect(JSON.stringify(debugState())).not.toContain(secret);
  expect(document.body.textContent).not.toContain(secret);

  // Closed with text typed and not sent: opening it again starts with an empty box.
  press(panel, "Cancel");
  await waitFor(() => {
    expect(screen.queryByRole("complementary", { name: "Test a backup" })).toBeNull();
  });
  const again = await openTest();
  type(again, secret);
  press(again, "Cancel");
  await waitFor(() => {
    expect(screen.queryByRole("complementary", { name: "Test a backup" })).toBeNull();
  });
  const third = await openTest();
  expect(box(third).value).toBe("");
});

test("damaged_backup_names_what_failed_in_plain_words", async () => {
  await unlocked();
  // One case per group of what the engine reports: a stored file, an item, another vault's backup, and everything else (the archive's own
  // structure, its signatures, and a word nobody listed). The page's words never carry the engine's own.
  const groups: { whats: (string | undefined)[]; words: string }[] = [
    { whats: ["backup: damaged file", "backup: entry hash", "file missing", "backup: file missing"], words: STORED_FILE },
    { whats: ["backup: damaged item"], words: AN_ITEM },
    { whats: ["backup: wrong vault"], words: OTHER_VAULT },
    {
      whats: [
        "backup: not a backup archive",
        "backup: central directory",
        "backup: end record",
        "backup: manifest mac",
        "backup: header mac",
        "backup: no header",
        "backup: no manifest",
        "backup: unexpected file",
        "backup: layout",
        "a word nobody listed",
        undefined,
      ],
      words: NOT_WHOLE,
    },
  ];
  for (const group of groups) {
    for (const what of group.whats) {
      shell.damageBackup(what);
      const panel = await openTest();
      test_(panel, BACKUP_PASSWORD);
      const damaged = await screen.findByRole("complementary", { name: "This backup is damaged" });
      expect(within(damaged).getByRole("heading", { level: 2, name: "This backup is damaged" })).toBeTruthy();
      expect(within(damaged).getByText(BACKUP_NAME)).toBeTruthy();
      expect(within(damaged).getByRole("alert").textContent, String(what)).toBe(group.words);
      expect(buttonsIn(damaged)).toEqual(["Close panel", "Done"]);
      if (what !== undefined) expect(damaged.textContent, what).not.toContain(what.replace(/^backup: /, ""));
      expect(spoken()).toContain("This backup is damaged.");
      expect(document.activeElement).toBe(within(damaged).getByRole("heading", { level: 2 }));
      press(damaged, "Done");
      await waitFor(() => {
        expect(screen.queryByRole("complementary", { name: "This backup is damaged" })).toBeNull();
      });
    }
  }
}, 60_000);

test("other_refusals_are_said_in_the_tables_words_under_the_box_and_keep_the_file", async () => {
  await unlocked();
  const panel = await openTest();
  shell.refuseNext("test_backup", { code: "core", kind: "unsupported_version" });
  test_(panel, BACKUP_PASSWORD);
  expect((await within(panel).findByRole("alert")).textContent).toBe("Update Petalock to open this vault. A newer version made it.");
  expect(within(panel).getByText(BACKUP_NAME)).toBeTruthy();
  shell.refuseNext("test_backup", { code: "core", kind: "io", what: "backup" });
  test_(panel, BACKUP_PASSWORD);
  await waitFor(() => {
    expect(within(panel).getByRole("alert").textContent).toBe("Petalock couldn't reach that folder or file. Check that the drive is connected, then try again.");
  });
  // Never the generic words, never the engine's own text.
  shell.refuseNext("test_backup", { code: "core", kind: "never_seen_before", detail: "E:/secret/folder" });
  test_(panel, BACKUP_PASSWORD);
  await waitFor(() => {
    expect(within(panel).getByRole("alert").textContent).toBe("Something went wrong. Try again. If it keeps happening, close Petalock and open it again.");
  });
  expect(document.body.textContent).not.toContain("secret");
});

test("expired_choice_asks_to_pick_again", async () => {
  await unlocked();
  const panel = await openTest();
  shell.expireTestChoices();
  test_(panel, BACKUP_PASSWORD);
  const alert = await within(panel).findByRole("alert");
  // The page's own words for this screen, not the shared "Pick the files again."
  expect(alert.textContent).toBe(EXPIRED);
  expect(document.body.textContent).not.toContain("Pick the files again.");
  // The file is gone from the panel, Test is off, and Pick a backup starts again from the picker.
  expect(within(panel).queryByText(BACKUP_NAME)).toBeNull();
  expect(within(panel).getByRole("button", { name: "Test" }).getAttribute("aria-disabled")).toBe("true");
  shell.pickBackupNext("Fresh 2026-11-01.petalock-backup", 2 * GB);
  press(panel, "Pick a backup");
  await within(panel).findByText("Fresh 2026-11-01.petalock-backup");
  expect(sent("test_backup_pick")[1]).toEqual({ choice: null });
  expect(within(panel).queryByRole("alert")).toBeNull();
  test_(panel, BACKUP_PASSWORD);
  await screen.findByRole("complementary", { name: "This backup is good" });
});

test("an_answer_refused_as_locked_means_the_choice_is_gone", async () => {
  await unlocked();
  const panel = await openTest();
  const release = shell.holdTest();
  test_(panel, BACKUP_PASSWORD);
  await screen.findByRole("region", { name: `Testing ${BACKUP_NAME}` });
  // The shell's lock epoch moved (Lock all, an idle lock, Windows locking): it drops the choice and refuses this answer.
  act(() => {
    shell.changeLockEpoch();
  });
  act(() => {
    release();
  });
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toBe(EXPIRED);
  expect(screen.queryByText(BACKUP_NAME)).toBeNull();
  expect(screen.queryByRole("complementary", { name: "This backup is good" })).toBeNull();
});

test("twenty_two_c_offers_test_this_backup", async () => {
  await unlocked();
  const settings = await settingsPanel();
  fireEvent.click(within(settings).getByRole("button", { name: "Back up" }));
  const backup = await screen.findByRole("complementary", { name: "Back up" });
  press(backup, "Back up");
  const saved = await screen.findByRole("complementary", { name: "Backup saved" });
  // Beside Done, as drawn.
  expect(buttonsIn(saved)).toEqual(["Close panel", "Test this backup", "Done"]);
  // The page was told the new backup's name and size, never its path.
  expect(document.body.textContent).not.toMatch(/[A-Z]:[\\/]/);
  press(saved, "Test this backup");
  const panel = await screen.findByRole("complementary", { name: "Test a backup" });
  // Straight to 23a with the new backup picked: its name, and no picker.
  expect(within(panel).getByText(shell.lastBackupName())).toBeTruthy();
  expect(within(panel).getByText("1.2 GB")).toBeTruthy();
  expect(sent("test_backup_pick")).toEqual([]);
  expect(screen.queryByRole("complementary", { name: "Backup saved" })).toBeNull();
  test_(panel, PASSWORD);
  await screen.findByRole("complementary", { name: "This backup is good" });
  // The choice it sent is the one the backup parked.
  expect(sent("test_backup")[0]?.choice).toBe(shell.lastBackupChoice());
});

test("test_a_backup_shown_for_a_read_only_vault", async () => {
  await unlocked(mine({ readOnly: true }));
  const settings = await settingsPanel();
  // The group is there for a read-only vault; Back up is not.
  const group = within(settings).getByRole("heading", { name: "This vault" }).closest("section") as HTMLElement;
  expect(buttonsIn(group)).toEqual(["Test a backup", "Open a backup", "Restore a backup"]);
  expect(within(settings).queryByRole("button", { name: "Back up" })).toBeNull();
  fireEvent.click(within(group).getByRole("button", { name: "Test a backup" }));
  const panel = await screen.findByRole("complementary", { name: "Test a backup" });
  test_(panel, BACKUP_PASSWORD);
  await screen.findByRole("complementary", { name: "This backup is good" });
});

test("its_vault_locking_cancels_and_forgets", async () => {
  await unlocked();
  const panel = await openTest();
  const choice = shell.testChoiceTokens()[0];
  const release = shell.holdTest();
  test_(panel, BACKUP_PASSWORD);
  await screen.findByRole("region", { name: `Testing ${BACKUP_NAME}` });
  const job = theJob();
  act(() => {
    shell.lock(session());
  });
  await screen.findByLabelText(/^Password for /);
  // The page cancelled the running test and forgot the choice; nothing of it is left on screen.
  await waitFor(() => {
    expect(sent("cancel_operation")).toEqual([{ operation: job.operation, scope: job.scope }]);
  });
  await waitFor(() => {
    expect(sent("forget_test_backup")).toEqual([{ choice }]);
  });
  expect(shell.testChoices()).toEqual([]);
  act(() => {
    release();
  });
  await act(async () => {
    await new Promise((done) => window.setTimeout(done, 10));
  });
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByRole("complementary")).toBeNull();
  expect(document.body.textContent).not.toContain(BACKUP_NAME);
});

test("a_lock_with_the_file_picked_and_nothing_running_forgets_it_too", async () => {
  await unlocked();
  await openTest();
  const choice = shell.testChoiceTokens()[0];
  act(() => {
    shell.lock(session());
  });
  await screen.findByLabelText(/^Password for /);
  await waitFor(() => {
    expect(sent("forget_test_backup")).toEqual([{ choice }]);
  });
  expect(sent("cancel_operation")).toEqual([]);
});

test("a_lock_while_the_picker_is_open_forgets_what_it_picked", async () => {
  await unlocked();
  const settings = await settingsPanel();
  const release = shell.holdPicker();
  fireEvent.click(within(settings).getByRole("button", { name: "Test a backup" }));
  await waitFor(() => {
    expect(sent("test_backup_pick")).toHaveLength(1);
  });
  act(() => {
    shell.lock(session());
  });
  await screen.findByLabelText(/^Password for /);
  act(() => {
    release();
  });
  await waitFor(() => {
    expect(sent("forget_test_backup")).toHaveLength(1);
  });
  expect(shell.testChoices()).toEqual([]);
  expect(screen.queryByRole("complementary")).toBeNull();
});

test("closing_the_panel_cancels_a_running_test_and_forgets_the_file", async () => {
  await unlocked();
  const panel = await openTest();
  const choice = shell.testChoiceTokens()[0];
  const release = shell.holdTest();
  test_(panel, BACKUP_PASSWORD);
  await screen.findByRole("region", { name: `Testing ${BACKUP_NAME}` });
  const job = theJob();
  press(panel, "Close panel");
  await waitFor(() => {
    expect(screen.queryByRole("complementary", { name: "Test a backup" })).toBeNull();
  });
  await waitFor(() => {
    expect(sent("cancel_operation")).toEqual([{ operation: job.operation, scope: job.scope }]);
  });
  expect(sent("forget_test_backup")).toEqual([{ choice }]);
  act(() => {
    release();
  });
  await act(async () => {
    await new Promise((done) => window.setTimeout(done, 10));
  });
  // Nothing comes back on screen from the test the person left.
  expect(screen.queryByRole("complementary")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
});

test("closing_before_the_job_started_event_arrives_still_stops_the_test_when_it_does", async () => {
  await unlocked();
  const panel = await openTest();
  const choice = shell.testChoiceTokens()[0];
  const release = shell.holdTest();
  // The command has begun in the shell, but its `job-started` has not reached the page: the panel says "Starting…".
  const arrive = shell.holdJobStarted();
  test_(panel, BACKUP_PASSWORD);
  await screen.findByText("Starting…");
  await waitFor(() => {
    expect(sent("test_backup")).toHaveLength(1);
  });
  const job = theJob();
  press(panel, "Close panel");
  await waitFor(() => {
    expect(screen.queryByRole("complementary", { name: "Test a backup" })).toBeNull();
  });
  // The file is forgotten at once; the stop cannot name an operation yet, so it waits for the event.
  expect(sent("forget_test_backup")).toEqual([{ choice }]);
  expect(sent("cancel_operation")).toEqual([]);
  act(() => {
    arrive();
  });
  await waitFor(() => {
    expect(sent("cancel_operation")).toEqual([{ operation: job.operation, scope: job.scope }]);
  });
  act(() => {
    release();
  });
  await act(async () => {
    await new Promise((done) => window.setTimeout(done, 10));
  });
  expect(screen.queryByRole("complementary")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
});

test("closing_before_the_job_started_event_and_an_answer_first_sends_no_stop", async () => {
  await unlocked();
  const panel = await openTest();
  const release = shell.holdTest();
  const arrive = shell.holdJobStarted();
  test_(panel, BACKUP_PASSWORD);
  await screen.findByText("Starting…");
  press(panel, "Close panel");
  await waitFor(() => {
    expect(screen.queryByRole("complementary", { name: "Test a backup" })).toBeNull();
  });
  // The shell's answer comes before the event: the wish to stop goes with the request, and the late event stops nothing.
  act(() => {
    release();
  });
  await act(async () => {
    await new Promise((done) => window.setTimeout(done, 10));
  });
  act(() => {
    arrive();
  });
  await act(async () => {
    await new Promise((done) => window.setTimeout(done, 10));
  });
  expect(sent("cancel_operation")).toEqual([]);
});

test("a_lock_epoch_alone_clears_and_hides_what_was_typed", async () => {
  await unlocked();
  const secret = "typed-secret-for-the-epoch-test";
  const panel = await openTest();
  fireEvent.click(within(panel).getByRole("button", { name: "Show what you typed" }));
  type(panel, secret);
  expect(box(panel).type).toBe("text");
  expect(box(panel).value).toBe(secret);
  // Only the epoch notification arrives: the vault's own `locked` event never does (it was missed), so the panel stays.
  act(() => {
    shell.changeLockEpoch();
  });
  await waitFor(() => {
    expect(box(panel).value).toBe("");
  });
  expect(box(panel).type).toBe("password");
  expect(within(panel).getByRole("button", { name: "Show what you typed" })).toBeTruthy();
  expect(document.body.textContent).not.toContain(secret);
  expect(JSON.stringify(debugState())).not.toContain(secret);
  // Typing again works (the box is the same panel's, not a leftover).
  type(panel, "again");
  expect(box(panel).value).toBe("again");
});

test("cancel_closes_the_panel_and_forgets_the_file", async () => {
  await unlocked();
  const panel = await openTest();
  const choice = shell.testChoiceTokens()[0];
  press(panel, "Cancel");
  await waitFor(() => {
    expect(screen.queryByRole("complementary", { name: "Test a backup" })).toBeNull();
  });
  expect(sent("forget_test_backup")).toEqual([{ choice }]);
  expect(sent("test_backup")).toEqual([]);
  expect(shell.testChoices()).toEqual([]);
  // Focus goes back to Settings' button on the side menu.
  await waitFor(() => {
    expect(document.activeElement).toBe(within(side()).getByRole("button", { name: "Settings" }));
  });
});

test("going_to_another_panel_forgets_the_file", async () => {
  await unlocked();
  await openTest();
  const choice = shell.testChoiceTokens()[0];
  // Back up, from Settings: the panel is replaced, so what it held is let go.
  fireEvent.click(within(side()).getByRole("button", { name: "Settings" }));
  await screen.findByRole("complementary", { name: "Settings" });
  await waitFor(() => {
    expect(sent("forget_test_backup")).toEqual([{ choice }]);
  });
  expect(screen.queryByRole("complementary", { name: "Test a backup" })).toBeNull();
});

test("test_backup_screens_have_no_axe_violations", async () => {
  await unlocked();
  let panel = await openTest();
  await expectNoAxe(document.body);
  // 23c
  test_(panel, "wrong");
  await within(panel).findByRole("alert");
  await expectNoAxe(document.body);
  // Working
  const release = shell.holdTest();
  test_(panel, BACKUP_PASSWORD);
  await screen.findByRole("region", { name: `Testing ${BACKUP_NAME}` });
  act(() => {
    shell.sendProgress(theJob().operation, 750 * MB, BIG);
  });
  await expectNoAxe(document.body);
  // 23b
  act(() => {
    release();
  });
  const good = await screen.findByRole("complementary", { name: "This backup is good" });
  await expectNoAxe(document.body);
  press(good, "Done");
  // 23d
  shell.damageBackup("backup: damaged file");
  panel = await openTest();
  test_(panel, BACKUP_PASSWORD);
  await screen.findByRole("complementary", { name: "This backup is damaged" });
  await expectNoAxe(document.body);
  press(screen.getByRole("complementary", { name: "This backup is damaged" }), "Done");
  // 23a after an expired choice (no file picked).
  panel = await openTest();
  shell.expireTestChoices();
  test_(panel, BACKUP_PASSWORD);
  await within(panel).findByRole("alert");
  await expectNoAxe(document.body);
});
