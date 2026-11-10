import { useEffect, type RefObject } from "react";
import type { SelectChoice } from "../../parts/Select";
import type { FolderEntry } from "../SideMenu";

/** The Folder list's value for "No folder": never an item's id, which is 32 hex characters. */
export const NO_FOLDER = "none";

/**
 * The folders to pick from: the one on screen first, then the rest by name, and "No folder" last, or first when All items is
 * on screen (nothing is the one on screen then).
 */
export function folderChoices(folders: readonly FolderEntry[], onScreen: string | null): SelectChoice[] {
  const named = folders.map((folder) => ({ value: folder.id, label: folder.name }));
  const none = { value: NO_FOLDER, label: "No folder" };
  if (onScreen === null) return [none, ...named];
  const first = named.filter((choice) => choice.value === onScreen);
  return [...first, ...named.filter((choice) => choice.value !== onScreen), none];
}

/** Where a form says it will put the item: "In My vault." or "In Agency, My vault.". */
export function whereWords(folders: readonly FolderEntry[], folder: string, vaultName: string): string {
  const folderName = folders.find((entry) => entry.id === folder)?.name;
  return folderName === undefined ? `In ${vaultName}.` : `In ${folderName}, ${vaultName}.`;
}

/**
 * Focus goes to the first field when a form opens. A menu or the search that opened it gives focus back to its own button as
 * it closes, which can come after this, so it is taken once more a moment later if it has gone elsewhere.
 */
export function useFocusOnOpen(field: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    field.current?.focus();
    const again = window.setTimeout(() => {
      if (document.activeElement === document.body || document.activeElement?.closest(".addb") != null) {
        field.current?.focus();
      }
    }, 0);
    return () => {
      window.clearTimeout(again);
    };
  }, [field]);
}
