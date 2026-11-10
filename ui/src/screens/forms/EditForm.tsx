import { useEffect, useId, useRef, useState, type SyntheticEvent } from "react";
import type { ItemDetail, ItemEdit, ItemSummary } from "../../api";
import { messageFor } from "../../messages";
import { Button } from "../../parts/Button";
import { Panel } from "../../parts/Panel";
import { closeEdit, revealForEdit, saveEdit, type SessionData } from "../../store";
import { GeneratorInForm } from "../GeneratorPanel";
import type { FolderEntry } from "../SideMenu";
import { NAME_RULE, refusedTheName } from "./KeyForm";
import { hasInnerLineBreak, NO_FOLDER, PASSWORD_MANY_LINES, useFocusOnOpen, whereWords } from "./shared";
import { hasLineBreak, MANY_LINES, ValueField } from "./ValueField";

/** What a form says under a Password or Value box it left empty because the stored value has a line break inside it. */
const MORE_THAN_ONE_LINE =
  "This value has more than one line, so it isn't shown here. Leave the box empty to keep it, or type a new one.";

/** A box's text: what was typed, or what the item has until something is typed. `changed` is whether it differs from what the item has. */
function useText(stored: string) {
  const [typed, setTyped] = useState<string | null>(null);
  return { value: typed ?? stored, set: setTyped, changed: typed !== null && typed !== stored };
}

/** The stored password or key's value, as the shell gave it for this form. */
type Stored = { phase: "loading" } | { phase: "ready"; value: string } | { phase: "failed"; error: unknown };

/**
 * Asks Rust for the stored password or key's value as the form opens (`has`: there is one), and holds it in this form's state
 * alone. An answer for a form that is gone (Cancel, a lock, another item or form) never arrives here: the store answers "gone"
 * for it, and the form is unmounted by then too.
 */
function useStoredSecret(session: number, id: string, field: "password" | "key_value", has: boolean): Stored {
  const [stored, setStored] = useState<Stored>(has ? { phase: "loading" } : { phase: "ready", value: "" });
  useEffect(() => {
    if (!has) return;
    let alive = true;
    void revealForEdit(session, id, field).then((answer) => {
      if (!alive || answer === "gone") return;
      setStored("failed" in answer ? { phase: "failed", error: answer.failed } : { phase: "ready", value: answer.value });
    });
    return () => {
      alive = false;
    };
  }, [session, id, field, has]);
  return stored;
}

/**
 * The Edit form of an item, in the side panel in place of its details: Edit login (11a), Edit key (7a's fields), Edit note
 * (7b's) and Edit file (10f: its title and note only). What the form needs of the item (a login's password, a key's value) is
 * asked of Rust when it opens and held only here. It sends a field only when it was changed: one that was not stays as stored,
 * byte for byte. That matters most for a value with a line break inside, which a one-line box cannot hold (it would drop the
 * break): such a box stays empty, says why, and sends nothing unless something is typed in it. Cancel changes nothing, and a
 * lock takes the form and says nothing. Saving opens the details again with "Saved", and focus on Edit.
 */
export function EditForm({
  data,
  folders,
  summary,
  detail,
}: {
  data: SessionData;
  folders: readonly FolderEntry[];
  summary: ItemSummary;
  detail: ItemDetail;
}) {
  const formId = useId();
  const isLogin = summary.kind === "login";
  const isKey = summary.kind === "key";
  const title = useText(summary.title);
  const username = useText(summary.username ?? "");
  const website = useText(detail.urls[0] ?? "");
  const notes = useText(detail.notes);
  const stored = useStoredSecret(data.session, summary.id, isLogin ? "password" : "key_value", isLogin ? detail.has_password : isKey ? detail.has_value : false);
  // A stored value a one-line box cannot hold is not put in it: the box stays empty, and typing in it replaces the value.
  const multiLine = stored.phase === "ready" && hasLineBreak(stored.value);
  const secret = useText(stored.phase === "ready" && !multiLine ? stored.value : "");
  const ready = stored.phase === "ready";

  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  /** The title (or the key's name) is empty, or the shell refused it, and Save was pressed: the box is marked. */
  const [titleMarked, setTitleMarked] = useState(false);
  /** The words now under the fields are a refused paste's (they clear on the next change or a clean paste). */
  const [pasteRefused, setPasteRefused] = useState(false);
  const titleBox = useRef<HTMLInputElement>(null);
  const passwordBox = useRef<HTMLInputElement>(null);

  useFocusOnOpen(titleBox);

  const sayInstead = (words: string | null) => {
    setProblem(words);
    setPasteRefused(false);
  };

  /** Reads what is being pasted or dropped into the Password box before it does; stops it, and says why, if it would be changed silently. */
  const checkPassword = (text: string, event: { preventDefault: () => void }) => {
    if (hasInnerLineBreak(text)) {
      event.preventDefault();
      setProblem(PASSWORD_MANY_LINES);
      setPasteRefused(true);
      setTitleMarked(false);
    } else if (pasteRefused) {
      sayInstead(null);
    }
  };

  const cancel = () => {
    closeEdit(data.session);
  };

  const save = async (event: SyntheticEvent) => {
    event.preventDefault();
    if (saving) return;
    if (title.value.trim() === "") {
      sayInstead(isKey ? "Type a name first." : "Type a title first.");
      setTitleMarked(true);
      titleBox.current?.focus();
      return;
    }
    setSaving(true);
    sayInstead(null);
    setTitleMarked(false);
    // The title, the notes and the folder always go (the shell wants them, and a folder left out would take the item out of
    // it); each of the rest only when it was changed.
    const edit: ItemEdit = {
      id: summary.id,
      revision: detail.revision,
      title: title.changed ? title.value.trim() : summary.title,
      notes: notes.changed ? notes.value : detail.notes,
      collection: summary.collection,
    };
    if (isLogin) {
      if (username.changed) edit.username = username.value;
      if (secret.changed) edit.password = secret.value;
      if (website.changed) {
        // The first website is the one in the box; any others are kept.
        const typed = website.value.trim();
        const others = detail.urls.slice(1);
        edit.urls = typed === "" ? others : [typed, ...others];
      }
    }
    if (isKey && secret.changed) edit.key_value = secret.value;
    const done = await saveEdit(data.session, edit);
    // Saved or locked: the form is already gone, and there is nothing to say.
    if (typeof done !== "object") return;
    const words = messageFor(done.failed);
    sayInstead(words.body === "" ? words.title : `${words.title} ${words.body}`);
    setTitleMarked(isKey && refusedTheName(done.failed));
    setSaving(false);
  };

  const heading = `Edit ${summary.kind}`;
  const loadProblem = stored.phase === "failed" ? messageFor(stored.error) : null;
  const secretHint = multiLine ? `${formId}-secret-hint` : undefined;
  // What the Note box is called: a note's own text is its Text, a login's, key's or file's extra words are its Note.
  const noteLabel = summary.kind === "note" ? "Text" : "Note";
  const showNotes = summary.kind !== "key" || detail.notes !== "";

  return (
    <Panel
      title={heading}
      subtitle={whereWords(folders, summary.collection ?? NO_FOLDER, data.name)}
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
            {isKey ? "Name" : "Title"}
          </label>
          <input
            ref={titleBox}
            id={`${formId}-title`}
            className={isKey ? "finp m" : "finp"}
            type="text"
            autoComplete="off"
            spellCheck={false}
            value={title.value}
            aria-invalid={titleMarked ? true : undefined}
            aria-describedby={[isKey ? `${formId}-name-hint` : null, titleMarked ? `${formId}-problem` : null].filter(Boolean).join(" ") || undefined}
            onChange={(event) => {
              title.set(event.currentTarget.value);
            }}
          />
          {isKey ? (
            <p className="fhint" id={`${formId}-name-hint`}>
              {NAME_RULE}
            </p>
          ) : null}
        </div>
        {isLogin ? (
          <>
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
                value={username.value}
                onChange={(event) => {
                  username.set(event.currentTarget.value);
                }}
              />
            </div>
            <div className="fbox">
              <div className="flrow">
                <label className="flab" htmlFor={`${formId}-password`}>
                  Password
                </label>
                <Button
                  aria-expanded={generating}
                  disabled={!ready}
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
                // Readable while editing, as drawn (11a): plain text, so a native copy or cut aimed at it is stopped (it
                // would skip the clipboard's marks, timer and clearing), like a key's Value box when it is shown.
                type="text"
                autoComplete="off"
                spellCheck={false}
                value={secret.value}
                disabled={!ready}
                aria-busy={stored.phase === "loading" ? true : undefined}
                aria-describedby={secretHint}
                onChange={(event) => {
                  secret.set(event.currentTarget.value);
                  if (pasteRefused) sayInstead(null);
                }}
                onPaste={(event) => {
                  checkPassword(event.clipboardData.getData("text"), event);
                }}
                onDrop={(event) => {
                  checkPassword(event.dataTransfer.getData("text"), event);
                }}
                onCopy={(event) => {
                  event.preventDefault();
                }}
                onCut={(event) => {
                  event.preventDefault();
                }}
                // The readable text cannot be dragged out either, which would skip the clipboard's marks, timer and clearing.
                onDragStart={(event) => {
                  event.preventDefault();
                }}
              />
              {multiLine ? (
                <p className="fhint" id={secretHint}>
                  {MORE_THAN_ONE_LINE}
                </p>
              ) : null}
            </div>
            {generating ? (
              <GeneratorInForm
                onUse={(value) => {
                  secret.set(value);
                  setGenerating(false);
                  passwordBox.current?.focus();
                }}
              />
            ) : null}
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
                value={website.value}
                onChange={(event) => {
                  website.set(event.currentTarget.value);
                }}
              />
              <p className="fhint" id={`${formId}-website-hint`}>
                https:// is added on save if it&apos;s missing.
              </p>
            </div>
          </>
        ) : null}
        {isKey ? (
          <ValueField
            id={`${formId}-value`}
            value={secret.value}
            onChange={secret.set}
            onRefused={() => {
              setProblem(MANY_LINES);
              setPasteRefused(true);
              setTitleMarked(false);
            }}
            onAccepted={() => {
              if (pasteRefused) {
                setProblem(null);
                setPasteRefused(false);
              }
            }}
            disabled={!ready}
            busy={stored.phase === "loading"}
            describedBy={secretHint}
          >
            {multiLine ? (
              <p className="fhint" id={secretHint}>
                {MORE_THAN_ONE_LINE}
              </p>
            ) : null}
          </ValueField>
        ) : null}
        {showNotes ? (
          <div className="fbox">
            <label className="flab" htmlFor={`${formId}-notes`}>
              {noteLabel}
            </label>
            <textarea
              id={`${formId}-notes`}
              className="finp farea"
              rows={summary.kind === "note" ? 6 : 3}
              autoComplete="off"
              spellCheck={false}
              value={notes.value}
              onChange={(event) => {
                notes.set(event.currentTarget.value);
              }}
            />
          </div>
        ) : null}
        {loadProblem === null ? null : (
          <p className="err" role="alert">
            {loadProblem.body === "" ? loadProblem.title : `${loadProblem.title} ${loadProblem.body}`}
          </p>
        )}
        {problem === null ? null : (
          <p className="err" id={`${formId}-problem`} role="alert">
            {problem}
          </p>
        )}
      </form>
    </Panel>
  );
}
