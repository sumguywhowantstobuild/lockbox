import type { ReactNode } from "react";
import { CloseIcon } from "./Icon";

/**
 * The panel that slides in from the right: details of an item, and later its forms. It is a named region, so a screen
 * reader can find it; its title is the heading of what is in it. The close button is always there.
 */
export function Panel({
  title,
  subtitle,
  icon,
  titleClassName,
  onClose,
  children,
}: {
  title: string;
  subtitle?: string;
  /** The picture at the top left. */
  icon?: ReactNode;
  titleClassName?: string;
  onClose: () => void;
  children?: ReactNode;
}) {
  return (
    <aside className="panel on" aria-label={title}>
      <div className="ptop">
        {icon === undefined ? null : <span className="pico">{icon}</span>}
        <span className="sp" />
        <button type="button" className="ib" aria-label="Close panel" onClick={onClose}>
          <CloseIcon />
        </button>
      </div>
      <div className="pscroll">
        <div>
          <h2 className={["ptitle", titleClassName].filter(Boolean).join(" ")}>{title}</h2>
          {subtitle === undefined || subtitle === "" ? null : <p className="psub">{subtitle}</p>}
          {children}
        </div>
      </div>
    </aside>
  );
}
