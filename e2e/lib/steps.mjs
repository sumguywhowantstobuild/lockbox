// Steps the specs share: finding what a person sees by role and accessible name, the checks before a spec drives the app,
// and first-time setup of a throwaway vault in the folder the run made for the spec. Every value a spec types is made up
// and carries a plain marker (MU-). Never a class or an ID: a control is found the way a person or a screen reader finds it.

import assert from "node:assert/strict";
import { appendFileSync, existsSync, readdirSync } from "node:fs";

import { $, $$, browser } from "@wdio/globals";

import * as app from "./app.mjs";
import { pickFolder } from "./folderbox.mjs";

export const env = process.env;
export const locations = JSON.parse(env.PETALOCK_E2E_LOCATIONS ?? "{}");

/** Waits for the control with `role` and accessible `name` to show, and returns it. */
export async function see(role, name, timeout = 20_000) {
  const found = await $(app.by(role, name));
  await found.waitForDisplayed({ timeout, timeoutMsg: `no ${role} named "${name}" appeared` });
  return found;
}

/** Waits for the control with `role` and accessible `name` to be gone. */
export async function gone(role, name, timeout = 20_000) {
  const found = await $(app.by(role, name));
  await found.waitForExist({ timeout, reverse: true, timeoutMsg: `the ${role} named "${name}" did not go` });
}

/** A line for the run's results (`skip <step>: <why>`), read by scripts/e2e.mjs. */
export const note = (line) => appendFileSync(env.PETALOCK_E2E_RESULTS, `${line}\n`);

/**
 * A row of the item list, by the start of its accessible name (`Login: <title>`, then what the row shows of it). Rows are
 * buttons whose name runs on into the username, so an exact name can't find them.
 */
export async function row(start, timeout = 20_000) {
  let found = null;
  await browser.waitUntil(
    async () => {
      for (const button of await $$("role/button")) {
        if ((await button.getComputedLabel()).startsWith(start)) {
          found = button;
          return true;
        }
      }
      return false;
    },
    { timeout, timeoutMsg: `no row named like "${start}" appeared` },
  );
  return found;
}

/**
 * The checks before a spec drives the app: the driver is attached to the instance this run started, the window is off the
 * screen on a PC, the idle clock starts from now, the first screen shows, and the spec's vault folder starts empty.
 */
export async function attach() {
  const caps = browser.capabilities;
  const attached = app.checkAttached({
    debuggerAddress: caps["ms:edgeOptions"]?.debuggerAddress,
    processId: caps["goog:processID"],
    driver: { pid: Number(env.PETALOCK_E2E_DRIVER_PID), created: env.PETALOCK_E2E_DRIVER_CREATED },
    snapshot: app.snapshotProcesses(),
    listeners: app.tcpListeners(),
  });
  if (env.PETALOCK_E2E_OFFSCREEN === "1") await browser.setWindowRect(-4000, -4000, null, null);
  // Petalock's idle lock counts the session's input, not the app's: restart that clock (see the function)
  app.restartIdleClock();
  await see("heading", "Welcome to Petalock", 60_000);
  assert.equal(existsSync(env.PETALOCK_E2E_DEFAULT_VAULTS), false, "the default vault folder does not exist before the spec");
  assert.deepEqual(readdirSync(env.PETALOCK_E2E_VAULT_FOLDER), [], "the vault folder the run made starts empty");
  assert.ok(attached.pid > 0);
}

/** The checks after a spec: the default vault folder was never made, and the vault is in the spec's own folder. */
export function checkFoldersAfter() {
  assert.equal(existsSync(env.PETALOCK_E2E_DEFAULT_VAULTS), false, "the default vault folder was never made");
  assert.ok(readdirSync(env.PETALOCK_E2E_VAULT_FOLDER).length >= 1, "the vault is in the folder the run made");
}

/** First-time setup up to the recovery key: the vault `name` with `password`, made in the spec's own vault folder. */
export async function createVault(name, password) {
  await app.press("Create a vault");
  await see("heading", "Create your vault");
  await app.typeInto(app.by("textbox", "Vault name"), name);
  await app.typeInto(app.named("Password"), password);
  await app.typeInto(app.named("Password again"), password);
  await app.press("Change");
  await app.press("Create vault");
  await pickFolder({
    title: "Choose where to create the vault",
    pid: browser.capabilities["goog:processID"],
    folder: env.PETALOCK_E2E_VAULT_FOLDER,
    runRoot: env.PETALOCK_E2E_RUN_ROOT,
    locations,
  });
  await see("heading", "Save your recovery key", 60_000);
}

/** The recovery key's 24 words as the screen shows them: place to word. */
export async function readRecoveryKey() {
  const found = [];
  for (const item of await $$("role/listitem")) {
    const match = /^(\d+)([a-z]+)$/.exec(String(await item.getProperty("textContent")).trim());
    if (match) found.push({ place: Number(match[1]), word: match[2] });
  }
  assert.equal(found.length, 24, "the screen shows the 24 words of the key");
  const words = new Map(found.map((entry) => [entry.place, entry.word]));
  assert.equal(words.size, 24, "each of the 24 places is shown once");
  return words;
}

/** Answers the three questions about the key with the words read off the screen, and waits for the empty vault. */
export async function confirmRecoveryKey(words) {
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
}

/** First-time setup, whole: the vault made, its key confirmed, and the empty vault open. */
export async function setUpVault(name, password) {
  await createVault(name, password);
  await confirmRecoveryKey(await readRecoveryKey());
}

/**
 * Adds a login, and waits for it to open with its copy buttons: from the empty vault's own Login button, or, once the vault
 * has items, from the toolbar's Add menu.
 */
export async function addLogin({ title, username, password, website }) {
  if (await $(app.by("button", "Login")).isExisting()) {
    await app.press("Login");
  } else {
    await app.press("Add");
    await (await see("menuitem", "Login")).click();
  }
  await see("heading", "New login");
  await app.typeInto(app.by("textbox", "Title"), title);
  await app.typeInto(app.by("textbox", "Username"), username);
  if (website !== undefined) await app.typeInto(app.by("textbox", "Website"), website);
  await app.typeInto(app.named("Password"), password);
  await app.press("Save");
  await see("button", "Copy password");
}

/**
 * The value the open item shows after Reveal (made-up values only), hidden again after: `box` is the revealed box's name,
 * "Password" for a login and "Key value" for a key.
 */
export async function revealed(box) {
  await app.press("Reveal");
  const shown = await see("textbox", box);
  const text = String(await shown.getProperty("textContent"));
  await app.press("Hide");
  await gone("textbox", box);
  return text;
}
