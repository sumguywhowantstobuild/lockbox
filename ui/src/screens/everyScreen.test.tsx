// Every screen of the app, reached as a person reaches it (through the lock screen, the menus and the keys, against the
// pretend shell), and checked by axe-core. The list is kept whole: every component a file under `screens/` exports must be
// claimed by a case here, so a new screen without a check fails `every_screen_passes_axe: the list names every screen`.
// While each screen is up, the page must also have made no `<style>` element: the Content Security Policy refuses them
// (`style-src 'self'`), so one made here would be a screen that breaks in the real window.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import App from "../App";
import { resetStoreForTests } from "../store";
import { expectNoAxe } from "../testing/axe";
import { BACKUP_PASSWORD, FOLDER, installFakeShell, itemId, PASSWORD, sampleItems, type FakeItem, type FakeShell, type FakeVault } from "../testing/fakeShell";
import { listBelow, readBeside } from "../testing/files";

const { invoke, listen } = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));

let shell: FakeShell;

beforeEach(() => {
  resetStoreForTests();
  invoke.mockReset();
  listen.mockReset();
  // Axe leaves a `<style>` of its own in the head; each case starts without any, so one found later is the page's.
  for (const style of document.querySelectorAll("style")) style.remove();
});

afterEach(() => {
  cleanup();
});

// ---- The vault the cases open: the sample items, a login with a stored file, a program file and keys in a folder ----

function items(): FakeItem[] {
  return [
    ...sampleItems().map((item) =>
      item.id === itemId(1)
        ? { ...item, attachments: [{ file_id: itemId(0xb1), name: "console-access-demo.pdf", length: 18_432, media_type: "application/pdf" }] }
        : item,
    ),
    {
      id: itemId(6),
      kind: "file",
      title: "Setup tool",
      collection: null,
      attachments: [{ file_id: itemId(0xb2), name: "setup-demo.exe", length: 12 * 1_048_576, media_type: "application/x-msdownload" }],
    },
    { id: itemId(30), kind: "key", title: "OPENAI_API_KEY", collection: FOLDER, value: "demo-screen-key-1" },
    { id: itemId(31), kind: "key", title: "TELEGRAM_BOT_TOKEN", collection: FOLDER, value: "demo-screen-key-2" },
  ];
}

/** Three made-up files picked for Add files: 2.1 MB, 3.2 GB and 84 KB. */
const THREE_FILES = [
  { name: "signed-contract-demo.pdf", size: 2_202_010 },
  { name: "design-files-demo.zip", size: 3_435_973_837 },
  { name: "scope-notes-demo.docx", size: 86_016 },
];

function vault(extra: Partial<FakeVault> = {}): FakeVault {
  return { id: 7, name: "My vault", items: items(), ...extra };
}

function start(vaults: FakeVault[], notices: object[] = []) {
  shell = installFakeShell(invoke, listen, vaults);
  shell.setLaunchNotices(notices);
  render(<App />);
}

async function unlockIt(heading: string | null = "All items") {
  const field = await screen.findByLabelText(/^Password for /);
  fireEvent.change(field, { target: { value: PASSWORD } });
  fireEvent.submit((field as HTMLInputElement).form as HTMLFormElement);
  if (heading !== null) await screen.findByRole("heading", { level: 1, name: heading });
}

async function unlocked(extra: Partial<FakeVault> = {}) {
  start([vault(extra)]);
  await unlockIt();
}

function click(name: string | RegExp, within_: HTMLElement = document.body) {
  fireEvent.click(within(within_).getByRole("button", { name }));
}

function side(): HTMLElement {
  return screen.getByRole("navigation", { name: "Vault and folders" });
}

/** Opens a menu the way a click does. */
async function openMenu(button: HTMLElement): Promise<HTMLElement> {
  button.focus();
  fireEvent.pointerDown(button, { button: 0 });
  fireEvent.click(button);
  return screen.findByRole("menu");
}

async function addMenu(choice: string) {
  const menu = await openMenu(screen.getByRole("button", { name: "Add" }));
  fireEvent.click(within(menu).getByRole("menuitem", { name: choice }));
}

async function select(title: string): Promise<HTMLElement> {
  fireEvent.click(await screen.findByRole("button", { name: new RegExp(String.raw`^(Login|Key|Note|File):\s*${title}`) }));
  return screen.findByRole("complementary", { name: title });
}

async function openFolder(name: string) {
  fireEvent.click(within(side()).getByRole("button", { name: new RegExp(String.raw`^${name}\s+\d+$`) }));
  await screen.findByRole("heading", { level: 1, name });
}

async function folderMenu(choice: string) {
  const menu = await openMenu(screen.getByRole("button", { name: "More for this folder" }));
  fireEvent.click(within(menu).getByRole("menuitem", { name: choice }));
}

/** First-time setup, from Welcome to the filled-in form. */
async function toTheForm() {
  start([]);
  await screen.findByRole("heading", { level: 1, name: "Welcome to Lockbox" });
  click("Create a vault");
  await screen.findByRole("heading", { level: 1, name: "Create your vault" });
  fireEvent.change(screen.getByLabelText("Vault name"), { target: { value: "My vault" } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "a long enough password" } });
  fireEvent.change(screen.getByLabelText("Password again"), { target: { value: "a long enough password" } });
}

async function toTheKey() {
  await toTheForm();
  click("Create vault");
  await screen.findByRole("heading", { level: 1, name: "Save your recovery key" });
}

/** The save shortcut pressed with a made-up copied text, once the page listens for it. */
async function pressTheShortcut() {
  await waitFor(() => {
    expect(shell.calls.some((call) => call.cmd === "capture_state")).toBe(true);
  });
  await act(async () => {
    shell.press({ text: "demo-copied-for-the-screen-check" });
    await Promise.resolve();
  });
}

// ---- The screens ----

interface Case {
  /** What a person sees, by the design's numbers where it has them. */
  name: string;
  /** The exported components (`<file under screens/>#<name>`) this case puts on the page and so checks. */
  shows: string[];
  /**
   * Gets the app to the screen and waits for something only that screen shows. A screen with a menu or a list open returns that
   * popup: it is checked on its own, and the page around it without it. Base UI draws a popup at the end of the app's element,
   * outside the page's landmarks, so a page-wide check would flag it under axe's `region` rule; it is a passing list of choices
   * that holds focus while open, as every menu is, and its own rules are still checked.
   */
  reach: () => Promise<unknown>;
}

const CASES: Case[] = [
  {
    name: "Welcome (21a)",
    shows: ["setup/FirstRun#FirstRun", "setup/Welcome#Welcome", "setup/Frame#Frame"],
    reach: async () => {
      start([]);
      await screen.findByRole("heading", { level: 1, name: "Welcome to Lockbox" });
    },
  },
  {
    name: "What do you have? (26a, 26b)",
    shows: ["setup/MoveIn#MoveIn"],
    reach: async () => {
      start([]);
      await screen.findByRole("heading", { level: 1, name: "Welcome to Lockbox" });
      click("I already have a vault or a backup");
      await screen.findByRole("heading", { level: 1, name: "What do you have?" });
      // 26b: the folder on a USB stick, refused, with its words as the alert.
      shell.refuseNext("add_existing_vault", { code: "invalid_input", what: "removable drive" });
      click("A vault folder");
      await screen.findByRole("alert");
    },
  },
  {
    name: "A vault is here, bring in the next (26c)",
    shows: ["setup/MoveIn#MoveIn"],
    reach: async () => {
      start([]);
      await screen.findByRole("heading", { level: 1, name: "Welcome to Lockbox" });
      click("I already have a vault or a backup");
      await screen.findByRole("heading", { level: 1, name: "What do you have?" });
      shell.offerExisting({ id: 40, name: "Old vault", items: [] });
      click("A vault folder");
      await screen.findByRole("heading", { level: 1, name: "Old vault is here" });
    },
  },
  {
    name: "Lost list of vaults (Ask 12)",
    shows: ["setup/LostList#LostList", "setup/Frame#Frame"],
    reach: async () => {
      shell = installFakeShell(invoke, listen, [{ id: 7, name: "My vault", items: sampleItems() }]);
      shell.damageVaultList();
      render(<App />);
      await screen.findByRole("heading", { level: 1, name: "Lockbox lost its list of vaults" });
    },
  },
  {
    name: "Create your vault (21b)",
    shows: ["setup/CreateVault#CreateVault"],
    reach: toTheForm,
  },
  {
    name: "Cloud folder question (21e)",
    shows: ["setup/CloudQuestion#CloudQuestion"],
    reach: async () => {
      await toTheForm();
      shell.cloudNext();
      click("Create vault");
      await screen.findByRole("heading", { level: 1, name: "This folder is synced to the cloud" });
    },
  },
  {
    name: "Save your recovery key (21c)",
    shows: ["setup/RecoveryKey#RecoveryKey", "setup/KeyActions#KeyActions"],
    reach: toTheKey,
  },
  {
    name: "The recovery key's printer list (21c)",
    shows: ["setup/KeyActions#KeyActions"],
    reach: async () => {
      await toTheKey();
      fireEvent.click(screen.getAllByRole("button", { name: "Print" })[0] as HTMLElement);
      await screen.findByRole("group", { name: "Choose a printer" });
      await screen.findByRole("combobox");
    },
  },
  {
    name: "Check your recovery key (21d)",
    shows: ["setup/PickWords#PickWords"],
    reach: async () => {
      await toTheKey();
      click("Continue");
      await screen.findByRole("heading", { level: 1, name: "Check your recovery key" });
    },
  },
  {
    name: "Finish your recovery key, at the next unlock (21f)",
    shows: ["setup/RecoveryKey#RecoveryKey"],
    reach: async () => {
      start([vault({ items: [], unconfirmed: true })]);
      await unlockIt("Finish your recovery key");
    },
  },
  {
    name: "An empty vault (21g)",
    shows: ["setup/Ready#Ready", "EmptyAdd#EmptyAdd", "MainWindow#MainWindow"],
    reach: async () => {
      await unlocked({ items: [] });
      await screen.findByText("Your vault is empty");
    },
  },
  {
    name: "Lock screen (1a)",
    shows: ["LockScreen#LockScreen"],
    reach: async () => {
      start([vault()]);
      await screen.findByRole("heading", { level: 1, name: "Unlock My vault" });
    },
  },
  {
    name: "Lock screen with launch's notices (Ask 11, 10e, the shortcut taken, a finished restore)",
    shows: ["Asks#LockScreenAsks", "Asks#LostOutputsAsk", "Asks#OpenFilesAsk", "Asks#ShortcutAsk"],
    reach: async () => {
      start(
        [vault()],
        [
          { kind: "output_sweep", removed: 0, kept: 0, unreadable: true },
          { kind: "open_cleanup", removed: 0, still_open: 2 },
          { kind: "shortcut_taken" },
          { kind: "restore", state: "recovered", how: "finished" },
        ],
      );
      await screen.findByText(/^Lockbox lost track of some opened files/);
      await screen.findByText("Couldn't remove 2 opened files.");
      await screen.findByText(/is used by another app, so the save shortcut is off/);
      await screen.findByText(/^Lockbox finished restoring a vault/);
    },
  },
  {
    name: "The save step on the lock screen (8b)",
    shows: ["LockScreen#LockScreen"],
    reach: async () => {
      start([vault()]);
      await pressTheShortcut();
      await screen.findByRole("heading", { level: 1, name: "Save what you copied" });
    },
  },
  {
    name: "The vault's details changed (Ask 3)",
    shows: ["Asks#DetailsChangedAsk"],
    reach: async () => {
      start([vault({ headerChanged: true })]);
      await unlockIt(null);
      await screen.findByRole("dialog");
    },
  },
  {
    name: "The vault's banners (Asks 4, 5, 9, 10)",
    shows: ["Asks#VaultBanners"],
    reach: async () => {
      start([vault({ unreadable: 2, leftover: 2, usedBackupHeader: true, cloud: "OneDrive" })]);
      await unlockIt();
      await screen.findByText("2 leftover files have no item that uses them.");
      await screen.findByText(/^OneDrive syncs/);
    },
  },
  {
    name: "All items (2a, 17a)",
    shows: ["MainWindow#MainWindow", "SideMenu#SideMenu", "ItemList#ItemList", "ListTools#ListTools"],
    reach: async () => {
      await unlocked();
      await screen.findByRole("combobox", { name: "Sort" });
    },
  },
  {
    name: "The kind list open (17b)",
    shows: ["ListTools#ListTools"],
    reach: async () => {
      await unlocked();
      const kind = screen.getByRole("combobox", { name: "Show only one kind" });
      fireEvent.pointerDown(kind, { button: 0 });
      fireEvent.click(kind);
      await screen.findAllByRole("option");
      return screen.getByRole("listbox");
    },
  },
  {
    name: "The vault menu",
    shows: ["SideMenu#SideMenu"],
    reach: async () => {
      await unlocked();
      return openMenu(screen.getByRole("button", { name: "My vault, vault menu" }));
    },
  },
  {
    name: "The Add menu",
    shows: ["AddMenu#AddMenu"],
    reach: async () => {
      await unlocked();
      return openMenu(screen.getByRole("button", { name: "Add" }));
    },
  },
  {
    name: "A login, its password revealed, with a stored file (3b, 10)",
    shows: ["ItemPanel#ItemPanel", "FileActions#AttachedFiles"],
    reach: async () => {
      await unlocked();
      const panel = await select("Bot admin console");
      click("Reveal", panel);
      await within(panel).findByRole("textbox", { name: "Password" });
    },
  },
  {
    name: "A stored file (10a)",
    shows: ["FileActions#FileRows"],
    reach: async () => {
      await unlocked();
      const panel = await select("Client contract");
      within(panel).getByRole("button", { name: "Open contract-demo.pdf" });
    },
  },
  {
    name: "A file opening, and auto-lock waiting (5d)",
    shows: ["FileActions#BusyNote"],
    reach: async () => {
      await unlocked();
      const panel = await select("Client contract");
      shell.holdFiles();
      click("Open contract-demo.pdf", panel);
      await screen.findByText(/^Auto-lock is waiting until this finishes/);
    },
  },
  {
    name: "A copy being saved, with its progress and Cancel (9b)",
    shows: ["FileActions#FileJobProgress"],
    reach: async () => {
      await unlocked();
      const panel = await select("Client contract");
      shell.holdFiles();
      click("Save a copy of contract-demo.pdf", panel);
      const card = await screen.findByRole("region", { name: "Saving a copy" });
      const job = shell.runningJobs()[0];
      act(() => {
        shell.sendProgress(job?.operation ?? 0, 1_288_490_189, 3_221_225_472);
      });
      await within(card).findByText("1.2 GB of 3 GB");
    },
  },
  {
    name: "Many files picked (9a)",
    shows: ["AddFiles#AddFiles"],
    reach: async () => {
      await unlocked();
      shell.pickFilesNext(THREE_FILES);
      await addMenu("File");
      await screen.findByRole("complementary", { name: "Add files" });
    },
  },
  {
    name: "Many files, no room for them (9e)",
    shows: [],
    reach: async () => {
      await unlocked();
      shell.setFreeSpace(1_181_116_006);
      shell.pickFilesNext(THREE_FILES);
      await addMenu("File");
      const panel = await screen.findByRole("complementary", { name: "Add files" });
      click("Add 3 files", panel);
      await within(panel).findByRole("alert");
    },
  },
  {
    name: "Many files being added, with one bar and Cancel (9b)",
    shows: [],
    reach: async () => {
      await unlocked();
      shell.holdFiles();
      shell.pickFilesNext(THREE_FILES);
      await addMenu("File");
      click("Add 3 files", await screen.findByRole("complementary", { name: "Add files" }));
      const card = await screen.findByRole("region", { name: "Adding files" });
      const job = shell.runningJobs()[0];
      act(() => {
        shell.sendProgress(job?.operation ?? 0, 1_395_864_371, 3_438_175_847);
      });
      await within(card).findByText("2 of 3");
    },
  },
  {
    name: "Many files added, and the originals still on the PC (9c)",
    shows: [],
    reach: async () => {
      await unlocked();
      shell.pickFilesNext(THREE_FILES);
      await addMenu("File");
      click("Add 3 files", await screen.findByRole("complementary", { name: "Add files" }));
      await screen.findByRole("complementary", { name: "3 files added" });
    },
  },
  {
    name: "Many files, some not added, named (9c)",
    shows: [],
    reach: async () => {
      await unlocked();
      shell.unreadableFiles(["scope-notes-demo.docx"]);
      shell.batchEndsAfter(1, { code: "busy", what: "vault" });
      shell.pickFilesNext(THREE_FILES);
      await addMenu("File");
      click("Add 3 files", await screen.findByRole("complementary", { name: "Add files" }));
      await screen.findByRole("complementary", { name: "1 of 3 files added" });
    },
  },
  {
    name: "Many files, the summary kept after moving on (9c)",
    shows: ["AddFiles#AddFilesLeft"],
    reach: async () => {
      await unlocked();
      shell.batchEndsAfter(1, { code: "busy", what: "vault" });
      const release = shell.holdFiles();
      shell.pickFilesNext(THREE_FILES);
      await addMenu("File");
      click("Add 3 files", await screen.findByRole("complementary", { name: "Add files" }));
      await screen.findByRole("region", { name: "Adding files" });
      await select("Client contract");
      act(() => {
        release();
      });
      await screen.findByRole("region", { name: "1 of 3 files added" });
    },
  },
  {
    name: "Save all files, with one bar and Stop (Saving)",
    shows: ["SaveAllFiles#SaveAllFiles"],
    reach: async () => {
      await unlocked();
      await openFolder("Agency support agent");
      shell.holdFiles();
      await folderMenu("Save all files (1)");
      const card = await screen.findByRole("region", { name: "Saving files" });
      const job = shell.runningJobs()[0];
      act(() => {
        shell.sendProgress(job?.operation ?? 0, 4_608, 18_432);
      });
      await within(card).findByText("4.5 KB of 18 KB");
    },
  },
  {
    name: "Save all files, saved with the warning (Done)",
    shows: [],
    reach: async () => {
      await unlocked();
      await openFolder("Agency support agent");
      await folderMenu("Save all files (1)");
      await screen.findByRole("complementary", { name: "1 file saved" });
    },
  },
  {
    name: "Save all files, stopped part way (Stopped)",
    shows: [],
    reach: async () => {
      await unlocked();
      await openFolder("Agency support agent");
      shell.batchEndsAfter(0, { code: "core", kind: "not_enough_space", needed: 10, available: 5 });
      await folderMenu("Save all files (1)");
      await screen.findByRole("complementary", { name: "Stopped after 0 of 1 file" });
    },
  },
  {
    name: "Save all files, the summary kept after moving on (Done)",
    shows: ["SaveAllFiles#SaveAllLeft"],
    reach: async () => {
      await unlocked();
      await openFolder("Agency support agent");
      const release = shell.holdFiles();
      await folderMenu("Save all files (1)");
      await screen.findByRole("region", { name: "Saving files" });
      await select("Rotation steps");
      act(() => {
        release();
      });
      await screen.findByRole("region", { name: "1 file saved" });
    },
  },
  {
    name: "Save all files into a cloud folder",
    shows: ["SaveAllFiles#SaveAllCloudQuestion"],
    reach: async () => {
      await unlocked();
      await openFolder("Agency support agent");
      shell.cloudPdfNext();
      await folderMenu("Save all files (1)");
      return screen.findByRole("dialog", { name: "This folder is synced to the cloud" });
    },
  },
  {
    name: "Attach files on an item (9d)",
    shows: [],
    reach: async () => {
      await unlocked();
      const panel = await select("Bot admin console");
      shell.pickFilesNext(THREE_FILES);
      click("Attach files", panel);
      await screen.findByRole("complementary", { name: "Attach files" });
    },
  },
  {
    name: "Open a program? (10b)",
    shows: ["FileActions#ProgramQuestion"],
    reach: async () => {
      await unlocked();
      const panel = await select("Setup tool");
      click("Open setup-demo.exe", panel);
      await screen.findByRole("dialog", { name: "Open a program?" });
    },
  },
  {
    name: "Replace a stored file (10c)",
    shows: ["FileActions#FileRows"],
    reach: async () => {
      await unlocked();
      const panel = await select("Client contract");
      click("Replace file contract-demo.pdf", panel);
      await screen.findByRole("dialog", { name: "Replace contract-demo.pdf?" });
    },
  },
  {
    name: "Save a copy into a cloud folder (21e on a copy)",
    shows: ["FileActions#CloudCopyQuestion"],
    reach: async () => {
      await unlocked();
      const panel = await select("Client contract");
      shell.cloudPdfNext();
      click("Save a copy of contract-demo.pdf", panel);
      await screen.findByRole("dialog", { name: "This folder is synced to the cloud" });
    },
  },
  {
    name: "New login with the generator open (6a, 16a)",
    shows: ["forms/LoginForm#LoginForm", "GeneratorPanel#GeneratorInForm"],
    reach: async () => {
      await unlocked();
      await addMenu("Login");
      const form = await screen.findByRole("complementary", { name: "New login" });
      click("Generate", form);
      await within(form).findByRole("textbox", { name: "Generated password" });
    },
  },
  {
    name: "New key (7a)",
    shows: ["forms/KeyForm#KeyForm", "forms/ValueField#ValueField"],
    reach: async () => {
      await unlocked();
      await addMenu("Key");
      await screen.findByRole("complementary", { name: "New key" });
    },
  },
  {
    name: "New note (7b)",
    shows: ["forms/NoteForm#NoteForm"],
    reach: async () => {
      await unlocked();
      await addMenu("Note");
      await screen.findByRole("complementary", { name: "New note" });
    },
  },
  {
    name: "Edit a login (11a)",
    shows: ["forms/EditForm#EditForm"],
    reach: async () => {
      await unlocked();
      const panel = await select("Bot admin console");
      await waitFor(() => {
        expect(within(panel).queryByRole("button", { name: "Edit" })).not.toBeNull();
      });
      click("Edit", panel);
      await screen.findByRole("complementary", { name: "Edit login" });
    },
  },
  {
    name: "The Generator page (16a)",
    shows: ["GeneratorPanel#GeneratorPage"],
    reach: async () => {
      await unlocked();
      click("Generator", side());
      await screen.findByRole("complementary", { name: "Generator" });
    },
  },
  {
    name: "Search with results (4a, 9g)",
    shows: ["SearchPanel#SearchPanel"],
    reach: async () => {
      await unlocked();
      fireEvent.keyDown(document.body, { key: "f", ctrlKey: true });
      const dialog = await screen.findByRole("dialog", { name: "Search every unlocked vault" });
      fireEvent.change(within(dialog).getByRole("textbox", { name: "Search every unlocked vault" }), { target: { value: "co" } });
      await within(dialog).findByRole("button", { name: /^File:\s*Client contract/ });
    },
  },
  {
    name: "Settings (31a)",
    shows: ["SettingsPanel#SettingsPanel"],
    reach: async () => {
      await unlocked();
      click("Settings", side());
      const panel = await screen.findByRole("complementary", { name: "Settings" });
      await within(panel).findByRole("switch", { name: "Start with Windows" });
    },
  },
  {
    name: "Back up: where it goes, progress, saved and not enough space (22a to 22d)",
    shows: ["BackupFlow#BackupPanel"],
    reach: async () => {
      await unlocked();
      click("Settings", side());
      const settings = await screen.findByRole("complementary", { name: "Settings" });
      click("Back up", settings);
      const panel = await screen.findByRole("complementary", { name: "Back up" });
      // The last of its views, the one with the most on it: a refusal said under the advice.
      shell.refuseNext("backup_vault", { code: "core", kind: "not_enough_space", needed: 1_288_490_189, available: 419_430_400 });
      click("Back up", panel);
      await within(panel).findByRole("alert");
    },
  },
  {
    name: "Test a backup: the file and the box, progress, the result and a damaged backup (23a to 23d)",
    shows: ["TestBackup#TestBackupPanel"],
    reach: async () => {
      await unlocked();
      click("Settings", side());
      const settings = await screen.findByRole("complementary", { name: "Settings" });
      click("Test a backup", settings);
      const panel = await screen.findByRole("complementary", { name: "Test a backup" });
      // The last of its views with a field on it: a wrong password said under the box.
      fireEvent.change(within(panel).getByLabelText("Password or recovery key from when it was made"), { target: { value: "not the one" } });
      click("Test", panel);
      await within(panel).findByRole("alert");
    },
  },
  {
    name: "Open a backup: the file and the box, progress and a wrong password (25a)",
    shows: ["OpenBackup#OpenBackupPanel"],
    reach: async () => {
      await unlocked();
      click("Settings", side());
      const settings = await screen.findByRole("complementary", { name: "Settings" });
      click("Open a backup", settings);
      const panel = await screen.findByRole("complementary", { name: "Open a backup" });
      // The last of its views with a field on it: a wrong password said under the box.
      fireEvent.change(within(panel).getByLabelText("Password or recovery key from when it was made"), { target: { value: "not the one" } });
      click("Open read-only", panel);
      await within(panel).findByRole("alert");
    },
  },
  {
    name: "Open a backup from the lock screen: the same steps full-screen (25a)",
    shows: ["OpenBackup#OpenBackupSteps"],
    reach: async () => {
      start([vault()]);
      fireEvent.click(await screen.findByRole("button", { name: "Open a backup" }));
      await screen.findByRole("heading", { level: 1, name: "Open a backup" });
      fireEvent.change(screen.getByLabelText("Password or recovery key from when it was made"), { target: { value: "not the one" } });
      click("Open read-only");
      await screen.findByRole("alert");
    },
  },
  {
    name: "Change password: the form, with the lines that say what is wrong with it (27a, 27b)",
    shows: ["ChangePassword#ChangePasswordPanel"],
    reach: async () => {
      await unlocked();
      click("Settings", side());
      const settings = await screen.findByRole("complementary", { name: "Settings" });
      click("Change password", settings);
      const panel = await screen.findByRole("complementary", { name: "Change password" });
      // The view with the most on it: a short new password and a second one that differs, said on the form.
      fireEvent.change(within(panel).getByLabelText("Current password"), { target: { value: "MU-not the one" } });
      fireEvent.change(within(panel).getByLabelText("New password"), { target: { value: "MU-short" } });
      fireEvent.change(within(panel).getByLabelText("New password again"), { target: { value: "MU-other" } });
      click("Change password", panel);
      await within(panel).findAllByRole("alert");
    },
  },
  {
    name: "Change password: the offer of a fresh backup once it is changed (27c)",
    shows: ["ChangePassword#ChangePasswordDone"],
    reach: async () => {
      await unlocked();
      click("Settings", side());
      const settings = await screen.findByRole("complementary", { name: "Settings" });
      click("Change password", settings);
      const panel = await screen.findByRole("complementary", { name: "Change password" });
      fireEvent.change(within(panel).getByLabelText("Current password"), { target: { value: PASSWORD } });
      fireEvent.change(within(panel).getByLabelText("New password"), { target: { value: "MU-a new passphrase" } });
      fireEvent.change(within(panel).getByLabelText("New password again"), { target: { value: "MU-a new passphrase" } });
      click("Change password", panel);
      await screen.findByRole("dialog", { name: "Make a fresh backup now?" });
    },
  },
  {
    name: "A backup open: Copy to a vault and the question about the files it lacks (25b to 25d)",
    shows: ["OpenBackup#CopyToVault"],
    reach: async () => {
      await unlocked();
      shell.backupHolds(
        items().map((item) =>
          item.id === itemId(1) ? { ...item, missingFiles: ["console-access-demo.pdf"] } : item,
        ),
      );
      click("Settings", side());
      const settings = await screen.findByRole("complementary", { name: "Settings" });
      click("Open a backup", settings);
      const panel = await screen.findByRole("complementary", { name: "Open a backup" });
      fireEvent.change(within(panel).getByLabelText("Password or recovery key from when it was made"), { target: { value: BACKUP_PASSWORD } });
      click("Open read-only", panel);
      await screen.findByRole("button", { name: /read-only, vault menu$/ });
      const item = await select("Bot admin console");
      click("Copy to a vault", item);
      await within(item).findByRole("combobox", { name: "Vault" });
      click("Copy", item);
      return screen.findByRole("dialog", { name: "Copy without these files?" });
    },
  },
  {
    name: "Restore a backup: the file and the box, where it goes, progress, the replace question and the finish (24a to 24e)",
    shows: ["RestoreFlow#RestoreFlow"],
    reach: async () => {
      start([vault()]);
      fireEvent.click(await screen.findByRole("button", { name: "Restore a backup" }));
      await screen.findByRole("heading", { level: 1, name: "Restore a backup" });
      shell.restoreIs({ replaces: true });
      fireEvent.change(screen.getByLabelText("Password or recovery key from when it was made"), { target: { value: BACKUP_PASSWORD } });
      click("Continue");
      await screen.findByRole("heading", { level: 1, name: "Where it goes" });
      click("Restore");
      await screen.findByRole("heading", { level: 1, name: "Replace your vault with this?" });
      click("Replace");
      // The last of its views, the one with a field on it.
      await screen.findByRole("heading", { level: 1, name: "My vault is restored" });
    },
  },
  {
    name: "Forgot password: the recovery key, the new password and the offer of a fresh backup (28a to 28e)",
    shows: ["ForgotPassword#ForgotPassword"],
    reach: async () => {
      start([vault()]);
      fireEvent.click(await screen.findByRole("button", { name: "Forgot password?" }));
      await screen.findByRole("heading", { level: 1, name: "Forgot password?" });
      fireEvent.change(screen.getByLabelText("Recovery key"), { target: { value: shell.recoveryKeyOf(7) } });
      click("Continue");
      await screen.findByRole("heading", { level: 1, name: "Choose a new password" });
      fireEvent.change(screen.getByLabelText("New password"), { target: { value: "MU-new passphrase 2026" } });
      fireEvent.change(screen.getByLabelText("New password again"), { target: { value: "MU-new passphrase 2026" } });
      click("Set new password");
      // The last of its views.
      await screen.findByRole("heading", { level: 1, name: "Make a fresh backup now?" });
    },
  },
  {
    name: "A restore that didn't finish: Ask 6, Ask 7 and the two states with no drawn screen",
    shows: ["RestoreNotices#RestoreNotices"],
    reach: async () => {
      const paths = { step: "swapping", staging: "C:\\Vaults\\demo", target: "C:\\Vaults\\demo", before_restore: null };
      start([vault()], [{ kind: "restore", state: "drive_missing", paths, folder: "E:\\Vaults" }]);
      await screen.findByRole("heading", { level: 1, name: "A restore is waiting for a drive" });
      // Try again that comes to a second screen: the rename that failed, then the one that was undone.
      shell.retryRestoreGives({ state: "pending", paths });
      click("Try again");
      await screen.findByRole("heading", { level: 1, name: "A restore is waiting" });
      shell.retryRestoreGives({ state: "recovered", how: "rolled_back", vault: { id: 7, name: "My vault" } });
      click("Try again");
      await screen.findByRole("heading", { level: 1, name: "A restore didn't finish" });
    },
  },
  {
    name: "A vault whose details are both damaged: Ask 8",
    shows: ["RestoreNotices#DamagedVaultAsk"],
    reach: async () => {
      start([vault(), { id: 9, name: null, available: true, detailsDamaged: true }]);
      fireEvent.click(await screen.findByRole("radio", { name: /A vault that can't be read/ }));
      await screen.findByRole("heading", { level: 1, name: "This vault can't be opened" });
    },
  },
  {
    name: "Older copies: the list, and the box that opens one read-only (24f)",
    shows: ["OlderCopies#OlderCopiesPanel", "OlderCopies#OlderCopiesList"],
    reach: async () => {
      start([vault()]);
      shell.olderCopies([
        { vault: 7, folder: "My vault.before-restore", last_written: "2026-11-04", size: 1_395_864_371 },
        { vault: 7, folder: "My vault.before-restore-2", last_written: null, size: 5_242_880 },
      ]);
      await unlockIt();
      click("Settings", side());
      const settings = await screen.findByRole("complementary", { name: "Settings" });
      fireEvent.click(await within(settings).findByRole("button", { name: "Older copies (2)" }));
      const panel = await screen.findByRole("complementary", { name: "Older copies" });
      // The last of its views, the one with a field on it: a wrong password said under the box.
      click("Open read-only", within(panel).getByText("My vault.before-restore").closest(".frow") as HTMLElement);
      fireEvent.change(within(panel).getByLabelText("Password or recovery key for this copy"), { target: { value: "not the one" } });
      click("Open", panel);
      await within(panel).findByRole("alert");
    },
  },
  {
    name: "Delete an older copy, asked first and for good (24g)",
    shows: [],
    reach: async () => {
      start([vault()]);
      shell.olderCopies([{ vault: 7, folder: "My vault.before-restore", last_written: "2026-11-04", size: 1_395_864_371 }]);
      await unlockIt();
      click("Settings", side());
      const settings = await screen.findByRole("complementary", { name: "Settings" });
      fireEvent.click(await within(settings).findByRole("button", { name: "Older copies (1)" }));
      const panel = await screen.findByRole("complementary", { name: "Older copies" });
      click("Delete", panel);
      return screen.findByRole("dialog", { name: "Delete My vault.before-restore?" });
    },
  },
  {
    name: "Older copies inside the restore, when there are too many (24f, from 24d's refusal)",
    shows: ["RestoreFlow#RestoreFlow"],
    reach: async () => {
      start([vault()]);
      shell.olderCopies([{ vault: 7, folder: "My vault.before-restore", last_written: "2026-11-04", size: 1_395_864_371 }]);
      fireEvent.click(await screen.findByRole("button", { name: "Restore a backup" }));
      await screen.findByRole("heading", { level: 1, name: "Restore a backup" });
      shell.restoreIs({ replaces: true });
      fireEvent.change(screen.getByLabelText("Password or recovery key from when it was made"), { target: { value: BACKUP_PASSWORD } });
      click("Continue");
      await screen.findByRole("heading", { level: 1, name: "Where it goes" });
      click("Restore");
      await screen.findByRole("heading", { level: 1, name: "Replace your vault with this?" });
      shell.restoreCommitRefuses({ code: "core", kind: "invalid_input", what: "too many before-restore copies" });
      click("Replace");
      fireEvent.click(await screen.findByRole("button", { name: "Older copies" }));
      await screen.findByRole("heading", { level: 1, name: "Older copies" });
      await screen.findByText("My vault.before-restore");
    },
  },
  {
    name: "Backup refused, and the questions beside it (Ask 2)",
    shows: ["BackupFlow#BackupRefusedAsk"],
    reach: async () => {
      await unlocked();
      click("Settings", side());
      const settings = await screen.findByRole("complementary", { name: "Settings" });
      click("Back up", settings);
      const panel = await screen.findByRole("complementary", { name: "Back up" });
      shell.refuseNext("backup_vault", { code: "invalid_input", what: "details changed" });
      click("Back up", panel);
      return screen.findByRole("dialog", { name: "Can't back up My vault yet" });
    },
  },
  {
    name: "Backup overdue (Ask 1)",
    shows: ["BackupReminder#BackupReminder"],
    reach: async () => {
      start([vault({ backupDays: 40 })]);
      await unlockIt(null);
      return screen.findByRole("dialog", { name: "My vault hasn't been backed up in 30 days" });
    },
  },
  {
    name: "Save what you copied, in the vault (8a)",
    shows: ["SaveBox#SaveBox"],
    reach: async () => {
      await unlocked();
      await pressTheShortcut();
      await screen.findByRole("complementary", { name: "Save what you copied" });
    },
  },
  {
    name: "Paste a .env, with its rows (15a, 15b)",
    shows: ["EnvPaste#EnvPaste", "forms/ClearClipboard#ClearClipboardBox"],
    reach: async () => {
      await unlocked();
      await addMenu("Paste a .env");
      const panel = await screen.findByRole("complementary", { name: "Paste a .env" });
      fireEvent.paste(within(panel).getByLabelText("Paste your .env here"), {
        clipboardData: { getData: () => "DEMO_ONE=demo-paste-1\nDEMO_TWO=demo-paste-2" },
      });
      await within(panel).findByRole("heading", { level: 3 });
      await within(panel).findByRole("combobox", { name: "Folder" });
      await within(panel).findByRole("checkbox", { name: /clipboard/i });
    },
  },
  {
    name: "Save a folder's keys as a .env file (15e)",
    shows: ["EnvOut#EnvFileDialog"],
    reach: async () => {
      await unlocked();
      await openFolder("Agency support agent");
      await folderMenu("Save as .env file");
      await screen.findByRole("dialog", { name: "Save as .env file" });
    },
  },
  {
    name: "New folder (14a)",
    shows: ["forms/FolderForm#NewFolderBox"],
    reach: async () => {
      await unlocked();
      click("New folder", side());
      await within(side()).findByRole("textbox", { name: "New folder name" });
    },
  },
  {
    name: "Rename a folder (14b)",
    shows: ["forms/FolderForm#RenameFolderDialog"],
    reach: async () => {
      await unlocked();
      await openFolder("Agency support agent");
      await folderMenu("Rename folder");
      await screen.findByRole("dialog", { name: "Rename folder" });
    },
  },
  {
    name: "Delete a folder (14c)",
    shows: ["forms/FolderForm#DeleteFolderDialog"],
    reach: async () => {
      await unlocked();
      await openFolder("Agency support agent");
      await folderMenu("Delete folder");
      await screen.findByRole("dialog", { name: "Delete Agency support agent?" });
    },
  },
  {
    name: "Moved to Trash, with Undo (13a)",
    shows: ["ItemPanel#ItemPanel"],
    reach: async () => {
      await unlocked();
      const panel = await select("Error tracker");
      await waitFor(() => {
        expect(within(panel).queryByRole("button", { name: "Move to trash" })).not.toBeNull();
      });
      click("Move to trash", panel);
      await screen.findByRole("button", { name: "Undo" });
    },
  },
  {
    name: "The Trash and a trashed item (13b, 13c)",
    shows: ["TrashView#TrashView", "TrashView#TrashPanel"],
    reach: async () => {
      await unlocked();
      click(/^Trash\s+\d+$/, side());
      await screen.findByRole("heading", { level: 1, name: "Trash" });
      fireEvent.click(screen.getByRole("button", { name: /^Login:\s*Old login in the trash/ }));
      await screen.findByRole("complementary", { name: "Old login in the trash" });
    },
  },
  {
    name: "The first close (5b)",
    shows: ["FirstClose#FirstClose"],
    reach: async () => {
      await unlocked();
      act(() => {
        shell.closeWindow();
      });
      await screen.findByRole("dialog", { name: "Lockbox stays by the clock" });
    },
  },
  {
    name: "Closing or quitting with a job running (33b, Ask 15)",
    shows: ["CloseQuestion#CloseQuestion"],
    reach: async () => {
      await unlocked();
      act(() => {
        shell.askClose("close", { running: ["backup"], pastSwap: false });
      });
      await screen.findByRole("dialog", { name: "A backup is running" });
    },
  },
];

/**
 * Every component a file under `screens/` exports (a PascalCase name, as a function or a constant such as a `memo`), as
 * `<file>#<name>`. A default export has no name to list, so none is allowed.
 */
function everyScreenComponent(): string[] {
  const files = listBelow(import.meta.url, "./").filter((path) => path.endsWith(".tsx") && !path.endsWith(".test.tsx"));
  return files.flatMap((path) => {
    const source = readBeside(import.meta.url, `./${path}`);
    const file = path.replace(/\.tsx$/, "");
    expect(source, `${file} has a default export, which this list can't name`).not.toMatch(/^export default /m);
    // A component's name is PascalCase; the words a screen shares are SHOUTING_CASE constants, not screens.
    return [...source.matchAll(/^export (?:function|const) ([A-Z][a-z]\w*)/gm)].map((match) => `${file}#${match[1] ?? ""}`);
  });
}

/** For each case, how many `<style>` elements the page had made while it was up; filled in as the cases run. */
const styleElements = new Map<string, number>();

describe("every_screen_passes_axe", () => {
  test("the list names every screen", () => {
    const claimed = new Set(CASES.flatMap((one) => one.shows));
    const found = everyScreenComponent();
    expect(found.length, "the screens were found").toBeGreaterThan(30);
    expect(
      found.filter((name) => !claimed.has(name)),
      "a screen with no case here: add one that reaches it",
    ).toEqual([]);
    expect(
      [...claimed].filter((name) => !found.includes(name)),
      "a case names a screen that no file exports",
    ).toEqual([]);
  });

  for (const one of CASES) {
    test(one.name, async () => {
      const popup = await one.reach();
      // Before axe, which adds a style element of its own.
      styleElements.set(one.name, document.querySelectorAll("style").length);
      if (popup instanceof Element) {
        await expectNoAxe(popup);
        await expectNoAxe({ include: [document.body], exclude: [popup] });
      } else {
        await expectNoAxe(document.body);
      }
    });
  }
});

test("rendered_screens_add_no_style_elements", () => {
  expect([...styleElements.keys()], "every screen was reached").toEqual(CASES.map((one) => one.name));
  expect(
    [...styleElements].filter(([, count]) => count > 0).map(([name]) => name),
    "screens that made a <style> element",
  ).toEqual([]);
});
