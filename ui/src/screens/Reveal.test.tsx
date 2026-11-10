// Reveal on a key's value and on a login's password (3d, 11a's Reveal): one lifecycle for both. A value is on the page only
// while the person has asked for it and nothing has changed since: Hide, another item, a form, another folder, the panel
// closing, the same item opening again and a lock each end it, and an answer that comes late never puts it back.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import App from "../App";
import { debugState, resetStoreForTests } from "../store";
import { readBeside } from "../testing/files";
import { FOLDER, installFakeShell, itemId, PASSWORD, sampleItems, type FakeItem, type FakeShell } from "../testing/fakeShell";

const { invoke, listen } = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

let shell: FakeShell;

beforeEach(() => {
  for (const style of document.querySelectorAll("style")) style.remove();
  resetStoreForTests();
  invoke.mockReset();
  listen.mockReset();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-06T12:00:00Z"));
});

/// Made up, and not any real key or password.
const BOT_TOKEN = "demo-telegram-7741-xxxx";
const LOGIN_PASSWORD = "demo-login-pass-3318";
const SPACED = "two  spaces\tand a tab";

function items(): FakeItem[] {
  const list = sampleItems().map((item) => (item.id === itemId(1) ? { ...item, password: LOGIN_PASSWORD } : item));
  return [
    ...list,
    { id: itemId(20), kind: "key", title: "TELEGRAM_BOT_TOKEN", collection: FOLDER, value: BOT_TOKEN, modified_at: "2026-11-04T09:00:00Z" },
    { id: itemId(21), kind: "key", title: "SPACED_KEY", collection: FOLDER, value: SPACED, modified_at: "2026-11-04T09:00:00Z" },
  ];
}

async function unlocked() {
  shell = installFakeShell(invoke, listen, [{ id: 7, name: "My vault", items: items() }]);
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

async function select(title: string) {
  const row = new RegExp(String.raw`^(Login|Key|Note|File):\s*${title}`);
  fireEvent.click(await screen.findByRole("button", { name: row }));
  const panel = await screen.findByRole("complementary", { name: title });
  await within(panel).findByRole("button", { name: /^(Reveal|Hide)$/ });
  return panel;
}

/** The two kinds of value that can be revealed, with the words each uses. */
const KINDS = [
  { what: "key", title: "TELEGRAM_BOT_TOKEN", other: "SPACED_KEY", box: "Key value", value: BOT_TOKEN, field: "key_value", copy: "Copy key" },
  { what: "login", title: "Bot admin console", other: "Error tracker", box: "Password", value: LOGIN_PASSWORD, field: "password", copy: "Copy password" },
] as const;

function nowhereOnThePage(value: string) {
  expect(document.body.textContent).not.toContain(value);
  expect(JSON.stringify(debugState())).not.toContain(value);
}

for (const kind of KINDS) {
  test(`${kind.what}_value_hidden_until_reveal_and_asked_by_field`, async () => {
    await unlocked();
    const panel = await select(kind.title);
    expect(within(panel).queryByRole("textbox", { name: kind.box })).toBeNull();
    expect(invoke.mock.calls.some(([cmd]) => cmd === "reveal_password")).toBe(false);
    nowhereOnThePage(kind.value);

    fireEvent.click(within(panel).getByRole("button", { name: "Reveal" }));
    const shown = await within(panel).findByRole("textbox", { name: kind.box });
    expect(shown.textContent).toBe(kind.value);
    const live = shell.sessionOf(7);
    expect(shell.revealed).toEqual([
      { session: live?.session, generation: live?.generation, id: kind.what === "key" ? itemId(20) : itemId(1), field: kind.field },
    ]);
    // In the same guarded box: Geist Mono, not selectable, named for what it is, and in no label or title.
    expect(shown.classList.contains("kval")).toBe(true);
    expect(shown.getAttribute("style")).toBeNull();
    for (const element of document.querySelectorAll("*")) {
      for (const name of element.getAttributeNames()) expect(element.getAttribute(name)).not.toContain(kind.value);
    }
    // The button is Hide now, and Copy still copies in Rust.
    expect(within(panel).queryByRole("button", { name: "Reveal" })).toBeNull();
    expect(within(panel).getByRole("button", { name: kind.copy })).toBeTruthy();

    fireEvent.click(within(panel).getByRole("button", { name: "Hide" }));
    expect(within(panel).queryByRole("textbox", { name: kind.box })).toBeNull();
    nowhereOnThePage(kind.value);
    expect(within(panel).getByRole("button", { name: "Reveal" })).toBeTruthy();
    // Asked again, it is shown again: Hide does not shut Reveal.
    fireEvent.click(within(panel).getByRole("button", { name: "Reveal" }));
    expect((await within(panel).findByRole("textbox", { name: kind.box })).textContent).toBe(kind.value);
  });

  test(`${kind.what}_ctrl_c_on_the_revealed_value_is_the_copy_button`, async () => {
    await unlocked();
    const panel = await select(kind.title);
    fireEvent.click(within(panel).getByRole("button", { name: "Reveal" }));
    const shown = await within(panel).findByRole("textbox", { name: kind.box });
    shown.focus();
    expect(fireEvent.copy(shown)).toBe(false);
    expect(fireEvent.cut(shown)).toBe(false);
    await waitFor(() => {
      expect(shell.copied).toHaveLength(1);
    });
    expect(shell.copied[0]).toMatchObject({ field: kind.field });
    // Copied through the shell: its words are the usual ones, and the value is not among them.
    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toContain(kind.what === "key" ? "Key copied" : "Password copied");
    });
    expect(screen.getByRole("status").textContent).not.toContain(kind.value);
  });

  test(`${kind.what}_reveal_cleared_on_lock_and_when_another_item_opens`, async () => {
    await unlocked();
    const panel = await select(kind.title);
    fireEvent.click(within(panel).getByRole("button", { name: "Reveal" }));
    await within(panel).findByRole("textbox", { name: kind.box });

    // Another item opens: the value is off the page and out of the store; coming back, it is hidden.
    const other = await select(kind.other);
    expect(within(other).queryByRole("textbox")).toBeNull();
    nowhereOnThePage(kind.value);
    const back = await select(kind.title);
    expect(within(back).queryByRole("textbox", { name: kind.box })).toBeNull();

    // A lock takes it with the vault's screen, saying nothing; unlocked again, it is hidden again.
    fireEvent.click(within(back).getByRole("button", { name: "Reveal" }));
    await within(back).findByRole("textbox", { name: kind.box });
    act(() => {
      shell.lock(shell.sessionOf(7)?.session ?? 0);
    });
    await screen.findByLabelText(/^Password for /);
    nowhereOnThePage(kind.value);
    expect(screen.queryByRole("alert")).toBeNull();
    await unlockThroughTheScreen();
    const again = await select(kind.title);
    expect(within(again).queryByRole("textbox", { name: kind.box })).toBeNull();
    nowhereOnThePage(kind.value);
  });

  // Finding 1, first sequence: Reveal pressed twice while the answer is delayed. Each press accepts only its own answer (the
  // latest press wins), so the first answer is dropped and the second shows the value; Hide takes it away, and an answer that
  // comes after must not put it back.
  test(`${kind.what}_a_second_reveal_answer_after_hide_does_not_show_the_value`, async () => {
    await unlocked();
    const panel = await select(kind.title);
    const release = shell.holdReveal();
    const reveal = within(panel).getByRole("button", { name: "Reveal" });
    fireEvent.click(reveal);
    fireEvent.click(reveal);
    await waitFor(() => {
      expect(shell.revealed).toHaveLength(2);
    });
    // The earlier press's answer comes first and is not the latest press's: nothing shows.
    await act(async () => {
      shell.releaseOneReveal();
      await Promise.resolve();
    });
    expect(within(panel).queryByRole("textbox", { name: kind.box })).toBeNull();
    // The latest press's answer comes: it shows. Hide takes it away.
    await act(async () => {
      shell.releaseOneReveal();
      await Promise.resolve();
    });
    expect((await within(panel).findByRole("textbox", { name: kind.box })).textContent).toBe(kind.value);
    fireEvent.click(within(panel).getByRole("button", { name: "Hide" }));
    expect(within(panel).queryByRole("textbox", { name: kind.box })).toBeNull();
    await act(async () => {
      release();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(within(panel).queryByRole("textbox", { name: kind.box })).toBeNull();
    expect(within(panel).getByRole("button", { name: "Reveal" })).toBeTruthy();
    nowhereOnThePage(kind.value);
  });

  // The latest press is answered first, Hide takes the value away, and the earlier press's answer, which comes late, does not
  // put it back.
  test(`${kind.what}_an_earlier_press_answered_late_after_hide_does_not_show_the_value`, async () => {
    await unlocked();
    const panel = await select(kind.title);
    const release = shell.holdReveal();
    const reveal = within(panel).getByRole("button", { name: "Reveal" });
    fireEvent.click(reveal);
    fireEvent.click(reveal);
    await waitFor(() => {
      expect(shell.revealed).toHaveLength(2);
    });
    await act(async () => {
      shell.releaseNewestReveal();
      await Promise.resolve();
    });
    expect((await within(panel).findByRole("textbox", { name: kind.box })).textContent).toBe(kind.value);
    fireEvent.click(within(panel).getByRole("button", { name: "Hide" }));
    await act(async () => {
      release();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(within(panel).queryByRole("textbox", { name: kind.box })).toBeNull();
    nowhereOnThePage(kind.value);
  });

  // Finding 1, second sequence: Reveal, then the panel is closed and the same item opened again; the answer that comes now
  // belongs to the earlier opening and must not show on the new one.
  test(`${kind.what}_an_answer_after_close_and_reopen_of_the_same_item_does_not_show_the_value`, async () => {
    await unlocked();
    const panel = await select(kind.title);
    const release = shell.holdReveal();
    fireEvent.click(within(panel).getByRole("button", { name: "Reveal" }));
    await waitFor(() => {
      expect(shell.revealed).toHaveLength(1);
    });
    fireEvent.click(within(panel).getByRole("button", { name: "Close panel" }));
    expect(screen.queryByRole("complementary")).toBeNull();
    const reopened = await select(kind.title);
    await act(async () => {
      release();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(within(reopened).queryByRole("textbox", { name: kind.box })).toBeNull();
    expect(within(reopened).getByRole("button", { name: "Reveal" })).toBeTruthy();
    nowhereOnThePage(kind.value);
  });

  // A form or another folder meanwhile ends it too.
  test(`${kind.what}_an_answer_after_a_form_or_another_folder_does_not_show_the_value`, async () => {
    await unlocked();
    const panel = await select(kind.title);
    const release = shell.holdReveal();
    fireEvent.click(within(panel).getByRole("button", { name: "Reveal" }));
    await waitFor(() => {
      expect(shell.revealed).toHaveLength(1);
    });
    // A form takes the panel, is cancelled, and the same item is opened again.
    const add = screen.getByRole("button", { name: "Add" });
    fireEvent.pointerDown(add, { button: 0 });
    fireEvent.click(add);
    fireEvent.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: "Note" }));
    const form = await screen.findByRole("complementary", { name: "New note" });
    fireEvent.click(within(form).getByRole("button", { name: "Cancel" }));
    const reopened = await select(kind.title);
    await act(async () => {
      release();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(within(reopened).queryByRole("textbox", { name: kind.box })).toBeNull();
    nowhereOnThePage(kind.value);
  });
}

test("a_login_in_a_search_result_has_no_reveal", async () => {
  await unlocked();
  fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
  const dialog = await screen.findByRole("dialog", { name: "Search every unlocked vault" });
  fireEvent.change(within(dialog).getByRole("textbox", { name: "Search every unlocked vault" }), { target: { value: "bot" } });
  await within(dialog).findByRole("button", { name: /^Login:\s*Bot admin console/ });
  expect(within(dialog).queryByRole("button", { name: /reveal/i })).toBeNull();
});

test("revealed_values_keep_their_spaces_and_tabs", async () => {
  const css = readBeside(import.meta.url, "../styles/components.css");
  // The class every revealed value wears keeps what was typed: runs of spaces, tabs and lines, wrapping at the edge.
  expect(/\.kval\s*\{[^}]*white-space:\s*pre-wrap/.test(css)).toBe(true);
  await unlocked();
  const panel = await select("SPACED_KEY");
  fireEvent.click(within(panel).getByRole("button", { name: "Reveal" }));
  const shown = await within(panel).findByRole("textbox", { name: "Key value" });
  expect(shown.classList.contains("kval")).toBe(true);
  expect(shown.textContent).toBe(SPACED);
});
