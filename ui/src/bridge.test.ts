import { beforeEach, expect, test, vi } from "vitest";

const { invoke, listen } = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));

// A fresh bridge for each test: the generations it knows start empty.
let bridge: typeof import("./bridge");
beforeEach(async () => {
  vi.resetModules();
  invoke.mockReset();
  listen.mockReset();
  bridge = await import("./bridge");
});

function tagged<T>(session: number, generation: number, data: T) {
  return { session, generation, data };
}

// Opens `session` at `generation`, as an unlock answering a bare `Tagged` does.
async function opened(session: number, generation: number) {
  invoke.mockResolvedValueOnce(tagged(session, generation, "info"));
  await bridge.open("unlock_vault", { id: 1, password: "x" });
}

test("discards_response_with_old_generation", async () => {
  await opened(1, 2);
  invoke.mockResolvedValueOnce(tagged(1, 1, "items read before the lock"));
  await expect(bridge.call("list_items", { session: 1, generation: 1 })).rejects.toBeInstanceOf(bridge.StaleAnswer);
});

test("accepts_response_with_current_generation", async () => {
  await opened(1, 2);
  invoke.mockResolvedValueOnce(tagged(1, 2, "items"));
  await expect(bridge.call("list_items", { session: 1, generation: 2 })).resolves.toEqual(tagged(1, 2, "items"));
  expect(invoke).toHaveBeenLastCalledWith("list_items", { session: 1, generation: 2 });
});

test("call_many_keeps_only_current_elements", async () => {
  await opened(1, 2);
  await opened(3, 5);
  invoke.mockResolvedValueOnce([
    tagged(1, 2, "a"),
    tagged(1, 1, "b"),
    tagged(3, 5, "c"),
    tagged(3, 6, "d"),
    tagged(9, 1, "never opened"),
  ]);
  await expect(bridge.callMany("search_all", { query: "x" })).resolves.toEqual([tagged(1, 2, "a"), tagged(3, 5, "c")]);
});

test("open_sets_current_generation", async () => {
  await opened(1, 2);
  await opened(1, 4); // unlocked again after a lock
  invoke.mockResolvedValueOnce(tagged(1, 4, "new"));
  await expect(bridge.call("list_items")).resolves.toEqual(tagged(1, 4, "new"));
  invoke.mockResolvedValueOnce(tagged(1, 2, "old"));
  await expect(bridge.call("list_items")).rejects.toBeInstanceOf(bridge.StaleAnswer);
  // An opening answer older than what the bridge has seen is stale too.
  invoke.mockResolvedValueOnce(tagged(1, 3, "info"));
  await expect(bridge.open("unlock_vault")).rejects.toBeInstanceOf(bridge.StaleAnswer);
});

test("open_unwraps_outcome", async () => {
  invoke.mockResolvedValueOnce({ Done: tagged(4, 1, "info") });
  await expect(bridge.open("create_vault")).resolves.toEqual(tagged(4, 1, "info"));
  invoke.mockResolvedValueOnce(tagged(4, 1, "items"));
  await expect(bridge.call("list_items")).resolves.toEqual(tagged(4, 1, "items"));

  const question = { Confirm: { HeaderChanged: { token: "0123456789abcdef0123456789abcdef" } } };
  invoke.mockResolvedValueOnce(question);
  await expect(bridge.open("recover_vault")).resolves.toEqual(question);
  invoke.mockResolvedValueOnce("Dismissed");
  await expect(bridge.open("open_backup_read_only")).resolves.toBe("Dismissed");
});

test("call_plain_returns_answer_as_is", async () => {
  invoke.mockResolvedValueOnce({ version: "9.8.7" });
  await expect(bridge.callPlain("app_info")).resolves.toEqual({ version: "9.8.7" });
  invoke.mockResolvedValueOnce([{ session: 1, generation: 1 }]);
  await expect(bridge.callPlain("list_sessions")).resolves.toEqual([{ session: 1, generation: 1 }]);
});

test("on_locked_makes_older_answers_stale", async () => {
  await bridge.onLocked();
  const [event, handler] = listen.mock.calls[0] as [string, (event: { payload: unknown }) => void];
  expect(event).toBe("lockbox://locked");
  await opened(1, 2);
  handler({ payload: { session: 1, generation: 3, reason: "windows_locked" } });
  invoke.mockResolvedValueOnce(tagged(1, 2, "items read before the lock"));
  await expect(bridge.call("list_items")).rejects.toBeInstanceOf(bridge.StaleAnswer);
  // An unlock whose answer arrives after the lock's event is stale as well.
  invoke.mockResolvedValueOnce(tagged(1, 2, "info"));
  await expect(bridge.open("unlock_vault")).rejects.toBeInstanceOf(bridge.StaleAnswer);
});
