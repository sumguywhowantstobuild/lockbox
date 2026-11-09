// Task 11's screens: Add and the new-login form (6a to 6d), the generator inside the form (6c) and as a page (16a), and
// what a lock does to a form half typed.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import App from "../App";
import { resetStoreForTests } from "../store";
import { expectNoAxe } from "../testing/axe";
import { readBeside } from "../testing/files";
import {
  FOLDER,
  installFakeShell,
  PASSWORD,
  sampleItems,
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
/// Made up, and not any real password.
const TYPED_PASSWORD = "Typed-by-hand-4471";

function vaults(): FakeVault[] {
  return [{ id: 7, name: "My vault", items: sampleItems() }];
}

/** The app on its lock screen with `list`, then the first vault unlocked through the screen as a person would. */
async function unlocked(list: FakeVault[] = vaults(), settings?: { idle_minutes: number; clipboard_seconds: number }) {
  shell = installFakeShell(invoke, listen, list, settings);
  const view = render(<App />);
  await unlockThroughTheScreen();
  return view;
}

async function unlockThroughTheScreen() {
  const field = await screen.findByLabelText(/^Password for /);
  fireEvent.change(field, { target: { value: PASSWORD } });
  fireEvent.submit((field as HTMLInputElement).form as HTMLFormElement);
  await screen.findByRole("heading", { level: 1, name: "All items" });
}

function addButton(): HTMLElement {
  return screen.getByRole("button", { name: "Add" });
}

/** Add, then Login, as a person would with the pointer. */
async function openForm(): Promise<{ add: HTMLElement; form: HTMLElement }> {
  const add = addButton();
  add.focus();
  fireEvent.pointerDown(add, { button: 0 });
  fireEvent.click(add);
  const menu = await screen.findByRole("menu");
  fireEvent.click(within(menu).getByRole("menuitem", { name: "Login" }));
  const form = await screen.findByRole("complementary", { name: "New login" });
  return { add, form };
}

function typeInto(form: HTMLElement, label: string, value: string) {
  fireEvent.change(within(form).getByLabelText(label), { target: { value } });
}

function inputOf(form: HTMLElement, label: string): HTMLInputElement {
  return within(form).getByLabelText<HTMLInputElement>(label);
}

/** What the generator shows now: the read-only text a screen reader reads as "Generated password". */
function shownValue(root: HTMLElement): string {
  return within(root).getByRole("textbox", { name: "Generated password" }).textContent;
}

function sent(cmd: string): unknown[] {
  return invoke.mock.calls.filter(([name]) => name === cmd).map(([, args]): unknown => args);
}

test("add_then_login_opens_the_form", async () => {
  const { container } = await unlocked();
  // Add sits in the toolbar, at its right end, and opens a menu: Login is the only kind in this version.
  const add = addButton();
  expect(add.closest(".tb")).not.toBeNull();
  expect(add.getAttribute("aria-haspopup")).toBe("menu");
  fireEvent.pointerDown(add, { button: 0 });
  fireEvent.click(add);
  const menu = await screen.findByRole("menu");
  expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Login"]);
  fireEvent.click(within(menu).getByRole("menuitem", { name: "Login" }));

  const form = await screen.findByRole("complementary", { name: "New login" });
  expect(within(form).getByRole("heading", { level: 2, name: "New login" })).toBeTruthy();
  // Where it will go: no folder is on screen, so it is in the vault alone.
  expect(within(form).getByText("In My vault.")).toBeTruthy();
  const title = inputOf(form, "Title");
  await waitFor(() => {
    expect(document.activeElement).toBe(title);
  });
  for (const label of ["Title", "Username", "Website"]) {
    expect(inputOf(form, label).type, label).toBe("text");
    expect(inputOf(form, label).autocomplete, label).toBe("off");
  }
  expect(within(form).getByText("https:// is added on save if it's missing.")).toBeTruthy();
  const password = inputOf(form, "Password");
  expect(password.type).toBe("password");
  expect(password.autocomplete).toBe("off");
  expect(within(form).getByRole("button", { name: "Generate" })).toBeTruthy();
  expect(within(form).getByRole("combobox", { name: "Folder" }).textContent).toBe("No folder");
  expect(within(form).getByRole("button", { name: "Cancel" })).toBeTruthy();
  expect(within(form).getByRole("button", { name: "Save" })).toBeTruthy();
  // The generator is closed until it is asked for, and nothing has gone to the shell.
  expect(within(form).queryByRole("textbox", { name: "Generated password" })).toBeNull();
  expect(sent("new_item")).toEqual([]);
  // No style in what the page draws but the library's own hidden input for the folder list, which it sets by script.
  const styled = Array.from(container.querySelectorAll("[style]")).filter(
    (element) => !(element instanceof HTMLInputElement && element.getAttribute("aria-hidden") === "true"),
  );
  expect(styled.map((element) => element.outerHTML)).toEqual([]);
  expect(container.querySelectorAll("style")).toHaveLength(0);
  await expectNoAxe(container);

  // Cancel closes it, sends nothing, and gives focus back to Add.
  fireEvent.click(within(form).getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("complementary")).toBeNull();
  await waitFor(() => {
    expect(document.activeElement).toBe(addButton());
  });
  expect(sent("new_item")).toEqual([]);

  // With a folder on screen it is in that folder, and the list of folders starts with it, "No folder" last.
  fireEvent.click(within(screen.getByRole("navigation", { name: "Vault and folders" })).getByRole("button", { name: /^Agency support agent/ }));
  const inFolder = (await openForm()).form;
  expect(within(inFolder).getByText("In Agency support agent, My vault.")).toBeTruthy();
  const folder = within(inFolder).getByRole("combobox", { name: "Folder" });
  expect(folder.textContent).toBe("Agency support agent");
  fireEvent.pointerDown(folder, { button: 0 });
  fireEvent.click(folder);
  const options = await screen.findAllByRole("option");
  expect(options.map((option) => option.textContent)).toEqual(["Agency support agent", "Lineproof", "No folder"]);
  // Picking another folder changes where the form says it will go.
  fireEvent.pointerDown(options[1] as HTMLElement);
  fireEvent.click(options[1] as HTMLElement);
  await waitFor(() => {
    expect(within(inFolder).getByText("In Lineproof, My vault.")).toBeTruthy();
  });
});

test("nothing_found_offers_new_login", async () => {
  await unlocked();
  fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
  const dialog = await screen.findByRole("dialog", { name: SEARCH });
  fireEvent.change(within(dialog).getByRole("textbox", { name: SEARCH }), { target: { value: "zzzz" } });
  // 2d's words, with the clause the design adds, and New item first at the foot.
  expect(await within(dialog).findByText('Nothing for "zzzz"')).toBeTruthy();
  expect(within(dialog).getByText("Try another word, or add a new login.")).toBeTruthy();
  const foot = within(dialog).getAllByRole("button").filter((button) => ["New item", "Lock all", "Close"].includes(button.textContent));
  expect(foot.map((button) => button.textContent)).toEqual(["New item", "Lock all", "Close"]);

  fireEvent.click(within(dialog).getByRole("button", { name: "New item" }));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  // The same form as Add's, its title started with what was typed (the name that was being looked for).
  const form = await screen.findByRole("complementary", { name: "New login" });
  const title = inputOf(form, "Title");
  expect(title.value).toBe("zzzz");
  await waitFor(() => {
    expect(document.activeElement).toBe(title);
  });
  fireEvent.click(within(form).getByRole("button", { name: "Cancel" }));
  await waitFor(() => {
    expect(document.activeElement).toBe(addButton());
  });

  // New item is also there when something was found, and with nothing typed the title starts empty.
  fireEvent.keyDown(document.body, { key: "f", ctrlKey: true });
  const again = await screen.findByRole("dialog", { name: SEARCH });
  fireEvent.click(within(again).getByRole("button", { name: "New item" }));
  const blank = await screen.findByRole("complementary", { name: "New login" });
  expect(inputOf(blank, "Title").value).toBe("");
});

test("generate_fills_the_password_field", async () => {
  const { container } = await unlocked();
  const { form } = await openForm();
  fireEvent.click(within(form).getByRole("button", { name: "Generate" }));
  // The shell makes one at the start size, with letters, numbers and symbols; it is shown, and in nothing else.
  await waitFor(() => {
    expect(shownValue(form)).toHaveLength(24);
  });
  expect(sent("generate_password")).toEqual([
    { options: { length: 24, lowercase: true, uppercase: true, digits: true, symbols: true, avoid_ambiguous: false } },
  ]);
  const made = shownValue(form);
  await expectNoAxe(container);
  expect(inputOf(form, "Password").value).toBe("");

  fireEvent.click(within(form).getByRole("button", { name: "Use this" }));
  // The field has it, hidden, and the generator has closed.
  expect(inputOf(form, "Password").value).toBe(made);
  expect(inputOf(form, "Password").type).toBe("password");
  expect(within(form).queryByRole("textbox", { name: "Generated password" })).toBeNull();
  expect(document.activeElement).toBe(inputOf(form, "Password"));
  // It is in no label, title or address.
  for (const element of container.querySelectorAll("*")) {
    for (const name of element.getAttributeNames()) {
      if (name === "value") continue;
      expect(element.getAttribute(name), `${element.tagName} ${name}`).not.toContain(made);
    }
  }
  // Saved, it goes to the shell as the login's password, with the rest, in the one call.
  typeInto(form, "Title", "Generated one");
  fireEvent.click(within(form).getByRole("button", { name: "Save" }));
  await screen.findByRole("complementary", { name: "Generated one" });
  expect(shell.made.at(-1)?.fields).toMatchObject({ password: made });
  expect(sent("copy_generated")).toEqual([]);
});

test("generator_length_and_types_change_the_value", async () => {
  await unlocked();
  const { form } = await openForm();
  fireEvent.click(within(form).getByRole("button", { name: "Generate" }));
  await waitFor(() => {
    expect(shownValue(form)).toHaveLength(24);
  });
  const options = () => sent("generate_password").map((args) => (args as { options: Record<string, unknown> }).options);
  const length = within(form).getByRole<HTMLInputElement>("slider", { name: "Length" });
  expect([length.min, length.max, length.value]).toEqual(["12", "64", "24"]);

  fireEvent.change(length, { target: { value: "40" } });
  await waitFor(() => {
    expect(shownValue(form)).toHaveLength(40);
  });
  expect(options().at(-1)).toMatchObject({ length: 40, digits: true, symbols: true });

  fireEvent.click(within(form).getByRole("checkbox", { name: "Numbers" }));
  await waitFor(() => {
    expect(options().at(-1)).toMatchObject({ length: 40, digits: false, symbols: true });
  });
  await waitFor(() => {
    expect(shownValue(form)).not.toMatch(/\d/);
  });
  fireEvent.click(within(form).getByRole("checkbox", { name: "Symbols" }));
  await waitFor(() => {
    expect(options().at(-1)).toMatchObject({ length: 40, digits: false, symbols: false });
  });
  await waitFor(() => {
    expect(shownValue(form)).toMatch(/^[A-Za-z]{40}$/);
  });

  // Try another asks again with the same choices and shows a different value.
  const before = shownValue(form);
  const asked = options().length;
  fireEvent.click(within(form).getByRole("button", { name: "Try another" }));
  await waitFor(() => {
    expect(options()).toHaveLength(asked + 1);
  });
  expect(options().at(-1)).toEqual(options().at(-2));
  await waitFor(() => {
    expect(shownValue(form)).not.toBe(before);
  });
  expect(shownValue(form)).toHaveLength(40);
});

test("passphrase_option_works", async () => {
  await unlocked();
  const { form } = await openForm();
  fireEvent.click(within(form).getByRole("button", { name: "Generate" }));
  const characters = within(form).getByRole("button", { name: "Characters" });
  const passphrase = within(form).getByRole("button", { name: "Passphrase" });
  expect(characters.getAttribute("aria-pressed")).toBe("true");
  expect(passphrase.getAttribute("aria-pressed")).toBe("false");

  fireEvent.click(passphrase);
  expect(passphrase.getAttribute("aria-pressed")).toBe("true");
  // Five words joined with hyphens, each starting with a capital, one of them with a number (Numbers is on); the size is
  // words now, and symbols are not a thing.
  await waitFor(() => {
    expect(shownValue(form)).toMatch(/^([A-Z][a-z]+\d?-){4}[A-Z][a-z]+\d?$/);
  });
  expect(shownValue(form).match(/\d/g)).toHaveLength(1);
  expect(sent("generate_passphrase").at(-1)).toEqual({
    options: { words: 5, separator: "-", capitalize: true, include_number: true },
  });
  const words = within(form).getByRole<HTMLInputElement>("slider", { name: "Words" });
  expect([words.min, words.max, words.value]).toEqual(["3", "12", "5"]);
  expect(within(form).queryByRole("checkbox", { name: "Symbols" })).toBeNull();
  expect(within(form).queryByRole("slider", { name: "Length" })).toBeNull();

  fireEvent.change(words, { target: { value: "8" } });
  await waitFor(() => {
    expect(shownValue(form).split("-")).toHaveLength(8);
  });
  fireEvent.click(within(form).getByRole("checkbox", { name: "Numbers" }));
  await waitFor(() => {
    expect(shownValue(form)).not.toMatch(/\d/);
  });
  expect(sent("generate_passphrase").at(-1)).toMatchObject({ options: { words: 8, include_number: false } });

  // Use this puts the phrase in the field; going back to characters kept the size it had.
  const phrase = shownValue(form);
  fireEvent.click(within(form).getByRole("button", { name: "Use this" }));
  expect(inputOf(form, "Password").value).toBe(phrase);
  fireEvent.click(within(form).getByRole("button", { name: "Generate" }));
  const again = within(form).getByRole("button", { name: "Characters" });
  expect(again.getAttribute("aria-pressed")).toBe("true");
  await waitFor(() => {
    expect(shownValue(form)).toHaveLength(24);
  });
});

test("same_title_is_allowed", async () => {
  await unlocked();
  const list = screen.getByRole("main");
  expect(within(list).getAllByText("Bot admin console")).toHaveLength(1);
  const { form } = await openForm();
  typeInto(form, "Title", "Bot admin console");
  typeInto(form, "Username", "other@example.com");
  fireEvent.click(within(form).getByRole("button", { name: "Save" }));
  const panel = await screen.findByRole("complementary", { name: "Bot admin console" });
  expect(await within(panel).findByText("other@example.com")).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
  // Two logins with one title, told apart by their usernames in the list.
  await waitFor(() => {
    expect(within(list).getAllByText("Bot admin console")).toHaveLength(2);
  });
  expect(within(list).getByText("admin@example.com")).toBeTruthy();
  expect(within(list).getByText("other@example.com")).toBeTruthy();
  expect(shell.made).toHaveLength(1);
});

test("save_then_copy_password_offered", async () => {
  const { container } = await unlocked();
  const { form } = await openForm();
  typeInto(form, "Title", "Support portal");
  typeInto(form, "Username", "ada@example.com");
  typeInto(form, "Website", "support.example.com");
  typeInto(form, "Password", TYPED_PASSWORD);
  fireEvent.click(within(form).getByRole("button", { name: "Save" }));

  // The login opens with its details and "Saved", and the form is gone.
  const panel = await screen.findByRole("complementary", { name: "Support portal" });
  expect(screen.queryByRole("complementary", { name: "New login" })).toBeNull();
  expect(await screen.findByText("Saved")).toBeTruthy();
  expect(await within(panel).findByText("ada@example.com")).toBeTruthy();
  // The website goes as typed (the shell adds https://), and the whole login goes in one call, in the folder on screen.
  const live = shell.sessionOf(7);
  expect(shell.made).toEqual([
    {
      session: live?.session,
      generation: live?.generation,
      kind: "login",
      title: "Support portal",
      collection: null,
      fields: { username: "ada@example.com", password: TYPED_PASSWORD, urls: ["support.example.com"] },
    },
  ]);
  expect(sent("new_item")).toHaveLength(1);
  expect(within(panel).getByText("support.example.com")).toBeTruthy();
  // Focus is on the saved login's name, a Tab from its Copy buttons.
  await waitFor(() => {
    expect(document.activeElement).toBe(within(panel).getByRole("heading", { level: 2, name: "Support portal" }));
  });
  expect(container.textContent).not.toContain(TYPED_PASSWORD);

  // Copy password is offered, and copies it in Rust like any login's.
  fireEvent.click(await within(panel).findByRole("button", { name: "Copy password" }));
  await waitFor(() => {
    expect(shell.copied).toHaveLength(1);
  });
  expect(shell.copied[0]).toMatchObject({ field: "password" });
  await waitFor(() => {
    expect(screen.getByText("Password copied")).toBeTruthy();
  });
  await expectNoAxe(container);
});

test("no_generator_link_on_lock_screen", async () => {
  shell = installFakeShell(invoke, listen, vaults());
  const { container } = render(<App />);
  await screen.findByLabelText(/^Password for /);
  expect(screen.queryByText("Generator")).toBeNull();
  expect(screen.queryByRole("button", { name: /Generator/ })).toBeNull();
  expect(container.querySelector(".navgen")).toBeNull();

  await unlockThroughTheScreen();
  const side = screen.getByRole("navigation", { name: "Vault and folders" });
  const generator = within(side).getByRole("button", { name: "Generator" });
  fireEvent.click(generator);
  const page = await screen.findByRole("complementary", { name: "Generator" });
  expect(within(page).getByRole("heading", { level: 2, name: "Generator" })).toBeTruthy();

  // Locked again: the lock screen has none, and the page is gone.
  fireEvent.click(within(side).getByRole("button", { name: "Lock all" }));
  await screen.findByLabelText(/^Password for /);
  expect(screen.queryByText("Generator")).toBeNull();
  expect(screen.queryByRole("complementary")).toBeNull();
  expect(container.querySelector(".navgen")).toBeNull();
});

test("generator_copy_shows_clear_time", async () => {
  const { container } = await unlocked(vaults(), { idle_minutes: 5, clipboard_seconds: 45 });
  const side = screen.getByRole("navigation", { name: "Vault and folders" });
  const generator = within(side).getByRole("button", { name: "Generator" });
  generator.focus();
  fireEvent.click(generator);
  const page = await screen.findByRole("complementary", { name: "Generator" });
  await waitFor(() => {
    expect(document.activeElement).toBe(within(page).getByRole("heading", { level: 2, name: "Generator" }));
  });
  expect(within(page).getByRole("button", { name: "Characters" }).getAttribute("aria-pressed")).toBe("true");
  expect(within(page).getByRole("button", { name: "Passphrase" })).toBeTruthy();
  await waitFor(() => {
    expect(shownValue(page)).toHaveLength(24);
  });
  // The settings' own delay is in the words, and the page keeps nothing.
  expect(
    await within(page).findByText(
      "Clears from the clipboard after 45 seconds, like any password. Lockbox doesn't keep it unless you save it in an item.",
    ),
  ).toBeTruthy();
  await expectNoAxe(container);

  const value = shownValue(page);
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-06T12:00:00Z"));
  fireEvent.click(within(page).getByRole("button", { name: "Copy" }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10);
  });
  // Through the shell, which copies it with the marks and timer of any copy: never the page's own clipboard.
  const live = shell.sessionOf(7);
  expect(shell.generated).toEqual([{ session: live?.session, generation: live?.generation, value }]);
  expect(shell.copied).toEqual([]);
  const status = screen.getByRole("status");
  expect(status.textContent).toContain("Password copied");
  expect(status.textContent).toContain("clears in 45 s");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  expect(screen.getByRole("status").textContent).toContain("clears in 40 s");
  // The value is on the page only where it is shown; it is in no message.
  expect(screen.getByRole("status").textContent).not.toContain(value);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(40_000);
  });
  expect(screen.queryByRole("status")?.textContent ?? "").not.toContain("Password copied");
  // Closing the page gives focus back to the Generator button.
  vi.useRealTimers();
  fireEvent.click(within(page).getByRole("button", { name: "Close panel" }));
  expect(screen.queryByRole("complementary")).toBeNull();
  await waitFor(() => {
    expect(document.activeElement).toBe(generator);
  });
});

test("lock_loses_the_form_with_no_error", async () => {
  await unlocked();
  const { form } = await openForm();
  typeInto(form, "Title", "Draft title");
  typeInto(form, "Password", TYPED_PASSWORD);
  fireEvent.click(within(form).getByRole("button", { name: "Generate" }));
  await waitFor(() => {
    expect(shownValue(form)).toHaveLength(24);
  });
  const generated = shownValue(form);

  // A lock while the form is open: it goes with the vault's screen, saying nothing, and nothing was saved.
  const live = shell.sessionOf(7);
  act(() => {
    shell.lock(live?.session ?? 0);
  });
  await screen.findByLabelText(/^Password for /);
  expect(screen.queryByRole("complementary")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  const page = document.body.textContent;
  for (const secret of ["Draft title", TYPED_PASSWORD, generated]) expect(page, secret).not.toContain(secret);
  for (const input of document.querySelectorAll("input")) {
    for (const secret of ["Draft title", TYPED_PASSWORD, generated]) expect(input.value).not.toContain(secret);
  }
  expect(sent("new_item")).toEqual([]);
  expect(shell.made).toEqual([]);

  // Unlocked again, the form is not there, and nothing of it comes back.
  await unlockThroughTheScreen();
  expect(screen.queryByRole("complementary")).toBeNull();
  const again = (await openForm()).form;
  expect(inputOf(again, "Title").value).toBe("");
  expect(inputOf(again, "Password").value).toBe("");

  // A lock while the save is on its way: the login was written, the answer is dropped, and nothing is said.
  typeInto(again, "Title", "Saved while locking");
  const release = shell.holdNewItem();
  fireEvent.click(within(again).getByRole("button", { name: "Save" }));
  await waitFor(() => {
    expect(shell.made).toHaveLength(1);
  });
  act(() => {
    shell.lock(shell.sessionOf(7)?.session ?? 0);
  });
  await screen.findByLabelText(/^Password for /);
  await act(async () => {
    release();
    await Promise.resolve();
  });
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByRole("complementary")).toBeNull();
  expect(document.body.textContent).not.toContain("Saved while locking");
  expect(document.body.textContent).not.toContain("Saved");
});

test("a_save_the_shell_refuses_is_said_in_words_and_the_form_stays", async () => {
  await unlocked();
  const { form } = await openForm();
  typeInto(form, "Title", "Odd site");
  typeInto(form, "Website", "javascript:alert(1)");
  typeInto(form, "Password", TYPED_PASSWORD);
  fireEvent.click(within(form).getByRole("button", { name: "Save" }));
  const alert = await within(form).findByRole("alert");
  expect(alert.textContent).toBe("That isn't a web address Lockbox can open. Use one that starts with http:// or https://.");
  // Nothing was made, and the form kept what was typed, to be put right.
  expect(shell.made).toEqual([]);
  expect(inputOf(form, "Title").value).toBe("Odd site");
  expect(inputOf(form, "Password").value).toBe(TYPED_PASSWORD);
  typeInto(form, "Website", "support.example.com");
  fireEvent.click(within(form).getByRole("button", { name: "Save" }));
  await screen.findByRole("complementary", { name: "Odd site" });
  expect(shell.made).toHaveLength(1);
});

test("a_title_is_needed_before_saving", async () => {
  const { container } = await unlocked();
  const { form } = await openForm();
  fireEvent.click(within(form).getByRole("button", { name: "Save" }));
  expect((await within(form).findByRole("alert")).textContent).toBe("Type a title first.");
  expect(inputOf(form, "Title").getAttribute("aria-invalid")).toBe("true");
  expect(document.activeElement).toBe(inputOf(form, "Title"));
  expect(sent("new_item")).toEqual([]);
  await expectNoAxe(container);
});

test("a_vault_opened_from_a_backup_has_no_add_but_still_has_the_generator", async () => {
  await unlocked([{ id: 7, name: "My vault", readOnly: true, items: sampleItems() }]);
  expect(screen.queryByRole("button", { name: "Add" })).toBeNull();
  expect(screen.getByRole("button", { name: "Generator" })).toBeTruthy();
  fireEvent.keyDown(document.body, { key: "f", ctrlKey: true });
  const dialog = await screen.findByRole("dialog", { name: SEARCH });
  fireEvent.change(within(dialog).getByRole("textbox", { name: SEARCH }), { target: { value: "zzzz" } });
  expect(await within(dialog).findByText("Try another word.")).toBeTruthy();
  expect(within(dialog).queryByRole("button", { name: "New item" })).toBeNull();
  expect(dialog.textContent).not.toContain("add a new login");
});

/** A selection that holds all of `element`'s text, as dragging over it or Select all would. */
function select(element: HTMLElement) {
  const range = document.createRange();
  range.selectNodeContents(element);
  const selection = document.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

test("generated_value_cannot_be_copied_natively", async () => {
  await unlocked();
  // The style sheet makes the value unselectable (a class, no inline style).
  const css = readBeside(import.meta.url, "../styles/components.css");
  expect(/\.gout\s*\{[^}]*user-select:\s*none/.test(css)).toBe(true);

  // On the Generator page: a native copy or cut of the value is stopped; Ctrl+C is the Copy button (through the shell).
  fireEvent.click(within(screen.getByRole("navigation", { name: "Vault and folders" })).getByRole("button", { name: "Generator" }));
  const page = await screen.findByRole("complementary", { name: "Generator" });
  await waitFor(() => {
    expect(shownValue(page)).toHaveLength(24);
  });
  const value = within(page).getByRole("textbox", { name: "Generated password" });
  expect(value.getAttribute("style")).toBeNull();
  // Ordinary text copied with a control of the generator focused is ordinary: the password does not stand in for it.
  const slider = within(page).getByRole("slider", { name: "Length" });
  slider.focus();
  select(within(page).getByText("Length"));
  expect(fireEvent.copy(slider)).toBe(true);
  expect(fireEvent.cut(slider)).toBe(true);
  expect(fireEvent.copy(document.body)).toBe(true);
  expect(shell.generated).toEqual([]);
  document.getSelection()?.removeAllRanges();
  // Aimed at the value: focus on its box with nothing else selected.
  value.focus();
  expect(fireEvent.cut(value)).toBe(false);
  expect(shell.generated).toEqual([]);
  expect(fireEvent.copy(value)).toBe(false);
  await waitFor(() => {
    expect(shell.generated).toHaveLength(1);
  });
  expect(shell.generated[0]?.value).toBe(shownValue(page));
  value.blur();
  // A selection that holds the value, copied from anywhere, is stopped the same way.
  select(value);
  expect(fireEvent.copy(document.body)).toBe(false);
  expect(fireEvent.cut(document.body)).toBe(false);
  document.getSelection()?.removeAllRanges();
  // Any other copy is left alone.
  expect(fireEvent.copy(document.body)).toBe(true);
  fireEvent.click(within(page).getByRole("button", { name: "Close panel" }));
  expect(screen.queryByRole("complementary")).toBeNull();
  await waitFor(() => {
    expect(document.activeElement).toBe(within(screen.getByRole("navigation", { name: "Vault and folders" })).getByRole("button", { name: "Generator" }));
  });

  // In the form: the value is stopped and nothing is copied at all (Use this is its only way out); the form's own fields copy as always.
  const { form } = await openForm();
  fireEvent.click(within(form).getByRole("button", { name: "Generate" }));
  await waitFor(() => {
    expect(shownValue(form)).toHaveLength(24);
  });
  const inForm = within(form).getByRole("textbox", { name: "Generated password" });
  const before = shell.generated.length;
  const formSlider = within(form).getByRole("slider", { name: "Length" });
  formSlider.focus();
  select(within(form).getByText("Length"));
  expect(fireEvent.copy(formSlider)).toBe(true);
  document.getSelection()?.removeAllRanges();
  inForm.focus();
  expect(fireEvent.copy(inForm)).toBe(false);
  expect(fireEvent.cut(inForm)).toBe(false);
  select(inForm);
  expect(fireEvent.copy(document.body)).toBe(false);
  document.getSelection()?.removeAllRanges();
  inputOf(form, "Title").focus();
  expect(fireEvent.copy(inputOf(form, "Title"))).toBe(true);
  expect(shell.generated).toHaveLength(before);
  // Once the generator has closed the listener is gone: copying is not interfered with.
  fireEvent.click(within(form).getByRole("button", { name: "Generate" }));
  expect(fireEvent.copy(document.body)).toBe(true);
});

test("a_login_added_in_a_folder_lands_in_it", async () => {
  await unlocked();
  fireEvent.click(within(screen.getByRole("navigation", { name: "Vault and folders" })).getByRole("button", { name: /^Agency support agent/ }));
  const { form } = await openForm();
  typeInto(form, "Title", "In the folder");
  fireEvent.click(within(form).getByRole("button", { name: "Save" }));
  await screen.findByRole("complementary", { name: "In the folder" });
  expect(shell.made.at(-1)?.collection).toBe(FOLDER);
  expect(screen.getByText(/^Login · Agency support agent/)).toBeTruthy();
});
