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

// Made up, and plainly so.
const ID = "ca97".padEnd(32, "0");
const VAULT = { session: 3, generation: 1 };

/** Opens `VAULT`'s session in the bridge, as an unlock's answer does. */
async function opened(): Promise<void> {
  invoke.mockResolvedValueOnce({ session: VAULT.session, generation: VAULT.generation, data: { info: {} } });
  await (await import("./bridge")).open("unlock_vault", { id: 1, password: "x" });
  invoke.mockClear();
}

// The commands that hand the waiting copy to a vault, in the exact shapes the shell sends and reads (Rust: `capture_requests_and_answers_have_the_agreed_shapes`).
test("capture_choose_sends_the_session_the_generation_and_the_copys_id", async () => {
  await opened();
  invoke.mockResolvedValueOnce({ ...VAULT, data: null });
  await expect(api.captureChoose(VAULT, ID)).resolves.toEqual({ ...VAULT, data: null });
  expect(invoke).toHaveBeenLastCalledWith("capture_choose", { session: 3, generation: 1, capture_id: ID });
  expect(invoke).toHaveBeenCalledTimes(1);
});

test("capture_unchoose_sends_the_copys_id_and_nothing_else", async () => {
  invoke.mockResolvedValueOnce(null);
  await expect(api.captureUnchoose(ID)).resolves.toBeNull();
  expect(invoke).toHaveBeenLastCalledWith("capture_unchoose", { capture_id: ID });
  expect(invoke).toHaveBeenCalledTimes(1);
});

test("an_old_copy_is_refused_not_found_as_the_plain_object", async () => {
  invoke.mockRejectedValueOnce({ code: "not_found" });
  await expect(api.captureUnchoose(ID)).rejects.toEqual({ code: "not_found" });
});

test("a_read_only_vault_is_refused_by_choose_as_the_plain_object", async () => {
  await opened();
  invoke.mockRejectedValueOnce({ code: "read_only" });
  await expect(api.captureChoose(VAULT, ID)).rejects.toEqual({ code: "read_only" });
});

test("a_capture_vault_refusal_of_save_passes_through_as_the_plain_object", async () => {
  await opened();
  const refusal = { code: "invalid_input", what: "capture vault" };
  invoke.mockRejectedValueOnce(refusal);
  await expect(
    api.captureSave(VAULT, { captureId: ID, name: "SOME_KEY", collection: null, onClash: "ask", clearClipboard: true, typed: null }),
  ).rejects.toEqual(refusal);
  expect(invoke).toHaveBeenLastCalledWith("capture_save", {
    session: 3,
    generation: 1,
    capture_id: ID,
    name: "SOME_KEY",
    collection: null,
    on_clash: "ask",
    clear_clipboard: true,
    typed: null,
  });
});
