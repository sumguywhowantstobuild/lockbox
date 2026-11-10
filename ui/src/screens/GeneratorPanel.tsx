import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import * as api from "../api";
import { focusBack } from "../focus";
import { messageFor } from "../messages";
import { Button } from "../parts/Button";
import { CopyIcon } from "../parts/Icon";
import { Panel } from "../parts/Panel";
import { closeTool, copyGenerated, type SessionData } from "../store";
import { useValueGuard } from "../useValueGuard";

type Kind = "characters" | "passphrase";

/** What the person has chosen: each kind keeps its own size, so going back and forth does not lose it. */
interface Choices {
  kind: Kind;
  /** How many characters (12 to 64 here; the engine takes 8 to 128). */
  length: number;
  /** How many words (3 to 12, as the engine takes them). */
  words: number;
  /** Numbers in a password; a number in one word of a passphrase. */
  numbers: boolean;
  /** Symbols in a password. A passphrase has none: its words are joined with a hyphen. */
  symbols: boolean;
}

const START: Choices = { kind: "characters", length: 24, words: 5, numbers: true, symbols: true };
const LENGTH = { min: 12, max: 64 };
const WORDS = { min: 3, max: 12 };

interface Generator {
  choices: Choices;
  change: (patch: Partial<Choices>) => void;
  /** The shell makes another with the same choices. */
  again: () => void;
  /** What the shell made last (empty until it has), or its refusal. The value lives in this component's state only. */
  value: string;
  error: unknown;
}

/**
 * The generator's state: asks the shell for a value whenever a choice changes or the person asks for another, and keeps
 * only the latest answer. The value is shown and, with Use this or Copy, sent back to Rust; it is never put anywhere else
 * (no title, label, address or log), and it goes with the component.
 */
function useGenerator(): Generator {
  const [choices, setChoices] = useState(START);
  const [round, setRound] = useState(0);
  const [made, setMade] = useState<{ value: string; error: unknown }>({ value: "", error: null });

  useEffect(() => {
    // An answer to an earlier question (a slider dragged on) is dropped.
    let current = true;
    const asked =
      choices.kind === "characters"
        ? api.generatePassword({
            length: choices.length,
            lowercase: true,
            uppercase: true,
            digits: choices.numbers,
            symbols: choices.symbols,
            avoid_ambiguous: false,
          })
        : api.generatePassphrase({ words: choices.words, separator: "-", capitalize: true, include_number: choices.numbers });
    asked.then(
      (value) => {
        if (current) setMade({ value, error: null });
      },
      (error: unknown) => {
        if (current) setMade({ value: "", error });
      },
    );
    return () => {
      current = false;
    };
  }, [choices, round]);

  return {
    choices,
    change: (patch) => {
      setChoices((before) => ({ ...before, ...patch }));
    },
    again: () => {
      setRound((before) => before + 1);
    },
    value: made.value,
    error: made.error,
  };
}

function KindButtons({ generator }: { generator: Generator }) {
  const { kind } = generator.choices;
  return (
    <div className="segs" role="group" aria-label="Kind of password">
      <button
        type="button"
        className="seg"
        aria-pressed={kind === "characters"}
        onClick={() => {
          generator.change({ kind: "characters" });
        }}
      >
        Characters
      </button>
      <button
        type="button"
        className="seg"
        aria-pressed={kind === "passphrase"}
        onClick={() => {
          generator.change({ kind: "passphrase" });
        }}
      >
        Passphrase
      </button>
    </div>
  );
}

/**
 * The value and what changes it: Length (Words for a passphrase), Numbers and Symbols (a password only), and Try another.
 * `actions` come after Try another. In the form the kind is chosen inside the block (6c); on the page it is above (16a).
 */
function GeneratorBlock({
  generator,
  kindInside,
  actions,
  onCopyKey,
}: {
  generator: Generator;
  kindInside: boolean;
  actions: ReactNode;
  /** Ctrl+C (or Copy in a menu) aimed at the value (focus on its box, or a selection touching it): done instead of a native copy. */
  onCopyKey?: () => void;
}) {
  const id = useId();
  const valueBox = useRef<HTMLDivElement>(null);

  // While the generator is on screen a native copy or cut aimed at the value is stopped (see `useValueGuard`). On the page,
  // Ctrl+C then does what the Copy button does (through the shell); in the form nothing is copied, and Use this is the way out.
  useValueGuard(valueBox, onCopyKey);

  const { choices } = generator;
  const passphrase = choices.kind === "passphrase";
  const range = passphrase ? WORDS : LENGTH;
  const size = passphrase ? choices.words : choices.length;
  const problem = generator.error === null ? null : messageFor(generator.error);
  return (
    <div className="gen">
      {/* Read-only text a keyboard can reach, so a screen reader can read the new value after a change. It is not announced by itself. */}
      <div ref={valueBox} className="gout" role="textbox" aria-readonly="true" aria-label="Generated password" tabIndex={0}>
        {generator.value}
      </div>
      {problem === null ? null : (
        <p className="err" role="alert">
          {problem.title} {problem.body}
        </p>
      )}
      {kindInside ? (
        <div className="grow">
          <KindButtons generator={generator} />
        </div>
      ) : null}
      <div className="grow">
        <label htmlFor={`${id}-size`}>{passphrase ? "Words" : "Length"}</label>
        <input
          id={`${id}-size`}
          type="range"
          min={range.min}
          max={range.max}
          value={size}
          onChange={(event) => {
            const next = Number(event.currentTarget.value);
            generator.change(passphrase ? { words: next } : { length: next });
          }}
        />
        <span className="gnum" aria-hidden="true">
          {size}
        </span>
      </div>
      <div className="grow">
        <label htmlFor={`${id}-numbers`}>Numbers</label>
        <input
          id={`${id}-numbers`}
          type="checkbox"
          checked={choices.numbers}
          onChange={(event) => {
            generator.change({ numbers: event.currentTarget.checked });
          }}
        />
      </div>
      {passphrase ? null : (
        <div className="grow">
          <label htmlFor={`${id}-symbols`}>Symbols</label>
          <input
            id={`${id}-symbols`}
            type="checkbox"
            checked={choices.symbols}
            onChange={(event) => {
              generator.change({ symbols: event.currentTarget.checked });
            }}
          />
        </div>
      )}
      <div className="gact">
        <Button onClick={generator.again}>Try another</Button>
        {actions}
      </div>
    </div>
  );
}

/**
 * The generator inside the new-login form (6c), under the password field: Use this puts the value in that field and the
 * generator closes. Nothing is copied or kept anywhere else.
 */
export function GeneratorInForm({ onUse }: { onUse: (value: string) => void }) {
  const generator = useGenerator();
  return (
    <GeneratorBlock
      generator={generator}
      kindInside
      actions={
        <Button
          look="pill-main"
          onClick={() => {
            // Before the first value has come there is nothing to use.
            if (generator.value !== "") onUse(generator.value);
          }}
        >
          Use this
        </Button>
      }
    />
  );
}

/**
 * The Generator page (16a), from the side menu: make a password or passphrase and Copy it. Copy goes through the shell
 * (the value is sent back to Rust, which copies it with the marks and timer of any copy), and the page says how long
 * until it clears, from the settings. Nothing is kept: closing the page loses the value unless it was saved in an item.
 */
export function GeneratorPage({ data }: { data: SessionData }) {
  const generator = useGenerator();
  const title = useRef<HTMLHeadingElement>(null);
  const [seconds, setSeconds] = useState<number | null>(null);
  // The Copy button, and Ctrl+C in place of a native copy: through the shell, which marks and times the copy.
  const copyIt = () => {
    if (generator.value !== "") void copyGenerated(data.session, generator.value);
  };

  useEffect(() => {
    title.current?.focus();
    let current = true;
    api.getSettings().then(
      (settings) => {
        if (current) setSeconds(settings.clipboard_seconds);
      },
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, []);

  return (
    <Panel
      title="Generator"
      titleRef={title}
      onClose={() => {
        closeTool(data.session);
        focusBack("generator");
      }}
    >
      <div className="gkind">
        <KindButtons generator={generator} />
      </div>
      <GeneratorBlock
        generator={generator}
        kindInside={false}
        onCopyKey={copyIt}
        actions={
          <Button look="pill-main" onClick={copyIt}>
            <CopyIcon />
            Copy
          </Button>
        }
      />
      {seconds === null ? null : (
        <p className="fhint">{`Clears from the clipboard after ${String(seconds)} seconds, like any password. Lockbox doesn't keep it unless you save it in an item.`}</p>
      )}
    </Panel>
  );
}
