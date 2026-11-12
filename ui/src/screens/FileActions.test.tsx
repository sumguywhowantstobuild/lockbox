// Task 19's screens: open, save a copy and replace a stored file (10a to 10f), attach one file to a login, key or note and add one
// as an item (9a to 9d, one file at a time until 4B), the app's question about opened copies a lock could not remove (10e), and
// search finding an attached file by its name (9g). Every answer that arrives after the person has moved on, and every lock, is
// tested: nothing late takes a panel, shows a result or acts on another item.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import App from "../App";
import { debugState, resetStoreForTests } from "../store";
import { expectNoAxe } from "../testing/axe";
import { FOLDER, installFakeShell, itemId, PASSWORD, sampleItems, type FakeItem, type FakeShell, type FakeVault } from "../testing/fakeShell";

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

const SEARCH = "Search every unlocked vault";
const CONTRACT = { file_id: itemId(0xa1), name: "contract-demo.pdf" };
const CONSOLE_PDF = { file_id: itemId(0xb1), name: "console-access-demo.pdf", length: 18_432, media_type: "application/pdf" };
const SETUP_EXE = { file_id: itemId(0xb2), name: "setup-demo.exe", length: 12 * 1_048_576, media_type: "application/x-msdownload" };
const TOKEN = itemId(7);

const OPENED_NOTE =
  "Opened a temporary read-only copy. Edits there aren't saved back. To change the stored file, use Replace file.";
const SAVED_NOTE = "Saved a copy. It isn't encrypted. Delete it when you're finished.";
const ADDED_NOTE =
  "File added. The original is still unprotected on your PC. Lockbox didn't change or delete it, so remove it yourself if you no longer need it.";
const ATTACHED_NOTE =
  "File attached. The original is still unprotected on your PC. Lockbox didn't change or delete it, so remove it yourself if you no longer need it.";
const PAUSE =
  "Auto-lock is waiting until this finishes. Windows locking or sleeping still locks your vaults and stops it.";
const DAMAGED = "This file is damaged, so it can't be opened or saved. A backup may have a good copy.";

/** The sample vault with a PDF on the login, a program file as an item, a key and a note. */
function items(): FakeItem[] {
  return [
    ...sampleItems().map((item) => (item.id === itemId(1) ? { ...item, attachments: [{ ...CONSOLE_PDF }] } : item)),
    { id: itemId(6), kind: "file", title: "Setup tool", collection: null, attachments: [{ ...SETUP_EXE }], modified_at: "2026-09-01T09:00:00Z" },
    { id: TOKEN, kind: "key", title: "OPENAI_API_KEY", value: "demo-key-value-1", modified_at: "2026-10-01T09:00:00Z" },
  ];
}

function mine(extra: Partial<FakeVault> = {}): FakeVault[] {
  return [{ id: 7, name: "My vault", items: items(), ...extra }];
}

async function unlocked(list: FakeVault[] = mine()) {
  shell = installFakeShell(invoke, listen, list);
  const view = render(<App />);
  await unlockThroughTheScreen();
  return view;
}

async function unlockThroughTheScreen() {
  const field = await screen.findByLabelText(/^Password for /);
  fireEvent.change(field, { target: { value: PASSWORD } });
  fireEvent.submit((field as HTMLInputElement).form as HTMLFormElement);
  await screen.findByRole("heading", { level: 1, name: /All items|Trash/ });
}

async function select(title: string) {
  const row = new RegExp(String.raw`^(Login|Key|Note|File):\s*${title}`);
  fireEvent.click(await screen.findByRole("button", { name: row }));
  return screen.findByRole("complementary", { name: title });
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

/** Add, then File, as a person would with the pointer. */
async function addFile() {
  const add = screen.getByRole("button", { name: "Add" });
  add.focus();
  fireEvent.pointerDown(add, { button: 0 });
  fireEvent.click(add);
  const menu = await screen.findByRole("menu");
  fireEvent.click(within(menu).getByRole("menuitem", { name: "File" }));
}

function nothingOfTheFileIsOnScreen() {
  const page = document.body.textContent;
  for (const word of ["contract-demo.pdf", "Client contract", "setup-demo.exe", "console-access-demo.pdf"]) {
    expect(page, word).not.toContain(word);
  }
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByRole("complementary")).toBeNull();
}

test("open_says_edits_arent_saved_back", async () => {
  const { container } = await unlocked();
  const panel = await select("Client contract");
  const open = within(panel).getByRole("button", { name: "Open contract-demo.pdf" });
  expect(open.textContent).toBe("Open");
  // Nothing happens until it is pressed; the shell is asked once, with ids and no path.
  expect(sent("open_file")).toEqual([]);
  fireEvent.click(open);
  await waitFor(() => {
    expect(toast()).toContain(OPENED_NOTE);
  });
  expect(sent("open_file")).toEqual([
    { session: session(), generation: shell.sessionOf(7)?.generation, id: itemId(4), file_id: CONTRACT.file_id, confirmed_executable: false },
  ]);
  expect(shell.fileOps).toEqual([{ cmd: "open_file", id: itemId(4), file_id: CONTRACT.file_id }]);
  // The sentence stays until it is read (not four seconds), with Got it, which takes it away.
  expect(toast()).not.toContain("contract-demo.pdf");
  const gotIt = within(document.querySelector<HTMLElement>(".tstack") as HTMLElement).getByRole("button", { name: "Got it" });
  await expectNoAxe(container);
  fireEvent.click(gotIt);
  await waitFor(() => {
    expect(toast()).not.toContain(OPENED_NOTE);
  });
  // The panel is as it was.
  expect(screen.getByRole("complementary", { name: "Client contract" })).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
});

test("program_file_asks_first", async () => {
  await unlocked();
  const panel = await select("Setup tool");
  const open = within(panel).getByRole("button", { name: "Open setup-demo.exe" });
  fireEvent.click(open);
  const dialog = await screen.findByRole("dialog", { name: "Open a program?" });
  expect(dialog.textContent).toContain("setup-demo.exe can run and change things on your PC. Only open it if you trust where it came from.");
  // The shell was asked once, without the yes; nothing was opened.
  expect(sent("open_file").map((args) => args.confirmed_executable)).toEqual([false]);
  expect(shell.fileOps).toEqual([]);
  // The safe answer has focus.
  const cancel = within(dialog).getByRole("button", { name: "Cancel" });
  await waitFor(() => {
    expect(document.activeElement).toBe(cancel);
  });
  await expectNoAxe(document.body);
  fireEvent.click(cancel);
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(sent("open_file")).toHaveLength(1);
  expect(shell.fileOps).toEqual([]);
  await waitFor(() => {
    expect(document.activeElement).toBe(open);
  });

  // Escape is no.
  fireEvent.click(open);
  const again = await screen.findByRole("dialog", { name: "Open a program?" });
  fireEvent.keyDown(again, { key: "Escape" });
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(shell.fileOps).toEqual([]);

  // Open anyway sends the shell its yes and opens.
  fireEvent.click(open);
  const third = await screen.findByRole("dialog", { name: "Open a program?" });
  // The dangerous answer is a filled red button, as drawn (10b).
  expect(within(third).getByRole("button", { name: "Open anyway" }).classList.contains("dfill")).toBe(true);
  fireEvent.click(within(third).getByRole("button", { name: "Open anyway" }));
  await waitFor(() => {
    expect(toast()).toContain(OPENED_NOTE);
  });
  expect(sent("open_file").map((args) => args.confirmed_executable)).toEqual([false, false, false, true]);
  expect(shell.fileOps).toEqual([{ cmd: "open_file", id: itemId(6), file_id: SETUP_EXE.file_id }]);
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("damaged_file_shows_10d_without_backup_button", async () => {
  await unlocked(mine({ damagedFiles: [CONTRACT.file_id] }));
  const panel = await select("Client contract");
  fireEvent.click(within(panel).getByRole("button", { name: "Open contract-demo.pdf" }));
  const refusal = await within(panel).findByRole("alert");
  expect(refusal.textContent).toBe(DAMAGED);
  // No button for a backup (opening a backup is 4B's), and the words come from the table, never the shell's own text.
  expect(screen.queryByRole("button", { name: /backup/i })).toBeNull();
  expect(panel.textContent).not.toMatch(/"kind"|code|what/);
  // The file can't be opened or saved now: those two are replaced by the words; Replace file is still the way to a good copy.
  expect(within(panel).queryByRole("button", { name: /^Open contract-demo\.pdf/ })).toBeNull();
  expect(within(panel).queryByRole("button", { name: /^Save a copy/ })).toBeNull();
  expect(within(panel).getByRole("button", { name: "Replace file contract-demo.pdf" })).toBeTruthy();
  expect(toast()).not.toContain("damaged");
  expect(shell.fileOps).toEqual([]);
  // Another item and back: the panel begins again, with its buttons.
  await select("Rotation steps");
  const back = await select("Client contract");
  expect(within(back).queryByRole("alert")).toBeNull();
  // Save a copy is refused the same way, in the same words.
  fireEvent.click(within(back).getByRole("button", { name: "Save a copy of contract-demo.pdf" }));
  expect((await within(back).findByRole("alert")).textContent).toBe(DAMAGED);
});

test("still_open_at_lock_offers_retry", async () => {
  shell = installFakeShell(invoke, listen, mine());
  shell.setLaunchNotices([{ kind: "open_cleanup", removed: 0, still_open: 2 }]);
  render(<App />);
  // On the lock screen, before any unlock: the words as drawn (10e), and Retry.
  await screen.findByText("Couldn't remove 2 opened files.");
  expect(screen.getByText("Close the app using them, then Retry. They stay readable on this PC until then.")).toBeTruthy();
  const retry = screen.getByRole("button", { name: "Retry" });
  // Still held by another app: it says how many are left.
  shell.retryLeaves(1);
  fireEvent.click(retry);
  await screen.findByText("Couldn't remove 1 opened file.");
  expect(shell.retries()).toBe(1);
  // Released: the message goes.
  shell.retryLeaves(0);
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => {
    expect(screen.queryByText(/Couldn't remove/)).toBeNull();
  });
  expect(shell.retries()).toBe(2);
  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();

  // A lock's own cleanup tells the page too, while a vault is open and after it locks.
  await unlockThroughTheScreen();
  act(() => {
    shell.lock(session());
  });
  act(() => {
    shell.tell({ kind: "open_cleanup", removed: 0, still_open: 1 });
  });
  await screen.findByText("Couldn't remove 1 opened file.");
  // A refusal of Retry is said in words, never the shell's own.
  shell.refuseNext("retry_open_cleanup", { code: "core", kind: "io" });
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  const refused = await screen.findByRole("alert");
  expect(refused.textContent).toBe("Lockbox couldn't reach that folder or file. Check that the drive is connected, then try again.");
  expect(screen.getByText("Couldn't remove 1 opened file.")).toBeTruthy();
});

test("a_notice_of_opened_copies_shows_in_the_window_too", async () => {
  await unlocked();
  act(() => {
    shell.tell({ kind: "open_cleanup", removed: 0, still_open: 3 });
  });
  await screen.findByText("Couldn't remove 3 opened files.");
  shell.retryLeaves(0);
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => {
    expect(screen.queryByText(/Couldn't remove/)).toBeNull();
  });
  // A sweep that removed some and left none says nothing.
  act(() => {
    shell.tell({ kind: "open_cleanup", removed: 2, still_open: 0 });
  });
  expect(screen.queryByText(/Couldn't remove/)).toBeNull();
});

test("save_copy_uses_the_windows_dialog", async () => {
  await unlocked();
  const panel = await select("Client contract");
  fireEvent.click(within(panel).getByRole("button", { name: "Save a copy of contract-demo.pdf" }));
  await waitFor(() => {
    expect(toast()).toContain(SAVED_NOTE);
  });
  // The shell opens the dialog and picks the place; the page sends the ids and nothing else, and has no file input or link of its own.
  expect(sent("save_file_copy")).toEqual([
    { session: session(), generation: shell.sessionOf(7)?.generation, id: itemId(4), file_id: CONTRACT.file_id },
  ]);
  expect(shell.fileOps).toEqual([{ cmd: "save_file_copy", id: itemId(4), file_id: CONTRACT.file_id }]);
  expect(document.querySelector('input[type="file"]')).toBeNull();
  expect(document.querySelector("a[download], a[href]")).toBeNull();
  expect(toast()).not.toContain("contract-demo.pdf");

  // A closed dialog says nothing and changes nothing.
  fireEvent.click(within(document.querySelector<HTMLElement>(".tstack") as HTMLElement).getByRole("button", { name: "Got it" }));
  shell.dismissFileNext();
  fireEvent.click(within(panel).getByRole("button", { name: "Save a copy of contract-demo.pdf" }));
  await waitFor(() => {
    expect(sent("save_file_copy")).toHaveLength(2);
  });
  await act(async () => {
    await Promise.resolve();
  });
  expect(toast()).toBe("");
  expect(screen.queryByRole("alert")).toBeNull();
  expect(shell.fileOps).toHaveLength(1);
});

test("replace_warns_first", async () => {
  await unlocked();
  const panel = await select("Client contract");
  const replace = within(panel).getByRole("button", { name: "Replace file contract-demo.pdf" });
  fireEvent.click(replace);
  const dialog = await screen.findByRole("dialog", { name: "Replace contract-demo.pdf?" });
  expect(dialog.textContent).toContain(
    "Lockbox will delete the stored file and keep the new one in its place. Backups you already made still hold the old one.",
  );
  // Nothing is sent, and no file is chosen, until the person says so.
  expect(sent("replace_file")).toEqual([]);
  const cancel = within(dialog).getByRole("button", { name: "Cancel" });
  await waitFor(() => {
    expect(document.activeElement).toBe(cancel);
  });
  await expectNoAxe(document.body);
  fireEvent.click(cancel);
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(sent("replace_file")).toEqual([]);
  await waitFor(() => {
    expect(document.activeElement).toBe(replace);
  });

  // A closed picker changes nothing and says nothing.
  shell.dismissFileNext();
  fireEvent.click(replace);
  fireEvent.click(within(await screen.findByRole("dialog", { name: "Replace contract-demo.pdf?" })).getByRole("button", { name: "Choose the new file" }));
  await waitFor(() => {
    expect(sent("replace_file")).toHaveLength(1);
  });
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(within(panel).getByText("contract-demo.pdf")).toBeTruthy();
  expect(toast()).toBe("");

  // The new file takes the old one's place.
  shell.pickNext("contract-v2.pdf", 4096);
  fireEvent.click(replace);
  fireEvent.click(within(await screen.findByRole("dialog", { name: "Replace contract-demo.pdf?" })).getByRole("button", { name: "Choose the new file" }));
  await waitFor(() => {
    expect(within(screen.getByRole("complementary", { name: "Client contract" })).getByText("contract-v2.pdf")).toBeTruthy();
  });
  const after = screen.getByRole("complementary", { name: "Client contract" });
  expect(within(after).queryByText("contract-demo.pdf")).toBeNull();
  expect(within(after).getByText("4 KB")).toBeTruthy();
  expect(sent("replace_file")).toEqual([
    { session: session(), generation: shell.sessionOf(7)?.generation, id: itemId(4), file_id: CONTRACT.file_id },
    { session: session(), generation: shell.sessionOf(7)?.generation, id: itemId(4), file_id: CONTRACT.file_id },
  ]);
  expect(toast()).toContain("File replaced");
  // The panel's own parts set no style attribute (the library's hidden input in the toolbar is its own).
  expect(after.querySelector("[style]")).toBeNull();
});

test("file_result_opens_with_the_same_questions", async () => {
  await unlocked();
  // The login's PDF is found by its name: a result of its own, saying which login it is attached to and the vault.
  fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
  const dialog = await screen.findByRole("dialog", { name: SEARCH });
  fireEvent.change(within(dialog).getByRole("textbox", { name: SEARCH }), { target: { value: "access" } });
  const opener = await within(dialog).findByRole("button", { name: /^File:\s*console-access-demo\.pdf/ });
  expect(opener.textContent).toContain("Attached to Bot admin console · My vault");
  const row = opener.closest("li") as HTMLElement;
  const actions = within(within(row).getByRole("group")).getAllByRole("button").map((button) => button.textContent);
  expect(actions).toEqual(["Open", "Save a copy"]);
  await expectNoAxe(document.body);

  // Open: the same call as the panel's, and the search steps aside.
  fireEvent.click(within(row).getByRole("button", { name: "Open" }));
  await waitFor(() => {
    expect(toast()).toContain(OPENED_NOTE);
  });
  expect(sent("open_file")).toEqual([
    { session: session(), generation: shell.sessionOf(7)?.generation, id: itemId(1), file_id: CONSOLE_PDF.file_id, confirmed_executable: false },
  ]);
  expect(screen.queryByRole("dialog", { name: SEARCH })).toBeNull();

  // A program file asks first, in the same words, over the search.
  fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
  const second = await screen.findByRole("dialog", { name: SEARCH });
  fireEvent.change(within(second).getByRole("textbox", { name: SEARCH }), { target: { value: "setup" } });
  // The file item matched by its own title and by its file's name: one result, with the file's actions.
  const opener2 = await within(second).findByRole("button", { name: /^File:\s*Setup tool/ });
  expect(within(second).getAllByRole("listitem")).toHaveLength(1);
  const row2 = opener2.closest("li") as HTMLElement;
  fireEvent.click(within(row2).getByRole("button", { name: "Open" }));
  const ask = await screen.findByRole("dialog", { name: "Open a program?" });
  expect(ask.textContent).toContain("setup-demo.exe can run and change things on your PC. Only open it if you trust where it came from.");
  expect(shell.fileOps).toHaveLength(1);
  const cancel = within(ask).getByRole("button", { name: "Cancel" });
  await waitFor(() => {
    expect(document.activeElement).toBe(cancel);
  });
  fireEvent.click(cancel);
  await waitFor(() => {
    expect(screen.queryByRole("dialog", { name: "Open a program?" })).toBeNull();
  });
  // The search is still there, and nothing was opened.
  expect(screen.getByRole("dialog", { name: SEARCH })).toBeTruthy();
  expect(shell.fileOps).toHaveLength(1);
  // Escape answers no to the question and leaves the search where it is.
  fireEvent.click(within(row2).getByRole("button", { name: "Open" }));
  fireEvent.keyDown(await screen.findByRole("dialog", { name: "Open a program?" }), { key: "Escape" });
  await waitFor(() => {
    expect(screen.queryByRole("dialog", { name: "Open a program?" })).toBeNull();
  });
  expect(screen.getByRole("dialog", { name: SEARCH })).toBeTruthy();
  expect(shell.fileOps).toHaveLength(1);
  fireEvent.click(within(row2).getByRole("button", { name: "Open" }));
  fireEvent.click(within(await screen.findByRole("dialog", { name: "Open a program?" })).getByRole("button", { name: "Open anyway" }));
  await waitFor(() => {
    expect(shell.fileOps).toHaveLength(2);
  });
  expect(sent("open_file").map((args) => args.confirmed_executable)).toEqual([false, false, false, false, true]);
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  // Save a copy from a result is the panel's call.
  fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
  const third = await screen.findByRole("dialog", { name: SEARCH });
  fireEvent.change(within(third).getByRole("textbox", { name: SEARCH }), { target: { value: "access" } });
  const row3 = (await within(third).findByRole("button", { name: /^File:\s*console-access-demo\.pdf/ })).closest("li") as HTMLElement;
  fireEvent.click(within(row3).getByRole("button", { name: "Save a copy" }));
  await waitFor(() => {
    expect(sent("save_file_copy")).toHaveLength(1);
  });
  expect(sent("save_file_copy")[0]).toEqual({
    session: session(),
    generation: shell.sessionOf(7)?.generation,
    id: itemId(1),
    file_id: CONSOLE_PDF.file_id,
  });
  await waitFor(() => {
    expect(toast()).toContain(SAVED_NOTE);
  });
});

test("search_lists_an_item_and_its_file_apart_and_opens_the_item_from_either", async () => {
  await unlocked();
  fireEvent.keyDown(document.body, { key: "f", ctrlKey: true });
  const dialog = await screen.findByRole("dialog", { name: SEARCH });
  // "console" is in the login's title and in its file's name: the login first, then the file.
  fireEvent.change(within(dialog).getByRole("textbox", { name: SEARCH }), { target: { value: "console" } });
  await within(dialog).findByRole("button", { name: /^File:\s*console-access-demo\.pdf/ });
  const names = within(dialog)
    .getAllByRole("button", { name: /^(Login|Key|Note|File):/ })
    .map((button) => button.textContent);
  expect(names).toHaveLength(2);
  expect(names[0]).toContain("Bot admin console");
  expect(names[1]).toContain("console-access-demo.pdf");
  // The file's result opens the item it is attached to.
  fireEvent.click(within(dialog).getByRole("button", { name: /^File:\s*console-access-demo\.pdf/ }));
  const panel = await screen.findByRole("complementary", { name: "Bot admin console" });
  expect(within(panel).getByText("console-access-demo.pdf")).toBeTruthy();
  expect(screen.queryByRole("dialog", { name: SEARCH })).toBeNull();
});

test("attach_one_file_on_each_kind", async () => {
  await unlocked();
  for (const [title, id, picked] of [
    ["Bot admin console", itemId(1), "scan-one.pdf"],
    ["OPENAI_API_KEY", TOKEN, "scan-two.pdf"],
    ["Rotation steps", itemId(3), "scan-three.pdf"],
  ] as const) {
    const panel = await select(title);
    // The section is there with the button even before there is a file in it.
    expect(within(panel).getByRole("heading", { name: "Attached files" })).toBeTruthy();
    shell.pickNext(picked, 3000);
    fireEvent.click(within(panel).getByRole("button", { name: "Attach a file" }));
    await waitFor(() => {
      expect(within(screen.getByRole("complementary", { name: title })).getByText(picked)).toBeTruthy();
    });
    expect(sent("attach_file").at(-1)).toEqual({ session: session(), generation: shell.sessionOf(7)?.generation, id });
    expect(shell.fileOps.at(-1)).toEqual({ cmd: "attach_file", id });
    expect(toast()).toContain(ATTACHED_NOTE);
    // The new file has its buttons, and the panel is still the item's.
    const after = screen.getByRole("complementary", { name: title });
    expect(within(after).getByRole("button", { name: `Open ${picked}` })).toBeTruthy();
    expect(within(after).getByRole("button", { name: `Save a copy of ${picked}` })).toBeTruthy();
    expect(within(after).getByRole("button", { name: `Replace file ${picked}` })).toBeTruthy();
  }
  expect(sent("attach_file")).toHaveLength(3);
  // The login that had a file already keeps it beside the new one.
  const login = await select("Bot admin console");
  expect(within(login).getByText("console-access-demo.pdf")).toBeTruthy();
  expect(within(login).getByText("scan-one.pdf")).toBeTruthy();
  // A file item is its file: there is nothing to attach to it.
  const file = await select("Client contract");
  expect(within(file).queryByRole("button", { name: "Attach a file" })).toBeNull();
});

test("adding_says_the_original_is_still_unprotected", async () => {
  await unlocked();
  shell.pickNext("tax-demo.pdf", 5120);
  await addFile();
  // The new item opens, with its file, and the sentence stays until it is read.
  const panel = await screen.findByRole("complementary", { name: "tax-demo.pdf" });
  expect(within(panel).getByText("5 KB")).toBeTruthy();
  expect(toast()).toContain(ADDED_NOTE);
  expect(sent("add_file")).toEqual([{ session: session(), generation: shell.sessionOf(7)?.generation, collection: null }]);
  expect(shell.fileOps).toEqual([{ cmd: "add_file", collection: null }]);
  expect(screen.getByRole("button", { name: /^File:\s*tax-demo\.pdf/ })).toBeTruthy();
  // A file item is its file: there is nothing to attach to it.
  expect(within(panel).queryByRole("button", { name: "Attach a file" })).toBeNull();

  // With a folder on screen, the file goes in that folder.
  fireEvent.click(screen.getByRole("button", { name: /^Agency support agent/ }));
  await screen.findByRole("heading", { level: 1, name: "Agency support agent" });
  shell.pickNext("in-folder-demo.pdf");
  await addFile();
  await screen.findByRole("complementary", { name: "in-folder-demo.pdf" });
  expect(sent("add_file").at(-1)?.collection).toBe(FOLDER);

  // A closed picker adds nothing and says nothing new.
  shell.dismissFileNext();
  fireEvent.click(within(document.querySelector<HTMLElement>(".tstack") as HTMLElement).getByRole("button", { name: "Got it" }));
  await addFile();
  await waitFor(() => {
    expect(sent("add_file")).toHaveLength(3);
  });
  await act(async () => {
    await Promise.resolve();
  });
  expect(toast()).toBe("");
  expect(shell.fileOps).toHaveLength(2);
});

test("no_multi_select_until_4b", async () => {
  await unlocked();
  // One file at a time: the words say so, and one press sends one command that picks one file.
  const add = screen.getByRole("button", { name: "Add" });
  add.focus();
  fireEvent.pointerDown(add, { button: 0 });
  fireEvent.click(add);
  const menu = await screen.findByRole("menu");
  expect(within(menu).getAllByRole("menuitem").map((entry) => entry.textContent)).toEqual(["Login", "Key", "Note", "File", "Paste a .env"]);
  fireEvent.click(within(menu).getByRole("menuitem", { name: "File" }));
  await screen.findByRole("complementary", { name: "picked-file.pdf" });
  expect(sent("add_file")).toHaveLength(1);
  expect(screen.queryByText(/pick more|add \d+ files|attach files|add files/i)).toBeNull();
  const panel = await select("Bot admin console");
  expect(within(panel).getByRole("button", { name: "Attach a file" })).toBeTruthy();
  expect(within(panel).queryByRole("button", { name: /attach files|pick more/i })).toBeNull();
  // The picked file is one: no list of picked files, no Add N files, no drop zone.
  expect(document.body.textContent).not.toMatch(/Pick more|Add \d+ files|Leave out/);
  expect(document.querySelector('input[type="file"], [aria-dropeffect], [data-dropzone]')).toBeNull();
});

test("busy_state_during_a_big_file", async () => {
  await unlocked();
  const panel = await select("Client contract");
  const release = shell.holdFiles();
  fireEvent.click(within(panel).getByRole("button", { name: "Open contract-demo.pdf" }));
  // The pressed button says it is working; the others are off, and still reachable by keyboard (aria-disabled).
  const working = await within(panel).findByRole("button", { name: "Opening contract-demo.pdf" });
  expect(working.textContent).toBe("Opening…");
  expect(working.getAttribute("aria-busy")).toBe("true");
  const save = within(panel).getByRole("button", { name: "Save a copy of contract-demo.pdf" });
  const replace = within(panel).getByRole("button", { name: "Replace file contract-demo.pdf" });
  expect(save.getAttribute("aria-disabled")).toBe("true");
  expect(replace.getAttribute("aria-disabled")).toBe("true");
  // A press on any of them while it works sends nothing.
  fireEvent.click(working);
  fireEvent.click(save);
  fireEvent.click(replace);
  await act(async () => {
    await Promise.resolve();
  });
  expect(sent("open_file")).toHaveLength(1);
  expect(sent("save_file_copy")).toEqual([]);
  expect(screen.queryByRole("dialog")).toBeNull();
  await expectNoAxe(document.body);

  act(() => {
    release();
  });
  await waitFor(() => {
    expect(toast()).toContain(OPENED_NOTE);
  });
  const done = within(panel).getByRole("button", { name: "Open contract-demo.pdf" });
  expect(done.textContent).toBe("Open");
  expect(done.getAttribute("aria-busy")).toBeNull();
  expect(within(panel).getByRole("button", { name: "Save a copy of contract-demo.pdf" }).getAttribute("aria-disabled")).toBeNull();

  // Save a copy and Replace say what they are doing in their own words.
  const again = shell.holdFiles();
  fireEvent.click(within(panel).getByRole("button", { name: "Save a copy of contract-demo.pdf" }));
  expect((await within(panel).findByRole("button", { name: "Saving a copy of contract-demo.pdf" })).textContent).toBe("Saving…");
  act(() => {
    again();
  });
  await waitFor(() => {
    expect(within(panel).getByRole("button", { name: "Save a copy of contract-demo.pdf" })).toBeTruthy();
  });
});

test("idle_pause_says_why_during_a_big_file", async () => {
  await unlocked();
  const panel = await select("Client contract");
  expect(screen.queryByText(PAUSE)).toBeNull();
  const release = shell.holdFiles();
  fireEvent.click(within(panel).getByRole("button", { name: "Open contract-demo.pdf" }));
  // The shell says the vault is working, and that is the page's cue: the words of 5d, here, with the file's own.
  const note = await screen.findByText(PAUSE);
  expect(note.closest("[role='status']")).not.toBeNull();
  expect(screen.getByText("Opening the file.")).toBeTruthy();
  act(() => {
    release();
  });
  await waitFor(() => {
    expect(screen.queryByText(PAUSE)).toBeNull();
  });

  // A save works the same, and says its own work.
  const again = shell.holdFiles();
  fireEvent.click(within(panel).getByRole("button", { name: "Save a copy of contract-demo.pdf" }));
  await screen.findByText(PAUSE);
  expect(screen.getByText("Saving a copy of the file.")).toBeTruthy();
  act(() => {
    again();
  });
  await waitFor(() => {
    expect(screen.queryByText(PAUSE)).toBeNull();
  });

  // Storing a file: the same.
  const third = shell.holdFiles();
  await addFile();
  await screen.findByText(PAUSE);
  expect(screen.getByText("Adding a file to your vault.")).toBeTruthy();
  // A lock takes the words away with the vault: Windows locking still locks, as the words say.
  act(() => {
    shell.lock(session());
  });
  await waitFor(() => {
    expect(screen.queryByText(PAUSE)).toBeNull();
  });
  act(() => {
    third();
  });
  expect(screen.queryByText(PAUSE)).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
});

test("read_only_vault_can_save_a_copy", async () => {
  await unlocked(mine({ readOnly: true }));
  // Nothing can be added or changed in it: no Add, no Attach, no Replace.
  expect(screen.queryByRole("button", { name: "Add" })).toBeNull();
  const panel = await select("Client contract");
  expect(within(panel).getByRole("button", { name: "Open contract-demo.pdf" })).toBeTruthy();
  expect(within(panel).queryByRole("button", { name: /^Replace file/ })).toBeNull();
  const login = await select("Bot admin console");
  expect(within(login).getByRole("button", { name: "Save a copy of console-access-demo.pdf" })).toBeTruthy();
  expect(within(login).queryByRole("button", { name: /Attach/ })).toBeNull();
  expect(within(login).queryByRole("button", { name: /^Replace file/ })).toBeNull();
  // Save a copy works: it writes nothing into the vault.
  fireEvent.click(within(login).getByRole("button", { name: "Save a copy of console-access-demo.pdf" }));
  await waitFor(() => {
    expect(toast()).toContain(SAVED_NOTE);
  });
  expect(shell.fileOps).toEqual([{ cmd: "save_file_copy", id: itemId(1), file_id: CONSOLE_PDF.file_id }]);
  // Open does too.
  fireEvent.click(within(login).getByRole("button", { name: "Open console-access-demo.pdf" }));
  await waitFor(() => {
    expect(toast()).toContain(OPENED_NOTE);
  });
  expect(sent("replace_file")).toEqual([]);
  expect(sent("attach_file")).toEqual([]);
  expect(sent("add_file")).toEqual([]);
});

// ---- A lock, and answers that come late ----

test("a_lock_during_open_shows_nothing_and_takes_the_vault", async () => {
  await unlocked();
  const panel = await select("Client contract");
  const release = shell.holdFiles();
  fireEvent.click(within(panel).getByRole("button", { name: "Open contract-demo.pdf" }));
  await screen.findByText(PAUSE);
  act(() => {
    shell.lock(session());
  });
  act(() => {
    release();
  });
  await screen.findByRole("heading", { name: /Unlock/ });
  await act(async () => {
    await Promise.resolve();
  });
  // The refusal (locked) is the news of a lock, not an error to show; nothing of the vault is on screen.
  nothingOfTheFileIsOnScreen();
  expect(toast()).toBe("");
  expect(debugState().sessions).toEqual([]);
  expect(debugState().toast).toBeNull();
});

test("a_lock_the_page_missed_during_save_takes_the_vault_with_nothing_said", async () => {
  await unlocked();
  const panel = await select("Client contract");
  const release = shell.holdFiles();
  fireEvent.click(within(panel).getByRole("button", { name: "Save a copy of contract-demo.pdf" }));
  await screen.findByText(PAUSE);
  shell.lockWithoutEvent(session());
  act(() => {
    release();
  });
  await waitFor(() => {
    expect(debugState().sessions).toEqual([]);
  });
  await screen.findByRole("heading", { name: /Unlock/ });
  nothingOfTheFileIsOnScreen();
  expect(toast()).toBe("");
});

test("a_question_is_taken_away_by_a_lock_with_the_file_name_in_it", async () => {
  await unlocked();
  const panel = await select("Setup tool");
  fireEvent.click(within(panel).getByRole("button", { name: "Open setup-demo.exe" }));
  await screen.findByRole("dialog", { name: "Open a program?" });
  act(() => {
    shell.lock(session());
  });
  await screen.findByRole("heading", { name: /Unlock/ });
  expect(document.body.textContent).not.toContain("setup-demo.exe");
  expect(screen.queryByRole("dialog", { name: "Open a program?" })).toBeNull();
  // The question held no yes: nothing was opened.
  expect(shell.fileOps).toEqual([]);
});

test("a_refusal_that_comes_after_moving_to_another_item_is_not_shown", async () => {
  await unlocked(mine({ damagedFiles: [CONTRACT.file_id] }));
  const panel = await select("Client contract");
  const release = shell.holdFiles();
  fireEvent.click(within(panel).getByRole("button", { name: "Open contract-demo.pdf" }));
  await screen.findByText(PAUSE);
  // The person goes to another item while the shell works.
  const note = await select("Rotation steps");
  act(() => {
    release();
  });
  await waitFor(() => {
    expect(screen.queryByText(PAUSE)).toBeNull();
  });
  await act(async () => {
    await Promise.resolve();
  });
  // The other item's panel is as it was, and nothing says the first file is damaged: the person has moved on.
  expect(screen.getByRole("complementary", { name: "Rotation steps" })).toBe(note);
  expect(screen.queryByRole("alert")).toBeNull();
  expect(document.body.textContent).not.toContain("damaged");
  // Back on the first item, its buttons are there and unmarked.
  const back = await select("Client contract");
  expect(within(back).getByRole("button", { name: "Open contract-demo.pdf" })).toBeTruthy();
  expect(within(back).queryByRole("alert")).toBeNull();
});

test("a_late_refusal_that_is_not_about_the_file_is_said_only_where_it_began", async () => {
  await unlocked();
  const panel = await select("Client contract");
  // Said where it began: the person is still on the item, so it is a message, in words, never the shell's text.
  shell.refuseNext("save_file_copy", { code: "core", kind: "io" });
  const release = shell.holdFiles();
  fireEvent.click(within(panel).getByRole("button", { name: "Save a copy of contract-demo.pdf" }));
  await screen.findByText(PAUSE);
  act(() => {
    release();
  });
  const refusal = await screen.findByRole("alert");
  expect(refusal.textContent).toContain("Lockbox couldn't reach that folder or file. Check that the drive is connected, then try again.");
  expect(refusal.textContent).not.toContain("io");
  fireEvent.click(within(refusal).getByRole("button", { name: "Dismiss message" }));

  // Moved on to another item first: nothing is said, and the other item's panel is as it was.
  shell.refuseNext("save_file_copy", { code: "core", kind: "io" });
  const again = shell.holdFiles();
  fireEvent.click(within(panel).getByRole("button", { name: "Save a copy of contract-demo.pdf" }));
  await screen.findByText(PAUSE);
  const other = await select("Rotation steps");
  act(() => {
    again();
  });
  await waitFor(() => {
    expect(screen.queryByText(PAUSE)).toBeNull();
  });
  await act(async () => {
    await Promise.resolve();
  });
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByRole("complementary", { name: "Rotation steps" })).toBe(other);
  expect(toast()).toBe("");
});

test("a_late_refusal_for_the_item_still_open_is_shown_in_its_panel", async () => {
  await unlocked(mine({ damagedFiles: [CONTRACT.file_id] }));
  const panel = await select("Client contract");
  const release = shell.holdFiles();
  fireEvent.click(within(panel).getByRole("button", { name: "Open contract-demo.pdf" }));
  await screen.findByText(PAUSE);
  act(() => {
    release();
  });
  // The panel it began in is still the one on screen: the refusal is its own, said in words in that panel and nowhere else.
  const shown = await within(panel).findByRole("alert");
  expect(shown.textContent).toBe(DAMAGED);
  expect(screen.getAllByRole("alert")).toHaveLength(1);
  expect(toast()).toBe("");
});

test("a_replace_that_comes_after_moving_on_does_not_change_the_panel", async () => {
  await unlocked();
  const panel = await select("Client contract");
  fireEvent.click(within(panel).getByRole("button", { name: "Replace file contract-demo.pdf" }));
  const release = shell.holdFiles();
  shell.pickNext("contract-v2.pdf", 4096);
  fireEvent.click(within(await screen.findByRole("dialog", { name: "Replace contract-demo.pdf?" })).getByRole("button", { name: "Choose the new file" }));
  await screen.findByText(PAUSE);
  const other = await select("Rotation steps");
  act(() => {
    release();
  });
  await waitFor(() => {
    expect(screen.queryByText(PAUSE)).toBeNull();
  });
  await waitFor(() => {
    expect(shell.fileOps).toHaveLength(1);
  });
  // The panel the person is on is not touched, and the first item has its new file when they come back.
  expect(screen.getByRole("complementary", { name: "Rotation steps" })).toBe(other);
  expect(within(other).queryByText("contract-v2.pdf")).toBeNull();
  const back = await select("Client contract");
  await waitFor(() => {
    expect(within(back).getByText("contract-v2.pdf")).toBeTruthy();
  });
  expect(within(back).queryByText("contract-demo.pdf")).toBeNull();
});

test("an_attach_that_finishes_after_choosing_another_item_leaves_that_items_details_coming", async () => {
  await unlocked();
  const panel = await select("Bot admin console");
  const releaseFiles = shell.holdFiles();
  fireEvent.click(within(panel).getByRole("button", { name: "Attach a file" }));
  await screen.findByText(PAUSE);
  // The person chooses the note while the attach works, and its details have no answer yet when the attach finishes.
  const releaseItems = shell.holdGetItem();
  const before = sent("get_item").length;
  fireEvent.click(await screen.findByRole("button", { name: /^Note:\s*Rotation steps/ }));
  await waitFor(() => {
    expect(sent("get_item")).toHaveLength(before + 1);
  });
  act(() => {
    releaseFiles();
  });
  await waitFor(() => {
    expect(shell.fileOps).toHaveLength(1);
  });
  await waitFor(() => {
    expect(screen.queryByText(PAUSE)).toBeNull();
  });
  act(() => {
    releaseItems();
  });
  // The note's details still arrive: the attach's refresh of the item left behind does not stand in front of them.
  const other = await screen.findByRole("complementary", { name: "Rotation steps" });
  await waitFor(() => {
    expect(within(other).getByText("Made-up note")).toBeTruthy();
  });
});

test("adding_a_file_does_not_take_the_panel_of_an_item_the_person_moved_to", async () => {
  await unlocked();
  const release = shell.holdFiles();
  await addFile();
  await screen.findByText(PAUSE);
  const other = await select("Rotation steps");
  act(() => {
    release();
  });
  await waitFor(() => {
    expect(screen.queryByText(PAUSE)).toBeNull();
  });
  await screen.findByRole("button", { name: /^File:\s*picked-file\.pdf/ });
  // The added file is in the list, said once, and the panel is still the note's.
  expect(screen.getByRole("complementary", { name: "Rotation steps" })).toBe(other);
  expect(toast()).toContain(ADDED_NOTE);
});

test("a_late_answer_for_a_search_that_was_closed_shows_nothing", async () => {
  await unlocked(mine({ damagedFiles: [CONSOLE_PDF.file_id] }));
  fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
  const dialog = await screen.findByRole("dialog", { name: SEARCH });
  fireEvent.change(within(dialog).getByRole("textbox", { name: SEARCH }), { target: { value: "access" } });
  const row = (await within(dialog).findByRole("button", { name: /^File:\s*console-access-demo\.pdf/ })).closest("li") as HTMLElement;
  const release = shell.holdFiles();
  fireEvent.click(within(row).getByRole("button", { name: "Open" }));
  await screen.findByText(PAUSE);
  // Search is closed with Escape before the answer comes.
  fireEvent.keyDown(dialog, { key: "Escape" });
  await waitFor(() => {
    expect(screen.queryByRole("dialog", { name: SEARCH })).toBeNull();
  });
  // And opened again, as a new search, before it comes: the answer belongs to the first one.
  fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
  const reopened = await screen.findByRole("dialog", { name: SEARCH });
  act(() => {
    release();
  });
  await waitFor(() => {
    expect(screen.queryByText(PAUSE)).toBeNull();
  });
  await act(async () => {
    await Promise.resolve();
  });
  expect(within(reopened).queryByRole("alert")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(document.body.textContent).not.toContain("damaged");
  fireEvent.keyDown(reopened, { key: "Escape" });
  await waitFor(() => {
    expect(screen.queryByRole("dialog", { name: SEARCH })).toBeNull();
  });

  // Still open, the same refusal is said in the search, in words.
  fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
  const again = await screen.findByRole("dialog", { name: SEARCH });
  fireEvent.change(within(again).getByRole("textbox", { name: SEARCH }), { target: { value: "access" } });
  const row2 = (await within(again).findByRole("button", { name: /^File:\s*console-access-demo\.pdf/ })).closest("li") as HTMLElement;
  fireEvent.click(within(row2).getByRole("button", { name: "Open" }));
  const refusal = await within(again).findByRole("alert");
  expect(refusal.textContent).toBe(DAMAGED);
});

test("a_second_press_while_a_file_works_sends_nothing", async () => {
  await unlocked();
  const panel = await select("Bot admin console");
  const release = shell.holdFiles();
  fireEvent.click(within(panel).getByRole("button", { name: "Save a copy of console-access-demo.pdf" }));
  await screen.findByText(PAUSE);
  // Adding a file from the Add menu while another file works does nothing either.
  await addFile();
  fireEvent.click(within(panel).getByRole("button", { name: "Attach a file" }));
  await act(async () => {
    await Promise.resolve();
  });
  expect(sent("add_file")).toEqual([]);
  expect(sent("attach_file")).toEqual([]);
  act(() => {
    release();
  });
  await waitFor(() => {
    expect(screen.queryByText(PAUSE)).toBeNull();
  });
  expect(sent("save_file_copy")).toHaveLength(1);
});

// ---- Save a copy to a cloud-synced folder (21e) ----

const CLOUD = "This folder is synced to the cloud";
const UPLOADED = "This file would be uploaded unprotected.";

test("save_copy_cloud_question_shows_21e", async () => {
  await unlocked();
  const panel = await select("Client contract");
  const save = within(panel).getByRole("button", { name: "Save a copy of contract-demo.pdf" });
  shell.cloudPdfNext();
  fireEvent.click(save);
  // The same question as the .env and the PDF: its words, the safe answer first and focused, and nothing written yet.
  const dialog = await screen.findByRole("dialog", { name: CLOUD });
  expect(dialog.textContent).toContain(UPLOADED);
  const another = within(dialog).getByRole("button", { name: "Pick another folder" });
  await waitFor(() => {
    expect(document.activeElement).toBe(another);
  });
  expect(shell.fileOps).toEqual([]);
  expect(sent("save_file_copy")).toHaveLength(1);
  await expectNoAxe(document.body);

  // Pick another folder asks Windows again.
  fireEvent.click(another);
  await waitFor(() => {
    expect(toast()).toContain(SAVED_NOTE);
  });
  expect(sent("save_file_copy")).toHaveLength(2);
  expect(sent("save_file_copy_confirm")).toEqual([]);
  expect(screen.queryByRole("dialog")).toBeNull();

  // Continue goes on with the copy the shell parked, by its token and nothing else.
  fireEvent.click(within(document.querySelector<HTMLElement>(".tstack") as HTMLElement).getByRole("button", { name: "Got it" }));
  shell.cloudPdfNext();
  fireEvent.click(save);
  const second = await screen.findByRole("dialog", { name: CLOUD });
  fireEvent.click(within(second).getByRole("button", { name: "Continue" }));
  await waitFor(() => {
    expect(toast()).toContain(SAVED_NOTE);
  });
  const confirmed = sent("save_file_copy_confirm");
  expect(confirmed).toHaveLength(1);
  expect(Object.keys(confirmed[0] ?? {})).toEqual(["token"]);
  expect(shell.fileOps.filter((op) => op.cmd === "save_file_copy")).toHaveLength(2);
  expect(screen.queryByRole("dialog")).toBeNull();

  // Escape writes nothing.
  shell.cloudPdfNext();
  fireEvent.click(save);
  fireEvent.keyDown(await screen.findByRole("dialog", { name: CLOUD }), { key: "Escape" });
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(sent("save_file_copy_confirm")).toHaveLength(1);
  expect(shell.fileOps.filter((op) => op.cmd === "save_file_copy")).toHaveLength(2);
});

test("save_copy_cloud_question_from_a_search_result", async () => {
  await unlocked();
  fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
  const dialog = await screen.findByRole("dialog", { name: SEARCH });
  fireEvent.change(within(dialog).getByRole("textbox", { name: SEARCH }), { target: { value: "access" } });
  const row = (await within(dialog).findByRole("button", { name: /^File:\s*console-access-demo\.pdf/ })).closest("li") as HTMLElement;
  shell.cloudPdfNext();
  fireEvent.click(within(row).getByRole("button", { name: "Save a copy" }));
  const ask = await screen.findByRole("dialog", { name: CLOUD });
  expect(ask.textContent).toContain(UPLOADED);
  // The search is behind the question, still open (hidden from the keyboard and the reader while the question holds focus).
  expect(screen.getByRole("dialog", { name: SEARCH, hidden: true })).toBeTruthy();
  expect(shell.fileOps).toEqual([]);
  fireEvent.click(within(ask).getByRole("button", { name: "Continue" }));
  await waitFor(() => {
    expect(toast()).toContain(SAVED_NOTE);
  });
  expect(shell.fileOps).toEqual([{ cmd: "save_file_copy", id: itemId(1), file_id: CONSOLE_PDF.file_id }]);
  expect(screen.queryByRole("dialog")).toBeNull();

  // Cancelled with Escape: the question goes, the search stays, nothing is written.
  fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
  const again = await screen.findByRole("dialog", { name: SEARCH });
  fireEvent.change(within(again).getByRole("textbox", { name: SEARCH }), { target: { value: "access" } });
  const row2 = (await within(again).findByRole("button", { name: /^File:\s*console-access-demo\.pdf/ })).closest("li") as HTMLElement;
  shell.cloudPdfNext();
  fireEvent.click(within(row2).getByRole("button", { name: "Save a copy" }));
  fireEvent.keyDown(await screen.findByRole("dialog", { name: CLOUD }), { key: "Escape" });
  await waitFor(() => {
    expect(screen.queryByRole("dialog", { name: CLOUD })).toBeNull();
  });
  expect(screen.getByRole("dialog", { name: SEARCH })).toBeTruthy();
  expect(shell.fileOps).toHaveLength(1);
});

test("a_lock_takes_the_cloud_question_away_and_a_yes_after_a_missed_lock_says_nothing", async () => {
  await unlocked();
  const panel = await select("Client contract");
  shell.cloudPdfNext();
  fireEvent.click(within(panel).getByRole("button", { name: "Save a copy of contract-demo.pdf" }));
  await screen.findByRole("dialog", { name: CLOUD });
  act(() => {
    shell.lock(session());
  });
  await screen.findByRole("heading", { name: /Unlock/ });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(shell.fileOps).toEqual([]);
  nothingOfTheFileIsOnScreen();

  // A lock the page missed: the yes finds nothing, the shell is asked about the session, and the vault goes with nothing said.
  const field = await screen.findByLabelText(/^Password for /);
  fireEvent.change(field, { target: { value: PASSWORD } });
  fireEvent.submit((field as HTMLInputElement).form as HTMLFormElement);
  await screen.findByRole("heading", { level: 1, name: /All items/ });
  const panel2 = await select("Client contract");
  shell.cloudPdfNext();
  fireEvent.click(within(panel2).getByRole("button", { name: "Save a copy of contract-demo.pdf" }));
  const ask = await screen.findByRole("dialog", { name: CLOUD });
  shell.lockWithoutEvent(session());
  fireEvent.click(within(ask).getByRole("button", { name: "Continue" }));
  await screen.findByRole("heading", { name: /Unlock/ });
  nothingOfTheFileIsOnScreen();
  expect(toast()).toBe("");
});

test("a_cloud_yes_that_comes_too_late_says_so_where_it_began", async () => {
  await unlocked();
  const panel = await select("Client contract");
  shell.cloudPdfNext();
  fireEvent.click(within(panel).getByRole("button", { name: "Save a copy of contract-demo.pdf" }));
  const ask = await screen.findByRole("dialog", { name: CLOUD });
  // Five minutes pass: the shell let go of the parked copy, and the vault is still open.
  shell.dropParkedChoices();
  fireEvent.click(within(ask).getByRole("button", { name: "Continue" }));
  const said = await screen.findByRole("alert");
  expect(said.textContent).toContain("That took too long, so nothing was saved. Press Save a copy again.");
  expect(shell.fileOps).toEqual([]);
  expect(debugState().sessions).toHaveLength(1);
});

test("a_cloud_yes_answered_after_moving_on_leaves_the_panel_alone", async () => {
  await unlocked();
  const panel = await select("Client contract");
  shell.cloudPdfNext();
  fireEvent.click(within(panel).getByRole("button", { name: "Save a copy of contract-demo.pdf" }));
  const ask = await screen.findByRole("dialog", { name: CLOUD });
  const release = shell.holdFiles();
  fireEvent.click(within(ask).getByRole("button", { name: "Continue" }));
  await screen.findByText(PAUSE);
  const other = await select("Rotation steps");
  act(() => {
    release();
  });
  await waitFor(() => {
    expect(screen.queryByText(PAUSE)).toBeNull();
  });
  // The copy was written (a fact about the vault), said once; the panel the person is on is not touched.
  expect(shell.fileOps).toHaveLength(1);
  expect(toast()).toContain(SAVED_NOTE);
  expect(screen.getByRole("complementary", { name: "Rotation steps" })).toBe(other);
});

// ---- The fix round: answers that arrive out of order ----

test("refresh_answers_in_reverse_order_never_put_back_older_details", async () => {
  await unlocked();
  const panel = await select("Bot admin console");
  const before = sent("get_item").length;
  const release = shell.holdGetItem();
  shell.pickNext("scan-one.pdf");
  fireEvent.click(within(panel).getByRole("button", { name: "Attach a file" }));
  await waitFor(() => {
    expect(sent("get_item")).toHaveLength(before + 1);
  });
  // A second file is attached while the first refresh has no answer yet.
  shell.pickNext("scan-two.pdf");
  fireEvent.click(within(screen.getByRole("complementary", { name: "Bot admin console" })).getByRole("button", { name: "Attach a file" }));
  await waitFor(() => {
    expect(sent("get_item")).toHaveLength(before + 2);
  });
  // The newer answer (both files) comes first, the older (one file) after it: the older never replaces the newer.
  act(() => {
    release();
  });
  await act(async () => {
    await Promise.resolve();
  });
  const after = screen.getByRole("complementary", { name: "Bot admin console" });
  await waitFor(() => {
    expect(within(after).getByText("scan-two.pdf")).toBeTruthy();
  });
  expect(within(after).getByText("scan-one.pdf")).toBeTruthy();
  expect(within(after).getByText("console-access-demo.pdf")).toBeTruthy();
  expect(within(after).getByRole("button", { name: "Open scan-two.pdf" })).toBeTruthy();
});

test("a_late_retry_answer_never_clears_a_newer_notice", async () => {
  shell = installFakeShell(invoke, listen, mine());
  shell.setLaunchNotices([{ kind: "open_cleanup", removed: 0, still_open: 2 }]);
  render(<App />);
  await screen.findByText("Couldn't remove 2 opened files.");
  const release = shell.holdRetry();
  shell.retryLeaves(0);
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => {
    expect(shell.retries()).toBe(1);
  });
  // Another vault locks meanwhile and reports a copy it could not remove: the newer news.
  act(() => {
    shell.tell({ kind: "open_cleanup", removed: 0, still_open: 1 });
  });
  await screen.findByText("Couldn't remove 1 opened file.");
  act(() => {
    release();
  });
  await act(async () => {
    await Promise.resolve();
  });
  // The older answer (none left) is not the news any more: the warning and its Retry stay.
  expect(screen.getByText("Couldn't remove 1 opened file.")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
});

test("a_file_action_that_began_in_an_earlier_query_neither_closes_nor_blames_the_next", async () => {
  await unlocked(mine({ damagedFiles: [CONSOLE_PDF.file_id] }));
  const look = async (query: string) => {
    fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
    const dialog = await screen.findByRole("dialog", { name: SEARCH });
    fireEvent.change(within(dialog).getByRole("textbox", { name: SEARCH }), { target: { value: query } });
    return dialog;
  };
  // Refused late, after the person typed another word: not shown beside the new results.
  const dialog = await look("access");
  const row = (await within(dialog).findByRole("button", { name: /^File:\s*console-access-demo\.pdf/ })).closest("li") as HTMLElement;
  const release = shell.holdFiles();
  fireEvent.click(within(row).getByRole("button", { name: "Open" }));
  await screen.findByText(PAUSE);
  fireEvent.change(within(dialog).getByRole("textbox", { name: SEARCH }), { target: { value: "rotation" } });
  await within(dialog).findByRole("button", { name: /^Note:\s*Rotation steps/ });
  act(() => {
    release();
  });
  await waitFor(() => {
    expect(screen.queryByText(PAUSE)).toBeNull();
  });
  await act(async () => {
    await Promise.resolve();
  });
  expect(within(dialog).queryByRole("alert")).toBeNull();
  expect(document.body.textContent).not.toContain("damaged");

  // Opened fine, after the person typed another word: the newer search is not closed.
  fireEvent.keyDown(dialog, { key: "Escape" });
  await waitFor(() => {
    expect(screen.queryByRole("dialog", { name: SEARCH })).toBeNull();
  });
  const second = await look("contract");
  const row2 = (await within(second).findByRole("button", { name: /^File:\s*Client contract/ })).closest("li") as HTMLElement;
  const again = shell.holdFiles();
  fireEvent.click(within(row2).getByRole("button", { name: "Open" }));
  await screen.findByText(PAUSE);
  fireEvent.change(within(second).getByRole("textbox", { name: SEARCH }), { target: { value: "rotation" } });
  await within(second).findByRole("button", { name: /^Note:\s*Rotation steps/ });
  act(() => {
    again();
  });
  await waitFor(() => {
    expect(shell.fileOps).toHaveLength(1);
  });
  // The copy opened (said once), and the search the person is using is still there with its box and results.
  expect(toast()).toContain(OPENED_NOTE);
  expect(screen.getByRole("dialog", { name: SEARCH })).toBeTruthy();
  expect(within(second).getByRole<HTMLInputElement>("textbox", { name: SEARCH }).value).toBe("rotation");
});

test("an_earlier_result_pressed_while_the_next_word_loads_never_closes_the_next_search", async () => {
  await unlocked();
  fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
  const dialog = await screen.findByRole("dialog", { name: SEARCH });
  const box = within(dialog).getByRole("textbox", { name: SEARCH });
  fireEvent.change(box, { target: { value: "contract" } });
  const row = (await within(dialog).findByRole("button", { name: /^File:\s*Client contract/ })).closest("li") as HTMLElement;
  // The person types another word; its results have not come yet, so the earlier ones are still on screen, and one of them is pressed.
  const releaseSearch = shell.holdSearch();
  fireEvent.change(box, { target: { value: "rotation" } });
  const releaseFiles = shell.holdFiles();
  fireEvent.click(within(row).getByRole("button", { name: "Open" }));
  await screen.findByText(PAUSE);
  // The new word's results arrive, then the open finishes: the open belongs to the earlier results, not the ones on screen now.
  await act(async () => {
    releaseSearch();
    await Promise.resolve();
  });
  await within(dialog).findByRole("button", { name: /^Note:\s*Rotation steps/ });
  act(() => {
    releaseFiles();
  });
  await waitFor(() => {
    expect(shell.fileOps).toHaveLength(1);
  });
  await waitFor(() => {
    expect(screen.queryByText(PAUSE)).toBeNull();
  });
  // The copy opened (said once), and the search the person is using is still there with its word and results.
  expect(toast()).toContain(OPENED_NOTE);
  expect(screen.getByRole("dialog", { name: SEARCH })).toBeTruthy();
  expect(within(dialog).getByRole<HTMLInputElement>("textbox", { name: SEARCH }).value).toBe("rotation");
  expect(within(dialog).getByRole("button", { name: /^Note:\s*Rotation steps/ })).toBeTruthy();
});

test("a_result_pressed_while_its_results_are_still_on_screen_steps_aside_when_it_worked", async () => {
  await unlocked();
  fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
  const dialog = await screen.findByRole("dialog", { name: SEARCH });
  const box = within(dialog).getByRole("textbox", { name: SEARCH });
  fireEvent.change(box, { target: { value: "contract" } });
  const row = (await within(dialog).findByRole("button", { name: /^File:\s*Client contract/ })).closest("li") as HTMLElement;
  // Another word is typed, but the open finishes while the results pressed are still the ones on screen: it worked where it was pressed.
  const releaseSearch = shell.holdSearch();
  fireEvent.change(box, { target: { value: "rotation" } });
  fireEvent.click(within(row).getByRole("button", { name: "Open" }));
  await waitFor(() => {
    expect(shell.fileOps).toHaveLength(1);
  });
  await waitFor(() => {
    expect(screen.queryByRole("dialog", { name: SEARCH })).toBeNull();
  });
  expect(toast()).toContain(OPENED_NOTE);
  act(() => {
    releaseSearch();
  });
});

test("a_file_item_with_several_files_acts_on_the_file_that_matched", async () => {
  const papers: FakeItem = {
    id: itemId(8),
    kind: "file",
    title: "Alpha papers",
    collection: null,
    attachments: [
      { file_id: itemId(0xc1), name: "alpha-first.pdf", length: 1024, media_type: "application/pdf" },
      { file_id: itemId(0xc2), name: "alpha-second.pdf", length: 2048, media_type: "application/pdf" },
    ],
    modified_at: "2026-09-01T09:00:00Z",
  };
  await unlocked([{ id: 7, name: "My vault", items: [...items(), papers] }]);
  fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
  const dialog = await screen.findByRole("dialog", { name: SEARCH });
  fireEvent.change(within(dialog).getByRole("textbox", { name: SEARCH }), { target: { value: "alpha" } });
  await within(dialog).findByRole("button", { name: /^File:\s*Alpha papers/ });
  const names = within(dialog)
    .getAllByRole("button", { name: /^File:/ })
    .map((button) => button.textContent);
  // The item's own row (acting on its first file), and the second file's own result; the first file's is not said twice.
  expect(names).toHaveLength(2);
  expect(names[1]).toContain("alpha-second.pdf");
  expect(names.some((text) => text.includes("alpha-first.pdf"))).toBe(false);
  const second = within(dialog).getByRole("button", { name: /^File:\s*alpha-second\.pdf/ }).closest("li") as HTMLElement;
  fireEvent.click(within(second).getByRole("button", { name: "Save a copy" }));
  await waitFor(() => {
    expect(shell.fileOps).toHaveLength(1);
  });
  expect(shell.fileOps[0]).toEqual({ cmd: "save_file_copy", id: itemId(8), file_id: itemId(0xc2) });
});

test("file_buttons_carry_no_name_in_a_title_or_url", async () => {
  await unlocked();
  await select("Client contract");
  for (const element of document.querySelectorAll("[title]")) {
    expect(element.getAttribute("title") ?? "").not.toContain("contract-demo");
  }
  expect(document.querySelector("[href], [src]")).toBeNull();
});
