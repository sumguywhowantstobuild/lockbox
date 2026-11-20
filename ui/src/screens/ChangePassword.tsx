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
  // The boxes, so focus can go to the one a problem is about (a keyboard or screen reader user starts where the error is).
  const currentBox = useRef<HTMLInputElement>(null);
  const nextBox = useRef<HTMLInputElement>(null);
  const againBox = useRef<HTMLInputElement>(null);
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
    const first = found.current !== null ? currentBox : found.next !== null ? nextBox : found.again !== null ? againBox : null;
    if (first !== null) {
      first.current?.focus();
      return;
    }
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
  // A refusal of the shell about a box puts focus on that box once it is said (the boxes are empty again by then).
  const refusedField = flow.problem?.field ?? null;
  useEffect(() => {
    if (refusedField === "current") currentBox.current?.focus();
    else if (refusedField === "new") nextBox.current?.focus();
  }, [refusedField, flow.problem]);

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
          inputRef={currentBox}
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
          inputRef={nextBox}
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
          inputRef={againBox}
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
      <p className="caveat" role="note">
        {`${BACKUPS_NEED_OLD_DETAILS} ${LIMIT}`}
      </p>
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
  // Not now (or Escape) leaves nothing open, so focus goes back to Settings, which opened the flow. Back up now's panel takes focus itself.
  const notNow = () => {
    finishPasswordChange(data.session, false);
    focusBack("settings");
  };
  return (
    <Dialog
      open={data.passwordChange?.phase === "done"}
      onOpenChange={(open) => {
        if (!open) notNow();
      }}
      title={OFFER_TITLE}
      description={OFFER}
      initialFocus={later}
    >
      <Button
        ref={later}
        onClick={notNow}
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
