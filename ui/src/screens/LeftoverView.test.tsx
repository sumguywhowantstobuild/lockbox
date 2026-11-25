// Ask 5, as drawn: the banner's "See them", the "Leftover files" view (a note, a row for each file with only its date and size, Restore a
// backup and Delete them all), and the question Delete them all asks first (32b's pattern: Cancel has focus, the yes is filled red). The files
// are the shell's `list_orphans`; the page never holds a name or a path of one, and a delete names no file (Rust reads the quarantine at the call).
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import App from "../App";
import { messageFor } from "../messages";
import { deleteLeftover, openLeftover, resetStoreForTests, showSession, unlock } from "../store";
import { expectNoAxe } from "../testing/axe";
import { installFakeShell, PASSWORD, sampleItems, type FakeShell, type FakeVault } from "../testing/fakeShell";

const { invoke, listen } = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));

afterEach(cleanup);

let shell: FakeShell;

beforeEach(() => {
  resetStoreForTests();
  invoke.mockReset();
  listen.mockReset();
});

const NOTE = "These files have no item that uses them. Their names were kept in the item, so only a date and size can show.";
// The same sentence for one file and for many: it promises only what the code can keep (a delete changes no backup), not that a backup holds the files.
const WHOLE = "This can't be undone. Deleting these files won't change your existing backups.";
const CHANGED = "The leftover files changed. Look at the list again, then delete.";
const UNREADABLE = "Some items in this vault can't be read, so Petalock is keeping these files until that's sorted.";
const BANNER = "2 leftover files have no item that uses them.";
const noon = (iso: string) => Date.parse(`${iso}T12:00:00Z`) / 1000;

/** Two files, listed with the later one first (the shell lists by id): the view puts the older one first, as drawn. */
const FILES = [
  { file_id: "b".repeat(32), length: 90_112, stored: noon("2026-04-03") },
  { file_id: "a".repeat(32), length: 4_404_019, stored: noon("2026-03-12") },
];

function vault(extra: Partial<FakeVault> = {}): FakeVault {
  return { id: 7, name: "My vault", items: sampleItems(), orphans: FILES.map((file) => ({ ...file })), ...extra };
}

function start(vaults: FakeVault[]) {
  shell = installFakeShell(invoke, listen, vaults);
  return render(<App />);
}

async function unlockIt(): Promise<void> {
  const field = await screen.findByLabelText(/^Password for /);
  fireEvent.change(field, { target: { value: PASSWORD } });
  fireEvent.submit((field as HTMLInputElement).form as HTMLFormElement);
  await screen.findByRole("heading", { level: 1, name: "All items" });
}

function sent(cmd: string): unknown[] {
  return invoke.mock.calls.filter(([name]) => name === cmd).map(([, args]): unknown => args);
}

/** The banner Ask 5 raises, found by its words. */
async function banner(words = BANNER): Promise<HTMLElement> {
  return (await screen.findByText(words)).closest(".ask") as HTMLElement;
}

async function openView(words = BANNER): Promise<void> {
  fireEvent.click(within(await banner(words)).getByRole("button", { name: "See them" }));
  await screen.findByRole("heading", { level: 1, name: "Leftover files" });
}

const ONE = "1 leftover file has no item that uses it.";

function rows(): HTMLElement[] {
  return screen.queryAllByRole("listitem").filter((row) => row.classList.contains("frow"));
}

async function ask(): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole("button", { name: "Delete them all" }));
  return screen.findByRole("dialog", { name: "Delete 2 leftover files permanently?" });
}

test("leftover_banner_shows_while_files_wait_and_opens_the_view", async () => {
  // The unlock's cleanup moved nothing this time (`leftover` is not set): the files are from an earlier unlock, and still wait, so still said.
  start([vault()]);
  await unlockIt();
  const notice = await banner();
  expect(within(notice).getAllByRole("button").map((button) => button.textContent)).toEqual(["See them", "Close"]);
  const live = shell.sessionOf(7);
  expect(sent("list_orphans")).toEqual([{ session: live?.session, generation: live?.generation }]);
  // Nothing is deleted, or even asked about, by the banner being there.
  expect(sent("delete_orphans")).toEqual([]);
  expect(screen.queryByRole("dialog")).toBeNull();

  // See them opens the view, and the banner steps aside (the view says it all). The list is read again for the view.
  fireEvent.click(within(notice).getByRole("button", { name: "See them" }));
  expect(await screen.findByRole("heading", { level: 1, name: "Leftover files" })).toBeTruthy();
  expect(screen.queryByText(BANNER)).toBeNull();
  await waitFor(() => {
    expect(sent("list_orphans")).toHaveLength(2);
  });
  // The heading has focus, so a screen reader says where the person is.
  await waitFor(() => {
    expect(document.activeElement?.tagName).toBe("H1");
  });
  // The side menu marks no place, as drawn: neither All items nor Trash.
  expect(screen.queryByRole("button", { current: "page" })).toBeNull();

  // Back to All items: the view goes, and the banner is there again for the files still waiting.
  fireEvent.click(within(screen.getByRole("navigation", { name: "Vault and folders" })).getByRole("button", { name: /^All items/ }));
  expect(await screen.findByRole("heading", { level: 1, name: "All items" })).toBeTruthy();
  expect(await screen.findByText(BANNER)).toBeTruthy();
});

test("the_banner_closes_without_a_delete_and_comes_back_at_the_next_unlock", async () => {
  start([vault()]);
  await unlockIt();
  fireEvent.click(within(await banner()).getByRole("button", { name: "Close" }));
  expect(screen.queryByText(BANNER)).toBeNull();
  expect(sent("delete_orphans")).toEqual([]);
  const live = shell.sessionOf(7);
  await act(async () => {
    shell.lock(live?.session ?? 0);
    await Promise.resolve();
  });
  await unlockIt();
  expect(await screen.findByText(BANNER)).toBeTruthy();
});

test("no_files_waiting_means_no_banner", async () => {
  start([vault({ orphans: [] })]);
  await unlockIt();
  await waitFor(() => {
    expect(sent("list_orphans")).toHaveLength(1);
  });
  expect(screen.queryByText(/leftover file/)).toBeNull();
});

test("leftover_view_lists_date_and_size_as_drawn", async () => {
  const { container } = start([vault()]);
  await unlockIt();
  await openView();
  expect(screen.getByText(NOTE)).toBeTruthy();
  // One row for each file, the older first, each its date and its size and nothing else: the name lived in the item.
  expect(rows().map((row) => row.textContent)).toEqual(["?File from 12 March 20264.2 MB", "?File from 3 April 202688 KB"]);
  const first = rows()[0] as HTMLElement;
  expect(within(first).getByText("File from 12 March 2026").tagName).toBe("B");
  expect(within(first).getByText("4.2 MB").tagName).toBe("SMALL");
  // As drawn: Restore a backup, filled, then Delete them all.
  const buttons = within(screen.getByRole("button", { name: "Delete them all" }).parentElement as HTMLElement).getAllByRole("button");
  expect(buttons.map((button) => button.textContent)).toEqual(["Restore a backup", "Delete them all"]);
  expect(buttons[0]?.classList.contains("cp")).toBe(true);
  expect(buttons[1]?.classList.contains("cp")).toBe(false);
  // What belongs to a list of items is not here: no filter, no Add. And no file's id or path is on the page.
  expect(screen.queryByLabelText("Filter this list")).toBeNull();
  expect(screen.queryByRole("button", { name: /^Add/ })).toBeNull();
  for (const file of FILES) expect(container.innerHTML).not.toContain(file.file_id);
  expect(container.textContent).not.toMatch(/orphaned|\.blob|[A-Za-z]:\\/);
  await expectNoAxe(container);
});

test("a_file_with_no_known_date_says_so_and_does_not_guess", async () => {
  start([vault({ orphans: [{ file_id: "c".repeat(32), length: 512, stored: 0 }] })]);
  await unlockIt();
  await openView(ONE);
  expect(rows().map((row) => row.textContent)).toEqual(["?File512 B"]);
});

test("delete_them_all_asks_first_and_cancel_deletes_nothing", async () => {
  const { container } = start([vault()]);
  await unlockIt();
  await openView();
  const delet = screen.getByRole("button", { name: "Delete them all" });
  // Nothing goes by the button being there.
  expect(sent("delete_orphans")).toEqual([]);
  delet.focus();
  const dialog = await ask();
  expect(within(dialog).getByText(WHOLE)).toBeTruthy();
  const cancel = within(dialog).getByRole("button", { name: "Cancel" });
  await waitFor(() => {
    expect(document.activeElement).toBe(cancel);
  });
  expect(within(dialog).getAllByRole("button").map((button) => button.textContent)).toEqual(["Cancel", "Delete permanently"]);
  // The yes is the filled red one; the safe answer is not.
  expect(within(dialog).getByRole("button", { name: "Delete permanently" }).classList.contains("dfill")).toBe(true);
  expect(cancel.classList.contains("dfill")).toBe(false);
  await expectNoAxe(container);
  await expectNoAxe(document.body);

  // Cancel, and Escape, delete nothing, and focus goes back to the button.
  fireEvent.click(cancel);
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  await waitFor(() => {
    expect(document.activeElement).toBe(delet);
  });
  fireEvent.keyDown(await ask(), { key: "Escape" });
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(sent("delete_orphans")).toEqual([]);
  expect(rows()).toHaveLength(2);
  expect(shell.sessionOf(7)).toBeDefined();
});

test("a_question_for_one_file_says_one_file", async () => {
  start([vault({ orphans: [FILES[1] as (typeof FILES)[number]] })]);
  await unlockIt();
  await openView(ONE);
  fireEvent.click(screen.getByRole("button", { name: "Delete them all" }));
  const dialog = await screen.findByRole("dialog", { name: "Delete 1 leftover file permanently?" });
  expect(within(dialog).getByText(WHOLE)).toBeTruthy();
  expect(dialog.textContent).not.toMatch(/still hold/);
});

test("delete_them_all_deletes_and_the_view_closes_empty", async () => {
  start([vault()]);
  await unlockIt();
  await openView();
  fireEvent.click(within(await ask()).getByRole("button", { name: "Delete permanently" }));
  // The view is gone, with the list of items back in its place, and nothing is listed or said of leftover files any more.
  expect(await screen.findByRole("heading", { level: 1, name: "All items" })).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "Leftover files" })).toBeNull();
  expect(screen.queryByText(BANNER)).toBeNull();
  expect(screen.queryByText(NOTE)).toBeNull();
  const live = shell.sessionOf(7);
  // The yes sends the ids of the files the list showed, in the order shown (the older first), and nothing else: no name, no path, no count.
  expect(sent("delete_orphans")).toEqual([{ session: live?.session, generation: live?.generation, files: ["a".repeat(32), "b".repeat(32)] }]);
  expect(await screen.findByText("2 leftover files deleted for good")).toBeTruthy();
  // Focus is not left in nowhere.
  await waitFor(() => {
    expect(document.activeElement).not.toBe(document.body);
  });
  // They were deleted in the vault, not hidden: the next unlock finds none.
  await act(async () => {
    shell.lock(live?.session ?? 0);
    await Promise.resolve();
  });
  await unlockIt();
  await waitFor(() => {
    expect(sent("list_orphans").length).toBeGreaterThan(2);
  });
  expect(screen.queryByText(/leftover file/)).toBeNull();
});

test("a_refused_delete_says_so_and_the_files_stay_listed", async () => {
  start([vault()]);
  await unlockIt();
  await openView();
  shell.refuseNext("delete_orphans", { code: "core", kind: "io" });
  fireEvent.click(within(await ask()).getByRole("button", { name: "Delete permanently" }));
  await waitFor(() => {
    expect(document.body.textContent).toContain(messageFor({ code: "core", kind: "io" }).title);
  });
  expect(screen.getByRole("heading", { level: 1, name: "Leftover files" })).toBeTruthy();
  expect(rows()).toHaveLength(2);
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("a_lock_drops_the_view_and_its_question_without_a_call", async () => {
  start([vault()]);
  await unlockIt();
  await openView();
  await ask();
  // The fake keeps one record for a session and moves its generation on at the next unlock, so the numbers are read now.
  const asked = { session: shell.sessionOf(7)?.session ?? 0, generation: shell.sessionOf(7)?.generation ?? 0 };
  await act(async () => {
    shell.lock(asked.session);
    await Promise.resolve();
  });
  await screen.findByLabelText(/^Password for /);
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(screen.queryByRole("heading", { name: "Leftover files" })).toBeNull();
  expect(sent("delete_orphans")).toEqual([]);
  // What is left of the question, called late, still sends nothing: the generation it was opened for has gone.
  await deleteLeftover(asked.session, asked.generation, FILES.map((file) => file.file_id));
  expect(sent("delete_orphans")).toEqual([]);
  // The next unlock starts clean: the banner, not the view.
  await unlockIt();
  expect(await screen.findByText(BANNER)).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "Leftover files" })).toBeNull();
  // And the vault is open again under the same session number, a newer generation: the old question's yes still sends nothing, and nothing is deleted.
  const again = shell.sessionOf(7);
  expect(again?.session).toBe(asked.session);
  expect(again?.generation).not.toBe(asked.generation);
  await deleteLeftover(asked.session, asked.generation, FILES.map((file) => file.file_id));
  expect(sent("delete_orphans")).toEqual([]);
  expect(screen.getByText(BANNER)).toBeTruthy();
});

test("a_question_opened_in_one_vault_is_not_answered_in_another", async () => {
  const mine = vault();
  const work: FakeVault = { id: 8, name: "Work", items: sampleItems(), orphans: [{ file_id: "d".repeat(32), length: 1000, stored: noon("2026-05-01") }] };
  shell = installFakeShell(invoke, listen, [mine, work]);
  render(<App />);
  await unlockIt();
  await act(async () => {
    expect(await unlock({ list: shell.listIdentity(), id: 8 }, PASSWORD)).toBe("opened");
  });
  const session = (id: number) => shell.sessionOf(id)?.session ?? 0;
  // The question is opened in Work's view (the front one), and the person goes to the other vault before answering.
  await openView(ONE);
  fireEvent.click(screen.getByRole("button", { name: "Delete them all" }));
  await screen.findByRole("dialog", { name: "Delete 1 leftover file permanently?" });
  act(() => {
    showSession(session(7));
  });
  await screen.findByRole("heading", { level: 1, name: "All items", hidden: true });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(sent("delete_orphans")).toEqual([]);
  expect((work.orphans ?? []).length).toBe(1);
  expect((mine.orphans ?? []).length).toBe(2);
});

test("a_read_only_vault_offers_no_delete", async () => {
  // A copy opened from a backup: it has no quarantine to list, so no list is asked and nothing is offered to delete. If its unlock counted
  // any, the banner says the count and closes, and that is all.
  start([{ id: 7, name: "My vault", items: sampleItems(), readOnly: true, leftover: 2 }]);
  await unlockIt();
  const notice = await banner();
  expect(within(notice).getAllByRole("button").map((button) => button.textContent)).toEqual(["Close"]);
  expect(sent("list_orphans")).toEqual([]);
  // The store refuses to open the view for it, whatever the page asks.
  const live = shell.sessionOf(7);
  act(() => {
    openLeftover(live?.session ?? 0);
  });
  expect(screen.queryByRole("heading", { name: "Leftover files" })).toBeNull();
  await deleteLeftover(live?.session ?? 0, live?.generation ?? 0, []);
  expect(sent("delete_orphans")).toEqual([]);
  expect(sent("list_orphans")).toEqual([]);
});

test("restore_a_backup_starts_the_restore_for_this_vault", async () => {
  start([vault()]);
  await unlockIt();
  await openView();
  fireEvent.click(screen.getByRole("button", { name: "Restore a backup" }));
  await screen.findByRole("heading", { level: 1, name: "Restore a backup" });
  // The open vault goes with the pick, so the restore lands beside this one, as Ask 4's does.
  expect(sent("restore_pick")).toEqual([{ choice: null, vault: 7 }]);
  expect(sent("delete_orphans")).toEqual([]);
  // Cancel goes back to the vault, to the view it came from.
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(await screen.findByRole("heading", { level: 1, name: "Leftover files" })).toBeTruthy();
});

// ---- The fix round: what is deleted is what was shown, nothing while an item can't be read, and a list that fails says so ----

const IO = { code: "core", kind: "io" };

function deleteButton(): HTMLButtonElement {
  return screen.getByRole<HTMLButtonElement>("button", { name: "Delete them all" });
}

/** The fake vault's own quarantine, so a test can change it the way another program (or the next unlock) would. */
function waiting(mine: FakeVault): string[] {
  return (mine.orphans ?? []).map((file) => file.file_id).sort();
}

test("a_file_that_came_after_the_list_was_shown_is_not_deleted", async () => {
  const mine = vault();
  start([mine]);
  await unlockIt();
  await openView();
  const dialog = await ask();
  // The question was asked over two files; a third came before the yes.
  const third = { file_id: "c".repeat(32), length: 10, stored: noon("2026-05-02") };
  mine.orphans = [...(mine.orphans ?? []), third];
  fireEvent.click(within(dialog).getByRole("button", { name: "Delete permanently" }));
  // The yes carried the two ids shown, the vault refused, and nothing was deleted.
  await waitFor(() => {
    expect(document.body.textContent).toContain(CHANGED);
  });
  const live = shell.sessionOf(7);
  expect(sent("delete_orphans")).toEqual([{ session: live?.session, generation: live?.generation, files: ["a".repeat(32), "b".repeat(32)] }]);
  expect(waiting(mine)).toEqual(["a".repeat(32), "b".repeat(32), "c".repeat(32)]);
  // The list is read again, so the person sees the three before answering again, and a yes then deletes all three.
  await waitFor(() => {
    expect(rows()).toHaveLength(3);
  });
  fireEvent.click(screen.getByRole("button", { name: "Delete them all" }));
  fireEvent.click(within(await screen.findByRole("dialog", { name: "Delete 3 leftover files permanently?" })).getByRole("button", { name: "Delete permanently" }));
  await waitFor(() => {
    expect(waiting(mine)).toEqual([]);
  });
});

test("a_file_swapped_for_another_in_the_same_number_is_not_deleted", async () => {
  const mine = vault();
  start([mine]);
  await unlockIt();
  await openView();
  const dialog = await ask();
  const other = { file_id: "d".repeat(32), length: 20, stored: noon("2026-05-03") };
  mine.orphans = [(mine.orphans ?? [])[1] as (typeof FILES)[number], other];
  fireEvent.click(within(dialog).getByRole("button", { name: "Delete permanently" }));
  await waitFor(() => {
    expect(document.body.textContent).toContain(CHANGED);
  });
  expect(sent("delete_orphans")).toHaveLength(1);
  expect(waiting(mine)).toEqual(["a".repeat(32), "d".repeat(32)]);
  // The list shows the file that is there now, not the one the question was about.
  await waitFor(() => {
    expect(rows().map((row) => row.textContent)).toEqual(["?File from 12 March 20264.2 MB", "?File from 3 May 202620 B"]);
  });
});

test("nothing_is_offered_to_delete_while_items_cannot_be_read", async () => {
  // Ask 4 is up: a quarantined file may belong to an item that can't be read now, so the view lists the files and says why it keeps them.
  start([vault({ unreadable: 2 })]);
  await unlockIt();
  await openView();
  expect(rows()).toHaveLength(2);
  expect(screen.getByText(UNREADABLE)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Delete them all" })).toBeNull();
  // The view's own buttons (Ask 4's banner has a Restore a backup of its own): the way back is there, Delete is not.
  expect(Array.from(document.querySelectorAll(".le-a button")).map((button) => button.textContent)).toEqual(["Restore a backup"]);
  expect(sent("delete_orphans")).toEqual([]);
});

test("a_copy_an_item_uses_is_not_counted_listed_or_deleted", async () => {
  // Three files wait in the quarantine; an item still uses one of them (the next unlock puts it back). The banner, the rows and the question
  // are about the two nobody uses, and after the delete the third is still there and no leftover is said.
  const used = { file_id: "c".repeat(32), length: 999, stored: noon("2026-05-01"), used: true };
  const mine = vault({ orphans: [...FILES, used] });
  start([mine]);
  await unlockIt();
  await openView();
  expect(rows()).toHaveLength(2);
  fireEvent.click(within(await ask()).getByRole("button", { name: "Delete permanently" }));
  expect(await screen.findByText("2 leftover files deleted for good")).toBeTruthy();
  expect(await screen.findByRole("heading", { level: 1, name: "All items" })).toBeTruthy();
  expect(screen.queryByText(/leftover file has|leftover files have/)).toBeNull();
  expect(screen.queryByText(/No leftover files were left/)).toBeNull();
  expect(waiting(mine)).toEqual(["c".repeat(32)]);
});

test("a_list_that_fails_at_unlock_says_so_and_can_be_tried_again", async () => {
  // The unlock moved nothing, so nothing counts the files: a failed list must not hide them in silence.
  start([vault()]);
  shell.refuseNext("list_orphans", IO);
  await unlockIt();
  const words = await screen.findByText(/^Petalock couldn't list the leftover files\./);
  expect(words.textContent).toContain(messageFor(IO).title);
  const notice = words.closest(".ask") as HTMLElement;
  expect(within(notice).getAllByRole("button").map((button) => button.textContent)).toEqual(["Try again", "Close"]);
  fireEvent.click(within(notice).getByRole("button", { name: "Try again" }));
  expect(await screen.findByText(BANNER)).toBeTruthy();
  expect(sent("list_orphans")).toHaveLength(2);
  expect(screen.queryByText(/couldn't list the leftover files/)).toBeNull();
});

test("a_list_that_fails_on_opening_the_view_says_so_and_offers_no_delete_until_it_works", async () => {
  start([vault()]);
  await unlockIt();
  const notice = await banner();
  shell.refuseNext("list_orphans", IO);
  fireEvent.click(within(notice).getByRole("button", { name: "See them" }));
  await screen.findByRole("heading", { level: 1, name: "Leftover files" });
  // While it is read again the rows are the earlier ones but Delete waits (it is not a current list); then the refusal is said, not "Opening…".
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain(messageFor(IO).title);
  expect(screen.queryByText("Opening…")).toBeNull();
  expect(rows()).toHaveLength(0);
  expect(deleteButton().disabled).toBe(true);
  fireEvent.click(deleteButton());
  expect(screen.queryByRole("dialog")).toBeNull();
  // Try again reads it; with the list in hand the rows are back and Delete works.
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await waitFor(() => {
    expect(rows()).toHaveLength(2);
  });
  expect(screen.queryByRole("alert")).toBeNull();
  expect(deleteButton().disabled).toBe(false);
});

test("delete_waits_for_the_list_being_read_again", async () => {
  start([vault()]);
  await unlockIt();
  const notice = await banner();
  fireEvent.click(within(notice).getByRole("button", { name: "See them" }));
  // Straight after the press the list is being read again: the earlier rows may show, but Delete is not offered on them.
  expect(deleteButton().disabled).toBe(true);
  await waitFor(() => {
    expect(deleteButton().disabled).toBe(false);
  });
});

test("a_list_that_fails_with_no_earlier_list_is_not_opening_for_ever", async () => {
  // The unlock counted two files (so See them is offered) and then the list failed: the view has no list at all and says the refusal.
  start([{ id: 7, name: "My vault", items: sampleItems(), leftover: 2 }]);
  // The unlock's read and the view's own read are both refused.
  shell.refuseNext("list_orphans", IO, 2);
  await unlockIt();
  const words = await screen.findByText(/^Petalock couldn't list the leftover files\./);
  fireEvent.click(within(words.closest(".ask") as HTMLElement).getByRole("button", { name: "See them" }));
  await screen.findByRole("heading", { level: 1, name: "Leftover files" });
  expect(screen.queryByText("Opening…")).toBeNull();
  expect((await screen.findAllByRole("alert")).some((one) => one.textContent.includes(messageFor(IO).title))).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await waitFor(() => {
    expect(rows()).toHaveLength(2);
  });
});

test("a_list_that_fails_after_a_delete_says_the_refusal_and_not_that_it_worked", async () => {
  const mine = vault();
  start([mine]);
  await unlockIt();
  await openView();
  const dialog = await ask();
  // The delete goes through; the list read after it is refused.
  shell.refuseNext("list_orphans", IO);
  fireEvent.click(within(dialog).getByRole("button", { name: "Delete permanently" }));
  await waitFor(() => {
    expect(waiting(mine)).toEqual([]);
  });
  await waitFor(() => {
    expect(document.body.textContent).toContain(messageFor(IO).title);
  });
  expect(document.body.textContent).not.toMatch(/deleted for good/);
  // The view stays, with the refusal and Try again, and no rows to delete again.
  expect(screen.getByRole("heading", { level: 1, name: "Leftover files" })).toBeTruthy();
  expect(rows()).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  // Nothing is left: the view closes.
  expect(await screen.findByRole("heading", { level: 1, name: "All items" })).toBeTruthy();
});
