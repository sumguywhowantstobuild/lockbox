import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import App from "./App";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

// Vitest globals are off, so Testing Library does not unmount between tests by itself.
afterEach(cleanup);

test("renders_version_from_app_info", async () => {
  invoke.mockResolvedValue({ version: "9.8.7" });
  render(<App />);
  expect(await screen.findByText("Lockbox 9.8.7")).toBeTruthy();
  // Through the bridge's `callPlain`, which passes its (absent) arguments on.
  expect(invoke).toHaveBeenCalledWith("app_info", undefined);
  expect(screen.getByRole("heading", { name: "Hands-on checks" })).toBeTruthy();
});

// Answers each command as the shell would for a fresh test vault.
function answerVaultCommands(cmd: string): Promise<unknown> {
  switch (cmd) {
    case "app_info":
      return Promise.resolve({ version: "9.8.7" });
    case "create_vault":
      return Promise.resolve({ Done: { session: 4, generation: 1, data: { info: {}, recovery_key: "x" } } });
    case "list_vaults":
      return Promise.resolve([
        { id: 2, name: "Another vault", available: true },
        { id: 7, name: "Lockbox test vault", available: true },
      ]);
    case "unlock_vault":
      return Promise.resolve({ session: 4, generation: 3, data: {} });
    default:
      return Promise.reject(new Error(`unexpected command ${cmd}`));
  }
}

test("test_vault_is_created_then_unlocked_by_its_registry_id", async () => {
  invoke.mockImplementation(answerVaultCommands);
  render(<App />);
  await screen.findByText("Lockbox 9.8.7");

  fireEvent.click(screen.getByRole("button", { name: "Create test vault" }));
  expect(await screen.findByText("Created and unlocked (session 4)", { exact: false })).toBeTruthy();
  expect(invoke).toHaveBeenCalledWith("create_vault", {
    name: "Lockbox test vault",
    password: "hands-on check only",
    choose_folder: false,
  });

  fireEvent.click(screen.getByRole("button", { name: "Unlock test vault" }));
  expect(await screen.findByText("Unlocked (session 4)", { exact: false })).toBeTruthy();
  expect(invoke).toHaveBeenCalledWith("unlock_vault", { id: 7, password: "hands-on check only" });
});

test("no_test_vault_and_refusals_are_shown", async () => {
  invoke.mockImplementation((cmd: string) => (cmd === "list_vaults" ? Promise.resolve([]) : answerVaultCommands(cmd)));
  render(<App />);
  await screen.findByText("Lockbox 9.8.7");
  fireEvent.click(screen.getByRole("button", { name: "Unlock test vault" }));
  expect(await screen.findByText("No test vault yet: create it first", { exact: false })).toBeTruthy();
  expect(invoke).not.toHaveBeenCalledWith("unlock_vault", expect.anything());

  invoke.mockImplementation((cmd: string) =>
    cmd === "create_vault"
      ? // Tauri rejects with the command's error as it was serialised: a plain object, not an `Error`.
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        Promise.reject({ code: "invalid_input", what: "removable drive" })
      : answerVaultCommands(cmd),
  );
  fireEvent.click(screen.getByRole("button", { name: "Create test vault" }));
  expect(
    await screen.findByText('Refused: {"code":"invalid_input","what":"removable drive"}', { exact: false }),
  ).toBeTruthy();
});

test("hands_on_probes_are_listed", async () => {
  invoke.mockResolvedValue({ version: "9.8.7" });
  render(<App />);
  await screen.findByText("Lockbox 9.8.7");
  expect(screen.getByRole("button", { name: "Navigate away" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Open a popup" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Download a file" })).toBeTruthy();
  expect(screen.getByTestId("drop-zone").textContent).toBe("Drop a file here");
  expect(screen.queryByText("A dropped file reached the page")).toBeNull();
});
