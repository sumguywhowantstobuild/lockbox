import { Popover } from "@base-ui/react/popover";
import { useEffect, useId, useRef, useState, type RefObject, type SyntheticEvent } from "react";
import { messageFor, messageText } from "../messages";
import { shownName } from "../openBackupWords";
import { Button } from "../parts/Button";
import { usePortalContainer } from "../parts/Portal";
import { lockOneVault, openChangePassword, openDetailsChanged, openNewRecoveryKey, renameVault, type SessionData } from "../store";

/** What the box says when the name has nothing in it (18b's words for the same thing). */
const NAME_FIRST = "Give the vault a name.";

/** The four refusals a rename shares with a backup, each with the button Ask 2 offers for it: what the words say to do first, for this vault. */
type Fix = "rename_details_changed" | "rename_details_unchecked" | "rename_password_copies_disagree" | "rename_recovery_key_copies_disagree";

const FIXES: Readonly<Record<Fix, { label: string; act: (session: number) => void }>> = {
  rename_details_changed: { label: "See the change", act: openDetailsChanged },
  rename_details_unchecked: {
    label: "Lock this vault",
    act: (session) => {
      void lockOneVault(session);
    },
  },
  rename_password_copies_disagree: { label: "Change password", act: openChangePassword },
  rename_recovery_key_copies_disagree: { label: "New recovery key", act: openNewRecoveryKey },
};

/** The way forward a rename's refusal asks for, or `null` when it asks for none (the page's own kind, from `asRenameRefusal` in the store). */
function fixFor(refusal: unknown): Fix | null {
  if (typeof refusal !== "object" || refusal === null || (refusal as { code?: unknown }).code !== "page") return null;
  const kind = (refusal as { kind?: unknown }).kind;
  return typeof kind === "string" && Object.hasOwn(FIXES, kind) ? (kind as Fix) : null;
}

/**
 * Rename vault (18d): a small box in the vault menu's own place and width, anchored to the vault button as the menu is, in which the vault's name can be changed. It holds the
 * current name, selected, with Cancel and Rename under it (no title, no picture, no close button). The page behind can't be reached while it is open (the keyboard stays in the
 * box and Escape closes it). Rename (or Enter) sends the name trimmed: nothing typed is said under the box and nothing is sent, the name it already has closes the box and sends
 * nothing, and while an answer is out Rename is `aria-disabled` and a second press sends nothing. A refusal is said in words under the box (never the shell's text), the box
 * marked and tied to the line, what was typed kept; the next change takes the words away. A refusal for one of the four reasons a backup is refused for offers, in Rename's
 * place, what its words ask for, as Ask 2 does (See the change, Lock this vault, Change password, New recovery key): it closes the box and opens that for this vault.
 * Done, Cancel and Escape close the box and give focus back to the vault button, and the
 * menu is not reopened. The box is for the vault it was opened in (its session and generation): an answer that comes after the box has gone says nothing.
 */
export function RenameVaultBox({
  data,
  anchor,
  onClose,
}: {
  data: Pick<SessionData, "session" | "generation" | "name" | "kind">;
  /** The vault button that opened the menu: where the box is drawn, and where focus goes when it closes. */
  anchor: RefObject<HTMLElement | null>;
  onClose: () => void;
}) {
  const id = useId();
  const container = usePortalContainer();
  const [typed, setTyped] = useState(data.name);
  const [problem, setProblem] = useState<string | null>(null);
  // The way forward a refusal's words ask for, offered in Rename's place until the name is changed again (Ask 2's button for the same reason).
  const [fix, setFix] = useState<Fix | null>(null);
  const [saving, setSaving] = useState(false);
  const box = useRef<HTMLInputElement>(null);
  // A second press before the first has an answer must not send a second rename.
  const sending = useRef(false);
  // Whether this box is still on screen: an answer that comes after it was closed (or its vault locked) does nothing.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const close = () => {
    onClose();
    window.setTimeout(() => {
      anchor.current?.focus();
    }, 0);
  };

  const submit = async (event: SyntheticEvent) => {
    event.preventDefault();
    if (sending.current) return;
    const name = typed.trim();
    if (name === "") {
      setProblem(NAME_FIRST);
      box.current?.focus();
      return;
    }
    if (name === data.name) {
      close();
      return;
    }
    sending.current = true;
    setSaving(true);
    setProblem(null);
    const done = await renameVault({ session: data.session, generation: data.generation }, name);
    sending.current = false;
    // Closed meanwhile (Cancel, Escape, a switch or a lock): nothing to close or say.
    if (!mounted.current) return;
    if (done === "stale") {
      onClose();
      return;
    }
    if (typeof done === "object") {
      setProblem(messageText(messageFor(done.failed)));
      setFix(fixFor(done.failed));
      setSaving(false);
      return;
    }
    close();
  };

  return (
    <Popover.Root
      open
      modal
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <Popover.Portal container={container}>
        <Popover.Positioner className="layer" anchor={anchor} sideOffset={6} align="start">
          <Popover.Popup className="menu mwide" aria-label="Rename vault" initialFocus={box}>
            <form className="rnbox" onSubmit={(event) => void submit(event)} noValidate>
              <div className="rnname">
                <label className="flab" htmlFor={`${id}-name`}>
                  {`New name for ${shownName(data)}`}
                </label>
                <input
                  ref={box}
                  id={`${id}-name`}
                  className="finp"
                  type="text"
                  autoComplete="off"
                  spellCheck={false}
                  value={typed}
                  aria-invalid={problem === null ? undefined : true}
                  aria-describedby={problem === null ? undefined : `${id}-problem`}
                  onFocus={(event) => {
                    event.currentTarget.select();
                  }}
                  onChange={(event) => {
                    setTyped(event.currentTarget.value);
                    setProblem(null);
                    setFix(null);
                  }}
                />
                {problem === null ? null : (
                  <p className="err" id={`${id}-problem`} role="alert">
                    {problem}
                  </p>
                )}
              </div>
              <div className="dbtns">
                <Popover.Close render={<Button />}>Cancel</Popover.Close>
                {fix === null ? (
                  <Button look="pill-main" type="submit" aria-disabled={saving ? true : undefined}>
                    Rename
                  </Button>
                ) : (
                  // What the words ask for first, for this vault: the box closes (its vault stays on screen) and that form or question opens, as Ask 2's button does.
                  <Button
                    look="pill-main"
                    onClick={() => {
                      onClose();
                      FIXES[fix].act(data.session);
                    }}
                  >
                    {FIXES[fix].label}
                  </Button>
                )}
              </div>
            </form>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
