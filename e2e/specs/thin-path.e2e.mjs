// thin_path_create_lock_unlock_add_copy_autolock: first-time setup of a throwaway vault, its recovery key confirmed by
// the words read off the screen, an observed lock, a password unlock, a login added, its password copied (checked on
// the clipboard where the run may use it), the shortest auto-lock, and the lock screen shown by the clock alone.
// Every value is made up and carries a plain marker (MU-). Controls are found by role and accessible name.

import assert from "node:assert/strict";
import { appendFileSync, existsSync, readdirSync } from "node:fs";

import { $, $$, browser } from "@wdio/globals";

import * as app from "../lib/app.mjs";
import { pickFolder } from "../lib/folderbox.mjs";

const VAULT = "MU-e2e";
// made at run time: nothing here is a literal secret, and each run's vault has its own
const stamp = String(Date.now());
const PASSWORD = ["MU", "e2e", "vault", stamp].join("-");
const LOGIN_TITLE = "MU-e2e login";
const LOGIN_USER = "MU-e2e-user";
const LOGIN_PASSWORD = ["MU", "e2e", "login", stamp].join("-");

const env = process.env;
const locations = JSON.parse(env.LOCKBOX_E2E_LOCATIONS ?? "{}");
const clipboard = app.clipboardSteps(env);
// the GitHub e2e job (its own marker; the generic CI=true counts for nothing)
const onCi = env.LOCKBOX_E2E_CI === "1";
// the clipboard clears itself after this long, once the password is copied: the lock must be seen well before
const CLIPBOARD_SECONDS = 300;
// the lock comes a minute after the last input (the shortest setting), on the app's 5-second clock; this is the allowance on top
const LOCK_ALLOWANCE_MS = 25_000;
let copiedAt = 0;

const see = async (role, name, timeout = 20_000) => {
  const found = await $(app.by(role, name));
  await found.waitForDisplayed({ timeout, timeoutMsg: `no ${role} named "${name}" appeared` });
  return found;
};

const gone = async (role, name, timeout = 20_000) => {
  const found = await $(app.by(role, name));
  await found.waitForExist({ timeout, reverse: true, timeoutMsg: `the ${role} named "${name}" did not go` });
};

const note = (line) => appendFileSync(env.LOCKBOX_E2E_RESULTS, `${line}\n`);

describe("thin_path_create_lock_unlock_add_copy_autolock", () => {
  before(async () => {
    const caps = browser.capabilities;
    const attached = app.checkAttached({
      debuggerAddress: caps["ms:edgeOptions"]?.debuggerAddress,
      processId: caps["goog:processID"],
      driver: { pid: Number(env.LOCKBOX_E2E_DRIVER_PID), created: env.LOCKBOX_E2E_DRIVER_CREATED },
      snapshot: app.snapshotProcesses(),
      listeners: app.tcpListeners(),
    });
    if (env.LOCKBOX_E2E_OFFSCREEN === "1") await browser.setWindowRect(-4000, -4000, null, null);
    // Lockbox's idle lock counts the session's input, not the app's: restart that clock (see the function)
    app.restartIdleClock();
    await see("heading", "Welcome to Lockbox", 60_000);
    assert.equal(existsSync(env.LOCKBOX_E2E_DEFAULT_VAULTS), false, "the default vault folder does not exist before the run");
    assert.deepEqual(readdirSync(env.LOCKBOX_E2E_VAULT_FOLDER), [], "the vault folder the run made starts empty");
    assert.ok(attached.pid > 0);
  });

  it("creates the vault in a folder the run made", async () => {
    await app.press("Create a vault");
    await see("heading", "Create your vault");
    await app.typeInto(app.by("textbox", "Vault name"), VAULT);
    await app.typeInto(app.named("Password"), PASSWORD);
    await app.typeInto(app.named("Password again"), PASSWORD);
    await app.press("Change");
    await app.press("Create vault");
    await pickFolder({
      title: "Choose where to create the vault",
      pid: browser.capabilities["goog:processID"],
      folder: env.LOCKBOX_E2E_VAULT_FOLDER,
      runRoot: env.LOCKBOX_E2E_RUN_ROOT,
      locations,
    });
    await see("heading", "Save your recovery key", 60_000);
  });

  it("confirms the recovery key by the words read from the screen", async () => {
    const items = await $$("role/listitem");
    const found = [];
    for (const item of items) {
      const match = /^(\d+)([a-z]+)$/.exec(String(await item.getProperty("textContent")).trim());
      if (match) found.push({ place: Number(match[1]), word: match[2] });
    }
    assert.equal(found.length, 24, "the screen shows the 24 words of the key");
    const words = new Map(found.map((entry) => [entry.place, entry.word]));
    assert.equal(words.size, 24, "each of the 24 places is shown once");
    await app.press("Continue");
    await see("heading", "Check your recovery key");
    let previous = "";
    for (let asked = 0; asked < 3; asked += 1) {
      const group = await $("role/group");
      await browser.waitUntil(async () => (await group.getComputedLabel()) !== previous, { timeoutMsg: "the next question did not come" });
      const label = await group.getComputedLabel();
      previous = label;
      const place = Number(/number (\d+)/.exec(label)?.[1]);
      assert.ok(words.has(place), `a question about a place the key has (${label})`);
      await app.press(words.get(place));
    }
    await see("button", "Login", 60_000);
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
    await app.press("Login");
    await see("heading", "New login");
    await app.typeInto(app.by("textbox", "Title"), LOGIN_TITLE);
    await app.typeInto(app.by("textbox", "Username"), LOGIN_USER);
    await app.typeInto(app.named("Password"), LOGIN_PASSWORD);
    await app.press("Save");
    await see("button", "Copy password");
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
    assert.equal(existsSync(env.LOCKBOX_E2E_DEFAULT_VAULTS), false, "the default vault folder was never made");
    assert.ok(readdirSync(env.LOCKBOX_E2E_VAULT_FOLDER).length >= 1, "the vault is in the folder the run made");
    if (clipboard.run && app.readClipboard() === LOGIN_PASSWORD) app.clearClipboard();
  });
});
