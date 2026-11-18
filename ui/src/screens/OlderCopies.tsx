import { Fragment, useEffect, useId, useRef, useState, type RefObject, type SyntheticEvent } from "react";
import { focusBack } from "../focus";
import { useLockEpoch } from "../jobs";
import { messageFor, messageText } from "../messages";
import {
  CHANGED_LISTING,
  COPY_CREDENTIAL_LABEL,
  copyCredentialHint,
  DELETE_ASKS_FIRST,
  deleteHeading,
  deleteWords,
  NONE_LEFT,
  OLDER_COPIES,
  olderCopiesFor,
  rowDetail,
} from "../olderCopiesWords";
import { Button } from "../parts/Button";
import { CredentialField } from "../parts/CredentialField";
import { Dialog } from "../parts/Dialog";
import { Panel } from "../parts/Panel";
import { abandonOlderDeletes, abandonOlderOpens, closeTool, deleteOlderCopy, loadOlderCopies, openOlderCopy, useOlderCopies, type SessionData } from "../store";

// Older copies (24f, 24g). A restore keeps the vault it replaced beside the restored one; these are those copies, listed for one vault. Open read-only asks for the
// password or recovery key the copy was made with, in the same box every backup uses, and opens it as a read-only session beside the live vault; Delete asks first
// (24g) and then deletes the folder for good. The panel is the vault's own (from Settings); the list is also drawn inside the restore, with Delete alone, when the
// swap was refused for too many copies. The page holds one listing (the store's): every button names its copy by vault and folder, and the store sends the ID of the
// newest listing. What is typed is this list's own state: wiped as it is sent, and on every lock epoch.

/** What the list says under its rows when a press found the copy changed, or the shell refused: an answer to the last press only. */
interface Notice {
  words: string;
  kind: "changed" | "refused";
}

/**
 * The older copies of `vault` as 24f draws them: a row for each (the folder's name, then "From <day> · <size>"), Open read-only (only when `canOpen`) and Delete on
 * each, and the hint. A copy's Open read-only shows its box under that row. `onDeleted` runs once a copy has been deleted for good (the restore goes back to its
 * question there); without it focus goes to `headingRef`, since the row it was on is gone.
 */
export function OlderCopiesList({
  vault,
  vaultName,
  canOpen,
  headingRef,
  onDeleted,
}: {
  vault: number;
  vaultName: string;
  canOpen: boolean;
  headingRef?: RefObject<HTMLElement | null>;
  onDeleted?: () => void;
}) {
  const listing = useOlderCopies();
  const mine = (listing ?? []).filter((entry) => entry.vault === vault);
  const ids = useId();
  // The folder whose box is open, what is typed in it and the words under it; the folder a delete asks about; a press is on its way; and what the last press said.
  const [opening, setOpening] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [asking, setAsking] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  // The shell has been handed a delete's yes.
  const [sent, setSent] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  // Every lock epoch wipes what is typed and hides it again: the box is drawn anew under the epoch's number, so its Show goes back to hidden.
  const epoch = useLockEpoch();
  const [seenEpoch, setSeenEpoch] = useState(epoch);
  if (seenEpoch !== epoch) {
    setSeenEpoch(epoch);
    setTyped("");
    setProblem(null);
  }
  useEffect(() => {
    void loadOlderCopies();
    // Leaving the list (its panel closed, the vault locked) walks away from an open that has not answered, and from a delete that has not been sent.
    return () => {
      abandonOlderOpens();
      abandonOlderDeletes();
    };
  }, []);
  // A lock epoch (Lock all, an idle lock, Windows locking) takes the same two, whatever is still on screen.
  useEffect(() => {
    abandonOlderOpens();
    abandonOlderDeletes();
  }, [epoch]);
  // A copy that is no longer listed has no box and no question.
  const boxFor = mine.some((entry) => entry.folder === opening) ? opening : null;

  const closeBox = () => {
    // Cancel while the shell works on it: the answer, when it comes, shows nothing.
    abandonOlderOpens();
    setOpening(null);
    setTyped("");
    setProblem(null);
  };
  const changed: Notice = { words: CHANGED_LISTING, kind: "changed" };
  // Cancel, or Escape, on the question: what waits for a listing is dropped. Once the shell has the yes it can't be stopped, and the question stays until it answers.
  const stopAsking = () => {
    if (sent) return;
    abandonOlderDeletes();
    setAsking(null);
  };

  const open = async (event: SyntheticEvent) => {
    event.preventDefault();
    if (boxFor === null || typed === "" || working) return;
    // The text goes once, and is gone from here as it goes: the box is empty whatever comes back.
    const text = typed;
    setTyped("");
    setProblem(null);
    setNotice(null);
    setWorking(true);
    try {
      const result = await openOlderCopy(vault, boxFor, text);
      if (result === "changed") {
        closeBox();
        setNotice(changed);
      }
      // `opened`: the window is the copy's now. `stale`: the vault locked meanwhile, and there is nothing to say.
    } catch (error) {
      setProblem(messageText(messageFor(error)));
    } finally {
      setWorking(false);
    }
  };

  const ask = async (folder: string) => {
    if (working) return;
    setNotice(null);
    setWorking(true);
    const result = await deleteOlderCopy(vault, folder, false);
    setWorking(false);
    if (result === "asked") setAsking(folder);
    else if (result === "changed") setNotice(changed);
    else if (typeof result === "object") setNotice({ words: messageText(messageFor(result.failed)), kind: "refused" });
  };

  const confirm = async () => {
    if (asking === null || working) return;
    setWorking(true);
    // Until the shell is handed the yes, Cancel (or leaving, or a lock) still stops it; from then on nothing can.
    const result = await deleteOlderCopy(vault, asking, true, () => {
      setSent(true);
    });
    setWorking(false);
    setSent(false);
    // Walked away from before it was sent: the question is already gone, and nothing was deleted.
    if (result === "cancelled") return;
    setAsking(null);
    if (result === "deleted") {
      if (onDeleted !== undefined) onDeleted();
      else window.setTimeout(() => headingRef?.current?.focus(), 0);
    } else if (result === "changed") {
      setNotice(changed);
    } else if (typeof result === "object") {
      setNotice({ words: messageText(messageFor(result.failed)), kind: "refused" });
    }
  };

  return (
    <>
      {listing === null ? null : mine.length === 0 ? (
        <p className="fhint">{NONE_LEFT}</p>
      ) : (
        <section className="gp">
          <div className="grp">
            {mine.map((entry, index) => {
              const detail = rowDetail(entry);
              const nameId = `${ids}-${String(index)}`;
              return (
                <Fragment key={entry.folder}>
                  <div className="frow">
                    <span className="fmeta">
                      <b id={nameId}>{entry.folder}</b>
                      {detail === null ? null : <small>{detail}</small>}
                    </span>
                    <div className="fact">
                      {canOpen ? (
                        <Button
                          look={boxFor === entry.folder ? "pill" : "pill-main"}
                          aria-describedby={nameId}
                          aria-expanded={boxFor === entry.folder}
                          onClick={() => {
                            // Another copy's box replaces this one: an open still waiting for the shell is walked away from.
                            abandonOlderOpens();
                            setNotice(null);
                            setProblem(null);
                            setTyped("");
                            setOpening(entry.folder);
                          }}
                        >
                          Open read-only
                        </Button>
                      ) : null}
                      <Button
                        aria-describedby={nameId}
                        aria-disabled={working ? true : undefined}
                        onClick={() => {
                          void ask(entry.folder);
                        }}
                      >
                        Delete
                      </Button>
                    </div>
                  </div>
                  {boxFor === entry.folder ? (
                    <form className="fld col" onSubmit={(event) => void open(event)} noValidate>
                      <CredentialField
                        key={epoch}
                        label={COPY_CREDENTIAL_LABEL}
                        value={typed}
                        readOnly={working}
                        autoFocus
                        onChange={(next) => {
                          setTyped(next);
                          setProblem(null);
                        }}
                        error={problem}
                      />
                      <p className="fhint">{copyCredentialHint(vaultName)}</p>
                      <div className="fact">
                        <Button look="pill-main" type="submit" aria-disabled={typed === "" || working ? true : undefined}>
                          Open
                        </Button>
                        <Button onClick={closeBox}>Cancel</Button>
                      </div>
                    </form>
                  ) : null}
                </Fragment>
              );
            })}
          </div>
        </section>
      )}
      {notice === null ? null : notice.kind === "changed" ? (
        <p className="fhint" role="status">
          {notice.words}
        </p>
      ) : (
        <p className="ferr" role="alert">
          {notice.words}
        </p>
      )}
      {mine.length === 0 ? null : <p className="fhint">{DELETE_ASKS_FIRST}</p>}
      <Dialog
        open={asking !== null}
        onOpenChange={(next) => {
          if (!next) stopAsking();
        }}
        title={deleteHeading(asking ?? "")}
        description={deleteWords(vaultName)}
        initialFocus={cancel}
      >
        <Button ref={cancel} aria-disabled={sent ? true : undefined} onClick={stopAsking}>
          Cancel
        </Button>
        <Button
          look="danger"
          aria-disabled={working ? true : undefined}
          onClick={() => {
            void confirm();
          }}
        >
          Delete for good
        </Button>
      </Dialog>
    </>
  );
}

/**
 * The Older copies panel (24f) of the vault open on screen: the copies a restore kept of it, whether it is open writable or read-only, with Open read-only and Delete
 * on each. Closing it gives focus back to Settings, where it was opened.
 */
export function OlderCopiesPanel({ data }: { data: SessionData }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);
  return (
    <Panel
      title={OLDER_COPIES}
      subtitle={olderCopiesFor(data.name)}
      titleRef={heading}
      onClose={() => {
        closeTool(data.session);
        focusBack("settings");
      }}
    >
      <OlderCopiesList vault={data.vaultId} vaultName={data.name} canOpen headingRef={heading} />
    </Panel>
  );
}
