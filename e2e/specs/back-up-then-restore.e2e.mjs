// back_up_then_restore (design, "End to end"): a throwaway vault with a made-up login is backed up into the run's own
// files folder through Windows' Save box; a second login is added after the backup; the backup is restored over the vault
// (Replace, which keeps the current vault beside it), unlocked with the password from when it was made, and the first
// login's password is read back from the restored vault while the login added after the backup is not there. Windows' file
// boxes are answered by window messages, off the screen; nothing here uses this PC's keyboard or clipboard.

import assert from "node:assert/strict";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { $, browser } from "@wdio/globals";

import * as app from "../lib/app.mjs";
import { pickFile, pickFolder } from "../lib/folderbox.mjs";
import { addLogin, attach, checkFoldersAfter, env, gone, locations, revealed, row, see, setUpVault } from "../lib/steps.mjs";

const VAULT = "MU-e2e-restore";
// made at run time: nothing here is a literal secret, and each run's vault has its own
const stamp = String(Date.now());
const PASSWORD = ["MU", "e2e", "restore", stamp].join("-");
const KEPT = { title: "MU-e2e kept login", username: "MU-e2e-kept-user", password: ["MU", "e2e", "kept", stamp].join("-") };
const LATER = { title: "MU-e2e later login", username: "MU-e2e-later-user", password: ["MU", "e2e", "later", stamp].join("-") };
const BACKUP = join(env.LOCKBOX_E2E_FILES_FOLDER ?? "", "MU-e2e.petalock-backup");
const pid = () => browser.capabilities["goog:processID"];

describe("back_up_then_restore", () => {
  before(async () => {
    assert.deepEqual(readdirSync(env.LOCKBOX_E2E_FILES_FOLDER), [], "the files folder the run made starts empty");
    await attach();
  });

  it("sets up a vault with a made-up login", async () => {
    await setUpVault(VAULT, PASSWORD);
    await addLogin(KEPT);
  });

  it("backs the vault up into the run's own folder", async () => {
    await app.press("Settings");
    await see("heading", "Settings");
    await app.press("Back up");
    await see("heading", "Back up");
    await app.press("Back up");
    await pickFile({ title: "Back up this vault", pid: pid(), file: BACKUP, runRoot: env.LOCKBOX_E2E_RUN_ROOT, locations });
    await see("button", "Done", 120_000);
    // a Save box can seem to take a name and save elsewhere: the backup must be where it was asked to go
    // counts only, never names (R5): what the two folders hold says where a misdirected save went
    const where = () => `the files folder holds ${String(readdirSync(env.LOCKBOX_E2E_FILES_FOLDER).length)} entries, the vault folder ${String(readdirSync(env.LOCKBOX_E2E_VAULT_FOLDER).length)}`;
    assert.equal(existsSync(BACKUP), true, `the backup is in the run's files folder (${where()})`);
    assert.ok(statSync(BACKUP).size > 0, "the backup has something in it");
    await app.press("Done");
  });

  it("adds a login after the backup", async () => {
    await addLogin(LATER);
  });

  it("restores the backup over the vault", async () => {
    await app.press("Settings");
    await see("heading", "Settings");
    // the Windows picker comes first; the restore's steps show once a backup is picked
    await app.press("Restore a backup");
    await pickFile({ title: "Restore a backup", pid: pid(), file: BACKUP, runRoot: env.LOCKBOX_E2E_RUN_ROOT, locations });
    await see("heading", "Restore a backup");
    await see("button", "Pick another");
    await app.typeInto(app.named("Password or recovery key from when it was made"), PASSWORD);
    await app.press("Continue");
    await see("heading", "Where it goes", 60_000);
    // into the spec's own vault folder, where the vault is (the usual vaults folder is never used by a run): there the
    // restore replaces the vault, after asking
    await app.press("Choose another");
    await pickFolder({ title: "Restore into this folder", pid: pid(), folder: env.LOCKBOX_E2E_VAULT_FOLDER, runRoot: env.LOCKBOX_E2E_RUN_ROOT, locations });
    await browser.waitUntil(async () => (await browser.execute(() => document.body.innerText)).includes(`${VAULT} is already in this folder`), {
      timeout: 30_000,
      timeoutMsg: "the restore did not say it would replace the vault in its folder",
    });
    await app.press("Restore");
    await see("heading", "Replace your vault with this?", 120_000);
    await app.press("Replace");
    await see("heading", `${VAULT} is restored`, 120_000);
  });

  it("unlocks the restored vault with the password from when the backup was made", async () => {
    app.restartIdleClock();
    // the box is named for the day the backup was made ("Password from <day>"): found by its visible label
    const box = await $(`//input[@id=//label[starts-with(normalize-space(.), "Password from")]/@for]`);
    await box.waitForDisplayed({ timeout: 15_000 });
    await box.setValue(PASSWORD);
    await app.press("Unlock");
    await see("heading", "All items", 60_000);
  });

  it("reads the made-up password back from the restored vault, and the later login is not there", async () => {
    await (await row(`Login: ${KEPT.title}`)).click();
    await see("button", "Copy password");
    // compared without printing the value, even on a failure
    const value = await revealed("Password");
    assert.ok(value === KEPT.password, "the restored login holds the password from before the backup");
    await app.press("Close panel");
    await gone("button", "Copy password");
    const later = await browser.execute((title) => document.body.innerText.includes(title), LATER.title);
    assert.equal(later, false, "the login added after the backup is not in the restored vault");
  });

  after(() => {
    checkFoldersAfter();
  });
});
