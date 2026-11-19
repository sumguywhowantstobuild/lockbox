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

// Built here, not written out as a literal that looks like a secret.
const CURRENT = ["current", "made", "up", "password"].join(" ");
const NEXT = ["next", "made", "up", "password"].join(" ");

/** Opens `VAULT`'s session in the bridge, as an unlock's answer does. */
async function opened(): Promise<void> {
  invoke.mockResolvedValueOnce({ session: VAULT.session, generation: VAULT.generation, data: { info: {} } });
  await (await import("./bridge")).open("unlock_vault", { id: 1, password: "x" });
  invoke.mockClear();
}

// The commands a recovery key and a password change go through, in the exact shapes the shell sends and reads (Rust:
// `new_key_view_and_change_password_json_shapes`).
test("recovery_wrappers_send_and_read_the_shell_shapes", async () => {
  await opened();

  invoke.mockResolvedValueOnce({ ...VAULT, data: null });
  await expect(api.changePassword(VAULT, CURRENT, NEXT)).resolves.toEqual({ ...VAULT, data: null });
  expect(invoke).toHaveBeenLastCalledWith("change_password", {
    session: 7,
    generation: 3,
    current_password: CURRENT,
    new_password: NEXT,
  });

  const key = { words: "alpha bravo charlie", issue: 4 };
  invoke.mockResolvedValueOnce({ ...VAULT, data: key });
  await expect(api.newRecoveryKey(VAULT, CURRENT)).resolves.toEqual({ ...VAULT, data: key });
  expect(invoke).toHaveBeenLastCalledWith("new_recovery_key", { session: 7, generation: 3, current_password: CURRENT });

  invoke.mockResolvedValueOnce({ ...VAULT, data: key });
  await expect(api.regenerateRecovery(VAULT)).resolves.toEqual({ ...VAULT, data: key });
  expect(invoke).toHaveBeenLastCalledWith("regenerate_recovery", { session: 7, generation: 3 });

  for (const answer of ["Confirmed", "Superseded"] as const) {
    invoke.mockResolvedValueOnce({ ...VAULT, data: answer });
    await expect(api.recoveryConfirmed(VAULT, 4)).resolves.toEqual({ ...VAULT, data: answer });
    expect(invoke).toHaveBeenLastCalledWith("recovery_confirmed", { session: 7, generation: 3, issue: 4 });
  }
});

// An answer read in an older generation is dropped, like every session command's.
test("recovery_answers_from_an_older_generation_are_dropped", async () => {
  await opened();
  invoke.mockResolvedValueOnce({ session: 7, generation: 2, data: { words: "alpha", issue: 1 } });
  await expect(api.newRecoveryKey(VAULT, CURRENT)).rejects.toBeInstanceOf((await import("./bridge")).StaleAnswer);
});
