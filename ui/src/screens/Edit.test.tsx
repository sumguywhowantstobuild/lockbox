// Task 13's screens: Edit on a login, a key, a note and a file (11a, 7a, 7b, 10f), a login's earlier passwords (11b), the
// vault opened read-only (11c), and what Cancel, a lock and a changed item do to an edit in progress. The password and a
// key's value an edit needs are asked of Rust when Edit opens and live only in the form; the form sends a field only when
// it was changed.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import App from "../App";
import { debugState, resetStoreForTests } from "../store";
import { expectNoAxe } from "../testing/axe";
import { FOLDER, installFakeShell, itemId, PASSWORD, sampleItems, type FakeItem, type FakeShell } from "../testing/fakeShell";

const { invoke, listen } = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

let shell: FakeShell;
/** The fake vault's own items, so a test can change one the way another program would. */
let stored: FakeItem[];

beforeEach(() => {
  for (const style of document.querySelectorAll("style")) style.remove();
  resetStoreForTests();
  invoke.mockReset();
  listen.mockReset();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-06T12:00:00Z"));
});

/// Made up, and not any real password or key.
const NOW_PW = "demo-current-pass-9921";
const OLD_ONE = "demo-older-pass-1100";
const OLD_TWO = "demo-oldest-pass-0042";
const OLD_THREE = "demo-ancient-pass-0007";
const NEW_PW = "demo-typed-new-pass-5150";
const BOT_TOKEN = "demo-telegram-7741-xxxx";
const NEW_TOKEN = "demo-new-token-3318";
const MULTI_PW = "demo-line-one\ndemo-line-two\r\n";
const MULTI_KEY = "demo-key-line-one\ndemo-key-line-two";
const MORE_THAN_ONE_LINE =
  "This value has more than one line, so it isn't shown here. Leave the box empty to keep it, or type a new one.";
const ONE_LINE_ONLY = "That value has more than one line, so it wasn't pasted. A key's value is one line here.";
const CHANGED_MEANWHILE = "This item changed while you were editing it. Nothing was saved. Cancel, then open it again to see the change.";

function items(): FakeItem[] {
  const list = sampleItems().map(
    (item): FakeItem =>
      item.id === itemId(1)
        ? {
            ...item,
            password: NOW_PW,
            previous: [
              { password: OLD_ONE, replaced_at: "2026-11-06T09:00:00Z" },
              { password: OLD_TWO, replaced_at: "2026-03-12T08:00:00Z" },
              { password: OLD_THREE, replaced_at: "2025-11-09T08:00:00Z" },
            ],
          }
        : item,
  );
  return [
    ...list,
    {
      id: itemId(20),
      kind: "key",
      title: "TELEGRAM_BOT_TOKEN",
      collection: FOLDER,
      value: BOT_TOKEN,
      notes: "rotate monthly",
      modified_at: "2026-11-04T09:00:00Z",
    },
    { id: itemId(21), kind: "key", title: "SPACED_KEY", collection: FOLDER, value: MULTI_KEY, modified_at: "2026-11-04T09:00:00Z" },
    {
      id: itemId(30),
      kind: "login",
      title: "Multi-line login",
      username: "m@example.com",
      urls: ["https://multi.example"],
      has_password: true,
      password: MULTI_PW,
      modified_at: "2026-11-04T09:00:00Z",
    },
  ];
}

async function unlocked(readOnly = false) {
  stored = items();
  shell = installFakeShell(invoke, listen, [{ id: 7, name: "My vault", items: stored, readOnly }]);
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

/** Opens the item's details by its row, and waits until the panel has what Edit needs (or says the vault is read-only). */
async function select(title: string) {
  const row = new RegExp(String.raw`^(Login|Key|Note|File):\s*${title}`);
  fireEvent.click(await screen.findByRole("button", { name: row }));
  const panel = await screen.findByRole("complementary", { name: title });
  await waitFor(() => {
    expect(within(panel).queryByRole("button", { name: "Edit" }) ?? within(panel).queryByText("Read-only")).not.toBeNull();
  });
  return panel;
}

function editButton(panel: HTMLElement): HTMLElement {
  return within(panel).getByRole("button", { name: "Edit" });
}

/** Edit on the item, as a person would: the form named `name`, with the stored values asked for and shown. */
async function openEdit(title: string, name: string): Promise<HTMLElement> {
  const panel = await select(title);
  fireEvent.click(editButton(panel));
  return screen.findByRole("complementary", { name });
}

function typeInto(form: HTMLElement, label: string, value: string) {
  fireEvent.change(within(form).getByLabelText(label), { target: { value } });
}

function inputOf(form: HTMLElement, label: string): HTMLInputElement {
  return within(form).getByLabelText<HTMLInputElement>(label);
}

function sent(cmd: string): unknown[] {
  return invoke.mock.calls.filter(([name]) => name === cmd).map(([, args]): unknown => args);
}

/** Pastes `text` into `box` as the page hears it; false when the page stopped the paste. */
function pasteInto(box: HTMLElement, text: string): boolean {
  return fireEvent.paste(box, { clipboardData: { getData: () => text } });
}

function nowhereOnThePage(value: string) {
  expect(document.body.textContent).not.toContain(value);
  expect(JSON.stringify(debugState())).not.toContain(value);
}

/** The text of every `aria-label` and `title` on the page, which must hold no value. */
function labelsAndTitles(): string {
  const found: string[] = [];
  for (const element of document.querySelectorAll("[aria-label],[title]")) {
    found.push(element.getAttribute("aria-label") ?? "", element.getAttribute("title") ?? "");
  }
  return found.join("\n");
}

/** What the fake shell would reveal now for the item's password, asked straight to it (not through a screen). */
async function storedPassword(id: string, field: string | { previous: number } = "password"): Promise<string> {
  const live = shell.sessionOf(7);
  const answer = (await invoke("reveal_password", { session: live?.session, generation: live?.generation, id, field })) as {
    data: string;
  };
  return answer.data;
}

function saveForm(form: HTMLElement) {
  fireEvent.click(within(form).getByRole("button", { name: "Save" }));
}

test("until_shows_the_replaced_day", async () => {
  const { container } = await unlocked();
  const panel = await select("Bot admin console");
  const group = within(panel).getByRole("heading", { level: 3, name: "Earlier passwords" }).closest("section");
  expect(group).not.toBeNull();
  const rows = within(group as HTMLElement);
  // Each row says the day it was replaced in the app's day words: today, or the date (with the year when it is another one).
  for (const day of ["today", "12 March", "9 November 2025"]) expect(rows.getByText(`Until ${day}`)).toBeTruthy();
  expect(rows.getAllByRole("button").map((button) => button.textContent)).toEqual(["Copy", "Reveal", "Copy", "Reveal", "Copy", "Reveal"]);
  // Named for the row they belong to, never by what is in it.
  expect(rows.getAllByRole("button").map((button) => button.getAttribute("aria-label"))).toEqual([
    "Copy earlier password, until today",
    "Reveal earlier password, until today",
    "Copy earlier password, until 12 March",
    "Reveal earlier password, until 12 March",
    "Copy earlier password, until 9 November 2025",
    "Reveal earlier password, until 9 November 2025",
  ]);
  // Dots stand for them: no password is on the page, in the store or in a label until Reveal.
  expect(group?.querySelectorAll(".sec.hid[aria-hidden='true']")).toHaveLength(3);
  for (const old of [OLD_ONE, OLD_TWO, OLD_THREE, NOW_PW]) nowhereOnThePage(old);
  expect(labelsAndTitles()).not.toContain("demo-");
  expect(shell.revealed).toEqual([]);
  // After the details the group is below the website, as drawn, and above "Move to trash" (a later task).
  expect(Array.from(panel.querySelectorAll("h3")).map((heading) => heading.textContent)).toEqual(["Earlier passwords"]);

  // A login with none has no group, and a key or a note neither.
  for (const [title, kind] of [
    ["Error tracker", "Login"],
    ["TELEGRAM_BOT_TOKEN", "Key"],
    ["Rotation steps", "Note"],
  ] as const) {
    fireEvent.click(await screen.findByRole("button", { name: new RegExp(String.raw`^${kind}:\s*${title}`) }));
    const other = await screen.findByRole("complementary", { name: title });
    await within(other).findByRole("button", { name: "Edit" });
    expect(within(other).queryByRole("heading", { name: "Earlier passwords" }), title).toBeNull();
  }
  await expectNoAxe(container);
});

test("an_earlier_password_is_revealed_one_at_a_time_copied_in_rust_and_wiped", async () => {
  await unlocked();
  const panel = await select("Bot admin console");
  fireEvent.click(within(panel).getByRole("button", { name: "Reveal earlier password, until 12 March" }));
  const shown = await within(panel).findByRole("textbox", { name: "Earlier password, until 12 March" });
  expect(shown.textContent).toBe(OLD_TWO);
  const live = shell.sessionOf(7);
  expect(shell.revealed).toEqual([{ session: live?.session, generation: live?.generation, id: itemId(1), field: { previous: 1 } }]);
  // In the same guarded box as any value: Geist Mono, not selectable, named for the row, and in no label or title.
  expect(shown.classList.contains("kval")).toBe(true);
  expect(shown.getAttribute("style")).toBeNull();
  expect(labelsAndTitles()).not.toContain(OLD_TWO);

  // One at a time: another row's Reveal takes this one off the page.
  fireEvent.click(within(panel).getByRole("button", { name: "Reveal earlier password, until today" }));
  expect((await within(panel).findByRole("textbox", { name: "Earlier password, until today" })).textContent).toBe(OLD_ONE);
  expect(within(panel).queryByRole("textbox", { name: "Earlier password, until 12 March" })).toBeNull();
  nowhereOnThePage(OLD_TWO);
  // So does the password in use, and the other way round.
  fireEvent.click(within(panel).getByRole("button", { name: "Reveal" }));
  expect((await within(panel).findByRole("textbox", { name: "Password" })).textContent).toBe(NOW_PW);
  expect(within(panel).queryByRole("textbox", { name: "Earlier password, until today" })).toBeNull();
  nowhereOnThePage(OLD_ONE);

  // Hide takes it away; a row's Hide is in its Reveal's place.
  fireEvent.click(within(panel).getByRole("button", { name: "Reveal earlier password, until today" }));
  await within(panel).findByRole("textbox", { name: "Earlier password, until today" });
  fireEvent.click(within(panel).getByRole("button", { name: "Hide earlier password, until today" }));
  expect(within(panel).queryByRole("textbox", { name: "Earlier password, until today" })).toBeNull();
  nowhereOnThePage(OLD_ONE);

  // Copy goes through the shell, which owns the clipboard: the value never comes to the page for it.
  fireEvent.click(within(panel).getByRole("button", { name: "Copy earlier password, until 12 March" }));
  await waitFor(() => {
    expect(shell.copied).toHaveLength(1);
  });
  expect(shell.copied[0]).toMatchObject({ id: itemId(1), field: { previous: 1 } });
  await waitFor(() => {
    expect(screen.getByRole("status").textContent).toContain("Password copied");
  });
  expect(screen.getByRole("status").textContent).not.toContain(OLD_TWO);
  nowhereOnThePage(OLD_TWO);

  // Ctrl+C on a revealed row is that same Copy, through the shell.
  fireEvent.click(within(panel).getByRole("button", { name: "Reveal earlier password, until 9 November 2025" }));
  const third = await within(panel).findByRole("textbox", { name: "Earlier password, until 9 November 2025" });
  third.focus();
  expect(fireEvent.copy(third)).toBe(false);
  await waitFor(() => {
    expect(shell.copied).toHaveLength(2);
  });
  expect(shell.copied[1]).toMatchObject({ field: { previous: 2 } });
});

test("earlier_passwords_go_when_another_item_opens_or_the_vault_locks", async () => {
  await unlocked();
  let panel = await select("Bot admin console");
  fireEvent.click(within(panel).getByRole("button", { name: "Reveal earlier password, until today" }));
  await within(panel).findByRole("textbox", { name: "Earlier password, until today" });
  // Another item, and back: it is hidden again.
  await select("Error tracker");
  nowhereOnThePage(OLD_ONE);
  panel = await select("Bot admin console");
  expect(within(panel).queryByRole("textbox", { name: "Earlier password, until today" })).toBeNull();
  nowhereOnThePage(OLD_ONE);

  // An answer that comes after the item was left never shows up.
  const release = shell.holdReveal();
  fireEvent.click(within(panel).getByRole("button", { name: "Reveal earlier password, until 12 March" }));
  await waitFor(() => {
    expect(shell.revealed).toHaveLength(2);
  });
  await select("Error tracker");
  release();
  await act(async () => {
    await Promise.resolve();
  });
  nowhereOnThePage(OLD_TWO);
  panel = await select("Bot admin console");
  expect(within(panel).queryByRole("textbox", { name: "Earlier password, until 12 March" })).toBeNull();

  // A lock takes what is shown, with nothing said.
  fireEvent.click(within(panel).getByRole("button", { name: "Reveal earlier password, until today" }));
  await within(panel).findByRole("textbox", { name: "Earlier password, until today" });
  act(() => {
    shell.lock(shell.sessionOf(7)?.session ?? 0);
  });
  await screen.findByLabelText(/^Password for /);
  nowhereOnThePage(OLD_ONE);
  expect(screen.queryByRole("alert")).toBeNull();
});

test("read_only_has_no_edit_and_is_labelled", async () => {
  await unlocked(true);
  // The vault is labelled in its menu, and the panel says so as drawn (11c), with no Edit on any kind.
  expect(screen.getByRole("button", { name: /read-only, vault menu/ })).toBeTruthy();
  for (const [title, kind] of [
    ["Bot admin console", "Login"],
    ["TELEGRAM_BOT_TOKEN", "Key"],
    ["Rotation steps", "Note"],
    ["Client contract", "File"],
  ] as const) {
    fireEvent.click(await screen.findByRole("button", { name: new RegExp(String.raw`^${kind}:\s*${title}`) }));
    const panel = await screen.findByRole("complementary", { name: title });
    await within(panel).findByText("Read-only");
    expect(within(panel).queryByRole("button", { name: "Edit" }), title).toBeNull();
    expect(within(panel).getByText("Read-only").classList.contains("chip")).toBe(true);
  }
  // Reading still works: a login's earlier passwords can be revealed and copied from a backup.
  const panel = await select("Bot admin console");
  expect(within(panel).getByRole("heading", { level: 3, name: "Earlier passwords" })).toBeTruthy();
  fireEvent.click(within(panel).getByRole("button", { name: "Reveal earlier password, until today" }));
  expect((await within(panel).findByRole("textbox", { name: "Earlier password, until today" })).textContent).toBe(OLD_ONE);
  expect(shell.edited).toEqual([]);

  // A vault that can be written says nothing of the kind in the panel, and has Edit.
  cleanup();
  resetStoreForTests();
  invoke.mockReset();
  listen.mockReset();
  await unlocked(false);
  const writable = await select("Bot admin console");
  expect(within(writable).queryByText("Read-only")).toBeNull();
  expect(editButton(writable)).toBeTruthy();
});

test("password_shows_while_editing", async () => {
  const { container } = await unlocked();
  const panel = await select("Bot admin console");
  // Opening the details asks for no password.
  expect(shell.revealed).toEqual([]);
  fireEvent.click(editButton(panel));
  const form = await screen.findByRole("complementary", { name: "Edit login" });
  expect(within(form).getByRole("heading", { level: 2, name: "Edit login" })).toBeTruthy();
  // As drawn: Title, Username, Password with Generate, Website with its line, Note; Cancel and Save.
  const labels = Array.from(form.querySelectorAll("label")).map((label) => label.textContent);
  expect(labels).toEqual(["Title", "Username", "Password", "Website", "Note"]);
  expect(inputOf(form, "Title").value).toBe("Bot admin console");
  expect(inputOf(form, "Username").value).toBe("admin@example.com");
  expect(inputOf(form, "Website").value).toBe("https://support.example.com");
  expect(inputOf(form, "Note").value).toBe("");
  expect(within(form).getByText("https:// is added on save if it's missing.")).toBeTruthy();
  expect(within(form).getByRole("button", { name: "Generate" })).toBeTruthy();
  expect(within(form).getByRole("button", { name: "Cancel" })).toBeTruthy();
  expect(within(form).getByRole("button", { name: "Save" })).toBeTruthy();
  // The password is asked of Rust as the form opens and is in its box once it has come.
  await waitFor(() => {
    expect(inputOf(form, "Password").value).toBe(NOW_PW);
  });
  const live = shell.sessionOf(7);
  expect(shell.revealed).toEqual([{ session: live?.session, generation: live?.generation, id: itemId(1), field: "password" }]);
  // As drawn (11a), the password is readable in its box: plain text, with no Show or Hide to press.
  expect(inputOf(form, "Password").type).toBe("text");
  expect(within(form).queryByRole("button", { name: /^(Show|Hide)$/ })).toBeNull();
  // It is in the box and nowhere else: not in the text of the page, a label or a title; no inline style anywhere.
  expect(document.body.textContent).not.toContain(NOW_PW);
  expect(labelsAndTitles()).not.toContain(NOW_PW);
  expect(container.querySelector("[style]")).toBeNull();
  expect(container.querySelector("style")).toBeNull();
  // The form has no Folder (moving is another task's), and the details were not asked for again.
  expect(within(form).queryByText("Folder")).toBeNull();
  await expectNoAxe(container);
});

test("edit_login_sends_only_what_was_changed_and_the_details_come_back", async () => {
  await unlocked();
  const form = await openEdit("Bot admin console", "Edit login");
  await waitFor(() => {
    expect(inputOf(form, "Password").value).toBe(NOW_PW);
  });
  typeInto(form, "Title", "Bot console (renamed)");
  saveForm(form);
  const panel = await screen.findByRole("complementary", { name: "Bot console (renamed)" });
  // The title and the note are always sent (the shell wants them); a field the person did not touch is not, and the
  // folder the item is in is sent as it is, since leaving it out would take the item out of its folder.
  expect(shell.edited).toHaveLength(1);
  expect(shell.edited[0]?.edit).toEqual({
    id: itemId(1),
    revision: 2,
    title: "Bot console (renamed)",
    notes: "",
    collection: FOLDER,
  });
  expect(await screen.findByText("Saved")).toBeTruthy();
  // The form is gone, the details are back with the new title, and focus is on Edit.
  expect(screen.queryByRole("complementary", { name: "Edit login" })).toBeNull();
  await waitFor(() => {
    expect(document.activeElement).toBe(editButton(panel));
  });
  // Nothing moved: the password in use and the earlier ones are as they were.
  expect(within(panel).getAllByRole("button", { name: /^Reveal earlier password/ })).toHaveLength(3);

  // A second edit: the username, the password, the website and the note, each sent as typed.
  fireEvent.click(editButton(panel));
  const again = await screen.findByRole("complementary", { name: "Edit login" });
  await waitFor(() => {
    expect(inputOf(again, "Password").value).toBe(NOW_PW);
  });
  typeInto(again, "Username", "new@example.com");
  typeInto(again, "Password", NEW_PW);
  typeInto(again, "Website", "new.example.com");
  typeInto(again, "Note", "a new note");
  saveForm(again);
  const details = await screen.findByRole("complementary", { name: "Bot console (renamed)" });
  await waitFor(() => {
    expect(shell.edited).toHaveLength(2);
  });
  expect(shell.edited[1]?.edit).toEqual({
    id: itemId(1),
    revision: 3,
    title: "Bot console (renamed)",
    notes: "a new note",
    collection: FOLDER,
    username: "new@example.com",
    password: NEW_PW,
    urls: ["new.example.com"],
  });
  // The shell completed the website; the engine moved the old password to the front of the earlier ones.
  expect(await within(details).findByText("new.example.com")).toBeTruthy();
  await waitFor(() => {
    expect(within(details).getAllByRole("button", { name: /^Reveal earlier password/ })).toHaveLength(4);
  });
  fireEvent.click(within(details).getAllByRole("button", { name: /^Reveal earlier password/ })[0] as HTMLElement);
  expect((await within(details).findByRole("textbox", { name: /^Earlier password/ })).textContent).toBe(NOW_PW);
  fireEvent.click(within(details).getByRole("button", { name: "Reveal" }));
  expect((await within(details).findByRole("textbox", { name: "Password" })).textContent).toBe(NEW_PW);
});

test("an_untouched_website_is_kept_and_a_cleared_one_is_sent_empty", async () => {
  await unlocked();
  let form = await openEdit("Bot admin console", "Edit login");
  typeInto(form, "Website", "");
  saveForm(form);
  await screen.findByRole("complementary", { name: "Bot admin console" });
  await waitFor(() => {
    expect(shell.edited).toHaveLength(1);
  });
  expect(shell.edited[0]?.edit.urls).toEqual([]);
  expect(shell.edited[0]?.edit).not.toHaveProperty("username");
  expect(shell.edited[0]?.edit).not.toHaveProperty("password");
  expect(stored.find((item) => item.id === itemId(1))?.urls).toEqual([]);
  // Another website with a login's other fields untouched.
  form = await openEdit("Bot admin console", "Edit login");
  expect(inputOf(form, "Website").value).toBe("");
  typeInto(form, "Website", "ftp://files.example");
  saveForm(form);
  // The shell refuses a website that is not a web address, and the form says so in words and stays as it was.
  expect((await within(form).findByRole("alert")).textContent).toBe(
    "That isn't a web address Lockbox can open. Use one that starts with http:// or https://.",
  );
  expect(inputOf(form, "Website").value).toBe("ftp://files.example");
  expect(shell.edited).toHaveLength(1);
});

test("a_value_with_a_line_break_is_not_put_in_a_one_line_box_and_saving_keeps_it_byte_for_byte", async () => {
  await unlocked();
  const form = await openEdit("Multi-line login", "Edit login");
  await waitFor(() => {
    expect(shell.revealed).toHaveLength(1);
  });
  // The box stays empty, with a line under it that says why and what to do.
  const password = inputOf(form, "Password");
  expect(within(form).getByText(MORE_THAN_ONE_LINE)).toBeTruthy();
  const hint = within(form).getByText(MORE_THAN_ONE_LINE);
  expect(password.getAttribute("aria-describedby")).toContain(hint.id);
  await act(async () => {
    await Promise.resolve();
  });
  expect(password.value).toBe("");
  expect(password.disabled).toBe(false);
  expect(document.body.textContent).not.toContain("demo-line-one");

  // Save with the box left empty: the password is not sent, and the stored one is the same bytes as before.
  typeInto(form, "Title", "Multi-line login (renamed)");
  saveForm(form);
  await screen.findByRole("complementary", { name: "Multi-line login (renamed)" });
  expect(shell.edited[0]?.edit).not.toHaveProperty("password");
  expect(await storedPassword(itemId(30))).toBe(MULTI_PW);
  expect(stored.find((item) => item.id === itemId(30))?.previous ?? []).toEqual([]);

  // Typing and clearing again is the same as leaving it: nothing is sent.
  const second = await screen.findByRole("complementary", { name: "Multi-line login (renamed)" });
  fireEvent.click(editButton(second));
  const again = await screen.findByRole("complementary", { name: "Edit login" });
  typeInto(again, "Password", "x");
  typeInto(again, "Password", "");
  typeInto(again, "Title", "Multi-line login");
  saveForm(again);
  await screen.findByRole("complementary", { name: "Multi-line login" });
  await waitFor(() => {
    expect(shell.edited).toHaveLength(2);
  });
  expect(shell.edited[1]?.edit).not.toHaveProperty("password");
  expect(await storedPassword(itemId(30))).toBe(MULTI_PW);

  // A new one typed in the box replaces it, and the old one is kept, exactly, as an earlier password.
  const third = await screen.findByRole("complementary", { name: "Multi-line login" });
  fireEvent.click(editButton(third));
  const last = await screen.findByRole("complementary", { name: "Edit login" });
  typeInto(last, "Password", NEW_PW);
  saveForm(last);
  await screen.findByRole("complementary", { name: "Multi-line login" });
  await waitFor(() => {
    expect(shell.edited).toHaveLength(3);
  });
  expect(shell.edited[2]?.edit.password).toBe(NEW_PW);
  expect(await storedPassword(itemId(30))).toBe(NEW_PW);
  expect(await storedPassword(itemId(30), { previous: 0 })).toBe(MULTI_PW);
});

test("key_edit_changes_value", async () => {
  const { container } = await unlocked();
  const form = await openEdit("TELEGRAM_BOT_TOKEN", "Edit key");
  expect(within(form).getByRole("heading", { level: 2, name: "Edit key" })).toBeTruthy();
  // Name with its rule, Value, and the note the key has (7a); no Folder.
  expect(Array.from(form.querySelectorAll("label")).map((label) => label.textContent)).toEqual(["Name", "Value", "Note"]);
  expect(within(form).getByText("Letters, digits and _ only. It can't start with a digit.")).toBeTruthy();
  expect(inputOf(form, "Name").value).toBe("TELEGRAM_BOT_TOKEN");
  expect(inputOf(form, "Note").value).toBe("rotate monthly");
  const value = inputOf(form, "Value");
  await waitFor(() => {
    expect(value.value).toBe(BOT_TOKEN);
  });
  const live = shell.sessionOf(7);
  expect(shell.revealed).toEqual([{ session: live?.session, generation: live?.generation, id: itemId(20), field: "key_value" }]);
  // Hidden until Show, as in the new-key form, and never in a label.
  expect(value.type).toBe("password");
  expect(labelsAndTitles()).not.toContain(BOT_TOKEN);
  await expectNoAxe(container);

  // The paste rule of the new-key form holds in the same box: a line break inside is refused in the same words.
  expect(pasteInto(value, "a\nb")).toBe(false);
  expect(value.value).toBe(BOT_TOKEN);
  expect((await within(form).findByRole("alert")).textContent).toBe(ONE_LINE_ONLY);
  // A shown value is not natively copyable: a copy or a cut aimed at its box is stopped.
  fireEvent.click(within(form).getByRole("button", { name: "Show" }));
  expect(value.type).toBe("text");
  expect(fireEvent.copy(value)).toBe(false);
  expect(fireEvent.cut(value)).toBe(false);
  fireEvent.click(within(form).getByRole("button", { name: "Hide" }));

  // A new value, and only that: sent with the name and the note the shell wants, nothing else.
  typeInto(form, "Value", NEW_TOKEN);
  saveForm(form);
  const panel = await screen.findByRole("complementary", { name: "TELEGRAM_BOT_TOKEN" });
  await waitFor(() => {
    expect(shell.edited).toHaveLength(1);
  });
  expect(shell.edited[0]?.edit).toEqual({
    id: itemId(20),
    revision: 2,
    title: "TELEGRAM_BOT_TOKEN",
    notes: "rotate monthly",
    collection: FOLDER,
    key_value: NEW_TOKEN,
  });
  await within(panel).findByRole("button", { name: "Edit" });
  fireEvent.click(within(panel).getByRole("button", { name: "Reveal" }));
  expect((await within(panel).findByRole("textbox", { name: "Key value" })).textContent).toBe(NEW_TOKEN);

  // A new name alone keeps the value; the shell's refusal of a bad name is in words, and the form stays as it was.
  fireEvent.click(editButton(panel));
  const again = await screen.findByRole("complementary", { name: "Edit key" });
  await waitFor(() => {
    expect(inputOf(again, "Value").value).toBe(NEW_TOKEN);
  });
  typeInto(again, "Name", "bad name");
  saveForm(again);
  expect((await within(again).findByRole("alert")).textContent).toBe(
    "That isn't a name Lockbox can use for a key. Use letters, digits and _ only, and don't start with a digit.",
  );
  expect(inputOf(again, "Name").getAttribute("aria-invalid")).toBe("true");
  expect(inputOf(again, "Value").value).toBe(NEW_TOKEN);
  typeInto(again, "Name", "");
  saveForm(again);
  await waitFor(() => {
    expect(within(again).getByRole("alert").textContent).toBe("Type a name first.");
  });
  typeInto(again, "Name", "RENAMED_TOKEN");
  saveForm(again);
  await screen.findByRole("complementary", { name: "RENAMED_TOKEN" });
  await waitFor(() => {
    expect(shell.edited).toHaveLength(2);
  });
  expect(shell.edited[1]?.edit).toEqual({
    id: itemId(20),
    revision: 3,
    title: "RENAMED_TOKEN",
    notes: "rotate monthly",
    collection: FOLDER,
  });
  expect(stored.find((item) => item.id === itemId(20))?.value).toBe(NEW_TOKEN);
});

test("a_key_with_a_line_break_in_its_value_keeps_it_when_only_the_name_changes", async () => {
  await unlocked();
  const form = await openEdit("SPACED_KEY", "Edit key");
  // This key has no note, so the form has none (the details show a note when there is one).
  expect(Array.from(form.querySelectorAll("label")).map((label) => label.textContent)).toEqual(["Name", "Value"]);
  await waitFor(() => {
    expect(shell.revealed).toHaveLength(1);
  });
  await act(async () => {
    await Promise.resolve();
  });
  expect(inputOf(form, "Value").value).toBe("");
  expect(within(form).getByText(MORE_THAN_ONE_LINE)).toBeTruthy();
  expect(document.body.textContent).not.toContain("demo-key-line-one");
  typeInto(form, "Name", "SPACED_KEY_RENAMED");
  saveForm(form);
  await screen.findByRole("complementary", { name: "SPACED_KEY_RENAMED" });
  expect(shell.edited[0]?.edit).not.toHaveProperty("key_value");
  expect(stored.find((item) => item.id === itemId(21))?.value).toBe(MULTI_KEY);
});

test("the_note_and_file_forms_follow_the_new_note_form_and_the_files_title_and_note", async () => {
  await unlocked();
  const note = await openEdit("Rotation steps", "Edit note");
  expect(Array.from(note.querySelectorAll("label")).map((label) => label.textContent)).toEqual(["Title", "Text"]);
  expect(inputOf(note, "Title").value).toBe("Rotation steps");
  expect(inputOf(note, "Text").value).toBe("Made-up note");
  // A note asks for no secret: nothing was revealed to open it.
  expect(shell.revealed).toEqual([]);
  typeInto(note, "Text", "new text of the note");
  saveForm(note);
  const noteDetails = await screen.findByRole("complementary", { name: "Rotation steps" });
  await within(noteDetails).findByText("new text of the note");
  expect(shell.edited[0]?.edit).toEqual({
    id: itemId(3),
    revision: 2,
    title: "Rotation steps",
    notes: "new text of the note",
    collection: FOLDER,
  });
  // A title is needed for a note, as for a new one.
  fireEvent.click(editButton(noteDetails));
  const again = await screen.findByRole("complementary", { name: "Edit note" });
  typeInto(again, "Title", "  ");
  saveForm(again);
  await waitFor(() => {
    expect(within(again).getByRole("alert").textContent).toBe("Type a title first.");
  });
  expect(inputOf(again, "Title").getAttribute("aria-invalid")).toBe("true");
  fireEvent.click(within(again).getByRole("button", { name: "Cancel" }));

  // A stored file: its title and note only, and its stored contents are not the form's to change.
  const file = await openEdit("Client contract", "Edit file");
  expect(Array.from(file.querySelectorAll("label")).map((label) => label.textContent)).toEqual(["Title", "Note"]);
  expect(within(file).queryByLabelText("Password")).toBeNull();
  expect(within(file).queryByLabelText("Website")).toBeNull();
  expect(within(file).queryByLabelText("Value")).toBeNull();
  typeInto(file, "Note", "signed copy");
  typeInto(file, "Title", "Client contract 2026");
  saveForm(file);
  const fileDetails = await screen.findByRole("complementary", { name: "Client contract 2026" });
  expect(within(fileDetails).getByText("contract-demo.pdf")).toBeTruthy();
  // The saved note is on the page, in the same "Notes" group a key's details use.
  expect(within(fileDetails).getByText("Notes")).toBeTruthy();
  expect(within(fileDetails).getByText("signed copy")).toBeTruthy();
  await waitFor(() => {
    expect(shell.edited).toHaveLength(2);
  });
  expect(shell.edited[1]?.edit).toEqual({
    id: itemId(4),
    revision: 2,
    title: "Client contract 2026",
    notes: "signed copy",
    collection: null,
  });
  expect(shell.revealed).toEqual([]);
});

test("cancel_changes_nothing", async () => {
  await unlocked();
  const form = await openEdit("Bot admin console", "Edit login");
  await waitFor(() => {
    expect(inputOf(form, "Password").value).toBe(NOW_PW);
  });
  typeInto(form, "Title", "Never saved title");
  typeInto(form, "Password", NEW_PW);
  typeInto(form, "Note", "never saved note");
  fireEvent.click(within(form).getByRole("button", { name: "Cancel" }));
  // The details are back as they were, with focus on Edit; nothing was sent and neither password is left on the page.
  const panel = await screen.findByRole("complementary", { name: "Bot admin console" });
  await waitFor(() => {
    expect(document.activeElement).toBe(editButton(panel));
  });
  expect(sent("update_item")).toEqual([]);
  expect(shell.edited).toEqual([]);
  expect(screen.queryByRole("complementary", { name: "Edit login" })).toBeNull();
  for (const text of ["Never saved title", NEW_PW, NOW_PW, "never saved note"]) {
    expect(document.body.textContent, text).not.toContain(text);
    expect(JSON.stringify(debugState()), text).not.toContain(text);
  }
  expect(within(panel).queryByRole("textbox", { name: "Password" })).toBeNull();
  // Opened again, the form has what is stored, not what was typed.
  fireEvent.click(editButton(panel));
  const again = await screen.findByRole("complementary", { name: "Edit login" });
  expect(inputOf(again, "Title").value).toBe("Bot admin console");
  expect(inputOf(again, "Note").value).toBe("");
  // Close panel on a form is the same as Cancel.
  typeInto(again, "Title", "Also never saved");
  fireEvent.click(within(again).getByRole("button", { name: "Close panel" }));
  expect(await screen.findByRole("complementary", { name: "Bot admin console" })).toBeTruthy();
  expect(sent("update_item")).toEqual([]);
  // The same on a key.
  const key = await openEdit("TELEGRAM_BOT_TOKEN", "Edit key");
  await waitFor(() => {
    expect(inputOf(key, "Value").value).toBe(BOT_TOKEN);
  });
  typeInto(key, "Value", NEW_TOKEN);
  fireEvent.click(within(key).getByRole("button", { name: "Cancel" }));
  await screen.findByRole("complementary", { name: "TELEGRAM_BOT_TOKEN" });
  for (const text of [NEW_TOKEN, BOT_TOKEN]) nowhereOnThePage(text);
  expect(sent("update_item")).toEqual([]);
});

test("lock_loses_the_edit_with_no_error", async () => {
  await unlocked();
  const form = await openEdit("Bot admin console", "Edit login");
  await waitFor(() => {
    expect(inputOf(form, "Password").value).toBe(NOW_PW);
  });
  typeInto(form, "Title", "Draft title");
  typeInto(form, "Password", NEW_PW);

  // A lock while the form is open: it goes with the vault's screen, saying nothing, and nothing was saved.
  act(() => {
    shell.lock(shell.sessionOf(7)?.session ?? 0);
  });
  await screen.findByLabelText(/^Password for /);
  expect(screen.queryByRole("complementary")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  for (const text of ["Draft title", NEW_PW, NOW_PW]) {
    expect(document.body.textContent, text).not.toContain(text);
    expect(JSON.stringify(debugState()), text).not.toContain(text);
    for (const input of document.querySelectorAll("input")) expect(input.value).not.toContain(text);
  }
  expect(sent("update_item")).toEqual([]);
  expect(shell.edited).toEqual([]);

  // Unlocked again, the form is not there and nothing of it comes back; the item is as it was.
  await unlockThroughTheScreen();
  expect(screen.queryByRole("complementary")).toBeNull();
  const details = await select("Bot admin console");
  expect(editButton(details)).toBeTruthy();

  // A lock while the stored password is on its way: the answer is dropped, and nothing is said or shown.
  const asked = shell.revealed.length;
  const release = shell.holdReveal();
  fireEvent.click(editButton(details));
  await screen.findByRole("complementary", { name: "Edit login" });
  await waitFor(() => {
    expect(shell.revealed).toHaveLength(asked + 1);
  });
  act(() => {
    shell.lock(shell.sessionOf(7)?.session ?? 0);
  });
  await screen.findByLabelText(/^Password for /);
  release();
  await act(async () => {
    await Promise.resolve();
  });
  expect(screen.queryByRole("alert")).toBeNull();
  nowhereOnThePage(NOW_PW);

  // A lock while the save is on its way: the change was written, the answer is dropped, and nothing is said.
  await unlockThroughTheScreen();
  const again = await openEdit("Bot admin console", "Edit login");
  await waitFor(() => {
    expect(inputOf(again, "Password").value).toBe(NOW_PW);
  });
  typeInto(again, "Title", "Saved while locking");
  const letGo = shell.holdUpdate();
  saveForm(again);
  await waitFor(() => {
    expect(shell.edited).toHaveLength(1);
  });
  act(() => {
    shell.lock(shell.sessionOf(7)?.session ?? 0);
  });
  await screen.findByLabelText(/^Password for /);
  await act(async () => {
    letGo();
    await Promise.resolve();
  });
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByText("Saved")).toBeNull();
  await unlockThroughTheScreen();
  expect(await screen.findByRole("button", { name: /^Login:\s*Saved while locking/ })).toBeTruthy();
});

test("a_late_answer_never_fills_a_form_that_is_gone", async () => {
  await unlocked();
  const details = await select("Bot admin console");
  // Edit, then Cancel before the password has come: when it does, nothing is shown anywhere.
  const release = shell.holdReveal();
  fireEvent.click(editButton(details));
  const form = await screen.findByRole("complementary", { name: "Edit login" });
  expect(inputOf(form, "Password").disabled).toBe(true);
  fireEvent.click(within(form).getByRole("button", { name: "Cancel" }));
  await screen.findByRole("complementary", { name: "Bot admin console" });
  release();
  await act(async () => {
    await Promise.resolve();
  });
  nowhereOnThePage(NOW_PW);
  expect(screen.queryByRole("textbox", { name: "Password" })).toBeNull();

  // Edit, Cancel, Edit again: the first answer is late and is dropped; the form waits for its own.
  const hold = shell.holdReveal();
  const panel = await screen.findByRole("complementary", { name: "Bot admin console" });
  fireEvent.click(editButton(panel));
  const first = await screen.findByRole("complementary", { name: "Edit login" });
  fireEvent.click(within(first).getByRole("button", { name: "Cancel" }));
  const back = await screen.findByRole("complementary", { name: "Bot admin console" });
  fireEvent.click(editButton(back));
  const second = await screen.findByRole("complementary", { name: "Edit login" });
  await waitFor(() => {
    expect(shell.revealed.filter((one) => one.field === "password")).toHaveLength(3);
  });
  act(() => {
    shell.releaseOneReveal();
  });
  await act(async () => {
    await Promise.resolve();
  });
  expect(inputOf(second, "Password").value).toBe("");
  expect(inputOf(second, "Password").disabled).toBe(true);
  hold();
  await waitFor(() => {
    expect(inputOf(second, "Password").value).toBe(NOW_PW);
  });
  expect(inputOf(second, "Password").disabled).toBe(false);
  fireEvent.click(within(second).getByRole("button", { name: "Cancel" }));

  // Edit, then another item opens: the first item's password never lands in the second item's form.
  const slow = shell.holdReveal();
  const open = await screen.findByRole("complementary", { name: "Bot admin console" });
  fireEvent.click(editButton(open));
  await screen.findByRole("complementary", { name: "Edit login" });
  const other = await select("Error tracker");
  slow();
  await act(async () => {
    await Promise.resolve();
  });
  nowhereOnThePage(NOW_PW);
  fireEvent.click(editButton(other));
  const theirs = await screen.findByRole("complementary", { name: "Edit login" });
  await waitFor(() => {
    expect(inputOf(theirs, "Password").value).not.toBe("");
  });
  expect(inputOf(theirs, "Password").value).not.toBe(NOW_PW);
});

test("edit_stale_revision_says_changed_meanwhile", async () => {
  await unlocked();
  const form = await openEdit("Bot admin console", "Edit login");
  await waitFor(() => {
    expect(inputOf(form, "Password").value).toBe(NOW_PW);
  });
  // Another change lands while the form is open: the revision the form read is no longer the stored one.
  const item = stored.find((one) => one.id === itemId(1));
  if (item !== undefined) item.revision = 9;
  typeInto(form, "Title", "Late title");
  typeInto(form, "Password", NEW_PW);
  saveForm(form);
  // Said in words, in the form, which stays as it was with what was typed: nothing was saved.
  expect((await within(form).findByRole("alert")).textContent).toBe(CHANGED_MEANWHILE);
  expect(inputOf(form, "Title").value).toBe("Late title");
  expect(inputOf(form, "Password").value).toBe(NEW_PW);
  expect(shell.edited).toEqual([]);
  expect(item?.title).toBe("Bot admin console");
  expect(within(form).getByRole("button", { name: "Save" }).getAttribute("aria-disabled")).toBeNull();
  // Cancel and open again: the item is read afresh, so the next save is not stale.
  fireEvent.click(within(form).getByRole("button", { name: "Cancel" }));
  const panel = await screen.findByRole("complementary", { name: "Bot admin console" });
  await waitFor(() => {
    expect(sent("get_item").length).toBeGreaterThan(1);
  });
  fireEvent.click(editButton(panel));
  const again = await screen.findByRole("complementary", { name: "Edit login" });
  typeInto(again, "Title", "On time");
  saveForm(again);
  await screen.findByRole("complementary", { name: "On time" });
  expect(shell.edited).toHaveLength(1);
  expect(shell.edited[0]?.edit.revision).toBe(9);
});

test("a_refused_list_refresh_after_a_save_still_opens_the_details", async () => {
  await unlocked();
  // A new login: the refresh of the list right after the save is refused once; the saved login's details still open.
  const add = screen.getByRole("button", { name: "Add" });
  add.focus();
  fireEvent.pointerDown(add, { button: 0 });
  fireEvent.click(add);
  const menu = await screen.findByRole("menu");
  fireEvent.click(within(menu).getByRole("menuitem", { name: "Login" }));
  const form = await screen.findByRole("complementary", { name: "New login" });
  typeInto(form, "Title", "Made before the refusal");
  typeInto(form, "Username", "made@example.com");
  shell.refuseNext("list_items", { code: "core", kind: "io" });
  saveForm(form);
  const made = await screen.findByRole("complementary", { name: "Made before the refusal" });
  expect(within(made).getByText("made@example.com")).toBeTruthy();
  expect(await screen.findByText("Saved")).toBeTruthy();
});

test("a_refused_list_refresh_after_an_edit_keeps_the_saved_details_open", async () => {
  await unlocked();
  const panel = await select("Rotation steps");
  fireEvent.click(editButton(panel));
  const note = await screen.findByRole("complementary", { name: "Edit note" });
  typeInto(note, "Title", "Renamed before the refusal");
  typeInto(note, "Text", "kept text");
  shell.refuseNext("list_items", { code: "core", kind: "io" });
  saveForm(note);
  const saved = await screen.findByRole("complementary", { name: "Renamed before the refusal" });
  await within(saved).findByText("kept text");
  expect(shell.edited).toHaveLength(1);
  await within(saved).findByRole("button", { name: "Edit" });
});

test("edit_is_reachable_by_keyboard_and_nothing_secret_is_in_a_name", async () => {
  const { container } = await unlocked();
  const panel = await select("Bot admin console");
  const edit = editButton(panel);
  expect(edit.tagName).toBe("BUTTON");
  expect(edit.getAttribute("type")).toBe("button");
  edit.focus();
  expect(document.activeElement).toBe(edit);
  fireEvent.click(edit);
  const form = await screen.findByRole("complementary", { name: "Edit login" });
  // The first field takes focus, and Enter in a field saves, like any form.
  await waitFor(() => {
    expect(document.activeElement).toBe(inputOf(form, "Title"));
  });
  await waitFor(() => {
    expect(inputOf(form, "Password").value).toBe(NOW_PW);
  });
  typeInto(form, "Title", "Saved with Enter");
  fireEvent.submit(inputOf(form, "Title").form as HTMLFormElement);
  await screen.findByRole("complementary", { name: "Saved with Enter" });
  expect(labelsAndTitles()).not.toContain(NOW_PW);
  await expectNoAxe(container);
});

/** Add, then the kind, as a person would with the pointer: the form named "New <kind>". */
async function openNew(kind: "Login" | "Key" | "Note"): Promise<HTMLElement> {
  const add = screen.getByRole("button", { name: "Add" });
  add.focus();
  fireEvent.pointerDown(add, { button: 0 });
  fireEvent.click(add);
  const menu = await screen.findByRole("menu");
  fireEvent.click(within(menu).getByRole("menuitem", { name: kind }));
  return screen.findByRole("complementary", { name: `New ${kind.toLowerCase()}` });
}

/** Drops `text` onto `box`; false when the page stopped the drop. */
function dropOnto(box: HTMLElement, text: string): boolean {
  return fireEvent.drop(box, { dataTransfer: { getData: () => text } });
}

test("a_save_that_completes_never_closes_a_newer_form", async () => {
  await unlocked();
  // An edit whose save is still on its way: Cancel, open another item's Edit, type; then the save completes.
  const form = await openEdit("Rotation steps", "Edit note");
  typeInto(form, "Title", "Renamed in flight");
  const release = shell.holdUpdate();
  saveForm(form);
  await waitFor(() => {
    expect(shell.edited).toHaveLength(1);
  });
  fireEvent.click(within(form).getByRole("button", { name: "Cancel" }));
  await screen.findByRole("complementary", { name: "Rotation steps" });
  const newer = await openEdit("Error tracker", "Edit login");
  typeInto(newer, "Title", "Newer draft");
  await act(async () => {
    release();
    await Promise.resolve();
  });
  // The save is told ("Saved") and the list has its change, but the newer form and its text are still there.
  expect(await screen.findByText("Saved")).toBeTruthy();
  expect(await screen.findByRole("button", { name: /^Note:\s*Renamed in flight/ })).toBeTruthy();
  const still = screen.getByRole("complementary", { name: "Edit login" });
  expect(inputOf(still, "Title").value).toBe("Newer draft");
  expect(screen.queryByRole("complementary", { name: "Renamed in flight" })).toBeNull();
  // Another form of the same kind for another item is newer too: the same, one kind for both.
  fireEvent.click(within(still).getByRole("button", { name: "Cancel" }));
  const first = await openEdit("Bot admin console", "Edit login");
  typeInto(first, "Title", "First login renamed");
  const letGo = shell.holdUpdate();
  saveForm(first);
  await waitFor(() => {
    expect(shell.edited).toHaveLength(2);
  });
  fireEvent.click(within(first).getByRole("button", { name: "Cancel" }));
  await screen.findByRole("complementary", { name: "Bot admin console" });
  const second = await openEdit("Multi-line login", "Edit login");
  typeInto(second, "Title", "Second draft");
  await act(async () => {
    letGo();
    await Promise.resolve();
  });
  await screen.findByRole("button", { name: /^Login:\s*First login renamed/ });
  expect(inputOf(screen.getByRole("complementary", { name: "Edit login" }), "Title").value).toBe("Second draft");

  // A new item whose save is on its way, then another new form: it is not closed when the save completes.
  fireEvent.click(within(screen.getByRole("complementary", { name: "Edit login" })).getByRole("button", { name: "Cancel" }));
  const login = await openNew("Login");
  typeInto(login, "Title", "Made in flight");
  const done = shell.holdNewItem();
  saveForm(login);
  await waitFor(() => {
    expect(shell.made).toHaveLength(1);
  });
  fireEvent.click(within(login).getByRole("button", { name: "Cancel" }));
  const note = await openNew("Note");
  typeInto(note, "Title", "Newer note draft");
  await act(async () => {
    done();
    await Promise.resolve();
  });
  await screen.findByRole("button", { name: /^Login:\s*Made in flight/ });
  expect(inputOf(screen.getByRole("complementary", { name: "New note" }), "Title").value).toBe("Newer note draft");
  expect(screen.queryByRole("complementary", { name: "Made in flight" })).toBeNull();
});

const PASSWORD_ONE_LINE = "That password has more than one line, so it wasn't pasted. A password is one line here.";

for (const which of ["new_login", "edit_login"] as const) {
  /** The Password box of the form, ready to take a paste, and the form's Save and Title for the sequence below. */
  const openPasswordForm = async (): Promise<HTMLElement> => {
    if (which === "new_login") return openNew("Login");
    const form = await openEdit("Bot admin console", "Edit login");
    await waitFor(() => {
      expect(inputOf(form, "Password").value).toBe(NOW_PW);
    });
    return form;
  };

  test(`${which}_a_password_with_a_line_break_inside_is_not_pasted_or_dropped`, async () => {
    await unlocked();
    const form = await openPasswordForm();
    const box = inputOf(form, "Password");
    let held = box.value;
    const change = () => {
      held = held === "demo-typed-one" ? "demo-typed-two" : "demo-typed-one";
      typeInto(form, "Password", held);
    };
    change();
    for (const text of ["line one\r\nline two", "line one\nline two", "\nline one\nline two\n", "a\rb"]) {
      // Stopped before the box can join the lines, which would change the password without a word.
      expect(pasteInto(box, text), JSON.stringify(text)).toBe(false);
      expect(box.value).toBe(held);
      expect((await within(form).findByRole("alert")).textContent).toBe(PASSWORD_ONE_LINE);
      change();
      expect(within(form).queryByRole("alert")).toBeNull();
      expect(dropOnto(box, text), JSON.stringify(text)).toBe(false);
      expect(box.value).toBe(held);
      expect((await within(form).findByRole("alert")).textContent).toBe(PASSWORD_ONE_LINE);
      change();
      expect(within(form).queryByRole("alert")).toBeNull();
    }
    // A break only at the very start or end is left to the box, as for a key's value; a clean paste clears the words.
    for (const text of ["one-line-pass\n", "one-line-pass\r\n", "\none-line-pass", "one-line-pass", ""]) {
      expect(pasteInto(box, text), JSON.stringify(text)).toBe(true);
      expect(dropOnto(box, text), JSON.stringify(text)).toBe(true);
    }
    expect(pasteInto(box, "a\nb")).toBe(false);
    await within(form).findByRole("alert");
    expect(pasteInto(box, "fine")).toBe(true);
    expect(within(form).queryByRole("alert")).toBeNull();

    // What is saved is what the box held: a refused paste changed nothing.
    expect(pasteInto(box, "x\r\ny")).toBe(false);
    typeInto(form, "Title", "Pasted into");
    typeInto(form, "Password", "demo-clean-pass-4");
    saveForm(form);
    await screen.findByRole("complementary", { name: "Pasted into" });
    const sentPassword =
      which === "new_login" ? shell.made.at(-1)?.fields?.password : shell.edited.at(-1)?.edit.password;
    expect(sentPassword).toBe("demo-clean-pass-4");
  });

  test(`${which}_the_words_for_a_refused_password_paste_do_not_hide_the_saves_own`, async () => {
    await unlocked();
    const form = await openPasswordForm();
    const box = inputOf(form, "Password");
    // A refused paste, then Save with no title: Save's words take the line over, and a change to the password keeps them.
    expect(pasteInto(box, "a\nb")).toBe(false);
    expect((await within(form).findByRole("alert")).textContent).toBe(PASSWORD_ONE_LINE);
    typeInto(form, "Title", "");
    saveForm(form);
    await waitFor(() => {
      expect(within(form).getByRole("alert").textContent).toBe("Type a title first.");
    });
    expect(inputOf(form, "Title").getAttribute("aria-invalid")).toBe("true");
    typeInto(form, "Password", "demo-typed-three");
    expect(within(form).getByRole("alert").textContent).toBe("Type a title first.");
    expect(inputOf(form, "Title").getAttribute("aria-invalid")).toBe("true");
  });
}

test("the_shown_password_cannot_be_copied_or_cut_natively", async () => {
  await unlocked();
  const form = await openEdit("Bot admin console", "Edit login");
  await waitFor(() => {
    expect(inputOf(form, "Password").value).toBe(NOW_PW);
  });
  const box = inputOf(form, "Password");
  expect(box.type).toBe("text");
  // A copy or a cut aimed at the shown password would skip the clipboard's marks, timer and clearing.
  expect(fireEvent.copy(box)).toBe(false);
  expect(fireEvent.cut(box)).toBe(false);
  expect(box.value).toBe(NOW_PW);
  // The other boxes are left alone, and the new-login form's Password box is as it was: hidden.
  expect(fireEvent.copy(inputOf(form, "Username"))).toBe(true);
  fireEvent.click(within(form).getByRole("button", { name: "Cancel" }));
  const fresh = await openNew("Login");
  expect(inputOf(fresh, "Password").type).toBe("password");
});

test("the_latest_reveal_press_wins_whatever_order_the_answers_arrive_in", async () => {
  await unlocked();
  const panel = await select("Bot admin console");
  const release = shell.holdReveal();
  fireEvent.click(within(panel).getByRole("button", { name: "Reveal earlier password, until 12 March" }));
  fireEvent.click(within(panel).getByRole("button", { name: "Reveal earlier password, until today" }));
  await waitFor(() => {
    expect(shell.revealed).toHaveLength(2);
  });
  // The later press is answered first, then the earlier one's answer comes late: it does not replace what was chosen last.
  act(() => {
    shell.releaseNewestReveal();
  });
  expect((await within(panel).findByRole("textbox", { name: "Earlier password, until today" })).textContent).toBe(OLD_ONE);
  act(() => {
    shell.releaseOneReveal();
  });
  await act(async () => {
    await Promise.resolve();
  });
  expect(within(panel).queryByRole("textbox", { name: "Earlier password, until 12 March" })).toBeNull();
  expect(within(panel).getByRole("textbox", { name: "Earlier password, until today" }).textContent).toBe(OLD_ONE);
  nowhereOnThePage(OLD_TWO);
  release();

  // The other order is the same: the later press is shown.
  fireEvent.click(within(panel).getByRole("button", { name: "Hide earlier password, until today" }));
  const again = shell.holdReveal();
  fireEvent.click(within(panel).getByRole("button", { name: "Reveal earlier password, until 12 March" }));
  fireEvent.click(within(panel).getByRole("button", { name: "Reveal earlier password, until 9 November 2025" }));
  await waitFor(() => {
    expect(shell.revealed).toHaveLength(4);
  });
  again();
  expect((await within(panel).findByRole("textbox", { name: "Earlier password, until 9 November 2025" })).textContent).toBe(OLD_THREE);
  expect(within(panel).queryByRole("textbox", { name: "Earlier password, until 12 March" })).toBeNull();
  nowhereOnThePage(OLD_TWO);
});
