import { useState } from "react";
import type { ItemSummary } from "../api";
import { ListIcon, LockIcon, SideMenuIcon } from "../parts/Icon";
import { VaultMark, type VaultLook } from "../parts/Pattern";
import { lockEverything, selectFolder, type SessionData } from "../store";

/** A folder of the open vault, with how many items are in it. */
export interface FolderEntry {
  id: string;
  name: string;
  count: number;
}

// A tile colour for each folder in turn, as the approved screens had them.
const TILES = ["t0", "t1", "t2", "t3", "t4"];

/**
 * The side menu: which vault is open, All items, the folders (to read, not to change), and Lock all. It closes to a
 * strip of icons; then each icon carries its name for a screen reader, and for a hint when the pointer rests on it.
 */
export function SideMenu({
  data,
  look,
  folders,
  total,
}: {
  data: SessionData;
  look: VaultLook;
  folders: readonly FolderEntry[];
  /** How many items All items holds. */
  total: number;
}) {
  const [closed, setClosed] = useState(false);
  // What a closed icon is called and said to be: the words it hides.
  const named = (name: string, count?: number) =>
    closed ? { "aria-label": count === undefined ? name : `${name}, ${String(count)} items`, title: name } : {};
  return (
    <nav className={closed ? "rail closed" : "rail"} aria-label="Vault and folders">
      <div className="rtop">
        <div className="vhead">
          <VaultMark points={look.points} className="vprint" />
          <span className="vname">
            <b>{data.name}</b>
            {data.readOnly ? <span className="chip">Read-only</span> : null}
          </span>
        </div>
        <button
          type="button"
          className="rside"
          aria-label={closed ? "Open side menu" : "Close side menu"}
          aria-expanded={!closed}
          onClick={() => {
            setClosed(!closed);
          }}
        >
          <SideMenuIcon />
        </button>
      </div>
      <div className="projs">
        <button
          type="button"
          className={data.folder === null ? "nav on" : "nav"}
          aria-current={data.folder === null ? "page" : undefined}
          {...named("All items", total)}
          onClick={() => {
            selectFolder(data.session, null);
          }}
        >
          <ListIcon />
          <span className="nt">All items</span>
          <span className="nn">{total}</span>
        </button>
        {folders.length > 0 ? <div className="rlab">Folders</div> : null}
        {folders.map((folder, index) => (
          <button
            key={folder.id}
            type="button"
            className={data.folder === folder.id ? "nav on" : "nav"}
            aria-current={data.folder === folder.id ? "page" : undefined}
            {...named(folder.name, folder.count)}
            onClick={() => {
              selectFolder(data.session, folder.id);
            }}
          >
            <span className={`ptile ${TILES[index % TILES.length] ?? "t0"}`} aria-hidden="true">
              {folder.name.slice(0, 1).toUpperCase()}
            </span>
            <span className="nt">{folder.name}</span>
            <span className="nn">{folder.count}</span>
          </button>
        ))}
      </div>
      <div className="rfoot">
        <div className="rbtns">
          <button
            type="button"
            className="rbtn lk"
            aria-label="Lock all"
            title={closed ? "Lock all" : undefined}
            onClick={() => {
              void lockEverything();
            }}
          >
            <LockIcon />
            Lock all
          </button>
        </div>
      </div>
    </nav>
  );
}

/** The folders of a list, with the number of items in each. */
export function foldersOf(items: readonly ItemSummary[]): FolderEntry[] {
  return items
    .filter((item) => item.kind === "collection" && !item.trashed)
    .map((folder) => ({
      id: folder.id,
      name: folder.title,
      count: items.filter((item) => item.collection === folder.id && item.kind !== "collection" && !item.trashed).length,
    }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}
