import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type ReactNode, type Ref } from "react";
import { Button } from "../../parts/Button";
import { useValueGuard } from "../../useValueGuard";
import { hasInnerLineBreak } from "./shared";

/**
 * What a form says when a paste or a drop holds a line break inside the value and the box is a one-line one (the save box's):
 * nothing was changed. The new-key and edit-key forms keep such a value instead (`manyLines`).
 */
export const MANY_LINES = "That value has more than one line, so it wasn't pasted. A key's value is one line here.";

/**
 * Whether a text has a line break anywhere in it, the ends included. A one-line box drops every one of them as it takes the
 * value, so it cannot hold such a value as it is: a value that has one is held in the box for lines (`manyLines`), or, in a
 * password's one-line box, left out and said so.
 */
export function hasLineBreak(text: string): boolean {
  return /[\r\n]/.test(text);
}

/** The dots that stand in for a hidden value in the box for lines: the same for every value, so they never show its shape. */
const DOTS = "••••••••••••••";

/**
 * A key's Value box, shared by the new-key form (7a), the edit-key form and the save box: the label with Show and Hide, a
 * one-line box that is hidden until Show, and the rules of the box.
 *
 * With `manyLines` (the two key forms) a paste or a drop with a line break inside it is kept whole, exactly as given (CRLF and
 * LF as they came), and the value moves from the one-line box to a box for lines: one fixed height, a row of dots while hidden
 * (no text, no line count, nothing in the page until Show) and the lines while shown. That box is read-only: a paste or a drop
 * replaces the value (and hides it again: a new value is never on screen before Show is pressed), a one-line paste takes it back
 * to the one-line box, and the Clear button empties it. No key does: Delete, Backspace and Shift+Delete leave it alone. It cannot
 * be edited by hand, since a text box would change CRLF to LF as it took the text. A text with a line break anywhere, the ends
 * included, goes to the box for lines, since the one-line box would drop a break at either end. Without `manyLines` (the save box), such a paste
 * or drop is stopped and the form is told (`onRefused`) to say why in words; a change or a clean paste tells it (`onAccepted`)
 * so it can take those words away.
 *
 * While the value is shown, a copy or cut aimed at its box is stopped, so it cannot leave around the clipboard's marks, timer
 * and clearing (Copy key in the details is the way to copy). What is typed lives in the form's state, not here.
 */
export function ValueField({
  id,
  value,
  onChange,
  onRefused,
  onAccepted,
  manyLines = false,
  disabled = false,
  busy = false,
  describedBy,
  inputRef,
  children,
}: {
  id: string;
  value: string;
  onChange: (text: string) => void;
  /** A paste or a drop with a line break inside was stopped (a box that is not `manyLines`). */
  onRefused?: () => void;
  onAccepted?: () => void;
  /** The box keeps a value with line breaks (the two key forms). */
  manyLines?: boolean;
  /** The box is not ready (its stored value is still on its way). */
  disabled?: boolean;
  busy?: boolean;
  /** The ids of the lines under the box that describe it, for a screen reader. */
  describedBy?: string;
  /** Reaches the one-line box, for a form that puts focus on it when it opens. */
  inputRef?: Ref<HTMLInputElement>;
  /** Lines under the box. */
  children?: ReactNode;
}) {
  const [shown, setShown] = useState(false);
  const lines = useRef<HTMLDivElement>(null);
  /** The box the value is in has just changed, and focus was in the old one: it goes to the new one. */
  const refocus = useRef(false);
  const labelId = `${id}-label`;
  const inLines = manyLines && hasLineBreak(value);

  useValueGuard(lines);
  useEffect(() => {
    if (!refocus.current) return;
    refocus.current = false;
    document.getElementById(id)?.focus();
  }, [inLines, id]);

  /** Takes `text` as the whole value (a paste or a drop into the box for lines, which has no cursor), exactly as it came. */
  const replaceWith = (text: string, event: { preventDefault: () => void }) => {
    event.preventDefault();
    if (text === "" || disabled) return;
    refocus.current = hasLineBreak(text) !== inLines;
    // A new value is never on screen before the person asks for it: Show has to be pressed again to read it.
    setShown(false);
    onChange(text);
  };

  /**
   * Reads what is being pasted or dropped into the one-line box before it does; keeps it, or stops it, if it would be changed
   * silently. The one-line box drops a break at either end, so the key forms (`manyLines`) keep a text with a break anywhere in
   * it, the ends included; the one-line callers only stop one with a break inside.
   */
  const checkText = (text: string, event: ClipboardEvent<HTMLInputElement> | DragEvent<HTMLInputElement>) => {
    if (!(manyLines ? hasLineBreak(text) : hasInnerLineBreak(text))) {
      onAccepted?.();
      return;
    }
    event.preventDefault();
    if (!manyLines) {
      onRefused?.();
      return;
    }
    // Put in where the cursor is, in place of what is selected, as the box would have put it.
    const box = event.currentTarget;
    const start = box.selectionStart ?? value.length;
    const end = box.selectionEnd ?? start;
    refocus.current = true;
    setShown(false);
    onChange(`${value.slice(0, start)}${text}${value.slice(end)}`);
  };

  return (
    <div className="fbox">
      <div className="flrow">
        <label className="flab" id={labelId} htmlFor={id}>
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
        {inLines ? (
          <Button
            aria-label="Clear value"
            disabled={disabled}
            onClick={() => {
              // The box for lines goes with the value: focus moves to the one-line box that takes its place.
              refocus.current = true;
              onChange("");
            }}
          >
            Clear
          </Button>
        ) : null}
      </div>
      {inLines ? (
        <div
          ref={lines}
          id={id}
          className="finp m kbox"
          role="textbox"
          aria-multiline="true"
          aria-readonly="true"
          aria-labelledby={labelId}
          aria-describedby={[describedBy, `${id}-hint`].filter(Boolean).join(" ")}
          aria-disabled={disabled ? true : undefined}
          aria-busy={busy ? true : undefined}
          tabIndex={0}
          onPaste={(event) => {
            replaceWith(event.clipboardData.getData("text"), event);
          }}
          // A drop only arrives where the drag over it was allowed.
          onDragOver={(event) => {
            event.preventDefault();
          }}
          onDrop={(event) => {
            replaceWith(event.dataTransfer.getData("text"), event);
          }}
          // Shown, the lines can be selected, so a native copy or cut would skip the clipboard's marks, timer and clearing.
          onCopy={(event) => {
            event.preventDefault();
          }}
          onCut={(event) => {
            event.preventDefault();
          }}
          onDragStart={(event) => {
            event.preventDefault();
          }}
        >
          {shown ? (
            value
          ) : (
            <>
              <span className="kdots" aria-hidden="true">
                {DOTS}
              </span>
              <span className="sr">Hidden</span>
            </>
          )}
        </div>
      ) : (
        <input
          ref={inputRef}
          id={id}
          className="finp m"
          type={shown ? "text" : "password"}
          autoComplete="off"
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          placeholder="Paste the key"
          value={value}
          disabled={disabled}
          aria-busy={busy ? true : undefined}
          aria-describedby={describedBy}
          onChange={(event) => {
            onChange(event.currentTarget.value);
            onAccepted?.();
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
      )}
      {inLines ? (
        <p className="fhint" id={`${id}-hint`}>
          Paste to replace it.
        </p>
      ) : null}
      {children}
    </div>
  );
}
