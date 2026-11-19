import { useEffect, useRef, useState, type SyntheticEvent } from "react";
import type { VaultEntry } from "../api";
import { useLockEpoch } from "../jobs";
import { messageFor, type Message } from "../messages";
import { PasswordField } from "../parts/PasswordField";
import { Pattern, VaultMark, vaultLook } from "../parts/Pattern";
import {
  cancelCapture,
  clearUnlockPick,
  leaveUnlockStep,
  startForgot,
  startOpenBackup,
  startRestore,
  unlock,
  unlockInStep,
  useCapture,
  useOpenBackup,
  useRestore,
  useStartError,
  useUnlockPick,
  useVaults,
  type UnlockStep as UnlockStepOf,
} from "../store";
import { useMode } from "../theme";
import { listedName } from "../vaultWords";
import { LockNote, LockScreenAsks } from "./Asks";
import { DamagedVaultAsk } from "./RestoreNotices";

/** A refusal as one line of text. */
function said(message: Message): string {
  return message.body === "" ? message.title : `${message.title} ${message.body}`;
}

/**
 * The unlock step of one more vault while another is open (the vault menu, the vault strip and Copy to a vault bring it): the lock screen's own look and form, for the one
 * vault the step was opened for, with Back (and Escape) to the window that was on screen. The password is typed once and goes with the vault's registry ID; it is wiped from
 * the box as it is sent (so a refusal, "Wrong password.", shows an empty box), by Back, and by every lock epoch, and Ask 16 (kept for that vault alone) is said above the box.
 * A vault whose details can't be read has Ask 8 here instead of a box, as on the lock screen. The vaults that are open are not touched by anything here.
 */
export function UnlockStep({ step }: { step: UnlockStepOf }) {
  const vaults = useVaults();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Every lock epoch (Lock all, an idle lock, Windows locking or sleeping) wipes what is typed, even before the vaults' own locks are heard.
  const epoch = useLockEpoch();
  const [seenEpoch, setSeenEpoch] = useState(epoch);
  if (seenEpoch !== epoch) {
    setSeenEpoch(epoch);
    setPassword("");
  }
  const list = vaults ?? [];
  const vault = list.find((entry) => entry.id === step.vault);
  const position = vault === undefined ? 0 : list.indexOf(vault);
  // A vault that has left the list, or can't be reached now, has nothing to unlock: the step goes.
  const gone = vault?.available !== true;
  useEffect(() => {
    if (gone) leaveUnlockStep();
  }, [gone]);
  if (vault === undefined || gone) return null;
  const name = listedName(vault);

  const back = () => {
    setPassword("");
    setError(null);
    leaveUnlockStep();
  };
  if (vault.details_damaged) return <DamagedVaultAsk vault={vault.id} name={vault.name} onBack={back} />;

  const submit = async (event: SyntheticEvent) => {
    event.preventDefault();
    if (password === "" || busy) return;
    // The text goes once, and is gone from here as it goes: the box is empty whatever comes back.
    const text = password;
    setPassword("");
    setError(null);
    setBusy(true);
    try {
      await unlockInStep(step.opening, text);
    } catch (refusal) {
      setError(said(messageFor(refusal)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="lock"
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.defaultPrevented) back();
      }}
    >
      <header className="field">
        <Pattern points={vaultLook(position, false).points} className="rose" />
        <p className="mark">Lockbox</p>
        <p className="say">Your items stay encrypted until you enter the password.</p>
      </header>
      <main className="plate">
        <h1>{`Unlock ${name}`}</h1>
        <div className="asks">
          <LockNote vault={vault.id} />
        </div>
        <form onSubmit={(event) => void submit(event)}>
          <PasswordField
            label={`Password for ${name}`}
            autoComplete="current-password"
            value={password}
            onChange={(next) => {
              setPassword(next);
              setError(null);
            }}
            error={error}
            readOnly={busy}
            autoFocus
          />
          <div className="lacts">
            <button type="submit" className="prim" disabled={busy || password === ""}>
              Unlock
            </button>
            <button type="button" className="lnk" onClick={back}>
              Back
            </button>
          </div>
        </form>
      </main>
    </div>
  );
}

/**
 * The lock screen: the vaults to pick from (with one, it is already chosen), the password, Unlock, and Forgot password? (28a, for the vault chosen). Nothing here
 * leads to a screen a later plan builds. A wrong password says so and keeps what was typed, so a typo can be mended; once a vault
 * opens the field is emptied, and if the vault locked again before the answer came there is nothing to say.
 *
 * While a copy from the save shortcut waits (8b), it is the same screen with the save step's words: the heading says what the unlock is for,
 * the button is "Unlock and continue" (the save box opens in the vault), and Cancel lets the copy go. The copy is held in the shell, never here.
 */
export function LockScreen() {
  const vaults = useVaults();
  const startError = useStartError();
  const capture = useCapture();
  // The picker of Restore a backup is open: a second press sends nothing.
  const restoring = useRestore() !== null;
  // The same for Open a backup's picker (its steps are the app's, and take this screen's place once a file is picked).
  const opening = useOpenBackup() !== null;
  // The vault 26c's Unlock asked for (a folder that just came in): chosen from the first drawing on, once.
  const asked = useUnlockPick();
  const [chosenId, setChosenId] = useState<number | null>(asked);
  useEffect(() => {
    if (asked !== null) clearUnlockPick();
  }, [asked]);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The finished restore's Unlock draws the password box anew, so it takes the focus (a box that stayed would not: it is only focused as it is drawn).
  const [focusBox, setFocusBox] = useState(0);
  // A vault that can't be opened and is the only one there is: Back from Ask 8 leaves the lock screen as it was, with its box.
  const [backFrom, setBackFrom] = useState<number | null>(null);
  // A second press before the first has an answer must not send a second unlock, and state changes too late for that.
  const unlocking = useRef(false);
  const mode = useMode();

  // With no vault open there is no session and so no lock event: a password typed here (kept after a wrong one so a typo
  // can be mended) must not sit in the field while the person has gone, the PC locked (Win+L), or the window hidden.
  useEffect(() => {
    const leave = () => {
      setPassword("");
    };
    const hide = () => {
      if (document.visibilityState === "hidden") leave();
    };
    window.addEventListener("blur", leave);
    document.addEventListener("visibilitychange", hide);
    return () => {
      window.removeEventListener("blur", leave);
      document.removeEventListener("visibilitychange", hide);
    };
  }, []);

  const list = vaults ?? [];
  // The chosen vault, or the first that can be opened (one whose details are damaged has Ask 8 instead of a box), or the first that can be reached.
  const chosen =
    list.find((vault) => vault.id === chosenId && vault.available) ?? list.find((vault) => vault.available && !vault.details_damaged) ?? list.find((vault) => vault.available);
  const position = chosen === undefined ? 0 : list.indexOf(chosen);
  const name = (vault: VaultEntry) => vault.name ?? "A vault that can't be read";

  const submit = async (event: SyntheticEvent) => {
    event.preventDefault();
    if (chosen === undefined || password === "" || unlocking.current) return;
    unlocking.current = true;
    setBusy(true);
    setError(null);
    try {
      await unlock(chosen.id, password);
      // The vault is open (or locked again already): the password has done its work.
      setPassword("");
    } catch (refusal) {
      setError(said(messageFor(refusal)));
    } finally {
      unlocking.current = false;
      setBusy(false);
    }
  };

  let heading = "Unlock a vault";
  if (vaults !== null && list.length === 0) heading = "No vaults yet";
  else if (list.length === 1 && chosen !== undefined) heading = `Unlock ${name(chosen)}`;
  if (capture !== null) heading = "Save what you copied";

  // Ask 8: both copies of the vault's details are damaged (the list says so), so no password can open it. Its own screen takes the place of the box; Back is
  // another vault that can be opened when there is one, and the lock screen as it was when there is not. A vault with no name for another reason keeps the box.
  if (capture === null && chosen !== undefined && chosen.details_damaged && backFrom !== chosen.id) {
    const other = list.find((vault) => vault.available && !vault.details_damaged);
    return (
      <DamagedVaultAsk
        vault={chosen.id}
        name={chosen.name}
        onBack={() => {
          setPassword("");
          setError(null);
          if (other === undefined) setBackFrom(chosen.id);
          else setChosenId(other.id);
        }}
      />
    );
  }

  return (
    <div
      className="lock"
      onKeyDown={(event) => {
        // Escape is Cancel on the save step, as it is in the box.
        if (event.key === "Escape" && capture !== null && !event.defaultPrevented) cancelCapture();
      }}
    >
      {/* The page's banner: its line says what the save step holds, so a screen reader moving by landmarks must reach it. */}
      <header className="field">
        <Pattern points={vaultLook(position, false).points} className="rose" />
        <p className="mark">Lockbox</p>
        <p className="say">
          {capture === null
            ? "Your items stay encrypted until you enter the password."
            : capture.state === "value"
              ? "Your copied key is held here until you save it or cancel."
              : "Unlock to paste or type a key and save it, or cancel."}
        </p>
      </header>
      <main className="plate">
        <h1>{heading}</h1>
        <LockScreenAsks
          chosen={chosen?.id ?? null}
          onUnlock={(vault) => {
            if (vault !== null) setChosenId(vault);
            setPassword("");
            setError(null);
            setFocusBox((count) => count + 1);
          }}
        />
        {startError !== null ? (
          <p className="err" role="alert">
            {said(messageFor(startError))}
          </p>
        ) : null}
        {vaults === null && startError === null ? (
          <p className="note" aria-busy="true">
            Opening…
          </p>
        ) : null}
        {vaults !== null && list.length === 0 ? <p className="note">There is no vault here yet.</p> : null}
        {list.length > 1 ? (
          <fieldset className="vlist">
            <legend className="sr">Vault</legend>
            {list.map((vault, index) => (
              // Its own colour (the mode class beside it, so the variables resolve here) and its own shape.
              <label
                key={vault.id}
                className={`${vault.id === chosen?.id ? "vbtn on" : vault.available ? "vbtn" : "vbtn off"} mode-${mode} v-${vaultLook(index, false).accent}`}
              >
                <input
                  type="radio"
                  className="vradio"
                  name="vault"
                  checked={vault.id === chosen?.id}
                  disabled={!vault.available}
                  onChange={() => {
                    setChosenId(vault.id);
                    setPassword("");
                    setError(null);
                  }}
                />
                <VaultMark points={vaultLook(index, false).points} className="vmini" />
                <span>
                  <b>{name(vault)}</b>
                  {vault.available ? null : <small>Not available</small>}
                </span>
              </label>
            ))}
          </fieldset>
        ) : null}
        {chosen === undefined && list.length > 0 ? (
          <p className="err" role="alert">
            {said(messageFor({ code: "core", kind: "io" }))}
          </p>
        ) : null}
        {chosen === undefined ? null : (
          <form onSubmit={(event) => void submit(event)}>
            <PasswordField
              key={focusBox}
              label={`Password for ${name(chosen)}`}
              autoComplete="current-password"
              value={password}
              onChange={(next) => {
                setPassword(next);
                setError(null);
              }}
              error={error}
              rule={capture === null ? undefined : "A locked vault's folders can't be read until you unlock it."}
              autoFocus
            />
            <div className="lacts">
              <button type="submit" className="prim" disabled={busy || password === ""}>
                {capture === null ? "Unlock" : "Unlock and continue"}
              </button>
              {capture === null ? (
                // The recovery key opens the vault again (28a). Not while a copy waits for its vault: that step's own way out is Cancel.
                <button
                  type="button"
                  className="lnk"
                  onClick={() => {
                    startForgot(chosen.id);
                  }}
                >
                  Forgot password?
                </button>
              ) : (
                <button type="button" className="lnk" onClick={cancelCapture}>
                  Cancel
                </button>
              )}
            </div>
          </form>
        )}
        {/* A second line under the form: a backup can bring a vault back on this PC, or be opened to look through and copy items out of. Not while a saved copy waits for its vault. */}
        {vaults !== null && capture === null ? (
          <p className="lalt">
            <button
              type="button"
              className="lnk"
              aria-disabled={restoring ? true : undefined}
              onClick={() => {
                if (!restoring) void startRestore();
              }}
            >
              Restore a backup
            </button>
            <button
              type="button"
              className="lnk"
              aria-disabled={restoring || opening ? true : undefined}
              onClick={() => {
                if (!restoring && !opening) void startOpenBackup();
              }}
            >
              Open a backup
            </button>
          </p>
        ) : null}
      </main>
    </div>
  );
}
