import { useEffect, useId, useRef, useState, type SyntheticEvent } from "react";
import { useLockEpoch } from "../../jobs";
import { messageFor, messageText } from "../../messages";
import type { CloudProvider } from "../../api";
import {
  cloudWarning,
  IN_THE_PICKED_FOLDER,
  IN_THE_USUAL_FOLDER,
  NAME_HINT,
  NEW_VAULT_HEADING,
  PLACE_REFUSALS,
  REPEAT_PASSWORD,
  SAY_NEW_VAULT,
  WHERE_IT_LIVES,
} from "../../newVaultWords";
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
 *
 * `inside` is the form of 18b, begun from the vault menu while other vaults are open (Task 7): its own words ("New vault", "Continue", "Cancel", and 18c's cloud warning on the
 * same screen), and Cancel (and Escape) goes back to the vault on screen. There a password
 * is wiped from its field the moment it is sent, so a refusal, a closed picker, the cloud question's Cancel or Choose another all leave empty fields (the passwords
 * are typed again), the fields can't be typed in while the answer is out, and every lock epoch wipes them. A vault the list refused (`vault not listed`) is said
 * with the words that point at the vault menu's Add existing vault folder.
 */
export function CreateVault({ onBack, inside = false }: { onBack: () => void; inside?: boolean }) {
  const nameId = useId();
  const nameBox = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("My vault");
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [chooseFolder, setChooseFolder] = useState(false);
  const [problems, setProblems] = useState<Problems>(NONE);
  // What the last refusal said, and whether it is about the folder (18c says that under "Where it lives").
  const [failure, setFailure] = useState<{ text: string; place: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  // What 18c says with the token: the service the shell found, and whether the folder was the person's pick or the usual one.
  const [asked, setAsked] = useState<{ provider: CloudProvider; picked: boolean } | null>(null);
  // A second press before the first has an answer must not create a second vault.
  const running = useRef(false);
  // Every lock epoch (Lock all, an idle lock, Windows locking or sleeping, even before the vaults' own locks are heard) wipes what is typed.
  const epoch = useLockEpoch();
  const [seenEpoch, setSeenEpoch] = useState(epoch);
  if (seenEpoch !== epoch) {
    setSeenEpoch(epoch);
    if (inside) {
      setPassword("");
      setAgain("");
    }
  }
  // The form that comes up over a vault takes focus, as the unlock step's box does: the menu that opened it has gone.
  useEffect(() => {
    if (inside) nameBox.current?.focus();
  }, [inside]);
  // 18c replaces the form on the same screen (inside), so the button that was pressed is gone and focus would drop to the page: it goes to the safe answer, Choose
  // another (stage 7's S1: an extra Enter must never make the vault in a cloud folder), which is described by the warning so a screen reader reads both, and back to
  // the password box on the way back, where the person types again.
  const warningId = useId();
  const safeAnswer = useRef<HTMLButtonElement>(null);
  const warning = inside && token !== null;
  // Set when the person leaves the warning (any of its three buttons): the form that comes back focuses its password box as it appears.
  const [leftWarning, setLeftWarning] = useState(false);
  useEffect(() => {
    if (warning && !busy) safeAnswer.current?.focus();
  }, [warning, busy]);
  const back = () => {
    if (busy) return;
    setPassword("");
    setAgain("");
    onBack();
  };
  const refusalWords = (refusal: unknown): string => {
    const notListed =
      inside &&
      typeof refusal === "object" &&
      refusal !== null &&
      (refusal as { code?: unknown }).code === "invalid_input" &&
      (refusal as { what?: unknown }).what === "vault not listed";
    return messageText(messageFor(notListed ? { code: "page", kind: "vault_not_listed_inside" } : refusal));
  };

  const go = async (run: () => Promise<SetupResult>, picked = false) => {
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
      setAsked(typeof result === "object" ? { provider: result.provider, picked } : null);
    } catch (refusal) {
      setToken(null);
      setAsked(null);
      const place =
        typeof refusal === "object" &&
        refusal !== null &&
        (refusal as { code?: unknown }).code === "invalid_input" &&
        PLACE_REFUSALS.includes((refusal as { what?: unknown }).what as string);
      setFailure({ text: refusalWords(refusal), place });
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
    const sentName = name.trim();
    const sentPassword = password;
    const sentFolder = chooseFolder;
    // Inside, the passwords go once and are gone from here as they go: the fields are empty whatever comes back.
    if (inside) {
      setPassword("");
      setAgain("");
    }
    void go(() => createVault(sentName, sentPassword, sentFolder), sentFolder);
  };

  if (token !== null && !inside) {
    return (
      <CloudQuestion
        busy={busy}
        step="Step 1 of 2"
        onContinue={() => void go(() => confirmCreateVault(token))}
        onChooseAnother={() => void go(() => createVault(name.trim(), password, true), true)}
        onCancel={() => {
          setToken(null);
        }}
      />
    );
  }

  if (token !== null) {
    // 18c: a folder that a cloud service syncs, on the New vault screen itself. The password went with the send and is kept nowhere to send again, so Choose another
    // goes back to the form, set to pick the folder, to type it once more; so does Cancel.
    return (
      <Frame say={SAY_NEW_VAULT}>
        <p className="fu-step">Step 1 of 2</p>
        <h1>{NEW_VAULT_HEADING}</h1>
        <div>
          <span className="fu-lab">{WHERE_IT_LIVES}</span>
          <div className="fu-row">
            {/* Where the path was drawn, the folder's place in words, as 18b says it: the page never has the path. */}
            <span className="fu-hint fu-where">{asked?.picked === true ? IN_THE_PICKED_FOLDER : IN_THE_USUAL_FOLDER}</span>
            <button
              ref={safeAnswer}
              type="button"
              className="lnk"
              disabled={busy}
              aria-describedby={warningId}
              onClick={() => {
                setLeftWarning(true);
                setChooseFolder(true);
                setToken(null);
              }}
            >
              Choose another
            </button>
          </div>
          <p className="fu-sub strong" id={warningId}>
            {cloudWarning(asked?.provider ?? "Other")}
          </p>
        </div>
        <div className="fu-row">
          <button
            type="button"
            className="prim"
            disabled={busy}
            onClick={() => {
              setLeftWarning(true);
              void go(() => confirmCreateVault(token));
            }}
          >
            Continue anyway
          </button>
          <button
            type="button"
            className="lnk"
            disabled={busy}
            onClick={() => {
              setLeftWarning(true);
              setToken(null);
            }}
          >
            Cancel
          </button>
        </div>
      </Frame>
    );
  }

  // A refusal of the folder is said under "Where it lives" (18c); any other is said above the buttons.
  const placeFailure = inside && failure !== null && failure.place;
  const failureAlert =
    failure === null ? null : (
      <p className="err" role="alert">
        {failure.text}
      </p>
    );

  return (
    <Frame say={inside ? SAY_NEW_VAULT : SAY_FIRST}>
      <form
        className="fu"
        onSubmit={submit}
        noValidate
        onKeyDown={(event) => {
          // Escape is Cancel where there is a vault to go back to.
          if (inside && event.key === "Escape" && !event.defaultPrevented) back();
        }}
      >
        <p className="fu-step">Step 1 of 2</p>
        <h1>{inside ? NEW_VAULT_HEADING : "Create your vault"}</h1>
        {inside ? null : <p className="fu-sub">Most people only need one. Make another later for things that need a separate password.</p>}
        <div>
          <label htmlFor={nameId}>Vault name</label>
          <input
            id={nameId}
            ref={nameBox}
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
            {inside ? NAME_HINT : "Anyone with a copy of the vault's folder can read this name, so keep secrets out of it."}
          </p>
        </div>
        <PasswordField
          label="Password"
          autoComplete="new-password"
          autoFocus={inside && leftWarning}
          value={password}
          rule="At least 12 characters."
          minimum={MIN_PASSWORD}
          readOnly={inside && busy}
          error={problems.password}
          onChange={(next) => {
            setPassword(next);
            setProblems((current) => ({ ...current, password: null, again: null }));
          }}
        />
        <PasswordField
          label={inside ? REPEAT_PASSWORD : "Password again"}
          autoComplete="new-password"
          value={again}
          readOnly={inside && busy}
          error={problems.again}
          onChange={(next) => {
            setAgain(next);
            setProblems((current) => ({ ...current, again: null }));
          }}
        />
        {inside ? (
          <div>
            <span className="fu-lab">{WHERE_IT_LIVES}</span>
            <div className="fu-row">
              <span className="fu-hint fu-where">
                {chooseFolder ? "You'll pick the folder when you press Continue." : "Kept in your Petalock Vaults folder on this PC."}
              </span>
              <button
                type="button"
                className="lnk"
                onClick={() => {
                  setChooseFolder((current) => !current);
                }}
              >
                {chooseFolder ? "Use the usual folder" : "Choose another"}
              </button>
            </div>
            {placeFailure ? failureAlert : null}
          </div>
        ) : (
          <div className="fu-row">
            <span className="fu-hint fu-where">
              {chooseFolder ? "You'll pick the folder when you press Create vault." : "Kept in your Petalock Vaults folder on this PC."}
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
        )}
        {placeFailure ? null : failureAlert}
        <div className="fu-row">
          <button type="submit" className="prim" disabled={busy}>
            {inside ? "Continue" : "Create vault"}
          </button>
          <button type="button" className="lnk" disabled={busy} onClick={back}>
            {inside ? "Cancel" : "Back"}
          </button>
        </div>
      </form>
    </Frame>
  );
}
