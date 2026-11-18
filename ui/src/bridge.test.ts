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

// A two-session command (a copy out of a backup into a vault): the answer is tagged with the destination, and is
// dropped when only the source session locked meanwhile.
test("call_pair_drops_the_answer_when_either_session_locked", async () => {
  await bridge.onLocked();
  const [, locked] = listen.mock.calls[0] as [string, (event: { payload: unknown }) => void];
  await opened(5, 1); // the vault
  await opened(6, 1); // the backup
  const source = { session: 6, generation: 1 };
  invoke.mockResolvedValueOnce(tagged(5, 1, "copied"));
  await expect(bridge.callPair("copy_item_to", {}, source)).resolves.toEqual(tagged(5, 1, "copied"));

  let answer: (value: unknown) => void = () => undefined;
  invoke.mockReturnValueOnce(
    new Promise((resolve) => {
      answer = resolve;
    }),
  );
  const copying = bridge.callPair("copy_item_to", {}, source);
  locked({ payload: { session: 6, generation: 2, reason: "manual" } });
  answer(tagged(5, 1, "names of the files left out"));
  await expect(copying).rejects.toBeInstanceOf(bridge.StaleAnswer);

  // The destination locking drops it through its own tag.
  invoke.mockResolvedValueOnce(tagged(5, 1, "copied"));
  locked({ payload: { session: 5, generation: 2, reason: "manual" } });
  await expect(bridge.callPair("copy_item_to", {}, { session: 5, generation: 2 })).rejects.toBeInstanceOf(
    bridge.StaleAnswer,
  );
});

test("call_many_keeps_only_current_elements", async () => {
  await opened(1, 2);
  await opened(3, 5);
  invoke.mockResolvedValueOnce({
    hits: [tagged(1, 2, "a"), tagged(1, 1, "b"), tagged(3, 5, "c"), tagged(3, 6, "d"), tagged(9, 1, "never opened")],
    busy: [4],
  });
  await expect(bridge.callMany("search_all", { query: "x" })).resolves.toEqual({
    hits: [tagged(1, 2, "a"), tagged(3, 5, "c")],
    busy: [4],
  });
});

// Fix round 2: the search's real shape, `{ hits, busy }`, with a vault that locks between the call and its answer.
test("search_hit_from_a_vault_locked_meanwhile_is_dropped", async () => {
  await bridge.onLocked();
  const [, locked] = listen.mock.calls[0] as [string, (event: { payload: unknown }) => void];
  await opened(1, 2);
  await opened(3, 5);
  let answer: (value: unknown) => void = () => undefined;
  invoke.mockReturnValueOnce(
    new Promise((resolve) => {
      answer = resolve;
    }),
  );
  const searched = bridge.callMany("search_all", { query: "bank" });
  locked({ payload: { session: 1, generation: 3, reason: "windows_locked" } });
  answer({ hits: [tagged(1, 2, ["read before the lock"]), tagged(3, 5, ["current"])], busy: [7] });
  await expect(searched).resolves.toEqual({ hits: [tagged(3, 5, ["current"])], busy: [7] });
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

  const question = { Confirm: { HeaderChanged: { token: "ab".repeat(16) } } };
  invoke.mockResolvedValueOnce(question);
  await expect(bridge.open("recover_vault")).resolves.toEqual(question);
  invoke.mockResolvedValueOnce("Dismissed");
  await expect(bridge.open("recover_vault")).resolves.toBe("Dismissed");
});

// Task 7: Open a backup is two steps. The picker is `open_backup_pick`; `open_backup_read_only` takes the held choice, the one box's credential and a request,
// and answers the new session in `Done`, never a closed picker.
test("open_backup_read_only_takes_a_choice_a_credential_and_a_request_and_answers_the_session", async () => {
  const args = { choice: "a".repeat(32), credential: { password_or_key: "typed" }, request: 3 };
  invoke.mockResolvedValueOnce({ Done: tagged(9, 1, { session: 9, generation: 1, name: "Old laptop backup", read_only: true, state: "unlocked", kind: "backup" }) });
  const answer = await bridge.open("open_backup_read_only", args);
  expect(invoke).toHaveBeenLastCalledWith("open_backup_read_only", args);
  expect(answer).toEqual(tagged(9, 1, { session: 9, generation: 1, name: "Old laptop backup", read_only: true, state: "unlocked", kind: "backup" }));
  // The session's generation is the bridge's now: an answer for it from before is stale.
  invoke.mockResolvedValueOnce(tagged(9, 0, "items read before"));
  await expect(bridge.call("list_items")).rejects.toBeInstanceOf(bridge.StaleAnswer);
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

// Fix round 1: a lock event that arrives after the session was unlocked again must not clear the screens.
test("late_lock_event_for_older_generation_is_ignored", async () => {
  const cleared = vi.fn();
  await bridge.onLocked(cleared);
  const [, handler] = listen.mock.calls[0] as [string, (event: { payload: unknown }) => void];
  await opened(1, 3);
  handler({ payload: { session: 1, generation: 2, reason: "manual" } });
  expect(cleared).not.toHaveBeenCalled();
  invoke.mockResolvedValueOnce(tagged(1, 3, "items"));
  await expect(bridge.call("list_items")).resolves.toEqual(tagged(1, 3, "items"));
  handler({ payload: { session: 1, generation: 4, reason: "manual" } });
  expect(cleared).toHaveBeenCalledOnce();
});

// `lockbox://notice` carries no vault data, so it has no generation: each notice is handed over as it came.
test("on_notice_hands_over_each_notice_as_it_came", async () => {
  const seen = vi.fn();
  await bridge.onNotice(seen);
  const [event, handler] = listen.mock.calls[0] as [string, (event: { payload: unknown }) => void];
  expect(event).toBe("lockbox://notice");
  const sweep = { kind: "output_sweep", removed: 0, kept: 0, unreadable: true };
  handler({ payload: sweep });
  expect(seen).toHaveBeenCalledExactlyOnceWith(sweep);
});

// `lockbox://capture` says a state and an id and never the value, so like a notice it has no generation: it is handed over as it came.
test("on_capture_hands_over_each_event_as_it_came", async () => {
  const seen = vi.fn();
  await bridge.onCapture(seen);
  const [event, handler] = listen.mock.calls[0] as [string, (event: { payload: unknown }) => void];
  expect(event).toBe("lockbox://capture");
  const made = { capture_id: "a".repeat(32), state: "value", changed: false, env_keys: null };
  handler({ payload: made });
  expect(seen).toHaveBeenCalledExactlyOnceWith(made);
});

// Task 2's three events, as the frozen connection names them: each is handed over as it came, and holds counts and ids only.
test.each([
  ["onJobStarted", "lockbox://job-started", { request: 4, operation: 9, scope: { type: "session", session: 3, generation: 7 }, kind: "import" }],
  ["onProgress", "lockbox://progress", { operation: 9, scope: { type: "launch", epoch: 2 }, kind: "test", done: 5, total: 10, finished: false }],
  ["onLockEpoch", "lockbox://lock-epoch", { epoch: 3, reason: "windows_locked" }],
  // Task 12: the shell asks before closing or quitting while a job runs; kinds and a flag only.
  ["onCloseAsked", "lockbox://close-asked", { reason: "close", running: ["import", "backup"], past_swap: false, restore_waiting: false }],
  ["onCloseAsked", "lockbox://close-asked", { reason: "quit", running: [], past_swap: false, restore_waiting: true }],
] as const)("%s_hands_over_each_event_as_it_came", async (name, channel, payload) => {
  const seen = vi.fn();
  await (bridge[name] as (handler: (event: unknown) => void) => Promise<unknown>)(seen);
  const [event, handler] = listen.mock.calls[0] as [string, (event: { payload: unknown }) => void];
  expect(event).toBe(channel);
  handler({ payload });
  expect(seen).toHaveBeenCalledExactlyOnceWith(payload);
});

// A job's scope is current while the bridge still holds that session's generation (a lock moves it on), or, for a launch job, in `jobs.ts`.
test("session_is_current_only_at_the_generation_the_bridge_holds", async () => {
  expect(bridge.isSessionCurrent(1, 2)).toBe(false);
  await opened(1, 2);
  expect(bridge.isSessionCurrent(1, 2)).toBe(true);
  expect(bridge.isSessionCurrent(1, 1)).toBe(false);
  await bridge.onLocked();
  const [, handler] = listen.mock.calls[0] as [string, (event: { payload: unknown }) => void];
  handler({ payload: { session: 1, generation: 3, reason: "manual" } });
  expect(bridge.isSessionCurrent(1, 2)).toBe(false);
});
