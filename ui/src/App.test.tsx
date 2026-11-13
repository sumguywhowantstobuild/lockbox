import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import App from "./App";
import { resetStoreForTests } from "./store";
import { expectNoAxe } from "./testing/axe";
import { installFakeShell, sampleItems } from "./testing/fakeShell";
import { listBelow, readBeside } from "./testing/files";

const { invoke, listen } = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  resetStoreForTests();
  invoke.mockReset();
  listen.mockReset();
});

test("the_app_opens_on_the_lock_screen", async () => {
  installFakeShell(invoke, listen, [{ id: 7, name: "My vault", items: sampleItems() }]);
  const { container } = render(<App />);
  expect(await screen.findByRole("heading", { level: 1, name: "Unlock My vault" })).toBeTruthy();
  // The test page is gone.
  expect(screen.queryByText(/hands-on/i)).toBeNull();
  expect(screen.queryByRole("button", { name: /test vault|test login|probe/i })).toBeNull();
  // Nothing is written into the page's styles: the policy would refuse it.
  expect(container.querySelectorAll("style, [style]")).toHaveLength(0);
  await expectNoAxe(container);
});

test("the_screen_follows_windows_light_or_dark", async () => {
  for (const dark of [false, true]) {
    resetStoreForTests();
    installFakeShell(invoke, listen, [{ id: 7, name: "My vault", items: sampleItems() }]);
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: dark && query === "(prefers-color-scheme: dark)",
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    const { container, unmount } = render(<App />);
    await screen.findByRole("heading", { level: 1 });
    const root = container.querySelector(".app");
    expect(root?.classList.contains(dark ? "mode-dark" : "mode-light"), `dark ${String(dark)}`).toBe(true);
    expect(root?.classList.contains(dark ? "mode-light" : "mode-dark")).toBe(false);
    unmount();
  }
});

test("a_vault_list_that_cannot_be_read_says_so_in_words", async () => {
  installFakeShell(invoke, listen, []);
  const real = invoke.getMockImplementation();
  if (real === undefined) throw new Error("no fake shell");
  invoke.mockImplementation((cmd: string, args?: unknown) =>
    cmd === "list_vaults"
      ? // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- Tauri rejects with the plain object
        Promise.reject({ code: "core", kind: "damaged", what: "SENTINEL-vault list" })
      : (real(cmd, args) as Promise<unknown>),
  );
  const { container } = render(<App />);
  const alert = await screen.findByRole("alert");
  expect(alert.textContent.length).toBeGreaterThan(5);
  expect(container.textContent).not.toContain("SENTINEL");
  await expectNoAxe(container);
});

test("a_lock_listener_that_fails_says_so_instead_of_waiting_for_ever", async () => {
  installFakeShell(invoke, listen, [{ id: 7, name: "My vault", items: sampleItems() }]);
  listen.mockImplementation(() => Promise.reject(new Error("SENTINEL no events")));
  const { container } = render(<App />);
  const alert = await screen.findByRole("alert");
  expect(alert.textContent.length).toBeGreaterThan(5);
  expect(container.textContent).not.toContain("SENTINEL");
  expect(screen.queryByText("Opening…")).toBeNull();
  // No vault is offered, since a lock could not be heard: no command was sent at all.
  expect(screen.queryByLabelText(/^Password for /)).toBeNull();
  expect(invoke).not.toHaveBeenCalled();
  await expectNoAxe(container);
});

test("no_probe_command_is_called_from_the_page", () => {
  const word = ["pro", "be_"].join("");
  const files = listBelow(import.meta.url, ".").filter((path) => /\.(ts|tsx)$/.test(path) && !/\.test\.tsx?$/.test(path));
  expect(files.length).toBeGreaterThan(10);
  for (const path of files) {
    expect(readBeside(import.meta.url, path), path).not.toContain(word);
  }
  expect(files.some((path) => path.startsWith("probes/"))).toBe(false);
});
