import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import App from "../../App";
import { messageFor, messageText } from "../../messages";
import { resetStoreForTests } from "../../store";
import { expectNoAxe } from "../../testing/axe";
import { installFakeShell, sampleItems, type FakeShell, type FakeVault } from "../../testing/fakeShell";

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

const HEADING = "Lockbox lost its list of vaults";
const SAY = "Your vaults are safe. Only the list of where they are was damaged.";
const SUB = "Your vaults are still in their folders. Start a new list, then add each vault back.";
const BUTTON = "Start a new list";

function vault(extra: Partial<FakeVault> = {}): FakeVault {
  return { id: 7, name: "My vault", items: sampleItems(), ...extra };
}

/** The app on a shell whose vault list can't be read. */
function startDamaged() {
  shell = installFakeShell(invoke, listen, [vault()]);
  shell.damageVaultList();
  return render(<App />);
}

function commandsSent(): string[] {
  return shell.calls.map((call) => call.cmd);
}

function buttonNames(): string[] {
  return screen.queryAllByRole("button").map((button) => button.textContent);
}

test("a_damaged_vault_list_shows_its_own_screen_with_the_approved_words", async () => {
  const { container } = startDamaged();
  expect(await screen.findByRole("heading", { level: 1, name: HEADING })).toBeTruthy();
  // The first-run layout: the dark side's line, the heading, the sentence under it and one main button.
  expect(container.querySelector("header.field .say")?.textContent).toBe(SAY);
  expect(container.querySelector(".fu-sub")?.textContent).toBe(SUB);
  const button = screen.getByRole("button", { name: BUTTON });
  expect(button.className).toBe("prim");
  expect(buttonNames()).toEqual([BUTTON]);
  // It is the setup screens' frame, not the lock screen: no unlock heading, no password, no red sentence yet.
  expect(container.querySelector(".fu")).not.toBeNull();
  expect(screen.queryByRole("heading", { level: 1, name: /^Unlock/ })).toBeNull();
  expect(screen.queryByLabelText(/^Password/)).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(container.querySelectorAll("style, [style]")).toHaveLength(0);
  await expectNoAxe(container);
});

test("start_a_new_list_asks_once_then_reads_the_list_again_and_shows_welcome", async () => {
  startDamaged();
  fireEvent.click(await screen.findByRole("button", { name: BUTTON }));
  expect(await screen.findByRole("heading", { level: 1, name: "Welcome to Lockbox" })).toBeTruthy();
  const sent = commandsSent().filter((cmd) => !cmd.startsWith("listen:"));
  // The list was refused at the start, the command ran once, and the list was read again.
  expect(sent.filter((cmd) => cmd === "start_new_vault_list")).toHaveLength(1);
  expect(sent.slice(sent.indexOf("start_new_vault_list"))).toEqual(["start_new_vault_list", "list_vaults"]);
  expect(screen.queryByText(HEADING)).toBeNull();
  // The command is sent with no arguments at all.
  expect(shell.calls.find((call) => call.cmd === "start_new_vault_list")?.args).toEqual({});
});

test("the_vaults_are_added_back_from_the_first_screen_after_a_new_list", async () => {
  startDamaged();
  shell.offerExisting({ id: 40, name: "Old vault", items: sampleItems() });
  fireEvent.click(await screen.findByRole("button", { name: BUTTON }));
  await screen.findByRole("heading", { level: 1, name: "Welcome to Lockbox" });
  fireEvent.click(screen.getByRole("button", { name: "I already have a vault" }));
  expect(await screen.findByRole("heading", { level: 1, name: "Unlock Old vault" })).toBeTruthy();
});

test("the_button_is_busy_while_it_runs_and_a_second_press_sends_nothing_more", async () => {
  startDamaged();
  const release = shell.holdStartNewList();
  const button = await screen.findByRole<HTMLButtonElement>("button", { name: BUTTON });
  fireEvent.click(button);
  await waitFor(() => {
    expect(button.disabled).toBe(true);
  });
  fireEvent.click(button);
  fireEvent.keyDown(button, { key: "Enter" });
  expect(commandsSent().filter((cmd) => cmd === "start_new_vault_list")).toHaveLength(1);
  // Still this screen, and not Welcome, until the answer comes.
  expect(screen.getByRole("heading", { level: 1, name: HEADING })).toBeTruthy();
  act(() => {
    release();
  });
  expect(await screen.findByRole("heading", { level: 1, name: "Welcome to Lockbox" })).toBeTruthy();
  expect(commandsSent().filter((cmd) => cmd === "start_new_vault_list")).toHaveLength(1);
});

test("a_refusal_is_said_in_words_on_the_screen_and_the_button_works_again", async () => {
  const { container } = startDamaged();
  // The refusal as the shell sends a disk error (`error.rs`: `Core` with the kind `io`), carrying text the page must not show.
  shell.refuseNext("start_new_vault_list", { code: "core", kind: "io", what: "SENTINEL-7f3a C:\\Users\\secret" });
  const button = await screen.findByRole<HTMLButtonElement>("button", { name: BUTTON });
  fireEvent.click(button);
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toBe(messageText(messageFor({ code: "core", kind: "io" })));
  expect(alert.textContent).not.toContain("SENTINEL");
  expect(container.textContent).not.toContain("SENTINEL");
  // Never a dead end: still this screen, its button enabled again, and focus on it.
  expect(screen.getByRole("heading", { level: 1, name: HEADING })).toBeTruthy();
  await waitFor(() => {
    expect(button.disabled).toBe(false);
  });
  expect(document.activeElement).toBe(button);
  await expectNoAxe(container);
  // The next press works, and the refusal goes.
  fireEvent.click(button);
  expect(await screen.findByRole("heading", { level: 1, name: "Welcome to Lockbox" })).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(commandsSent().filter((cmd) => cmd === "start_new_vault_list")).toHaveLength(2);
});

test("a_refusal_that_leaves_the_list_damaged_reads_it_again_and_keeps_the_screen_with_the_words", async () => {
  const { container } = startDamaged();
  shell.refuseNext("start_new_vault_list", { code: "core", kind: "io" });
  const button = await screen.findByRole<HTMLButtonElement>("button", { name: BUTTON });
  fireEvent.click(button);
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toBe(messageText(messageFor({ code: "core", kind: "io" })));
  expect(screen.getByRole("heading", { level: 1, name: HEADING })).toBeTruthy();
  // The list was read again after the refusal, and it still could not be read.
  const sent = commandsSent().filter((cmd) => !cmd.startsWith("listen:"));
  expect(sent.slice(sent.indexOf("start_new_vault_list"))).toEqual(["start_new_vault_list", "list_vaults"]);
  await waitFor(() => {
    expect(button.disabled).toBe(false);
  });
  expect(container.querySelectorAll(".err")).toHaveLength(1);
});

test("a_move_that_worked_but_a_new_list_that_was_not_written_still_leaves_for_welcome", async () => {
  startDamaged();
  // The shell set the damaged file aside, could not write the new list, and said so: the list now reads as empty.
  shell.startNewListFailsAfterMoveNext({ code: "core", kind: "io" });
  fireEvent.click(await screen.findByRole("button", { name: BUTTON }));
  expect(await screen.findByRole("heading", { level: 1, name: "Welcome to Lockbox" })).toBeTruthy();
  expect(screen.queryByText(HEADING)).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(commandsSent().filter((cmd) => cmd === "start_new_vault_list")).toHaveLength(1);
});

test("a_list_mended_from_outside_leaves_the_screen_when_the_button_is_pressed", async () => {
  startDamaged();
  await screen.findByRole("heading", { level: 1, name: HEADING });
  // Someone put the list right while the screen was up: the shell now reads it, and refuses to start a new one over a good list.
  shell.repairVaultList();
  fireEvent.click(screen.getByRole("button", { name: BUTTON }));
  expect(await screen.findByRole("heading", { level: 1, name: "Unlock My vault" })).toBeTruthy();
  expect(screen.queryByText(HEADING)).toBeNull();
  expect(screen.queryByRole("button", { name: BUTTON })).toBeNull();
});

test("a_list_that_cannot_be_read_for_another_reason_does_not_show_this_screen", async () => {
  const others: object[] = [
    { code: "core", kind: "io" },
    { code: "core", kind: "damaged", what: "item" },
    { code: "core", kind: "damaged", what: "SENTINEL-vault list" },
    { code: "core", kind: "damaged" },
    { code: "invalid_input", what: "vault list" },
    { code: "locked" },
  ];
  for (const refusal of others) {
    resetStoreForTests();
    invoke.mockReset();
    listen.mockReset();
    shell = installFakeShell(invoke, listen, [vault()]);
    shell.refuseNext("list_vaults", refusal);
    const { container, unmount } = render(<App />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent.length, JSON.stringify(refusal)).toBeGreaterThan(5);
    expect(container.textContent).not.toContain("SENTINEL");
    expect(screen.queryByRole("heading", { level: 1, name: HEADING }), JSON.stringify(refusal)).toBeNull();
    expect(screen.queryByRole("button", { name: BUTTON }), JSON.stringify(refusal)).toBeNull();
    expect(commandsSent()).not.toContain("start_new_vault_list");
    unmount();
  }
});

test("a_list_that_reads_fine_never_shows_it", async () => {
  shell = installFakeShell(invoke, listen, [vault()]);
  render(<App />);
  await screen.findByRole("heading", { level: 1, name: "Unlock My vault" });
  expect(screen.queryByRole("button", { name: BUTTON })).toBeNull();
  expect(commandsSent()).not.toContain("start_new_vault_list");
});
