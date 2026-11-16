import { useRef, useState } from "react";
import type { FileView, ItemSummary } from "../api";
import { verbs } from "../addFilesWords";
import { formatBytes } from "../format";
import { useJob } from "../jobs";
import { messageText, messageFor } from "../messages";
import { Button } from "../parts/Button";
import { Dialog } from "../parts/Dialog";
import { KindIcon, PlusIcon } from "../parts/Icon";
import { JobProgress } from "../parts/JobProgress";
import { startAddFiles, confirmStoredCopy, openStoredFile, replaceStoredFile, saveStoredFile, type SessionData } from "../store";

// Stored files in an item's panel (10a to 10f, 9d): Open, Save a copy and Replace file on each, and Attach a file on a login, key or note.
// What the buttons do, and what is said when it is done, is the store's (`openStoredFile` and the rest): this file draws the rows, asks
// the two questions the design puts before an action (a program file, and a replace) and says that the vault is working. A file's name
// is shown in the panel, as it is in the list, and in the names of its own buttons; it is never in a message that outlives the panel.

/** The question before opening a program file (10b): the words are the design's. */
export function ProgramQuestion({
  name,
  onNo,
  onYes,
}: {
  /** The file's name, or `null` while there is no question. */
  name: string | null;
  onNo: () => void;
  onYes: () => void;
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  return (
    <Dialog
      open={name !== null}
      onOpenChange={(open) => {
        if (!open) onNo();
      }}
      title="Open a program?"
      description={`${name ?? ""} can run and change things on your PC. Only open it if you trust where it came from.`}
      initialFocus={cancel}
    >
      <Button ref={cancel} onClick={onNo}>
        Cancel
      </Button>
      <Button look="danger" onClick={onYes}>
        Open anyway
      </Button>
    </Dialog>
  );
}

/**
 * The question before a copy goes to a folder a cloud service syncs (21e, as the `.env` file and the recovery key's PDF ask it): the words are
 * the design's. Pick another folder is the safe answer, with the first focus, and asks Windows for a folder again; Continue goes on with the
 * copy the shell parked; Escape writes nothing.
 */
export function CloudCopyQuestion({
  open,
  onAnother,
  onContinue,
  onNo,
}: {
  open: boolean;
  onAnother: () => void;
  onContinue: () => void;
  onNo: () => void;
}) {
  const another = useRef<HTMLButtonElement>(null);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onNo();
      }}
      title="This folder is synced to the cloud"
      description="This file would be uploaded unprotected."
      initialFocus={another}
    >
      <Button onClick={onContinue}>Continue</Button>
      <Button ref={another} look="pill-main" onClick={onAnother}>
        Pick another folder
      </Button>
    </Dialog>
  );
}

/** The warning before a stored file is replaced (10c): the words are the design's. Cancel is the first answer, and has focus. */
function ReplaceQuestion({ name, onNo, onYes }: { name: string | null; onNo: () => void; onYes: () => void }) {
  const cancel = useRef<HTMLButtonElement>(null);
  return (
    <Dialog
      open={name !== null}
      onOpenChange={(open) => {
        if (!open) onNo();
      }}
      title={`Replace ${name ?? ""}?`}
      description="Lockbox will delete the stored file and keep the new one in its place. Backups you already made still hold the old one."
      initialFocus={cancel}
    >
      <Button ref={cancel} onClick={onNo}>
        Cancel
      </Button>
      <Button look="pill-main" onClick={onYes}>
        Choose the new file
      </Button>
    </Dialog>
  );
}

/** A file's type for its tile: the letters after the last dot, in capitals, when there are one to four of them ("PDF"). */
export function typeWord(name: string): string | null {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  const type = name.slice(dot + 1);
  return /^[A-Za-z0-9]{1,4}$/.test(type) ? type.toUpperCase() : null;
}

/**
 * One stored file of an item: its name and size, and Open, Save a copy and Replace file (no Replace in a vault opened from a backup, which
 * can only save a copy and open). While the vault is working on a file the pressed button says so (`aria-busy`) and every file button in
 * the panel is off (`aria-disabled`, so it keeps focus) and sends nothing. A file that did not decrypt shows the words of 10d in place of
 * Open and Save a copy, with no button to a backup (4B's), and keeps Replace file, which is how a good copy goes in.
 */
function FileRow({ data, summary, file }: { data: SessionData; summary: ItemSummary; file: FileView }) {
  const [asking, setAsking] = useState<"program" | "replace" | { cloud: string } | null>(null);
  const openButton = useRef<HTMLButtonElement>(null);
  const saveButton = useRef<HTMLButtonElement>(null);
  const replaceButton = useRef<HTMLButtonElement>(null);
  const { session } = data;
  const job = data.fileJob;
  const mine = job !== null && job.id === summary.id && job.fileId === file.file_id ? job.kind : null;
  const off = job !== null ? true : undefined;
  const refused = data.openItem?.id === summary.id && data.openItem.fileError?.fileId === file.file_id ? data.openItem.fileError : null;
  const goBack = (button: HTMLButtonElement | null) => {
    // The question has closed: focus goes back to the button that asked it, once the dialog has finished giving it away.
    window.setTimeout(() => {
      button?.focus();
    }, 0);
  };

  const open = async () => {
    if (data.fileJob !== null) return;
    if ((await openStoredFile(session, summary.id, file.file_id)) === "asks") setAsking("program");
  };

  /** Save a copy, or the yes to its cloud question (`token`): a cloud-synced folder asks first, and the question is this row's. */
  const save = async (token?: string) => {
    if (data.fileJob !== null) return;
    const result =
      token === undefined
        ? await saveStoredFile(session, summary.id, file.file_id)
        : await confirmStoredCopy(session, summary.id, file.file_id, token);
    if (typeof result === "object") setAsking({ cloud: result.confirm });
  };

  return (
    <div className="frow">
      {/* As drawn (10f): the tile names the file's type ("PDF"); a file with no short type keeps the file picture. */}
      <span className="ftile t1" aria-hidden="true">
        {typeWord(file.name) ?? <KindIcon kind="file" />}
      </span>
      <span className="fmeta">
        <b>{file.name}</b>
        <small>{formatBytes(file.length)}</small>
      </span>
      <div className="fact">
        {refused === null ? (
          <>
            <Button
              ref={openButton}
              className="t"
              aria-label={`${mine === "open" ? "Opening" : "Open"} ${file.name}`}
              aria-disabled={off}
              aria-busy={mine === "open" ? true : undefined}
              onClick={() => {
                void open();
              }}
            >
              {mine === "open" ? "Opening…" : "Open"}
            </Button>
            <Button
              ref={saveButton}
              aria-label={`${mine === "save" ? "Saving a copy of" : "Save a copy of"} ${file.name}`}
              aria-disabled={off}
              aria-busy={mine === "save" ? true : undefined}
              onClick={() => {
                void save();
              }}
            >
              {mine === "save" ? "Saving…" : "Save a copy"}
            </Button>
          </>
        ) : (
          <p className="err" role="alert">
            {messageText(messageFor(refused.error))}
          </p>
        )}
        {data.readOnly ? null : (
          <Button
            ref={replaceButton}
            aria-label={`${mine === "replace" ? "Replacing file" : "Replace file"} ${file.name}`}
            aria-disabled={off}
            aria-busy={mine === "replace" ? true : undefined}
            onClick={() => {
              if (data.fileJob === null) setAsking("replace");
            }}
          >
            {mine === "replace" ? "Replacing…" : "Replace file"}
          </Button>
        )}
      </div>
      <ProgramQuestion
        name={asking === "program" ? file.name : null}
        onNo={() => {
          setAsking(null);
          goBack(openButton.current);
        }}
        onYes={() => {
          setAsking(null);
          void openStoredFile(session, summary.id, file.file_id, true);
        }}
      />
      <CloudCopyQuestion
        open={typeof asking === "object" && asking !== null}
        onAnother={() => {
          setAsking(null);
          void save();
        }}
        onContinue={() => {
          const token = typeof asking === "object" && asking !== null ? asking.cloud : undefined;
          setAsking(null);
          if (token !== undefined) void save(token);
        }}
        onNo={() => {
          setAsking(null);
          goBack(saveButton.current);
        }}
      />
      <ReplaceQuestion
        name={asking === "replace" ? file.name : null}
        onNo={() => {
          setAsking(null);
          goBack(replaceButton.current);
        }}
        onYes={() => {
          setAsking(null);
          void replaceStoredFile(session, summary.id, file.file_id);
        }}
      />
    </div>
  );
}

/** The stored files of a file item, as the rows of its panel. */
export function FileRows({ data, summary }: { data: SessionData; summary: ItemSummary }) {
  return (
    <section className="gp">
      <div className="grp">
        {summary.attachments.map((file) => (
          <FileRow key={file.file_id} data={data} summary={summary} file={file} />
        ))}
      </div>
    </section>
  );
}

/**
 * "Attached files" on a login, key or note (9d): its files with their buttons, and Attach files, which picks one file or many in the Windows
 * picker and lists them in the Add files panel before they go on this item (`AddFiles`). In a vault opened from a backup there is no Attach,
 * and the section shows only when there is a file to open.
 */
export function AttachedFiles({ data, summary }: { data: SessionData; summary: ItemSummary }) {
  const job = data.fileJob;
  const mine = job !== null && job.kind === "attach" && job.id === summary.id;
  if (data.readOnly && summary.attachments.length === 0) return null;
  return (
    <section className="gp">
      <div className="gfh">
        <h3 className="gh">Attached files</h3>
        {data.readOnly ? null : (
          <Button
            aria-disabled={job !== null ? true : undefined}
            aria-busy={mine ? true : undefined}
            onClick={() => {
              if (data.fileJob === null) void startAddFiles(data.session, { type: "item", id: summary.id });
            }}
          >
            {mine ? (
              "Attaching…"
            ) : (
              <>
                <PlusIcon />
                Attach files
              </>
            )}
          </Button>
        )}
      </div>
      {summary.attachments.length === 0 ? null : (
        <div className="grp">
          {summary.attachments.map((file) => (
            <FileRow key={file.file_id} data={data} summary={summary} file={file} />
          ))}
        </div>
      )}
    </section>
  );
}

/** 9b's line about the laptop for a batch of files, as drawn. */
const BATCH_WARNING = "Keep the laptop open. Windows locking or sleeping cancels this, and files not finished aren't added.";

/** What each long operation the shell names is, in the window's words. */
const WORK: Record<string, string> = {
  import: "Adding a file to your vault.",
  save_copy: "Saving a copy of the file.",
  open: "Opening the file.",
};

/** What 9b says for a Save a copy with progress, in the words the session chose (the design is silent beyond the sentence about the laptop). */
const SAVE_CARD = {
  label: "Saving a copy",
  sentence: WORK.save_copy,
  warning: "Keep the laptop open. Windows locking or sleeping cancels this, and a copy not finished isn't saved.",
} as const;

/**
 * 9b outside the Add files panel: the bar, the bytes in words and Cancel, for the Save a copy this vault is working on, or for a batch of
 * files once the person has gone from its panel, once the job has told the page which operation it is (`lockbox://job-started`, matched by the
 * request the page sent). Nothing before that, and nothing for Open or Replace file, which have no progress of their own: 4A's "working" words
 * are all they show. A batch has its bar in the panel while that is on screen (one bar, never two); here it is what can still stop it.
 */
export function FileJobProgress({ data }: { data: SessionData }) {
  const job = useJob(data.fileJob?.request ?? null);
  if (job === null || (job.kind !== "import" && job.kind !== "save_copy")) return null;
  if (data.fileJob?.kind === "add_files") {
    if (data.tool?.kind === "add_files") return null;
    const { doing } = verbs(data.addFiles?.into ?? { type: "folder", collection: null });
    return <JobProgress operation={job.operation} label={`${doing} files`} sentence={`${doing} files to your vault.`} warning={BATCH_WARNING} />;
  }
  return job.kind === "save_copy" ? <JobProgress operation={job.operation} {...SAVE_CARD} /> : null;
}

/**
 * What 5d draws for a long job: while the shell says the vault is working (`lockbox://busy`), the window says what, and why it does not
 * lock for being idle. Windows locking or sleeping still locks, and the words say so. Nothing while no job runs, and a lock takes it with
 * the vault's record. A job that has its own progress card says what it is doing, and the Windows part, there, so only "Auto-lock is waiting
 * until this finishes." is left here.
 */
export function BusyNote({ data }: { data: SessionData }) {
  const card = useJob(data.fileJob?.request ?? null);
  if (data.operations.length === 0) return null;
  const doing =
    card !== null
      ? []
      : data.operations.map((name) => (Object.hasOwn(WORK, name) ? WORK[name] : "Working.")).filter((words, at, all) => all.indexOf(words) === at);
  return (
    <div className="ask" role="status">
      {doing.map((words) => (
        <p key={words}>{words}</p>
      ))}
      {/* A progress card already says the Windows part ("Windows locking or sleeping cancels this"), so it is not said twice. */}
      <p>
        {card !== null
          ? "Auto-lock is waiting until this finishes."
          : "Auto-lock is waiting until this finishes. Windows locking or sleeping still locks your vaults and stops it."}
      </p>
    </div>
  );
}
