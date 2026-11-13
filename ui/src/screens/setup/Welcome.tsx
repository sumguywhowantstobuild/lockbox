import { useRef, useState } from "react";
import { messageFor, messageText } from "../../messages";
import { addExistingVault, confirmAddExistingVault, type SetupResult } from "../../store";
import { CloudQuestion } from "./CloudQuestion";
import { Frame, SAY_FIRST } from "./Frame";

/**
 * 21a, the first screen when there is no vault: create one, or bring in one that is already on this PC. Backups come
 * with the backup screens of a later plan, so the second way in says only what it does today. Adding a vault that sits
 * in a cloud-synced folder asks first, as creating one does.
 */
export function Welcome({ onCreate }: { onCreate: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  // A second press before the first has an answer must not open a second folder picker.
  const running = useRef(false);

  const go = async (run: () => Promise<SetupResult>) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await run();
      setToken(typeof result === "object" ? result.confirm : null);
    } catch (refusal) {
      setToken(null);
      setError(messageText(messageFor(refusal)));
    } finally {
      running.current = false;
      setBusy(false);
    }
  };

  if (token !== null) {
    return (
      <CloudQuestion
        busy={busy}
        onContinue={() => void go(() => confirmAddExistingVault(token))}
        onChooseAnother={() => void go(addExistingVault)}
        onCancel={() => {
          setToken(null);
        }}
      />
    );
  }

  return (
    <Frame say={SAY_FIRST}>
      <h1>Welcome to Lockbox</h1>
      <p className="fu-sub">
        There is no account and no server. Start with a vault, or bring in one you already have.
      </p>
      {error === null ? null : (
        <p className="err" role="alert">
          {error}
        </p>
      )}
      <div className="fu-row">
        <button type="button" className="prim" disabled={busy} onClick={onCreate}>
          Create a vault
        </button>
        <button type="button" className="lnk" disabled={busy} onClick={() => void go(addExistingVault)}>
          I already have a vault
        </button>
      </div>
    </Frame>
  );
}
