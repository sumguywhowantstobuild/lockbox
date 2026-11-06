// The small line pictures of the approved screens. Each is drawn for the eye only (`aria-hidden`): the button or row
// that holds it carries the name. Colour and size come from the style sheet.
import type { ItemKind } from "../api";

function Drawing({ d, className = "i" }: { d: string; className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

const KIND_PATHS: Record<ItemKind, string> = {
  login: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z M4.5 20.5c.6-3.9 3.7-6 7.5-6s6.9 2.1 7.5 6",
  note: "M6.5 4h11A1.5 1.5 0 0 1 19 5.5v13a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 18.5v-13A1.5 1.5 0 0 1 6.5 4Z M8.5 9h7 M8.5 12.5h7 M8.5 16h4",
  file: "M13.5 3.5H7A1.5 1.5 0 0 0 5.5 5v14A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5V8.5Z M13.5 3.5v5h5",
  collection: "M4 6.5A1.5 1.5 0 0 1 5.5 5h4l2 2.5h7A1.5 1.5 0 0 1 20 9v8.5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5Z",
};

/** The picture of a kind of item, in the colour of the vault. */
export function KindIcon({ kind }: { kind: ItemKind }) {
  return <Drawing d={KIND_PATHS[kind]} className="ki" />;
}

export function CopyIcon() {
  return (
    <svg className="i" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="9" y="9" width="11" height="11" rx="2.5" />
      <path d="M5 15V6.5A1.5 1.5 0 0 1 6.5 5H15" />
    </svg>
  );
}

export function ChevronsIcon() {
  return <Drawing d="M8 10l4-4 4 4M8 14l4 4 4-4" />;
}

export function SideMenuIcon() {
  return (
    <svg className="i" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="4" y="5" width="16" height="14" rx="2.5" />
      <path d="M9.5 5v14" />
    </svg>
  );
}

export function ListIcon() {
  return <Drawing d="M5 7h14M5 12h14M5 17h14" />;
}

export function CloseIcon() {
  return <Drawing d="M6 6l12 12M18 6L6 18" />;
}

export function FilterIcon() {
  return <Drawing d="M4 7h16M7.5 12h9M10.5 17h3" />;
}

export function LockIcon() {
  return (
    <svg className="i" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="6" y="11" width="12" height="9" rx="2" />
      <path d="M9 11V8a3 3 0 0 1 6 0v3" />
    </svg>
  );
}

export function PaperclipIcon() {
  return (
    <svg className="i rclip" viewBox="0 0 24 24" role="img" aria-label="Has attached files">
      <path d="M20 11.5l-8 8a5 5 0 0 1-7-7l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7L9.7 17.2a1.7 1.7 0 0 1-2.4-2.4l7.7-7.7" />
    </svg>
  );
}
