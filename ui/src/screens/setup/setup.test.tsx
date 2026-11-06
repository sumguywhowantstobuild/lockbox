import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import App from "../../App";
import { Pattern } from "../../parts/Pattern";
import { debugState, resetStoreForTests } from "../../store";
import { expectNoAxe } from "../../testing/axe";
import { installFakeShell, PASSWORD, sampleItems, type FakeShell, type FakeVault } from "../../testing/fakeShell";
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
  // Nothing from a later task: saving it as a PDF, printing, Help.
  expect(screen.queryByRole("button", { name: /print|pdf|help/i })).toBeNull();
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
  const allowed = new Set(["list_vaults", "create_vault", "list_items", "get_settings"]);
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
  // The key is gone from the page for good, and nothing from a later task is offered yet.
  expect(keyWordsOnPage(key)).toEqual([]);
  expect(screen.queryByRole("button", { name: /^(Add|Login|Key|Note|File|Help|Paste)/ })).toBeNull();
  expect(within(main).queryByRole("button")).toBeNull();
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
