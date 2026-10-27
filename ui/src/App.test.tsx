import { render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import App from "./App";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

test("renders_version_from_app_info", async () => {
  invoke.mockResolvedValue({ version: "9.8.7" });
  render(<App />);
  expect(await screen.findByText("Lockbox 9.8.7")).toBeTruthy();
  expect(invoke).toHaveBeenCalledWith("app_info");
  expect(screen.getByRole("heading", { name: "Hands-on checks" })).toBeTruthy();
});
