// Task 9's screens: locking one vault from the vault menu (5a), Lock all, closing the window (5b, the one-time
// explanation) and the lock screen every kind of lock comes back to (5c).
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import App from "../App";
import { resetStoreForTests, unlock } from "../store";
import { expectNoAxe } from "../testing/axe";
import { readBeside } from "../testing/files";
import {
  installFakeShell,
  PASSWORD,
  sampleItems,
  type FakeShell,
  type FakeVault,
} from "../testing/fakeShell";

const { invoke, listen } = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));

afterEach(cleanup);

let shell: FakeShell;

beforeEach(() => {
  // The accessibility check (axe-core) leaves a `<style>` in the document head of its own; each test starts without one,
  // so a style element found later is the page's.
  for (const style of document.querySelectorAll("style")) style.remove();
  resetStoreForTests();
  invoke.mockReset();
  listen.mockReset();
});

const MINE: FakeVault = { id: 7, name: "My vault", items: sampleItems() };
const HOME: FakeVault = { id: 8, name: "Home", items: sampleItems() };

/** A vault's menu row by its name: an open vault's row reads "<name>Unlocked" (its status line, 4C Task 13b), so either way finds it. */
function rowName(name: string | RegExp): string | RegExp | ((read: string) => boolean) {
  if (typeof name !== "string") return name;
  return (read) => read === name || read === `${name}Unlocked`;
}

/** The app on its lock screen with `vaults`, then My vault unlocked through the screen as a person would. */
async function unlocked(vaults: FakeVault[] = [{ ...MINE }, { ...HOME }]) {
  shell = installFakeShell(invoke, listen, vaults);
  const view = render(<App />);
  await unlockOnScreen();
  return view;
}

async function unlockOnScreen() {
  const field = await screen.findByLabelText(/^Password for /);
  fireEvent.change(field, { target: { value: PASSWORD } });
  fireEvent.submit((field as HTMLInputElement).form as HTMLFormElement);
  await screen.findByRole("heading", { level: 1, name: "All items" });
}

/**
 * Opens the vault menu the way a click does, and gives the menu. A real click focuses the button first (jsdom's `click` does not), so focus
 * starts there and not on the page heading an unlock gave it; the menu gives focus back to where it was when it opened.
 */
async function openVaultMenu(vault = "My vault") {
  const opener = screen.getByRole("button", { name: `${vault}, vault menu` });
  opener.focus();
  fireEvent.pointerDown(opener, { button: 0 });
  fireEvent.click(opener);
  return screen.findByRole("menu");
}

const IDLE_WORDS = "Your items stay encrypted until you enter the password.";
const FIRST_CLOSE_TITLE = "Petalock stays by the clock";
const FIRST_CLOSE_FIRST = "Closing the window locks every vault, and Petalock keeps running so the save shortcut works.";
const FIRST_CLOSE_SECOND =
  "To stop it completely, right-click its icon by the clock and choose Quit. This message shows once.";

function nothingOfTheVaultIsOnScreen() {
  const page = document.body.textContent;
  for (const secret of ["Bot admin console", "admin@example.com", "Rotation steps", "Client contract"]) {
    expect(page, secret).not.toContain(secret);
  }
  expect(screen.queryByRole("complementary")).toBeNull();
  expect(screen.queryByRole("menu")).toBeNull();
}

test("lock_this_vault_from_its_menu", async () => {
  const { container } = await unlocked();
  const live = shell.sessionOf(7);
  if (live === undefined) throw new Error("not open");
  const menu = await openVaultMenu();
  // What the menu lets a person do: make a new vault, add an existing vault's folder (Task 7), lock this vault, and rename it (Task 8). Everything drawn on 5a that a later task builds is not shown.
  expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
    "New vault",
    "Add existing vault folder",
    "Lock My vault",
    "Rename My vault",
    "Show My vault in Explorer",
    "Remove My vault from this list",
  ]);
  // Delete a vault waits for a later version (18e); Show in Explorer and Remove from this list are Task 9's, above.
  for (const later of [/delete/i]) {
    expect(within(menu).queryByText(later), String(later)).toBeNull();
  }
  // Each listed vault says whether it is open; the menu's own words say the same to a screen reader.
  // Every vault is one row with its state under its name: an open vault (chosen, and said "checked") says Unlocked, one that is not open says Locked. Each vault appears once.
  expect(within(menu).getByText("Unlocked")).toBeTruthy();
  expect(within(menu).getByRole("menuitemradio", { name: rowName("My vault") }).getAttribute("aria-checked")).toBe("true");
  expect(within(menu).getByText("Locked")).toBeTruthy();
  expect(within(menu).getByRole("menuitemradio", { name: "HomeLocked" }).getAttribute("aria-checked")).toBe("false");
  // No style element: the policy refuses one. (The parts place themselves by script, which is allowed; the markup of
  // the screen's own parts holds no style attribute.)
  expect(document.querySelectorAll("style")).toHaveLength(0);
  expect(container.querySelectorAll(".mline[style], .vsw[style], .dock[style], .dvault[style]")).toHaveLength(0);
  await expectNoAxe(container);

  fireEvent.click(within(menu).getByRole("menuitem", { name: "Lock My vault" }));
  // The lock screen, with the vault locked by the shell's own `lock_vault` for this session and nothing else.
  expect(await screen.findByLabelText(/^Password for /)).toBeTruthy();
  expect(invoke).toHaveBeenCalledWith("lock_vault", { session: live.session });
  expect(invoke.mock.calls.some(([cmd]) => cmd === "lock_all")).toBe(false);
  expect(shell.sessionOf(7)?.unlocked).toBe(false);
  nothingOfTheVaultIsOnScreen();
  expect(screen.queryByRole("alert")).toBeNull();
});

test("the_vault_menu_goes_with_escape_and_gives_focus_back", async () => {
  await unlocked();
  const opener = screen.getByRole("button", { name: "My vault, vault menu" });
  expect(opener.getAttribute("aria-haspopup")).toBe("menu");
  await openVaultMenu();
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
  await waitFor(() => {
    expect(screen.queryByRole("menu")).toBeNull();
  });
  await waitFor(() => {
    expect(document.activeElement).toBe(opener);
  });
  // Nothing was locked by looking.
  expect(invoke.mock.calls.some(([cmd]) => cmd === "lock_vault" || cmd === "lock_all")).toBe(false);
});

test("the_closed_side_menu_still_names_the_vault_button", async () => {
  await unlocked();
  const side = screen.getByRole("navigation", { name: "Vault and folders" });
  fireEvent.click(within(side).getByRole("button", { name: "Close side menu" }));
  expect(within(side).getByRole("button", { name: "My vault, vault menu" })).toBeTruthy();
});

test("lock_all_returns_to_lock_screen", async () => {
  await unlocked();
  // A second vault is open as well (the person unlocked it earlier): both are listed as open.
  await act(async () => {
    expect(await unlock({ list: shell.listIdentity(), id: 8 }, PASSWORD)).toBe("opened");
  });
  // The vault opened last is the one on screen.
  const menu = await openVaultMenu("Home");
  expect(within(menu).queryAllByText("Unlocked")).toHaveLength(2);
  expect(within(menu).getAllByRole("menuitemradio").map((row) => row.textContent)).toEqual(["My vaultUnlocked", "HomeUnlocked"]);
  expect(within(menu).getAllByRole("menuitemradio").map((row) => row.getAttribute("aria-checked"))).toEqual(["false", "true"]);
  fireEvent.keyDown(menu, { key: "Escape" });
  await waitFor(() => {
    expect(screen.queryByRole("menu")).toBeNull();
  });

  fireEvent.click(screen.getByRole("button", { name: "Lock all" }));
  expect(await screen.findByLabelText(/^Password for /)).toBeTruthy();
  expect(screen.getByRole("heading", { level: 1, name: "Unlock a vault" })).toBeTruthy();
  expect(invoke).toHaveBeenCalledWith("lock_all", {});
  expect(shell.sessionOf(7)?.unlocked).toBe(false);
  expect(shell.sessionOf(8)?.unlocked).toBe(false);
  nothingOfTheVaultIsOnScreen();

  // The tray's Lock all is the shell locking every vault itself: the page hears the same events and comes to the same screen.
  await unlockOnScreen();
  await act(async () => {
    await unlock({ list: shell.listIdentity(), id: 8 }, PASSWORD);
  });
  act(() => {
    for (const id of [7, 8]) shell.lock(shell.sessionOf(id)?.session ?? -1);
  });
  expect(await screen.findByLabelText(/^Password for /)).toBeTruthy();
  nothingOfTheVaultIsOnScreen();
});

test("first_close_explains_once", async () => {
  const { container } = await unlocked();
  const panel = document.body.textContent;
  expect(panel).not.toContain(FIRST_CLOSE_TITLE);

  // The close button: every vault is locked, the window stays, and 5b is over the lock screen.
  act(() => {
    shell.closeWindow();
  });
  const dialog = await screen.findByRole("dialog", { name: FIRST_CLOSE_TITLE });
  expect(within(dialog).getByText(FIRST_CLOSE_FIRST)).toBeTruthy();
  expect(within(dialog).getByText(FIRST_CLOSE_SECOND)).toBeTruthy();
  // Its words are its description, so a screen reader reads both paragraphs after the title.
  const described = dialog.getAttribute("aria-describedby");
  expect(described).not.toBeNull();
  expect(document.getElementById(described ?? "")?.textContent).toBe(`${FIRST_CLOSE_FIRST}${FIRST_CLOSE_SECOND}`);
  expect(within(dialog).getAllByRole("button").map((button) => button.textContent)).toEqual(["Got it"]);
  await waitFor(() => {
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Got it" }));
  });
  expect(shell.windowHidden()).toBe(false);
  expect(shell.sessionOf(7)?.unlocked).toBe(false);
  // The lock screen is under it, and nothing of the vault is left anywhere.
  expect(screen.getByRole("heading", { level: 1, name: "Unlock a vault", hidden: true })).toBeTruthy();
  nothingOfTheVaultIsOnScreen();
  expect(document.querySelectorAll("style")).toHaveLength(0);
  await expectNoAxe(container);

  // Escape is not a yes: the message stays, the shell is told nothing and the window stays.
  fireEvent.keyDown(dialog, { key: "Escape" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(screen.queryByRole("dialog", { name: FIRST_CLOSE_TITLE })).not.toBeNull();
  expect(shell.closeExplainedCalls()).toBe(0);

  // Got it: the shell is asked once, with nothing, and the message goes.
  fireEvent.click(within(dialog).getByRole("button", { name: "Got it" }));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(invoke.mock.calls.filter(([cmd]) => cmd === "close_explained_ok")).toEqual([["close_explained_ok", {}]]);
  expect(shell.windowHidden()).toBe(true);
  // The lock screen is there to use, with nothing typed.
  expect(screen.getByLabelText<HTMLInputElement>(/^Password for /).value).toBe("");
});

test("second_close_says_nothing", async () => {
  await unlocked();
  act(() => {
    shell.closeWindow();
  });
  fireEvent.click(within(await screen.findByRole("dialog", { name: FIRST_CLOSE_TITLE })).getByRole("button", { name: "Got it" }));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  // The vault is opened again and the window closed again: the window hides, and the page says nothing and asks nothing.
  const before = invoke.mock.calls.length;
  await unlockOnScreen();
  act(() => {
    shell.closeWindow();
  });
  expect(await screen.findByLabelText(/^Password for /)).toBeTruthy();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.body.textContent).not.toContain(FIRST_CLOSE_TITLE);
  expect(shell.closeExplainedCalls()).toBe(1);
  expect(invoke.mock.calls.slice(before).filter(([cmd]) => cmd === "close_explained_ok")).toEqual([]);
  nothingOfTheVaultIsOnScreen();

  // An `explain: false` with nothing showing changes nothing.
  act(() => {
    shell.sendEvent({ kind: "first_close", explain: false });
  });
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("a_second_close_while_5b_shows_counts_as_got_it", async () => {
  await unlocked();
  act(() => {
    shell.closeWindow();
  });
  await screen.findByRole("dialog", { name: FIRST_CLOSE_TITLE });
  // The window is closed again while 5b shows: the shell hides it and sends `explain: false`; the page asks nothing.
  act(() => {
    shell.closeWindow();
  });
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(shell.windowHidden()).toBe(true);
  expect(shell.closeExplainedCalls()).toBe(0);
  // And it stays once: the next close says nothing.
  act(() => {
    shell.closeWindow();
  });
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("a_close_when_it_was_explained_in_an_earlier_run_shows_nothing", async () => {
  await unlocked();
  shell.markCloseExplained();
  act(() => {
    shell.closeWindow();
  });
  expect(await screen.findByLabelText(/^Password for /)).toBeTruthy();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(shell.windowHidden()).toBe(true);
});

test("got_it_that_cannot_reach_the_shell_leaves_the_message_to_be_pressed_again", async () => {
  await unlocked();
  act(() => {
    shell.closeWindow();
  });
  const dialog = await screen.findByRole("dialog", { name: FIRST_CLOSE_TITLE });
  const real = invoke.getMockImplementation();
  if (real === undefined) throw new Error("no fake shell");
  let broken = true;
  invoke.mockImplementation((cmd: string, args?: unknown) =>
    cmd === "close_explained_ok" && broken ? Promise.reject(new Error("SENTINEL no bridge")) : (real(cmd, args) as Promise<unknown>),
  );
  fireEvent.click(within(dialog).getByRole("button", { name: "Got it" }));
  await waitFor(() => {
    expect(invoke.mock.calls.filter(([cmd]) => cmd === "close_explained_ok")).toHaveLength(1);
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  // Still there, and nothing said about why.
  expect(screen.queryByRole("dialog", { name: FIRST_CLOSE_TITLE })).not.toBeNull();
  expect(document.body.textContent).not.toContain("SENTINEL");
  expect(screen.queryByRole("alert")).toBeNull();
  broken = false;
  fireEvent.click(within(dialog).getByRole("button", { name: "Got it" }));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(shell.windowHidden()).toBe(true);
});

test("got_it_is_pressed_once_and_its_answer_alone_closes_the_message", async () => {
  await unlocked();
  act(() => {
    shell.closeWindow();
  });
  const dialog = await screen.findByRole("dialog", { name: FIRST_CLOSE_TITLE });
  const real = invoke.getMockImplementation();
  if (real === undefined) throw new Error("no fake shell");
  let answer: () => void = () => undefined;
  invoke.mockImplementation((cmd: string, args?: unknown) =>
    cmd === "close_explained_ok"
      ? new Promise((resolve) => {
          answer = () => {
            resolve(null);
          };
        })
      : (real(cmd, args) as Promise<unknown>),
  );
  const button = within(dialog).getByRole("button", { name: "Got it" });
  fireEvent.click(button);
  fireEvent.click(button);
  expect(invoke.mock.calls.filter(([cmd]) => cmd === "close_explained_ok")).toHaveLength(1);
  // The answer comes without the shell's own `explain: false` (the event was lost): the answer is enough to close it.
  await act(async () => {
    answer();
    await Promise.resolve();
  });
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

test("lock_reason_idle_shows_5c", async () => {
  // Whatever the reason, the page comes to the same screen: the lock screen, with no message, no error and nothing of the
  // vault, even with the vault menu open when the lock came.
  for (const reason of ["idle", "manual", "app_closing", "windows_locked", "sleep", "drive_gone"]) {
    resetStoreForTests();
    const { container, unmount } = await unlocked([{ ...MINE }]);
    await openVaultMenu();
    const live = shell.sessionOf(7);
    if (live === undefined) throw new Error("not open");
    act(() => {
      shell.lock(live.session, reason);
    });
    expect(await screen.findByRole("heading", { level: 1, name: "Unlock My vault" }), reason).toBeTruthy();
    expect(screen.getByText(IDLE_WORDS), reason).toBeTruthy();
    expect(screen.queryByRole("alert"), reason).toBeNull();
    expect(screen.queryByRole("dialog"), reason).toBeNull();
    expect(screen.getByLabelText<HTMLInputElement>(/^Password for /).value, reason).toBe("");
    nothingOfTheVaultIsOnScreen();
    if (reason === "idle") await expectNoAxe(container);
    unmount();
  }
});

test("locked_vault_line_on_the_list", async () => {
  await unlocked([
    { ...MINE },
    { ...HOME },
    // A vault that can't be reached is not named in the line, and is a row of the menu that says so (Task 6).
    { id: 9, name: null, available: false },
  ]);
  expect(screen.getByText("Home is locked, so its items aren't listed.")).toBeTruthy();
  const menu = await openVaultMenu();
  // The menu agrees with the line: every vault is one row, in the list's order (once, with no line of notes): the open one, the locked one that says Locked, and the
  // one that can't be reached, which says so.
  expect(menu.querySelectorAll(".mnote")).toHaveLength(0);
  expect(within(menu).getAllByRole("menuitemradio").map((row) => row.textContent)).toEqual(["My vaultUnlocked", "HomeLocked", "A vault that can't be readNot available"]);
  expect(within(menu).getByRole("group", { name: "Vaults" })).toBeTruthy();
  // The state is in words, not in colour alone.
  expect(menu.querySelectorAll(".mi .ms")).toHaveLength(3);
});

test("locked_vault_line_names_how_many_when_there_are_several", async () => {
  await unlocked([{ ...MINE }, { ...HOME }, { id: 9, name: "Work", items: [] }]);
  expect(screen.getByText("2 other vaults are locked, so their items aren't listed.")).toBeTruthy();
  const menu = await openVaultMenu();
  expect(within(menu).getAllByRole("menuitemradio").map((row) => row.textContent)).toEqual(["My vaultUnlocked", "HomeLocked", "WorkLocked"]);
});

test("the_vault_menu_keeps_its_action_in_reach_with_many_vaults", async () => {
  const many: FakeVault[] = [{ ...MINE }];
  for (let n = 1; n <= 19; n += 1) many.push({ id: 100 + n, name: `Vault ${String(n)}`, items: [] });
  await unlocked(many);
  const menu = await openVaultMenu();
  // All twenty are rows (the open one and the nineteen that are locked), in the one area that scrolls; the action is not inside it, so scrolling the rows never takes it away.
  const area = menu.querySelector(".mscroll");
  expect(area).not.toBeNull();
  expect(area?.querySelectorAll('[role="menuitemradio"]')).toHaveLength(20);
  expect(within(menu).getAllByRole("menuitemradio")).toHaveLength(20);
  const lock = within(menu).getByRole("menuitem", { name: "Lock My vault" });
  expect(area?.contains(lock)).toBe(false);
  expect(menu.classList.contains("mwide")).toBe(true);
  // jsdom lays nothing out, so the style sheet is read: the menu is never taller than the room the window leaves it (the
  // positioner's `--available-height`), and the rows are what scroll. The real window is the hands-on's to check.
  const css = readBeside(import.meta.url, "../styles/components.css");
  const rule = (selector: string) => {
    const at = css.indexOf(`\n${selector} {`);
    expect(at, `${selector} is in the style sheet`).toBeGreaterThan(-1);
    return css.slice(at, css.indexOf("}", at));
  };
  expect(rule(".menu.mwide")).toMatch(/max-height:\s*var\(--available-height/);
  expect(rule(".menu.mwide")).toMatch(/display:\s*flex/);
  expect(rule(".mscroll")).toMatch(/overflow-y:\s*auto/);
  expect(rule(".mscroll")).toMatch(/min-height:\s*0/);
});

test("the_vault_menu_keeps_its_action_in_reach_with_many_open_vaults", async () => {
  // Every open vault and backup is a row: with several of them at a small window, the rows scroll in an area of their own, and the Lock action
  // stays outside it, as the locked vaults' lines do.
  await unlocked([{ ...MINE }, { ...HOME }, { id: 9, name: "Work", items: [] }]);
  for (const id of [8, 9]) {
    await act(async () => {
      expect(await unlock({ list: shell.listIdentity(), id }, PASSWORD)).toBe("opened");
    });
  }
  const menu = await openVaultMenu("Work");
  const rows = within(menu).getAllByRole("menuitemradio");
  expect(rows).toHaveLength(3);
  const area = rows[0]?.closest(".mscroll");
  expect(area).not.toBeNull();
  for (const row of rows) expect(row.closest(".mscroll")).toBe(area);
  const lock = within(menu).getByRole("menuitem", { name: "Lock Work" });
  expect(lock.closest(".mscroll")).toBeNull();
  // The area the rows are in may shrink inside the menu (down to a row and a half), so it is what scrolls and the action stays (jsdom lays nothing out).
  const css = readBeside(import.meta.url, "../styles/components.css");
  const rule = (selector: string) => {
    const at = css.indexOf(`\n${selector} {`);
    expect(at, `${selector} is in the style sheet`).toBeGreaterThan(-1);
    return css.slice(at, css.indexOf("}", at));
  };
  expect(rule(".menu.mwide > .mscroll")).toMatch(/flex:\s*0 1 auto/);
  expect(rule(".menu.mwide > .mscroll")).toMatch(/min-height:\s*4\.5em/);
  // No line of notes is left in the style sheet or the menu.
  expect(css).not.toContain(".mnote");
});
