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

// The command Help goes through, in the exact shapes the shell reads and sends (Rust: `commands::guide`): the body is `{}` and nothing else, so no
// address or path can come from the page; the answer is nothing; and the shell's one refusal passes through as its plain object.
test("open_help_sends_an_empty_body_and_reads_nothing", async () => {
  invoke.mockResolvedValueOnce(null);
  await expect(api.openHelp()).resolves.toBeNull();
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(invoke).toHaveBeenLastCalledWith("open_help", {});
});

test("open_help_takes_no_input_at_all", () => {
  // The function has no parameter, so there is nothing a caller could put in the body.
  expect(api.openHelp.length).toBe(0);
});

test("open_help_refusal_passes_through_as_the_plain_object", async () => {
  const refusal = { code: "core", kind: "io" };
  invoke.mockRejectedValueOnce(refusal);
  await expect(api.openHelp()).rejects.toEqual(refusal);
  expect(invoke).toHaveBeenCalledTimes(1);
});
