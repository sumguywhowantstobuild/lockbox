import { act, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  addReveal,
  closeSearch,
  copyField,
  copyFromSearch,
  debugState,
  getForm,
  getReveal,
  lockEverything,
  lockOneVault,
  openedItems,
  openNewLogin,
  openSearch,
  resetStoreForTests,
  selectItem,
  setForm,
  startNotices,
  startStore,
  unlock,
} from "./store";
import { installFakeShell, itemId, LOCKED, PASSWORD, sampleItems, type FakeShell } from "./testing/fakeShell";

const { invoke, listen } = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));

afterEach(cleanup);

let shell: FakeShell;

beforeEach(() => {
  resetStoreForTests();
  invoke.mockReset();
  listen.mockReset();
  shell = installFakeShell(invoke, listen, [{ id: 7, name: "My vault", items: sampleItems() }]);
});

/** Starts the store and opens vault 7: its session and generation. */
async function opened(): Promise<{ session: number; generation: number }> {
  await startStore();
  expect(await unlock(7, PASSWORD)).toBe("opened");
  const live = shell.sessionOf(7);
  if (live === undefined) throw new Error("the fake shell opened no session");
  return { session: live.session, generation: live.generation };
}

test("lock_subscribes_before_any_command", async () => {
  // The listener's answer is held back: until it comes, no command may have been sent.
  let subscribed: () => void = () => undefined;
  listen.mockImplementation(() => {
    shell.calls.push({ cmd: "listen:lockbox://locked", args: undefined });
    return new Promise((resolve) => {
      subscribed = () => {
        resolve(() => undefined);
      };
    });
  });
  const started = startStore();
  await Promise.resolve();
  await Promise.resolve();
  expect(shell.calls.map((call) => call.cmd)).toEqual(["listen:lockbox://locked"]);
  subscribed();
  await started;
  // Then the settings (so the first screen is drawn in the saved theme), then the vault list.
  expect(shell.calls.map((call) => call.cmd)).toEqual(["listen:lockbox://locked", "get_settings", "list_vaults"]);
  // Started twice (React's strict mode does): subscribed once.
  await startStore();
  expect(shell.calls.filter((call) => call.cmd.startsWith("listen:"))).toHaveLength(1);
});

test("locked_event_wipes_revealed_values_and_forms", async () => {
  const { session, generation } = await opened();
  expect(openedItems(session)?.length).toBeGreaterThan(0);

  const REVEALED = "Pw-0123456789-revealed";
  addReveal(session, "item-1", REVEALED);
  setForm(session, "filter", "typed but not saved");
  expect(getReveal(session, "item-1")).toBe(REVEALED);
  expect(getForm(session, "filter")).toBe("typed but not saved");
  expect(JSON.stringify(debugState())).toContain(REVEALED);

  act(() => {
    shell.lock(session, "idle");
  });

  // Gone from the store, wherever it was kept: values, forms, lists and the open item.
  expect(getReveal(session, "item-1")).toBeUndefined();
  expect(getForm(session, "filter")).toBeUndefined();
  expect(openedItems(session)).toBeNull();
  const kept = JSON.stringify(debugState());
  expect(kept).not.toContain(REVEALED);
  expect(kept).not.toContain("typed but not saved");
  expect(kept).not.toContain("Bot admin console");
  // A value added after the lock, for the old generation, is refused too.
  addReveal(session, "item-2", REVEALED);
  expect(getReveal(session, "item-2")).toBeUndefined();
  expect(generation).toBeGreaterThan(0);
});

test("a_lock_of_one_vault_leaves_the_other_alone", async () => {
  resetStoreForTests();
  invoke.mockReset();
  listen.mockReset();
  shell = installFakeShell(invoke, listen, [
    { id: 7, name: "My vault", items: sampleItems() },
    { id: 8, name: "Home", items: sampleItems() },
  ]);
  await startStore();
  await unlock(7, PASSWORD);
  await unlock(8, PASSWORD);
  const first = shell.sessionOf(7);
  const second = shell.sessionOf(8);
  if (first === undefined || second === undefined) throw new Error("not open");
  addReveal(first.session, "a", "first-secret");
  addReveal(second.session, "a", "second-secret");
  act(() => {
    shell.lock(first.session);
  });
  expect(getReveal(first.session, "a")).toBeUndefined();
  expect(getReveal(second.session, "a")).toBe("second-secret");
  expect(openedItems(second.session)?.length).toBeGreaterThan(0);
});

test("stale_answer_shows_no_error", async () => {
  await startStore();

  // A list in flight when the lock comes: its answer is from the old generation. Nothing is stored, nothing is thrown.
  const release = shell.holdListItems();
  const unlocking = unlock(7, PASSWORD);
  await vi.waitFor(() => {
    expect(shell.calls.some((call) => call.cmd === "list_items")).toBe(true);
  });
  const live = shell.sessionOf(7);
  if (live === undefined) throw new Error("not open");
  act(() => {
    shell.lock(live.session);
  });
  release();
  await expect(unlocking).resolves.toBe("stale");
  expect(debugState().startError).toBeNull();
  expect(openedItems(live.session)).toBeNull();
  expect(JSON.stringify(debugState())).not.toContain("Bot admin console");

  // The vault opens again afterwards, in the next generation.
  await expect(unlock(7, PASSWORD)).resolves.toBe("opened");
  expect(openedItems(live.session)?.length).toBeGreaterThan(0);
});

test("an_unlock_answer_older_than_its_lock_is_dropped", async () => {
  await startStore();
  const real = invoke.getMockImplementation();
  if (real === undefined) throw new Error("no fake shell");
  let answerNow: () => void = () => undefined;
  // The shell sent the lock event first (generation 2), then the unlock's own answer (generation 1) reached the page.
  invoke.mockImplementation((cmd: string, args?: unknown) =>
    cmd === "unlock_vault"
      ? new Promise((resolve) => {
          answerNow = () => {
            resolve({
              session: 9001,
              generation: 1,
              data: { info: { session: 9001, generation: 1, name: "My vault", read_only: false, state: "unlocked" } },
            });
          };
        })
      : (real(cmd, args) as Promise<unknown>),
  );
  const unlocking = unlock(7, PASSWORD);
  const handler = (listen.mock.calls[0] as [string, (event: { payload: unknown }) => void])[1];
  act(() => {
    handler({ payload: { session: 9001, generation: 2, reason: "idle" } });
  });
  answerNow();
  await expect(unlocking).resolves.toBe("stale");
  expect(debugState().sessions).toEqual([]);
  expect(debugState().startError).toBeNull();
});

/** Makes the fake shell answer `cmd` with `answer` (a refusal or a plain answer) and nothing else, no lock event. */
function answerWith(cmd: string, answer: () => Promise<unknown>): void {
  const real = invoke.getMockImplementation();
  if (real === undefined) throw new Error("no fake shell");
  invoke.mockImplementation((name: string, args?: unknown) =>
    name === cmd ? answer() : (real(name, args) as Promise<unknown>),
  );
}

// eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- Tauri rejects with the plain object
const refusedAsLocked = () => Promise.reject(LOCKED);

test("lock_all_drops_every_session_even_if_no_lock_event_comes", async () => {
  resetStoreForTests();
  invoke.mockReset();
  listen.mockReset();
  shell = installFakeShell(invoke, listen, [
    { id: 7, name: "My vault", items: sampleItems() },
    { id: 8, name: "Home", items: sampleItems() },
  ]);
  await startStore();
  await unlock(7, PASSWORD);
  await unlock(8, PASSWORD);
  const first = shell.sessionOf(7);
  if (first === undefined) throw new Error("not open");
  addReveal(first.session, "a", "first-secret");
  // The shell locks and answers, but the event never reaches the page.
  answerWith("lock_all", () => Promise.resolve(null));
  await lockEverything();
  expect(debugState().sessions).toEqual([]);
  expect(JSON.stringify(debugState())).not.toContain("first-secret");
  expect(JSON.stringify(debugState())).not.toContain("Bot admin console");
  expect(debugState().toast).toBeNull();
});

test("a_locked_refusal_drops_the_session_and_shows_no_error", async () => {
  const { session } = await opened();
  // The page missed the lock event; the shell now refuses each command as locked.
  answerWith("get_item", refusedAsLocked);
  await selectItem(session, itemId(1));
  expect(debugState().sessions).toEqual([]);

  const again = await opened();
  answerWith("copy_field", refusedAsLocked);
  await copyField(again.session, itemId(1), "password");
  expect(debugState().sessions).toEqual([]);
  expect(debugState().toast).toBeNull();

  // A list refused as locked: the vault is not open, so no list and no error.
  answerWith("list_items", refusedAsLocked);
  await expect(unlock(7, PASSWORD)).resolves.toBe("stale");
  expect(debugState().sessions).toEqual([]);
});

test("a_lock_listener_that_cannot_be_set_up_says_so_and_sends_no_command", async () => {
  listen.mockReset();
  listen.mockImplementation(() => Promise.reject(new Error("no events")));
  invoke.mockClear();
  await startStore();
  expect(invoke).not.toHaveBeenCalled();
  expect(debugState().vaults).toBeNull();
  expect(debugState().startError).toEqual({ code: "page", kind: "lock_listener" });
  // Asked again, it does not try a second time and does not hang.
  await startStore();
  expect(invoke).not.toHaveBeenCalled();
});

test("lock_one_vault_drops_it_even_if_no_lock_event_comes", async () => {
  const { session } = await opened();
  addReveal(session, "a", "first-secret");
  // The shell locks and answers, but the event never reaches the page.
  answerWith("lock_vault", () => Promise.resolve(null));
  await lockOneVault(session);
  expect(debugState().sessions).toEqual([]);
  expect(JSON.stringify(debugState())).not.toContain("first-secret");
  expect(debugState().toast).toBeNull();
});

test("lock_one_vault_leaves_the_other_open", async () => {
  shell = installFakeShell(invoke, listen, [
    { id: 7, name: "My vault", items: sampleItems() },
    { id: 8, name: "Home", items: sampleItems() },
  ]);
  await startStore();
  await unlock(7, PASSWORD);
  await unlock(8, PASSWORD);
  const first = shell.sessionOf(7);
  const second = shell.sessionOf(8);
  if (first === undefined || second === undefined) throw new Error("not open");
  await lockOneVault(first.session);
  expect(debugState().sessions.map((entry) => entry.vaultId)).toEqual([8]);
  expect(shell.sessionOf(8)?.unlocked).toBe(true);
});

test("an_old_lock_answer_does_not_close_the_vault_unlocked_again", async () => {
  const { session } = await opened();
  const real = invoke.getMockImplementation();
  if (real === undefined) throw new Error("no fake shell");
  let answerNow: () => void = () => undefined;
  // The lock's own answer is slow: the event came first, and the vault was unlocked again before the answer arrived.
  invoke.mockImplementation((cmd: string, args?: unknown) =>
    cmd === "lock_vault"
      ? new Promise((resolve) => {
          answerNow = () => {
            resolve(null);
          };
        })
      : (real(cmd, args) as Promise<unknown>),
  );
  const locking = lockOneVault(session);
  act(() => {
    shell.lock(session);
  });
  expect(debugState().sessions).toEqual([]);
  await expect(unlock(7, PASSWORD)).resolves.toBe("opened");
  expect(debugState().sessions).toHaveLength(1);
  answerNow();
  await locking;
  // The new session is the one the person has now; the late answer is about the old one.
  expect(debugState().sessions).toHaveLength(1);
  expect(openedItems(session)?.length).toBeGreaterThan(0);
});

/**
 * Holds the next answer to `cmd` until the returned function settles it with `answer`. Settled before the command is sent (the
 * page asks something else first), the answer waits for it: either way it comes after everything the test did before settling.
 */
type HeldAnswer = (shellAnswer: () => Promise<unknown>) => Promise<unknown>;

function holdNext(cmd: string): (answer: HeldAnswer) => void {
  const real = invoke.getMockImplementation();
  if (real === undefined) throw new Error("no fake shell");
  let settle: ((answer: HeldAnswer) => void) | null = null;
  let early: HeldAnswer | null = null;
  let held = false;
  invoke.mockImplementation((name: string, args?: unknown) => {
    if (name !== cmd || held) return real(name, args) as Promise<unknown>;
    held = true;
    // The fake shell's own answer, asked only when the held answer is given: what it would say then.
    const shellAnswer = () => real(name, args) as Promise<unknown>;
    if (early !== null) return early(shellAnswer);
    return new Promise((resolve, reject) => {
      settle = (answer) => {
        answer(shellAnswer).then(resolve, reject);
      };
    });
  });
  return (answer) => {
    if (settle === null) early = answer;
    else settle(answer);
  };
}

test("a_late_locked_refusal_does_not_drop_the_vault_unlocked_again", async () => {
  const { session } = await opened();
  // A command asked before a lock is answered `locked` only after the vault was unlocked again (the same session, the next
  // generation): the refusal is about the old generation, so the vault the person has now stays.
  const answer = holdNext("copy_field");
  const copying = copyField(session, itemId(1), "password");
  act(() => {
    shell.lock(session);
  });
  await expect(unlock(7, PASSWORD)).resolves.toBe("opened");
  answer(refusedAsLocked);
  await copying;
  expect(debugState().sessions).toHaveLength(1);
  expect(openedItems(session)?.length).toBeGreaterThan(0);
});

test("a_late_copy_from_search_leaves_a_newer_form_alone", async () => {
  const { session } = await opened();
  // Copy on a search result, then the person closes the search and starts a new login before the copy's answer comes: the
  // copy is still told, but it does not open the old result over the form being typed.
  openSearch();
  const answer = holdNext("copy_field");
  const copying = copyFromSearch(session, itemId(1), "password");
  closeSearch();
  openNewLogin(session);
  setForm(session, "title", "typed by the person");
  answer((shellAnswer) => shellAnswer());
  await copying;
  // Opening a result reads the item first: let that finish too.
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(debugState().toast).toMatchObject({ kind: "copied", text: "Password copied" });
  const entry = debugState().sessions[0];
  expect(entry?.tool?.kind).toBe("new_login");
  expect(entry?.openItem).toBeNull();
  expect(getForm(session, "title")).toBe("typed by the person");
  expect(debugState().search).toBeNull();
});

test("an_unlock_overtaken_by_a_lock_is_stale_not_an_error", async () => {
  await startStore();
  // Lock all, or the window's close, landed during the unlock: the shell refuses it as locked, and no session exists yet for
  // a lock event to clear. Nothing to show, as for a stale answer.
  answerWith("unlock_vault", refusedAsLocked);
  await expect(unlock(7, PASSWORD)).resolves.toBe("stale");
  expect(debugState().sessions).toEqual([]);
  expect(debugState().toast).toBeNull();
});

test("a_late_lock_all_answer_does_not_drop_the_vault_unlocked_again", async () => {
  const { session } = await opened();
  // Lock all's events came first, the vault was unlocked again, and only then did Lock all's own answer arrive: it drops
  // what the page held when it was pressed, not the vault unlocked since.
  const answer = holdNext("lock_all");
  const locking = lockEverything();
  act(() => {
    shell.lock(session);
  });
  await expect(unlock(7, PASSWORD)).resolves.toBe("opened");
  answer(() => Promise.resolve(null));
  await locking;
  expect(debugState().sessions).toHaveLength(1);
});

test("a_lock_the_shell_refuses_is_said_and_the_vault_stays", async () => {
  const { session } = await opened();
  // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- Tauri rejects with the plain object
  answerWith("lock_vault", () => Promise.reject({ code: "core", kind: "io" }));
  await lockOneVault(session);
  expect(debugState().sessions).toHaveLength(1);
  expect(debugState().toast).toMatchObject({ kind: "failed", session });
});

test("a_lock_refused_as_locked_drops_the_vault_and_says_nothing", async () => {
  const { session } = await opened();
  answerWith("lock_vault", refusedAsLocked);
  await lockOneVault(session);
  expect(debugState().sessions).toEqual([]);
  expect(debugState().toast).toBeNull();
});

test("first_close_notice_sets_and_clears_5b_and_is_never_asked_for_at_launch", async () => {
  await startStore();
  // Launch has nothing for it: `first_close` is only ever an event.
  await startNotices();
  expect(debugState().notices.firstClose).toBe(false);
  expect(shell.calls.filter((call) => call.cmd === "launch_notices")).toHaveLength(1);
  act(() => {
    shell.sendEvent({ kind: "first_close", explain: true });
  });
  expect(debugState().notices.firstClose).toBe(true);
  // Something else arriving does not take it away.
  act(() => {
    shell.sendEvent({ kind: "output_sweep", removed: 0, kept: 0, unreadable: false });
  });
  expect(debugState().notices.firstClose).toBe(true);
  // A notice that isn't a yes or a no changes nothing.
  act(() => {
    shell.sendEvent({ kind: "first_close", explain: "yes" });
  });
  expect(debugState().notices.firstClose).toBe(true);
  act(() => {
    shell.sendEvent({ kind: "first_close", explain: false });
  });
  expect(debugState().notices.firstClose).toBe(false);
});
