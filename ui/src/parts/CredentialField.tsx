import { useId, useState, type KeyboardEvent } from "react";
import { Button } from "./Button";

/**
 * The box a password or a recovery key is typed into when a backup (or later a vault) is opened with what it was made with: hidden to begin with,
 * named by its label, and never kept, filled in or corrected by the browser or the on-screen keyboard (`autoComplete`, `spellCheck`,
 * `autoCorrect` and `autoCapitalize` are all off, whether it shows or not). Show and Hide, beside the label, let a long recovery key be checked
 * against the paper it was written on. It says when Caps Lock is on (as a hint, not an alarm), and shows `error` as an alert tied to the box.
 *
 * The text is the caller's state: this part keeps none, so the screen decides when it is wiped (after every send, and when its panel closes).
 * Whether the text is shown is this part's own, and goes back to hidden with the box.
 */
export function CredentialField({
  label,
  value,
  onChange,
  error,
  autoFocus = false,
  readOnly = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** The words for a refusal, shown under the box; `null` for none. */
  error?: string | null;
  autoFocus?: boolean;
  /** The box can be read (and shown) but not typed in, while what it held is being used. */
  readOnly?: boolean;
}) {
  const id = useId();
  const [shown, setShown] = useState(false);
  const [capsLock, setCapsLock] = useState(false);
  // Read on every key, down and up: the keys are the only way a page learns the state of the lock.
  const watch = (event: KeyboardEvent<HTMLInputElement>) => {
    setCapsLock(event.getModifierState("CapsLock"));
  };
  const hint = `${id}-caps`;
  const problem = `${id}-error`;
  const described = [capsLock ? hint : null, error ? problem : null].filter(Boolean).join(" ");
  return (
    <div className="fbox">
      <div className="flrow">
        <label className="flab" htmlFor={id}>
          {label}
        </label>
        <Button
          aria-label={shown ? "Hide what you typed" : "Show what you typed"}
          onClick={() => {
            setShown((now) => !now);
          }}
        >
          {shown ? "Hide" : "Show"}
        </Button>
      </div>
      <input
        id={id}
        className="finp"
        type={shown ? "text" : "password"}
        autoComplete="off"
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
        autoFocus={autoFocus}
        readOnly={readOnly}
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
        <p className="ferr" id={problem} role="alert">
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
