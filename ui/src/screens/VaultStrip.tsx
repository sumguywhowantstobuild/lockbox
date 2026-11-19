import { LockIcon } from "../parts/Icon";
import { VaultMark, vaultLook } from "../parts/Pattern";
import { showSession, startUnlockStep, useSessions, useVaults, type SessionData } from "../store";
import { useMode } from "../theme";
import { listedName } from "../vaultWords";

/**
 * The vault strip, a column of buttons beside the side menu, there only from two vaults on the list (as approved, 2026-11-04): a button for every listed vault, in the
 * list's order, wearing its own mark and colour (by its place on the list, as the lock screen's list does). The one on screen is marked with a ring and `aria-current`,
 * never by colour alone; a locked vault has a small drawn lock and says "locked" in its name; one that can't be reached says "not available" and does nothing yet. A
 * button does what the vault's row of the vault menu does: an open vault's window comes to the front, a locked one opens its unlock step. Two vaults with the same name say
 * their place on the list as well ("My vault, 2 of 2"), and their marks differ by it.
 */
export function VaultStrip({ data }: { data: SessionData }) {
  const vaults = useVaults() ?? [];
  const sessions = useSessions();
  const mode = useMode();
  if (vaults.length < 2) return null;
  return (
    <nav className="dock" aria-label="Vaults">
      {vaults.map((vault, place) => {
        const session = sessions.find((one) => one.vaultId === vault.id);
        const look = vaultLook(place, false);
        const name = session?.name ?? listedName(vault);
        const alike = vaults.filter((other) => listedName(other) === listedName(vault)).length > 1;
        const state = session !== undefined ? null : vault.available ? "locked" : "not available";
        const words = [alike ? `${name}, ${String(place + 1)} of ${String(vaults.length)}` : name, state].filter((part) => part !== null).join(", ");
        const on = session?.session === data.session;
        return (
          // Its own colour (the mode class beside it, so the variables resolve here) and its own shape.
          <button
            key={vault.id}
            type="button"
            className={`dvault mode-${mode} v-${look.accent}${on ? " on" : ""}${state === "not available" ? " off" : ""}`}
            aria-label={words}
            title={words}
            aria-current={on ? "true" : undefined}
            aria-disabled={state === "not available" ? true : undefined}
            onClick={() => {
              if (session !== undefined) showSession(session.session);
              else if (vault.available) startUnlockStep(vault.id);
            }}
          >
            <VaultMark points={look.points} className="dmark" />
            {state === "locked" ? (
              <span className="dlock" aria-hidden="true">
                <LockIcon />
              </span>
            ) : null}
          </button>
        );
      })}
    </nav>
  );
}
