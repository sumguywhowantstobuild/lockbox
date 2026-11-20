// Every field where a password or a recovery key is typed turns spellcheck, autocorrect and auto-capitalisation off and says what it is for
// (`autocomplete`: "off" for a recovery key or a box that takes either, "current-password" or "new-password" for a password). One parameterised test
// reaches each of them through the real App, as a person would, and fails for a listed screen that draws no field. A second reads the sources, so a
// field in a file nobody listed fails too. Each later task that adds a field adds its screen to the list here.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import App from "./App";
import { resetStoreForTests } from "./store";
import { BACKUP_PASSWORD, installFakeShell, PASSWORD, sampleItems, type FakeShell, type FakeVault } from "./testing/fakeShell";
import { listBelow, readBeside } from "./testing/files";

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

type Purpose = "off" | "current-password" | "new-password";

interface Place {
  /** The screen, as the person would say it. */
  screen: string;
  /** The fields it draws, in the page's order, and what each is for. */
  fields: Purpose[];
  /** Gets to the screen from a fresh page. */
  reach: () => Promise<void>;
}

function mine(): FakeVault[] {
  return [{ id: 7, name: "My vault", items: sampleItems() }];
}

function start(list: FakeVault[] = mine()) {
  shell = installFakeShell(invoke, listen, list);
  render(<App />);
}

async function unlocked() {
  start();
  const field = await screen.findByLabelText(/^Password for /);
  fireEvent.change(field, { target: { value: PASSWORD } });
  fireEvent.submit((field as HTMLInputElement).form as HTMLFormElement);
  await screen.findByRole("heading", { level: 1, name: "All items", hidden: true });
}

function side(): HTMLElement {
  return screen.getByRole("navigation", { name: "Vault and folders" });
}

async function settings(): Promise<HTMLElement> {
  fireEvent.click(within(side()).getByRole("button", { name: "Settings" }));
  return screen.findByRole("complementary", { name: "Settings" });
}

const LABEL = "Password or recovery key from when it was made";

/** The toolbar's Add menu, opened as a click does, and one of its choices picked. */
async function addMenu(choice: string) {
  const button = screen.getByRole("button", { name: "Add" });
  button.focus();
  fireEvent.pointerDown(button, { button: 0 });
  fireEvent.click(button);
  const menu = await screen.findByRole("menu");
  fireEvent.click(within(menu).getByRole("menuitem", { name: choice }));
}

const PLACES: Place[] = [
  {
    screen: "the lock screen",
    fields: ["current-password"],
    reach: async () => {
      start();
      await screen.findByLabelText(/^Password for /);
    },
  },
  {
    screen: "first-time setup, step 1 (21b)",
    fields: ["new-password", "new-password"],
    reach: async () => {
      start([]);
      await screen.findByRole("heading", { level: 1, name: "Welcome to Lockbox" });
      fireEvent.click(screen.getByRole("button", { name: "Create a vault" }));
      await screen.findByRole("heading", { level: 1, name: "Create your vault" });
    },
  },
  {
    screen: "Restore a backup, the password or key (24a)",
    fields: ["off"],
    reach: async () => {
      start();
      await screen.findByLabelText(/^Password for /);
      fireEvent.click(screen.getByRole("button", { name: "Restore a backup" }));
      await screen.findByRole("heading", { level: 1, name: "Restore a backup" });
    },
  },
  {
    screen: "Restore a backup, unlocking the restored vault (24e)",
    fields: ["current-password"],
    reach: async () => {
      start();
      await screen.findByLabelText(/^Password for /);
      shell.restoreIs({ replaces: true });
      fireEvent.click(screen.getByRole("button", { name: "Restore a backup" }));
      await screen.findByRole("heading", { level: 1, name: "Restore a backup" });
      fireEvent.change(screen.getByLabelText(LABEL), { target: { value: BACKUP_PASSWORD } });
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
      await screen.findByRole("heading", { level: 1, name: "Where it goes" });
      fireEvent.click(screen.getByRole("button", { name: "Restore" }));
      await screen.findByRole("heading", { level: 1, name: "Replace your vault with this?" });
      fireEvent.click(screen.getByRole("button", { name: "Replace" }));
      await screen.findByRole("heading", { level: 1, name: "My vault is restored" });
    },
  },
  {
    screen: "Test a backup (23a)",
    fields: ["off"],
    reach: async () => {
      await unlocked();
      fireEvent.click(within(await settings()).getByRole("button", { name: "Test a backup" }));
      await screen.findByRole("complementary", { name: "Test a backup" });
    },
  },
  {
    screen: "Open a backup, in a window (25a)",
    fields: ["off"],
    reach: async () => {
      await unlocked();
      fireEvent.click(within(await settings()).getByRole("button", { name: "Open a backup" }));
      await screen.findByRole("complementary", { name: "Open a backup" });
    },
  },
  {
    screen: "Open a backup, from the lock screen (25a)",
    fields: ["off"],
    reach: async () => {
      start();
      fireEvent.click(await screen.findByRole("button", { name: "Open a backup" }));
      await screen.findByRole("heading", { level: 1, name: "Open a backup" });
    },
  },
  {
    screen: "Older copies, opening one read-only (24f)",
    fields: ["off"],
    reach: async () => {
      start();
      shell.olderCopies([{ vault: 7, folder: "My vault.before-restore", last_written: "2026-11-04", size: 1_000_000 }]);
      const field = await screen.findByLabelText(/^Password for /);
      fireEvent.change(field, { target: { value: PASSWORD } });
      fireEvent.submit((field as HTMLInputElement).form as HTMLFormElement);
      await screen.findByRole("heading", { level: 1, name: "All items", hidden: true });
      fireEvent.click(within(await settings()).getByRole("button", { name: /^Older copies \(\d+\)$/ }));
      const list = await screen.findByRole("complementary", { name: "Older copies" });
      fireEvent.click(within(list).getAllByRole("button", { name: "Open read-only" })[0] as HTMLElement);
    },
  },
  // A stored item's secret is a secret box too (its values are the vault's whole point): they keep autocomplete "off" (a stored login's password is not
  // one the browser should offer to remember or fill), and the other three attributes off.
  {
    screen: "New login, its password (6a)",
    fields: ["off"],
    reach: async () => {
      await unlocked();
      await addMenu("Login");
      await screen.findByRole("complementary", { name: "New login" });
    },
  },
  {
    screen: "New key, its value (7a)",
    fields: ["off"],
    reach: async () => {
      await unlocked();
      await addMenu("Key");
      await screen.findByRole("complementary", { name: "New key" });
    },
  },
  {
    screen: "Edit a login, its password (11a)",
    fields: ["off"],
    reach: async () => {
      await unlocked();
      fireEvent.click(await screen.findByRole("button", { name: /^Login:\s*Bot admin console/ }));
      const panel = await screen.findByRole("complementary", { name: "Bot admin console" });
      fireEvent.click(await within(panel).findByRole("button", { name: "Edit" }));
      await screen.findByRole("complementary", { name: "Edit login" });
    },
  },
  {
    screen: "Change password (27a)",
    fields: ["current-password", "new-password", "new-password"],
    reach: async () => {
      await unlocked();
      fireEvent.click(within(await settings()).getByRole("button", { name: "Change password" }));
      await screen.findByRole("complementary", { name: "Change password" });
    },
  },
  {
    screen: "New recovery key, the current password (29a)",
    fields: ["current-password"],
    reach: async () => {
      await unlocked();
      fireEvent.click(within(await settings()).getByRole("button", { name: "New recovery key" }));
      await screen.findByRole("complementary", { name: "New recovery key" });
    },
  },
  {
    screen: "Forgot password, the recovery key (28a)",
    fields: ["off"],
    reach: async () => {
      start();
      fireEvent.click(await screen.findByRole("button", { name: "Forgot password?" }));
      await screen.findByRole("heading", { level: 1, name: "Forgot password?" });
    },
  },
  {
    screen: "Forgot password, the new password (28d)",
    fields: ["new-password", "new-password"],
    reach: async () => {
      start();
      fireEvent.click(await screen.findByRole("button", { name: "Forgot password?" }));
      await screen.findByRole("heading", { level: 1, name: "Forgot password?" });
      fireEvent.change(screen.getByLabelText("Recovery key"), { target: { value: shell.recoveryKeyOf(7) } });
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
      await screen.findByRole("heading", { level: 1, name: "Choose a new password" });
    },
  },
  {
    screen: "The unlock step of another vault, with one open (Task 6)",
    fields: ["current-password"],
    reach: async () => {
      start([...mine(), { id: 8, name: "Home", items: sampleItems() }]);
      const field = await screen.findByLabelText(/^Password for /);
      fireEvent.change(field, { target: { value: PASSWORD } });
      fireEvent.submit((field as HTMLInputElement).form as HTMLFormElement);
      await screen.findByRole("heading", { level: 1, name: "All items", hidden: true });
      const opener = screen.getByRole("button", { name: /, vault menu$/ });
      opener.focus();
      fireEvent.pointerDown(opener, { button: 0 });
      fireEvent.click(opener);
      const menu = await screen.findByRole("menu");
      fireEvent.click(within(menu).getByRole("menuitemradio", { name: /^Home/ }));
      await screen.findByRole("heading", { level: 1, name: "Unlock Home" });
    },
  },
  {
    screen: "New vault from the vault menu, step 1 (Task 7)",
    fields: ["new-password", "new-password"],
    reach: async () => {
      await unlocked();
      const opener = screen.getByRole("button", { name: /, vault menu$/ });
      opener.focus();
      fireEvent.pointerDown(opener, { button: 0 });
      fireEvent.click(opener);
      const menu = await screen.findByRole("menu");
      fireEvent.click(within(menu).getByRole("menuitem", { name: "New vault" }));
      await screen.findByRole("heading", { level: 1, name: "New vault" });
    },
  },
  {
    screen: "The save box, unlocking the vault chosen in it (Task 10)",
    fields: ["current-password"],
    reach: async () => {
      start([...mine(), { id: 8, name: "Home", items: sampleItems() }]);
      const field = await screen.findByLabelText(/^Password for /);
      fireEvent.change(field, { target: { value: PASSWORD } });
      fireEvent.submit((field as HTMLInputElement).form as HTMLFormElement);
      await screen.findByRole("heading", { level: 1, name: "All items", hidden: true });
      await waitFor(() => {
        expect(shell.calls.some((call) => call.cmd === "capture_state")).toBe(true);
      });
      await act(async () => {
        shell.press({ text: "demo-copied-for-the-field-check" });
        await Promise.resolve();
      });
      const panel = await screen.findByRole("complementary", { name: "Save what you copied" });
      const list = within(panel).getByRole("combobox", { name: "Vault" });
      fireEvent.pointerDown(list, { button: 0 });
      fireEvent.click(list);
      const option = (await screen.findAllByRole("option")).find((one) => one.textContent === "Home");
      fireEvent.pointerDown(option as HTMLElement);
      fireEvent.click(option as HTMLElement);
      await within(panel).findByLabelText("Password for Home");
    },
  },
];

/** Every box where a vault's password or a recovery key is typed, shown or hidden: hidden ones by type, and any other by what its label says. */
function secretBoxes(): HTMLInputElement[] {
  return Array.from(document.querySelectorAll("input")).filter(
    (box) => box.type === "password" || /password|recovery key/i.test(box.labels?.[0]?.textContent ?? ""),
  );
}

test("every_secret_field_has_the_four_attributes", async () => {
  let checked = 0;
  for (const place of PLACES) {
    cleanup();
    resetStoreForTests();
    invoke.mockReset();
    listen.mockReset();
    await place.reach();
    const boxes = secretBoxes();
    // A listed screen that draws no field (or another number than it says) fails: the list is never an empty promise.
    expect(boxes.length, `${place.screen} draws its fields`).toBeGreaterThan(0);
    expect(
      boxes.map((box) => box.getAttribute("autocomplete")),
      `${place.screen}: what each field is for`,
    ).toEqual(place.fields);
    for (const box of boxes) {
      expect(box.getAttribute("spellcheck"), `${place.screen}: spellcheck`).toBe("false");
      expect(box.getAttribute("autocorrect"), `${place.screen}: autocorrect`).toBe("off");
      expect(box.getAttribute("autocapitalize"), `${place.screen}: auto-capitalisation`).toBe("off");
      checked += 1;
    }
  }
  // The number of fields looked at is the number the list promises.
  expect(checked).toBe(PLACES.reduce((sum, place) => sum + place.fields.length, 0));
  // It reaches every screen in the list from a fresh page, one after another, so its time grows with the list: it gets room for the screens still to be listed.
}, 30_000);

test("every_file_that_draws_a_secret_field_is_on_the_list", () => {
  // A field typed into in a file nobody listed would go unchecked: the parts that draw one are the two named here, and the two item forms that draw a
  // hidden box (a new login's password and a key's value) are reached by the cases above. Anything else fails until it is listed. (The edit form's
  // login password is a plain text box, readable while editing, and has its own case above.)
  const parts = ["parts/PasswordField.tsx", "parts/CredentialField.tsx"];
  const items = ["screens/forms/LoginForm.tsx", "screens/forms/ValueField.tsx"];
  const drawers = listBelow(import.meta.url, "./")
    .filter((path) => /\.tsx$/.test(path) && !/\.test\.tsx$/.test(path))
    .filter((path) => /type=("password"|\{[^}]*"password")/.test(readBeside(import.meta.url, `./${path}`)))
    .sort();
  expect(drawers).toEqual([...parts, ...items].sort());
});
