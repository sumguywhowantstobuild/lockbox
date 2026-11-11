import { useId, useRef, useState, type SyntheticEvent } from "react";
import { focusBack } from "../../focus";
import { messageFor } from "../../messages";
import { Button } from "../../parts/Button";
import { GeneratorIcon } from "../../parts/Icon";
import { Panel } from "../../parts/Panel";
import { Select } from "../../parts/Select";
import { closeTool, saveNewLogin, type SessionData } from "../../store";
import { GeneratorInForm } from "../GeneratorPanel";
import type { FolderEntry } from "../SideMenu";
import { folderChoices, hasInnerLineBreak, NO_FOLDER, PASSWORD_MANY_LINES, useFocusOnOpen, whereWords } from "./shared";

/**
 * The new-login form (6b, with the generator of 6c): Title, Username, Website, Password with Generate, Folder, and Cancel
 * and Save. Saving makes the login whole in one write, then opens it with "Saved". What is typed lives in this form's own
 * state: Cancel, a lock and picking another item all take it, the password with it, and a lock says nothing. The same
 * title as another login is fine; the username tells them apart. The shell adds `https://` to a website that has none and
 * refuses anything but `http` and `https`; its refusals are said in words under the fields and the form stays as it was.
 */
export function LoginForm({
  data,
  folders,
  title: started,
}: {
  data: SessionData;
  folders: readonly FolderEntry[];
  /** What the title starts as: the search text it was opened from, or empty. */
  title: string;
}) {
  const formId = useId();
  const [title, setTitle] = useState(started);
  const [username, setUsername] = useState("");
  const [website, setWebsite] = useState("");
  const [password, setPassword] = useState("");
  const [folder, setFolder] = useState(data.folder ?? NO_FOLDER);
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  /** The title is empty and Save was pressed: the field is marked, and the words say why. */
  const [titleMissing, setTitleMissing] = useState(false);
  /** The words now under the fields are a refused paste's (they clear on the next change or a clean paste). */
  const [pasteRefused, setPasteRefused] = useState(false);
  const titleBox = useRef<HTMLInputElement>(null);
  const passwordBox = useRef<HTMLInputElement>(null);

  useFocusOnOpen(titleBox);

  const subtitle = whereWords(folders, folder, data.name);

  /** Something other than a refused paste has the line now: a change to the password must not clear it. */
  const sayInstead = (words: string | null) => {
    setProblem(words);
    setPasteRefused(false);
  };

  /** Reads what is being pasted or dropped before the box does; stops it, and says why, if it would be changed silently. */
  const checkText = (text: string, event: { preventDefault: () => void }) => {
    if (hasInnerLineBreak(text)) {
      event.preventDefault();
      setProblem(PASSWORD_MANY_LINES);
      setPasteRefused(true);
      setTitleMissing(false);
    } else if (pasteRefused) {
      sayInstead(null);
    }
  };

  const cancel = () => {
    closeTool(data.session);
    focusBack("add");
  };

  const save = async (event: SyntheticEvent) => {
    event.preventDefault();
    if (saving) return;
    if (title.trim() === "") {
      sayInstead("Type a title first.");
      setTitleMissing(true);
      titleBox.current?.focus();
      return;
    }
    setSaving(true);
    sayInstead(null);
    setTitleMissing(false);
    const done = await saveNewLogin(data.session, {
      title,
      username,
      website,
      password,
      folder: folder === NO_FOLDER ? null : folder,
    });
    // Saved or locked: the form is already gone, and there is nothing to say.
    if (typeof done !== "object") return;
    const words = messageFor(done.failed);
    sayInstead(words.body === "" ? words.title : `${words.title} ${words.body}`);
    setSaving(false);
  };

  return (
    <Panel
      title="New login"
      subtitle={subtitle}
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
          <label className="flab" htmlFor={`${formId}-username`}>
            Username
          </label>
          <input
            id={`${formId}-username`}
            className="finp"
            type="text"
            autoComplete="off"
            spellCheck={false}
            value={username}
            onChange={(event) => {
              setUsername(event.currentTarget.value);
            }}
          />
        </div>
        <div className="fbox">
          <label className="flab" htmlFor={`${formId}-website`}>
            Website
          </label>
          <input
            id={`${formId}-website`}
            className="finp"
            type="text"
            autoComplete="off"
            spellCheck={false}
            aria-describedby={`${formId}-website-hint`}
            value={website}
            onChange={(event) => {
              setWebsite(event.currentTarget.value);
            }}
          />
          <p className="fhint" id={`${formId}-website-hint`}>
            https:// is added on save if it&apos;s missing.
          </p>
        </div>
        <div className="fbox">
          <div className="flrow">
            <label className="flab" htmlFor={`${formId}-password`}>
              Password
            </label>
            <Button
              aria-expanded={generating}
              onClick={() => {
                setGenerating(!generating);
              }}
            >
              <GeneratorIcon />
              Generate
            </Button>
          </div>
          <input
            ref={passwordBox}
            id={`${formId}-password`}
            className="finp m"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={password}
            onChange={(event) => {
              setPassword(event.currentTarget.value);
              if (pasteRefused) sayInstead(null);
            }}
            onPaste={(event) => {
              checkText(event.clipboardData.getData("text"), event);
            }}
            onDrop={(event) => {
              checkText(event.dataTransfer.getData("text"), event);
            }}
          />
        </div>
        {generating ? (
          <GeneratorInForm
            onUse={(value) => {
              setPassword(value);
              setGenerating(false);
              passwordBox.current?.focus();
            }}
          />
        ) : null}
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
