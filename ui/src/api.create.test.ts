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

// Built here, not written out as a literal that looks like a secret.
const PASSWORD = ["made", "up", "create", "password"].join(" ");

// The create commands in the exact shapes the shell sends and reads (Rust: `new_key_view_and_change_password_json_shapes`, frozen in Plan 4C Task 7).
const DONE = {
  session: 12,
  generation: 1,
  data: {
    info: { session: 12, generation: 1, name: "Family", read_only: false, state: "unlocked", kind: "vault" },
    recovery_key: "alpha bravo charlie",
    issue: 1,
    vault_id: 4,
  },
};

test("create_vault_sends_its_body_and_reads_the_new_vaults_registry_id", async () => {
  invoke.mockResolvedValueOnce({ Done: DONE });
  await expect(api.createVault("Family", PASSWORD, false)).resolves.toEqual(DONE);
  expect(invoke).toHaveBeenLastCalledWith("create_vault", { name: "Family", password: PASSWORD, choose_folder: false });

  // The confirmed path answers the same shape.
  invoke.mockResolvedValueOnce({ Done: { ...DONE, session: 13, data: { ...DONE.data, vault_id: 5 } } });
  const madeUp = "0123456789abcdef".repeat(2);
  const confirmed = await api.createVaultConfirm(madeUp);
  expect(invoke).toHaveBeenLastCalledWith("create_vault_confirm", { token: madeUp });
  expect(confirmed).toMatchObject({ session: 13, data: { vault_id: 5, issue: 1 } });
});

test("a_create_a_lock_overtook_rejects_with_the_plain_object_that_carries_the_vault_id", async () => {
  const refusal = { code: "locked_after_change", what: "vault created", vault: 4 };
  invoke.mockRejectedValueOnce(refusal);
  await expect(api.createVault("Family", PASSWORD, true)).rejects.toEqual(refusal);
  expect(invoke).toHaveBeenLastCalledWith("create_vault", { name: "Family", password: PASSWORD, choose_folder: true });
});

test("the_refusals_of_a_create_pass_through_as_the_plain_objects_the_shell_sends", async () => {
  for (const refusal of [
    { code: "invalid_input", what: "vault not listed" },
    { code: "too_large", what: "vault list" },
    { code: "core", kind: "damaged", what: "vault list" },
  ]) {
    invoke.mockRejectedValueOnce(refusal);
    await expect(api.createVault("Family", PASSWORD, false)).rejects.toEqual(refusal);
  }
});
