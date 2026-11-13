import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { LockboxParts } from "../parts/LockboxParts";
import { resetStoreForTests, startStore } from "../store";
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
    <LockboxParts>
      <LockScreen />
    </LockboxParts>,
  );
  return view;
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
  expect(invoke).toHaveBeenCalledWith("unlock_vault", { id: 8, password: "wrong for home" });
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
  const old = screen.getByRole<HTMLInputElement>("radio", { name: /Old laptop/ });
  expect(old.disabled).toBe(true);
  expect(screen.getByText("Not available")).toBeTruthy();
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
    expect(invoke).toHaveBeenCalledWith("unlock_vault", { id: 7, password: PASSWORD });
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

test("no_forgot_password_link_until_4c", async () => {
  const { container } = await show([
    { id: 7, name: "My vault", items: sampleItems() },
    { id: 8, name: "Home", items: sampleItems() },
  ]);
  // Nothing on the lock screen leads to a screen a later plan builds: no forgotten password, no restore, no adding a
  // vault folder, no generator. Only the vaults, the password and Unlock.
  for (const words of [/forgot/i, /restore/i, /add existing/i, /generate/i, /recovery/i]) {
    expect(screen.queryByText(words)).toBeNull();
  }
  expect(screen.queryAllByRole("link")).toEqual([]);
  expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual(["Unlock"]);
  expect(container.querySelectorAll("[style]")).toHaveLength(0);
});

test("no_vaults_says_so", async () => {
  const { container } = await show([]);
  expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("No vaults yet");
  expect(screen.queryByLabelText(/^Password for /)).toBeNull();
  await expectNoAxe(container);
});
