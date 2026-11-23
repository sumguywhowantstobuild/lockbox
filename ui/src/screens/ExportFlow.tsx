import { useEffect, useId, useRef, useState, type KeyboardEvent, type SyntheticEvent } from "react";
import { EXPORT_DELETE_IT, EXPORT_LINE_BREAKS, EXPORT_WARNING, exportContents, exportCounts, exportSavedIn, exportUnreadable } from "../exportWords";
import { focusBack } from "../focus";
import { useLockEpoch } from "../jobs";
import { messageFor, messageText } from "../messages";
import { Button } from "../parts/Button";
import { Panel } from "../parts/Panel";
import { PasswordField } from "../parts/PasswordField";
import {
  cancelExportQuestion,
  clearExportProblem,
  closeExport,
  continueExport,
  exportVault,
  pickAnotherExportFolder,
  type ExportFlow as Flow,
  type SessionData,
} from "../store";
import { CloudCopyQuestion } from "./FileActions";

// Export to a readable file (34a to 34c), on the session whose Settings opened it. 34a warns that anyone who gets the file can read everything in it, then asks for
// the vault's password. What is typed is the form's own state and is wiped from it the moment it is sent; the page learns the folder, counts and the titles of the
// rows whose values have line breaks, and sends none of it back. 34b is the refusals (said on the form, in the table's words) and the cloud question, which
// answers by a token and never sends the password again. 34c says to delete the file and empty the Recycle Bin. Every refusal goes through `messageFor`.

/**
 * The Export panel, as the export follows: the form (34a, with the line a refusal puts on it, and the cloud question of 34b over it) and the end (34c).
 */
export function ExportPanel({ data }: { data: SessionData }) {
  const flow = data.exportFlow;
  if (flow === null) return null;
  if (flow.phase === "done") return <Done data={data} flow={flow} />;
  return <Form data={data} flow={flow} />;
}

function Form({ data, flow }: { data: SessionData; flow: Extract<Flow, { phase: "ask" | "cloud" }> }) {
  const { session } = data;
  const formId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const [typed, setTyped] = useState("");
  const [empty, setEmpty] = useState<string | null>(null);
  // The box, so a problem about it (empty, or the shell's refusal) puts focus where the next try starts.
  const box = useRef<HTMLInputElement>(null);
  // An export was sent from this form: its answer (a refusal, a closed dialog, a cancelled question) leaves focus in the box, ready for the next try.
  const sentOnce = useRef(false);
  // The field can't be typed in while the password is out or the cloud question is open: what is typed meanwhile would outlive the answer.
  const asking = flow.phase === "cloud";
  const sending = flow.sending;
  const locked = asking || sending;
  // Every lock epoch (Lock all, an idle lock, Windows locking or sleeping, even when this vault's own `locked` event has not come) wipes what is typed.
  const epoch = useLockEpoch();
  const [seenEpoch, setSeenEpoch] = useState(epoch);
  if (seenEpoch !== epoch) {
    setSeenEpoch(epoch);
    setTyped("");
    setEmpty(null);
  }
  useEffect(() => {
    heading.current?.focus();
  }, []);
  useEffect(() => {
    if (!sentOnce.current || flow.phase !== "ask" || flow.sending) return;
    const timer = window.setTimeout(() => {
      box.current?.focus();
    }, 0);
    return () => {
      window.clearTimeout(timer);
    };
  }, [flow]);

  // While the password is out or the question is open the panel can't be put away: Cancel does not take the request back, and the answer is for this form.
  const close = () => {
    if (locked) return;
    closeExport(session);
    focusBack("settings");
  };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    event.preventDefault();
    close();
  };

  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    if (locked) return;
    if (typed === "") {
      setEmpty(messageText(messageFor({ code: "invalid_input", what: "password is empty" })));
      box.current?.focus();
      return;
    }
    setEmpty(null);
    // The password goes once, and is gone from here as it goes: the field is empty whatever comes back.
    const sent = typed;
    setTyped("");
    sentOnce.current = true;
    void exportVault(session, sent);
  };

  // What the shell last refused with is said on the field it is about (the form as a whole for any other refusal, a vault's folder among them).
  const problem = flow.phase === "ask" ? flow.problem : null;
  const refusal = problem === null ? null : messageText(messageFor(problem.error));
  const aboutPassword = problem?.field === "current" ? refusal : null;
  const aboutForm = problem?.field === "form" ? refusal : null;

  return (
    <>
      <Panel
        title="Export"
        subtitle={exportContents(data.name)}
        titleRef={heading}
        onClose={close}
        onKeyDown={onKeyDown}
        footer={
          <>
            <Button aria-disabled={locked ? true : undefined} onClick={close}>
              Cancel
            </Button>
            <Button look="pill-main" type="submit" form={formId} aria-disabled={locked ? true : undefined}>
              Choose where it goes
            </Button>
          </>
        }
      >
        <p className="fwarn">{EXPORT_WARNING}</p>
        <form id={formId} onSubmit={submit} noValidate aria-busy={sending ? true : undefined}>
          <PasswordField
            look="panel"
            autoComplete="current-password"
            label={`Password for ${data.name}`}
            inputRef={box}
            readOnly={locked}
            value={typed}
            error={empty ?? aboutPassword}
            onChange={(value) => {
              setTyped(value);
              setEmpty(null);
              if (problem !== null) clearExportProblem(session);
            }}
          />
          {aboutForm === null ? null : (
            <p className="ferr" role="alert">
              {aboutForm}
            </p>
          )}
        </form>
      </Panel>
      {/* The folder is synced to the cloud: the existing question (21e). Pick another folder is the safe answer, with the first focus; Escape writes nothing and lets the choice go. */}
      <CloudCopyQuestion
        open={asking}
        onAnother={() => {
          void pickAnotherExportFolder(session);
        }}
        onContinue={() => {
          void continueExport(session);
        }}
        onNo={() => {
          cancelExportQuestion(session);
        }}
      />
    </>
  );
}

/**
 * 34c: the file was written. It says where, how many items and stored files, that the file isn't protected (delete it, and empty the Recycle Bin), and, when
 * there are any, the items whose values have line breaks, which another app may change. Show in Explorer isn't here: the page holds only the folder to read,
 * and no command takes it back. Focus is on the heading as it appears, so what to do next is read first.
 */
function Done({ data, flow }: { data: SessionData; flow: Extract<Flow, { phase: "done" }> }) {
  const { session } = data;
  const heading = useRef<HTMLHeadingElement>(null);
  const { summary } = flow;
  useEffect(() => {
    heading.current?.focus();
  }, []);
  const close = () => {
    closeExport(session);
    focusBack("settings");
  };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    event.preventDefault();
    close();
  };
  return (
    <Panel
      title="Exported"
      subtitle={exportSavedIn(flow.folder)}
      titleRef={heading}
      onClose={close}
      onKeyDown={onKeyDown}
      footer={
        <Button look="pill-main" onClick={close}>
          Done
        </Button>
      }
    >
      <p className="psub">{exportCounts(summary.items, summary.left_out_files)}</p>
      {/* A vault with damaged items gives a file without them: said, so it is never taken for the whole vault. */}
      {summary.unreadable === 0 ? null : <p className="fwarn">{exportUnreadable(summary.unreadable)}</p>}
      <p className="fwarn">{EXPORT_DELETE_IT}</p>
      {summary.line_breaks.length === 0 ? null : (
        <div className="sumlist">
          <p className="gh">{EXPORT_LINE_BREAKS}</p>
          <ul className="names">
            {summary.line_breaks.map((title, at) => (
              <li key={`${String(at)}:${title}`}>{title}</li>
            ))}
          </ul>
        </div>
      )}
    </Panel>
  );
}
