import { useEffect, useRef, useState } from "react";
import { messageFor, messageText } from "../../messages";
import { startNewVaultList } from "../../store";
import { Frame } from "./Frame";

/** The line the dark side says: the vaults themselves are fine. */
const SAY_LOST_LIST = "Your vaults are safe. Only the list of where they are was damaged.";

/**
 * Ask 12, shown instead of the lock screen when the shell can't read the list of vaults because the file is damaged: it is the first-use
 * screens' layout with one way out. "Start a new list" has the shell set the damaged file aside (it is kept, not deleted) and make an
 * empty list; the list is then read again, which opens the first screen, where "I already have a vault" adds each vault back. The
 * button is busy while the shell works. A refusal is said here in words and focus goes back to the button, which works again.
 */
export function LostList() {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  // A second press before the first has an answer must not send a second command, and state changes too late for that.
  const running = useRef(false);

  // A button that was disabled while the shell worked has lost focus: after a refusal it goes back to the one that was pressed.
  useEffect(() => {
    if (!busy && error !== null) button.current?.focus();
  }, [busy, error]);

  const start = async () => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError(null);
    try {
      await startNewVaultList();
    } catch (refusal) {
      setError(messageText(messageFor(refusal)));
    } finally {
      running.current = false;
      setBusy(false);
    }
  };

  return (
    <Frame say={SAY_LOST_LIST}>
      <h1>Lockbox lost its list of vaults</h1>
      <p className="fu-sub">Your vaults are still in their folders. Start a new list, then add each vault back.</p>
      {error === null ? null : (
        <p className="err" role="alert">
          {error}
        </p>
      )}
      <div className="fu-row">
        <button ref={button} type="button" className="prim" disabled={busy} onClick={() => void start()}>
          Start a new list
        </button>
      </div>
    </Frame>
  );
}
