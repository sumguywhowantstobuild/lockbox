import { Frame, SAY_FIRST } from "./Frame";

/**
 * 18c's cloud question, before a vault is made in (or added from) a folder a cloud service syncs: the shell has done
 * nothing yet, and the person's yes goes back to it. It cannot name the service (the shell sends none), so it says "a
 * cloud service". Nothing is made until `onContinue`; `onChooseAnother` is only offered when a folder can be picked.
 */
export function CloudQuestion({
  busy,
  onContinue,
  onChooseAnother,
  onCancel,
}: {
  busy: boolean;
  onContinue: () => void;
  onChooseAnother?: () => void;
  onCancel: () => void;
}) {
  return (
    <Frame say={SAY_FIRST}>
      <h1>This folder is synced to the cloud</h1>
      <p className="fu-sub strong">
        A cloud service syncs this folder. Lockbox doesn&apos;t support vaults in cloud folders. Choose a folder on this PC,
        or continue anyway.
      </p>
      <div className="fu-row">
        <button type="button" className="prim" disabled={busy} onClick={onContinue}>
          Continue anyway
        </button>
        {onChooseAnother === undefined ? null : (
          <button type="button" className="lnk" disabled={busy} onClick={onChooseAnother}>
            Choose another
          </button>
        )}
        <button type="button" className="lnk" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </Frame>
  );
}
