// Plan 4B Task 11's screens: Save all files (N) in a folder's menu, Windows' folder picker (the shell's, so never seen here), one bar for the batch
// with a Stop, and the end (saved, renamed, damaged, gone, stopped) with the warning that the copies aren't encrypted. The pretend shell holds the
// destination, the plan and the summary's handle; the page sees names, sizes and tokens, never a path.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import App from "../App";
import { resetStoreForTests } from "../store";
import { expectNoAxe } from "../testing/axe";
import {
  FOLDER,
  FOLDER_2,
  installFakeShell,
  itemId,
  PASSWORD,
  SAVE_ALL_FOLDER,
  sampleItems,
  type FakeItem,
  type FakeShell,
  type FakeVault,
} from "../testing/fakeShell";
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
  vi.setSystemTime(new Date("2026-11-16T12:00:00Z"));
});

const KB = 1024;
const MB = KB ** 2;
const GB = KB ** 3;
const ANY_REQUEST = expect.any(Number) as number;
const HEX_32 = /^[0-9a-f]{32}$/;

const HANDOVER = { file_id: itemId(0xc1), name: "handover-demo.pdf", length: 180 * KB, media_type: "application/pdf" };
const CONTRACT = { file_id: itemId(0xc2), name: "contract-demo.pdf", length: 96 * KB, media_type: "application/pdf" };
const ARCHIVE = { file_id: itemId(0xc3), name: "project-archive-demo.zip", length: Math.round(2.4 * GB), media_type: "application/zip" };
const RECORDING = { file_id: itemId(0xc4), name: "demo-recording-demo.mp4", length: 840 * MB, media_type: "video/mp4" };
const TOTAL = HANDOVER.length + CONTRACT.length + ARCHIVE.length + RECORDING.length;

const WARNING =
  "These copies aren't encrypted, so anyone who can reach this folder can open them. Delete them when you're finished, and empty the Recycle Bin. Your vault still has its own copies.";
const KEEP_OPEN =
  "Keep the laptop open. Windows locking or sleeping stops this. Files already saved stay there, and a file only appears once it's whole and checked.";

/**
 * The sample vault, with four stored files in "Agency support agent" (one attached to a login, three file items), one that went to the trash and
 * one in another folder, which are not counted, and a key, so the folder's menu has every entry.
 */
function items(): FakeItem[] {
  return [
    ...sampleItems().map((item) => (item.id === itemId(1) ? { ...item, attachments: [HANDOVER] } : item)),
    { id: itemId(40), kind: "file", title: "Contract", collection: FOLDER, attachments: [CONTRACT] },
    { id: itemId(41), kind: "file", title: "Project archive", collection: FOLDER, attachments: [ARCHIVE] },
    { id: itemId(42), kind: "file", title: "Recording", collection: FOLDER, attachments: [RECORDING] },
    {
      id: itemId(43),
      kind: "file",
      title: "Old scan",
      collection: FOLDER,
      trashed: true,
      attachments: [{ file_id: itemId(0xc5), name: "old-scan-demo.pdf", length: 5 * KB, media_type: "application/pdf" }],
    },
    {
      id: itemId(44),
      kind: "file",
      title: "Other folder's file",
      collection: FOLDER_2,
      trashed: true,
      attachments: [{ file_id: itemId(0xc6), name: "elsewhere-demo.pdf", length: 5 * KB, media_type: "application/pdf" }],
    },
    { id: itemId(45), kind: "key", title: "DEMO_KEY", collection: FOLDER, value: "demo-save-all" },
  ];
}

function mine(extra: Partial<FakeVault> = {}): FakeVault[] {
  return [{ id: 7, name: "My vault", items: items(), ...extra }];
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

function spokenPlace(): HTMLElement {
  return document.querySelector<HTMLElement>(".tstack [role='status']") as HTMLElement;
}

function pointerOpen(button: HTMLElement) {
  button.focus();
  fireEvent.pointerDown(button, { button: 0 });
  fireEvent.click(button);
}

async function openFolder(name: string) {
  fireEvent.click(within(screen.getByRole("navigation", { name: "Vault and folders" })).getByRole("button", { name: new RegExp(`^${name}\\s+\\d+$`) }));
  await screen.findByRole("heading", { level: 1, name });
}

async function folderMenu(): Promise<HTMLElement> {
  pointerOpen(screen.getByRole("button", { name: "More for this folder" }));
  return screen.findByRole("menu");
}

/** The folder's menu, then its entry "Save all files (N)". */
async function pressSaveAll(count = 4) {
  const menu = await folderMenu();
  fireEvent.click(within(menu).getByRole("menuitem", { name: `Save all files (${String(count)})` }));
}

async function inAgency() {
  await unlocked();
  await openFolder("Agency support agent");
}

function theJob(): { request: number; operation: number; scope: { type: string; session: number; generation: number }; kind: string } {
  const [job, ...others] = shell.runningJobs();
  expect(others).toEqual([]);
  if (job === undefined) throw new Error("no job is running");
  return job;
}

/** The rows of a summary: the tile's letters, the name and the size line, as the panel shows them. */
function rows(panel: HTMLElement): string[] {
  return Array.from(panel.querySelectorAll(".frow")).map((row) => row.textContent);
}

// ---- The folder's menu ----

test("entry_counts_every_stored_file_attached_ones_included", async () => {
  await inAgency();
  const menu = await folderMenu();
  // Four: the login's attached file and three file items. A trashed item's file and another folder's are not counted.
  expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
    "Paste a .env",
    "Copy all as .env",
    "Save as .env file",
    "Save all files (4)",
    "Rename folder",
    "Delete folder",
  ]);
  // As drawn (T09f): a divider before it and one after it, so Rename and Delete stay set apart.
  const parts = Array.from(menu.querySelectorAll('[role="menuitem"], [role="separator"]')).map((part) => part.getAttribute("role"));
  expect(parts).toEqual(["menuitem", "menuitem", "menuitem", "separator", "menuitem", "separator", "menuitem", "menuitem"]);
  await expectNoAxe(menu);
});

test("entry_hidden_with_no_files", async () => {
  await unlocked();
  // Lineproof holds a login and a file that is in the trash: nothing to save.
  await openFolder("Lineproof");
  const menu = await folderMenu();
  expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Paste a .env", "Rename folder", "Delete folder"]);
  expect(within(menu).queryByText(/Save all/i)).toBeNull();
});

test("entry_shown_alone_in_a_read_only_vault", async () => {
  await unlocked(mine({ readOnly: true }));
  await openFolder("Agency support agent");
  const menu = await folderMenu();
  // Save a copy works in a read-only vault, and so does this: with no Paste, Rename or Delete there, it is the menu's only entry.
  expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Save all files (4)"]);
  expect(menu.querySelector('[role="separator"]')).toBeNull();
  fireEvent.click(within(menu).getByRole("menuitem", { name: "Save all files (4)" }));
  await screen.findByRole("complementary", { name: "4 files saved" });
  // A folder with no files has nothing to offer there, so no menu button at all.
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  await openFolder("Lineproof");
  expect(screen.queryByRole("button", { name: "More for this folder" })).toBeNull();
});

test("the_entry_is_not_in_the_trash_view", async () => {
  await unlocked();
  fireEvent.click(within(screen.getByRole("navigation", { name: "Vault and folders" })).getByRole("button", { name: /^Trash\s+\d+$/ }));
  await screen.findByRole("heading", { level: 1, name: "Trash" });
  expect(screen.queryByRole("button", { name: "More for this folder" })).toBeNull();
});

// ---- The two steps ----

test("the_page_sends_the_folder_then_the_choice_and_never_a_path", async () => {
  await inAgency();
  await pressSaveAll();
  await screen.findByRole("complementary", { name: "4 files saved" });
  expect(sent("save_all_files")).toEqual([{ session: session(), generation: generation(), folder: FOLDER }]);
  expect(sent("save_all_start")).toEqual([{ choice: expect.stringMatching(HEX_32) as string, request: ANY_REQUEST }]);
  for (const cmd of ["save_all_files", "save_all_start"]) {
    for (const args of sent(cmd)) {
      const text = JSON.stringify(args);
      expect(text).not.toMatch(/[A-Za-z]:\\|\\\\/);
      for (const file of [HANDOVER, CONTRACT, ARCHIVE, RECORDING]) expect(text).not.toContain(file.name);
    }
  }
  expect(shell.savedToDisk).toEqual([HANDOVER.name, CONTRACT.name, ARCHIVE.name, RECORDING.name]);
});

test("a_closed_picker_does_nothing", async () => {
  await inAgency();
  shell.dismissFileNext();
  await pressSaveAll();
  await waitFor(() => {
    expect(sent("save_all_files")).toHaveLength(1);
  });
  await act(async () => {
    await Promise.resolve();
  });
  expect(sent("save_all_start")).toEqual([]);
  expect(screen.queryByRole("complementary")).toBeNull();
  expect(toast()).toBe("");
  expect(shell.savedToDisk).toEqual([]);
});

test("a_refusal_before_the_start_is_said_in_words_and_nothing_starts", async () => {
  await inAgency();
  shell.refuseNext("save_all_files", { code: "invalid_input", what: "state folder" });
  await pressSaveAll();
  await waitFor(() => {
    expect(toast()).toContain("Lockbox won't save that in its own settings folder. Choose another folder.");
  });
  expect(sent("save_all_start")).toEqual([]);
  expect(screen.queryByRole("complementary")).toBeNull();
  // The race the shell guards (a folder that emptied since the menu was drawn) is said in its own words.
  shell.refuseNext("save_all_files", { code: "invalid_input", what: "no files" });
  await pressSaveAll();
  await waitFor(() => {
    expect(toast()).toContain("This folder has no files to save.");
  });
});

test("no_room_for_the_batch_is_said_with_the_numbers_and_nothing_starts", async () => {
  await inAgency();
  shell.setFreeSpace(Math.round(1.1 * GB));
  await pressSaveAll();
  await waitFor(() => {
    expect(toast()).toContain("Not enough space. These files need 3.2 GB, and this drive has 1.1 GB free.");
  });
  expect(sent("save_all_start")).toEqual([]);
  expect(screen.queryByRole("complementary")).toBeNull();
  expect(shell.savedToDisk).toEqual([]);
});

test("a_cloud_folder_asks_first_and_yes_goes_on_with_the_same_plan", async () => {
  await inAgency();
  shell.cloudPdfNext();
  await pressSaveAll();
  const dialog = await screen.findByRole("dialog", { name: "This folder is synced to the cloud" });
  expect(within(dialog).getByText("These files would be uploaded unprotected.")).toBeTruthy();
  // Nothing was started or written, and the safe answer has the first focus. The dialog moves it there a moment after it shows, so it is waited for, as
  // every other question's first focus is: on a loaded machine the dialog can be found before the move (failed under load twice in full sets).
  expect(sent("save_all_start")).toEqual([]);
  expect(shell.savedToDisk).toEqual([]);
  await waitFor(() => {
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Pick another folder" }));
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Save here anyway" }));
  await screen.findByRole("complementary", { name: "4 files saved" });
  expect(sent("save_all_files_confirm")).toEqual([{ token: expect.stringMatching(/^[A-Za-z0-9-]+$/) as string }]);
  expect(sent("save_all_files")).toHaveLength(1);
  expect(sent("save_all_start")).toHaveLength(1);
});

test("a_cloud_folder_can_be_swapped_for_another_folder", async () => {
  await inAgency();
  shell.cloudPdfNext();
  await pressSaveAll();
  const dialog = await screen.findByRole("dialog", { name: "This folder is synced to the cloud" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Pick another folder" }));
  await screen.findByRole("complementary", { name: "4 files saved" });
  expect(sent("save_all_files")).toHaveLength(2);
  expect(sent("save_all_files_confirm")).toEqual([]);
});

test("escape_on_the_cloud_question_writes_nothing", async () => {
  await inAgency();
  shell.cloudPdfNext();
  await pressSaveAll();
  const dialog = await screen.findByRole("dialog", { name: "This folder is synced to the cloud" });
  fireEvent.keyDown(dialog, { key: "Escape" });
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(sent("save_all_files_confirm")).toEqual([]);
  expect(sent("save_all_start")).toEqual([]);
  expect(shell.savedToDisk).toEqual([]);
});

test("a_cloud_yes_that_took_too_long_says_so", async () => {
  await inAgency();
  shell.cloudPdfNext();
  await pressSaveAll();
  const dialog = await screen.findByRole("dialog", { name: "This folder is synced to the cloud" });
  shell.dropParkedChoices();
  fireEvent.click(within(dialog).getByRole("button", { name: "Save here anyway" }));
  await waitFor(() => {
    expect(toast()).toContain("That took too long, so nothing was saved. Choose Save all files again.");
  });
  expect(shell.savedToDisk).toEqual([]);
  expect(screen.queryByRole("complementary")).toBeNull();
});

// ---- The bar ----

test("progress_shows_from_to_and_the_count", async () => {
  await inAgency();
  const release = shell.holdFiles();
  await pressSaveAll();
  const panel = await screen.findByRole("complementary", { name: "Saving files" });
  const place = (await within(panel).findByRole("region", { name: "Saving files" })).closest("aside") as HTMLElement;
  const job = theJob();
  expect(job.kind).toBe("save_all");
  expect(job.request).toBe(sent("save_all_start")[0]?.request);
  expect(within(panel).getByText(`From Agency support agent, to ${SAVE_ALL_FOLDER}.`)).toBeTruthy();
  expect(within(place).getByText(KEEP_OPEN)).toBeTruthy();
  // Part way into the third file: its name and "3 of 4", worked out from the bytes done against the sizes the plan holds.
  act(() => {
    shell.sendProgress(job.operation, HANDOVER.length + CONTRACT.length + 1.3 * GB, TOTAL);
  });
  expect(within(place).getByText(ARCHIVE.name)).toBeTruthy();
  expect(within(place).getByText("3 of 4")).toBeTruthy();
  expect(within(place).getByText("1.3 GB of 3.2 GB")).toBeTruthy();
  expect(screen.getAllByRole("progressbar")).toHaveLength(1);
  act(() => {
    shell.sendProgress(job.operation, TOTAL - 1000, TOTAL);
  });
  expect(within(place).getByText(RECORDING.name)).toBeTruthy();
  expect(within(place).getByText("4 of 4")).toBeTruthy();
  // One job, one Stop (as drawn): no second bar in the list's column, and auto-lock's own words once.
  expect(within(place).getByRole("button", { name: "Stop" })).toBeTruthy();
  expect(screen.getAllByText(/^Auto-lock is waiting until this finishes\./)).toHaveLength(1);
  act(() => {
    release();
  });
  await screen.findByRole("complementary", { name: "4 files saved" });
  expect(screen.queryByRole("progressbar")).toBeNull();
});

test("a_second_press_while_it_works_sends_nothing", async () => {
  await inAgency();
  const release = shell.holdFiles();
  await pressSaveAll();
  await screen.findByRole("region", { name: "Saving files" });
  await pressSaveAll();
  await act(async () => {
    await Promise.resolve();
  });
  expect(sent("save_all_files")).toHaveLength(1);
  expect(shell.runningJobs()).toHaveLength(1);
  act(() => {
    release();
  });
  await screen.findByRole("complementary", { name: "4 files saved" });
});

test("stop_ends_it_and_says_so_with_what_was_saved", async () => {
  await inAgency();
  const release = shell.holdFiles();
  await pressSaveAll();
  const place = (await screen.findByRole("region", { name: "Saving files" })).closest("aside") as HTMLElement;
  const job = theJob();
  act(() => {
    shell.sendProgress(job.operation, HANDOVER.length + CONTRACT.length + 1000, TOTAL);
  });
  fireEvent.click(within(place).getByRole("button", { name: "Stop" }));
  expect(sent("cancel_operation")).toEqual([{ operation: job.operation, scope: job.scope }]);
  const ended = await screen.findByRole("complementary", { name: "Stopped after 2 of 4 files" });
  // A Stop is a result, not a refusal.
  expect(screen.queryByRole("alert")).toBeNull();
  expect(shell.savedToDisk).toEqual([HANDOVER.name, CONTRACT.name]);
  expect(within(ended).getByRole("button", { name: "Done" })).toBeTruthy();
  act(() => {
    release();
  });
});

// ---- The end ----

test("summary_lists_saved_renamed_and_damaged", async () => {
  await unlocked(mine({ damagedFiles: [RECORDING.file_id] }));
  await openFolder("Agency support agent");
  shell.savedNamesTaken([CONTRACT.name]);
  await pressSaveAll();
  const ended = await screen.findByRole("complementary", { name: "3 of 4 files saved" });
  expect(within(ended).getByText(`In ${SAVE_ALL_FOLDER}.`)).toBeTruthy();
  // Each saved file with its type, size and, for an attachment, what it is attached to; the name is the one on disk.
  expect(rows(ended)).toEqual([
    `PDF${HANDOVER.name}180 KB, attached to Bot admin console`,
    "PDFcontract-demo (2).pdf96 KB",
    `ZIP${ARCHIVE.name}2.4 GB`,
  ]);
  expect(
    within(ended).getByText(
      "contract-demo.pdf was already in this folder, so the new copy is contract-demo (2).pdf. The one that was there is untouched.",
    ),
  ).toBeTruthy();
  expect(within(ended).getByText(`${RECORDING.name} is damaged, so it wasn't saved. A backup may have a good copy.`)).toBeTruthy();
  expect(shell.savedToDisk).toEqual([HANDOVER.name, "contract-demo (2).pdf", ARCHIVE.name]);
});

test("a_name_windows_refuses_is_said_with_its_own_sentence", async () => {
  const odd = { file_id: itemId(0xc7), name: "report: final?.pdf", length: 4 * KB, media_type: "application/pdf" };
  await unlocked(mine({ items: [...items(), { id: itemId(46), kind: "file", title: "Odd name", collection: FOLDER, attachments: [odd] }] }));
  await openFolder("Agency support agent");
  await pressSaveAll(5);
  const ended = await screen.findByRole("complementary", { name: "5 files saved" });
  expect(within(ended).getByText("report: final?.pdf can't be a file name in Windows, so it was saved as report_ final_.pdf.")).toBeTruthy();
  expect(rows(ended)).toContain("PDFreport_ final_.pdf4 KB");
  expect(ended.textContent).not.toContain("was already in this folder");
});

test("a_file_removed_from_the_vault_meanwhile_is_named", async () => {
  await inAgency();
  shell.filesGoneDuringSave([ARCHIVE.name]);
  await pressSaveAll();
  const ended = await screen.findByRole("complementary", { name: "3 of 4 files saved" });
  expect(within(ended).getByText(`${ARCHIVE.name} was removed from the vault before it was saved.`)).toBeTruthy();
  expect(rows(ended)).toHaveLength(3);
});

test("summary_shows_the_unencrypted_warning_word_for_word", async () => {
  await inAgency();
  await pressSaveAll();
  const ended = await screen.findByRole("complementary", { name: "4 files saved" });
  expect(within(ended).getByText(WARNING)).toBeTruthy();
  expect(rows(ended)).toHaveLength(4);
  // Nothing is said of a rename or a damaged file when there was none.
  expect(ended.textContent).not.toMatch(/already in this folder|damaged|removed from the vault|wasn't/);
  // The end takes focus at its heading, so it is read.
  expect(document.activeElement).toBe(within(ended).getByRole("heading", { level: 2, name: "4 files saved" }));
});

test("summary_offers_show_in_explorer", async () => {
  await inAgency();
  await pressSaveAll();
  const ended = await screen.findByRole("complementary", { name: "4 files saved" });
  fireEvent.click(within(ended).getByRole("button", { name: "Show in Explorer" }));
  await waitFor(() => {
    expect(sent("show_output_in_explorer")).toHaveLength(1);
  });
  // Only the handle goes back: no path, no name.
  expect(sent("show_output_in_explorer")).toEqual([{ output: expect.stringMatching(HEX_32) as string }]);
  expect(shell.openedFolders).toEqual([SAVE_ALL_FOLDER]);
  expect(shell.heldOutputs()).toBe(1);
  // Done puts the handle away and the panel with it, and focus goes back to the folder's menu.
  fireEvent.click(within(ended).getByRole("button", { name: "Done" }));
  await waitFor(() => {
    expect(screen.queryByRole("complementary")).toBeNull();
  });
  expect(sent("close_output")).toEqual([{ output: sent("show_output_in_explorer")[0]?.output }]);
  expect(shell.heldOutputs()).toBe(0);
  await waitFor(() => {
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "More for this folder" }));
  });
});

test("show_in_explorer_that_fails_is_said_and_one_that_lost_its_handle_says_to_open_it_from_windows", async () => {
  await inAgency();
  await pressSaveAll();
  const ended = await screen.findByRole("complementary", { name: "4 files saved" });
  shell.explorerFailsNext();
  fireEvent.click(within(ended).getByRole("button", { name: "Show in Explorer" }));
  await waitFor(() => {
    expect(toast()).toContain("Lockbox couldn't reach that folder or file.");
  });
  expect(toast()).not.toContain(SAVE_ALL_FOLDER);
  shell.dropParkedChoices();
  fireEvent.click(within(ended).getByRole("button", { name: "Show in Explorer" }));
  await waitFor(() => {
    expect(toast()).toContain("Lockbox can't open that folder now. Open it from Windows.");
  });
});

test("a_second_save_puts_the_first_summarys_handle_away", async () => {
  await inAgency();
  await pressSaveAll();
  await screen.findByRole("complementary", { name: "4 files saved" });
  expect(shell.heldOutputs()).toBe(1);
  // The menu is still there with the summary open: a second save replaces the first summary, and its handle goes with it.
  await pressSaveAll();
  await waitFor(() => {
    expect(sent("save_all_start")).toHaveLength(2);
  });
  await waitFor(() => {
    expect(sent("close_output")).toHaveLength(1);
  });
  expect(shell.heldOutputs()).toBe(1);
  expect(shell.savedToDisk).toHaveLength(8);
});

test("a_second_saves_cloud_question_puts_the_first_summarys_handle_away", async () => {
  await inAgency();
  await pressSaveAll();
  await screen.findByRole("complementary", { name: "4 files saved" });
  expect(shell.heldOutputs()).toBe(1);
  // A second save, and the folder chosen is a cloud one: the question replaces the first summary, so its handle goes now (not at expiry or lock).
  shell.cloudPdfNext();
  await pressSaveAll();
  const dialog = await screen.findByRole("dialog", { name: "This folder is synced to the cloud" });
  await waitFor(() => {
    expect(sent("close_output")).toEqual([{ output: expect.stringMatching(HEX_32) as string }]);
  });
  expect(shell.heldOutputs()).toBe(0);
  // Nothing was saved by the question, and the answer that goes on makes a new summary with a new handle, closed once by its own Done.
  expect(sent("save_all_start")).toHaveLength(1);
  fireEvent.click(within(dialog).getByRole("button", { name: "Save here anyway" }));
  const second = await screen.findByRole("complementary", { name: "4 files saved" });
  expect(sent("close_output")).toHaveLength(1);
  expect(shell.heldOutputs()).toBe(1);
  fireEvent.click(within(second).getByRole("button", { name: "Done" }));
  await waitFor(() => {
    expect(sent("close_output")).toHaveLength(2);
  });
  expect(shell.heldOutputs()).toBe(0);
});

test("a_cloud_question_answered_no_leaves_nothing_held_and_closes_nothing_twice", async () => {
  await inAgency();
  await pressSaveAll();
  await screen.findByRole("complementary", { name: "4 files saved" });
  shell.cloudPdfNext();
  await pressSaveAll();
  const dialog = await screen.findByRole("dialog", { name: "This folder is synced to the cloud" });
  fireEvent.keyDown(dialog, { key: "Escape" });
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(sent("close_output")).toHaveLength(1);
  expect(shell.heldOutputs()).toBe(0);
  expect(screen.queryByRole("complementary")).toBeNull();
});

test("a_second_save_that_never_replaces_the_summary_keeps_its_handle", async () => {
  await inAgency();
  await pressSaveAll();
  await screen.findByRole("complementary", { name: "4 files saved" });
  // The picker is closed without a folder: nothing is replaced.
  shell.dismissFileNext();
  await pressSaveAll();
  await waitFor(() => {
    expect(sent("save_all_files")).toHaveLength(2);
  });
  // A refusal at the first step (a stale folder) replaces nothing either.
  shell.refuseNext("save_all_files", { code: "invalid_input", what: "no files" });
  await pressSaveAll();
  await waitFor(() => {
    expect(toast()).toContain("This folder has no files to save.");
  });
  expect(sent("close_output")).toEqual([]);
  expect(shell.heldOutputs()).toBe(1);
  // The refusal moves the summary from the panel to the card in the list's column; it is still the first summary and its handle still works.
  const kept = await screen.findByRole("region", { name: "4 files saved" });
  fireEvent.click(within(kept).getByRole("button", { name: "Show in Explorer" }));
  await waitFor(() => {
    expect(shell.openedFolders).toEqual([SAVE_ALL_FOLDER]);
  });
  fireEvent.click(within(kept).getByRole("button", { name: "Dismiss" }));
  await waitFor(() => {
    expect(sent("close_output")).toHaveLength(1);
  });
  expect(shell.heldOutputs()).toBe(0);
});

test("a_second_save_refused_at_its_start_has_put_the_first_summarys_handle_away_once", async () => {
  await inAgency();
  await pressSaveAll();
  await screen.findByRole("complementary", { name: "4 files saved" });
  shell.changeFolderAfterPlanNext();
  await pressSaveAll();
  await waitFor(() => {
    expect(toast()).toContain("The files in this folder changed. Save them again.");
  });
  expect(screen.queryByRole("complementary")).toBeNull();
  expect(sent("close_output")).toHaveLength(1);
  expect(shell.heldOutputs()).toBe(0);
});

test("damaged_file_is_named_and_points_to_a_backup", async () => {
  await unlocked(mine({ damagedFiles: [RECORDING.file_id] }));
  await openFolder("Agency support agent");
  await pressSaveAll();
  const ended = await screen.findByRole("complementary", { name: "3 of 4 files saved" });
  const alert = within(ended).getByRole("alert");
  expect(alert.textContent).toBe(`${RECORDING.name} is damaged, so it wasn't saved. A backup may have a good copy.`);
  // The way to the backup is the button beside the sentence (Task 7); Show in Explorer and Done stay.
  expect(within(ended).getByRole("button", { name: "Open a backup" })).toBeTruthy();
  expect(within(ended).getByRole("button", { name: "Show in Explorer" })).toBeTruthy();
  expect(within(ended).getByRole("button", { name: "Done" })).toBeTruthy();
  expect(within(ended).getByText(WARNING)).toBeTruthy();
});

test("save_all_summary_offers_open_a_backup", async () => {
  await unlocked(mine({ damagedFiles: [RECORDING.file_id] }));
  await openFolder("Agency support agent");
  await pressSaveAll();
  const ended = await screen.findByRole("complementary", { name: "3 of 4 files saved" });
  // One button, after the damaged file's sentence and before the rest of the summary.
  const buttons = within(ended).getAllByRole("button", { name: "Open a backup" });
  expect(buttons).toHaveLength(1);
  const sentence = within(ended).getByRole("alert");
  expect(sentence.compareDocumentPosition(buttons[0] as HTMLElement) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(sent("open_backup_pick")).toEqual([]);
  fireEvent.click(buttons[0] as HTMLElement);
  // The picker comes first; the backup's panel takes the summary's place, and nothing is saved or changed.
  const opening = await screen.findByRole("complementary", { name: "Open a backup" });
  expect(sent("open_backup_pick")).toEqual([{ choice: null }]);
  expect(screen.queryByRole("complementary", { name: "3 of 4 files saved" })).toBeNull();
  fireEvent.click(within(opening).getByRole("button", { name: "Cancel" }));
  await waitFor(() => {
    expect(screen.queryByRole("complementary", { name: "Open a backup" })).toBeNull();
  });
  // The summary's card in the list's column is still there for the copies, with the way to the backup in it too.
  const card = await screen.findByRole("region", { name: "3 of 4 files saved" });
  expect(within(card).getByRole("button", { name: "Open a backup" })).toBeTruthy();
});

test("a_summary_with_no_damaged_file_has_no_open_a_backup_button", async () => {
  await unlocked();
  await openFolder("Agency support agent");
  await pressSaveAll();
  const ended = await screen.findByRole("complementary", { name: /files saved$/ });
  expect(within(ended).queryByRole("button", { name: "Open a backup" })).toBeNull();
});

test("stopped_names_unfinished_and_not_started", async () => {
  await inAgency();
  const release = shell.holdFiles();
  await pressSaveAll();
  const place = (await screen.findByRole("region", { name: "Saving files" })).closest("aside") as HTMLElement;
  const job = theJob();
  // Two files are done and the third is part way when Stop is pressed.
  act(() => {
    shell.sendProgress(job.operation, HANDOVER.length + CONTRACT.length + 1000, TOTAL);
  });
  fireEvent.click(within(place).getByRole("button", { name: "Stop" }));
  const ended = await screen.findByRole("complementary", { name: "Stopped after 2 of 4 files" });
  expect(within(ended).getByText(`In ${SAVE_ALL_FOLDER}.`)).toBeTruthy();
  expect(rows(ended)).toEqual([`PDF${HANDOVER.name}180 KB, attached to Bot admin console`, `PDF${CONTRACT.name}96 KB`]);
  // As drawn (Stopped): one sentence for the file that was caught and the one not started.
  expect(within(ended).getByText(`${ARCHIVE.name} wasn't finished, so nothing half-made was left. ${RECORDING.name} wasn't started.`)).toBeTruthy();
  // The copies that were made are still unencrypted, so the warning and Show in Explorer stay.
  expect(within(ended).getByText(WARNING)).toBeTruthy();
  expect(within(ended).getByRole("button", { name: "Show in Explorer" })).toBeTruthy();
  act(() => {
    release();
  });
});

test("stopped_before_the_first_file_names_every_file_and_has_nothing_to_show", async () => {
  await inAgency();
  const release = shell.holdFiles();
  await pressSaveAll();
  const place = (await screen.findByRole("region", { name: "Saving files" })).closest("aside") as HTMLElement;
  fireEvent.click(within(place).getByRole("button", { name: "Stop" }));
  const ended = await screen.findByRole("complementary", { name: "Stopped after 0 of 4 files" });
  expect(within(ended).getByText(`${HANDOVER.name} wasn't finished, so nothing half-made was left.`)).toBeTruthy();
  const named = within(ended).getByText("These files weren't started:").parentElement as HTMLElement;
  expect(within(named).getAllByRole("listitem").map((item) => item.textContent)).toEqual([CONTRACT.name, ARCHIVE.name, RECORDING.name]);
  // Nothing was saved: no folder to show, nothing unencrypted to warn about.
  expect(rows(ended)).toEqual([]);
  expect(ended.textContent).not.toContain("These copies aren't encrypted");
  expect(within(ended).queryByRole("button", { name: "Show in Explorer" })).toBeNull();
  expect(within(ended).queryByText(/^In /)).toBeNull();
  act(() => {
    release();
  });
});

test("a_full_drive_ends_it_and_says_how_many_were_saved", async () => {
  await inAgency();
  shell.batchEndsAfter(2, { code: "core", kind: "not_enough_space", needed: 10, available: 5 });
  await pressSaveAll();
  const ended = await screen.findByRole("complementary", { name: "Stopped after 2 of 4 files" });
  expect(within(ended).getByText("There isn't enough room on that drive.")).toBeTruthy();
  expect(within(ended).getByText(`${ARCHIVE.name} wasn't finished, so nothing half-made was left. ${RECORDING.name} wasn't started.`)).toBeTruthy();
});

test("a_drive_that_filled_mid_file_says_the_same_words_with_no_figures", async () => {
  await inAgency();
  // The engine's refusal for a disk-full write or flush carries 0 and 0 when it did not know the figures; the summary's words do not depend on them.
  shell.batchEndsAfter(2, { code: "core", kind: "not_enough_space", needed: 0, available: 0 });
  await pressSaveAll();
  const ended = await screen.findByRole("complementary", { name: "Stopped after 2 of 4 files" });
  expect(within(ended).getByText("There isn't enough room on that drive.")).toBeTruthy();
  expect(within(ended).getByText(`${ARCHIVE.name} wasn't finished, so nothing half-made was left. ${RECORDING.name} wasn't started.`)).toBeTruthy();
  expect(ended.textContent).not.toMatch(/connect|0 B/i);
  expect(rows(ended)).toHaveLength(2);
});

test("folder_changed_asks_to_save_again", async () => {
  await inAgency();
  // A file lands in the folder between the plan and the start.
  shell.changeFolderAfterPlanNext();
  await pressSaveAll();
  await waitFor(() => {
    expect(toast()).toContain("The files in this folder changed. Save them again.");
  });
  expect(screen.queryByRole("complementary")).toBeNull();
  expect(shell.savedToDisk).toEqual([]);
  expect(shell.runningJobs()).toEqual([]);
  // The list is read again, so the entry counts the file that came, and saving again goes through.
  await pressSaveAll(5);
  await screen.findByRole("complementary", { name: "5 files saved" });
});

// ---- A lock, and moving on ----

test("a_lock_during_the_save_takes_the_panel_the_bar_and_the_handle_and_says_nothing", async () => {
  await inAgency();
  const release = shell.holdFiles();
  await pressSaveAll();
  await screen.findByRole("region", { name: "Saving files" });
  act(() => {
    shell.lock(session());
  });
  await waitFor(() => {
    expect(screen.queryByRole("region", { name: "Saving files" })).toBeNull();
  });
  act(() => {
    release();
  });
  await act(async () => {
    await Promise.resolve();
  });
  expect(screen.queryByRole("alert")).toBeNull();
  expect(shell.savedToDisk).toEqual([]);
  expect(shell.heldOutputs()).toBe(0);
});

test("a_lock_with_the_summary_open_drops_the_handle", async () => {
  await inAgency();
  await pressSaveAll();
  await screen.findByRole("complementary", { name: "4 files saved" });
  expect(shell.heldOutputs()).toBe(1);
  act(() => {
    shell.lock(session());
  });
  await screen.findByLabelText(/^Password for /);
  expect(shell.heldOutputs()).toBe(0);
});

test("moving_on_keeps_the_bar_and_the_summary_in_a_card_that_dismiss_puts_away", async () => {
  await inAgency();
  shell.batchEndsAfter(1, { code: "busy", what: "vault" });
  const release = shell.holdFiles();
  await pressSaveAll();
  await screen.findByRole("region", { name: "Saving files" });
  // The person opens another item: the panel is replaced, and the bar, with its Stop, shows in the list's column (never twice).
  fireEvent.click(await screen.findByRole("button", { name: /^Note:\s*Rotation steps/ }));
  const bar = await screen.findByRole("region", { name: "Saving files" });
  expect(screen.getAllByRole("progressbar")).toHaveLength(1);
  expect(within(bar).getByRole("button", { name: "Stop" })).toBeTruthy();
  const place = spokenPlace();
  act(() => {
    release();
  });
  // The end is kept in a card, since the copies are unencrypted and the person has to hear it; the page's spoken place says it.
  const card = await screen.findByRole("region", { name: "Stopped after 1 of 4 files" });
  expect(within(card).getByText(WARNING)).toBeTruthy();
  expect(within(card).getByRole("button", { name: "Show in Explorer" })).toBeTruthy();
  expect(card.querySelector("[aria-live], [role='status'], [role='alert']")).toBeNull();
  await waitFor(() => {
    expect(place.textContent).toContain("Stopped after 1 of 4 files.");
  });
  fireEvent.click(within(card).getByRole("button", { name: "Dismiss" }));
  await waitFor(() => {
    expect(screen.queryByRole("region", { name: "Stopped after 1 of 4 files" })).toBeNull();
  });
  expect(sent("close_output")).toHaveLength(1);
});

test("a_clean_end_while_the_panel_is_elsewhere_is_still_kept_for_the_warning", async () => {
  await inAgency();
  const release = shell.holdFiles();
  await pressSaveAll();
  await screen.findByRole("region", { name: "Saving files" });
  fireEvent.click(await screen.findByRole("button", { name: /^Note:\s*Rotation steps/ }));
  act(() => {
    release();
  });
  const card = await screen.findByRole("region", { name: "4 files saved" });
  expect(within(card).getByText(WARNING)).toBeTruthy();
});

// ---- Screen readers, keys and the page's rules ----

test("the_panel_takes_focus_at_its_heading_and_escape_closes_the_end", async () => {
  await inAgency();
  const release = shell.holdFiles();
  await pressSaveAll();
  const working = await screen.findByRole("complementary", { name: "Saving files" });
  expect(document.activeElement).toBe(within(working).getByRole("heading", { level: 2, name: "Saving files" }));
  act(() => {
    release();
  });
  const done = await screen.findByRole("complementary", { name: "4 files saved" });
  fireEvent.keyDown(within(done).getByRole("button", { name: "Done" }), { key: "Escape" });
  await waitFor(() => {
    expect(screen.queryByRole("complementary")).toBeNull();
  });
  expect(sent("close_output")).toHaveLength(1);
});

test("save_all_screens_have_no_axe_violations", async () => {
  const { container } = await unlocked(mine({ damagedFiles: [RECORDING.file_id] }));
  await openFolder("Agency support agent");
  // The cloud question.
  shell.cloudPdfNext();
  await pressSaveAll();
  const dialog = await screen.findByRole("dialog", { name: "This folder is synced to the cloud" });
  await expectNoAxe(dialog);
  fireEvent.click(within(dialog).getByRole("button", { name: "Pick another folder" }));
  // The bar.
  const release = shell.holdFiles();
  await screen.findByRole("region", { name: "Saving files" });
  act(() => {
    shell.sendProgress(theJob().operation, 1000, TOTAL);
  });
  await expectNoAxe(container);
  // The end, with a damaged file.
  act(() => {
    release();
  });
  await screen.findByRole("complementary", { name: "3 of 4 files saved" });
  await expectNoAxe(container);
}, 40_000);

test("the_stopped_and_renamed_summaries_have_no_axe_violations", async () => {
  const { container } = await unlocked();
  shell.savedNamesTaken([CONTRACT.name]);
  shell.batchEndsAfter(2, { code: "core", kind: "not_enough_space", needed: 10, available: 5 });
  await openFolder("Agency support agent");
  await pressSaveAll();
  await screen.findByRole("complementary", { name: "Stopped after 2 of 4 files" });
  await expectNoAxe(container);
}, 30_000);

test("the_screen_writes_no_style_and_shows_no_path", async () => {
  await inAgency();
  await pressSaveAll();
  const ended = await screen.findByRole("complementary", { name: "4 files saved" });
  for (const element of ended.querySelectorAll("[title]")) expect(element.getAttribute("title") ?? "").not.toContain("demo");
  expect(ended.querySelector("[href], [src]")).toBeNull();
  const source = readBeside(import.meta.url, "./SaveAllFiles.tsx");
  expect(source).not.toMatch(/style=|<style/);
});
