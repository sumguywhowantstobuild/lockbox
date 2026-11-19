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

// The command Rename goes through, in the exact shapes the shell sends and reads (Rust: `rename_json_shapes`): the body is the session, its
// generation and the name, nothing else; the answer is the tagged nothing; and the refusals the page tells apart pass through as the shell's plain objects.
test("rename_vault_sends_the_session_generation_and_name_and_reads_the_tagged_nothing", async () => {
  await opened();
  invoke.mockResolvedValueOnce({ ...VAULT, data: null });
  await expect(api.renameVault(VAULT, "Family")).resolves.toEqual({ ...VAULT, data: null });
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(invoke).toHaveBeenLastCalledWith("rename_vault", { session: 7, generation: 3, name: "Family" });
});

test("rename_refusals_pass_through_as_the_plain_objects", async () => {
  await opened();
  const refusals = [
    { code: "invalid_input", what: "details changed" },
    { code: "locked_after_change", what: "vault name", vault: 7 },
    { code: "core", kind: "invalid_input", what: "vault name" },
    { code: "read_only" },
  ];
  for (const refusal of refusals) {
    invoke.mockRejectedValueOnce(refusal);
    await expect(api.renameVault(VAULT, "Family")).rejects.toEqual(refusal);
  }
  expect(invoke).toHaveBeenCalledTimes(refusals.length);
});

// An answer read in an older generation is dropped, like every session command's.
test("a_rename_answer_from_an_older_generation_is_dropped", async () => {
  await opened();
  invoke.mockResolvedValueOnce({ session: 7, generation: 2, data: null });
  await expect(api.renameVault(VAULT, "Family")).rejects.toBeInstanceOf((await import("./bridge")).StaleAnswer);
});
