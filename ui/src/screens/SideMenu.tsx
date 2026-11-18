import { useState } from "react";
import type { ItemSummary } from "../api";
import { ChevronsIcon, GeneratorIcon, ListIcon, LockIcon, PlusIcon, SearchIcon, SettingsIcon, SideMenuIcon, TrashIcon } from "../parts/Icon";
import { Menu } from "../parts/Menu";
import { VaultMark, type VaultLook } from "../parts/Pattern";
import {
  lockEverything,
  lockOneVault,
  openGenerator,
  openSearch,
  openSettings,
  openTrash,
  selectFolder,
  showSession,
  useSessions,
  useVaults,
  type SessionData,
} from "../store";
import { kindRow, shownName } from "../openBackupWords";
import { NewFolderBox } from "./forms/FolderForm";

/** A folder of the open vault, with how many items are in it. */
export interface FolderEntry {
  id: string;
  name: string;
  count: number;
}

// A tile colour for each folder in turn, as the approved screens had them.
const TILES = ["t0", "t1", "t2", "t3", "t4"];

/**
 * The side menu: which vault is open (its name opens the vault menu: each vault and whether it is open, a row for every open session that brings it to the front, and Lock for
 * the one on screen; an older copy's name says so, and a backup's is its file's), Search, All items, the folders with "New folder" under them (which becomes a name box), the Generator, the Trash with
 * its count, and Settings and Lock all side by side. It closes to a strip of icons; then each icon carries its name for a screen reader, and for a hint
 * when the pointer rests on it. The menu is only there while a vault is unlocked, so the Generator never shows on the lock screen.
 * A vault opened read-only has no "New folder".
 */
export function SideMenu({
  data,
  look,
  folders,
  total,
  trashed,
}: {
  data: SessionData;
  look: VaultLook;
  folders: readonly FolderEntry[];
  /** How many items All items holds. */
  total: number;
  /** How many items are in the Trash, folders included. */
  trashed: number;
}) {
  const [closed, setClosed] = useState(false);
  // The name box "New folder" becomes. A lock takes the whole side menu, and the box with it.
  const [naming, setNaming] = useState(false);
  // Each vault the list can reach, and whether it is open: the vault menu says it in words, as the list's line does.
  const vaults = useVaults();
  const sessions = useSessions();
  const open = new Set(sessions.map((session) => session.vaultId));
  // Each vault is in the menu once: an open one is a row below (the choice to bring it to the front), so the lines above are only the vaults that are not open, which say Locked.
  const notes = (vaults ?? [])
    .filter((vault) => vault.available && vault.name !== null && !open.has(vault.id))
    .map((vault) => ({ name: vault.name ?? "", state: "Locked" }));
  // Every open session is a row that brings it to the front, in the order they were unlocked or opened (a switch does not reorder them); a read-only one says what it is
  // under its name. A locked session is gone from the page, so it has no row, and a locked vault of the list stays a note above.
  const rows = [...sessions]
    .sort((a, b) => a.opened - b.opened)
    .map((session) => ({
      id: String(session.session),
      label: session.name,
      detail: kindRow(session.kind),
      checked: session.session === data.session,
      onSelect: () => {
        showSession(session.session);
      },
    }));
  const onScreen = shownName(data);
  // What a closed icon is called and said to be: the words it hides.
  const named = (name: string, count?: number) =>
    closed ? { "aria-label": count === undefined ? name : `${name}, ${String(count)} items`, title: name } : {};
  return (
    <nav className={closed ? "rail closed" : "rail"} aria-label="Vault and folders">
      <div className="rtop">
        <Menu
          label={`${onScreen}${data.readOnly ? ", read-only" : ""}, vault menu`}
          triggerClassName="vhead vsw"
          icon={
            <>
              <VaultMark points={look.points} className="vprint" />
              <span className="vname">
                <b>{onScreen}</b>
                {data.readOnly ? <span className="chip">Read-only</span> : null}
              </span>
              <ChevronsIcon className="i vchev" />
            </>
          }
          notes={notes}
          rows={rows}
          items={[
            {
              label: `Lock ${onScreen}`,
              onSelect: () => {
                void lockOneVault(data.session);
              },
            },
          ]}
        />
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
      <button
        type="button"
        className="srch"
        aria-keyshortcuts="Control+F Control+K"
        {...named("Search")}
        onClick={openSearch}
      >
        <SearchIcon />
        <span className="nt">Search</span>
        <kbd className="kc" aria-hidden="true">
          Ctrl+F
        </kbd>
      </button>
      <div className="projs">
        <button
          type="button"
          className={data.folder === null && !data.trash ? "nav on" : "nav"}
          aria-current={data.folder === null && !data.trash ? "page" : undefined}
          {...named("All items", total)}
          onClick={() => {
            selectFolder(data.session, null);
          }}
        >
          <ListIcon />
          <span className="nt">All items</span>{" "}
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
            <span className="nt">{folder.name}</span>{" "}
            <span className="nn">{folder.count}</span>
          </button>
        ))}
        {data.readOnly ? null : naming ? (
          <NewFolderBox
            session={data.session}
            onDone={() => {
              setNaming(false);
            }}
          />
        ) : (
          <button
            type="button"
            className="nav newf"
            {...named("New folder")}
            onClick={() => {
              // The strip has no room for a box, so the side menu opens for it.
              setClosed(false);
              setNaming(true);
            }}
          >
            <PlusIcon />
            <span className="nt">New folder</span>
          </button>
        )}
      </div>
      <div className="rfoot">
        <button
          type="button"
          // Marked while its panel is open, as Trash is (drawn so in 16a); a picture of where you are, the panel says the rest.
          className={data.tool?.kind === "generator" ? "nav util navgen on" : "nav util navgen"}
          {...named("Generator")}
          onClick={() => {
            openGenerator(data.session);
          }}
        >
          <GeneratorIcon />
          <span className="nt">Generator</span>
        </button>
        <button
          type="button"
          className={data.trash ? "nav util navtrash on" : "nav util navtrash"}
          aria-current={data.trash ? "page" : undefined}
          {...named("Trash", trashed)}
          onClick={() => {
            openTrash(data.session);
          }}
        >
          <TrashIcon />
          <span className="nt">Trash</span>{" "}
          <span className="nn">{trashed}</span>
        </button>
        <div className="rbtns">
          <button
            type="button"
            className={data.tool?.kind === "settings" ? "rbtn navset on" : "rbtn navset"}
            aria-label="Settings"
            title={closed ? "Settings" : undefined}
            onClick={() => {
              openSettings(data.session);
            }}
          >
            <SettingsIcon />
            Settings
          </button>
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
