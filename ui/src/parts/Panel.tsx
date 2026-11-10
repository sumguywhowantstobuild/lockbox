import type { KeyboardEventHandler, ReactNode, Ref } from "react";
import { CloseIcon } from "./Icon";

/**
 * The panel that slides in from the right: details of an item, and its forms. It is a named region, so a screen reader
 * can find it; its title is the heading of what is in it. The close button is always there. A form puts its buttons in
 * `footer`, a bar that stays in view while the fields scroll. `titleRef` reaches the heading, which can take focus when
 * the panel opens as the next step of what the person just did. `tools` are the pills (or a label) at the top, before Close: an
 * item's Edit, or "Read-only".
 */
export function Panel({
  title,
  subtitle,
  icon,
  titleClassName,
  titleRef,
  onClose,
  tools,
  footer,
  onKeyDown,
  children,
}: {
  title: string;
  subtitle?: string;
  /** The picture at the top left. */
  icon?: ReactNode;
  titleClassName?: string;
  titleRef?: Ref<HTMLHeadingElement>;
  onClose: () => void;
  tools?: ReactNode;
  footer?: ReactNode;
  /** Keys pressed inside the panel (and in a list or menu it opened): a panel that closes on Escape listens here. */
  onKeyDown?: KeyboardEventHandler<HTMLElement>;
  children?: ReactNode;
}) {
  return (
    <aside className="panel on" aria-label={title} onKeyDown={onKeyDown}>
      <div className="ptop">
        {icon === undefined ? null : <span className="pico">{icon}</span>}
        <span className="sp" />
        {tools}
        <button type="button" className="ib" aria-label="Close panel" onClick={onClose}>
          <CloseIcon />
        </button>
      </div>
      <div className="pscroll">
        <div>
          <h2 ref={titleRef} tabIndex={titleRef === undefined ? undefined : -1} className={["ptitle", titleClassName].filter(Boolean).join(" ")}>
            {title}
          </h2>
          {subtitle === undefined || subtitle === "" ? null : <p className="psub">{subtitle}</p>}
          {children}
        </div>
      </div>
      {footer === undefined ? null : <div className="pbar">{footer}</div>}
    </aside>
  );
}
