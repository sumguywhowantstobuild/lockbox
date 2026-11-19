import { Menu as BaseMenu } from "@base-ui/react/menu";
import { Fragment, type ReactNode } from "react";
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
  /** Set apart from the items before it by a divider line (a plain menu, not one of choices). */
  apart?: boolean;
  /** A picture before the words (a plain menu): the kinds in Add, as drawn (6a). Hidden from a screen reader. */
  icon?: ReactNode;
}

/**
 * A row of the vault menu: every vault of the list (open or locked) and every open backup or older copy, a menu item of a group of its own above the menu's actions, one
 * of which, `checked`, is the one that is on screen now. `detail` is the quiet line under the name that says what the row is (Locked, Backup, Not available). A row
 * that is `unavailable` can be reached and read but does nothing when it is chosen, and the menu stays open.
 */
export interface MenuRow {
  /** Tells the row apart from another with the same name. */
  id: string;
  label: string;
  detail?: string;
  checked: boolean;
  /** Reached by the keys and read as unavailable (`aria-disabled`); choosing it does nothing. */
  unavailable?: boolean;
  onSelect: () => void;
}

/**
 * A short menu from a button. The button opens it by click or keyboard, the arrow keys move through the items, Enter
 * or a click chooses one and closes the menu, Escape closes it, and focus goes back to the button. With an `icon` the
 * button shows the picture and `label` is its name for a screen reader. `popupLabel` names the menu itself (a menu of
 * choices says what is being chosen). Items with `checked` are choices, one of which is marked. `rows` are choosable rows above the plain items (the vault menu's, drawn
 * wide), in a group of their own named `rowsLabel`: each is a menu item (a radio item, so the one that is `checked` is said as "checked" and marked with a check mark,
 * never by colour alone), and choosing one closes the menu. The arrow keys reach every row (each is a menu item, which is why a locked vault is a row and not a line of text a
 * keyboard can't reach), and the menu scrolls the row that has focus into view of the area the rows scroll in; with many rows the menu stays within the room the window
 * leaves it, the rows scroll and the actions stay in view below them.
 */
export function Menu({
  label,
  icon,
  items,
  rows,
  rowsLabel = "Vaults",
  popupLabel,
  triggerClassName = "pill",
}: {
  label: string;
  icon?: ReactNode;
  items: readonly MenuItem[];
  rows?: readonly MenuRow[];
  rowsLabel?: string;
  popupLabel?: string;
  triggerClassName?: string;
}) {
  const container = usePortalContainer();
  const chosen = items.find((item) => item.checked === true);
  const choices = items.some((item) => item.checked !== undefined);
  // The vault menu (with rows) and a menu of choices (Move) each have their drawn width; a choice menu lines up with its
  // button's right edge, as drawn (12a), so it stays inside the panel.
  const popupClass = rows !== undefined ? "menu mwide" : choices ? "menu mpick" : "menu";
  const entries = choices ? (
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
    <>
      {rows === undefined || rows.length === 0 ? null : (
        <>
          {/* The rows scroll in an area of their own, so many vaults, backups and older copies never push the actions out of a menu the window has made short. */}
          <div className="mscroll">
            <BaseMenu.RadioGroup value={rows.find((row) => row.checked)?.id ?? null} aria-label={rowsLabel}>
              {rows.map((row) => (
                <BaseMenu.RadioItem
                  key={row.id}
                  value={row.id}
                  closeOnClick={row.unavailable !== true}
                  className="mi"
                  aria-disabled={row.unavailable === true ? true : undefined}
                  onClick={() => {
                    if (row.unavailable !== true) row.onSelect();
                  }}
                >
                  <span className="mtwo">
                    <span className="mt">{row.label}</span>
                    {row.detail === undefined ? null : <span className="ms">{row.detail}</span>}
                  </span>
                  <BaseMenu.RadioItemIndicator className="sel-on">
                    <CheckIcon />
                  </BaseMenu.RadioItemIndicator>
                </BaseMenu.RadioItem>
              ))}
            </BaseMenu.RadioGroup>
          </div>
          <div className="mline" aria-hidden="true" />
        </>
      )}
      {items.map((item) => (
        <Fragment key={item.label}>
          {item.apart === true ? <BaseMenu.Separator className="mline" /> : null}
          <BaseMenu.Item className={item.danger === true ? "mi dng" : "mi"} onClick={item.onSelect}>
            {item.icon}
            {item.label}
          </BaseMenu.Item>
        </Fragment>
      ))}
    </>
  );
  return (
    <BaseMenu.Root>
      <BaseMenu.Trigger className={triggerClassName} aria-label={icon === undefined ? undefined : label}>
        {icon ?? label}
      </BaseMenu.Trigger>
      <BaseMenu.Portal container={container}>
        <BaseMenu.Positioner className="layer" sideOffset={6} align={choices ? "end" : "center"}>
          <BaseMenu.Popup className={popupClass} aria-label={popupLabel}>
            {entries}
          </BaseMenu.Popup>
        </BaseMenu.Positioner>
      </BaseMenu.Portal>
    </BaseMenu.Root>
  );
}
