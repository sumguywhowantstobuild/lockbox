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

/** Opens `VAULT`'s session in the bridge, as an unlock's answer does. */
async function opened(): Promise<void> {
  invoke.mockResolvedValueOnce({ session: VAULT.session, generation: VAULT.generation, data: { info: {} } });
  await (await import("./bridge")).open("unlock_vault", { id: 1, password: "x" });
  invoke.mockClear();
}

// The two commands Ask 5's list uses, in the exact shapes the page sends and reads (Rust: `list_orphans`, `OrphanView`, `delete_orphans`).
test("leftover_wrappers_send_and_read_the_shell_shapes", async () => {
  await opened();

  // The list names the session and its generation and nothing else; each file is its hex id, its size and the time it was last written.
  const files = [{ file_id: "ab".repeat(16), length: 4_404_019, stored: 1_773_300_000 }];
  invoke.mockResolvedValueOnce({ ...VAULT, data: files });
  await expect(api.listOrphans(VAULT)).resolves.toEqual({ ...VAULT, data: files });
  expect(invoke).toHaveBeenLastCalledWith("list_orphans", { session: 7, generation: 3 });

  // The delete names the files the person was shown, by id and nothing else (no path, no count): Rust deletes only if they are the files it
  // lists now. The answer is how many went.
  const shown = ["ab".repeat(16), "cd".repeat(16)];
  invoke.mockResolvedValueOnce({ ...VAULT, data: 2 });
  await expect(api.deleteOrphans(VAULT, shown)).resolves.toEqual({ ...VAULT, data: 2 });
  expect(invoke).toHaveBeenLastCalledWith("delete_orphans", { session: 7, generation: 3, files: shown });
});

// An answer read in an older generation is dropped, like every session command's.
test("a_leftover_answer_from_an_older_generation_is_dropped", async () => {
  await opened();
  const { StaleAnswer } = await import("./bridge");
  invoke.mockResolvedValueOnce({ session: 7, generation: 2, data: [] });
  await expect(api.listOrphans(VAULT)).rejects.toBeInstanceOf(StaleAnswer);
  invoke.mockResolvedValueOnce({ session: 7, generation: 2, data: 1 });
  await expect(api.deleteOrphans(VAULT, [])).rejects.toBeInstanceOf(StaleAnswer);
});
