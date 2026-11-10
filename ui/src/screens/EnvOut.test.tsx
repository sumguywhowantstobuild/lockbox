// Task 17's screens, out: the folder's menu, Copy all as .env and Save as .env file (15d to 15f). The text is made and put on the
// clipboard, or written to a file, in Rust: the page sends a folder's id and hears whether it worked.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import App from "../App";
import { debugState, resetStoreForTests } from "../store";
import { expectNoAxe } from "../testing/axe";
import {
  ENV_TWICE,
  FOLDER,
  FOLDER_2,
  installFakeShell,
  itemId,
  NO_KEYS,
  PASSWORD,
  SAVED_FOLDER,
  sampleItems,
  type FakeItem,
  type FakeShell,
} from "../testing/fakeShell";

const { invoke, listen } = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

let shell: FakeShell;

beforeEach(() => {
  for (const style of document.querySelectorAll("style")) style.remove();
  resetStoreForTests();
  invoke.mockReset();
  listen.mockReset();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-10T12:00:00Z"));
});

const UNENCRYPTED = "The saved file is not encrypted, so anyone who can open it can read these keys.";
const DELETE_IT = "This copy isn't encrypted. Delete it when you're finished.";

/** The sample vault with two keys in Agency support agent (FOLDER), and a key in the trash in Lineproof (FOLDER_2). */
function withKeys(): FakeItem[] {
  return [
    ...sampleItems(),
    { id: itemId(30), kind: "key", title: "OPENAI_API_KEY", collection: FOLDER, value: "demo-out-1" },
    { id: itemId(31), kind: "key", title: "TELEGRAM_BOT_TOKEN", collection: FOLDER, value: "demo-out-2" },
    { id: itemId(32), kind: "key", title: "GONE_KEY", collection: FOLDER_2, value: "demo-out-3", trashed: true },
  ];
}

async function unlocked(items: FakeItem[] = withKeys(), settings = { idle_minutes: 5, clipboard_seconds: 30 }) {
  shell = installFakeShell(invoke, listen, [{ id: 7, name: "My vault", items }], settings);
  const view = render(<App />);
  const field = await screen.findByLabelText(/^Password for /);
  fireEvent.change(field, { target: { value: PASSWORD } });
  fireEvent.submit((field as HTMLInputElement).form as HTMLFormElement);
  await screen.findByRole("heading", { level: 1, name: "All items" });
  return view;
}

function sent(cmd: string): Record<string, unknown>[] {
  return invoke.mock.calls.filter(([name]) => name === cmd).map(([, args]) => args as Record<string, unknown>);
}

async function openFolder(name: string) {
  const rail = screen.getByRole("navigation", { name: "Vault and folders" });
  fireEvent.click(within(rail).getByRole("button", { name: new RegExp(`^${name}\\s+\\d+$`) }));
  await screen.findByRole("heading", { level: 1, name });
}

async function openFolderMenu(): Promise<HTMLElement> {
  const button = screen.getByRole("button", { name: "More for this folder" });
  button.focus();
  fireEvent.pointerDown(button, { button: 0 });
  fireEvent.click(button);
  return screen.findByRole("menu");
}

async function choose(name: string) {
  const menu = await openFolderMenu();
  fireEvent.click(within(menu).getByRole("menuitem", { name }));
}

function toastText(): string {
  return document.querySelector(".tstack")?.textContent ?? "";
}

async function lockNow() {
  const live = shell.sessionOf(7);
  expect(live).toBeDefined();
  await act(async () => {
    shell.lock(live?.session ?? 0);
    await Promise.resolve();
  });
  await screen.findByLabelText(/^Password for /);
}

test("the_folders_menu_has_its_entries_in_order_and_a_divider_before_rename", async () => {
  await unlocked();
  await openFolder("Agency support agent");
  const menu = await openFolderMenu();
  expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
    "Paste a .env",
    "Copy all as .env",
    "Save as .env file",
    "Rename folder",
    "Delete folder",
  ]);
  const parts = Array.from(menu.querySelectorAll('[role="menuitem"], [role="separator"]')).map((part) => part.getAttribute("role"));
  expect(parts).toEqual(["menuitem", "menuitem", "menuitem", "separator", "menuitem", "menuitem"]);
  // Save all files waits for a later plan.
  expect(within(menu).queryByText(/Save all/i)).toBeNull();
  await expectNoAxe(menu);
});

test("a_folder_with_no_key_leaves_out_the_two_taking_out_entries", async () => {
  await unlocked();
  // Lineproof holds a login and a key that is in the trash: nothing to take out, so no entry that leads nowhere.
  await openFolder("Lineproof");
  const menu = await openFolderMenu();
  expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Paste a .env", "Rename folder", "Delete folder"]);
  const parts = Array.from(menu.querySelectorAll('[role="menuitem"], [role="separator"]')).map((part) => part.getAttribute("role"));
  expect(parts).toEqual(["menuitem", "separator", "menuitem", "menuitem"]);
});

test("copy_all_shows_the_copied_message_with_its_countdown", async () => {
  await unlocked();
  await openFolder("Agency support agent");
  await choose("Copy all as .env");
  await waitFor(() => {
    expect(toastText()).toContain("Keys copied");
  });
  expect(toastText()).toContain("clears in 30 s");
  const copies = sent("env_copy");
  expect(copies).toHaveLength(1);
  expect(Object.keys(copies[0] ?? {}).sort()).toEqual(["collection", "generation", "session"]);
  expect(copies[0]?.collection).toBe(FOLDER);
  expect(shell.envCopied).toEqual([FOLDER]);
  // The text stays in Rust: the page was told "Done" and nothing else.
  expect(document.body.textContent).not.toContain("demo-out-");
});

test("a_duplicate_says_the_name_and_copies_nothing", async () => {
  await unlocked([...withKeys(), { id: itemId(33), kind: "key", title: "OPENAI_API_KEY", collection: FOLDER, value: "demo-out-4" }]);
  await openFolder("Agency support agent");
  await choose("Copy all as .env");
  await waitFor(() => {
    expect(toastText()).toContain("OPENAI_API_KEY appears twice in this folder. Rename or move one, then try again.");
  });
  expect(toastText()).not.toContain("Keys copied");
  expect(shell.envCopied).toEqual([]);
  // It stays until it is read: a long sentence, and one the person has to act on.
  expect(screen.getByRole("alert").textContent).toContain("OPENAI_API_KEY appears twice");
});

test("a_refused_copy_says_its_words", async () => {
  await unlocked();
  await openFolder("Agency support agent");
  shell.refuseNext("env_copy", NO_KEYS);
  await choose("Copy all as .env");
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("This folder has no keys. Add a key first.");
});

test("a_lock_before_the_copy_answers_says_nothing", async () => {
  await unlocked();
  await openFolder("Agency support agent");
  await choose("Copy all as .env");
  await lockNow();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(toastText()).toBe("");
});

test("save_file_warns_not_encrypted", async () => {
  const { container } = await unlocked();
  await openFolder("Agency support agent");
  await choose("Save as .env file");
  const dialog = await screen.findByRole("dialog", { name: "Save as .env file" });
  expect(within(dialog).getByText(UNENCRYPTED)).toBeTruthy();
  expect(within(dialog).getAllByRole("button").map((button) => button.textContent)).toEqual(["Cancel", "Save"]);
  // Nothing is written, and nothing asked of Rust, until Save.
  expect(sent("env_save_file")).toEqual([]);
  await expectNoAxe(container);

  // Cancel closes it, sends nothing, and gives focus back to the folder's menu.
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(sent("env_save_file")).toEqual([]);
  await waitFor(() => {
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "More for this folder" }));
  });
});

test("save_sends_the_folder_and_says_where_it_went_and_that_it_is_not_encrypted", async () => {
  await unlocked();
  await openFolder("Agency support agent");
  await choose("Save as .env file");
  const dialog = await screen.findByRole("dialog", { name: "Save as .env file" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
  await waitFor(() => {
    expect(toastText()).toContain(`Saved in ${SAVED_FOLDER}. ${DELETE_IT}`);
  });
  const saves = sent("env_save_file");
  expect(saves).toHaveLength(1);
  expect(Object.keys(saves[0] ?? {}).sort()).toEqual(["collection", "generation", "session"]);
  expect(saves[0]?.collection).toBe(FOLDER);
  expect(shell.envFiles).toEqual([FOLDER]);
  expect(screen.queryByRole("dialog")).toBeNull();
  // The folder's own path is the person's to read: shown, and never sent back.
  expect(JSON.stringify(sent("env_save_file"))).not.toContain(SAVED_FOLDER);
});

test("a_dismissed_save_does_nothing", async () => {
  await unlocked();
  await openFolder("Agency support agent");
  await choose("Save as .env file");
  shell.dismissPdfNext();
  fireEvent.click(within(await screen.findByRole("dialog", { name: "Save as .env file" })).getByRole("button", { name: "Save" }));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(sent("env_save_file")).toHaveLength(1);
  expect(shell.envFiles).toEqual([]);
  expect(toastText()).toBe("");
  expect(screen.queryByRole("alert")).toBeNull();
});

test("cloud_warning_shows_15f", async () => {
  const { container } = await unlocked();
  await openFolder("Agency support agent");
  await choose("Save as .env file");
  shell.cloudPdfNext();
  fireEvent.click(within(await screen.findByRole("dialog", { name: "Save as .env file" })).getByRole("button", { name: "Save" }));
  const dialog = await screen.findByRole("dialog", { name: "This folder is synced to the cloud" });
  expect(within(dialog).getByText("This file would be uploaded unprotected.")).toBeTruthy();
  expect(within(dialog).getAllByRole("button").map((button) => button.textContent)).toEqual(["Continue", "Pick another folder"]);
  // Nothing is written yet, and the safe answer has the first focus.
  expect(shell.envFiles).toEqual([]);
  await waitFor(() => {
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Pick another folder" }));
  });
  await expectNoAxe(container);

  // Continue goes on with the save the shell parked, by its token.
  fireEvent.click(within(dialog).getByRole("button", { name: "Continue" }));
  await waitFor(() => {
    expect(toastText()).toContain(`Saved in ${SAVED_FOLDER}. ${DELETE_IT}`);
  });
  const confirms = sent("save_readable_confirm");
  expect(confirms).toHaveLength(1);
  expect(Object.keys(confirms[0] ?? {})).toEqual(["token"]);
  expect(shell.envFiles).toEqual([FOLDER]);
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("pick_another_folder_asks_the_shell_again_and_escape_leaves_nothing_written", async () => {
  await unlocked();
  await openFolder("Agency support agent");
  await choose("Save as .env file");
  shell.cloudPdfNext();
  fireEvent.click(within(await screen.findByRole("dialog", { name: "Save as .env file" })).getByRole("button", { name: "Save" }));
  const dialog = await screen.findByRole("dialog", { name: "This folder is synced to the cloud" });
  // Pick another folder is the same save again: the shell opens its folder picker afresh.
  fireEvent.click(within(dialog).getByRole("button", { name: "Pick another folder" }));
  await waitFor(() => {
    expect(toastText()).toContain(`Saved in ${SAVED_FOLDER}.`);
  });
  expect(sent("env_save_file")).toHaveLength(2);
  expect(sent("save_readable_confirm")).toEqual([]);
  expect(shell.envFiles).toEqual([FOLDER]);

  // Escape on the question writes nothing: the parked save stays parked.
  await choose("Save as .env file");
  shell.cloudPdfNext();
  fireEvent.click(within(await screen.findByRole("dialog", { name: "Save as .env file" })).getByRole("button", { name: "Save" }));
  const second = await screen.findByRole("dialog", { name: "This folder is synced to the cloud" });
  fireEvent.keyDown(within(second).getByRole("button", { name: "Pick another folder" }), { key: "Escape" });
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(shell.envFiles).toEqual([FOLDER]);
  expect(sent("save_readable_confirm")).toEqual([]);
  await waitFor(() => {
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "More for this folder" }));
  });
});

test("a_duplicate_in_the_file_says_the_same_sentence_and_writes_nothing", async () => {
  await unlocked([...withKeys(), { id: itemId(33), kind: "key", title: "TELEGRAM_BOT_TOKEN", collection: FOLDER, value: "demo-out-5" }]);
  await openFolder("Agency support agent");
  await choose("Save as .env file");
  fireEvent.click(within(await screen.findByRole("dialog", { name: "Save as .env file" })).getByRole("button", { name: "Save" }));
  await waitFor(() => {
    expect(toastText()).toContain("TELEGRAM_BOT_TOKEN appears twice in this folder. Rename or move one, then try again.");
  });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(shell.envFiles).toEqual([]);
  expect(toastText()).not.toContain("Saved in");
});

test("a_refused_save_says_its_words_in_the_table", async () => {
  await unlocked();
  await openFolder("Agency support agent");
  await choose("Save as .env file");
  shell.refuseNext("env_save_file", ENV_TWICE);
  fireEvent.click(within(await screen.findByRole("dialog", { name: "Save as .env file" })).getByRole("button", { name: "Save" }));
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("A key name is in this folder twice. Rename or move one, then try again.");
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("a_stale_answer_shows_nothing", async () => {
  await unlocked();
  await openFolder("Agency support agent");
  await choose("Save as .env file");
  const release = shell.holdPrint();
  fireEvent.click(within(await screen.findByRole("dialog", { name: "Save as .env file" })).getByRole("button", { name: "Save" }));
  // The vault locks while the shell has the save: no file appears and nothing is said.
  await lockNow();
  release();
  await act(async () => {
    await Promise.resolve();
  });
  expect(shell.envFiles).toEqual([]);
  expect(screen.queryByRole("alert")).toBeNull();
  expect(document.body.textContent).not.toContain("Saved in");
});

test("an_expired_cloud_question_says_so_and_keeps_the_session_on_the_page_and_in_the_engine", async () => {
  await unlocked();
  await openFolder("Agency support agent");
  await choose("Save as .env file");
  shell.cloudPdfNext();
  fireEvent.click(within(await screen.findByRole("dialog", { name: "Save as .env file" })).getByRole("button", { name: "Save" }));
  const dialog = await screen.findByRole("dialog", { name: "This folder is synced to the cloud" });
  // The shell dropped the question it had parked (five minutes passed, and nothing locked the vault): the yes is `not_found`.
  shell.dropParkedChoices();
  fireEvent.click(within(dialog).getByRole("button", { name: "Continue" }));
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("That took too long, so nothing was saved. Choose Save as .env file again.");
  expect(sent("save_readable_confirm")).toHaveLength(1);
  // The question is closed, and the vault was not locked: the page and the engine both still have the session.
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(screen.getByRole("heading", { level: 1, name: "Agency support agent" })).toBeTruthy();
  expect(debugState().sessions).toHaveLength(1);
  expect(shell.sessionOf(7)?.unlocked).toBe(true);
  expect(shell.envFiles).toEqual([]);
  // And it can be done again.
  await choose("Save as .env file");
  fireEvent.click(within(await screen.findByRole("dialog", { name: "Save as .env file" })).getByRole("button", { name: "Save" }));
  await waitFor(() => {
    expect(toastText()).toContain(`Saved in ${SAVED_FOLDER}.`);
  });
  expect(shell.envFiles).toEqual([FOLDER]);
});

test("a_missed_lock_on_the_cloud_question_takes_the_session_off_and_says_nothing", async () => {
  await unlocked();
  await openFolder("Agency support agent");
  await choose("Save as .env file");
  shell.cloudPdfNext();
  fireEvent.click(within(await screen.findByRole("dialog", { name: "Save as .env file" })).getByRole("button", { name: "Save" }));
  const dialog = await screen.findByRole("dialog", { name: "This folder is synced to the cloud" });
  // The vault locks (its parked question goes with it) and the page never hears the lock event.
  shell.lockWithoutEvent(shell.sessionOf(7)?.session ?? 0);
  fireEvent.click(within(dialog).getByRole("button", { name: "Continue" }));
  // The shell is asked about the session, says it is locked, and the session leaves the page: nothing is said, nothing is written.
  await screen.findByLabelText(/^Password for /);
  expect(sent("save_readable_confirm")).toHaveLength(1);
  expect(debugState().sessions).toEqual([]);
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.body.textContent).not.toContain("took too long");
  expect(shell.envFiles).toEqual([]);
});

test("a_stale_answer_to_the_lookup_takes_the_session_off_and_says_nothing", async () => {
  await unlocked();
  await openFolder("Agency support agent");
  await choose("Save as .env file");
  shell.cloudPdfNext();
  fireEvent.click(within(await screen.findByRole("dialog", { name: "Save as .env file" })).getByRole("button", { name: "Save" }));
  const dialog = await screen.findByRole("dialog", { name: "This folder is synced to the cloud" });
  shell.dropParkedChoices();
  // The shell answers the lookup tagged with another generation than the bridge knows (the vault locked and the page missed the event):
  // the bridge calls the answer stale, which is the same news as a `locked` refusal.
  const real = invoke.getMockImplementation();
  if (real === undefined) throw new Error("no fake shell");
  invoke.mockImplementation((cmd: string, args?: unknown) =>
    cmd === "list_items"
      ? (real(cmd, args) as Promise<{ generation: number }>).then((answer) => ({ ...answer, generation: answer.generation + 1 }))
      : (real(cmd, args) as Promise<unknown>),
  );
  fireEvent.click(within(dialog).getByRole("button", { name: "Continue" }));
  await screen.findByLabelText(/^Password for /);
  expect(sent("list_items").length).toBeGreaterThan(1);
  expect(debugState().sessions).toEqual([]);
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.body.textContent).not.toContain("took too long");
  expect(shell.envFiles).toEqual([]);
});

test("a_lookup_that_fails_another_way_says_why_and_keeps_the_session", async () => {
  await unlocked();
  await openFolder("Agency support agent");
  await choose("Save as .env file");
  shell.cloudPdfNext();
  fireEvent.click(within(await screen.findByRole("dialog", { name: "Save as .env file" })).getByRole("button", { name: "Save" }));
  const dialog = await screen.findByRole("dialog", { name: "This folder is synced to the cloud" });
  shell.dropParkedChoices();
  // The question is gone, and the shell's answer to the lookup that follows is a busy vault: that is what is said.
  shell.refuseNext("list_items", { code: "busy" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Continue" }));
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("That vault is busy.");
  expect(alert.textContent).not.toContain("took too long");
  expect(debugState().sessions).toHaveLength(1);
  expect(shell.sessionOf(7)?.unlocked).toBe(true);
});

test("cancel_does_nothing_while_the_save_runs_and_the_warning_stays", async () => {
  await unlocked();
  await openFolder("Agency support agent");
  await choose("Save as .env file");
  const dialog = await screen.findByRole("dialog", { name: "Save as .env file" });
  const release = shell.holdPrint();
  fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
  await waitFor(() => {
    expect(within(dialog).getByRole("button", { name: "Cancel" }).getAttribute("aria-disabled")).toBe("true");
  });
  // Cancel, while Rust may still write the file, leaves the warning where it is.
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("dialog", { name: "Save as .env file" })).not.toBeNull();
  // The save goes on to its end, and then the dialog goes.
  release();
  await waitFor(() => {
    expect(toastText()).toContain(`Saved in ${SAVED_FOLDER}.`);
  });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(shell.envFiles).toEqual([FOLDER]);
  expect(sent("env_save_file")).toHaveLength(1);
});

test("the_cloud_question_after_a_lock_says_nothing_either", async () => {
  await unlocked();
  await openFolder("Agency support agent");
  await choose("Save as .env file");
  shell.cloudPdfNext();
  fireEvent.click(within(await screen.findByRole("dialog", { name: "Save as .env file" })).getByRole("button", { name: "Save" }));
  await screen.findByRole("dialog", { name: "This folder is synced to the cloud" });
  await lockNow();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(shell.envFiles).toEqual([]);
  expect(screen.queryByRole("alert")).toBeNull();
});
