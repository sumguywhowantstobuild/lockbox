import { memo, useMemo, useState } from "react";
import type { CopyableField, ItemKind, ItemSummary } from "../api";
import { agoWords, formatBytes } from "../format";
import { Clip } from "../parts/Clip";
import { CopyIcon, KindIcon, PaperclipIcon } from "../parts/Icon";
import type { SortChoice } from "./ListTools";

/** The groups of the list, in the order they show (keys first, as drawn), and the words for each. */
const GROUPS: { kind: ItemKind; heading: string }[] = [
  { kind: "key", heading: "Keys" },
  { kind: "login", heading: "Logins" },
  { kind: "note", heading: "Notes" },
  { kind: "file", heading: "Files" },
];

/** The kind a row says first, for a screen reader: "Login: Bot admin console". */
const KIND_WORD: Record<ItemKind, string> = { login: "Login", key: "Key", note: "Note", file: "File", collection: "Folder" };

// A picture colour for each kind of item, as the approved screens had them.
const TILE: Record<ItemKind, string> = { login: "t0", file: "t1", note: "t2", key: "t3", collection: "t4" };

/** What a row's copy button copies, and how it is named for a screen reader; a note and a file have none. */
const COPY: Partial<Record<ItemKind, { field: CopyableField; word: string }>> = {
  login: { field: "password", word: "password" },
  key: { field: "key_value", word: "key" },
};

function detailOf(item: ItemSummary): string {
  if (item.kind === "login") return item.username ?? "";
  const file = item.attachments[0];
  if (item.kind === "file" && file !== undefined) return `${file.name} · ${formatBytes(file.length)}`;
  return "";
}

// One comparer for every name, made once: a list of thousands is sorted with it on each change.
const NAMES = new Intl.Collator(undefined, { sensitivity: "base" });

function byTitle(a: ItemSummary, b: ItemSummary): number {
  return NAMES.compare(a.title, b.title);
}

/** The one changed last first. The dates are the engine's own fixed-format text, so their order is time's; then by name. */
function byChanged(a: ItemSummary, b: ItemSummary): number {
  if (a.modified_at !== b.modified_at) return a.modified_at < b.modified_at ? 1 : -1;
  return byTitle(a, b);
}

/**
 * One row: it opens the item, and a login's has a button that copies its password, a key's one that copies its value (both
 * in Rust: the page never holds either). `detail` is what the row says after the title. A row whose props did not change is
 * not drawn again (`memo`): with thousands of items, a keystroke in the filter or a change of kind redraws only what changed.
 */
const Row = memo(function Row({
  item,
  detail,
  folder,
  open,
  onOpen,
  onCopy,
}: {
  item: ItemSummary;
  detail: string;
  folder: string | undefined;
  open: boolean;
  onOpen: (id: string) => void;
  onCopy: (id: string, field: CopyableField) => void;
}) {
  const copy = COPY[item.kind];
  return (
    <li className={open ? "lrow on" : "lrow"}>
      <button
        type="button"
        className="rgo"
        aria-current={open ? "true" : undefined}
        onClick={() => {
          onOpen(item.id);
        }}
      >
        <span className={`ktile ${TILE[item.kind]}`}>
          <KindIcon kind={item.kind} />
        </span>
        {/* Spaces between the parts, so the name a screen reader gets reads as words (flex ignores them). */}
        <span className="sr">{`${KIND_WORD[item.kind]}:`}</span>{" "}
        <span className="rn">
          <Clip className="rname" text={item.title} />
          {item.attachments.length > 0 && item.kind !== "file" ? <PaperclipIcon /> : null}
        </span>{" "}
        <Clip className="rdet" text={detail} /> {folder === undefined ? null : <span className="rfold">{folder}</span>}
      </button>
      <div className="cslot">
        {copy !== undefined ? (
          <button
            type="button"
            className="cpy"
            aria-label={`Copy ${copy.word} for ${item.title}`}
            onClick={() => {
              onCopy(item.id, copy.field);
            }}
          >
            <CopyIcon />
          </button>
        ) : null}
      </div>
    </li>
  );
});

/**
 * The items of a list, in the order chosen (17b): in a group for each kind, by name inside it; or one list by name; or one
 * list with the item changed last first, each row saying when. Every row is on the page whatever the size of the list (the
 * style sheet has the browser skip drawing the ones out of view), so a screen reader reaches them all. `folderNames` names
 * the folder of each item when the list spans folders (All items), so a row says where it lives.
 */
export function ItemList({
  items,
  sort,
  openId,
  folderNames,
  onOpen,
  onCopy,
}: {
  items: readonly ItemSummary[];
  sort: SortChoice;
  openId: string | null;
  /** Folder names by folder ID, or `null` to show none. */
  folderNames: ReadonlyMap<string, string> | null;
  onOpen: (id: string) => void;
  onCopy: (id: string, field: CopyableField) => void;
}) {
  // When the list was opened: "2 days ago" is said from this.
  const [now] = useState(() => new Date());
  const row = (item: ItemSummary) => (
    <Row
      key={item.id}
      item={item}
      detail={sort === "changed" ? agoWords(item.modified_at, now) : detailOf(item)}
      folder={item.collection === null ? undefined : folderNames?.get(item.collection)}
      open={item.id === openId}
      onOpen={onOpen}
      onCopy={onCopy}
    />
  );
  // Sorted once for these items and this order, not again on every redraw of the window.
  const ordered = useMemo(
    () =>
      sort === "kind"
        ? {
            grouped: true as const,
            groups: GROUPS.map(({ kind, heading }) => ({ kind, heading, group: items.filter((item) => item.kind === kind).sort(byTitle) })),
          }
        : { grouped: false as const, rows: [...items].sort(sort === "name" ? byTitle : byChanged) },
    [items, sort],
  );
  if (!ordered.grouped) {
    return (
      <div className="lgroups">
        <ul className="grp lgrp">{ordered.rows.map(row)}</ul>
      </div>
    );
  }
  return (
    <div className="lgroups">
      {ordered.groups.map(({ kind, heading, group }) => {
        if (group.length === 0) return null;
        return (
          <section key={kind}>
            <h2 className="sech">
              {heading}
              <span>{group.length}</span>
            </h2>
            <ul className="grp lgrp">{group.map(row)}</ul>
          </section>
        );
      })}
    </div>
  );
}
