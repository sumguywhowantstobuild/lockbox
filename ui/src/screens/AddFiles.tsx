import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { AddFilesView, AddInto, PickedFile } from "../api";
import { endTitle, filesWords, KEEP_THE_LISTED, originalsStay, refusalWords, stoppedWords, verbs, wasClean } from "../addFilesWords";
import { focusBack } from "../focus";
import { formatBytes } from "../format";
import { useJob } from "../jobs";
import { Button } from "../parts/Button";
import { CloseIcon, KindIcon, PlusIcon } from "../parts/Icon";
import { JobProgress, JobStop } from "../parts/JobProgress";
import { Panel } from "../parts/Panel";
import { Select } from "../parts/Select";
import { closeAddFiles, leaveOutPickedFile, pickMoreFiles, runAddFiles, type AddFilesFlow, type SessionData } from "../store";
import { typeWord } from "./FileActions";
import { folderChoices, NO_FOLDER } from "./forms/shared";
import type { FolderEntry } from "./SideMenu";

// Many files in (Plan 4B Task 10), as drawn in 9a to 9e: one panel from the picked list to the end. The page holds names and sizes (the paths
// stay in Rust) and the choice they wait under; what is sent is the choice, a number to leave a file out, and where the batch goes.

/** 9b's line about the laptop, as drawn. */
const KEEP_OPEN = "Keep the laptop open. Windows locking or sleeping cancels this, and files not finished aren't added.";

/** The file going in now and its place in the batch ("2 of 3"), worked out from the bytes done against the sizes the page holds. */
export function nowGoing(files: readonly PickedFile[], done: number): { name: string; place: string } | null {
  if (files.length === 0) return null;
  let end = 0;
  let at = files.length - 1;
  for (const [index, file] of files.entries()) {
    end += file.size;
    if (done < end) {
      at = index;
      break;
    }
  }
  return { name: files[at]?.name ?? "", place: `${String(at + 1)} of ${String(files.length)}` };
}

/** The lists under 9c's heading: what could not be read, what was never tried, why it stopped, and the two sentences that keep an original safe. */
function AddFilesSummary({ view, into }: { view: AddFilesView; into: AddInto }) {
  const reason = stoppedWords(view.stopped);
  const left = view.failed.length > 0 || view.not_added.length > 0;
  const { done } = verbs(into);
  return (
    <>
      {reason === null ? null : <p className={view.stopped?.code === "cancelled" ? "psub" : "ferr"}>{reason}</p>}
      {view.failed.length === 0 ? null : (
        <div className="sumlist">
          <p className="gh">These files couldn&apos;t be read:</p>
          <ul className="names">
            {view.failed.map((name, at) => (
              <li key={`${String(at)}:${name}`}>{name}</li>
            ))}
          </ul>
        </div>
      )}
      {view.not_added.length === 0 ? null : (
        <div className="sumlist">
          <p className="gh">{`These files were not ${done}:`}</p>
          <ul className="names">
            {view.not_added.map((name, at) => (
              <li key={`${String(at)}:${name}`}>{name}</li>
            ))}
          </ul>
        </div>
      )}
      {left && view.added > 0 ? <p className="fwarn">{KEEP_THE_LISTED}</p> : null}
      {view.added > 0 ? <p className="fwarn">{originalsStay(view.added)}</p> : null}
    </>
  );
}

/**
 * What 9c's end says to a person who has gone to another item while the batch worked and it left something out: a card in the list's column
 * that names each file that did not go in, so no original is deleted for a file that was never stored. A batch that went in whole says so in a
 * message instead. Dismiss puts it away.
 */
export function AddFilesLeft({ data }: { data: SessionData }) {
  const flow = data.addFiles;
  if (flow === null || flow.phase !== "done" || flow.result === null || data.tool?.kind === "add_files" || wasClean(flow.result)) return null;
  const title = endTitle(flow.result, flow.files.length, flow.into);
  return (
    <section className="ask away" aria-label={title}>
      <p className="jt">{title}</p>
      <AddFilesSummary view={flow.result} into={flow.into} />
      <div className="ask-acts">
        <Button
          onClick={() => {
            closeAddFiles(data.session);
          }}
        >
          Dismiss
        </Button>
      </div>
    </section>
  );
}

/**
 * The Add files panel (9a, 9b, 9c, 9e) for Add, then File, and for Attach files on an item. Its title and body follow the batch:
 *
 * - **Picked (9a, 9e):** how many files and how big, each with a button to leave it out, Pick more, the folder they go into (not for an item,
 *   which they are attached to), Cancel and Add N files. A refusal before the batch starts (no room for the whole of it, a file over 256 GB, a
 *   choice that expired) is said under the list with its numbers, and for the two about size Add is off until the list changes.
 * - **Adding (9b):** one bar for the whole batch (`JobProgress`): the file now going in and "2 of 3", the bytes, the sentence about the laptop,
 *   and Cancel. The panel's own Close lets the batch carry on, with its bar in the list's column.
 * - **Done (9c):** how many went in, every file that did not (named), and the sentence that the originals are still on the PC.
 *
 * Focus is on the panel's heading when it opens, and when the batch changes phase if focus was in the panel's own place, so what it says is read;
 * focus the person put elsewhere (the list's filter) stays there, and the store says the end in the page's spoken place instead.
 */
export function AddFiles({ data, folders }: { data: SessionData; folders: readonly FolderEntry[] }) {
  const flow = data.addFiles;
  if (flow === null) return null;
  return <AddFilesPanel data={data} folders={folders} flow={flow} />;
}

function AddFilesPanel({ data, folders, flow }: { data: SessionData; folders: readonly FolderEntry[]; flow: AddFilesFlow }) {
  const { session } = data;
  const { into, files, phase } = flow;
  const verb = verbs(into);
  const [folder, setFolder] = useState(into.type === "folder" ? (into.collection ?? NO_FOLDER) : NO_FOLDER);
  const [focusAfter, setFocusAfter] = useState<{ index: number } | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const pick = useRef<HTMLButtonElement>(null);
  const leaveButtons = useRef(new Map<number, HTMLButtonElement>());
  const job = useJob(phase === "adding" && data.fileJob?.kind === "add_files" ? data.fileJob.request : null);

  // The heading takes focus when the panel opens, and as a later phase begins when focus is the panel's to give: the end takes it only if focus was
  // in this batch's own panel or bar as it ended (decided by the store, while the bar was still there); the other phases, if focus is in the panel
  // or on nothing (the button that was pressed has gone). Focus in the filter, the list or any field outside the panel is left where it is.
  const opened = useRef(false);
  useEffect(() => {
    const first = !opened.current;
    opened.current = true;
    const active = document.activeElement;
    const free = active === null || active === document.body || heading.current?.closest("aside")?.contains(active) === true;
    if (!first && !(phase === "done" ? flow.focusResult : free)) return;
    heading.current?.focus();
    const again = window.setTimeout(() => {
      if (document.activeElement === document.body || document.activeElement?.closest(".addb") != null) heading.current?.focus();
    }, 0);
    return () => {
      window.clearTimeout(again);
    };
  }, [phase, flow.focusResult]);

  // A file left out: focus goes to the next file's button (the one now at that place), or the last, or Pick more when none is left.
  useEffect(() => {
    if (focusAfter === null) return;
    const at = Math.min(focusAfter.index, files.length - 1);
    (leaveButtons.current.get(at) ?? pick.current)?.focus();
  }, [focusAfter, files]);

  const itemTitle = into.type === "item" ? (data.items?.find((entry) => entry.id === into.id)?.title ?? "this item") : null;
  const folderName = into.type === "folder" && into.collection !== null ? folders.find((entry) => entry.id === into.collection)?.name : undefined;
  const where = itemTitle !== null ? itemTitle : folderName;
  const target = (): AddInto => (into.type === "item" ? into : { type: "folder", collection: folder === NO_FOLDER ? null : folder });

  const close = () => {
    closeAddFiles(session);
    if (into.type === "folder") focusBack("add");
  };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    // Escape in the folder list (or any list or menu opened from here) closes that and nothing more.
    const from = event.target instanceof Element ? event.target : null;
    if (from?.closest('[role="listbox"], [role="menu"], [aria-expanded="true"]') != null) return;
    close();
  };

  // ---- 9c: the end ----
  if (phase === "done" && flow.result !== null) {
    const view = flow.result;
    const place = into.type === "item" ? `On ${itemTitle ?? "this item"}.` : `In ${folderName ?? data.name}.`;
    return (
      <Panel
        title={endTitle(view, files.length, into)}
        titleRef={heading}
        subtitle={view.added > 0 ? place : undefined}
        onClose={close}
        onKeyDown={onKeyDown}
        footer={
          <Button look="pill-main" onClick={close}>
            Done
          </Button>
        }
      >
        <AddFilesSummary view={view} into={into} />
      </Panel>
    );
  }

  // ---- 9b: one bar for the batch ----
  if (phase === "adding") {
    const place = where === undefined ? data.name : `${where}, in ${data.name}`;
    return (
      <Panel
        title={`${verb.doing} files`}
        titleRef={heading}
        onClose={close}
        onKeyDown={onKeyDown}
        footer={job === null ? undefined : <JobStop operation={job.operation} />}
      >
        {job === null ? (
          <p className="note" aria-busy="true">
            Starting…
          </p>
        ) : (
          <JobProgress
            operation={job.operation}
            label={`${verb.doing} files`}
            heading={false}
            sentence={`${verb.doing} to ${place}.`}
            now={nowGoing(files, job.done)}
            warning={KEEP_OPEN}
            layout="panel"
          />
        )}
      </Panel>
    );
  }

  // ---- 9a, 9e: the picked list ----
  const refusal = flow.problem === null ? null : refusalWords(flow.problem, files);
  const total = files.reduce((sum, file) => sum + file.size, 0);
  const sub =
    files.length === 0
      ? "No files picked."
      : `${filesWords(files.length)} picked, ${formatBytes(total)}.${itemTitle !== null ? ` They're attached to ${itemTitle}.` : ` They go into ${data.name}.`}`;
  const off = files.length === 0 || flow.busy || flow.choice === null || refusal?.size === true;
  return (
    <Panel
      title={`${verb.action} files`}
      titleRef={heading}
      subtitle={sub}
      onClose={close}
      onKeyDown={onKeyDown}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button
            look="pill-main"
            aria-disabled={off ? true : undefined}
            onClick={() => {
              if (!off) void runAddFiles(session, target());
            }}
          >
            {`${verb.action} ${filesWords(files.length)}`}
          </Button>
        </>
      }
    >
      {files.length === 0 ? null : (
        <section className="gp">
          <ul className="grp erows">
            {files.map((file, index) => (
              <li key={`${String(index)}:${file.name}`} className="erow pf">
                <span className="ftile" aria-hidden="true">
                  {typeWord(file.name) ?? <KindIcon kind="file" />}
                </span>
                <span className="en">{file.name}</span>
                <span className="ed">{formatBytes(file.size)}</span>
                <button
                  type="button"
                  className="ex"
                  aria-label={`Leave out ${file.name}`}
                  aria-disabled={flow.busy ? true : undefined}
                  ref={(button) => {
                    if (button === null) leaveButtons.current.delete(index);
                    else leaveButtons.current.set(index, button);
                  }}
                  onClick={() => {
                    if (flow.busy) return;
                    setFocusAfter({ index });
                    void leaveOutPickedFile(session, index);
                  }}
                >
                  <CloseIcon />
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {refusal === null ? null : (
        <p className="ferr" role="alert">
          {refusal.text}
        </p>
      )}
      <div className="le-a">
        <Button
          ref={pick}
          aria-disabled={flow.busy ? true : undefined}
          onClick={() => {
            if (!flow.busy) void pickMoreFiles(session);
          }}
        >
          {files.length === 0 ? (
            "Pick files"
          ) : (
            <>
              <PlusIcon />
              Pick more
            </>
          )}
        </Button>
      </div>
      {into.type === "folder" ? (
        <div className="fbox">
          <Select label="Folder" items={folderChoices(folders, data.folder)} value={folder} onValueChange={setFolder} />
        </div>
      ) : null}
    </Panel>
  );
}
