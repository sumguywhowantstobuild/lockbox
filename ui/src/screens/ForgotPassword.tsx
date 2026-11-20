import { useEffect, useRef, useState, type SyntheticEvent } from "react";
import { useLockEpoch } from "../jobs";
import { messageFor, messageText } from "../messages";
import { Button } from "../parts/Button";
import { Dialog } from "../parts/Dialog";
import { PasswordField } from "../parts/PasswordField";
import { RecoveryKeyField } from "../parts/RecoveryKeyField";
import { BACKUPS_NEED_OLD_DETAILS, LIMIT, MIN_PASSWORD, MISMATCH, OFFER, OFFER_TITLE, TOO_SHORT } from "../passwordWords";
import {
  answerChangedDetails,
  backToForgotKey,
  checkRecoveryKey,
  clearForgotProblem,
  closeForgot,
  finishForgot,
  finishRecovery,
  noRecoveryKey,
  startRestore,
  useForgot,
  useVaults,
  type ForgotFlow as Flow,
} from "../store";
import { Frame } from "./setup/Frame";

// Forgot password (28a to 28e). Full-screen steps on the first-use screens' two-sided frame, shown by the app above whatever else it would show: the flow is the
// app's and not a vault's, so 28e still shows once the vault it opened is on screen under it. The recovery key is typed in one box, shown, and sent once; the
// shell keeps it, checked, under a choice. The new password is typed twice, sent once with that choice, and the vault opens. What is typed is this screen's own
// state: the passwords are wiped as they are sent; the key stays in its box until the check answers, and after a refusal (a typo, another vault's key), to be
// mended (Ariel's call, Plan 4C Task 13c), and goes once it is accepted. Everything typed is wiped on every lock epoch, when the step changes, and when the
// window loses focus or hides. Every refusal goes through `messageFor`, and the screens never show an error's own text.

/** What the dark side of the frame says on every step. */
const SAY_FORGOT = "The recovery key you saved when you made this vault can open it again.";

/** 28a's line under the heading, and the box's own label. */
const KEY_LABEL = "Recovery key";
const KEY_HINT = "The 24 words you saved when this key was made.";

/**
 * 28c: no key is plainly the end, unless a backup opens with details the person still has (the design's meaning; the words are the session's). The names are
 * the vault's own, from the list.
 */
const NO_KEY_EXCEPTION = "The one exception is a backup that opens with details you still have: its password or recovery key from when it was made.";

/** 28d's second sentence about what is not changed: the vault's older copies open with the old password. */
const OLD_COPIES_NEED_OLD_PASSWORD = "Older copies of this vault still open with the old password.";

/** The question about details changed outside Lockbox, in Ask 3's words (its first sentence, and the way out put as the choices this question has). */
const CHANGED_DESCRIPTION =
  "Its name, or other details kept beside your items, don't match what Lockbox last saved. If you edited that file yourself, accept them and go on. If you didn't, say No and check your PC first; restoring a backup you trust is the safer way back.";

/** What the polite place says once the new password is set, and the dark side's line on 28e (the session's words). */
const SAID_DONE = "Your new password is set.";

/** Which screen the flow is on, as a key: focus goes to its heading when this changes, and what was typed does not outlive it. */
function viewOf(flow: Flow): string {
  return flow.phase === "changed" ? "key" : flow.phase;
}

/**
 * The steps, or nothing while the flow is not begun:
 *
 * - **28a:** the recovery key's box, Continue and Back (the lock screen again), and "I don't have my recovery key". **28b** is the same screen with what was wrong
 *   said under the box (a typo, a word that is no listed word, a wrong count, a key that doesn't open this vault), the key still in it and the focus on it.
 * - **28c:** no key: plainly, nobody can get in, unless a backup opens with details the person still has, with Restore a backup.
 * - **The question** about details changed outside Lockbox, over 28a, when the key's vault says so: No lets the key go, Yes goes on to the new password.
 * - **28d:** the new password twice (with its count), what existing backups and older copies still need, and the limit in spec 5.3.
 * - **28e:** the password is set and the vault is open under this step: a fresh backup is offered.
 */
export function ForgotPassword() {
  const flow = useForgot();
  if (flow === null) return null;
  return <Steps flow={flow} />;
}

interface Problems {
  next: string | null;
  again: string | null;
}

const NONE: Problems = { next: null, again: null };

function Steps({ flow }: { flow: Flow }) {
  const vaults = useVaults();
  const listed = vaults?.find((entry) => entry.id === flow.vault)?.name ?? null;
  // The vault's name as the list has it (for what the key was typed for, and for "doesn't open"), and as the key's own details gave it once checked.
  const forName = listed ?? "this vault";
  const checkedName = flow.name === null || flow.name === "" ? forName : flow.name;

  const [typed, setTyped] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [problems, setProblems] = useState<Problems>(NONE);
  const wipe = () => {
    setTyped("");
    setNext("");
    setAgain("");
    setProblems(NONE);
  };
  // Every lock epoch (Lock all, an idle lock, Windows locking or sleeping) wipes what is typed, and the password boxes are drawn anew so Show goes back to
  // hidden (the key box shows its words and has no Show).
  const epoch = useLockEpoch();
  const [seenEpoch, setSeenEpoch] = useState(epoch);
  if (seenEpoch !== epoch) {
    setSeenEpoch(epoch);
    wipe();
  }
  // What is typed belongs to the step it was typed at: it goes when the flow moves on. The question about changed details counts, though it shows over 28a:
  // the key it asks about was accepted, so it is gone from the box under it.
  const view = viewOf(flow);
  const [seenPhase, setSeenPhase] = useState(flow.phase);
  if (seenPhase !== flow.phase) {
    setSeenPhase(flow.phase);
    wipe();
  }
  // With no vault open there is no session and so no lock event: what is typed here (a key or a password, kept while a typo is mended) must not sit in its box
  // while the person has gone, the PC locked (Win+L), or the window hidden. A refusal about the key that was in the box goes with it (typing clears a refusal,
  // so one showing over typed text is about that text): the person who left to read their saved copy comes back to an empty box, not to "a typo" in nothing.
  // A refusal over an empty box (an expired choice: type the key again) stays.
  const typedNow = useRef(typed);
  useEffect(() => {
    typedNow.current = typed;
  }, [typed]);
  useEffect(() => {
    const leave = () => {
      if (typedNow.current !== "") clearForgotProblem();
      setTyped("");
      setNext("");
      setAgain("");
      setProblems(NONE);
    };
    const hide = () => {
      if (document.visibilityState === "hidden") leave();
    };
    window.addEventListener("blur", leave);
    document.addEventListener("visibilitychange", hide);
    return () => {
      window.removeEventListener("blur", leave);
      document.removeEventListener("visibilitychange", hide);
    };
  }, []);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, [view]);
  // A refused key is mended where it is: when the check answers with a refusal, the focus goes to the box that still holds the key, as the password forms put
  // it on the box a refusal is about. A refusal that comes another way (an expired choice from 28d) is a new screen, and its heading has the focus.
  const keyBox = useRef<HTMLTextAreaElement>(null);
  const wasChecking = useRef(flow.checking);
  useEffect(() => {
    if (wasChecking.current && !flow.checking && flow.phase === "key" && flow.problem !== null) keyBox.current?.focus();
    wasChecking.current = flow.checking;
  }, [flow.checking, flow.phase, flow.problem]);

  let steps;
  if (view === "key") {
    const off = typed.trim() === "" || flow.checking;
    const said = flow.problem === null ? null : messageText(messageFor(flow.problem, { vault: forName }));
    const submit = (event: SyntheticEvent) => {
      event.preventDefault();
      if (off) return;
      // The key goes once. It stays in the box, read-only, until the answer: a refusal leaves it there to be mended, and an accepted key moves the flow on,
      // which wipes it.
      void checkRecoveryKey(typed);
    };
    steps = (
      <form className="fu" onSubmit={submit} noValidate>
        <h1 ref={heading} tabIndex={-1}>
          Forgot password?
        </h1>
        <p className="fu-sub">{`Type the recovery key you saved for ${forName}.`}</p>
        <RecoveryKeyField
          ref={keyBox}
          label={KEY_LABEL}
          hint={KEY_HINT}
          value={typed}
          readOnly={flow.checking}
          onChange={(value) => {
            if (flow.checking) return;
            setTyped(value);
            clearForgotProblem();
          }}
          error={said}
        />
        <div className="fu-row">
          <button type="submit" className="prim" aria-disabled={off ? true : undefined}>
            Continue
          </button>
          <button type="button" className="lnk" onClick={closeForgot}>
            Back
          </button>
        </div>
        <button type="button" className="lnk fu-other" aria-disabled={flow.checking ? true : undefined} onClick={noRecoveryKey}>
          I don&apos;t have my recovery key
        </button>
      </form>
    );
  } else if (view === "no_key") {
    steps = (
      <div className="fu">
        <h1 ref={heading} tabIndex={-1}>
          No recovery key?
        </h1>
        <p className="fu-sub strong">{`Without the password or the recovery key, nobody can get into ${forName}, and the data can't be recovered.`}</p>
        <p className="fu-sub">{NO_KEY_EXCEPTION}</p>
        <div className="fu-row">
          <button
            type="button"
            className="prim"
            onClick={() => {
              // The restore is the app's own and takes the window above this flow, which has nothing left to do: it ends here, as the lock screen's own link would.
              closeForgot();
              void startRestore();
            }}
          >
            Restore a backup
          </button>
          <button type="button" className="lnk" onClick={backToForgotKey}>
            Back
          </button>
        </div>
      </div>
    );
  } else if (view === "password") {
    const sending = flow.sending;
    const refusal = flow.passwordProblem === null ? null : messageText(messageFor(flow.passwordProblem.error));
    const aboutNext = flow.passwordProblem?.field === "new" ? refusal : null;
    const aboutForm = flow.passwordProblem?.field === "form" ? refusal : null;
    const submit = (event: SyntheticEvent) => {
      event.preventDefault();
      if (sending) return;
      const found: Problems = {
        next: Array.from(next.normalize("NFC")).length < MIN_PASSWORD ? TOO_SHORT : null,
        again: next !== again ? MISMATCH : null,
      };
      setProblems(found);
      if (found.next !== null || found.again !== null) return;
      // The password goes once, and is gone from here as it goes: the boxes are empty whatever comes back.
      const sentPassword = next;
      setNext("");
      setAgain("");
      void finishRecovery(sentPassword);
    };
    steps = (
      <form className="fu" onSubmit={submit} noValidate aria-busy={sending ? true : undefined}>
        <h1 ref={heading} tabIndex={-1}>
          Choose a new password
        </h1>
        <p className="fu-sub">{`For ${checkedName}.`}</p>
        <PasswordField
          key={`${String(epoch)}-new`}
          label="New password"
          autoComplete="new-password"
          rule="At least 12 characters."
          minimum={MIN_PASSWORD}
          readOnly={sending}
          value={next}
          error={problems.next ?? aboutNext}
          onChange={(value) => {
            setNext(value);
            setProblems(NONE);
            clearForgotProblem();
          }}
        />
        <PasswordField
          key={`${String(epoch)}-again`}
          label="New password again"
          autoComplete="new-password"
          readOnly={sending}
          value={again}
          error={problems.again}
          onChange={(value) => {
            setAgain(value);
            setProblems((now) => ({ ...now, again: null }));
          }}
        />
        {aboutForm === null ? null : (
          <p className="err" role="alert">
            {aboutForm}
          </p>
        )}
        <p className="caveat" role="note">
          {`${BACKUPS_NEED_OLD_DETAILS} ${OLD_COPIES_NEED_OLD_PASSWORD} ${LIMIT}`}
        </p>
        <div className="fu-row">
          <button type="submit" className="prim" aria-disabled={sending ? true : undefined}>
            Set new password
          </button>
          <button
            type="button"
            className="lnk"
            aria-disabled={sending ? true : undefined}
            onClick={() => {
              if (!sending) backToForgotKey();
            }}
          >
            Back
          </button>
        </div>
      </form>
    );
  } else {
    steps = (
      <div className="fu">
        <h1 ref={heading} tabIndex={-1}>
          {OFFER_TITLE}
        </h1>
        <p className="fu-sub strong">{`${checkedName} is open with its new password.`}</p>
        <p className="fu-hint">{OFFER}</p>
        <div className="fu-row">
          <button
            type="button"
            className="prim"
            onClick={() => {
              finishForgot(true);
            }}
          >
            Back up now
          </button>
          <button
            type="button"
            className="lnk"
            onClick={() => {
              finishForgot(false);
            }}
          >
            Not now
          </button>
        </div>
      </div>
    );
  }

  return (
    <>
      {/* Once the vault is open (28e) the side no longer promises the key can open it: it says where things stand. */}
      <Frame say={flow.phase === "done" ? SAID_DONE : SAY_FORGOT}>{steps}</Frame>
      <ChangedDetails open={flow.phase === "changed"} name={checkedName} />
      {/* Always on the page, so a change in it is spoken: the message stack that says these things in the main window is not here. */}
      <div role="status" className="live">
        <span className="sr">{flow.phase === "done" ? SAID_DONE : ""}</span>
      </div>
    </>
  );
}

/**
 * The question about details changed outside Lockbox, over 28a, in Ask 3's shape: a dialog that holds focus, since it is a security question; Escape and a click
 * outside are no yes, only a button answers. No, the safe answer, has the focus first: it lets the key go. Yes goes on to the new password, and goes to the
 * shell with it.
 */
function ChangedDetails({ open, name }: { open: boolean; name: string }) {
  const no = useRef<HTMLButtonElement>(null);
  return (
    <Dialog open={open} onOpenChange={() => undefined} title={`${name}'s details were changed outside Lockbox.`} description={CHANGED_DESCRIPTION} initialFocus={no}>
      <Button ref={no} onClick={backToForgotKey}>
        No
      </Button>
      <Button
        look="pill-main"
        onClick={() => {
          answerChangedDetails(true);
        }}
      >
        Yes
      </Button>
    </Dialog>
  );
}
