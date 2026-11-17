import { useEffect, useId, useRef, useState, type KeyboardEvent, type SyntheticEvent } from "react";
import { focusBack } from "../focus";
import { formatBytes, fullDay } from "../format";
import { useJob, useLockEpoch } from "../jobs";
import { messageFor, messageText } from "../messages";
import { Button } from "../parts/Button";
import { CredentialField } from "../parts/CredentialField";
import { Figure } from "../parts/Figure";
import { JobProgress } from "../parts/JobProgress";
import { Panel } from "../parts/Panel";
import { clearTestProblem, closeTestBackup, pickAnotherBackup, runTestBackup, type SessionData, type TestFlow } from "../store";
import { damagedWords, missingWords, WRONG_FOR_THIS_BACKUP } from "../testBackupWords";

// Test a backup (23a to 23d): the backup is picked first (in Windows' own dialog, which Rust opens; the page only ever has its name and size), then the
// password or recovery key it was made with is typed in one box, and the backup is checked from end to end without being restored. A wrong password keeps
// the file picked; a damaged backup says so in plain words. The panel belongs to the vault whose Settings (or 22c) opened it.

const GOOD_WORDS = "Every item and file checked out. Nothing was changed.";

/** The words under the box for what the last try was refused with: 23c's line for a wrong password, the table's words for the rest. */
function problemWords(problem: unknown): string {
  const wrong = typeof problem === "object" && problem !== null && (problem as { code?: unknown; kind?: unknown }).code === "core" && (problem as { kind?: unknown }).kind === "wrong_password";
  return wrong ? WRONG_FOR_THIS_BACKUP : messageText(messageFor(problem));
}

/**
 * The Test a backup panel (23a to 23d), on the session that opened it:
 *
 * - **23a, 23c:** the picked file (its name and size as text; Pick another), the one box for a password or recovery key, Cancel and Test. A wrong password
 *   is said under the box and the box is empty; the file stays picked. A file the shell let go (expired) is said under the row, and Pick a backup starts again.
 * - **Testing:** the progress card (`JobProgress`): "Testing <file name>", the bytes and Cancel, which stops the test and comes back to 23a.
 * - **23b:** "This backup is good", when it was made, its size and counts. **23d:** "This backup is damaged", in plain words, from the first thing that failed.
 *
 * Closing the panel, in any way, stops a test that runs and lets the shell forget the file. What is typed is this panel's own state: it is wiped as it is sent.
 */
export function TestBackupPanel({ data }: { data: SessionData }) {
  const flow = data.test;
  if (flow === null || flow.phase === "picking") return null;
  return <TestPanel data={data} flow={flow} />;
}

function TestPanel({ data, flow }: { data: SessionData; flow: TestFlow }) {
  const { session } = data;
  const [typed, setTyped] = useState("");
  // Every lock epoch (Lock all, an idle lock, Windows locking or sleeping, even when this panel's own `locked` event never came) wipes what is typed
  // and hides it again: the box is drawn anew under the epoch's number, so its Show goes back to hidden.
  const epoch = useLockEpoch();
  const [seenEpoch, setSeenEpoch] = useState(epoch);
  if (seenEpoch !== epoch) {
    setSeenEpoch(epoch);
    setTyped("");
  }
  const heading = useRef<HTMLHeadingElement>(null);
  const formId = useId();
  const job = useJob(flow.phase === "testing" ? flow.request : null);
  // Focus goes to the heading as each step comes (the file and box, the bar, the result), so a screen reader reads what the step says.
  const step = flow.phase;
  useEffect(() => {
    heading.current?.focus();
  }, [step]);

  const close = () => {
    closeTestBackup(session);
    focusBack("settings");
  };
  // Escape closes the panel, except while the test runs: a stray key does not stop a long test (Cancel and Close panel do).
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape" || event.defaultPrevented || flow.phase === "testing") return;
    close();
  };
  const name = flow.fileName ?? "";

  // ---- 23b: good ----
  if (flow.phase === "good" && flow.view !== null) {
    const { view } = flow;
    const made = fullDay(view.created_at);
    const missing = missingWords(view.missing_files);
    return (
      <Panel
        title="This backup is good"
        titleRef={heading}
        subtitle={name}
        onClose={close}
        onKeyDown={onKeyDown}
        footer={
          <Button look="pill-main" onClick={close}>
            Done
          </Button>
        }
      >
        <section className="gp">
          <div className="grp">
            {made === "" ? null : <Figure label="Made" value={made} />}
            <Figure label="Size" value={formatBytes(view.size_on_disk)} />
            <Figure label="Items" value={String(view.items)} />
            <Figure label="Files" value={String(view.files)} />
          </div>
        </section>
        <p className="fhint">{GOOD_WORDS}</p>
        {missing === null ? null : <p className="fhint">{missing}</p>}
      </Panel>
    );
  }

  // ---- 23d: damaged ----
  if (flow.phase === "damaged") {
    return (
      <Panel
        title="This backup is damaged"
        titleRef={heading}
        subtitle={name}
        onClose={close}
        onKeyDown={onKeyDown}
        footer={
          <Button look="pill-main" onClick={close}>
            Done
          </Button>
        }
      >
        <p className="ferr" role="alert">
          {damagedWords(flow.damage)}
        </p>
      </Panel>
    );
  }

  // ---- The bar: the test runs ----
  if (flow.phase === "testing") {
    return (
      <Panel title="Test a backup" titleRef={heading} onClose={close} onKeyDown={onKeyDown}>
        {job === null ? (
          <p className="note" aria-busy="true">
            Starting…
          </p>
        ) : (
          <JobProgress operation={job.operation} label={`Testing ${name}`} />
        )}
      </Panel>
    );
  }

  // ---- 23a, 23c: the file, and the box ----
  const picked = flow.choice !== null;
  const off = typed === "" || !picked || flow.busy;
  // A refusal about the file (the shell let it go) is said under its row; one about what was typed (a wrong password) is the box's.
  const aboutTheBox = picked && flow.problem !== null ? problemWords(flow.problem) : null;
  const aboutTheFile = !picked && flow.problem !== null ? problemWords(flow.problem) : null;
  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    if (off) return;
    // The text goes once, and is gone from here as it goes: the box is empty whatever comes back.
    const text = typed;
    setTyped("");
    void runTestBackup(session, text);
  };
  return (
    <Panel
      title="Test a backup"
      titleRef={heading}
      onClose={close}
      onKeyDown={onKeyDown}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button look="pill-main" type="submit" form={formId} aria-disabled={off ? true : undefined}>
            Test
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
                if (!flow.busy) void pickAnotherBackup(session);
              }}
            >
              {picked ? "Pick another" : "Pick a backup"}
            </Button>
          </div>
        </div>
      </section>
      {aboutTheFile === null ? null : (
        <p className="ferr" role="alert">
          {aboutTheFile}
        </p>
      )}
      <form id={formId} onSubmit={submit}>
        <CredentialField
          key={epoch}
          label="Password or recovery key from when it was made"
          value={typed}
          onChange={(next) => {
            setTyped(next);
            if (picked) clearTestProblem(session);
          }}
          error={aboutTheBox}
        />
      </form>
    </Panel>
  );
}
