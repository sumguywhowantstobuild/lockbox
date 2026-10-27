import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import App from "./App";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

// Vitest globals are off, so Testing Library does not unmount between tests by itself.
afterEach(cleanup);

test("renders_version_from_app_info", async () => {
  invoke.mockResolvedValue({ version: "9.8.7" });
  render(<App />);
  expect(await screen.findByText("Lockbox 9.8.7")).toBeTruthy();
  expect(invoke).toHaveBeenCalledWith("app_info");
  expect(screen.getByRole("heading", { name: "Hands-on checks" })).toBeTruthy();
});

test("hands_on_probes_are_listed", async () => {
  invoke.mockResolvedValue({ version: "9.8.7" });
  render(<App />);
  await screen.findByText("Lockbox 9.8.7");
  expect(screen.getByRole("button", { name: "Navigate away" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Open a popup" })).toBeTruthy();
  expect(screen.getByRole("link", { name: "Download a file" }).getAttribute("download")).toBe("x.txt");
  expect(screen.getByTestId("drop-zone").textContent).toBe("Drop a file here");
  expect(screen.queryByText("A dropped file reached the page")).toBeNull();
});
