import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import type { ReactNode, RefObject } from "react";
import { usePortalContainer } from "./Portal";

/**
 * A question or a notice over the screen. Base UI holds focus inside it while it is open and gives focus back to what
 * had it when it closes; the page behind is out of reach of the keyboard and of a screen reader meanwhile. `Escape`
 * closes it. Its buttons are the children, so a dialog that asks lists its answers there. Focus lands on the first
 * button unless `initialFocus` names another one: a question whose first answer does harm names the safe one.
 */
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  body,
  initialFocus,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** One sentence or paragraph, or a list of paragraphs: a screen reader reads them all as the dialog's description. */
  description?: string | readonly string[];
  /** What sits between the words and the buttons: a dialog that asks for a line of text (a folder's name) puts its box here. */
  body?: ReactNode;
  initialFocus?: RefObject<HTMLElement | null>;
  children?: ReactNode;
}) {
  const container = usePortalContainer();
  return (
    <BaseDialog.Root open={open} onOpenChange={onOpenChange}>
      <BaseDialog.Portal container={container}>
        <BaseDialog.Backdrop className="scrim" />
        <BaseDialog.Popup className="pal sm dlg" initialFocus={initialFocus}>
          <BaseDialog.Title>{title}</BaseDialog.Title>
          {description === undefined ? null : typeof description === "string" ? (
            <BaseDialog.Description>{description}</BaseDialog.Description>
          ) : (
            // Several paragraphs: the description is the box that holds them (a paragraph can't hold paragraphs).
            <BaseDialog.Description render={<div />}>
              {description.map((paragraph) => (
                <p key={paragraph}>{paragraph}</p>
              ))}
            </BaseDialog.Description>
          )}
          {body}
          <div className="dbtns">{children}</div>
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}
