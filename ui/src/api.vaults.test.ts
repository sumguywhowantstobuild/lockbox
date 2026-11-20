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

// Made up, and plainly so (nothing here looks like a real key or token).
const WORD = "MU-typed-in-a-test";
const LIST = 6_029_157_341_982_211;

// The commands that name a vault of the list before an unlock, in the exact shapes the shell sends and reads (Rust: `vault_ref_json_shapes`): the row is
// `{ list, id }` copied field by field, and nothing else goes with it but the typed text.
test("the_list_passes_its_identity_through", async () => {
  const entry = { list: LIST, id: 2, name: "Family", available: true, details_damaged: false };
  invoke.mockResolvedValueOnce([entry]);
  await expect(api.listVaults()).resolves.toEqual([entry]);
  expect(invoke).toHaveBeenLastCalledWith("list_vaults", {});
});

test("unlock_and_recover_send_the_row_as_list_and_id", async () => {
  invoke.mockResolvedValueOnce({ session: 7, generation: 1, data: { info: {} } });
  await api.unlockVault({ list: 7, id: 2 }, WORD);
  expect(invoke).toHaveBeenLastCalledWith("unlock_vault", { vault: { list: 7, id: 2 }, password: WORD });

  invoke.mockResolvedValueOnce({ kind: "checked", choice: "MU-choice", vault_name: "Family" });
  await api.recoverCheck({ list: 7, id: 2 }, WORD);
  expect(invoke).toHaveBeenLastCalledWith("recover_check", { vault: { list: 7, id: 2 }, recovery_key: WORD });
});

// A whole entry (it carries a name) handed to a wrapper still sends the two fields and nothing else.
test("forget_and_show_send_the_row_and_nothing_else", async () => {
  const entry = { list: 7, id: 2, name: "Family", available: true, details_damaged: false };
  invoke.mockResolvedValueOnce(null);
  await expect(api.forgetVault(entry)).resolves.toBeNull();
  expect(invoke).toHaveBeenLastCalledWith("forget_vault", { vault: { list: 7, id: 2 } });

  invoke.mockResolvedValueOnce(null);
  await expect(api.showVaultInExplorer(entry)).resolves.toBeNull();
  expect(invoke).toHaveBeenLastCalledWith("show_vault_in_explorer", { vault: { list: 7, id: 2 } });
  expect(invoke).toHaveBeenCalledTimes(2);
});

test("not_found_busy_and_folder_refusals_pass_through_as_the_plain_objects", async () => {
  const refusals = [{ code: "not_found" }, { code: "busy", what: "operation in progress" }, { code: "invalid_input", what: "folder" }, { code: "core", kind: "io" }];
  for (const refusal of refusals) {
    invoke.mockRejectedValueOnce(refusal);
    await expect(api.forgetVault({ list: 7, id: 2 })).rejects.toEqual(refusal);
    invoke.mockRejectedValueOnce(refusal);
    await expect(api.showVaultInExplorer({ list: 7, id: 2 })).rejects.toEqual(refusal);
  }
  expect(invoke).toHaveBeenCalledTimes(refusals.length * 2);
});

test("add_existing_vault_in_a_cloud_folder_asks_first_and_names_the_service", async () => {
  // The question in the exact shape the shell sends (Rust: `cloud_question_names_the_provider_in_its_json`, Plan 4C Task 13b): the token and the service, never a path.
  // Save a copy, Save as PDF or .env, Save all files and a restore's prepare send the same shape (their Rust tests check the provider); the page names it only in 18c.
  const madeUp = "00112233445566778899aabbccddeeff";
  const asked = { Confirm: { CloudFolder: { token: madeUp, provider: "Dropbox" } } };
  invoke.mockResolvedValueOnce(asked);
  await expect(api.addExistingVault()).resolves.toEqual(asked);
  expect(invoke).toHaveBeenLastCalledWith("add_existing_vault", {});
});
