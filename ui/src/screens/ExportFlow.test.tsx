// Plan 4D Task 2's screens, the page half: export a vault to a readable file (34a the warning and the vault's password, 34b the refusals and the cloud
// question, 34c what to do afterwards). Rust writes the file; the page sends the password once and hears only the folder, counts and the titles of
// items whose values have line breaks. Every case runs through the real App against the pretend shell. Typed passwords are made up (`MU-`); a test of a
// wipe looks for them in the fields, the page and the store.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import App from "../App";
import { debugState, exportVault, openExport, resetStoreForTests } from "../store";
import { expectNoAxe } from "../testing/axe";
import {
  FOLDER,
  installFakeShell,
  itemId,
  LOCKED,
  PASSWORD,
  sampleItems,
  SAVED_FOLDER,
  type FakeItem,
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
  for (const style of document.querySelectorAll("style")) style.remove();
  resetStoreForTests();
  invoke.mockReset();
  listen.mockReset();
});

const WRONG_ONE = "MU-not the password";
const SECRETS = [PASSWORD, WRONG_ONE, "MU-typed"];

const FOR_THE_VAULT = "For My vault: logins, keys and notes. Stored files aren't included, and earlier passwords stay out.";
const WARNING = "Anyone who gets this file can read everything in it.";
const WRONG_CURRENT = "That isn't the current password.";
const EMPTY = "Type the password first.";
const IN_A_VAULT_FOLDER = "Lockbox won't save that inside a vault's folder. Choose another folder.";
const IN_THE_STATE_FOLDER = "Lockbox won't save that in its own settings folder. Choose another folder.";
const CLOUD_TITLE = "This folder is synced to the cloud";
const CLOUD_WORDS = "This file would be uploaded unprotected.";
const DELETE_IT = "This file isn't protected. Delete it once you're done with it, and empty the Recycle Bin.";
const LINE_BREAKS = "Another app may change the line breaks in the values of these items when it reads the file.";
const EXPIRED = "That took too long, so nothing was saved. Choose Export again.";

/** The values below carry line breaks on purpose: the titles of those rows are what 34c lists. */
const WITH_BREAKS = ["MU-Two line note", "MU_TWO_LINE_KEY", "MU-Login with CR"];

function items(): FakeItem[] {
  return [
    ...sampleItems(),
    { id: itemId(40), kind: "note", title: WITH_BREAKS[0] ?? "", collection: FOLDER, notes: "MU-first line\r\nMU-second line" },
    { id: itemId(41), kind: "key", title: WITH_BREAKS[1] ?? "", collection: FOLDER, value: "MU-key-a\nMU-key-b" },
    { id: itemId(42), kind: "login", title: WITH_BREAKS[2] ?? "", collection: null, password: "MU-pass\rword", has_password: true },
    { id: itemId(43), kind: "note", title: "MU-One line note", collection: null, notes: "MU-only one line" },
  ];
}

function vault(id: number, name: string, extra: Partial<FakeVault> = {}): FakeVault {
  return { id, name, items: items(), ...extra };
}

function mine(extra: Partial<FakeVault> = {}): FakeVault[] {
  return [vault(7, "My vault", extra)];
}

function side(): HTMLElement {
  return screen.getByRole("navigation", { name: "Vault and folders" });
}

function sent(cmd: string): Record<string, unknown>[] {
  return invoke.mock.calls.filter(([name]) => name === cmd).map(([, args]) => args as Record<string, unknown>);
}

function sessionOfVault(id: number): { session: number; generation: number } {
  const live = shell.sessionOf(id);
  if (live === undefined) throw new Error(`vault ${String(id)} is not open`);
  return { session: live.session, generation: live.generation };
}

async function unlockWith(password: string) {
  const field = await screen.findByLabelText(/^Password for /);
  fireEvent.change(field, { target: { value: password } });
  fireEvent.submit((field as HTMLInputElement).form as HTMLFormElement);
}

async function unlocked(list: FakeVault[] = mine()) {
  shell = installFakeShell(invoke, listen, list);
  const view = render(<App />);
  await unlockWith(PASSWORD);
  await screen.findByRole("heading", { level: 1, name: "All items", hidden: true });
  return view;
}

/** Every vault of `list` open, the first through the lock screen and the rest as the store opens them: the last one is on screen. */
async function allOpen(list: FakeVault[]) {
  const view = await unlocked(list);
  const { unlock } = await import("../store");
  for (const one of list.slice(1)) {
    await act(async () => {
      expect(await unlock({ list: shell.listIdentity(), id: one.id }, PASSWORD)).toBe("opened");
    });
  }
  return view;
}

/** Starts again with a fresh page and shell (a test that runs several cases). */
function fresh() {
  cleanup();
  resetStoreForTests();
  invoke.mockReset();
  listen.mockReset();
}

/** Settings from the side menu, then its Export row. Gives the form (34a). */
async function openForm(): Promise<HTMLElement> {
  fireEvent.click(within(side()).getByRole("button", { name: "Settings" }));
  const settings = await screen.findByRole("complementary", { name: "Settings" });
  fireEvent.click(within(settings).getByRole("button", { name: "Export" }));
  return screen.findByRole("complementary", { name: "Export" });
}

function typeInto(panel: HTMLElement, value: string) {
  fireEvent.change(within(panel).getByLabelText("Password for My vault"), { target: { value } });
}

function submit(panel: HTMLElement) {
  fireEvent.click(within(panel).getByRole("button", { name: "Choose where it goes" }));
}

function fields(panel: HTMLElement): HTMLInputElement[] {
  return Array.from(panel.querySelectorAll("input"));
}

/** What the page and the store hold of the made-up passwords: the list of where each was found. */
function foundOnPage(secrets: string[]): string[] {
  const found: string[] = [];
  const held = JSON.stringify(debugState());
  const words = document.body.textContent;
  for (const secret of secrets) {
    for (const box of document.querySelectorAll("input")) if (box.value.includes(secret)) found.push(`a field holds ${secret}`);
    if (held.includes(secret)) found.push(`the store holds ${secret}`);
    if (words.includes(secret)) found.push(`the page says ${secret}`);
    // Any attribute but a typed box's own `value`, which is the field and is counted above: a title, a label or a link must never hold it.
    for (const element of document.body.querySelectorAll("*")) {
      for (const attr of Array.from(element.attributes)) {
        if (element instanceof HTMLInputElement && attr.name === "value") continue;
        if (attr.value.includes(secret)) found.push(`an attribute holds ${secret}`);
      }
    }
  }
  return found;
}

type Real = (cmd: string, args?: unknown) => Promise<unknown>;

function realShell(): Real {
  const real = invoke.getMockImplementation();
  if (real === undefined) throw new Error("no fake shell");
  return real as Real;
}

/** Holds every answer of `cmd` until `release`; the shell decides at once (and writes, when it is good) as it does, and only the answer is late. */
function hold(cmd: string): { release: () => void; count: () => number } {
  const real = realShell();
  const waiting: (() => void)[] = [];
  let released = false;
  invoke.mockImplementation((name: string, args?: unknown) => {
    if (name !== cmd || released) return real(name, args);
    const decided = real(name, args).then(
      (value: unknown) => ({ failed: false as const, value }),
      (error: unknown) => ({ failed: true as const, error }),
    );
    return new Promise((resolve, reject) => {
      waiting.push(() => {
        void decided.then((outcome) => {
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the shell rejects with the plain object
          if (outcome.failed) reject(outcome.error);
          else resolve(outcome.value);
        });
      });
    });
  });
  return {
    release: () => {
      released = true;
      for (const go of waiting.splice(0)) go();
    },
    count: () => waiting.length,
  };
}

/** The vault menu, opened as a click does, and the row for a vault chosen. */
async function switchTo(name: string) {
  const opener = screen.getByRole("button", { name: /, vault menu$/ });
  opener.focus();
  fireEvent.pointerDown(opener, { button: 0 });
  fireEvent.click(opener);
  const menu = await screen.findByRole("menu");
  const row = within(menu)
    .getAllByRole("menuitemradio")
    .find((one) => one.textContent === name || one.textContent === `${name}Unlocked`);
  if (row === undefined) throw new Error(`no row for ${name}`);
  fireEvent.click(row);
  await waitFor(() => {
    expect(screen.queryByRole("menu")).toBeNull();
  });
}

/** From a vault on screen to the cloud question: the shell finds a cloud-synced folder, and the right password was typed. */
async function toTheCloudQuestion(): Promise<{ panel: HTMLElement; dialog: HTMLElement }> {
  const panel = await openForm();
  shell.cloudPdfNext();
  typeInto(panel, PASSWORD);
  submit(panel);
  const dialog = await screen.findByRole("dialog", { name: CLOUD_TITLE });
  return { panel, dialog };
}

/** From a vault on screen to the end (34c), made with the right password. */
async function toTheEnd(): Promise<HTMLElement> {
  const panel = await openForm();
  typeInto(panel, PASSWORD);
  submit(panel);
  return screen.findByRole("complementary", { name: "Exported" });
}

test("export_warns_before_the_password", async () => {
  await unlocked();
  const panel = await openForm();
  expect(within(panel).getByRole("heading", { level: 2, name: "Export" })).toBeTruthy();
  // What goes in, and what stays out; then the warning, and only then the box for the password.
  expect(within(panel).getByText(FOR_THE_VAULT)).toBeTruthy();
  const warning = within(panel).getByText(WARNING);
  const box = within(panel).getByLabelText("Password for My vault");
  expect(warning.compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(within(panel).getByText(/^For My vault:/).compareDocumentPosition(warning) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  // One hidden field, for the vault's password, and nothing else to type.
  expect(fields(panel).map((one) => one.labels?.[0]?.textContent)).toEqual(["Password for My vault"]);
  expect(fields(panel).map((one) => one.type)).toEqual(["password"]);
  expect(within(panel).getAllByRole("button").map((button) => button.getAttribute("aria-label") ?? button.textContent)).toEqual([
    "Close panel",
    "Cancel",
    "Choose where it goes",
  ]);
  // Nothing is sent before it is asked for; an empty field is said on the form and sends nothing.
  expect(sent("export_csv")).toEqual([]);
  submit(panel);
  expect(within(panel).getAllByRole("alert").map((alert) => alert.textContent)).toEqual([EMPTY]);
  expect(sent("export_csv")).toEqual([]);
  // Focus starts on the heading, so a screen reader reads the warning first.
  expect(within(panel).getByRole("heading", { level: 2, name: "Export" })).toBeTruthy();
});

test("export_asks_the_vaults_password_and_wipes_it_pending_refused_back_and_locked", { timeout: 20_000 }, async () => {
  // Pending: the field, the page and the store are clear the moment it is sent, before the answer comes.
  await unlocked();
  let panel = await openForm();
  let late = hold("export_csv");
  typeInto(panel, PASSWORD);
  expect(foundOnPage([PASSWORD])).toEqual([`a field holds ${PASSWORD}`]);
  submit(panel);
  await waitFor(() => {
    expect(late.count()).toBe(1);
  });
  expect(fields(panel).map((box) => box.value)).toEqual([""]);
  expect(foundOnPage(SECRETS)).toEqual([]);
  // While it is out the field can't be typed in, a second press sends nothing, and Cancel doesn't take it back.
  expect(fields(panel).map((box) => box.readOnly)).toEqual([true]);
  typeInto(panel, "MU-typed meanwhile");
  expect(fields(panel).map((box) => box.value)).toEqual([""]);
  submit(panel);
  fireEvent.click(within(panel).getByRole("button", { name: "Cancel" }));
  expect(screen.getByRole("complementary", { name: "Export" })).toBeTruthy();
  expect(late.count()).toBe(1);
  // The command's arguments: this vault's session and generation and the password, once.
  expect(sent("export_csv")).toEqual([{ ...sessionOfVault(7), password: PASSWORD }]);
  act(() => {
    late.release();
  });
  await screen.findByRole("complementary", { name: "Exported" });
  expect(sent("export_csv")).toHaveLength(1);
  expect(foundOnPage(SECRETS)).toEqual([]);

  // Refused: an empty field with the reason.
  fresh();
  await unlocked();
  panel = await openForm();
  typeInto(panel, WRONG_ONE);
  submit(panel);
  await within(panel).findByText(WRONG_CURRENT);
  expect(fields(panel).map((box) => box.value)).toEqual([""]);
  expect(foundOnPage(SECRETS)).toEqual([]);

  // The cloud question is open: the password is long gone from the field, the page and the store.
  fresh();
  await unlocked();
  const asked = await toTheCloudQuestion();
  expect(fields(asked.panel).map((box) => box.value)).toEqual([""]);
  expect(foundOnPage(SECRETS)).toEqual([]);

  // Back: Cancel, or Close panel, with the field typed, and the form opened again, is empty.
  fresh();
  await unlocked();
  panel = await openForm();
  typeInto(panel, "MU-typed one");
  expect(foundOnPage(["MU-typed"])).toEqual(["a field holds MU-typed"]);
  fireEvent.click(within(panel).getByRole("button", { name: "Cancel" }));
  await waitFor(() => {
    expect(screen.queryByRole("complementary", { name: "Export" })).toBeNull();
  });
  expect(foundOnPage(SECRETS)).toEqual([]);
  panel = await openForm();
  expect(fields(panel).map((box) => box.value)).toEqual([""]);
  typeInto(panel, "MU-typed two");
  fireEvent.click(within(panel).getByRole("button", { name: "Close panel" }));
  await waitFor(() => {
    expect(screen.queryByRole("complementary", { name: "Export" })).toBeNull();
  });
  expect(foundOnPage(SECRETS)).toEqual([]);
  expect(sent("export_csv")).toEqual([]);

  // A lock of the vault with the form typed and not sent, and a lock epoch that comes before it: nothing stays, and nothing comes back with the next unlock.
  fresh();
  await unlocked();
  panel = await openForm();
  typeInto(panel, "MU-typed four");
  act(() => {
    shell.lock(sessionOfVault(7).session);
  });
  await screen.findByLabelText(/^Password for /);
  expect(foundOnPage(SECRETS)).toEqual([]);
  await unlockWith(PASSWORD);
  await screen.findByRole("heading", { level: 1, name: "All items", hidden: true });
  panel = await openForm();
  expect(fields(panel).map((box) => box.value)).toEqual([""]);
  typeInto(panel, "MU-typed five");
  await act(async () => {
    shell.changeLockEpoch("idle");
    await Promise.resolve();
  });
  expect(fields(panel).map((box) => box.value)).toEqual([""]);
  expect(foundOnPage(SECRETS)).toEqual([]);
  expect(sent("export_csv")).toEqual([]);

  // A lock while the answer is out: the answer is dropped, and nothing typed is anywhere.
  fresh();
  await unlocked();
  panel = await openForm();
  late = hold("export_csv");
  typeInto(panel, PASSWORD);
  submit(panel);
  await waitFor(() => {
    expect(late.count()).toBe(1);
  });
  act(() => {
    shell.lock(sessionOfVault(7).session);
  });
  await screen.findByLabelText(/^Password for /);
  act(() => {
    late.release();
  });
  expect(foundOnPage(SECRETS.filter((one) => one !== PASSWORD))).toEqual([]);
  expect(screen.queryByRole("complementary", { name: "Exported" })).toBeNull();
});

test("wrong_password_is_said_with_an_empty_field", { timeout: 20_000 }, async () => {
  const vaults = mine();
  await unlocked(vaults);
  const panel = await openForm();
  typeInto(panel, WRONG_ONE);
  within(panel).getByRole("button", { name: "Choose where it goes" }).focus();
  submit(panel);
  const alert = await within(panel).findByRole("alert");
  expect(alert.textContent).toBe(WRONG_CURRENT);
  // On the field itself, which is empty again, and focus is there to type the password again.
  await waitFor(() => {
    expect(document.activeElement).toBe(within(panel).getByLabelText("Password for My vault"));
  });
  expect(within(panel).getByLabelText("Password for My vault").getAttribute("aria-invalid")).toBe("true");
  expect(fields(panel).map((box) => box.value)).toEqual([""]);
  // One command, with what was typed. Nothing was written, no picker answered, no summary.
  expect(sent("export_csv")).toEqual([{ ...sessionOfVault(7), password: WRONG_ONE }]);
  expect(shell.exports).toEqual([]);
  expect(screen.queryByRole("complementary", { name: "Exported" })).toBeNull();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(foundOnPage(SECRETS)).toEqual([]);
  // No lockout: the next tries are answered the same way, and the right one goes on.
  for (const wrong of ["MU-wrong two", "MU-wrong three"]) {
    typeInto(panel, wrong);
    submit(panel);
    await waitFor(() => {
      expect(sent("export_csv").at(-1)).toMatchObject({ password: wrong });
    });
    await within(panel).findByText(WRONG_CURRENT);
    expect(fields(panel).map((box) => box.value)).toEqual([""]);
  }
  typeInto(panel, PASSWORD);
  expect(within(panel).queryByText(WRONG_CURRENT)).toBeNull();
  submit(panel);
  await screen.findByRole("complementary", { name: "Exported" });
  expect(sent("export_csv")).toHaveLength(4);
  expect(shell.exports).toHaveLength(1);

  // Any other refusal goes through the table, said on the form, with the field empty.
  fresh();
  await unlocked();
  const form = await openForm();
  shell.refuseNext("export_csv", { code: "busy" });
  typeInto(form, PASSWORD);
  submit(form);
  await within(form).findByText("That vault is busy. Wait for what it's doing to finish, then try again.");
  expect(fields(form).map((box) => box.value)).toEqual([""]);
  expect(shell.exports).toEqual([]);
});

test("vault_folder_refusal_and_cloud_warning_use_the_existing_words", { timeout: 20_000 }, async () => {
  // A vault's folder, and Lockbox's own: refused in the design's words on the form, the field empty, nothing written.
  await unlocked();
  let panel = await openForm();
  shell.refuseNext("export_csv", { code: "core", kind: "invalid_input", what: "destination in a vault folder" });
  typeInto(panel, PASSWORD);
  submit(panel);
  expect((await within(panel).findByRole("alert")).textContent).toBe(IN_A_VAULT_FOLDER);
  expect(fields(panel).map((box) => box.value)).toEqual([""]);
  expect(shell.exports).toEqual([]);
  shell.refuseNext("export_csv", { code: "invalid_input", what: "state folder" });
  typeInto(panel, PASSWORD);
  submit(panel);
  await within(panel).findByText(IN_THE_STATE_FOLDER);
  expect(within(panel).queryByText(IN_A_VAULT_FOLDER)).toBeNull();
  expect(shell.exports).toEqual([]);

  // A cloud folder: the existing question, the safe answer focused first, nothing written yet.
  fresh();
  await unlocked();
  const { dialog } = await toTheCloudQuestion();
  expect(within(dialog).getByText(CLOUD_WORDS)).toBeTruthy();
  expect(within(dialog).getAllByRole("button").map((button) => button.textContent)).toEqual(["Continue", "Pick another folder"]);
  await waitFor(() => {
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Pick another folder" }));
  });
  expect(shell.exports).toEqual([]);
  expect(sent("export_csv")).toHaveLength(1);

  // Pick another folder is one more command with the token and nothing else: the password is not sent again, and it is not in the page to send.
  fireEvent.click(within(dialog).getByRole("button", { name: "Pick another folder" }));
  await screen.findByRole("complementary", { name: "Exported" });
  const repicks = sent("export_repick");
  expect(repicks).toHaveLength(1);
  expect(Object.keys(repicks[0] ?? {})).toEqual(["token"]);
  expect(sent("export_csv")).toHaveLength(1);
  expect(sent("save_readable_confirm")).toEqual([]);
  expect(JSON.stringify(repicks)).not.toContain(PASSWORD);
  expect(shell.exports).toHaveLength(1);

  // The new folder is a cloud one as well: the question stays, with a new token, and the safe answer is focused again.
  fresh();
  await unlocked();
  const again = await toTheCloudQuestion();
  shell.cloudPdfNext();
  fireEvent.click(within(again.dialog).getByRole("button", { name: "Pick another folder" }));
  await waitFor(() => {
    expect(sent("export_repick")).toHaveLength(1);
  });
  const second = await screen.findByRole("dialog", { name: CLOUD_TITLE });
  await waitFor(() => {
    expect(document.activeElement).toBe(within(second).getByRole("button", { name: "Pick another folder" }));
  });
  fireEvent.click(within(second).getByRole("button", { name: "Continue" }));
  await screen.findByRole("complementary", { name: "Exported" });
  const confirms = sent("save_readable_confirm");
  expect(confirms).toHaveLength(1);
  expect(Object.keys(confirms[0] ?? {})).toEqual(["token"]);
  expect(confirms[0]?.token).not.toBe(sent("export_repick")[0]?.token);
  expect(sent("export_csv")).toHaveLength(1);
  expect(shell.exports).toHaveLength(1);

  // Continue goes on with the one the shell parked, by its token, and sends no password either.
  fresh();
  await unlocked();
  const cloud = await toTheCloudQuestion();
  fireEvent.click(within(cloud.dialog).getByRole("button", { name: "Continue" }));
  await screen.findByRole("complementary", { name: "Exported" });
  expect(sent("save_readable_confirm")).toHaveLength(1);
  expect(JSON.stringify(sent("save_readable_confirm"))).not.toContain(PASSWORD);
  expect(sent("export_repick")).toEqual([]);
  expect(shell.exports).toHaveLength(1);

  // Escape is Cancel: the token is dropped, nothing is written, and the form is back with its field empty.
  fresh();
  await unlocked();
  const asked = await toTheCloudQuestion();
  const token = (debugState().sessions[0]?.exportFlow as { token: string }).token;
  expect(token).toMatch(/\S/);
  fireEvent.keyDown(within(asked.dialog).getByRole("button", { name: "Pick another folder" }), { key: "Escape" });
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  panel = screen.getByRole("complementary", { name: "Export" });
  expect(fields(panel).map((box) => box.value)).toEqual([""]);
  expect(JSON.stringify(debugState())).not.toContain(token);
  expect(sent("save_readable_confirm")).toEqual([]);
  expect(sent("export_repick")).toEqual([]);
  expect(shell.exports).toEqual([]);
  await waitFor(() => {
    expect(document.activeElement).toBe(within(panel).getByLabelText("Password for My vault"));
  });
});

test("a_closed_picker_writes_nothing_and_says_nothing", { timeout: 20_000 }, async () => {
  await unlocked();
  const panel = await openForm();
  shell.dismissPdfNext();
  typeInto(panel, PASSWORD);
  submit(panel);
  await waitFor(() => {
    expect(sent("export_csv")).toHaveLength(1);
  });
  await waitFor(() => {
    expect(document.activeElement).toBe(within(panel).getByLabelText("Password for My vault"));
  });
  expect(within(panel).queryByRole("alert")).toBeNull();
  expect(fields(panel).map((box) => box.value)).toEqual([""]);
  expect(shell.exports).toEqual([]);
  expect(screen.queryByRole("complementary", { name: "Exported" })).toBeNull();
  // The same after Pick another folder: the picker is closed, nothing is written, the form is back.
  fresh();
  await unlocked();
  const asked = await toTheCloudQuestion();
  shell.dismissPdfNext();
  fireEvent.click(within(asked.dialog).getByRole("button", { name: "Pick another folder" }));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(within(asked.panel).queryByRole("alert")).toBeNull();
  expect(shell.exports).toEqual([]);
  expect(sent("export_repick")).toHaveLength(1);
});

test("afterwards_says_to_delete_the_file_and_empty_the_recycle_bin", { timeout: 20_000 }, async () => {
  const vaults = mine();
  await unlocked(vaults);
  const panel = await toTheEnd();
  expect(within(panel).getByRole("heading", { level: 2, name: "Exported" })).toBeTruthy();
  // Where it went, how much, and what was left out.
  expect(within(panel).getByText(`Saved in ${SAVED_FOLDER}.`)).toBeTruthy();
  expect(within(panel).getByText("7 items saved. 1 stored file left out.")).toBeTruthy();
  // The file isn't protected: delete it, and empty the Recycle Bin.
  expect(within(panel).getByText(DELETE_IT)).toBeTruthy();
  // The items whose values have line breaks, by title, with one sentence about them.
  expect(within(panel).getByText(LINE_BREAKS)).toBeTruthy();
  expect(within(panel).getAllByRole("listitem").map((row) => row.textContent)).toEqual(WITH_BREAKS);
  // Only Done: Show in Explorer isn't offered, as nothing the page holds could say which folder to open.
  expect(within(panel).getAllByRole("button").map((button) => button.getAttribute("aria-label") ?? button.textContent)).toEqual(["Close panel", "Done"]);
  expect(within(panel).queryByRole("button", { name: "Show in Explorer" })).toBeNull();
  // The heading has focus as it appears, so the instruction is read first.
  await waitFor(() => {
    expect(document.activeElement).toBe(within(panel).getByRole("heading", { level: 2, name: "Exported" }));
  });
  // What was written is what the shell was told to write for this vault, and the vault is as it was.
  expect(shell.exports).toEqual([{ items: 7, left_out_files: 1, line_breaks: WITH_BREAKS, unreadable: 0 }]);
  // Nothing was unreadable, so the end says nothing about it.
  expect(within(panel).queryByText(/couldn't be read/)).toBeNull();
  expect(vaults[0]?.items).toEqual(items());
  expect(foundOnPage(SECRETS)).toEqual([]);
  // Done puts the panel away, and focus goes back to Settings, which opened it.
  fireEvent.click(within(panel).getByRole("button", { name: "Done" }));
  await waitFor(() => {
    expect(screen.queryByRole("complementary", { name: "Exported" })).toBeNull();
  });
  await waitFor(() => {
    expect(document.activeElement).toBe(within(side()).getByRole("button", { name: "Settings" }));
  });
  expect(debugState().sessions[0]?.exportFlow).toBeNull();

  // A vault with nothing multi-line and no stored file says neither: the sentence and the list are only there when there is something to name.
  fresh();
  await unlocked([{ id: 7, name: "My vault", items: [{ id: itemId(1), kind: "login", title: "MU-Only login", collection: null, has_password: true }] }]);
  const plain = await toTheEnd();
  expect(within(plain).getByText("1 item saved. No stored files left out.")).toBeTruthy();
  expect(within(plain).getByText(DELETE_IT)).toBeTruthy();
  expect(within(plain).queryByText(LINE_BREAKS)).toBeNull();
  expect(within(plain).queryAllByRole("listitem")).toEqual([]);

  // More than one stored file says it in the plural.
  fresh();
  const files = [
    { file_id: itemId(0xc1), name: "a-demo.pdf", length: 10, media_type: "application/pdf" },
    { file_id: itemId(0xc2), name: "b-demo.pdf", length: 10, media_type: "application/pdf" },
  ];
  await unlocked([
    vault(7, "My vault", {
      items: [...items(), { id: itemId(44), kind: "login", title: "MU-Login with files", collection: null, has_password: true, attachments: files }],
    }),
  ]);
  const plural = await toTheEnd();
  expect(within(plural).getByText("8 items saved. 3 stored files left out.")).toBeTruthy();
});

test("the_page_never_sends_the_folder_back", { timeout: 20_000 }, async () => {
  await unlocked();
  await toTheEnd();
  // The scans below find something to look at: the folder is on the page, in words, and the export's command was sent.
  expect(document.body.textContent).toContain(SAVED_FOLDER);
  expect(sent("export_csv")).toHaveLength(1);
  // No command carried the folder the shell said, and the folder is said in words only: no attribute, link or title holds it.
  expect(JSON.stringify(invoke.mock.calls)).not.toContain(SAVED_FOLDER);
  for (const element of document.body.querySelectorAll("*")) {
    for (const attr of Array.from(element.attributes)) expect(attr.value, `${element.tagName} ${attr.name}`).not.toContain(SAVED_FOLDER);
  }
  // The same through the cloud question's two answers.
  for (const answer of ["Continue", "Pick another folder"]) {
    fresh();
    await unlocked();
    const { dialog } = await toTheCloudQuestion();
    fireEvent.click(within(dialog).getByRole("button", { name: answer }));
    await screen.findByRole("complementary", { name: "Exported" });
    expect(JSON.stringify(invoke.mock.calls), answer).not.toContain(SAVED_FOLDER);
  }
});

test("a_stale_answer_renders_nothing", { timeout: 30_000 }, async () => {
  // The vault locks while the shell has the export: no file, nothing said, no 34c.
  await unlocked();
  let panel = await openForm();
  let late = hold("export_csv");
  typeInto(panel, PASSWORD);
  submit(panel);
  await waitFor(() => {
    expect(late.count()).toBe(1);
  });
  act(() => {
    shell.lock(sessionOfVault(7).session);
  });
  await screen.findByLabelText(/^Password for /);
  act(() => {
    late.release();
  });
  await act(async () => {
    await Promise.resolve();
  });
  expect(screen.queryByRole("alert")).toBeNull();
  expect(document.body.textContent).not.toContain("Saved in");
  expect(screen.queryByRole("complementary", { name: "Exported" })).toBeNull();

  // The shell tags the answer with a generation the bridge has moved past (the lock event was missed): the same news, and the session goes.
  fresh();
  await unlocked();
  panel = await openForm();
  const real = realShell();
  invoke.mockImplementation((cmd: string, args?: unknown) =>
    cmd === "export_csv"
      ? (real(cmd, args) as Promise<{ generation: number }>).then((answer) => ({ ...answer, generation: answer.generation + 1 }))
      : real(cmd, args),
  );
  typeInto(panel, PASSWORD);
  submit(panel);
  await screen.findByLabelText(/^Password for /);
  expect(debugState().sessions).toEqual([]);
  expect(screen.queryByRole("alert")).toBeNull();
  expect(document.body.textContent).not.toContain("Saved in");

  // A refusal as locked, with the page having missed the lock: the session goes, and nothing is said.
  fresh();
  await unlocked();
  panel = await openForm();
  shell.refuseNext("export_csv", LOCKED);
  typeInto(panel, PASSWORD);
  submit(panel);
  await screen.findByLabelText(/^Password for /);
  expect(screen.queryByRole("alert")).toBeNull();
  expect(debugState().sessions).toEqual([]);

  // A lock epoch that begins before the answer lands: the answer is dropped unread, with the vault.
  fresh();
  await unlocked();
  panel = await openForm();
  late = hold("export_csv");
  typeInto(panel, PASSWORD);
  submit(panel);
  await waitFor(() => {
    expect(late.count()).toBe(1);
  });
  await act(async () => {
    shell.changeLockEpoch("idle");
    await Promise.resolve();
  });
  act(() => {
    late.release();
  });
  await screen.findByLabelText(/^Password for /);
  expect(document.body.textContent).not.toContain("Saved in");
  expect(screen.queryByRole("complementary", { name: "Exported" })).toBeNull();

  // A lock while the cloud question is open takes it away, and a Continue after it writes nothing.
  fresh();
  await unlocked();
  await toTheCloudQuestion();
  act(() => {
    shell.lock(sessionOfVault(7).session);
  });
  await screen.findByLabelText(/^Password for /);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(sent("save_readable_confirm")).toEqual([]);
  expect(shell.exports).toEqual([]);
  expect(screen.queryByRole("alert")).toBeNull();

  // The lock is missed by the page, and the yes finds the shell without the question: the shell is asked about the session, the session goes, nothing is said.
  fresh();
  await unlocked();
  const { dialog } = await toTheCloudQuestion();
  shell.lockWithoutEvent(sessionOfVault(7).session);
  fireEvent.click(within(dialog).getByRole("button", { name: "Continue" }));
  await screen.findByLabelText(/^Password for /);
  expect(debugState().sessions).toEqual([]);
  expect(screen.queryByRole("alert")).toBeNull();
  expect(document.body.textContent).not.toContain("took too long");
  expect(shell.exports).toEqual([]);

  // A question left open past the shell's five minutes (nothing locked): it is said, the session stays, and the form is back to try again.
  fresh();
  await unlocked();
  const waited = await toTheCloudQuestion();
  shell.dropParkedChoices();
  fireEvent.click(within(waited.dialog).getByRole("button", { name: "Continue" }));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  const form = screen.getByRole("complementary", { name: "Export" });
  expect((await within(form).findByRole("alert")).textContent).toBe(EXPIRED);
  expect(fields(form).map((box) => box.value)).toEqual([""]);
  expect(debugState().sessions).toHaveLength(1);
  expect(shell.exports).toEqual([]);

  // A refusal at the yes (the destination became a vault's folder meanwhile) is said in the design's words on the form, and nothing is written.
  fresh();
  await unlocked();
  const later = await toTheCloudQuestion();
  shell.refuseNext("save_readable_confirm", { code: "core", kind: "invalid_input", what: "destination in a vault folder" });
  fireEvent.click(within(later.dialog).getByRole("button", { name: "Continue" }));
  await within(await screen.findByRole("complementary", { name: "Export" })).findByText(IN_A_VAULT_FOLDER);
  expect(shell.exports).toEqual([]);
});

test("export_hidden_on_a_read_only_vault", async () => {
  // A vault opened read-only has nothing the page may export: Settings has no such row, and the store won't open the form or send.
  await unlocked(mine({ readOnly: true }));
  fireEvent.click(within(side()).getByRole("button", { name: "Settings" }));
  const settings = await screen.findByRole("complementary", { name: "Settings" });
  expect(within(settings).queryByRole("button", { name: "Export" })).toBeNull();
  expect(within(settings).queryByText(/export/i)).toBeNull();
  act(() => {
    openExport(sessionOfVault(7).session);
  });
  expect(screen.queryByRole("complementary", { name: "Export" })).toBeNull();
  await act(async () => {
    await exportVault(sessionOfVault(7).session, PASSWORD);
  });
  expect(sent("export_csv")).toEqual([]);
  // And a writable vault has the row, with its hint.
  fresh();
  await unlocked();
  fireEvent.click(within(side()).getByRole("button", { name: "Settings" }));
  const writable = await screen.findByRole("complementary", { name: "Settings" });
  const row = within(writable).getByRole("button", { name: "Export" });
  expect(row.getAttribute("aria-describedby")).not.toBeNull();
  expect(within(writable).getByText("Save a readable copy of My vault for another app. It isn't encrypted.")).toBeTruthy();
});

test("a_form_left_by_a_switch_sends_nothing", async () => {
  // A form left by a switch is gone, with what was typed, and its answer can't reach the other vault.
  const vaults = [vault(7, "My vault"), vault(8, "Home")];
  await allOpen(vaults);
  let panel = await openForm();
  expect(within(panel).getByText(/^For Home:/)).toBeTruthy();
  fireEvent.change(within(panel).getByLabelText("Password for Home"), { target: { value: "MU-typed three" } });
  await switchTo("My vault");
  expect(screen.queryByRole("complementary", { name: "Export" })).toBeNull();
  expect(foundOnPage(SECRETS)).toEqual([]);
  await switchTo("Home");
  panel = await screen.findByRole("complementary", { name: "Export" });
  expect(within(panel).getByText(/^For Home:/)).toBeTruthy();
  expect(fields(panel).map((box) => box.value)).toEqual([""]);
  expect(sent("export_csv")).toEqual([]);
  // The export goes to the vault whose form it is, with that vault's password: another vault's is refused, and nothing is written.
  fireEvent.change(within(panel).getByLabelText("Password for Home"), { target: { value: WRONG_ONE } });
  fireEvent.click(within(panel).getByRole("button", { name: "Choose where it goes" }));
  await within(panel).findByText(WRONG_CURRENT);
  expect(sent("export_csv")).toEqual([{ ...sessionOfVault(8), password: WRONG_ONE }]);
  expect(shell.exports).toEqual([]);
});

test("export_screens_have_no_axe_violations", { timeout: 20_000 }, async () => {
  await unlocked();
  let panel = await openForm();
  // 34a, and with the line a refusal puts on it.
  await expectNoAxe(panel);
  typeInto(panel, WRONG_ONE);
  submit(panel);
  await within(panel).findByText(WRONG_CURRENT);
  await expectNoAxe(panel);
  expect(panel.querySelectorAll("style, [style]")).toHaveLength(0);
  // 34b: the vault folder's refusal on the form, then the cloud question over it.
  shell.refuseNext("export_csv", { code: "core", kind: "invalid_input", what: "destination in a vault folder" });
  typeInto(panel, PASSWORD);
  submit(panel);
  await within(panel).findByText(IN_A_VAULT_FOLDER);
  await expectNoAxe(panel);
  shell.cloudPdfNext();
  typeInto(panel, PASSWORD);
  submit(panel);
  const dialog = await screen.findByRole("dialog", { name: CLOUD_TITLE });
  await expectNoAxe(dialog);
  await expectNoAxe({ include: [document.body], exclude: [dialog] });
  // The dialog's own parts set their styles by script (which the policy allows); the page adds no `<style>` element, and the panel under it no `style` attribute.
  expect(document.body.querySelectorAll("style")).toHaveLength(0);
  expect(panel.querySelectorAll("style, [style]")).toHaveLength(0);
  // 34c, with the titles listed.
  fireEvent.click(within(dialog).getByRole("button", { name: "Continue" }));
  panel = await screen.findByRole("complementary", { name: "Exported" });
  await expectNoAxe(panel);
  expect(panel.querySelectorAll("style, [style]")).toHaveLength(0);
  expect(within(panel).getAllByRole("listitem")).toHaveLength(3);
});

test("an_export_says_how_many_items_could_not_be_read_and_are_not_in_the_file", { timeout: 20_000 }, async () => {
  // Two damaged items: the file is partial, and 34c says so beside the counts, so it is never taken for the whole vault.
  await unlocked(mine({ unreadable: 2 }));
  const panel = await toTheEnd();
  const line = within(panel).getByText("2 items couldn't be read and aren't in the file.");
  expect(shell.exports).toEqual([{ items: 7, left_out_files: 1, line_breaks: WITH_BREAKS, unreadable: 2 }]);
  // The delete-it warning is still there, and the unreadable line comes before it.
  expect(line.compareDocumentPosition(within(panel).getByText(DELETE_IT)) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

  // One says it in the singular.
  fresh();
  await unlocked(mine({ unreadable: 1 }));
  const one = await toTheEnd();
  expect(within(one).getByText("1 item couldn't be read and isn't in the file.")).toBeTruthy();

  // None says nothing at all.
  fresh();
  await unlocked();
  const none = await toTheEnd();
  expect(within(none).queryByText(/couldn't be read/)).toBeNull();
});

test("the_password_is_held_by_nothing_once_it_is_sent", { timeout: 20_000 }, async () => {
  // Pending, the one holder of the password is the request on its way; the store and page hold none (the wipe test), and the store's export code keeps no
  // closure, retry or callback over it: `exportVault` sends in one call and only the promise of the answer is awaited.
  const source = readBeside(import.meta.url, "../store.ts");
  const start = source.indexOf("// ---- Export to a readable file");
  const end = source.indexOf("// ---- Back up a vault");
  expect(start, "the export section was found").toBeGreaterThan(-1);
  expect(end, "the section ends").toBeGreaterThan(start);
  const code = source
    .slice(start, end)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  const sender = /export function exportVault\([^)]*\): Promise<void> \{([\s\S]*?)\n\}\n/.exec(code);
  expect(sender, "exportVault was found").not.toBeNull();
  const body = sender?.[1] ?? "";
  // It sends the password once, straight to the command, and makes no function that could hold it.
  expect(body.match(/\bpassword\b/g)).toHaveLength(1);
  expect(body).toContain("api.exportVault(");
  expect(body).not.toMatch(/=>|\bfunction\b|\.then\(|\.catch\(|setTimeout/);
  // Nowhere else in the section is the word used: no other function takes or keeps a password.
  expect(code.replace(sender?.[0] ?? "", "").match(/\bpassword\b/gi) ?? []).toEqual([]);

  // And at run time: sent once, with the answer held, the password is in the one command and nowhere on the page or in the store.
  await unlocked();
  const panel = await openForm();
  const late = hold("export_csv");
  typeInto(panel, PASSWORD);
  submit(panel);
  await waitFor(() => {
    expect(late.count()).toBe(1);
  });
  expect(sent("export_csv")).toEqual([{ ...sessionOfVault(7), password: PASSWORD }]);
  expect(foundOnPage(SECRETS)).toEqual([]);
  act(() => {
    late.release();
  });
  await screen.findByRole("complementary", { name: "Exported" });
  expect(sent("export_csv")).toHaveLength(1);
});

test("a_refusal_after_a_lock_epoch_begins_shows_nothing", { timeout: 30_000 }, async () => {
  // A wrong password's refusal that lands after the epoch moved on and before the vault's own lock event: nothing is said, and the vault goes.
  await unlocked();
  let panel = await openForm();
  let late = hold("export_csv");
  typeInto(panel, WRONG_ONE);
  submit(panel);
  await waitFor(() => {
    expect(late.count()).toBe(1);
  });
  await act(async () => {
    shell.changeLockEpoch("idle");
    await Promise.resolve();
  });
  act(() => {
    late.release();
  });
  await screen.findByLabelText(/^Password for /);
  expect(document.body.textContent).not.toContain(WRONG_CURRENT);
  expect(screen.queryByRole("alert")).toBeNull();
  expect(debugState().sessions).toEqual([]);

  // A vault's folder refusal at the cloud question's yes, delayed past the epoch change: the same.
  fresh();
  await unlocked();
  const asked = await toTheCloudQuestion();
  shell.refuseNext("save_readable_confirm", { code: "core", kind: "invalid_input", what: "destination in a vault folder" });
  late = hold("save_readable_confirm");
  fireEvent.click(within(asked.dialog).getByRole("button", { name: "Continue" }));
  await waitFor(() => {
    expect(late.count()).toBe(1);
  });
  await act(async () => {
    shell.changeLockEpoch("idle");
    await Promise.resolve();
  });
  act(() => {
    late.release();
  });
  await screen.findByLabelText(/^Password for /);
  expect(document.body.textContent).not.toContain("inside a vault's folder");
  expect(screen.queryByRole("alert")).toBeNull();

  // The question's token found nothing, and the epoch moves on during the lookup that follows: "took too long" is never said.
  fresh();
  await unlocked();
  const waited = await toTheCloudQuestion();
  shell.dropParkedChoices();
  const lookup = hold("list_items");
  fireEvent.click(within(waited.dialog).getByRole("button", { name: "Continue" }));
  await waitFor(() => {
    expect(lookup.count()).toBe(1);
  });
  await act(async () => {
    shell.changeLockEpoch("idle");
    await Promise.resolve();
  });
  act(() => {
    lookup.release();
  });
  await screen.findByLabelText(/^Password for /);
  expect(document.body.textContent).not.toContain("took too long");
  expect(screen.queryByRole("alert")).toBeNull();
  expect(debugState().sessions).toEqual([]);

  // Without any epoch change the same refusal is said (the check fires only on a lock).
  fresh();
  await unlocked();
  panel = await openForm();
  late = hold("export_csv");
  typeInto(panel, WRONG_ONE);
  submit(panel);
  await waitFor(() => {
    expect(late.count()).toBe(1);
  });
  act(() => {
    late.release();
  });
  await within(panel).findByText(WRONG_CURRENT);
});
