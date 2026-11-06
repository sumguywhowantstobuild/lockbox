import { messageFor, messageText } from "../../messages";
import { makeNewKey, startTypeBack, type SessionData } from "../../store";
import { Frame, SAY_KEY } from "./Frame";
import { groupsOf, pickGroups } from "./keyGroups";

/**
 * The recovery key step (21c for a new vault, 21f for one whose earlier step never finished): the key, shown for as long
 * as the vault stays unlocked, and what losing it means. It is the store's, so any lock takes it off the screen and the
 * next unlock makes a new one. Saving it as a PDF or printing it comes with a later task, so nothing here offers either.
 * Also the screens before the key arrives (21f asks the shell for a new one) and after the shell would not make it.
 */
export function RecoveryKey({ data }: { data: SessionData }) {
  const step = data.recovery;
  if (step === null) return null;

  if (step.phase === "making") {
    return (
      <Frame say={SAY_KEY}>
        <h1>Finish your recovery key</h1>
        <p className="fu-sub" role="status" aria-busy="true">
          Making a new key…
        </p>
      </Frame>
    );
  }

  if (step.phase === "failed") {
    return (
      <Frame say={SAY_KEY}>
        <h1>Finish your recovery key</h1>
        <p className="err" role="alert">
          {messageText(messageFor(step.error))}
        </p>
        <div className="fu-row">
          <button
            type="button"
            className="prim"
            onClick={() => {
              void makeNewKey(data.session);
            }}
          >
            Try again
          </button>
        </div>
      </Frame>
    );
  }

  if (step.phase !== "show") return null;
  const { key, unfinished } = step;
  return (
    <Frame say={SAY_KEY}>
      {unfinished ? null : <p className="fu-step">Step 2 of 2</p>}
      <h1>{unfinished ? "Finish your recovery key" : "Save your recovery key"}</h1>
      {unfinished ? (
        <p className="fu-sub">
          Last time this step didn&apos;t finish, so that key may not have been saved. This is a new one, and the old one no
          longer works.
        </p>
      ) : null}
      <p className="fu-key m">{key}</p>
      <p className="fu-lose">If you lose both your password and this key, nobody can get your data back.</p>
      <p className="fu-hint">
        Don&apos;t keep the saved key on this PC. Writing it down by hand is fine. Screenshots won&apos;t work, because
        Lockbox stays out of screen capture.
      </p>
      <div className="fu-row">
        <button
          type="button"
          className="prim"
          onClick={() => {
            startTypeBack(data.session, pickGroups(groupsOf(key).length));
          }}
        >
          Continue
        </button>
      </div>
    </Frame>
  );
}
