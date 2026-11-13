import { useEffect, useId, useRef, useState } from "react";
import { messageFor, messageText } from "../../messages";
import { confirmRecovery, missedPick, nextQuestion, showKeyAgain, type SessionData } from "../../store";
import { Frame, SAY_KEY } from "./Frame";
import { QUESTIONS, wordsOf } from "./keyWords";

/**
 * 21d, step 2 of 2: the key is hidden, and three of its word numbers, chosen at random when the key was last shown, are
 * asked one at a time, each with four words to pick from (the right one and three from the key's other places). Words are
 * only picked here, never typed, so there is no text box. A wrong pick shows the key again and the next Continue asks
 * three new numbers; only when all three are right does the shell hear of it (`recovery_confirmed`), and only then is the
 * key dropped. The key and the questions are the store's, so a lock takes them.
 */
export function PickWords({ data }: { data: SessionData }) {
  const questionId = useId();
  const question = useRef<HTMLParagraphElement>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const running = useRef(false);

  const step = data.recovery;
  const at = step?.phase === "pick" ? step.at : 0;
  // Keyboard and screen reader users land on the question each time it changes, then Tab to its choices.
  useEffect(() => {
    question.current?.focus();
  }, [at]);

  if (step?.phase !== "pick") return null;
  const { key, unfinished, asks } = step;
  const ask = asks[at];
  if (ask === undefined) return null;
  const right = wordsOf(key)[ask.position - 1];

  const choose = (word: string) => {
    if (running.current) return;
    setFailure(null);
    if (word !== right) {
      missedPick(data.session, at);
      return;
    }
    if (at < asks.length - 1) {
      nextQuestion(data.session, at);
      return;
    }
    running.current = true;
    setBusy(true);
    // On success the key step is over and this screen goes with it. On a refusal the last question stays, and picking the
    // right word again is the way to try again.
    confirmRecovery(data.session)
      .catch((refusal: unknown) => {
        setFailure(messageText(messageFor(refusal)));
      })
      .finally(() => {
        running.current = false;
        setBusy(false);
      });
  };

  return (
    <Frame say={SAY_KEY}>
      {unfinished ? null : <p className="fu-step">Step 2 of 2</p>}
      <h1>Check your recovery key</h1>
      <p className="fu-sub">The key is hidden now. For each number, pick the word you saved.</p>
      <p className="fu-step">{`Question ${String(at + 1)} of ${String(QUESTIONS)}`}</p>
      <div role="group" aria-labelledby={questionId} className="fu-ask">
        <p id={questionId} className="fu-q" tabIndex={-1} ref={question}>
          {`Which word is number ${String(ask.position)}?`}
        </p>
        <div className="fu-pick m">
          {ask.choices.map((word) => (
            <button
              key={word}
              type="button"
              disabled={busy}
              onClick={(event) => {
                // The second click of a double-click lands on the next question's buttons, which sit in the same
                // places: only a first click answers. The keyboard's activation has no click count (0), so it does.
                if (event.detail > 1) return;
                choose(word);
              }}
            >
              {word}
            </button>
          ))}
        </div>
      </div>
      {failure === null ? null : (
        <p className="err" role="alert">
          {failure}
        </p>
      )}
      <div className="fu-row">
        <button
          type="button"
          className="lnk"
          disabled={busy}
          onClick={() => {
            showKeyAgain(data.session);
          }}
        >
          Show the key again
        </button>
      </div>
    </Frame>
  );
}
