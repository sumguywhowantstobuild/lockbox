import { rememberOpener } from "../focus";
import { PlusIcon } from "../parts/Icon";
import { Menu } from "../parts/Menu";
import { openNewKey, openNewLogin, openNewNote, openPasteEnv } from "../store";

/**
 * Add (6a), at the right end of the toolbar: a menu of what can be added. A login, a key and a note are equal in it, as
 * drawn, and a pasted .env is set apart after them; a file comes with its form, and is not listed before it works. Not shown
 * in a vault opened from a backup, where nothing can be added.
 */
export function AddMenu({ session }: { session: number }) {
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
