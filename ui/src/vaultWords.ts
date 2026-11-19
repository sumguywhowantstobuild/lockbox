// The words for a vault of the list that the vault menu and the vault strip say, beside its name (Plan 4C Task 6). The page's own: the design draws no screen for them.
import type { VaultEntry } from "./api";

/** What a locked vault says under its name in the vault menu, and in the strip's button. */
export const LOCKED = "Locked";

/** What a vault says when its folder can't be reached just now. */
export const NOT_AVAILABLE = "Not available";

/** The name of a vault whose details can't be read (the list gives it none). */
export const CANT_BE_READ = "A vault that can't be read";

/** A listed vault's name as the screens say it. */
export function listedName(vault: Pick<VaultEntry, "name">): string {
  return vault.name ?? CANT_BE_READ;
}
