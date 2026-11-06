import { useId, useState, type KeyboardEvent } from "react";

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
  autoFocus = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** The words for a refusal, shown under the box; `null` for none. */
  error?: string | null;
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
  const described = [capsLock ? hint : null, error ? problem : null].filter(Boolean).join(" ");
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
      {capsLock ? (
        <p className="note caps" id={hint}>
          Caps Lock is on.
        </p>
      ) : null}
    </div>
  );
}
