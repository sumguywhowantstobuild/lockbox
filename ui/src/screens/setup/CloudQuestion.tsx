import { Frame, SAY_FIRST } from "./Frame";

/**
 * 18c's cloud question, before a vault is made in (or added from) a folder a cloud service syncs: the shell has done
 * nothing yet, and the person's yes goes back to it. It cannot name the service (the shell sends none), so it says "a
 * cloud service". Nothing is made until `onContinue`; `onChooseAnother` is only offered when a folder can be picked.
 * `step` is the step line when the question comes inside numbered steps (making a vault is step 1 of 2). As drawn,
 * Continue anyway sits beside Cancel; Choose another has its own line under the sentence that offers it.
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
  return (
    <Frame say={SAY_FIRST}>
      {step === undefined ? null : <p className="fu-step">{step}</p>}
      <h1>This folder is synced to the cloud</h1>
      <p className="fu-sub strong">
        A cloud service syncs this folder. Lockbox doesn&apos;t support vaults in cloud folders. Choose a folder on this PC,
        or continue anyway.
      </p>
      {onChooseAnother === undefined ? null : (
        <p className="fu-other">
          <button type="button" className="lnk" disabled={busy} onClick={onChooseAnother}>
            Choose another
          </button>
        </p>
      )}
      <div className="fu-row">
        <button type="button" className="prim" disabled={busy} onClick={onContinue}>
          Continue anyway
        </button>
        <button type="button" className="lnk" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </Frame>
  );
}
