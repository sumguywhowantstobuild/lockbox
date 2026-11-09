import { useEffect, useId, useRef, useState, type SyntheticEvent } from "react";
import { focusBack } from "../../focus";
import { messageFor } from "../../messages";
import { Button } from "../../parts/Button";
import { Panel } from "../../parts/Panel";
import { Select, type SelectChoice } from "../../parts/Select";
import { closeTool, saveNewLogin, type SessionData } from "../../store";
import { GeneratorInForm } from "../GeneratorPanel";
import type { FolderEntry } from "../SideMenu";

/** The Folder list's value for "No folder": never an item's id, which is 32 hex characters. */
const NO_FOLDER = "none";

/**
 * The folders to pick from: the one on screen first, then the rest by name, and "No folder" last, or first when All items is
 * on screen (nothing is the one on screen then).
 */
function folderChoices(folders: readonly FolderEntry[], onScreen: string | null): SelectChoice[] {
  const named = folders.map((folder) => ({ value: folder.id, label: folder.name }));
  const none = { value: NO_FOLDER, label: "No folder" };
  if (onScreen === null) return [none, ...named];
  const first = named.filter((choice) => choice.value === onScreen);
  return [...first, ...named.filter((choice) => choice.value !== onScreen), none];
}

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
  const titleBox = useRef<HTMLInputElement>(null);
  const passwordBox = useRef<HTMLInputElement>(null);

  // Focus goes to the title when the form opens. A menu or the search that opened it gives focus back to its own button as
  // it closes, which can come after this, so it is taken once more a moment later if it has gone elsewhere.
  useEffect(() => {
    titleBox.current?.focus();
    const again = window.setTimeout(() => {
      if (document.activeElement === document.body || document.activeElement?.closest(".addb") != null) {
        titleBox.current?.focus();
      }
    }, 0);
    return () => {
      window.clearTimeout(again);
    };
  }, []);

  const folderName = folders.find((entry) => entry.id === folder)?.name;
  const subtitle = folderName === undefined ? `In ${data.name}.` : `In ${folderName}, ${data.name}.`;

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
    setProblem(words.body === "" ? words.title : `${words.title} ${words.body}`);
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
