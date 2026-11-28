import { useEffect, useId, useRef } from "react";
import { Frame, SAY_FIRST } from "./Frame";

/**
 * 18c's cloud question, before a vault is made in (or added from) a folder a cloud service syncs: the shell has done
 * nothing yet, and the person's yes goes back to it. It cannot name the service (the shell sends none), so it says "a
 * cloud service". Nothing is made until `onContinue`; `onChooseAnother` is only offered when a folder can be picked.
 * `step` is the step line when the question comes inside numbered steps (making a vault is step 1 of 2). As drawn,
 * Continue anyway sits beside Cancel; Choose another has its own line under the sentence that offers it. The question takes
 * the place of the screen whose button was pressed, so focus goes to the safe answer (Choose another, or Cancel where no
 * folder can be picked), which the sentence describes so a screen reader reads both: an extra Enter never says yes to the
 * cloud folder (stage 7's S1).
 */
export function CloudQuestion({
  busy,
  step,
  onContinue,
  onChooseAnother,
  onCancel,
}: {
  busy: boolean;
  step?: string;
  onContinue: () => void;
  onChooseAnother?: () => void;
  onCancel: () => void;
}) {
  const sentenceId = useId();
  const safeAnswer = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!busy) safeAnswer.current?.focus();
  }, [busy]);
  const chooseAnother = onChooseAnother !== undefined;
  return (
    <Frame say={SAY_FIRST}>
      {step === undefined ? null : <p className="fu-step">{step}</p>}
      <h1>This folder is synced to the cloud</h1>
      <p className="fu-sub strong" id={sentenceId}>
        A cloud service syncs this folder. Petalock doesn&apos;t support vaults in cloud folders. Choose a folder on this PC,
        or continue anyway.
      </p>
      {!chooseAnother ? null : (
        <p className="fu-other">
          <button
            ref={safeAnswer}
            type="button"
            className="lnk"
            disabled={busy}
            aria-describedby={sentenceId}
            onClick={onChooseAnother}
          >
            Choose another
          </button>
        </p>
      )}
      <div className="fu-row">
        <button type="button" className="prim" disabled={busy} onClick={onContinue}>
          Continue anyway
        </button>
        <button
          ref={chooseAnother ? undefined : safeAnswer}
          type="button"
          className="lnk"
          disabled={busy}
          aria-describedby={chooseAnother ? undefined : sentenceId}
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
    </Frame>
  );
}
