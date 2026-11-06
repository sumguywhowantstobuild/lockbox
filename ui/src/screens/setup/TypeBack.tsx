import { useId, useRef, useState, type SyntheticEvent } from "react";
import { messageFor, messageText } from "../../messages";
import { confirmRecovery, groupBoxName, setForm, showKeyAgain, useForm, type SessionData } from "../../store";
import { Frame, SAY_KEY } from "./Frame";
import { groupMatches, ordinal } from "./keyGroups";

/**
 * 21d, step 2 of 2: the key is hidden, and two of its groups, picked at random when the key was last shown, are typed
 * back from what the person saved. Only when both match does the shell hear of it (`recovery_confirmed`), and only then
 * is the key dropped. What is typed is the store's, like the key: a lock takes it too. A wrong group is said, by its
 * number and never by its text, and the step stays.
 */
export function TypeBack({ data }: { data: SessionData }) {
  const baseId = useId();
  const first = useForm(data.session, groupBoxName(0));
  const second = useForm(data.session, groupBoxName(1));
  const [problems, setProblems] = useState<[string | null, string | null]>([null, null]);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const running = useRef(false);

  const step = data.recovery;
  if (step?.phase !== "typeback") return null;
  const { key, groups, unfinished } = step;
  const typed = [first, second];

  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    if (running.current) return;
    const found = groups.map((group, slot): string | null => {
      const text = typed[slot] ?? "";
      if (text.trim() === "") return `Type the ${ordinal(group + 1)} group.`;
      return groupMatches(key, group, text) ? null : `The ${ordinal(group + 1)} group doesn't match.`;
    });
    setProblems([found[0] ?? null, found[1] ?? null]);
    if (found.some((problem) => problem !== null)) return;
    running.current = true;
    setBusy(true);
    setFailure(null);
    // On success the key step is over and this screen goes with it.
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
      <form className="fu" onSubmit={submit} noValidate>
        {unfinished ? null : <p className="fu-step">Step 2 of 2</p>}
        <h1>Type part of your key back</h1>
        <p className="fu-sub">
          The key is hidden now. Type its {ordinal(groups[0] + 1)} and {ordinal(groups[1] + 1)} groups from what you saved.
        </p>
        {groups.map((group, slot) => {
          const id = `${baseId}-${String(slot)}`;
          const problem = problems[slot];
          return (
            <div key={group}>
              <label htmlFor={id}>{`${ordinal(group + 1)} group`}</label>
              <input
                id={id}
                className="inp m"
                autoComplete="off"
                spellCheck={false}
                value={typed[slot] ?? ""}
                aria-invalid={problem === null ? undefined : true}
                aria-describedby={problem === null ? undefined : `${id}-error`}
                onChange={(event) => {
                  setForm(data.session, groupBoxName(slot === 0 ? 0 : 1), event.currentTarget.value);
                  setProblems((current) => (slot === 0 ? [null, current[1]] : [current[0], null]));
                }}
              />
              {problem === null ? null : (
                <p className="err" id={`${id}-error`} role="alert">
                  {problem}
                </p>
              )}
            </div>
          );
        })}
        {failure === null ? null : (
          <p className="err" role="alert">
            {failure}
          </p>
        )}
        <div className="fu-row">
          <button type="submit" className="prim" disabled={busy}>
            Continue
          </button>
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
      </form>
    </Frame>
  );
}
