import type { CopyableField, ItemKind, ItemSummary } from "../api";
import { formatBytes } from "../format";
import { Clip } from "../parts/Clip";
import { CopyIcon, KindIcon, PaperclipIcon } from "../parts/Icon";

/** The groups of the list, in the order they show (keys first, as drawn), and the words for each. */
const GROUPS: { kind: ItemKind; heading: string; word: string }[] = [
  { kind: "key", heading: "Keys", word: "Key" },
  { kind: "login", heading: "Logins", word: "Login" },
  { kind: "note", heading: "Notes", word: "Note" },
  { kind: "file", heading: "Files", word: "File" },
];

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

function byTitle(a: ItemSummary, b: ItemSummary): number {
  return a.title.localeCompare(b.title, undefined, { sensitivity: "base" });
}

/**
 * The items of a list, in a group for each kind. A row opens the item; a login's row has a button that copies its
 * password, and a key's one that copies its value (both in Rust: the page never holds either). `folderNames` names the
 * folder of each item when the list spans folders (All items), so a row says where it lives.
 */
export function ItemList({
  items,
  openId,
  folderNames,
  onOpen,
  onCopy,
}: {
  items: readonly ItemSummary[];
  openId: string | null;
  /** Folder names by folder ID, or `null` to show none. */
  folderNames: ReadonlyMap<string, string> | null;
  onOpen: (id: string) => void;
  onCopy: (id: string, field: CopyableField) => void;
}) {
  return (
    <div className="lgroups">
      {GROUPS.map(({ kind, heading, word }) => {
        const group = items.filter((item) => item.kind === kind).sort(byTitle);
        if (group.length === 0) return null;
        return (
          <section key={kind}>
            <h2 className="sech">
              {heading}
              <span>{group.length}</span>
            </h2>
            <ul className="grp lgrp">
              {group.map((item) => {
                const folder = item.collection === null ? undefined : folderNames?.get(item.collection);
                const copy = COPY[item.kind];
                return (
                  <li key={item.id} className={item.id === openId ? "lrow on" : "lrow"}>
                    <button
                      type="button"
                      className="rgo"
                      aria-current={item.id === openId ? "true" : undefined}
                      onClick={() => {
                        onOpen(item.id);
                      }}
                    >
                      <span className={`ktile ${TILE[item.kind]}`}>
                        <KindIcon kind={item.kind} />
                      </span>
                      {/* Spaces between the parts, so the name a screen reader gets reads as words (flex ignores them). */}
                      <span className="sr">{`${word}:`}</span>{" "}
                      <span className="rn">
                        <Clip className="rname" text={item.title} />
                        {item.attachments.length > 0 && item.kind !== "file" ? <PaperclipIcon /> : null}
                      </span>{" "}
                      <Clip className="rdet" text={detailOf(item)} />{" "}
                      {folder === undefined ? null : <span className="rfold">{folder}</span>}
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
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
