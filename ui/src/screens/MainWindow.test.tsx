import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import App from "../App";
import { resetStoreForTests } from "../store";
import { expectNoAxe } from "../testing/axe";
import {
  FOLDER,
  installFakeShell,
  itemId,
  PASSWORD,
  sampleItems,
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
  resetStoreForTests();
  invoke.mockReset();
  listen.mockReset();
  // Only the date: the answers arrive on real timers.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-06T12:00:00Z"));
});

/** The app on its lock screen with `vaults`, unlocked through the screen as a person would. */
async function unlocked(vaults: FakeVault[] = [{ id: 7, name: "My vault", items: sampleItems() }]) {
  shell = installFakeShell(invoke, listen, vaults);
  const view = render(<App />);
  const field = await screen.findByLabelText(/^Password for /);
  fireEvent.change(field, { target: { value: PASSWORD } });
  fireEvent.submit((field as HTMLInputElement).form as HTMLFormElement);
  await screen.findByRole("heading", { level: 1, name: "All items" });
  return view;
}

async function select(title: string) {
  // The kind is said first, then the title: "Login: Bot admin console …".
  const row = new RegExp(String.raw`^(Login|Note|File):\s*${title}`);
  fireEvent.click(await screen.findByRole("button", { name: row }));
  return screen.findByRole("complementary", { name: title });
}

test("items_list_after_unlock", async () => {
  const { container } = await unlocked();
  const list = screen.getByRole("main");
  // Grouped by kind, each group counted; the trashed login and the two folders are not items in the list.
  const groups = within(list)
    .getAllByRole("heading", { level: 2 })
    .map((heading) => heading.textContent);
  expect(groups).toEqual(["Logins2", "Notes1", "Files1"]);
  for (const title of ["Bot admin console", "Error tracker", "Rotation steps", "Client contract"]) {
    expect(within(list).getByText(title)).toBeTruthy();
  }
  expect(within(list).queryByText("Old login in the trash")).toBeNull();
  expect(within(list).queryByText("Agency support agent", { selector: ".rname" })).toBeNull();
  // A login's row shows its username, a file's its name and size, and which folder each is in.
  expect(within(list).getByText("admin@example.com")).toBeTruthy();
  expect(within(list).getByText("contract-demo.pdf · 96 KB")).toBeTruthy();
  // Add is in the toolbar (Task 11); nothing else from a later task: no kind or sort lists.
  expect(screen.getByRole("button", { name: "Add" })).toBeTruthy();
  expect(screen.queryByLabelText("Sort")).toBeNull();
  // The side menu: the vault, All items (counted), the folders, Lock all.
  const side = screen.getByRole("navigation", { name: "Vault and folders" });
  expect(within(side).getByText("My vault")).toBeTruthy();
  expect(within(side).getByRole("button", { name: /^All items/ }).getAttribute("aria-current")).toBe("page");
  expect(within(side).getByRole("button", { name: /^Agency support agent/ })).toBeTruthy();
  expect(within(side).getByRole("button", { name: /^Lineproof/ })).toBeTruthy();
  expect(within(side).getByRole("button", { name: "Lock all" })).toBeTruthy();
  expect(container.querySelectorAll("[style]")).toHaveLength(0);
  expect(container.querySelectorAll("style")).toHaveLength(0);
  await expectNoAxe(container);
});

test("selecting_shows_details_with_password_hidden", async () => {
  const { container } = await unlocked();
  const panel = await select("Bot admin console");
  expect(within(panel).getByRole("heading", { level: 2, name: "Bot admin console" })).toBeTruthy();
  expect(within(panel).getByText("Login · Agency support agent · changed 2 days ago")).toBeTruthy();
  expect(await within(panel).findByText("admin@example.com")).toBeTruthy();
  expect(within(panel).getByText("support.example.com")).toBeTruthy();
  // The password is hidden until Reveal (Task 12), and the shell was never asked for it before.
  const password = within(panel).getByText("Password").closest("div");
  expect(password?.textContent).toContain("••••");
  expect(within(panel).getByRole("button", { name: "Reveal" })).toBeTruthy();
  expect(invoke.mock.calls.some(([cmd]) => cmd === "reveal_password")).toBe(false);
  // Only what the shell sends for the item, with exactly these arguments.
  const live = shell.sessionOf(7);
  expect(invoke).toHaveBeenCalledWith("get_item", {
    session: live?.session,
    generation: live?.generation,
    id: itemId(1),
  });
  // Edit is here (Task 13), and nothing from a later task: no Move, trash, attach. The one Open is the website's (Task 10),
  // through `open_url`.
  expect(within(panel).getByRole("button", { name: "Edit" })).toBeTruthy();
  for (const words of [/^Move/, /trash/i, /attach/i]) {
    expect(within(panel).queryByRole("button", { name: words })).toBeNull();
  }
  expect(within(panel).getAllByRole("button", { name: /^Open/ }).map((button) => button.getAttribute("aria-label"))).toEqual([
    "Open support.example.com",
  ]);
  await expectNoAxe(container);

  // Closing the panel puts the list back and drops the item.
  fireEvent.click(within(panel).getByRole("button", { name: "Close panel" }));
  expect(screen.queryByRole("complementary")).toBeNull();
});

test("a_login_with_no_password_or_site_says_what_it_lacks", async () => {
  const items: FakeItem[] = [{ id: itemId(9), kind: "login", title: "Bare login", username: "", has_password: false, modified_at: "2026-11-06T09:00:00Z" }];
  await unlocked([{ id: 7, name: "My vault", items }]);
  const panel = await select("Bare login");
  expect(await within(panel).findByText("No password saved")).toBeTruthy();
  expect(within(panel).queryByRole("button", { name: "Copy password" })).toBeNull();
  expect(within(panel).getByText("Login · changed today")).toBeTruthy();
});

test("a_note_shows_its_text_and_a_file_its_name", async () => {
  await unlocked();
  const note = await select("Rotation steps");
  expect(await within(note).findByText("Made-up note")).toBeTruthy();
  fireEvent.click(within(note).getByRole("button", { name: "Close panel" }));
  const file = await select("Client contract");
  expect(await within(file).findByText("contract-demo.pdf")).toBeTruthy();
  expect(within(file).getByText("96 KB")).toBeTruthy();
});

test("copy_calls_copy_field_and_shows_clear_time", async () => {
  const { container } = await unlocked();
  const panel = await select("Bot admin console");
  await within(panel).findByText("admin@example.com");
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-06T12:00:00Z"));
  fireEvent.click(within(panel).getByRole("button", { name: "Copy password" }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10);
  });
  const live = shell.sessionOf(7);
  expect(shell.copied).toEqual([{ session: live?.session, generation: live?.generation, id: itemId(1), field: "password" }]);
  // The settings' own delay, counting down each second.
  const status = screen.getByRole("status");
  expect(status.textContent).toContain("Password copied");
  expect(status.textContent).toContain("clears in 30 s");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  expect(screen.getByRole("status").textContent).toContain("clears in 25 s");
  // It never shows the password, or anything the shell sent but the words above.
  expect(container.textContent).not.toContain("Pw-");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(25_000);
  });
  expect(screen.queryByRole("status")?.textContent ?? "").not.toContain("Password copied");
});

test("the_copy_message_has_no_accessibility_problems", async () => {
  const { container } = await unlocked();
  const panel = await select("Bot admin console");
  await within(panel).findByText("admin@example.com");
  fireEvent.click(within(panel).getByRole("button", { name: "Copy password" }));
  await vi.waitFor(() => {
    expect(screen.getByRole("status").textContent).toContain("Password copied");
  });
  await expectNoAxe(container);
});

test("copy_username_and_the_row_button_copy_the_right_field", async () => {
  await unlocked();
  const panel = await select("Bot admin console");
  await within(panel).findByText("admin@example.com");
  fireEvent.click(within(panel).getByRole("button", { name: "Copy username" }));
  await vi.waitFor(() => {
    expect(shell.copied.at(-1)?.field).toBe("username");
  });
  // The row's own copy button copies that login's password.
  fireEvent.click(screen.getByRole("button", { name: "Copy password for Error tracker" }));
  await vi.waitFor(() => {
    expect(shell.copied.at(-1)).toMatchObject({ id: itemId(2), field: "password" });
  });
});

test("a_copy_that_fails_says_so_in_words", async () => {
  await unlocked();
  const panel = await select("Bot admin console");
  await within(panel).findByText("admin@example.com");
  const real = invoke.getMockImplementation();
  if (real === undefined) throw new Error("no fake shell");
  invoke.mockImplementation((cmd: string, args?: unknown) =>
    cmd === "copy_field"
      ? // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- Tauri rejects with the plain object
        Promise.reject({ code: "core", kind: "io" })
      : (real(cmd, args) as Promise<unknown>),
  );
  fireEvent.click(within(panel).getByRole("button", { name: "Copy password" }));
  const alert = await screen.findByRole("alert");
  expect(alert.textContent.length).toBeGreaterThan(5);
  expect(alert.textContent).not.toContain("io");
  // The place that announces a copy stays empty: nothing was copied.
  expect(screen.getByRole("status").textContent).toBe("");
});

test("lock_returns_to_lock_screen", async () => {
  await unlocked();
  const panel = await select("Bot admin console");
  await within(panel).findByText("admin@example.com");
  fireEvent.click(within(panel).getByRole("button", { name: "Copy password" }));
  await vi.waitFor(() => {
    expect(screen.getByRole("status").textContent).toContain("Password copied");
  });

  fireEvent.click(screen.getByRole("button", { name: "Lock all" }));
  expect(await screen.findByRole("heading", { level: 1, name: "Unlock My vault" })).toBeTruthy();
  // Nothing of the vault stays on the page: no title, no username, no panel, no message about a copy.
  const page = document.body.textContent;
  for (const secret of ["Bot admin console", "admin@example.com", "Rotation steps", "Copied", "copied"]) {
    expect(page, secret).not.toContain(secret);
  }
  expect(screen.queryByRole("complementary")).toBeNull();
  expect(screen.queryByRole("status")?.textContent ?? "").toBe("");
  expect(screen.getByLabelText<HTMLInputElement>(/^Password for /).value).toBe("");
});

test("an_idle_lock_does_the_same_without_an_error", async () => {
  await unlocked();
  await select("Bot admin console");
  const live = shell.sessionOf(7);
  if (live === undefined) throw new Error("not open");
  act(() => {
    shell.lock(live.session, "idle");
  });
  expect(await screen.findByRole("heading", { level: 1, name: "Unlock My vault" })).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(document.body.textContent).not.toContain("Bot admin console");
});

test("closed_menu_icons_have_names", async () => {
  const { container } = await unlocked();
  const side = screen.getByRole("navigation", { name: "Vault and folders" });
  fireEvent.click(within(side).getByRole("button", { name: "Close side menu" }));
  // The words are hidden by the style sheet, so each icon carries its name: the screen reader still says it.
  const buttons = within(side).getAllByRole("button");
  for (const button of buttons) {
    expect(button.getAttribute("aria-label") ?? button.textContent, button.outerHTML).toBeTruthy();
  }
  expect(within(side).getByRole("button", { name: "Open side menu" })).toBeTruthy();
  for (const name of ["All items", "Agency support agent", "Lineproof", "Lock all"]) {
    const button = within(side).getByRole("button", { name: new RegExp(`^${name}`) });
    expect(button.getAttribute("aria-label"), name).toContain(name);
  }
  expect(side.className).toContain("closed");
  await expectNoAxe(container);
  fireEvent.click(within(side).getByRole("button", { name: "Open side menu" }));
  expect(side.className).not.toContain("closed");
});

test("long_lines_show_full_text_on_hover", async () => {
  const long = `A very long login name ${"that keeps going ".repeat(12)}and ends here`;
  const items: FakeItem[] = [
    { id: itemId(9), kind: "login", title: long, username: "x@example.com", has_password: true },
    { id: itemId(10), kind: "login", title: "Short", username: "y@example.com", has_password: true },
  ];
  await unlocked([{ id: 7, name: "My vault", items }]);
  const widths = vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function (this: HTMLElement) {
    return this.textContent === long ? 900 : 40;
  });
  const client = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(200);
  try {
    const name = screen.getByText(long);
    const short = screen.getByText("Short");
    // Nothing is set until the pointer is over a line that is cut, and a line that fits never gets one.
    expect(name.getAttribute("title")).toBeNull();
    fireEvent.mouseEnter(name);
    fireEvent.mouseEnter(short);
    expect(name.getAttribute("title")).toBe(long);
    expect(short.getAttribute("title")).toBeNull();
  } finally {
    widths.mockRestore();
    client.mockRestore();
  }
});

test("lock_all_returns_to_the_lock_screen_even_if_the_lock_event_is_lost", async () => {
  await unlocked();
  const panel = await select("Bot admin console");
  await within(panel).findByText("admin@example.com");
  const real = invoke.getMockImplementation();
  if (real === undefined) throw new Error("no fake shell");
  // The shell locks and answers; its `lockbox://locked` never reaches the page.
  invoke.mockImplementation((cmd: string, args?: unknown) =>
    cmd === "lock_all" ? Promise.resolve(null) : (real(cmd, args) as Promise<unknown>),
  );
  fireEvent.click(screen.getByRole("button", { name: "Lock all" }));
  expect(await screen.findByRole("heading", { level: 1, name: "Unlock My vault" })).toBeTruthy();
  expect(document.body.textContent).not.toContain("Bot admin console");
  expect(document.body.textContent).not.toContain("admin@example.com");
});

test("a_folder_picks_its_items", async () => {
  await unlocked();
  const side = screen.getByRole("navigation", { name: "Vault and folders" });
  fireEvent.click(within(side).getByRole("button", { name: /^Agency support agent/ }));
  expect(screen.getByRole("heading", { level: 1, name: "Agency support agent" })).toBeTruthy();
  expect(within(side).getByRole("button", { name: /^Agency support agent/ }).getAttribute("aria-current")).toBe("page");
  const list = screen.getByRole("main");
  expect(within(list).getByText("Bot admin console")).toBeTruthy();
  expect(within(list).getByText("Rotation steps")).toBeTruthy();
  expect(within(list).queryByText("Error tracker")).toBeNull();
  expect(within(list).queryByText("Client contract")).toBeNull();
  // The folder's own list has the folder as its title, and an item with no folder is only in All items.
  fireEvent.click(within(side).getByRole("button", { name: /^All items/ }));
  expect(within(screen.getByRole("main")).getByText("Client contract")).toBeTruthy();
  expect(FOLDER).toHaveLength(32);
});

test("filter_narrows_the_list_with_a_way_to_clear_it", async () => {
  const { container } = await unlocked();
  const filter = screen.getByRole("searchbox", { name: "Filter this list" });
  fireEvent.change(filter, { target: { value: "console" } });
  const list = screen.getByRole("main");
  expect(within(list).getByText("Bot admin console")).toBeTruthy();
  expect(within(list).queryByText("Error tracker")).toBeNull();
  // A filtered list must not look like missing items: it says how many of how many, and offers to clear.
  expect(within(list).getByText("Showing 1 of 4, filtered by “console”.")).toBeTruthy();
  await expectNoAxe(container);
  fireEvent.click(screen.getByRole("button", { name: "Clear filter" }));
  expect(within(screen.getByRole("main")).getByText("Error tracker")).toBeTruthy();
  expect(screen.getByRole<HTMLInputElement>("searchbox", { name: "Filter this list" }).value).toBe("");
  // Nothing matching says so.
  fireEvent.change(screen.getByRole("searchbox", { name: "Filter this list" }), { target: { value: "zzzz" } });
  expect(within(screen.getByRole("main")).getByText("Nothing matches “zzzz”.")).toBeTruthy();
});

test("a_locked_vault_is_named_in_a_line", async () => {
  await unlocked([
    { id: 7, name: "My vault", items: sampleItems() },
    { id: 8, name: "Home", items: sampleItems() },
  ]);
  expect(screen.getByText("Home is locked, so its items aren't listed.")).toBeTruthy();
});

test("an_empty_vault_says_so", async () => {
  const { container } = await unlocked([{ id: 7, name: "My vault", items: [] }]);
  // 21g: what it is, and what to do first. Nothing here leads to a screen a later task builds.
  expect(screen.getByText("Your vault is empty")).toBeTruthy();
  expect(screen.getByText("What to do first: add a login, or a key, a note or a file.")).toBeTruthy();
  // Add is right there too (Task 12): the three kinds that can be made, and nothing from a later task.
  const list = screen.getByRole("main").querySelector<HTMLElement>(".lscroll");
  expect(list).not.toBeNull();
  expect(within(list as HTMLElement).getAllByRole("button").map((button) => button.textContent)).toEqual(["Login", "Key", "Note"]);
  await expectNoAxe(container);
});

// Folders in the side menu, or something in the trash: "Your vault is empty" would be untrue.
test("a_vault_with_only_folders_is_not_called_empty", async () => {
  await unlocked([{ id: 7, name: "My vault", items: [{ id: FOLDER, kind: "collection", title: "Agency support agent" }] }]);
  expect(screen.getByText("Nothing in this vault yet.")).toBeTruthy();
  expect(screen.queryByText("Your vault is empty")).toBeNull();
});

test("a_vault_with_only_trash_is_not_called_empty", async () => {
  await unlocked([{ id: 8, name: "Trash only", items: [{ id: itemId(9), kind: "login", title: "Gone", trashed: true }] }]);
  expect(screen.getByText("Nothing in this vault yet.")).toBeTruthy();
  expect(screen.queryByText("Your vault is empty")).toBeNull();
});

test("an_empty_folder_says_so_in_its_own_words", async () => {
  await unlocked([{ id: 7, name: "My vault", items: [{ id: FOLDER, kind: "collection", title: "Agency support agent" }] }]);
  fireEvent.click(screen.getByRole("button", { name: /^Agency support agent/ }));
  expect(await screen.findByText("Nothing in Agency support agent yet.")).toBeTruthy();
  expect(screen.queryByText("Your vault is empty")).toBeNull();
});
