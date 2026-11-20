import { useEffect, useId, useRef, useState, type KeyboardEvent, type SyntheticEvent } from "react";
import type { OnClash } from "../api";
import { focusBack } from "../focus";
import { useLockEpoch } from "../jobs";
import { messageFor, messageText } from "../messages";
import { Button } from "../parts/Button";
import { Dialog } from "../parts/Dialog";
import { Panel } from "../parts/Panel";
import { PasswordField } from "../parts/PasswordField";
import { Select } from "../parts/Select";
import {
  cancelCapture,
  captureAsEnv,
  chooseSaveVault,
  revealCapture,
  saveCapture,
  saveChoices,
  saveChoiceValue,
  settleSaveChoice,
  boxBlock,
  unlockInBox,
  useCapture,
  useSessions,
  useVaults,
  type SessionData,
} from "../store";
import { useValueGuard } from "../useValueGuard";
import { ClearClipboardBox } from "./forms/ClearClipboard";
import { NAME_RULE, refusedTheName } from "./forms/KeyForm";
import { folderChoices, NO_FOLDER } from "./forms/shared";
import { MANY_LINES, ValueField } from "./forms/ValueField";
import { foldersOf } from "./SideMenu";

/** What the box says at its top when a later press found a different value: what was typed stays. */
const CHANGED = "The copied value changed. What you typed is kept.";

/** What the box says when the clipboard held no text (an image, say), or more than a key can hold. */
const NOTHING_COPIED = "Nothing to save was copied. Paste or type the value here.";
const TOO_BIG = "What you copied is too big to save as a key. Paste or type the value here.";

/** What the unlock step in the box says under its password (8b's words). */
const LOCKED_RULE = "A locked vault's folders can't be read until you unlock it.";

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
 * state and nowhere else. It is made for one copy and one vault chosen (`key` is both where it is used): a new copy, another vault chosen, the copy
 * going, a lock and the panel closing all take this part away, and an answer that comes to a part that is gone is dropped, so a value never outlives
 * the copy it was asked for.
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
 * The save box (8a, and 8c when nothing was copied): what the shortcut copied, to be named and saved as a key. It is the app's, not a window's: it is mounted by its
 * copy above whichever screen is up and drawn over a vault's main window (`host` is that window, or `null` while another screen has it, when it draws nothing and
 * what is secret in it is wiped), so a lock of the vault under it, a switch, or the lock screen does not take it. The shell holds the copy and the page only its
 * id; the value comes on Show, to the row that asked. The order is the design's: the Vault to save into (the one on screen first, then every other vault that can take
 * a key), its password if it is locked (8b's content in the panel: nothing else is drawn until it is unlocked, and what was typed is kept), then Name, Folder (the
 * chosen vault's, since folders are encrypted) and "Clear the clipboard after saving", then Save. When the clipboard held no text, or too much, there is no
 * copied value to show: a Value box takes what is pasted or typed in its place (8c), and the clear does not apply. Save asks the shell once, which stops at a name that
 * is taken (8d: Replace, Keep both with the name it would use, Cancel). Saved, the box closes and says where it went; into the vault on screen the new key opens, into
 * another the window stays as it is. Cancel, the close button, Escape and another panel taking the window's place let the copy go. A new copy while the box is
 * open keeps what was typed and chosen and says the value changed. A lock of the vault chosen, or of every vault, or the shell letting the copy go, takes the box
 * with nothing said; a lock of any other vault leaves it.
 */
export function SaveBox({ host }: { host: SessionData | null }) {
  const capture = useCapture();
  const sessions = useSessions();
  const vaults = useVaults();
  const formId = useId();
  const [name, setName] = useState("");
  const [typed, setTyped] = useState("");
  /** The folder picked, and the vault it was picked in: a vault chosen after it takes the pick away. */
  const [picked, setPicked] = useState<{ vault: string; folder: string } | null>(null);
  const [clear, setClear] = useState(true);
  /** A save, an unlock, or the reading as a `.env`, is on its way: a second press does nothing. */
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [nameMarked, setNameMarked] = useState(false);
  /** The password of the locked vault chosen. It is the box's own state and nowhere else, wiped as it is sent. */
  const [password, setPassword] = useState("");
  const [unlockProblem, setUnlockProblem] = useState<string | null>(null);
  /**
   * The name that is taken, and the one Keep both would give, for the copy `captureId` and the vault `vault` (its value in the list): the question (8d) is open while
   * this is set and both are still the ones on screen. It is a question about one value in one vault; when another copy takes its place, or another vault is chosen,
   * it is gone, and Replace needs a fresh Save.
   */
  const [asked, setAsked] = useState<{ captureId: string; vault: string; name: string; savedAs: string } | null>(null);
  const nameBox = useRef<HTMLInputElement>(null);
  const valueBox = useRef<HTMLInputElement>(null);
  const passwordPlace = useRef<HTMLDivElement>(null);
  const mounted = useRef(true);
  const shown = useRef<string | null>(null);
  /** Focus went to the first field when the box was first drawn. */
  const focused = useRef(false);
  /** An unlock was sent from the box: the open look that follows takes focus to its first field. */
  const focusAfterUnlock = useRef(false);
  const wasClosed = useRef(false);
  const wasBlocked = useRef(false);
  const vaultPlace = useRef<HTMLDivElement>(null);
  /** The Vault list has the focus (or had it when it was made anew), so the box it is made again as gets it. */
  const vaultFocused = useRef(false);

  // Every lock epoch (Lock all, an idle lock, Windows locking or sleeping) wipes what is secret and typed here, even before the vaults' own locks are heard.
  const epoch = useLockEpoch();
  const [seenEpoch, setSeenEpoch] = useState(epoch);
  if (seenEpoch !== epoch) {
    setSeenEpoch(epoch);
    setPassword("");
    setTyped("");
  }
  // While another screen has the window the box is not drawn, and nothing secret waits in it: neither a typed password nor a typed key value.
  if (host === null && (password !== "" || typed !== "")) {
    setPassword("");
    setTyped("");
  }

  const front = sessions.at(-1);
  const kept = capture === null || capture.choice === null ? null : { choice: capture.choice, name: capture.choiceName ?? "" };
  const offered = saveChoices(front, sessions, vaults, kept);
  // The vault chosen, as the list has it. The box never moves the choice by itself: it is always on offer as its own entry (a locked choice whose vault has just opened
  // and is ready is the open session's entry for a moment, until the store settles it), and there is no other vault to fall back on.
  const chosenValue = kept === null ? "" : saveChoiceValue(kept.choice);
  // A vault is its list's identity and its ID together (a replaced list may give an ID to another vault).
  const keptLocked = kept?.choice.kind === "locked" ? kept.choice : null;
  const opened = keptLocked === null ? undefined : sessions.find((one) => one.vaultId === keptLocked.vault && one.vaultList === keptLocked.list);
  const current =
    kept === null
      ? undefined
      : (offered.find((one) => one.value === chosenValue) ??
        offered.find((one) => one.choice.kind === "open" && opened !== undefined && one.choice.session === opened.session));
  const currentValue = current?.value ?? "";
  // Why the chosen vault can't take the copy (read-only, waiting on a step, left the list or unavailable), on screen or behind: the box says it and offers no Save.
  const block = current === undefined ? null : boxBlock(current.choice, sessions, vaults);
  // A blocked vault has no password field and no name question: a password typed before it was blocked is gone with its field (it is not there when the vault comes
  // back), and a question about a name is closed (Replace and Keep both would save into a vault that can't take the key).
  if (block !== null && password !== "") setPassword("");
  if (block !== null && asked !== null) setAsked(null);

  // Another vault chosen: what was typed for the last one's password, and what was said about it, goes.
  const [seenChoice, setSeenChoice] = useState(currentValue);
  if (seenChoice !== currentValue) {
    setSeenChoice(currentValue);
    setPassword("");
    setUnlockProblem(null);
    setProblem(null);
    setNameMarked(false);
  }

  const drawn = host !== null;
  const ready = current !== undefined;
  // Asking for the password of a locked vault, or the open look; a blocked vault is neither (the Vault list and one line say why).
  const locked = current?.choice.kind === "locked" && block === null;
  const closed = current?.choice.kind !== "open" || block !== null;
  const hasValue = capture?.state === "value";
  const offersAgain = offered.map((one) => one.value).join(",");

  useEffect(() => {
    shown.current = capture?.id ?? null;
  });

  // The vaults on offer changed under the choice (one went unavailable, a window was switched): the store settles it, and hands the copy over again if it moved.
  useEffect(() => {
    settleSaveChoice();
  }, [offersAgain, currentValue]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Focus goes to the first field when the box is first drawn: the name when there is a copied value (the vault is already known), the Value box with nothing
  // copied, the password when the first vault is a locked one. A menu that opened the box gives focus back to its own button as it closes, which can come after
  // this, so it is taken once more a moment later if it has gone elsewhere.
  useEffect(() => {
    if (!drawn || !ready || focused.current) return;
    focused.current = true;
    const field = (): HTMLElement | null | undefined =>
      locked ? passwordPlace.current?.querySelector("input") : hasValue ? nameBox.current : valueBox.current;
    field()?.focus();
    const again = window.setTimeout(() => {
      if (document.activeElement === document.body || document.activeElement?.closest('.addb, [aria-label="More for this folder"]') != null) field()?.focus();
    }, 0);
    return () => {
      window.clearTimeout(again);
    };
  }, [drawn, ready, locked, hasValue]);

  // The vault was unlocked in the box: the open look comes back, and its first field takes focus.
  useEffect(() => {
    const unlockedNow = wasClosed.current && !closed;
    wasClosed.current = closed;
    if (!unlockedNow || !focusAfterUnlock.current || !drawn) return;
    focusAfterUnlock.current = false;
    (hasValue ? nameBox : valueBox).current?.focus();
  }, [closed, drawn, hasValue]);

  // The Vault list is made anew when the vaults on offer change, and keyboard focus that was on the old one goes to the new one.
  const selectKey = offered
    .map((one) => one.value)
    .sort()
    .join(",");
  useEffect(() => {
    if (!vaultFocused.current) return;
    const active = document.activeElement;
    if (active === null || active === document.body) vaultPlace.current?.querySelector<HTMLElement>('[role="combobox"]')?.focus();
  }, [selectKey]);

  // A blocked state takes the password field or the open look's fields away: focus that was in one of them (it is on the page's body now) goes to the Vault list, which
  // is what the line under it is about. Focus that is somewhere else is left there.
  useEffect(() => {
    const entered = block !== null && !wasBlocked.current;
    wasBlocked.current = block !== null;
    if (!entered || !drawn) return;
    const active = document.activeElement;
    if (active === null || active === document.body) vaultPlace.current?.querySelector<HTMLElement>('[role="combobox"]')?.focus();
  }, [block, drawn]);

  if (capture === null || current === undefined || host === null) return null;

  const choice = current.choice;
  const chosenSession = choice.kind === "open" ? sessions.find((entry) => entry.session === choice.session) : undefined;
  if (block === null && choice.kind === "open" && chosenSession === undefined) return null;
  const blockWords =
    block === null
      ? null
      : block === "read_only"
        ? // The existing words, after the vault's name: the alert is read alone by a screen reader, and has to say which vault (the session's form, for Ariel to change).
          `${current.name}: ${messageText(messageFor({ code: "read_only" }))}`
        : block === "step"
          ? `${current.name} needs a step before it can be used. Switch to it to finish, then save.`
          : `${current.name} can't be reached now. Choose another vault.`;

  // The vault on screen is the one the window's own folder and the `.env` offer belong to.
  const onScreen = chosenSession?.session === host.session;
  const folders = foldersOf(chosenSession?.items ?? []);
  // A folder that has gone while the box was open is no longer a choice: the save goes to no folder unless another is picked. Before one is picked, the vault on
  // screen starts on the folder shown, and another vault on "No folder".
  const start = onScreen ? (host.folder ?? NO_FOLDER) : NO_FOLDER;
  const wanted = picked?.vault === currentValue ? picked.folder : start;
  const folder = wanted === NO_FOLDER || folders.some((entry) => entry.id === wanted) ? wanted : NO_FOLDER;
  const place = folder === NO_FOLDER ? null : folder;
  const vaultName = chosenSession?.name ?? "";
  const folderName = folders.find((entry) => entry.id === place)?.name;
  // What the message after the save says: the vault on screen as ever ("<name> saved in <folder>", or in the vault with no folder); another vault is named too.
  const where = onScreen ? (folderName ?? vaultName) : folderName === undefined ? vaultName : `${folderName}, ${vaultName}`;
  const clash = asked !== null && block === null && asked.captureId === capture.id && asked.vault === currentValue ? asked : null;

  const cancel = () => {
    cancelCapture();
    focusBack("add");
  };

  const choose = (value: string) => {
    const next = offered.find((one) => one.value === value);
    if (next === undefined) return;
    focusAfterUnlock.current = false;
    chooseSaveVault(next.choice);
  };

  const save = async (onClash: OnClash) => {
    if (busy || chosenSession === undefined) return;
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
    const sentIn = currentValue;
    const done = await saveCapture(
      chosenSession.session,
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
      setAsked({ captureId: sentFor, vault: sentIn, name: trimmed, savedAs: done.clash });
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
    const done = await captureAsEnv(host.session, capture.id, folder);
    if (!mounted.current) return;
    setBusy(false);
    if (typeof done === "object") setProblem(messageText(messageFor(done.failed)));
  };

  // The unlock for the vault chosen: the text goes once, and is gone from here as it goes, so the field is empty whatever comes back (a wrong password shows an
  // empty field with the reason). The vault opens behind the window on screen, and the box goes on in it.
  const unlockHere = async () => {
    if (busy || password === "" || choice.kind !== "locked") return;
    const text = password;
    setPassword("");
    setUnlockProblem(null);
    setBusy(true);
    focusAfterUnlock.current = true;
    try {
      await unlockInBox(capture.opening, choice, text);
    } catch (refusal) {
      focusAfterUnlock.current = false;
      if (mounted.current) setUnlockProblem(messageText(messageFor(refusal)));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const onSubmit = (event: SyntheticEvent) => {
    event.preventDefault();
    // A blocked vault has no password to send and nothing to save into: Enter does nothing there.
    if (locked) void unlockHere();
    else if (!closed) void save("ask");
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    // Escape in the folder list (or any list or menu open from here) closes that and nothing more.
    const from = event.target instanceof Element ? event.target : null;
    if (from?.closest('[role="listbox"], [role="menu"], [aria-expanded="true"]') != null) return;
    cancel();
  };

  return (
    <div className="boxlayer">
      <Panel
        title="Save what you copied"
        onClose={cancel}
        onKeyDown={onKeyDown}
        footer={
          <>
            <Button onClick={cancel}>Cancel</Button>
            {blockWords !== null ? null : locked ? (
              <Button look="pill-main" type="submit" form={formId} disabled={busy || password === ""}>
                Unlock and continue
              </Button>
            ) : (
              <Button look="pill-main" type="submit" form={formId} aria-disabled={busy ? true : undefined}>
                Save
              </Button>
            )}
          </>
        }
      >
        <form id={formId} onSubmit={onSubmit} noValidate>
          <p role="status" className={capture.changed ? "cnote" : "sr"}>
            {capture.changed ? CHANGED : ""}
          </p>
          {closed ? null : hasValue ? (
            <>
              <CopiedValue key={`${capture.id}:${currentValue}`} captureId={capture.id} />
              {capture.envKeys === null || !onScreen ? null : (
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
          <div
            className="fbox"
            key="vault"
            ref={vaultPlace}
            onFocus={() => {
              vaultFocused.current = true;
            }}
            onBlur={(event) => {
              // Focus that went to another control is gone from the list. Focus that went nowhere may be the list being made anew (its old box was taken away): it is
              // the list's own again unless the old box is still on the page a moment later.
              if (event.relatedTarget !== null) {
                vaultFocused.current = false;
                return;
              }
              const was = event.target;
              window.setTimeout(() => {
                if (was.isConnected) vaultFocused.current = false;
              }, 0);
            }}
          >
            {/* Made anew when the vaults on offer change (a locked one that was unlocked becomes an open one, with another value): the list part puts a value that has
                left its items back to the first it ever had, and would call `onValueChange` for it as if the person had chosen it. */}
            <Select
              key={selectKey}
              label="Vault"
              items={offered.map((one) => ({ value: one.value, label: one.label }))}
              value={currentValue}
              onValueChange={choose}
            />
          </div>
          {blockWords !== null ? (
            <p className="err" role="alert">
              {blockWords}
            </p>
          ) : locked ? (
            <div ref={passwordPlace}>
              <PasswordField
                look="panel"
                label={`Password for ${current.name}`}
                autoComplete="current-password"
                value={password}
                onChange={(next) => {
                  setPassword(next);
                  setUnlockProblem(null);
                }}
                error={unlockProblem}
                rule={LOCKED_RULE}
                readOnly={busy}
              />
            </div>
          ) : (
            <>
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
                <Select
                  label="Folder"
                  items={folderChoices(folders, onScreen ? host.folder : null)}
                  value={folder}
                  onValueChange={(next) => {
                    setPicked({ vault: currentValue, folder: next });
                  }}
                />
              </div>
              {hasValue ? <ClearClipboardBox checked={clear} onChange={setClear} /> : null}
              {problem === null ? null : (
                <p className="err" id={`${formId}-problem`} role="alert">
                  {problem}
                </p>
              )}
            </>
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
    </div>
  );
}
