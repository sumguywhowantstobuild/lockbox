// Plan 4C Task 3's screens: change a vault's password (27a, 27b, 27c), Ask 16 for each vault, and the two questions that lead to it (Ask 9, Ask 2).
// Every case runs through the real App against the pretend shell, as a person would reach it: the lock screen, Settings (or the question), the form.
// Typed passwords are made up (`MU-`), and a test of a wipe looks for them in the fields, the page and the store.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import App from "../App";
import { messageFor } from "../messages";
import { VaultMark, vaultLook } from "../parts/Pattern";
import { debugState, openChangePassword, resetStoreForTests, unlock } from "../store";
import { expectNoAxe } from "../testing/axe";
import { installFakeShell, PASSWORD, sampleItems, WRONG_PASSWORD, type FakeShell, type FakeVault } from "../testing/fakeShell";

const { invoke, listen } = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));

afterEach(cleanup);

let shell: FakeShell;

beforeEach(() => {
  for (const style of document.querySelectorAll("style")) style.remove();
  resetStoreForTests();
  invoke.mockReset();
  listen.mockReset();
});

const NEW = "MU-new passphrase 2026";
const NEW_2 = "MU-another passphrase 2027";
const WRONG_ONE = "MU-not the password";

const BACKUPS_WORDS = "Backups you already made still need the old details.";
const LIMIT_WORDS =
  "Changing the password doesn't lock out an old copy. Anyone who has an old copy of this vault's details (an earlier copy of its folder, or an old backup) and its old password or recovery key can read your current and future items and files, if they get copies of them.";
const OFFER_TITLE = "Make a fresh backup now?";
const OFFER_WORDS = "Backups you already made still need the old details. A fresh one opens with what you use today.";
const WRONG_CURRENT = "That isn't the current password.";
const TOO_SHORT = "At least 12 characters.";
const MISMATCH = "The two new passwords don't match.";
const ASK16 = "Your new password was saved, but the vault locked before Lockbox could say so. Unlock with the new one.";
const ASK9 =
  "Opened from the backup copy of this vault's details. If you changed this vault's password recently, it may need your previous password. Change the password again now that it's open.";

function vault(id: number, name: string, extra: Partial<FakeVault> = {}): FakeVault {
  return { id, name, items: sampleItems(), ...extra };
}

function mine(extra: Partial<FakeVault> = {}): FakeVault[] {
  return [vault(7, "My vault", extra)];
}

function side(): HTMLElement {
  return screen.getByRole("navigation", { name: "Vault and folders" });
}

function sent(cmd: string): Record<string, unknown>[] {
  return invoke.mock.calls.filter(([name]) => name === cmd).map(([, args]) => args as Record<string, unknown>);
}

function sessionOfVault(id: number): { session: number; generation: number } {
  const live = shell.sessionOf(id);
  if (live === undefined) throw new Error(`vault ${String(id)} is not open`);
  return { session: live.session, generation: live.generation };
}

async function unlockWith(password: string) {
  const field = await screen.findByLabelText(/^Password for /);
  fireEvent.change(field, { target: { value: password } });
  fireEvent.submit((field as HTMLInputElement).form as HTMLFormElement);
}

async function unlocked(list: FakeVault[] = mine()) {
  shell = installFakeShell(invoke, listen, list);
  const view = render(<App />);
  await unlockWith(PASSWORD);
  await screen.findByRole("heading", { level: 1, name: "All items", hidden: true });
  return view;
}

/** Every vault of `list` open, the first through the lock screen and the rest as the store opens them: the last one is on screen. */
async function allOpen(list: FakeVault[]) {
  const view = await unlocked(list);
  for (const one of list.slice(1)) {
    await act(async () => {
      expect(await unlock({ list: shell.listIdentity(), id: one.id }, PASSWORD)).toBe("opened");
    });
  }
  return view;
}

/** Starts again with a fresh page and shell (a test that runs several cases). */
function fresh() {
  cleanup();
  resetStoreForTests();
  invoke.mockReset();
  listen.mockReset();
}

/** Settings from the side menu, then its Change password row. Gives the form (27a). */
async function openForm(): Promise<HTMLElement> {
  fireEvent.click(within(side()).getByRole("button", { name: "Settings" }));
  const settings = await screen.findByRole("complementary", { name: "Settings" });
  fireEvent.click(within(settings).getByRole("button", { name: "Change password" }));
  return screen.findByRole("complementary", { name: "Change password" });
}

function inputs(place: HTMLElement): HTMLInputElement[] {
  return Array.from(place.querySelectorAll("input"));
}

function typeInto(panel: HTMLElement, label: string, value: string) {
  fireEvent.change(within(panel).getByLabelText(label), { target: { value } });
}

function fill(panel: HTMLElement, current: string, next: string, again: string = next) {
  typeInto(panel, "Current password", current);
  typeInto(panel, "New password", next);
  typeInto(panel, "New password again", again);
}

/** Fills the form with made-up text and shows the page-check can find it: all three fields hold it, so a later "nothing found" is a real wipe. */
function fillMarked(panel: HTMLElement) {
  fill(panel, "MU-typed current", "MU-typed new passphrase");
  expect(foundOnPage(["MU-typed"])).toHaveLength(3);
}

function submit(panel: HTMLElement) {
  fireEvent.click(within(panel).getByRole("button", { name: "Change password" }));
}

/** The vault menu, opened as a click does, and the row for a vault chosen (by its place among the open ones when two are named alike). */
async function switchTo(name: string, at?: number) {
  const opener = screen.getByRole("button", { name: /, vault menu$/ });
  opener.focus();
  fireEvent.pointerDown(opener, { button: 0 });
  fireEvent.click(opener);
  const menu = await screen.findByRole("menu");
  const rows = within(menu).getAllByRole("menuitemradio");
  const row = at === undefined ? rows.find((one) => one.textContent === name) : rows[at];
  if (row === undefined) throw new Error(`no row for ${name}`);
  fireEvent.click(row);
  await waitFor(() => {
    expect(screen.queryByRole("menu")).toBeNull();
  });
}

/** Whatever of a made-up password is in a field, in the words on the page or in the store: the list of where it was found. */
function foundOnPage(secrets: string[]): string[] {
  const found: string[] = [];
  const held = JSON.stringify(debugState());
  const words = document.body.textContent;
  for (const secret of secrets) {
    for (const box of document.querySelectorAll("input")) if (box.value.includes(secret)) found.push(`a field holds ${secret}`);
    if (held.includes(secret)) found.push(`the store holds ${secret}`);
    if (words.includes(secret)) found.push(`the page says ${secret}`);
  }
  return found;
}

const SECRETS = [PASSWORD, NEW, NEW_2, WRONG_ONE, "MU-typed"];

test("change_password_shows_which_vault", async () => {
  await allOpen([vault(7, "My vault"), vault(8, "Home")]);
  // Home is the one on screen: the form says "For Home.", and the window carries Home's own colour and mark (its place on the list).
  let panel = await openForm();
  expect(within(panel).getByText("For Home.")).toBeTruthy();
  const markOf = (position: number) => {
    const drawn = render(<VaultMark points={vaultLook(position, false).points} />);
    const d = drawn.container.querySelector("path")?.getAttribute("d");
    drawn.unmount();
    return d;
  };
  const onScreen = () => document.querySelector(".vprint path")?.getAttribute("d");
  expect(onScreen()).toBe(markOf(1));
  expect(document.querySelector(".app")?.classList.contains(`v-${vaultLook(1, false).accent}`)).toBe(true);
  // Switch to My vault: its own form says so, with its own colour and mark.
  await switchTo("My vault");
  panel = await openForm();
  expect(within(panel).getByText("For My vault.")).toBeTruthy();
  expect(onScreen()).toBe(markOf(0));
  expect(onScreen()).not.toBe(markOf(1));
  expect(document.querySelector(".app")?.classList.contains(`v-${vaultLook(0, false).accent}`)).toBe(true);
});

test("change_password_asks_current_then_new_twice", async () => {
  const vaults = mine();
  await unlocked(vaults);
  const panel = await openForm();
  expect(within(panel).getByRole("heading", { level: 2, name: "Change password" })).toBeTruthy();
  // In order: the current password, then the new one, then the new one again; each hidden.
  expect(inputs(panel).map((box) => box.labels?.[0]?.textContent)).toEqual(["Current password", "New password", "New password again"]);
  expect(inputs(panel).map((box) => box.type)).toEqual(["password", "password", "password"]);
  expect(within(panel).getAllByRole("button").map((button) => button.getAttribute("aria-label") ?? button.textContent)).toEqual([
    "Close panel",
    "Cancel",
    "Change password",
  ]);
  // Nothing is sent before Change password is pressed.
  expect(sent("change_password")).toEqual([]);
  fill(panel, PASSWORD, NEW);
  expect(sent("change_password")).toEqual([]);
  submit(panel);
  // The command's actual arguments: this vault's session and generation, the current password and the new one, once.
  await screen.findByRole("dialog", { name: OFFER_TITLE });
  expect(sent("change_password")).toEqual([{ ...sessionOfVault(7), current_password: PASSWORD, new_password: NEW }]);
  // The vault's details changed in the shell, and the form is gone.
  expect(vaults[0]?.password).toBe(NEW);
  expect(screen.queryByRole("complementary", { name: "Change password" })).toBeNull();
});

test("change_password_states_the_backup_limit", async () => {
  await unlocked();
  const panel = await openForm();
  // Existing backups still need the old details, and spec 5.3's limit in full: an old copy of the details with the old password or key reads
  // current and future items and files, if it gets copies of them. As 27a draws it: one note, the backup sentence first, then the limit.
  const note = within(panel).getByRole("note");
  expect(note.textContent).toBe(`${BACKUPS_WORDS} ${LIMIT_WORDS}`);
  expect(within(panel).getAllByRole("note")).toHaveLength(1);
  expect(LIMIT_WORDS).toMatch(/old copy of this vault's details/);
  expect(LIMIT_WORDS).toMatch(/old password or recovery key/);
  expect(LIMIT_WORDS).toMatch(/current and future items and files/);
  expect(LIMIT_WORDS).toMatch(/if they get copies of them/);
});

test("short_or_mismatched_new_password_is_said_on_the_form", async () => {
  const vaults = mine();
  await unlocked(vaults);
  const panel = await openForm();
  // Under 12 characters, said on the new password's own field; nothing is sent, and what was typed stays to be mended.
  fill(panel, PASSWORD, "MU-short", "MU-short");
  submit(panel);
  const alerts = within(panel).getAllByRole("alert");
  expect(alerts.map((alert) => alert.textContent)).toEqual([TOO_SHORT]);
  expect(within(panel).getByLabelText("New password").getAttribute("aria-invalid")).toBe("true");
  expect(sent("change_password")).toEqual([]);
  expect(inputs(panel).map((box) => box.value)).toEqual([PASSWORD, "MU-short", "MU-short"]);
  // Long enough, but the two don't match: said on the second one.
  fill(panel, PASSWORD, NEW, NEW_2);
  expect(within(panel).queryAllByRole("alert")).toEqual([]);
  submit(panel);
  expect(within(panel).getAllByRole("alert").map((alert) => alert.textContent)).toEqual([MISMATCH]);
  expect(within(panel).getByLabelText("New password again").getAttribute("aria-invalid")).toBe("true");
  expect(sent("change_password")).toEqual([]);
  // Both at once, as 27b draws it.
  fill(panel, PASSWORD, "MU-short", "MU-other");
  submit(panel);
  expect(within(panel).getAllByRole("alert").map((alert) => alert.textContent)).toEqual([TOO_SHORT, MISMATCH]);
  expect(sent("change_password")).toEqual([]);
  expect(vaults[0]?.password).toBeUndefined();
  // Mended, it goes.
  fill(panel, PASSWORD, NEW);
  submit(panel);
  await screen.findByRole("dialog", { name: OFFER_TITLE });
  expect(sent("change_password")).toHaveLength(1);
});

test("a_short_new_password_is_said_once", async () => {
  await unlocked();
  const panel = await openForm();
  // Typing shows the rule with its count; once the form says the password is too short, that one line is all there is under the box.
  typeInto(panel, "New password", "MU-short");
  expect(within(panel).getByText("At least 12 characters · 8 so far")).toBeTruthy();
  fill(panel, PASSWORD, "MU-short", "MU-short");
  submit(panel);
  expect(within(panel).getAllByText(TOO_SHORT)).toHaveLength(1);
  expect(within(panel).queryByText(/so far$/)).toBeNull();
  const box = within(panel).getByLabelText("New password");
  // The box points at the error alone while it shows.
  const described = (box.getAttribute("aria-describedby") ?? "").split(" ").map((id) => document.getElementById(id)?.textContent);
  expect(described).toEqual([TOO_SHORT]);
  // Typed again, the error goes and the rule with its count comes back.
  typeInto(panel, "New password", "MU-shorter");
  expect(within(panel).queryAllByRole("alert")).toEqual([]);
  expect(within(panel).getByText("At least 12 characters · 10 so far")).toBeTruthy();
});

test("focus_goes_to_the_box_the_form_is_about", async () => {
  await unlocked();
  let panel = await openForm();
  // A page-side problem: focus moves to the first box that has one, from wherever the Enter was pressed.
  fill(panel, PASSWORD, "MU-short", "MU-short");
  within(panel).getByLabelText("New password again").focus();
  submit(panel);
  expect(document.activeElement).toBe(within(panel).getByLabelText("New password"));
  fill(panel, PASSWORD, NEW, NEW_2);
  within(panel).getByLabelText("Current password").focus();
  submit(panel);
  expect(document.activeElement).toBe(within(panel).getByLabelText("New password again"));
  // The shell's wrong current password: said on Current password, and focus goes there (the box with the error), not left in the last box.
  fill(panel, WRONG_ONE, NEW);
  within(panel).getByLabelText("New password again").focus();
  submit(panel);
  await within(panel).findByRole("alert");
  await waitFor(() => {
    expect(document.activeElement).toBe(within(panel).getByLabelText("Current password"));
  });
  // An empty current password is the first box with a problem.
  fill(panel, "", NEW);
  within(panel).getByLabelText("New password again").focus();
  submit(panel);
  expect(document.activeElement).toBe(within(panel).getByLabelText("Current password"));
  // The shell's own refusal of the new password (it counts as the engine does) puts focus on New password.
  shell.refuseNext("change_password", { code: "core", kind: "password_too_short", min: 12 });
  fill(panel, PASSWORD, NEW);
  within(panel).getByLabelText("New password again").focus();
  submit(panel);
  await within(panel).findByRole("alert");
  await waitFor(() => {
    expect(document.activeElement).toBe(within(panel).getByLabelText("New password"));
  });
  // A refusal about the form as a whole moves no focus: it stays where the person was.
  shell.refuseNext("change_password", { code: "io", what: "disk full" });
  fill(panel, PASSWORD, NEW);
  const again = within(panel).getByLabelText("New password again");
  again.focus();
  submit(panel);
  await within(panel).findByRole("alert");
  expect(document.activeElement).toBe(again);
  // A form opened afresh starts on its heading, as before.
  fresh();
  await unlocked();
  panel = await openForm();
  expect(document.activeElement).toBe(within(panel).getByRole("heading", { level: 2, name: "Change password" }));
});

test("the_offers_answer_puts_focus_back_on_settings", async () => {
  for (const answer of ["Not now", "Escape"] as const) {
    fresh();
    await unlocked();
    const panel = await openForm();
    fill(panel, PASSWORD, NEW);
    submit(panel);
    const dialog = await screen.findByRole("dialog", { name: OFFER_TITLE });
    if (answer === "Not now") fireEvent.click(within(dialog).getByRole("button", { name: "Not now" }));
    else fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: OFFER_TITLE })).toBeNull();
    });
    // The form and Settings are gone, so focus goes to the button that opened them, not to nothing.
    await waitFor(() => {
      expect(document.activeElement, answer).toBe(within(side()).getByRole("button", { name: "Settings" }));
    });
  }
});

test("the_count_matches_the_core_with_combining_and_non_bmp_characters", async () => {
  await unlocked();
  const panel = await openForm();
  const box = within(panel).getByLabelText<HTMLInputElement>("New password");
  const status = within(panel).getByRole("status");
  const hint = () => box.closest(".fbox")?.querySelector(".fhint");
  // What the core counts (Unicode characters after NFC) against what the page says, for text whose length is not its count of UTF-16 units.
  const cases: { text: string; count: number }[] = [
    // "e" and a combining accent make one character after NFC: 11 of them are 22 units but 11 characters.
    { text: "é".repeat(11), count: 11 },
    { text: "é".repeat(12), count: 12 },
    // "q" with an accent has no single character, so it stays two: 6 of them are 12 characters.
    { text: "q́".repeat(6), count: 12 },
    // Outside the Basic Multilingual Plane a character is two units: 11 of them are 11 characters, 12 are 12.
    { text: "\u{1F600}".repeat(11), count: 11 },
    { text: "\u{1F600}".repeat(12), count: 12 },
    // Hangul jamo join into one syllable: 12 syllables are 36 units.
    { text: "한".repeat(12), count: 12 },
    { text: "한".repeat(11), count: 11 },
  ];
  const { session, generation } = sessionOfVault(7);
  for (const { text, count } of cases) {
    fireEvent.change(box, { target: { value: text } });
    if (count < 12) {
      expect(hint()?.textContent, text).toBe(`At least 12 characters · ${String(count)} so far`);
      expect(hint()?.classList.contains("ok")).toBe(false);
    } else {
      expect(hint()?.textContent, text).toBe("12 characters or more");
      expect(hint()?.classList.contains("ok")).toBe(true);
    }
    // The core's own answer for the same text (the new password's length is checked before the current one, which is wrong here on purpose):
    // short is `password_too_short`, long enough goes on to the check of the current password.
    const asked = (invoke as (cmd: string, args: unknown) => Promise<unknown>)("change_password", {
      session,
      generation,
      current_password: WRONG_ONE,
      new_password: text,
    });
    const answer = await asked.then(
      () => null,
      (refusal: unknown) => refusal,
    );
    expect(answer, text).toEqual(count < 12 ? { code: "core", kind: "password_too_short", min: 12 } : WRONG_PASSWORD);
  }
  // The screen-reader line says "12 characters or more" once, when the minimum is reached, and not again as more is typed.
  fireEvent.change(box, { target: { value: "" } });
  expect(status.textContent).toBe("");
  const watch = new MutationObserver(() => undefined);
  watch.observe(status, { childList: true, characterData: true, subtree: true });
  for (let length = 1; length <= 16; length += 1) fireEvent.change(box, { target: { value: "x".repeat(length) } });
  // Sixteen keystrokes, and the line changed exactly once: at the twelfth.
  expect(watch.takeRecords()).toHaveLength(1);
  expect(status.textContent).toBe("12 characters or more");
  // And the count is not announced as it changes: only the status line is live, and the hint is not.
  expect(hint()?.getAttribute("aria-live")).toBeNull();
  watch.disconnect();
});

test("wrong_current_password_is_said_with_empty_fields", async () => {
  const vaults = mine();
  await unlocked(vaults);
  const panel = await openForm();
  fill(panel, WRONG_ONE, NEW);
  submit(panel);
  const alert = await within(panel).findByRole("alert");
  expect(alert.textContent).toBe(WRONG_CURRENT);
  // The reason is on the current password's own field, and every field is empty.
  expect(within(panel).getByLabelText("Current password").getAttribute("aria-invalid")).toBe("true");
  expect(inputs(panel).map((box) => box.value)).toEqual(["", "", ""]);
  // One command, with what was typed; the vault's password is as it was, and no offer of a backup was made.
  expect(sent("change_password")).toEqual([{ ...sessionOfVault(7), current_password: WRONG_ONE, new_password: NEW }]);
  expect(vaults[0]?.password).toBeUndefined();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(foundOnPage(SECRETS)).toEqual([]);
  // The words come through the table, from a refusal of the page's own that the shell's wrong password became.
  expect(messageFor({ code: "page", kind: "wrong_current_password" }).title).toBe(WRONG_CURRENT);
  expect(messageFor(WRONG_PASSWORD).title).toBe("Wrong password.");
});

test("change_password_wipes_the_typed_secrets_pending_refused_back_and_locked", async () => {
  // Pending: the fields, the page and the store are clear the moment it is sent, before the answer comes.
  const vaults = mine();
  await unlocked(vaults);
  let panel = await openForm();
  const release = shell.holdChangePassword();
  fill(panel, PASSWORD, NEW);
  // The check can find a secret: it is in the field now (and the store is read, with its vault, so an empty answer is not an unread store).
  expect(foundOnPage([NEW, PASSWORD])).toEqual([`a field holds ${NEW}`, `a field holds ${NEW}`, `a field holds ${PASSWORD}`]);
  expect(JSON.stringify(debugState())).toContain("My vault");
  submit(panel);
  await waitFor(() => {
    expect(sent("change_password")).toHaveLength(1);
  });
  expect(inputs(panel).map((box) => box.value)).toEqual(["", "", ""]);
  expect(foundOnPage(SECRETS)).toEqual([]);
  // While it is out the fields can't be typed in (text typed meanwhile would outlive a refusal), and a second press sends nothing.
  expect(inputs(panel).map((box) => box.readOnly)).toEqual([true, true, true]);
  fill(panel, PASSWORD, NEW_2);
  expect(inputs(panel).map((box) => box.value)).toEqual(["", "", ""]);
  expect(foundOnPage(SECRETS)).toEqual([]);
  submit(panel);
  expect(sent("change_password")).toHaveLength(1);
  act(() => {
    release();
  });
  await screen.findByRole("dialog", { name: OFFER_TITLE });
  expect(foundOnPage(SECRETS.filter((one) => one !== PASSWORD))).toEqual([]);

  // Refused: empty fields with the reason.
  fresh();
  await unlocked();
  panel = await openForm();
  fill(panel, WRONG_ONE, NEW);
  submit(panel);
  await within(panel).findByText(WRONG_CURRENT);
  expect(inputs(panel).map((box) => box.value)).toEqual(["", "", ""]);
  expect(foundOnPage(SECRETS)).toEqual([]);

  // Back: Cancel with the fields typed, and the form opened again, is empty.
  fresh();
  await unlocked();
  panel = await openForm();
  fillMarked(panel);
  fireEvent.click(within(panel).getByRole("button", { name: "Cancel" }));
  await waitFor(() => {
    expect(screen.queryByRole("complementary", { name: "Change password" })).toBeNull();
  });
  expect(foundOnPage(SECRETS)).toEqual([]);
  panel = await openForm();
  expect(inputs(panel).map((box) => box.value)).toEqual(["", "", ""]);
  // And the panel's own close button does the same.
  fillMarked(panel);
  fireEvent.click(within(panel).getByRole("button", { name: "Close panel" }));
  await waitFor(() => {
    expect(screen.queryByRole("complementary", { name: "Change password" })).toBeNull();
  });
  expect(foundOnPage(SECRETS)).toEqual([]);

  // A lock of the vault, with the form typed and not sent: nothing of it stays on the lock screen, or comes back with the next unlock.
  fresh();
  await unlocked();
  panel = await openForm();
  fillMarked(panel);
  act(() => {
    shell.lock(sessionOfVault(7).session);
  });
  await screen.findByLabelText(/^Password for /);
  expect(foundOnPage(SECRETS)).toEqual([]);
  expect(sent("change_password")).toEqual([]);
  await unlockWith(PASSWORD);
  await screen.findByRole("heading", { level: 1, name: "All items", hidden: true });
  panel = await openForm();
  expect(inputs(panel).map((box) => box.value)).toEqual(["", "", ""]);

  // A lock epoch that reaches the page before the vault's own lock does (Lock all, idle, Windows locking) wipes what is typed in the open form.
  fillMarked(panel);
  await act(async () => {
    shell.changeLockEpoch("idle");
    await Promise.resolve();
  });
  expect(inputs(panel).map((box) => box.value)).toEqual(["", "", ""]);
  expect(foundOnPage(SECRETS)).toEqual([]);

  // A lock while the answer is out: the page drops the answer, and nothing typed is anywhere.
  fresh();
  await unlocked();
  panel = await openForm();
  const hold = shell.holdChangePassword();
  fill(panel, PASSWORD, NEW);
  submit(panel);
  await waitFor(() => {
    expect(sent("change_password")).toHaveLength(1);
  });
  act(() => {
    shell.lock(sessionOfVault(7).session);
  });
  await screen.findByLabelText(/^Password for /);
  act(() => {
    hold();
  });
  expect(foundOnPage(SECRETS.filter((one) => one !== PASSWORD))).toEqual([]);
  expect(screen.queryByRole("dialog", { name: OFFER_TITLE })).toBeNull();
});

test("done_offers_a_fresh_backup", async () => {
  const vaults = mine();
  await unlocked(vaults);
  let panel = await openForm();
  fill(panel, PASSWORD, NEW);
  submit(panel);
  // 27c, as drawn: the question over the window, its words word for word, Not now first and Back up now as the way on.
  const dialog = await screen.findByRole("dialog", { name: OFFER_TITLE });
  expect(within(dialog).getByText(OFFER_WORDS)).toBeTruthy();
  expect(within(dialog).getAllByRole("button").map((button) => button.textContent)).toEqual(["Not now", "Back up now"]);
  expect(vaults[0]?.password).toBe(NEW);
  // Back up now opens 22a for this vault (nothing is written until Back up is pressed there).
  fireEvent.click(within(dialog).getByRole("button", { name: "Back up now" }));
  panel = await screen.findByRole("complementary", { name: "Back up" });
  expect(within(panel).getByText("For My vault.")).toBeTruthy();
  expect(screen.queryByRole("dialog", { name: OFFER_TITLE })).toBeNull();
  expect(sent("backup_vault")).toEqual([]);

  // Not now closes it, and opens nothing.
  fresh();
  await unlocked();
  panel = await openForm();
  fill(panel, PASSWORD, NEW);
  submit(panel);
  const again = await screen.findByRole("dialog", { name: OFFER_TITLE });
  fireEvent.click(within(again).getByRole("button", { name: "Not now" }));
  await waitFor(() => {
    expect(screen.queryByRole("dialog", { name: OFFER_TITLE })).toBeNull();
  });
  expect(screen.queryByRole("complementary", { name: "Back up" })).toBeNull();
  expect(screen.queryByRole("complementary", { name: "Change password" })).toBeNull();
  expect(sent("backup_vault")).toEqual([]);
});

test("locked_before_it_could_say_shows_ask_16_on_that_vaults_unlock", async () => {
  // A lock before the headers were written: nothing changed, no Ask 16, and the old password still opens.
  let vaults = mine();
  await unlocked(vaults);
  let panel = await openForm();
  fill(panel, PASSWORD, NEW);
  shell.interruptChangeNext("lock_before_write");
  submit(panel);
  await screen.findByLabelText(/^Password for /);
  expect(screen.queryByText(ASK16)).toBeNull();
  expect(vaults[0]?.password).toBeUndefined();
  await unlockWith(NEW);
  expect((await screen.findByRole("alert")).textContent).toBe("Wrong password.");
  await unlockWith(PASSWORD);
  await screen.findByRole("heading", { level: 1, name: "All items" });

  // A change that landed, whose good answer the lock event overtook: Ask 16 word for word on the lock screen, until that vault is unlocked.
  for (const how of ["lock_after_write", "lock_after_write_as_error"] as const) {
    fresh();
    vaults = mine();
    await unlocked(vaults);
    panel = await openForm();
    fill(panel, PASSWORD, NEW);
    shell.interruptChangeNext(how);
    submit(panel);
    await screen.findByLabelText(/^Password for /);
    expect((await screen.findByText(ASK16)).textContent).toBe(ASK16);
    expect(vaults[0]?.password).toBe(NEW);
    expect(foundOnPage(SECRETS)).toEqual([]);
    // The old password is refused (the note stays), the new one opens, and the note is gone for the next lock.
    await unlockWith(PASSWORD);
    expect((await screen.findByRole("alert")).textContent).toBe("Wrong password.");
    expect(screen.getByText(ASK16)).toBeTruthy();
    await unlockWith(NEW);
    await screen.findByRole("heading", { level: 1, name: "All items" });
    expect(screen.queryByText(ASK16)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Lock all" }));
    await screen.findByLabelText(/^Password for /);
    expect(screen.queryByText(ASK16)).toBeNull();
  }

  // `vault.json` landed though the write came back as an error (`commit` read it back and made the new header live): the shell locks the vault and answers
  // `locked_after_change`, which is the second case's second round above (`lock_after_write_as_error`): Ask 16 says the new password is in effect, and it
  // is, so it is shown only because the new password opens (and the old one is refused). The write that failed before `vault.json` was touched is the
  // plain refusal: said on the form, no Ask 16, the old password still opens and the new one doesn't.
  fresh();
  vaults = mine();
  await unlocked(vaults);
  panel = await openForm();
  fill(panel, PASSWORD, NEW);
  shell.interruptChangeNext({ refused_before_write: { code: "core", kind: "io" } });
  submit(panel);
  await within(panel).findByText("Lockbox couldn't reach that folder or file. Check that the drive is connected, then try again.");
  expect(inputs(panel).map((box) => box.value)).toEqual(["", "", ""]);
  expect(vaults[0]?.password).toBeUndefined();
  expect(screen.queryByText(ASK16)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Lock all" }));
  await screen.findByLabelText(/^Password for /);
  expect(screen.queryByText(ASK16)).toBeNull();
  await unlockWith(NEW);
  expect((await screen.findByRole("alert")).textContent).toBe("Wrong password.");
  await unlockWith(PASSWORD);
  await screen.findByRole("heading", { level: 1, name: "All items" });

  // Another vault is open when the change's vault locks: Ask 16 waits for that vault, isn't shown on the other, and isn't lost.
  fresh();
  vaults = [vault(7, "My vault"), vault(8, "Home")];
  await allOpen(vaults);
  await switchTo("My vault");
  panel = await openForm();
  fill(panel, PASSWORD, NEW);
  shell.interruptChangeNext("lock_after_write");
  submit(panel);
  // My vault has locked; Home is open and on screen. First wait until the page has taken the answer in (the note is kept for My vault, 7, and its session
  // is gone from the page), so that "Home says nothing of it" is not just the answer not having arrived.
  await screen.findByRole("button", { name: "Home, vault menu" });
  await waitFor(() => {
    expect(shell.sessionOf(7)?.unlocked).toBe(false);
    expect(debugState().lockNotes.map((note) => note.vault)).toEqual([7]);
    expect(debugState().sessions.map((one) => one.vaultId)).toEqual([8]);
  });
  expect(screen.queryByText(ASK16)).toBeNull();
  expect(screen.queryByRole("dialog")).toBeNull();
  // Lock Home too: the lock screen, with My vault chosen first. Ask 16 is there for it, and gone when Home is chosen.
  fireEvent.click(screen.getByRole("button", { name: "Lock all" }));
  await screen.findByLabelText(/^Password for /);
  expect(screen.getByRole<HTMLInputElement>("radio", { name: /My vault/ }).checked).toBe(true);
  expect(screen.getByText(ASK16)).toBeTruthy();
  fireEvent.click(screen.getByRole("radio", { name: /Home/ }));
  expect(screen.queryByText(ASK16)).toBeNull();
  // Unlocking Home does not use it up.
  await unlockWith(PASSWORD);
  await screen.findByRole("heading", { level: 1, name: "All items" });
  fireEvent.click(screen.getByRole("button", { name: "Lock all" }));
  await screen.findByLabelText(/^Password for /);
  expect(screen.getByRole<HTMLInputElement>("radio", { name: /My vault/ }).checked).toBe(true);
  expect(screen.getByText(ASK16)).toBeTruthy();
  // Unlocking My vault does.
  await unlockWith(NEW);
  await screen.findByRole("heading", { level: 1, name: "All items" });
  fireEvent.click(screen.getByRole("button", { name: "Lock all" }));
  await screen.findByLabelText(/^Password for /);
  expect(screen.queryByText(ASK16)).toBeNull();
});

test("a_form_left_by_a_switch_sends_nothing", async () => {
  const vaults = [vault(7, "My vault"), vault(8, "Home")];
  await allOpen(vaults);
  // Home is on screen; its form is typed and left by a switch to My vault.
  const panel = await openForm();
  fill(panel, PASSWORD, NEW);
  await switchTo("My vault");
  expect(screen.queryByRole("complementary", { name: "Change password" })).toBeNull();
  expect(foundOnPage(SECRETS)).toEqual([]);
  expect(sent("change_password")).toEqual([]);
  // Back on Home, its form is still open, with every field empty.
  await switchTo("Home");
  const back = await screen.findByRole("complementary", { name: "Change password" });
  expect(within(back).getByText("For Home.")).toBeTruthy();
  expect(inputs(back).map((box) => box.value)).toEqual(["", "", ""]);
  expect(foundOnPage(SECRETS)).toEqual([]);
  expect(sent("change_password")).toEqual([]);
  expect(vaults.map((one) => one.password)).toEqual([undefined, undefined]);
});

test("a_change_sent_before_a_switch_answers_on_its_own_vault", async () => {
  // Two vaults with the same name: only the command's arguments and the vault changed on disk tell them apart.
  const vaults = [vault(7, "My vault"), vault(8, "My vault")];
  await allOpen(vaults);
  // The second one is on screen. Its change is sent, and the person switches to the first before the answer comes.
  const panel = await openForm();
  fill(panel, PASSWORD, NEW);
  const release = shell.holdChangePassword();
  submit(panel);
  await waitFor(() => {
    expect(sent("change_password")).toHaveLength(1);
  });
  expect(sent("change_password")).toEqual([{ ...sessionOfVault(8), current_password: PASSWORD, new_password: NEW }]);
  await switchTo("My vault", 0);
  act(() => {
    release();
  });
  // Only the second vault's details changed. Wait until the page has taken the answer in, in the second vault's own record (and not in the first's),
  // and only then look: the answer is not shown on the first vault, which is on screen.
  expect(vaults.map((one) => one.password)).toEqual([undefined, NEW]);
  const [first, second] = [sessionOfVault(7).session, sessionOfVault(8).session];
  await waitFor(() => {
    expect(debugState().sessions.find((one) => one.session === second)?.passwordChange).toEqual({ phase: "done" });
  });
  expect(debugState().sessions.find((one) => one.session === first)?.passwordChange).toBeNull();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.queryByRole("complementary", { name: "Change password" })).toBeNull();
  // Back on the second vault the answer is there: the offer of a backup, for it.
  await switchTo("My vault", 1);
  const dialog = await screen.findByRole("dialog", { name: OFFER_TITLE });
  fireEvent.click(within(dialog).getByRole("button", { name: "Back up now" }));
  await screen.findByRole("complementary", { name: "Back up" });
  expect(sent("change_password")).toHaveLength(1);
});

test("repeated_wrong_current_passwords_then_the_right_one_changes_it", async () => {
  const vaults = mine();
  await unlocked(vaults);
  const panel = await openForm();
  // No lockout (spec 5.6): each try is answered the same way, with empty fields, and nothing changes until the right one.
  for (const [index, wrong] of ["MU-wrong one", "MU-wrong two", "MU-wrong three"].entries()) {
    fill(panel, wrong, NEW);
    submit(panel);
    await waitFor(() => {
      expect(sent("change_password")).toHaveLength(index + 1);
    });
    await within(panel).findByText(WRONG_CURRENT);
    expect(inputs(panel).map((box) => box.value)).toEqual(["", "", ""]);
    expect(vaults[0]?.password).toBeUndefined();
    expect(sent("change_password")[index]).toMatchObject({ current_password: wrong, new_password: NEW });
  }
  fill(panel, PASSWORD, NEW);
  expect(within(panel).queryByText(WRONG_CURRENT)).toBeNull();
  submit(panel);
  await screen.findByRole("dialog", { name: OFFER_TITLE });
  expect(sent("change_password")).toHaveLength(4);
  expect(vaults[0]?.password).toBe(NEW);
});

test("an_existing_vault_with_a_shorter_password_still_unlocks", async () => {
  // The 12-character minimum is for setting a password, never for unlocking: a vault made with a shorter one (an older version's) opens.
  shell = installFakeShell(invoke, listen, mine({ password: "MU-short" }));
  render(<App />);
  await unlockWith("MU-short");
  await screen.findByRole("heading", { level: 1, name: "All items", hidden: true });
  expect(sent("unlock_vault")).toEqual([{ vault: { list: shell.listIdentity(), id: 7 }, password: "MU-short" }]);
  // Changing it asks for the current one as it is (short), and the new one must be long enough.
  const panel = await openForm();
  fill(panel, "MU-short", NEW);
  submit(panel);
  await screen.findByRole("dialog", { name: OFFER_TITLE });
  expect(sent("change_password")).toHaveLength(1);
});

test("ask_9_and_ask_2_now_show_change_password_for_their_vault", async () => {
  // Ask 9: the design's words in full, with Later and Change password. It opens the form for the vault the question is about.
  const vaults = [vault(7, "My vault"), vault(8, "Home", { usedBackupHeader: true })];
  await allOpen(vaults);
  expect(screen.getByText(ASK9)).toBeTruthy();
  const notice = screen.getByText(ASK9).closest(".ask") as HTMLElement;
  expect(within(notice).getAllByRole("button").map((button) => button.textContent)).toEqual(["Later", "Change password"]);
  fireEvent.click(within(notice).getByRole("button", { name: "Change password" }));
  const panel = await screen.findByRole("complementary", { name: "Change password" });
  expect(within(panel).getByText("For Home.")).toBeTruthy();
  fill(panel, PASSWORD, NEW);
  submit(panel);
  await screen.findByRole("dialog", { name: OFFER_TITLE });
  // The command went to Home's session, and only Home's details changed; the question is answered, so it goes.
  expect(sent("change_password")).toEqual([{ ...sessionOfVault(8), current_password: PASSWORD, new_password: NEW }]);
  expect(vaults.map((one) => one.password)).toEqual([undefined, NEW]);
  expect(screen.queryByText(ASK9)).toBeNull();

  // Later still only closes it.
  fresh();
  await unlocked([vault(7, "My vault", { usedBackupHeader: true })]);
  fireEvent.click(screen.getByRole("button", { name: "Later" }));
  expect(screen.queryByText(ASK9)).toBeNull();
  expect(screen.queryByRole("complementary", { name: "Change password" })).toBeNull();

  // Ask 2, when the copies of the details disagree on the password: Not now, Change password.
  fresh();
  await unlocked();
  fireEvent.click(within(side()).getByRole("button", { name: "Settings" }));
  const settings = await screen.findByRole("complementary", { name: "Settings" });
  fireEvent.click(within(settings).getByRole("button", { name: "Back up" }));
  const backup = await screen.findByRole("complementary", { name: "Back up" });
  shell.refuseNext("backup_vault", { code: "invalid_input", what: "password copies disagree" });
  fireEvent.click(within(backup).getByRole("button", { name: "Back up" }));
  const question = await screen.findByRole("dialog", { name: "Can't back up My vault yet" });
  expect(within(question).getByText("Change this vault's password once more, then back up.")).toBeTruthy();
  expect(within(question).getAllByRole("button").map((button) => button.textContent)).toEqual(["Not now", "Change password"]);
  fireEvent.click(within(question).getByRole("button", { name: "Change password" }));
  const form = await screen.findByRole("complementary", { name: "Change password" });
  expect(within(form).getByText("For My vault.")).toBeTruthy();
  expect(screen.queryByRole("dialog", { name: "Can't back up My vault yet" })).toBeNull();
  // The other three refusals keep their own buttons: none of them leads here.
  fresh();
  await unlocked();
  fireEvent.click(within(side()).getByRole("button", { name: "Settings" }));
  const again = await screen.findByRole("complementary", { name: "Settings" });
  fireEvent.click(within(again).getByRole("button", { name: "Back up" }));
  const second = await screen.findByRole("complementary", { name: "Back up" });
  shell.refuseNext("backup_vault", { code: "invalid_input", what: "recovery key copies disagree" });
  fireEvent.click(within(second).getByRole("button", { name: "Back up" }));
  const other = await screen.findByRole("dialog", { name: "Can't back up My vault yet" });
  expect(within(other).queryByRole("button", { name: "Change password" })).toBeNull();
});

test("change_password_hidden_on_a_read_only_vault", async () => {
  // A vault opened read-only has nothing to change: Settings has no such row, Ask 9 has no such button, and the store won't open the form.
  await unlocked(mine({ readOnly: true, usedBackupHeader: true }));
  fireEvent.click(within(side()).getByRole("button", { name: "Settings" }));
  const settings = await screen.findByRole("complementary", { name: "Settings" });
  expect(within(settings).queryByRole("button", { name: "Change password" })).toBeNull();
  expect(within(settings).queryByText(/change password/i)).toBeNull();
  const notice = screen.getByText(/^Opened from the backup copy of this vault's details/).closest(".ask") as HTMLElement;
  expect(within(notice).queryByRole("button", { name: "Change password" })).toBeNull();
  expect(notice.textContent).not.toContain("Change the password again");
  act(() => {
    openChangePassword(sessionOfVault(7).session);
  });
  expect(screen.queryByRole("complementary", { name: "Change password" })).toBeNull();
  expect(sent("change_password")).toEqual([]);
});

test("change_password_screens_have_no_axe_violations", async () => {
  await unlocked();
  let panel = await openForm();
  // 27a.
  await expectNoAxe(panel);
  // 27b: with every kind of line on it, the page's own and a refusal.
  fill(panel, WRONG_ONE, "MU-short", "MU-other");
  submit(panel);
  expect(within(panel).getAllByRole("alert")).toHaveLength(2);
  await expectNoAxe(panel);
  fill(panel, WRONG_ONE, NEW);
  submit(panel);
  await within(panel).findByText(WRONG_CURRENT);
  await expectNoAxe(panel);
  // The markup writes no style element or attribute of its own.
  expect(panel.querySelectorAll("style, [style]")).toHaveLength(0);
  // 27c.
  panel = await screen.findByRole("complementary", { name: "Change password" });
  fill(panel, PASSWORD, NEW);
  submit(panel);
  const dialog = await screen.findByRole("dialog", { name: OFFER_TITLE });
  await expectNoAxe(dialog);
});
