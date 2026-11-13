import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import * as api from "../api";
import { focusBack } from "../focus";
import { messageFor, messageText } from "../messages";
import { Button } from "../parts/Button";
import { Panel } from "../parts/Panel";
import { Select, type SelectChoice } from "../parts/Select";
import { keyCodeOf, shortcutText } from "../shortcut";
import { closeTool, loadSettings, saveSettings, useSettings, type SaveTicket, type SessionData } from "../store";

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
 * when the panel opens and changed by its own command. The rows for a vault (backup, password, export) and Help are not here until the
 * plans that build them.
 */
export function SettingsPanel({ data }: { data: SessionData }) {
  const id = useId();
  const saved = useSettings();
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
    // Settings the page could not read at the start are read again now.
    loadSettings();
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
    ? "Turned off in Windows' Startup settings. Turn Lockbox on there to start it with Windows."
    : startup.state === null
      ? "Lockbox can't tell right now whether it starts with Windows."
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
            hint="Works while Lockbox is by the clock."
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
            hint="Screenshots, recordings and screen sharing show Lockbox blank. Windows doesn't guarantee this."
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
          <SettingsRow label="Lockbox">{version === null ? null : <span className="fval">{`Version ${version}`}</span>}</SettingsRow>
        </div>
      </section>
    </Panel>
  );
}
