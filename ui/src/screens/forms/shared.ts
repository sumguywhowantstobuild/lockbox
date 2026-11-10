import { useEffect, type RefObject } from "react";
import type { SelectChoice } from "../../parts/Select";
import type { FolderEntry } from "../SideMenu";

/**
 * Whether `text` has a line break anywhere but its very start or end. A one-line box drops a break at either end (a pasted key
 * or password that ends with one is still that), but would join the lines of anything longer without a word, and a credential
 * must never change silently. The one check for every one-line box that takes a credential (a key's Value, a login's Password).
 */
export function hasInnerLineBreak(text: string): boolean {
  return /[\r\n]/.test(text.replace(/^[\r\n]+|[\r\n]+$/g, ""));
}

/** What a login form says when a paste or a drop into the Password box holds a line break inside it: nothing was changed. */
export const PASSWORD_MANY_LINES = "That password has more than one line, so it wasn't pasted. A password is one line here.";

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
