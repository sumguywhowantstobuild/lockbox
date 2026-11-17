import { useEffect, useRef, useState } from "react";
import { BRING_IN_THE_NEXT, EITHER_WORKS, folderWords, SAY_MOVE_IN } from "../../moveInWords";
import {
  addExistingVault,
  bringInAnother,
  confirmAddExistingVault,
  leaveMoveIn,
  startRestore,
  unlockBroughtIn,
  useMoveIn,
  useRestore,
  type SetupResult,
} from "../../store";
import { CloudQuestion } from "./CloudQuestion";
import { Frame } from "./Frame";

/**
 * Moving to a new computer, on the first-use screens' frame: 26a ("What do you have?"), 26b (its alert, when the vault folder is on a removable drive) and 26c
 * (a vault has come in). The app shows it above the lock screen and the first screen, and below an open restore. Nothing is shown when the steps are closed.
 */
export function MoveIn() {
  const moveIn = useMoveIn();
  if (moveIn === null) return null;
  return moveIn.step === "what" ? <WhatDoYouHave /> : <VaultIsHere name={moveIn.name} />;
}

/**
 * 26a: a backup file starts the restore (its first step is Windows' picker, and Cancel comes back here); a vault folder is picked and added, with the
 * cloud question as the first screen asks it. A refusal of the folder is the alert under the two ways in, and both work again. Back is the first screen, or
 * the lock screen when a vault has already come in.
 */
function WhatDoYouHave() {
  const picking = useRestore() !== null;
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  // A second press before the first has an answer must not open a second picker, and state changes too late for that.
  const running = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const folder = useRef<HTMLButtonElement>(null);

  // Focus goes to the heading when the step comes up, and back to it when the cloud question is turned down.
  useEffect(() => {
    if (token === null) heading.current?.focus();
  }, [token]);
  // A button that waited has lost focus: after a refusal it goes back to the one that was pressed.
  useEffect(() => {
    if (!busy && error !== null) folder.current?.focus();
  }, [busy, error]);

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
      setError(folderWords(refusal));
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

  const off = busy || picking;
  return (
    <Frame say={SAY_MOVE_IN}>
      <h1 ref={heading} tabIndex={-1}>
        What do you have?
      </h1>
      <p className="fu-sub">{EITHER_WORKS}</p>
      <div className="fu-row">
        <button
          type="button"
          className="prim"
          aria-disabled={off ? true : undefined}
          onClick={() => {
            if (!off) void startRestore({ origin: "first_screen" });
          }}
        >
          A backup file
        </button>
        <button
          ref={folder}
          type="button"
          className="fu-sec"
          aria-disabled={off ? true : undefined}
          onClick={() => {
            if (!off) void go(addExistingVault);
          }}
        >
          A vault folder
        </button>
      </div>
      {error === null ? null : (
        <p className="err" role="alert">
          {error}
        </p>
      )}
      <div className="fu-row">
        <button type="button" className="lnk" aria-disabled={off ? true : undefined} onClick={off ? undefined : leaveMoveIn}>
          Back
        </button>
      </div>
    </Frame>
  );
}

/** 26c: the vault that came in is named, and the next one can be brought in. Each vault comes across on its own. */
function VaultIsHere({ name }: { name: string }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);
  return (
    <Frame say={SAY_MOVE_IN}>
      <h1 ref={heading} tabIndex={-1}>{`${name} is here`}</h1>
      <p className="fu-sub">{BRING_IN_THE_NEXT}</p>
      <div className="fu-row">
        <button type="button" className="prim" onClick={unlockBroughtIn}>
          {`Unlock ${name}`}
        </button>
        <button type="button" className="lnk" onClick={bringInAnother}>
          Bring in another vault
        </button>
      </div>
    </Frame>
  );
}
