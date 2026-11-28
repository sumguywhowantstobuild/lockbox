// Plan 4B Task 12's page: the question the shell asks when the window is closed, or Petalock is quit, while a job runs (33b, Ask 15).
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
  "It's past the point of cancelling. If you close now, Petalock finishes or undoes it the next time it opens, so nothing is lost.";

/** The shell asks; the number it gave the question is returned (the shell mints it, the first is 1). */
function asked(reason: "close" | "quit", running: string[], pastSwap = false, restoreWaiting = false): number {
  let question = 0;
  act(() => {
    question = shell.askClose(reason, { running, pastSwap, restoreWaiting });
  });
  return question;
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
  expect(answersSent()).toEqual([["close_answer", { question: 1, go: false }]]);
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
  expect(answersSent()).toEqual([["close_answer", { question: 1, go: false }]]);
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
  expect(answersSent()).toEqual([["close_answer", { question: 1, go: true }]]);
  // The question stays until the answer settles.
  expect(screen.queryByRole("dialog", { name: BACKUP_TITLE })).not.toBeNull();
  await act(async () => {
    answer();
    await Promise.resolve();
  });
  // Today's close path ran: the vault locked, and the first close is explained (5b), as it is without a question.
  expect(await screen.findByRole("dialog", { name: "Petalock stays by the clock" })).toBeTruthy();
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
  expect(answersSent()).toEqual([["close_answer", { question: 1, go: true }]]);
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
  expect(answersSent()).toEqual([["close_answer", { question: 1, go: false }]]);
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
    // Plan 4C Task 12: a question with no usable number cannot be answered, so it is not shown: missing, text, zero, negative, fractional, past what
    // a number holds exactly, and not a number at all.
    { reason: "close", running: ["backup"], past_swap: false, restore_waiting: false },
    ...["1", 0, -1, 1.5, 2 ** 53, null, Number.NaN, [1], { n: 1 }].map((question) => ({
      reason: "close",
      running: ["backup"],
      past_swap: false,
      restore_waiting: false,
      question,
    })),
  ];
  for (const payload of bad) {
    act(() => {
      shell.sendRaw("petalock://close-asked", payload);
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
    shell.sendRaw("petalock://close-asked", { reason: "close", running: ["format_disk"], past_swap: false, restore_waiting: false, question: 1 });
  });
  const dialog = await screen.findByRole("dialog", { name: "Several jobs are running" });
  expect(within(dialog).getByText("Closing will cancel them, and nothing half-made is left behind.")).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "Keep it running" }));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(answersSent()).toEqual([["close_answer", { question: 1, go: false }]]);
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
  expect(answersSent()).toEqual([["close_answer", { question: 1, go: false }]]);
  expect(shell.closeAnswers()).toEqual([false]);
  expect(shell.sessionOf(7)?.unlocked).toBe(true);
  expect(shell.windowHidden()).toBe(false);

  // Kinds the page does not know do not hide it; Close anyway runs the close, which locks and explains 5b.
  asked("close", ["format_disk"], false, true);
  const again = await screen.findByRole("dialog", { name: WAITING_TITLE });
  fireEvent.click(within(again).getByRole("button", { name: ANYWAY }));
  expect(await screen.findByRole("dialog", { name: "Petalock stays by the clock" })).toBeTruthy();
  expect(answersSent()).toEqual([
    ["close_answer", { question: 1, go: false }],
    ["close_answer", { question: 2, go: true }],
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
  expect(answersSent()).toEqual([["close_answer", { question: 1, go: false }]]);
  expect(shell.quits()).toBe(0);
});

test("close_question_with_a_waiting_restore_has_no_axe_violations", async () => {
  const { container } = await unlocked();
  asked("close", [], false, true);
  await screen.findByRole("dialog", { name: WAITING_TITLE });
  await expectNoAxe(container);
  await expectNoAxe(document.body);
});

/** The event for question `question`, as the shell sends it (the same again for a repeat). */
function eventFor(question: number, running: string[] = ["backup"]) {
  return { reason: "close", running, past_swap: false, restore_waiting: false, question };
}

// Plan 4C Task 12 (Greptile P2 of PR 8): the shell says the pending question again when Close is pressed again. Heard while the answer to that
// question is out, it is the same question, so the answer that settles still takes it away; it used to replace the one the answer was for, and
// the question stayed until one more press.
test("a_repeat_close_while_an_answer_is_in_flight_keeps_one_question", async () => {
  await unlocked();
  const id = asked("close", ["backup"]);
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
  fireEvent.click(within(dialog).getByRole("button", { name: KEEP }));
  expect(answersSent()).toEqual([["close_answer", { question: id, go: false }]]);

  // Close pressed again, and the shell says the same question again, while the answer is out. The repeat really reached the page's listener (the
  // question and its repeat: two events), so what follows is not a test of an event that never came.
  expect(shell.closeAskedHeard()).toBe(1);
  act(() => {
    shell.repeatClose();
  });
  expect(shell.closeAskedHeard()).toBe(2);
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
  await act(async () => {
    answer();
    await Promise.resolve();
  });
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  // One question, one answer: no second press was needed, and none was sent.
  expect(answersSent()).toHaveLength(1);
  expect(shell.closeAnswers()).toEqual([false]);
  expect(shell.pendingClose()).toBe(false);
});

// The shell says a question again when the page asks to hear it again; an answered question's event that arrives after its answer (late, or a
// repeat that was already on its way) must not bring the question back, for any of the ways a question ends.
test("a_repeated_event_after_its_answer_cannot_reopen_it", async () => {
  await unlocked();
  const first = asked("close", ["backup"]);
  fireEvent.click(within(await screen.findByRole("dialog", { name: BACKUP_TITLE })).getByRole("button", { name: KEEP }));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  act(() => {
    shell.sendRaw("petalock://close-asked", eventFor(first));
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(screen.queryByRole("dialog")).toBeNull();

  // A new question is a new number and shows; the old one's event arriving now changes nothing about it.
  const second = asked("quit", ["import"]);
  expect(second).not.toBe(first);
  await screen.findByRole("dialog", { name: "Files are being added" });
  act(() => {
    shell.sendRaw("petalock://close-asked", eventFor(first));
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
  expect(screen.queryByRole("dialog", { name: BACKUP_TITLE })).toBeNull();
  expect(screen.queryByRole("dialog", { name: "Files are being added" })).not.toBeNull();

  // A question nobody answered that a lock cleared may show again if the shell says it again (it may still hold it: the next test); the answered
  // first one still may not. The lock clears the second once more before the next question.
  act(() => {
    shell.changeLockEpoch("windows_locked");
  });
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  act(() => {
    shell.sendRaw("petalock://close-asked", eventFor(first));
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(screen.queryByRole("dialog")).toBeNull();
  act(() => {
    shell.sendRaw("petalock://close-asked", eventFor(second, ["import"]));
  });
  await screen.findByRole("dialog", { name: "Files are being added" });
  act(() => {
    shell.changeLockEpoch("windows_locked");
  });
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  // And the answer a question's button sends carries that question's own number, never an earlier one.
  const third = asked("close", ["backup"]);
  expect(third).toBeGreaterThan(second);
  fireEvent.click(within(await screen.findByRole("dialog", { name: BACKUP_TITLE })).getByRole("button", { name: ANYWAY }));
  await waitFor(() => {
    expect(answersSent()).toHaveLength(2);
  });
  expect(answersSent()[1]).toEqual(["close_answer", { question: third, go: true }]);

  // A control: an event numbered above any shown shows its question, so the absences above were not an `eventFor` the page throws out.
  act(() => {
    shell.sendRaw("petalock://close-asked", eventFor(third + 100, ["import"]));
  });
  expect(await screen.findByRole("dialog", { name: "Files are being added" })).toBeTruthy();
});

// The race behind it: a lock of all vaults and a close at the same moment, the lock's event reaching the page after the question. The page clears a
// question the shell still holds, and Close and Quit would do nothing at all if the page then refused every repeat. A question cleared by a lock
// before anyone answered it shows again when the shell says it again; once it is answered it never does.
test("a_question_cleared_by_a_lock_before_an_answer_shows_again_when_the_shell_repeats_it", async () => {
  await unlocked();
  const id = asked("close", ["backup"]);
  await screen.findByRole("dialog", { name: BACKUP_TITLE });
  act(() => {
    shell.changeLockEpoch("idle");
  });
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  const heard = shell.closeAskedHeard();

  // The shell still holds it, and says it again.
  act(() => {
    shell.sendRaw("petalock://close-asked", eventFor(id));
  });
  expect(shell.closeAskedHeard()).toBe(heard + 1);
  const dialog = await screen.findByRole("dialog", { name: BACKUP_TITLE });

  // Answered (the fake has none pending, so it is refused and goes quietly, as a shell that had dropped it would): now it is over for good.
  fireEvent.click(within(dialog).getByRole("button", { name: KEEP }));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(answersSent()).toEqual([["close_answer", { question: id, go: false }]]);
  act(() => {
    shell.sendRaw("petalock://close-asked", eventFor(id));
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(screen.queryByRole("dialog")).toBeNull();
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
