import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import type { EnvChoice, EnvRow, EnvRows } from "../api";
import { focusBack } from "../focus";
import { messageFor, messageText } from "../messages";
import { Button } from "../parts/Button";
import { CloseIcon } from "../parts/Icon";
import { Panel } from "../parts/Panel";
import { Select } from "../parts/Select";
import { closeTool, readEnv, refusedAsEnvGone, releaseEnv, saveEnv, type SessionData } from "../store";
import { ClearClipboardBox } from "./forms/ClearClipboard";
import { folderChoices, NO_FOLDER, useFocusOnOpen } from "./forms/shared";
import type { FolderEntry } from "./SideMenu";

/** What a clashing row does when it is saved: put its value in the key that is there, or save beside it under another name. */
type Pick = "replace" | "keep_both";

/** What the panel says when the shell no longer holds the pasted values (five minutes, or a lock): the person pastes again. */
const LET_GO = "Lockbox let go of the pasted keys after 5 minutes. Paste the .env again.";

const NOTHING_FOUND = "No keys were found in what you pasted.";

/** "3 keys", "1 key". */
function keysWords(count: number): string {
  return `${String(count)} ${count === 1 ? "key" : "keys"}`;
}

/**
 * Which lines could not be read, by number and never by what they said: "Line 4 can't be read, so it was left out. Check it in your
 * .env." For several, "Lines 4 and 9 …", "Lines 4, 9 and 12 …"; up to five numbers, then "and N more".
 */
function badLinesWords(lines: readonly number[]): string {
  if (lines.length === 1) return `Line ${String(lines[0])} can't be read, so it was left out. Check it in your .env.`;
  const shown = lines.slice(0, 5).map(String);
  const more = lines.length - shown.length;
  const last = more > 0 ? `${String(more)} more` : shown.pop();
  const list = shown.length === 0 ? String(last) : `${shown.join(", ")} and ${String(last)}`;
  return `Lines ${list} can't be read, so they were left out. Check them in your .env.`;
}

/**
 * Paste a .env (15a to 15c), in the panel. The text goes from the paste itself to Rust, once, and never rests anywhere on the page:
 * the box stays empty (typed characters, a drop and a change are not taken, a paste is stopped before it can land), and what comes
 * back is names only. The rows (15b) show each key's name with its value hidden and no way to show it, a button to leave a row out,
 * and, once, the Folder. A line that could not be read is said by its number (15c). A name already in the chosen folder, or earlier
 * in the paste, is marked "Already here" and asks what to do (Replace to start with, Keep both, Cancel); changing the folder works the
 * marks out again from what Rust sent with the rows, and sends nothing.
 *
 * The values wait in Rust under a token (five minutes, or until the vault locks). Cancel, the panel's close, Escape and another tool
 * taking the panel all end the same way, when this component goes: a save of every row as "leave out", sent without waiting, so Rust
 * lets go at once. A lock sends nothing: the vault is gone, and the lock let go already. An answer to a read that comes after the
 * panel went, or after a newer paste, is dropped, and its token let go the same way. A refusal of the save is said in the panel,
 * and the panel goes back to the empty box (a save cut short can have written some, so the list is read again).
 *
 * "Clear the clipboard after saving" (15b) is on to begin with: it is sent with the save, and Rust clears the clipboard after the keys are
 * written, only if it still holds the pasted text. The message after a save says what became of it.
 *
 * A panel opened on a copy that the save box read in Rust (`initialRows`, `initialFolder`) shows those rows as if they had been pasted, with no
 * paste box. Its values wait under the rows' token like any paste's, and are let go the same way when the panel goes.
 */
export function EnvPaste({
  data,
  folders,
  initialRows,
  initialFolder,
}: {
  data: SessionData;
  folders: readonly FolderEntry[];
  initialRows?: EnvRows;
  initialFolder?: string;
}) {
  const id = useId();
  const [found, setFound] = useState<EnvRows | null>(initialRows ?? null);
  const [clear, setClear] = useState(true);
  /** The rows left out, by index. */
  const [left, setLeft] = useState<number[]>([]);
  /** What each clashing row was told to do in the folder chosen now, by index (a row not here starts on Replace). */
  const [picks, setPicks] = useState<Record<number, Pick>>({});
  const [folder, setFolder] = useState(initialFolder ?? data.folder ?? NO_FOLDER);
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [reading, setReading] = useState(false);
  /** Where focus goes after a row leaves: the next one's button, or Cancel when none is left. Each change is a new object. */
  const [focusAfter, setFocusAfter] = useState<{ row: number | null } | null>(null);
  /** Counts the times the empty box came back after a refusal, so focus goes to it each time. */
  const [boxBack, setBoxBack] = useState(0);
  const box = useRef<HTMLTextAreaElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const leaveButtons = useRef(new Map<number, HTMLButtonElement>());
  /** The token the values wait under and the rows it covers, from the answer that is on screen until it is used up or let go. */
  const held = useRef<{ token: string; indexes: number[] } | null>(
    initialRows?.token == null ? null : { token: initialRows.token, indexes: initialRows.rows.map((row) => row.index) },
  );
  /** The number of the latest paste: an older answer is late. */
  const run = useRef(0);
  const mounted = useRef(true);

  useFocusOnOpen(box);

  // The panel going, however it goes (Cancel, its close, Escape, another tool, the folder's menu): let Rust forget the values.
  const { session, generation } = data;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const waiting = held.current;
      held.current = null;
      if (waiting === null) return;
      if (initialRows === undefined) {
        releaseEnv(session, generation, waiting.token, waiting.indexes);
        return;
      }
      // Opened on rows that were waiting already: React runs an effect's cleanup and its setup again as a trial in development, with this same
      // panel, and that must not let the values go. A panel still gone a moment later has left, and lets them go.
      window.setTimeout(() => {
        if (mounted.current) held.current = waiting;
        else releaseEnv(session, generation, waiting.token, waiting.indexes);
      }, 0);
    };
  }, [session, generation, initialRows]);

  useEffect(() => {
    if (boxBack > 0) box.current?.focus();
  }, [boxBack]);

  // The rows came and the box that had focus went: focus goes to the results heading ("3 keys found"), so it is read, and the page
  // does not get it. A sentence about lines that could not be read is the heading's description, so it is read with it.
  useEffect(() => {
    if (found !== null && found.rows.length > 0) heading.current?.focus();
  }, [found]);

  useEffect(() => {
    if (focusAfter === null) return;
    const target = focusAfter.row === null ? undefined : leaveButtons.current.get(focusAfter.row);
    (target ?? cancel.current)?.focus();
  }, [focusAfter]);

  const rows: readonly EnvRow[] = found?.rows ?? [];
  const showRows = rows.length > 0;
  const place = folder === NO_FOLDER ? null : folder;
  // The rows that clash in the folder chosen: their number, and the name Keep both would use. A folder not listed has none.
  const clashes = new Map((found?.clashes.find((entry) => entry.collection === place)?.rows ?? []).map((clash) => [clash.index, clash.saved_as]));
  const kept = rows.filter((row) => !left.includes(row.index));
  const off = !showRows || kept.length === 0 || saving;

  const close = () => {
    closeTool(session);
    focusBack("add");
  };

  const read = async (text: string) => {
    run.current += 1;
    const mine = run.current;
    setProblem(null);
    setFound(null);
    setReading(true);
    const answer = await readEnv(session, text);
    // A lock: the panel goes with the vault, and nothing is said.
    if (answer === "stale") return;
    const current = mounted.current && mine === run.current;
    if ("failed" in answer) {
      if (current) {
        setProblem(messageText(messageFor(answer.failed)));
        setReading(false);
      }
      return;
    }
    const { token } = answer.rows;
    const indexes = answer.rows.rows.map((row) => row.index);
    if (!current) {
      // Late: the panel went, or a newer paste came. Nothing shows, and the values it holds are let go as Cancel would.
      if (token !== null) releaseEnv(session, generation, token, indexes);
      return;
    }
    held.current = token === null ? null : { token, indexes };
    setFound(answer.rows);
    setLeft([]);
    setPicks({});
    setReading(false);
  };

  const leaveOut = (index: number) => {
    const at = kept.findIndex((row) => row.index === index);
    const next = kept[at + 1] ?? kept[at - 1];
    setLeft([...left, index]);
    setFocusAfter({ row: next?.index ?? null });
  };

  const save = async () => {
    const waiting = held.current;
    if (off || waiting === null) return;
    // One choice for every row: a plain save, the pick of a clashing one, or leave out.
    const choices = rows.map((row): EnvChoice => {
      if (left.includes(row.index)) return { index: row.index, action: "leave_out" };
      return clashes.has(row.index) ? { index: row.index, action: picks[row.index] ?? "replace" } : { index: row.index, action: "save" };
    });
    // The token is used up by this save whatever it answers, so the panel has nothing left to let go of.
    held.current = null;
    setSaving(true);
    setProblem(null);
    const where = folders.find((entry) => entry.id === place)?.name ?? "No folder";
    const done = await saveEnv(session, waiting.token, choices, place, where, clear, () => mounted.current);
    if (done === "stale") return;
    if ("saved" in done) {
      // The store closed this panel as the save ended, and it was still the one on screen: focus goes back to where it was opened
      // from, as Cancel does it. A panel the person closed or left meanwhile is not asked for focus.
      if (done.closed) focusBack("add");
      return;
    }
    if (!mounted.current) return;
    if ("failed" in done) {
      // Forget the rows and the token, and go back to the empty box: the person pastes again.
      setProblem(refusedAsEnvGone(done.failed) ? LET_GO : messageText(messageFor(done.failed)));
      setFound(null);
      setLeft([]);
      setPicks({});
      setSaving(false);
      setBoxBack(boxBack + 1);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    // Escape in the folder list (or any list or menu open from here) closes that and nothing more.
    const from = event.target instanceof Element ? event.target : null;
    if (from?.closest('[role="listbox"], [role="menu"], [aria-expanded="true"]') != null) return;
    close();
  };

  return (
    <Panel
      title="Paste a .env"
      onClose={close}
      onKeyDown={onKeyDown}
      footer={
        <>
          <Button ref={cancel} onClick={close}>
            Cancel
          </Button>
          <Button
            look="pill-main"
            aria-disabled={off ? true : undefined}
            onClick={() => {
              void save();
            }}
          >
            {showRows && kept.length > 0 ? `Save ${keysWords(kept.length)}` : "Save"}
          </Button>
        </>
      }
    >
      {problem === null ? null : (
        <p className="err" role="alert">
          {problem}
        </p>
      )}
      {found !== null && !showRows ? (
        <p className="err" role="alert">
          {NOTHING_FOUND}
        </p>
      ) : null}
      {found !== null && found.bad_lines.length > 0 ? (
        <p className="err" id={`${id}-bad`} role="alert">
          {badLinesWords(found.bad_lines)}
        </p>
      ) : null}
      {showRows ? (
        <>
          <section className="gp">
            <h3
              ref={heading}
              tabIndex={-1}
              className="gh"
              aria-describedby={found !== null && found.bad_lines.length > 0 ? `${id}-bad` : undefined}
            >
              {`${keysWords(rows.length)} found`}
            </h3>
            {kept.length === 0 ? (
              <p className="note">Every key was left out.</p>
            ) : (
              <ul className="grp erows">
                {kept.map((row) => {
                  const savedAs = clashes.get(row.index);
                  const pick = picks[row.index] ?? "replace";
                  return (
                    <li key={row.index} className="erow">
                      <span className="en m">{row.name}</span>
                      <span className="ed" role="img" aria-label="Value hidden">
                        ••••••
                      </span>
                      <button
                        type="button"
                        className="ex"
                        aria-label={`Leave out ${row.name}`}
                        ref={(button) => {
                          if (button === null) leaveButtons.current.delete(row.index);
                          else leaveButtons.current.set(row.index, button);
                        }}
                        onClick={() => {
                          leaveOut(row.index);
                        }}
                      >
                        <CloseIcon />
                      </button>
                      {savedAs === undefined ? null : (
                        <div className="econf">
                          <span>Already here</span>
                          <div className="segs" role="group" aria-label="What to do with this key">
                            <button
                              type="button"
                              className="seg"
                              aria-pressed={pick === "replace"}
                              onClick={() => {
                                setPicks({ ...picks, [row.index]: "replace" });
                              }}
                            >
                              Replace
                            </button>
                            <button
                              type="button"
                              className="seg"
                              aria-pressed={pick === "keep_both"}
                              onClick={() => {
                                setPicks({ ...picks, [row.index]: "keep_both" });
                              }}
                            >
                              Keep both
                            </button>
                            <button
                              type="button"
                              className="seg"
                              onClick={() => {
                                leaveOut(row.index);
                              }}
                            >
                              Cancel
                            </button>
                          </div>
                          {pick === "keep_both" ? <span className="eas">{`Saves as ${savedAs}`}</span> : null}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
          <div className="fbox">
            <Select
              label="Folder"
              items={folderChoices(folders, data.folder)}
              value={folder}
              onValueChange={(next) => {
                // The marks are worked out afresh for a new folder, from what Rust already sent: no call, and every clash starts on
                // Replace. The folder already chosen, chosen again, is no change, and the picks stay as they were.
                if (next === folder) return;
                setFolder(next);
                setPicks({});
              }}
            />
          </div>
          <ClearClipboardBox checked={clear} onChange={setClear} />
        </>
      ) : (
        <div className="fbox">
          <label className="flab" htmlFor={`${id}-box`}>
            Paste your .env here
          </label>
          <textarea
            ref={box}
            id={`${id}-box`}
            className="finp m farea"
            rows={8}
            spellCheck={false}
            autoComplete="off"
            placeholder="NAME=value"
            aria-describedby={`${id}-hint`}
            aria-busy={reading ? true : undefined}
            // Always empty: what is pasted goes to Rust at once, and typed characters, a change or a drop are not taken.
            value=""
            onChange={() => undefined}
            onPaste={(event) => {
              event.preventDefault();
              const text = event.clipboardData.getData("text");
              if (text !== "") void read(text);
            }}
            onDrop={(event) => {
              event.preventDefault();
            }}
          />
          <p className="fhint" id={`${id}-hint`}>
            What you paste is read into rows straight away, with the values hidden.
          </p>
        </div>
      )}
    </Panel>
  );
}
