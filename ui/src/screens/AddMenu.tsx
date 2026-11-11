import { rememberOpener } from "../focus";
import { PlusIcon } from "../parts/Icon";
import { Menu } from "../parts/Menu";
import { addStoredFile, openNewKey, openNewLogin, openNewNote, openPasteEnv } from "../store";

/**
 * Add (6a), at the right end of the toolbar: a menu of what can be added. A login, a key, a note and a file are equal in it, as
 * drawn, and a pasted .env is set apart after them. File picks one file in the Windows picker and stores it as an item in the folder on
 * screen (`folder`, `null` on All items); several at once is 4B's, so it is not "Files". Not shown in a vault opened from a backup, where
 * nothing can be added.
 */
export function AddMenu({ session, folder }: { session: number; folder: string | null }) {
  return (
    <div className="addslot">
      <Menu
        label="Add"
        triggerClassName="addb"
        icon={
          <>
            <PlusIcon />
            Add
          </>
        }
        items={[
          {
            label: "Login",
            onSelect: () => {
              rememberOpener(null);
              openNewLogin(session);
            },
          },
          {
            label: "Key",
            onSelect: () => {
              rememberOpener(null);
              openNewKey(session);
            },
          },
          {
            label: "Note",
            onSelect: () => {
              rememberOpener(null);
              openNewNote(session);
            },
          },
          {
            label: "File",
            onSelect: () => {
              void addStoredFile(session, folder);
            },
          },
          {
            label: "Paste a .env",
            apart: true,
            onSelect: () => {
              rememberOpener(null);
              openPasteEnv(session);
            },
          },
        ]}
      />
    </div>
  );
}
