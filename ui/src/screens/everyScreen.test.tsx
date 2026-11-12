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
import { FOLDER, installFakeShell, itemId, PASSWORD, sampleItems, type FakeItem, type FakeShell, type FakeVault } from "../testing/fakeShell";
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
