import { useEffect, useId, useRef, useState, type KeyboardEvent, type SyntheticEvent } from "react";
import type { OnClash } from "../api";
import { focusBack } from "../focus";
import { messageFor, messageText } from "../messages";
import { Button } from "../parts/Button";
import { Dialog } from "../parts/Dialog";
import { Panel } from "../parts/Panel";
import { Select } from "../parts/Select";
import { abandonCapture, cancelCapture, captureAsEnv, revealCapture, saveCapture, useCapture, type SessionData } from "../store";
import { ClearClipboardBox } from "./forms/ClearClipboard";
import { NAME_RULE, refusedTheName } from "./forms/KeyForm";
import { folderChoices, NO_FOLDER, useFocusOnOpen } from "./forms/shared";
import { MANY_LINES, ValueField } from "./forms/ValueField";
import { useValueGuard } from "../useValueGuard";
import type { FolderEntry } from "./SideMenu";

/** What the box says at its top when a later press found a different value: what was typed stays. */
const CHANGED = "The copied value changed. What you typed is kept.";

/** What the box says when the clipboard held no text (an image, say), or more than a key can hold. */
const NOTHING_COPIED = "Nothing to save was copied. Paste or type the value here.";
const TOO_BIG = "What you copied is too big to save as a key. Paste or type the value here.";

/** "3 keys", "1 key". */
function keysWords(count: number): string {
  return `${String(count)} ${count === 1 ? "key" : "keys"}`;
}

/**
 * The copied value once shown: like every secret on the page, kept from a native copy, cut or drag (`useValueGuard`, not selectable), which
 * would put a second copy on the clipboard without the marks that keep it out of Windows' clipboard history, its timer and its clear at a
 * lock. It is on the clipboard already, so Ctrl+C on it copies nothing more.
 */
function ShownValue({ value }: { value: string }) {
  const box = useRef<HTMLSpanElement>(null);
  useValueGuard(box);
  return (
    <span
      ref={box}
      className="cshown"
      onDragStart={(event) => {
        event.preventDefault();
      }}
    >
      {value}
    </span>
  );
}

/**
 * The copied value's row (8a): its dots, and Show, which asks the shell for the value by the copy's id. The value lives in this part's own
 * state and nowhere else. It is made for one copy (`key` is the copy's id where it is used): a new copy, the copy going, a lock and the
 * panel closing all take this part away, and an answer that comes to a part that is gone is dropped, so a value never outlives the copy
 * it was asked for.
 */
function CopiedValue({ captureId }: { captureId: string }) {
  const label = useId();
  const box = useId();
  const [value, setValue] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const toggle = async () => {
    if (value !== null) {
      setValue(null);
      return;
    }
    if (asking) return;
    setAsking(true);
    setProblem(null);
    const answer = await revealCapture(captureId);
    if (!alive.current) return;
    setAsking(false);
    if (answer === "gone") return;
    if ("failed" in answer) setProblem(messageText(messageFor(answer.failed)));
    else setValue(answer.value);
  };

  return (
    <div className="fbox">
      <div className="flrow">
        <span className="flab" id={label}>
          Copied value
        </span>
        <Button
          aria-controls={box}
          aria-describedby={label}
          onClick={() => {
            void toggle();
          }}
        >
          {value === null ? "Show" : "Hide"}
        </Button>
      </div>
      <div className="cval" id={box} role="group" aria-labelledby={label}>
        {value === null ? (
          <span className="cdots" role="img" aria-label="Value hidden">
            ••••••••••••••
          </span>
        ) : (
          <ShownValue value={value} />
        )}
      </div>
      {problem === null ? null : (
        <p className="err" role="alert">
          {problem}
        </p>
      )}
    </div>
  );
}

/**
 * The save box (8a, and 8c when nothing was copied): what the shortcut copied, to be named and saved as a key. The shell holds the copy and the page
 * only its id; the value comes on Show, to the row that asked. Name, Vault (the one open, as text), Folder and "Clear the clipboard after saving".
 * When the clipboard held no text, or too much, there is no copied value to show: a Value box takes what is pasted or typed in its place (8c), and
 * the clear does not apply. Save asks the shell once, which stops at a name that is taken (8d: Replace, Keep both with the name it would use, Cancel).
 * Saved, the box closes, the new key opens, and the message says where it went and what became of the clipboard. Cancel, the close button, Escape and
 * another panel taking the place all let the copy go. A new copy while the box is open keeps what was typed and chosen and says the value changed.
 * A lock, or the shell letting the copy go, takes the box with nothing said.
 */
export function SaveBox({ data, folders }: { data: SessionData; folders: readonly FolderEntry[] }) {
  const capture = useCapture();
  const formId = useId();
  const [name, setName] = useState("");
  const [typed, setTyped] = useState("");
  const [picked, setPicked] = useState(data.folder ?? NO_FOLDER);
  const [clear, setClear] = useState(true);
  /** A save, or the reading as a `.env`, is on its way: a second press does nothing. */
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [nameMarked, setNameMarked] = useState(false);
  /**
   * The name that is taken, and the one Keep both would give, for the copy `captureId`: the question (8d) is open while this is set and that is
   * still the copy on screen. It is a question about one value; when another copy takes its place it is gone, and Replace needs a fresh Save.
   */
  const [asked, setAsked] = useState<{ captureId: string; name: string; savedAs: string } | null>(null);
  const nameBox = useRef<HTMLInputElement>(null);
  const valueBox = useRef<HTMLInputElement>(null);
  // Focus goes to the name when there is a copied value; the vault is already known. With nothing copied, to the Value box.
  const [opensOnName] = useState(capture?.state === "value");
  const mounted = useRef(true);
  const shown = useRef<string | null>(null);

  useFocusOnOpen(opensOnName ? nameBox : valueBox);

  useEffect(() => {
    shown.current = capture?.id ?? null;
  });

  // The box going some way the box itself did not end (another panel took its place): the copy is let go. React runs an effect's cleanup and
  // its setup again as a trial in development, with this same box, so only a box that is still gone a moment later has left.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      window.setTimeout(() => {
        if (!mounted.current && shown.current !== null) abandonCapture(shown.current);
      }, 0);
    };
  }, []);

  if (capture === null) return null;

  // A folder that has gone while the box was open is no longer a choice: the save goes to no folder unless another is picked.
  const folder = picked === NO_FOLDER || folders.some((entry) => entry.id === picked) ? picked : NO_FOLDER;
  const place = folder === NO_FOLDER ? null : folder;
  const where = folders.find((entry) => entry.id === place)?.name ?? data.name;
  const hasValue = capture.state === "value";
  const clash = asked !== null && asked.captureId === capture.id ? asked : null;

  const cancel = () => {
    cancelCapture();
    focusBack("add");
  };

  const save = async (onClash: OnClash) => {
    if (busy) return;
    const trimmed = name.trim();
    if (trimmed === "") {
      setProblem("Type a name first.");
      setNameMarked(true);
      nameBox.current?.focus();
      return;
    }
    setBusy(true);
    setProblem(null);
    setNameMarked(false);
    const sentFor = capture.id;
    const done = await saveCapture(
      data.session,
      { captureId: sentFor, name: trimmed, collection: place, onClash, clearClipboard: hasValue && clear, typed: hasValue ? null : typed },
      where,
    );
    if (!mounted.current) return;
    setBusy(false);
    if (done === "saved" || done === "stale" || done === "gone") {
      setAsked(null);
      return;
    }
    // An answer about a copy that another has replaced since is about a value that is no longer here: it opens nothing and says nothing.
    if (shown.current !== sentFor) {
      setAsked(null);
      return;
    }
    if ("clash" in done) {
      // The name is taken (or the number the person was shown is not free any more): the question opens, or shows the next free name.
      setAsked({ captureId: sentFor, name: trimmed, savedAs: done.clash });
      return;
    }
    setAsked(null);
    setProblem(messageText(messageFor(done.failed)));
    setNameMarked(refusedTheName(done.failed));
  };

  const asEnv = async () => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    const done = await captureAsEnv(data.session, capture.id, folder);
    if (!mounted.current) return;
    setBusy(false);
    if (typeof done === "object") setProblem(messageText(messageFor(done.failed)));
  };

  const onSubmit = (event: SyntheticEvent) => {
    event.preventDefault();
    void save("ask");
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    // Escape in the folder list (or any list or menu open from here) closes that and nothing more.
    const from = event.target instanceof Element ? event.target : null;
    if (from?.closest('[role="listbox"], [role="menu"], [aria-expanded="true"]') != null) return;
    cancel();
  };

  return (
    <>
      <Panel
        title="Save what you copied"
        onClose={cancel}
        onKeyDown={onKeyDown}
        footer={
          <>
            <Button onClick={cancel}>Cancel</Button>
            <Button look="pill-main" type="submit" form={formId} aria-disabled={busy ? true : undefined}>
              Save
            </Button>
          </>
        }
      >
        <form id={formId} onSubmit={onSubmit} noValidate>
          <p role="status" className={capture.changed ? "cnote" : "sr"}>
            {capture.changed ? CHANGED : ""}
          </p>
          {hasValue ? (
            <>
              <CopiedValue key={capture.id} captureId={capture.id} />
              {capture.envKeys === null ? null : (
                <div className="fbox">
                  <p className="cnote">{`This looks like a .env file with ${keysWords(capture.envKeys)}.`}</p>
                  <Button
                    aria-disabled={busy ? true : undefined}
                    onClick={() => {
                      void asEnv();
                    }}
                  >
                    Save as separate keys
                  </Button>
                </div>
              )}
            </>
          ) : (
            <>
              <p className="cnote">{capture.state === "too_large" ? TOO_BIG : NOTHING_COPIED}</p>
              <ValueField
                id={`${formId}-value`}
                inputRef={valueBox}
                value={typed}
                onChange={setTyped}
                onRefused={() => {
                  setProblem(MANY_LINES);
                  setNameMarked(false);
                }}
                onAccepted={() => {
                  if (problem === MANY_LINES) setProblem(null);
                }}
              />
            </>
          )}
          <div className="fbox">
            <label className="flab" htmlFor={`${formId}-name`}>
              Name
            </label>
            <input
              ref={nameBox}
              id={`${formId}-name`}
              className="finp m"
              type="text"
              autoComplete="off"
              spellCheck={false}
              placeholder="OPENAI_API_KEY"
              value={name}
              aria-invalid={nameMarked ? true : undefined}
              aria-describedby={[`${formId}-name-hint`, nameMarked ? `${formId}-problem` : null].filter(Boolean).join(" ")}
              onChange={(event) => {
                setName(event.currentTarget.value);
              }}
            />
            <p className="fhint" id={`${formId}-name-hint`}>
              {NAME_RULE}
            </p>
          </div>
          <div className="fbox">
            <label className="flab" htmlFor={`${formId}-vault`}>
              Vault
            </label>
            <input id={`${formId}-vault`} className="finp" type="text" readOnly value={data.name} />
          </div>
          <div className="fbox">
            <Select label="Folder" items={folderChoices(folders, data.folder)} value={folder} onValueChange={setPicked} />
          </div>
          {hasValue ? <ClearClipboardBox checked={clear} onChange={setClear} /> : null}
          {problem === null ? null : (
            <p className="err" id={`${formId}-problem`} role="alert">
              {problem}
            </p>
          )}
        </form>
      </Panel>
      <Dialog
        open={clash !== null}
        onOpenChange={(open) => {
          if (!open) setAsked(null);
        }}
        title={`This folder already has ${clash?.name ?? ""}`}
        description={`Replace puts this value in the old one's place. Keep both saves this as ${clash?.savedAs ?? ""}.`}
      >
        <Button
          onClick={() => {
            setAsked(null);
          }}
        >
          Cancel
        </Button>
        <Button
          disabled={busy}
          onClick={() => {
            if (clash !== null) void save({ keep_both: clash.savedAs });
          }}
        >
          Keep both
        </Button>
        <Button
          look="pill-main"
          disabled={busy}
          onClick={() => {
            void save("replace");
          }}
        >
          Replace
        </Button>
      </Dialog>
    </>
  );
}
