import { useId, useRef, useState, type SyntheticEvent } from "react";
import { focusBack } from "../../focus";
import { messageFor } from "../../messages";
import { Button } from "../../parts/Button";
import { Panel } from "../../parts/Panel";
import { Select } from "../../parts/Select";
import { closeTool, saveNewKey, type SessionData } from "../../store";
import type { FolderEntry } from "../SideMenu";
import { folderChoices, NO_FOLDER, useFocusOnOpen, whereWords } from "./shared";
import { ValueField } from "./ValueField";

/** What a key's name may be, said once under its box and again when the shell refuses a name. */
export const NAME_RULE = "Letters, digits and underscores (_) only. It can't start with a digit.";

/** Whether the shell refused the name itself (the engine's `key name`), so the Name box is the one to mark. */
export function refusedTheName(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { what?: unknown }).what === "key name";
}

/**
 * The new-key form (7a): Name, Value (hidden until Show), Folder, and Cancel and Save. Saving makes the key whole in one
 * write, then opens it hidden with "Saved". What is typed lives in this form's own state, the value included: Cancel, a lock
 * and picking another item all take it, and a lock says nothing. The name must be a variable name (letters, digits and `_`,
 * not starting with a digit), since a key's name is what `.env` out uses: the shell refuses any other, in words under the
 * fields, and the form stays as it was. The Value box is the one the edit-key form uses (`ValueField`); a value with line breaks
 * (a private key file pasted whole) is kept exactly as pasted, in a box that does not show its shape.
 */
export function KeyForm({ data, folders }: { data: SessionData; folders: readonly FolderEntry[] }) {
  const formId = useId();
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [folder, setFolder] = useState(data.folder ?? NO_FOLDER);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  /** The name is empty, or the shell refused it, and Save was pressed: the box is marked, and the words say why. */
  const [nameMarked, setNameMarked] = useState(false);
  const nameBox = useRef<HTMLInputElement>(null);

  useFocusOnOpen(nameBox);

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
        <ValueField id={`${formId}-value`} value={value} onChange={setValue} manyLines />
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
