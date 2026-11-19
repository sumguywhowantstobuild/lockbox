import { useEffect, useId, useRef, useState, type KeyboardEvent, type SyntheticEvent } from "react";
import { focusBack } from "../focus";
import { useLockEpoch } from "../jobs";
import { messageFor, messageText } from "../messages";
import { NEW_KEY_OFFER, OLD_KEY_STOPS } from "../newKeyWords";
import { Button } from "../parts/Button";
import { Dialog } from "../parts/Dialog";
import { Panel } from "../parts/Panel";
import { PasswordField } from "../parts/PasswordField";
import { LIMIT, OFFER_TITLE } from "../passwordWords";
import { clearNewKeyProblem, closeNewRecoveryKey, finishNewKey, makeNewRecoveryKey, type NewKeyFlow, type SessionData } from "../store";

// A new recovery key (29a, and 29c after it), on the session whose Settings or Ask 2 opened it. The form asks for the current password and says what the new key
// does to the old one and to the backups already made, and the limit of spec 5.3. What is typed is the form's own state and is wiped from it the moment it is sent.
// Every refusal goes through `messageFor`. The key itself is shown by 29b, which is setup's key screens with their own headings (`RecoveryKey`, `PickWords`).

/**
 * The New recovery key panel (29a), when a key is begun in this session. A wrong current password, or a refusal of the shell, is said on the form with the field
 * empty; an empty field is said before anything is sent.
 */
export function NewRecoveryKeyPanel({ data }: { data: SessionData }) {
  const flow = data.newKey;
  if (flow?.phase !== "ask") return null;
  return <Form data={data} flow={flow} />;
}

function Form({ data, flow }: { data: SessionData; flow: Extract<NewKeyFlow, { phase: "ask" }> }) {
  const { session } = data;
  const formId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const [current, setCurrent] = useState("");
  const [empty, setEmpty] = useState<string | null>(null);
  // The field can't be typed in while a key is asked for: what is typed meanwhile would outlive the answer, a refusal's included.
  const sending = flow.sending;
  // Every lock epoch (Lock all, an idle lock, Windows locking or sleeping, even when this vault's own `locked` event has not come) wipes what is typed.
  const epoch = useLockEpoch();
  const [seenEpoch, setSeenEpoch] = useState(epoch);
  if (seenEpoch !== epoch) {
    setSeenEpoch(epoch);
    setCurrent("");
    setEmpty(null);
  }
  useEffect(() => {
    heading.current?.focus();
  }, []);

  // While a key is asked for the form can't be put away: Cancel does not take the request back, and the answer is for this form.
  const close = () => {
    if (flow.sending) return;
    closeNewRecoveryKey(session);
    focusBack("settings");
  };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    event.preventDefault();
    close();
  };

  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    if (flow.sending) return;
    if (current === "") {
      setEmpty(messageText(messageFor({ code: "invalid_input", what: "password is empty" })));
      return;
    }
    setEmpty(null);
    // The password goes once, and is gone from here as it goes: the field is empty whatever comes back.
    const sent = current;
    setCurrent("");
    void makeNewRecoveryKey(session, sent);
  };

  // What the shell last refused with is said on the field it is about (the form as a whole for any other refusal).
  const refusal = flow.problem === null ? null : messageText(messageFor(flow.problem.error));
  const aboutCurrent = flow.problem?.field === "current" ? refusal : null;
  const aboutForm = flow.problem?.field === "form" ? refusal : null;

  return (
    <Panel
      title="New recovery key"
      subtitle={`For ${data.name}.`}
      titleRef={heading}
      onClose={close}
      onKeyDown={onKeyDown}
      footer={
        <>
          <Button aria-disabled={flow.sending ? true : undefined} onClick={close}>
            Cancel
          </Button>
          <Button look="pill-main" type="submit" form={formId} aria-disabled={flow.sending ? true : undefined}>
            Make a new key
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} noValidate aria-busy={flow.sending ? true : undefined}>
        <PasswordField
          look="panel"
          autoComplete="current-password"
          label="Current password"
          readOnly={sending}
          value={current}
          error={empty ?? aboutCurrent}
          onChange={(value) => {
            setCurrent(value);
            setEmpty(null);
            if (flow.problem !== null) clearNewKeyProblem(session);
          }}
        />
        {aboutForm === null ? null : (
          <p className="ferr" role="alert">
            {aboutForm}
          </p>
        )}
      </form>
      <p className="fhint">{OLD_KEY_STOPS}</p>
      <p className="fwarn">{LIMIT}</p>
    </Panel>
  );
}

/**
 * 29c: the new key was picked back and the shell heard it, so a fresh backup is offered right then. It is a question over the window, for this vault: Back up now
 * opens Back up (22a) for it, Not now only closes the question. Not now has the focus first, as the other offers' safe answer does. It is shown when this vault is
 * on screen.
 */
export function NewRecoveryKeyDone({ data }: { data: SessionData }) {
  const later = useRef<HTMLButtonElement>(null);
  return (
    <Dialog
      open={data.newKey?.phase === "done"}
      onOpenChange={(open) => {
        if (!open) finishNewKey(data.session, false);
      }}
      title={OFFER_TITLE}
      description={NEW_KEY_OFFER}
      initialFocus={later}
    >
      <Button
        ref={later}
        onClick={() => {
          finishNewKey(data.session, false);
        }}
      >
        Not now
      </Button>
      <Button
        look="pill-main"
        onClick={() => {
          finishNewKey(data.session, true);
        }}
      >
        Back up now
      </Button>
    </Dialog>
  );
}
