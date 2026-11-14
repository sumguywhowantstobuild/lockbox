import { useId, useRef, useState, type SyntheticEvent } from "react";
import { messageFor, messageText } from "../../messages";
import { PasswordField } from "../../parts/PasswordField";
import { confirmCreateVault, createVault, type SetupResult } from "../../store";
import { CloudQuestion } from "./CloudQuestion";
import { Frame, SAY_FIRST } from "./Frame";

/** The shortest password the engine takes: 12 characters, counted after Unicode normalisation (spec 5.3). */
const MIN_PASSWORD = 12;

interface Problems {
  name: string | null;
  password: string | null;
  again: string | null;
}

const NONE: Problems = { name: null, password: null, again: null };

/**
 * 21b, step 1 of 2: the vault's name and its password, typed twice. The rules are on the form before anything is typed,
 * and what breaks them is said on the form too, with nothing sent. The engine checks again (the page's check is a
 * courtesy). The vault goes in the usual folder unless the person asks to pick one; a folder a cloud service syncs
 * asks first (18c). A password typed here stays when the window is left, since the person may be fetching it from a
 * password manager; the form is gone once the vault is made.
 */
export function CreateVault({ onBack }: { onBack: () => void }) {
  const nameId = useId();
  const [name, setName] = useState("My vault");
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [chooseFolder, setChooseFolder] = useState(false);
  const [problems, setProblems] = useState<Problems>(NONE);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  // A second press before the first has an answer must not create a second vault.
  const running = useRef(false);

  const go = async (run: () => Promise<SetupResult>) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setFailure(null);
    try {
      const result = await run();
      if (result === "done") {
        // The vault is made and the key step has taken over: the passwords have done their work.
        setPassword("");
        setAgain("");
      }
      setToken(typeof result === "object" ? result.confirm : null);
    } catch (refusal) {
      setToken(null);
      setFailure(messageText(messageFor(refusal)));
    } finally {
      running.current = false;
      setBusy(false);
    }
  };

  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    if (busy) return;
    const found: Problems = {
      name: name.trim() === "" ? "Give the vault a name." : null,
      password: Array.from(password.normalize("NFC")).length < MIN_PASSWORD ? "At least 12 characters." : null,
      again: password !== again ? "The two passwords don't match." : null,
    };
    setProblems(found);
    if (found.name !== null || found.password !== null || found.again !== null) return;
    void go(() => createVault(name.trim(), password, chooseFolder));
  };

  if (token !== null) {
    return (
      <CloudQuestion
        busy={busy}
        step="Step 1 of 2"
        onContinue={() => void go(() => confirmCreateVault(token))}
        onChooseAnother={() => void go(() => createVault(name.trim(), password, true))}
        onCancel={() => {
          setToken(null);
        }}
      />
    );
  }

  return (
    <Frame say={SAY_FIRST}>
      <form className="fu" onSubmit={submit} noValidate>
        <p className="fu-step">Step 1 of 2</p>
        <h1>Create your vault</h1>
        <p className="fu-sub">Most people only need one. Make another later for things that need a separate password.</p>
        <div>
          <label htmlFor={nameId}>Vault name</label>
          <input
            id={nameId}
            className="inp"
            autoComplete="off"
            spellCheck={false}
            value={name}
            aria-invalid={problems.name === null ? undefined : true}
            aria-describedby={`${nameId}-hint${problems.name === null ? "" : ` ${nameId}-error`}`}
            onChange={(event) => {
              setName(event.currentTarget.value);
              setProblems((current) => ({ ...current, name: null }));
            }}
          />
          {problems.name === null ? null : (
            <p className="err" id={`${nameId}-error`} role="alert">
              {problems.name}
            </p>
          )}
          <p className="fu-hint" id={`${nameId}-hint`}>
            Anyone with a copy of the vault&apos;s folder can read this name, so keep secrets out of it.
          </p>
        </div>
        <PasswordField
          label="Password"
          value={password}
          rule="At least 12 characters."
          minimum={MIN_PASSWORD}
          error={problems.password}
          onChange={(next) => {
            setPassword(next);
            setProblems((current) => ({ ...current, password: null, again: null }));
          }}
        />
        <PasswordField
          label="Password again"
          value={again}
          error={problems.again}
          onChange={(next) => {
            setAgain(next);
            setProblems((current) => ({ ...current, again: null }));
          }}
        />
        <div className="fu-row">
          <span className="fu-hint fu-where">
            {chooseFolder
              ? "You'll pick the folder when you press Create vault."
              : "Kept in your Lockbox Vaults folder on this PC."}
          </span>
          <button
            type="button"
            className="lnk"
            onClick={() => {
              setChooseFolder((current) => !current);
            }}
          >
            {chooseFolder ? "Use the usual folder" : "Change"}
          </button>
        </div>
        {failure === null ? null : (
          <p className="err" role="alert">
            {failure}
          </p>
        )}
        <div className="fu-row">
          <button type="submit" className="prim" disabled={busy}>
            Create vault
          </button>
          <button type="button" className="lnk" disabled={busy} onClick={onBack}>
            Back
          </button>
        </div>
      </form>
    </Frame>
  );
}
