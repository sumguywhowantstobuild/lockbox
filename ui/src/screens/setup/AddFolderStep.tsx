import { useRef, useState } from "react";
import { chooseAnotherFolder, confirmAddFolder, leaveAddFolder, type AddFolder } from "../../store";
import { CloudQuestion } from "./CloudQuestion";

/**
 * The cloud question of Add existing vault folder, begun from the vault menu (18c, Task 7): the first screens' own question, over the window, when the folder the person
 * picked is one a cloud service syncs. Nothing was added; Continue anyway sends the token it was given, Choose another opens the picker again, and Cancel leaves the window
 * as it was. Every other end of the add (a closed picker, a refusal, the folder added) is the store's and has no screen of its own.
 */
export function AddFolderStep({ step }: { step: Extract<AddFolder, { phase: "cloud" }> }) {
  const [busy, setBusy] = useState(false);
  // A second press before the first has an answer must not send a second request, and state changes too late for that.
  const running = useRef(false);

  const go = async (run: () => Promise<void>) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    try {
      await run();
    } finally {
      running.current = false;
      setBusy(false);
    }
  };

  return (
    <CloudQuestion
      busy={busy}
      onContinue={() => void go(() => confirmAddFolder(step.opening, step.token))}
      onChooseAnother={() => void go(() => chooseAnotherFolder(step.opening))}
      onCancel={() => {
        leaveAddFolder(step.opening);
      }}
    />
  );
}
