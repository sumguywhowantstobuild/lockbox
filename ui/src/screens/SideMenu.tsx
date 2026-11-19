import { useState } from "react";
import type { ItemSummary } from "../api";
import { ChevronsIcon, GeneratorIcon, ListIcon, LockIcon, PlusIcon, SearchIcon, SettingsIcon, SideMenuIcon, TrashIcon } from "../parts/Icon";
import { Menu, type MenuRow } from "../parts/Menu";
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
  startUnlockStep,
  useSessions,
  useVaults,
  type SessionData,
} from "../store";
import { kindRow, shownName } from "../openBackupWords";
import { listedName, LOCKED, NOT_AVAILABLE } from "../vaultWords";
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
 * The side menu: which vault is open (its name opens the vault menu: a row for every vault of the list, which brings an open one to the front and opens a locked one's unlock
 * step, a row for every open backup and older copy, and Lock for the one on screen; an older copy's name says so, and a backup's is its file's), Search, All items, the folders with "New folder" under them (which becomes a name box), the Generator, the Trash with
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
  // Every vault of the list is one row of the vault menu, in the list's order (each once): an open one brings its window to the front, a locked one opens its own unlock
  // step, an unavailable one says so and does nothing yet, and one whose details can't be read opens Ask 8 from the same step. Then the sessions that are not on the list
  // (a backup, an older copy), in the order they were opened (a switch does not reorder them); a read-only one says what it is under its name.
  const vaults = useVaults() ?? [];
  const sessions = useSessions();
  const listed: MenuRow[] = vaults.map((vault) => {
    const session = sessions.find((one) => one.vaultId === vault.id);
    if (session !== undefined) {
      return {
        id: `vault:${String(vault.id)}`,
        label: session.name,
        detail: kindRow(session.kind),
        checked: session.session === data.session,
        onSelect: () => {
          showSession(session.session);
        },
      };
    }
    if (!vault.available) {
      return { id: `vault:${String(vault.id)}`, label: listedName(vault), detail: NOT_AVAILABLE, checked: false, unavailable: true, onSelect: () => undefined };
    }
    return {
      id: `vault:${String(vault.id)}`,
      label: listedName(vault),
      detail: LOCKED,
      checked: false,
      onSelect: () => {
        startUnlockStep(vault.id);
      },
    };
  });
  const others: MenuRow[] = sessions
    .filter((session) => !vaults.some((vault) => vault.id === session.vaultId))
    .sort((a, b) => a.opened - b.opened)
    .map((session) => ({
      id: `session:${String(session.session)}`,
      label: session.name,
      detail: kindRow(session.kind),
      checked: session.session === data.session,
      onSelect: () => {
        showSession(session.session);
      },
    }));
  const rows = [...listed, ...others];
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
