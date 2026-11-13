/// <reference types="vite/client" />
// The page's Content Security Policy and what the built page carries. Tauri adds a hash to the policy for every inline
// `<script>` and `<style>` it finds in the built HTML, so an inline one would be let through by the window without anyone
// changing the policy: the built page must have none. The Rust side pins the same policy as compiled (`security_config_is_pinned`).
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { readBeside } from "./testing/files";

/** The policy as agreed in the design (spec 4.1): nothing from outside the app, no inline script or style. */
const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; " +
  "connect-src ipc: http://ipc.localhost; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

test("csp_config_unchanged", () => {
  const config = JSON.parse(readBeside(import.meta.url, "../../crates/lockbox-desktop/tauri.conf.json")) as {
    app: { security: Record<string, unknown> };
  };
  // Exactly these two keys: no devCsp, no `dangerousDisableAssetCspModification`, no asset protocol.
  expect(config.app.security).toEqual({ csp: CSP, freezePrototype: true });
  // The page's own HTML adds no policy of its own and no inline code.
  const html = readBeside(import.meta.url, "../index.html");
  expect(html).not.toMatch(/http-equiv/i);
});

// The built page, found by name only (the glob loads nothing). It is there once `npm run build` has run, as CI runs it first.
const builtHtml = Object.keys(import.meta.glob("../dist/index.html"));

test("no_inline_styles_in_built_html", () => {
  expect(builtHtml, "No built page in ui/dist: run `npm run build` in ui/ first, then this test.").toHaveLength(1);
  const html = readFileSync(new URL(builtHtml[0] ?? "", import.meta.url), "utf8");
  expect(html, "a <style> element").not.toMatch(/<style[\s>]/i);
  expect(html, "a style attribute").not.toMatch(/\sstyle\s*=/i);
  // Every script is a file of the app's own, never code written into the page.
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  expect(scripts.length, "the page loads its script").toBeGreaterThan(0);
  for (const [, attributes = "", body = ""] of scripts) {
    expect(attributes, "a script with no src").toMatch(/\ssrc="\/assets\/[^"]+\.js"/);
    expect(body.trim(), "code inside a script element").toBe("");
  }
  // Style sheets come from the app's own files too.
  for (const [link] of html.matchAll(/<link\b[^>]*>/gi)) {
    if (/rel="stylesheet"/.test(link)) expect(link).toMatch(/href="\/assets\/[^"]+\.css"/);
  }
});
