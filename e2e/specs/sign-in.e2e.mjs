// sign_in_in_six_keys_or_clicks (PRD, "Sign-in in few clicks"; design task 2): from the unlocked vault's list, pick the
// login, open its site, copy the username and copy the password, counting every key and click a person would make; at most
// six. Each copy is checked on the clipboard. Opening the site hands a made-up address (a reserved .example name, which
// never resolves) to the PC's browser. The clipboard and the browser are this PC's: the measured steps run on CI, and on a
// PC only with LOCKBOX_E2E_PC_FREE=1 (the vault's setup still runs, and the skip is said with its reason).

import assert from "node:assert/strict";

import { $, browser } from "@wdio/globals";

import * as app from "../lib/app.mjs";
import { addLogin, attach, checkFoldersAfter, env, gone, note, row, see, setUpVault } from "../lib/steps.mjs";

const VAULT = "MU-e2e-signin";
// made at run time: nothing here is a literal secret, and each run's vault has its own
const stamp = String(Date.now());
const PASSWORD = ["MU", "e2e", "signin", stamp].join("-");
const SITE = "mu-e2e.example";
const LOGIN = { title: "MU-e2e site login", username: "MU-e2e-site-user", password: ["MU", "e2e", "site", stamp].join("-"), website: `https://${SITE}/login` };
// the PRD's measure: from the unlocked vault, at most this many keys or clicks to have both values copied
const MOST_INPUTS = 6;
const clipboard = app.clipboardSteps(env);

describe("sign_in_in_six_keys_or_clicks", () => {
  before(attach);

  it("sets up a vault with a login that has a website", async () => {
    await setUpVault(VAULT, PASSWORD);
    await addLogin(LOGIN);
    await app.press("Close panel");
    await gone("button", "Copy password");
  });

  it("picks the login, opens the site and copies both values in six keys or clicks or fewer", async function () {
    if (!clipboard.run) {
      note(`skip the sign-in measure: ${clipboard.why}`);
      this.skip();
    }
    app.restartIdleClock();
    // every key or click a person makes from here is counted, each named for the run's output
    const inputs = [];
    const started = Date.now();
    const input = async (what, act) => {
      inputs.push(what);
      await act();
    };
    const pick = await row(`Login: ${LOGIN.title}`);
    await input("pick the login", () => pick.click());
    await input(`open ${SITE}`, () => app.press(`Open ${SITE}`));
    await input("copy the username", () => app.press("Copy username"));
    await browser.waitUntil(() => app.readClipboard() === LOGIN.username, { timeout: 15_000, timeoutMsg: "the clipboard did not hold the username" });
    await input("copy the password", () => app.press("Copy password"));
    await browser.waitUntil(() => app.readClipboard() === LOGIN.password, { timeout: 15_000, timeoutMsg: "the clipboard did not hold the password" });
    console.log(`sign-in measure: ${String(inputs.length)} inputs (${inputs.join(", ")}) in ${String(Date.now() - started)} ms`);
    assert.ok(inputs.length <= MOST_INPUTS, `at most ${String(MOST_INPUTS)} keys or clicks (${String(inputs.length)}: ${inputs.join(", ")})`);
    // opening the site said nothing went wrong
    assert.equal(await (await $("role/alert")).isExisting(), false, "no refusal was shown");
  });

  after(() => {
    checkFoldersAfter();
    if (clipboard.run && [LOGIN.username, LOGIN.password].includes(app.readClipboard())) app.clearClipboard();
  });
});
