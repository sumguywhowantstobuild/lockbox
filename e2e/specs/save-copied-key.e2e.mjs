// save_a_copied_key_with_every_vault_locked (design, "How a copied key gets saved", 8b): with every vault locked, a made-up
// key is put on the clipboard and the real save shortcut (Ctrl+Shift+L, pressed as keyboard input) is pressed; the lock
// screen turns into "Save what you copied", the clipboard then gets another made-up value (the key must be the one held
// when the shortcut was pressed, read once), the vault is unlocked there, the key is named and saved, and the saved value is
// read back, and again after the vault is locked and opened. The shortcut and the clipboard are this PC's: those steps run
// on CI, and on a PC only with LOCKBOX_E2E_PC_FREE=1 (the vault's setup and lock still run, and the skip is said with its
// reason). Values are compared without ever being printed.

import assert from "node:assert/strict";

import * as app from "../lib/app.mjs";
import { attach, checkFoldersAfter, env, gone, note, revealed, row, see, setUpVault } from "../lib/steps.mjs";

const VAULT = "MU-e2e-capture";
// made at run time: nothing here is a literal secret, and each run's vault has its own
const stamp = String(Date.now());
const PASSWORD = ["MU", "e2e", "capture", stamp].join("-");
const KEY_NAME = "MU_E2E_CAPTURED_KEY";
const KEY_VALUE = ["mu", "e2e", "key", stamp].join("-");
// copied after the shortcut: Petalock must not read the clipboard again when it saves
const LATER_VALUE = ["mu", "e2e", "later", stamp].join("-");
const clipboard = app.clipboardSteps(env);

const readBack = async () => {
  await (await row(`Key: ${KEY_NAME}`)).click();
  await see("button", "Copy key");
  const value = await revealed("Key value");
  assert.ok(value === KEY_VALUE, "the saved key holds the value that was on the clipboard when the shortcut was pressed");
};

describe("save_a_copied_key_with_every_vault_locked", () => {
  before(attach);

  it("sets up a vault", async () => {
    await setUpVault(VAULT, PASSWORD);
  });

  it("locks every vault", async () => {
    await app.press("Lock all");
    await see("heading", `Unlock ${VAULT}`);
  });

  it("saves a copied key through the real shortcut, unlocking on the way", async function () {
    if (!clipboard.run) {
      note(`skip the save shortcut and the clipboard: ${clipboard.why}`);
      this.skip();
    }
    app.restartIdleClock();
    app.writeClipboard(KEY_VALUE);
    // the shortcut captures whatever is on the clipboard: never press it unless the made-up value is still there
    assert.ok(app.readClipboard() === KEY_VALUE, "the made-up key is on the clipboard before the shortcut");
    app.pressSaveShortcut();
    // 8b: with every vault locked, the lock screen asks first, for the vault the value goes to
    await see("heading", "Save what you copied", 30_000);
    app.writeClipboard(LATER_VALUE);
    await app.typeInto(app.named(`Password for ${VAULT}`), PASSWORD);
    await app.press("Unlock and continue");
    // then the box, with the vault open: name and folder
    await app.typeInto(app.by("textbox", "Name"), KEY_NAME);
    await app.press("Save");
    await gone("heading", "Save what you copied", 30_000);
  });

  it("reads the saved value back from the vault, and again after it is locked and opened", async function () {
    if (!clipboard.run) {
      note(`skip reading the saved key back: ${clipboard.why}`);
      this.skip();
    }
    await readBack();
    app.restartIdleClock();
    await app.press("Lock all");
    await see("heading", `Unlock ${VAULT}`);
    await app.unlock(VAULT, PASSWORD);
    await readBack();
  });

  after(() => {
    checkFoldersAfter();
    if (clipboard.run && [KEY_VALUE, LATER_VALUE].includes(app.readClipboard())) app.clearClipboard();
  });
});
