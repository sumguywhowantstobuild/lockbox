import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  // Tauri's devUrl and the window's navigation rule both name this port: never move to another one.
  server: { port: 5173, strictPort: true },
  // Built files are embedded in the Rust binary; no source maps ship with them. Nothing is turned into a `data:`
  // URI (the default does that to small files): the Content Security Policy takes fonts only from the app itself.
  build: { sourcemap: false, assetsInlineLimit: 0 },
  // 15 s a test, not Vitest's 5 s: the screen tests that drive a whole flow take 1 to 2 s alone, and up to just over 5 s
  // when the full suite runs every file at once beside the check's other lanes (four different tests timed out that way
  // on 2026-11-23, each passing alone). A test that truly hangs still fails.
  test: { environment: "jsdom", testTimeout: 15_000 },
});
