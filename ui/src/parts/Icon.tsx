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
  key: "M8 20a4.5 4.5 0 1 1 0-9 4.5 4.5 0 0 1 0 9Z M11.2 12.3 19.5 4 M15.8 7.7l3 3 M13 10.5l2 2",
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

export function CheckIcon() {
  return <Drawing d="M5 12.5l4.5 4.5L19 7.5" />;
}

export function CloseIcon() {
  return <Drawing d="M6 6l12 12M18 6L6 18" />;
}

export function FilterIcon() {
  return <Drawing d="M4 7h16M7.5 12h9M10.5 17h3" />;
}

export function SearchIcon() {
  return (
    <svg className="i" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-3.8-3.8" />
    </svg>
  );
}

export function PlusIcon() {
  return <Drawing d="M12 5v14M5 12h14" />;
}

/** Eight short rays round a point: the Generator. */
export function GeneratorIcon() {
  return <Drawing d="M12 4v3M12 17v3M4 12h3M17 12h3M6.5 6.5l2 2M15.5 15.5l2 2M17.5 6.5l-2 2M8.5 15.5l-2 2" />;
}

/** A bin: the Trash. */
export function TrashIcon() {
  return (
    <svg className="i" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 7h14M10 7V5.5A1.5 1.5 0 0 1 11.5 4h1A1.5 1.5 0 0 1 14 5.5V7M7 7l.8 11.2A1.5 1.5 0 0 0 9.3 19.5h5.4a1.5 1.5 0 0 0 1.5-1.3L17 7" />
    </svg>
  );
}

/** Three dots: more for this (the folder's menu). */
export function MoreIcon() {
  return (
    <svg className="i" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="6" cy="12" r="1.2" />
      <circle cx="12" cy="12" r="1.2" />
      <circle cx="18" cy="12" r="1.2" />
    </svg>
  );
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
