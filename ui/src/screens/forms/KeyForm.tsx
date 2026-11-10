import { useId, useRef, useState, type SyntheticEvent } from "react";
import { focusBack } from "../../focus";
import { messageFor } from "../../messages";
import { Button } from "../../parts/Button";
import { Panel } from "../../parts/Panel";
import { Select } from "../../parts/Select";
import { closeTool, saveNewKey, type SessionData } from "../../store";
import type { FolderEntry } from "../SideMenu";
import { folderChoices, NO_FOLDER, useFocusOnOpen, whereWords } from "./shared";

/** What a key's name may be, said once under its box and again when the shell refuses a name. */
const NAME_RULE = "Letters, digits and _ only. It can't start with a digit.";

/** What the form says when a paste or a drop holds a line break inside the value: nothing was changed. */
const MANY_LINES = "That value has more than one line, so it wasn't pasted. A key's value is one line here.";

/**
 * Whether `text` has a line break anywhere but its very start or end. The box is one line: it drops a break at either end
 * (a pasted key that ends with one is still the key), but would join the lines of anything longer without a word, and a
 * credential must never change silently.
 */
function hasInnerLineBreak(text: string): boolean {
  return /[\r\n]/.test(text.replace(/^[\r\n]+|[\r\n]+$/g, ""));
}

/** Whether the shell refused the name itself (the engine's `key name`), so the Name box is the one to mark. */
function refusedTheName(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { what?: unknown }).what === "key name";
}

/**
 * The new-key form (7a): Name, Value (hidden until Show), Folder, and Cancel and Save. Saving makes the key whole in one
 * write, then opens it hidden with "Saved". What is typed lives in this form's own state, the value included: Cancel, a lock
 * and picking another item all take it, and a lock says nothing. The name must be a variable name (letters, digits and `_`,
 * not starting with a digit), since a key's name is what `.env` out uses: the shell refuses any other, in words under the
 * fields, and the form stays as it was. While the value is shown, a copy or cut aimed at its box is stopped, so it cannot
 * leave around the clipboard's marks, timer and clearing.
 */
export function KeyForm({ data, folders }: { data: SessionData; folders: readonly FolderEntry[] }) {
  const formId = useId();
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [shown, setShown] = useState(false);
  const [folder, setFolder] = useState(data.folder ?? NO_FOLDER);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  /** The name is empty, or the shell refused it, and Save was pressed: the box is marked, and the words say why. */
  const [nameMarked, setNameMarked] = useState(false);
  /** The words now under the fields are the refused paste's (they clear on the next change or a clean paste). */
  const [pasteRefused, setPasteRefused] = useState(false);
  const nameBox = useRef<HTMLInputElement>(null);

  useFocusOnOpen(nameBox);

  /** Reads what is being pasted or dropped before the box does; stops it, and says why, if it would be changed silently. */
  const checkText = (text: string, event: { preventDefault: () => void }) => {
    if (hasInnerLineBreak(text)) {
      event.preventDefault();
      setProblem(MANY_LINES);
      setPasteRefused(true);
      setNameMarked(false);
    } else if (pasteRefused) {
      setProblem(null);
      setPasteRefused(false);
    }
  };

  const cancel = () => {
    closeTool(data.session);
    focusBack("add");
  };

  const save = async (event: SyntheticEvent) => {
    event.preventDefault();
    if (saving) return;
    if (name.trim() === "") {
      setProblem("Type a name first.");
      setNameMarked(true);
      nameBox.current?.focus();
      return;
    }
    setSaving(true);
    setProblem(null);
    setNameMarked(false);
    const done = await saveNewKey(data.session, { name, value, folder: folder === NO_FOLDER ? null : folder });
    // Saved or locked: the form is already gone, and there is nothing to say.
    if (typeof done !== "object") return;
    const words = messageFor(done.failed);
    setProblem(words.body === "" ? words.title : `${words.title} ${words.body}`);
    setNameMarked(refusedTheName(done.failed));
    setSaving(false);
  };

  return (
    <Panel
      title="New key"
      subtitle={whereWords(folders, folder, data.name)}
      onClose={cancel}
      footer={
        <>
          <Button onClick={cancel}>Cancel</Button>
          <Button look="pill-main" type="submit" form={formId} aria-disabled={saving ? true : undefined}>
            Save
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={(event) => void save(event)} noValidate>
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
          <div className="flrow">
            <label className="flab" htmlFor={`${formId}-value`}>
              Value
            </label>
            <Button
              aria-controls={`${formId}-value`}
              onClick={() => {
                setShown(!shown);
              }}
            >
              {shown ? "Hide" : "Show"}
            </Button>
          </div>
          <input
            id={`${formId}-value`}
            className="finp m"
            type={shown ? "text" : "password"}
            autoComplete="off"
            spellCheck={false}
            placeholder="Paste the key"
            value={value}
            onChange={(event) => {
              setValue(event.currentTarget.value);
              if (pasteRefused) {
                setProblem(null);
                setPasteRefused(false);
              }
            }}
            onPaste={(event) => {
              checkText(event.clipboardData.getData("text"), event);
            }}
            onDrop={(event) => {
              checkText(event.dataTransfer.getData("text"), event);
            }}
            // Shown, the value can be selected, so a native copy or cut would skip the clipboard's marks, timer and clearing.
            onCopy={(event) => {
              if (shown) event.preventDefault();
            }}
            onCut={(event) => {
              if (shown) event.preventDefault();
            }}
          />
        </div>
        <div className="fbox">
          <Select
            label="Folder"
            items={folderChoices(folders, data.folder)}
            value={folder}
            onValueChange={setFolder}
          />
        </div>
        {problem === null ? null : (
          <p className="err" id={`${formId}-problem`} role="alert">
            {problem}
          </p>
        )}
      </form>
    </Panel>
  );
}
