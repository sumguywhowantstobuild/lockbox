import { useState } from "react";
import { messageFor, messageText } from "../../messages";
import { makeNewKey, startPicking, useSettings, type SessionData } from "../../store";
import { Frame, SAY_KEY } from "./Frame";
import { KeyActions, type PrintRun } from "./KeyActions";
import { asksFor, wordsOf } from "./keyWords";

/**
 * Puts focus on the heading when it appears after the questions (a wrong pick, or "Show the key again"): the button that had focus went with them, and
 * without this the next Tab would start from the top of the page. (One function for good, so a later render of the screen
 * does not take focus again.)
 */
function focusWhenShown(heading: HTMLHeadingElement | null): void {
  heading?.focus();
}

/**
 * The recovery key step (21c for a new vault, 21f for one whose earlier step never finished): the key as 24 numbered
 * words in two columns, headed as what it is (a Lockbox key, not a crypto wallet phrase), shown for as long as the vault
 * stays unlocked, and what losing it means. It is the store's, so any lock takes it off the screen and the
 * next unlock makes a new one. It can be printed or saved as a PDF (`KeyActions`); what goes on paper is the one element
 * marked `data-print-only` (the heading, the words and the warning), and `print.css` hides the rest.
 * Also the screens before the key arrives (21f asks the shell for a new one) and after the shell would not make it.
 */
export function RecoveryKey({ data }: { data: SessionData }) {
  // The print that is running, if any. Continue waits for it: going on takes the key off the page, and the page is what
  // the printer captures.
  const [printing, setPrinting] = useState<PrintRun>(null);
  // Lockbox stays out of screen capture unless the person turned that off in Settings: the sentence about screenshots follows it.
  const { capture_protected: keptOutOfCapture } = useSettings();
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
  const { key, unfinished, missed } = step;
  const back = step.back === true;
  const words = wordsOf(key);
  const half = Math.ceil(words.length / 2);
  // Two columns, 1 to 12 and 13 to 24, so the words can be copied by hand in order. Each word is its own element, and
  // the key is in no attribute (a title, a label), so it is read out and selected as the words it is.
  const column = (from: number, to: number) => (
    <ol className="fu-col">
      {words.slice(from, to).map((word, place) => (
        <li key={from + place}>
          <span className="fu-n">{from + place + 1}</span>
          <span className="fu-w">{word}</span>
        </li>
      ))}
    </ol>
  );
  return (
    <Frame say={SAY_KEY}>
      {unfinished ? null : <p className="fu-step">Step 2 of 2</p>}
      <h1 tabIndex={back ? -1 : undefined} ref={back ? focusWhenShown : undefined}>
        {unfinished ? "Finish your recovery key" : "Save your recovery key"}
      </h1>
      {unfinished ? (
        <p className="fu-sub">
          Last time this step didn&apos;t finish, so that key may not have been saved. This is a new one, and the old one no
          longer works.
        </p>
      ) : null}
      {missed ? (
        <p className="err" role="alert">
          That wasn&apos;t the right word, so here is your key again. Look it over, then go on to try three new words.
        </p>
      ) : null}
      <div className="fu-print" data-print-only>
        <h2 className="fu-kind">Lockbox recovery key, not a crypto wallet phrase</h2>
        <div className="fu-key m">
          {column(0, half)}
          {column(half, words.length)}
        </div>
        <KeyActions session={data.session} running={printing} setRunning={setPrinting} />
        <p className="fu-lose">If you lose both your password and this key, nobody can get your data back.</p>
      </div>
      <p className="fu-hint">
        Don&apos;t keep the saved key on this PC. Writing it down by hand is fine.{" "}
        {keptOutOfCapture
          ? "Screenshots won't work, because Lockbox stays out of screen capture."
          : "Don't take a screenshot of it: that would be a readable copy."}
      </p>
      <div className="fu-row">
        <button
          type="button"
          className="prim"
          aria-disabled={printing === null ? undefined : true}
          onClick={() => {
            if (printing !== null) return;
            startPicking(data.session, asksFor(key));
          }}
        >
          Continue
        </button>
      </div>
    </Frame>
  );
}
