import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  // Tauri's devUrl and the window's navigation rule both name this port: never move to another one.
  server: { port: 5173, strictPort: true },
  // Built files are embedded in the Rust binary; no source maps ship with them.
  build: { sourcemap: false },
  test: { environment: "jsdom" },
});
