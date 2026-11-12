// Task 20's screens: Settings (31a, 31b), opened from the side menu and saved at once, Start with Windows, the theme it chooses, and the
// recovery key's words that follow the capture setting.
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import App from "../App";
import { debugState, resetStoreForTests } from "../store";
import { expectNoAxe } from "../testing/axe";
import {
  DEFAULT_SETTINGS,
  installFakeShell,
  PASSWORD,
  sampleItems,
  SHORTCUT_NOT_SET,
  SHORTCUT_TAKEN,
  STARTUP_FAILED,
  type FakeSettings,
  type FakeShell,
  type FakeStartup,
  type FakeVault,
} from "../testing/fakeShell";

const { invoke, listen } = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

let shell: FakeShell;

beforeEach(() => {
  resetStoreForTests();
  invoke.mockReset();
  listen.mockReset();
});

/** Windows' light or dark setting, which a test can change while the page is open (`change` is what the browser sends). */
function windows(initial: "light" | "dark") {
  let dark = initial === "dark";
  const handlers = new Set<() => void>();
  vi.stubGlobal("matchMedia", (query: string) => ({
    get matches() {
      return dark && query === "(prefers-color-scheme: dark)";
    },
    media: query,
    addEventListener: (_event: string, handler: () => void) => handlers.add(handler),
    removeEventListener: (_event: string, handler: () => void) => handlers.delete(handler),
  }));
  return {
    set(next: "light" | "dark") {
      dark = next === "dark";
      for (const handler of handlers) handler();
    },
  };
}

interface Options {
  settings?: Partial<FakeSettings>;
  startup?: FakeStartup;
  readOnly?: boolean;
  vaults?: FakeVault[];
}

/** The app unlocked through its screen, with the shell as `options` has it; Settings is not opened yet. */
async function unlocked(options: Options = {}) {
  shell = installFakeShell(
    invoke,
    listen,
    options.vaults ?? [{ id: 7, name: "My vault", items: sampleItems(), readOnly: options.readOnly }],
    options.settings,
  );
  if (options.startup !== undefined) shell.setStartup(options.startup);
  const view = render(<App />);
  const field = await screen.findByLabelText(/^Password for /);
  fireEvent.change(field, { target: { value: PASSWORD } });
  fireEvent.submit((field as HTMLInputElement).form as HTMLFormElement);
  // A vault whose recovery key was never typed back goes to that step, not to its list.
  if (options.vaults?.some((vault) => vault.unconfirmed === true) !== true) await screen.findByRole("heading", { level: 1, name: "All items" });
  return view;
}

function side(): HTMLElement {
  return screen.getByRole("navigation", { name: "Vault and folders" });
}

/** Settings opened from the side menu, and its Start with Windows row read. */
async function opened(options: Options = {}) {
  const view = await unlocked(options);
  fireEvent.click(within(side()).getByRole("button", { name: "Settings" }));
  const panel = await screen.findByRole("complementary", { name: "Settings" });
  await within(panel).findByRole("switch", { name: "Start with Windows" });
  return { ...view, panel };
}

function commands(name: string): unknown[] {
  return (invoke.mock.calls as [string, unknown][]).filter(([cmd]) => cmd === name).map(([, args]) => args);
}

const OPEN_LIST = ".layer:not([hidden]) [role=listbox]";

/** Opens a list in the panel and picks `label` with a click, as a person would. */
async function pick(name: string, label: string) {
  const trigger = screen.getByRole("combobox", { name });
  fireEvent.pointerDown(trigger, { button: 0 });
  fireEvent.click(trigger);
  const option = await vi.waitFor(() => {
    const found = [...document.querySelectorAll<HTMLElement>(`${OPEN_LIST} [role=option]`)].find((entry) => entry.textContent === label);
    if (found === undefined) throw new Error(`no option ${label}`);
    return found;
  });
  fireEvent.pointerDown(option);
  fireEvent.click(option);
  await vi.waitFor(() => {
    expect(document.querySelector(OPEN_LIST)).toBeNull();
  });
}

/** The words of the options a list holds, in order. */
async function optionsOf(name: string): Promise<string[]> {
  const trigger = screen.getByRole("combobox", { name });
  fireEvent.pointerDown(trigger, { button: 0 });
  fireEvent.click(trigger);
  const list = await vi.waitFor(() => {
    const found = document.querySelector<HTMLElement>(OPEN_LIST);
    if (found === null) throw new Error("no list");
    return found;
  });
  const words = [...list.querySelectorAll("[role=option]")].map((option) => option.textContent);
  fireEvent.keyDown(list, { key: "Escape" });
  await vi.waitFor(() => {
    expect(document.querySelector(OPEN_LIST)).toBeNull();
  });
  return words;
}

function root(container: HTMLElement): HTMLElement {
  const found = container.querySelector<HTMLElement>(".app");
  if (found === null) throw new Error("no app");
  return found;
}

/** A key press on the shortcut's box while it listens, as the browser sends it. */
function press(code: string, key: string, modifiers: { ctrl?: boolean; shift?: boolean; alt?: boolean } = {}): boolean {
  const target = screen.getByLabelText("Save shortcut, press the new keys");
  return fireEvent.keyDown(target, { code, key, ctrlKey: modifiers.ctrl ?? false, shiftKey: modifiers.shift ?? false, altKey: modifiers.alt ?? false });
}

function startListening(): void {
  fireEvent.click(screen.getByRole("button", { name: "Change" }));
}

const WORDS_SHORTCUT = "Use at least two of Ctrl, Shift and Alt, with a letter, a digit or F1 to F12. Ctrl with C, V or X is kept for copy and paste.";

test("changes_apply_at_once", async () => {
  const { container } = await opened();
  // Nothing was saved by opening the page: the settings were only read.
  expect(commands("set_settings")).toEqual([]);

  // Each change is one save of the whole settings, the others as they were, sent at once with no Save button to press.
  await pick("Lock after idle", "15 minutes");
  await vi.waitFor(() => {
    expect(commands("set_settings")).toEqual([{ ...DEFAULT_SETTINGS, idle_minutes: 15 }]);
  });
  await pick("Clear clipboard after", "90 seconds");
  await vi.waitFor(() => {
    expect(commands("set_settings")).toHaveLength(2);
  });
  fireEvent.click(screen.getByRole("switch", { name: "Keep out of screen capture" }));
  await vi.waitFor(() => {
    expect(commands("set_settings")).toHaveLength(3);
  });
  fireEvent.click(screen.getByRole("button", { name: "Dark" }));
  await vi.waitFor(() => {
    expect(commands("set_settings")).toHaveLength(4);
  });
  expect(commands("set_settings")).toEqual([
    { ...DEFAULT_SETTINGS, idle_minutes: 15 },
    { ...DEFAULT_SETTINGS, idle_minutes: 15, clipboard_seconds: 90 },
    { ...DEFAULT_SETTINGS, idle_minutes: 15, clipboard_seconds: 90, capture_protected: false },
    { ...DEFAULT_SETTINGS, idle_minutes: 15, clipboard_seconds: 90, capture_protected: false, theme: "dark" },
  ]);
  expect(shell.settings()).toEqual({ ...DEFAULT_SETTINGS, idle_minutes: 15, clipboard_seconds: 90, capture_protected: false, theme: "dark" });
  // The page's copy follows each save: the next screen to read it (the recovery key's words, a copy's clear time) sees the new value.
  expect(debugState().settings).toEqual(shell.settings());
  // The controls say what was saved.
  expect(screen.getByRole("combobox", { name: "Lock after idle" }).textContent).toContain("15 minutes");
  expect(screen.getByRole("combobox", { name: "Clear clipboard after" }).textContent).toContain("90 seconds");
  expect(screen.getByRole<HTMLInputElement>("switch", { name: "Keep out of screen capture" }).checked).toBe(false);
  expect(screen.getByRole("button", { name: "Dark" }).getAttribute("aria-pressed")).toBe("true");
  expect(screen.queryByRole("alert")).toBeNull();
  await expectNoAxe(container);
});

test("the_lists_hold_the_sessions_choices_and_say_them_in_words", async () => {
  await opened();
  expect(await optionsOf("Lock after idle")).toEqual(["1 minute", "2 minutes", "5 minutes", "10 minutes", "15 minutes", "30 minutes", "60 minutes"]);
  expect(await optionsOf("Clear clipboard after")).toEqual(["10 seconds", "20 seconds", "30 seconds", "60 seconds", "90 seconds", "120 seconds", "300 seconds"]);
  // As drawn (31a): a filled list in its row with a down arrow, not the toolbar's outlined list with an up-down mark.
  for (const name of ["Lock after idle", "Clear clipboard after"]) {
    const list = screen.getByRole("combobox", { name });
    expect(list.classList.contains("sfill"), name).toBe(true);
    expect(list.querySelector("svg.chev-down"), name).not.toBeNull();
  }
  expect(screen.getByRole("combobox", { name: "Lock after idle" }).textContent).toContain("5 minutes");
  expect(screen.getByRole("combobox", { name: "Clear clipboard after" }).textContent).toContain("30 seconds");
});

test("a_saved_value_outside_the_lists_is_still_shown_and_offered", async () => {
  // The shell takes any whole number inside its bounds, so a settings file can hold one the lists do not.
  await opened({ settings: { idle_minutes: 7, clipboard_seconds: 45 } });
  expect(screen.getByRole("combobox", { name: "Lock after idle" }).textContent).toContain("7 minutes");
  expect(screen.getByRole("combobox", { name: "Clear clipboard after" }).textContent).toContain("45 seconds");
  expect(await optionsOf("Lock after idle")).toEqual(["1 minute", "2 minutes", "5 minutes", "7 minutes", "10 minutes", "15 minutes", "30 minutes", "60 minutes"]);
  expect(commands("set_settings")).toEqual([]);
});

test("a_refused_save_puts_the_control_back_to_the_saved_value", async () => {
  const { container } = await opened();
  // The list: the shell refuses the idle time; the box goes back to what is saved, and the refusal is said in the general words.
  shell.refuseNext("set_settings", { code: "invalid_input", what: "idle time" });
  await pick("Lock after idle", "15 minutes");
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toBe("Lockbox can't use that. Check what you entered and try again.");
  expect(screen.getByRole("combobox", { name: "Lock after idle" }).textContent).toContain("5 minutes");
  expect(shell.settings().idle_minutes).toBe(5);
  expect(debugState().settings?.idle_minutes).toBe(5);

  // The toggle goes back too, and the theme's choice stays where it was and the screen does not change.
  shell.refuseNext("set_settings", { code: "core", kind: "io" });
  fireEvent.click(screen.getByRole("switch", { name: "Keep out of screen capture" }));
  await vi.waitFor(() => {
    expect(screen.getAllByRole("alert").map((line) => line.textContent)).toContain(
      "Lockbox couldn't reach that folder or file. Check that the drive is connected, then try again.",
    );
  });
  expect(screen.getByRole<HTMLInputElement>("switch", { name: "Keep out of screen capture" }).checked).toBe(true);

  shell.refuseNext("set_settings", { code: "invalid_input", what: "request" });
  fireEvent.click(screen.getByRole("button", { name: "Dark" }));
  await vi.waitFor(() => {
    expect(commands("set_settings")).toHaveLength(3);
  });
  await vi.waitFor(() => {
    expect(screen.getByRole("button", { name: "System" }).getAttribute("aria-pressed")).toBe("true");
  });
  expect(screen.getByRole("button", { name: "Dark" }).getAttribute("aria-pressed")).toBe("false");
  expect(root(container).classList.contains("mode-dark")).toBe(false);
  expect(shell.settingsSaved).toEqual([]);

  // Each row keeps its own refusal: three rows were refused, so three lines are up.
  expect(screen.getAllByRole("alert")).toHaveLength(3);

  // A change that is then saved clears the refusal of its own row, and only that one.
  await pick("Lock after idle", "10 minutes");
  await vi.waitFor(() => {
    expect(shell.settings().idle_minutes).toBe(10);
  });
  await vi.waitFor(() => {
    expect(screen.getAllByRole("alert")).toHaveLength(2);
  });
});

test("a_refusal_stays_until_its_own_row_is_saved", async () => {
  await opened();
  // The capture protection is refused: a security setting that was not applied.
  shell.refuseNext("set_settings", { code: "core", kind: "io" });
  fireEvent.click(screen.getByRole("switch", { name: "Keep out of screen capture" }));
  await screen.findByRole("alert");
  // An unrelated change that works does not take the notice away.
  fireEvent.click(screen.getByRole("button", { name: "Dark" }));
  await vi.waitFor(() => {
    expect(shell.settings().theme).toBe("dark");
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(screen.getAllByRole("alert")).toHaveLength(1);
  const row = screen.getByRole("switch", { name: "Keep out of screen capture" }).closest(".srow") as HTMLElement;
  expect(within(row).getByRole("alert")).toBeTruthy();
  // Trying that row again and saving it clears it.
  fireEvent.click(screen.getByRole("switch", { name: "Keep out of screen capture" }));
  await vi.waitFor(() => {
    expect(shell.settings().capture_protected).toBe(false);
  });
  await vi.waitFor(() => {
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

test("cancelling_a_shortcut_that_waits_behind_a_save_sends_nothing", async () => {
  await opened();
  const release = shell.holdSettings();
  fireEvent.click(screen.getByRole("button", { name: "Dark" }));
  await vi.waitFor(() => {
    expect(commands("set_settings")).toHaveLength(1);
  });
  // The new shortcut is chosen while that save is not answered: it waits in line. Cancel takes it out of the line.
  startListening();
  press("KeyK", "k", { ctrl: true, alt: true });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(commands("set_settings")).toHaveLength(1);
  // Still in line, so Cancel can take it back, and says nothing of being off.
  expect(screen.getByRole("button", { name: "Cancel" }).getAttribute("aria-disabled")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.getByRole("button", { name: "Change" })).toBeTruthy();
  release();
  await vi.waitFor(() => {
    expect(shell.settings().theme).toBe("dark");
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  // The old shortcut is the one in use: the cancelled one was never sent.
  expect(commands("set_settings")).toHaveLength(1);
  expect(shell.settings().shortcut).toEqual(DEFAULT_SETTINGS.shortcut);
  expect(screen.getByText("Ctrl+Shift+L", { selector: "kbd" })).toBeTruthy();
});

test("escape_and_cancel_wait_for_a_shortcut_already_sent", async () => {
  await opened();
  const release = shell.holdSettings();
  startListening();
  press("KeyK", "k", { ctrl: true, alt: true });
  await vi.waitFor(() => {
    expect(commands("set_settings")).toHaveLength(1);
  });
  // Sent: the shell has it, so it cannot be called back from here. The wait goes on until the answer, and Cancel says it is off
  // (to a screen reader too) rather than doing nothing when pressed (Task 21).
  const cancel = await screen.findByRole("button", { name: "Cancel" });
  await vi.waitFor(() => {
    expect(cancel.getAttribute("aria-disabled")).toBe("true");
  });
  press("Escape", "Escape");
  fireEvent.click(cancel);
  expect(screen.getByRole("button", { name: "Cancel" })).toBe(cancel);
  release();
  await screen.findByRole("button", { name: "Change" });
  expect(screen.getByText("Ctrl+Alt+K", { selector: "kbd" })).toBeTruthy();
  expect(shell.settings().shortcut.key).toBe(75);
});

test("listening_says_what_to_do_if_nothing_happens", async () => {
  const { container } = await opened();
  expect(screen.queryByText(/If nothing happens/)).toBeNull();
  startListening();
  // Windows keeps a combination another app holds from reaching the page, so the page can only say what silence means.
  const hint = screen.getByText("If nothing happens, another app is using those keys. Try a different combination.");
  expect(hint.getAttribute("role")).toBe("status");
  await expectNoAxe(container);
  press("Escape", "Escape");
  expect(screen.queryByText(/If nothing happens/)).toBeNull();
});

test("a_key_that_makes_no_letter_is_refused_not_guessed", async () => {
  await opened();
  startListening();
  // Dvorak: the key at Q's place makes an apostrophe. A US key code would register Q, a key the person did not press; so it is refused.
  press("KeyQ", "'", { ctrl: true, alt: true });
  expect(screen.getByRole("alert").textContent).toBe(WORDS_SHORTCUT);
  press("KeyE", "€", { ctrl: true, alt: true });
  expect(screen.getByRole("alert").textContent).toBe(WORDS_SHORTCUT);
  expect(commands("set_settings")).toEqual([]);
});

test("a_letter_is_the_letter_its_key_makes_wherever_that_key_sits", async () => {
  await opened();
  startListening();
  // French AZERTY: M sits where a US keyboard has the semicolon. Windows names that key M (77), so Ctrl+Alt+M is what was pressed.
  press("Semicolon", "m", { ctrl: true, alt: true });
  expect(screen.queryByRole("alert")?.textContent ?? "").toBe("");
  expect(screen.getByText("Ctrl+Alt+M", { selector: "kbd" })).toBeTruthy();
});

test("start_with_windows_written_but_not_read_back_shows_the_true_state", async () => {
  const { panel } = await opened();
  // The write went through, and reading it back failed: the shell's one fixed refusal. The page asks again and shows what Windows has.
  shell.startupReadbackFailsNext();
  fireEvent.click(within(panel).getByRole("switch", { name: "Start with Windows" }));
  await vi.waitFor(() => {
    expect(commands("get_startup")).toHaveLength(2);
  });
  await vi.waitFor(() => {
    expect(within(panel).getByRole<HTMLInputElement>("switch", { name: "Start with Windows" }).checked).toBe(true);
  });
  expect(shell.startup().on).toBe(true);
  // It is on, as asked, so there is nothing to refuse.
  expect(within(panel).queryByRole("alert")).toBeNull();
});

test("start_with_windows_that_cannot_be_read_back_says_it_does_not_know", async () => {
  const { panel } = await opened({ startup: { on: true, turned_off_in_windows: false } });
  shell.startupReadbackFailsNext();
  // The write is refused, and so is the second read: the page cannot say which it is, so it says so and shows nothing as the state.
  const real = invoke.getMockImplementation();
  if (real === undefined) throw new Error("no fake shell");
  let reads = 0;
  invoke.mockImplementation((cmd: string, args?: unknown) => {
    if (cmd === "get_startup") {
      reads += 1;
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- Tauri rejects with the plain object
      if (reads >= 1) return Promise.reject(STARTUP_FAILED);
    }
    return real(cmd, args) as Promise<unknown>;
  });
  fireEvent.click(within(panel).getByRole("switch", { name: "Start with Windows" }));
  const alert = await within(panel).findByRole("alert");
  expect(alert.textContent).toBe("Lockbox couldn't change Start with Windows. Try again.");
  expect(within(panel).getByText("Lockbox can't tell right now whether it starts with Windows.")).toBeTruthy();
  expect(within(panel).queryByText("Starts locked, by the clock.")).toBeNull();
  // It is not shown as the old state or as the one asked for, and it can be pressed again.
  expect(within(panel).getByRole<HTMLInputElement>("switch", { name: "Start with Windows" }).checked).toBe(false);
  expect(within(panel).getByRole("switch", { name: "Start with Windows" }).getAttribute("aria-disabled")).toBeNull();
});

test("a_launch_shortcut_notice_goes_when_a_new_shortcut_is_saved", async () => {
  shell = installFakeShell(invoke, listen, [{ id: 7, name: "My vault", items: sampleItems() }]);
  shell.setLaunchNotices([{ kind: "shortcut_taken" }]);
  render(<App />);
  const words = /is used by another app, so the save shortcut is off\./;
  await screen.findByText(words);
  const field = await screen.findByLabelText(/^Password for /);
  fireEvent.change(field, { target: { value: PASSWORD } });
  fireEvent.submit((field as HTMLInputElement).form as HTMLFormElement);
  await screen.findByRole("heading", { level: 1, name: "All items" });
  fireEvent.click(within(side()).getByRole("button", { name: "Settings" }));
  await screen.findByRole("complementary", { name: "Settings" });
  startListening();
  press("KeyK", "k", { ctrl: true, alt: true });
  await screen.findByRole("button", { name: "Change" });
  // The new one works, so the warning about the old one is wrong and goes; it does not come back when the shell sends it again.
  expect(screen.queryByText(words)).toBeNull();
  act(() => {
    shell.tell({ kind: "shortcut_taken" });
  });
  expect(screen.queryByText(words)).toBeNull();
});

test("saves_are_sent_one_after_another_each_built_from_what_is_saved", async () => {
  await opened();
  const release = shell.holdSettings();
  fireEvent.click(screen.getByRole("button", { name: "Dark" }));
  await vi.waitFor(() => {
    expect(commands("set_settings")).toHaveLength(1);
  });
  // A second change while the first is not answered: it waits, so an older answer can never land over a newer save.
  fireEvent.click(screen.getByRole("switch", { name: "Keep out of screen capture" }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(commands("set_settings")).toHaveLength(1);
  // Both controls already show what was chosen.
  expect(screen.getByRole("button", { name: "Dark" }).getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByRole<HTMLInputElement>("switch", { name: "Keep out of screen capture" }).checked).toBe(false);
  release();
  await vi.waitFor(() => {
    expect(commands("set_settings")).toHaveLength(2);
  });
  // The second is the whole settings with the first's change in it.
  expect(commands("set_settings")[1]).toEqual({ ...DEFAULT_SETTINGS, theme: "dark", capture_protected: false });
  await vi.waitFor(() => {
    expect(shell.settings()).toEqual({ ...DEFAULT_SETTINGS, theme: "dark", capture_protected: false });
  });
  expect(screen.queryByRole("alert")).toBeNull();
});

test("a_refused_save_does_not_spoil_the_one_waiting_behind_it", async () => {
  await opened();
  shell.refuseNext("set_settings", { code: "invalid_input", what: "idle time" });
  await pick("Lock after idle", "15 minutes");
  await screen.findByRole("alert");
  // The next change is built from what is saved, not from the refused one: the idle time is still 5.
  fireEvent.click(screen.getByRole("switch", { name: "Keep out of screen capture" }));
  await vi.waitFor(() => {
    expect(shell.settings()).toEqual({ ...DEFAULT_SETTINGS, capture_protected: false });
  });
});

test("theme_switches_without_reload", async () => {
  const system = windows("light");
  const { container } = await opened();
  const app = root(container);
  expect(app.classList.contains("mode-light")).toBe(true);
  const theme = screen.getByRole("group", { name: "Theme" });
  // Light, Dark and System, one pressed: System, by default.
  expect(within(theme).getAllByRole("button").map((button) => [button.textContent, button.getAttribute("aria-pressed")])).toEqual([
    ["Light", "false"],
    ["Dark", "false"],
    ["System", "true"],
  ]);

  fireEvent.click(within(theme).getByRole("button", { name: "Dark" }));
  await vi.waitFor(() => {
    expect(app.classList.contains("mode-dark")).toBe(true);
  });
  expect(app.classList.contains("mode-light")).toBe(false);
  expect(within(theme).getByRole("button", { name: "Dark" }).getAttribute("aria-pressed")).toBe("true");
  expect(within(theme).getByRole("button", { name: "System" }).getAttribute("aria-pressed")).toBe("false");
  // The same page: nothing reloaded, the same root element, Settings still open.
  expect(root(container)).toBe(app);
  expect(screen.getByRole("complementary", { name: "Settings" })).toBeTruthy();

  // Windows' own setting is heard only for System.
  act(() => {
    system.set("dark");
  });
  fireEvent.click(within(theme).getByRole("button", { name: "Light" }));
  await vi.waitFor(() => {
    expect(app.classList.contains("mode-light")).toBe(true);
  });
  act(() => {
    system.set("light");
    system.set("dark");
  });
  expect(app.classList.contains("mode-light")).toBe(true);
  fireEvent.click(within(theme).getByRole("button", { name: "System" }));
  await vi.waitFor(() => {
    expect(app.classList.contains("mode-dark")).toBe(true);
  });
  act(() => {
    system.set("light");
  });
  expect(app.classList.contains("mode-light")).toBe(true);
  expect(commands("set_settings").map((sent) => (sent as FakeSettings).theme)).toEqual(["dark", "light", "system"]);
});

test("the_saved_theme_is_used_from_the_start_and_windows_only_for_system", async () => {
  windows("light");
  const dark = await opened({ settings: { theme: "dark" } });
  expect(root(dark.container).classList.contains("mode-dark")).toBe(true);
  cleanup();
  resetStoreForTests();

  windows("dark");
  const light = await opened({ settings: { theme: "light" } });
  expect(root(light.container).classList.contains("mode-light")).toBe(true);
  cleanup();
  resetStoreForTests();

  const system = await opened({ settings: { theme: "system" } });
  expect(root(system.container).classList.contains("mode-dark")).toBe(true);
});

test("a_settings_file_that_cannot_be_read_leaves_the_screen_following_windows", async () => {
  windows("dark");
  shell = installFakeShell(invoke, listen, [{ id: 7, name: "My vault", items: sampleItems() }]);
  shell.refuseNext("get_settings", { code: "core", kind: "io" });
  const { container } = render(<App />);
  await screen.findByRole("heading", { level: 1, name: "Unlock My vault" });
  expect(root(container).classList.contains("mode-dark")).toBe(true);
  expect(screen.queryByRole("alert")).toBeNull();
});

test("settings_opens_from_the_side_menu_and_focus_comes_back_to_its_button", async () => {
  await unlocked();
  const buttons = within(side()).getAllByRole("button");
  const names = buttons.map((button) => button.getAttribute("aria-label") ?? button.textContent);
  // In the foot's own row, before Lock all.
  const foot = document.querySelector(".rbtns");
  expect([...(foot?.querySelectorAll("button") ?? [])].map((button) => button.textContent)).toEqual(["Settings", "Lock all"]);
  expect(names).toContain("Settings");

  const button = within(side()).getByRole("button", { name: "Settings" });
  button.focus();
  fireEvent.click(button);
  const panel = await screen.findByRole("complementary", { name: "Settings" });
  expect(within(panel).getByRole("heading", { level: 2, name: "Settings" })).toBeTruthy();
  fireEvent.click(within(panel).getByRole("button", { name: "Close panel" }));
  expect(screen.queryByRole("complementary", { name: "Settings" })).toBeNull();
  await vi.waitFor(() => {
    expect(document.activeElement).toBe(within(side()).getByRole("button", { name: "Settings" }));
  });
});

test("a_read_only_vault_can_open_settings_and_change_them", async () => {
  await opened({ readOnly: true });
  expect(screen.getByText("Read-only", { selector: ".chip" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Dark" }));
  await vi.waitFor(() => {
    expect(shell.settings().theme).toBe("dark");
  });
});

test("says_which_vault", async () => {
  const { panel, container } = await opened();
  // 4A's settings are all for the app, so the panel says so, and has no section for the open vault.
  expect(within(panel).getByText("For every vault on this PC.")).toBeTruthy();
  expect(within(panel).queryByRole("heading", { name: "My vault" })).toBeNull();
  // The sections as drawn, in order.
  expect(within(panel).getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent)).toEqual([
    "Appearance",
    "Locking and clipboard",
    "Saving what you copied",
    "This PC",
    "About",
  ]);
  // The words of each row, as drawn.
  // (The two lists are named for a screen reader as well as written, so their words are found twice.)
  for (const words of ["Lock after idle", "Clear clipboard after"]) expect(within(panel).getAllByText(words), words).toHaveLength(2);
  for (const words of [
    "Theme",
    "Save shortcut",
    "Works while Lockbox is by the clock.",
    "Start with Windows",
    "Starts locked, by the clock.",
    "Keep out of screen capture",
    "Screenshots, recordings and screen sharing show Lockbox blank. Windows doesn't guarantee this.",
  ]) {
    expect(within(panel).getByText(words), words).toBeTruthy();
  }
  // Nothing in the panel's markup is styled by the page itself, apart from the select part's own hidden input.
  expect(
    [...container.querySelectorAll("[style]")].filter(
      (element) => element.closest("[data-base-ui-portal]") === null && !element.matches("input[aria-hidden='true'][id^='base-ui-']"),
    ),
  ).toEqual([]);
  expect(container.querySelectorAll("style")).toHaveLength(0);
  await expectNoAxe(container);
});

test("shows_the_version", async () => {
  const { panel } = await opened();
  const about = within(panel).getByRole("heading", { level: 3, name: "About" }).closest("section");
  expect(about).not.toBeNull();
  expect(await within(about as HTMLElement).findByText("Version 1.2.3")).toBeTruthy();
  expect(within(about as HTMLElement).getByText("Lockbox")).toBeTruthy();
  expect(commands("app_info")).toEqual([{}]);
});

test("no_backup_or_password_links_until_their_plans", async () => {
  const { panel } = await opened();
  for (const name of [
    /back up/i,
    /test a backup/i,
    /restore/i,
    /older copies/i,
    /open a backup/i,
    /export/i,
    /change password/i,
    /recovery key/i,
  ]) {
    expect(within(panel).queryByRole("button", { name }), String(name)).toBeNull();
    expect(within(panel).queryByRole("link", { name }), String(name)).toBeNull();
  }
  // Only the controls of this plan's settings are in the panel.
  expect(within(panel).getAllByRole("button").map((button) => button.getAttribute("aria-label") ?? button.textContent)).toEqual([
    "Close panel",
    "Light",
    "Dark",
    "System",
    "Change",
  ]);
});

test("help_link_hidden_until_the_address_exists", async () => {
  const { panel } = await opened();
  expect(within(panel).queryByRole("link")).toBeNull();
  expect(within(panel).queryByText(/help/i)).toBeNull();
  expect(within(panel).queryByRole("button", { name: /help/i })).toBeNull();
  expect(commands("open_url")).toEqual([]);
});

test("shows_the_saved_shortcut_and_changing_it_listens_for_the_next_keys", async () => {
  const { panel } = await opened();
  const row = within(panel).getByText("Save shortcut").closest(".srow") as HTMLElement;
  expect(within(row).getByText("Ctrl+Shift+L", { selector: "kbd" })).toBeTruthy();
  startListening();
  // The box says what to do, the pill becomes Cancel, and focus is on the box for the keys.
  const keycap = screen.getByLabelText("Save shortcut, press the new keys");
  expect(keycap.textContent).toBe("Press the new keys");
  expect(document.activeElement).toBe(keycap);
  expect(screen.queryByRole("button", { name: "Change" })).toBeNull();
  expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  // A modifier on its own is not a choice: still waiting, nothing said, nothing sent.
  for (const [code, key] of [["ControlLeft", "Control"], ["ShiftLeft", "Shift"], ["AltLeft", "Alt"]]) {
    expect(press(code ?? "", key ?? "", { ctrl: true, shift: true, alt: true })).toBe(true);
  }
  expect(screen.queryByRole("alert")).toBeNull();
  expect(commands("set_settings")).toEqual([]);
  expect(screen.getByLabelText("Save shortcut, press the new keys").textContent).toBe("Press the new keys");
});

test("a_new_shortcut_is_taken_shown_and_saved_with_the_whole_settings", async () => {
  await opened();
  startListening();
  // The key press is the browser's own: Ctrl+Alt+K is not given to the page's other handlers (it is not a shortcut of the page's).
  expect(press("KeyK", "k", { ctrl: true, alt: true })).toBe(false);
  await vi.waitFor(() => {
    expect(commands("set_settings")).toEqual([{ ...DEFAULT_SETTINGS, shortcut: { ctrl: true, shift: false, alt: true, key: 75 } }]);
  });
  // Saved: shown, the pill is Change again, and the page's own copy has it.
  await vi.waitFor(() => {
    expect(screen.getByText("Ctrl+Alt+K", { selector: "kbd" })).toBeTruthy();
  });
  expect(screen.getByRole("button", { name: "Change" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  expect(debugState().settings?.shortcut).toEqual({ ctrl: true, shift: false, alt: true, key: 75 });
  expect(shell.settings().shortcut).toEqual({ ctrl: true, shift: false, alt: true, key: 75 });
  // Focus is back on the pill that started it.
  await vi.waitFor(() => {
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Change" }));
  });

  // A digit and a function key are keys too, and all three modifiers are named in order.
  startListening();
  press("Digit5", "%", { ctrl: true, shift: true, alt: true });
  await vi.waitFor(() => {
    expect(shell.settings().shortcut.key).toBe(53);
    expect(screen.getByRole("button", { name: "Change" })).toBeTruthy();
  });
  expect(screen.getByText("Ctrl+Shift+Alt+5", { selector: "kbd" })).toBeTruthy();
  startListening();
  press("F5", "F5", { shift: true, alt: true });
  await vi.waitFor(() => {
    expect(shell.settings().shortcut.key).toBe(116);
    expect(screen.getByRole("button", { name: "Change" })).toBeTruthy();
  });
  expect(screen.getByText("Shift+Alt+F5", { selector: "kbd" })).toBeTruthy();
  expect(commands("set_settings").map((sent) => (sent as FakeSettings).shortcut.key)).toEqual([75, 53, 116]);
});

test("a_letter_is_the_one_the_key_makes_in_the_persons_layout", async () => {
  await opened();
  // A French keyboard: the key marked A is where Q is on a US one, and Windows names it A. Ctrl+Alt+A is taken, not Ctrl+Alt+Q.
  startListening();
  press("KeyQ", "a", { ctrl: true, alt: true });
  await vi.waitFor(() => {
    expect(shell.settings().shortcut).toEqual({ ctrl: true, shift: false, alt: true, key: 65 });
  });
  await screen.findByRole("button", { name: "Change" });
  expect(screen.getByText("Ctrl+Alt+A", { selector: "kbd" })).toBeTruthy();
});

test("escape_cancels_the_change_and_keeps_the_saved_shortcut", async () => {
  await opened();
  startListening();
  // Escape is the way out, and it is not taken as a key.
  press("Escape", "Escape");
  expect(screen.queryByLabelText("Save shortcut, press the new keys")).toBeNull();
  expect(screen.getByText("Ctrl+Shift+L", { selector: "kbd" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Change" })).toBeTruthy();
  expect(commands("set_settings")).toEqual([]);
  await vi.waitFor(() => {
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Change" }));
  });
  // Escape also leaves the panel alone: it is still open.
  expect(screen.getByRole("complementary", { name: "Settings" })).toBeTruthy();

  // The Cancel pill does the same, and takes a refusal that was showing with it.
  startListening();
  press("KeyK", "k", { ctrl: true });
  expect(screen.getByRole("alert")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByText("Ctrl+Shift+L", { selector: "kbd" })).toBeTruthy();
  expect(commands("set_settings")).toEqual([]);
});

test("fewer_than_two_modifiers_is_refused_in_words_without_a_call", async () => {
  const { container } = await opened();
  startListening();
  for (const modifiers of [{}, { ctrl: true }, { shift: true }, { alt: true }]) {
    press("KeyK", "k", modifiers);
    expect(screen.getByRole("alert").textContent).toBe(WORDS_SHORTCUT);
  }
  // A key that is not a letter, a digit or F1 to F12 is refused in the same words, with two modifiers too.
  press("Space", " ", { ctrl: true, shift: true });
  expect(screen.getByRole("alert").textContent).toBe(WORDS_SHORTCUT);
  press("ArrowUp", "ArrowUp", { ctrl: true, alt: true });
  press("F13", "F13", { ctrl: true, alt: true });
  expect(screen.getByRole("alert").textContent).toBe(WORDS_SHORTCUT);
  expect(commands("set_settings")).toEqual([]);
  // The page keeps listening, with the saved shortcut still the saved one.
  expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  expect(debugState().settings?.shortcut).toEqual(DEFAULT_SETTINGS.shortcut);
  await expectNoAxe(container);
  // A good one is then taken, and the refusal goes.
  press("KeyK", "k", { ctrl: true, alt: true });
  await vi.waitFor(() => {
    expect(commands("set_settings")).toHaveLength(1);
  });
  await vi.waitFor(() => {
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

test("tab_is_not_swallowed_while_listening", async () => {
  await opened();
  startListening();
  // Tab and Shift+Tab are how a keyboard gets out of the box, so they are no choice and no refusal.
  expect(press("Tab", "Tab")).toBe(true);
  expect(press("Tab", "Tab", { shift: true })).toBe(true);
  expect(screen.queryByRole("alert")).toBeNull();
  expect(commands("set_settings")).toEqual([]);
});

test("moving_away_from_the_box_ends_the_listening", async () => {
  await opened();
  startListening();
  // Onto the Cancel pill is still inside; anywhere else ends it, as Escape does.
  fireEvent.focusOut(screen.getByLabelText("Save shortcut, press the new keys"), { relatedTarget: screen.getByRole("button", { name: "Cancel" }) });
  expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  fireEvent.focusOut(screen.getByLabelText("Save shortcut, press the new keys"), { relatedTarget: document.body });
  expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  expect(screen.getByRole("button", { name: "Change" })).toBeTruthy();
});

test("taken_shortcut_says_so", async () => {
  const { container } = await opened();
  startListening();
  shell.refuseNext("set_settings", SHORTCUT_TAKEN);
  press("KeyS", "s", { ctrl: true, shift: true });
  // 31b: the combination tried, Cancel, and the alert in its own words.
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toBe("Another app already uses Ctrl+Shift+S. Press a different combination.");
  expect(screen.getByText("Ctrl+Shift+S", { selector: "kbd" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  // Nothing was saved and the old shortcut is still the one in use.
  expect(shell.settings().shortcut).toEqual(DEFAULT_SETTINGS.shortcut);
  expect(debugState().settings?.shortcut).toEqual(DEFAULT_SETTINGS.shortcut);
  await expectNoAxe(container);

  // Still listening: the next combination is taken, and the alert goes.
  press("KeyK", "k", { ctrl: true, alt: true });
  await vi.waitFor(() => {
    expect(shell.settings().shortcut).toEqual({ ctrl: true, shift: false, alt: true, key: 75 });
  });
  await vi.waitFor(() => {
    expect(screen.queryByRole("alert")).toBeNull();
  });
  expect(screen.getByText("Ctrl+Alt+K", { selector: "kbd" })).toBeTruthy();
});

test("a_taken_shortcut_is_put_back_when_the_change_is_cancelled", async () => {
  await opened();
  startListening();
  shell.refuseNext("set_settings", SHORTCUT_TAKEN);
  press("KeyS", "s", { ctrl: true, shift: true });
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("alert")).toBeNull();
  // The old shortcut was on screen all along until a new one was saved.
  expect(screen.getByText("Ctrl+Shift+L", { selector: "kbd" })).toBeTruthy();
});

test("shortcut_the_shell_refuses_says_the_rules_and_keeps_listening", async () => {
  await opened();
  startListening();
  // Ctrl with C, V or X is kept for copy and paste: the page sends it and the shell says no, as the shell's check is the one that decides.
  press("KeyC", "c", { ctrl: true, shift: true });
  await vi.waitFor(() => {
    expect(commands("set_settings")).toHaveLength(1);
  });
  expect((await screen.findByRole("alert")).textContent).toBe(WORDS_SHORTCUT);
  expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  expect(shell.settings().shortcut).toEqual(DEFAULT_SETTINGS.shortcut);
});

test("shortcut_not_set_says_windows_did_not_take_it", async () => {
  await opened();
  startListening();
  shell.refuseNext("set_settings", SHORTCUT_NOT_SET);
  press("KeyK", "k", { ctrl: true, alt: true });
  expect((await screen.findByRole("alert")).textContent).toBe("Windows didn't take that shortcut. Try again.");
  expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  expect(shell.settings().shortcut).toEqual(DEFAULT_SETTINGS.shortcut);
  // Trying again is the same keys, and it goes through.
  press("KeyK", "k", { ctrl: true, alt: true });
  await vi.waitFor(() => {
    expect(shell.settings().shortcut.key).toBe(75);
  });
});

test("start_with_windows_can_be_turned_on_and_off", async () => {
  const { panel, container } = await opened();
  expect(commands("get_startup")).toEqual([{}]);
  const toggle = within(panel).getByRole<HTMLInputElement>("switch", { name: "Start with Windows" });
  expect(toggle.checked).toBe(false);
  expect(within(panel).getByText("Starts locked, by the clock.")).toBeTruthy();

  fireEvent.click(toggle);
  await vi.waitFor(() => {
    expect(commands("set_startup")).toEqual([{ on: true }]);
  });
  await vi.waitFor(() => {
    expect(within(panel).getByRole<HTMLInputElement>("switch", { name: "Start with Windows" }).checked).toBe(true);
  });
  expect(shell.startup()).toEqual({ on: true, turned_off_in_windows: false });
  // It is not one of the settings the file keeps: nothing was saved there.
  expect(commands("set_settings")).toEqual([]);

  // The switch shows the choice at once; a press waits until the answer of the one before is in (one change at a time).
  await new Promise((resolve) => setTimeout(resolve, 20));
  fireEvent.click(within(panel).getByRole("switch", { name: "Start with Windows" }));
  await vi.waitFor(() => {
    expect(commands("set_startup")).toEqual([{ on: true }, { on: false }]);
  });
  await vi.waitFor(() => {
    expect(within(panel).getByRole<HTMLInputElement>("switch", { name: "Start with Windows" }).checked).toBe(false);
  });
  expect(screen.queryByRole("alert")).toBeNull();
  await expectNoAxe(container);
});

test("start_with_windows_already_on_is_shown_on", async () => {
  const { panel } = await opened({ startup: { on: true, turned_off_in_windows: false } });
  expect(within(panel).getByRole<HTMLInputElement>("switch", { name: "Start with Windows" }).checked).toBe(true);
  expect(within(panel).getByText("Starts locked, by the clock.")).toBeTruthy();
});

test("start_with_windows_turned_off_in_windows_shows_off_and_says_where_to_turn_it_on", async () => {
  const { panel, container } = await opened({ startup: { on: true, turned_off_in_windows: true } });
  const toggle = within(panel).getByRole<HTMLInputElement>("switch", { name: "Start with Windows" });
  // Off, whatever Lockbox's own entry says, and the hint says whose switch it is.
  expect(toggle.checked).toBe(false);
  expect(
    within(panel).getByText("Turned off in Windows' Startup settings. Turn Lockbox on there to start it with Windows."),
  ).toBeTruthy();
  expect(within(panel).queryByText("Starts locked, by the clock.")).toBeNull();
  // Pressing it changes nothing here: Windows' own switch wins, and a screen reader is told the control is not available.
  expect(toggle.getAttribute("aria-disabled")).toBe("true");
  fireEvent.click(toggle);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(commands("set_startup")).toEqual([]);
  expect(within(panel).getByRole<HTMLInputElement>("switch", { name: "Start with Windows" }).checked).toBe(false);
  await expectNoAxe(container);
});

test("start_with_windows_follows_what_the_shell_reads_back", async () => {
  // The answer of the write is the true state: Windows may have switched it off meanwhile.
  const { panel } = await opened();
  const real = invoke.getMockImplementation();
  if (real === undefined) throw new Error("no fake shell");
  invoke.mockImplementation((cmd: string, args?: unknown) =>
    cmd === "set_startup" ? Promise.resolve({ on: true, turned_off_in_windows: true }) : (real(cmd, args) as Promise<unknown>),
  );
  fireEvent.click(within(panel).getByRole("switch", { name: "Start with Windows" }));
  await vi.waitFor(() => {
    expect(within(panel).getByText(/^Turned off in Windows' Startup settings\./)).toBeTruthy();
  });
  expect(within(panel).getByRole<HTMLInputElement>("switch", { name: "Start with Windows" }).checked).toBe(false);
});

test("start_with_windows_refused_says_so_and_goes_back", async () => {
  const { panel } = await opened();
  shell.refuseNext("set_startup", STARTUP_FAILED);
  fireEvent.click(within(panel).getByRole("switch", { name: "Start with Windows" }));
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toBe("Lockbox couldn't change Start with Windows. Try again.");
  expect(within(panel).getByRole<HTMLInputElement>("switch", { name: "Start with Windows" }).checked).toBe(false);
  // Trying again works, and the refusal goes.
  fireEvent.click(within(panel).getByRole("switch", { name: "Start with Windows" }));
  await vi.waitFor(() => {
    expect(within(panel).getByRole<HTMLInputElement>("switch", { name: "Start with Windows" }).checked).toBe(true);
  });
  expect(screen.queryByRole("alert")).toBeNull();
});

test("start_with_windows_that_cannot_be_read_says_so", async () => {
  await unlocked();
  shell.refuseNext("get_startup", STARTUP_FAILED);
  fireEvent.click(within(side()).getByRole("button", { name: "Settings" }));
  const panel = await screen.findByRole("complementary", { name: "Settings" });
  expect((await within(panel).findByRole("alert")).textContent).toBe("Lockbox couldn't change Start with Windows. Try again.");
  expect(within(panel).getByRole<HTMLInputElement>("switch", { name: "Start with Windows" }).checked).toBe(false);
});

test("recovery_key_words_follow_the_capture_setting", async () => {
  const unfinished: FakeVault[] = [{ id: 7, name: "My vault", items: [], unconfirmed: true }];
  // On (the default): the screen says screenshots won't work, since Lockbox stays out of screen capture.
  await unlocked({ vaults: unfinished });
  await screen.findByRole("heading", { level: 1, name: "Finish your recovery key" });
  expect(screen.getByText(/Screenshots won't work, because Lockbox stays out of screen capture\./)).toBeTruthy();
  expect(screen.queryByText(/readable copy/)).toBeNull();
  cleanup();
  resetStoreForTests();

  // Off: it says a screenshot would be a readable copy, and keeps the rest of the line.
  await unlocked({ vaults: [{ id: 7, name: "My vault", items: [], unconfirmed: true }], settings: { capture_protected: false } });
  await screen.findByRole("heading", { level: 1, name: "Finish your recovery key" });
  expect(screen.getByText(/Don't take a screenshot of it: that would be a readable copy\./)).toBeTruthy();
  expect(screen.getByText(/Don't keep the saved key on this PC\. Writing it down by hand is fine\./)).toBeTruthy();
  expect(screen.queryByText(/Screenshots won't work/)).toBeNull();
});

test("the_pages_copy_of_the_settings_follows_a_save_for_the_recovery_key", async () => {
  await opened();
  expect(debugState().settings?.capture_protected).toBe(true);
  fireEvent.click(screen.getByRole("switch", { name: "Keep out of screen capture" }));
  await vi.waitFor(() => {
    expect(debugState().settings?.capture_protected).toBe(false);
  });
  // The settings were read once, at the start: opening Settings asked for no second copy.
  expect(commands("get_settings")).toEqual([{}]);
});

test("the_save_shortcut_notice_names_the_saved_shortcut", async () => {
  shell = installFakeShell(invoke, listen, [{ id: 7, name: "My vault", items: sampleItems() }], {
    shortcut: { ctrl: true, shift: false, alt: true, key: 75 },
  });
  shell.setLaunchNotices([{ kind: "shortcut_taken" }]);
  render(<App />);
  expect(await screen.findByText(/^Ctrl\+Alt\+K is used by another app, so the save shortcut is off\./)).toBeTruthy();
});
