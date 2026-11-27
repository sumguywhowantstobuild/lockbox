import { useEffect, useRef, useState, type SyntheticEvent } from "react";
import type { VaultEntry } from "../api";
import { useLockEpoch } from "../jobs";
import { messageFor, type Message } from "../messages";
import { PasswordField } from "../parts/PasswordField";
import { AppMark } from "../parts/AppMark";
import { Intaglio } from "../parts/Intaglio";
import { VaultMark, vaultLook } from "../parts/Pattern";
import { focusButton } from "../focus";
import { folderWords } from "../moveInWords";
import {
  cancelCapture,
  clearUnlockPick,
  leaveUnlockStep,
  startAddFolder,
  startForgot,
  startOpenBackup,
  startRestore,
  tryVaultAgain,
  unlock,
  unlockInStep,
  useAddFolder,
  useAddRefusal,
  useCapture,
  useOpenBackup,
  useRestore,
  useStartError,
  useUnlockPick,
  useVaults,
  type UnlockStep as UnlockStepOf,
} from "../store";
import { useMode } from "../theme";
import { listedName, STILL_UNAVAILABLE, UNAVAILABLE_LINE } from "../vaultWords";
import { LockNote, LockScreenAsks } from "./Asks";
import { DamagedVaultAsk } from "./RestoreNotices";
import { RemoveVaultBox } from "./VaultBoxes";
import { VaultLinks } from "./VaultLinks";

/** A refusal as one line of text. */
function said(message: Message): string {
  return message.body === "" ? message.title : `${message.title} ${message.body}`;
}

/**
 * An unlock heading: the chosen vault's small mark in its colour, then the words (Plan 5 Task 9b). Every vault shows the same
 * large picture, so the heading carries the vault's own look; the mark is for the eye only, so the heading's name is its words.
 */
function UnlockHeading({ words, position, mode }: { words: string; position: number | null; mode: string }) {
  if (position === null) return <>{words}</>;
  const look = vaultLook(position, false);
  return (
    <>
      <VaultMark points={look.points} className={`vmini mode-${mode} v-${look.accent}`} />
      <span>{words}</span>
    </>
  );
}

/**
 * The unlock step of one more vault while another is open (the vault menu, the vault strip and Copy to a vault bring it): the lock screen's own look and form, for the one
 * vault the step was opened for, with Back (and Escape) to the window that was on screen. The password is typed once and goes with the vault's registry ID; it is wiped from
 * the box as it is sent (so a refusal, "Wrong password.", shows an empty box), by Back, and by every lock epoch, and Ask 16 (kept for that vault alone) is said above the box.
 * A vault whose details can't be read has Ask 8 here instead of a box, as on the lock screen. The vaults that are open are not touched by anything here. "Forgot password?"
 * opens 28a for this vault, as on the lock screen; its Back gives this step back, and the vault its new password opens ends the step. Show and Remove are a second line.
 */
export function UnlockStep({ step }: { step: UnlockStepOf }) {
  const vaults = useVaults();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // What Show in Explorer was refused with, in words, under the form (its own line: the password box is not what was refused).
  const [linkProblem, setLinkProblem] = useState<string | null>(null);
  // Every lock epoch (Lock all, an idle lock, Windows locking or sleeping) wipes what is typed, even before the vaults' own locks are heard.
  const epoch = useLockEpoch();
  const [seenEpoch, setSeenEpoch] = useState(epoch);
  if (seenEpoch !== epoch) {
    setSeenEpoch(epoch);
    setPassword("");
  }
  const mode = useMode();
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
  // The vault is off the list: the step goes with it (the store closed it), and focus is on the vault button of the window that was on screen.
  const removed = () => {
    focusButton(".vhead");
  };
  if (vault.details_damaged) return <DamagedVaultAsk entry={vault} onBack={back} onRemoved={removed} />;

  const submit = async (event: SyntheticEvent) => {
    event.preventDefault();
    if (password === "" || busy) return;
    // The text goes once, and is gone from here as it goes: the box is empty whatever comes back.
    const text = password;
    setPassword("");
    setError(null);
    setBusy(true);
    setLinkProblem(null);
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
        <Intaglio className="rose" />
        <p className="mark">
          <AppMark />
          Petalock
        </p>
        <p className="say">Your items stay encrypted until you enter the password.</p>
      </header>
      <main className="plate">
        <h1 className="vh">
          <UnlockHeading words={`Unlock ${name}`} position={position} mode={mode} />
        </h1>
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
            {/* Design task 1: "Forgot password?" goes to task 28, here as on the lock screen, for this vault. The flow takes the window; its Back gives this step back.
                Not on Copy to a vault's step (`stay`), whose way out is the copy's window, as the lock screen has none while a copy waits; not while an unlock is out. */}
            {step.stay ? null : (
              <button
                type="button"
                className="lnk"
                disabled={busy}
                onClick={() => {
                  setPassword("");
                  setError(null);
                  startForgot(vault.id);
                }}
              >
                Forgot password?
              </button>
            )}
            <button type="button" className="lnk" onClick={back}>
              Back
            </button>
          </div>
        </form>
        {/* Show and Remove: a second line under the form, whose words line up with the form's edge, as the lock screen's second line does. */}
        <p className="lalt">
          <VaultLinks vault={vault} onRemoved={removed} onProblem={setLinkProblem} />
        </p>
        {linkProblem === null ? null : (
          <p className="err" role="alert">
            {linkProblem}
          </p>
        )}
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
  // A vault asked for while this screen is up (Add existing vault folder from here added one) is chosen, and its box is drawn anew so it takes the focus.
  const [takenPick, setTakenPick] = useState<number | null>(asked);
  if (asked !== takenPick) {
    setTakenPick(asked);
    if (asked !== null) {
      setChosenId(asked);
      setPassword("");
      setError(null);
      setFocusBox((count) => count + 1);
    }
  }
  // Add existing vault folder from this screen: a picker or a cloud question is out (a second press sends nothing), and a refusal is said in the plate until the next add or unlock.
  const adding = useAddFolder() !== null;
  const addRefusal = useAddRefusal();
  // Try again on an unavailable vault's row: which rows were found still unavailable (said under them), and the rows with a read out (a second press sends nothing).
  const [still, setStill] = useState<number[]>([]);
  const trying = useRef(new Set<number>());
  // Remove from list on an unavailable vault's row: 18g, anchored to that row's Remove from list button, and where focus goes once the vault is off the list.
  const [removing, setRemoving] = useState<VaultEntry | null>(null);
  const removeAnchor = useRef<HTMLElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [focusHeading, setFocusHeading] = useState(0);
  const headingFocused = useRef(0);
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
  // A vault was taken off the list and none is left to choose: focus goes to the heading (when one can be chosen, its password box is drawn anew and takes it).
  const nothingToChoose = chosen === undefined;
  useEffect(() => {
    if (focusHeading === headingFocused.current) return;
    headingFocused.current = focusHeading;
    if (nothingToChoose) headingRef.current?.focus();
  }, [focusHeading, nothingToChoose]);

  const submit = async (event: SyntheticEvent) => {
    event.preventDefault();
    if (chosen === undefined || password === "" || unlocking.current) return;
    unlocking.current = true;
    setBusy(true);
    setError(null);
    try {
      await unlock({ list: chosen.list, id: chosen.id }, password);
      // The vault is open (or locked again already): the password has done its work.
      setPassword("");
    } catch (refusal) {
      setError(said(messageFor(refusal)));
    } finally {
      unlocking.current = false;
      setBusy(false);
    }
  };

  // Try again on an unavailable vault's row: the list is read again. Back, the vault is chosen and its box takes the focus; still unavailable, the row says so; a list that can't be
  // read is the list's own error line (the store keeps it), and a row that has gone just goes.
  const tryAgain = async (id: number) => {
    if (trying.current.has(id)) return;
    trying.current.add(id);
    setStill((ids) => ids.filter((one) => one !== id));
    const found = await tryVaultAgain(id);
    trying.current.delete(id);
    if (found === "still") {
      setStill((ids) => [...ids, id]);
    } else if (found === "back") {
      setChosenId(id);
      setPassword("");
      setError(null);
      setFocusBox((count) => count + 1);
    }
  };

  let heading = "Unlock a vault";
  if (vaults !== null && list.length === 0) heading = "No vaults yet";
  else if (list.length === 1 && chosen !== undefined) heading = `Unlock ${name(chosen)}`;
  if (capture !== null) heading = "Save what you copied";

  // Once a vault is off the list the lock screen shows what is left: the vault now chosen has its box focused, or the heading when none can be chosen.
  const afterRemoval = () => {
    setRemoving(null);
    setPassword("");
    setError(null);
    setFocusBox((count) => count + 1);
    setFocusHeading((count) => count + 1);
  };
  // Ask 8: both copies of the vault's details are damaged (the list says so), so no password can open it. Its own screen takes the place of the box; Back is
  // another vault that can be opened when there is one, and the lock screen as it was when there is not. A vault with no name for another reason keeps the box.
  if (capture === null && chosen !== undefined && chosen.details_damaged && backFrom !== chosen.id) {
    const other = list.find((vault) => vault.available && !vault.details_damaged);
    return (
      <DamagedVaultAsk
        entry={chosen}
        onRemoved={afterRemoval}
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
        <Intaglio className="rose" />
        <p className="mark">
          <AppMark />
          Petalock
        </p>
        <p className="say">
          {capture === null
            ? "Your items stay encrypted until you enter the password."
            : capture.state === "value"
              ? "Your copied key is held here until you save it or cancel."
              : "Unlock to paste or type a key and save it, or cancel."}
        </p>
      </header>
      <main className="plate">
        <h1 ref={headingRef} tabIndex={-1} className="vh">
          {/* The chosen vault's mark starts an unlock heading, with one vault or many; the save step and an empty list have none. */}
          <UnlockHeading words={heading} position={chosen !== undefined && capture === null ? position : null} mode={mode} />
        </h1>
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
        {/* The rows show from two vaults on, and for any vault that can't be reached, even when it is the only one: its row is where Try again and Remove from list are (30b). */}
        {list.length > 1 || list.some((vault) => !vault.available) ? (
          <fieldset className="vlist">
            {/* The save step names the choice on screen, as 8b draws it ("Vault", in the field labels' look); the plain lock screen names it for a screen reader only. */}
            <legend className={capture === null ? "sr" : "flab"}>Vault</legend>
            {list.map((vault, index) =>
              vault.available ? (
                // Its own colour (the mode class beside it, so the variables resolve here) and its own shape.
                <label key={vault.id} className={`${vault.id === chosen?.id ? "vbtn on" : "vbtn"} mode-${mode} v-${vaultLook(index, false).accent}`}>
                  <input
                    type="radio"
                    className="vradio"
                    name="vault"
                    checked={vault.id === chosen?.id}
                    onChange={() => {
                      setChosenId(vault.id);
                      setPassword("");
                      setError(null);
                    }}
                  />
                  <VaultMark points={vaultLook(index, false).points} className="vmini" />
                  <span>
                    <b>{name(vault)}</b>
                  </span>
                </label>
              ) : (
                // A vault whose folder or drive isn't there (30b) is no choice: it says so, and has its own Try again and Remove from list.
                <div key={vault.id} role="group" aria-label={name(vault)} className={`vbtn off mode-${mode} v-${vaultLook(index, false).accent}`}>
                  <VaultMark points={vaultLook(index, false).points} className="vmini" />
                  <span className="vgrow">
                    <b>{name(vault)}</b>
                    <small>{UNAVAILABLE_LINE}</small>
                  </span>
                  <button
                    type="button"
                    className="lnk"
                    onClick={() => {
                      void tryAgain(vault.id);
                    }}
                  >
                    Try again
                  </button>
                  <button
                    type="button"
                    className="lnk"
                    onClick={(event) => {
                      removeAnchor.current = event.currentTarget;
                      setRemoving(vault);
                    }}
                  >
                    Remove from list
                  </button>
                  {/* Always on the page, so a change in it is spoken. */}
                  <p role="status" className="vstill">
                    {still.includes(vault.id) ? STILL_UNAVAILABLE : ""}
                  </p>
                </div>
              ),
            )}
          </fieldset>
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
        {/* What Add existing vault folder was refused with (30a), right under the form, or above the links when there is none; the next add or unlock takes it away. */}
        {addRefusal === null ? null : (
          <p className="err" role="alert">
            {folderWords(addRefusal)}
          </p>
        )}
        {/* A second line under the form: a backup can bring a vault back on this PC, a vault folder be added to the list, or a backup be opened to look through and copy items out of. Not while a saved copy waits for its vault. */}
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
              aria-disabled={restoring || opening || adding ? true : undefined}
              onClick={() => {
                if (!restoring && !opening && !adding) startAddFolder("lock");
              }}
            >
              Add existing vault folder
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
        {removing === null ? null : (
          <RemoveVaultBox
            vault={removing}
            name={name(removing)}
            anchor={removeAnchor}
            onClose={() => {
              setRemoving(null);
            }}
            onDone={afterRemoval}
          />
        )}
      </main>
    </div>
  );
}
