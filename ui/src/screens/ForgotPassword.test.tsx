// Plan 4C Task 4's screens: Forgot password in two steps (28a to 28e). Every case runs through the real App against the pretend shell, as a person would
// reach it: the lock screen's "Forgot password?", the recovery key, the new password, the offer of a fresh backup. Recovery keys are the pretend shell's own
// (`fakeKey`); typed passwords are made up (`MU-`), and a test of a wipe looks for them in the fields, the page and the store.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import App from "../App";
import { messageFor } from "../messages";
import { debugState, resetStoreForTests } from "../store";
import { expectNoAxe } from "../testing/axe";
import { fakeKey, FAKE_WORDS, installFakeShell, PASSWORD, sampleItems, type FakeShell, type FakeVault } from "../testing/fakeShell";

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

const LINK = "Forgot password?";
const KEY_HEADING = "Forgot password?";
const NO_KEY_LINK = "I don't have my recovery key";
const NO_KEY_HEADING = "No recovery key?";
const NO_KEY_EXCEPTION = "The one exception is a backup that opens with details you still have: its password or recovery key from when it was made.";
const NEW_HEADING = "Choose a new password";
const BACKUPS_WORDS = "Backups you already made still need the old details.";
const OLD_COPIES_WORDS = "Older copies of this vault still open with the old password.";
const LIMIT_WORDS =
  "Changing the password doesn't lock out an old copy. Anyone who has an old copy of this vault's details (an earlier copy of its folder, or an old backup) and its old password or recovery key can read your current and future items and files, if they get copies of them.";
const OFFER_TITLE = "Make a fresh backup now?";
const OFFER_WORDS = "Backups you already made still need the old details. A fresh one opens with what you use today.";
const TOO_SHORT = "At least 12 characters.";
const MISMATCH = "The two new passwords don't match.";
const TYPO = "That recovery key has a typo. Check it against the one you saved.";
const WORD_7 = "Word 7 isn't a recovery key word. Check it against the key you saved.";
const COUNT_23 = "That's 23 words; a recovery key has 24. Check none are missing or doubled.";
const EXPIRED = "Type the recovery key again. It waited too long, or the vault changed since it was checked. Nothing was changed.";
const ASK16 = "Your new password was saved, but the vault locked before Lockbox could say so. Unlock with the new one.";
const CHANGED_WORDS =
  "Its name, or other details kept beside your items, don't match what Lockbox last saved. If you edited that file yourself, accept them and go on. If you didn't, say No and check your PC first; restoring a backup you trust is the safer way back.";

function vault(id: number, name: string, extra: Partial<FakeVault> = {}): FakeVault {
  return { id, name, items: sampleItems(), ...extra };
}

function mine(extra: Partial<FakeVault> = {}): FakeVault[] {
  return [vault(7, "My vault", extra)];
}

function sent(cmd: string): Record<string, unknown>[] {
  return invoke.mock.calls.filter(([name]) => name === cmd).map(([, args]) => args as Record<string, unknown>);
}

async function unlockWith(password: string) {
  const field = await screen.findByLabelText(/^Password for /);
  fireEvent.change(field, { target: { value: password } });
  fireEvent.submit((field as HTMLInputElement).form as HTMLFormElement);
}

/** The lock screen over `list`, with Forgot password? pressed for the vault chosen (the first one, unless `pick` is the place of another among the radios). */
async function forgot(list: FakeVault[] = mine(), pick?: number) {
  shell = installFakeShell(invoke, listen, list);
  const view = render(<App />);
  await screen.findByLabelText(/^Password for /);
  if (pick !== undefined) fireEvent.click(screen.getAllByRole("radio")[pick] as HTMLElement);
  fireEvent.click(screen.getByRole("button", { name: LINK }));
  await screen.findByRole("heading", { level: 1, name: KEY_HEADING });
  return view;
}

/** Starts again with a fresh page and shell (a test that runs several cases). */
function fresh() {
  cleanup();
  resetStoreForTests();
  invoke.mockReset();
  listen.mockReset();
}

function keyBox(): HTMLInputElement {
  return screen.getByLabelText<HTMLInputElement>("Recovery key");
}

function typeKey(text: string) {
  fireEvent.change(keyBox(), { target: { value: text } });
}

function press(name: string) {
  fireEvent.click(screen.getByRole("button", { name }));
}

/** The key as the person types it, then Continue. */
function sendKey(text: string) {
  typeKey(text);
  press("Continue");
}

function passwordBoxes(): HTMLInputElement[] {
  return [screen.getByLabelText<HTMLInputElement>("New password"), screen.getByLabelText<HTMLInputElement>("New password again")];
}

function typeNew(next: string, again: string = next) {
  const [first, second] = passwordBoxes();
  fireEvent.change(first as HTMLInputElement, { target: { value: next } });
  fireEvent.change(second as HTMLInputElement, { target: { value: again } });
}

/** The right key for the vault, sent, and 28d is up. */
async function toNewPassword(id = 7) {
  sendKey(shell.recoveryKeyOf(id));
  await screen.findByRole("heading", { level: 1, name: NEW_HEADING });
}

function setPassword() {
  press("Set new password");
}

/** `key` with the word at `index` (from 0) put in another listed word's place. */
function withWord(key: string, index: number, word: string): string {
  const words = key.split(" ");
  words[index] = word;
  return words.join(" ");
}

/** Whatever of a made-up secret is in a field, in the words on the page or in the store: the list of where it was found. */
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

function alerts(): string[] {
  return screen.queryAllByRole("alert").map((alert) => alert.textContent);
}

test("forgot_password_link_opens_28a", async () => {
  const list = mine();
  await forgot(list);
  // 28a: the recovery key's box, for the vault chosen, hidden to begin with and named by its label. Nothing is sent by opening it.
  expect(screen.getByText("Type the recovery key you saved for My vault.")).toBeTruthy();
  const box = keyBox();
  expect(box.type).toBe("password");
  expect(box.value).toBe("");
  expect(screen.getAllByRole("button").map((button) => button.getAttribute("aria-label") ?? button.textContent)).toEqual([
    "Show what you typed",
    "Continue",
    "Back",
    NO_KEY_LINK,
  ]);
  expect(sent("recover_check")).toEqual([]);
  expect(sent("recover_finish")).toEqual([]);
  // Back is the lock screen again, with the vault still chosen.
  press("Back");
  await screen.findByLabelText("Password for My vault");
  expect(screen.queryByRole("heading", { level: 1, name: KEY_HEADING })).toBeNull();
  expect(sent("recover_forget")).toEqual([]);
});

test("the_flow_belongs_to_the_vault_chosen_on_the_lock_screen", async () => {
  // Two vaults of the same name: only the command's arguments and the vault changed on disk tell them apart.
  const list = [vault(7, "My vault"), vault(8, "My vault")];
  await forgot(list, 1);
  sendKey(shell.recoveryKeyOf(8));
  await screen.findByRole("heading", { level: 1, name: NEW_HEADING });
  // The check named the second vault by its registry ID, and only it changes.
  expect(sent("recover_check")).toEqual([{ vault: { list: shell.listIdentity(), id: 8 }, recovery_key: shell.recoveryKeyOf(8) }]);
  typeNew(NEW);
  setPassword();
  await screen.findByRole("heading", { level: 1, name: OFFER_TITLE });
  expect(list.map((one) => one.password)).toEqual([undefined, NEW]);
  expect(shell.sessionOf(8)?.unlocked).toBe(true);
  expect(shell.sessionOf(7)?.unlocked ?? false).toBe(false);
});

test("closing_the_flow_returns_to_the_vault_it_was_opened_for", async () => {
  await forgot([vault(7, "My vault"), vault(8, "Home")], 1);
  expect(screen.getByText("Type the recovery key you saved for Home.")).toBeTruthy();
  press("Back");
  await screen.findByLabelText("Password for Home");
  expect(screen.getByRole<HTMLInputElement>("radio", { name: /Home/ }).checked).toBe(true);
});

test("a_typo_says_so", async () => {
  await forgot();
  // A valid key with one word changed for another listed word: the check the key carries catches it before anything is tried against the vault.
  const typo = withWord(shell.recoveryKeyOf(7), 3, "amber");
  expect(typo).not.toBe(shell.recoveryKeyOf(7));
  sendKey(typo);
  // The spec's words (5.2), word for word, on the box; the box is empty.
  await waitFor(() => {
    expect(alerts()).toEqual([TYPO]);
  });
  expect(keyBox().value).toBe("");
  expect(keyBox().getAttribute("aria-invalid")).toBe("true");
  // One command, with the key as typed in snake_case, and no choice was made.
  expect(sent("recover_check")).toEqual([{ vault: { list: shell.listIdentity(), id: 7 }, recovery_key: typo }]);
  expect(shell.recoveryChoiceTokens()).toEqual([]);
  expect(foundOnPage([typo])).toEqual([]);
  // Typing again takes the line away.
  typeKey("a");
  expect(alerts()).toEqual([]);
});

test("a_word_not_in_the_list_names_its_number", async () => {
  await forgot();
  sendKey(withWord(shell.recoveryKeyOf(7), 6, "notaword"));
  await waitFor(() => {
    expect(alerts()).toEqual([WORD_7]);
  });
  expect(keyBox().value).toBe("");
  expect(shell.recoveryChoiceTokens()).toEqual([]);
});

test("a_wrong_count_says_how_many", async () => {
  await forgot();
  sendKey(shell.recoveryKeyOf(7).split(" ").slice(0, 23).join(" "));
  await waitFor(() => {
    expect(alerts()).toEqual([COUNT_23]);
  });
  expect(shell.recoveryChoiceTokens()).toEqual([]);
  // A word too many is a count too.
  sendKey(`${shell.recoveryKeyOf(7)} ${FAKE_WORDS[0] ?? ""}`);
  await waitFor(() => {
    expect(alerts()).toEqual(["That's 25 words; a recovery key has 24. Check none are missing or doubled."]);
  });
});

test("another_or_old_key_says_it_doesnt_open_this_vault", async () => {
  // Another vault's key, or an old one: the cipher can't tell them apart, so the words are the same, with this vault's name put in by the page.
  const list = [vault(7, "My vault"), vault(8, "Home", { recoveryKey: fakeKey(20) })];
  await forgot(list);
  sendKey(shell.recoveryKeyOf(8));
  await waitFor(() => {
    expect(alerts()).toEqual(["This key doesn't open My vault."]);
  });
  expect(keyBox().value).toBe("");
  expect(shell.recoveryChoiceTokens()).toEqual([]);
  // A key that was this vault's once (fakeKey(47) is My vault's own, and the other vault's is another).
  sendKey(fakeKey(3));
  await waitFor(() => {
    expect(sent("recover_check")).toHaveLength(2);
  });
  await waitFor(() => {
    expect(alerts()).toEqual(["This key doesn't open My vault."]);
  });
  // The name is the vault's on the list, not the shell's own text: the table's entry carries a place for it.
  expect(messageFor({ code: "page", kind: "recovery_key_does_not_open" }, { vault: "Home" }).title).toBe("This key doesn't open Home.");
  // The other vault, chosen on the lock screen, says its own name.
  press("Back");
  fireEvent.click(await screen.findByRole("radio", { name: /Home/ }));
  fireEvent.click(screen.getByRole("button", { name: LINK }));
  await screen.findByRole("heading", { level: 1, name: KEY_HEADING });
  sendKey(shell.recoveryKeyOf(7));
  await waitFor(() => {
    expect(alerts()).toEqual(["This key doesn't open Home."]);
  });
  expect(sent("recover_check").map((one) => one.vault)).toEqual([7, 7, 8].map((id) => ({ list: shell.listIdentity(), id })));
});

test("a_refusal_the_shell_gives_for_the_check_is_said_in_its_own_words", async () => {
  await forgot();
  shell.refuseNext("recover_check", { code: "core", kind: "damaged" });
  sendKey(shell.recoveryKeyOf(7));
  await waitFor(() => {
    expect(alerts()).toEqual(["Lockbox can't read part of this vault. It may be damaged. A backup can bring it back."]);
  });
  expect(keyBox().value).toBe("");
  // Never the shell's own text.
  fresh();
  await forgot();
  shell.refuseNext("recover_check", { code: "core", kind: "damaged", what: "SENTINEL C:\\Users\\secret" });
  sendKey(shell.recoveryKeyOf(7));
  await waitFor(() => {
    expect(alerts()).toHaveLength(1);
  });
  expect(document.body.textContent).not.toContain("SENTINEL");
});

test("no_key_says_plainly_nobody_can_get_in_unless_a_backup_opens", async () => {
  await forgot();
  fireEvent.click(screen.getByRole("button", { name: NO_KEY_LINK }));
  // 28c: plainly, in the design's meaning: nobody can get in, unless a backup opens with details they still have.
  await screen.findByRole("heading", { level: 1, name: NO_KEY_HEADING });
  expect(screen.getByText("Without the password or the recovery key, nobody can get into My vault, and the data can't be recovered.")).toBeTruthy();
  expect(screen.getByText(NO_KEY_EXCEPTION)).toBeTruthy();
  expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual(["Restore a backup", "Back"]);
  expect(sent("recover_check")).toEqual([]);
  // Back is 28a again, with the box empty.
  press("Back");
  await screen.findByRole("heading", { level: 1, name: KEY_HEADING });
  expect(keyBox().value).toBe("");
  // Restore a backup leaves this flow and begins a restore (24a's picker), the same as the lock screen's own link.
  fireEvent.click(screen.getByRole("button", { name: NO_KEY_LINK }));
  await screen.findByRole("heading", { level: 1, name: NO_KEY_HEADING });
  press("Restore a backup");
  await waitFor(() => {
    expect(sent("restore_pick")).toEqual([{ choice: null, vault: null }]);
  });
  await screen.findByRole("heading", { level: 1, name: "Restore a backup" });
  expect(debugState().forgot).toBeNull();
});

test("new_password_twice_with_the_count", async () => {
  await forgot();
  await toNewPassword();
  // 28d: the new password and again, both hidden, for a new password; the vault's name from the check.
  expect(screen.getByText("For My vault.")).toBeTruthy();
  const boxes = passwordBoxes();
  expect(boxes.map((box) => box.type)).toEqual(["password", "password"]);
  expect(boxes.map((box) => box.getAttribute("autocomplete"))).toEqual(["new-password", "new-password"]);
  expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual(["Set new password", "Back"]);
  // Counted as the core counts: Unicode characters after NFC (combining and non-BMP characters at the boundary).
  const hint = () => boxes[0]?.closest("div")?.querySelector(".fu-hint");
  const cases: { text: string; count: number }[] = [
    { text: "é".repeat(11), count: 11 },
    { text: "é".repeat(12), count: 12 },
    { text: "q́".repeat(6), count: 12 },
    { text: "\u{1F600}".repeat(11), count: 11 },
    { text: "\u{1F600}".repeat(12), count: 12 },
  ];
  for (const { text, count } of cases) {
    fireEvent.change(boxes[0] as HTMLInputElement, { target: { value: text } });
    if (count < 12) {
      expect(hint()?.textContent, text).toBe(`At least 12 characters · ${String(count)} so far`);
      expect(hint()?.classList.contains("ok")).toBe(false);
    } else {
      expect(hint()?.textContent, text).toBe("12 characters or more");
      expect(hint()?.classList.contains("ok")).toBe(true);
    }
  }
  // Nothing is sent before Set new password; then once, with the choice the check gave and the password, in the contract's snake_case.
  expect(sent("recover_finish")).toEqual([]);
  const [choice] = shell.recoveryChoiceTokens();
  expect(choice).toMatch(/^[0-9a-f]{32}$/);
  typeNew(NEW);
  setPassword();
  await screen.findByRole("heading", { level: 1, name: OFFER_TITLE });
  expect(sent("recover_finish")).toEqual([{ choice, new_password: NEW, accept_changed_header: false }]);
  // The choice was used up by it.
  expect(shell.recoveryChoiceTokens()).toEqual([]);
});

test("a_mismatched_confirmation_sends_nothing", async () => {
  const list = mine();
  await forgot(list);
  await toNewPassword();
  // Under 12 characters, said on the new password's own field; nothing is sent and the text stays to be mended.
  typeNew("MU-short", "MU-short");
  setPassword();
  expect(alerts()).toEqual([TOO_SHORT]);
  expect(passwordBoxes()[0]?.getAttribute("aria-invalid")).toBe("true");
  expect(sent("recover_finish")).toEqual([]);
  expect(passwordBoxes().map((box) => box.value)).toEqual(["MU-short", "MU-short"]);
  // Long enough, but the two don't match: said on the second one.
  typeNew(NEW, NEW_2);
  expect(alerts()).toEqual([]);
  setPassword();
  expect(alerts()).toEqual([MISMATCH]);
  expect(passwordBoxes()[1]?.getAttribute("aria-invalid")).toBe("true");
  expect(sent("recover_finish")).toEqual([]);
  // Both at once.
  typeNew("MU-short", "MU-other");
  setPassword();
  expect(alerts()).toEqual([TOO_SHORT, MISMATCH]);
  expect(sent("recover_finish")).toEqual([]);
  expect(list[0]?.password).toBeUndefined();
  // The key is still held, and mended it goes through.
  expect(shell.recoveryChoiceTokens()).toHaveLength(1);
  typeNew(NEW);
  setPassword();
  await screen.findByRole("heading", { level: 1, name: OFFER_TITLE });
  expect(sent("recover_finish")).toHaveLength(1);
});

test("the_new_password_screen_states_the_backup_limit", async () => {
  await forgot();
  await toNewPassword();
  // Old backups and old copies still open with the old password, and spec 5.3's limit in full, as 27a says it: one note, in that order.
  expect(screen.getByRole("note").textContent).toBe(`${BACKUPS_WORDS} ${OLD_COPIES_WORDS} ${LIMIT_WORDS}`);
  expect(screen.getAllByRole("note")).toHaveLength(1);
  expect(LIMIT_WORDS).toMatch(/old copy of this vault's details/);
  expect(LIMIT_WORDS).toMatch(/old password or recovery key/);
  expect(LIMIT_WORDS).toMatch(/current and future items and files/);
  expect(LIMIT_WORDS).toMatch(/if they get copies of them/);
});

test("done_offers_a_fresh_backup", async () => {
  const list = mine();
  await forgot(list);
  await toNewPassword();
  typeNew(NEW);
  setPassword();
  // 28e: the change landed, the vault is open under this step, and a fresh backup is offered; its words word for word (27c's).
  await screen.findByRole("heading", { level: 1, name: OFFER_TITLE });
  expect(screen.getByText(OFFER_WORDS)).toBeTruthy();
  expect(screen.getAllByRole("status").map((one) => one.textContent)).toContain("Your new password is set.");
  expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual(["Back up now", "Not now"]);
  expect(list[0]?.password).toBe(NEW);
  expect(shell.sessionOf(7)?.unlocked).toBe(true);
  expect(foundOnPage([NEW])).toEqual([]);
  // Back up now opens 22a for this vault (nothing is written until Back up is pressed there) and closes the step.
  press("Back up now");
  const panel = await screen.findByRole("complementary", { name: "Back up" });
  expect(within(panel).getByText("For My vault.")).toBeTruthy();
  expect(screen.queryByRole("heading", { level: 1, name: OFFER_TITLE })).toBeNull();
  expect(sent("backup_vault")).toEqual([]);

  // Not now closes it, and opens nothing: the vault is as an unlock leaves it.
  fresh();
  await forgot();
  await toNewPassword();
  typeNew(NEW);
  setPassword();
  await screen.findByRole("heading", { level: 1, name: OFFER_TITLE });
  press("Not now");
  await screen.findByRole("heading", { level: 1, name: "All items", hidden: true });
  expect(screen.queryByRole("heading", { level: 1, name: OFFER_TITLE })).toBeNull();
  expect(screen.queryByRole("complementary", { name: "Back up" })).toBeNull();
  expect(sent("backup_vault")).toEqual([]);
  // The new password opens the vault from now on, and the old one doesn't.
  fireEvent.click(screen.getByRole("button", { name: "Lock all" }));
  await unlockWith(PASSWORD);
  expect((await screen.findByRole("alert")).textContent).toBe("Wrong password.");
  await unlockWith(NEW);
  await screen.findByRole("heading", { level: 1, name: "All items", hidden: true });
});

test("a_recovered_vault_with_an_unconfirmed_key_makes_a_new_one_after_the_offer", async () => {
  await forgot(mine({ unconfirmed: true }));
  await toNewPassword();
  typeNew(NEW);
  setPassword();
  // 21f's step is the usual unlock result: the offer shows first, and the key is made for the vault's session.
  await screen.findByRole("heading", { level: 1, name: OFFER_TITLE });
  await waitFor(() => {
    expect(sent("regenerate_recovery")).toHaveLength(1);
  });
  press("Not now");
  await waitFor(() => {
    expect(screen.queryByRole("heading", { level: 1, name: OFFER_TITLE })).toBeNull();
  });
  expect(shell.keyOf(7)).toBeDefined();
});

test("changed_header_asks_first_then_sets_the_password", async () => {
  const list = mine({ headerChanged: true });
  await forgot(list);
  sendKey(shell.recoveryKeyOf(7));
  // Ask 3's words, for the vault the key opened: the question comes first, before the new password, and nothing is written meanwhile.
  const dialog = await screen.findByRole("dialog", { name: "My vault's details were changed outside Lockbox." });
  expect(within(dialog).getByText(CHANGED_WORDS)).toBeTruthy();
  expect(within(dialog).getAllByRole("button").map((button) => button.textContent)).toEqual(["No", "Yes"]);
  expect(sent("recover_finish")).toEqual([]);
  expect(list[0]?.password).toBeUndefined();
  // Escape is not a yes: only a button answers.
  fireEvent.keyDown(dialog, { key: "Escape" });
  expect(screen.getByRole("dialog", { name: "My vault's details were changed outside Lockbox." })).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "Yes" }));
  await screen.findByRole("heading", { level: 1, name: NEW_HEADING });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(sent("recover_finish")).toEqual([]);
  // The choice the shell holds for the checked key, read from the shell and not from what the page sent.
  const [held] = shell.recoveryChoiceTokens();
  expect(held).toMatch(/^[0-9a-f]{32}$/);
  typeNew(NEW);
  setPassword();
  await screen.findByRole("heading", { level: 1, name: OFFER_TITLE });
  // The yes went with the password, in the one call, with that choice, and the vault's details are accepted.
  expect(sent("recover_finish")).toEqual([{ choice: held, new_password: NEW, accept_changed_header: true }]);
  expect(list[0]?.password).toBe(NEW);
  expect(list[0]?.headerChanged).toBe(false);
});

test("no_to_the_changed_header_forgets_the_choice", async () => {
  const list = mine({ headerChanged: true });
  await forgot(list);
  sendKey(shell.recoveryKeyOf(7));
  const dialog = await screen.findByRole("dialog", { name: "My vault's details were changed outside Lockbox." });
  const [choice] = shell.recoveryChoiceTokens();
  expect(choice).toBeDefined();
  // No is the safe answer and has the focus first.
  await waitFor(() => {
    expect(document.activeElement?.textContent).toBe("No");
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "No" }));
  await waitFor(() => {
    expect(sent("recover_forget")).toEqual([{ choice }]);
  });
  // Nothing changed: the shell holds no choice, the password is as it was and the details are still not accepted; the box is 28a's, empty.
  expect(shell.recoveryChoiceTokens()).toEqual([]);
  expect(list[0]?.password).toBeUndefined();
  expect(list[0]?.headerChanged).toBe(true);
  expect(sent("recover_finish")).toEqual([]);
  await screen.findByRole("heading", { level: 1, name: KEY_HEADING });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(keyBox().value).toBe("");
});

test("back_from_the_new_password_forgets_the_choice", async () => {
  await forgot();
  await toNewPassword();
  const [choice] = shell.recoveryChoiceTokens();
  typeNew(NEW);
  press("Back");
  await screen.findByRole("heading", { level: 1, name: KEY_HEADING });
  expect(sent("recover_forget")).toEqual([{ choice }]);
  expect(shell.recoveryChoiceTokens()).toEqual([]);
  expect(keyBox().value).toBe("");
  expect(foundOnPage([NEW])).toEqual([]);
  // Leaving from there forgets nothing more (no choice is held), and a new check makes a new choice.
  sendKey(shell.recoveryKeyOf(7));
  await screen.findByRole("heading", { level: 1, name: NEW_HEADING });
  expect(shell.recoveryChoiceTokens()).toHaveLength(1);
  expect(shell.recoveryChoiceTokens()[0]).not.toBe(choice);
  press("Back");
  await screen.findByRole("heading", { level: 1, name: KEY_HEADING });
  press("Back");
  await screen.findByLabelText(/^Password for /);
  expect(sent("recover_forget")).toHaveLength(2);
});

test("back_while_the_check_is_pending_forgets_its_late_choice", async () => {
  await forgot();
  const release = shell.holdRecoverCheck();
  sendKey(shell.recoveryKeyOf(7));
  await waitFor(() => {
    expect(sent("recover_check")).toHaveLength(1);
  });
  // The shell has made the choice; the page has not heard. Back leaves the flow, and sends nothing of its own yet (it knows no choice).
  expect(shell.recoveryChoiceTokens()).toHaveLength(1);
  const [late] = shell.recoveryChoiceTokens();
  press("Back");
  await screen.findByLabelText(/^Password for /);
  expect(sent("recover_forget")).toEqual([]);
  // The late answer brings the choice, and the page lets it go at once: it never shows 28d, and nothing is left held.
  act(() => {
    release();
  });
  await waitFor(() => {
    expect(sent("recover_forget")).toEqual([{ choice: late }]);
  });
  expect(shell.recoveryChoiceTokens()).toEqual([]);
  expect(screen.queryByRole("heading", { level: 1, name: NEW_HEADING })).toBeNull();
  expect(debugState().forgot).toBeNull();
});

test("a_check_pending_when_the_flow_is_opened_again_does_not_keep_the_old_choice", async () => {
  await forgot();
  const release = shell.holdRecoverCheck();
  sendKey(shell.recoveryKeyOf(7));
  await waitFor(() => {
    expect(sent("recover_check")).toHaveLength(1);
  });
  press("Back");
  await screen.findByLabelText(/^Password for /);
  // Opened again before the old answer came: the old answer is not this flow's.
  fireEvent.click(screen.getByRole("button", { name: LINK }));
  await screen.findByRole("heading", { level: 1, name: KEY_HEADING });
  act(() => {
    release();
  });
  await waitFor(() => {
    expect(sent("recover_forget")).toHaveLength(1);
  });
  expect(screen.queryByRole("heading", { level: 1, name: NEW_HEADING })).toBeNull();
  expect(keyBox().value).toBe("");
});

test("forgot_password_wipes_the_typed_secrets_pending_refused_back_and_locked", async () => {
  // Pending: the field, the page and the store are clear the moment the key is sent, before the answer comes.
  await forgot();
  const key = shell.recoveryKeyOf(7);
  typeKey(key);
  expect(foundOnPage([key])).toEqual(["a field holds " + key]);
  expect(JSON.stringify(debugState())).toContain("My vault");
  const release = shell.holdRecoverCheck();
  press("Continue");
  await waitFor(() => {
    expect(sent("recover_check")).toHaveLength(1);
  });
  expect(keyBox().value).toBe("");
  expect(foundOnPage([key])).toEqual([]);
  // While it is out the box can't be typed in (what is typed meanwhile would outlive a refusal), and a second press sends nothing.
  expect(keyBox().readOnly).toBe(true);
  typeKey(key);
  expect(keyBox().value).toBe("");
  press("Continue");
  expect(sent("recover_check")).toHaveLength(1);
  act(() => {
    release();
  });
  await screen.findByRole("heading", { level: 1, name: NEW_HEADING });
  expect(foundOnPage([key])).toEqual([]);

  // The new password is wiped the same way: pending, then after a refusal.
  const finish = shell.holdRecoverFinish();
  typeNew(NEW);
  expect(foundOnPage([NEW])).toHaveLength(2);
  setPassword();
  await waitFor(() => {
    expect(sent("recover_finish")).toHaveLength(1);
  });
  expect(passwordBoxes().map((box) => box.value)).toEqual(["", ""]);
  expect(passwordBoxes().map((box) => box.readOnly)).toEqual([true, true]);
  expect(foundOnPage([NEW])).toEqual([]);
  act(() => {
    finish();
  });
  await screen.findByRole("heading", { level: 1, name: OFFER_TITLE });
  expect(foundOnPage([NEW, key])).toEqual([]);

  // Refused (28a): empty box with the reason.
  fresh();
  await forgot();
  const wrong = withWord(shell.recoveryKeyOf(7), 3, "amber");
  sendKey(wrong);
  await waitFor(() => {
    expect(alerts()).toEqual([TYPO]);
  });
  expect(keyBox().value).toBe("");
  expect(foundOnPage([wrong])).toEqual([]);

  // Refused (28d): a refusal of the finish takes the choice with it, so the person is back at the key with empty boxes and the reason.
  fresh();
  await forgot();
  await toNewPassword();
  const [heldChoice] = shell.recoveryChoiceTokens();
  expect(heldChoice).toMatch(/^[0-9a-f]{32}$/);
  // The refusal comes before the shell takes the choice (the fake refuses it at the door, as an IPC failure would), so the shell still holds the key: the page
  // lets it go itself, with that choice, rather than leaving it for the five minutes.
  shell.refuseNext("recover_finish", { code: "core", kind: "io" });
  typeNew(NEW);
  setPassword();
  await waitFor(() => {
    expect(alerts()).toEqual(["Lockbox couldn't reach that folder or file. Check that the drive is connected, then try again."]);
  });
  expect(keyBox().value).toBe("");
  await waitFor(() => {
    expect(sent("recover_forget")).toEqual([{ choice: heldChoice }]);
  });
  expect(shell.recoveryChoiceTokens()).toEqual([]);
  expect(foundOnPage([NEW, shell.recoveryKeyOf(7)])).toEqual([]);

  // Back: typed and left, the box opened again is empty; the same on 28d.
  fresh();
  await forgot();
  typeKey("MU-typed key");
  expect(foundOnPage(["MU-typed"])).toHaveLength(1);
  press("Back");
  await screen.findByLabelText(/^Password for /);
  expect(foundOnPage(["MU-typed"])).toEqual([]);
  fireEvent.click(screen.getByRole("button", { name: LINK }));
  await screen.findByRole("heading", { level: 1, name: KEY_HEADING });
  expect(keyBox().value).toBe("");
  await toNewPassword();
  typeNew("MU-typed new passphrase");
  expect(foundOnPage(["MU-typed"])).toHaveLength(2);
  press("Back");
  await screen.findByRole("heading", { level: 1, name: KEY_HEADING });
  expect(foundOnPage(["MU-typed"])).toEqual([]);

  // A lock (every vault: Lock all, idle, Windows locking, sleep) with the key typed, and with the new password typed: the flow is at 28a again with
  // nothing typed anywhere, and nothing was sent.
  fresh();
  await forgot();
  typeKey("MU-typed key");
  await act(async () => {
    shell.changeLockEpoch("idle");
    await Promise.resolve();
  });
  expect(foundOnPage(["MU-typed"])).toEqual([]);
  expect(sent("recover_check")).toEqual([]);
  await toNewPassword();
  typeNew("MU-typed new passphrase");
  expect(shell.recoveryChoiceTokens()).toHaveLength(1);
  await act(async () => {
    shell.changeLockEpoch("windows_locked");
    await Promise.resolve();
  });
  await screen.findByRole("heading", { level: 1, name: KEY_HEADING });
  expect(keyBox().value).toBe("");
  expect(foundOnPage(["MU-typed"])).toEqual([]);
  expect(sent("recover_finish")).toEqual([]);
  // The shell dropped the choice with the lock; nothing is said, and the key typed again makes a new one.
  expect(shell.recoveryChoiceTokens()).toEqual([]);
  expect(alerts()).toEqual([]);
  await toNewPassword();

  // The window loses focus or hides with the key typed, or the new password typed: it is wiped, as the lock screen's password is.
  fresh();
  await forgot();
  typeKey("MU-typed key");
  act(() => {
    window.dispatchEvent(new Event("blur"));
  });
  expect(foundOnPage(["MU-typed"])).toEqual([]);
  await toNewPassword();
  typeNew("MU-typed new passphrase");
  expect(foundOnPage(["MU-typed"])).toHaveLength(2);
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  try {
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
  } finally {
    visibility.mockRestore();
  }
  expect(foundOnPage(["MU-typed"])).toEqual([]);
  // The shell's choice stays until its five minutes are up, so the step is still 28d and sets the password when it is typed again.
  expect(screen.getByRole("heading", { level: 1, name: NEW_HEADING })).toBeTruthy();
  expect(shell.recoveryChoiceTokens()).toHaveLength(1);
});

test("an_expired_choice_goes_back_to_the_key_with_its_words", async () => {
  // Five minutes (or a change to the vault's details) took the choice: nothing was changed, and the key is typed again.
  const list = mine();
  await forgot(list);
  await toNewPassword();
  shell.expireRecoveryChoices();
  typeNew(NEW);
  setPassword();
  await waitFor(() => {
    expect(alerts()).toEqual([EXPIRED]);
  });
  await screen.findByRole("heading", { level: 1, name: KEY_HEADING });
  expect(keyBox().value).toBe("");
  expect(list[0]?.password).toBeUndefined();
  expect(foundOnPage([NEW])).toEqual([]);
  // The right key again, and it goes through.
  await toNewPassword();
  typeNew(NEW);
  setPassword();
  await screen.findByRole("heading", { level: 1, name: OFFER_TITLE });
  expect(list[0]?.password).toBe(NEW);
});

test("a_header_changed_between_the_check_and_the_finish_asks_for_the_key_again", async () => {
  const list = mine();
  await forgot(list);
  await toNewPassword();
  // The vault's details were changed on disk after the key was checked: the shell won't set a password on what it did not check.
  const first = list[0] as FakeVault;
  first.headerChanged = true;
  typeNew(NEW);
  setPassword();
  await waitFor(() => {
    expect(alerts()).toEqual([EXPIRED]);
  });
  expect(first.password).toBeUndefined();
  // A fresh check now meets the changed details, and asks.
  sendKey(shell.recoveryKeyOf(7));
  await screen.findByRole("dialog", { name: "My vault's details were changed outside Lockbox." });
});

test("locked_before_it_could_say_shows_ask_16_on_that_vaults_unlock", async () => {
  // A lock before the password was written: nothing changed, no Ask 16, the flow is at the key with empty fields, and the old password still opens.
  let list = mine();
  await forgot(list);
  await toNewPassword();
  shell.interruptRecoverNext("lock_before_write");
  typeNew(NEW);
  setPassword();
  await screen.findByRole("heading", { level: 1, name: KEY_HEADING });
  expect(alerts()).toEqual([]);
  expect(keyBox().value).toBe("");
  expect(list[0]?.password).toBeUndefined();
  expect(screen.queryByText(ASK16)).toBeNull();
  press("Back");
  await unlockWith(NEW);
  expect((await screen.findByRole("alert")).textContent).toBe("Wrong password.");
  await unlockWith(PASSWORD);
  await screen.findByRole("heading", { level: 1, name: "All items", hidden: true });

  // The password was written, then the lock came: the page drops the answer (it is from before the lock) or the shell says so, and either way Ask 16 is
  // on that vault's lock screen, the old password is refused and the new one opens.
  for (const how of ["lock_after_write", "lock_after_write_as_error"] as const) {
    fresh();
    list = mine();
    await forgot(list);
    await toNewPassword();
    shell.interruptRecoverNext(how);
    typeNew(NEW);
    setPassword();
    await screen.findByLabelText(/^Password for /);
    expect((await screen.findByText(ASK16)).textContent).toBe(ASK16);
    expect(debugState().forgot).toBeNull();
    expect(debugState().sessions).toEqual([]);
    expect(list[0]?.password).toBe(NEW);
    expect(foundOnPage([NEW])).toEqual([]);
    await unlockWith(PASSWORD);
    expect((await screen.findByRole("alert")).textContent).toBe("Wrong password.");
    expect(screen.getByText(ASK16)).toBeTruthy();
    await unlockWith(NEW);
    await screen.findByRole("heading", { level: 1, name: "All items", hidden: true });
    expect(screen.queryByText(ASK16)).toBeNull();
  }

  // Another vault's lock screen does not say it: with two vaults, Ask 16 is for the one that was recovered. The second vault (Home, ID 8) is recovered, so
  // the vault the refusal names is not the first one on the list or the lock screen's default.
  fresh();
  list = [vault(7, "My vault"), vault(8, "Home")];
  await forgot(list, 1);
  await toNewPassword(8);
  shell.interruptRecoverNext("lock_after_write_as_error");
  typeNew(NEW);
  setPassword();
  await screen.findByLabelText(/^Password for /);
  expect(list.map((one) => one.password)).toEqual([undefined, NEW]);
  expect(debugState().lockNotes.map((note) => note.vault)).toEqual([8]);
  // Home is the vault chosen again, with its note; My vault says nothing of it.
  expect(screen.getByRole<HTMLInputElement>("radio", { name: /Home/ }).checked).toBe(true);
  expect(screen.getByText(ASK16)).toBeTruthy();
  fireEvent.click(screen.getByRole("radio", { name: /My vault/ }));
  expect(screen.queryByText(ASK16)).toBeNull();

  // A refusal that names a vault other than the flow's own is the shell's word for which vault's change landed: the note is kept for that one, whichever vault
  // the flow was opened for (a flow that read its own vault instead of the refusal's would keep it for the wrong one).
  fresh();
  list = [vault(7, "My vault"), vault(8, "Home")];
  await forgot(list);
  await toNewPassword(7);
  shell.refuseNext("recover_finish", { code: "locked_after_change", what: "password", vault: 8 });
  typeNew(NEW);
  setPassword();
  await screen.findByLabelText(/^Password for /);
  expect(debugState().lockNotes.map((note) => note.vault)).toEqual([8]);
  expect(screen.getByRole<HTMLInputElement>("radio", { name: /My vault/ }).checked).toBe(true);
  expect(screen.queryByText(ASK16)).toBeNull();
  fireEvent.click(screen.getByRole("radio", { name: /Home/ }));
  expect(screen.getByText(ASK16)).toBeTruthy();
});

test("back_is_not_offered_while_the_new_password_is_out", async () => {
  // The flow can't be left while the new password is sending, so the answer is always the flow's own: Back does nothing, and forgets no choice.
  await forgot();
  await toNewPassword();
  const finish = shell.holdRecoverFinish();
  typeNew(NEW);
  setPassword();
  await waitFor(() => {
    expect(sent("recover_finish")).toHaveLength(1);
  });
  expect(screen.getByRole("button", { name: "Back" }).getAttribute("aria-disabled")).toBe("true");
  press("Back");
  expect(screen.getByRole("heading", { level: 1, name: NEW_HEADING })).toBeTruthy();
  expect(sent("recover_forget")).toEqual([]);
  act(() => {
    finish();
  });
  await screen.findByRole("heading", { level: 1, name: OFFER_TITLE });
});

test("a_lock_of_the_vault_while_28e_shows_ends_the_offer", async () => {
  // The offer is for the vault the new password opened: when that vault locks there is nothing to back up, and the lock screen is what shows.
  await forgot();
  await toNewPassword();
  typeNew(NEW);
  setPassword();
  await screen.findByRole("heading", { level: 1, name: OFFER_TITLE });
  const live = shell.sessionOf(7);
  expect(live?.unlocked).toBe(true);
  act(() => {
    shell.lock((live as { session: number }).session);
  });
  await screen.findByLabelText(/^Password for /);
  expect(screen.queryByRole("heading", { level: 1, name: OFFER_TITLE })).toBeNull();
  expect(debugState().forgot).toBeNull();
  // The new password is what opens it now.
  await unlockWith(NEW);
  await screen.findByRole("heading", { level: 1, name: "All items", hidden: true });
});

test("forgot_password_screens_have_no_axe_violations", async () => {
  const { container } = await forgot(mine({ headerChanged: true }));
  // 28a.
  await expectNoAxe(container);
  // 28b: with a refusal on the box.
  sendKey(withWord(shell.recoveryKeyOf(7), 3, "amber"));
  await waitFor(() => {
    expect(alerts()).toEqual([TYPO]);
  });
  await expectNoAxe(container);
  // 28c.
  fireEvent.click(screen.getByRole("button", { name: NO_KEY_LINK }));
  await screen.findByRole("heading", { level: 1, name: NO_KEY_HEADING });
  await expectNoAxe(container);
  press("Back");
  // The changed details' question.
  sendKey(shell.recoveryKeyOf(7));
  const dialog = await screen.findByRole("dialog", { name: "My vault's details were changed outside Lockbox." });
  await expectNoAxe(dialog);
  fireEvent.click(within(dialog).getByRole("button", { name: "Yes" }));
  // 28d, with its lines on it.
  await screen.findByRole("heading", { level: 1, name: NEW_HEADING });
  await expectNoAxe(container);
  typeNew("MU-short", "MU-other");
  setPassword();
  expect(alerts()).toEqual([TOO_SHORT, MISMATCH]);
  await expectNoAxe(container);
  expect(container.querySelectorAll("style, [style]")).toHaveLength(0);
  // 28e.
  typeNew(NEW);
  setPassword();
  await screen.findByRole("heading", { level: 1, name: OFFER_TITLE });
  await expectNoAxe(container);
  expect(container.querySelectorAll("style, [style]")).toHaveLength(0);
});
