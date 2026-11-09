import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import App from "../App";
import { messageFor, messageText } from "../messages";
import { resetStoreForTests, sayOnLockScreen } from "../store";
import { expectNoAxe } from "../testing/axe";
import {
  installFakeShell,
  NEWER_VAULT,
  PASSWORD,
  sampleItems,
  VAULT_LIST_DAMAGED,
  type FakeShell,
  type FakeVault,
} from "../testing/fakeShell";
import { readBeside } from "../testing/files";

const { invoke, listen } = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));

afterEach(cleanup);

let shell: FakeShell;

beforeEach(() => {
  resetStoreForTests();
  invoke.mockReset();
  listen.mockReset();
});

const ASK3_TITLE = "My vault's details were changed outside Lockbox.";
const ASK3_BODY =
  "Its name, or other details kept beside your items, don't match what Lockbox last saved. Moving a vault or restoring a backup doesn't cause this. If you edited that file yourself, accept it. If you didn't, lock it and check your PC first; restoring a backup you trust is the safer way back. Backups stay off until you accept.";
const ASK11 =
  "Lockbox lost track of some opened files. Its record of files you opened is damaged, so it can't clean them up. Until you set the record aside, backing up, Save a copy and Open stay off.";
const SWEEP_UNREADABLE = { kind: "output_sweep", removed: 0, kept: 0, unreadable: true };

function vault(extra: Partial<FakeVault> = {}): FakeVault {
  return { id: 7, name: "My vault", items: sampleItems(), ...extra };
}

/** The element the last `start` drew in: a dialog is drawn inside the app's own element, so it holds the dialogs too. */
let drawn: Element = document.body;

function start(vaults: FakeVault[], notices: object[] = []) {
  shell = installFakeShell(invoke, listen, vaults);
  shell.setLaunchNotices(notices);
  const view = render(<App />);
  drawn = view.container;
  return view;
}

async function unlockIt(password = PASSWORD): Promise<void> {
  const field = await screen.findByLabelText(/^Password for /);
  fireEvent.change(field, { target: { value: password } });
  fireEvent.submit((field as HTMLInputElement).form as HTMLFormElement);
}

function commandsSent(): string[] {
  return shell.calls.map((call) => call.cmd);
}

function buttonNames(): string[] {
  return screen.queryAllByRole("button").map((button) => button.textContent);
}

async function askThree() {
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByRole("heading", { name: ASK3_TITLE })).toBeTruthy();
  return dialog;
}

test("ask3_accept_calls_accept_header", async () => {
  start([vault({ headerChanged: true })]);
  await unlockIt();
  const dialog = await askThree();
  // The design's words, word for word, and the two answers in the design's order.
  expect(within(dialog).getByText(ASK3_BODY)).toBeTruthy();
  expect(within(dialog).getAllByRole("button").map((button) => button.textContent)).toEqual(["Lock this vault", "Accept"]);
  // The safe answer holds focus first, and Escape is not a yes: the question stays until it is answered.
  await waitFor(() => {
    expect(document.activeElement?.textContent).toBe("Lock this vault");
  });
  fireEvent.keyDown(dialog, { key: "Escape" });
  expect(screen.getByRole("dialog")).toBeTruthy();
  expect(commandsSent()).not.toContain("accept_header");

  fireEvent.click(within(dialog).getByRole("button", { name: "Accept" }));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  const live = shell.sessionOf(7);
  expect(invoke).toHaveBeenCalledWith("accept_header", { session: live?.session, generation: live?.generation });
  expect(screen.getByRole("heading", { level: 1, name: "All items" })).toBeTruthy();
  expect(commandsSent()).not.toContain("lock_vault");
});

test("ask3_lock_this_vault_locks_it", async () => {
  start([vault({ headerChanged: true })]);
  await unlockIt();
  const dialog = await askThree();
  const before = shell.sessionOf(7);
  fireEvent.click(within(dialog).getByRole("button", { name: "Lock this vault" }));
  expect(await screen.findByRole("heading", { level: 1, name: "Unlock My vault" })).toBeTruthy();
  expect(invoke).toHaveBeenCalledWith("lock_vault", { session: before?.session });
  expect(shell.sessionOf(7)?.unlocked).toBe(false);
  expect(commandsSent()).not.toContain("accept_header");
  // Locking is an answer, not a failure.
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("ask3_comes_back_at_next_unlock", async () => {
  start([vault({ headerChanged: true })]);
  await unlockIt();
  fireEvent.click(within(await askThree()).getByRole("button", { name: "Lock this vault" }));
  await screen.findByRole("heading", { level: 1, name: "Unlock My vault" });
  // Unlocking again: the shell reports the change again, and the page has kept nothing that would hide it.
  await unlockIt();
  await askThree();
  expect(commandsSent().filter((cmd) => cmd === "unlock_vault")).toHaveLength(2);
  expect(commandsSent()).not.toContain("accept_header");
});

test("ask3_comes_before_the_new_key_screen", async () => {
  start([vault({ headerChanged: true, unconfirmed: true })]);
  await unlockIt();
  const dialog = await askThree();
  // The engine refuses a new key while the change waits, so none is asked for, and the key screen is not shown.
  expect(commandsSent()).not.toContain("regenerate_recovery");
  expect(screen.queryByRole("heading", { level: 1, name: "Finish your recovery key" })).toBeNull();

  fireEvent.click(within(dialog).getByRole("button", { name: "Accept" }));
  expect(await screen.findByRole("heading", { level: 1, name: "Finish your recovery key" })).toBeTruthy();
  const order = commandsSent().filter((cmd) => ["unlock_vault", "accept_header", "regenerate_recovery"].includes(cmd));
  expect(order).toEqual(["unlock_vault", "accept_header", "regenerate_recovery"]);
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("ask3_lock_leaves_the_new_key_for_the_next_unlock", async () => {
  start([vault({ headerChanged: true, unconfirmed: true })]);
  await unlockIt();
  fireEvent.click(within(await askThree()).getByRole("button", { name: "Lock this vault" }));
  await screen.findByRole("heading", { level: 1, name: "Unlock My vault" });
  expect(commandsSent()).not.toContain("regenerate_recovery");
  expect(shell.unconfirmed(7)).toBe(true);
  // Next unlock: Ask 3 first again, and still no key until it is accepted.
  await unlockIt();
  await askThree();
  expect(commandsSent()).not.toContain("regenerate_recovery");
});

test("ask3_closes_with_no_error_when_the_vault_locks", async () => {
  start([vault({ headerChanged: true })]);
  await unlockIt();
  await askThree();
  // The idle timer, or Windows, locks the vault while the question shows.
  act(() => {
    const live = shell.sessionOf(7);
    shell.lock(live?.session ?? -1, "idle");
  });
  expect(await screen.findByRole("heading", { level: 1, name: "Unlock My vault" })).toBeTruthy();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
});

test("ask3_late_lock_answer_leaves_a_newer_unlock_alone", async () => {
  // The lock happens and its event arrives at once, but the command's own answer is slow: the person unlocks again first.
  for (const [how, answer] of [
    ["answers", null],
    ["is refused as busy", { code: "busy" }],
    ["is refused as locked", { code: "locked" }],
  ] as const) {
    resetStoreForTests();
    invoke.mockReset();
    listen.mockReset();
    const { unmount } = start([vault({ headerChanged: true })]);
    const real = invoke.getMockImplementation();
    if (real === undefined) throw new Error("no fake shell");
    let settle: () => void = () => undefined;
    invoke.mockImplementation((cmd: string, args?: unknown) => {
      if (cmd !== "lock_vault") return real(cmd, args) as Promise<unknown>;
      return (real(cmd, args) as Promise<unknown>).then(
        () =>
          new Promise((resolve, reject) => {
            settle = () => {
              if (answer === null) resolve(null);
              // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- Tauri rejects with the plain object
              else reject(answer);
            };
          }),
      );
    });
    await unlockIt();
    fireEvent.click(within(await askThree()).getByRole("button", { name: "Lock this vault" }));
    await screen.findByRole("heading", { level: 1, name: "Unlock My vault" });
    // Unlocked again, and asked again.
    await unlockIt();
    const dialog = await askThree();
    const again = shell.sessionOf(7);
    expect(again?.unlocked, how).toBe(true);

    // Now the first command's answer comes in.
    await act(async () => {
      settle();
      await Promise.resolve();
    });
    // The new session is still on the page, with no refusal of the old one in it, and its buttons work.
    expect(screen.getByRole("dialog"), how).toBe(dialog);
    expect(within(dialog).queryByRole("alert"), how).toBeNull();
    expect(within(dialog).getByRole<HTMLButtonElement>("button", { name: "Accept" }).disabled, how).toBe(false);
    expect(shell.sessionOf(7)?.generation, how).toBe(again?.generation);
    unmount();
  }
});

test("ask3_a_refusal_is_said_in_words_and_the_question_stays", async () => {
  const SENTINEL = "SENTINEL-header";
  start([vault({ headerChanged: true, readOnly: true })]);
  const real = invoke.getMockImplementation();
  if (real === undefined) throw new Error("no fake shell");
  invoke.mockImplementation((cmd: string, args?: unknown) =>
    cmd === "accept_header"
      ? // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- Tauri rejects with the plain object
        Promise.reject({ code: "read_only", what: SENTINEL })
      : (real(cmd, args) as Promise<unknown>),
  );
  await unlockIt();
  const dialog = await askThree();
  fireEvent.click(within(dialog).getByRole("button", { name: "Accept" }));
  const said = await within(dialog).findByRole("alert");
  expect(said.textContent).toBe(messageText(messageFor({ code: "read_only" })));
  expect(document.body.textContent).not.toContain(SENTINEL);
  // Still asking, and both answers still there.
  expect(within(dialog).getAllByRole("button").map((button) => button.textContent)).toEqual(["Lock this vault", "Accept"]);
});

test("ask4_counts_unreadable_items_and_closes", async () => {
  const { container } = start([vault({ unreadable: 3 })]);
  await unlockIt();
  const words =
    "3 items in this vault can't be read. Everything else works. They may be damaged, so Lockbox left all stored files where they are until this is sorted.";
  expect(await screen.findByText(words)).toBeTruthy();
  // A banner, not a dialog: nothing holds focus, and with its buttons held back to 4B it has only Close.
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(buttonNames()).toContain("Close");
  expect(screen.queryByRole("button", { name: /Restore a backup|Open a backup/ })).toBeNull();
  await expectNoAxe(container);

  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(screen.queryByText(words)).toBeNull();
  // The list stays, and the shell reports it again at the next unlock (the page keeps no memory of the Close).
  expect(screen.getByRole("heading", { level: 1, name: "All items" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Lock all" }));
  await unlockIt();
  expect(await screen.findByText(words)).toBeTruthy();
});

test("ask4_one_item_reads_as_one", async () => {
  start([vault({ unreadable: 1 })]);
  await unlockIt();
  expect(
    await screen.findByText(
      "1 item in this vault can't be read. Everything else works. It may be damaged, so Lockbox left all stored files where they are until this is sorted.",
    ),
  ).toBeTruthy();
});

test("ask5_banner_closes_with_no_delete", async () => {
  const { container } = start([vault({ leftover: 2 })]);
  await unlockIt();
  const words = "2 leftover files have no item that uses them.";
  expect(await screen.findByText(words)).toBeTruthy();
  expect(screen.queryByRole("dialog")).toBeNull();
  // Count only: the sentences about "these files", their date and size wait for the list (4B), and so does Delete.
  expect(container.textContent).not.toMatch(/these files|date and size|Delete them all/);
  expect(screen.queryByRole("button", { name: /Delete|Restore a backup/ })).toBeNull();
  await expectNoAxe(container);

  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(screen.queryByText(words)).toBeNull();
  expect(commandsSent()).not.toContain("delete_orphans");
  expect(commandsSent()).not.toContain("list_orphans");
});

test("ask9_later_closes_it", async () => {
  const { container } = start([vault({ usedBackupHeader: true })]);
  await unlockIt();
  const words =
    "Opened from the backup copy of this vault's details. If you changed this vault's password recently, it may need your previous password.";
  expect(await screen.findByText(words)).toBeTruthy();
  // The sentence that sends the person to Change password waits for the screen that does it (4C).
  expect(container.textContent).not.toContain("Change the password again");
  expect(screen.queryByRole("button", { name: "Change password" })).toBeNull();
  await expectNoAxe(container);
  fireEvent.click(screen.getByRole("button", { name: "Later" }));
  expect(screen.queryByText(words)).toBeNull();
});

test("ask10_names_the_provider", async () => {
  const names = [
    ["OneDrive", "OneDrive"],
    ["GoogleDrive", "Google Drive"],
    ["Dropbox", "Dropbox"],
    ["Other", "A cloud service"],
  ] as const;
  for (const [provider, said] of names) {
    resetStoreForTests();
    invoke.mockReset();
    listen.mockReset();
    const { container, unmount } = start([vault({ cloud: provider })]);
    await unlockIt();
    const words = `${said} syncs My vault's folder. Lockbox doesn't support vaults in cloud folders. To stop this message, move the vault to a folder on this PC.`;
    expect(await screen.findByText(words), provider).toBeTruthy();
    // The provider is named by its everyday name, never the shell's own spelling.
    expect(container.textContent).not.toContain("GoogleDrive");
    expect(screen.queryByRole("button", { name: "Show in Explorer" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Keep it there" }));
    expect(screen.queryByText(words)).toBeNull();
    unmount();
  }
});

test("ask11_set_aside_calls_reset", async () => {
  const { container } = start([vault()], [SWEEP_UNREADABLE]);
  expect(await screen.findByText(ASK11)).toBeTruthy();
  await expectNoAxe(container);
  // It is there on the lock screen and stays with the person into the vault, until the record is set aside.
  await unlockIt();
  expect(await screen.findByRole("heading", { level: 1, name: "All items" })).toBeTruthy();
  expect(screen.getByText(ASK11)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Close" })).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Set it aside" }));
  await waitFor(() => {
    expect(screen.queryByText(ASK11)).toBeNull();
  });
  expect(shell.outputJournalResets()).toBe(1);
  expect(invoke).toHaveBeenCalledWith("reset_output_journal", {});
});

test("ask11_is_only_for_a_record_that_could_not_be_read", async () => {
  start([vault()], [{ kind: "output_sweep", removed: 2, kept: 1, unreadable: false }, { kind: "open_cleanup", removed: 0, still_open: 1 }]);
  await screen.findByRole("heading", { level: 1, name: "Unlock My vault" });
  await waitFor(() => {
    expect(commandsSent()).toContain("launch_notices");
  });
  expect(screen.queryByText(ASK11)).toBeNull();
  expect(screen.queryByRole("button", { name: "Set it aside" })).toBeNull();
});

test("ask11_arrives_as_an_event_too", async () => {
  start([vault()]);
  await screen.findByRole("heading", { level: 1, name: "Unlock My vault" });
  await waitFor(() => {
    expect(commandsSent()).toContain("launch_notices");
  });
  expect(screen.queryByText(ASK11)).toBeNull();
  act(() => {
    shell.tell(SWEEP_UNREADABLE);
  });
  expect(await screen.findByText(ASK11)).toBeTruthy();
});

test("ask13_newer_vault_has_no_buttons", async () => {
  const { container } = start([vault({ newer: true })]);
  await unlockIt();
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toBe("Update Lockbox to open this vault. A newer version made it.");
  expect(messageFor(NEWER_VAULT)).toEqual({ title: "Update Lockbox to open this vault.", body: "A newer version made it." });
  // The design gives it no button: the lock screen's own Unlock is the only one.
  expect(buttonNames()).toEqual(["Unlock"]);
  await expectNoAxe(container);
});

test("ask16_says_the_change_was_saved", async () => {
  const { container } = start([vault()]);
  await screen.findByRole("heading", { level: 1, name: "Unlock My vault" });
  // What the change-password screen of 4C hands over when its refusal says the vault locked after the change; nothing
  // in 4A can send it.
  act(() => {
    sayOnLockScreen({ code: "locked_after_change", what: "password" });
  });
  const words = "Your new password was saved, but the vault locked before Lockbox could say so. Unlock with the new one.";
  expect(await screen.findByText(words)).toBeTruthy();
  expect(buttonNames()).toEqual(["Unlock"]);
  await expectNoAxe(container);
  // Unlocking with the new password is what it asked for: the note goes.
  await unlockIt();
  await screen.findByRole("heading", { level: 1, name: "All items" });
  fireEvent.click(screen.getByRole("button", { name: "Lock all" }));
  await screen.findByRole("heading", { level: 1, name: "Unlock My vault" });
  expect(screen.queryByText(words)).toBeNull();
});

test("unavailable_vault_says_so", async () => {
  const { container } = start([{ id: 7, name: null, available: false }]);
  const words = messageText(messageFor({ code: "core", kind: "io" }));
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toBe(words);
  expect(words).toBe("Lockbox couldn't reach that folder or file. Check that the drive is connected, then try again.");
  // Nothing to unlock and nothing that leads nowhere.
  expect(screen.queryByLabelText(/^Password for /)).toBeNull();
  expect(buttonNames()).toEqual([]);
  await expectNoAxe(container);
});

test("an_unavailable_vault_in_the_list_is_marked", async () => {
  start([vault(), { id: 8, name: "Old laptop", available: false }]);
  expect(await screen.findByText("Not available")).toBeTruthy();
  expect(screen.getByRole<HTMLInputElement>("radio", { name: /Old laptop/ }).disabled).toBe(true);
});

test("restore_notice_shows_words_with_no_buttons_until_4b", async () => {
  const { container } = start([vault()], [{ kind: "restore", state: "recovered", how: "finished" }]);
  const words = "Lockbox finished restoring a vault. Unlock with the password from when that backup was made.";
  expect(await screen.findByText(words)).toBeTruthy();
  // Words only: no button of its own (the lock screen's Unlock is the answer).
  expect(buttonNames()).toEqual(["Unlock"]);
  await expectNoAxe(container);
  // Unlocking is the answer: it does not come back after the next lock.
  await unlockIt();
  await screen.findByRole("heading", { level: 1, name: "All items" });
  expect(screen.queryByText(words)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Lock all" }));
  await screen.findByRole("heading", { level: 1, name: "Unlock My vault" });
  expect(screen.queryByText(words)).toBeNull();
});

test("a_restore_notice_of_4b_shows_nothing_and_no_path", async () => {
  const PATH = "C:\\Vaults\\SENTINEL-restore";
  const paths = { step: "swapping", staging: PATH, target: PATH, before_restore: PATH };
  const { container } = start(
    [vault()],
    [
      { kind: "restore", state: "drive_missing", paths },
      { kind: "restore", state: "unclear", journal: PATH, paths: null },
    ],
  );
  await screen.findByRole("heading", { level: 1, name: "Unlock My vault" });
  await waitFor(() => {
    expect(commandsSent()).toContain("launch_notices");
  });
  expect(container.textContent).not.toContain("SENTINEL");
  expect(buttonNames()).toEqual(["Unlock"]);
});

test("damaged_vault_list_shows_a_message", async () => {
  const { container } = start([vault()]);
  const real = invoke.getMockImplementation();
  if (real === undefined) throw new Error("no fake shell");
  invoke.mockImplementation((cmd: string, args?: unknown) =>
    cmd === "list_vaults"
      ? // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- Tauri rejects with the plain object
        Promise.reject(VAULT_LIST_DAMAGED)
      : (real(cmd, args) as Promise<unknown>),
  );
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toBe("Lockbox lost its list of vaults. Your vaults are still in their folders.");
  // Starting a new list is 4C's: until then no button leads there.
  expect(buttonNames()).toEqual([]);
  await expectNoAxe(container);
});

test("each_ask_passes_axe", async () => {
  const cases: { name: string; run: () => Promise<void> }[] = [
    {
      name: "Ask 3",
      run: async () => {
        start([vault({ headerChanged: true })]);
        await unlockIt();
        await askThree();
      },
    },
    {
      name: "Asks 4, 5, 9 and 10 together",
      run: async () => {
        start([vault({ unreadable: 2, leftover: 2, usedBackupHeader: true, cloud: "OneDrive" })]);
        await unlockIt();
        await screen.findByText("2 leftover files have no item that uses them.");
        await screen.findByText(/^OneDrive syncs/);
        expect(screen.getAllByRole("button", { name: "Close" })).toHaveLength(2);
      },
    },
    {
      name: "Ask 11 and the restore notice on the lock screen",
      run: async () => {
        start([vault()], [SWEEP_UNREADABLE, { kind: "restore", state: "recovered", how: "finished" }]);
        await screen.findByText(ASK11);
        await screen.findByText(/^Lockbox finished restoring a vault/);
      },
    },
    {
      name: "Ask 11 in the vault",
      run: async () => {
        start([vault()], [SWEEP_UNREADABLE]);
        await unlockIt();
        await screen.findByRole("heading", { level: 1, name: "All items" });
        await screen.findByText(ASK11);
      },
    },
    {
      name: "Ask 13",
      run: async () => {
        start([vault({ newer: true })]);
        await unlockIt();
        await screen.findByRole("alert");
      },
    },
    {
      name: "Ask 16",
      run: async () => {
        start([vault()]);
        await screen.findByRole("heading", { level: 1, name: "Unlock My vault" });
        act(() => {
          sayOnLockScreen({ code: "locked_after_change", what: "password" });
        });
        await screen.findByText(/^Your new password was saved/);
      },
    },
    {
      name: "an unavailable vault",
      run: async () => {
        start([{ id: 7, name: null, available: false }]);
        await screen.findByRole("alert");
      },
    },
  ];
  for (const { name, run } of cases) {
    resetStoreForTests();
    invoke.mockReset();
    listen.mockReset();
    await run();
    const container = drawn;
    // The dialog part sets style properties from script (allowed by the policy); the markup of the screens writes none.
    if (screen.queryByRole("dialog") === null) {
      expect(container.querySelectorAll("style, [style]"), `${name}: no style element or attribute`).toHaveLength(0);
    }
    await expectNoAxe(container);
    cleanup();
  }
});

test("asks_put_no_secret_or_path_in_a_title_or_a_label", () => {
  // The words come from fixed text and the vault's own name, never from a refusal or a path.
  const source = readBeside(import.meta.url, "./Asks.tsx");
  // No `aria-label`, and no `title` on a plain element (the Dialog part's own `title` is its heading's text).
  expect(source).not.toMatch(/\baria-label\b|<[a-z]+\s[^>]*\btitle=/);
  expect(source).not.toMatch(/style=|<style/);
});
