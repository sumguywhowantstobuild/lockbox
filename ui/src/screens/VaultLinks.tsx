import { useEffect, useRef, useState } from "react";
import type { VaultEntry } from "../api";
import { messageFor, messageText } from "../messages";
import { showVaultFolder } from "../store";
import { listedName } from "../vaultWords";
import { RemoveVaultBox } from "./VaultBoxes";

/**
 * The two quiet links a locked or unreadable vault's own screen has beside Back (the unlock step, and Ask 8 wherever it shows), in the vault menu's own words and order:
 * `Show <name> in Explorer` and `Remove <name> from this list`. Show asks the shell to open the vault's folder (the page never has a path) and says a refusal in words through
 * `onProblem`, for the screen's own error line (`null` when a new press begins); Remove opens 18g, anchored to its own button, which gives focus back to it on Cancel or
 * Escape, and calls `onRemoved` once the vault is off the list. Both name the row as the list gave it.
 */
export function VaultLinks({ vault, onRemoved, onProblem }: { vault: VaultEntry; onRemoved: () => void; onProblem: (words: string | null) => void }) {
  const name = listedName(vault);
  const [asking, setAsking] = useState(false);
  const removeButton = useRef<HTMLButtonElement>(null);
  const showing = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const show = async () => {
    if (showing.current) return;
    showing.current = true;
    onProblem(null);
    const done = await showVaultFolder({ list: vault.list, id: vault.id });
    showing.current = false;
    if (mounted.current && done !== "done") onProblem(messageText(messageFor(done.failed)));
  };

  return (
    <>
      <button
        type="button"
        className="lnk"
        onClick={() => {
          void show();
        }}
      >
        {`Show ${name} in Explorer`}
      </button>
      <button
        type="button"
        className="lnk"
        ref={removeButton}
        onClick={() => {
          setAsking(true);
        }}
      >
        {`Remove ${name} from this list`}
      </button>
      {asking ? (
        <RemoveVaultBox
          vault={vault}
          name={name}
          anchor={removeButton}
          onClose={() => {
            setAsking(false);
          }}
          onDone={() => {
            setAsking(false);
            onProblem(null);
            onRemoved();
          }}
        />
      ) : null}
    </>
  );
}
