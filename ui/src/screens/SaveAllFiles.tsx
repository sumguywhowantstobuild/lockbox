import { useEffect, useRef, type KeyboardEvent } from "react";
import { endTitle, KEEP_OPEN, attachedTo, renamedSentence, stoppedLines, stoppedReason, UNENCRYPTED_WARNING } from "../saveAllWords";
import { focusButton, focusList } from "../focus";
import { formatBytes } from "../format";
import { useJob } from "../jobs";
import { Button } from "../parts/Button";
import { KindIcon } from "../parts/Icon";
import { JobProgress } from "../parts/JobProgress";
import { Panel } from "../parts/Panel";
import type { SaveAllView } from "../api";
import { closeSaveAll, confirmSaveAll, leaveSaveAllQuestion, showSavedFolder, startOpenBackup, type SaveAllFlow, type SessionData } from "../store";
import { nowGoing } from "./AddFiles";
import { CloudCopyQuestion, typeWord } from "./FileActions";

// Save all of a folder's files (Plan 4B Task 11), as drawn in Saving, Done, SameName, Damaged and Stopped: one panel from the bar to the summary.
// The page holds names, sizes and tokens (the folder the files go to stays in Rust; `folder_shown` is only text to say), and what it sends back is
// the folder's id, the plan's choice and the summary's handle.

/** After the panel closes, focus goes back to the folder's menu button, which opened it (or to the list when the menu is not there any more). */
function focusMenu(): void {
  focusButton('[aria-label="More for this folder"]', focusList);
}

/**
 * What the end says besides its heading, in the order of the drawn summaries: what could not be saved (a damaged file, a file that left the vault), each
 * saved file with its type, size and what it is attached to (`rows`: the panel lists them, the card in the list's column does not), the names that
 * changed, the file that was caught by a stop and those not started, and the warning that the copies aren't encrypted. `alert` makes a damaged
 * file an alert, for the panel that has just appeared; the card is said by the page's spoken place instead.
 */
function SaveAllSummary({ view, rows, alert }: { view: SaveAllView; rows: boolean; alert: boolean }) {
  const reason = stoppedReason(view.stopped);
  const { sentence, notStarted } = stoppedLines(view);
  const saved = view.saved.length > 0;
  return (
    <>
      {reason === null ? null : <p className="ferr">{reason}</p>}
      {view.damaged.map((name, at) => (
        <p key={`d${String(at)}:${name}`} className="ferr" role={alert ? "alert" : undefined}>
          {`${name} is damaged, so it wasn't saved. A backup may have a good copy.`}
        </p>
      ))}
      {/* One way to the backup for the damaged files (Task 7): a backup may hold a good copy of each. */}
      {view.damaged.length === 0 ? null : (
        <div className="fact">
          <Button
            onClick={() => {
              void startOpenBackup();
            }}
          >
            Open a backup
          </Button>
        </div>
      )}
      {view.gone.map((name, at) => (
        <p key={`g${String(at)}:${name}`} className="psub">
          {`${name} was removed from the vault before it was saved.`}
        </p>
      ))}
      {rows && saved ? (
        <section className="gp">
          <div className="grp">
            {view.saved.map((file, at) => (
              <div key={`${String(at)}:${file.name}`} className="frow">
                <span className="ftile t1" aria-hidden="true">
                  {typeWord(file.name) ?? <KindIcon kind="file" />}
                </span>
                <span className="fmeta">
                  <b>{file.name}</b>
                  <small>{`${formatBytes(file.size)}${attachedTo(file)}`}</small>
                </span>
              </div>
            ))}
          </div>
        </section>
      ) : null}
      {view.renamed.map((change, at) => (
        <p key={`r${String(at)}:${change.from}`} className="fwarn">
          {renamedSentence(change)}
        </p>
      ))}
      {sentence === null ? null : <p className="psub">{sentence}</p>}
      {notStarted.length === 0 ? null : (
        <div className="sumlist">
          <p className="gh">These files weren&apos;t started:</p>
          <ul className="names">
            {notStarted.map((name, at) => (
              <li key={`${String(at)}:${name}`}>{name}</li>
            ))}
          </ul>
        </div>
      )}
      {saved ? <p className="fwarn">{UNENCRYPTED_WARNING}</p> : null}
    </>
  );
}

/**
 * What the end says to a person who has gone to another item while the save worked: a card in the list's column with the summary's lines (not every
 * file's row), so the warning about the copies is never lost with the panel. Show in Explorer opens the folder; Dismiss puts the card and the
 * summary's handle away.
 */
export function SaveAllLeft({ data }: { data: SessionData }) {
  const flow = data.saveAll;
  if (flow === null || flow.phase !== "done" || flow.result === null || data.tool?.kind === "save_all") return null;
  const view = flow.result;
  const title = endTitle(view, flow.plan?.files.length ?? 0);
  return (
    <section className="ask away" aria-label={title}>
      <p className="jt">{title}</p>
      {view.saved.length > 0 ? <p className="psub">{`In ${view.folder_shown}.`}</p> : null}
      <SaveAllSummary view={view} rows={false} alert={false} />
      <div className="ask-acts">
        {view.saved.length > 0 ? (
          <Button
            onClick={() => {
              void showSavedFolder(data.session);
            }}
          >
            Show in Explorer
          </Button>
        ) : null}
        <Button
          onClick={() => {
            closeSaveAll(data.session);
          }}
        >
          Dismiss
        </Button>
      </div>
    </section>
  );
}

/**
 * The question before the files go to a folder a cloud service syncs: the words are Save a copy's, in the plural. Pick another folder is the safe
 * answer, with the first focus, and asks Windows again; Save here anyway goes on with the folder the shell parked; Escape writes nothing.
 */
export function SaveAllCloudQuestion({ data }: { data: SessionData }) {
  const { session } = data;
  return (
    <CloudCopyQuestion
      many
      open={data.saveAll?.phase === "cloud"}
      onAnother={() => {
        leaveSaveAllQuestion(session, true);
      }}
      onContinue={() => {
        void confirmSaveAll(session);
      }}
      onNo={() => {
        leaveSaveAllQuestion(session, false);
        focusMenu();
      }}
    />
  );
}

/**
 * The Save all panel, as it follows the save:
 *
 * - **Saving:** one bar for every file's bytes (`JobProgress`): "From <folder>, to <where>.", the file going now and "3 of 4", the bytes, the sentence about
 *   the laptop, and Stop. The panel's own Close lets the save carry on, with its bar in the list's column.
 * - **The end:** how many files were saved, in <where>, each file, what changed or was left out, the warning, Show in Explorer and Done.
 *
 * Focus is on the panel's heading when it opens, and when the save changes phase if focus was in the panel's own place, so what it says is read;
 * focus the person put elsewhere (the list's filter) stays there, and the store says the end in the page's spoken place instead.
 */
export function SaveAllFiles({ data }: { data: SessionData }) {
  const flow = data.saveAll;
  if (flow === null || flow.plan === null) return null;
  return <SaveAllPanel data={data} flow={flow} />;
}

function SaveAllPanel({ data, flow }: { data: SessionData; flow: SaveAllFlow }) {
  const { session } = data;
  const { plan, phase } = flow;
  const heading = useRef<HTMLHeadingElement>(null);
  const job = useJob(phase === "saving" && data.fileJob?.kind === "save_all" ? data.fileJob.request : null);

  // The heading takes focus when the panel opens, and as the end arrives when focus is the panel's to give: the end takes it only if focus was in this
  // save's own panel or bar as it ended (decided by the store, while the bar was still there). Focus in the filter, the list or any field outside the
  // panel is left where it is.
  const opened = useRef(false);
  useEffect(() => {
    const first = !opened.current;
    opened.current = true;
    const active = document.activeElement;
    const free = active === null || active === document.body || heading.current?.closest("aside")?.contains(active) === true;
    if (!first && !(phase === "done" ? flow.focusResult : free)) return;
    heading.current?.focus();
    const again = window.setTimeout(() => {
      if (document.activeElement === document.body) heading.current?.focus();
    }, 0);
    return () => {
      window.clearTimeout(again);
    };
  }, [phase, flow.focusResult]);

  const close = () => {
    closeSaveAll(session);
    focusMenu();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    close();
  };

  if (plan === null) return null;
  if (phase === "done" && flow.result !== null) {
    const view = flow.result;
    const saved = view.saved.length > 0;
    return (
      <Panel
        title={endTitle(view, plan.files.length)}
        titleRef={heading}
        subtitle={saved ? `In ${view.folder_shown}.` : undefined}
        onClose={close}
        onKeyDown={onKeyDown}
        footer={
          <>
            {saved ? (
              <Button
                onClick={() => {
                  void showSavedFolder(session);
                }}
              >
                Show in Explorer
              </Button>
            ) : null}
            <Button look="pill-main" onClick={close}>
              Done
            </Button>
          </>
        }
      >
        <SaveAllSummary view={view} rows alert />
      </Panel>
    );
  }

  return (
    <Panel title="Saving files" titleRef={heading} onClose={close} onKeyDown={onKeyDown}>
      {job === null ? (
        <p className="note" aria-busy="true">
          Starting…
        </p>
      ) : (
        <JobProgress
          operation={job.operation}
          label="Saving files"
          heading={false}
          sentence={`From ${flow.folder.name}, to ${plan.folder_shown}.`}
          now={nowGoing(plan.files, job.done)}
          warning={KEEP_OPEN}
          stopWord="Stop"
        />
      )}
    </Panel>
  );
}
