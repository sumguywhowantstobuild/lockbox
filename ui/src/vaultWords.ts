// The words for a vault of the list that the vault menu and the vault strip say, beside its name (Plan 4C Task 6). The page's own: the design draws no screen for them.
import type { VaultEntry } from "./api";

/** What an open vault says under its name in the vault menu (18a's words). */
export const UNLOCKED = "Unlocked";

/** What a locked vault says under its name in the vault menu, and in the strip's button. */
export const LOCKED = "Locked";

/** What a vault says when its folder can't be reached just now. */
export const NOT_AVAILABLE = "Not available";

/** What an unavailable vault says under its name on the lock screen (30b's words). */
export const UNAVAILABLE_LINE = "Unavailable: its folder or drive isn't there";

/** What Try again says when the folder or drive is still not there. The words are the session's, for Ariel to change. */
export const STILL_UNAVAILABLE = "Still unavailable. Connect its drive or put its folder back, then try again.";

/** The unavailable box's sentence (30b gives the line above; the box is the session's, for Ariel to change). */
export function unavailableSentence(name: string): string {
  return `${name} is unavailable: its folder or drive isn't there.`;
}

/**
 * 18g's words: the design's own. When removing the vault would leave the first screen (it is the only one listed and no other window stays open), the last sentence points
 * at the first screen's own way back instead, since Add existing vault folder is not there (the design's pointer for the same case, "Vault made but not listed"; the
 * session's call, for Ariel to change).
 */
export function removeSentence(name: string, leavesFirstScreen: boolean): string {
  const back = leavesFirstScreen ? `"I already have a vault or a backup" on the first screen` : "Add existing vault folder";
  return `Remove ${name} from this list? Its folder and everything in it stay on your PC. You can bring it back with ${back}.`;
}

/** The name of a vault whose details can't be read (the list gives it none). */
export const CANT_BE_READ = "A vault that can't be read";

/** A listed vault's name as the screens say it. */
export function listedName(vault: Pick<VaultEntry, "name">): string {
  return vault.name ?? CANT_BE_READ;
}

/**
 * The name a row of the list `vaults` says for the vault at `place` (`name`: an open vault's own, else its listed name): with that place on the list, "My vault,
 * 2 of 3", when another listed vault reads the same, so two rows never look or sound alike (every new vault starts as "My vault"). The vault strip, the vault menu
 * and Copy to a vault all say it (the save box's list has its own, which counts the vaults it offers).
 */
export function placedName(vaults: readonly Pick<VaultEntry, "name">[], place: number, name?: string): string {
  const vault = vaults[place];
  if (vault === undefined) return name ?? "";
  const shown = name ?? listedName(vault);
  const alike = vaults.filter((other) => listedName(other) === listedName(vault)).length > 1;
  return alike ? `${shown}, ${String(place + 1)} of ${String(vaults.length)}` : shown;
}
