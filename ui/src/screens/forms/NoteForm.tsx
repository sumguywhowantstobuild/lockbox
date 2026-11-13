import { useId, useRef, useState, type SyntheticEvent } from "react";
import { focusBack } from "../../focus";
import { messageFor } from "../../messages";
import { Button } from "../../parts/Button";
import { Panel } from "../../parts/Panel";
import { Select } from "../../parts/Select";
import { closeTool, saveNewNote, type SessionData } from "../../store";
import type { FolderEntry } from "../SideMenu";
import { folderChoices, NO_FOLDER, useFocusOnOpen, whereWords } from "./shared";

/**
 * The new-note form (7b): Title, Text, Folder, and Cancel and Save. Saving makes the note whole in one write, then opens it
 * with its text showing (decision A) and "Saved". What is typed lives in this form's own state: Cancel, a lock and picking
 * another item all take it, and a lock says nothing. The text may be empty; the title may not.
 */
export function NoteForm({ data, folders }: { data: SessionData; folders: readonly FolderEntry[] }) {
  const formId = useId();
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [folder, setFolder] = useState(data.folder ?? NO_FOLDER);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  /** The title is empty and Save was pressed: the box is marked, and the words say why. */
  const [titleMissing, setTitleMissing] = useState(false);
  const titleBox = useRef<HTMLInputElement>(null);

  useFocusOnOpen(titleBox);

  const cancel = () => {
    closeTool(data.session);
    focusBack("add");
  };

  const save = async (event: SyntheticEvent) => {
    event.preventDefault();
    if (saving) return;
    if (title.trim() === "") {
      setProblem("Type a title first.");
      setTitleMissing(true);
      titleBox.current?.focus();
      return;
    }
    setSaving(true);
    setProblem(null);
    setTitleMissing(false);
    const done = await saveNewNote(data.session, { title, text, folder: folder === NO_FOLDER ? null : folder });
    // Saved or locked: the form is already gone, and there is nothing to say.
    if (typeof done !== "object") return;
    const words = messageFor(done.failed);
    setProblem(words.body === "" ? words.title : `${words.title} ${words.body}`);
    setSaving(false);
  };

  return (
    <Panel
      title="New note"
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
          <label className="flab" htmlFor={`${formId}-title`}>
            Title
          </label>
          <input
            ref={titleBox}
            id={`${formId}-title`}
            className="finp"
            type="text"
            autoComplete="off"
            spellCheck={false}
            value={title}
            aria-invalid={titleMissing ? true : undefined}
            aria-describedby={titleMissing ? `${formId}-problem` : undefined}
            onChange={(event) => {
              setTitle(event.currentTarget.value);
            }}
          />
        </div>
        <div className="fbox">
          <label className="flab" htmlFor={`${formId}-text`}>
            Text
          </label>
          <textarea
            id={`${formId}-text`}
            className="finp farea"
            rows={6}
            autoComplete="off"
            spellCheck={false}
            value={text}
            onChange={(event) => {
              setText(event.currentTarget.value);
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
