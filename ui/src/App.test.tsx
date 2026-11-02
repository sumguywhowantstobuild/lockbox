import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import App from "./App";

const { invoke, listen } = vi.hoisted(() => ({
  invoke: vi.fn(),
  // Never fires by itself; a test takes the handler from `listen.mock.calls` and calls it.
  listen: vi.fn(() => Promise.resolve(() => undefined)),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));

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

// A fresh test vault in session 9, where any stored file's type can be asked about: `.cmd` asks until confirmed.
function answerOpenCommands(cmd: string, args: { confirmed_executable?: boolean } | undefined): Promise<unknown> {
  switch (cmd) {
    case "app_info":
      return Promise.resolve({ version: "9.8.7" });
    case "launch_notices":
      return Promise.resolve([]);
    case "create_vault":
      return Promise.resolve({ Done: { session: 9, generation: 1, data: {} } });
    case "add_file":
      return Promise.resolve({ session: 9, generation: 1, data: { Done: "item-id" } });
    case "get_item":
      return Promise.resolve({
        session: 9,
        generation: 1,
        data: { summary: { attachments: [{ file_id: "file-id" }] } },
      });
    case "open_file":
      return Promise.resolve({
        session: 9,
        generation: 1,
        data: args?.confirmed_executable === true ? { Done: null } : { Confirm: "Executable" },
      });
    case "retry_open_cleanup":
      return Promise.resolve({ removed: 1, still_open: 2 });
    default:
      return Promise.reject(new Error(`unexpected command ${cmd}`));
  }
}

test("open_test_buttons_add_a_file_then_ask_before_opening_it", async () => {
  invoke.mockReset();
  invoke.mockImplementation(answerOpenCommands);
  render(<App />);
  await screen.findByText("Lockbox 9.8.7");
  fireEvent.click(screen.getByRole("button", { name: "Create test vault" }));
  await screen.findByText("Created and unlocked (session 9)", { exact: false });

  const open = screen.getByRole("button", { name: "Open test .cmd" });
  fireEvent.click(open);
  expect(await screen.findByText("Asked first: this file can run code", { exact: false })).toBeTruthy();
  expect(invoke).toHaveBeenCalledWith("add_file", { session: 9, generation: 1, collection: null });
  const asked = { session: 9, generation: 1, id: "item-id", file_id: "file-id", confirmed_executable: false };
  expect(invoke).toHaveBeenCalledWith("open_file", asked);

  fireEvent.click(open);
  expect(await screen.findByText("Opened read-only (session 9)", { exact: false })).toBeTruthy();
  expect(invoke).toHaveBeenCalledWith("open_file", { ...asked, confirmed_executable: true });
  // The same file: nothing added a second time.
  expect(invoke.mock.calls.filter(([cmd]) => cmd === "add_file")).toHaveLength(1);

  fireEvent.click(screen.getByRole("button", { name: "Retry opened copies" }));
  expect(await screen.findByText("Opened copies: 1 removed, 2 still held", { exact: false })).toBeTruthy();
});

// Answers the backup buttons as the shell would: the test vault is session 5, its backup opens as session 6, and the
// backup lacks one of the item's files until the copy is sent with `skip_missing`.
function answerBackupCommands(cmd: string, args: { skip_missing?: boolean } | undefined): Promise<unknown> {
  const tagged = (session: number, data: unknown) => Promise.resolve({ session, generation: 1, data });
  switch (cmd) {
    case "app_info":
      return Promise.resolve({ version: "9.8.7" });
    case "launch_notices":
      return Promise.resolve([]);
    case "create_vault":
      return Promise.resolve({ Done: { session: 5, generation: 1, data: {} } });
    case "backup_vault":
      return tagged(5, {
        Done: { items: 3, files: 1, damaged_items: 1, damaged_files: 0, missing_files: 2, size_on_disk: 4096 },
      });
    case "test_backup":
      return Promise.resolve({
        Done: { created_at: "2026-11-02T09:00:00Z", items: 3, files: 1, missing_files: 2, size_on_disk: 4096 },
      });
    case "open_backup_read_only":
      return Promise.resolve({ Done: { session: 6, generation: 1, data: {} } });
    case "list_items":
      return tagged(6, {
        items: [
          { id: "folder-id", kind: "collection", trashed: false },
          { id: "old-id", kind: "note", trashed: true },
          { id: "item-id", kind: "file", trashed: false },
        ],
      });
    case "copy_item_to":
      return tagged(
        5,
        args?.skip_missing === true
          ? { Done: { id: "copy-id", left_out: ["scan.png", "id.pdf"] } }
          : { Confirm: { MissingFiles: { names: ["scan.png", "id.pdf"] } } },
      );
    default:
      return Promise.reject(new Error(`unexpected command ${cmd}`));
  }
}

test("backup_buttons_back_up_test_open_and_copy_out", async () => {
  invoke.mockReset();
  invoke.mockImplementation(answerBackupCommands);
  render(<App />);
  await screen.findByText("Lockbox 9.8.7");
  fireEvent.click(screen.getByRole("button", { name: "Create test vault" }));
  await screen.findByText("Created and unlocked (session 5)", { exact: false });

  fireEvent.click(screen.getByRole("button", { name: "Back up test vault" }));
  expect(
    await screen.findByText("3 items, 1 files; left out: 1 damaged items, 0 damaged files, 2 missing files", {
      exact: false,
    }),
  ).toBeTruthy();
  expect(invoke).toHaveBeenCalledWith("backup_vault", { session: 5, generation: 1 });

  fireEvent.click(screen.getByRole("button", { name: "Test a backup" }));
  expect(await screen.findByText("Backup is good: made 2026-11-02T09:00:00Z", { exact: false })).toBeTruthy();
  const credential = { credential: { password: "hands-on check only" } };
  expect(invoke).toHaveBeenCalledWith("test_backup", credential);

  fireEvent.click(screen.getByRole("button", { name: "Copy an item out" }));
  expect(await screen.findByText("No backup open", { exact: false })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Open backup read-only" }));
  expect(await screen.findByText("Backup opened read-only (session 6)", { exact: false })).toBeTruthy();
  expect(invoke).toHaveBeenCalledWith("open_backup_read_only", credential);

  const copy = screen.getByRole("button", { name: "Copy an item out" });
  fireEvent.click(copy);
  expect(await screen.findByText("Asked first: the backup lacks scan.png, id.pdf", { exact: false })).toBeTruthy();
  const asked = {
    from: 6,
    from_generation: 1,
    id: "item-id",
    to: 5,
    to_generation: 1,
    skip_missing: false,
  };
  expect(invoke).toHaveBeenCalledWith("copy_item_to", asked);
  fireEvent.click(copy);
  expect(await screen.findByText("Item copied into session 5; left out: scan.png, id.pdf", { exact: false })).toBeTruthy();
  expect(invoke).toHaveBeenCalledWith("copy_item_to", { ...asked, skip_missing: true });
});

// The handler the page registered for `event`.
function listener(event: string): (event: { payload: unknown }) => void {
  const calls = listen.mock.calls as unknown as [string, (event: { payload: unknown }) => void][];
  const found = calls.find(([name]) => name === event)?.[1];
  if (found === undefined) throw new Error(`the page does not listen for ${event}`);
  return found;
}

test("a_lock_clears_the_question_naming_files_and_the_backup_session", async () => {
  invoke.mockReset();
  invoke.mockImplementation(answerBackupCommands);
  listen.mockClear();
  render(<App />);
  await screen.findByText("Lockbox 9.8.7");
  fireEvent.click(screen.getByRole("button", { name: "Create test vault" }));
  await screen.findByText("Created and unlocked (session 5)", { exact: false });
  fireEvent.click(screen.getByRole("button", { name: "Open backup read-only" }));
  await screen.findByText("Backup opened read-only (session 6)", { exact: false });
  fireEvent.click(screen.getByRole("button", { name: "Copy an item out" }));
  expect(await screen.findByText("Asked first: the backup lacks scan.png, id.pdf", { exact: false })).toBeTruthy();

  // The backup session locks: the names go, and the buttons say nothing is open.
  act(() => {
    listener("lockbox://locked")({ payload: { session: 6, generation: 2, reason: "manual" } });
  });
  expect(screen.queryByText("scan.png", { exact: false })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Copy an item out" }));
  expect(await screen.findByText("No backup open", { exact: false })).toBeTruthy();
  // The question was forgotten with it: the next copy would ask again, not copy without the files.
  expect(invoke.mock.calls.filter(([cmd]) => cmd === "copy_item_to")).toHaveLength(1);
});

test("backup_in_progress_is_shown_while_busy_says_so", async () => {
  invoke.mockReset();
  invoke.mockImplementation(answerBackupCommands);
  listen.mockClear();
  render(<App />);
  await screen.findByText("Lockbox 9.8.7");
  expect(listen).toHaveBeenCalledWith("lockbox://busy", expect.any(Function));
  const calls = listen.mock.calls as unknown as [string, (event: { payload: unknown }) => void][];
  const busy = calls.find(([name]) => name === "lockbox://busy")?.[1];
  if (busy === undefined) throw new Error("the page does not listen for busy");

  expect(screen.queryByText("Backup in progress", { exact: false })).toBeNull();
  act(() => {
    busy({ payload: { session: 5, operations: ["backup"] } });
  });
  expect(screen.getByText("Backup in progress", { exact: false })).toBeTruthy();
  // Another operation of the same session: the backup is over.
  act(() => {
    busy({ payload: { session: 5, operations: [] } });
  });
  expect(screen.queryByText("Backup in progress", { exact: false })).toBeNull();
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
