// Plan 4B Task 8's screens: the older copies a restore keeps (24f), opened read-only or deleted for good (24g), from Settings. Every case runs through the
// real App against the pretend shell. The page holds one listing (the shell replaces every ID at each listing), so each button sends an ID from the newest
// one; the typed password or recovery key is the box's own state, wiped as it is sent; an older copy's session never carries the live vault's place on the list.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import App from "../App";
import { abandonOlderOpens, debugState, loadOlderCopies, openOlderCopy, resetStoreForTests } from "../store";
import { expectNoAxe } from "../testing/axe";
import { installFakeShell, PASSWORD, sampleItems, type FakeOlderCopy, type FakeShell, type FakeVault } from "../testing/fakeShell";

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
const FIRST = "My vault.before-restore";
const SECOND = "My vault.before-restore-2";
const THIRD = "My vault.before-restore-3";
const LABEL = "Password or recovery key for this copy";
const HINT = "It's the one My vault used before the restore.";
const CHANGED = "That older copy has changed. Here is the list as it is now.";
const OPEN_COPY = "Close this older copy first, then delete it.";
const DELETE_WORDS =
  "This older copy is deleted from this PC, for good, with everything in it. This can't be undone. Your current My vault and the backups you saved yourself aren't touched.";

function copies(): FakeOlderCopy[] {
  return [
    { vault: 7, folder: FIRST, last_written: "2026-11-04", size: Math.round(1.3 * GB) },
    { vault: 7, folder: SECOND, last_written: null, size: 5 * MB },
    { vault: 7, folder: THIRD, last_written: "2026-10-01", size: null },
    // Another vault's copy is not this vault's.
    { vault: 8, folder: "Other.before-restore", last_written: "2026-09-09", size: MB },
  ];
}

function mine(): FakeVault[] {
  return [
    { id: 7, name: "My vault", items: sampleItems() },
    { id: 8, name: "Other", items: [] },
  ];
}

function sent(cmd: string): Record<string, unknown>[] {
  return invoke.mock.calls.filter(([name]) => name === cmd).map(([, args]) => args as Record<string, unknown>);
}

function side(): HTMLElement {
  return screen.getByRole("navigation", { name: "Vault and folders" });
}

/** The vault unlocked, with `list` kept beside it by earlier restores. */
async function unlocked(list: FakeOlderCopy[] = copies()) {
  shell = installFakeShell(invoke, listen, mine());
  shell.olderCopies(list);
  const view = render(<App />);
  const field = await screen.findByLabelText(/^Password for My vault/);
  fireEvent.change(field, { target: { value: PASSWORD } });
  fireEvent.submit((field as HTMLInputElement).form as HTMLFormElement);
  await screen.findByRole("heading", { level: 1, name: "All items" });
  return view;
}

/** Settings, then 24f. */
async function toTheList(list: FakeOlderCopy[] = copies()) {
  await unlocked(list);
  fireEvent.click(within(side()).getByRole("button", { name: "Settings" }));
  const settings = await screen.findByRole("complementary", { name: "Settings" });
  fireEvent.click(await within(settings).findByRole("button", { name: /^Older copies \(\d+\)$/ }));
  return screen.findByRole("complementary", { name: "Older copies" });
}

function row(panel: HTMLElement, folder: string): HTMLElement {
  const found = within(panel).getByText(folder).closest(".frow");
  if (!(found instanceof HTMLElement)) throw new Error(`no row for ${folder}`);
  return found;
}

function press(name: string | RegExp, inside: HTMLElement = document.body) {
  fireEvent.click(within(inside).getByRole("button", { name }));
}

function typeInto(text: string) {
  fireEvent.change(screen.getByLabelText<HTMLInputElement>(LABEL), { target: { value: text } });
}

test("older_copies_lists_date_and_size", async () => {
  const panel = await toTheList();
  expect(within(panel).getByRole("heading", { level: 2, name: "Older copies" })).toBeTruthy();
  expect(within(panel).getByText("For My vault. Kept when you restored a backup over it.")).toBeTruthy();
  // One row for each copy of this vault, the folder's name first, then the day it was last written and its size; a part the shell could not give is left out.
  expect(within(row(panel, FIRST)).getByText("From 4 November 2026 · 1.3 GB")).toBeTruthy();
  expect(within(row(panel, SECOND)).getByText("5 MB")).toBeTruthy();
  expect(within(row(panel, THIRD)).getByText("From 1 October 2026")).toBeTruthy();
  expect(within(panel).queryByText("Other.before-restore")).toBeNull();
  for (const folder of [FIRST, SECOND, THIRD]) {
    expect(within(row(panel, folder)).getByRole("button", { name: "Open read-only" })).toBeTruthy();
    expect(within(row(panel, folder)).getByRole("button", { name: "Delete" })).toBeTruthy();
  }
  expect(within(panel).getByText("Delete asks first, because it can't be undone.")).toBeTruthy();
  // Nothing was sent but the listing: no path crossed, nothing was opened or deleted.
  expect(sent("open_pre_restore_read_only")).toEqual([]);
  expect(sent("delete_pre_restore")).toEqual([]);
  expect(sent("list_pre_restore").every((args) => Object.keys(args).length === 0)).toBe(true);
  // A row whose shell gave neither a day nor a size has no second line.
  expect(document.body.textContent).not.toContain("null");
});

test("a_copy_with_no_day_and_no_size_has_no_second_line", async () => {
  const panel = await toTheList([{ vault: 7, folder: FIRST, last_written: null, size: null }]);
  const found = row(panel, FIRST);
  expect(found.querySelector("small")).toBeNull();
});

test("closing_the_panel_gives_focus_back_to_settings", async () => {
  const panel = await toTheList();
  await waitFor(() => {
    expect(document.activeElement).toBe(within(panel).getByRole("heading", { level: 2, name: "Older copies" }));
  });
  fireEvent.click(within(panel).getByRole("button", { name: "Close panel" }));
  expect(screen.queryByRole("complementary", { name: "Older copies" })).toBeNull();
  await waitFor(() => {
    expect(document.activeElement).toBe(within(side()).getByRole("button", { name: "Settings" }));
  });
});

test("open_an_older_copy_read_only", async () => {
  const panel = await toTheList();
  const mark = debugState().sessions;
  expect(mark).toHaveLength(1);
  const live = mark[0];
  press("Open read-only", row(panel, FIRST));
  // The step is inside the panel, under that row: the box, the hint, Open and Cancel.
  const step = within(panel).getByLabelText(LABEL);
  expect(step).toBeTruthy();
  expect(within(panel).getByText(HINT)).toBeTruthy();
  expect(within(panel).getByRole("button", { name: "Open" })).toBeTruthy();
  expect(within(panel).getByRole("button", { name: "Cancel" })).toBeTruthy();
  // Cancel puts it away, and the typed text with it.
  typeInto("something typed");
  press("Cancel", panel);
  expect(within(panel).queryByLabelText(LABEL)).toBeNull();
  press("Open read-only", row(panel, FIRST));
  expect((screen.getByLabelText<HTMLInputElement>(LABEL)).value).toBe("");

  // A wrong password keeps the step, says the unlock's words in the field and leaves the box empty.
  const id = shell.olderIds()[FIRST];
  typeInto("not the one it used");
  press("Open", panel);
  const alert = await within(panel).findByRole("alert");
  expect(alert.textContent).toBe("Wrong password.");
  expect(screen.getByLabelText<HTMLInputElement>(LABEL).value).toBe("");
  expect(sent("open_pre_restore_read_only")).toEqual([{ id, credential: { password_or_key: "not the one it used" } }]);
  expect(debugState().sessions).toHaveLength(1);

  // The right one opens it: a read-only session, the active one, with the chip and no writing.
  typeInto(PASSWORD);
  press("Open", panel);
  await screen.findByText("Read-only", { selector: ".chip" });
  const [first, second] = debugState().sessions;
  expect(first).toBe(live);
  expect(second?.readOnly).toBe(true);
  expect(sent("open_pre_restore_read_only")[1]).toEqual({ id, credential: { password_or_key: PASSWORD } });
  // The listing is read again after the open.
  expect(sent("list_pre_restore").length).toBeGreaterThanOrEqual(3);

  // The live vault is not marked open by it: the older copy's record has no place on the vault list, so once the live vault is locked the
  // window says it is locked, though the older copy is open.
  expect(second?.vaultId).not.toBe(7);
  expect(second?.vaultId).not.toBe(8);
  expect(debugState().sessions.filter((session) => session.vaultId === 7)).toEqual([live]);
  act(() => {
    shell.lock(live?.session ?? 0);
  });
  await waitFor(() => {
    expect(debugState().sessions).toHaveLength(1);
  });
  expect(document.querySelector(".lnote")?.textContent).toBe("2 other vaults are locked, so their items aren't listed.");
});

test("an_older_copy_opened_by_a_recovery_key_is_sent_as_the_one_box", async () => {
  const panel = await toTheList();
  press("Open read-only", row(panel, SECOND));
  typeInto("any words that are not the password");
  press("Open", panel);
  await within(panel).findByRole("alert");
  expect(sent("open_pre_restore_read_only")[0]).toEqual({ id: shell.olderIds()[SECOND], credential: { password_or_key: "any words that are not the password" } });
});

test("older_copy_credential_field_turns_off_spellcheck_and_autocomplete", async () => {
  const panel = await toTheList();
  press("Open read-only", row(panel, FIRST));
  const box = screen.getByLabelText<HTMLInputElement>(LABEL);
  expect(box.getAttribute("autocomplete")).toBe("off");
  expect(box.getAttribute("spellcheck")).toBe("false");
  expect(box.getAttribute("autocorrect")).toBe("off");
  expect(box.getAttribute("autocapitalize")).toBe("off");
  expect(box.type).toBe("password");
  // It is wiped on every lock epoch, and drawn anew (hidden again).
  typeInto("typed and not sent");
  fireEvent.click(within(panel).getByRole("button", { name: "Show what you typed" }));
  expect(screen.getByLabelText<HTMLInputElement>(LABEL).type).toBe("text");
  await act(async () => {
    shell.changeLockEpoch("idle");
    await Promise.resolve();
  });
  const again = screen.getByLabelText<HTMLInputElement>(LABEL);
  expect(again.value).toBe("");
  expect(again.type).toBe("password");
});

test("delete_asks_first_and_says_it_is_for_good", async () => {
  const panel = await toTheList();
  press("Delete", row(panel, SECOND));
  // The first send carries no yes: only the question comes back, and nothing is touched.
  const dialog = await screen.findByRole("dialog", { name: `Delete ${SECOND}?` });
  expect(sent("delete_pre_restore")).toEqual([{ id: shell.olderIds()[SECOND], confirm: false }]);
  expect(within(dialog).getByText(DELETE_WORDS)).toBeTruthy();
  // The safe answer has the focus.
  await waitFor(() => {
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Cancel" }));
  });
  expect(within(dialog).getByRole("button", { name: "Delete for good" }).className).toContain("dfill");
  await expectNoAxe(document.body);

  // Cancel keeps it.
  press("Cancel", dialog);
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(shell.deletedOlderCopies()).toEqual([]);
  expect(sent("delete_pre_restore")).toHaveLength(1);

  // Delete for good sends the yes, takes the row away, and the listing is read again.
  const id = shell.olderIds()[SECOND];
  const listings = sent("list_pre_restore").length;
  press("Delete", row(panel, SECOND));
  const second = await screen.findByRole("dialog", { name: `Delete ${SECOND}?` });
  press("Delete for good", second);
  await waitFor(() => {
    expect(within(panel).queryByText(SECOND)).toBeNull();
  });
  expect(shell.deletedOlderCopies()).toEqual([SECOND]);
  // Every send carries an ID of the newest listing, and only the last carries the yes.
  expect(sent("delete_pre_restore")).toEqual([
    { id, confirm: false },
    { id, confirm: false },
    { id, confirm: true },
  ]);
  expect(sent("list_pre_restore").length).toBeGreaterThan(listings);
  expect(within(panel).getByText(FIRST)).toBeTruthy();
  expect(within(panel).getByText(THIRD)).toBeTruthy();
});

test("the_last_copy_deleted_says_none_are_left", async () => {
  const panel = await toTheList([{ vault: 7, folder: FIRST, last_written: "2026-11-04", size: MB }]);
  press("Delete", row(panel, FIRST));
  const dialog = await screen.findByRole("dialog", { name: `Delete ${FIRST}?` });
  press("Delete for good", dialog);
  expect(await within(panel).findByText("No older copies are left.")).toBeTruthy();
  expect(within(panel).queryByText("Delete asks first, because it can't be undone.")).toBeNull();
  // The panel's close is still there, and focus is in the panel (the row it was on is gone).
  expect(within(panel).getByRole("button", { name: "Close panel" })).toBeTruthy();
  await waitFor(() => {
    expect(panel.contains(document.activeElement)).toBe(true);
  });
});

test("delete_refused_while_that_copy_is_open", async () => {
  const panel = await toTheList();
  shell.olderCopyIsOpen(FIRST);
  press("Delete", row(panel, FIRST));
  const alert = await within(panel).findByRole("alert");
  expect(alert.textContent).toBe(OPEN_COPY);
  // No question was asked and nothing was deleted; the row is still there.
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(within(panel).getByText(FIRST)).toBeTruthy();
  expect(shell.deletedOlderCopies()).toEqual([]);
  expect(sent("delete_pre_restore").every((args) => args.confirm === false)).toBe(true);
  // The refusal is not shown with any name or path.
  expect(alert.textContent).not.toContain("\\");
});

test("a_copy_open_read_only_is_refused_its_delete_until_it_is_locked", async () => {
  const panel = await toTheList();
  press("Open read-only", row(panel, FIRST));
  typeInto(PASSWORD);
  press("Open", panel);
  await screen.findByText("Read-only", { selector: ".chip" });
  // The older copy is the window now, and the live vault's Older copies panel waits behind it. Locking the older copy shows the live vault again.
  const [live, copy] = debugState().sessions;
  expect(copy?.readOnly).toBe(true);
  expect(shell.olderCopiesOpen()).toEqual([FIRST]);
  act(() => {
    shell.lock(copy?.session ?? 0);
  });
  await waitFor(() => {
    expect(debugState().sessions).toEqual([live]);
  });
  expect(shell.olderCopiesOpen()).toEqual([]);
  // Closed, it can be deleted: the question comes.
  const again = await screen.findByRole("complementary", { name: "Older copies" });
  press("Delete", row(again, FIRST));
  await screen.findByRole("dialog", { name: `Delete ${FIRST}?` });
});

test("a_changed_listing_is_refreshed", async () => {
  const panel = await toTheList();
  // Another listing replaced the shell's IDs, and a copy was deleted outside Lockbox: the page's IDs no longer match.
  shell.forgetOlderIds();
  shell.olderCopies(copies().filter((entry) => entry.folder !== SECOND));
  const listings = sent("list_pre_restore").length;
  press("Delete", row(panel, FIRST));
  // The shell answered `not_found`: no question, the listing is read again, and the words say so.
  expect(await within(panel).findByText(CHANGED)).toBeTruthy();
  expect(sent("list_pre_restore").length).toBeGreaterThan(listings);
  expect(screen.queryByRole("dialog")).toBeNull();
  await waitFor(() => {
    expect(within(panel).queryByText(SECOND)).toBeNull();
  });
  expect(within(panel).getByText(FIRST)).toBeTruthy();
  // The next press uses the new listing's ID, and goes through.
  press("Delete", row(panel, FIRST));
  await screen.findByRole("dialog", { name: `Delete ${FIRST}?` });
  expect(sent("delete_pre_restore").at(-1)).toEqual({ id: shell.olderIds()[FIRST], confirm: false });
});

test("an_open_that_finds_the_copy_changed_refreshes_the_listing_too", async () => {
  const panel = await toTheList();
  press("Open read-only", row(panel, FIRST));
  shell.forgetOlderIds();
  typeInto(PASSWORD);
  press("Open", panel);
  expect(await within(panel).findByText(CHANGED)).toBeTruthy();
  expect(within(panel).queryByLabelText(LABEL)).toBeNull();
  expect(debugState().sessions).toHaveLength(1);
});

test("a_lock_takes_the_older_copies_panel_and_what_was_typed_with_the_vault", async () => {
  const panel = await toTheList();
  press("Open read-only", row(panel, FIRST));
  typeInto("typed, never sent");
  act(() => {
    shell.lock(debugState().sessions[0]?.session ?? 0);
  });
  await waitFor(() => {
    expect(screen.queryByRole("complementary", { name: "Older copies" })).toBeNull();
  });
  expect(document.body.textContent).not.toContain("typed, never sent");
});

const CHANGED_DETAILS =
  "My vault's details were changed outside Lockbox. Its name, or other details kept beside your items, don't match what Lockbox last saved. Nothing in this older copy can change. If you didn't edit its files yourself, check your PC first.";

test("an_older_copy_whose_details_were_changed_says_so", async () => {
  const panel = await toTheList([
    { vault: 7, folder: FIRST, headerChanged: true },
    { vault: 7, folder: SECOND },
  ]);
  press("Open read-only", row(panel, SECOND));
  typeInto(PASSWORD);
  press("Open", panel);
  await screen.findByText("Read-only", { selector: ".chip" });
  // An older copy that was not changed has no warning.
  expect(screen.queryByText(CHANGED_DETAILS)).toBeNull();
  act(() => {
    shell.lock(debugState().sessions[1]?.session ?? 0);
  });
  const again = await screen.findByRole("complementary", { name: "Older copies" });
  press("Open read-only", row(again, FIRST));
  typeInto(PASSWORD);
  press("Open", again);
  // The shell said `header_changed`: the copy opens, read-only, and the window says what that means for it, with a way to put the words away.
  const words = await screen.findByText(CHANGED_DETAILS);
  expect(debugState().sessions[1]?.readOnly).toBe(true);
  expect(debugState().sessions[1]?.asks.headerChanged).toBe(true);
  const banner = words.closest(".ask") as HTMLElement;
  // Nothing in it can be accepted: the copy is read-only.
  expect(within(banner).queryByRole("button", { name: "Accept" })).toBeNull();
  press("Close", banner);
  expect(screen.queryByText(CHANGED_DETAILS)).toBeNull();
  await expectNoAxe(document.body);
});

test("cancel_while_the_open_is_pending_opens_nothing", async () => {
  const panel = await toTheList();
  const release = shell.holdOlderOpen();
  press("Open read-only", row(panel, FIRST));
  typeInto(PASSWORD);
  press("Open", panel);
  await waitFor(() => {
    expect(sent("open_pre_restore_read_only")).toHaveLength(1);
  });
  // Cancel is still there while the shell works on it.
  press("Cancel", panel);
  expect(within(panel).queryByLabelText(LABEL)).toBeNull();
  await act(async () => {
    release();
    await Promise.resolve();
  });
  // The answer comes after the person walked away: the copy is not shown, and the session the shell made is locked again.
  await waitFor(() => {
    expect(sent("lock_vault")).toHaveLength(1);
  });
  expect(shell.olderCopiesOpen()).toEqual([]);
  expect(debugState().sessions).toHaveLength(1);
  expect(screen.queryByText("Read-only", { selector: ".chip" })).toBeNull();
  // Nothing is left that keeps the copy from being deleted.
  press("Delete", row(panel, FIRST));
  await screen.findByRole("dialog", { name: `Delete ${FIRST}?` });
});

test("closing_the_panel_while_the_open_is_pending_opens_nothing", async () => {
  const panel = await toTheList();
  const release = shell.holdOlderOpen();
  press("Open read-only", row(panel, FIRST));
  typeInto(PASSWORD);
  press("Open", panel);
  await waitFor(() => {
    expect(sent("open_pre_restore_read_only")).toHaveLength(1);
  });
  fireEvent.click(within(panel).getByRole("button", { name: "Close panel" }));
  expect(screen.queryByRole("complementary", { name: "Older copies" })).toBeNull();
  await act(async () => {
    release();
    await Promise.resolve();
  });
  await waitFor(() => {
    expect(sent("lock_vault")).toHaveLength(1);
  });
  expect(shell.olderCopiesOpen()).toEqual([]);
  expect(debugState().sessions).toHaveLength(1);
  expect(screen.queryByText("Read-only", { selector: ".chip" })).toBeNull();
});

test("an_open_that_is_not_abandoned_still_opens_when_the_answer_is_late", async () => {
  const panel = await toTheList();
  const release = shell.holdOlderOpen();
  press("Open read-only", row(panel, FIRST));
  typeInto(PASSWORD);
  press("Open", panel);
  await waitFor(() => {
    expect(sent("open_pre_restore_read_only")).toHaveLength(1);
  });
  await act(async () => {
    release();
    await Promise.resolve();
  });
  await screen.findByText("Read-only", { selector: ".chip" });
  expect(sent("lock_vault")).toEqual([]);
});

test("listings_go_one_at_a_time_so_the_page_keeps_the_ids_the_shell_has", async () => {
  const panel = await toTheList();
  const before = sent("list_pre_restore").length;
  // Two listings overlap, and the shell would let the second finish first: each listing replaces every ID, so the page must not have two out at once.
  const release = shell.holdOlderListing();
  const first = loadOlderCopies();
  const second = loadOlderCopies();
  await Promise.resolve();
  expect(sent("list_pre_restore").length - before).toBe(1);
  // A press that comes while a listing is on its way waits for it, and then uses the IDs it gave.
  press("Delete", row(panel, FIRST));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(sent("delete_pre_restore")).toEqual([]);
  await act(async () => {
    release();
    await Promise.all([first, second]);
  });
  await screen.findByRole("dialog", { name: `Delete ${FIRST}?` });
  expect(sent("list_pre_restore").length - before).toBe(2);
  expect(debugState().olderCopies?.find((entry) => entry.folder === FIRST)?.id).toBe(shell.olderIds()[FIRST]);
  expect(sent("delete_pre_restore")).toEqual([{ id: shell.olderIds()[FIRST], confirm: false }]);
  expect(screen.queryByText(CHANGED)).toBeNull();
});

/** Delete asked and answered with the question open for `folder`; the dialog. */
async function theQuestion(panel: HTMLElement, folder: string): Promise<HTMLElement> {
  press("Delete", row(panel, folder));
  return screen.findByRole("dialog", { name: `Delete ${folder}?` });
}

test("a_queued_delete_is_cancelled_with_its_question", async () => {
  const panel = await toTheList();
  const dialog = await theQuestion(panel, SECOND);
  // A listing is on its way, so the yes waits for it: Cancel is still there, and what waits is dropped.
  const release = shell.holdOlderListing();
  const listing = loadOlderCopies();
  press("Delete for good", dialog);
  press("Cancel", dialog);
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  await act(async () => {
    release();
    await listing;
  });
  await act(async () => {
    await Promise.resolve();
  });
  expect(sent("delete_pre_restore").every((args) => args.confirm === false)).toBe(true);
  expect(shell.deletedOlderCopies()).toEqual([]);
  expect(within(panel).getByText(SECOND)).toBeTruthy();
});

test("a_queued_delete_is_dropped_by_a_lock", async () => {
  const panel = await toTheList();
  const dialog = await theQuestion(panel, SECOND);
  const release = shell.holdOlderListing();
  const listing = loadOlderCopies();
  press("Delete for good", dialog);
  act(() => {
    shell.lock(debugState().sessions[0]?.session ?? 0);
  });
  await waitFor(() => {
    expect(debugState().sessions).toHaveLength(0);
  });
  await act(async () => {
    release();
    await listing;
  });
  await act(async () => {
    await Promise.resolve();
  });
  expect(sent("delete_pre_restore").every((args) => args.confirm === false)).toBe(true);
  expect(shell.deletedOlderCopies()).toEqual([]);
});

test("a_queued_delete_is_dropped_by_a_lock_epoch", async () => {
  const panel = await toTheList();
  const dialog = await theQuestion(panel, SECOND);
  const release = shell.holdOlderListing();
  const listing = loadOlderCopies();
  press("Delete for good", dialog);
  await act(async () => {
    shell.changeLockEpoch("idle");
    await Promise.resolve();
  });
  await act(async () => {
    release();
    await listing;
  });
  await act(async () => {
    await Promise.resolve();
  });
  expect(sent("delete_pre_restore").every((args) => args.confirm === false)).toBe(true);
  expect(shell.deletedOlderCopies()).toEqual([]);
});

test("a_delete_that_was_sent_cannot_be_cancelled", async () => {
  const panel = await toTheList();
  const dialog = await theQuestion(panel, SECOND);
  const release = shell.holdOlderDelete();
  press("Delete for good", dialog);
  await waitFor(() => {
    expect(sent("delete_pre_restore").at(-1)?.confirm).toBe(true);
  });
  // The shell has it: nothing claims it can still be stopped.
  expect(within(dialog).getByRole("button", { name: "Cancel" }).getAttribute("aria-disabled")).toBe("true");
  expect(within(dialog).getByRole("button", { name: "Delete for good" }).getAttribute("aria-disabled")).toBe("true");
  press("Cancel", dialog);
  expect(screen.getByRole("dialog", { name: `Delete ${SECOND}?` })).toBeTruthy();
  press("Delete for good", dialog);
  expect(sent("delete_pre_restore").filter((args) => args.confirm === true)).toHaveLength(1);
  await act(async () => {
    release();
    await Promise.resolve();
  });
  await waitFor(() => {
    expect(within(panel).queryByText(SECOND)).toBeNull();
  });
  expect(shell.deletedOlderCopies()).toEqual([SECOND]);
});

test("cancelling_a_reopen_of_a_copy_that_is_already_open_leaves_it_open", async () => {
  const panel = await toTheList();
  press("Open read-only", row(panel, FIRST));
  typeInto(PASSWORD);
  press("Open", panel);
  await screen.findByText("Read-only", { selector: ".chip" });
  const [, copy] = debugState().sessions;
  // Asked again while it is open (the shell answers with the session it has), and walked away from before the answer.
  const release = shell.holdOlderOpen();
  const again = openOlderCopy(7, FIRST, PASSWORD);
  await waitFor(() => {
    expect(sent("open_pre_restore_read_only")).toHaveLength(2);
  });
  abandonOlderOpens();
  await act(async () => {
    release();
    expect(await again).toBe("stale");
  });
  // The session the answer named was not made by this open: it stays open, with its page state.
  expect(sent("lock_vault")).toEqual([]);
  expect(shell.olderCopiesOpen()).toEqual([FIRST]);
  expect(debugState().sessions[1]).toBe(copy);
});

test("a_refusal_that_comes_after_switching_copies_does_not_touch_the_new_box", async () => {
  const panel = await toTheList();
  const release = shell.holdOlderOpen();
  press("Open read-only", row(panel, FIRST));
  typeInto("not the one it used");
  press("Open", panel);
  await waitFor(() => {
    expect(sent("open_pre_restore_read_only")).toHaveLength(1);
  });
  // Another copy's box replaces it while the shell works.
  press("Open read-only", row(panel, SECOND));
  await act(async () => {
    release();
    await Promise.resolve();
  });
  // A's wrong password is not said under B's box.
  await waitFor(() => {
    expect(screen.getByLabelText<HTMLInputElement>(LABEL).readOnly).toBe(false);
  });
  expect(within(panel).queryByRole("alert")).toBeNull();
  expect(sent("open_pre_restore_read_only")).toHaveLength(1);
});

test("a_changed_answer_that_comes_after_switching_copies_does_not_close_the_new_box", async () => {
  const panel = await toTheList();
  const release = shell.holdOlderOpen();
  press("Open read-only", row(panel, FIRST));
  typeInto(PASSWORD);
  press("Open", panel);
  await waitFor(() => {
    expect(sent("open_pre_restore_read_only")).toHaveLength(1);
  });
  shell.forgetOlderIds();
  press("Open read-only", row(panel, SECOND));
  await act(async () => {
    release();
    await Promise.resolve();
  });
  await waitFor(() => {
    expect(screen.getByLabelText<HTMLInputElement>(LABEL).readOnly).toBe(false);
  });
  // B's box is still open, and the listing's words are not said for a press that was walked away from.
  expect(screen.getByLabelText(LABEL)).toBeTruthy();
  expect(within(panel).queryByText(CHANGED)).toBeNull();
});

test("older_copies_screens_have_no_axe_violations", async () => {
  const panel = await toTheList();
  await expectNoAxe(document.body);
  press("Open read-only", row(panel, FIRST));
  typeInto("wrong on purpose");
  press("Open", panel);
  await within(panel).findByRole("alert");
  await expectNoAxe(document.body);
  press("Cancel", panel);
  shell.olderCopyIsOpen(SECOND);
  press("Delete", row(panel, SECOND));
  await within(panel).findByRole("alert");
  await expectNoAxe(document.body);
});
