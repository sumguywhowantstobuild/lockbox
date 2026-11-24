// thin_path_create_lock_unlock_add_copy_autolock: first-time setup of a throwaway vault, its recovery key confirmed by
// the words read off the screen, an observed lock, a password unlock, a login added, its password copied (checked on
// the clipboard where the run may use it), the shortest auto-lock, and the lock screen shown by the clock alone.
// Every value is made up and carries a plain marker (MU-). Controls are found by role and accessible name.

import assert from "node:assert/strict";

import { $, browser } from "@wdio/globals";

import * as app from "../lib/app.mjs";
import { addLogin, attach, checkFoldersAfter, confirmRecoveryKey, createVault, env, note, readRecoveryKey, see } from "../lib/steps.mjs";

const VAULT = "MU-e2e";
// made at run time: nothing here is a literal secret, and each run's vault has its own
const stamp = String(Date.now());
const PASSWORD = ["MU", "e2e", "vault", stamp].join("-");
const LOGIN_TITLE = "MU-e2e login";
const LOGIN_USER = "MU-e2e-user";
const LOGIN_PASSWORD = ["MU", "e2e", "login", stamp].join("-");

const clipboard = app.clipboardSteps(env);
// the GitHub e2e job (its own marker; the generic CI=true counts for nothing)
const onCi = env.LOCKBOX_E2E_CI === "1";
// the clipboard clears itself after this long, once the password is copied: the lock must be seen well before
const CLIPBOARD_SECONDS = 300;
// the lock comes a minute after the last input (the shortest setting), on the app's 5-second clock; this is the allowance on top
const LOCK_ALLOWANCE_MS = 25_000;
let copiedAt = 0;

describe("thin_path_create_lock_unlock_add_copy_autolock", () => {
  before(attach);

  it("creates the vault in a folder the run made", async () => {
    await createVault(VAULT, PASSWORD);
  });

  it("confirms the recovery key by the words read from the screen", async () => {
    await confirmRecoveryKey(await readRecoveryKey());
  });

  it("locks, and the lock screen shows", async () => {
    await app.press("Lock all");
    await see("heading", `Unlock ${VAULT}`);
    assert.equal(await (await $(app.by("button", "Login"))).isExisting(), false, "the vault's items are not on the screen");
  });

  it("unlocks with the password", async () => {
    app.restartIdleClock();
    await app.unlock(VAULT, PASSWORD);
    await see("button", "Login");
  });

  it("sets the clipboard to clear after the longest time, before anything is copied", async () => {
    // set first, so the copy below arms this timer and not the default one: the lock, not the timer, is what must clear it
    await app.press("Settings");
    await see("heading", "Settings");
    await (await see("combobox", "Clear clipboard after")).click();
    await (await see("option", `${String(CLIPBOARD_SECONDS)} seconds`)).click();
    await app.press("Close panel");
    await see("button", "Login");
  });

  it("adds a login", async () => {
    await addLogin({ title: LOGIN_TITLE, username: LOGIN_USER, password: LOGIN_PASSWORD });
  });

  it("copies the password, and the clipboard holds it", async function () {
    if (!clipboard.run) {
      note(`skip the clipboard check: ${clipboard.why}`);
      this.skip();
    }
    await app.press("Copy password");
    copiedAt = Date.now();
    await browser.waitUntil(() => app.readClipboard() === LOGIN_PASSWORD, { timeout: 15_000, timeoutMsg: "the clipboard did not hold the password" });
  });

  it("locks by itself at the shortest auto-lock, and the clipboard is cleared", async function () {
    await app.press("Settings");
    await see("heading", "Settings");
    await (await see("combobox", "Lock after idle")).click();
    await (await see("option", "1 minute")).click();
    // the copied password is on the clipboard now, before the wait begins
    if (clipboard.run) assert.equal(app.readClipboard(), LOGIN_PASSWORD, "the copied password is on the clipboard before the idle wait");
    // The idle clock starts now, after the setting: the lock comes a minute after the last input, whatever came before.
    app.restartIdleClock();
    const started = Date.now();
    const limit = onCi ? 60_000 + LOCK_ALLOWANCE_MS : 270_000;
    let lockedAfter = null;
    let quietest = 0;
    while (Date.now() - started < limit) {
      if (await $(app.by("heading", `Unlock ${VAULT}`)).isDisplayed()) {
        lockedAfter = Date.now() - started;
        break;
      }
      // how long the PC has been quiet at its longest, so that a skip can tell "in use" from "should have locked"
      quietest = Math.max(quietest, app.idleSeconds());
      await browser.pause(2000);
    }
    if (lockedAfter === null) {
      if (onCi) throw new Error(`no lock within ${String(limit / 1000)} s of setting one minute on CI (a minute plus ${String(LOCK_ALLOWANCE_MS / 1000)} s)`);
      if (quietest >= 70) throw new Error(`the PC had been quiet for ${quietest} s and the vault did not lock; one minute was set`);
      note(`skip the auto-lock check: the PC was in use (quiet for at most ${quietest} s of the 60 the lock needs)`);
      this.skip();
    }
    assert.ok(lockedAfter >= 50_000, `the lock came a minute after the setting, not at once (${Math.round(lockedAfter / 1000)} s)`);
    if (clipboard.run) {
      const sinceCopy = Date.now() - copiedAt;
      assert.ok(sinceCopy < (CLIPBOARD_SECONDS - 20) * 1000, `the lock was seen before the clipboard's own timer could clear it (${Math.round(sinceCopy / 1000)} s after the copy)`);
      await browser.waitUntil(() => app.readClipboard() === "", { timeout: 15_000, timeoutMsg: "the clipboard was not cleared by the lock" });
    } else {
      note(`skip the clipboard cleared check: ${clipboard.why}`);
    }
  });

  after(async () => {
    checkFoldersAfter();
    if (clipboard.run && app.readClipboard() === LOGIN_PASSWORD) app.clearClipboard();
  });
});
