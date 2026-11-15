// The page's job store (Task 2): which operation belongs to which request, progress that is kept or dropped by its scope, and what a lock
// takes away. Events are sent by hand through the mocked `listen`, in the shapes of the frozen connection.
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const { invoke, listen } = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));

type Handler = (event: { payload: unknown }) => void;
let jobs: typeof import("./jobs");
let bridge: typeof import("./bridge");
const handlers = new Map<string, Handler[]>();

function emit(event: string, payload: unknown): void {
  for (const handler of handlers.get(event) ?? []) handler({ payload });
}

const SESSION = { type: "session", session: 3, generation: 7 } as const;
const started = (request: number, operation: number, scope: unknown = SESSION, kind = "import") => ({ request, operation, scope, kind });
const progress = (operation: number, done: number, total: number, finished = false, scope: unknown = SESSION, kind = "import") => ({
  operation,
  scope,
  kind,
  done,
  total,
  finished,
});

/** The bridge learns that session 3 is open at generation 7, as an unlock's answer tells it. */
async function opened(session = 3, generation = 7): Promise<void> {
  invoke.mockResolvedValueOnce({ session, generation, data: "info" });
  await bridge.open("unlock_vault", { id: 1, password: "x" });
}

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  invoke.mockReset();
  listen.mockReset();
  handlers.clear();
  listen.mockImplementation((event: string, handler: Handler) => {
    handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    return Promise.resolve(() => undefined);
  });
  bridge = await import("./bridge");
  jobs = await import("./jobs");
  await opened();
  await jobs.startJobs();
});

afterEach(() => {
  vi.useRealTimers();
});

test("requests_are_numbers_that_are_never_reused", () => {
  const first = jobs.nextRequest();
  const second = jobs.nextRequest();
  expect(Number.isInteger(first) && Number.isInteger(second)).toBe(true);
  expect(second).not.toBe(first);
  expect(first).toBeGreaterThan(0);
});

test("job_started_is_matched_by_request_even_before_the_answer", () => {
  const mine = jobs.nextRequest();
  const other = jobs.nextRequest();
  // The command has not answered: only the event has come, and it names the request the page chose.
  emit("lockbox://job-started", started(mine, 41));
  emit("lockbox://job-started", started(other, 42, { type: "session", session: 3, generation: 7 }, "save_copy"));
  expect(jobs.jobOfRequest(mine)).toMatchObject({ operation: 41, kind: "import", done: 0, total: 0, finished: false });
  expect(jobs.jobOfRequest(other)).toMatchObject({ operation: 42, kind: "save_copy" });
  expect(jobs.jobOfOperation(41)?.request).toBe(mine);
});

test("an_event_for_a_request_the_page_is_not_waiting_for_is_kept_one_second_then_dropped", () => {
  emit("lockbox://job-started", started(900, 5));
  expect(jobs.jobOfRequest(900)).toBeNull();
  // Within the second, a screen that now waits for that request gets it.
  vi.advanceTimersByTime(900);
  jobs.expectRequest(900);
  expect(jobs.jobOfRequest(900)).toMatchObject({ operation: 5 });
  // Past the second, an event nobody claimed is gone for good.
  emit("lockbox://job-started", started(901, 6));
  vi.advanceTimersByTime(1100);
  jobs.expectRequest(901);
  expect(jobs.jobOfRequest(901)).toBeNull();
});

test("progress_updates_the_job_and_never_passes_the_total", () => {
  const request = jobs.nextRequest();
  emit("lockbox://job-started", started(request, 11));
  emit("lockbox://progress", progress(11, 300, 1000));
  expect(jobs.jobOfOperation(11)).toMatchObject({ done: 300, total: 1000, finished: false });
  // A figure past the total is shown as the total, whatever the shell sent.
  emit("lockbox://progress", progress(11, 1500, 1000));
  expect(jobs.jobOfOperation(11)).toMatchObject({ done: 1000, total: 1000 });
  emit("lockbox://progress", progress(11, 1000, 1000, true));
  expect(jobs.jobOfOperation(11)).toMatchObject({ finished: true });
});

test("progress_for_an_operation_nobody_started_is_dropped", () => {
  emit("lockbox://progress", progress(77, 1, 2));
  expect(jobs.jobOfOperation(77)).toBeNull();
});

test("stale_scope_progress_is_dropped", async () => {
  const request = jobs.nextRequest();
  emit("lockbox://job-started", started(request, 21));
  emit("lockbox://progress", progress(21, 10, 100));
  expect(jobs.jobOfOperation(21)?.done).toBe(10);
  // The session locked and was unlocked again: its generation is 8 now, so a late event of generation 7 is not shown.
  await opened(3, 8);
  emit("lockbox://progress", progress(21, 50, 100));
  expect(jobs.jobOfOperation(21)).toBeNull();

  // A launch job's scope goes with the epoch: an event of an older epoch than the last `lock-epoch` is not shown.
  const test2 = jobs.nextRequest();
  const launch = { type: "launch", epoch: 2 };
  emit("lockbox://job-started", started(test2, 22, launch, "test"));
  emit("lockbox://lock-epoch", { epoch: 3, reason: "manual" });
  emit("lockbox://progress", progress(22, 5, 10, false, launch, "test"));
  expect(jobs.jobOfOperation(22)).toBeNull();
  // A job started in the current epoch is kept.
  const fresh = jobs.nextRequest();
  const current = { type: "launch", epoch: 3 };
  emit("lockbox://job-started", started(fresh, 23, current, "test"));
  emit("lockbox://progress", progress(23, 5, 10, false, current, "test"));
  expect(jobs.jobOfOperation(23)).toMatchObject({ done: 5 });
});

test("a_job_started_in_a_scope_that_has_gone_is_not_kept", () => {
  const request = jobs.nextRequest();
  emit("lockbox://job-started", started(request, 31, { type: "session", session: 3, generation: 6 }));
  expect(jobs.jobOfRequest(request)).toBeNull();
});

test("lock_removes_every_job_from_the_screen", () => {
  const a = jobs.nextRequest();
  const b = jobs.nextRequest();
  const c = jobs.nextRequest();
  const launch = { type: "launch", epoch: 1 };
  emit("lockbox://job-started", started(a, 51));
  emit("lockbox://job-started", started(b, 52, SESSION, "save_copy"));
  emit("lockbox://job-started", started(c, 53, launch, "test"));
  // One vault's lock takes that vault's jobs, and only them.
  emit("lockbox://locked", { session: 3, generation: 8, reason: "manual" });
  expect(jobs.jobOfOperation(51)).toBeNull();
  expect(jobs.jobOfOperation(52)).toBeNull();
  expect(jobs.jobOfOperation(53)).not.toBeNull();
  // The epoch changing takes the launch-scoped ones, even with no vault open.
  emit("lockbox://lock-epoch", { epoch: 2, reason: "manual" });
  expect(jobs.jobOfOperation(53)).toBeNull();
});

test("stop_calls_cancel_for_that_operation", async () => {
  const request = jobs.nextRequest();
  emit("lockbox://job-started", started(request, 61));
  invoke.mockResolvedValueOnce(null);
  await jobs.stopJob(61);
  expect(invoke).toHaveBeenLastCalledWith("cancel_operation", { operation: 61, scope: SESSION });
  // It says it is stopping, so a second press does not send another.
  expect(jobs.jobOfOperation(61)?.stopping).toBe(true);
  await jobs.stopJob(61);
  expect(invoke.mock.calls.filter(([name]) => name === "cancel_operation")).toHaveLength(1);
});

test("a_refused_stop_says_nothing", async () => {
  const request = jobs.nextRequest();
  emit("lockbox://job-started", started(request, 62));
  // The job ended, or its scope went, before the stop got there: the shell refuses and the page shows nothing of it.
  invoke.mockRejectedValueOnce({ code: "not_found" });
  await expect(jobs.stopJob(62)).resolves.toBeUndefined();
  // A job the page does not know sends nothing at all.
  invoke.mockClear();
  await jobs.stopJob(999);
  expect(invoke).not.toHaveBeenCalled();
});

test("releasing_a_request_forgets_its_job", () => {
  const request = jobs.nextRequest();
  emit("lockbox://job-started", started(request, 71));
  emit("lockbox://progress", progress(71, 10, 10, true));
  jobs.releaseRequest(request);
  expect(jobs.jobOfRequest(request)).toBeNull();
  expect(jobs.jobOfOperation(71)).toBeNull();
});
