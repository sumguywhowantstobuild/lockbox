// Plan 4B Task 12's page: the question the shell asks when the window is closed, or Lockbox is quit, while a job runs (33b, Ask 15).
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import App from "../App";
import { resetStoreForTests } from "../store";
import { expectNoAxe } from "../testing/axe";
import { installFakeShell, PASSWORD, sampleItems, type FakeShell, type FakeVault } from "../testing/fakeShell";

const { invoke, listen } = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));

afterEach(cleanup);

let shell: FakeShell;

beforeEach(() => {
  // The accessibility check leaves a `<style>` of its own in the head; each test starts without one.
  for (const style of document.querySelectorAll("style")) style.remove();
  resetStoreForTests();
  invoke.mockReset();
  listen.mockReset();
});

const MINE: FakeVault = { id: 7, name: "My vault", items: sampleItems() };

/** The app with one vault unlocked through its screen, as a person would. */
async function unlocked() {
  shell = installFakeShell(invoke, listen, [{ ...MINE }]);
  const view = render(<App />);
  const field = await screen.findByLabelText(/^Password for /);
  fireEvent.change(field, { target: { value: PASSWORD } });
  fireEvent.submit((field as HTMLInputElement).form as HTMLFormElement);
  await screen.findByRole("heading", { level: 1, name: "All items" });
  return view;
}

/** The app on its lock screen, nothing unlocked: a job with no vault (testing or restoring a backup) can still hold a close. */
async function locked() {
  shell = installFakeShell(invoke, listen, [{ ...MINE }]);
  const view = render(<App />);
  await screen.findByLabelText(/^Password for /);
  return view;
}

const KEEP = "Keep it running";
const ANYWAY = "Close anyway";

const BACKUP_TITLE = "A backup is running";
const ONE_JOB_TEXT = "Closing will cancel it, and nothing half-made is left behind.";
const MANY_TITLE = "Several jobs are running";
const MANY_TEXT = "Closing will cancel them, and nothing half-made is left behind.";
const KEEP_OPEN = "Keep it open";
const WAITING_TITLE = "A restore is waiting for your answer";
const WAITING_TEXT = "Closing cancels it. Your vault stays as it is, and you can start the restore again.";
const SWAP_TITLE = "A restore is finishing";
const SWAP_TEXT =
  "It's past the point of cancelling. If you close now, Lockbox finishes or undoes it the next time it opens, so nothing is lost.";

function asked(reason: "close" | "quit", running: string[], pastSwap = false, restoreWaiting = false) {
  act(() => {
    shell.askClose(reason, { running, pastSwap, restoreWaiting });
  });
}

function answersSent(): unknown[][] {
  return invoke.mock.calls.filter(([cmd]) => cmd === "close_answer");
}

function nothingOfTheVaultIsOnScreen() {
  const page = document.body.textContent;
  for (const secret of ["Bot admin console", "admin@example.com", "Rotation steps", "Client contract"]) {
    expect(page, secret).not.toContain(secret);
  }
}

// The design's own words for a backup (33b) and for a restore past its swap (Ask 15); the other kinds are the session's, for Ariel to change.
const TITLES: [string, string][] = [
  ["import", "Files are being added"],
  ["save_copy", "A copy is being saved"],
  ["save_all", "Files are being saved"],
  ["backup", BACKUP_TITLE],
  ["test", "A backup is being tested"],
  ["restore", "A restore is running"],
  ["restore_check", "A backup is being checked for a restore"],
  ["open_backup", "A backup is being opened"],
  ["open", "A file is being opened"],
  ["replace", "A file is being replaced"],
  ["copy_item", "An item is being copied"],
];

test("close_question_names_the_running_job", async () => {
  await unlocked();
  // 33b, word for word: one backup, and the two answers in the drawn order.
  asked("close", ["backup"]);
  const dialog = await screen.findByRole("dialog", { name: BACKUP_TITLE });
  expect(within(dialog).getByText(ONE_JOB_TEXT)).toBeTruthy();
  expect(document.getElementById(dialog.getAttribute("aria-describedby") ?? "")?.textContent).toBe(ONE_JOB_TEXT);
  expect(within(dialog).getAllByRole("button").map((button) => button.textContent)).toEqual([ANYWAY, KEEP]);
  act(() => {
    shell.changeLockEpoch();
  });
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  // Every other kind names its own job, in the same words for a Quit.
  for (const [kind, title] of TITLES) {
    asked(kind === "open" ? "quit" : "close", [kind]);
    const named = await screen.findByRole("dialog", { name: title });
    expect(within(named).getByText(ONE_JOB_TEXT), kind).toBeTruthy();
    act(() => {
      shell.changeLockEpoch();
    });
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
  }

  // The same kind twice is still one job's words; two kinds are "several", in the order the shell gave.
  asked("close", ["import", "import"]);
  await screen.findByRole("dialog", { name: "Files are being added" });
  act(() => {
    shell.changeLockEpoch();
  });
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  asked("quit", ["import", "backup"]);
  const several = await screen.findByRole("dialog", { name: MANY_TITLE });
  expect(within(several).getByText(MANY_TEXT)).toBeTruthy();
  expect(within(several).getAllByRole("button").map((button) => button.textContent)).toEqual([ANYWAY, KEEP]);
  act(() => {
    shell.changeLockEpoch();
  });
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  // A restore past its swap says Ask 15's words, whatever else runs, for Close and for Quit alike.
  for (const reason of ["close", "quit"] as const) {
    asked(reason, ["backup", "restore"], true);
    const swap = await screen.findByRole("dialog", { name: SWAP_TITLE });
    expect(within(swap).getByText(SWAP_TEXT)).toBeTruthy();
    expect(within(swap).getAllByRole("button").map((button) => button.textContent)).toEqual([ANYWAY, KEEP]);
    expect(screen.queryByText(BACKUP_TITLE)).toBeNull();
    act(() => {
      shell.changeLockEpoch();
    });
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
  }
  expect(document.querySelectorAll("style")).toHaveLength(0);
});

test("close_question_holds_focus", async () => {
  await unlocked();
  asked("close", ["backup"]);
  const dialog = await screen.findByRole("dialog", { name: BACKUP_TITLE });
  // The safe answer holds focus first: Enter right after the question shows must not cancel the job.
  await waitFor(() => {
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: KEEP }));
  });
  // The window behind is out of reach of the keyboard and of a screen reader while it shows.
  expect(screen.queryByRole("heading", { level: 1, name: "All items" })).toBeNull();
  expect(dialog.contains(document.activeElement)).toBe(true);
  expect(answersSent()).toEqual([]);
});

test("close_question_has_no_axe_violations", async () => {
  const { container } = await unlocked();
  asked("close", ["backup"]);
  await screen.findByRole("dialog", { name: BACKUP_TITLE });
  await expectNoAxe(container);
  await expectNoAxe(document.body);
  act(() => {
    shell.changeLockEpoch();
  });
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  asked("quit", ["backup", "restore"], true);
  await screen.findByRole("dialog", { name: SWAP_TITLE });
  await expectNoAxe(document.body);
});

test("keep_it_running_answers_no_and_changes_nothing", async () => {
  await unlocked();
  asked("close", ["backup"]);
  const dialog = await screen.findByRole("dialog", { name: BACKUP_TITLE });
  fireEvent.click(within(dialog).getByRole("button", { name: KEEP }));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(answersSent()).toEqual([["close_answer", { go: false }]]);
  expect(shell.closeAnswers()).toEqual([false]);
  // Nothing locked, nothing hidden, and the window is as it was.
  expect(shell.sessionOf(7)?.unlocked).toBe(true);
  expect(shell.windowHidden()).toBe(false);
  expect(shell.quits()).toBe(0);
  expect(screen.getByRole("heading", { level: 1, name: "All items" })).toBeTruthy();
});

test("escape_is_keep_it_running", async () => {
  await unlocked();
  asked("quit", ["backup"]);
  const dialog = await screen.findByRole("dialog", { name: BACKUP_TITLE });
  fireEvent.keyDown(dialog, { key: "Escape" });
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(answersSent()).toEqual([["close_answer", { go: false }]]);
  expect(shell.quits()).toBe(0);
  expect(shell.sessionOf(7)?.unlocked).toBe(true);
});

test("close_anyway_on_a_close_answers_yes_once_and_the_close_goes_on", async () => {
  await unlocked();
  asked("close", ["backup"]);
  const dialog = await screen.findByRole("dialog", { name: BACKUP_TITLE });
  const real = invoke.getMockImplementation();
  if (real === undefined) throw new Error("no fake shell");
  let answer: () => void = () => undefined;
  invoke.mockImplementation((cmd: string, args?: unknown) =>
    cmd === "close_answer"
      ? new Promise((resolve) => {
          answer = () => {
            resolve(real(cmd, args));
          };
        })
      : (real(cmd, args) as Promise<unknown>),
  );
  const button = within(dialog).getByRole("button", { name: ANYWAY });
  fireEvent.click(button);
  fireEvent.click(button);
  // Pressed twice, sent once; a second press, or Escape, while the answer is out adds nothing.
  fireEvent.keyDown(dialog, { key: "Escape" });
  expect(answersSent()).toEqual([["close_answer", { go: true }]]);
  // The question stays until the answer settles.
  expect(screen.queryByRole("dialog", { name: BACKUP_TITLE })).not.toBeNull();
  await act(async () => {
    answer();
    await Promise.resolve();
  });
  // Today's close path ran: the vault locked, and the first close is explained (5b), as it is without a question.
  expect(await screen.findByRole("dialog", { name: "Lockbox stays by the clock" })).toBeTruthy();
  expect(screen.queryByRole("dialog", { name: BACKUP_TITLE })).toBeNull();
  expect(shell.closeAnswers()).toEqual([true]);
  expect(shell.sessionOf(7)?.unlocked).toBe(false);
  nothingOfTheVaultIsOnScreen();
});

test("close_anyway_on_a_quit_answers_yes_and_the_app_quits", async () => {
  await unlocked();
  asked("quit", ["backup"]);
  const dialog = await screen.findByRole("dialog", { name: BACKUP_TITLE });
  fireEvent.click(within(dialog).getByRole("button", { name: ANYWAY }));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(answersSent()).toEqual([["close_answer", { go: true }]]);
  expect(shell.quits()).toBe(1);
});

test("a_lock_epoch_change_closes_the_question_without_answering", async () => {
  await unlocked();
  asked("close", ["backup"]);
  await screen.findByRole("dialog", { name: BACKUP_TITLE });
  // Lock all, Windows locking, or an idle lock: the shell has dropped the question, so the page has nothing to answer.
  act(() => {
    shell.changeLockEpoch("windows_locked");
  });
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(answersSent()).toEqual([]);
  expect(shell.pendingClose()).toBe(false);
});

test("the_question_shows_over_the_lock_screen_for_a_job_with_no_vault", async () => {
  await locked();
  asked("quit", ["test"]);
  const dialog = await screen.findByRole("dialog", { name: "A backup is being tested" });
  await waitFor(() => {
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: KEEP }));
  });
  fireEvent.click(within(dialog).getByRole("button", { name: KEEP }));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(answersSent()).toEqual([["close_answer", { go: false }]]);
});

test("an_answer_the_shell_says_it_has_no_question_for_closes_the_question_quietly", async () => {
  await unlocked();
  const real = invoke.getMockImplementation();
  if (real === undefined) throw new Error("no fake shell");
  invoke.mockImplementation((cmd: string, args?: unknown) =>
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- Tauri rejects with the plain object
    cmd === "close_answer" ? Promise.reject({ code: "not_found" }) : (real(cmd, args) as Promise<unknown>),
  );
  asked("close", ["backup"]);
  const dialog = await screen.findByRole("dialog", { name: BACKUP_TITLE });
  fireEvent.click(within(dialog).getByRole("button", { name: ANYWAY }));
  // The shell has no question any more (a lock cleared it): nothing is left to answer, so it goes, and says nothing.
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(screen.queryByRole("alert")).toBeNull();
  expect(document.body.textContent).not.toContain("not_found");
});

// The shell still holds a question whose answer never arrived: a later close or Quit sends no new event, so the page keeps it to be answered again.
test.each([
  ["a_bridge_that_cannot_be_reached", new Error("SENTINEL no bridge")],
  ["a_refusal_other_than_not_found", { code: "busy", what: "SENTINEL" }],
])("an_answer_that_fails_keeps_the_question_to_answer_again_%s", async (_name, failure) => {
  await unlocked();
  const real = invoke.getMockImplementation();
  if (real === undefined) throw new Error("no fake shell");
  let broken = true;
  invoke.mockImplementation((cmd: string, args?: unknown) =>
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- Tauri rejects with the plain object
    cmd === "close_answer" && broken ? Promise.reject(failure) : (real(cmd, args) as Promise<unknown>),
  );
  asked("close", ["backup"]);
  const dialog = await screen.findByRole("dialog", { name: BACKUP_TITLE });
  fireEvent.click(within(dialog).getByRole("button", { name: ANYWAY }));
  await waitFor(() => {
    expect(answersSent()).toHaveLength(1);
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  // Still asking, with nothing said of why, and the shell still holds it.
  expect(screen.queryByRole("dialog", { name: BACKUP_TITLE })).not.toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(document.body.textContent).not.toContain("SENTINEL");
  expect(shell.pendingClose()).toBe(true);
  expect(shell.sessionOf(7)?.unlocked).toBe(true);

  // Pressed again once the shell can be reached, the second answer goes through and the question goes.
  broken = false;
  fireEvent.click(within(screen.getByRole("dialog", { name: BACKUP_TITLE })).getByRole("button", { name: ANYWAY }));
  await waitFor(() => {
    expect(screen.queryByRole("dialog", { name: BACKUP_TITLE })).toBeNull();
  });
  expect(answersSent()).toHaveLength(2);
  expect(shell.closeAnswers()).toEqual([true]);
  expect(shell.pendingClose()).toBe(false);
});

test("keep_it_running_that_fails_keeps_the_question_too", async () => {
  await unlocked();
  const real = invoke.getMockImplementation();
  if (real === undefined) throw new Error("no fake shell");
  let broken = true;
  invoke.mockImplementation((cmd: string, args?: unknown) =>
    cmd === "close_answer" && broken ? Promise.reject(new Error("SENTINEL no bridge")) : (real(cmd, args) as Promise<unknown>),
  );
  asked("quit", ["backup"]);
  const dialog = await screen.findByRole("dialog", { name: BACKUP_TITLE });
  fireEvent.keyDown(dialog, { key: "Escape" });
  await waitFor(() => {
    expect(answersSent()).toHaveLength(1);
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(screen.queryByRole("dialog", { name: BACKUP_TITLE })).not.toBeNull();
  expect(document.body.textContent).not.toContain("SENTINEL");
  broken = false;
  fireEvent.click(within(screen.getByRole("dialog", { name: BACKUP_TITLE })).getByRole("button", { name: KEEP }));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(shell.closeAnswers()).toEqual([false]);
});

test("an_event_that_is_not_a_question_asks_nothing", async () => {
  await unlocked();
  const bad: unknown[] = [
    null,
    "close",
    { reason: "close" },
    { reason: "shutdown", running: ["backup"], past_swap: false, restore_waiting: false },
    { reason: "close", running: "backup", past_swap: false, restore_waiting: false },
    { reason: "close", running: ["backup"], past_swap: "no", restore_waiting: false },
    { reason: "close", running: ["backup"], past_swap: false, restore_waiting: "no" },
    // A flag that is not a boolean is not a question, even beside a running job, and even when it says yes.
    { reason: "close", running: [], past_swap: false, restore_waiting: "yes" },
    { reason: "close", running: [], past_swap: false, restore_waiting: 1 },
    { reason: "close", running: [], past_swap: false },
    // Nothing running, nothing past its swap and no restore waiting: there is nothing to say.
    { reason: "close", running: [], past_swap: false, restore_waiting: false },
  ];
  for (const payload of bad) {
    act(() => {
      shell.sendRaw("lockbox://close-asked", payload);
    });
  }
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(answersSent()).toEqual([]);
});

test("a_question_naming_only_kinds_the_page_does_not_know_still_asks", async () => {
  await unlocked();
  // The shell holds its question until it is answered, so a question the page drops leaves Close and Quit doing nothing. A job the page has no name
  // for (a kind added in the shell before the page knows it) still asks, in the words for jobs in general.
  act(() => {
    shell.sendRaw("lockbox://close-asked", { reason: "close", running: ["format_disk"], past_swap: false, restore_waiting: false });
  });
  const dialog = await screen.findByRole("dialog", { name: "Several jobs are running" });
  expect(within(dialog).getByText("Closing will cancel them, and nothing half-made is left behind.")).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "Keep it running" }));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(answersSent()).toEqual([["close_answer", { go: false }]]);
});

// Task 13d: a restore finished and waiting for its yes at 24d (nothing runs) is a question of its own.
test("close_question_says_a_restore_is_waiting", async () => {
  await unlocked();
  for (const reason of ["close", "quit"] as const) {
    asked(reason, [], false, true);
    const dialog = await screen.findByRole("dialog", { name: WAITING_TITLE });
    expect(within(dialog).getByText(WAITING_TEXT)).toBeTruthy();
    expect(document.getElementById(dialog.getAttribute("aria-describedby") ?? "")?.textContent).toBe(WAITING_TEXT);
    // Close anyway, then Keep it open; the safe one holds focus first, so a stray Enter closes nothing.
    expect(within(dialog).getAllByRole("button").map((button) => button.textContent)).toEqual([ANYWAY, KEEP_OPEN]);
    await waitFor(() => {
      expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: KEEP_OPEN }));
    });
    act(() => {
      shell.changeLockEpoch();
    });
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
  }

  // Past the swap, Ask 15's words win; a running job's question wins over the waiting restore, and says "Keep it running" as it does.
  asked("close", ["restore"], true, true);
  const swap = await screen.findByRole("dialog", { name: SWAP_TITLE });
  expect(within(swap).getAllByRole("button").map((button) => button.textContent)).toEqual([ANYWAY, KEEP]);
  act(() => {
    shell.changeLockEpoch();
  });
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  asked("close", ["backup"], false, true);
  const job = await screen.findByRole("dialog", { name: BACKUP_TITLE });
  expect(within(job).getByText(ONE_JOB_TEXT)).toBeTruthy();
  expect(within(job).getAllByRole("button").map((button) => button.textContent)).toEqual([ANYWAY, KEEP]);
  expect(screen.queryByText(WAITING_TITLE)).toBeNull();
  act(() => {
    shell.changeLockEpoch();
  });
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  asked("quit", ["import", "backup"], false, true);
  await screen.findByRole("dialog", { name: MANY_TITLE });
  expect(screen.queryByText(WAITING_TITLE)).toBeNull();
  expect(document.querySelectorAll("style")).toHaveLength(0);
});

test("a_waiting_restore_alone_is_a_question", async () => {
  await unlocked();
  // No known kind and nothing past its swap, but a restore waits: asked, and answered like any other question.
  asked("close", [], false, true);
  const dialog = await screen.findByRole("dialog", { name: WAITING_TITLE });
  fireEvent.click(within(dialog).getByRole("button", { name: KEEP_OPEN }));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(answersSent()).toEqual([["close_answer", { go: false }]]);
  expect(shell.closeAnswers()).toEqual([false]);
  expect(shell.sessionOf(7)?.unlocked).toBe(true);
  expect(shell.windowHidden()).toBe(false);

  // Kinds the page does not know do not hide it; Close anyway runs the close, which locks and explains 5b.
  asked("close", ["format_disk"], false, true);
  const again = await screen.findByRole("dialog", { name: WAITING_TITLE });
  fireEvent.click(within(again).getByRole("button", { name: ANYWAY }));
  expect(await screen.findByRole("dialog", { name: "Lockbox stays by the clock" })).toBeTruthy();
  expect(answersSent()).toEqual([
    ["close_answer", { go: false }],
    ["close_answer", { go: true }],
  ]);
  expect(shell.closeAnswers()).toEqual([false, true]);
  expect(shell.sessionOf(7)?.unlocked).toBe(false);
  nothingOfTheVaultIsOnScreen();
});

test("a_waiting_restore_alone_over_the_lock_screen_is_a_question_and_escape_keeps_it_open", async () => {
  await locked();
  asked("quit", [], false, true);
  const dialog = await screen.findByRole("dialog", { name: WAITING_TITLE });
  fireEvent.keyDown(dialog, { key: "Escape" });
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(answersSent()).toEqual([["close_answer", { go: false }]]);
  expect(shell.quits()).toBe(0);
});

test("close_question_with_a_waiting_restore_has_no_axe_violations", async () => {
  const { container } = await unlocked();
  asked("close", [], false, true);
  await screen.findByRole("dialog", { name: WAITING_TITLE });
  await expectNoAxe(container);
  await expectNoAxe(document.body);
});

test("a_second_question_while_one_shows_changes_its_words", async () => {
  await unlocked();
  asked("close", ["backup"]);
  await screen.findByRole("dialog", { name: BACKUP_TITLE });
  // The shell sends no second event while one is pending; if the page hears one anyway, it shows the latest, once.
  asked("close", ["backup"], true);
  expect(await screen.findByRole("dialog", { name: SWAP_TITLE })).toBeTruthy();
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
});
