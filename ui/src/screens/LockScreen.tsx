import { useEffect, useRef, useState, type SyntheticEvent } from "react";
import type { VaultEntry } from "../api";
import { messageFor, type Message } from "../messages";
import { PasswordField } from "../parts/PasswordField";
import { Pattern, VaultMark, vaultLook } from "../parts/Pattern";
import { cancelCapture, unlock, useCapture, useStartError, useVaults } from "../store";
import { useMode } from "../theme";
import { LockScreenAsks } from "./Asks";

/** A refusal as one line of text. */
function said(message: Message): string {
  return message.body === "" ? message.title : `${message.title} ${message.body}`;
}

/**
 * The lock screen: the vaults to pick from (with one, it is already chosen), the password, Unlock. Nothing here leads to
 * a screen a later plan builds. A wrong password says so and keeps what was typed, so a typo can be mended; once a vault
 * opens the field is emptied, and if the vault locked again before the answer came there is nothing to say.
 *
 * While a copy from the save shortcut waits (8b), it is the same screen with the save step's words: the heading says what the unlock is for,
 * the button is "Unlock and continue" (the save box opens in the vault), and Cancel lets the copy go. The copy is held in the shell, never here.
 */
export function LockScreen() {
  const vaults = useVaults();
  const startError = useStartError();
  const capture = useCapture();
  const [chosenId, setChosenId] = useState<number | null>(null);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
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
  // The chosen vault, or the first that can be reached.
  const chosen = list.find((vault) => vault.id === chosenId && vault.available) ?? list.find((vault) => vault.available);
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

  return (
    <div
      className="lock"
      onKeyDown={(event) => {
        // Escape is Cancel on the save step, as it is in the box.
        if (event.key === "Escape" && capture !== null && !event.defaultPrevented) cancelCapture();
      }}
    >
      <div className="field">
        <Pattern points={vaultLook(position, false).points} className="rose" />
        <p className="mark">Lockbox</p>
        <p className="say">
          {capture === null
            ? "Your items stay encrypted until you enter the password."
            : capture.state === "value"
              ? "Your copied key is held here until you save it or cancel."
              : "Unlock to paste or type a key and save it, or cancel."}
        </p>
      </div>
      <main className="plate">
        <h1>{heading}</h1>
        <LockScreenAsks />
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
              label={`Password for ${name(chosen)}`}
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
              {capture === null ? null : (
                <button type="button" className="lnk" onClick={cancelCapture}>
                  Cancel
                </button>
              )}
            </div>
          </form>
        )}
      </main>
    </div>
  );
}
