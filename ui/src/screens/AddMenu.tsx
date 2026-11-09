import { PlusIcon } from "../parts/Icon";
import { Menu } from "../parts/Menu";
import { openNewLogin } from "../store";

/**
 * Add (6a), at the right end of the toolbar: a menu of what can be added. A login is the only kind in this version; a key
 * and a note come with their forms, and a file and a pasted .env with theirs, and none of them is listed before it works.
 * Not shown in a vault opened from a backup, where nothing can be added.
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
              openNewLogin(session);
            },
          },
        ]}
      />
    </div>
  );
}
