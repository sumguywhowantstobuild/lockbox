// Plan 4B Task 9's screens: moving to a new computer (26a to 26c), from the first screen's second link. Every case runs through the real App against the
// pretend shell, with no vault listed to begin with.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import App from "../../App";
import { debugState, resetStoreForTests } from "../../store";
import { expectNoAxe } from "../../testing/axe";
import { BACKUP_PASSWORD, installFakeShell, PASSWORD, sampleItems, type FakeShell, type FakeVault } from "../../testing/fakeShell";

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

const LINK = "I already have a vault or a backup";
const SAY = "Your vault comes with you as a backup or a folder.";
const SUB = "Either works on a new computer. Backups and folders need the password or recovery key from when they were made.";
const COPY_FIRST = "That folder is on a removable drive. Copy it to this PC first, then choose the copy.";
const WRONG_DRIVE = "A vault can't live on a removable, FAT32 or network drive. Choose a folder on this PC.";
const NOT_A_VAULT = "That folder isn't a Lockbox vault. Choose the vault's own folder.";
const NEXT = "Each vault comes across on its own. If you had more than one, bring in the next.";
const LABEL = "Password or recovery key from when it was made";

function start(vaults: FakeVault[] = []) {
  shell = installFakeShell(invoke, listen, vaults);
  return render(<App />);
}

function press(name: string | RegExp) {
  fireEvent.click(screen.getByRole("button", { name }));
}

function heading(name: string): Promise<HTMLElement> {
  return screen.findByRole("heading", { level: 1, name });
}

function sent(cmd: string): unknown[] {
  return invoke.mock.calls.filter(([name]) => name === cmd).map(([, args]): unknown => args);
}

/** The first screen, then 26a. */
async function toWhatDoYouHave(vaults: FakeVault[] = []) {
  const view = start(vaults);
  await heading("Welcome to Lockbox");
  press(LINK);
  await heading("What do you have?");
  return view;
}

/** 26a, then a backup picked, its password typed and the folder step (24b). */
async function toTheFolder() {
  await toWhatDoYouHave();
  press("A backup file");
  await heading("Restore a backup");
  fireEvent.change(screen.getByLabelText(LABEL), { target: { value: BACKUP_PASSWORD } });
  press("Continue");
  await heading("Where it goes");
}

/** From the folder step to 26c, after a restore. */
async function toTheNextVault() {
  await toTheFolder();
  press("Restore");
  await heading("My vault is here");
}

function oldVault(id: number, name: string): FakeVault {
  return { id, name, items: sampleItems() };
}

test("first_screen_offers_a_backup_or_a_folder", async () => {
  start();
  await heading("Welcome to Lockbox");
  // 21a's second way in, in the design's words, and it opens nothing by itself.
  expect(screen.queryByRole("button", { name: "I already have a vault" })).toBeNull();
  press(LINK);
  expect(sent("add_existing_vault")).toEqual([]);
  expect(sent("restore_pick")).toEqual([]);
  await heading("What do you have?");
  // 26a, as drawn: the dark side's line, the sub line, the two ways in and Back.
  expect(document.querySelector("header.field .say")?.textContent).toBe(SAY);
  expect(screen.getByText(SUB)).toBeTruthy();
  expect(screen.getByRole("button", { name: "A backup file" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "A vault folder" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Back" })).toBeTruthy();
  expect(document.activeElement).toBe(screen.getByRole("heading", { level: 1, name: "What do you have?" }));
  // Back is the first screen again.
  press("Back");
  await heading("Welcome to Lockbox");
  expect(screen.getByRole("button", { name: LINK })).toBeTruthy();
});

test("usb_folder_is_refused_with_copy_it_first", async () => {
  await toWhatDoYouHave();
  shell.refuseNext("add_existing_vault", { code: "invalid_input", what: "removable drive" });
  press("A vault folder");
  const alert = await screen.findByRole("alert");
  // 26b: 26a stays, with the refusal as its alert, in its own words and not the create form's.
  expect(alert.textContent).toBe(COPY_FIRST);
  expect(screen.getByRole("heading", { level: 1, name: "What do you have?" })).toBeTruthy();
  expect(screen.getByText(SUB)).toBeTruthy();
  // Nothing was added, and both ways in work again.
  expect(debugState().vaults).toEqual([]);
  expect(screen.getByRole("button", { name: "A vault folder" }).getAttribute("aria-disabled")).toBeNull();
  expect(screen.getByRole("button", { name: "A backup file" }).getAttribute("aria-disabled")).toBeNull();
  // Focus is back on the button that was pressed.
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "A vault folder" }));
  // The next try starts clean.
  shell.dismissPickerNext();
  press("A vault folder");
  await waitFor(() => {
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

test("other_drive_refusals_show_their_words", async () => {
  await toWhatDoYouHave();
  const drives = ["network drive", "drive type not supported", "file system not supported"];
  for (const what of drives) {
    shell.refuseNext("add_existing_vault", { code: "invalid_input", what });
    press("A vault folder");
    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toBe(WRONG_DRIVE);
    });
  }
  shell.refuseNext("add_existing_vault", { code: "invalid_input", what: "not a vault folder" });
  press("A vault folder");
  await waitFor(() => {
    expect(screen.getByRole("alert").textContent).toBe(NOT_A_VAULT);
  });
  // A refusal the page has no words for is the generic words, never the shell's own text.
  shell.refuseNext("add_existing_vault", { code: "core", kind: "io", what: "SENTINEL-7f3a C:\\Users\\secret" });
  press("A vault folder");
  await waitFor(() => {
    expect(screen.getByRole("alert").textContent).not.toBe(NOT_A_VAULT);
  });
  expect(document.body.textContent).not.toContain("SENTINEL");
  expect(document.body.textContent).not.toContain("not a vault folder");
  expect(screen.getByRole("heading", { level: 1, name: "What do you have?" })).toBeTruthy();
});

test("restore_from_the_first_screen_suggests_the_usual_folder", async () => {
  await toTheFolder();
  // The pick, with nothing sent but the pick's own; the folder step names the usual folder, as a restore from the lock screen does.
  expect(sent("restore_pick")).toEqual([{ choice: null, vault: null }]);
  expect(screen.getByText("C:\\Users\\Someone\\Lockbox Vaults\\My vault")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Choose another" })).toBeTruthy();
  expect(sent("restore_choose_folder")).toEqual([]);
});

test("cancel_goes_back_to_what_do_you_have", async () => {
  await toWhatDoYouHave();
  press("A backup file");
  await heading("Restore a backup");
  press("Cancel");
  // 26a, not Settings and not the first screen; the shell is told to forget the pick.
  await heading("What do you have?");
  expect(document.activeElement).toBe(screen.getByRole("heading", { level: 1, name: "What do you have?" }));
  await waitFor(() => {
    expect(shell.restorePicks()).toEqual([]);
  });
  expect(debugState().restore).toBeNull();
  // And once more: it can be started again.
  press("A backup file");
  await heading("Restore a backup");
  press("Cancel");
  await heading("What do you have?");
});

test("a_closed_backup_picker_leaves_what_do_you_have", async () => {
  await toWhatDoYouHave();
  shell.dismissFileNext();
  press("A backup file");
  await waitFor(() => {
    expect(sent("restore_pick")).toHaveLength(1);
  });
  await heading("What do you have?");
  expect(debugState().restore).toBeNull();
  expect(screen.getByRole("button", { name: "A backup file" }).getAttribute("aria-disabled")).toBeNull();
});

test("after_a_restore_offers_the_next_vault", async () => {
  await toTheNextVault();
  // 26c in place of 24e: the dark side's line, the sentence, Unlock with the vault's name and Bring in another vault.
  expect(document.querySelector("header.field .say")?.textContent).toBe(SAY);
  expect(screen.getByText(NEXT)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Unlock My vault" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Bring in another vault" })).toBeTruthy();
  expect(screen.queryByLabelText(/^Password from/)).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole("heading", { level: 1, name: "My vault is here" }));

  // Bring in another vault: back to 26a, and the restore is over. The vault stays listed.
  press("Bring in another vault");
  await heading("What do you have?");
  expect(debugState().restore).toBeNull();
  expect((debugState().vaults ?? []).map((vault) => vault.name)).toEqual(["My vault"]);
  // Back from here is the lock screen, which offers the vault that came in.
  press("Back");
  await heading("Unlock My vault");
});

test("a_second_restore_from_what_do_you_have_comes_to_the_next_vault", async () => {
  await toTheNextVault();
  press("Bring in another vault");
  await heading("What do you have?");
  press("A backup file");
  await heading("Restore a backup");
  shell.restoreIs({ name: "Second vault" });
  fireEvent.change(screen.getByLabelText(LABEL), { target: { value: BACKUP_PASSWORD } });
  press("Continue");
  await heading("Where it goes");
  press("Restore");
  await heading("Second vault is here");
  expect((debugState().vaults ?? []).map((vault) => vault.name)).toEqual(["My vault", "Second vault"]);
  press("Unlock Second vault");
  await heading("Second vault is restored");
});

test("unlock_after_a_restore_goes_to_the_password_step", async () => {
  await toTheNextVault();
  press("Unlock My vault");
  await heading("My vault is restored");
  expect(screen.getByLabelText("Password from 2 October 2026")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Password from 2 October 2026"), { target: { value: BACKUP_PASSWORD } });
  press("Unlock");
  await heading("All items");
  expect(debugState().restore).toBeNull();
});

test("after_a_folder_offers_the_next_vault", async () => {
  await toWhatDoYouHave();
  shell.offerExisting(oldVault(40, "Old vault"));
  press("A vault folder");
  await heading("Old vault is here");
  expect(screen.getByText(NEXT)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Bring in another vault" })).toBeTruthy();
  expect(sent("add_existing_vault")).toHaveLength(1);

  // Another vault, then Unlock: the lock screen with that vault chosen and its password field ready.
  press("Bring in another vault");
  await heading("What do you have?");
  shell.offerExisting(oldVault(41, "Newer vault"));
  press("A vault folder");
  await heading("Newer vault is here");
  press("Unlock Newer vault");
  const field = await screen.findByLabelText("Password for Newer vault");
  expect(document.activeElement).toBe(field);
  expect(screen.getByRole<HTMLInputElement>("radio", { name: /Newer vault/ }).checked).toBe(true);
  expect(screen.getByRole<HTMLInputElement>("radio", { name: /Old vault/ }).checked).toBe(false);
  fireEvent.change(field, { target: { value: PASSWORD } });
  fireEvent.submit((field as HTMLInputElement).form as HTMLFormElement);
  await heading("All items");
});

test("a_folder_added_while_the_list_cannot_be_read_still_unlocks", async () => {
  await toWhatDoYouHave();
  shell.offerExisting(oldVault(40, "Old vault"));
  // The add works, and then reading the list again is refused: the list was empty and stays unread.
  shell.refuseNext("list_vaults", { code: "core", kind: "io" });
  press("A vault folder");
  await heading("Old vault is here");
  press("Unlock Old vault");
  const field = await screen.findByLabelText("Password for Old vault");
  expect(document.activeElement).toBe(field);
  fireEvent.change(field, { target: { value: PASSWORD } });
  fireEvent.submit((field as HTMLInputElement).form as HTMLFormElement);
  await heading("All items");
});

test("a_folder_in_a_cloud_folder_asks_and_cancel_goes_back_to_what_do_you_have", async () => {
  await toWhatDoYouHave();
  shell.offerExisting(oldVault(40, "Old vault"));
  shell.cloudNext();
  press("A vault folder");
  await heading("This folder is synced to the cloud");
  press("Cancel");
  await heading("What do you have?");
  shell.cloudNext();
  press("A vault folder");
  await heading("This folder is synced to the cloud");
  press("Continue anyway");
  await heading("Old vault is here");
  expect(sent("add_existing_vault_confirm")).toHaveLength(1);
});

test("first_screen_restore_works_with_no_vaults_listed", async () => {
  start();
  await heading("Welcome to Lockbox");
  expect(debugState().vaults).toEqual([]);
  press(LINK);
  await heading("What do you have?");
  press("A backup file");
  await heading("Restore a backup");
  // With no vault listed, the pick, the check and the copy all go through, and the restored vault is listed by the commit.
  expect(debugState().vaults).toEqual([]);
  fireEvent.change(screen.getByLabelText(LABEL), { target: { value: BACKUP_PASSWORD } });
  press("Continue");
  await heading("Where it goes");
  press("Restore");
  await heading("My vault is here");
  expect((debugState().vaults ?? []).map((vault) => vault.name)).toEqual(["My vault"]);
  // The first screen is not what shows now that a vault is listed.
  expect(screen.queryByRole("heading", { level: 1, name: "Welcome to Lockbox" })).toBeNull();
  press("Unlock My vault");
  await heading("My vault is restored");
});

test("a_lock_screen_restore_still_goes_back_to_where_it_began", async () => {
  // The origin is only this flow's own: a restore started from the lock screen has nothing to do with 26a.
  start([oldVault(7, "My vault")]);
  await screen.findByLabelText(/^Password for /);
  press("Restore a backup");
  await heading("Restore a backup");
  press("Cancel");
  await screen.findByLabelText(/^Password for /);
  expect(screen.queryByRole("heading", { level: 1, name: "What do you have?" })).toBeNull();
  expect(screen.queryByText(NEXT)).toBeNull();
});

test("new_computer_screens_have_no_axe_violations", async () => {
  const view = await toWhatDoYouHave();
  await expectNoAxe(view.container);
  expect(view.container.querySelectorAll("style, [style]")).toHaveLength(0);
  shell.refuseNext("add_existing_vault", { code: "invalid_input", what: "removable drive" });
  press("A vault folder");
  const alert = await screen.findByRole("alert");
  expect(within(view.container).getByText(COPY_FIRST)).toBe(alert);
  await expectNoAxe(view.container);
  // 26c after a folder.
  shell.offerExisting(oldVault(40, "Old vault"));
  press("A vault folder");
  await heading("Old vault is here");
  await expectNoAxe(view.container);
  expect(view.container.querySelectorAll("style, [style]")).toHaveLength(0);
});

test("the_26c_after_a_restore_has_no_axe_violations", async () => {
  await toTheFolder();
  press("Restore");
  await heading("My vault is here");
  const view = { container: document.body };
  await expectNoAxe(view.container);
  expect(document.querySelectorAll("style, [style]")).toHaveLength(0);
});
