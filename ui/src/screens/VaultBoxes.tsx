import { Popover } from "@base-ui/react/popover";
import { useEffect, useRef, useState, type RefObject } from "react";
import type { VaultRef } from "../api";
import { messageFor, messageText } from "../messages";
import { Button } from "../parts/Button";
import { usePortalContainer } from "../parts/Portal";
import { removeVault, startUnlockStep, tryVaultAgain, useSessions, useVaults } from "../store";
import { removeSentence, STILL_UNAVAILABLE, unavailableSentence } from "../vaultWords";

/** Whether this box is still on screen: an answer that comes after it was closed (or its window locked) does nothing. */
function useMounted() {
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return mounted;
}

/**
 * Remove from list (18g): a small box in the vault menu's own place and width (the popup is `menu mwide`), anchored to `anchor` (the vault button, or the Remove button
 * of an unlock step or of a lock screen's row), which asks before a vault leaves the list: its folder and everything in it stay on the PC, and it can be brought back. It is a
 * question (`alertdialog`) and the page behind can't be reached while it is up; focus starts on Cancel, the choice that changes nothing. Remove sends the row as the list gave it
 * and, while the answer is out, is `aria-disabled` so a second press sends nothing. A refusal is said in words under the sentence (never the shell's text) and the box stays;
 * done calls `onDone` and says nothing more, since what comes next (the window the lock takes, the lock screen, the first screen) is the app's. Cancel and Escape close the box and
 * give focus back to `anchor`. When removing would leave the first screen (the only listed vault, no other window open), the last sentence points at the first screen's own
 * way back instead.
 */
export function RemoveVaultBox({
  vault,
  name,
  anchor,
  onClose,
  onDone,
}: {
  vault: VaultRef;
  name: string;
  anchor: RefObject<HTMLElement | null>;
  onClose: () => void;
  onDone: () => void;
}) {
  const container = usePortalContainer();
  const vaults = useVaults() ?? [];
  const sessions = useSessions();
  const [problem, setProblem] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const cancel = useRef<HTMLButtonElement>(null);
  // A second press before the first has an answer must not send a second Remove, and state changes too late for that.
  const sending = useRef(false);
  const mounted = useMounted();
  const leavesFirstScreen = vaults.length === 1 && vaults[0]?.id === vault.id && !sessions.some((one) => one.vaultId !== vault.id);

  const close = () => {
    onClose();
    window.setTimeout(() => {
      anchor.current?.focus();
    }, 0);
  };

  const remove = async () => {
    if (sending.current) return;
    sending.current = true;
    setRemoving(true);
    setProblem(null);
    const done = await removeVault({ list: vault.list, id: vault.id });
    sending.current = false;
    // Done is the host's to follow up even when this box is gone (the screen it was on went with the vault: the vault's own window, its unlock step, its row).
    if (done === "done") {
      onDone();
      return;
    }
    // Closed meanwhile (Cancel, Escape, or the vault's window went with its lock): nothing to say.
    if (!mounted.current) return;
    setProblem(messageText(messageFor(done.failed)));
    setRemoving(false);
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
          <Popover.Popup className="menu mwide" role="alertdialog" aria-label="Remove vault from this list" initialFocus={cancel}>
            <div className="mbox">
              <Popover.Description render={<p className="mwarn" />}>{removeSentence(name, leavesFirstScreen)}</Popover.Description>
              {problem === null ? null : (
                <p className="err mproblem" role="alert">
                  {problem}
                </p>
              )}
              <div className="dbtns">
                <Popover.Close render={<Button ref={cancel} />}>Cancel</Popover.Close>
                <Button
                  look="pill-main"
                  aria-disabled={removing ? true : undefined}
                  onClick={() => {
                    void remove();
                  }}
                >
                  Remove
                </Button>
              </div>
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

/**
 * The box an unavailable vault's row of the vault menu opens, in the menu's place (30b's words, the session's box): it says the folder or drive isn't there and offers Cancel,
 * Remove from list (which `onRemove` turns into 18g in the same place) and Try again, where focus starts. Try again reads the list again: back, it closes the box and opens the
 * vault's unlock step; still unavailable, it says so in a status line and the box stays; the row gone, the box closes; a list that can't be read is said in words.
 */
export function UnavailableVaultBox({
  vault,
  name,
  anchor,
  onClose,
  onRemove,
}: {
  vault: VaultRef;
  name: string;
  anchor: RefObject<HTMLElement | null>;
  onClose: () => void;
  onRemove: () => void;
}) {
  const container = usePortalContainer();
  const [still, setStill] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [trying, setTrying] = useState(false);
  const tryAgain = useRef<HTMLButtonElement>(null);
  const sending = useRef(false);
  const mounted = useMounted();

  const close = () => {
    onClose();
    window.setTimeout(() => {
      anchor.current?.focus();
    }, 0);
  };

  const retry = async () => {
    if (sending.current) return;
    sending.current = true;
    setTrying(true);
    setStill("");
    setProblem(null);
    const found = await tryVaultAgain(vault.id);
    sending.current = false;
    if (!mounted.current) return;
    setTrying(false);
    if (found === "back") {
      // The unlock step takes the window: focus is its password box's, so none goes back to the vault button.
      onClose();
      startUnlockStep(vault.id);
    } else if (found === "gone") {
      close();
    } else if (found === "still") {
      setStill(STILL_UNAVAILABLE);
    } else {
      setProblem(messageText(messageFor(found.failed)));
    }
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
          <Popover.Popup className="menu mwide" aria-label={`${name} is unavailable`} initialFocus={tryAgain}>
            <div className="mbox">
              <p className="mwarn">{unavailableSentence(name)}</p>
              {/* Always on the page, so a change in it is spoken. */}
              <p role="status" className="mstill">
                {still}
              </p>
              {problem === null ? null : (
                <p className="err mproblem" role="alert">
                  {problem}
                </p>
              )}
              <div className="dbtns">
                <Popover.Close render={<Button />}>Cancel</Popover.Close>
                <Button onClick={onRemove}>Remove from list</Button>
                <Button
                  ref={tryAgain}
                  look="pill-main"
                  aria-disabled={trying ? true : undefined}
                  onClick={() => {
                    void retry();
                  }}
                >
                  Try again
                </Button>
              </div>
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
