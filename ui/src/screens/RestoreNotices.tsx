import { useEffect, useRef, useState, type ReactNode } from "react";
import { messageFor, messageText } from "../messages";
import {
  damagedHeading,
  DAMAGED_WORDS,
  DRIVE_STILL_MISSING,
  missingWords,
  MISSING_HEADING,
  PENDING_HEADING,
  PENDING_WORDS,
  RESTORE_STILL_WAITING,
  SAY_RESTORE,
  UNCLEAR_WORDS,
  undoneWords,
  UNDONE_HEADING,
} from "../restoreWords";
import { closeRestoreNotice, dismissUnfinishedRestore, retryUnfinishedRestore, startRestore, useNotices, type RestoreAsk } from "../store";
import { Frame } from "./setup/Frame";

// A restore that didn't finish (Ask 6, Ask 7 and the two states with no drawn screen) and a vault that can't be opened (Ask 8). All of them are full-screen
// steps on the restore's two-sided frame, shown by the app above whatever it would show and below an open restore, and each has a polite place of its own that
// says what a press found, as the restore's steps do. The words are fixed text with the vault's name or the folder as text: a refusal goes through
// `messageFor`, and nothing here is a path the page could send back.

/** One of these screens: its heading (which takes the focus), its words, the buttons and what a press said under them. */
function Screen({ heading, words, said, problem, children }: { heading: string; words: string; said: string; problem: string | null; children: ReactNode }) {
  const title = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    title.current?.focus();
  }, [heading]);
  return (
    <>
      <Frame say={SAY_RESTORE}>
        <div className="fu">
          <h1 ref={title} tabIndex={-1}>
            {heading}
          </h1>
          <p className="fu-sub">{words}</p>
          {problem === null ? null : (
            <p className="err" role="alert">
              {problem}
            </p>
          )}
          <div className="fu-row">{children}</div>
        </div>
      </Frame>
      {/* Always on the page, so a change in it is spoken. */}
      <div role="status" className="live">
        <span className="sr">{said}</span>
      </div>
    </>
  );
}

/**
 * The notice of a restore that didn't finish, when it has a screen of its own:
 *
 * - **Ask 6** (the restore was undone, and the vault is as it was): Restore again starts the restore afresh; Not now closes it.
 * - **Ask 7** (the drive it was using isn't connected) and the rename that failed: Try again asks the shell to run recovery again and shows what it found, or
 *   says it is still the same; Dismiss lets the journal go and leaves the folders there as they are.
 * - The journal that can't be read: Dismiss only.
 *
 * The finished notice is not here: it stays on the lock screen. Nothing is shown while there is no notice.
 */
export function RestoreNotices() {
  const { restore } = useNotices();
  if (restore === null || restore.ask === "finished") return null;
  return <Notice key={restore.ask} ask={restore} />;
}

function Notice({ ask }: { ask: Exclude<RestoreAsk, { ask: "finished" }> }) {
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

  // A press that is refused (a restore is running, `busy`) is said under the buttons in the table's words, and the screen stays.
  const tryAgain = async () => {
    if (busy) return;
    setBusy(true);
    setSaid("");
    setProblem(null);
    try {
      const found = await retryUnfinishedRestore();
      if (found === "still") setSaid(ask.ask === "drive_missing" ? DRIVE_STILL_MISSING : RESTORE_STILL_WAITING);
    } catch (refusal) {
      setProblem(messageText(messageFor(refusal)));
    } finally {
      setBusy(false);
    }
  };
  const dismiss = async () => {
    if (busy) return;
    setBusy(true);
    setSaid("");
    setProblem(null);
    try {
      await dismissUnfinishedRestore();
    } catch (refusal) {
      setProblem(messageText(messageFor(refusal)));
    } finally {
      setBusy(false);
    }
  };
  const off = busy ? true : undefined;

  if (ask.ask === "undone") {
    return (
      <Screen heading={UNDONE_HEADING} words={undoneWords(ask.name)} said={said} problem={problem}>
        <button
          type="button"
          className="prim"
          onClick={() => {
            // The notice is closed and the restore begun from the start, with no vault: the usual folder.
            closeRestoreNotice();
            void startRestore();
          }}
        >
          Restore again
        </button>
        <button type="button" className="lnk" onClick={closeRestoreNotice}>
          Not now
        </button>
      </Screen>
    );
  }
  const heading = ask.ask === "drive_missing" ? MISSING_HEADING : ask.ask === "pending" ? PENDING_HEADING : UNDONE_HEADING;
  const words = ask.ask === "drive_missing" ? missingWords(ask.folder ?? "its folder") : ask.ask === "pending" ? PENDING_WORDS : UNCLEAR_WORDS;
  return (
    <Screen heading={heading} words={words} said={said} problem={problem}>
      {ask.ask === "unclear" ? null : (
        <button
          type="button"
          className="prim"
          aria-disabled={off}
          onClick={() => {
            void tryAgain();
          }}
        >
          Try again
        </button>
      )}
      <button
        type="button"
        className={ask.ask === "unclear" ? "prim" : "lnk"}
        aria-disabled={off}
        onClick={() => {
          void dismiss();
        }}
      >
        Dismiss
      </button>
    </Screen>
  );
}

/**
 * Ask 8: a vault listed with `details_damaged` (its two copies of its details are both unreadable), so no password can open it. Shown by the lock screen in place of its password box. Restore a
 * backup begins a restore for that vault (the backup unpacks in a new folder beside the damaged one, which is left alone); Back is the lock screen again.
 */
export function DamagedVaultAsk({ vault, name, onBack }: { vault: number; name: string | null; onBack: () => void }) {
  return (
    <Screen heading={damagedHeading(name)} words={DAMAGED_WORDS} said="" problem={null}>
      <button
        type="button"
        className="prim"
        onClick={() => {
          void startRestore({ vault });
        }}
      >
        Restore a backup
      </button>
      <button type="button" className="lnk" onClick={onBack}>
        Back
      </button>
    </Screen>
  );
}
