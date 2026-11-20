import { beforeEach, expect, test, vi } from "vitest";

const { invoke, listen } = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));

let api: typeof import("./api");
beforeEach(async () => {
  vi.resetModules();
  invoke.mockReset();
  listen.mockReset();
  api = await import("./api");
});

// Plan 4C Task 12: the close question's answer, in the exact shape the shell reads (Rust: `close_answer`, `deny_unknown_fields`): the question's own
// number and the answer, nothing else (no session, no generation, no reason), and the shell's plain nothing back.
test("close_answer_sends_the_questions_number_and_the_answer_and_nothing_else", async () => {
  invoke.mockResolvedValue(null);
  await expect(api.closeAnswer(7, true)).resolves.toBeNull();
  await expect(api.closeAnswer(8, false)).resolves.toBeNull();
  expect(invoke.mock.calls).toEqual([
    ["close_answer", { question: 7, go: true }],
    ["close_answer", { question: 8, go: false }],
  ]);
  expect(Object.keys(invoke.mock.calls[0]?.[1] as object).sort()).toEqual(["go", "question"]);
});

// The shell's refusal of a question that is not the pending one reaches the page as its plain object, which `closeAsk.ts` reads as "nothing left to answer".
test("close_answer_refusal_passes_through_as_the_plain_object", async () => {
  invoke.mockRejectedValueOnce({ code: "not_found" });
  await expect(api.closeAnswer(1, false)).rejects.toEqual({ code: "not_found" });
});
