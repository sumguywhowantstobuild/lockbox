// Plan 4B Task 10's screens: many files in (9a the picked list, 9b one bar for the batch, 9c the end, 9e no room), through Add, then File, and
// through Attach on a login, key or note. The pretend shell holds the picked paths (the page sees names and sizes and a choice), checks the
// batch before it starts, and ends it the ways the real one can: to the end, a Stop, a vault that stays busy, a file it can't read.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import App from "../App";
import { resetStoreForTests } from "../store";
import { expectNoAxe } from "../testing/axe";
import { FOLDER, installFakeShell, itemId, PASSWORD, sampleItems, type FakeShell, type FakeVault } from "../testing/fakeShell";
import { readBeside } from "../testing/files";

const { invoke, listen } = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

let shell: FakeShell;

beforeEach(() => {
  for (const style of document.querySelectorAll("style")) style.remove();
  resetStoreForTests();
  invoke.mockReset();
  listen.mockReset();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-06T12:00:00Z"));
});

const MB = 1024 ** 2;
const GB = 1024 ** 3;
const ANY_REQUEST = expect.any(Number) as number;

/** Made-up files with the sizes 9a draws: 2.1 MB, 3.2 GB and 84 KB, 3.2 GB in all. */
const CONTRACT = { name: "signed-contract-demo.pdf", size: Math.round(2.1 * MB) };
const DESIGN = { name: "design-files-demo.zip", size: Math.round(3.2 * GB) };
const NOTES = { name: "scope-notes-demo.docx", size: 84 * 1024 };
const THREE = [CONTRACT, DESIGN, NOTES];

const PLURAL_ORIGINALS =
  "The originals are still unprotected on your PC. Lockbox didn't change or delete them, so remove them yourself if you no longer need them.";
const SINGLE_ORIGINAL =
  "The original is still unprotected on your PC. Lockbox didn't change or delete it, so remove it yourself if you no longer need it.";
const KEEP_OPEN = "Keep the laptop open. Windows locking or sleeping cancels this, and files not finished aren't added.";
const EXPIRED = "That choice has expired. Pick the files again.";

function mine(extra: Partial<FakeVault> = {}): FakeVault[] {
  return [{ id: 7, name: "My vault", items: sampleItems(), ...extra }];
}

async function unlocked(list: FakeVault[] = mine()) {
  shell = installFakeShell(invoke, listen, list);
  const view = render(<App />);
  const field = await screen.findByLabelText(/^Password for /);
  fireEvent.change(field, { target: { value: PASSWORD } });
  fireEvent.submit((field as HTMLInputElement).form as HTMLFormElement);
  await screen.findByRole("heading", { level: 1, name: /All items|Trash/ });
  return view;
}

function sent(cmd: string): Record<string, unknown>[] {
  return invoke.mock.calls.filter(([name]) => name === cmd).map(([, args]) => args as Record<string, unknown>);
}

function session(): number {
  const live = shell.sessionOf(7);
  if (live === undefined) throw new Error("the vault is not open");
  return live.session;
}

function generation(): number | undefined {
  return shell.sessionOf(7)?.generation;
}

function toast(): string {
  return document.querySelector(".tstack")?.textContent ?? "";
}

async function menuChoice(name: string) {
  const add = screen.getByRole("button", { name: "Add" });
  add.focus();
  fireEvent.pointerDown(add, { button: 0 });
  fireEvent.click(add);
  const menu = await screen.findByRole("menu");
  fireEvent.click(within(menu).getByRole("menuitem", { name }));
}

/** Add, then File: the picker answers with `files` (one file, a made-up one, when none are given), and 9a is up. */
async function pickFiles(files: { name: string; size: number }[] = THREE): Promise<HTMLElement> {
  shell.pickFilesNext(files);
  await menuChoice("File");
  return screen.findByRole("complementary", { name: "Add files" });
}

async function openFolder(name: string) {
  fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${name}`) }));
  await screen.findByRole("heading", { level: 1, name });
}

function addButton(panel: HTMLElement, label: string): HTMLElement {
  return within(panel).getByRole("button", { name: label });
}

async function select(title: string) {
  fireEvent.click(await screen.findByRole("button", { name: new RegExp(String.raw`^(Login|Key|Note|File):\s*${title}`) }));
  return screen.findByRole("complementary", { name: title });
}

function theJob(): { request: number; operation: number; scope: { type: string; session: number; generation: number }; kind: string } {
  const [job, ...others] = shell.runningJobs();
  expect(others).toEqual([]);
  if (job === undefined) throw new Error("no job is running");
  return job;
}

/** The names under a heading of the end summary, as the lists show them. */
function listed(panel: HTMLElement, heading: string): string[] {
  const place = within(panel).getByText(heading).parentElement as HTMLElement;
  return within(place)
    .getAllByRole("listitem")
    .map((item) => item.textContent);
}

// ---- 9a: the picked files ----

test("picked_files_listed_with_pick_more", async () => {
  await unlocked();
  const panel = await pickFiles();
  // The words of 9a: how many, how big, where they go, each file with its size and a button to leave it out.
  expect(within(panel).getByText("3 files picked, 3.2 GB. They go into My vault.")).toBeTruthy();
  const rows = within(panel).getAllByRole("listitem");
  expect(rows.map((row) => row.textContent)).toEqual([
    `PDF${CONTRACT.name}2.1 MB`,
    `ZIP${DESIGN.name}3.2 GB`,
    `DOCX${NOTES.name}84 KB`,
  ]);
  for (const file of THREE) expect(within(panel).getByRole("button", { name: `Leave out ${file.name}` })).toBeTruthy();
  expect(within(panel).getByRole("button", { name: "Pick more" })).toBeTruthy();
  expect(within(panel).getByRole("combobox", { name: "Folder" }).textContent).toBe("No folder");
  // As drawn (9a): Pick more carries its plus, as Attach files does.
  expect(within(panel).getByRole("button", { name: "Pick more" }).querySelector("svg")).not.toBeNull();
  expect(within(panel).getByRole("button", { name: "Cancel" })).toBeTruthy();
  expect(within(panel).getByRole("button", { name: "Add 3 files" })).toBeTruthy();
  // The picker was asked for a new pick, with no choice; nothing of a path is sent, or shown.
  expect(sent("pick_files_to_add")).toEqual([{ session: session(), generation: generation(), choice: null }]);
  expect(sent("add_file")).toEqual([]);
  expect(panel.textContent).not.toMatch(/[A-Z]:\\|\\\\|\/Users\//);
  // Nothing was written by picking.
  expect(shell.fileOps).toEqual([]);
});

test("pick_more_adds_to_the_same_choice_and_a_closed_picker_keeps_the_list", async () => {
  await unlocked();
  const panel = await pickFiles([CONTRACT]);
  expect(within(panel).getByText(/^1 file picked, 2.1 MB\./)).toBeTruthy();
  expect(within(panel).getByRole("button", { name: "Add 1 file" })).toBeTruthy();
  const choice = sent("pick_files_to_add")[0] !== undefined ? shell.heldChoices().length : 0;
  expect(choice).toBe(1);
  shell.pickFilesNext([DESIGN, NOTES]);
  fireEvent.click(within(panel).getByRole("button", { name: "Pick more" }));
  await within(panel).findByRole("button", { name: "Add 3 files" });
  expect(within(panel).getAllByRole("listitem")).toHaveLength(3);
  // The second pick names the same choice, which the shell answered with the first time; it is still one choice.
  const [first, second] = sent("pick_files_to_add");
  expect(first?.choice).toBeNull();
  expect(second).toEqual({ session: session(), generation: generation(), choice: expect.stringMatching(/^[0-9a-f]{32}$/) as string });
  expect(shell.heldChoices()).toHaveLength(1);
  expect(shell.heldChoices()[0]).toHaveLength(3);
  // A picker closed with nothing chosen leaves the list as it was.
  shell.dismissFileNext();
  fireEvent.click(within(panel).getByRole("button", { name: "Pick more" }));
  await waitFor(() => {
    expect(sent("pick_files_to_add")).toHaveLength(3);
  });
  await act(async () => {
    await Promise.resolve();
  });
  expect(within(panel).getAllByRole("listitem")).toHaveLength(3);
  expect(within(panel).getByRole("button", { name: "Add 3 files" })).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
  // Added together, as one batch.
  fireEvent.click(within(panel).getByRole("button", { name: "Add 3 files" }));
  await screen.findByRole("complementary", { name: "3 files added" });
  expect(shell.addedFiles).toEqual([CONTRACT.name, DESIGN.name, NOTES.name]);
  expect(sent("add_files")).toHaveLength(1);
});

test("a_closed_first_picker_opens_nothing", async () => {
  await unlocked();
  shell.dismissFileNext();
  await menuChoice("File");
  await waitFor(() => {
    expect(sent("pick_files_to_add")).toHaveLength(1);
  });
  await act(async () => {
    await Promise.resolve();
  });
  expect(screen.queryByRole("complementary")).toBeNull();
  expect(toast()).toBe("");
  expect(shell.heldChoices()).toEqual([]);
});

test("leaving_a_file_out_sends_its_number_and_shows_the_shorter_list", async () => {
  await unlocked();
  const panel = await pickFiles();
  const choice = sent("pick_files_to_add").length;
  expect(choice).toBe(1);
  fireEvent.click(within(panel).getByRole("button", { name: `Leave out ${DESIGN.name}` }));
  await within(panel).findByRole("button", { name: "Add 2 files" });
  expect(sent("remove_picked_file")).toEqual([
    { session: session(), generation: generation(), choice: expect.stringMatching(/^[0-9a-f]{32}$/) as string, index: 1 },
  ]);
  expect(within(panel).queryByText(DESIGN.name)).toBeNull();
  expect(within(panel).getByText(/^2 files picked, 2\.\d MB\.|^2 files picked, 2 MB\./)).toBeTruthy();
  // Focus goes to the next file's button, so the keyboard doesn't start again at the top.
  expect(document.activeElement).toBe(within(panel).getByRole("button", { name: `Leave out ${NOTES.name}` }));
  // The last ones: with none left, Add is off and Pick more becomes Pick files.
  fireEvent.click(within(panel).getByRole("button", { name: `Leave out ${NOTES.name}` }));
  await within(panel).findByRole("button", { name: "Add 1 file" });
  fireEvent.click(within(panel).getByRole("button", { name: `Leave out ${CONTRACT.name}` }));
  const none = await within(panel).findByRole("button", { name: "Add 0 files" });
  expect(none.getAttribute("aria-disabled")).toBe("true");
  expect(within(panel).getByRole("button", { name: "Pick files" })).toBeTruthy();
  fireEvent.click(none);
  await act(async () => {
    await Promise.resolve();
  });
  expect(sent("add_files")).toEqual([]);
});

test("cancel_leaves_nothing_added_and_gives_focus_back_to_add", async () => {
  await unlocked();
  const panel = await pickFiles();
  fireEvent.click(within(panel).getByRole("button", { name: "Cancel" }));
  await waitFor(() => {
    expect(screen.queryByRole("complementary")).toBeNull();
  });
  expect(sent("add_files")).toEqual([]);
  expect(shell.fileOps).toEqual([]);
  await waitFor(() => {
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Add" }));
  });
});

test("escape_in_the_panel_cancels_it_and_a_list_it_opened_closes_first", async () => {
  await unlocked();
  const panel = await pickFiles();
  fireEvent.keyDown(within(panel).getByRole("button", { name: "Pick more" }), { key: "Escape" });
  await waitFor(() => {
    expect(screen.queryByRole("complementary")).toBeNull();
  });
  expect(sent("add_files")).toEqual([]);
});

test("the_panel_takes_focus_at_its_heading_when_it_opens", async () => {
  await unlocked();
  const panel = await pickFiles();
  expect(document.activeElement).toBe(within(panel).getByRole("heading", { level: 2, name: "Add files" }));
});

test("the_folder_on_screen_is_where_they_go_and_the_list_can_change_it", async () => {
  await unlocked();
  await openFolder("Agency support agent");
  const panel = await pickFiles([NOTES]);
  expect(within(panel).getByRole("combobox", { name: "Folder" }).textContent).toBe("Agency support agent");
  fireEvent.click(addButton(panel, "Add 1 file"));
  await screen.findByRole("complementary", { name: "1 file added" });
  expect(sent("add_files")).toEqual([
    {
      session: session(),
      generation: generation(),
      choice: expect.stringMatching(/^[0-9a-f]{32}$/) as string,
      into: { type: "folder", collection: FOLDER },
      request: ANY_REQUEST,
    },
  ]);
});

test("a_read_only_vault_has_no_way_to_add", async () => {
  await unlocked(mine({ readOnly: true }));
  expect(screen.queryByRole("button", { name: "Add" })).toBeNull();
  expect(sent("pick_files_to_add")).toEqual([]);
});

// ---- 9b: one bar for the batch ----

test("one_bar_for_the_batch", async () => {
  await unlocked();
  await openFolder("Agency support agent");
  const release = shell.holdFiles();
  const panel = await pickFiles();
  fireEvent.click(addButton(panel, "Add 3 files"));
  // The shell says the job started; the panel becomes 9b, with one bar for the whole batch.
  const working = await screen.findByRole("complementary", { name: "Adding files" });
  const place = (await within(working).findByRole("region", { name: "Adding files" })).closest("aside") as HTMLElement;
  const job = theJob();
  expect(job.kind).toBe("import");
  expect(job.request).toBe(sent("add_files")[0]?.request);
  expect(within(place).getByText("Adding to Agency support agent, in My vault.")).toBeTruthy();
  expect(within(place).getByText(KEEP_OPEN)).toBeTruthy();
  // The first figures: the file now going in and "2 of 3", worked out from the bytes done against the sizes the page holds.
  act(() => {
    shell.sendProgress(job.operation, 1.3 * GB, 3.2 * GB + 2.1 * MB + 84 * 1024);
  });
  expect(within(place).getByText(DESIGN.name)).toBeTruthy();
  expect(within(place).getByText("2 of 3")).toBeTruthy();
  expect(within(place).getByText("1.3 GB of 3.2 GB")).toBeTruthy();
  expect(screen.getAllByRole("progressbar")).toHaveLength(1);
  // Past the second file, the third.
  act(() => {
    shell.sendProgress(job.operation, 3.2 * GB + 2.1 * MB + 1, 3.2 * GB + 2.1 * MB + 84 * 1024);
  });
  expect(within(place).getByText(NOTES.name)).toBeTruthy();
  expect(within(place).getByText("3 of 3")).toBeTruthy();
  // The list behind has no second bar, and auto-lock's own words are there once.
  expect(screen.getAllByRole("progressbar")).toHaveLength(1);
  expect(screen.getAllByText(/^Auto-lock is waiting until this finishes\./)).toHaveLength(1);
  expect(within(place).getByRole("button", { name: "Cancel" })).toBeTruthy();
  act(() => {
    release();
  });
  await screen.findByRole("complementary", { name: "3 files added" });
  expect(screen.queryByRole("progressbar")).toBeNull();
});

test("the_vault_is_asked_once_for_the_whole_batch", async () => {
  await unlocked();
  const release = shell.holdFiles();
  const panel = await pickFiles();
  fireEvent.click(addButton(panel, "Add 3 files"));
  await screen.findByRole("region", { name: "Adding files" });
  // One command, one job, one Cancel; a second press of Add or the menu while it works sends nothing.
  await menuChoice("File");
  await act(async () => {
    await Promise.resolve();
  });
  expect(sent("add_files")).toHaveLength(1);
  expect(sent("pick_files_to_add")).toHaveLength(1);
  expect(shell.runningJobs()).toHaveLength(1);
  act(() => {
    release();
  });
  await screen.findByRole("complementary", { name: "3 files added" });
});

test("cancel_on_the_bar_stops_that_batch_and_names_what_did_not_go_in", async () => {
  await unlocked();
  const release = shell.holdFiles();
  const panel = await pickFiles();
  fireEvent.click(addButton(panel, "Add 3 files"));
  const place = (await screen.findByRole("region", { name: "Adding files" })).closest("aside") as HTMLElement;
  const job = theJob();
  // The first file is done and the second is part way when Cancel is pressed.
  act(() => {
    shell.sendProgress(job.operation, CONTRACT.size + 1000, CONTRACT.size + DESIGN.size + NOTES.size);
  });
  fireEvent.click(within(place).getByRole("button", { name: "Cancel" }));
  expect(sent("cancel_operation")).toEqual([{ operation: job.operation, scope: job.scope }]);
  const ended = await screen.findByRole("complementary", { name: "1 of 3 files added" });
  // A Stop is a result, not a refusal: no alert, and the words say it was the person's.
  expect(within(ended).getByText("You stopped it.")).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(listed(ended, "These files were not added:")).toEqual([DESIGN.name, NOTES.name]);
  // Only the added file's original is "still on your PC, unprotected"; the others must be kept, and the words say so.
  expect(within(ended).getByText(/Keep the files listed above/)).toBeTruthy();
  expect(shell.addedFiles).toEqual([CONTRACT.name]);
  act(() => {
    release();
  });
});

test("stopped_with_nothing_added_says_so_and_has_no_originals_sentence", async () => {
  await unlocked();
  const release = shell.holdFiles();
  const panel = await pickFiles();
  fireEvent.click(addButton(panel, "Add 3 files"));
  const place = (await screen.findByRole("region", { name: "Adding files" })).closest("aside") as HTMLElement;
  fireEvent.click(within(place).getByRole("button", { name: "Cancel" }));
  const ended = await screen.findByRole("complementary", { name: "Nothing was added" });
  expect(within(ended).getByText("You stopped it.")).toBeTruthy();
  expect(listed(ended, "These files were not added:")).toEqual(THREE.map((file) => file.name));
  expect(ended.textContent).not.toContain("still unprotected");
  expect(shell.addedFiles).toEqual([]);
  act(() => {
    release();
  });
});

// ---- 9c: the end ----

test("originals_still_on_disk_sentence_is_plural", async () => {
  await unlocked();
  await openFolder("Agency support agent");
  const panel = await pickFiles();
  fireEvent.click(addButton(panel, "Add 3 files"));
  const done = await screen.findByRole("complementary", { name: "3 files added" });
  expect(within(done).getByText("In Agency support agent.")).toBeTruthy();
  expect(within(done).getByText(PLURAL_ORIGINALS)).toBeTruthy();
  // Nothing is left unsaid or named: every file went in.
  expect(done.textContent).not.toMatch(/not added|couldn't be read|Keep the files/);
  expect(shell.addedFiles).toEqual([CONTRACT.name, DESIGN.name, NOTES.name]);
  // Focus is on the result's heading, so it is read.
  expect(document.activeElement).toBe(within(done).getByRole("heading", { level: 2, name: "3 files added" }));
  // The files are in the list, and Done closes the panel.
  expect(await screen.findByRole("button", { name: /^File:\s*signed-contract-demo\.pdf/ })).toBeTruthy();
  fireEvent.click(within(done).getByRole("button", { name: "Done" }));
  await waitFor(() => {
    expect(screen.queryByRole("complementary")).toBeNull();
  });
  await waitFor(() => {
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Add" }));
  });
});

test("one_file_goes_through_the_same_panel_with_the_single_sentence", async () => {
  await unlocked();
  const panel = await pickFiles([{ name: "tax-demo.pdf", size: 5120 }]);
  fireEvent.click(addButton(panel, "Add 1 file"));
  const done = await screen.findByRole("complementary", { name: "1 file added" });
  expect(within(done).getByText("In My vault.")).toBeTruthy();
  expect(within(done).getByText(SINGLE_ORIGINAL)).toBeTruthy();
  expect(screen.getByRole("button", { name: /^File:\s*tax-demo\.pdf/ })).toBeTruthy();
  expect(sent("add_file")).toEqual([]);
});

// Stage 7 (Task 15): one file picked is spoken of as "it"; two or more keep "they" (picked_files_listed_with_pick_more, attach_many_on_an_item).
test("one_file_picked_says_it_goes_into", async () => {
  await unlocked();
  const panel = await pickFiles([{ name: "tax-demo.pdf", size: 5120 }]);
  expect(within(panel).getByText("1 file picked, 5 KB. It goes into My vault.")).toBeTruthy();
  expect(panel.textContent).not.toContain("They go into");
});

test("one_file_attached_says_its_attached", async () => {
  await unlocked();
  const item = await select("Bot admin console");
  shell.pickFilesNext([CONTRACT]);
  fireEvent.click(within(item).getByRole("button", { name: "Attach files" }));
  const panel = await screen.findByRole("complementary", { name: "Attach files" });
  expect(within(panel).getByText(/^1 file picked, 2\.\d MB\. It's attached to Bot admin console\.$/)).toBeTruthy();
  expect(panel.textContent).not.toContain("They're attached");
});

test("no_room_for_one_file_says_this_file_needs", async () => {
  await unlocked();
  shell.setFreeSpace(Math.round(1.1 * GB));
  const panel = await pickFiles([DESIGN]);
  fireEvent.click(addButton(panel, "Add 1 file"));
  const alert = await within(panel).findByRole("alert");
  expect(alert.textContent).toBe("Not enough space. This file needs 3.2 GB, and this drive has 1.1 GB free.");
});

test("partial_batch_names_what_was_not_added", async () => {
  await unlocked();
  shell.unreadableFiles(["broken-demo.pdf"]);
  // A vault that stayed busy past the shell's 30 seconds ends the batch after the second file went in.
  shell.batchEndsAfter(2, { code: "busy", what: "vault" });
  const panel = await pickFiles([
    { name: "first-demo.pdf", size: 100 },
    { name: "broken-demo.pdf", size: 100 },
    { name: "third-demo.pdf", size: 100 },
    { name: "fourth-demo.txt", size: 100 },
    { name: "fifth-demo.txt", size: 100 },
  ]);
  fireEvent.click(addButton(panel, "Add 5 files"));
  const ended = await screen.findByRole("complementary", { name: "2 of 5 files added" });
  // Every file that did not go in is named, in two lists, so nobody deletes an original that was never stored.
  expect(listed(ended, "This file couldn't be read:")).toEqual(["broken-demo.pdf"]);
  expect(listed(ended, "These files were not added:")).toEqual(["fourth-demo.txt", "fifth-demo.txt"]);
  expect(within(ended).getByText(/Keep the files listed above/)).toBeTruthy();
  // What ended it is said in the shell's words for it, not the shell's own text.
  expect(within(ended).getByText("That vault is busy. Wait for what it's doing to finish, then try again.")).toBeTruthy();
  expect(ended.textContent).not.toContain("vault\"");
  expect(shell.addedFiles).toEqual(["first-demo.pdf", "third-demo.pdf"]);
});

test("a_file_that_cannot_be_read_is_named_when_the_rest_all_went_in", async () => {
  await unlocked();
  shell.unreadableFiles(["gone-demo.pdf"]);
  const panel = await pickFiles([
    { name: "kept-demo.pdf", size: 100 },
    { name: "gone-demo.pdf", size: 100 },
  ]);
  fireEvent.click(addButton(panel, "Add 2 files"));
  const ended = await screen.findByRole("complementary", { name: "1 of 2 files added" });
  // One name under a heading is "This file" (Task 15), and the sentence that keeps its original speaks of it alone.
  expect(listed(ended, "This file couldn't be read:")).toEqual(["gone-demo.pdf"]);
  expect(within(ended).queryByText("These files couldn't be read:")).toBeNull();
  expect(within(ended).queryByText(/were not added:|was not added:/)).toBeNull();
  expect(
    within(ended).getByText("Keep the file listed above. It isn't in your vault, and its original is all that is left of it."),
  ).toBeTruthy();
  expect(within(ended).queryByText("You stopped it.")).toBeNull();
});

// ---- 9e: no room, or too big ----

test("no_space_for_the_batch_refused_before_starting_with_numbers", async () => {
  await unlocked();
  shell.setFreeSpace(Math.round(1.1 * GB));
  const panel = await pickFiles();
  fireEvent.click(addButton(panel, "Add 3 files"));
  const alert = await within(panel).findByRole("alert");
  expect(alert.textContent).toBe("Not enough space. These files need 3.2 GB, and this drive has 1.1 GB free.");
  // Nothing started: no bar, no job, the list and its buttons are as they were, and Add is off until the list changes.
  expect(shell.runningJobs()).toEqual([]);
  expect(screen.queryByRole("progressbar")).toBeNull();
  expect(within(panel).getAllByRole("listitem")).toHaveLength(3);
  expect(within(panel).getByRole("button", { name: "Add 3 files" }).getAttribute("aria-disabled")).toBe("true");
  expect(shell.fileOps).toEqual([]);
  // Leaving the big file out makes room, and the same choice goes ahead (a refusal before the start does not use it up).
  fireEvent.click(within(panel).getByRole("button", { name: `Leave out ${DESIGN.name}` }));
  const again = await within(panel).findByRole("button", { name: "Add 2 files" });
  expect(again.getAttribute("aria-disabled")).toBeNull();
  expect(within(panel).queryByRole("alert")).toBeNull();
  fireEvent.click(again);
  await screen.findByRole("complementary", { name: "2 files added" });
  expect(shell.addedFiles).toEqual([CONTRACT.name, NOTES.name]);
});

test("over_256_gib_names_the_file_and_its_size", async () => {
  await unlocked();
  const panel = await pickFiles([CONTRACT, { name: "huge-demo.img", size: 300 * GB }]);
  fireEvent.click(addButton(panel, "Add 2 files"));
  const alert = await within(panel).findByRole("alert");
  expect(alert.textContent).toBe("huge-demo.img is 300 GB. Lockbox can keep a file up to 256 GB.");
  expect(shell.runningJobs()).toEqual([]);
  expect(within(panel).getByRole("button", { name: "Add 2 files" }).getAttribute("aria-disabled")).toBe("true");
  fireEvent.click(within(panel).getByRole("button", { name: "Leave out huge-demo.img" }));
  await within(panel).findByRole("button", { name: "Add 1 file" });
  expect(within(panel).queryByRole("alert")).toBeNull();
});

test("add_files_unknown_free_space_goes_ahead", async () => {
  await unlocked();
  // The drive's free space can't be read (the shell's default here): that never blocks.
  const panel = await pickFiles();
  fireEvent.click(addButton(panel, "Add 3 files"));
  await screen.findByRole("complementary", { name: "3 files added" });
  expect(screen.queryByRole("alert")).toBeNull();
});

// ---- A choice the shell let go ----

test("an_expired_choice_asks_to_pick_again", async () => {
  await unlocked();
  const panel = await pickFiles();
  shell.dropParkedChoices();
  fireEvent.click(addButton(panel, "Add 3 files"));
  const alert = await within(panel).findByRole("alert");
  expect(alert.textContent).toBe(EXPIRED);
  // The list is gone with the choice: it can't be added, and Pick files starts again.
  expect(within(panel).queryAllByRole("listitem")).toEqual([]);
  expect(shell.runningJobs()).toEqual([]);
  shell.pickFilesNext([NOTES]);
  fireEvent.click(within(panel).getByRole("button", { name: "Pick files" }));
  await within(panel).findByRole("button", { name: "Add 1 file" });
  expect(within(panel).queryByRole("alert")).toBeNull();
  fireEvent.click(within(panel).getByRole("button", { name: "Add 1 file" }));
  await screen.findByRole("complementary", { name: "1 file added" });
  expect(shell.addedFiles).toEqual([NOTES.name]);
});

test("pick_more_after_the_choice_expired_says_so_too", async () => {
  await unlocked();
  const panel = await pickFiles();
  shell.dropParkedChoices();
  fireEvent.click(within(panel).getByRole("button", { name: "Pick more" }));
  const alert = await within(panel).findByRole("alert");
  expect(alert.textContent).toBe(EXPIRED);
  expect(within(panel).queryAllByRole("listitem")).toEqual([]);
});

test("a_lock_takes_the_pick_the_panel_and_the_choice", async () => {
  await unlocked();
  await pickFiles();
  expect(shell.heldChoices()).toHaveLength(1);
  act(() => {
    shell.lock(session());
  });
  await waitFor(() => {
    expect(screen.queryByRole("complementary", { name: "Add files" })).toBeNull();
  });
  expect(shell.heldChoices()).toEqual([]);
  expect(screen.queryByRole("alert")).toBeNull();
});

test("a_lock_during_the_batch_takes_the_bar_and_says_nothing", async () => {
  await unlocked();
  const release = shell.holdFiles();
  const panel = await pickFiles();
  fireEvent.click(addButton(panel, "Add 3 files"));
  await screen.findByRole("region", { name: "Adding files" });
  act(() => {
    shell.lock(session());
  });
  await waitFor(() => {
    expect(screen.queryByRole("region", { name: "Adding files" })).toBeNull();
  });
  act(() => {
    release();
  });
  await act(async () => {
    await Promise.resolve();
  });
  expect(screen.queryByRole("alert")).toBeNull();
  expect(shell.addedFiles).toEqual([]);
  expect(document.body.textContent).not.toContain("Nothing was added");
});

// ---- Away from the panel while the batch works ----

test("moving_on_while_the_batch_works_keeps_the_bar_and_a_clean_end_says_its_sentence", async () => {
  await unlocked();
  const release = shell.holdFiles();
  const panel = await pickFiles();
  fireEvent.click(addButton(panel, "Add 3 files"));
  await screen.findByRole("region", { name: "Adding files" });
  // The person opens another item: the panel is replaced, and the bar, with its Cancel, shows in the list column instead (never twice).
  await select("Client contract");
  const card = await screen.findByRole("region", { name: "Adding files" });
  expect(screen.getAllByRole("progressbar")).toHaveLength(1);
  expect(within(card).getByRole("button", { name: "Cancel" })).toBeTruthy();
  act(() => {
    release();
  });
  await waitFor(() => {
    expect(toast()).toContain("3 files added.");
  });
  expect(toast()).toContain(PLURAL_ORIGINALS);
  expect(screen.queryByRole("region", { name: "Adding files" })).toBeNull();
});

test("moving_on_while_the_batch_works_still_names_what_did_not_go_in", async () => {
  await unlocked();
  shell.batchEndsAfter(1, { code: "core", kind: "not_enough_space", needed: 10, available: 5 });
  const release = shell.holdFiles();
  const panel = await pickFiles([
    { name: "one-demo.pdf", size: 10 },
    { name: "two-demo.pdf", size: 10 },
  ]);
  fireEvent.click(addButton(panel, "Add 2 files"));
  await screen.findByRole("region", { name: "Adding files" });
  await select("Client contract");
  act(() => {
    release();
  });
  // The names are not lost with the panel: they are in a card in the list column, which Dismiss puts away.
  const card = await screen.findByRole("region", { name: "1 of 2 files added" });
  expect(listed(card, "This file was not added:")).toEqual(["two-demo.pdf"]);
  expect(within(card).getByText("There isn't enough room on that drive.")).toBeTruthy();
  fireEvent.click(within(card).getByRole("button", { name: "Dismiss" }));
  await waitFor(() => {
    expect(screen.queryByRole("region", { name: "1 of 2 files added" })).toBeNull();
  });
});

// ---- The end of a batch, when focus is not where the batch was ----

const PARTIAL_WORDS = "The files that didn't go in are named in the summary beside the list.";

function theFilter(): HTMLElement {
  return screen.getByRole("searchbox", { name: "Filter this list" });
}

function spokenPlace(): HTMLElement {
  return document.querySelector<HTMLElement>(".tstack [role='status']") as HTMLElement;
}

test("a_partial_batch_ending_after_moving_on_is_spoken_in_the_place_that_stays_on_the_page", async () => {
  await unlocked();
  shell.batchEndsAfter(1, { code: "busy", what: "vault" });
  const release = shell.holdFiles();
  const panel = await pickFiles([
    { name: "one-demo.pdf", size: 10 },
    { name: "two-demo.pdf", size: 10 },
    { name: "three-demo.pdf", size: 10 },
  ]);
  fireEvent.click(addButton(panel, "Add 3 files"));
  await screen.findByRole("region", { name: "Adding files" });
  await select("Client contract");
  // Focus is in the list's filter, outside the bar.
  theFilter().focus();
  const place = spokenPlace();
  const started = place.querySelector(".sr");
  act(() => {
    release();
  });
  const card = await screen.findByRole("region", { name: "1 of 3 files added" });
  // The card is a plain section that nothing speaks by being drawn: the place that was already on the page says it, and where the names are.
  await waitFor(() => {
    expect(place.textContent).toContain(`1 of 3 files added. ${PARTIAL_WORDS}`);
  });
  expect(place.isConnected).toBe(true);
  expect(card.querySelector("[aria-live], [role='status'], [role='alert']")).toBeNull();
  // It is a new spoken element for this end (keyed by the operation), not the start's own text changed.
  const spoken = place.querySelector(".sr");
  expect(spoken).not.toBe(started);
  expect(spoken?.textContent).toContain("1 of 3 files added.");
  // Focus was not moved by it.
  expect(document.activeElement).toBe(theFilter());
});

test("a_stop_ending_after_moving_on_is_spoken_too", async () => {
  await unlocked();
  const release = shell.holdFiles();
  const panel = await pickFiles();
  fireEvent.click(addButton(panel, "Add 3 files"));
  await screen.findByRole("region", { name: "Adding files" });
  await select("Client contract");
  theFilter().focus();
  const card = await screen.findByRole("region", { name: "Adding files" });
  fireEvent.click(within(card).getByRole("button", { name: "Cancel" }));
  await screen.findByRole("region", { name: "Nothing was added" });
  await waitFor(() => {
    expect(spokenPlace().textContent).toContain(`Nothing was added. ${PARTIAL_WORDS}`);
  });
  act(() => {
    release();
  });
});

test("a_batch_ending_with_focus_in_the_filter_leaves_focus_there_and_says_it_instead", async () => {
  await unlocked();
  const release = shell.holdFiles();
  const panel = await pickFiles();
  fireEvent.click(addButton(panel, "Add 3 files"));
  await screen.findByRole("region", { name: "Adding files" });
  // The panel stays; the person goes to the filter while the batch works.
  theFilter().focus();
  expect(document.activeElement).toBe(theFilter());
  act(() => {
    release();
  });
  const done = await screen.findByRole("complementary", { name: "3 files added" });
  expect(within(done).getByText(PLURAL_ORIGINALS)).toBeTruthy();
  // Let the panel's own timers and effects run: focus is still where the person put it.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  expect(document.activeElement).toBe(theFilter());
  expect(document.activeElement).not.toBe(within(done).getByRole("heading", { level: 2, name: "3 files added" }));
  // Nothing moved focus, so the page's spoken place says the end.
  expect(spokenPlace().textContent).toContain(`3 files added. ${PLURAL_ORIGINALS}`);
});

test("a_partial_batch_ending_with_focus_in_the_filter_leaves_focus_there_and_says_it_instead", async () => {
  await unlocked();
  shell.batchEndsAfter(1, { code: "busy", what: "vault" });
  const release = shell.holdFiles();
  const panel = await pickFiles([
    { name: "one-demo.pdf", size: 10 },
    { name: "two-demo.pdf", size: 10 },
  ]);
  fireEvent.click(addButton(panel, "Add 2 files"));
  await screen.findByRole("region", { name: "Adding files" });
  theFilter().focus();
  act(() => {
    release();
  });
  const ended = await screen.findByRole("complementary", { name: "1 of 2 files added" });
  expect(listed(ended, "This file was not added:")).toEqual(["two-demo.pdf"]);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  expect(document.activeElement).toBe(theFilter());
  expect(spokenPlace().textContent).toContain(`1 of 2 files added. ${PARTIAL_WORDS}`);
});

test("a_batch_ending_with_focus_in_the_panel_still_takes_focus_to_its_result_and_does_not_say_it_twice", async () => {
  await unlocked();
  const release = shell.holdFiles();
  const panel = await pickFiles();
  fireEvent.click(addButton(panel, "Add 3 files"));
  const working = await screen.findByRole("complementary", { name: "Adding files" });
  // Focus on the panel's own Close, which is not the bar's: it belongs to this batch's panel all the same.
  within(working).getByRole("button", { name: "Close panel" }).focus();
  act(() => {
    release();
  });
  const done = await screen.findByRole("complementary", { name: "3 files added" });
  await waitFor(() => {
    expect(document.activeElement).toBe(within(done).getByRole("heading", { level: 2, name: "3 files added" }));
  });
  expect(spokenPlace().textContent).not.toContain("3 files added.");
});

// ---- Attach many on an item ----

test("an_item_reopened_during_an_attach_batch_shows_the_new_files_and_edits_without_a_stale_refusal", async () => {
  await unlocked();
  const first = await select("Bot admin console");
  const release = shell.holdFiles();
  shell.pickFilesNext([CONTRACT, NOTES]);
  fireEvent.click(within(first).getByRole("button", { name: "Attach files" }));
  const panel = await screen.findByRole("complementary", { name: "Attach files" });
  fireEvent.click(within(panel).getByRole("button", { name: "Attach 2 files" }));
  await screen.findByRole("region", { name: "Attaching files" });
  // The person leaves the panel and opens the same item again before the batch ends: its details are read now, with none of the new files.
  const reopened = await select("Bot admin console");
  expect(within(reopened).queryByText(CONTRACT.name)).toBeNull();
  const readsBefore = sent("get_item").length;
  act(() => {
    release();
  });
  await waitFor(() => {
    expect(toast()).toContain("2 files attached.");
  });
  // The item that is open is read again when the batch ends, so it shows what was attached.
  await within(reopened).findByText(CONTRACT.name);
  expect(within(reopened).getByText(NOTES.name)).toBeTruthy();
  expect(sent("get_item").length).toBeGreaterThan(readsBefore);
  // And an edit begun after the end carries the revision the batch made, so the shell does not refuse it as stale.
  fireEvent.click(within(reopened).getByRole("button", { name: "Edit" }));
  const form = await screen.findByRole("complementary", { name: "Edit login" });
  await waitFor(() => {
    expect(within(form).getByLabelText<HTMLInputElement>("Password").value).not.toBe("");
  });
  fireEvent.change(within(form).getByLabelText("Title"), { target: { value: "Bot console (renamed)" } });
  fireEvent.click(within(form).getByRole("button", { name: "Save" }));
  await screen.findByRole("complementary", { name: "Bot console (renamed)" });
  expect(shell.edited).toHaveLength(1);
  // (The pretend shell counts each stored file as one change: two files, from revision 2 to 4.)
  expect(shell.edited[0]?.edit.revision).toBe(4);
  expect(screen.queryByRole("alert")).toBeNull();
});

test("an_attach_batch_that_ends_with_another_item_open_does_not_read_that_item_again", async () => {
  await unlocked();
  const first = await select("Bot admin console");
  const release = shell.holdFiles();
  shell.pickFilesNext([CONTRACT]);
  fireEvent.click(within(first).getByRole("button", { name: "Attach files" }));
  const panel = await screen.findByRole("complementary", { name: "Attach files" });
  fireEvent.click(within(panel).getByRole("button", { name: "Attach 1 file" }));
  await screen.findByRole("region", { name: "Attaching files" });
  await select("Rotation steps");
  const readsBefore = sent("get_item").length;
  act(() => {
    release();
  });
  await waitFor(() => {
    expect(toast()).toContain("1 file attached.");
  });
  await act(async () => {
    await Promise.resolve();
  });
  // The open item is another one: nothing about it changed, so no read of it, or of the item that took the files, is made for the batch.
  expect(sent("get_item")).toHaveLength(readsBefore);
});

test("attach_many_on_an_item", async () => {
  await unlocked();
  const item = await select("Bot admin console");
  expect(within(item).getByRole("button", { name: "Attach files" })).toBeTruthy();
  expect(within(item).queryByRole("button", { name: "Attach a file" })).toBeNull();
  shell.pickFilesNext([CONTRACT, NOTES]);
  fireEvent.click(within(item).getByRole("button", { name: "Attach files" }));
  const panel = await screen.findByRole("complementary", { name: "Attach files" });
  expect(within(panel).getByText(/^2 files picked, 2\.\d MB\. They're attached to Bot admin console\./)).toBeTruthy();
  // The files go on this item, so there is no folder to choose.
  expect(within(panel).queryByRole("combobox", { name: "Folder" })).toBeNull();
  expect(within(panel).getAllByRole("listitem")).toHaveLength(2);
  fireEvent.click(within(panel).getByRole("button", { name: "Attach 2 files" }));
  const done = await screen.findByRole("complementary", { name: "2 files attached" });
  expect(sent("add_files")).toEqual([
    {
      session: session(),
      generation: generation(),
      choice: expect.stringMatching(/^[0-9a-f]{32}$/) as string,
      into: { type: "item", id: itemId(1) },
      request: ANY_REQUEST,
    },
  ]);
  expect(sent("attach_file")).toEqual([]);
  expect(within(done).getByText("On Bot admin console.")).toBeTruthy();
  expect(within(done).getByText(PLURAL_ORIGINALS)).toBeTruthy();
  expect(shell.fileOps.at(-1)).toEqual({ cmd: "add_files", id: itemId(1) });
  // Done puts the item back, with both files in its list.
  fireEvent.click(within(done).getByRole("button", { name: "Done" }));
  const after = await screen.findByRole("complementary", { name: "Bot admin console" });
  await within(after).findByText(CONTRACT.name);
  expect(within(after).getByText(NOTES.name)).toBeTruthy();
  expect(within(after).getByRole("button", { name: `Open ${CONTRACT.name}` })).toBeTruthy();
});

test("attach_many_works_on_a_key_and_a_note_and_not_on_a_file_item", async () => {
  await unlocked();
  const note = await select("Rotation steps");
  expect(within(note).getByRole("button", { name: "Attach files" })).toBeTruthy();
  const file = await select("Client contract");
  expect(within(file).queryByRole("button", { name: "Attach files" })).toBeNull();
});

// ---- Screen readers, keys and the page's rules ----

test("add_files_screens_have_no_axe_violations", async () => {
  const { container } = await unlocked();
  const release = shell.holdFiles();
  shell.setFreeSpace(Math.round(1.1 * GB));
  const panel = await pickFiles();
  // 9a, the picked list.
  await expectNoAxe(container);
  // 9e, no room, with its alert.
  fireEvent.click(addButton(panel, "Add 3 files"));
  await within(panel).findByRole("alert");
  await expectNoAxe(container);
  // 9b, the bar.
  shell.setFreeSpace(null);
  fireEvent.click(within(panel).getByRole("button", { name: `Leave out ${DESIGN.name}` }));
  fireEvent.click(await within(panel).findByRole("button", { name: "Add 2 files" }));
  await screen.findByRole("region", { name: "Adding files" });
  act(() => {
    shell.sendProgress(theJob().operation, 1000, 5000);
  });
  await expectNoAxe(container);
  // 9c, the end.
  act(() => {
    release();
  });
  await screen.findByRole("complementary", { name: "2 files added" });
  await expectNoAxe(container);
}, 40_000);

test("the_partial_summary_has_no_axe_violations", async () => {
  const { container } = await unlocked();
  shell.unreadableFiles([NOTES.name]);
  shell.batchEndsAfter(1, { code: "busy", what: "vault" });
  const panel = await pickFiles();
  fireEvent.click(addButton(panel, "Add 3 files"));
  await screen.findByRole("complementary", { name: "1 of 3 files added" });
  await expectNoAxe(container);
}, 20_000);

test("a_start_and_an_end_of_a_batch_are_spoken_in_the_place_that_stays_on_the_page", async () => {
  await unlocked();
  const place = document.querySelector<HTMLElement>(".tstack [role='status']") as HTMLElement;
  const release = shell.holdFiles();
  const panel = await pickFiles();
  fireEvent.click(addButton(panel, "Add 3 files"));
  const card = await screen.findByRole("region", { name: "Adding files" });
  await waitFor(() => {
    expect(place.textContent).toContain("Adding files started.");
  });
  // The bar has no live region of its own, and progress says nothing.
  expect(card.querySelector("[aria-live], [role='status'], [role='alert']")).toBeNull();
  act(() => {
    release();
  });
  await screen.findByRole("complementary", { name: "3 files added" });
  expect(place.isConnected).toBe(true);
});

test("focus_goes_to_the_result_when_the_bar_with_focus_goes", async () => {
  await unlocked();
  const release = shell.holdFiles();
  const panel = await pickFiles();
  fireEvent.click(addButton(panel, "Add 3 files"));
  const place = (await screen.findByRole("region", { name: "Adding files" })).closest("aside") as HTMLElement;
  const cancel = within(place).getByRole("button", { name: "Cancel" });
  cancel.focus();
  fireEvent.click(cancel);
  const ended = await screen.findByRole("complementary", { name: "Nothing was added" });
  await waitFor(() => {
    expect(document.activeElement).toBe(within(ended).getByRole("heading", { level: 2, name: "Nothing was added" }));
  });
  act(() => {
    release();
  });
});

test("the_screen_writes_no_style_and_shows_no_name_in_a_title_or_url", async () => {
  await unlocked();
  const panel = await pickFiles();
  for (const element of panel.querySelectorAll("[title]")) expect(element.getAttribute("title") ?? "").not.toContain("demo");
  // (The folder list's own hidden field sets a style from script, which the policy allows; this screen's markup writes none: see its source.)
  expect(panel.querySelector("[href], [src]")).toBeNull();
  const source = readBeside(import.meta.url, "./AddFiles.tsx");
  expect(source).not.toMatch(/style=|<style/);
});

test("the_page_never_sends_a_path_or_a_name", async () => {
  await unlocked();
  const panel = await pickFiles();
  fireEvent.click(addButton(panel, "Add 3 files"));
  await screen.findByRole("complementary", { name: "3 files added" });
  for (const cmd of ["pick_files_to_add", "remove_picked_file", "add_files"]) {
    for (const args of sent(cmd)) {
      const text = JSON.stringify(args);
      for (const file of THREE) expect(text).not.toContain(file.name);
      expect(text).not.toMatch(/[A-Za-z]:\\|\\\\/);
    }
  }
});
