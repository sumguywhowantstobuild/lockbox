// Task 10's screens: the one search (Ctrl+F and Ctrl+K, 4a to 4c), signing in to a website from it (2a to 2f), and the
// login's own details with their copy and open buttons (2b, 2c).
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import App from "../App";
import { debugState, resetStoreForTests, unlock } from "../store";
import { expectNoAxe } from "../testing/axe";
import {
  installFakeShell,
  itemId,
  PASSWORD,
  sampleItems,
  SEARCH_LIMIT,
  type FakeItem,
  type FakeShell,
  type FakeVault,
} from "../testing/fakeShell";

const { invoke, listen } = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

let shell: FakeShell;

beforeEach(() => {
  // Axe leaves a `<style>` of its own in the head; a style element found later is the page's.
  for (const style of document.querySelectorAll("style")) style.remove();
  resetStoreForTests();
  invoke.mockReset();
  listen.mockReset();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-06T12:00:00Z"));
});

const SEARCH = "Search every unlocked vault";
const LOGIN_PASSWORD_MARK = "Pw-";

const HOME_ITEMS: FakeItem[] = [
  { id: itemId(21), kind: "login", title: "OpenAI console", username: "me@example.com", has_password: true, modified_at: "2026-11-01T09:00:00Z" },
  {
    id: itemId(22),
    kind: "login",
    title: "Bot admin console",
    username: "home@example.com",
    urls: ["https://support.example.com/admin?x=1"],
    has_password: true,
    modified_at: "2026-11-02T09:00:00Z",
  },
];

const MINE: FakeVault = { id: 7, name: "My vault", items: sampleItems() };

function vaults(): FakeVault[] {
  return [
    { ...MINE, items: sampleItems() },
    { id: 8, name: "Home", items: HOME_ITEMS.map((item) => ({ ...item })) },
    { id: 9, name: "Work", items: [] },
  ];
}

/** The app on its lock screen with `list`, then the vault at `first` unlocked through the screen as a person would. */
async function unlocked(list: FakeVault[] = [vaults()[0] as FakeVault], settings?: { idle_minutes: number; clipboard_seconds: number }) {
  shell = installFakeShell(invoke, listen, list, settings);
  const view = render(<App />);
  const field = await screen.findByLabelText(/^Password for /);
  fireEvent.change(field, { target: { value: PASSWORD } });
  fireEvent.submit((field as HTMLInputElement).form as HTMLFormElement);
  await screen.findByRole("heading", { level: 1, name: "All items" });
  return view;
}

/** My vault and Home both open, Home on screen (opened last), Work still locked. */
async function twoOpen() {
  const view = await unlocked(vaults());
  await act(async () => {
    expect(await unlock(8, PASSWORD)).toBe("opened");
  });
  await screen.findByRole("button", { name: "Home, vault menu" });
  return view;
}

/** Ctrl+F or Ctrl+K as the page hears it; false when the page took the key from the window (`preventDefault`). */
function ctrl(key: "f" | "k"): boolean {
  return fireEvent.keyDown(document.body, { key, ctrlKey: true });
}

async function openSearch(key: "f" | "k" = "f") {
  ctrl(key);
  const dialog = await screen.findByRole("dialog", { name: SEARCH });
  return { dialog, box: within(dialog).getByRole<HTMLInputElement>("textbox", { name: SEARCH }) };
}

async function searchFor(text: string) {
  const found = await openSearch();
  fireEvent.change(found.box, { target: { value: text } });
  return found;
}

/** One result's line, found by the name of the button that opens it (its kind, title and detail line). */
async function result(dialog: HTMLElement, name: RegExp): Promise<HTMLElement> {
  const opener = await within(dialog).findByRole("button", { name });
  const row = opener.closest("li");
  if (row === null) throw new Error("a result is not in a list");
  return row;
}

function rowsOf(dialog: HTMLElement): HTMLElement[] {
  return within(dialog).queryAllByRole("listitem");
}

/** The words on the action buttons of one result (not the button that opens it). */
function actionsOf(row: HTMLElement): string[] {
  const group = within(row).queryByRole("group");
  return group === null ? [] : within(group).getAllByRole("button").map((button) => button.textContent);
}

function searchCalls(): unknown[] {
  return invoke.mock.calls.filter(([cmd]) => cmd === "search_all").map(([, args]): unknown => args);
}

function nothingOfTheVaultsIsOnScreen() {
  const page = document.body.textContent;
  for (const secret of ["Bot admin console", "admin@example.com", "OpenAI console", "support.example.com", "Rotation steps"]) {
    expect(page, secret).not.toContain(secret);
  }
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.queryByRole("complementary")).toBeNull();
}

test("ctrl_f_and_ctrl_k_open_one_search", async () => {
  const { container } = await unlocked();
  expect(screen.queryByRole("dialog")).toBeNull();
  // Focus is on the filter when the person presses the keys; it is the place focus must come back to.
  const filter = screen.getByRole("searchbox", { name: "Filter this list" });
  filter.focus();

  // The page takes the key: WebView2 has no find bar to give it to, and the window must not act on it.
  expect(ctrl("f")).toBe(false);
  const dialog = await screen.findByRole("dialog", { name: SEARCH });
  const box = within(dialog).getByRole<HTMLInputElement>("textbox", { name: SEARCH });
  await waitFor(() => {
    expect(document.activeElement).toBe(box);
  });
  expect(box.value).toBe("");
  expect(box.getAttribute("placeholder")).toBe("Search unlocked vaults");
  // Another press while it is open does not make a second one.
  expect(ctrl("k")).toBe(false);
  expect(ctrl("f")).toBe(false);
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
  expect(document.querySelectorAll("style")).toHaveLength(0);
  // No style attribute in what the page draws (the library sets its own properties by script on its dialog box, which the
  // policy allows).
  expect(Array.from(dialog.querySelectorAll("[style]")).map((element) => element.outerHTML)).toEqual([]);
  await expectNoAxe(container);

  // Escape closes it, and focus goes back to where it was.
  fireEvent.keyDown(dialog, { key: "Escape" });
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  await waitFor(() => {
    expect(document.activeElement).toBe(filter);
  });

  // Ctrl+K opens the same one, and its Close button closes it.
  const again = await openSearch("k");
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
  fireEvent.click(within(again.dialog).getByRole("button", { name: "Close" }));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  await waitFor(() => {
    expect(document.activeElement).toBe(filter);
  });

  // Other keys do not open it, and the filter box keeps its own keys.
  fireEvent.keyDown(document.body, { key: "f" });
  fireEvent.keyDown(document.body, { key: "f", ctrlKey: true, shiftKey: true });
  fireEvent.keyDown(document.body, { key: "f", ctrlKey: true, altKey: true });
  fireEvent.keyDown(document.body, { key: "g", ctrlKey: true });
  expect(screen.queryByRole("dialog")).toBeNull();
  // The search button in the side menu opens the same one.
  fireEvent.click(within(screen.getByRole("navigation", { name: "Vault and folders" })).getByRole("button", { name: /^Search/ }));
  await screen.findByRole("dialog", { name: SEARCH });
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
});

test("an_empty_search_asks_the_shell_nothing_and_shows_only_the_foot", async () => {
  await unlocked();
  const { dialog, box } = await openSearch();
  fireEvent.change(box, { target: { value: "   " } });
  expect(within(dialog).queryByRole("list")).toBeNull();
  expect(screen.queryByText(/^Nothing for/)).toBeNull();
  expect(searchCalls()).toEqual([]);
  expect(within(dialog).getByRole("button", { name: "Lock all" })).toBeTruthy();
  expect(within(dialog).getByRole("button", { name: "Close" })).toBeTruthy();
  // The box takes no more than the shell would answer.
  expect(box.maxLength).toBe(256);
});

test("results_cover_every_unlocked_vault", async () => {
  const { container } = await twoOpen();
  const { dialog } = await searchFor("console");
  // Each result says which vault it is in; Work is locked, so nothing from it.
  await result(dialog, /admin@example\.com · support\.example\.com · My vault/);
  await result(dialog, /home@example\.com · support\.example\.com · Home/);
  await result(dialog, /me@example\.com · Home/);
  expect(rowsOf(dialog)).toHaveLength(3);
  expect(within(dialog).queryByText(/Work/)).toBeNull();
  // The site shown is the host, never the address with its path or query.
  expect(dialog.textContent).not.toContain("/admin");
  expect(dialog.textContent).not.toContain("x=1");
  // One search over every vault, sent as it was typed and nowhere else.
  expect(searchCalls().at(-1)).toEqual({ query: "console" });
  expect(searchCalls().every((args) => JSON.stringify(args).includes('"query"'))).toBe(true);
  // A folder, a stored file, and a trashed login are not offered, whatever matched.
  fireEvent.change(within(dialog).getByRole("textbox", { name: SEARCH }), { target: { value: "agency" } });
  const note = await result(dialog, /Agency support agent · My vault/);
  await waitFor(() => {
    expect(rowsOf(dialog)).toHaveLength(2);
  });
  // A note has nothing to copy: its one button opens it.
  expect(within(note).getAllByRole("button")).toHaveLength(1);
  expect(within(dialog).queryByText(/^Client contract/)).toBeNull();
  expect(within(dialog).queryByRole("button", { name: /Copy key/ })).toBeNull();
  expect(within(dialog).queryByRole("button", { name: /New item/ })).toBeNull();
  await expectNoAxe(container);

  // Picking a result of the vault that is not on screen puts that vault on screen, with the item open.
  fireEvent.click(within(dialog).getByRole("button", { name: /Rotation steps/ }));
  const panel = await screen.findByRole("complementary", { name: "Rotation steps" });
  expect(within(panel).getByText("Made-up note")).toBeTruthy();
  await screen.findByRole("button", { name: "My vault, vault menu" });
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

test("result_actions_copy_password_and_username", async () => {
  await unlocked();
  const { dialog } = await searchFor("support");
  const row = await result(dialog, /admin@example\.com · support\.example\.com · My vault/);
  expect(actionsOf(row)).toEqual(["Copy username", "Copy password", "Open site"]);
  const live = shell.sessionOf(7);
  fireEvent.click(within(row).getByRole("button", { name: "Copy password" }));
  await waitFor(() => {
    expect(shell.copied).toEqual([{ session: live?.session, generation: live?.generation, id: itemId(1), field: "password" }]);
  });
  // The login opens behind with the message about the copy, and the search is out of the way.
  await screen.findByRole("complementary", { name: "Bot admin console" });
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(screen.getByRole("status").textContent).toContain("Password copied");

  const second = await searchFor("support");
  fireEvent.click(within(await result(second.dialog, /admin@example\.com/)).getByRole("button", { name: "Copy username" }));
  await waitFor(() => {
    expect(shell.copied.at(-1)).toMatchObject({ id: itemId(1), field: "username" });
  });
  await waitFor(() => {
    expect(screen.getByRole("status").textContent).toContain("Username copied");
  });
  // No password or other secret ever reached the page.
  expect(document.body.textContent).not.toContain(LOGIN_PASSWORD_MARK);
  expect(invoke.mock.calls.some(([cmd]) => cmd === "reveal_password")).toBe(false);
});

test("a_copy_that_fails_says_so_in_the_search", async () => {
  await unlocked();
  const { dialog } = await searchFor("support");
  const row = await result(dialog, /admin@example\.com/);
  const real = invoke.getMockImplementation();
  if (real === undefined) throw new Error("no fake shell");
  invoke.mockImplementation((cmd: string, args?: unknown) =>
    cmd === "copy_field"
      ? // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- Tauri rejects with the plain object
        Promise.reject({ code: "core", kind: "io" })
      : (real(cmd, args) as Promise<unknown>),
  );
  fireEvent.click(within(row).getByRole("button", { name: "Copy password" }));
  // In words, in the search where the person is looking, and the search stays.
  const alert = await within(dialog).findByRole("alert");
  expect(alert.textContent).toBe("Lockbox couldn't reach that folder or file. Check that the drive is connected, then try again.");
  expect(screen.getByRole("dialog", { name: SEARCH })).toBeTruthy();
});

test("nothing_found_says_so", async () => {
  const { container } = await unlocked();
  const { dialog } = await searchFor("zzzz");
  expect(await within(dialog).findByText('Nothing for "zzzz"')).toBeTruthy();
  expect(within(dialog).getByText("Try another word.")).toBeTruthy();
  expect(within(dialog).queryByRole("list")).toBeNull();
  // Nothing here leads to a screen a later task builds.
  expect(dialog.textContent).not.toMatch(/new login|New item/);
  expect(within(dialog).queryByText(/is locked|are locked|is busy|are busy/)).toBeNull();
  await expectNoAxe(container);
});

test("says_when_vaults_are_locked", async () => {
  await unlocked([vaults()[0] as FakeVault, vaults()[1] as FakeVault]);
  let { dialog } = await searchFor("acme");
  // One locked vault is named.
  expect(await within(dialog).findByText('Nothing for "acme"')).toBeTruthy();
  expect(within(dialog).getByText("Home is locked, so it isn't searched. Try another word.")).toBeTruthy();
  expect(dialog.textContent).not.toContain("add a new login");
  expect(searchCalls().at(-1)).toEqual({ query: "acme" });
  fireEvent.keyDown(dialog, { key: "Escape" });
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  cleanup();

  // Several are named in plain words, with the last after "and".
  resetStoreForTests();
  invoke.mockReset();
  listen.mockReset();
  await unlocked([
    vaults()[0] as FakeVault,
    vaults()[1] as FakeVault,
    vaults()[2] as FakeVault,
    { id: 10, name: "Old copy", items: [] },
  ]);
  ({ dialog } = await searchFor("acme"));
  expect(await within(dialog).findByText("Home, Work and Old copy are locked, so they aren't searched. Try another word.")).toBeTruthy();
  // A result is shown with the other vaults' names, with no sentence about the locked ones when something was found.
  fireEvent.change(within(dialog).getByRole("textbox", { name: SEARCH }), { target: { value: "console" } });
  await result(dialog, /admin@example\.com/);
  expect(within(dialog).queryByText(/is locked|are locked/)).toBeNull();
});

test("busy_vault_says_results_are_missing", async () => {
  await twoOpen();
  shell.setBusy(7, true);
  const { dialog } = await searchFor("console");
  // The busy vault gives nothing, the others' results come, and a line says what is missing and why.
  await result(dialog, /me@example\.com · Home/);
  expect(within(dialog).queryByText(/My vault$/)).toBeNull();
  expect(within(dialog).getByText("My vault is busy, so its results are missing for now.")).toBeTruthy();
  expect(within(dialog).queryByRole("alert")).toBeNull();

  // Nothing found elsewhere either: both are said.
  fireEvent.change(within(dialog).getByRole("textbox", { name: SEARCH }), { target: { value: "acme" } });
  expect(await within(dialog).findByText('Nothing for "acme"')).toBeTruthy();
  expect(within(dialog).getByText("My vault is busy, so its results are missing for now.")).toBeTruthy();

  // Two busy vaults are named together.
  shell.setBusy(8, true);
  fireEvent.change(within(dialog).getByRole("textbox", { name: SEARCH }), { target: { value: "console" } });
  expect(await within(dialog).findByText("My vault and Home are busy, so their results are missing for now.")).toBeTruthy();
});

test("two_logins_show_usernames", async () => {
  const items = sampleItems();
  items.push({
    id: itemId(30),
    kind: "login",
    title: "Bot admin console",
    username: "billing@example.com",
    urls: ["https://support.example.com"],
    has_password: true,
    modified_at: "2026-11-03T09:00:00Z",
  });
  await unlocked([{ id: 7, name: "My vault", items }]);
  const { dialog } = await searchFor("console");
  const first = await result(dialog, /admin@example\.com · support\.example\.com · My vault/);
  const second = await result(dialog, /billing@example\.com · support\.example\.com · My vault/);
  expect(first).not.toBe(second);
  // Each one's buttons act on its own login.
  fireEvent.click(within(second).getByRole("button", { name: "Open site" }));
  await waitFor(() => {
    expect(shell.opened).toMatchObject([{ id: itemId(30), index: 0 }]);
  });
  fireEvent.click(within(first).getByRole("button", { name: "Open site" }));
  await waitFor(() => {
    expect(shell.opened.at(-1)).toMatchObject({ id: itemId(1), index: 0 });
  });
  fireEvent.click(within(second).getByRole("button", { name: "Copy password" }));
  await waitFor(() => {
    expect(shell.copied.at(-1)).toMatchObject({ id: itemId(30), field: "password" });
  });
});

test("no_website_means_no_open_button", async () => {
  const items: FakeItem[] = [
    ...sampleItems(),
    { id: itemId(31), kind: "login", title: "Router", username: "root", has_password: true, urls: ["router.local"] },
    { id: itemId(32), kind: "login", title: "Files server", username: "ada", has_password: true, urls: ["ftp://files.example.com"] },
  ];
  await unlocked([{ id: 7, name: "My vault", items }]);
  const { dialog } = await searchFor("example");
  const tracker = await result(dialog, /team@example\.com · My vault/);
  // A login with no website: its details line has no site, and the row has no Open site.
  expect(actionsOf(tracker)).toEqual(["Copy username", "Copy password"]);
  const withSite = await result(dialog, /admin@example\.com · support\.example\.com · My vault/);
  expect(within(withSite).getByRole("button", { name: "Open site" })).toBeTruthy();
  // A website the shell would not open (no scheme, or not http or https) gives no button either.
  fireEvent.change(within(dialog).getByRole("textbox", { name: SEARCH }), { target: { value: "router" } });
  const router = await result(dialog, /root · My vault/);
  expect(within(router).queryByRole("button", { name: "Open site" })).toBeNull();
  fireEvent.change(within(dialog).getByRole("textbox", { name: SEARCH }), { target: { value: "files server" } });
  const files = await result(dialog, /ada · My vault/);
  expect(within(files).queryByRole("button", { name: "Open site" })).toBeNull();
  expect(shell.opened).toEqual([]);

  // The login's own details agree: no website, no Open.
  fireEvent.keyDown(dialog, { key: "Escape" });
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  fireEvent.click(await screen.findByRole("button", { name: /^Login:\s*Error tracker/ }));
  const panel = await screen.findByRole("complementary", { name: "Error tracker" });
  await within(panel).findByText("team@example.com");
  expect(within(panel).queryByRole("button", { name: /^Open/ })).toBeNull();
});

test("open_site_goes_through_open_url", async () => {
  const opened = vi.spyOn(window, "open").mockReturnValue(null);
  try {
    await unlocked();
    const { dialog } = await searchFor("support");
    const row = await result(dialog, /admin@example\.com · support\.example\.com · My vault/);
    const live = shell.sessionOf(7);
    fireEvent.click(within(row).getByRole("button", { name: "Open site" }));
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("open_url", {
        session: live?.session,
        generation: live?.generation,
        id: itemId(1),
        index: 0,
      });
    });
    expect(shell.opened).toHaveLength(1);
    // The page builds no link and opens nothing itself: the shell opens the stored address, the page never sees it.
    expect(dialog.querySelectorAll("a")).toHaveLength(0);
    expect(document.querySelectorAll("a[href]")).toHaveLength(0);
    expect(opened).not.toHaveBeenCalled();
    expect(dialog.textContent).not.toContain("https://");
    // The search stays: the person comes back to copy the username and password.
    expect(screen.getByRole("dialog", { name: SEARCH })).toBeTruthy();
    expect(within(dialog).queryByRole("alert")).toBeNull();

    // A refusal is said in words.
    const real = invoke.getMockImplementation();
    if (real === undefined) throw new Error("no fake shell");
    invoke.mockImplementation((cmd: string, args?: unknown) =>
      cmd === "open_url"
        ? // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- Tauri rejects with the plain object
          Promise.reject({ code: "invalid_input", what: "link type" })
        : (real(cmd, args) as Promise<unknown>),
    );
    fireEvent.click(within(row).getByRole("button", { name: "Open site" }));
    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toBe("Lockbox can't use that. Check what you entered and try again.");
  } finally {
    opened.mockRestore();
  }
});

test("copy_buttons_on_the_login_details", async () => {
  const items = sampleItems();
  items[2] = { ...items[2], urls: ["https://support.example.com", "https://status.example.com/page"] } as FakeItem;
  await unlocked([{ id: 7, name: "My vault", items }]);
  fireEvent.click(await screen.findByRole("button", { name: /^Login:\s*Bot admin console/ }));
  const panel = await screen.findByRole("complementary", { name: "Bot admin console" });
  await within(panel).findByText("admin@example.com");
  const live = shell.sessionOf(7);

  // Copy for the username, Copy password, and an Open for each website; Reveal is a later task's.
  fireEvent.click(within(panel).getByRole("button", { name: "Copy username" }));
  await waitFor(() => {
    expect(shell.copied.at(-1)).toEqual({ session: live?.session, generation: live?.generation, id: itemId(1), field: "username" });
  });
  fireEvent.click(within(panel).getByRole("button", { name: "Copy password" }));
  await waitFor(() => {
    expect(shell.copied.at(-1)).toMatchObject({ id: itemId(1), field: "password" });
  });
  expect(within(panel).queryByRole("button", { name: /reveal/i })).toBeNull();

  const opens = within(panel).getAllByRole("button", { name: /^Open / });
  expect(opens.map((button) => button.getAttribute("aria-label"))).toEqual(["Open support.example.com", "Open status.example.com"]);
  expect(opens.map((button) => button.textContent)).toEqual(["Open", "Open"]);
  fireEvent.click(opens[1] as HTMLElement);
  await waitFor(() => {
    expect(shell.opened).toEqual([{ session: live?.session, generation: live?.generation, id: itemId(1), index: 1 }]);
  });
  fireEvent.click(opens[0] as HTMLElement);
  await waitFor(() => {
    expect(shell.opened.at(-1)).toMatchObject({ index: 0 });
  });
  expect(panel.querySelectorAll("a")).toHaveLength(0);
  expect(document.body.textContent).not.toContain(LOGIN_PASSWORD_MARK);
});

test("clear_time_shows_after_copy", async () => {
  await unlocked([vaults()[0] as FakeVault], { idle_minutes: 5, clipboard_seconds: 45 });
  const { dialog } = await searchFor("support");
  const row = await result(dialog, /admin@example\.com/);
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-06T12:00:00Z"));
  fireEvent.click(within(row).getByRole("button", { name: "Copy username" }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300);
  });
  // The settings' own delay, counting down; the copy never shows the value, and "Clear now" is not offered, since no
  // command clears the clipboard on its own.
  const status = screen.getByRole("status");
  expect(status.textContent).toContain("Username copied");
  expect(status.textContent).toContain("clears in 45 s");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  expect(screen.getByRole("status").textContent).toContain("clears in 40 s");
  expect(screen.queryByRole("button", { name: /clear now/i })).toBeNull();
  expect(screen.queryByText(/clear now/i)).toBeNull();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(41_000);
  });
  expect(screen.queryByRole("status")?.textContent ?? "").not.toContain("Username copied");
});

test("lock_all_at_the_foot", async () => {
  await twoOpen();
  const { dialog } = await searchFor("console");
  await result(dialog, /me@example\.com · Home/);
  // At the foot, Lock all, and at its other end Close. New item is a later task's.
  const lock = within(dialog).getByRole("button", { name: "Lock all" });
  const close = within(dialog).getByRole("button", { name: "Close" });
  expect(lock.compareDocumentPosition(close) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  const lastResult = rowsOf(dialog).at(-1) as HTMLElement;
  expect(lastResult.compareDocumentPosition(lock) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(within(dialog).queryByRole("button", { name: /new item/i })).toBeNull();

  fireEvent.click(lock);
  expect(await screen.findByLabelText(/^Password for /)).toBeTruthy();
  expect(invoke).toHaveBeenCalledWith("lock_all", {});
  expect(shell.sessionOf(7)?.unlocked).toBe(false);
  expect(shell.sessionOf(8)?.unlocked).toBe(false);
  nothingOfTheVaultsIsOnScreen();
  expect(screen.queryByRole("alert")).toBeNull();

  // Nothing of the search is kept for the next unlock: no box open, and nothing typed.
  const field = await screen.findByLabelText(/^Password for /);
  fireEvent.change(field, { target: { value: PASSWORD } });
  fireEvent.submit((field as HTMLInputElement).form as HTMLFormElement);
  await screen.findByRole("heading", { level: 1, name: "All items" });
  expect(screen.queryByRole("dialog")).toBeNull();
  const fresh = await openSearch();
  expect(fresh.box.value).toBe("");
  expect(rowsOf(fresh.dialog)).toHaveLength(0);
});

test("sign_in_takes_six_keys_or_clicks", async () => {
  await unlocked();
  // The steps from the open window to the password on the clipboard with the site opened. Typing the word to look for is
  // one step, however long.
  const steps: string[] = [];
  const step = (what: string) => steps.push(what);

  step("Ctrl+F");
  const { dialog, box } = await openSearch();
  step("type the site's name");
  fireEvent.change(box, { target: { value: "support" } });
  const row = await result(dialog, /admin@example\.com · support\.example\.com · My vault/);
  step("click Open site");
  fireEvent.click(within(row).getByRole("button", { name: "Open site" }));
  await waitFor(() => {
    expect(shell.opened).toHaveLength(1);
  });
  step("click Copy username");
  fireEvent.click(within(row).getByRole("button", { name: "Copy username" }));
  const panel = await screen.findByRole("complementary", { name: "Bot admin console" });
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  await within(panel).findByRole("button", { name: "Copy password" });
  step("click Copy password");
  fireEvent.click(within(panel).getByRole("button", { name: "Copy password" }));
  await waitFor(() => {
    expect(shell.copied.map((sent) => sent.field)).toEqual(["username", "password"]);
  });

  expect(shell.opened).toHaveLength(1);
  expect(steps, steps.join(", ")).toHaveLength(5);
  expect(steps.length).toBeLessThanOrEqual(6);
});

test("lock_during_search_drops_results", async () => {
  const { container } = await twoOpen();
  const { dialog, box } = await openSearch();
  // A search is on its way (the shell read both vaults) when Home locks: nothing from Home, and no error.
  const release = shell.holdSearch();
  fireEvent.change(box, { target: { value: "console" } });
  await waitFor(() => {
    expect(searchCalls()).toHaveLength(1);
  });
  const home = shell.sessionOf(8);
  if (home === undefined) throw new Error("Home is not open");
  act(() => {
    shell.lock(home.session);
  });
  await act(async () => {
    release();
    await Promise.resolve();
  });
  await result(dialog, /admin@example\.com · support\.example\.com · My vault/);
  expect(within(dialog).queryByText(/Home/)).toBeNull();
  expect(within(dialog).queryByText(/me@example\.com|home@example\.com/)).toBeNull();
  expect(rowsOf(dialog)).toHaveLength(1);
  expect(screen.queryByRole("alert")).toBeNull();
  // Nor does the page hold what Home found.
  expect(JSON.stringify(debugState().search)).not.toContain("me@example.com");
  await expectNoAxe(container);
});

test("a_lock_of_the_vault_with_results_on_screen_takes_them_away_at_once", async () => {
  await twoOpen();
  const { dialog } = await searchFor("console");
  await result(dialog, /me@example\.com · Home/);
  await result(dialog, /admin@example\.com · support\.example\.com · My vault/);
  const mine = shell.sessionOf(7);
  if (mine === undefined) throw new Error("My vault is not open");
  act(() => {
    shell.lock(mine.session);
  });
  // My vault's result goes; Home's stay; no message about it.
  await waitFor(() => {
    expect(within(dialog).queryByText(/My vault/)).toBeNull();
  });
  expect(within(dialog).queryByText(/admin@example\.com/)).toBeNull();
  expect(within(dialog).getByText(/me@example\.com · Home/)).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
  // Not only off the screen: the page no longer holds that vault's items at all.
  expect(debugState().search?.hits.map((found) => found.session)).toEqual([shell.sessionOf(8)?.session]);

  // The last vault locks: the lock screen, and nothing of the results.
  const home = shell.sessionOf(8);
  if (home === undefined) throw new Error("Home is not open");
  act(() => {
    shell.lock(home.session);
  });
  expect(await screen.findByLabelText(/^Password for /)).toBeTruthy();
  nothingOfTheVaultsIsOnScreen();
  expect(debugState().search).toBeNull();
  expect(JSON.stringify(debugState())).not.toContain("admin@example.com");
});

test("results_are_reachable_by_arrow_keys_and_tab", async () => {
  await twoOpen();
  const { dialog, box } = await searchFor("console");
  const rows = await within(dialog).findAllByRole("button", { name: /console/ });
  const opens = rows.filter((button) => button.className.includes("hgo"));
  expect(opens).toHaveLength(3);
  // Down from the box goes to the first result, Down again to the next, Up goes back to the box.
  box.focus();
  fireEvent.keyDown(box, { key: "ArrowDown" });
  expect(document.activeElement).toBe(opens[0]);
  fireEvent.keyDown(opens[0] as HTMLElement, { key: "ArrowDown" });
  expect(document.activeElement).toBe(opens[1]);
  fireEvent.keyDown(opens[1] as HTMLElement, { key: "ArrowUp" });
  expect(document.activeElement).toBe(opens[0]);
  fireEvent.keyDown(opens[0] as HTMLElement, { key: "ArrowUp" });
  expect(document.activeElement).toBe(box);
  // Down at the last result stays on it.
  (opens[2] as HTMLElement).focus();
  fireEvent.keyDown(opens[2] as HTMLElement, { key: "ArrowDown" });
  expect(document.activeElement).toBe(opens[2]);
  // Every button in the search has a name a screen reader can say, and the actions are in Tab's order after their result.
  for (const button of within(dialog).getAllByRole("button")) {
    expect((button.getAttribute("aria-label") ?? button.textContent).trim(), button.outerHTML).not.toBe("");
  }
});

test("an_older_answer_never_replaces_a_newer_one", async () => {
  await unlocked();
  const { dialog, box } = await openSearch();
  const release = shell.holdSearch();
  fireEvent.change(box, { target: { value: "console" } });
  await waitFor(() => {
    expect(searchCalls()).toHaveLength(1);
  });
  // A second word is typed; its answer comes first, and the first word's answer arrives late.
  fireEvent.change(box, { target: { value: "tracker" } });
  await waitFor(() => {
    expect(searchCalls()).toHaveLength(2);
  });
  await act(async () => {
    release();
    await Promise.resolve();
  });
  await result(dialog, /team@example\.com/);
  expect(rowsOf(dialog)).toHaveLength(1);
  expect(within(dialog).queryByText(/admin@example\.com/)).toBeNull();
  expect(within(dialog).queryByText(/Nothing for/)).toBeNull();
});

const TOO_MANY = "Too many matches. Type more of the name.";

test("hidden_kinds_never_make_a_false_nothing_found", async () => {
  // More files than the shell gives one search, all matching, and one login that matches too but ranks after them.
  const files: FakeItem[] = Array.from({ length: SEARCH_LIMIT + 20 }, (_, n) => ({
    id: itemId(0x100 + n),
    kind: "file",
    title: `alpha file ${String(n)}`,
    attachments: [{ file_id: itemId(0x400 + n), name: `a${String(n)}.pdf`, length: 10, media_type: "application/pdf" }],
  }));
  const login: FakeItem = { id: itemId(0x90), kind: "login", title: "alpha login", username: "ada", has_password: true };
  await unlocked([{ id: 7, name: "My vault", items: [...files, login] }]);
  const { dialog, box } = await searchFor("alpha");
  // The shell's limit was spent on files, so the login is not among the answers: the page does not say there is nothing.
  expect(await within(dialog).findByText(TOO_MANY)).toBeTruthy();
  expect(within(dialog).queryByText(/Nothing for/)).toBeNull();
  expect(rowsOf(dialog)).toHaveLength(0);

  // Few matches, all of a kind the search does not show, and the limit not reached: nothing was cut, so it is the plain
  // empty state (4A shows logins and notes).
  fireEvent.change(box, { target: { value: "alpha file 7" } });
  expect(await within(dialog).findByText('Nothing for "alpha file 7"')).toBeTruthy();
  expect(within(dialog).queryByText(TOO_MANY)).toBeNull();

  // Nothing at all matching still says so.
  fireEvent.change(box, { target: { value: "zzzz" } });
  expect(await within(dialog).findByText('Nothing for "zzzz"')).toBeTruthy();
  expect(within(dialog).queryByText(TOO_MANY)).toBeNull();
});

test("a_full_answer_with_results_still_says_some_may_be_missing", async () => {
  const logins: FakeItem[] = Array.from({ length: SEARCH_LIMIT + 5 }, (_, n) => ({
    id: itemId(0x100 + n),
    kind: "login",
    title: `beta ${String(n).padStart(3, "0")}`,
    username: "ada",
    has_password: true,
  }));
  await unlocked([{ id: 7, name: "My vault", items: logins }]);
  const { dialog, box } = await searchFor("beta");
  await within(dialog).findAllByRole("listitem");
  expect(rowsOf(dialog)).toHaveLength(SEARCH_LIMIT);
  expect(within(dialog).getByText(TOO_MANY)).toBeTruthy();
  fireEvent.change(box, { target: { value: "beta 004" } });
  await waitFor(() => {
    expect(rowsOf(dialog)).toHaveLength(1);
  });
  expect(within(dialog).queryByText(TOO_MANY)).toBeNull();
});

test("the_open_buttons_name_only_the_host_and_only_for_addresses_the_shell_opens", async () => {
  const items = sampleItems();
  items[2] = {
    ...items[2],
    urls: [
      "https://ada:hunter2@example.com:8443/path/x?token=abc#frag",
      "  https://lead.example.com/  ",
      "https://exa mple.com",
      "example.org",
      "ftp://f.example.com",
      "https://",
    ],
  } as FakeItem;
  await unlocked([{ id: 7, name: "My vault", items }]);
  fireEvent.click(await screen.findByRole("button", { name: /^Login:\s*Bot admin console/ }));
  const panel = await screen.findByRole("complementary", { name: "Bot admin console" });
  await within(panel).findByText("admin@example.com");

  // One button for each address that parses as http or https (what the shell opens), named by its host alone.
  const opens = within(panel).getAllByRole("button", { name: /^Open/ });
  expect(opens.map((button) => button.getAttribute("aria-label"))).toEqual(["Open example.com", "Open lead.example.com"]);
  // No label or hint anywhere holds a password, a token or a path.
  const hints = Array.from(document.querySelectorAll("[aria-label], [title]")).map(
    (element) => `${element.getAttribute("aria-label") ?? ""} ${element.getAttribute("title") ?? ""}`,
  );
  for (const secret of ["hunter2", "token", "abc", "frag", "8443", "path"]) {
    expect(hints.join("\n"), secret).not.toContain(secret);
  }
  // Nor does the website line show the login or the query.
  expect(panel.textContent).not.toContain("hunter2");
  expect(panel.textContent).not.toContain("token=abc");
  expect(panel.textContent).not.toContain("frag");
  // Each button opens its own address, by number.
  fireEvent.click(opens[1] as HTMLElement);
  await waitFor(() => {
    expect(shell.opened).toMatchObject([{ id: itemId(1), index: 1 }]);
  });
  fireEvent.click(opens[0] as HTMLElement);
  await waitFor(() => {
    expect(shell.opened.at(-1)).toMatchObject({ index: 0 });
  });
});
