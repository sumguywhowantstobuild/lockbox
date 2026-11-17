import { useEffect, useId, useRef, useState, type SyntheticEvent } from "react";
import { focusBack } from "../focus";
import { formatBytes } from "../format";
import { useJob, useJobAnnouncement, useJobAnnouncementKey, useLockEpoch } from "../jobs";
import { messageFor, messageText } from "../messages";
import { Button } from "../parts/Button";
import { CredentialField } from "../parts/CredentialField";
import { Dialog } from "../parts/Dialog";
import { JobProgress } from "../parts/JobProgress";
import { PasswordField } from "../parts/PasswordField";
import {
  answerRestoreQuestion,
  backToRestoreFile,
  backToRestoreFolder,
  checkRestore,
  chooseRestoreFolder,
  clearRestoreProblem,
  closeRestore,
  pickAnotherRestore,
  replaceRestore,
  runRestore,
  unlockRestored,
  useRestore,
  type RestoreFlow as Flow,
} from "../store";
import {
  boxWords,
  fileWords,
  isAboutTheBox,
  isTooManyOlderCopies,
  keptWords,
  KEEP_OPEN,
  passwordFromWords,
  refusalWords,
  SAY_RESTORE,
  WAITS,
  whereWords,
} from "../restoreWords";
import { Frame } from "./setup/Frame";

// Restore a backup (24a to 24e). Full-screen steps on the first-use screens' two-sided frame, shown by the app above whatever else it would show: the
// restore belongs to the app and not to a vault, so a lock of the open vault (or the swap closing the vault it replaces) does not take it away. The
// backup is picked first (in Windows' own dialog, which Rust opens); the password or recovery key it was made with is typed in one box and sent once; the
// shell keeps it. Every refusal goes through `messageFor` or the words of `restoreWords.ts`, and the screens never show an error's own text.

/** Which screen the flow is on, as a key: focus goes to its heading when this changes, so a screen reader reads the new step. */
function viewOf(flow: Flow): string {
  switch (flow.phase) {
    case "pick":
    case "checking":
      return "file";
    case "where":
    case "cloud":
    case "name":
      return "where";
    default:
      return flow.phase;
  }
}

/**
 * The restore's steps, or nothing while no restore is begun (and while Windows' picker is still open, when there is no step yet):
 *
 * - **24a:** the picked file (its name and size as text; Pick another), the one box for a password or recovery key, Continue and Cancel. A wrong password is
 *   said under the box and the box is empty; the file stays picked. Any other refusal about the file is said under its row, and a file the shell let go
 *   (a lock, five minutes) is "No backup picked" with Pick a backup.
 * - **24b:** the name it unpacks as and the folder as text, Choose another, Restore and Back. A cloud-synced folder, and a folder the shell can't tell apart
 *   from another vault, ask first.
 * - **24c:** the bar and its Cancel, until the swap; then "Putting it in place", with no bar and no Cancel. **24d:** the question, when a vault is replaced.
 * - **24e:** the restored vault's own password, and Unlock.
 * - A refusal of the copy or the swap is a screen of its own with the design's words.
 *
 * What is typed is this screen's own state: it is wiped as it is sent, and on every lock epoch. The screens have no message stack, so a polite place of
 * their own says the bar's start, the swap, the end and the refusals.
 */
export function RestoreFlow() {
  const flow = useRestore();
  if (flow === null || flow.phase === "picking") return null;
  return <Steps flow={flow} />;
}

function Steps({ flow }: { flow: Flow }) {
  const [typed, setTyped] = useState("");
  const [unlocking, setUnlocking] = useState(false);
  const [unlockProblem, setUnlockProblem] = useState<string | null>(null);
  // Every lock epoch (Lock all, an idle lock, Windows locking or sleeping) wipes what is typed, and the box is drawn anew so its Show goes back to hidden.
  const epoch = useLockEpoch();
  const [seenEpoch, setSeenEpoch] = useState(epoch);
  if (seenEpoch !== epoch) {
    setSeenEpoch(epoch);
    setTyped("");
    setUnlockProblem(null);
  }
  const heading = useRef<HTMLHeadingElement>(null);
  const backupId = useId();
  const job = useJob(flow.phase === "copying" ? flow.request : null);
  const announcement = useJobAnnouncement();
  const announcementKey = useJobAnnouncementKey();
  const view = viewOf(flow);
  // What is typed belongs to the step it was typed at, and to one try: it goes when the flow moves to another screen, and when the check answers (whatever it
  // says), so nothing typed for the backup is ever offered again on a later step, 24e's password box above all. It starts empty each time.
  const checking = flow.phase === "checking";
  const [seenView, setSeenView] = useState(view);
  const [wasChecking, setWasChecking] = useState(checking);
  if (seenView !== view || wasChecking !== checking) {
    setSeenView(view);
    setWasChecking(checking);
    setTyped("");
    setUnlockProblem(null);
  }
  useEffect(() => {
    heading.current?.focus();
  }, [view]);

  // Once the copy has answered, the name is the one it gave (the archive it actually opened), never the one the check found.
  const name = flow.prepared?.name ?? flow.checked?.name ?? "";
  const cancel = () => {
    closeRestore();
    focusBack("settings");
  };

  let steps;
  if (view === "file") {
    const picked = flow.choice !== null;
    const off = typed === "" || !picked || flow.busy || flow.phase === "checking";
    // What the last try was refused with: about the box (a wrong password), or about the file (a damaged backup, one the shell let go, another restore going).
    const aboutTheBox = picked && isAboutTheBox(flow.problem) ? boxWords(flow.problem) : null;
    const aboutTheFile = flow.problem !== null && aboutTheBox === null ? fileWords(flow.problem) : null;
    const submit = (event: SyntheticEvent) => {
      event.preventDefault();
      if (off) return;
      // The text goes once, and is gone from here as it goes: the box is empty whatever comes back.
      const text = typed;
      setTyped("");
      void checkRestore(text);
    };
    steps = (
      <form className="fu" onSubmit={submit} noValidate>
        <h1 ref={heading} tabIndex={-1}>
          Restore a backup
        </h1>
        <div role="group" aria-labelledby={backupId}>
          <span className="fu-lab" id={backupId}>
            Backup
          </span>
          <div className="fu-row">
            <span className="fu-hint fu-where">{picked ? `${flow.fileName ?? ""}, ${formatBytes(flow.size)}` : "No backup picked."}</span>
            <button
              type="button"
              className="lnk"
              disabled={flow.busy || flow.phase === "checking"}
              onClick={() => {
                void pickAnotherRestore();
              }}
            >
              {picked ? "Pick another" : "Pick a backup"}
            </button>
          </div>
          {aboutTheFile === null ? null : (
            <p className="err" role="alert">
              {aboutTheFile}
            </p>
          )}
        </div>
        <div>
          <CredentialField
            key={epoch}
            label="Password or recovery key from when it was made"
            value={typed}
            readOnly={flow.phase === "checking"}
            onChange={(next) => {
              setTyped(next);
              if (isAboutTheBox(flow.problem)) clearRestoreProblem();
            }}
            error={aboutTheBox}
          />
          <p className="fu-hint">If it&apos;s wrong, you can try again without picking the file again.</p>
        </div>
        <div className="fu-row">
          <button type="submit" className="prim" aria-disabled={off ? true : undefined}>
            Continue
          </button>
          <button type="button" className="lnk" onClick={cancel}>
            Cancel
          </button>
        </div>
      </form>
    );
  } else if (view === "where") {
    const checked = flow.checked;
    steps = (
      <div className="fu">
        <h1 ref={heading} tabIndex={-1}>
          Where it goes
        </h1>
        <p className="fu-sub">{whereWords(name, checked?.usual ?? true, checked?.replaces_existing ?? false)}</p>
        <div className="fu-row">
          <span className="fu-hint fu-where">{checked?.folder_shown ?? ""}</span>
          <button
            type="button"
            className="lnk"
            disabled={flow.busy}
            onClick={() => {
              void chooseRestoreFolder();
            }}
          >
            Choose another
          </button>
        </div>
        {flow.problem === null ? null : (
          <p className="err" role="alert">
            {refusalWords(flow.problem)}
          </p>
        )}
        <div className="fu-row">
          <button
            type="button"
            className="prim"
            aria-disabled={flow.busy ? true : undefined}
            onClick={() => {
              if (!flow.busy) void runRestore();
            }}
          >
            Restore
          </button>
          <button type="button" className="lnk" disabled={flow.busy} onClick={backToRestoreFile}>
            Back
          </button>
        </div>
        <CloudQuestion open={flow.phase === "cloud"} />
        {flow.phase === "name" ? <NameQuestion key={flow.token ?? ""} suggested={flow.suggested} /> : null}
      </div>
    );
  } else if (view === "copying") {
    steps = (
      <div className="fu">
        <h1 ref={heading} tabIndex={-1}>{`Restoring ${name}`}</h1>
        {job === null ? (
          <p className="fu-hint" aria-busy="true">
            Starting…
          </p>
        ) : (
          <JobProgress operation={job.operation} label="Checking and unpacking" warning={KEEP_OPEN} figures="percent" />
        )}
      </div>
    );
  } else if (view === "swapping") {
    // Past the point of cancelling: no bar to read a figure from and no Cancel, only that it is happening.
    steps = (
      <div className="fu">
        <h1 ref={heading} tabIndex={-1}>{`Restoring ${name}`}</h1>
        <p className="fu-hint" aria-busy="true">
          Putting it in place
        </p>
      </div>
    );
  } else if (view === "replace") {
    steps = (
      <div className="fu">
        <h1 ref={heading} tabIndex={-1}>
          Replace your vault with this?
        </h1>
        <p className="fu-sub">{keptWords(name, flow.prepared?.kept_as ?? null)}</p>
        <p className="fu-hint fu-where">{WAITS}</p>
        <div className="fu-row">
          <button type="button" className="prim" onClick={replaceRestore}>
            Replace
          </button>
          <button type="button" className="lnk" onClick={cancel}>
            Cancel
          </button>
        </div>
      </div>
    );
  } else if (view === "refused") {
    // A refusal of the copy: OK goes back to 24b with the pick kept. A refusal of the swap leaves a finished copy that can only be let go.
    const again = flow.refusedAs === "again" && !isTooManyOlderCopies(flow.problem);
    steps = (
      <div className="fu">
        <h1 ref={heading} tabIndex={-1}>
          This restore can&apos;t go ahead
        </h1>
        <p className="fu-sub strong">{refusalWords(flow.problem)}</p>
        <div className="fu-row">
          {again ? (
            <button type="button" className="prim" onClick={backToRestoreFolder}>
              OK
            </button>
          ) : (
            <button type="button" className="prim" onClick={cancel}>
              Cancel
            </button>
          )}
        </div>
      </div>
    );
  } else {
    const unlock = async (event: SyntheticEvent) => {
      event.preventDefault();
      if (typed === "" || unlocking) return;
      setUnlocking(true);
      setUnlockProblem(null);
      try {
        const result = await unlockRestored(typed);
        // The vault is open (or locked again already): the password has done its work.
        if (result === "opened") setTyped("");
      } catch (refusal) {
        setUnlockProblem(messageText(messageFor(refusal)));
      } finally {
        setUnlocking(false);
      }
    };
    steps = (
      <form className="fu" onSubmit={(event) => void unlock(event)} noValidate>
        <h1 ref={heading} tabIndex={-1}>{`${name} is restored`}</h1>
        <p className="fu-sub">Unlock it with the password from when this backup was made, not the one you use today.</p>
        <PasswordField
          key={epoch}
          label={passwordFromWords(flow.checked?.made ?? null)}
          value={typed}
          onChange={(next) => {
            setTyped(next);
            setUnlockProblem(null);
          }}
          error={unlockProblem}
        />
        <div className="fu-row">
          <button type="submit" className="prim" disabled={unlocking || typed === ""}>
            Unlock
          </button>
        </div>
      </form>
    );
  }

  // What the polite place says besides the bar's start: the swap, the end, and a refusal's words (the refusal's heading takes focus; its words are said here).
  let said = "";
  if (flow.phase === "swapping") said = "Putting it in place.";
  else if (flow.phase === "done") said = `${name} is restored.`;
  else if (flow.phase === "refused") said = refusalWords(flow.problem);
  return (
    <>
      <Frame say={SAY_RESTORE}>{steps}</Frame>
      {/* Always on the page, so a change in it is spoken: the message stack that says these things in the main window is not here. */}
      <div role="status" className="live">
        <span className="sr" key={announcementKey}>
          {announcement}
        </span>
        <span className="sr">{said}</span>
      </div>
    </>
  );
}

/**
 * The question before a vault is unpacked into a folder a cloud service syncs: the words are Save a copy's shape (the safe answer first, with the focus), and
 * the sentence is the vault's own (18c). Choose another asks Windows for a folder; Continue anyway runs the copy; Escape goes back to 24b.
 */
function CloudQuestion({ open }: { open: boolean }) {
  const another = useRef<HTMLButtonElement>(null);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) backToRestoreFolder();
      }}
      title="This folder is synced to the cloud"
      description="A cloud service syncs this folder. Lockbox doesn't support vaults in cloud folders. Choose a folder on this PC, or continue anyway."
      initialFocus={another}
    >
      <Button
        onClick={() => {
          void answerRestoreQuestion(null);
        }}
      >
        Continue anyway
      </Button>
      <Button
        ref={another}
        look="pill-main"
        onClick={() => {
          void chooseRestoreFolder();
        }}
      >
        Choose another
      </Button>
    </Dialog>
  );
}

/**
 * The question when the folder holds a vault the shell can't tell apart from this backup's (both copies of its details are unreadable): the backup goes in a
 * new folder beside it, under a name the person can change. The suggestion is the shell's; the name is a folder's name, never a path. Cancel goes back to 24b.
 */
function NameQuestion({ suggested }: { suggested: string }) {
  const [typed, setTyped] = useState(suggested);
  const id = useId();
  const cancel = useRef<HTMLButtonElement>(null);
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) backToRestoreFolder();
      }}
      title="Restore into a new folder?"
      description="A vault is already in that folder, and Lockbox can't tell whether it's the same one. This backup can unpack into a new folder beside it instead."
      initialFocus={cancel}
      body={
        <div className="fbox">
          <label className="flab" htmlFor={id}>
            Folder name
          </label>
          <input
            id={id}
            className="finp"
            autoComplete="off"
            spellCheck={false}
            value={typed}
            onChange={(event) => {
              setTyped(event.currentTarget.value);
            }}
          />
        </div>
      }
    >
      <Button ref={cancel} onClick={backToRestoreFolder}>
        Cancel
      </Button>
      <Button
        look="pill-main"
        onClick={() => {
          void answerRestoreQuestion(typed.trim() === "" ? null : typed.trim());
        }}
      >
        Restore here
      </Button>
    </Dialog>
  );
}
