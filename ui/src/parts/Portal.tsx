// Where the parts that float (dialogs, menus, lists) are put. They are drawn into the page's body by default, which is
// outside the screen's root and so outside the classes that carry its colours; the root says where to draw them instead.
import { createContext, useContext } from "react";

const PortalContainer = createContext<HTMLElement | undefined>(undefined);

/** Gives the floating parts below it the screen's root to be drawn in. */
export const PortalContainerProvider = PortalContainer.Provider;

/**
 * The element a floating part is drawn in. `undefined` (not `null`, which the library reads as "nowhere") when none was
 * given, which draws it in the page's body.
 */
export function usePortalContainer(): HTMLElement | undefined {
  return useContext(PortalContainer);
}
