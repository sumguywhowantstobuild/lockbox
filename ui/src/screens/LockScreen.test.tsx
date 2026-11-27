import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import App from "../App";
import { PetalockParts } from "../parts/PetalockParts";
import { Intaglio } from "../parts/Intaglio";
import { VaultMark, vaultLook } from "../parts/Pattern";
import { debugState, resetStoreForTests, startStore } from "../store";
import { expectNoAxe } from "../testing/axe";
import { installFakeShell, PASSWORD, sampleItems, type FakeShell } from "../testing/fakeShell";
import { LockScreen } from "./LockScreen";

const { invoke, listen } = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));

afterEach(cleanup);

let shell: FakeShell;

beforeEach(() => {
  resetStoreForTests();
  invoke.mockReset();
  listen.mockReset();
});

async function show(vaults: Parameters<typeof installFakeShell>[2]) {
  shell = installFakeShell(invoke, listen, vaults);
  await startStore();
  const view = render(
    <PetalockParts>
      <LockScreen />
    </PetalockParts>,
  );
  return view;
}

/** The path of a drawing rendered alone, to compare with what a screen draws. */
function drawingOf(element: ReactElement): string {
  const { container, unmount } = render(element);
  const d = container.querySelector("path")?.getAttribute("d") ?? "";
  unmount();
  return d;
}

/** The engraved logo's ribbons, joined: as drawn alone, or as drawn in the dark side of a screen. */
function engraving(): string {
  const { container, unmount } = render(<Intaglio />);
  const d = [...container.querySelectorAll("path")].map((path) => path.getAttribute("d")).join("|");
  unmount();
  return d;
}
function drawnIn(root: ParentNode | null | undefined): string {
  return [...(root?.querySelectorAll("svg.rose path") ?? [])].map((path) => path.getAttribute("d")).join("|");
}

function passwordField(): HTMLInputElement {
  return screen.getByLabelText<HTMLInputElement>(/^Password for /);
}

function type(text: string): void {
  fireEvent.change(passwordField(), { target: { value: text } });
}

function submit(): void {
  fireEvent.submit(passwordField().form as HTMLFormElement);
}

test("one_vault_is_already_chosen", async () => {
  const { container } = await show([{ id: 7, name: "My vault", items: sampleItems() }]);
  expect(screen.getByRole("heading", { level: 1, name: "Unlock My vault" })).toBeTruthy();
  expect(screen.getByLabelText("Password for My vault")).toBeTruthy();
  // No list to choose from: there is nothing to choose.
  expect(screen.queryByRole("radio")).toBeNull();
  expect(screen.getByRole("button", { name: "Unlock" })).toBeTruthy();
  await expectNoAxe(container);
});

test("lock_screen_shows_the_app_mark_small", async () => {
  const appMark = drawingOf(<VaultMark points={3} />);
  const logo = engraving();
  // Both drawings exist, so the comparisons below can't pass on two empty ones.
  expect(appMark).not.toBe("");
  expect(logo).not.toBe("");
  const { container } = await show([{ id: 7, name: "My vault", items: sampleItems() }]);
  const field = container.querySelector(".field");
  // 1a: the app's small three-petal mark beside its name, drawn for the eye only (the name is the words beside it)...
  const name = field?.querySelector(".mark");
  expect(name?.textContent).toBe("Petalock");
  const mark = name?.querySelector("svg.appmark");
  expect(mark?.getAttribute("aria-hidden")).toBe("true");
  expect(mark?.querySelector("path")?.getAttribute("d")).toBe(appMark);
  // ...and Petalock's engraved logo large behind it (Plan 5 Task 9b), the same for every vault.
  expect(drawnIn(field)).toBe(logo);
  expect(field?.querySelectorAll("svg.appmark")).toHaveLength(1);
});

test("lock_and_setup_screens_show_the_engraved_logo", async () => {
  // The lock screen's dark side shows the one picture whichever vault is chosen (places 0 and 1), and so does the save step;
  // the setup screens' frame is checked beside it (Frame.test.tsx).
  const logo = engraving();
  expect(logo.split("|")).toHaveLength(26);
  const { container } = await show([
    { id: 7, name: "My vault", items: sampleItems() },
    { id: 8, name: "Home", items: sampleItems() },
  ]);
  const picture = () => container.querySelector(".field svg.rose");
  expect(drawnIn(container.querySelector(".field"))).toBe(logo);
  expect(picture()?.getAttribute("aria-hidden")).toBe("true");
  expect(container.querySelectorAll(".field svg.rose")).toHaveLength(1);
  fireEvent.click(screen.getByRole("radio", { name: /Home/ }));
  expect(screen.getByLabelText("Password for Home")).toBeTruthy();
  expect(drawnIn(container.querySelector(".field"))).toBe(logo);
  cleanup();

  resetStoreForTests();
  invoke.mockReset();
  listen.mockReset();
  shell = installFakeShell(invoke, listen, [{ id: 7, name: "My vault", items: sampleItems() }]);
  const app = render(<App />);
  await vi.waitFor(() => {
    expect(shell.calls.some((call) => call.cmd === "capture_state")).toBe(true);
  });
  await act(async () => {
    shell.press({ text: "MU-copied value" });
    await Promise.resolve();
  });
  await screen.findByRole("heading", { level: 1, name: "Save what you copied" });
  expect(drawnIn(app.container.querySelector(".field"))).toBe(logo);
});

test("the_unlock_heading_shows_the_chosen_vaults_mark", async () => {
  // Every vault shows the same large picture, so the heading starts with the chosen vault's small mark in its colour, with
  // one vault or many, and the mark follows the choice. It is for the eye only: the heading's name stays its words.
  const markOf = (position: number) => drawingOf(<VaultMark points={vaultLook(position, false).points} />);
  expect(markOf(0)).not.toBe(markOf(1));
  const headingMark = (name: string) => {
    const heading = screen.getByRole("heading", { level: 1, name });
    const mark = heading.querySelector("svg.vmini");
    expect(heading.firstElementChild).toBe(mark);
    expect(mark?.getAttribute("aria-hidden")).toBe("true");
    expect(mark?.getAttribute("class") ?? "").toMatch(/\bmode-(light|dark)\b/);
    return { d: mark?.querySelector("path")?.getAttribute("d"), accent: /\bv-(work|home)\b/.exec(mark?.getAttribute("class") ?? "")?.[1] };
  };
  await show([{ id: 7, name: "My vault", items: sampleItems() }]);
  expect(headingMark("Unlock My vault")).toEqual({ d: markOf(0), accent: "work" });
  cleanup();

  resetStoreForTests();
  await show([
    { id: 7, name: "My vault", items: sampleItems() },
    { id: 8, name: "Home", items: sampleItems() },
  ]);
  expect(headingMark("Unlock a vault")).toEqual({ d: markOf(0), accent: "work" });
  fireEvent.click(screen.getByRole("radio", { name: /Home/ }));
  expect(headingMark("Unlock a vault")).toEqual({ d: markOf(1), accent: "home" });
  fireEvent.click(screen.getByRole("radio", { name: /My vault/ }));
  expect(headingMark("Unlock a vault")).toEqual({ d: markOf(0), accent: "work" });
});

test("two_vaults_list_with_the_first_chosen", async () => {
  const { container } = await show([
    { id: 7, name: "My vault", items: sampleItems() },
    { id: 8, name: "Home", items: sampleItems() },
  ]);
  expect(screen.getByRole("heading", { level: 1, name: "Unlock a vault" })).toBeTruthy();
  const choices = screen.getAllByRole<HTMLInputElement>("radio");
  expect(choices.map((choice) => choice.checked)).toEqual([true, false]);
  expect(screen.getByLabelText("Password for My vault")).toBeTruthy();

  // Picking the other one changes whose password is asked for, and empties what was typed for the first.
  type("typed for the first vault");
  fireEvent.click(screen.getByRole("radio", { name: /Home/ }));
  expect(screen.getByLabelText("Password for Home")).toBeTruthy();
  expect(passwordField().value).toBe("");
  type("wrong for home");
  submit();
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(invoke).toHaveBeenCalledWith("unlock_vault", { vault: { list: shell.listIdentity(), id: 8 }, password: "wrong for home" });
  await expectNoAxe(container);
});

test("each_vault_in_the_list_wears_its_own_colour_and_shape", async () => {
  await show([
    { id: 7, name: "My vault", items: sampleItems() },
    { id: 8, name: "Home", items: sampleItems() },
    { id: 9, name: "Work", items: sampleItems() },
  ]);
  const rows = screen.getAllByRole("radio").map((radio) => radio.closest("label"));
  // The colour takes turns, in light and dark alike (its mode class is beside it, so its variables resolve).
  expect(rows.map((row) => /\bv-(work|home)\b/.exec(row?.className ?? "")?.[1])).toEqual(["work", "home", "work"]);
  expect(rows.every((row) => /\bmode-(light|dark)\b/.test(row?.className ?? ""))).toBe(true);
  // Each has a shape of its own.
  const shapes = rows.map((row) => row?.querySelector("path")?.getAttribute("d"));
  expect(new Set(shapes).size).toBe(3);
});

test("a_vault_that_is_not_there_cannot_be_chosen", async () => {
  await show([
    { id: 7, name: "My vault", items: sampleItems() },
    { id: 8, name: "Old laptop", available: false },
  ]);
  // Not a radio at all (Task 9, 30b): its row says so in 30b's words, and has Try again and Remove from list.
  expect(screen.queryByRole("radio", { name: /Old laptop/ })).toBeNull();
  expect(screen.getByText("Unavailable: its folder or drive isn't there")).toBeTruthy();
  expect(screen.queryByText("Not available")).toBeNull();
});

test("wrong_password_says_so_and_stays", async () => {
  const { container } = await show([{ id: 7, name: "My vault", items: sampleItems() }]);
  type("not the password");
  submit();
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toBe("Wrong password.");
  // Still the lock screen, the typed text kept so a typo can be mended, and no vault was opened.
  expect(screen.getByRole("heading", { level: 1, name: "Unlock My vault" })).toBeTruthy();
  expect(passwordField().value).toBe("not the password");
  expect(shell.sessionOf(7)).toBeUndefined();
  // The refusal's own fields never reach the screen.
  expect(container.textContent).not.toContain("wrong_password");
  await expectNoAxe(container);

  // Typing again takes the message away.
  type("not the password either");
  expect(screen.queryByRole("alert")).toBeNull();
});

test("a_refusal_the_screen_has_no_words_for_is_generic", async () => {
  await show([{ id: 7, name: "My vault", items: sampleItems() }]);
  const real = invoke.getMockImplementation();
  if (real === undefined) throw new Error("no fake shell");
  invoke.mockImplementation((cmd: string, args?: unknown) =>
    cmd === "unlock_vault"
      ? // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- Tauri rejects with the plain object
        Promise.reject({ code: "core", kind: "io", what: "SENTINEL-C:\\Users\\secret" })
      : (real(cmd, args) as Promise<unknown>),
  );
  type(PASSWORD);
  submit();
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).not.toContain("SENTINEL");
  expect(alert.textContent).not.toContain("secret");
  expect(alert.textContent.length).toBeGreaterThan(5);
});

test("caps_lock_shows_a_hint", async () => {
  const { container } = await show([{ id: 7, name: "My vault", items: sampleItems() }]);
  expect(screen.queryByText("Caps Lock is on.")).toBeNull();
  fireEvent.keyDown(passwordField(), { key: "a", modifierCapsLock: true });
  expect(screen.getByText("Caps Lock is on.")).toBeTruthy();
  // It is there for a reader of the screen, but is not an alarm of its own.
  expect(screen.getByText("Caps Lock is on.").getAttribute("role")).not.toBe("alert");
  await expectNoAxe(container);
  fireEvent.keyUp(passwordField(), { key: "a", modifierCapsLock: false });
  expect(screen.queryByText("Caps Lock is on.")).toBeNull();
  // The key itself being pressed turns it on, and the next press shows it off.
  fireEvent.keyDown(passwordField(), { key: "CapsLock", modifierCapsLock: true });
  expect(screen.getByText("Caps Lock is on.")).toBeTruthy();
  fireEvent.keyDown(passwordField(), { key: "b", modifierCapsLock: false });
  expect(screen.queryByText("Caps Lock is on.")).toBeNull();
});

test("enter_unlocks", async () => {
  await show([{ id: 7, name: "My vault", items: sampleItems() }]);
  type(PASSWORD);
  // Enter in the field submits the form its Unlock button belongs to: that is the browser's own rule, so the test
  // checks the two are one form, and sends the submit.
  const button = screen.getByRole<HTMLButtonElement>("button", { name: "Unlock" });
  expect(button.type).toBe("submit");
  expect(button.form).toBe(passwordField().form);
  submit();
  await vi.waitFor(() => {
    expect(invoke).toHaveBeenCalledWith("unlock_vault", { vault: { list: shell.listIdentity(), id: 7 }, password: PASSWORD });
  });
  await vi.waitFor(() => {
    expect(shell.sessionOf(7)).toBeDefined();
  });
});

test("password_field_empties_after_unlock", async () => {
  await show([{ id: 7, name: "My vault", items: sampleItems() }]);
  type(PASSWORD);
  expect(passwordField().value).toBe(PASSWORD);
  const field = passwordField();
  submit();
  await vi.waitFor(() => {
    expect(shell.sessionOf(7)).toBeDefined();
  });
  // The field is emptied as soon as the answer is in, whether or not the screen stays.
  await vi.waitFor(() => {
    expect(field.value).toBe("");
  });
  expect(document.body.innerHTML).not.toContain(PASSWORD);
  expect(shell.calls.filter((call) => call.cmd === "unlock_vault")).toHaveLength(1);
});

test("a_second_press_while_unlocking_sends_one_unlock", async () => {
  await show([{ id: 7, name: "My vault", items: sampleItems() }]);
  type(PASSWORD);
  submit();
  submit();
  await vi.waitFor(() => {
    expect(shell.sessionOf(7)).toBeDefined();
  });
  expect(shell.calls.filter((call) => call.cmd === "unlock_vault")).toHaveLength(1);
});

test("a_lock_before_the_answer_shows_no_error", async () => {
  await show([{ id: 7, name: "My vault", items: sampleItems() }]);
  const real = invoke.getMockImplementation();
  if (real === undefined) throw new Error("no fake shell");
  let answerNow: () => void = () => undefined;
  invoke.mockImplementation((cmd: string, args?: unknown) =>
    cmd === "unlock_vault"
      ? new Promise((resolve) => {
          answerNow = () => {
            resolve({
              session: 4242,
              generation: 1,
              data: { info: { session: 4242, generation: 1, name: "My vault", read_only: false, state: "unlocked" } },
            });
          };
        })
      : (real(cmd, args) as Promise<unknown>),
  );
  type(PASSWORD);
  submit();
  const handler = (listen.mock.calls[0] as [string, (event: { payload: unknown }) => void])[1];
  act(() => {
    handler({ payload: { session: 4242, generation: 2, reason: "idle" } });
  });
  await act(async () => {
    answerNow();
    await Promise.resolve();
  });
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByRole("heading", { level: 1, name: "Unlock My vault" })).toBeTruthy();
});

test("a_typed_password_does_not_survive_leaving_the_window", async () => {
  await show([{ id: 7, name: "My vault", items: sampleItems() }]);
  // Win+L, a minimised window or a switch to another program: the field is emptied, with no vault open to lock.
  type("almost the password");
  act(() => {
    window.dispatchEvent(new Event("blur"));
  });
  expect(passwordField().value).toBe("");

  type("typed again");
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  try {
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(passwordField().value).toBe("");
  } finally {
    visibility.mockRestore();
  }

  // Coming back to the window while it is visible empties nothing.
  type("kept");
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  expect(passwordField().value).toBe("kept");
});

test("forgot_password_link_opens_28a", async () => {
  const { container } = await show([
    { id: 7, name: "My vault", items: sampleItems() },
    { id: 8, name: "Home", items: sampleItems() },
  ]);
  // Nothing on the lock screen leads to a screen a later plan builds: no generator. Forgot password? (Task 28) sits beside Unlock; Restore a backup (4B's Task 5), Add existing
  // vault folder (Task 9) and Open a backup (Task 7) are the links under the form; the rest are the vaults, the password and Unlock.
  for (const words of [/generate/i]) {
    expect(screen.queryByText(words)).toBeNull();
  }
  expect(screen.queryAllByRole("link")).toEqual([]);
  expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual(["Unlock", "Forgot password?", "Restore a backup", "Add existing vault folder", "Open a backup"]);
  expect(container.querySelectorAll("[style]")).toHaveLength(0);
  // It is a button of the form's own line, not a submit: pressed, it opens 28a for the vault chosen (the second one here), and sends nothing yet.
  const link = screen.getByRole<HTMLButtonElement>("button", { name: "Forgot password?" });
  expect(link.type).toBe("button");
  fireEvent.click(screen.getByRole("radio", { name: /Home/ }));
  fireEvent.click(link);
  expect(debugState().forgot).toMatchObject({ vault: 8, phase: "key" });
  expect(invoke.mock.calls.filter(([name]) => String(name).startsWith("recover_"))).toEqual([]);
});

test("forgot_password_is_not_offered_while_a_copy_waits_for_its_vault", async () => {
  // The save step (8b) is the same screen with its own words and a Cancel: its way out is the copy's, not the password's.
  shell = installFakeShell(invoke, listen, [{ id: 7, name: "My vault", items: sampleItems() }]);
  render(<App />);
  await vi.waitFor(() => {
    expect(shell.calls.some((call) => call.cmd === "capture_state")).toBe(true);
  });
  await act(async () => {
    shell.press({ text: "MU-copied value" });
    await Promise.resolve();
  });
  await screen.findByRole("heading", { level: 1, name: "Save what you copied" });
  expect(screen.queryByRole("button", { name: "Forgot password?" })).toBeNull();
});

test("the_save_steps_vaults_are_a_group_named_vault_on_screen", async () => {
  // 8b draws a "Vault" label over the choice of vault, as the in-window save box has (4C Task 13b): on the save step the group's name shows, in the field labels'
  // look; on the plain lock screen it is still there for a screen reader, and not shown.
  shell = installFakeShell(invoke, listen, [
    { id: 7, name: "My vault", items: sampleItems() },
    { id: 8, name: "Home", items: sampleItems() },
  ]);
  render(<App />);
  const plain = await screen.findByRole("group", { name: "Vault" });
  expect(plain.querySelector("legend")?.className).toBe("sr");
  await vi.waitFor(() => {
    expect(shell.calls.some((call) => call.cmd === "capture_state")).toBe(true);
  });
  await act(async () => {
    shell.press({ text: "MU-copied value" });
    await Promise.resolve();
  });
  await screen.findByRole("heading", { level: 1, name: "Save what you copied" });
  const group = screen.getByRole("group", { name: "Vault" });
  expect(group.querySelector("legend")?.className).toBe("flab");
});

test("restore_a_backup_is_a_second_line_under_the_form_and_opens_the_first_step", async () => {
  const { container } = await show([{ id: 7, name: "My vault", items: sampleItems() }]);
  const form = container.querySelector("form") as HTMLFormElement;
  const link = screen.getByRole("button", { name: "Restore a backup" });
  // Under the form, on a line of its own, and not one of its buttons.
  expect(form.contains(link)).toBe(false);
  expect(form.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  await expectNoAxe(container);
  // It opens Windows' picker first, with nothing sent but the pick's own; the screens that follow belong to the app (`RestoreFlow.test.tsx`).
  fireEvent.click(link);
  await vi.waitFor(() => {
    expect(invoke.mock.calls.filter(([name]) => name === "restore_pick")).toEqual([["restore_pick", { choice: null, vault: null }]]);
  });
});

test("no_vaults_says_so", async () => {
  const { container } = await show([]);
  expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("No vaults yet");
  expect(screen.queryByLabelText(/^Password for /)).toBeNull();
  await expectNoAxe(container);
});
