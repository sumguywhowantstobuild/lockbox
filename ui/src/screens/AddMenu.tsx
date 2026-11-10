import { rememberOpener } from "../focus";
import { PlusIcon } from "../parts/Icon";
import { Menu } from "../parts/Menu";
import { openNewKey, openNewLogin, openNewNote } from "../store";

/**
 * Add (6a), at the right end of the toolbar: a menu of what can be added. A login, a key and a note are equal in it, as
 * drawn; a file and a pasted .env come with their forms, and neither is listed before it works. Not shown in a vault opened
 * from a backup, where nothing can be added.
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
        ]}
      />
    </div>
  );
}
