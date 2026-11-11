import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import App from "../../App";
import { messageFor, messageText } from "../../messages";
import { Pattern } from "../../parts/Pattern";
import { debugState, resetStoreForTests } from "../../store";
import { expectNoAxe } from "../../testing/axe";
import {
  installFakeShell,
  PASSWORD,
  DEFAULT_PRINTER,
  PDF_NOT_MADE,
  PRINT_NOT_SENT,
  PRINTER_BUSY,
  PRINTERS,
  sampleItems,
  SAVED_FOLDER,
  type FakeShell,
  type FakeVault,
} from "../../testing/fakeShell";
import { readBeside } from "../../testing/files";
import { wordsOf } from "./keyWords";

const { invoke, listen } = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

let shell: FakeShell;

beforeEach(() => {
  resetStoreForTests();
  invoke.mockReset();
  listen.mockReset();
});

const NEW_PASSWORD = "a long enough password";

function start(vaults: FakeVault[]) {
  shell = installFakeShell(invoke, listen, vaults);
  return render(<App />);
}

function click(name: string | RegExp, role: "button" | "link" = "button"): void {
  fireEvent.click(screen.getByRole(role, { name }));
}

function typeInto(label: string | RegExp, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

/** From the first screen to the filled-in form. */
async function toTheForm() {
  await screen.findByRole("heading", { level: 1, name: "Welcome to Lockbox" });
  click("Create a vault");
  await screen.findByRole("heading", { level: 1, name: "Create your vault" });
}

function fill(name = "My vault", password = NEW_PASSWORD, again = password): void {
  typeInto("Vault name", name);
  typeInto("Password", password);
  typeInto("Password again", again);
}

async function toTheKey() {
  await toTheForm();
  fill();
  click("Create vault");
  return screen.findByRole("heading", { level: 1, name: "Save your recovery key" });
}

const PICK_HEADING = "Check your recovery key";

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

/** Every word of the key that is on the page, in its text or in any attribute. */
function keyWordsOnPage(key: string): string[] {
  const found = new Set<string>();
  const add = (text: string) => {
    for (const token of text.toLowerCase().split(/[^a-z]+/)) if (token !== "") found.add(token);
  };
  // Each piece of text on its own, since `textContent` runs one element's text into the next's.
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

/** From the key to the first question. */
async function toTheQuestions() {
  click("Continue");
  await screen.findByRole("heading", { level: 1, name: PICK_HEADING });
}

/** Three right picks, one after the other. */
function pickAllRight(key: string): void {
  for (let n = 0; n < 3; n += 1) pick(key, true);
}

function commandsSent(): string[] {
  return shell.calls.map((call) => call.cmd);
}

test("no_vaults_goes_to_welcome", async () => {
  const { container } = start([]);
  expect(await screen.findByRole("heading", { level: 1, name: "Welcome to Lockbox" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Create a vault" })).toBeTruthy();
  // 21a's second way in, in the words the plan gives; backups wait for 4B.
  expect(screen.getByRole("button", { name: "I already have a vault" })).toBeTruthy();
  expect(screen.queryByText(/backup/i)).toBeNull();
  expect(screen.queryByText(/forgot/i)).toBeNull();
  // The nine-point pattern of the setup screens, not a vault's own.
  const drawn = container.querySelector(".rose path")?.getAttribute("d");
  const nine = render(<Pattern points={9} />).container.querySelector("path")?.getAttribute("d");
  expect(drawn).toBe(nine);
  await expectNoAxe(container);
});

test("i_already_have_a_vault_adds_one_and_goes_to_the_lock_screen", async () => {
  start([]);
  shell.offerExisting({ id: 40, name: "Old vault", items: sampleItems() });
  await screen.findByRole("heading", { level: 1, name: "Welcome to Lockbox" });
  click("I already have a vault");
  expect(await screen.findByRole("heading", { level: 1, name: "Unlock Old vault" })).toBeTruthy();
  expect(commandsSent()).toContain("add_existing_vault");
});

test("a_folder_that_is_not_a_vault_says_so_on_the_first_screen", async () => {
  const { container } = start([]);
  await screen.findByRole("heading", { level: 1, name: "Welcome to Lockbox" });
  click("I already have a vault");
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).not.toContain("not a vault folder");
  expect(alert.textContent.length).toBeGreaterThan(5);
  expect(screen.getByRole("heading", { level: 1, name: "Welcome to Lockbox" })).toBeTruthy();
  await expectNoAxe(container);
});

test("password_rules_show_on_the_form", async () => {
  const { container } = start([]);
  await toTheForm();
  // The rule is on the form before anything is typed, and so is the warning about the name.
  expect(screen.getByText("At least 12 characters.")).toBeTruthy();
  expect(
    screen.getByText("Anyone with a copy of the vault's folder can read this name, so keep secrets out of it."),
  ).toBeTruthy();
  await expectNoAxe(container);

  fill("My vault", "too short", "too short");
  click("Create vault");
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toBe("At least 12 characters.");
  // Said on the form, and nothing was sent.
  expect(screen.getByRole("heading", { level: 1, name: "Create your vault" })).toBeTruthy();
  expect(commandsSent()).not.toContain("create_vault");
  await expectNoAxe(container);

  // Twelve characters are twelve characters, whatever they are made of: accents counted once.
  fill("My vault", "é".repeat(12), "é".repeat(12));
  click("Create vault");
  await screen.findByRole("heading", { level: 1, name: "Save your recovery key" });
});

test("password_hint_counts_as_you_type_and_announces_only_the_minimum", async () => {
  const { container } = start([]);
  await toTheForm();
  const field = screen.getByLabelText<HTMLInputElement>("Password");
  const hintOf = () => {
    const id = field.getAttribute("aria-describedby")?.split(" ").find((one) => one.endsWith("-rule")) ?? "";
    return document.getElementById(id) as HTMLElement;
  };
  const status = container.querySelector<HTMLElement>(".fu [role=status]:not([aria-busy])") as HTMLElement;
  // The announcement place is there from the start and says nothing.
  expect(status).not.toBeNull();
  expect(status.textContent).toBe("");
  // Before anything is typed: the rule alone, as before.
  expect(hintOf().textContent).toBe("At least 12 characters.");

  const seen: string[] = [];
  const watcher = new MutationObserver(() => {
    seen.push(status.textContent);
  });
  watcher.observe(status, { childList: true, characterData: true, subtree: true });

  // The count follows typing, one character at a time, and counts accented letters once.
  for (let n = 1; n <= 11; n += 1) {
    typeInto("Password", "é".repeat(n));
    expect(hintOf().textContent, `after ${String(n)}`).toBe(`At least 12 characters · ${String(n)} so far`);
    expect(hintOf().classList.contains("ok")).toBe(false);
  }
  await Promise.resolve();
  expect(seen).toEqual([]);
  expect(field.getAttribute("aria-describedby")).toContain(hintOf().id);

  // The rule met: the hint says so, with a check mark that is drawn only, and the one announcement is made.
  typeInto("Password", "é".repeat(12));
  expect(hintOf().textContent).toBe("12 characters or more");
  expect(hintOf().classList.contains("ok")).toBe(true);
  expect(hintOf().querySelector("svg[aria-hidden=true]")).not.toBeNull();
  await Promise.resolve();
  expect(status.textContent).toBe("12 characters or more");
  // Keeping on typing changes nothing in the announcement place.
  seen.length = 0;
  for (let n = 13; n <= 20; n += 1) typeInto("Password", "é".repeat(n));
  await Promise.resolve();
  expect(seen).toEqual([]);
  expect(hintOf().textContent).toBe("12 characters or more");
  await expectNoAxe(container);

  // Back under the minimum, the count returns and the announcement is cleared (so reaching it again is heard again).
  typeInto("Password", "short");
  expect(hintOf().textContent).toBe("At least 12 characters · 5 so far");
  expect(status.textContent).toBe("");
  watcher.disconnect();

  // The second box has no rule, so it has no count and no announcement of its own.
  const again = screen.getByLabelText<HTMLInputElement>("Password again");
  typeInto("Password again", "abc");
  expect(again.getAttribute("aria-describedby")).toBeNull();
  expect(container.querySelectorAll("[role=status]:not([aria-busy])")).toHaveLength(1);
});

test("mismatch_shows_on_the_form", async () => {
  const { container } = start([]);
  await toTheForm();
  fill("My vault", NEW_PASSWORD, `${NEW_PASSWORD}!`);
  click("Create vault");
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toBe("The two passwords don't match.");
  expect(commandsSent()).not.toContain("create_vault");
  // Mended, it goes on.
  typeInto("Password again", NEW_PASSWORD);
  expect(screen.queryByRole("alert")).toBeNull();
  await expectNoAxe(container);
});

test("a_vault_needs_a_name", async () => {
  const { container } = start([]);
  await toTheForm();
  fill("   ");
  click("Create vault");
  expect((await screen.findByRole("alert")).textContent).toBe("Give the vault a name.");
  expect(commandsSent()).not.toContain("create_vault");
  await expectNoAxe(container);
});

test("creating_sends_the_name_and_password_and_the_choice_of_folder", async () => {
  const { container } = start([]);
  await toTheForm();
  fill("Home", NEW_PASSWORD);
  click("Create vault");
  await screen.findByRole("heading", { level: 1, name: "Save your recovery key" });
  expect(invoke).toHaveBeenCalledWith("create_vault", { name: "Home", password: NEW_PASSWORD, choose_folder: false });
  // The form and its passwords are gone from the page.
  expect(document.body.innerHTML).not.toContain(NEW_PASSWORD);
  // Nothing is written into the page's styles: the policy would refuse it.
  expect(container.querySelectorAll("style, [style]")).toHaveLength(0);
  await expectNoAxe(container);
});

test("choosing_another_folder_asks_for_the_picker_and_a_closed_picker_stays_on_the_form", async () => {
  const { container } = start([]);
  await toTheForm();
  fill();
  click("Change");
  shell.dismissPickerNext();
  click("Create vault");
  await vi.waitFor(() => {
    expect(invoke).toHaveBeenCalledWith("create_vault", { name: "My vault", password: NEW_PASSWORD, choose_folder: true });
  });
  // Closing the picker is not an error: the form is as it was.
  await vi.waitFor(() => {
    expect(screen.getByLabelText<HTMLInputElement>("Password").value).toBe(NEW_PASSWORD);
  });
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByRole("heading", { level: 1, name: "Create your vault" })).toBeTruthy();
  expect(screen.getByText("You'll pick the folder when you press Create vault.")).toBeTruthy();
  await expectNoAxe(container);
});

test("key_shows_once_with_the_plain_warning", async () => {
  const { container } = start([]);
  await toTheKey();
  const key = shell.keyOf(1) ?? "";
  expect(key).not.toBe("");
  // The key is on the screen, as text and in no attribute, and not run together anywhere.
  for (const word of wordsOf(key)) expect(screen.getAllByText(word).length, word).toBeGreaterThan(0);
  expect(keyWordsInAttributes(key)).toEqual([]);
  expect(document.body.innerHTML).not.toContain(key);
  expect(screen.getByText("Step 2 of 2")).toBeTruthy();
  // The plain warnings, word for word.
  expect(screen.getByText("If you lose both your password and this key, nobody can get your data back.")).toBeTruthy();
  expect(screen.getByText(/Don't keep the saved key on this PC\./)).toBeTruthy();
  expect(screen.getByText(/Writing it down by hand is fine\./)).toBeTruthy();
  expect(screen.getByText(/Screenshots won't work/)).toBeTruthy();
  // Saving it as a PDF and printing are here; Help waits for a later task.
  expect(screen.getByRole("button", { name: "Print" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Save as PDF" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: /help/i })).toBeNull();
  // The vault is marked and the key was made once: asking for another is not how this screen works.
  expect(shell.unconfirmed(1)).toBe(true);
  expect(commandsSent()).not.toContain("regenerate_recovery");
  // The nine-point pattern.
  const nine = render(<Pattern points={9} />).container.querySelector("path")?.getAttribute("d");
  expect(container.querySelector(".rose path")?.getAttribute("d")).toBe(nine);
  await expectNoAxe(container);
});

test("key_shows_24_numbered_words_in_two_columns", async () => {
  const { container } = start([]);
  await toTheKey();
  const key = shell.keyOf(1) ?? "";
  const words = wordsOf(key);
  expect(words).toHaveLength(24);

  const box = container.querySelector(".fu-key");
  expect(box).not.toBeNull();
  // In the fixed-width face, as one block, so it can be copied by hand in order.
  expect(box?.classList.contains("m")).toBe(true);
  const columns = [...(box?.querySelectorAll("ol") ?? [])];
  expect(columns).toHaveLength(2);
  const read = (column: Element) =>
    [...column.querySelectorAll("li")].map((row) => ({
      number: row.querySelector(".fu-n")?.textContent,
      word: row.querySelector(".fu-w")?.textContent,
    }));
  const left = read(columns[0] as Element);
  const right = read(columns[1] as Element);
  // 1 to 12 down the first, 13 to 24 down the second, each beside its word.
  expect(left.map((row) => row.number)).toEqual(Array.from({ length: 12 }, (_, i) => String(i + 1)));
  expect(right.map((row) => row.number)).toEqual(Array.from({ length: 12 }, (_, i) => String(i + 13)));
  expect([...left, ...right].map((row) => row.word)).toEqual(words);
  // Nothing else on the block: the key is not also written out in one piece, nor in a title or a label.
  expect(box?.querySelectorAll("li")).toHaveLength(24);
  expect(keyWordsInAttributes(key)).toEqual([]);
  expect(document.body.innerHTML).not.toContain(key);
  expect(shell.keyOf(1)).toBe(key);
  await expectNoAxe(container);
});

test("key_heading_says_not_a_wallet_phrase", async () => {
  const { container } = start([]);
  // On the new vault's key (21c) ...
  await toTheKey();
  const headed = screen.getByRole("heading", { level: 2, name: "Lockbox recovery key, not a crypto wallet phrase" });
  // ... above the words it is about.
  expect(headed.compareDocumentPosition(document.querySelector(".fu-key") as Element) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  // The plain warnings are still there beside it.
  expect(screen.getByText("If you lose both your password and this key, nobody can get your data back.")).toBeTruthy();
  await expectNoAxe(container);
});

test("key_heading_is_also_on_the_new_key_of_an_unfinished_step", async () => {
  // ... and on 21f, the key made at the next unlock.
  start([{ id: 7, name: "My vault", items: [], unconfirmed: true }]);
  const field = await screen.findByLabelText(/^Password for /);
  fireEvent.change(field, { target: { value: PASSWORD } });
  fireEvent.submit((field as HTMLInputElement).form as HTMLFormElement);
  await screen.findByRole("heading", { level: 1, name: "Finish your recovery key" });
  expect(screen.getByRole("heading", { level: 2, name: "Lockbox recovery key, not a crypto wallet phrase" })).toBeTruthy();
  expect(document.querySelectorAll(".fu-key li")).toHaveLength(24);
});

test("key_hidden_while_picking", async () => {
  const { container } = start([]);
  await toTheKey();
  const key = shell.keyOf(1) ?? "";
  await toTheQuestions();
  expect(screen.queryByRole("heading", { level: 1, name: "Save your recovery key" })).toBeNull();
  expect(container.querySelector(".fu-key")).toBeNull();
  // No box to type in: words are only picked here.
  expect(container.querySelectorAll("input, textarea, select, [contenteditable]")).toHaveLength(0);
  expect(screen.queryAllByRole("textbox")).toHaveLength(0);

  // Of the key, only the four choices of the question now asked are on the page, and none is in an attribute.
  for (let n = 0; n < 3; n += 1) {
    const { choices } = asked();
    expect(keyWordsOnPage(key).sort()).toEqual(choices.map((choice) => choice.textContent).sort());
    expect(keyWordsInAttributes(key)).toEqual([]);
    expect(document.body.innerHTML).not.toContain(key);
    pick(key, true);
  }
  await screen.findByRole("heading", { level: 1, name: "All items" });
});

test("the_key_can_be_shown_again_from_the_questions", async () => {
  const { container } = start([]);
  await toTheKey();
  const key = shell.keyOf(1) ?? "";
  await toTheQuestions();
  pick(key, true);
  await expectNoAxe(container);
  // The same key, for someone who needs to look once more; the question starts again when they go on.
  click("Show the key again");
  expect(await screen.findByRole("heading", { level: 1, name: "Save your recovery key" })).toBeTruthy();
  for (const word of wordsOf(key)) expect(screen.getAllByText(word).length, word).toBeGreaterThan(0);
  expect(screen.queryByRole("alert")).toBeNull();
  expect(shell.keyOf(1)).toBe(key);
  expect(commandsSent()).not.toContain("regenerate_recovery");
  expect(commandsSent()).not.toContain("recovery_confirmed");
  await toTheQuestions();
  expect(screen.getByText("Question 1 of 3")).toBeTruthy();
});

test("three_different_numbers_asked", async () => {
  start([]);
  await toTheKey();
  const key = shell.keyOf(1) ?? "";
  const seen = new Set<number>();
  for (let round = 0; round < 6; round += 1) {
    await toTheQuestions();
    const numbers: number[] = [];
    for (let n = 0; n < 3; n += 1) {
      expect(screen.getByText(`Question ${String(n + 1)} of 3`)).toBeTruthy();
      numbers.push(asked().position);
      // The last one is picked wrong, to see the key again and ask for three new numbers.
      pick(key, n < 2);
    }
    expect(new Set(numbers).size, numbers.join()).toBe(3);
    for (const number of numbers) {
      expect(number).toBeGreaterThanOrEqual(1);
      expect(number).toBeLessThanOrEqual(24);
      seen.add(number);
    }
    await screen.findByRole("heading", { level: 1, name: "Save your recovery key" });
  }
  // Six rounds of three, all from a handful of places, would mean the pick is not random.
  expect(seen.size).toBeGreaterThan(5);
  expect(commandsSent()).not.toContain("recovery_confirmed");
});

test("choices_are_four_distinct_words_from_the_key", async () => {
  start([]);
  // A key that repeats words, so a choice could equal the right word or another choice.
  const repeating = `${Array.from({ length: 10 }, () => "ember").join(" ")} ${Array.from({ length: 6 }, () => "ivory").join(" ")} quartz marble copper velvet saddle anchor beacon cactus`;
  shell.nextKeyIs(repeating);
  await toTheKey();
  const key = shell.keyOf(1) ?? "";
  expect(key).toBe(repeating);
  const words = wordsOf(key);
  expect(words).toHaveLength(24);
  for (let round = 0; round < 8; round += 1) {
    await toTheQuestions();
    for (let n = 0; n < 3; n += 1) {
      const { position, choices } = asked();
      const shown = choices.map((choice) => choice.textContent);
      expect(shown, `number ${String(position)}`).toHaveLength(4);
      expect(new Set(shown).size, shown.join()).toBe(4);
      expect(shown.filter((word) => word === words[position - 1])).toHaveLength(1);
      for (const word of shown) expect(words).toContain(word);
      pick(key, n < 2);
    }
    await screen.findByRole("heading", { level: 1, name: "Save your recovery key" });
  }
});

test("wrong_pick_shows_the_key_and_starts_over", async () => {
  const { container } = start([]);
  await toTheKey();
  const key = shell.keyOf(1) ?? "";
  await toTheQuestions();
  pick(key, true);
  pick(key, false);
  // The key is back in full, on the first screen of the step, and it says why.
  expect(await screen.findByRole("heading", { level: 1, name: "Save your recovery key" })).toBeTruthy();
  for (const word of wordsOf(key)) expect(screen.getAllByText(word).length, word).toBeGreaterThan(0);
  const alert = screen.getByRole("alert");
  expect(alert.textContent).toContain("That wasn't the right word");
  for (const word of wordsOf(key)) expect(alert.textContent, word).not.toContain(word);
  expect(keyWordsInAttributes(key)).toEqual([]);
  // Nothing was sent, and the mark stays.
  expect(commandsSent()).not.toContain("recovery_confirmed");
  expect(commandsSent()).not.toContain("regenerate_recovery");
  expect(shell.unconfirmed(1)).toBe(true);
  expect(shell.keyOf(1)).toBe(key);
  await expectNoAxe(container);

  // Focus is not lost with the button that had it: it lands on the heading, so the next Tab starts at the key.
  expect(document.activeElement).toBe(screen.getByRole("heading", { level: 1, name: "Save your recovery key" }));

  // Start over: the first question again. That the three numbers are new each time is shown by
  // `three_different_numbers_asked`, which collects them over six rounds; this test only follows one.
  await toTheQuestions();
  expect(screen.getByText("Question 1 of 3")).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
  pickAllRight(key);
  await screen.findByRole("heading", { level: 1, name: "All items" });
  expect(commandsSent().filter((cmd) => cmd === "recovery_confirmed")).toHaveLength(1);
});

test("a_double_click_answers_one_question_only", async () => {
  start([]);
  await toTheKey();
  const key = shell.keyOf(1) ?? "";
  await toTheQuestions();
  // The second click of a double-click (detail 2, or 3 for a triple) lands on the next question's buttons, which sit in
  // the same places. It must not answer that question.
  const first = asked();
  const right = wordsOf(key)[first.position - 1];
  const rightButton = first.choices.find((choice) => choice.textContent === right) as HTMLButtonElement;
  fireEvent.click(rightButton, { detail: 1 });
  expect(screen.getByText("Question 2 of 3")).toBeTruthy();
  const second = asked();
  const wrongButton = second.choices.find((choice) => choice.textContent !== wordsOf(key)[second.position - 1]);
  fireEvent.click(wrongButton as HTMLButtonElement, { detail: 2 });
  fireEvent.click(second.choices[0] as HTMLButtonElement, { detail: 3 });
  expect(screen.getByText("Question 2 of 3")).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByRole("heading", { level: 1, name: "Save your recovery key" })).toBeNull();
  // A real click, or the keyboard (detail 0), still answers.
  pick(key, true);
  expect(screen.getByText("Question 3 of 3")).toBeTruthy();
});

test("three_right_picks_confirm", async () => {
  const { container } = start([]);
  await toTheKey();
  const key = shell.keyOf(1) ?? "";
  await toTheQuestions();
  const live = shell.sessionOf(1);
  // Two right picks are not enough, and nothing is sent yet.
  pick(key, true);
  pick(key, true);
  expect(commandsSent()).not.toContain("recovery_confirmed");
  expect(shell.unconfirmed(1)).toBe(true);
  expect(screen.getByText("Question 3 of 3")).toBeTruthy();
  await expectNoAxe(container);

  // The third: the mark is cleared, once, for this session, and then the vault.
  pick(key, true);
  await screen.findByRole("heading", { level: 1, name: "All items" });
  expect(commandsSent().filter((cmd) => cmd === "recovery_confirmed")).toHaveLength(1);
  expect(invoke).toHaveBeenCalledWith("recovery_confirmed", { session: live?.session, generation: live?.generation });
  expect(shell.unconfirmed(1)).toBe(false);
  // The key is gone from the page and the store for good.
  expect(keyWordsOnPage(key)).toEqual([]);
  expect(JSON.stringify(debugState())).not.toContain(wordsOf(key).slice(0, 3).join(" "));
  for (const word of wordsOf(key)) expect(JSON.stringify(debugState()), word).not.toContain(`"${word}"`);
});

test("a_refused_confirmation_is_said_and_the_last_pick_can_be_made_again", async () => {
  const { container } = start([]);
  await toTheKey();
  const key = shell.keyOf(1) ?? "";
  await toTheQuestions();
  pick(key, true);
  pick(key, true);
  const real = invoke.getMockImplementation();
  if (real === undefined) throw new Error("no fake shell");
  let refuse = true;
  invoke.mockImplementation((cmd: string, args?: unknown) => {
    if (cmd === "recovery_confirmed" && refuse) {
      refuse = false;
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- Tauri rejects with the plain object
      return Promise.reject({ code: "too_large", what: "vault state" });
    }
    return real(cmd, args) as Promise<unknown>;
  });
  pick(key, true);
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("Try again.");
  expect(screen.getByText("Question 3 of 3")).toBeTruthy();
  expect(shell.unconfirmed(1)).toBe(true);
  await expectNoAxe(container);
  pick(key, true);
  await screen.findByRole("heading", { level: 1, name: "All items" });
  expect(shell.unconfirmed(1)).toBe(false);
});

test("any_lock_wipes_the_key", async () => {
  start([]);
  await toTheKey();
  const first = shell.keyOf(1) ?? "";
  expect(keyWordsOnPage(first)).toEqual([...new Set(wordsOf(first))]);
  const live = shell.sessionOf(1);
  act(() => {
    shell.lock(live?.session ?? 0);
  });
  // The lock screen of the new vault; the key is nowhere, on the page or in the store.
  expect(await screen.findByRole("heading", { level: 1, name: "Unlock My vault" })).toBeTruthy();
  expect(keyWordsOnPage(first)).toEqual([]);
  expect(debugState().sessions).toEqual([]);
  for (const word of wordsOf(first)) expect(JSON.stringify(debugState()), word).not.toContain(word);

  // The next unlock finds the mark still there and makes a new key, so the vault is never left without one.
  typeInto(/^Password for /, NEW_PASSWORD);
  fireEvent.submit(screen.getByLabelText<HTMLInputElement>(/^Password for /).form as HTMLFormElement);
  expect(await screen.findByRole("heading", { level: 1, name: "Finish your recovery key" })).toBeTruthy();
  const second = shell.keyOf(1) ?? "";
  expect(second).not.toBe(first);
  expect(keyWordsOnPage(second)).toEqual([...new Set(wordsOf(second))]);
  // Of the old key, only the words the new one shares are on the page.
  const shared = new Set(wordsOf(second));
  expect(keyWordsOnPage(first).filter((word) => !shared.has(word))).toEqual([]);

  // A lock while picking wipes the questions, the choices and the key, too.
  await toTheQuestions();
  pick(second, true);
  const { choices } = asked();
  expect(choices).toHaveLength(4);
  act(() => {
    shell.lock(shell.sessionOf(1)?.session ?? 0);
  });
  await screen.findByRole("heading", { level: 1, name: "Unlock My vault" });
  expect(keyWordsOnPage(second)).toEqual([]);
  for (const word of wordsOf(second)) expect(JSON.stringify(debugState()), word).not.toContain(word);
  expect(debugState().sessions).toEqual([]);
  expect(shell.unconfirmed(1)).toBe(true);
});

test("idle_timer_not_paused_here", async () => {
  start([]);
  await toTheKey();
  // This screen sends nothing that would hold the idle timer back, and an idle lock takes the key away like any other.
  // (`launch_notices` is the page's one question at start, asked of the shell with no vault; it holds nothing back either, and neither does
  // `capture_state`, which asks what the save shortcut left waiting.)
  const allowed = new Set(["list_vaults", "launch_notices", "capture_state", "create_vault", "list_items", "get_settings"]);
  const sent = commandsSent().filter((cmd) => !cmd.startsWith("listen:"));
  expect(sent.filter((cmd) => !allowed.has(cmd))).toEqual([]);
  expect(sent.join()).not.toMatch(/idle|pause|hold|keep/);
  const key = shell.keyOf(1) ?? "";
  act(() => {
    shell.lock(shell.sessionOf(1)?.session ?? 0, "idle");
  });
  await screen.findByRole("heading", { level: 1, name: "Unlock My vault" });
  expect(document.body.innerHTML).not.toContain(key);
  expect(commandsSent().join()).not.toMatch(/idle|pause|hold|keep/);
});

test("new_key_screen_shows_on_unconfirmed_unlock", async () => {
  const { container } = start([{ id: 7, name: "My vault", items: [], unconfirmed: true }]);
  const field = await screen.findByLabelText(/^Password for /);
  fireEvent.change(field, { target: { value: PASSWORD } });
  fireEvent.submit((field as HTMLInputElement).form as HTMLFormElement);

  // Straight to the new key: never the list in between.
  expect(await screen.findByRole("heading", { level: 1, name: "Finish your recovery key" })).toBeTruthy();
  expect(screen.queryByRole("heading", { level: 1, name: "All items" })).toBeNull();
  expect(
    screen.getByText(
      "Last time this step didn't finish, so that key may not have been saved. This is a new one, and the old one no longer works.",
    ),
  ).toBeTruthy();
  const key = shell.keyOf(7) ?? "";
  expect(keyWordsOnPage(key)).toEqual([...new Set(wordsOf(key))]);
  // The new key is asked for with the session and nothing else: no password on this path.
  const live = shell.sessionOf(7);
  expect(invoke).toHaveBeenCalledWith("regenerate_recovery", { session: live?.session, generation: live?.generation });
  const order = commandsSent().filter((cmd) => cmd === "unlock_vault" || cmd === "regenerate_recovery");
  expect(order).toEqual(["unlock_vault", "regenerate_recovery"]);
  await expectNoAxe(container);

  // Shown, picked back, confirmed: then the vault.
  await toTheQuestions();
  pickAllRight(key);
  expect(await screen.findByRole("heading", { level: 1, name: "All items" })).toBeTruthy();
  expect(invoke).toHaveBeenCalledWith("recovery_confirmed", { session: live?.session, generation: live?.generation });
  expect(shell.unconfirmed(7)).toBe(false);
});

test("a_read_only_copy_with_the_mark_never_asks_for_a_new_key", async () => {
  const { container } = start([{ id: 7, name: "My vault", items: [], unconfirmed: true, readOnly: true }]);
  const field = await screen.findByLabelText(/^Password for /);
  fireEvent.change(field, { target: { value: PASSWORD } });
  fireEvent.submit((field as HTMLInputElement).form as HTMLFormElement);
  expect(await screen.findByRole("heading", { level: 1, name: "All items" })).toBeTruthy();
  expect(commandsSent()).not.toContain("regenerate_recovery");
  await expectNoAxe(container);
});

test("a_new_key_that_could_not_be_made_says_so_and_can_be_asked_again", async () => {
  const { container } = start([{ id: 7, name: "My vault", items: [], unconfirmed: true }]);
  shell.refuseMarkNext();
  const field = await screen.findByLabelText(/^Password for /);
  fireEvent.change(field, { target: { value: PASSWORD } });
  fireEvent.submit((field as HTMLInputElement).form as HTMLFormElement);
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toBe("Lockbox couldn't save a note it needs before making the key, so it made none. Try again.");
  expect(screen.getByRole("heading", { level: 1, name: "Finish your recovery key" })).toBeTruthy();
  expect(container.textContent).not.toContain("vault state");
  expect(screen.queryByRole("heading", { level: 1, name: "All items" })).toBeNull();
  await expectNoAxe(container);

  click("Try again");
  const key = await vi.waitFor(() => {
    const made = shell.keyOf(7);
    if (made === undefined) throw new Error("no key yet");
    return made;
  });
  expect(await screen.findByText(wordsOf(key)[0] ?? "")).toBeTruthy();
  expect(keyWordsOnPage(key)).toEqual([...new Set(wordsOf(key))]);
  expect(screen.queryByRole("alert")).toBeNull();
});

test("a_vault_that_could_not_be_marked_is_not_made", async () => {
  const { container } = start([]);
  await toTheForm();
  shell.refuseMarkNext();
  fill();
  click("Create vault");
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toBe("Lockbox couldn't save a note it needs before making the key, so it made none. Try again.");
  expect(screen.getByRole("heading", { level: 1, name: "Create your vault" })).toBeTruthy();
  expect(shell.keyOf(1)).toBeUndefined();
  await expectNoAxe(container);
  // Again, and it goes through.
  click("Create vault");
  expect(await screen.findByRole("heading", { level: 1, name: "Save your recovery key" })).toBeTruthy();
});

test("ready_screen_says_what_to_do_first", async () => {
  const { container } = start([]);
  await toTheKey();
  const key = shell.keyOf(1) ?? "";
  await toTheQuestions();
  pickAllRight(key);
  await screen.findByRole("heading", { level: 1, name: "All items" });
  const main = screen.getByRole("main");
  expect(within(main).getByText("Your vault is empty")).toBeTruthy();
  expect(within(main).getByText("What to do first: add a login, or a key, a note or a file.")).toBeTruthy();
  // The key is gone from the page for good. Add is in the toolbar (Task 11) and right there in the empty vault (Task 12), with
  // the three kinds that can be made; nothing else from a later task is offered.
  expect(keyWordsOnPage(key)).toEqual([]);
  expect(screen.getByRole("button", { name: "Add" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: /^(File|Help|Paste)/ })).toBeNull();
  const list = main.querySelector<HTMLElement>(".lscroll");
  expect(list).not.toBeNull();
  expect(within(list as HTMLElement).getAllByRole("button").map((button) => button.textContent)).toEqual(["Login", "Key", "Note"]);
  await expectNoAxe(container);
});

test("cloud_folder_asks_before_creating", async () => {
  const { container } = start([]);
  await toTheForm();
  fill();
  shell.cloudNext();
  click("Create vault");
  // The question, and nothing made: no key, no vault, no mark.
  expect(await screen.findByRole("heading", { level: 1, name: "This folder is synced to the cloud" })).toBeTruthy();
  expect(screen.getByText(/Lockbox doesn't support vaults in cloud folders/)).toBeTruthy();
  expect(commandsSent()).not.toContain("create_vault_confirm");
  expect(shell.keyOf(1)).toBeUndefined();
  expect(shell.unconfirmed(1)).toBe(false);
  expect(screen.queryByRole("heading", { name: "Save your recovery key" })).toBeNull();
  await expectNoAxe(container);

  // No: back to the form, as it was, and the question is dropped without being answered.
  click("Cancel");
  expect(await screen.findByRole("heading", { level: 1, name: "Create your vault" })).toBeTruthy();
  expect(screen.getByLabelText<HTMLInputElement>("Vault name").value).toBe("My vault");
  expect(commandsSent()).not.toContain("create_vault_confirm");

  // Yes: the token it was given comes back, and the key follows.
  shell.cloudNext();
  click("Create vault");
  await screen.findByRole("heading", { level: 1, name: "This folder is synced to the cloud" });
  click("Continue anyway");
  expect(await screen.findByRole("heading", { level: 1, name: "Save your recovery key" })).toBeTruthy();
  const sent = shell.calls.filter((call) => call.cmd === "create_vault_confirm");
  expect(sent).toHaveLength(1);
  expect(sent[0]?.args).toEqual({ token: expect.stringMatching(/^create-token-/) as unknown });
});

test("cloud_folder_choose_another_asks_for_the_picker", async () => {
  start([]);
  await toTheForm();
  fill();
  shell.cloudNext();
  click("Create vault");
  await screen.findByRole("heading", { level: 1, name: "This folder is synced to the cloud" });
  click("Choose another");
  await screen.findByRole("heading", { level: 1, name: "Save your recovery key" });
  expect(shell.calls.filter((call) => call.cmd === "create_vault").map((call) => call.args)).toEqual([
    { name: "My vault", password: NEW_PASSWORD, choose_folder: false },
    { name: "My vault", password: NEW_PASSWORD, choose_folder: true },
  ]);
});

test("an_existing_vault_in_a_cloud_folder_asks_too", async () => {
  const { container } = start([]);
  shell.offerExisting({ id: 40, name: "Old vault", items: [] });
  shell.cloudNext();
  await screen.findByRole("heading", { level: 1, name: "Welcome to Lockbox" });
  click("I already have a vault");
  expect(await screen.findByRole("heading", { level: 1, name: "This folder is synced to the cloud" })).toBeTruthy();
  await expectNoAxe(container);
  click("Continue anyway");
  expect(await screen.findByRole("heading", { level: 1, name: "Unlock Old vault" })).toBeTruthy();
  expect(commandsSent()).toContain("add_existing_vault_confirm");
});

test("a_lock_that_ended_the_create_shows_no_error_on_the_form", async () => {
  // The picker was open and Windows locked: the shell answers `locked`, and no vault was made.
  const { container } = start([]);
  await toTheForm();
  fill();
  const real = invoke.getMockImplementation();
  if (real === undefined) throw new Error("no fake shell");
  invoke.mockImplementation((cmd: string, args?: unknown) =>
    cmd === "create_vault"
      ? // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- Tauri rejects with the plain object
        Promise.reject({ code: "locked" })
      : (real(cmd, args) as Promise<unknown>),
  );
  click("Create vault");
  await vi.waitFor(() => {
    expect(invoke).toHaveBeenCalledWith("create_vault", expect.anything());
  });
  await act(async () => {
    await Promise.resolve();
  });
  expect(screen.queryByRole("alert")).toBeNull();
  expect(container.textContent).not.toContain("This vault is locked");
  expect(screen.getByRole("heading", { level: 1, name: "Create your vault" })).toBeTruthy();
  // The form is as it was, and Create vault works again.
  expect(screen.getByLabelText<HTMLInputElement>("Password").value).toBe(NEW_PASSWORD);
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Create vault" }).disabled).toBe(false);
});

test("a_lock_before_the_create_answer_shows_no_error_and_no_key", async () => {
  start([]);
  await toTheForm();
  fill();
  const real = invoke.getMockImplementation();
  if (real === undefined) throw new Error("no fake shell");
  let answerNow: () => void = () => undefined;
  invoke.mockImplementation((cmd: string, args?: unknown) =>
    cmd === "create_vault"
      ? new Promise((resolve) => {
          answerNow = () => {
            resolve({
              Done: {
                session: 4242,
                generation: 1,
                data: {
                  info: { session: 4242, generation: 1, name: "My vault", read_only: false, state: "unlocked" },
                  recovery_key: "SENTINEL-KEY",
                },
              },
            });
          };
        })
      : (real(cmd, args) as Promise<unknown>),
  );
  click("Create vault");
  const handler = (listen.mock.calls[0] as [string, (event: { payload: unknown }) => void])[1];
  act(() => {
    handler({ payload: { session: 4242, generation: 2, reason: "windows_locked" } });
  });
  await act(async () => {
    answerNow();
    await Promise.resolve();
  });
  expect(document.body.innerHTML).not.toContain("SENTINEL-KEY");
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByRole("heading", { name: "Save your recovery key" })).toBeNull();
});

// ---- Print and Save as PDF (Task 7) ----

const CLOUD_TITLE = "This folder is synced to the cloud";
const CLOUD_TEXT = "This file would be uploaded unprotected.";

const PICKER_NAME = "Choose a printer";
const NO_PRINTER = "No printer is set up on this PC. Save as PDF instead, or add a printer in Windows' settings.";

/** The two buttons under the key. The picker's own Print comes after the first one in the page, so the first is the key's. */
function printButtons(): { print: HTMLButtonElement; pdf: HTMLButtonElement } {
  return {
    print: screen.getAllByRole<HTMLButtonElement>("button", { name: "Print" })[0] as HTMLButtonElement,
    pdf: screen.getByRole<HTMLButtonElement>("button", { name: "Save as PDF" }),
  };
}

/** What is in the printer picker, once it is open with printers in it. */
function pickerParts(): { group: HTMLElement; select: HTMLElement; send: HTMLButtonElement; cancel: HTMLButtonElement } {
  const group = screen.getByRole("group", { name: PICKER_NAME });
  return {
    group,
    // The Select part's box: it shows the printer chosen, and its list opens from it.
    select: within(group).getByRole("combobox", { name: "Printer" }),
    send: within(group).getByRole<HTMLButtonElement>("button", { name: "Print" }),
    cancel: within(group).getByRole<HTMLButtonElement>("button", { name: "Cancel" }),
  };
}

/** Picks a printer from the Select part's list, by clicking its box and then the option; waits until the list is closed. */
async function choosePrinter(select: HTMLElement, name: string): Promise<void> {
  fireEvent.pointerDown(select, { button: 0 });
  fireEvent.click(select);
  const option = await screen.findByRole("option", { name });
  fireEvent.pointerDown(option);
  fireEvent.click(option);
  await vi.waitFor(() => {
    expect(select.textContent).toBe(name);
  });
  await vi.waitFor(() => {
    expect(screen.queryByRole("listbox")).toBeNull();
  });
}

/** The printers the Select part's list offers, read by opening it with the arrow key and closing it with Escape. */
async function listedPrinters(select: HTMLElement): Promise<string[]> {
  select.focus();
  fireEvent.keyDown(select, { key: "ArrowDown" });
  const list = await screen.findByRole("listbox");
  const names = within(list).getAllByRole("option").map((option) => option.textContent);
  fireEvent.keyDown(list, { key: "Escape" });  await vi.waitFor(() => {
    expect(screen.queryByRole("listbox")).toBeNull();
  });
  await vi.waitFor(() => {
    expect(document.activeElement).toBe(select);
  });
  return names;
}

/** Presses the key's Print, with focus on it as a person does, and waits for the picker to open with its printers. */
async function openPicker() {
  const { print } = printButtons();
  print.focus();
  fireEvent.click(print);
  await screen.findByRole("group", { name: PICKER_NAME });
  await vi.waitFor(() => {
    expect(pickerParts().select).toBeTruthy();
  });
  return pickerParts();
}

/** Opens the picker, presses its Print, and waits for the shell to have the job. */
async function printViaPicker() {
  const parts = await openPicker();
  fireEvent.click(parts.send);
  await vi.waitFor(() => {
    expect(commandsSent()).toContain("print_recovery_key");
  });
  return parts;
}

/** The print commands that reached the shell (a cloud question's yes included). */
function printCommands(): string[] {
  return commandsSent().filter((cmd) => ["save_recovery_pdf", "save_readable_confirm", "print_recovery_key"].includes(cmd));
}

/** From the lock screen of a vault with an unfinished key step to its new key (21f). */
async function toTheUnfinishedKey() {
  const started = start([{ id: 7, name: "My vault", items: [], unconfirmed: true }]);
  const field = await screen.findByLabelText(/^Password for /);
  fireEvent.change(field, { target: { value: PASSWORD } });
  fireEvent.submit((field as HTMLInputElement).form as HTMLFormElement);
  await screen.findByRole("heading", { level: 1, name: "Finish your recovery key" });
  return started;
}

/** Presses Save as PDF with focus on it, as a person does, and waits for the shell to have it. */
async function pressSavePdf(): Promise<HTMLButtonElement> {
  const { pdf } = printButtons();
  pdf.focus();
  fireEvent.click(pdf);
  await vi.waitFor(() => {
    expect(commandsSent()).toContain("save_recovery_pdf");
  });
  return pdf;
}

/** What the key screen's status line says now (it is on the page, empty, until a save says where). */
function statusText(): string {
  return screen.queryByRole("status")?.textContent ?? "";
}

/** Lets what is waiting on the shell's answers finish. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

test("both_buttons_on_21c_sit_under_the_key_and_pass_axe", async () => {
  const { container } = start([]);
  await toTheKey();
  const key = shell.keyOf(1) ?? "";
  const { print, pdf } = printButtons();
  // Under the words, before the plain warning, Print first.
  const box = container.querySelector(".fu-key") as Element;
  const warning = screen.getByText("If you lose both your password and this key, nobody can get your data back.");
  for (const button of [print, pdf]) {
    expect(box.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(button.compareDocumentPosition(warning) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(button.getAttribute("type")).toBe("button");
    expect(button.getAttribute("aria-disabled")).toBeNull();
  }
  expect(print.compareDocumentPosition(pdf) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  // Nothing has been sent, and no secret is in a name, a title or a label.
  expect(printCommands()).toEqual([]);
  expect(keyWordsInAttributes(key)).toEqual([]);
  await expectNoAxe(container);
});

test("both_buttons_on_21f_too", async () => {
  const { container } = await toTheUnfinishedKey();
  const { print, pdf } = printButtons();
  expect(print.textContent).toBe("Print");
  expect(pdf.textContent).toBe("Save as PDF");
  await pressSavePdf();
  expect(await screen.findByText(`Saved in ${SAVED_FOLDER}.`)).toBeTruthy();
  expect(shell.pdfs).toEqual([SAVED_FOLDER]);
  await printViaPicker();
  expect(await screen.findByText("Sent to Hall Inkjet.")).toBeTruthy();
  expect(keyWordsInAttributes(shell.keyOf(7) ?? "")).toEqual([]);
  await expectNoAxe(container);
});

test("save_as_pdf_disabled_while_running", async () => {
  start([]);
  await toTheKey();
  const release = shell.holdPrint();
  const pdf = await pressSavePdf();
  const { print } = printButtons();
  // Both are off while it runs, and the one that is working says so to a screen reader. Focus stays where it was.
  await vi.waitFor(() => {
    expect(pdf.getAttribute("aria-busy")).toBe("true");
  });
  expect(pdf.getAttribute("aria-disabled")).toBe("true");
  expect(print.getAttribute("aria-disabled")).toBe("true");
  expect(print.getAttribute("aria-busy")).toBeNull();
  expect(document.activeElement).toBe(pdf);
  // Pressing either again sends nothing: one print at a time.
  fireEvent.click(pdf);
  fireEvent.click(print);
  expect(printCommands()).toEqual(["save_recovery_pdf"]);

  await act(async () => {
    release();
    await Promise.resolve();
  });
  expect(await screen.findByText(`Saved in ${SAVED_FOLDER}.`)).toBeTruthy();
  for (const button of [pdf, print]) {
    expect(button.getAttribute("aria-disabled")).toBeNull();
    expect(button.getAttribute("aria-busy")).toBeNull();
  }
  expect(document.activeElement).toBe(pdf);

  // A print from the picker holds both the same way.
  const { send } = await openPicker();
  const again = shell.holdPrint();
  fireEvent.click(send);
  await vi.waitFor(() => {
    expect(send.getAttribute("aria-busy")).toBe("true");
  });
  expect(pdf.getAttribute("aria-disabled")).toBe("true");
  expect(print.getAttribute("aria-disabled")).toBe("true");
  fireEvent.click(pdf);
  expect(printCommands()).toEqual(["save_recovery_pdf", "print_recovery_key"]);
  await act(async () => {
    again();
    await Promise.resolve();
  });
  await vi.waitFor(() => {
    expect(print.getAttribute("aria-busy")).toBeNull();
  });
  expect(pdf.getAttribute("aria-disabled")).toBeNull();
});

test("continue_waits_while_the_page_is_being_printed", async () => {
  // The page is what gets printed: going on to the questions would take the key off it before it is captured.
  for (const button of ["Save as PDF", "Print"]) {
    resetStoreForTests();
    invoke.mockReset();
    listen.mockReset();
    cleanup();
    start([]);
    await toTheKey();
    const key = shell.keyOf(1) ?? "";
    // Print is pressed in the picker, where the job is sent from.
    const pressed = button === "Print" ? (await openPicker()).send : screen.getByRole<HTMLButtonElement>("button", { name: button });
    const release = shell.holdPrint();
    pressed.focus();
    fireEvent.click(pressed);
    await vi.waitFor(() => {
      expect(pressed.getAttribute("aria-busy")).toBe("true");
    });
    const next = screen.getByRole<HTMLButtonElement>("button", { name: "Continue" });
    expect(next.getAttribute("aria-disabled"), button).toBe("true");
    next.focus();
    fireEvent.click(next);
    await settle();
    // Still the key, still marked for printing, no questions.
    expect(screen.queryByRole("heading", { level: 1, name: PICK_HEADING }), button).toBeNull();
    expect(document.querySelectorAll("[data-print-only] .fu-key li"), button).toHaveLength(24);
    expect(keyWordsOnPage(key), button).toEqual([...new Set(wordsOf(key))]);
    expect(document.activeElement, button).toBe(next);

    await act(async () => {
      release();
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(next.getAttribute("aria-disabled"), button).toBeNull();
    });
    fireEvent.click(next);
    expect(await screen.findByRole("heading", { level: 1, name: PICK_HEADING })).toBeTruthy();
  }
});

test("saved_says_the_folder", async () => {
  const { container } = start([]);
  await toTheKey();
  expect(statusText()).toBe("");
  await pressSavePdf();
  const line = await screen.findByText(`Saved in ${SAVED_FOLDER}.`);
  expect(line.getAttribute("role")).toBe("status");
  expect(screen.queryByRole("alert")).toBeNull();
  expect(shell.pdfs).toEqual([SAVED_FOLDER]);
  // The key's step goes on as it was: it is neither confirmed nor changed by saving.
  expect(shell.unconfirmed(1)).toBe(true);
  expect(screen.getByRole("heading", { level: 1, name: "Save your recovery key" })).toBeTruthy();
  // The line is under the buttons and goes away when another try starts.
  const { pdf } = printButtons();
  expect(pdf.compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  const release = shell.holdPrint();
  fireEvent.click(pdf);
  await vi.waitFor(() => {
    expect(screen.queryByText(`Saved in ${SAVED_FOLDER}.`)).toBeNull();
  });
  await act(async () => {
    release();
    await Promise.resolve();
  });
  await screen.findByText(`Saved in ${SAVED_FOLDER}.`);
  await expectNoAxe(container);
});

test("dismissed_says_nothing", async () => {
  start([]);
  await toTheKey();
  shell.dismissPdfNext();
  const pdf = await pressSavePdf();
  await settle();
  expect(statusText()).toBe("");
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.queryByText(/Saved in/)).toBeNull();
  expect(shell.pdfs).toEqual([]);
  // Both buttons work again.
  expect(pdf.getAttribute("aria-disabled")).toBeNull();
  expect(printButtons().print.getAttribute("aria-disabled")).toBeNull();
});

test("cloud_warning_shows_21e_words", async () => {
  const { container } = start([]);
  await toTheKey();
  const key = shell.keyOf(1) ?? "";
  shell.cloudPdfNext();
  const pdf = await pressSavePdf();
  const dialog = await screen.findByRole("dialog", { name: CLOUD_TITLE });
  expect(within(dialog).getByText(CLOUD_TEXT)).toBeTruthy();
  expect(within(dialog).getByRole("button", { name: "Continue" })).toBeTruthy();
  expect(within(dialog).getByRole("button", { name: "Pick another folder" })).toBeTruthy();
  // Nothing is written until the person says yes, and the token is in no attribute.
  expect(shell.pdfs).toEqual([]);
  expect(document.body.innerHTML).not.toContain("pdf-token");
  expect(keyWordsInAttributes(key)).toEqual([]);
  // Focus is inside, on the answer that writes nothing, and not on Continue.
  await vi.waitFor(() => {
    expect(dialog.contains(document.activeElement)).toBe(true);
  });
  expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Pick another folder" }));
  await expectNoAxe(container);

  // Escape cancels: nothing written, nothing said, and focus is back on Save as PDF.
  fireEvent.keyDown(dialog, { key: "Escape" });
  await vi.waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(shell.pdfs).toEqual([]);
  expect(printCommands()).toEqual(["save_recovery_pdf"]);
  expect(statusText()).toBe("");
  expect(screen.queryByRole("alert")).toBeNull();
  await vi.waitFor(() => {
    expect(document.activeElement).toBe(pdf);
  });
  expect(pdf.getAttribute("aria-disabled")).toBeNull();
});

test("cloud_continue_saves_with_the_token", async () => {
  start([]);
  await toTheKey();
  shell.cloudPdfNext();
  const pdf = await pressSavePdf();
  const dialog = await screen.findByRole("dialog", { name: CLOUD_TITLE });
  fireEvent.click(within(dialog).getByRole("button", { name: "Continue" }));
  expect(await screen.findByText(`Saved in ${SAVED_FOLDER}.`)).toBeTruthy();
  // The yes went back with the token the shell gave, and with nothing else.
  const confirm = shell.calls.find((call) => call.cmd === "save_readable_confirm");
  expect(confirm?.args).toEqual({ token: "pdf-token-1" });
  expect(shell.pdfs).toEqual([SAVED_FOLDER]);
  expect(screen.queryByRole("dialog")).toBeNull();
  await vi.waitFor(() => {
    expect(document.activeElement).toBe(pdf);
  });
  expect(screen.queryByRole("alert")).toBeNull();
});

test("cloud_pick_another_folder_opens_the_dialog_again", async () => {
  start([]);
  await toTheKey();
  // The first folder is a cloud one, and so is the second.
  shell.cloudPdfNext();
  shell.cloudPdfNext();
  await pressSavePdf();
  const first = await screen.findByRole("dialog", { name: CLOUD_TITLE });
  fireEvent.click(within(first).getByRole("button", { name: "Pick another folder" }));
  await vi.waitFor(() => {
    expect(commandsSent().filter((cmd) => cmd === "save_recovery_pdf")).toHaveLength(2);
  });
  // The picker came again (Save as PDF was sent again), nothing was confirmed or written, and the question is asked anew.
  const second = await screen.findByRole("dialog", { name: CLOUD_TITLE });
  expect(commandsSent()).not.toContain("save_readable_confirm");
  expect(shell.pdfs).toEqual([]);
  // Its yes uses the new token, not the old one.
  fireEvent.click(within(second).getByRole("button", { name: "Continue" }));
  expect(await screen.findByText(`Saved in ${SAVED_FOLDER}.`)).toBeTruthy();
  expect(shell.calls.filter((call) => call.cmd === "save_readable_confirm").map((call) => call.args)).toEqual([
    { token: "pdf-token-2" },
  ]);

  // A picker that is closed the second time ends it quietly: nothing written.
  shell.cloudPdfNext();
  shell.pdfs.length = 0;
  await settle();
  fireEvent.click(printButtons().pdf);
  const third = await screen.findByRole("dialog", { name: CLOUD_TITLE });
  shell.dismissPdfNext();
  fireEvent.click(within(third).getByRole("button", { name: "Pick another folder" }));
  await settle();
  await vi.waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(shell.pdfs).toEqual([]);
});

test("print_calls_print_recovery_key", async () => {
  start([]);
  await toTheKey();
  await printViaPicker();
  await settle();
  const sent = shell.calls.find((call) => call.cmd === "print_recovery_key");
  const live = shell.sessionOf(1);
  // The vault's session, its generation and the printer's name: nothing else goes with it.
  expect(sent?.args).toEqual({ session: live?.session, generation: live?.generation, printer: DEFAULT_PRINTER });
  expect(printCommands()).toEqual(["print_recovery_key"]);
  expect(shell.pdfs).toEqual([]);
  expect(screen.queryByRole("alert")).toBeNull();
});

test("print_opens_the_picker_with_the_default_picked", async () => {
  const { container } = start([]);
  await toTheKey();
  const key = shell.keyOf(1) ?? "";
  const { print, pdf } = printButtons();
  expect(screen.queryByRole("group", { name: PICKER_NAME })).toBeNull();
  expect(print.getAttribute("aria-expanded")).toBe("false");

  const { group, select, send, cancel } = await openPicker();
  // Print asked Windows for the printers, and nothing was printed.
  expect(shell.calls.filter((call) => call.cmd === "list_printers").map((call) => call.args)).toEqual([{}]);
  expect(printCommands()).toEqual([]);
  // The key's two buttons are still above it, and the picker is under them, still inside the part that never prints.
  expect(pdf.compareDocumentPosition(group) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(group.closest("[data-print-hide]")).not.toBeNull();
  expect(group.closest("[data-print-only]")).not.toBeNull();
  expect(print.getAttribute("aria-expanded")).toBe("true");
  // "Printer": the printers by name, the default picked, and focus on it.
  expect(select.textContent).toBe(DEFAULT_PRINTER);
  expect(document.activeElement).toBe(select);
  expect(await listedPrinters(select)).toEqual(PRINTERS);
  expect(send.textContent).toBe("Print");
  expect(cancel.textContent).toBe("Cancel");
  expect(send.getAttribute("aria-disabled")).toBeNull();
  // Pressing Print again does not ask again: focus goes back to the list.
  cancel.focus();
  fireEvent.click(print);
  expect(shell.calls.filter((call) => call.cmd === "list_printers")).toHaveLength(1);
  expect(document.activeElement).toBe(select);
  expect(keyWordsInAttributes(key)).toEqual([]);
  await expectNoAxe(container);

  // With no default, the first printer is picked; a default that is not on the list is no default.
  cancel.focus();
  fireEvent.click(cancel);
  shell.setPrinters(["Back Office", "Front Desk"], null);
  const again = await openPicker();
  expect(again.select.textContent).toBe("Back Office");
  expect(await listedPrinters(again.select)).toEqual(["Back Office", "Front Desk"]);
});

test("picker_print_sends_the_chosen_printer", async () => {
  start([]);
  await toTheKey();
  // The one chosen is neither the first on the list nor the default.
  shell.setPrinters(["Back Office", "Front Desk", "Side Room"], "Front Desk");
  const { select, send } = await openPicker();
  expect(select.textContent).toBe("Front Desk");
  await choosePrinter(select, "Side Room");
  fireEvent.click(send);
  await vi.waitFor(() => {
    expect(commandsSent()).toContain("print_recovery_key");
  });
  const live = shell.sessionOf(1);
  expect(shell.calls.find((call) => call.cmd === "print_recovery_key")?.args).toEqual({
    session: live?.session,
    generation: live?.generation,
    printer: "Side Room",
  });
  await vi.waitFor(() => {
    expect(shell.printed).toEqual(["Side Room"]);
  });
  expect(printCommands()).toEqual(["print_recovery_key"]);
});

test("sent_says_the_printer", async () => {
  const { container } = start([]);
  await toTheKey();
  expect(statusText()).toBe("");
  const parts = await openPicker();
  await choosePrinter(parts.select, "Office Laser");
  fireEvent.click(parts.send);
  const line = await screen.findByText("Sent to Office Laser.");
  expect(line.getAttribute("role")).toBe("status");
  // The picker is closed, nothing is said but that, and focus is back on the key's Print button.
  await vi.waitFor(() => {
    expect(screen.queryByRole("group", { name: PICKER_NAME })).toBeNull();
  });
  const { print, pdf } = printButtons();
  expect(document.activeElement).toBe(print);
  expect(print.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByRole("alert")).toBeNull();
  expect(print.getAttribute("aria-disabled")).toBeNull();
  expect(pdf.getAttribute("aria-disabled")).toBeNull();
  expect(shell.pdfs).toEqual([]);
  await expectNoAxe(container);
  // The next try takes the line away until it has an answer of its own.
  const release = shell.holdPrint();
  const next = await openPicker();
  expect(statusText()).toBe("");
  fireEvent.click(next.send);
  await settle();
  await act(async () => {
    release();
    await Promise.resolve();
  });
  expect(await screen.findByText("Sent to Hall Inkjet.")).toBeTruthy();
  expect(screen.queryByText("Sent to Office Laser.")).toBeNull();
});

test("no_printer_says_so_with_only_cancel", async () => {
  const { container } = start([]);
  await toTheKey();
  shell.setPrinters([], null);
  const { print } = printButtons();
  print.focus();
  fireEvent.click(print);
  const group = await screen.findByRole("group", { name: PICKER_NAME });
  expect(within(group).getByText(NO_PRINTER)).toBeTruthy();
  expect(within(group).queryByLabelText("Printer")).toBeNull();
  expect(within(group).queryByRole("combobox")).toBeNull();
  // Only Cancel: there is nothing to print to.
  expect(within(group).getAllByRole("button").map((button) => button.textContent)).toEqual(["Cancel"]);
  const cancel = within(group).getByRole<HTMLButtonElement>("button", { name: "Cancel" });
  await vi.waitFor(() => {
    expect(document.activeElement).toBe(cancel);
  });
  expect(printCommands()).toEqual([]);
  await expectNoAxe(container);

  fireEvent.click(cancel);
  expect(screen.queryByRole("group", { name: PICKER_NAME })).toBeNull();
  expect(document.activeElement).toBe(print);
  expect(screen.queryByText(NO_PRINTER)).toBeNull();
});

test("cancel_closes_the_picker_and_returns_focus", async () => {
  start([]);
  await toTheKey();
  const { cancel } = await openPicker();
  cancel.focus();
  fireEvent.click(cancel);
  expect(screen.queryByRole("group", { name: PICKER_NAME })).toBeNull();
  const { print } = printButtons();
  expect(document.activeElement).toBe(print);
  expect(print.getAttribute("aria-expanded")).toBe("false");
  // Nothing was printed, nothing is said, and it opens again.
  expect(printCommands()).toEqual([]);
  expect(statusText()).toBe("");
  expect(screen.queryByRole("alert")).toBeNull();
  const second = await openPicker();
  expect(second.select.textContent).toBe(DEFAULT_PRINTER);
  expect(shell.calls.filter((call) => call.cmd === "list_printers")).toHaveLength(2);
});

test("print_refusal_shows_its_words", async () => {
  const { container } = start([]);
  await toTheKey();
  const { print, pdf } = printButtons();

  const parts = await openPicker();
  shell.refusePrintNext(PRINTER_BUSY);
  parts.send.focus();
  fireEvent.click(parts.send);
  const busy = await screen.findByRole("alert");
  expect(busy.textContent).toBe(messageText(messageFor(PRINTER_BUSY)));
  expect(busy.textContent).toBe("Lockbox is still printing. Wait for it to finish, then try again.");
  expect(busy.textContent).not.toMatch(/printer|busy|code/);
  // The picker stays, to try again or to cancel, and focus has not left it.
  expect(pickerParts().send.getAttribute("aria-disabled")).toBeNull();
  expect(document.activeElement).toBe(parts.send);
  expect(statusText()).toBe("");
  await expectNoAxe(container);

  // A job that could not be sent has its own words, and a new try takes the old ones away.
  shell.refusePrintNext(PRINT_NOT_SENT);
  fireEvent.click(pickerParts().send);
  await vi.waitFor(() => {
    expect(screen.getByRole("alert").textContent).toBe(
      "Lockbox couldn't send that to the printer. Check that it's on and connected, then try again.",
    );
  });
  expect(screen.getAllByRole("alert")).toHaveLength(1);
  expect(shell.printed).toEqual([]);

  // The PDF's own refusal has its own words.
  shell.refusePrintNext(PDF_NOT_MADE);
  fireEvent.click(pdf);
  await vi.waitFor(() => {
    expect(screen.getByRole("alert").textContent).toBe("Lockbox couldn't make the PDF. Nothing was saved. Try again.");
  });
  expect(screen.getAllByRole("alert")).toHaveLength(1);
  expect(shell.pdfs).toEqual([]);
  expect(print.getAttribute("aria-disabled")).toBeNull();
  expect(pdf.getAttribute("aria-disabled")).toBeNull();

  // Trying again once it works clears the words.
  fireEvent.click(pdf);
  await screen.findByText(`Saved in ${SAVED_FOLDER}.`);
  expect(screen.queryByRole("alert")).toBeNull();
});

test("printer_gone_shows_its_words_and_reloads_the_list", async () => {
  const { container } = start([]);
  await toTheKey();
  const parts = await openPicker();
  await choosePrinter(parts.select, "Office Laser");
  // Windows no longer has the printer that was picked.
  shell.setPrinters(["Hall Inkjet", "Back Office"], "Hall Inkjet");
  fireEvent.click(parts.send);
  await vi.waitFor(() => {
    expect(screen.getByRole("alert").textContent).toBe("That printer isn't available any more. Pick another one.");
  });
  expect(shell.printed).toEqual([]);
  // The list was asked for again, and what is shown is the new one, with its default picked.
  await vi.waitFor(() => {
    expect(shell.calls.filter((call) => call.cmd === "list_printers")).toHaveLength(2);
  });
  await vi.waitFor(() => {
    expect(pickerParts().select.textContent).toBe("Hall Inkjet");
  });
  expect(await listedPrinters(pickerParts().select)).toEqual(["Hall Inkjet", "Back Office"]);
  expect(screen.queryByText("Sent to Office Laser.")).toBeNull();
  expect(pickerParts().send.getAttribute("aria-disabled")).toBeNull();
  expect(printButtons().print.getAttribute("aria-disabled")).toBeNull();
  await expectNoAxe(container);

  // And the second try goes to a printer that is there.
  await choosePrinter(pickerParts().select, "Back Office");
  fireEvent.click(pickerParts().send);
  expect(await screen.findByText("Sent to Back Office.")).toBeTruthy();
  expect(shell.printed).toEqual(["Back Office"]);
  expect(screen.queryByRole("alert")).toBeNull();
});

test("printer_list_failure_shows_its_words_and_opens_nothing", async () => {
  start([]);
  await toTheKey();
  const real = invoke.getMockImplementation();
  if (real === undefined) throw new Error("no fake shell");
  invoke.mockImplementation((cmd: string, args?: unknown) =>
    cmd === "list_printers"
      ? // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- Tauri rejects with the plain object
        Promise.reject({ code: "print_failed", what: "print" })
      : (real(cmd, args) as Promise<unknown>),
  );
  const { print, pdf } = printButtons();
  print.focus();
  fireEvent.click(print);
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toBe(messageText(messageFor({ code: "print_failed", what: "print" })));
  expect(screen.queryByRole("group", { name: PICKER_NAME })).toBeNull();
  expect(print.getAttribute("aria-disabled")).toBeNull();
  expect(pdf.getAttribute("aria-disabled")).toBeNull();
  expect(document.activeElement).toBe(print);
});

test("picker_never_prints", async () => {
  const { container } = start([]);
  await toTheKey();
  const mine = container.querySelector("[data-print-only]") as Element;
  const { select } = await openPicker();
  const sheet = document.createElement("style");
  sheet.textContent = splitPrintCss(PRINT_CSS).inside;
  document.head.append(sheet);
  try {
    // The key still prints; the picker, its list, its options and its buttons do not.
    expect(onThePage(mine)).toBe(true);
    const group = screen.getByRole("group", { name: PICKER_NAME, hidden: true });
    expect(onThePage(group)).toBe(false);
    for (const element of group.querySelectorAll("div, label, button, [role='combobox']")) expect(onThePage(element), element.tagName).toBe(false);
    // No text of the picker reaches the paper, and the one marked part still holds all 24 words.
    const strays: string[] = [];
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const holder = node.parentElement;
      if ((node.textContent ?? "").trim() !== "" && holder !== null && onThePage(holder) && group.contains(holder)) {
        strays.push((node.textContent ?? "").trim());
      }
    }
    expect(strays).toEqual([]);
    expect([...mine.querySelectorAll(".fu-key li")].filter((row) => onThePage(row))).toHaveLength(24);
    // Nor does the list of printers when it is open: it floats outside the key's element.
    fireEvent.keyDown(select, { key: "ArrowDown" });
    const list = await screen.findByRole("listbox", { hidden: true });
    expect(mine.contains(list)).toBe(false);
    for (const option of within(list).getAllByRole("option", { hidden: true })) expect(onThePage(option), option.textContent).toBe(false);
  } finally {
    sheet.remove();
  }
});

test("buttons_and_continue_held_while_printing", async () => {
  start([]);
  await toTheKey();
  const { print, pdf } = printButtons();
  const next = screen.getByRole<HTMLButtonElement>("button", { name: "Continue" });
  const held = (...buttons: HTMLButtonElement[]) => {
    for (const button of buttons) expect(button.getAttribute("aria-disabled"), button.textContent).toBe("true");
  };

  // While the list loads: Print says it is busy, all three are held, and focus stays where it was.
  const releaseList = shell.holdPrinterList();
  print.focus();
  fireEvent.click(print);
  await vi.waitFor(() => {
    expect(commandsSent()).toContain("list_printers");
  });
  expect(print.getAttribute("aria-busy")).toBe("true");
  held(print, pdf, next);
  expect(document.activeElement).toBe(print);
  fireEvent.click(pdf);
  fireEvent.click(print);
  fireEvent.click(next);
  await settle();
  expect(printCommands()).toEqual([]);
  expect(screen.queryByRole("heading", { level: 1, name: PICK_HEADING })).toBeNull();
  expect(shell.calls.filter((call) => call.cmd === "list_printers")).toHaveLength(1);
  await act(async () => {
    releaseList();
    await Promise.resolve();
  });
  const parts = await vi.waitFor(() => pickerParts());
  for (const button of [print, pdf, next, parts.send]) expect(button.getAttribute("aria-disabled"), button.textContent).toBeNull();
  expect(print.getAttribute("aria-busy")).toBeNull();
  expect(document.activeElement).toBe(parts.select);

  // While a print runs: the picker's Print, the key's two buttons and Continue are all held; focus stays on the Print pressed.
  const release = shell.holdPrint();
  parts.send.focus();
  fireEvent.click(parts.send);
  await vi.waitFor(() => {
    expect(parts.send.getAttribute("aria-busy")).toBe("true");
  });
  // (Cancel is held too, so nothing closes the picker midway.)
  held(print, pdf, next, parts.send, parts.cancel);
  expect(document.activeElement).toBe(parts.send);
  for (const button of [pdf, print, next, parts.send, parts.cancel]) fireEvent.click(button);
  await settle();
  expect(printCommands()).toEqual(["print_recovery_key"]);
  expect(screen.getByRole("group", { name: PICKER_NAME })).toBeTruthy();
  expect(screen.queryByRole("heading", { level: 1, name: PICK_HEADING })).toBeNull();
  await act(async () => {
    release();
    await Promise.resolve();
  });
  expect(await screen.findByText("Sent to Hall Inkjet.")).toBeTruthy();
  for (const button of [print, pdf, next]) expect(button.getAttribute("aria-disabled"), button.textContent).toBeNull();
  expect(document.activeElement).toBe(print);
});

/** Every command that is not a print command goes to the fake shell as it is; `print` answers the print ones. */
function answerPrintWith(print: (cmd: string, args: unknown) => Promise<unknown>): void {
  const real = invoke.getMockImplementation();
  if (real === undefined) throw new Error("no fake shell");
  invoke.mockImplementation((cmd: string, args?: unknown) =>
    ["save_recovery_pdf", "print_recovery_key"].includes(cmd) ? print(cmd, args) : (real(cmd, args) as Promise<unknown>),
  );
}

test("lock_while_printing_shows_no_error", async () => {
  for (const [button, command] of [
    ["Save as PDF", "save_recovery_pdf"],
    ["Print", "print_recovery_key"],
  ] as const) {
    resetStoreForTests();
    invoke.mockReset();
    listen.mockReset();
    cleanup();
    start([]);
    await toTheKey();
    const key = shell.keyOf(1) ?? "";
    // Print is sent from the picker.
    const pressed = button === "Print" ? (await openPicker()).send : screen.getByRole("button", { name: button });
    const release = shell.holdPrint();
    fireEvent.click(pressed);
    await vi.waitFor(() => {
      expect(commandsSent()).toContain(command);
    });
    // The vault locks while it is working; the shell then answers that it is locked, and no file is made.
    act(() => {
      shell.lock(shell.sessionOf(1)?.session ?? 0);
    });
    await screen.findByRole("heading", { level: 1, name: "Unlock My vault" });
    await act(async () => {
      release();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.queryByRole("alert"), button).toBeNull();
    expect(statusText(), button).toBe("");
    expect(screen.queryByText(/Saved in/), button).toBeNull();
    expect(document.body.textContent, button).not.toMatch(/locked|couldn't|still printing/i);
    expect(shell.pdfs, button).toEqual([]);
    expect(shell.printed, button).toEqual([]);
    expect(screen.queryByRole("group", { name: PICKER_NAME }), button).toBeNull();
    expect(document.body.textContent, button).not.toMatch(/Sent to/);
    expect(keyWordsOnPage(key), button).toEqual([]);
    expect(debugState().sessions, button).toEqual([]);
  }
});

test("lock_while_picking_closes_it_with_no_error", async () => {
  // The picker is open and the vault locks: the key leaves, so does the picker, and nothing is said.
  start([]);
  await toTheKey();
  const key = shell.keyOf(1) ?? "";
  await openPicker();
  act(() => {
    shell.lock(shell.sessionOf(1)?.session ?? 0);
  });
  await screen.findByRole("heading", { level: 1, name: "Unlock My vault" });
  expect(screen.queryByRole("group", { name: PICKER_NAME })).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByRole("combobox")).toBeNull();
  expect(printCommands()).toEqual([]);
  expect(shell.printed).toEqual([]);
  expect(keyWordsOnPage(key)).toEqual([]);

  // Unlocked again, the screen starts clean: no picker, no leftover words.
  const field = await screen.findByLabelText(/^Password for /);
  fireEvent.change(field, { target: { value: NEW_PASSWORD } });
  fireEvent.submit((field as HTMLInputElement).form as HTMLFormElement);
  await screen.findByRole("heading", { level: 1, name: "Finish your recovery key" });
  expect(screen.queryByRole("group", { name: PICKER_NAME })).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(statusText()).toBe("");

  // And a lock while the list is still being asked for: the late list opens nothing and says nothing.
  resetStoreForTests();
  invoke.mockReset();
  listen.mockReset();
  cleanup();
  start([]);
  await toTheKey();
  const releaseList = shell.holdPrinterList();
  fireEvent.click(printButtons().print);
  await vi.waitFor(() => {
    expect(commandsSent()).toContain("list_printers");
  });
  act(() => {
    shell.lock(shell.sessionOf(1)?.session ?? 0);
  });
  await screen.findByRole("heading", { level: 1, name: "Unlock My vault" });
  await act(async () => {
    releaseList();
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(screen.queryByRole("group", { name: PICKER_NAME })).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(printCommands()).toEqual([]);
});

test("an_answer_from_before_the_lock_shows_nothing_and_no_file_is_named", async () => {
  start([]);
  await toTheKey();
  const key = shell.keyOf(1) ?? "";
  // The answer was made before the lock and read after it: its generation is the old one.
  let answerNow: () => void = () => undefined;
  answerPrintWith((_cmd, args) => {
    const sent = args as { session: number; generation: number };
    return new Promise((resolve) => {
      answerNow = () => {
        resolve({ session: sent.session, generation: sent.generation, data: { Done: { folder: SAVED_FOLDER } } });
      };
    });
  });
  fireEvent.click(printButtons().pdf);
  await vi.waitFor(() => {
    expect(invoke).toHaveBeenCalledWith("save_recovery_pdf", expect.anything());
  });
  act(() => {
    shell.lock(shell.sessionOf(1)?.session ?? 0);
  });
  await act(async () => {
    answerNow();
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(screen.queryByText(/Saved in/)).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(document.body.textContent).not.toContain(SAVED_FOLDER);
  expect(keyWordsOnPage(key)).toEqual([]);
});

test("a_locked_refusal_without_the_lock_event_shows_nothing_and_takes_the_key_off", async () => {
  start([]);
  await toTheKey();
  const key = shell.keyOf(1) ?? "";
  // The page never heard the lock, but the shell says the vault is locked: that is the news.
  answerPrintWith(() =>
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- Tauri rejects with the plain object
    Promise.reject({ code: "locked" }),
  );
  fireEvent.click((await openPicker()).send);
  await screen.findByRole("heading", { level: 1, name: "Unlock My vault" });
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByRole("group", { name: PICKER_NAME })).toBeNull();
  expect(keyWordsOnPage(key)).toEqual([]);
  expect(debugState().sessions).toEqual([]);
});

test("an_expired_cloud_question_says_so_and_keeps_the_session_on_the_page_and_in_the_engine", async () => {
  start([]);
  await toTheKey();
  const key = shell.keyOf(1) ?? "";
  shell.cloudPdfNext();
  await pressSavePdf();
  const dialog = await screen.findByRole("dialog", { name: CLOUD_TITLE });
  // The shell dropped the question it had parked (five minutes passed, and nothing locked the vault): the yes is `not_found`.
  shell.dropParkedChoices();
  fireEvent.click(within(dialog).getByRole("button", { name: "Continue" }));
  expect((await screen.findByRole("alert")).textContent).toBe("That took too long, so nothing was saved. Press Save as PDF again.");
  expect(commandsSent()).toContain("save_readable_confirm");
  // The question is closed, but the vault was not locked: the page and the engine both still have the session, and the key is still shown.
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(debugState().sessions).toHaveLength(1);
  expect(shell.sessionOf(1)?.unlocked).toBe(true);
  expect(keyWordsOnPage(key).length).toBeGreaterThan(0);
  expect(shell.pdfs).toEqual([]);
});

test("a_missed_lock_on_the_cloud_question_takes_the_key_and_the_session_off_and_says_nothing", async () => {
  start([]);
  await toTheKey();
  const key = shell.keyOf(1) ?? "";
  shell.cloudPdfNext();
  await pressSavePdf();
  const dialog = await screen.findByRole("dialog", { name: CLOUD_TITLE });
  // The vault locks and the shell lets go of the question it had parked, but the page never hears the lock event.
  shell.lockWithoutEvent(shell.sessionOf(1)?.session ?? 0);
  fireEvent.click(within(dialog).getByRole("button", { name: "Continue" }));
  await screen.findByRole("heading", { level: 1, name: "Unlock My vault" });
  expect(commandsSent()).toContain("save_readable_confirm");
  // No words, no question, no key and no session on the page, and nothing written.
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.body.textContent).not.toContain("took too long");
  expect(keyWordsOnPage(key)).toEqual([]);
  expect(debugState().sessions).toEqual([]);
  expect(shell.pdfs).toEqual([]);
});

test("a_stale_answer_to_the_lookup_takes_the_key_and_the_session_off_and_says_nothing", async () => {
  start([]);
  await toTheKey();
  const key = shell.keyOf(1) ?? "";
  shell.cloudPdfNext();
  await pressSavePdf();
  const dialog = await screen.findByRole("dialog", { name: CLOUD_TITLE });
  shell.dropParkedChoices();
  // The lookup is answered tagged with another generation than the bridge knows: stale, with no lock event heard.
  const real = invoke.getMockImplementation();
  if (real === undefined) throw new Error("no fake shell");
  invoke.mockImplementation((cmd: string, args?: unknown) =>
    cmd === "list_items"
      ? (real(cmd, args) as Promise<{ generation: number }>).then((answer) => ({ ...answer, generation: answer.generation + 1 }))
      : (real(cmd, args) as Promise<unknown>),
  );
  fireEvent.click(within(dialog).getByRole("button", { name: "Continue" }));
  await screen.findByRole("heading", { level: 1, name: "Unlock My vault" });
  expect(commandsSent()).toContain("list_items");
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.body.textContent).not.toContain("took too long");
  expect(keyWordsOnPage(key)).toEqual([]);
  expect(debugState().sessions).toEqual([]);
  expect(shell.pdfs).toEqual([]);
});

test("a_cloud_question_that_fails_for_another_reason_keeps_the_key_and_says_why", async () => {
  // The control for the test above: a gone question is no lock either; any other refusal is said and the key stays.
  start([]);
  await toTheKey();
  const key = shell.keyOf(1) ?? "";
  shell.cloudPdfNext();
  await pressSavePdf();
  const dialog = await screen.findByRole("dialog", { name: CLOUD_TITLE });
  const real = invoke.getMockImplementation();
  if (real === undefined) throw new Error("no fake shell");
  invoke.mockImplementation((cmd: string, args?: unknown) =>
    cmd === "save_readable_confirm"
      ? // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- Tauri rejects with the plain object
        Promise.reject(PDF_NOT_MADE)
      : (real(cmd, args) as Promise<unknown>),
  );
  fireEvent.click(within(dialog).getByRole("button", { name: "Continue" }));
  expect((await screen.findByRole("alert")).textContent).toBe("Lockbox couldn't make the PDF. Nothing was saved. Try again.");
  expect(keyWordsOnPage(key).length).toBeGreaterThan(0);
  expect(debugState().sessions).toHaveLength(1);
});

// What the page prints: only the key's element and its words, in black on white. jsdom has no print and loads no style
// sheet of ours, so the `@media print` block's rules are laid on the page as they are, in a style element the test
// makes (the policy for the real page does not apply in jsdom); the real page never has a style element.
const PRINT_CSS = readBeside(import.meta.url, "../../styles/print.css").replace(/\/\*[\s\S]*?\*\//g, "");

/** The one `@media print { ... }` block's rules, and whatever lies outside it. */
function splitPrintCss(css: string): { inside: string; outside: string } {
  const head = /@media\s+print\s*\{/.exec(css);
  if (head === null) return { inside: "", outside: css };
  let depth = 1;
  let at = head.index + head[0].length;
  const start = at;
  while (depth > 0 && at < css.length) {
    if (css[at] === "{") depth += 1;
    if (css[at] === "}") depth -= 1;
    at += 1;
  }
  return { inside: css.slice(start, at - 1), outside: css.slice(0, head.index) + css.slice(at) };
}

/** Whether the element, and every element holding it, is shown. */
function onThePage(element: Element): boolean {
  for (let node: Element | null = element; node !== null; node = node.parentElement) {
    if (getComputedStyle(node).display === "none") return false;
  }
  return true;
}

function isColour(value: string, ...names: string[]): boolean {
  return names.includes(value.replace(/\s+/g, "").toLowerCase());
}
const BLACK = ["#000", "#000000", "black", "rgb(0,0,0)"];
const WHITE = ["#fff", "#ffffff", "white", "rgb(255,255,255)"];

test("print_style_keeps_every_rule_inside_media_print", () => {
  const { inside, outside } = splitPrintCss(PRINT_CSS);
  expect(inside.trim(), "print.css has an @media print block").not.toBe("");
  // The page on screen is untouched: nothing is outside the block.
  expect(outside.trim()).toBe("");
  // And the built style sheet says the same: the marker is named only inside @media print blocks.
  const built = Object.keys(import.meta.glob("../../../dist/assets/*.css"));
  expect(built.length, "run `npm run build` in ui/ first, then this test").toBeGreaterThan(0);
  for (const path of built) {
    const css = readBeside(import.meta.url, path).replace(/\/\*[\s\S]*?\*\//g, "");
    expect(css).toContain("data-print-only");
    const rest = css.replace(/@media\s+print\s*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "");
    expect(rest, "no print rule outside @media print").not.toContain("data-print-only");
  }
});

test("print_style_shows_only_the_key_and_its_words", async () => {
  const { container } = start([]);
  await toTheKey();
  const key = shell.keyOf(1) ?? "";
  const words = wordsOf(key);

  const marked = [...container.querySelectorAll("[data-print-only]")];
  expect(marked, "one element is marked").toHaveLength(1);
  const mine = marked[0] as Element;
  // The marked element holds the heading, the 24 numbered words and the plain warning, and nothing of the page's own.
  expect(within(mine as HTMLElement).getByRole("heading", { level: 2, name: "Lockbox recovery key, not a crypto wallet phrase" })).toBeTruthy();
  expect(mine.querySelectorAll(".fu-key li")).toHaveLength(24);
  expect(within(mine as HTMLElement).getByText("If you lose both your password and this key, nobody can get your data back.")).toBeTruthy();
  expect(keyWordsInAttributes(key)).toEqual([]);

  const sheet = document.createElement("style");
  sheet.textContent = splitPrintCss(PRINT_CSS).inside;
  document.head.append(sheet);
  try {
    // The key's own element, its heading, its words with their numbers and the warning stay on the page.
    expect(onThePage(mine)).toBe(true);
    expect(onThePage(mine.querySelector("h2") as Element)).toBe(true);
    const box = mine.querySelector(".fu-key") as Element;
    expect(onThePage(box)).toBe(true);
    const shown = [...mine.querySelectorAll(".fu-key li")];
    expect(shown.filter((row) => onThePage(row) && onThePage(row.querySelector(".fu-w") as Element) && onThePage(row.querySelector(".fu-n") as Element))).toHaveLength(24);
    expect(shown.map((row) => row.querySelector(".fu-w")?.textContent)).toEqual(words);
    expect(onThePage(mine.querySelector(".fu-lose") as Element)).toBe(true);

    // The buttons, the hint, the step line, the heading above, the frame and its side text do not.
    for (const button of screen.getAllByRole("button", { hidden: true })) expect(onThePage(button), button.textContent).toBe(false);
    for (const selector of [".fu-hint", ".fu-step", "h1", ".field", ".mark", ".say", ".rose"]) {
      const found = [...container.querySelectorAll(selector)];
      expect(found.length, selector).toBeGreaterThan(0);
      for (const element of found) expect(onThePage(element), selector).toBe(false);
    }
    // Whatever else reads as text on the printed page is inside the marked element: a line added to the screen later
    // does not reach the paper unless it is marked.
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    const strays: string[] = [];
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const holder = node.parentElement;
      if ((node.textContent ?? "").trim() !== "" && holder !== null && onThePage(holder) && !mine.contains(holder)) {
        strays.push((node.textContent ?? "").trim());
      }
    }
    expect(strays).toEqual([]);
    // Within the marked element, what is only for the screen (the buttons and what they say) is left off the paper.
    for (const element of mine.querySelectorAll("button, [role='status'], [role='alert']")) expect(onThePage(element)).toBe(false);

    // Black on white, in two columns.
    for (const element of [mine.querySelector("h2"), mine.querySelector(".fu-lose"), ...mine.querySelectorAll(".fu-w, .fu-n")]) {
      expect(isColour(getComputedStyle(element as Element).color, ...BLACK), element?.textContent ?? "").toBe(true);
    }
    for (const element of [mine, box]) {
      expect(isColour(getComputedStyle(element).backgroundColor, ...WHITE)).toBe(true);
    }
    expect(getComputedStyle(box).gridTemplateColumns.replace(/\s+/g, " ")).toBe("1fr 1fr");
    expect(box.querySelectorAll("ol")).toHaveLength(2);
  } finally {
    sheet.remove();
  }
});

test("print_style_has_a_rule_that_can_fail", async () => {
  // The same checks as above, but the marker is taken off the page: everything is hidden, so the test would notice.
  const { container } = start([]);
  await toTheKey();
  const sheet = document.createElement("style");
  sheet.textContent = splitPrintCss(PRINT_CSS).inside;
  document.head.append(sheet);
  try {
    const mine = container.querySelector("[data-print-only]") as Element;
    expect(onThePage(mine)).toBe(true);
    mine.removeAttribute("data-print-only");
    expect(onThePage(mine.querySelector(".fu-w") as Element)).toBe(false);
  } finally {
    sheet.remove();
  }
});
