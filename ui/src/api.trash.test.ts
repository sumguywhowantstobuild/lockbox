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

// The two commands the Trash view uses, in the exact shapes the page sends and reads (Rust: `empty_trash`, `EmptiedView`, `old_trash`).
test("trash_wrappers_send_and_read_the_shell_shapes", async () => {
  await opened();

  // Empty trash names the session, its generation and the count the question said (no item, no password); the answer is a count and
  // whether the trash was not that size (then nothing was deleted).
  invoke.mockResolvedValueOnce({ ...VAULT, data: { Done: { purged: 3, trash_changed: false } } });
  await expect(api.emptyTrash(VAULT, 3)).resolves.toEqual({ ...VAULT, data: { Done: { purged: 3, trash_changed: false } } });
  expect(invoke).toHaveBeenLastCalledWith("empty_trash", { session: 7, generation: 3, expected: 3 });

  // The old group's button adds the days: one more key, in the shell's own name for it (a number, never a string).
  invoke.mockResolvedValueOnce({ ...VAULT, data: { Done: { purged: 0, trash_changed: true } } });
  await expect(api.emptyTrash(VAULT, 2, 30)).resolves.toEqual({ ...VAULT, data: { Done: { purged: 0, trash_changed: true } } });
  expect(invoke).toHaveBeenLastCalledWith("empty_trash", { session: 7, generation: 3, expected: 2, older_than_days: 30 });

  // The old trash names the days, and answers the ids.
  invoke.mockResolvedValueOnce({ ...VAULT, data: ["a".repeat(32), "b".repeat(32)] });
  await expect(api.oldTrash(VAULT, 30)).resolves.toEqual({ ...VAULT, data: ["a".repeat(32), "b".repeat(32)] });
  expect(invoke).toHaveBeenLastCalledWith("old_trash", { session: 7, generation: 3, days: 30 });
});

// An answer read in an older generation is dropped, like every session command's.
test("a_trash_answer_from_an_older_generation_is_dropped", async () => {
  await opened();
  const { StaleAnswer } = await import("./bridge");
  invoke.mockResolvedValueOnce({ session: 7, generation: 2, data: { Done: { purged: 1 } } });
  await expect(api.emptyTrash(VAULT, 1)).rejects.toBeInstanceOf(StaleAnswer);
  invoke.mockResolvedValueOnce({ session: 7, generation: 2, data: [] });
  await expect(api.oldTrash(VAULT, 30)).rejects.toBeInstanceOf(StaleAnswer);
});
