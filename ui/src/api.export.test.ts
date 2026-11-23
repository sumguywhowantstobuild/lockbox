import { beforeEach, expect, test, vi } from "vitest";

const { invoke, listen } = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));

// A fresh bridge for each test: the generations it knows start empty.
let api: typeof import("./api");
beforeEach(async () => {
  vi.resetModules();
  invoke.mockReset();
  listen.mockReset();
  api = await import("./api");
});

const VAULT = { session: 7, generation: 3 };

// Built here, not written out as a literal that looks like a secret.
const TYPED = ["typed", "made", "up", "password"].join(" ");

/** Opens `VAULT`'s session in the bridge, as an unlock's answer does. */
async function opened(): Promise<void> {
  invoke.mockResolvedValueOnce({ session: VAULT.session, generation: VAULT.generation, data: { info: {} } });
  await (await import("./bridge")).open("unlock_vault", { id: 1, password: "x" });
  invoke.mockClear();
}

// The commands an export goes through, in the exact shapes the page sends and reads (Rust: `export_csv`, `export_repick`, `SavedView`).
test("export_wrappers_send_and_read_the_shell_shapes", async () => {
  await opened();
  const summary = { items: 7, left_out_files: 2, line_breaks: ["Made-up note"], unreadable: 2 };

  // Done, with the summary beside the folder.
  invoke.mockResolvedValueOnce({ ...VAULT, data: { Done: { folder: "C:\\Made-up\\Folder", export: summary } } });
  await expect(api.exportVault(VAULT, TYPED)).resolves.toEqual({ ...VAULT, data: { Done: { folder: "C:\\Made-up\\Folder", export: summary } } });
  expect(invoke).toHaveBeenLastCalledWith("export_csv", { session: 7, generation: 3, password: TYPED });

  // The cloud question, and the closed picker.
  const ask = { Confirm: { CloudFolder: { token: "made-up-token", provider: "OneDrive" } } };
  invoke.mockResolvedValueOnce({ ...VAULT, data: ask });
  await expect(api.exportVault(VAULT, TYPED)).resolves.toEqual({ ...VAULT, data: ask });
  invoke.mockResolvedValueOnce({ ...VAULT, data: "Dismissed" });
  await expect(api.exportVault(VAULT, TYPED)).resolves.toEqual({ ...VAULT, data: "Dismissed" });

  // Pick another folder names the token and nothing else; Continue is the existing confirm.
  invoke.mockResolvedValueOnce({ ...VAULT, data: { Done: { folder: "C:\\Made-up\\Other", export: summary } } });
  await api.exportRepick("made-up-token");
  expect(invoke).toHaveBeenLastCalledWith("export_repick", { token: "made-up-token" });
  invoke.mockResolvedValueOnce({ ...VAULT, data: { Done: { folder: "C:\\Made-up\\Other", export: summary } } });
  await api.saveReadableConfirm("made-up-token");
  expect(invoke).toHaveBeenLastCalledWith("save_readable_confirm", { token: "made-up-token" });
});

// An answer read in an older generation is dropped, like every session command's.
test("an_export_answer_from_an_older_generation_is_dropped", async () => {
  await opened();
  invoke.mockResolvedValueOnce({ session: 7, generation: 2, data: "Dismissed" });
  await expect(api.exportVault(VAULT, TYPED)).rejects.toBeInstanceOf((await import("./bridge")).StaleAnswer);
});
