import { useState, type ReactNode, type Ref } from "react";
import { Button } from "../../parts/Button";
import { hasInnerLineBreak } from "./shared";

/** What a form says when a paste or a drop holds a line break inside the value: nothing was changed. */
export const MANY_LINES = "That value has more than one line, so it wasn't pasted. A key's value is one line here.";

/**
 * Whether a stored value has a line break anywhere in it, the ends included. A one-line box drops every one of them as it takes
 * the value, so it cannot hold such a value as it is: an edit form leaves its box empty for one (and says so) rather than show,
 * and then save, a changed one.
 */
export function hasLineBreak(text: string): boolean {
  return /[\r\n]/.test(text);
}

/**
 * A key's Value box, shared by the new-key form (7a) and the edit-key form: the label with Show and Hide, a one-line box that
 * is hidden until Show, and the rules of the box. A paste or a drop with a line break inside it is stopped, and the form is
 * told (`onRefused`) to say why in words; a change or a clean paste tells it (`onAccepted`) so it can take those words away. While
 * the value is shown, a copy or cut aimed at its box is stopped, so it cannot leave around the clipboard's marks, timer and
 * clearing. What is typed lives in the form's state, not here.
 */
export function ValueField({
  id,
  value,
  onChange,
  onRefused,
  onAccepted,
  disabled = false,
  busy = false,
  describedBy,
  inputRef,
  children,
}: {
  id: string;
  value: string;
  onChange: (text: string) => void;
  onRefused: () => void;
  onAccepted: () => void;
  /** The box is not ready (its stored value is still on its way). */
  disabled?: boolean;
  busy?: boolean;
  /** The ids of the lines under the box that describe it, for a screen reader. */
  describedBy?: string;
  /** Reaches the box, for a form that puts focus on it when it opens. */
  inputRef?: Ref<HTMLInputElement>;
  /** Lines under the box. */
  children?: ReactNode;
}) {
  const [shown, setShown] = useState(false);

  /** Reads what is being pasted or dropped before the box does; stops it if it would be changed silently. */
  const checkText = (text: string, event: { preventDefault: () => void }) => {
    if (hasInnerLineBreak(text)) {
      event.preventDefault();
      onRefused();
    } else {
      onAccepted();
    }
  };

  return (
    <div className="fbox">
      <div className="flrow">
        <label className="flab" htmlFor={id}>
          Value
        </label>
        <Button
          aria-controls={id}
          onClick={() => {
            setShown(!shown);
          }}
        >
          {shown ? "Hide" : "Show"}
        </Button>
      </div>
      <input
        ref={inputRef}
        id={id}
        className="finp m"
        type={shown ? "text" : "password"}
        autoComplete="off"
        spellCheck={false}
        placeholder="Paste the key"
        value={value}
        disabled={disabled}
        aria-busy={busy ? true : undefined}
        aria-describedby={describedBy}
        onChange={(event) => {
          onChange(event.currentTarget.value);
          onAccepted();
        }}
        onPaste={(event) => {
          checkText(event.clipboardData.getData("text"), event);
        }}
        onDrop={(event) => {
          checkText(event.dataTransfer.getData("text"), event);
        }}
        // Shown, the value can be selected, so a native copy or cut would skip the clipboard's marks, timer and clearing.
        onCopy={(event) => {
          if (shown) event.preventDefault();
        }}
        onCut={(event) => {
          if (shown) event.preventDefault();
        }}
        // Nor can it be dragged out as text while it is shown.
        onDragStart={(event) => {
          if (shown) event.preventDefault();
        }}
      />
      {children}
    </div>
  );
}
