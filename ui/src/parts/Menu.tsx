import { Menu as BaseMenu } from "@base-ui/react/menu";
import type { ReactNode } from "react";
import { CheckIcon } from "./Icon";
import { usePortalContainer } from "./Portal";

export interface MenuItem {
  label: string;
  onSelect: () => void;
  /** Drawn in red, for what deletes. */
  danger?: boolean;
  /**
   * Tells the item apart from another with the same label (two folders may share a name); the label when left out. Used by a
   * menu of choices (`checked`), where it is the choice's own key.
   */
  id?: string;
  /**
   * Makes the menu one of choices (every item of it says it): `true` for the one that is chosen now. It is marked with a check
   * mark and said as "checked" to a screen reader (a choice of a group, not a plain action), and never by colour alone.
   */
  checked?: boolean;
}

/** A line that tells how something stands, in words (a vault and `Unlocked`). It is read, not chosen. */
export interface MenuNote {
  name: string;
  state: string;
}

/**
 * A short menu from a button. The button opens it by click or keyboard, the arrow keys move through the items, Enter
 * or a click chooses one and closes the menu, Escape closes it, and focus goes back to the button. With an `icon` the
 * button shows the picture and `label` is its name for a screen reader. `popupLabel` names the menu itself (a menu of
 * choices says what is being chosen). Items with `checked` are choices, one of which is marked. `notes` are lines above the items that say how
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
  popupLabel,
  triggerClassName = "pill",
}: {
  label: string;
  icon?: ReactNode;
  items: readonly MenuItem[];
  notes?: readonly MenuNote[];
  popupLabel?: string;
  triggerClassName?: string;
}) {
  const container = usePortalContainer();
  const chosen = items.find((item) => item.checked === true);
  const entries = items.some((item) => item.checked !== undefined) ? (
    <BaseMenu.RadioGroup value={chosen === undefined ? null : (chosen.id ?? chosen.label)}>
      {items.map((item) => (
        <BaseMenu.RadioItem
          key={item.id ?? item.label}
          value={item.id ?? item.label}
          closeOnClick
          className="mi"
          onClick={item.onSelect}
        >
          <span className="mt">{item.label}</span>
          <BaseMenu.RadioItemIndicator className="sel-on">
            <CheckIcon />
          </BaseMenu.RadioItemIndicator>
        </BaseMenu.RadioItem>
      ))}
    </BaseMenu.RadioGroup>
  ) : (
    items.map((item) => (
      <BaseMenu.Item key={item.label} className={item.danger === true ? "mi dng" : "mi"} onClick={item.onSelect}>
        {item.label}
      </BaseMenu.Item>
    ))
  );
  return (
    <BaseMenu.Root>
      <BaseMenu.Trigger className={triggerClassName} aria-label={icon === undefined ? undefined : label}>
        {icon ?? label}
      </BaseMenu.Trigger>
      <BaseMenu.Portal container={container}>
        <BaseMenu.Positioner className="layer" sideOffset={6}>
          <BaseMenu.Popup className={notes === undefined ? "menu" : "menu mwide"} aria-label={popupLabel}>
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
