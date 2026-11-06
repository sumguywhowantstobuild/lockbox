import { useCallback, useEffect, useSyncExternalStore } from "react";
import { messageFor } from "../messages";
import { clearToast, useToast } from "../store";
import { CloseIcon } from "./Icon";

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
 * The message at the foot of the window: that a value was copied and when the clipboard clears, or that a copy did not
 * work. The place that announces a copy is always on the page (a screen reader only speaks changes in a place it already
 * knows), and says it once; the countdown in view is not spoken, or it would speak every second.
 */
export function ToastStack() {
  const toast = useToast();
  const copied = toast?.kind === "copied" ? toast : null;
  const left = useSecondsLeft(copied?.endsAt ?? null);

  // When the time is up the message goes. The shell clears the clipboard at the same moment.
  useEffect(() => {
    if (copied !== null && left === 0) clearToast();
  }, [copied, left]);

  const failure = toast?.kind === "failed" ? messageFor(toast.error) : null;
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
          </div>
        ) : null}
      </div>
      {failure !== null ? (
        <div role="alert" className="toast">
          <span>
            {failure.title} {failure.body}
          </span>
          <button type="button" className="tb2" aria-label="Dismiss message" onClick={clearToast}>
            <CloseIcon />
          </button>
        </div>
      ) : null}
    </div>
  );
}
