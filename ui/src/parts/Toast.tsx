import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type FocusEvent } from "react";
import { focusList } from "../focus";
import { messageFor } from "../messages";
import { clearCopiedNow, clearToast, undoTrash, useToast, type Toast } from "../store";
import { CloseIcon } from "./Icon";

/** How long a short message ("Saved", "Moved to Lineproof", "Restored") stays. */
const SAVED_SECONDS = 4;

/** How long "Moved to Trash" stays, with its Undo: long enough to reach for it. */
const TRASHED_SECONDS = 10;

/** Whether a key pressed in `target` goes to typing: a text box, a list box's own input, or anything editable. */
function isTyping(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || target.closest("input, textarea, select") !== null);
}

/** Whole seconds until `endsAt`, counting down while the page is open; 0 once it has passed or when there is none. */
function useSecondsLeft(endsAt: number | null): number {
  const subscribe = useCallback(
    (notify: () => void) => {
      if (endsAt === null) return () => undefined;
      const timer = setInterval(notify, 250);
      return () => {
        clearInterval(timer);
      };
    },
    [endsAt],
  );
  return useSyncExternalStore(subscribe, () =>
    endsAt === null ? 0 : Math.max(0, Math.ceil((endsAt - Date.now()) / 1000)),
  );
}

/**
 * Whether the pointer rests on the message or focus is inside it, for the message it was seen on: a new message starts clear, so
 * a pointer that was on the one before never holds the next. `bind` goes on the message's own box.
 */
function useHeld(toast: Toast | null) {
  const [held, setHeld] = useState<{ toast: Toast | null; pointer: boolean; focus: boolean }>({ toast: null, pointer: false, focus: false });
  const mine = held.toast === toast ? held : { toast, pointer: false, focus: false };
  return {
    holding: toast !== null && (mine.pointer || mine.focus),
    bind: {
      onMouseEnter: () => {
        setHeld({ ...mine, pointer: true });
      },
      onMouseLeave: () => {
        setHeld({ ...mine, pointer: false });
      },
      onFocus: () => {
        setHeld({ ...mine, focus: true });
      },
      onBlur: (event: FocusEvent<HTMLElement>) => {
        // Focus moving to another part of the same message is still focus on it.
        if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
        setHeld({ ...mine, focus: false });
      },
    },
  };
}

/**
 * The message at the foot of the window: that a value was copied and when the clipboard clears, that something was saved, moved or
 * restored, that an item went to the Trash (with Undo), or that a change did not work. The place that announces a copy is always on
 * the page (a screen reader only speaks changes in a place it already knows), and says each message once; the countdown in view is
 * not spoken, or it would speak every second. The newest message is the only one: it replaces the one before.
 */
export function ToastStack() {
  const toast = useToast();
  const copied = toast?.kind === "copied" ? toast : null;
  const saved = toast?.kind === "saved" ? toast : null;
  const said = toast?.kind === "said" ? toast : null;
  const trashed = toast?.kind === "trashed" ? toast : null;
  const noted = toast?.kind === "noted" ? toast : null;
  const left = useSecondsLeft(copied?.endsAt ?? null);
  const { holding, bind } = useHeld(trashed);
  // The trash message whose Undo was already asked for: the message stays until the restore is answered, and a held Ctrl+Z, a
  // second press or Undo after Ctrl+Z must not send a second restore for an item already on its way back.
  const undone = useRef<Toast | null>(null);
  const undoOnce = useCallback(() => {
    if (trashed === null || undone.current === trashed) return;
    undone.current = trashed;
    void undoTrash(trashed.session, trashed.id);
  }, [trashed]);

  // When the time is up the message goes. The shell clears the clipboard at the same moment.
  useEffect(() => {
    if (copied !== null && left === 0) clearToast();
  }, [copied, left]);

  // A short message says it once and goes after a few seconds, or when another message takes its place.
  const short = saved ?? said;
  useEffect(() => {
    if (short === null) return;
    const timer = setTimeout(clearToast, SAVED_SECONDS * 1000);
    return () => {
      clearTimeout(timer);
    };
  }, [short]);

  // "Moved to Trash" stays about ten seconds, and its time does not run out while the pointer rests on it or Undo has focus:
  // when the pointer leaves, or focus does, the ten seconds begin again.
  useEffect(() => {
    if (trashed === null || holding) return;
    const timer = setTimeout(clearToast, TRASHED_SECONDS * 1000);
    return () => {
      clearTimeout(timer);
    };
  }, [trashed, holding]);

  // While "Moved to Trash" shows, Ctrl+Z does what its Undo does, from anywhere: in a long list the keyboard could not reach Undo, which
  // comes after the list, before its time ran out. Not inside a text box, where Ctrl+Z undoes typing, and not while a question is up.
  useEffect(() => {
    if (trashed === null) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (!event.ctrlKey || event.shiftKey || event.altKey || event.metaKey || event.key.toLowerCase() !== "z") return;
      if (event.defaultPrevented || isTyping(event.target)) return;
      if (document.querySelector('[role="dialog"], [role="alertdialog"]') !== null) return;
      event.preventDefault();
      if (!event.repeat) undoOnce();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [trashed, undoOnce]);

  // A failure, or a sentence the person has to act on (`told`): both are alerts, and both stay until dismissed or replaced.
  const failure = toast?.kind === "failed" ? messageFor(toast.error) : null;
  const told = toast?.kind === "told" ? toast.text : null;
  return (
    <div className="tstack">
      <div role="status" className="live">
        {copied !== null && left > 0 ? (
          <div className="toast">
            <span>{copied.text}</span>
            <span className="tc" aria-hidden="true">
              clears in <span className="tn">{left}</span> s
            </span>
            <span className="sr">It clears from the clipboard in {copied.seconds} seconds.</span>
            <button
              type="button"
              className="tb2"
              onClick={(event) => {
                // The message is replaced by what the clear found: focus goes back to the list if the button had it.
                if (document.activeElement === event.currentTarget) focusList();
                void clearCopiedNow();
              }}
            >
              Clear now
            </button>
          </div>
        ) : null}
        {saved !== null ? (
          <div className="toast">
            <span>Saved</span>
          </div>
        ) : null}
        {said !== null ? (
          <div className="toast">
            <span>{said.text}</span>
          </div>
        ) : null}
        {noted !== null ? (
          // A sentence to read (a file opened as a read-only copy, a saved copy that is not encrypted): it wraps, stays until "Got it", and takes
          // focus back to the list if the button had it, so the keyboard is not left at the top of the page.
          <div className="toast long">
            <span>{noted.text}</span>
            <button
              type="button"
              className="tb2"
              onClick={(event) => {
                const hadFocus = document.activeElement === event.currentTarget;
                clearToast();
                if (hadFocus) focusList();
              }}
            >
              Got it
            </button>
          </div>
        ) : null}
        {trashed !== null ? (
          <div className="toast" {...bind}>
            <span>Moved to Trash</span>
            <span className="tc" aria-hidden="true">
              Ctrl+Z
            </span>
            <button
              type="button"
              className="tb2"
              aria-keyshortcuts="Control+Z"
              onClick={undoOnce}
            >
              Undo
            </button>
          </div>
        ) : null}
      </div>
      {failure !== null || told !== null ? (
        <div role="alert" className="toast">
          <span>{failure === null ? told : `${failure.title} ${failure.body}`}</span>
          <button type="button" className="tb2" aria-label="Dismiss message" onClick={clearToast}>
            <CloseIcon />
          </button>
        </div>
      ) : null}
    </div>
  );
}
