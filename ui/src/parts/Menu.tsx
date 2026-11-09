import { Menu as BaseMenu } from "@base-ui/react/menu";
import type { ReactNode } from "react";
import { usePortalContainer } from "./Portal";

export interface MenuItem {
  label: string;
  onSelect: () => void;
  /** Drawn in red, for what deletes. */
  danger?: boolean;
}

/** A line that tells how something stands, in words (a vault and `Unlocked`). It is read, not chosen. */
export interface MenuNote {
  name: string;
  state: string;
}

/**
 * A short menu from a button. The button opens it by click or keyboard, the arrow keys move through the items, Enter
 * or a click chooses one and closes the menu, Escape closes it, and focus goes back to the button. With an `icon` the
 * button shows the picture and `label` is its name for a screen reader. `notes` are lines above the items that say how
 * things stand; they can't be chosen, so a screen reader hears them as the name of the group the items sit in (arriving
 * at the first item says "My vault, Unlocked. Home, Locked.", then the item), and the lines themselves are left out of
 * its tree so nothing is said twice. With many lines the menu stays within the room the window leaves it: the lines
 * scroll in their own area and the items stay in view below them.
 */
export function Menu({
  label,
  icon,
  items,
  notes,
  triggerClassName = "pill",
}: {
  label: string;
  icon?: ReactNode;
  items: readonly MenuItem[];
  notes?: readonly MenuNote[];
  triggerClassName?: string;
}) {
  const container = usePortalContainer();
  const entries = items.map((item) => (
    <BaseMenu.Item key={item.label} className={item.danger === true ? "mi dng" : "mi"} onClick={item.onSelect}>
      {item.label}
    </BaseMenu.Item>
  ));
  return (
    <BaseMenu.Root>
      <BaseMenu.Trigger className={triggerClassName} aria-label={icon === undefined ? undefined : label}>
        {icon ?? label}
      </BaseMenu.Trigger>
      <BaseMenu.Portal container={container}>
        <BaseMenu.Positioner className="layer" sideOffset={6}>
          <BaseMenu.Popup className={notes === undefined ? "menu" : "menu mwide"}>
            {notes === undefined || notes.length === 0 ? (
              entries
            ) : (
              <>
                <div className="mscroll">
                  {notes.map((note, at) => (
                    <div key={at} className="mnote" aria-hidden="true">
                      <span className="mt">{note.name}</span>
                      <span className="ms">{note.state}</span>
                    </div>
                  ))}
                </div>
                <div className="mline" aria-hidden="true" />
                <BaseMenu.Group aria-label={notes.map((note) => `${note.name}, ${note.state}.`).join(" ")}>
                  {entries}
                </BaseMenu.Group>
              </>
            )}
          </BaseMenu.Popup>
        </BaseMenu.Positioner>
      </BaseMenu.Portal>
    </BaseMenu.Root>
  );
}
