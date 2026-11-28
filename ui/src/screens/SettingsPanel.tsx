import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import * as api from "../api";
import { focusBack } from "../focus";
import { messageFor, messageText } from "../messages";
import { Button } from "../parts/Button";
import { ChevronRightIcon } from "../parts/Icon";
import { Panel } from "../parts/Panel";
import { Select, type SelectChoice } from "../parts/Select";
import { keyCodeOf, shortcutText } from "../shortcut";
import { exportHint } from "../exportWords";
import { SETTINGS_HINT } from "../olderCopiesWords";
import { SETTINGS_OPEN_HINT, shownName } from "../openBackupWords";
import {
  closeTool,
  loadOlderCopies,
  loadSettings,
  NOT_ON_THE_LIST,
  openBackup,
  openChangePassword,
  openExport,
  openHelp,
  openNewRecoveryKey,
  openOlderCopies,
  saveSettings,
  startOpenBackup,
  startRestore,
  startTestBackup,
  useOlderCopies,
  useOpenBackup,
  useRestore,
  useSessions,
  useSettings,
  type SaveTicket,
  type SessionData,
} from "../store";

/** The lists of the two time settings: the session's own steps, inside what the shell takes (1 to 60 minutes, 10 to 300 seconds). */
const IDLE_MINUTES = [1, 2, 5, 10, 15, 30, 60];
const CLIPBOARD_SECONDS = [10, 20, 30, 60, 90, 120, 300];

const minutes = (count: number) => (count === 1 ? "1 minute" : `${String(count)} minutes`);
const seconds = (count: number) => (count === 1 ? "1 second" : `${String(count)} seconds`);

/** The choices of a list, with the saved value among them even when it is not one of the steps (the shell takes any whole number in its bounds). */
function choices(steps: readonly number[], saved: number, say: (count: number) => string): SelectChoice[] {
  const all = steps.includes(saved) ? steps : [...steps, saved].sort((a, b) => a - b);
  return all.map((count) => ({ value: String(count), label: say(count) }));
}

/** The keys that are only a modifier: pressed on their own they are no choice. */
const MODIFIER_KEYS = new Set(["Control", "Shift", "Alt", "AltGraph", "Meta", "OS"]);

/** What a press the page can see is no shortcut says, in the shell's own words (the shell's check is the one that decides the rest). */
const NOT_ALLOWED = { code: "invalid_input", what: "shortcut" };

/** The rows that can say their own refusal (the shortcut and Start with Windows keep theirs apart). */
type Row = "theme" | "idle" | "clipboard" | "capture";

/**
 * Where the page is in changing the shortcut: the combination last tried (none yet), its refusal, whether a try is on its way, and
 * whether it has reached the shell (`sent`), after which it can't be called back and Cancel says it is off until the answer.
 */
interface Listening {
  tried: api.Shortcut | null;
  error: unknown;
  saving: boolean;
  sent?: boolean;
}

/** Start with Windows as the page knows it: what the shell last read, the change asked and not yet answered, and the refusal. */
interface StartupView {
  /** `null` until it has been read, or when it could not be. */
  state: api.StartupState | null;
  /** The choice made and not answered yet, so the switch moves at once. */
  wanted: boolean | null;
  error: unknown;
  /** The first read is over (answered or refused): the row is shown. */
  read: boolean;
}

/** One row of a group: its words and hint on the left, its control on the right, and a refusal in a line of its own under both. */
function SettingsRow({
  label,
  labelFor,
  hint,
  hintId,
  hidden = false,
  error,
  note,
  children,
}: {
  label: string;
  /** The control the words name, when the control is a form control of its own. */
  labelFor?: string;
  hint?: string;
  hintId?: string;
  /** The words are only for the eyes: the control carries its own name for a screen reader. */
  hidden?: boolean;
  error?: string | null;
  /** A line for a screen reader and the eyes under the row, while there is something to say (`role="status"`). */
  note?: string | null;
  children?: ReactNode;
}) {
  return (
    <div className="srow">
      <span className="swords">
        {labelFor === undefined ? (
          <span className="slab" aria-hidden={hidden ? true : undefined}>
            {label}
          </span>
        ) : (
          <label className="slab" htmlFor={labelFor}>
            {label}
          </label>
        )}
        {hint === undefined ? null : (
          <span className="fhint" id={hintId}>
            {hint}
          </span>
        )}
      </span>
      {children}
      {note === null || note === undefined ? null : (
        <p className="fhint snote" role="status">
          {note}
        </p>
      )}
      {error === null || error === undefined ? null : (
        <p className="ferr" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** A refusal in words, through the fixed table. */
function said(error: unknown, names?: { shortcut?: string }): string {
  return messageText(messageFor(error, names));
}

/**
 * Settings (31a, 31b), from the side menu: the app's settings, for every vault, saved at once as each one changes. A change shows as it is
 * made and goes back to what is saved if the shell refuses it, with the refusal in words under its row. Saves go one after another (the store
 * sees to that), each as the whole settings. Start with Windows is not one of the settings the file keeps: it is the shell's own entry, read
 * when the panel opens and changed by its own command. "This vault" has Back up, Export, Change password and New recovery key (a writable vault only) and Test a
 * backup (any vault, a read-only one too). "About" has the version and Help, which opens the guide in the browser.
 */
export function SettingsPanel({ data }: { data: SessionData }) {
  const id = useId();
  const saved = useSettings();
  // With more than one vault (or backup) open, the section that is for the window's own vault says which it is (the design: "With two open, Add and Settings say which vault").
  const several = useSessions().length > 1;
  // The picker of Restore a backup is open (or its steps are): a second press sends nothing.
  const restoring = useRestore() !== null;
  // The same for Open a backup: its picker is open (or its panel is, in this panel's place).
  const opening = useOpenBackup() !== null;
  // The older copies the restores kept of this vault, from the store's one listing. A session that is itself an older copy has none of its own.
  const kept = useOlderCopies();
  const olderCount = data.vaultId === NOT_ON_THE_LIST ? 0 : (kept ?? []).filter((entry) => entry.vault === data.vaultId).length;
  const title = useRef<HTMLHeadingElement>(null);
  // What the person chose and the shell has not answered: the controls show it meanwhile.
  const [pending, setPending] = useState<Partial<api.Settings>>({});
  const inFlight = useRef(0);
  // The refusal each row last had, until that row is saved: a change that works elsewhere does not take it away.
  const [problems, setProblems] = useState<Partial<Record<Row, { error: unknown }>>>({});
  const [listening, setListening] = useState<Listening | null>(null);
  // Which try at a new shortcut is the latest: one that was cancelled (or replaced) is not answered on screen.
  const attempt = useRef(0);
  const ticket = useRef<SaveTicket | null>(null);
  const keycap = useRef<HTMLElement>(null);
  const pill = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);
  const [startup, setStartup] = useState<StartupView>({ state: null, wanted: null, error: null, read: false });
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    title.current?.focus();
    // Settings the page could not read at the start are read again now, and so are the older copies the restores kept.
    loadSettings();
    void loadOlderCopies();
    let current = true;
    api.getStartup().then(
      (state) => {
        if (current) setStartup({ state, wanted: null, error: null, read: true });
      },
      (error: unknown) => {
        if (current) setStartup({ state: null, wanted: null, error, read: true });
      },
    );
    api.appInfo().then(
      (info) => {
        if (current) setVersion(info.version);
      },
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, []);

  const isListening = listening !== null;
  useEffect(() => {
    // Focus goes to the box that waits for the keys, and back to the pill when the change ends by Escape, Cancel or a saved shortcut.
    if (isListening) keycap.current?.focus();
    else if (returnFocus.current) {
      returnFocus.current = false;
      pill.current?.focus();
    }
  }, [isListening]);

  const shown: api.Settings = { ...saved, ...pending };

  const change = (row: Row, patch: Partial<api.Settings>) => {
    setPending((before) => ({ ...before, ...patch }));
    inFlight.current += 1;
    void saveSettings(patch).then((result) => {
      inFlight.current -= 1;
      // Once every save is answered the controls read what is saved: a refused change is back to the old value.
      if (inFlight.current === 0) setPending({});
      setProblems((before) => {
        const rest = Object.fromEntries(Object.entries(before).filter(([name]) => name !== row));
        return result === "saved" || result === "cancelled" ? rest : { ...rest, [row]: { error: result.failed } };
      });
    });
  };
  const errorOf = (row: Row) => {
    const found = problems[row];
    return found === undefined ? null : said(found.error);
  };

  const stopListening = (focusPill: boolean) => {
    // A try that waits in line is taken out of it; one the shell has been sent cannot be called back, so the wait goes on to its answer.
    const sent = ticket.current;
    if (listening?.saving === true && sent !== null) {
      if (sent.sent) return;
      sent.cancelled = true;
    }
    attempt.current += 1;
    returnFocus.current = focusPill;
    setListening(null);
  };

  const onKeys = (event: KeyboardEvent<HTMLElement>) => {
    if (listening === null) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      stopListening(true);
      return;
    }
    // A modifier on its own is the start of a combination, and Tab (Shift+Tab) is how the keyboard leaves the box.
    if (MODIFIER_KEYS.has(event.key)) return;
    if (event.key === "Tab" && !event.ctrlKey && !event.altKey) return;
    event.preventDefault();
    event.stopPropagation();
    if (listening.saving) return;
    const key = keyCodeOf(event.code, event.key);
    const modifiers = [event.ctrlKey, event.shiftKey, event.altKey].filter(Boolean).length;
    if (key === null || modifiers < 2 || event.metaKey) {
      setListening({ ...listening, error: NOT_ALLOWED });
      return;
    }
    const tried: api.Shortcut = { ctrl: event.ctrlKey, shift: event.shiftKey, alt: event.altKey, key };
    attempt.current += 1;
    const mine = attempt.current;
    setListening({ tried, error: null, saving: true });
    const mineTicket: SaveTicket = {
      cancelled: false,
      sent: false,
      onSent: () => {
        if (attempt.current === mine) setListening((now) => (now?.saving === true ? { ...now, sent: true } : now));
      },
    };
    ticket.current = mineTicket;
    void saveSettings({ shortcut: tried }, mineTicket).then((result) => {
      if (attempt.current !== mine || result === "cancelled") return;
      if (result === "saved") {
        returnFocus.current = true;
        setListening(null);
      } else {
        setListening({ tried, error: result.failed, saving: false });
      }
    });
  };

  const toggleStartup = (on: boolean) => {
    if (startup.wanted !== null || startup.state?.turned_off_in_windows === true) return;
    setStartup({ ...startup, wanted: on, error: null });
    api.setStartup(on).then(
      (state) => {
        setStartup({ state, wanted: null, error: null, read: true });
      },
      (error: unknown) => {
        // The shell's one refusal does not say whether the write itself went through (a readback can fail after it did), so the state is
        // read again. If that works it is shown as it is, and there is nothing to refuse when it is what was asked for; if it does not, the
        // state is not known, and the switch does not claim one.
        api.getStartup().then(
          (state) => {
            setStartup({ state, wanted: null, error: state.on === on ? null : error, read: true });
          },
          () => {
            setStartup({ state: null, wanted: null, error, read: true });
          },
        );
      },
    );
  };

  const turnedOff = startup.state?.turned_off_in_windows === true;
  const startsWithWindows = startup.wanted ?? (startup.state?.on === true && !turnedOff);
  const startupHint = turnedOff
    ? "Turned off in Windows' Startup settings. Turn Petalock on there to start it with Windows."
    : startup.state === null
      ? "Petalock can't tell right now whether it starts with Windows."
      : "Starts locked, by the clock.";
  // The refusal of the shortcut, naming the combination that was tried.
  let shortcutError: string | null = null;
  if (listening !== null && listening.error !== null) {
    shortcutError = said(listening.error, listening.tried === null ? {} : { shortcut: shortcutText(listening.tried) });
  }

  return (
    <Panel
      title="Settings"
      subtitle="For every vault on this PC."
      titleRef={title}
      // A backup or an older copy says it is read-only on every screen of its session, Settings too.
      tools={data.readOnly ? <span className="chip">Read-only</span> : undefined}
      onClose={() => {
        closeTool(data.session);
        focusBack("settings");
      }}
    >
      <section className="gp">
        <h3 className="gh">Appearance</h3>
        <div className="grp">
          <SettingsRow label="Theme" error={errorOf("theme")}>
            <div className="segs" role="group" aria-label="Theme">
              {(["light", "dark", "system"] as const).map((theme) => (
                <button
                  key={theme}
                  type="button"
                  className="seg"
                  aria-pressed={shown.theme === theme}
                  onClick={() => {
                    if (shown.theme !== theme) change("theme", { theme });
                  }}
                >
                  {theme === "light" ? "Light" : theme === "dark" ? "Dark" : "System"}
                </button>
              ))}
            </div>
          </SettingsRow>
        </div>
      </section>

      <section className="gp">
        <h3 className="gh">Locking and clipboard</h3>
        <div className="grp">
          <SettingsRow label="Lock after idle" hidden error={errorOf("idle")}>
            <div className="ssel">
              <Select
                inRow
                label="Lock after idle"
                items={choices(IDLE_MINUTES, shown.idle_minutes, minutes)}
                value={String(shown.idle_minutes)}
                onValueChange={(next) => {
                  if (Number(next) !== shown.idle_minutes) change("idle", { idle_minutes: Number(next) });
                }}
              />
            </div>
          </SettingsRow>
          <SettingsRow label="Clear clipboard after" hidden error={errorOf("clipboard")}>
            <div className="ssel">
              <Select
                inRow
                label="Clear clipboard after"
                items={choices(CLIPBOARD_SECONDS, shown.clipboard_seconds, seconds)}
                value={String(shown.clipboard_seconds)}
                onValueChange={(next) => {
                  if (Number(next) !== shown.clipboard_seconds) change("clipboard", { clipboard_seconds: Number(next) });
                }}
              />
            </div>
          </SettingsRow>
        </div>
      </section>

      <section className="gp">
        <h3 className="gh">Saving what you copied</h3>
        <div className="grp">
          <SettingsRow
            label="Save shortcut"
            hint="Works while Petalock is by the clock."
            error={shortcutError}
            // Windows keeps a combination another app holds from reaching the page, so silence is all the page sees of it.
            note={listening === null ? null : "If nothing happens, another app is using those keys. Try a different combination."}
          >
            <div
              className="skeys"
              onBlur={(event) => {
                // Focus moving to anything outside the key cap and its pill ends the wait, as Escape does.
                if (listening !== null && !event.currentTarget.contains(event.relatedTarget)) stopListening(false);
              }}
            >
              {listening === null ? (
                <kbd className="kc">{shortcutText(saved.shortcut)}</kbd>
              ) : (
                <kbd
                  ref={keycap}
                  className="keycap"
                  role="textbox"
                  aria-readonly="true"
                  aria-label="Save shortcut, press the new keys"
                  tabIndex={0}
                  onKeyDown={onKeys}
                >
                  {listening.tried === null ? "Press the new keys" : shortcutText(listening.tried)}
                </kbd>
              )}
              <Button
                ref={pill}
                aria-disabled={listening?.sent === true ? true : undefined}
                onClick={() => {
                  if (listening === null) setListening({ tried: null, error: null, saving: false });
                  else stopListening(true);
                }}
              >
                {listening === null ? "Change" : "Cancel"}
              </Button>
            </div>
          </SettingsRow>
        </div>
      </section>

      <section className="gp">
        <h3 className="gh">{several ? `This vault: ${shownName(data)}` : "This vault"}</h3>
        <div className="grp">
          {data.readOnly ? null : (
            // A copy kept on another drive. Not in a vault opened from a backup, which has nothing of its own to back up.
            <SettingsRow label="Back up" hint={`Keep a copy of ${data.name} on another drive.`} hintId={`${id}-backup-hint`}>
              <Button
                aria-describedby={`${id}-backup-hint`}
                onClick={() => {
                  openBackup(data.session);
                }}
              >
                Back up
              </Button>
            </SettingsRow>
          )}
          {/* Any vault's, a read-only one too: the backup it checks is a file, and no vault's contents are read. */}
          <SettingsRow label="Test a backup" hint="Check that a backup opens, without restoring it." hintId={`${id}-test-hint`}>
            <Button
              aria-describedby={`${id}-test-hint`}
              // The Windows picker is open: a second press sends nothing.
              aria-disabled={data.test?.phase === "picking" ? true : undefined}
              onClick={() => {
                if (data.test === null) void startTestBackup(data.session);
              }}
            >
              Test a backup
            </Button>
          </SettingsRow>
          {/* Any vault's, a read-only one too: a backup is browsed in a session of its own and nothing is written into the vault that is open. */}
          <SettingsRow label="Open a backup" hint={SETTINGS_OPEN_HINT} hintId={`${id}-open-hint`}>
            <Button
              aria-describedby={`${id}-open-hint`}
              // The Windows picker is open: a second press sends nothing.
              aria-disabled={opening ? true : undefined}
              onClick={() => {
                if (!opening) void startOpenBackup();
              }}
            >
              Open a backup
            </Button>
          </SettingsRow>
          {/* Any vault's, a read-only one too: a restore unpacks a backup beside the vaults and writes nothing into the one that is open. */}
          <SettingsRow label="Restore a backup" hint="Unpack a backup. Your current vault is kept beside it." hintId={`${id}-restore-hint`}>
            <Button
              aria-describedby={`${id}-restore-hint`}
              aria-disabled={restoring ? true : undefined}
              onClick={() => {
                if (!restoring) void startRestore();
              }}
            >
              Restore a backup
            </Button>
          </SettingsRow>
          {olderCount === 0 ? null : (
            // The copies a restore kept of this vault (shown only while there are some, so the button never leads to an empty list): the vault's own, whether it is open
            // writable or read-only, and none for a session that is an older copy.
            <SettingsRow label="Older copies" hint={SETTINGS_HINT} hintId={`${id}-older-hint`}>
              <Button
                aria-describedby={`${id}-older-hint`}
                onClick={() => {
                  openOlderCopies(data.session);
                }}
              >
                {`Older copies (${String(olderCount)})`}
              </Button>
            </SettingsRow>
          )}
          {data.readOnly ? null : (
            // This vault's items as a readable file: not in a copy opened from a backup or an older copy (copying items out of a backup is 25's own way).
            <SettingsRow label="Export" hint={exportHint(data.name)} hintId={`${id}-export-hint`}>
              <Button
                aria-describedby={`${id}-export-hint`}
                onClick={() => {
                  openExport(data.session);
                }}
              >
                Export
              </Button>
            </SettingsRow>
          )}
          {data.readOnly ? null : (
            // This vault's own password: not in a copy opened from a backup or an older copy, which nothing can be written to.
            <SettingsRow label="Change password" hint={`Set a new password for ${data.name}.`} hintId={`${id}-password-hint`}>
              <Button
                aria-describedby={`${id}-password-hint`}
                onClick={() => {
                  openChangePassword(data.session);
                }}
              >
                Change password
              </Button>
            </SettingsRow>
          )}
          {data.readOnly ? null : (
            // This vault's own recovery key: not in a copy opened from a backup or an older copy, which nothing can be written to.
            <SettingsRow label="New recovery key" hint={`Make a new recovery key for ${data.name}. The old one stops working.`} hintId={`${id}-key-hint`}>
              <Button
                aria-describedby={`${id}-key-hint`}
                onClick={() => {
                  openNewRecoveryKey(data.session);
                }}
              >
                New recovery key
              </Button>
            </SettingsRow>
          )}
        </div>
      </section>

      <section className="gp">
        <h3 className="gh">This PC</h3>
        <div className="grp">
          {startup.read ? (
            <SettingsRow
              label="Start with Windows"
              labelFor={`${id}-startup`}
              hint={startupHint}
              hintId={`${id}-startup-hint`}
              error={startup.error === null ? null : said(startup.error)}
            >
              <input
                id={`${id}-startup`}
                type="checkbox"
                role="switch"
                className="swt"
                checked={startsWithWindows}
                aria-disabled={turnedOff ? true : undefined}
                aria-describedby={`${id}-startup-hint`}
                onChange={(event) => {
                  toggleStartup(event.currentTarget.checked);
                }}
              />
            </SettingsRow>
          ) : null}
          <SettingsRow
            label="Keep out of screen capture"
            labelFor={`${id}-capture`}
            hint="Screenshots, recordings and screen sharing show Petalock blank. Windows doesn't guarantee this."
            hintId={`${id}-capture-hint`}
            error={errorOf("capture")}
          >
            <input
              id={`${id}-capture`}
              type="checkbox"
              role="switch"
              className="swt"
              checked={shown.capture_protected}
              aria-describedby={`${id}-capture-hint`}
              onChange={(event) => {
                change("capture", { capture_protected: event.currentTarget.checked });
              }}
            />
          </SettingsRow>
        </div>
      </section>

      <section className="gp">
        <h3 className="gh">About</h3>
        <div className="grp">
          <SettingsRow label="Petalock">{version === null ? null : <span className="fval">{`Version ${version}`}</span>}</SettingsRow>
          {/* The guide, in the browser (task 36). Every vault has it, a read-only one too: it opens nothing of the vault's. */}
          <button
            type="button"
            className="srow sgo"
            onClick={() => {
              void openHelp(data.session);
            }}
          >
            <span className="slab">Help</span>
            <ChevronRightIcon />
          </button>
        </div>
      </section>
    </Panel>
  );
}
