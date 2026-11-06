import { Menu as BaseMenu } from "@base-ui/react/menu";
import type { ReactNode } from "react";
import { usePortalContainer } from "./Portal";

export interface MenuItem {
  label: string;
  onSelect: () => void;
  /** Drawn in red, for what deletes. */
  danger?: boolean;
}

/**
 * A short menu from a button. The button opens it by click or keyboard, the arrow keys move through the items, Enter
 * or a click chooses one and closes the menu, Escape closes it, and focus goes back to the button. With an `icon` the
 * button shows the picture and `label` is its name for a screen reader.
 */
export function Menu({
  label,
  icon,
  items,
  triggerClassName = "pill",
}: {
  label: string;
  icon?: ReactNode;
  items: readonly MenuItem[];
  triggerClassName?: string;
}) {
  const container = usePortalContainer();
  return (
    <BaseMenu.Root>
      <BaseMenu.Trigger className={triggerClassName} aria-label={icon === undefined ? undefined : label}>
        {icon ?? label}
      </BaseMenu.Trigger>
      <BaseMenu.Portal container={container}>
        <BaseMenu.Positioner className="layer" sideOffset={6}>
          <BaseMenu.Popup className="menu">
            {items.map((item) => (
              <BaseMenu.Item
                key={item.label}
                className={item.danger === true ? "mi dng" : "mi"}
                onClick={item.onSelect}
              >
                {item.label}
              </BaseMenu.Item>
            ))}
          </BaseMenu.Popup>
        </BaseMenu.Positioner>
      </BaseMenu.Portal>
    </BaseMenu.Root>
  );
}
