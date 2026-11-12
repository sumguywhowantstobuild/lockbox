// The side menu as the approved screens draw it (1d, 16a, 31a, 21g): the vault's name with its up-down mark, the place
// that is open marked (Generator and Settings as well as a folder or the Trash), and one width whatever the vault is called.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import App from "../App";
import { resetStoreForTests } from "../store";
import { readBeside } from "../testing/files";
import { installFakeShell, PASSWORD, sampleItems, type FakeVault } from "../testing/fakeShell";

const { invoke, listen } = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

beforeEach(() => {
  resetStoreForTests();
  invoke.mockReset();
  listen.mockReset();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-06T12:00:00Z"));
});

async function unlocked(vaults: FakeVault[] = [{ id: 7, name: "My vault", items: sampleItems() }]) {
  installFakeShell(invoke, listen, vaults);
  const view = render(<App />);
  const field = await screen.findByLabelText(/^Password for /);
  fireEvent.change(field, { target: { value: PASSWORD } });
  fireEvent.submit((field as HTMLInputElement).form as HTMLFormElement);
  await screen.findByRole("heading", { level: 1, name: "All items" });
  return view;
}

function side(): HTMLElement {
  return screen.getByRole("navigation", { name: "Vault and folders" });
}

const COMPONENTS = readBeside(import.meta.url, "../styles/components.css").replace(/\/\*[\s\S]*?\*\//g, "");
const HIGH_CONTRAST = readBeside(import.meta.url, "../styles/high-contrast.css").replace(/\/\*[\s\S]*?\*\//g, "");

function declarationsFor(selector: string): string {
  for (const rule of COMPONENTS.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if ((rule[1] ?? "").split(",").some((part) => part.trim() === selector)) return (rule[2] ?? "").replace(/\s+/g, " ");
  }
  throw new Error(`${selector} has no rule in components.css`);
}

test("the_vault_name_shows_the_up_down_mark_of_its_menu", async () => {
  // Found at stage 7: the name opened the vault menu with nothing to say it would. Drawn: "My vault ⌃⌄".
  await unlocked();
  const button = within(side()).getByRole("button", { name: "My vault, vault menu" });
  const mark = button.querySelector("svg.vchev");
  expect(mark, "the up-down mark is in the button").not.toBeNull();
  expect(mark?.getAttribute("aria-hidden")).toBe("true");
  // A picture only: the button is still named by the vault and its menu.
  expect(button.getAttribute("aria-haspopup")).toBe("menu");
});

test("generator_and_settings_are_marked_while_their_panel_is_open", async () => {
  // Found at stage 7: Trash was marked when open, Generator and Settings were not (drawn marked in 16a and 31a).
  await unlocked();
  const generator = within(side()).getByRole("button", { name: "Generator" });
  const settings = within(side()).getByRole("button", { name: "Settings" });
  expect(generator.classList.contains("on")).toBe(false);
  fireEvent.click(generator);
  await screen.findByRole("complementary", { name: "Generator" });
  expect(generator.classList.contains("on")).toBe(true);
  expect(settings.classList.contains("on")).toBe(false);
  fireEvent.click(settings);
  await screen.findByRole("complementary", { name: "Settings" });
  expect(settings.classList.contains("on")).toBe(true);
  expect(generator.classList.contains("on")).toBe(false);
  fireEvent.click(within(screen.getByRole("complementary", { name: "Settings" })).getByRole("button", { name: "Close panel" }));
  await waitFor(() => {
    expect(settings.classList.contains("on")).toBe(false);
  });
});

test("the_side_menu_keeps_one_width_and_settings_marked_looks_picked", () => {
  // Found at stage 7: a long vault name pushed the side menu about 30px wider (21g). Drawn at one width: a flex part
  // grows to fit its content unless its smallest width is set to nothing, so the long name is cut short instead.
  expect(declarationsFor(".rail")).toMatch(/(^|; |\s)min-width: 0;/);
  // Settings marked: the tint with an edge (not a tint alone), open and closed to icons, where the closed buttons lose
  // their own background (the rule names both, so it wins there too).
  const marked = declarationsFor(".rbtn.on");
  expect(marked).toMatch(/background: var\(--sel\)/);
  expect(marked).toMatch(/box-shadow: inset 0 0 0 1px var\(--ink2\)/);
  expect(declarationsFor(".rail.closed .rbtn.on")).toBe(marked);
  // In Windows' high contrast it takes the system highlight, as a picked folder does.
  expect(HIGH_CONTRAST).toMatch(/:is\([^)]*\.rbtn\.on[^)]*\)\s*\{[^}]*background: Highlight/);
  // The vault name's up-down mark: small and quiet, and gone when the side menu is closed to icons.
  expect(declarationsFor(".vsw .vchev")).toMatch(/(^| )width: 14px/);
  expect(declarationsFor(".rail.closed .vchev")).toMatch(/display: none/);
  // The search button has its box in light, as drawn (1d): the card's colour with a thin edge.
  const search = declarationsFor(".srch");
  expect(search).toMatch(/background: var\(--card\)/);
  expect(search).toMatch(/box-shadow: inset 0 0 0 1px var\(--line\)/);
  // The vault menu is drawn wider than the side menu (5a), floating out over the list rather than inside the side menu.
  expect(declarationsFor(".menu.mwide")).toMatch(/(^| )width: 292px/);
  // A menu of choices (Move) is drawn 264px wide (12a), so a long folder name fits.
  expect(declarationsFor(".menu.mpick")).toMatch(/(^| )width: 264px/);
});
