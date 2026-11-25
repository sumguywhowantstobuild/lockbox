// Task 36, Get help: the Help link of the empty vault (21g), Help in Settings (31a), and what the empty vault says to do first. Help asks the shell to
// open its own fixed address (`open_help`, an empty body): the page never holds, builds or sends an address, so a test can only count the asks and read
// what each one carried.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import App from "../App";
import { messageFor, messageText } from "../messages";
import { debugState, resetStoreForTests } from "../store";
import { expectNoAxe } from "../testing/axe";
import { installFakeShell, PASSWORD, sampleItems, type FakeShell, type FakeVault } from "../testing/fakeShell";
import { rowReads } from "../testing/menuRows";

const { invoke, listen } = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));

afterEach(() => {
  cleanup();
});

let shell: FakeShell;

beforeEach(() => {
  resetStoreForTests();
  invoke.mockReset();
  listen.mockReset();
});

const WHAT_TO_DO_FIRST =
  "What to do first: add a login, or a key, a note or a file. Once it holds things you'd miss, make a backup from Settings.";

/** What Help says when the launcher could not start the browser (the shell's `core` `io` refusal with `what` "guide"). */
const HELP_NOT_OPENED = "Petalock couldn't open the guide. Check that this PC has a web browser, then try again.";
const BROWSER_REFUSAL = { code: "core", kind: "io", what: "guide" };

/** The app unlocked through its lock screen, as a person does it. */
async function unlocked(vaults: FakeVault[]) {
  shell = installFakeShell(invoke, listen, vaults);
  const view = render(<App />);
  const field = await screen.findByLabelText(/^Password for /);
  fireEvent.change(field, { target: { value: PASSWORD } });
  fireEvent.submit((field as HTMLInputElement).form as HTMLFormElement);
  await screen.findByRole("heading", { level: 1, name: "All items" });
  return view;
}

/** Settings of the vault on screen, opened from the side menu. */
async function settings(): Promise<HTMLElement> {
  const side = screen.getByRole("navigation", { name: "Vault and folders" });
  fireEvent.click(within(side).getByRole("button", { name: "Settings" }));
  const panel = await screen.findByRole("complementary", { name: "Settings" });
  await within(panel).findByRole("switch", { name: "Start with Windows" });
  return panel;
}

/** Every `open_help` the page sent, as it sent it. */
function helpAsks(): unknown[] {
  return (invoke.mock.calls as [string, unknown][]).filter(([cmd]) => cmd === "open_help").map(([, args]) => args);
}

/** The empty vault's own card in the list. */
function emptyCard(): HTMLElement {
  return screen.getByText("Your vault is empty").closest(".lempty") as HTMLElement;
}

// 21g's and 31a's words and their placing are in `setup.test.tsx` (the vault just made) and here (a vault unlocked again).
test("an_empty_vault_reopened_shows_what_to_do_first", async () => {
  await unlocked([{ id: 7, name: "My vault", items: [] }]);
  const card = emptyCard();
  expect(within(card).getByText(WHAT_TO_DO_FIRST)).toBeTruthy();
  // The kinds that can be made, then Help on a line of its own: a plain link, as drawn.
  expect(within(card).getAllByRole("button").map((button) => button.textContent)).toEqual(["Login", "Key", "Note", "File", "Paste a .env", "Help"]);
  const help = within(card).getByRole("button", { name: "Help" });
  expect(help.className).toBe("lnk");
  expect(help.closest(".le-a")?.querySelectorAll("button")).toHaveLength(1);

  // Once the vault holds an item the card is gone, and Help with it (it is in Settings still).
  fireEvent.click(within(card).getByRole("button", { name: "Note" }));
  const form = await screen.findByRole("complementary", { name: "New note" });
  fireEvent.change(within(form).getByLabelText("Title"), { target: { value: "MU-first note" } });
  fireEvent.click(within(form).getByRole("button", { name: "Save" }));
  await screen.findByRole("complementary", { name: "MU-first note" });
  await waitFor(() => {
    expect(screen.queryByText("Your vault is empty")).toBeNull();
  });
  expect(screen.queryByText(WHAT_TO_DO_FIRST)).toBeNull();
  expect(within(screen.getByRole("main")).queryByRole("button", { name: "Help" })).toBeNull();
});

test("a_vault_with_items_does_not_say_what_to_do_first", async () => {
  await unlocked([{ id: 7, name: "My vault", items: sampleItems() }]);
  expect(screen.queryByText("Your vault is empty")).toBeNull();
  expect(screen.queryByText(WHAT_TO_DO_FIRST)).toBeNull();
  expect(within(screen.getByRole("main")).queryByRole("button", { name: "Help" })).toBeNull();
});

test("settings_shows_help", async () => {
  await unlocked([{ id: 7, name: "My vault", items: sampleItems() }]);
  const panel = await settings();
  // 31a: in the About group, under the version, a row that goes to the guide.
  const about = within(panel).getByRole("heading", { level: 3, name: "About" }).closest("section") as HTMLElement;
  const help = within(about).getByRole("button", { name: "Help" });
  expect(about.textContent).toContain("Version 1.2.3");
  expect(help.classList.contains("srow")).toBe(true);
  expect(help.classList.contains("sgo")).toBe(true);
  // The arrow is a picture for the eye; the button is named by its word alone.
  expect(help.querySelector("svg[aria-hidden='true']")).not.toBeNull();
  expect(help.getAttribute("aria-label")).toBeNull();
  expect(shell.helpOpened()).toBe(0);
  fireEvent.click(help);
  await waitFor(() => {
    expect(shell.helpOpened()).toBe(1);
  });
  expect(helpAsks()).toEqual([{}]);
  expect(screen.queryByRole("alert")).toBeNull();
});

test("help_is_there_in_a_vault_opened_from_a_backup_too", async () => {
  await unlocked([{ id: 7, name: "My vault", items: sampleItems(), readOnly: true }]);
  const panel = await settings();
  fireEvent.click(within(panel).getByRole("button", { name: "Help" }));
  await waitFor(() => {
    expect(shell.helpOpened()).toBe(1);
  });
});

// Review Focus 5, the page's half: from both entry points the page sends the one body, `{}`, once for each press.
test("help_asks_the_shell_the_same_way_from_both_entry_points", async () => {
  await unlocked([{ id: 7, name: "My vault", items: [] }]);
  fireEvent.click(within(emptyCard()).getByRole("button", { name: "Help" }));
  await waitFor(() => {
    expect(shell.helpOpened()).toBe(1);
  });
  const panel = await settings();
  fireEvent.click(within(panel).getByRole("button", { name: "Help" }));
  await waitFor(() => {
    expect(shell.helpOpened()).toBe(2);
  });
  expect(helpAsks()).toEqual([{}, {}]);
  // Nothing but `open_help` carries Help to the shell: no other command went with it.
  const sent = (invoke.mock.calls as [string, unknown][]).map(([cmd]) => cmd);
  expect(sent.filter((cmd) => /help|guide|url|open/i.test(cmd))).toEqual(["open_help", "open_help"]);
});

test("a_browser_that_cannot_start_is_said_in_fixed_words", async () => {
  await unlocked([{ id: 7, name: "My vault", items: [] }]);
  shell.helpFailsNext();
  fireEvent.click(within(emptyCard()).getByRole("button", { name: "Help" }));
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain(HELP_NOT_OPENED);
  // Nothing of the shell's answer, and no address, reaches the screen.
  expect(document.body.textContent).not.toMatch(/https?:|github|invalid_input|"code"|\bcore\b|\bio\b/i);
  // Try again, and it opens.
  fireEvent.click(within(emptyCard()).getByRole("button", { name: "Help" }));
  await waitFor(() => {
    expect(shell.helpOpened()).toBe(2);
  });
});

test("help_screens_have_no_axe_violations", async () => {
  const { container } = await unlocked([{ id: 7, name: "My vault", items: [] }]);
  await expectNoAxe(container);
  // With the message that says the browser would not start.
  shell.helpFailsNext();
  fireEvent.click(within(emptyCard()).getByRole("button", { name: "Help" }));
  await screen.findByRole("alert");
  await expectNoAxe(container);
  // Settings, with its Help row.
  const panel = await settings();
  expect(within(panel).getByRole("button", { name: "Help" })).toBeTruthy();
  await expectNoAxe(container);
  // No style element, and no style attribute on what Help adds (the Content Security Policy refuses them; the choice lists' own hidden inputs
  // carry one, which the library sets by script).
  expect(container.querySelectorAll("style")).toHaveLength(0);
  expect(within(panel).getByRole("button", { name: "Help" }).querySelectorAll("[style]")).toHaveLength(0);
  expect(within(panel).getByRole("button", { name: "Help" }).hasAttribute("style")).toBe(false);
});

// ---- Fix round: what a failed Help says, and to whom ----

interface HeldAsk {
  resolve: (answer: unknown) => void;
  reject: (refusal: unknown) => void;
}

/** From now on each `open_help` waits, answered by the test; everything else goes to the pretend shell. The asks held, in order. */
function holdHelp(): HeldAsk[] {
  const real = invoke.getMockImplementation() as (cmd: string, args?: unknown) => Promise<unknown>;
  const held: HeldAsk[] = [];
  invoke.mockImplementation((cmd: string, args?: unknown) => {
    if (cmd !== "open_help") return real(cmd, args);
    return new Promise((resolve, reject) => {
      held.push({ resolve, reject });
    });
  });
  return held;
}

/** Lets what the page does after an answer happen. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

async function openVaultMenu(): Promise<HTMLElement> {
  await settle();
  const opener = screen.getByRole("button", { name: /, vault menu$/ });
  opener.focus();
  fireEvent.pointerDown(opener, { button: 0 });
  fireEvent.click(opener);
  return screen.findByRole("menu");
}

/** A locked vault of the menu chosen, its password typed, and the vault open and on screen. */
async function unlockFromMenu(name: string): Promise<void> {
  const menu = await openVaultMenu();
  const row = within(menu)
    .getAllByRole("menuitemradio")
    .find((one) => rowReads(one, name, "Locked"));
  if (row === undefined) throw new Error(`no locked row for ${name}`);
  fireEvent.click(row);
  await waitFor(() => {
    expect(screen.queryByRole("menu")).toBeNull();
  });
  await screen.findByRole("heading", { level: 1, name: `Unlock ${name}` });
  const field = screen.getByLabelText<HTMLInputElement>(/^Password for /);
  fireEvent.change(field, { target: { value: PASSWORD } });
  fireEvent.submit(field.form as HTMLFormElement);
  await screen.findByRole("button", { name: `${name}, vault menu` });
}

test("a_browser_that_cannot_start_is_said_through_the_table_with_helps_own_words", async () => {
  await unlocked([{ id: 7, name: "My vault", items: [] }]);
  // The words come from the table's entry for this refusal (the launcher's I/O error), not from a sentence the page keeps for itself.
  expect(messageText(messageFor(BROWSER_REFUSAL))).toBe(HELP_NOT_OPENED);
  expect(messageText(messageFor({ code: "core", kind: "io" }))).not.toContain("browser");
  const held = holdHelp();
  fireEvent.click(within(emptyCard()).getByRole("button", { name: "Help" }));
  await waitFor(() => {
    expect(held).toHaveLength(1);
  });
  await act(async () => {
    held[0]?.reject(BROWSER_REFUSAL);
    await Promise.resolve();
  });
  expect((await screen.findByRole("alert")).textContent).toContain(HELP_NOT_OPENED);
});

test("a_refusal_that_is_not_the_browsers_does_not_send_the_person_to_their_browser", async () => {
  await unlocked([{ id: 7, name: "My vault", items: [] }]);
  const held = holdHelp();
  // What else can come back: the bridge refusing the call, the blocking task cancelled, an engine error of another kind, a thing that is no refusal at all.
  const others: unknown[] = [{ code: "cancelled" }, { code: "invalid_input", what: "request" }, { code: "core", kind: "io" }, "boom", null];
  for (const [at, refusal] of others.entries()) {
    fireEvent.click(within(emptyCard()).getByRole("button", { name: "Help" }));
    await waitFor(() => {
      expect(held).toHaveLength(at + 1);
    });
    await act(async () => {
      held[at]?.reject(refusal);
      await Promise.resolve();
    });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent, JSON.stringify(refusal)).toContain(messageText(messageFor(refusal)));
    expect(alert.textContent, JSON.stringify(refusal)).not.toContain("web browser");
  }
});

test("a_late_failure_after_a_lock_says_nothing", async () => {
  await unlocked([{ id: 7, name: "My vault", items: [] }]);
  const held = holdHelp();
  fireEvent.click(within(emptyCard()).getByRole("button", { name: "Help" }));
  await waitFor(() => {
    expect(held).toHaveLength(1);
  });
  const session = debugState().sessions[0]?.session ?? 0;
  act(() => {
    shell.lock(session);
  });
  await waitFor(() => {
    expect(debugState().sessions).toHaveLength(0);
  });
  await act(async () => {
    held[0]?.reject(BROWSER_REFUSAL);
    await Promise.resolve();
  });
  await settle();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(debugState().toast).toBeNull();
});

test("a_late_failure_after_a_switch_does_not_appear_over_the_other_vault", async () => {
  await unlocked([
    { id: 7, name: "My vault", items: [] },
    { id: 8, name: "Home", items: sampleItems() },
  ]);
  const held = holdHelp();
  fireEvent.click(within(emptyCard()).getByRole("button", { name: "Help" }));
  await waitFor(() => {
    expect(held).toHaveLength(1);
  });
  await unlockFromMenu("Home");
  await act(async () => {
    held[0]?.reject(BROWSER_REFUSAL);
    await Promise.resolve();
  });
  await settle();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(debugState().toast).toBeNull();
});

test("an_older_attempt_that_fails_after_a_newer_one_says_nothing", async () => {
  await unlocked([{ id: 7, name: "My vault", items: [] }]);
  const held = holdHelp();
  fireEvent.click(within(emptyCard()).getByRole("button", { name: "Help" }));
  fireEvent.click(within(emptyCard()).getByRole("button", { name: "Help" }));
  await waitFor(() => {
    expect(held).toHaveLength(2);
  });
  // The second one opens the guide; the first then finds no browser: the guide is open, so nothing is said.
  await act(async () => {
    held[1]?.resolve(null);
    await Promise.resolve();
  });
  await act(async () => {
    held[0]?.reject(BROWSER_REFUSAL);
    await Promise.resolve();
  });
  await settle();
  expect(screen.queryByRole("alert")).toBeNull();
});

test("trying_again_takes_away_helps_own_failure", async () => {
  await unlocked([{ id: 7, name: "My vault", items: [] }]);
  shell.helpFailsNext();
  fireEvent.click(within(emptyCard()).getByRole("button", { name: "Help" }));
  await screen.findByRole("alert");
  const held = holdHelp();
  fireEvent.click(within(emptyCard()).getByRole("button", { name: "Help" }));
  await waitFor(() => {
    expect(held).toHaveLength(1);
  });
  // The retry is on its way: the old failure is already gone, and stays gone when the guide opens.
  expect(screen.queryByRole("alert")).toBeNull();
  await act(async () => {
    held[0]?.resolve(null);
    await Promise.resolve();
  });
  await settle();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(debugState().toast).toBeNull();
});

test("a_read_only_empty_vault_keeps_help_but_not_the_instructions", async () => {
  await unlocked([{ id: 7, name: "My vault", items: [], readOnly: true }]);
  const card = emptyCard();
  // Nothing can be added or backed up from a read-only copy, so the card doesn't say to.
  expect(within(card).queryByText(/What to do first/)).toBeNull();
  expect(card.textContent).not.toMatch(/add a login|make a backup/i);
  expect(within(card).getAllByRole("button").map((button) => button.textContent)).toEqual(["Help"]);
  fireEvent.click(within(card).getByRole("button", { name: "Help" }));
  await waitFor(() => {
    expect(shell.helpOpened()).toBe(1);
  });
});

test("the_pretend_shell_refuses_a_null_body_and_counts_no_launch", async () => {
  await unlocked([{ id: 7, name: "My vault", items: [] }]);
  const before = shell.helpOpened();
  // The real command refuses anything but `{}` (the Rust test `open_help_refuses_any_field` sends null too); so does the pretend one.
  await expect(invoke("open_help", null)).rejects.toEqual({ code: "invalid_input", what: "request" });
  await expect(invoke("open_help", { url: "https://example.invalid/" })).rejects.toEqual({ code: "invalid_input", what: "request" });
  expect(shell.helpOpened()).toBe(before);
  await expect(invoke("open_help", {})).resolves.toBeNull();
  expect(shell.helpOpened()).toBe(before + 1);
});
