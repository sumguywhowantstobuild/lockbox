import { useId, type KeyboardEvent, type Ref } from "react";

/**
 * The box a recovery key alone is typed into (forgot password's 28a, as drawn): several lines in the mono face, the words shown as typed and wrapping, so
 * 24 words can be read back against the copy they were written on (Ariel's call, Plan 4C Task 13c). Never kept, filled in or corrected by the browser or the
 * on-screen keyboard (`autoComplete`, `spellCheck`, `autoCorrect` and `autoCapitalize` all off). A box that takes a password or a key stays
 * `CredentialField`, hidden, since a password must not show.
 *
 * Enter sends the form, as the one-line box did: a key never needs a line break (line breaks count as spaces when it is read), so Shift+Enter is left as
 * one, for a key copied out line by line, and an Enter that ends a word an input method is composing is that method's own. There is no Caps Lock line: the
 * words are read whatever their case.
 *
 * The text is the caller's state: this part keeps none, so the screen decides when it is wiped.
 */
export function RecoveryKeyField({
  label,
  hint,
  value,
  onChange,
  error,
  readOnly = false,
  ref,
}: {
  label: string;
  /** The line under the box, which describes it. */
  hint: string;
  value: string;
  onChange: (value: string) => void;
  /** The words for a refusal, shown under the box and read before the hint; `null` for none. */
  error?: string | null;
  /** The box can be read but not typed in, while what it holds is being checked. */
  readOnly?: boolean;
  ref?: Ref<HTMLTextAreaElement>;
}) {
  const id = useId();
  const about = `${id}-hint`;
  const problem = `${id}-error`;
  const send = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  };
  return (
    <div>
      <label htmlFor={id}>{label}</label>
      <textarea
        ref={ref}
        id={id}
        className="finp farea fkey m"
        rows={4}
        autoComplete="off"
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
        readOnly={readOnly}
        value={value}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${problem} ${about}` : about}
        onChange={(event) => {
          onChange(event.currentTarget.value);
        }}
        onKeyDown={send}
      />
      {error ? (
        <p className="ferr" id={problem} role="alert">
          {error}
        </p>
      ) : null}
      <p className="fu-hint" id={about}>
        {hint}
      </p>
    </div>
  );
}
