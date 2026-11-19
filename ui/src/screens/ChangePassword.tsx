import { useEffect, useId, useRef, useState, type KeyboardEvent, type SyntheticEvent } from "react";
import { focusBack } from "../focus";
import { useLockEpoch } from "../jobs";
import { messageFor, messageText } from "../messages";
import { Button } from "../parts/Button";
import { Dialog } from "../parts/Dialog";
import { Panel } from "../parts/Panel";
import { PasswordField } from "../parts/PasswordField";
import { BACKUPS_NEED_OLD_DETAILS, LIMIT, MIN_PASSWORD, MISMATCH, OFFER, OFFER_TITLE, TOO_SHORT } from "../passwordWords";
import {
  changePassword,
  clearPasswordProblem,
  closeChangePassword,
  finishPasswordChange,
  type PasswordChange,
  type SessionData,
} from "../store";

// Change password (27a to 27c), on the session whose Settings, Ask 9 or Ask 2 opened it. The form asks for the current password, then the new one twice,
// says what existing backups still need and the limit of spec 5.3, and says what is wrong with the form on the form itself, before anything is sent. What is
// typed is the form's own state and is wiped from it the moment it is sent. Every refusal goes through `messageFor`.

interface Problems {
  current: string | null;
  next: string | null;
  again: string | null;
}

const NONE: Problems = { current: null, next: null, again: null };

/**
 * The Change password panel (27a, 27b), when a change is begun in this session. A wrong current password, or a refusal of the shell, is said on the form
 * and the three fields are empty; a new password under 12 characters or two that differ are said before anything is sent, and the text stays to be mended.
 */
export function ChangePasswordPanel({ data }: { data: SessionData }) {
  const flow = data.passwordChange;
  if (flow?.phase !== "ask") return null;
  return <Form data={data} flow={flow} />;
}

function Form({ data, flow }: { data: SessionData; flow: Extract<PasswordChange, { phase: "ask" }> }) {
  const { session } = data;
  const formId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [problems, setProblems] = useState<Problems>(NONE);
  // The fields can't be typed in while a change is out: what is typed meanwhile would outlive the answer, a refusal's included.
  const sending = flow.sending;
  // Every lock epoch (Lock all, an idle lock, Windows locking or sleeping, even when this vault's own `locked` event has not come) wipes what is typed.
  const epoch = useLockEpoch();
  const [seenEpoch, setSeenEpoch] = useState(epoch);
  if (seenEpoch !== epoch) {
    setSeenEpoch(epoch);
    setCurrent("");
    setNext("");
    setAgain("");
    setProblems(NONE);
  }
  useEffect(() => {
    heading.current?.focus();
  }, []);

  // While a change is out the form can't be put away: Cancel does not take a change back, and the answer is for this form.
  const close = () => {
    if (flow.sending) return;
    closeChangePassword(session);
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
    const found: Problems = {
      current: current === "" ? messageText(messageFor({ code: "invalid_input", what: "password is empty" })) : null,
      next: Array.from(next.normalize("NFC")).length < MIN_PASSWORD ? TOO_SHORT : null,
      again: next !== again ? MISMATCH : null,
    };
    setProblems(found);
    if (found.current !== null || found.next !== null || found.again !== null) return;
    // The passwords go once, and are gone from here as they go: the fields are empty whatever comes back.
    const sentCurrent = current;
    const sentNext = next;
    setCurrent("");
    setNext("");
    setAgain("");
    void changePassword(session, sentCurrent, sentNext);
  };

  // What the shell last refused with is said on the field it is about (the form as a whole for any other refusal).
  const refusal = flow.problem === null ? null : messageText(messageFor(flow.problem.error));
  const aboutCurrent = flow.problem?.field === "current" ? refusal : null;
  const aboutNext = flow.problem?.field === "new" ? refusal : null;
  const aboutForm = flow.problem?.field === "form" ? refusal : null;
  const mended = () => {
    if (flow.problem !== null) clearPasswordProblem(session);
  };

  return (
    <Panel
      title="Change password"
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
            Change password
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
          error={problems.current ?? aboutCurrent}
          onChange={(value) => {
            setCurrent(value);
            setProblems((now) => ({ ...now, current: null }));
            mended();
          }}
        />
        <PasswordField
          look="panel"
          autoComplete="new-password"
          label="New password"
          readOnly={sending}
          rule="At least 12 characters."
          minimum={MIN_PASSWORD}
          value={next}
          error={problems.next ?? aboutNext}
          onChange={(value) => {
            setNext(value);
            setProblems((now) => ({ ...now, next: null, again: null }));
            mended();
          }}
        />
        <PasswordField
          look="panel"
          autoComplete="new-password"
          label="New password again"
          readOnly={sending}
          value={again}
          error={problems.again}
          onChange={(value) => {
            setAgain(value);
            setProblems((now) => ({ ...now, again: null }));
          }}
        />
        {aboutForm === null ? null : (
          <p className="ferr" role="alert">
            {aboutForm}
          </p>
        )}
      </form>
      <p className="fhint">{BACKUPS_NEED_OLD_DETAILS}</p>
      <p className="fwarn">{LIMIT}</p>
    </Panel>
  );
}

/**
 * 27c: the change landed, so a fresh backup is offered right then. It is a question over the window, for this vault: Back up now opens Back up (22a) for it,
 * Not now only closes the question. Not now has the focus first, as the other offers' safe answer does. It is shown when this vault is on screen, so a
 * change that was answered while another vault was in front waits here until its own vault comes back.
 */
export function ChangePasswordDone({ data }: { data: SessionData }) {
  const later = useRef<HTMLButtonElement>(null);
  return (
    <Dialog
      open={data.passwordChange?.phase === "done"}
      onOpenChange={(open) => {
        if (!open) finishPasswordChange(data.session, false);
      }}
      title={OFFER_TITLE}
      description={OFFER}
      initialFocus={later}
    >
      <Button
        ref={later}
        onClick={() => {
          finishPasswordChange(data.session, false);
        }}
      >
        Not now
      </Button>
      <Button
        look="pill-main"
        onClick={() => {
          finishPasswordChange(data.session, true);
        }}
      >
        Back up now
      </Button>
    </Dialog>
  );
}
