// WebdriverIO's settings for the end-to-end run. `node scripts/e2e.mjs` starts tauri-driver (which starts msedgedriver,
// which starts the app) and sets every LOCKBOX_E2E_* variable read here; this file is not meant to be run by hand.
//
// The script runs this once per spec file, each on a fresh test state: the app starts when the session is made and is
// closed when it ends. Within a spec the first failure stops it: a path's steps depend on the ones before them.

import { appendFileSync } from "node:fs";

const need = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set: run node scripts/e2e.mjs`);
  return value;
};

const results = need("LOCKBOX_E2E_RESULTS");

export const config = {
  runner: "local",
  hostname: "127.0.0.1",
  port: Number(need("LOCKBOX_E2E_DRIVER_PORT")),
  path: "/",
  specs: ["./specs/**/*.e2e.mjs"],
  maxInstances: 1,
  capabilities: [
    {
      maxInstances: 1,
      // WebDriver Classic only: msedgedriver is asked for nothing it does not answer
      "wdio:enforceWebDriverClassic": true,
      "tauri:options": { application: need("LOCKBOX_E2E_APP") },
    },
  ],
  logLevel: "warn",
  waitforTimeout: 15_000,
  connectionRetryCount: 0,
  framework: "mocha",
  reporters: ["spec"],
  mochaOpts: { ui: "bdd", timeout: 600_000, bail: true },
  // one line per step, read by scripts/e2e.mjs: a run that passed nothing is not a pass
  // (a step the spec skips on purpose is neither: it writes its own "skip" line, with the reason)
  afterTest: async (test, _context, { passed, error }) => {
    if (!passed && error === undefined) return;
    appendFileSync(results, `${passed ? "pass" : "fail"} ${test.title}\n`);
    if (!passed) {
      // what the window said when the step failed: its headings and alerts only, never an item's values
      try {
        const said = await browser.execute(() =>
          [...document.querySelectorAll("h1, h2, [role=alert], [role=status]")].map((element) => (element.textContent ?? "").trim().slice(0, 160)).filter(Boolean),
        );
        console.log(`on screen at the failure: ${JSON.stringify(said)}`);
      } catch {
        console.log("on screen at the failure: the window could not be read");
      }
    }
  },
};
