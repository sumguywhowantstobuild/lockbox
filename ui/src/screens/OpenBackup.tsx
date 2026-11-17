import { useEffect, useId, useRef, useState, type KeyboardEvent, type SyntheticEvent } from "react";
import type { ItemSummary, SessionRef } from "../api";
import { focusBack } from "../focus";
import { formatBytes } from "../format";
import { useJob, useJobAnnouncement, useJobAnnouncementKey, useLockEpoch } from "../jobs";
import { messageFor, messageText } from "../messages";
import {
  COPY_TO_A_VAULT,
  COPY_WITHOUT_TITLE,
  copyWithoutWords,
  COPYING,
  NOWHERE_TO_COPY,
  OPEN_A_BACKUP,
  PUT_BACK,
  SAY_OPEN,
} from "../openBackupWords";
import { Button } from "../parts/Button";
import { CredentialField } from "../parts/CredentialField";
import { Dialog } from "../parts/Dialog";
import { JobProgress } from "../parts/JobProgress";
import { Panel } from "../parts/Panel";
import { Select } from "../parts/Select";
import { boxWords, fileWords, isAboutTheBox, KEEP_OPEN } from "../restoreWords";
import {
  clearOpenProblem,
  closeOpenBackup,
  copyItemOut,
  pickAnotherOpenBackup,
  runOpenBackup,
  useOpenBackup,
  useSessions,
  type OpenFlow,
  type SessionData,
} from "../store";
import { Frame } from "./setup/Frame";
import { NO_FOLDER } from "./forms/shared";
import { foldersOf } from "./SideMenu";

// Open a backup read-only (25a): the backup is picked first (in Windows' own dialog, which Rust opens; the page only ever has its name and size), then the password or
// recovery key it was made with is typed in one box, and the backup opens as a read-only session of its own. A wrong password keeps the file picked. Begun from a window it is
// that window's panel; begun from the lock screen it is the same steps full-screen on the setup frame, as the restore's are. What is typed is the step's own state: it is
// wiped as it is sent and on every lock epoch. Every refusal goes through `messageFor` or the words of the restore and the test, never an error's own text.

/** The words under the box for a refusal about what was typed, and under the file's row for any other (a damaged backup, a choice the shell let go). */
function problemWords(flow: OpenFlow): { box: string | null; file: string | null } {
  const picked = flow.choice !== null;
  if (flow.problem === null) return { box: null, file: null };
  if (picked && isAboutTheBox(flow.problem)) return { box: boxWords(flow.problem), file: null };
  return { box: null, file: fileWords(flow.problem) };
}

/** What both of the steps share: the typed text (wiped by a lock epoch), the running job, and the send. */
function useSteps(flow: OpenFlow) {
  const [typed, setTyped] = useState("");
  // Every lock epoch (Lock all, an idle lock, Windows locking or sleeping, even when no vault was open) wipes what is typed and hides it again: the box is drawn anew under
  // the epoch's number, so its Show goes back to hidden.
  const epoch = useLockEpoch();
  const [seenEpoch, setSeenEpoch] = useState(epoch);
  if (seenEpoch !== epoch) {
    setSeenEpoch(epoch);
    setTyped("");
  }
  const heading = useRef<HTMLHeadingElement>(null);
  const job = useJob(flow.phase === "opening" ? flow.request : null);
  // Focus goes to the heading as each step comes (the file and box, the bar), so a screen reader reads what the step says.
  const step = flow.phase;
  useEffect(() => {
    heading.current?.focus();
  }, [step]);
  const picked = flow.choice !== null;
  const off = typed === "" || !picked || flow.busy;
  const words = problemWords(flow);
  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    if (off) return;
    // The text goes once, and is gone from here as it goes: the box is empty whatever comes back.
    const text = typed;
    setTyped("");
    void runOpenBackup(text);
  };
  const change = (next: string) => {
    setTyped(next);
    if (flow.problem !== null) clearOpenProblem();
  };
  return { typed, epoch, heading, job, picked, off, words, submit, change, name: flow.fileName ?? "" };
}

/**
 * The Open a backup panel (25a), in the window of the session that began it (an item, Settings or the Save all summary is replaced by it):
 *
 * - **25a:** the picked file (its name and size as text; Pick another), the one box for a password or recovery key, Cancel and Open read-only. A wrong password is said under
 *   the box and the box is empty; the file stays picked. A damaged backup, or a file the shell let go, is said under the row (Pick a backup starts again).
 * - **Opening:** the progress card (`JobProgress`): "Opening <file name>", the bytes and Stop, which stops the open and comes back to 25a.
 *
 * Closing the panel, in any way, stops an open that runs and lets the shell forget the file. When the backup opens, it is the window, and the panel is gone.
 */
export function OpenBackupPanel({ data }: { data: SessionData }) {
  const flow = useOpenBackup();
  if (flow === null || flow.phase === "picking" || flow.host !== data.session) return null;
  return <PanelSteps flow={flow} />;
}

function PanelSteps({ flow }: { flow: OpenFlow }) {
  const formId = useId();
  const { typed, epoch, heading, job, picked, off, words, submit, change, name } = useSteps(flow);
  const close = () => {
    closeOpenBackup();
    focusBack("settings");
  };
  // Escape closes the panel, except while the open runs: a stray key does not stop a long open (Stop and Close panel do).
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape" || event.defaultPrevented || flow.phase === "opening") return;
    close();
  };
  if (flow.phase === "opening") {
    return (
      <Panel title={OPEN_A_BACKUP} titleRef={heading} onClose={close} onKeyDown={onKeyDown}>
        {job === null ? (
          <p className="note" aria-busy="true">
            Starting…
          </p>
        ) : (
          <JobProgress operation={job.operation} label={`Opening ${name}`} warning={KEEP_OPEN} stopWord="Stop" />
        )}
      </Panel>
    );
  }
  return (
    <Panel
      title={OPEN_A_BACKUP}
      titleRef={heading}
      onClose={close}
      onKeyDown={onKeyDown}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button look="pill-main" type="submit" form={formId} aria-disabled={off ? true : undefined}>
            Open read-only
          </Button>
        </>
      }
    >
      <section className="gp">
        <div className="grp">
          <div className="frow">
            {picked ? (
              <>
                <span className="ftile" aria-hidden="true">
                  BAK
                </span>
                <span className="fmeta">
                  <b>{name}</b>
                  <small>{formatBytes(flow.size)}</small>
                </span>
              </>
            ) : (
              <span className="fmeta">
                <b>No backup picked.</b>
              </span>
            )}
            <Button
              aria-disabled={flow.busy ? true : undefined}
              onClick={() => {
                if (!flow.busy) void pickAnotherOpenBackup();
              }}
            >
              {picked ? "Pick another" : "Pick a backup"}
            </Button>
          </div>
        </div>
      </section>
      {words.file === null ? null : (
        <p className="ferr" role="alert">
          {words.file}
        </p>
      )}
      <form id={formId} onSubmit={submit} noValidate>
        <CredentialField key={epoch} label="Password or recovery key from when it was made" value={typed} onChange={change} error={words.box} />
      </form>
    </Panel>
  );
}

/**
 * The lock screen's Open a backup: the same steps, full-screen on the setup frame, as the restore's are (nothing is open to hold a panel). Nothing while no such flow is
 * begun, and while Windows' picker is still open.
 */
export function OpenBackupSteps() {
  const flow = useOpenBackup();
  if (flow === null || flow.phase === "picking" || flow.host !== null) return null;
  return <FullSteps flow={flow} />;
}

function FullSteps({ flow }: { flow: OpenFlow }) {
  const backupId = useId();
  const { typed, epoch, heading, job, picked, off, words, submit, change, name } = useSteps(flow);
  // The screens have no message stack, so a polite place of their own says the bar's start.
  const announcement = useJobAnnouncement();
  const announcementKey = useJobAnnouncementKey();
  let steps;
  if (flow.phase === "opening") {
    steps = (
      <div className="fu">
        <h1 ref={heading} tabIndex={-1}>{`Opening ${name}`}</h1>
        {job === null ? (
          <p className="fu-hint" aria-busy="true">
            Starting…
          </p>
        ) : (
          <JobProgress operation={job.operation} label={`Opening ${name}`} heading={false} warning={KEEP_OPEN} stopWord="Stop" />
        )}
      </div>
    );
  } else {
    steps = (
      <form className="fu" onSubmit={submit} noValidate>
        <h1 ref={heading} tabIndex={-1}>
          {OPEN_A_BACKUP}
        </h1>
        <div role="group" aria-labelledby={backupId}>
          <span className="fu-lab" id={backupId}>
            Backup
          </span>
          <div className="fu-row">
            <span className="fu-hint fu-where">{picked ? `${name}, ${formatBytes(flow.size)}` : "No backup picked."}</span>
            <button
              type="button"
              className="lnk"
              disabled={flow.busy}
              onClick={() => {
                void pickAnotherOpenBackup();
              }}
            >
              {picked ? "Pick another" : "Pick a backup"}
            </button>
          </div>
          {words.file === null ? null : (
            <p className="err" role="alert">
              {words.file}
            </p>
          )}
        </div>
        <div>
          <CredentialField key={epoch} label="Password or recovery key from when it was made" value={typed} onChange={change} error={words.box} />
          <p className="fu-hint">If it&apos;s wrong, you can try again without picking the file again.</p>
        </div>
        <div className="fu-row">
          <button type="submit" className="prim" aria-disabled={off ? true : undefined}>
            Open read-only
          </button>
          <button type="button" className="lnk" onClick={closeOpenBackup}>
            Cancel
          </button>
        </div>
      </form>
    );
  }
  return (
    <>
      <Frame say={SAY_OPEN}>{steps}</Frame>
      {/* Always on the page, so a change in it is spoken: the message stack that says these things in the main window is not here. */}
      <div role="status" className="live">
        <span className="sr" key={announcementKey}>
          {announcement}
        </span>
      </div>
    </>
  );
}

/** What one copy is: out of this session (at this generation), this item, into this vault's folder. A question is asked about exactly this, and answered with exactly this. */
interface Copying {
  from: SessionRef;
  id: string;
  vault: number;
  folder: string | null;
}

/**
 * Copy to a vault (25b, 25c, 25d), in the item's panel of a read-only session (a backup or an older copy): the sentence, the button, and under it an inline form: **Vault** (each
 * unlocked writable session by name, the most recently unlocked first and chosen) and **Folder** (that vault's live folders, then No folder; the folder named as the item's folder
 * here is chosen when the vault has one, else No folder). Copy sends the item to that vault and folder; the window stays on this session. When the backup lacks files attached to
 * the item, 25d asks first, and Copy without them sends it again. With no such vault open, the form says to unlock one first.
 */
export function CopyToVault({ data, summary, folderNames }: { data: SessionData; summary: ItemSummary; folderNames: ReadonlyMap<string, string> }) {
  const sessions = useSessions();
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const askCancel = useRef<HTMLButtonElement>(null);
  const formId = useId();
  // What the person chose; what is not chosen follows the defaults, so a vault that locks meanwhile moves the choice to the next.
  const [picked, setPicked] = useState<{ vault: string | null; folder: string | null }>({ vault: null, folder: null });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // 25d's question, with the session (and generation), item, vault and folder it was asked about: Copy without them goes with those, never with whatever is on screen or in the form
  // by then (a vault may lock meanwhile, and another session's window may be up).
  const [asking, setAsking] = useState<(Copying & { names: readonly string[] }) | null>(null);
  // Which session, generation and item this panel is for now, read when an answer comes: an answer for any other is dropped (the panel is keyed by them, so it is its own).
  const here_ = useRef({ session: data.session, generation: data.generation, id: summary.id });
  useEffect(() => {
    here_.current = { session: data.session, generation: data.generation, id: summary.id };
  }, [data.session, data.generation, summary.id]);

  const targets = sessions.filter((entry) => !entry.readOnly).sort((a, b) => b.opened - a.opened);
  const vault = targets.find((entry) => String(entry.session) === picked.vault) ?? targets[0];
  const folders = vault === undefined ? [] : foldersOf(vault.items ?? []);
  // The folder with the same name as this item's folder here, else none.
  const here = summary.collection === null ? undefined : folderNames.get(summary.collection);
  const same = here === undefined ? undefined : folders.find((folder) => folder.name === here);
  const folder = picked.folder !== null && (picked.folder === NO_FOLDER || folders.some((entry) => entry.id === picked.folder)) ? picked.folder : (same?.id ?? NO_FOLDER);

  const close = () => {
    setOpen(false);
    setProblem(null);
    setAsking(null);
    setPicked({ vault: null, folder: null });
    window.setTimeout(() => {
      opener.current?.focus();
    }, 0);
  };
  const send = async (skipMissing: boolean, copying: Copying | undefined) => {
    if (copying === undefined || busy) return;
    setBusy(true);
    setProblem(null);
    const result = await copyItemOut(copying.from, copying.id, copying.vault, copying.folder, skipMissing);
    setBusy(false);
    // An answer for another session, generation or item than this panel's now (or for a session that locked) opens nothing and says nothing.
    const now = here_.current;
    if (result === "stale" || copying.from.session !== now.session || copying.from.generation !== now.generation || copying.id !== now.id) return;
    if ("done" in result) close();
    else if ("missing" in result) setAsking({ ...copying, names: result.missing });
    else setProblem(messageText(messageFor(result.refused)));
  };
  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    if (vault === undefined) return;
    void send(false, {
      from: { session: data.session, generation: data.generation },
      id: summary.id,
      vault: vault.session,
      folder: folder === NO_FOLDER ? null : folder,
    });
  };

  return (
    <section className="gp">
      <div className="grp">
        <div className="frow">
          <span className="fmeta">
            <b>{PUT_BACK}</b>
          </span>
          <Button
            ref={opener}
            look="pill-main"
            aria-expanded={open}
            aria-controls={open ? formId : undefined}
            // While a copy is sent there is no Stop for it (the shell gives none), so the form stays until it answers.
            aria-disabled={busy ? true : undefined}
            onClick={() => {
              if (busy) return;
              if (open) close();
              else setOpen(true);
            }}
          >
            {COPY_TO_A_VAULT}
          </Button>
        </div>
        {!open ? null : vault === undefined ? (
          <div id={formId} className="fld col" role="group" aria-label={COPY_TO_A_VAULT}>
            <p className="fhint">{NOWHERE_TO_COPY}</p>
            <div className="fact">
              <Button onClick={close}>Cancel</Button>
            </div>
          </div>
        ) : (
          <form id={formId} className="fld col" aria-label={COPY_TO_A_VAULT} onSubmit={submit} noValidate>
            <div className="fbox">
              <Select
                label="Vault"
                items={targets.map((entry) => ({ value: String(entry.session), label: entry.name }))}
                value={String(vault.session)}
                onValueChange={(next) => {
                  setPicked({ vault: next, folder: null });
                }}
              />
            </div>
            <div className="fbox">
              <Select
                label="Folder"
                items={[...folders.map((entry) => ({ value: entry.id, label: entry.name })), { value: NO_FOLDER, label: "No folder" }]}
                value={folder}
                onValueChange={(next) => {
                  setPicked((now) => ({ ...now, folder: next }));
                }}
              />
            </div>
            {problem === null ? null : (
              <p className="ferr" role="alert">
                {problem}
              </p>
            )}
            {busy ? (
              <p className="fhint" role="status">
                {COPYING}
              </p>
            ) : null}
            <div className="fact">
              <Button
                aria-disabled={busy ? true : undefined}
                onClick={() => {
                  if (!busy) close();
                }}
              >
                Cancel
              </Button>
              <Button look="pill-main" type="submit" aria-disabled={busy ? true : undefined}>
                Copy
              </Button>
            </div>
          </form>
        )}
      </div>
      <Dialog
        open={asking !== null}
        onOpenChange={(next) => {
          if (!next) setAsking(null);
        }}
        title={COPY_WITHOUT_TITLE}
        description={copyWithoutWords(asking?.names ?? [], summary.kind)}
        initialFocus={askCancel}
      >
        <Button
          ref={askCancel}
          onClick={() => {
            setAsking(null);
          }}
        >
          Cancel
        </Button>
        <Button
          look="pill-main"
          onClick={() => {
            const asked = asking;
            setAsking(null);
            void send(true, asked === null ? undefined : { from: asked.from, id: asked.id, vault: asked.vault, folder: asked.folder });
          }}
        >
          Copy without them
        </Button>
      </Dialog>
    </section>
  );
}
