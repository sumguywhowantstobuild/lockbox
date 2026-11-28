// Plan 4C Task 5's screens: a new recovery key for an open vault (29a the current password, 29b the key shown once and picked back, 29c the offer of a
// fresh backup), the two places that lead to it (Settings, and Ask 2 when the copies of the details disagree on the recovery key), and what a lock, a
// switch of vault or a late answer does to a key that is on its way or on screen. Every case runs through the real App against the pretend shell.
// Typed passwords are made up (`MU-`); a test of a wipe looks for them, and for the key's words, in the fields, the page and the store.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import App from "../App";
import { debugState, makeNewRecoveryKey, openNewRecoveryKey, resetStoreForTests, showSession, unlock } from "../store";
import { expectNoAxe } from "../testing/axe";
import {
  BACKUP_PASSWORD,
  DEFAULT_PRINTER,
  installFakeShell,
  LOCKED,
  PASSWORD,
  sampleItems,
  SAVED_FOLDER,
  type FakeShell,
  type FakeVault,
} from "../testing/fakeShell";
import { wordsOf } from "./setup/keyWords";

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

const WRONG_ONE = "MU-not the password";
const SECRETS = [PASSWORD, WRONG_ONE, "MU-typed"];

const OLD_KEY_WORDS = "The old recovery key stops working for this vault. Backups you already made still need the old key.";
const LIMIT_WORDS =
  "Making a new recovery key doesn't lock out an old copy. Anyone who has an old copy of this vault's details (an earlier copy of its folder, or an old backup) and its old password or recovery key can read your current and future items and files, if they get copies of them.";
const WRONG_CURRENT = "That isn't the current password.";
const EMPTY = "Type the password first.";
const KEY_HEADING = "Your new recovery key";
const PICK_HEADING = "Check your new recovery key";
const WALLET = "Petalock recovery key, not a crypto wallet phrase";
const LOSE = "If you lose both your password and this key, nobody can get your data back.";
const OFFER_TITLE = "Make a fresh backup now?";
const OFFER_WORDS = "Backups you already made still need the old key. A fresh one opens with what you use today.";
const LOCKED_KEY =
  "The vault locked before Petalock could show your new recovery key. Unlock the vault, and Petalock will make another one to write down.";
const KEY_COPIES = "Make a new recovery key for this vault, then back up.";

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

/** Settings from the side menu, then its New recovery key row. Gives the form (29a). */
async function openForm(): Promise<HTMLElement> {
  fireEvent.click(within(side()).getByRole("button", { name: "Settings" }));
  const settings = await screen.findByRole("complementary", { name: "Settings" });
  fireEvent.click(within(settings).getByRole("button", { name: "New recovery key" }));
  return screen.findByRole("complementary", { name: "New recovery key" });
}

function typeInto(panel: HTMLElement, value: string) {
  fireEvent.change(within(panel).getByLabelText("Current password"), { target: { value } });
}

function submit(panel: HTMLElement) {
  fireEvent.click(within(panel).getByRole("button", { name: "Make a new key" }));
}

function fields(panel: HTMLElement): HTMLInputElement[] {
  return Array.from(panel.querySelectorAll("input"));
}

/** From a vault on screen to its new key (29b), made with the right password. Gives the key. */
async function toTheKey(vaultId = 7): Promise<string> {
  const panel = await openForm();
  typeInto(panel, PASSWORD);
  submit(panel);
  await screen.findByRole("heading", { level: 1, name: KEY_HEADING });
  return shell.keyOf(vaultId) ?? "";
}

/** The question the screen asks now: the word's number (from 1) and its choices. */
function asked(): { position: number; choices: HTMLButtonElement[] } {
  const label = screen.getByText(/^Which word is number \d+\?$/);
  const text = label.textContent;
  const group = screen.getByRole("group", { name: text });
  return {
    position: Number.parseInt(/(\d+)/.exec(text)?.[1] ?? "0", 10),
    choices: within(group).getAllByRole<HTMLButtonElement>("button"),
  };
}

/** Picks, on the question now asked, the right word (`right`) or the first choice that isn't it. */
function pick(key: string, right: boolean): number {
  const { position, choices } = asked();
  const word = wordsOf(key)[position - 1];
  const choice = choices.find((one) => (one.textContent === word) === right);
  if (choice === undefined) throw new Error(`no ${right ? "right" : "wrong"} choice`);
  fireEvent.click(choice);
  return position;
}

async function toTheQuestions() {
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  await screen.findByRole("heading", { level: 1, name: PICK_HEADING });
}

function pickAllRight(key: string): void {
  for (let n = 0; n < 3; n += 1) pick(key, true);
}

/** Every word of the key that is on the page, in its text or in any attribute. */
function keyWordsOnPage(key: string): string[] {
  const found = new Set<string>();
  const add = (text: string) => {
    for (const token of text.toLowerCase().split(/[^a-z]+/)) if (token !== "") found.add(token);
  };
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) add(node.textContent ?? "");
  for (const element of document.body.querySelectorAll("*")) for (const attr of Array.from(element.attributes)) add(attr.value);
  return [...new Set(wordsOf(key))].filter((word) => found.has(word));
}

/** Every word of the key found in an attribute (a title, an aria-label, a value): there should be none, ever. */
function keyWordsInAttributes(key: string): string[] {
  const words = new Set(wordsOf(key));
  const found = new Set<string>();
  for (const element of document.body.querySelectorAll("*")) {
    for (const attr of Array.from(element.attributes)) {
      for (const token of attr.value.toLowerCase().split(/[^a-z]+/)) if (words.has(token)) found.add(token);
    }
  }
  return [...found];
}

/** Every word of the key held by the store as a string of its own (the key's words, or the choices of a question): none once the key is dropped. */
function keyWordsInStore(key: string): string[] {
  const held = JSON.stringify(debugState());
  return [...new Set(wordsOf(key))].filter((word) => held.includes(`"${word}"`));
}

/** Everything of a key, or of a made-up password, still on the page or in the store: the list of where it was found. */
function foundOnPage(secrets: string[], key?: string): string[] {
  const found: string[] = [];
  const held = JSON.stringify(debugState());
  const words = document.body.textContent;
  for (const secret of secrets) {
    for (const box of document.querySelectorAll("input")) if (box.value.includes(secret)) found.push(`a field holds ${secret}`);
    if (held.includes(secret)) found.push(`the store holds ${secret}`);
    if (words.includes(secret)) found.push(`the page says ${secret}`);
  }
  if (key !== undefined) {
    if (held.includes(key)) found.push("the store holds the key");
    for (const word of keyWordsInStore(key)) found.push(`the store holds the word ${word}`);
    for (const word of keyWordsOnPage(key)) found.push(`the page shows the word ${word}`);
  }
  return found;
}

type Real = (cmd: string, args?: unknown) => Promise<unknown>;

function realShell(): Real {
  const real = invoke.getMockImplementation();
  if (real === undefined) throw new Error("no fake shell");
  return real as Real;
}

/**
 * Holds every answer of `cmd` until `release`. With `heardNow` the shell decides at once (and writes, when it is good) as it does, and only the answer
 * is late; without it the shell hears the command at the release too, so a command sent later is heard first.
 */
function hold(cmd: string, heardNow = true): { release: () => void; count: () => number } {
  const real = realShell();
  const waiting: (() => void)[] = [];
  // After the release the wrapper stays in the chain and lets everything through, so a hold made after this one is not undone by its release.
  let released = false;
  invoke.mockImplementation((name: string, args?: unknown) => {
    if (name !== cmd || released) return real(name, args);
    if (!heardNow) {
      return new Promise((resolve, reject) => {
        waiting.push(() => {
          real(name, args).then(resolve, reject);
        });
      });
    }
    const decided = real(name, args).then(
      (value: unknown) => ({ failed: false as const, value }),
      (error: unknown) => ({ failed: true as const, error }),
    );
    return new Promise((resolve, reject) => {
      waiting.push(() => {
        void decided.then((outcome) => {
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the shell rejects with the plain object
          if (outcome.failed) reject(outcome.error);
          else resolve(outcome.value);
        });
      });
    });
  });
  return {
    release: () => {
      released = true;
      for (const go of waiting.splice(0)) go();
    },
    count: () => waiting.length,
  };
}

/**
 * The next `new_recovery_key` is cut short as a lock can cut it. `lock_before_write`: nothing was made, the answer is `locked`. `lock_after_write`: the key
 * was made and its mark written, then the lock event reached the page before the good answer did, so the answer is from before the lock (the bridge drops
 * it). `lock_after_write_as_error`: the key was made and the shell answered `locked_after_change` with the vault's ID.
 */
function cutNext(how: "lock_before_write" | "lock_after_write" | "lock_after_write_as_error", vaultId = 7) {
  const real = realShell();
  invoke.mockImplementation((name: string, args?: unknown) => {
    if (name !== "new_recovery_key") return real(name, args);
    invoke.mockImplementation(real);
    const { session } = args as { session: number };
    if (how === "lock_before_write") {
      shell.lock(session);
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the shell rejects with the plain object
      return Promise.reject(LOCKED);
    }
    return real(name, args).then((value) => {
      shell.lock(session);
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the shell rejects with the plain object
      if (how === "lock_after_write_as_error") return Promise.reject({ code: "locked_after_change", what: "recovery key", vault: vaultId });
      return value;
    });
  });
}

/** The vault menu, opened as a click does, and the row for a vault chosen (by its place among the open ones when two are named alike). */
async function switchTo(name: string, at?: number) {
  const opener = screen.getByRole("button", { name: /, vault menu$/ });
  opener.focus();
  fireEvent.pointerDown(opener, { button: 0 });
  fireEvent.click(opener);
  const menu = await screen.findByRole("menu");
  const rows = within(menu).getAllByRole("menuitemradio");
  const row = at === undefined ? rows.find((one) => one.textContent === name || one.textContent === `${name}Unlocked`) : rows[at];
  if (row === undefined) throw new Error(`no row for ${name}`);
  fireEvent.click(row);
  await waitFor(() => {
    expect(screen.queryByRole("menu")).toBeNull();
  });
}

test("new_key_asks_the_current_password_and_says_the_old_key_stops_working_here", async () => {
  const vaults = mine();
  await unlocked(vaults);
  const panel = await openForm();
  expect(within(panel).getByRole("heading", { level: 2, name: "New recovery key" })).toBeTruthy();
  expect(within(panel).getByText("For My vault.")).toBeTruthy();
  // One hidden field, for the current password, and nothing else to type.
  expect(fields(panel).map((box) => box.labels?.[0]?.textContent)).toEqual(["Current password"]);
  expect(fields(panel).map((box) => box.type)).toEqual(["password"]);
  expect(within(panel).getAllByRole("button").map((button) => button.getAttribute("aria-label") ?? button.textContent)).toEqual([
    "Close panel",
    "Cancel",
    "Make a new key",
  ]);
  // The old key stops working here, and old backups still need it; spec 5.3's limit in full, said of a new key (not a password change), in one note
  // as 27a's.
  expect(within(panel).getByRole("note").textContent).toBe(`${OLD_KEY_WORDS} ${LIMIT_WORDS}`);
  expect(LIMIT_WORDS).toMatch(/^Making a new recovery key doesn't lock out an old copy\./);
  expect(within(panel).queryByText(/Changing the password/)).toBeNull();
  expect(LIMIT_WORDS).toMatch(/old copy of this vault's details/);
  expect(LIMIT_WORDS).toMatch(/old password or recovery key/);
  expect(LIMIT_WORDS).toMatch(/current and future items and files/);
  expect(LIMIT_WORDS).toMatch(/if they get copies of them/);
  // Nothing is sent before Make a new key; an empty field is said on the form and sends nothing.
  expect(sent("new_recovery_key")).toEqual([]);
  submit(panel);
  expect(within(panel).getAllByRole("alert").map((alert) => alert.textContent)).toEqual([EMPTY]);
  expect(sent("new_recovery_key")).toEqual([]);
  // The command's actual arguments: this vault's session and generation and the current password, once.
  typeInto(panel, PASSWORD);
  submit(panel);
  await screen.findByRole("heading", { level: 1, name: KEY_HEADING });
  expect(sent("new_recovery_key")).toEqual([{ ...sessionOfVault(7), current_password: PASSWORD }]);
  // The vault's details changed in the shell: its mark is set and a key was made. The form is gone with the window.
  expect(vaults[0]?.unconfirmed).toBe(true);
  expect(shell.keyOf(7)).toBeDefined();
  expect(screen.queryByRole("complementary", { name: "New recovery key" })).toBeNull();
});

test("wrong_current_password_is_said_and_nothing_changes", async () => {
  const vaults = mine();
  await unlocked(vaults);
  const panel = await openForm();
  // Empty: said on the box, and focus goes to it.
  submit(panel);
  expect(within(panel).getByRole("alert").textContent).toBe(EMPTY);
  expect(document.activeElement).toBe(within(panel).getByLabelText("Current password"));
  typeInto(panel, WRONG_ONE);
  within(panel).getByRole("button", { name: "Make a new key" }).focus();
  submit(panel);
  const alert = await within(panel).findByRole("alert");
  expect(alert.textContent).toBe(WRONG_CURRENT);
  // Focus goes to the box the refusal is about.
  await waitFor(() => {
    expect(document.activeElement).toBe(within(panel).getByLabelText("Current password"));
  });
  // On the field itself, which is empty again.
  expect(within(panel).getByLabelText("Current password").getAttribute("aria-invalid")).toBe("true");
  expect(fields(panel).map((box) => box.value)).toEqual([""]);
  // One command, with what was typed. No key, no mark, no key screen, no offer: nothing changed.
  expect(sent("new_recovery_key")).toEqual([{ ...sessionOfVault(7), current_password: WRONG_ONE }]);
  expect(shell.keyOf(7)).toBeUndefined();
  expect(shell.unconfirmed(7)).toBe(false);
  expect(vaults[0]?.password).toBeUndefined();
  expect(screen.queryByRole("heading", { level: 1, name: KEY_HEADING })).toBeNull();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(foundOnPage(SECRETS)).toEqual([]);
  // No lockout: the next tries are answered the same way, and the right one makes the key.
  for (const wrong of ["MU-wrong two", "MU-wrong three"]) {
    typeInto(panel, wrong);
    submit(panel);
    await waitFor(() => {
      expect(sent("new_recovery_key").at(-1)).toMatchObject({ current_password: wrong });
    });
    await within(panel).findByText(WRONG_CURRENT);
    expect(fields(panel).map((box) => box.value)).toEqual([""]);
    expect(shell.unconfirmed(7)).toBe(false);
  }
  typeInto(panel, PASSWORD);
  expect(within(panel).queryByText(WRONG_CURRENT)).toBeNull();
  submit(panel);
  await screen.findByRole("heading", { level: 1, name: KEY_HEADING });
  expect(sent("new_recovery_key")).toHaveLength(4);

  // Any other refusal goes through the table, said on the form, with the field empty and nothing made (the shell's mark could not be written).
  fresh();
  const again = mine();
  await unlocked(again);
  const form = await openForm();
  shell.refuseMarkNext();
  typeInto(form, PASSWORD);
  submit(form);
  await within(form).findByText("Petalock couldn't save a note it needs before making the key, so it made none. Try again.");
  expect(fields(form).map((box) => box.value)).toEqual([""]);
  expect(shell.keyOf(7)).toBeUndefined();
  expect(screen.queryByRole("heading", { level: 1, name: KEY_HEADING })).toBeNull();
});

test("the_key_shows_once_headed_not_a_crypto_wallet_phrase", async () => {
  await unlocked();
  const key = await toTheKey();
  expect(key).not.toBe("");
  const words = wordsOf(key);
  expect(words).toHaveLength(24);
  // The page's own heading, and the full heading above the words, as 21c has it.
  const headed = screen.getByRole("heading", { level: 2, name: WALLET });
  const box = document.querySelector(".fu-key") as HTMLElement;
  expect(headed.compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  // Not setup's step line: this is a key made for a vault that already exists.
  expect(screen.queryByText("Step 2 of 2")).toBeNull();
  expect(screen.queryByRole("heading", { level: 1, name: "Save your recovery key" })).toBeNull();
  expect(screen.queryByRole("heading", { level: 1, name: "Finish your recovery key" })).toBeNull();
  // 24 numbered words in two columns, 1 to 12 and 13 to 24, in the fixed-width face.
  expect(box.classList.contains("m")).toBe(true);
  const columns = [...box.querySelectorAll("ol")];
  expect(columns).toHaveLength(2);
  const read = (column: Element) =>
    [...column.querySelectorAll("li")].map((row) => ({ number: row.querySelector(".fu-n")?.textContent, word: row.querySelector(".fu-w")?.textContent }));
  const [left, right] = [read(columns[0] as Element), read(columns[1] as Element)];
  expect(left.map((row) => row.number)).toEqual(Array.from({ length: 12 }, (_, i) => String(i + 1)));
  expect(right.map((row) => row.number)).toEqual(Array.from({ length: 12 }, (_, i) => String(i + 13)));
  expect([...left, ...right].map((row) => row.word)).toEqual(words);
  // The loss and storage warnings, word for word, as 21c has them.
  expect(screen.getByText(LOSE)).toBeTruthy();
  expect(screen.getByText(/Don't keep the saved key on this PC\./)).toBeTruthy();
  expect(screen.getByText(/Writing it down by hand is fine\./)).toBeTruthy();
  expect(screen.getByText(/Screenshots won't work/)).toBeTruthy();
  // It is on the page as words, in no attribute, and not run together; a native copy or drag of it copies nothing.
  expect(keyWordsInAttributes(key)).toEqual([]);
  expect(document.body.innerHTML).not.toContain(key);
  const range = document.createRange();
  range.selectNodeContents(box);
  document.getSelection()?.removeAllRanges();
  document.getSelection()?.addRange(range);
  expect(fireEvent.copy(document.body)).toBe(false);
  document.getSelection()?.removeAllRanges();
  expect(fireEvent.dragStart(box.querySelector(".fu-w") as HTMLElement)).toBe(false);
  // Shown once: it was made once, by this command, and nothing asked for another. Its vault is marked until it is picked back.
  expect(sent("new_recovery_key")).toHaveLength(1);
  expect(sent("regenerate_recovery")).toEqual([]);
  expect(shell.unconfirmed(7)).toBe(true);
  expect(screen.getByRole("button", { name: "Continue" })).toBeTruthy();
});

test("print_and_save_as_pdf_work_from_29b", async () => {
  await unlocked();
  const key = await toTheKey();
  const live = sessionOfVault(7);
  // Save as PDF goes through the same buttons as setup's, for this vault's session, and says where it went.
  const pdf = screen.getByRole("button", { name: "Save as PDF" });
  pdf.focus();
  fireEvent.click(pdf);
  expect(await screen.findByText(`Saved in ${SAVED_FOLDER}.`)).toBeTruthy();
  expect(sent("save_recovery_pdf")).toEqual([live]);
  expect(shell.pdfs).toEqual([SAVED_FOLDER]);
  // Print opens the printer list with the default picked, and Print in it sends the page to that printer.
  fireEvent.click(screen.getAllByRole("button", { name: "Print" })[0] as HTMLElement);
  const group = await screen.findByRole("group", { name: "Choose a printer" });
  await waitFor(() => {
    expect(within(group).getByRole("combobox", { name: "Printer" })).toBeTruthy();
  });
  fireEvent.click(within(group).getByRole("button", { name: "Print" }));
  expect(await screen.findByText(`Sent to ${DEFAULT_PRINTER}.`)).toBeTruthy();
  expect(sent("print_recovery_key")).toEqual([{ ...live, printer: DEFAULT_PRINTER }]);
  // The key is in no name, title or label, and the way on is still there.
  expect(keyWordsInAttributes(key)).toEqual([]);
  expect(screen.getByRole("button", { name: "Continue" })).toBeTruthy();
});

test("picking_three_words_confirms_and_clears_the_mark", async () => {
  await unlocked();
  const key = await toTheKey();
  const live = sessionOfVault(7);
  const issue = (debugState().sessions[0]?.recovery as { issue: number }).issue;
  await toTheQuestions();
  // The key is hidden while it is picked, and nothing but this question's four choices is on the page. No box to type in, and no setup step line.
  expect(screen.queryByRole("heading", { level: 1, name: KEY_HEADING })).toBeNull();
  expect(screen.queryByText("Step 2 of 2")).toBeNull();
  expect(document.querySelectorAll(".fu-key")).toHaveLength(0);
  expect(screen.queryAllByRole("textbox")).toHaveLength(0);
  expect(keyWordsOnPage(key).sort()).toEqual(asked().choices.map((choice) => choice.textContent).sort());
  pick(key, true);
  pick(key, true);
  // Two are not enough: nothing is sent, the mark stays.
  expect(sent("recovery_confirmed")).toEqual([]);
  expect(shell.unconfirmed(7)).toBe(true);
  expect(screen.getByText("Question 3 of 3")).toBeTruthy();
  pick(key, true);
  // The third: this key's number goes to the shell, once, and the mark is cleared; the key and the picks leave the page and the store.
  await screen.findByRole("dialog", { name: OFFER_TITLE });
  expect(sent("recovery_confirmed")).toEqual([{ ...live, issue }]);
  expect(shell.unconfirmed(7)).toBe(false);
  expect(debugState().sessions[0]?.recovery).toBeNull();
  expect(foundOnPage([], key)).toEqual([]);
});

test("a_wrong_pick_shows_the_words_and_starts_over_with_new_numbers", async () => {
  await unlocked();
  const key = await toTheKey();
  // The numbers asked in each of six rounds, each ended by a wrong last pick: three different ones every time, and not the same few each time.
  const seen = new Set<number>();
  for (let round = 0; round < 6; round += 1) {
    await toTheQuestions();
    const numbers: number[] = [];
    for (let n = 0; n < 3; n += 1) {
      expect(screen.getByText(`Question ${String(n + 1)} of 3`)).toBeTruthy();
      numbers.push(asked().position);
      pick(key, n < 2);
    }
    expect(new Set(numbers).size, numbers.join()).toBe(3);
    for (const number of numbers) seen.add(number);
    // The key is back in full on the first screen of the step, and it says why, without saying a word of the key.
    await screen.findByRole("heading", { level: 1, name: KEY_HEADING });
    for (const word of wordsOf(key)) expect(screen.getAllByText(word).length, word).toBeGreaterThan(0);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("That wasn't the right word");
    for (const word of wordsOf(key)) expect(alert.textContent, word).not.toContain(word);
    expect(document.activeElement).toBe(screen.getByRole("heading", { level: 1, name: KEY_HEADING }));
  }
  expect(seen.size).toBeGreaterThan(5);
  // Nothing was confirmed, the mark stays, and the same key is still the one to confirm.
  expect(sent("recovery_confirmed")).toEqual([]);
  expect(shell.unconfirmed(7)).toBe(true);
  expect(shell.keyOf(7)).toBe(key);
  expect(keyWordsInAttributes(key)).toEqual([]);
  await toTheQuestions();
  expect(screen.queryByRole("alert")).toBeNull();
  pickAllRight(key);
  await screen.findByRole("dialog", { name: OFFER_TITLE });
  expect(sent("recovery_confirmed")).toHaveLength(1);
});

test("a_lock_before_confirming_leaves_the_mark_and_21f_follows_at_next_unlock", async () => {
  // At the key and at the questions: a lock takes the words off the page and out of the store, the mark stays, and the next unlock makes another key (21f).
  for (const at of ["the key", "the questions"]) {
    fresh();
    await unlocked();
    const key = await toTheKey();
    if (at === "the questions") {
      await toTheQuestions();
      pick(key, true);
    }
    expect(foundOnPage([], key).length, at).toBeGreaterThan(0);
    act(() => {
      shell.lock(sessionOfVault(7).session);
    });
    await screen.findByLabelText(/^Password for /);
    expect(foundOnPage([], key), at).toEqual([]);
    expect(shell.unconfirmed(7)).toBe(true);
    expect(sent("recovery_confirmed")).toEqual([]);
    // The lock says nothing of the key: it was shown and not saved, which the next unlock sees by the mark.
    expect(screen.queryByText(LOCKED_KEY)).toBeNull();
    await unlockWith(PASSWORD);
    await screen.findByRole("heading", { level: 1, name: "Finish your recovery key" });
    const second = shell.keyOf(7) ?? "";
    expect(second).not.toBe(key);
    expect(sent("regenerate_recovery")).toHaveLength(1);
    // The page shows the second key and nothing is left of the first as a whole (the fake's two keys share some words of its small list).
    expect(document.body.innerHTML).not.toContain(key);
    expect(JSON.stringify(debugState())).not.toContain(key);
  }
});

test("locked_before_the_key_could_show_says_so_on_that_vaults_unlock", async () => {
  // A lock before anything was written: nothing is made, nothing is said, no mark; the next unlock is an ordinary one.
  let vaults = mine();
  await unlocked(vaults);
  let panel = await openForm();
  typeInto(panel, PASSWORD);
  cutNext("lock_before_write");
  submit(panel);
  await screen.findByLabelText(/^Password for /);
  expect(screen.queryByText(LOCKED_KEY)).toBeNull();
  expect(vaults[0]?.unconfirmed).toBeFalsy();
  expect(shell.keyOf(7)).toBeUndefined();
  await unlockWith(PASSWORD);
  await screen.findByRole("heading", { level: 1, name: "All items" });

  // The key was made and its mark written, and the lock came first: the session's words (for Ariel to change) on that vault's unlock, as the shell's
  // `locked_after_change` or as its good answer dropped as from before the lock. Nothing of the key is on the page, and 21f follows at the next unlock.
  for (const how of ["lock_after_write", "lock_after_write_as_error"] as const) {
    fresh();
    vaults = mine();
    await unlocked(vaults);
    panel = await openForm();
    typeInto(panel, PASSWORD);
    cutNext(how);
    submit(panel);
    await screen.findByLabelText(/^Password for /);
    expect((await screen.findByText(LOCKED_KEY)).textContent).toBe(LOCKED_KEY);
    const made = shell.keyOf(7) ?? "";
    expect(made).not.toBe("");
    expect(vaults[0]?.unconfirmed).toBe(true);
    expect(foundOnPage(SECRETS, made)).toEqual([]);
    await unlockWith(PASSWORD);
    await screen.findByRole("heading", { level: 1, name: "Finish your recovery key" });
    expect(screen.queryByText(LOCKED_KEY)).toBeNull();
    expect(shell.keyOf(7)).not.toBe(made);
    expect(JSON.stringify(debugState())).not.toContain(made);
  }

  // Two vaults with the same name: the note is for the vault whose key was made, shown while it is chosen and gone when the other is.
  fresh();
  vaults = [vault(7, "My vault"), vault(8, "My vault")];
  await allOpen(vaults);
  await switchTo("My vault", 0);
  panel = await openForm();
  typeInto(panel, PASSWORD);
  cutNext("lock_after_write", 7);
  submit(panel);
  await waitFor(() => {
    expect(debugState().lockNotes.map((note) => note.vault)).toEqual([7]);
    expect(debugState().sessions.map((one) => one.vaultId)).toEqual([8]);
  });
  // Only the first vault was marked, and the one still open says nothing of it.
  expect(vaults.map((one) => Boolean(one.unconfirmed))).toEqual([true, false]);
  expect(screen.queryByText(LOCKED_KEY)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Lock all" }));
  await screen.findByLabelText(/^Password for /);
  const radios = () => screen.getAllByRole<HTMLInputElement>("radio");
  expect(radios()[0]?.checked).toBe(true);
  expect(screen.getByText(LOCKED_KEY)).toBeTruthy();
  fireEvent.click(radios()[1] as HTMLElement);
  expect(screen.queryByText(LOCKED_KEY)).toBeNull();
});

// Many steps (about 1.5 s alone); timed out at 5 s twice in the full parallel run.
test("the_shown_key_and_picks_are_dropped_on_confirm_leave_and_lock_even_after_a_late_answer", { timeout: 20_000 }, async () => {
  // Confirm: the key and the questions are gone from the page and the store, and a second answer of the same confirmation changes nothing.
  await unlocked();
  let key = await toTheKey();
  // The check can find the key: while it is shown, its words are on the page and in the store (so a later "nothing found" is a real drop).
  expect(foundOnPage([], key).length).toBeGreaterThan(10);
  await toTheQuestions();
  pickAllRight(key);
  await screen.findByRole("dialog", { name: OFFER_TITLE });
  expect(foundOnPage([], key)).toEqual([]);

  // Lock, with the key request still out: its late answer is from before the lock. The key never reaches the page or the store.
  fresh();
  await unlocked();
  let panel = await openForm();
  typeInto(panel, PASSWORD);
  let late = hold("new_recovery_key");
  submit(panel);
  await waitFor(() => {
    expect(late.count()).toBe(1);
  });
  key = shell.keyOf(7) ?? "";
  expect(key).not.toBe("");
  act(() => {
    shell.lock(sessionOfVault(7).session);
  });
  await screen.findByLabelText(/^Password for /);
  act(() => {
    late.release();
  });
  await screen.findByText(LOCKED_KEY);
  expect(screen.queryByRole("heading", { level: 1, name: KEY_HEADING })).toBeNull();
  expect(foundOnPage(SECRETS, key)).toEqual([]);

  // Lock, with the last pick's confirmation out: its late answer brings nothing back (no key, no offer) and the lock-screen is clean.
  fresh();
  await unlocked();
  key = await toTheKey();
  await toTheQuestions();
  pick(key, true);
  pick(key, true);
  late = hold("recovery_confirmed");
  pick(key, true);
  await waitFor(() => {
    expect(late.count()).toBe(1);
  });
  act(() => {
    shell.lock(sessionOfVault(7).session);
  });
  await screen.findByLabelText(/^Password for /);
  act(() => {
    late.release();
  });
  await act(async () => {
    await Promise.resolve();
  });
  expect(screen.queryByRole("dialog", { name: OFFER_TITLE })).toBeNull();
  expect(foundOnPage([], key)).toEqual([]);
  expect(debugState().sessions).toEqual([]);

  // A lock epoch that reaches the page before the vault's own lock does (Lock all, idle, Windows locking) takes the key off at once.
  fresh();
  await unlocked();
  key = await toTheKey();
  expect(foundOnPage([], key).length).toBeGreaterThan(0);
  await act(async () => {
    shell.changeLockEpoch("idle");
    await Promise.resolve();
  });
  expect(debugState().sessions[0]?.recovery).toBeNull();
  expect(foundOnPage([], key)).toEqual([]);

  // Leave: another vault comes to the front while the key is on screen. Its words and its picks are dropped; the mark stays for the next unlock.
  for (const at of ["the key", "the questions"]) {
    fresh();
    const vaults = [vault(7, "My vault"), vault(8, "Home")];
    await allOpen(vaults);
    key = await toTheKey(8);
    if (at === "the questions") {
      await toTheQuestions();
      pick(key, true);
    }
    expect(foundOnPage([], key).length, at).toBeGreaterThan(0);
    act(() => {
      showSession(sessionOfVault(7).session);
    });
    await screen.findByRole("heading", { level: 1, name: "All items", hidden: true });
    expect(foundOnPage([], key), at).toEqual([]);
    expect(vaults[1]?.unconfirmed).toBe(true);
    act(() => {
      showSession(sessionOfVault(8).session);
    });
    await screen.findByRole("heading", { level: 1, name: "All items", hidden: true });
    expect(screen.queryByRole("heading", { level: 1, name: KEY_HEADING })).toBeNull();
    expect(foundOnPage([], key), at).toEqual([]);
  }

  // Leave, with the last pick's confirmation out: its late answer brings nothing back and offers no backup.
  fresh();
  const two = [vault(7, "My vault"), vault(8, "Home")];
  await allOpen(two);
  key = await toTheKey(8);
  await toTheQuestions();
  pick(key, true);
  pick(key, true);
  late = hold("recovery_confirmed");
  pick(key, true);
  await waitFor(() => {
    expect(late.count()).toBe(1);
  });
  act(() => {
    showSession(sessionOfVault(7).session);
  });
  await screen.findByRole("heading", { level: 1, name: "All items", hidden: true });
  act(() => {
    late.release();
  });
  await act(async () => {
    await Promise.resolve();
  });
  act(() => {
    showSession(sessionOfVault(8).session);
  });
  await screen.findByRole("heading", { level: 1, name: "All items", hidden: true });
  expect(screen.queryByRole("dialog", { name: OFFER_TITLE })).toBeNull();
  expect(foundOnPage([], key)).toEqual([]);

  // A key asked for, and the person leaves before it comes: the answer is kept for its own vault and shown when that vault is back on screen, and not
  // before. (Two vaults with the same name: only the arguments and the vault changed tell them apart.)
  fresh();
  const same = [vault(7, "My vault"), vault(8, "My vault")];
  await allOpen(same);
  panel = await openForm();
  typeInto(panel, PASSWORD);
  late = hold("new_recovery_key");
  submit(panel);
  await waitFor(() => {
    expect(late.count()).toBe(1);
  });
  expect(sent("new_recovery_key")).toEqual([{ ...sessionOfVault(8), current_password: PASSWORD }]);
  await switchTo("My vault", 0);
  act(() => {
    late.release();
  });
  const second = sessionOfVault(8).session;
  await waitFor(() => {
    expect(debugState().sessions.find((one) => one.session === second)?.recovery).toMatchObject({ phase: "show", voluntary: true });
  });
  key = shell.keyOf(8) ?? "";
  // Only the second vault was marked and given a key; the vault on screen shows none of it.
  expect(same.map((one) => Boolean(one.unconfirmed))).toEqual([false, true]);
  expect(shell.keyOf(7)).toBeUndefined();
  expect(debugState().sessions.find((one) => one.session === sessionOfVault(7).session)?.recovery).toBeNull();
  expect(screen.queryByRole("heading", { level: 1, name: KEY_HEADING })).toBeNull();
  expect(keyWordsOnPage(key)).toEqual([]);
  await act(async () => {
    showSession(second);
    await Promise.resolve();
  });
  await screen.findByRole("heading", { level: 1, name: KEY_HEADING });
  expect(keyWordsOnPage(key).length).toBeGreaterThan(10);
});

test("a_good_reply_between_the_lock_epoch_and_the_vaults_own_lock_never_puts_the_key_on_the_page", async () => {
  // A lock starts (the epoch moves) while the key is being made; the good reply lands before this vault's own `locked` event. The words are not installed,
  // and the non-secret outcome is kept for that vault's unlock.
  await unlocked();
  const panel = await openForm();
  typeInto(panel, PASSWORD);
  const late = hold("new_recovery_key");
  submit(panel);
  await waitFor(() => {
    expect(late.count()).toBe(1);
  });
  const key = shell.keyOf(7) ?? "";
  expect(key).not.toBe("");
  await act(async () => {
    shell.changeLockEpoch("idle");
    await Promise.resolve();
  });
  act(() => {
    late.release();
  });
  await waitFor(() => {
    expect(debugState().lockNotes.map((note) => note.vault)).toEqual([7]);
  });
  expect(screen.queryByRole("heading", { level: 1, name: KEY_HEADING })).toBeNull();
  expect(foundOnPage(SECRETS, key)).toEqual([]);
  // The vault's own lock event follows; its unlock says so, and 21f follows by the mark.
  act(() => {
    shell.lock(sessionOfVault(7).session);
  });
  await screen.findByLabelText(/^Password for /);
  expect(await screen.findByText(LOCKED_KEY)).toBeTruthy();
  expect(shell.unconfirmed(7)).toBe(true);
  expect(foundOnPage(SECRETS, key)).toEqual([]);
  await unlockWith(PASSWORD);
  await screen.findByRole("heading", { level: 1, name: "Finish your recovery key" });
});

test("a_new_foreground_session_drops_another_vaults_shown_key_and_picks", async () => {
  // A backup opening: the key is asked for in Home, the person goes to My vault and begins opening a backup there, goes back to Home, the key appears, and then
  // the backup opens and takes the foreground. Home's key goes from the page and the store; going back to Home shows none.
  const vaults = [vault(7, "My vault"), vault(8, "Home")];
  await allOpen(vaults);
  const home = sessionOfVault(8).session;
  const panel = await openForm();
  typeInto(panel, PASSWORD);
  const key = hold("new_recovery_key");
  submit(panel);
  await waitFor(() => {
    expect(key.count()).toBe(1);
  });
  await switchTo("My vault");
  fireEvent.click(within(side()).getByRole("button", { name: "Settings" }));
  const settings = await screen.findByRole("complementary", { name: "Settings" });
  fireEvent.click(within(settings).getByRole("button", { name: "Open a backup" }));
  const open = await screen.findByRole("complementary", { name: "Open a backup" });
  fireEvent.change(within(open).getByLabelText("Password or recovery key from when it was made"), { target: { value: BACKUP_PASSWORD } });
  const slow = hold("open_backup_read_only");
  fireEvent.click(within(open).getByRole("button", { name: "Open read-only" }));
  await waitFor(() => {
    expect(slow.count()).toBe(1);
  });
  await switchTo("Home");
  act(() => {
    key.release();
  });
  await screen.findByRole("heading", { level: 1, name: KEY_HEADING });
  const made = shell.keyOf(8) ?? "";
  expect(foundOnPage([], made).length).toBeGreaterThan(10);
  act(() => {
    slow.release();
  });
  // The backup is the window now (its menu is there), and Home's key is gone from the page and the store.
  await screen.findByRole("button", { name: /, read-only, vault menu$/ });
  expect(foundOnPage([], made)).toEqual([]);
  expect(debugState().sessions.find((one) => one.session === home)?.recovery).toBeNull();
  await switchTo("Home");
  expect(screen.queryByRole("heading", { level: 1, name: KEY_HEADING })).toBeNull();
  expect(foundOnPage([], made)).toEqual([]);
  expect(vaults[1]?.unconfirmed).toBe(true);

  // Another vault unlocked (an open one opened again) takes the foreground the same way.
  fresh();
  const two = [vault(7, "My vault"), vault(8, "Home")];
  await allOpen(two);
  const shown = await toTheKey(8);
  expect(foundOnPage([], shown).length).toBeGreaterThan(10);
  await act(async () => {
    expect(await unlock({ list: shell.listIdentity(), id: 7 }, PASSWORD)).toBe("opened");
  });
  await screen.findByRole("heading", { level: 1, name: "All items", hidden: true });
  expect(debugState().sessions.find((one) => one.vaultId === 8)?.recovery).toBeNull();
  expect(foundOnPage([], shown)).toEqual([]);
  act(() => {
    showSession(sessionOfVault(8).session);
  });
  await screen.findByRole("heading", { level: 1, name: "All items", hidden: true });
  expect(screen.queryByRole("heading", { level: 1, name: KEY_HEADING })).toBeNull();
  expect(foundOnPage([], shown)).toEqual([]);
});

test("a_key_that_reached_a_vault_in_the_background_says_so_when_that_vault_locks_before_it_is_shown", async () => {
  // Two vaults with the same name. The key is asked for in the second, the person goes to the first, and the reply reaches the second in the background. Its
  // words were never on screen, so when it locks before the person returns, its unlock says so.
  const same = [vault(7, "My vault"), vault(8, "My vault")];
  await allOpen(same);
  const panel = await openForm();
  typeInto(panel, PASSWORD);
  const late = hold("new_recovery_key");
  submit(panel);
  await waitFor(() => {
    expect(late.count()).toBe(1);
  });
  await switchTo("My vault", 0);
  act(() => {
    late.release();
  });
  const second = sessionOfVault(8).session;
  await waitFor(() => {
    expect(debugState().sessions.find((one) => one.session === second)?.recovery).toMatchObject({ phase: "show", voluntary: true });
  });
  const key = shell.keyOf(8) ?? "";
  expect(debugState().lockNotes).toEqual([]);
  act(() => {
    shell.lock(second);
  });
  await waitFor(() => {
    expect(debugState().lockNotes.map((note) => note.vault)).toEqual([8]);
    expect(debugState().sessions.map((one) => one.vaultId)).toEqual([7]);
  });
  expect(foundOnPage([], key)).toEqual([]);
  expect(same.map((one) => Boolean(one.unconfirmed))).toEqual([false, true]);
  // The note is for the second vault only: shown while it is chosen on the lock screen, and 21f follows its unlock.
  expect(screen.queryByText(LOCKED_KEY)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Lock all" }));
  await screen.findByLabelText(/^Password for /);
  const radios = () => screen.getAllByRole<HTMLInputElement>("radio");
  fireEvent.click(radios()[0] as HTMLElement);
  expect(screen.queryByText(LOCKED_KEY)).toBeNull();
  fireEvent.click(radios()[1] as HTMLElement);
  expect(screen.getByText(LOCKED_KEY)).toBeTruthy();
  await unlockWith(PASSWORD);
  await screen.findByRole("heading", { level: 1, name: "Finish your recovery key" });
  expect(screen.queryByText(LOCKED_KEY)).toBeNull();
});

test("replies_in_reverse_order_keep_the_current_key_confirmable", async () => {
  await unlocked();
  const first = await toTheKey();
  const live = sessionOfVault(7);
  await toTheQuestions();
  pick(first, true);
  pick(first, true);
  // The confirmation of the first key is out and the shell has not heard it; a newer key is made and answered first, so the old confirmation finds it
  // superseded when it is heard.
  const late = hold("recovery_confirmed", false);
  pick(first, true);
  await waitFor(() => {
    expect(late.count()).toBe(1);
  });
  await act(async () => {
    openNewRecoveryKey(live.session);
    await makeNewRecoveryKey(live.session, PASSWORD);
  });
  const second = shell.keyOf(7) ?? "";
  expect(second).not.toBe(first);
  expect(debugState().sessions[0]?.recovery).toMatchObject({ phase: "show", key: second, voluntary: true });
  await act(async () => {
    late.release();
    await Promise.resolve();
  });
  await waitFor(() => {
    expect(sent("recovery_confirmed")).toHaveLength(1);
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  // `Superseded` closed nothing: the newer key's step is on screen, its mark stays, no offer was made, and it is the one that can be confirmed.
  expect(shell.unconfirmed(7)).toBe(true);
  expect(debugState().sessions[0]?.recovery).toMatchObject({ phase: "show", key: second });
  expect(screen.getByRole("heading", { level: 1, name: KEY_HEADING })).toBeTruthy();
  expect(screen.queryByRole("dialog", { name: OFFER_TITLE })).toBeNull();
  expect(keyWordsOnPage(second).length).toBeGreaterThan(10);
  await toTheQuestions();
  pickAllRight(second);
  await screen.findByRole("dialog", { name: OFFER_TITLE });
  const issues = sent("recovery_confirmed").map((one) => one.issue as number);
  expect(issues).toHaveLength(2);
  expect(issues[1]).toBeGreaterThan(issues[0] as number);
  expect(shell.unconfirmed(7)).toBe(false);
});

test("new_key_wipes_the_typed_password_pending_refused_back_and_locked", async () => {
  // Pending: the field, the page and the store are clear the moment it is sent, before the answer comes.
  await unlocked();
  let panel = await openForm();
  let late = hold("new_recovery_key");
  typeInto(panel, PASSWORD);
  expect(foundOnPage([PASSWORD])).toEqual([`a field holds ${PASSWORD}`]);
  expect(JSON.stringify(debugState())).toContain("My vault");
  submit(panel);
  await waitFor(() => {
    expect(late.count()).toBe(1);
  });
  expect(fields(panel).map((box) => box.value)).toEqual([""]);
  expect(foundOnPage(SECRETS)).toEqual([]);
  // While it is out the field can't be typed in, and a second press sends nothing; Cancel doesn't take it back, and the form stays.
  expect(fields(panel).map((box) => box.readOnly)).toEqual([true]);
  typeInto(panel, "MU-typed meanwhile");
  expect(fields(panel).map((box) => box.value)).toEqual([""]);
  submit(panel);
  fireEvent.click(within(panel).getByRole("button", { name: "Cancel" }));
  expect(screen.getByRole("complementary", { name: "New recovery key" })).toBeTruthy();
  expect(late.count()).toBe(1);
  act(() => {
    late.release();
  });
  await screen.findByRole("heading", { level: 1, name: KEY_HEADING });
  expect(sent("new_recovery_key")).toHaveLength(1);
  expect(foundOnPage(SECRETS)).toEqual([]);

  // Refused: an empty field with the reason.
  fresh();
  await unlocked();
  panel = await openForm();
  typeInto(panel, WRONG_ONE);
  submit(panel);
  await within(panel).findByText(WRONG_CURRENT);
  expect(fields(panel).map((box) => box.value)).toEqual([""]);
  expect(foundOnPage(SECRETS)).toEqual([]);

  // Back: Cancel, or Close panel, with the field typed, and the form opened again, is empty.
  fresh();
  await unlocked();
  panel = await openForm();
  typeInto(panel, "MU-typed one");
  expect(foundOnPage(["MU-typed"])).toEqual(["a field holds MU-typed"]);
  fireEvent.click(within(panel).getByRole("button", { name: "Cancel" }));
  await waitFor(() => {
    expect(screen.queryByRole("complementary", { name: "New recovery key" })).toBeNull();
  });
  expect(foundOnPage(SECRETS)).toEqual([]);
  panel = await openForm();
  expect(fields(panel).map((box) => box.value)).toEqual([""]);
  typeInto(panel, "MU-typed two");
  fireEvent.click(within(panel).getByRole("button", { name: "Close panel" }));
  await waitFor(() => {
    expect(screen.queryByRole("complementary", { name: "New recovery key" })).toBeNull();
  });
  expect(foundOnPage(SECRETS)).toEqual([]);
  expect(sent("new_recovery_key")).toEqual([]);

  // A form left by a switch sends nothing, and what was typed is gone when its vault is back.
  fresh();
  const vaults = [vault(7, "My vault"), vault(8, "Home")];
  await allOpen(vaults);
  panel = await openForm();
  typeInto(panel, "MU-typed three");
  await switchTo("My vault");
  expect(screen.queryByRole("complementary", { name: "New recovery key" })).toBeNull();
  expect(foundOnPage(SECRETS)).toEqual([]);
  await switchTo("Home");
  panel = await screen.findByRole("complementary", { name: "New recovery key" });
  expect(within(panel).getByText("For Home.")).toBeTruthy();
  expect(fields(panel).map((box) => box.value)).toEqual([""]);
  expect(sent("new_recovery_key")).toEqual([]);
  expect(vaults.map((one) => Boolean(one.unconfirmed))).toEqual([false, false]);

  // A lock of the vault with the form typed and not sent, and a lock epoch that comes before it: nothing stays, and nothing comes back with the next unlock.
  fresh();
  await unlocked();
  panel = await openForm();
  typeInto(panel, "MU-typed four");
  act(() => {
    shell.lock(sessionOfVault(7).session);
  });
  await screen.findByLabelText(/^Password for /);
  expect(foundOnPage(SECRETS)).toEqual([]);
  await unlockWith(PASSWORD);
  await screen.findByRole("heading", { level: 1, name: "All items", hidden: true });
  panel = await openForm();
  expect(fields(panel).map((box) => box.value)).toEqual([""]);
  typeInto(panel, "MU-typed five");
  await act(async () => {
    shell.changeLockEpoch("idle");
    await Promise.resolve();
  });
  expect(fields(panel).map((box) => box.value)).toEqual([""]);
  expect(foundOnPage(SECRETS)).toEqual([]);
  expect(sent("new_recovery_key")).toEqual([]);

  // A lock while the answer is out: the answer is dropped, and nothing typed is anywhere.
  fresh();
  await unlocked();
  panel = await openForm();
  late = hold("new_recovery_key");
  typeInto(panel, PASSWORD);
  submit(panel);
  await waitFor(() => {
    expect(late.count()).toBe(1);
  });
  act(() => {
    shell.lock(sessionOfVault(7).session);
  });
  await screen.findByLabelText(/^Password for /);
  act(() => {
    late.release();
  });
  expect(foundOnPage(SECRETS.filter((one) => one !== PASSWORD))).toEqual([]);
  expect(screen.queryByRole("heading", { level: 1, name: KEY_HEADING })).toBeNull();
});

test("done_offers_a_fresh_backup", async () => {
  await unlocked();
  let key = await toTheKey();
  await toTheQuestions();
  pickAllRight(key);
  // 29c, as 27c: the question over the window, its words word for word, Not now first and Back up now as the way on.
  const dialog = await screen.findByRole("dialog", { name: OFFER_TITLE });
  expect(within(dialog).getByText(OFFER_WORDS)).toBeTruthy();
  expect(within(dialog).getAllByRole("button").map((button) => button.textContent)).toEqual(["Not now", "Back up now"]);
  // It is on the vault's own window (the list is behind it), and the key is gone.
  expect(screen.queryByRole("heading", { level: 1, name: KEY_HEADING })).toBeNull();
  expect(foundOnPage([], key)).toEqual([]);
  // Back up now opens 22a for this vault (nothing is written until Back up is pressed there).
  fireEvent.click(within(dialog).getByRole("button", { name: "Back up now" }));
  const panel = await screen.findByRole("complementary", { name: "Back up" });
  expect(within(panel).getByText("For My vault.")).toBeTruthy();
  expect(screen.queryByRole("dialog", { name: OFFER_TITLE })).toBeNull();
  expect(sent("backup_vault")).toEqual([]);

  // Not now closes it, and opens nothing.
  fresh();
  await unlocked();
  key = await toTheKey();
  await toTheQuestions();
  pickAllRight(key);
  const again = await screen.findByRole("dialog", { name: OFFER_TITLE });
  fireEvent.click(within(again).getByRole("button", { name: "Not now" }));
  await waitFor(() => {
    expect(screen.queryByRole("dialog", { name: OFFER_TITLE })).toBeNull();
  });
  expect(screen.queryByRole("complementary", { name: "Back up" })).toBeNull();
  expect(sent("backup_vault")).toEqual([]);
  // The offer is made once: Settings opened again shows the form as new, and no offer is waiting.
  expect(debugState().sessions[0]?.newKey).toBeNull();
});

test("the_key_screen_starts_on_its_heading_and_the_offers_answer_returns_to_settings", async () => {
  for (const answer of ["Not now", "Escape"] as const) {
    fresh();
    await unlocked();
    const key = await toTheKey();
    // 29b: focus is on the screen's heading when the key shows, as on every other step, not left on nothing.
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole("heading", { level: 1, name: KEY_HEADING }));
    });
    await toTheQuestions();
    pickAllRight(key);
    const dialog = await screen.findByRole("dialog", { name: OFFER_TITLE });
    if (answer === "Not now") fireEvent.click(within(dialog).getByRole("button", { name: "Not now" }));
    else fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: OFFER_TITLE })).toBeNull();
    });
    // 29c's answer puts focus back on Settings, which opened the flow.
    await waitFor(() => {
      expect(document.activeElement, answer).toBe(within(side()).getByRole("button", { name: "Settings" }));
    });
  }
});

test("ask_2_now_shows_new_recovery_key_for_its_vault", async () => {
  // The refusal for copies that disagree on the recovery key: the design's words, with Not now and New recovery key. It opens the form for the vault it is about.
  const vaults = [vault(7, "My vault"), vault(8, "Home")];
  await allOpen(vaults);
  fireEvent.click(within(side()).getByRole("button", { name: "Settings" }));
  const settings = await screen.findByRole("complementary", { name: "Settings" });
  fireEvent.click(within(settings).getByRole("button", { name: "Back up" }));
  const backup = await screen.findByRole("complementary", { name: "Back up" });
  shell.refuseNext("backup_vault", { code: "invalid_input", what: "recovery key copies disagree" });
  fireEvent.click(within(backup).getByRole("button", { name: "Back up" }));
  const question = await screen.findByRole("dialog", { name: "Can't back up Home yet" });
  expect(within(question).getByText(KEY_COPIES)).toBeTruthy();
  expect(within(question).getAllByRole("button").map((button) => button.textContent)).toEqual(["Not now", "New recovery key"]);
  fireEvent.click(within(question).getByRole("button", { name: "New recovery key" }));
  const form = await screen.findByRole("complementary", { name: "New recovery key" });
  expect(within(form).getByText("For Home.")).toBeTruthy();
  expect(screen.queryByRole("dialog", { name: "Can't back up Home yet" })).toBeNull();
  typeInto(form, PASSWORD);
  submit(form);
  await screen.findByRole("heading", { level: 1, name: KEY_HEADING });
  // The command went to Home's session, and only Home was given a key and marked.
  expect(sent("new_recovery_key")).toEqual([{ ...sessionOfVault(8), current_password: PASSWORD }]);
  expect(vaults.map((one) => Boolean(one.unconfirmed))).toEqual([false, true]);

  // Not now only closes it, and the other refusals keep their own buttons: none of them leads here.
  for (const what of ["password copies disagree", "details changed", "details unchecked"]) {
    fresh();
    await unlocked();
    fireEvent.click(within(side()).getByRole("button", { name: "Settings" }));
    const again = await screen.findByRole("complementary", { name: "Settings" });
    fireEvent.click(within(again).getByRole("button", { name: "Back up" }));
    const panel = await screen.findByRole("complementary", { name: "Back up" });
    shell.refuseNext("backup_vault", { code: "invalid_input", what });
    fireEvent.click(within(panel).getByRole("button", { name: "Back up" }));
    const other = await screen.findByRole("dialog", { name: "Can't back up My vault yet" });
    expect(within(other).queryByRole("button", { name: "New recovery key" }), what).toBeNull();
  }
  fresh();
  await unlocked();
  fireEvent.click(within(side()).getByRole("button", { name: "Settings" }));
  const last = await screen.findByRole("complementary", { name: "Settings" });
  fireEvent.click(within(last).getByRole("button", { name: "Back up" }));
  const panel = await screen.findByRole("complementary", { name: "Back up" });
  shell.refuseNext("backup_vault", { code: "invalid_input", what: "recovery key copies disagree" });
  fireEvent.click(within(panel).getByRole("button", { name: "Back up" }));
  const closing = await screen.findByRole("dialog", { name: "Can't back up My vault yet" });
  fireEvent.click(within(closing).getByRole("button", { name: "Not now" }));
  await waitFor(() => {
    expect(screen.queryByRole("dialog", { name: "Can't back up My vault yet" })).toBeNull();
  });
  expect(screen.queryByRole("complementary", { name: "New recovery key" })).toBeNull();
});

test("new_key_hidden_on_a_read_only_vault", async () => {
  // A vault opened read-only has no key to replace: Settings has no such row, and the store won't open the form.
  await unlocked(mine({ readOnly: true }));
  fireEvent.click(within(side()).getByRole("button", { name: "Settings" }));
  const settings = await screen.findByRole("complementary", { name: "Settings" });
  expect(within(settings).queryByRole("button", { name: "New recovery key" })).toBeNull();
  expect(within(settings).queryByText(/new recovery key/i)).toBeNull();
  act(() => {
    openNewRecoveryKey(sessionOfVault(7).session);
  });
  expect(screen.queryByRole("complementary", { name: "New recovery key" })).toBeNull();
  await act(async () => {
    await makeNewRecoveryKey(sessionOfVault(7).session, PASSWORD);
  });
  expect(sent("new_recovery_key")).toEqual([]);
  // And a writable vault has the row, with its hint.
  fresh();
  await unlocked();
  fireEvent.click(within(side()).getByRole("button", { name: "Settings" }));
  const writable = await screen.findByRole("complementary", { name: "Settings" });
  const row = within(writable).getByRole("button", { name: "New recovery key" });
  expect(row.getAttribute("aria-describedby")).not.toBeNull();
  expect(within(writable).getByText("Make a new recovery key for My vault. The old one stops working.")).toBeTruthy();
});

test("new_key_screens_have_no_axe_violations", async () => {
  await unlocked();
  let panel = await openForm();
  // 29a, and with the line a refusal puts on it.
  await expectNoAxe(panel);
  typeInto(panel, WRONG_ONE);
  submit(panel);
  await within(panel).findByText(WRONG_CURRENT);
  await expectNoAxe(panel);
  expect(panel.querySelectorAll("style, [style]")).toHaveLength(0);
  // 29b, shown and after a wrong pick, then the questions.
  typeInto(panel, PASSWORD);
  submit(panel);
  await screen.findByRole("heading", { level: 1, name: KEY_HEADING });
  const key = shell.keyOf(7) ?? "";
  await expectNoAxe(document.body);
  expect(document.body.querySelectorAll("style, [style]")).toHaveLength(0);
  await toTheQuestions();
  await expectNoAxe(document.body);
  pick(key, true);
  pick(key, false);
  await screen.findByRole("heading", { level: 1, name: KEY_HEADING });
  expect(screen.getByRole("alert")).toBeTruthy();
  await expectNoAxe(document.body);
  // 29c.
  await toTheQuestions();
  pickAllRight(key);
  const dialog = await screen.findByRole("dialog", { name: OFFER_TITLE });
  await expectNoAxe(dialog);
  panel = dialog;
  expect(panel.querySelectorAll("style, [style]")).toHaveLength(0);
});
