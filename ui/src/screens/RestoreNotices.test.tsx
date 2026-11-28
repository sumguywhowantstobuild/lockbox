// Plan 4B Task 6's screens: Ask 6 (a restore that was undone), Ask 7 (a restore waiting for a drive), the two states with no drawn screen (a rename that
// failed, a journal that can't be read) and Ask 8 (a vault whose details are both damaged). Every case runs through the real App against the pretend shell.
// The notice names its vault and its folder as text; no command takes a path back, and the page keeps none.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import App from "../App";
import { debugState, resetStoreForTests } from "../store";
import { expectNoAxe } from "../testing/axe";
import { BACKUP_PASSWORD, installFakeShell, PASSWORD, sampleItems, type FakeShell, type FakeVault } from "../testing/fakeShell";

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

const SAY = "A restore keeps your current vault beside the restored one.";
const SENTINEL = "C:\\Vaults\\SENTINEL-restore";
const PATHS = { step: "swapping", staging: SENTINEL, target: SENTINEL, before_restore: SENTINEL };
const BUSY_WORDS = "That vault is busy. Wait for what it's doing to finish, then try again.";
const STILL_MISSING = "That drive still isn't connected.";

const UNDONE = { kind: "restore", state: "recovered", how: "rolled_back", vault: { id: 7, name: "My vault" } };
const MISSING = { kind: "restore", state: "drive_missing", paths: PATHS, folder: "E:\\Vaults" };
const PENDING = { kind: "restore", state: "pending", paths: PATHS };
const UNCLEAR = { kind: "restore", state: "unclear", journal: SENTINEL, paths: null };

function mine(extra: Partial<FakeVault> = {}): FakeVault[] {
  return [{ id: 7, name: "My vault", items: sampleItems(), ...extra }];
}

function sent(cmd: string): Record<string, unknown>[] {
  return invoke.mock.calls.filter(([name]) => name === cmd).map(([, args]) => args as Record<string, unknown>);
}

function press(name: string | RegExp, within_: HTMLElement = document.body) {
  fireEvent.click(within(within_).getByRole("button", { name }));
}

function heading(name: string): Promise<HTMLElement> {
  return screen.findByRole("heading", { level: 1, name });
}

function buttons(): (string | null)[] {
  return screen.queryAllByRole("button").map((button) => button.textContent);
}

function spoken(): string {
  return document.querySelector(".live")?.textContent ?? "";
}

/** The page, started with what launch kept. */
function start(notices: object[], list: FakeVault[] = mine()) {
  shell = installFakeShell(invoke, listen, list);
  shell.setLaunchNotices(notices);
  return render(<App />);
}

test("restore_undone_at_launch_shows_ask_6", async () => {
  const { container } = start([UNDONE]);
  await heading("A restore didn't finish");
  // The setup frame, with its dark side's line; the words are the drawn ones, and the vault's name is the notice's.
  expect(document.querySelector("header.field .say")?.textContent).toBe(SAY);
  expect(
    screen.getByText("Petalock was closed partway through, and has put My vault back the way it was. Nothing is lost. You can start the restore again."),
  ).toBeTruthy();
  expect(buttons()).toEqual(["Restore again", "Not now"]);
  // Above the lock screen: no password box is on the page, and the heading has the focus.
  expect(screen.queryByLabelText(/^Password for /)).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole("heading", { level: 1, name: "A restore didn't finish" }));
  expect(container.querySelector('[role="status"].live')).not.toBeNull();
  // Nothing was sent to the shell but the launch's own questions: there is nothing to dismiss, the journal is gone.
  await waitFor(() => {
    expect(sent("launch_notices")).toHaveLength(1);
  });
  expect(sent("dismiss_restore")).toEqual([]);
  expect(sent("restore_pick")).toEqual([]);
});

test("restore_undone_at_launch_shows_ask_6: Not now closes it and shows the lock screen, and nothing is sent", async () => {
  start([UNDONE]);
  await heading("A restore didn't finish");
  press("Not now");
  await heading("Unlock My vault");
  expect(screen.queryByText(/partway through/)).toBeNull();
  expect(sent("dismiss_restore")).toEqual([]);
  expect(sent("retry_restore_recovery")).toEqual([]);
  expect(sent("restore_pick")).toEqual([]);
});

test("restore_undone_at_launch_shows_ask_6: Restore again closes it and starts the restore, with no vault given", async () => {
  start([UNDONE]);
  await heading("A restore didn't finish");
  press("Restore again");
  await heading("Restore a backup");
  expect(sent("restore_pick")).toEqual([{ choice: null, vault: null }]);
  expect(screen.queryByText(/partway through/)).toBeNull();
  // Cancel goes back to the lock screen, and the notice does not come back.
  press("Cancel");
  await heading("Unlock My vault");
  expect(screen.queryByText(/partway through/)).toBeNull();
});

test("restore_undone_at_launch_shows_ask_6: a staging folder removed reads the same, and a vault that can't be named is 'your vault'", async () => {
  start([{ kind: "restore", state: "recovered", how: "staging_removed", vault: null }]);
  await heading("A restore didn't finish");
  expect(
    screen.getByText("Petalock was closed partway through, and has put your vault back the way it was. Nothing is lost. You can start the restore again."),
  ).toBeTruthy();
});

test("a_notice_that_comes_while_the_app_runs_is_shown_the_same", async () => {
  shell = installFakeShell(invoke, listen, mine());
  render(<App />);
  await heading("Unlock My vault");
  act(() => {
    shell.tell(UNDONE);
  });
  await heading("A restore didn't finish");
});

test("drive_missing_shows_ask_7_and_names_the_folder_as_text", async () => {
  const { container } = start([MISSING]);
  await heading("A restore is waiting for a drive");
  expect(document.querySelector("header.field .say")?.textContent).toBe(SAY);
  expect(
    screen.getByText(
      "It was using E:\\Vaults, which isn't connected. Connect the drive, then try again. Dismissing leaves the folders there as they are, for you to sort out.",
    ),
  ).toBeTruthy();
  expect(buttons()).toEqual(["Try again", "Dismiss"]);
  // The folder is text: nothing on the page takes it back, and the journal's own paths are never shown or kept.
  expect(container.textContent).not.toContain("SENTINEL");
  expect(JSON.stringify(debugState())).not.toContain("SENTINEL");
  expect(container.querySelector("a, input")).toBeNull();
});

test("drive_missing_shows_ask_7_and_names_the_folder_as_text: Try again retries, and says so when the drive is still missing", async () => {
  start([MISSING]);
  await heading("A restore is waiting for a drive");
  shell.retryRestoreGives(MISSING);
  press("Try again");
  await waitFor(() => {
    expect(spoken()).toBe(STILL_MISSING);
  });
  expect(sent("retry_restore_recovery")).toEqual([{}]);
  // The same screen, still with its two buttons and its focus on the heading.
  expect(screen.getByRole("heading", { level: 1, name: "A restore is waiting for a drive" })).toBeTruthy();
  expect(buttons()).toEqual(["Try again", "Dismiss"]);
  // The drive is back and the restore is undone: the answer replaces the notice with Ask 6.
  shell.retryRestoreGives(UNDONE);
  press("Try again");
  await heading("A restore didn't finish");
  expect(sent("retry_restore_recovery")).toHaveLength(2);
});

test("drive_missing_shows_ask_7_and_names_the_folder_as_text: a retry that finished the restore shows the finished notice on the lock screen", async () => {
  start([MISSING], [{ id: 7, name: "My vault" }, { id: 8, name: "Restored vault" }]);
  await heading("A restore is waiting for a drive");
  shell.retryRestoreGives({ kind: "restore", state: "recovered", how: "finished", vault: { id: 8, name: "Restored vault" } });
  press("Try again");
  await screen.findByText("Petalock finished restoring Restored vault. Unlock with the password from when that backup was made.");
  expect(screen.queryByRole("heading", { level: 1, name: "A restore is waiting for a drive" })).toBeNull();
});

test("drive_missing_shows_ask_7_and_names_the_folder_as_text: Dismiss sends confirm true at once and leaves the folders there", async () => {
  start([MISSING]);
  await heading("A restore is waiting for a drive");
  press("Dismiss");
  await heading("Unlock My vault");
  // Its own words already say what dismissing leaves, so there is no second question; the page touches nothing else.
  expect(sent("dismiss_restore")).toEqual([{ confirm: true }]);
  expect(sent("retry_restore_recovery")).toEqual([]);
  expect(sent("restore_pick")).toEqual([]);
  expect(sent("restore_discard")).toEqual([]);
  expect(screen.queryByText(/isn't connected/)).toBeNull();
});

test("drive_missing_shows_ask_7_and_names_the_folder_as_text: a restore that is running answers busy, said under the buttons, and the screen stays", async () => {
  start([MISSING]);
  await heading("A restore is waiting for a drive");
  shell.refuseNext("retry_restore_recovery", { code: "busy", what: "restore" });
  press("Try again");
  expect((await screen.findByRole("alert")).textContent).toBe(BUSY_WORDS);
  expect(buttons()).toEqual(["Try again", "Dismiss"]);
  shell.refuseNext("dismiss_restore", { code: "busy", what: "restore" });
  press("Dismiss");
  await waitFor(() => {
    expect(sent("dismiss_restore")).toHaveLength(1);
  });
  expect((await screen.findByRole("alert")).textContent).toBe(BUSY_WORDS);
  expect(screen.getByRole("heading", { level: 1, name: "A restore is waiting for a drive" })).toBeTruthy();
});

test("pending_and_unclear_offer_a_way_out", async () => {
  const { container } = start([PENDING]);
  await heading("A restore is waiting");
  expect(
    screen.getByText(
      "Petalock couldn't finish putting things back yet. Close anything that may be using the vault's folder, then try again. Dismissing leaves the folders there as they are, for you to sort out.",
    ),
  ).toBeTruthy();
  expect(buttons()).toEqual(["Try again", "Dismiss"]);
  expect(container.textContent).not.toContain("SENTINEL");
  // Try again that still can't finish says so, and the screen stays.
  shell.retryRestoreGives(PENDING);
  press("Try again");
  await waitFor(() => {
    expect(spoken()).toBe("That restore still isn't finished.");
  });
  // Then the journal turns out unreadable: the other screen, with its one way out.
  shell.retryRestoreGives(UNCLEAR);
  press("Try again");
  await heading("A restore didn't finish");
  expect(
    screen.getByText("Petalock can't read its notes on what the restore had done. Dismissing leaves the folders there as they are, for you to sort out."),
  ).toBeTruthy();
  expect(buttons()).toEqual(["Dismiss"]);
  expect(container.textContent).not.toContain("SENTINEL");
  expect(JSON.stringify(debugState())).not.toContain("SENTINEL");
  press("Dismiss");
  await heading("Unlock My vault");
  expect(sent("dismiss_restore")).toEqual([{ confirm: true }]);
});

test("pending_and_unclear_offer_a_way_out: unclear from launch has Dismiss only and no path", async () => {
  const { container } = start([UNCLEAR]);
  await heading("A restore didn't finish");
  expect(buttons()).toEqual(["Dismiss"]);
  expect(container.textContent).not.toContain("SENTINEL");
  press("Dismiss");
  await heading("Unlock My vault");
  expect(sent("dismiss_restore")).toEqual([{ confirm: true }]);
});

test("a_retry_that_reconnects_a_vault_makes_it_available_on_the_lock_screen", async () => {
  // The drive was away, so the vault was listed as not available; the retry undoes the restore and the drive is back.
  const list: FakeVault[] = [{ id: 7, name: "My vault", items: sampleItems(), available: false }];
  start([MISSING], list);
  await heading("A restore is waiting for a drive");
  list[0] = { ...(list[0] as FakeVault), available: true };
  shell.retryRestoreGives(UNDONE);
  press("Try again");
  await heading("A restore didn't finish");
  press("Not now");
  // The list was read again: the vault can be unlocked.
  expect(await screen.findByLabelText("Password for My vault")).toBeTruthy();
  expect(sent("list_vaults").length).toBeGreaterThan(1);
});

test("a_retry_that_finishes_a_restore_lists_the_new_vault_so_the_finished_notice_unlocks_it", async () => {
  const list: FakeVault[] = [...mine()];
  start([MISSING], list);
  await heading("A restore is waiting for a drive");
  // The restore finished and added its vault to the shell's list while the page still held the old one.
  list.push({ id: 8, name: "Restored vault", items: sampleItems() });
  shell.retryRestoreGives({ state: "recovered", how: "finished", vault: { id: 8, name: "Restored vault" } });
  press("Try again");
  await screen.findByText("Petalock finished restoring Restored vault. Unlock with the password from when that backup was made.");
  fireEvent.click(screen.getAllByRole("button", { name: "Unlock" })[0] as HTMLElement);
  // Its Unlock chooses the restored vault, which the page knows about now.
  expect(await screen.findByLabelText("Password for Restored vault")).toBeTruthy();
  expect(screen.getByRole<HTMLInputElement>("radio", { name: /Restored vault/ }).checked).toBe(true);
});

test("a_notice_that_comes_while_the_app_runs_reads_the_vault_list_again", async () => {
  const list: FakeVault[] = [...mine()];
  shell = installFakeShell(invoke, listen, list);
  render(<App />);
  await heading("Unlock My vault");
  const before = sent("list_vaults").length;
  list.push({ id: 8, name: "Restored vault", items: sampleItems() });
  act(() => {
    shell.tell({ kind: "restore", state: "recovered", how: "finished", vault: { id: 8, name: "Restored vault" } });
  });
  await screen.findByRole("radio", { name: /Restored vault/ });
  expect(sent("list_vaults").length).toBeGreaterThan(before);
});

test("a_restore_refused_by_an_unfinished_one_reads_the_vault_list_again", async () => {
  const list: FakeVault[] = [...mine()];
  shell = installFakeShell(invoke, listen, list);
  render(<App />);
  await screen.findByLabelText(/^Password for /);
  press("Restore a backup");
  await heading("Restore a backup");
  fireEvent.change(screen.getByLabelText("Password or recovery key from when it was made"), { target: { value: BACKUP_PASSWORD } });
  press("Continue");
  await heading("Where it goes");
  const before = sent("list_vaults").length;
  list.push({ id: 8, name: "Restored vault", items: sampleItems() });
  shell.restoreRecoversNext({ state: "recovered", how: "finished", vault: { id: 8, name: "Restored vault" } });
  press("Restore");
  await screen.findByText("Petalock finished restoring Restored vault. Unlock with the password from when that backup was made.");
  await screen.findByRole("radio", { name: /Restored vault/ });
  expect(sent("list_vaults").length).toBeGreaterThan(before);
});

test("a_notice_of_none_closes_what_was_shown", async () => {
  start([MISSING]);
  await heading("A restore is waiting for a drive");
  shell.retryRestoreGives({ state: "none" });
  press("Try again");
  await heading("Unlock My vault");
});

/** The lock screen with a vault whose two copies of its details are both damaged (listed with no name, and reachable). */
const DAMAGED: FakeVault = { id: 9, name: null, available: true, detailsDamaged: true };

test("both_headers_unreadable_shows_ask_8", async () => {
  const { container } = start([], [...mine(), DAMAGED]);
  await heading("Unlock a vault");
  fireEvent.click(screen.getByRole("radio", { name: /A vault that can't be read/ }));
  await heading("This vault can't be opened");
  expect(document.querySelector("header.field .say")?.textContent).toBe(SAY);
  expect(
    screen.getByText(
      "Both copies of its details are damaged, so no password can open it. A backup can bring it back, in a new folder beside this one, and the damaged folder is left alone.",
    ),
  ).toBeTruthy();
  // Back, then Show in Explorer and Remove from this list (Task 9), as quiet links.
  expect(buttons()).toEqual(["Restore a backup", "Back", "Show A vault that can't be read in Explorer", "Remove A vault that can't be read from this list"]);
  // No password can open it, so there is no box.
  expect(screen.queryByLabelText(/^Password for /)).toBeNull();
  expect(container.querySelector("input")).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole("heading", { level: 1, name: "This vault can't be opened" }));
  expect(container.querySelector('[role="status"].live')).not.toBeNull();
});

test("both_headers_unreadable_shows_ask_8: Restore a backup sends the vault, and the folder step says it unpacks beside the damaged one", async () => {
  start([], [...mine(), DAMAGED]);
  await heading("Unlock a vault");
  fireEvent.click(screen.getByRole("radio", { name: /A vault that can't be read/ }));
  await heading("This vault can't be opened");
  press("Restore a backup");
  await heading("Restore a backup");
  expect(sent("restore_pick")).toEqual([{ choice: null, vault: 9 }]);
  const choice = shell.restorePickTokens()[0];
  // Pick another keeps the destination: the same vault goes again.
  press("Pick another");
  await waitFor(() => {
    expect(sent("restore_pick")).toHaveLength(2);
  });
  expect(sent("restore_pick")[1]).toEqual({ choice, vault: 9 });
  fireEvent.change(screen.getByLabelText("Password or recovery key from when it was made"), { target: { value: BACKUP_PASSWORD } });
  press("Continue");
  await heading("Where it goes");
  expect(screen.getByText("It unpacks as My vault, in a new folder beside the damaged one.")).toBeTruthy();
  // Choose another replaces the parent: the sentence is the ordinary one.
  press("Choose another");
  await screen.findByText("It unpacks as My vault, in the folder you chose.");
  // Cancel is back to the lock screen, and the damaged vault's own screen comes back only when it is chosen.
  press("Back");
  press("Cancel");
  // Back at the lock screen, with the vault that can be opened chosen (not the damaged one, whose screen comes back only when it is chosen).
  await heading("Unlock a vault");
  expect(screen.getByLabelText("Password for My vault")).toBeTruthy();
});

test("both_headers_unreadable_shows_ask_8: Back goes to the lock screen with a vault that can be opened", async () => {
  start([], [...mine(), DAMAGED]);
  await heading("Unlock a vault");
  fireEvent.click(screen.getByRole("radio", { name: /A vault that can't be read/ }));
  await heading("This vault can't be opened");
  press("Back");
  await heading("Unlock a vault");
  expect(screen.getByLabelText("Password for My vault")).toBeTruthy();
  expect(sent("restore_pick")).toEqual([]);
});

test("both_headers_unreadable_shows_ask_8: a vault that is all there is shows Ask 8 at once, and Back leaves the lock screen as it was", async () => {
  start([], [DAMAGED]);
  await heading("This vault can't be opened");
  press("Back");
  await heading("Unlock A vault that can't be read");
  expect(screen.getByLabelText("Password for A vault that can't be read")).toBeTruthy();
});

test("a_vault_with_no_name_but_details_that_are_not_damaged_keeps_the_lock_screen", async () => {
  // A listed folder with no vault in it, or a header unreadable for another reason, lists with no name too: "both copies are damaged" would be wrong for it.
  start([], [...mine(), { id: 9, name: null, available: true, detailsDamaged: false }]);
  await heading("Unlock a vault");
  fireEvent.click(screen.getByRole("radio", { name: /A vault that can't be read/ }));
  expect(await screen.findByLabelText("Password for A vault that can't be read")).toBeTruthy();
  expect(screen.queryByText("This vault can't be opened")).toBeNull();
  expect(screen.queryByText(/Both copies of its details are damaged/)).toBeNull();
  expect(buttons()).not.toContain("Back");
});

test("a_vault_that_can_be_read_never_shows_ask_8", async () => {
  start([], [...mine(), { id: 8, name: "Old laptop", available: false }]);
  await heading("Unlock a vault");
  expect(screen.queryByText("This vault can't be opened")).toBeNull();
});

test("notices_have_no_axe_violations", async () => {
  const first = start([UNDONE]);
  await heading("A restore didn't finish");
  await expectNoAxe(first.container);
  cleanup();
  resetStoreForTests();
  for (const notice of [MISSING, PENDING, UNCLEAR]) {
    const view = start([notice]);
    await screen.findByRole("heading", { level: 1 });
    await expectNoAxe(view.container);
    cleanup();
    resetStoreForTests();
  }
  const ask8 = start([], [...mine(), DAMAGED]);
  await heading("Unlock a vault");
  fireEvent.click(screen.getByRole("radio", { name: /A vault that can't be read/ }));
  await heading("This vault can't be opened");
  await expectNoAxe(ask8.container);
  // The Content Security Policy refuses a `<style>` element: the page makes none.
  expect(document.querySelectorAll("style")).toHaveLength(0);
});

test("a_notice_closed_with_not_now_leaves_the_vault_to_unlock_and_no_command_carries_a_path", async () => {
  // A notice closed with Not now is gone for good: the lock screen and the vault show as they always did.
  start([UNDONE]);
  await heading("A restore didn't finish");
  press("Not now");
  const field = await screen.findByLabelText(/^Password for /);
  fireEvent.change(field, { target: { value: PASSWORD } });
  fireEvent.submit((field as HTMLInputElement).form as HTMLFormElement);
  await heading("All items");
  for (const cmd of ["launch_notices", "restore_notice", "retry_restore_recovery", "dismiss_restore"]) {
    for (const args of sent(cmd)) expect(JSON.stringify(args), cmd).not.toMatch(/[A-Z]:[\\/]|\\Users/);
  }
});
