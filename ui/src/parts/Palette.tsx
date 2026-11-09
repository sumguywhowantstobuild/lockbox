import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import type { KeyboardEventHandler, ReactNode, RefObject } from "react";
import { usePortalContainer } from "./Portal";

/**
 * A box near the top of the window for finding something and acting on it, over a dimmed page: the search. Like a
 * dialog, Base UI holds focus inside it while it is open, gives focus back to what had it when it closes, keeps the page
 * behind out of reach of the keyboard and of a screen reader, and closes it on `Escape`. `label` is its name (it is not
 * drawn: the box inside it has its own words). Focus lands on `initialFocus`, the box to type in.
 */
export function Palette({
  open,
  onOpenChange,
  label,
  initialFocus,
  onKeyDown,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  label: string;
  initialFocus: RefObject<HTMLElement | null>;
  /** Keys that reach the box from anything inside it (the arrow keys between results). */
  onKeyDown?: KeyboardEventHandler<HTMLElement>;
  children?: ReactNode;
}) {
  const container = usePortalContainer();
  return (
    <BaseDialog.Root open={open} onOpenChange={onOpenChange}>
      <BaseDialog.Portal container={container}>
        <BaseDialog.Backdrop className="scrim" />
        <BaseDialog.Popup className="pal find" initialFocus={initialFocus} onKeyDown={onKeyDown}>
          <BaseDialog.Title className="sr">{label}</BaseDialog.Title>
          {children}
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}
