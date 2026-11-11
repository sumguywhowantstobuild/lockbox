import { useEffect, useId, useRef, useState, type KeyboardEvent, type SyntheticEvent } from "react";
import { focusButton, focusList } from "../../focus";
import { messageFor } from "../../messages";
import { Button } from "../../parts/Button";
import { Dialog } from "../../parts/Dialog";
import {
  addFolder,
  deleteFolderOnScreen,
  readFolder,
  renameFolder,
  selectFolder,
} from "../../store";

/** What a form says when a folder's name has nothing in it. */
const NAME_FIRST = "Type a name first.";

/** A refusal in one line of words, as a box under a field says it. */
function wordsOf(error: unknown): string {
  const words = messageFor(error);
  return words.body === "" ? words.title : `${words.title} ${words.body}`;
}

/** The folder's menu button, which the folder's dialogs give focus back to. */
const FOLDER_MENU = '[aria-label="More for this folder"]';

/**
 * The name box that "New folder" becomes in the side menu (14a): one line, focus in it, spoken as "New folder name". Enter saves,
 * Escape cancels, and so does leaving it empty (Enter on nothing, or on spaces, too). A refused name is said in words under the box
 * and the box keeps what was typed; the next change takes the words away. The made folder opens at once (a person makes a folder
 * to put something in it), and focus goes to it in the side menu. A lock takes the box with whatever was typed and says nothing.
 * An answer that comes after the box has gone (cancelled, or a lock) opens nothing.
 */
export function NewFolderBox({ session, onDone }: { session: number; onDone: () => void }) {
  const id = useId();
  const [name, setName] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const box = useRef<HTMLInputElement>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    box.current?.focus();
    return () => {
      alive.current = false;
    };
  }, []);

  const save = async () => {
    if (saving) return;
    const typed = name.trim();
    // Nothing typed is nothing to save: the box goes, as Escape would, and focus goes back to New folder with it.
    if (typed === "") {
      onDone();
      focusButton(".rail .newf");
      return;
    }
    setSaving(true);
    setProblem(null);
    const done = await addFolder(session, typed);
    if (!alive.current) return;
    if (done === "stale") {
      onDone();
      return;
    }
    if ("failed" in done) {
      setProblem(wordsOf(done.failed));
      setSaving(false);
      box.current?.focus();
      return;
    }
    selectFolder(session, done.made);
    onDone();
    focusButton('.rail .projs [aria-current="page"]');
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void save();
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onDone();
      focusButton(".rail .newf");
    }
  };

  return (
    <div className="nfold">
      <input
        ref={box}
        className="finp nfin"
        type="text"
        aria-label="New folder name"
        autoComplete="off"
        spellCheck={false}
        value={name}
        aria-invalid={problem === null ? undefined : true}
        aria-describedby={problem === null ? undefined : `${id}-problem`}
        onChange={(event) => {
          setName(event.currentTarget.value);
          setProblem(null);
        }}
        onKeyDown={onKeyDown}
        onBlur={() => {
          // Leaving the box while it is empty cancels; with something typed it stays, so nothing typed is lost to a stray click.
          if (name.trim() === "" && !saving) onDone();
        }}
      />
      {problem === null ? null : (
        <p className="err" id={`${id}-problem`} role="alert">
          {problem}
        </p>
      )}
    </div>
  );
}

/**
 * Rename folder (14c): a dialog with the box "Folder name" holding the current name, Cancel and Rename. It reads the folder as it
 * opens, so the revision it sends is the one the folder had then: a change made meanwhile makes the rename stale, which is said in
 * words and changes nothing. Enter in the box renames. Focus goes back to the folder's menu button when it closes.
 */
export function RenameFolderDialog({
  session,
  folder,
  onClose,
}: {
  session: number;
  folder: { id: string; name: string };
  onClose: () => void;
}) {
  const formId = useId();
  const [typed, setTyped] = useState(folder.name);
  const [read, setRead] = useState<{ revision: number; notes: string } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const box = useRef<HTMLInputElement>(null);
  // Whether this dialog is still on screen. An answer that comes after it was cancelled (or a newer question took its place)
  // does nothing: it must not close, or say anything in, a dialog that is not the one that asked.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    void readFolder(session, folder.id).then((answer) => {
      if (!alive || answer === "stale") return;
      if ("failed" in answer) setProblem(wordsOf(answer.failed));
      else setRead(answer);
    });
    return () => {
      alive = false;
    };
  }, [session, folder.id]);

  const close = () => {
    onClose();
    focusButton(FOLDER_MENU, focusList);
  };

  const submit = async (event: SyntheticEvent) => {
    event.preventDefault();
    if (saving) return;
    const name = typed.trim();
    if (name === "") {
      setProblem(NAME_FIRST);
      box.current?.focus();
      return;
    }
    if (read === null) return;
    setSaving(true);
    setProblem(null);
    const done = await renameFolder(session, folder.id, read, name);
    // Locked, or cancelled meanwhile: the dialog is gone, and there is nothing to say or close.
    if (done === "stale" || !mounted.current) return;
    if (typeof done === "object") {
      setProblem(wordsOf(done.failed));
      setSaving(false);
      return;
    }
    close();
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
      title="Rename folder"
      initialFocus={box}
      body={
        <form id={formId} onSubmit={(event) => void submit(event)} noValidate>
          <label className="flab" htmlFor={`${formId}-name`}>
            Folder name
          </label>
          <input
            ref={box}
            id={`${formId}-name`}
            className="finp"
            type="text"
            autoComplete="off"
            spellCheck={false}
            value={typed}
            aria-invalid={problem === null ? undefined : true}
            aria-describedby={problem === null ? undefined : `${formId}-problem`}
            onFocus={(event) => {
              event.currentTarget.select();
            }}
            onChange={(event) => {
              setTyped(event.currentTarget.value);
              setProblem(null);
            }}
          />
          {problem === null ? null : (
            <p className="err" id={`${formId}-problem`} role="alert">
              {problem}
            </p>
          )}
        </form>
      }
    >
      <Button onClick={close}>Cancel</Button>
      <Button look="pill-main" type="submit" form={formId} aria-disabled={saving || read === null ? true : undefined}>
        Rename
      </Button>
    </Dialog>
  );
}

/**
 * Delete folder (14d): asks first, and says how many items go to the Trash with it ("Its 3 items move to Trash, and you can
 * restore them from there."; one: "Its 1 item moves to Trash, and you can restore it from there."; none: "It has no items."). Cancel
 * has focus, changes nothing and gives focus back to the folder's menu. Delete closes the question and goes: the view moves to All
 * items and "Moved to Trash" shows with Undo.
 */
export function DeleteFolderDialog({
  session,
  folder,
  count,
  onClose,
}: {
  session: number;
  folder: { id: string; name: string };
  /** How many items are in the folder now: what goes with it. */
  count: number;
  onClose: () => void;
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  const words =
    count === 0
      ? "It has no items."
      : count === 1
        ? "Its 1 item moves to Trash, and you can restore it from there."
        : `Its ${String(count)} items move to Trash, and you can restore them from there.`;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          onClose();
          focusButton(FOLDER_MENU, focusList);
        }
      }}
      title={`Delete ${folder.name}?`}
      description={words}
      initialFocus={cancel}
    >
      <Button
        ref={cancel}
        onClick={() => {
          onClose();
          focusButton(FOLDER_MENU, focusList);
        }}
      >
        Cancel
      </Button>
      <Button
        className="dngb"
        onClick={() => {
          onClose();
          void deleteFolderOnScreen(session, folder.id);
        }}
      >
        Delete
      </Button>
    </Dialog>
  );
}
