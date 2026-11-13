import { useId, useState, type KeyboardEvent } from "react";
import { CheckIcon } from "./Icon";

/**
 * A password box: hidden, named by its label, and never kept or filled in by the browser. It says when Caps Lock is on
 * (as a hint, not an alarm), and shows `error` as an alert tied to the box. The text is the caller's state: this part
 * keeps none.
 */
export function PasswordField({
  label,
  value,
  onChange,
  error,
  rule,
  minimum,
  autoFocus = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** The words for a refusal, shown under the box; `null` for none. */
  error?: string | null;
  /** A rule the password has to meet ("At least 12 characters."), shown under the box before anything is typed. */
  rule?: string;
  /**
   * With `rule`, the number of characters the rule asks for (counted after Unicode normalisation, as the engine does).
   * The rule then says how many are typed so far, and once the minimum is reached it says so with a check mark, and a
   * polite announcement is made that once. The count is not announced as it changes: the box points at the hint, so a
   * screen reader reads it on request.
   */
  minimum?: number;
  autoFocus?: boolean;
}) {
  const id = useId();
  const [capsLock, setCapsLock] = useState(false);
  // Read on every key, down and up: the keys are the only way a page learns the state of the lock.
  const watch = (event: KeyboardEvent<HTMLInputElement>) => {
    setCapsLock(event.getModifierState("CapsLock"));
  };
  const hint = `${id}-caps`;
  const problem = `${id}-error`;
  const ruleId = `${id}-rule`;
  const typed = minimum === undefined ? 0 : Array.from(value.normalize("NFC")).length;
  const met = minimum !== undefined && typed >= minimum;
  const metWords = `${String(minimum)} characters or more`;
  const ruleWords =
    minimum !== undefined && typed > 0 ? `${(rule ?? "").replace(/\.$/, "")} · ${String(typed)} so far` : rule;
  const described = [capsLock ? hint : null, error ? problem : null, rule ? ruleId : null].filter(Boolean).join(" ");
  return (
    <div>
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        className="inp"
        type="password"
        autoComplete="off"
        spellCheck={false}
        autoFocus={autoFocus}
        value={value}
        aria-invalid={error ? true : undefined}
        aria-describedby={described === "" ? undefined : described}
        onChange={(event) => {
          onChange(event.currentTarget.value);
        }}
        onKeyDown={watch}
        onKeyUp={watch}
      />
      {error ? (
        <p className="err" id={problem} role="alert">
          {error}
        </p>
      ) : null}
      {rule ? (
        <p className={met ? "fu-hint ok" : "fu-hint"} id={ruleId}>
          {met ? (
            <>
              <CheckIcon />
              {metWords}
            </>
          ) : (
            ruleWords
          )}
        </p>
      ) : null}
      {rule && minimum !== undefined ? (
        // Always on the page, so a change in it is announced; it changes once, at the minimum.
        <p className="sr" role="status">
          {met ? metWords : ""}
        </p>
      ) : null}
      {capsLock ? (
        <p className="note caps" id={hint}>
          Caps Lock is on.
        </p>
      ) : null}
    </div>
  );
}
