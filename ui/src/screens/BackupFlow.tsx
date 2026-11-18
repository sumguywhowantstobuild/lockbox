import { useEffect, useRef, type KeyboardEvent } from "react";
import { formatBytes, leftOutWords } from "../format";
import { focusBack } from "../focus";
import { useJob } from "../jobs";
import { backupNotFinishedMore, BACKUP_NOT_FINISHED, messageFor, messageText } from "../messages";
import { Button } from "../parts/Button";
import { Dialog } from "../parts/Dialog";
import { Figure } from "../parts/Figure";
import { JobProgress, JobStop } from "../parts/JobProgress";
import { Panel } from "../parts/Panel";
import {
  closeBackup,
  lockOneVault,
  putBackupAside,
  seeTheChange,
  startBackup,
  testThisBackup,
  type BackupStep,
  type SessionData,
} from "../store";

// Back up a vault: 22a (where it goes), 22b (progress and Cancel), 22c (saved, and what was left out), 22d (not enough space), and the question
// that stops a backup a made-now copy might not open (Ask 2 and the three beside it). Where the file goes is picked in Windows' own dialog, which
// Rust opens when Back up is pressed, so no path is ever on the page. Every refusal goes through `messageFor`, and the words are the design's.

const KEEP_IT_ELSEWHERE = "Keep it on another drive. A backup on this drive is lost with this drive.";
const KEEP_OPEN = "Keep the laptop open. Windows locking or sleeping cancels this, and nothing half-made is left behind.";

/** 22d's words, from the refusal's two numbers: "Not enough space. This backup needs 1.2 GB, and that drive has 400 MB free." `null` when it did not carry them. */
function noSpaceWords(error: unknown): string | null {
  if (!isNoSpace(error)) return null;
  const { needed, available } = messageFor(error).numbers ?? {};
  if (needed === undefined || available === undefined) return null;
  return `Not enough space. This backup needs ${formatBytes(needed)}, and that drive has ${formatBytes(available)} free.`;
}

function isNoSpace(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { code, kind } = error as { code?: unknown; kind?: unknown };
  return code === "core" && kind === "not_enough_space";
}

/** What the panel is showing, as a key: focus goes to its heading when this changes, so a screen reader reads the new view. */
function viewOf(step: BackupStep | null, running: boolean): string {
  if (step === null) return "ask";
  return step.phase === "running" ? (running ? "running" : "ask") : step.phase;
}

/**
 * The Back up panel (22a to 22d). 22a says whose backup it is and to keep it on another drive; Back up opens Windows' save dialog. While the dialog is
 * open the panel is 22a with its buttons waiting; the bar (22b) comes when the shell says the work started, and its Cancel stops that one job. A drive
 * too small is said under 22a (22d) and the person can try another. A backup that did not finish says nothing half-made was left. Closing the panel
 * while it runs does not stop it.
 */
export function BackupPanel({ data }: { data: SessionData }) {
  const step = data.backup;
  const request = step?.phase === "running" ? step.request : null;
  const job = useJob(request);
  const title = useRef<HTMLHeadingElement>(null);
  const view = viewOf(step, job !== null);
  useEffect(() => {
    title.current?.focus();
  }, [view]);
  const close = () => {
    closeBackup(data.session);
    focusBack("settings");
  };
  const waiting = step?.phase === "running" && job === null;
  // Escape closes the panel, as the other panels do, except while the backup runs: a stray key does not put away a long backup's bar (Cancel and
  // Close panel do).
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape" || event.defaultPrevented || step?.phase === "running") return;
    event.preventDefault();
    close();
  };
  if (step?.phase === "saved") {
    const left = leftOutWords(step.view);
    return (
      <Panel
        title="Backup saved"
        titleRef={title}
        onClose={close}
        onKeyDown={onKeyDown}
        footer={
          <>
            <Button
              onClick={() => {
                testThisBackup(data.session);
              }}
            >
              Test this backup
            </Button>
            <Button look="pill-main" onClick={close}>
              Done
            </Button>
          </>
        }
      >
        <section className="gp">
          <div className="grp">
            <Figure label="Items" value={String(step.view.items)} />
            <Figure label="Files" value={String(step.view.files)} />
            <Figure label="Size" value={formatBytes(step.view.size_on_disk)} />
          </div>
        </section>
        {left === null ? null : <p className="psub">{left}</p>}
      </Panel>
    );
  }
  if (step?.phase === "failed") {
    const more = backupNotFinishedMore(step.error);
    return (
      <Panel
        title="Back up"
        titleRef={title}
        onClose={close}
        onKeyDown={onKeyDown}
        footer={
          <Button look="pill-main" onClick={close}>
            OK
          </Button>
        }
      >
        <p className="psub">{BACKUP_NOT_FINISHED}</p>
        {more === null ? null : <p className="psub">{more}</p>}
      </Panel>
    );
  }
  if (job !== null) {
    // 22b: the bar is Task 2's progress part, named for the vault, with its Cancel in the panel's foot; the figure is the backup's own size.
    return (
      <Panel title="Back up" titleRef={title} onClose={close} onKeyDown={onKeyDown} footer={<JobStop operation={job.operation} />}>
        <JobProgress operation={job.operation} label={`Backing up ${data.name}`} warning={KEEP_OPEN} layout="panel" countsTwice />
      </Panel>
    );
  }
  const error = step?.phase === "ask" ? step.error : null;
  const noSpace = error === null ? null : noSpaceWords(error);
  return (
    <Panel
      title="Back up"
      subtitle={`For ${data.name}.`}
      titleRef={title}
      onClose={close}
      onKeyDown={onKeyDown}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button
            look="pill-main"
            aria-disabled={waiting ? true : undefined}
            onClick={() => {
              if (!waiting) void startBackup(data.session);
            }}
          >
            Back up
          </Button>
        </>
      }
    >
      <p className="psub">{KEEP_IT_ELSEWHERE}</p>
      {error === null ? null : (
        <p className="ferr" role="alert">
          {noSpace ?? messageText(messageFor(error))}
        </p>
      )}
    </Panel>
  );
}

/**
 * Ask 2, and the three beside it: a backup refused before anything was written because one made now might not open. A dialog over the window, named for
 * the vault, with the design's words for which of the four it is. "Not now" puts it away; the safe answer has focus. Ask 2's "See the change" opens Ask
 * 3 for this vault, and "Lock this vault" locks it. The two buttons that would lead to 4C's screens (Change password, New recovery key) are not drawn
 * until those screens exist, so those two ask only "Not now".
 */
export function BackupRefusedAsk({ data }: { data: SessionData }) {
  const step = data.backup;
  const refused = step?.phase === "refused" ? step.error : null;
  const not = useRef<HTMLButtonElement>(null);
  const what = typeof refused === "object" && refused !== null ? (refused as { what?: unknown }).what : undefined;
  return (
    <Dialog
      open={refused !== null}
      onOpenChange={(open) => {
        if (!open) putBackupAside(data.session);
      }}
      title={`Can't back up ${data.name} yet`}
      description={refused === null ? undefined : messageText(messageFor(refused))}
      initialFocus={not}
    >
      <Button
        ref={not}
        onClick={() => {
          putBackupAside(data.session);
        }}
      >
        Not now
      </Button>
      {what === "details changed" ? (
        <Button
          look="pill-main"
          onClick={() => {
            seeTheChange(data.session);
          }}
        >
          See the change
        </Button>
      ) : null}
      {what === "details unchecked" ? (
        <Button
          look="pill-main"
          onClick={() => {
            void lockOneVault(data.session);
          }}
        >
          Lock this vault
        </Button>
      ) : null}
    </Dialog>
  );
}
