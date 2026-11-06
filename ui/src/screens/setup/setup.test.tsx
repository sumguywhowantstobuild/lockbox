import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import App from "../../App";
import { Pattern } from "../../parts/Pattern";
import { debugState, resetStoreForTests } from "../../store";
import { expectNoAxe } from "../../testing/axe";
import { installFakeShell, PASSWORD, sampleItems, type FakeShell, type FakeVault } from "../../testing/fakeShell";
import { groupsOf } from "./keyGroups";

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

/** The two groups the screen asks for: their numbers (from 1) and their boxes. */
function asked(): { number: number; box: HTMLInputElement }[] {
  return screen.getAllByLabelText<HTMLInputElement>(/^\d+(st|nd|rd|th) group$/).map((box) => ({
    number: Number.parseInt(/^(\d+)/.exec(box.labels?.[0]?.textContent ?? "")?.[1] ?? "0", 10),
    box,
  }));
}

function correct(key: string): void {
  for (const { number, box } of asked()) fireEvent.change(box, { target: { value: groupsOf(key)[number - 1] ?? "" } });
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
  // The key is on the screen, in one place, and in no attribute.
  expect(screen.getByText(key)).toBeTruthy();
  expect(document.body.innerHTML.split(key)).toHaveLength(2);
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

test("key_hidden_while_typing_back", async () => {
  const { container } = start([]);
  await toTheKey();
  const key = shell.keyOf(1) ?? "";
  click("Continue");
  expect(await screen.findByRole("heading", { level: 1, name: "Type part of your key back" })).toBeTruthy();
  // Not a group of it is on the page: not as text, not in a box, not in an attribute.
  for (const group of groupsOf(key)) expect(document.body.innerHTML, group).not.toContain(group);
  expect(asked()).toHaveLength(2);
  expect(asked().every(({ box }) => box.value === "")).toBe(true);
  await expectNoAxe(container);

  // And it can be shown again, the same key, for someone who needs to look once more.
  click("Show the key again");
  expect(await screen.findByRole("heading", { level: 1, name: "Save your recovery key" })).toBeTruthy();
  expect(screen.getByText(key)).toBeTruthy();
  expect(shell.keyOf(1)).toBe(key);
  expect(commandsSent()).not.toContain("regenerate_recovery");
});

test("two_random_groups_required", async () => {
  const { container } = start([]);
  await toTheKey();
  const key = shell.keyOf(1) ?? "";
  click("Continue");
  await screen.findByRole("heading", { level: 1, name: "Type part of your key back" });
  const [first, second] = asked();
  expect(first).toBeDefined();
  expect(second).toBeDefined();
  // Two different groups of the thirteen.
  expect(first?.number).not.toBe(second?.number);
  for (const entry of asked()) {
    expect(entry.number).toBeGreaterThanOrEqual(1);
    expect(entry.number).toBeLessThanOrEqual(13);
  }
  // Nothing typed, or only one group, does not go on.
  click("Continue");
  expect(commandsSent()).not.toContain("recovery_confirmed");
  fireEvent.change(first?.box as HTMLInputElement, { target: { value: groupsOf(key)[(first?.number ?? 1) - 1] ?? "" } });
  click("Continue");
  expect(commandsSent()).not.toContain("recovery_confirmed");
  expect(screen.getAllByRole("alert").length).toBeGreaterThan(0);
  await expectNoAxe(container);

  // Both right: the mark is cleared, once.
  correct(key);
  click("Continue");
  await screen.findByRole("heading", { level: 1, name: "All items" });
  expect(commandsSent().filter((cmd) => cmd === "recovery_confirmed")).toHaveLength(1);
  expect(shell.unconfirmed(1)).toBe(false);
});

test("wrong_group_stays_on_the_step", async () => {
  const { container } = start([]);
  await toTheKey();
  const key = shell.keyOf(1) ?? "";
  click("Continue");
  await screen.findByRole("heading", { level: 1, name: "Type part of your key back" });
  correct(key);
  const [first, second] = asked();
  // One group is wrong: it is said which, nothing is sent, and the step stays.
  fireEvent.change(second?.box as HTMLInputElement, { target: { value: "ZZZZ" } });
  click("Continue");
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain(`The ${String(second?.number)}`);
  expect(alert.textContent).toContain("group doesn't match");
  expect(alert.textContent).not.toContain(groupsOf(key)[(second?.number ?? 1) - 1]);
  expect(screen.getByRole("heading", { level: 1, name: "Type part of your key back" })).toBeTruthy();
  expect(commandsSent()).not.toContain("recovery_confirmed");
  expect(shell.unconfirmed(1)).toBe(true);
  // What was typed is kept, so a slip can be mended.
  expect(first?.box.value).toBe(groupsOf(key)[(first?.number ?? 1) - 1]);
  expect((second?.box as HTMLInputElement).value).toBe("ZZZZ");
  await expectNoAxe(container);
  // Mended.
  correct(key);
  click("Continue");
  await screen.findByRole("heading", { level: 1, name: "All items" });
});

test("any_lock_wipes_the_key", async () => {
  start([]);
  await toTheKey();
  const first = shell.keyOf(1) ?? "";
  expect(document.body.textContent).toContain(first);
  const live = shell.sessionOf(1);
  act(() => {
    shell.lock(live?.session ?? 0);
  });
  // The lock screen of the new vault; the key is nowhere, on the page or in the store.
  expect(await screen.findByRole("heading", { level: 1, name: "Unlock My vault" })).toBeTruthy();
  for (const group of groupsOf(first)) expect(document.body.innerHTML, group).not.toContain(group);
  expect(debugState().sessions).toEqual([]);
  expect(JSON.stringify(debugState())).not.toContain(first);

  // The next unlock finds the mark still there and makes a new key, so the vault is never left without one.
  typeInto(/^Password for /, NEW_PASSWORD);
  fireEvent.submit(screen.getByLabelText<HTMLInputElement>(/^Password for /).form as HTMLFormElement);
  expect(await screen.findByRole("heading", { level: 1, name: "Finish your recovery key" })).toBeTruthy();
  const second = shell.keyOf(1) ?? "";
  expect(second).not.toBe(first);
  expect(screen.getByText(second)).toBeTruthy();
  expect(document.body.innerHTML).not.toContain(first);

  // A lock while typing back wipes what was typed of it, too.
  click("Continue");
  await screen.findByRole("heading", { level: 1, name: "Type part of your key back" });
  correct(second);
  const typed = asked().map(({ box }) => box.value);
  expect(typed.every((text) => text.length === 4)).toBe(true);
  act(() => {
    shell.lock(shell.sessionOf(1)?.session ?? 0);
  });
  await screen.findByRole("heading", { level: 1, name: "Unlock My vault" });
  for (const text of typed) expect(document.body.innerHTML).not.toContain(text);
  expect(JSON.stringify(debugState())).not.toContain(typed[0]);
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
  expect(screen.getByText(key)).toBeTruthy();
  // The new key is asked for with the session and nothing else: no password on this path.
  const live = shell.sessionOf(7);
  expect(invoke).toHaveBeenCalledWith("regenerate_recovery", { session: live?.session, generation: live?.generation });
  const order = commandsSent().filter((cmd) => cmd === "unlock_vault" || cmd === "regenerate_recovery");
  expect(order).toEqual(["unlock_vault", "regenerate_recovery"]);
  await expectNoAxe(container);

  // Shown, typed back, confirmed: then the vault.
  click("Continue");
  await screen.findByRole("heading", { level: 1, name: "Type part of your key back" });
  correct(key);
  click("Continue");
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
  expect(await screen.findByText(key)).toBeTruthy();
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
  click("Continue");
  await screen.findByRole("heading", { level: 1, name: "Type part of your key back" });
  correct(key);
  click("Continue");
  await screen.findByRole("heading", { level: 1, name: "All items" });
  const main = screen.getByRole("main");
  expect(within(main).getByText("Your vault is empty")).toBeTruthy();
  expect(within(main).getByText("What to do first: add a login, or a key, a note or a file.")).toBeTruthy();
  // The key is gone from the page for good, and nothing from a later task is offered yet.
  expect(document.body.innerHTML).not.toContain(key);
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
