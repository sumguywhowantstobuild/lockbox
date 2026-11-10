import { useState } from "react";
import { messageFor } from "../messages";
import { CloseIcon, FilterIcon, MoreIcon } from "../parts/Icon";
import { Menu } from "../parts/Menu";
import type { VaultLook } from "../parts/Pattern";
import { ToastStack } from "../parts/Toast";
import {
  copyField,
  pickTrashed,
  selectItem,
  setForm,
  useForm,
  useSessions,
  useVaults,
  type SessionData,
} from "../store";
import { AddMenu } from "./AddMenu";
import { DetailsChangedAsk, LostOutputsAsk, VaultBanners } from "./Asks";
import { EmptyAdd } from "./EmptyAdd";
import { EditForm } from "./forms/EditForm";
import { DeleteFolderDialog, RenameFolderDialog } from "./forms/FolderForm";
import { KeyForm } from "./forms/KeyForm";
import { LoginForm } from "./forms/LoginForm";
import { NoteForm } from "./forms/NoteForm";
import { GeneratorPage } from "./GeneratorPanel";
import { ItemList } from "./ItemList";
import { Ready } from "./setup/Ready";
import { ItemPanel } from "./ItemPanel";
import { SearchPanel } from "./SearchPanel";
import { foldersOf, SideMenu } from "./SideMenu";
import { TrashPanel, TrashView } from "./TrashView";

const FILTER = "filter";

/** The words for the vaults that are not open, so the list does not look as if their items were missing. */
function lockedLine(names: readonly string[]): string | null {
  if (names.length === 0) return null;
  return names.length === 1
    ? `${names[0] ?? ""} is locked, so its items aren't listed.`
    : `${String(names.length)} other vaults are locked, so their items aren't listed.`;
}

/**
 * The main window of an unlocked vault: the side menu, the toolbar with its filter, the list of items (all of them, or
 * one folder's) and, when one is picked, its details in the panel; and the search, which Ctrl+F and Ctrl+K open over it.
 * A failed or stale answer never reaches this far as an error: a vault that locked is simply no longer here.
 */
export function MainWindow({ data, look }: { data: SessionData; look: VaultLook }) {
  const vaults = useVaults();
  const sessions = useSessions();
  const filter = useForm(data.session, FILTER);
  // The folder's own question, while one is open: which, for which folder (kept as it was when asked).
  const [asking, setAsking] = useState<{ kind: "rename" | "delete"; folder: { id: string; name: string }; count: number } | null>(null);
  const everything = data.items ?? [];
  const items = everything.filter((item) => item.kind !== "collection" && !item.trashed);
  const inTrash = everything.filter((item) => item.trashed);
  const folders = foldersOf(everything);
  const folderNames = new Map(folders.map((folder) => [folder.id, folder.name]));
  const folderName = data.folder === null ? undefined : folderNames.get(data.folder);
  // The panel: the item's details outside the Trash view (never for one that has gone to the Trash since), or a Trash row's panel in it.
  const picked = data.openItem === null ? undefined : everything.find((item) => item.id === data.openItem?.id);
  const panel = data.trash
    ? picked?.trashed === true
      ? "trash"
      : null
    : data.openItem !== null && picked?.trashed !== true
      ? "item"
      : null;
  const folderId = data.folder;
  const folderMenu =
    data.trash || data.readOnly || folderId === null || folderName === undefined
      ? null
      : { id: folderId, name: folderName, count: folders.find((folder) => folder.id === folderId)?.count ?? 0 };
  const inView = data.folder === null ? items : items.filter((item) => item.collection === data.folder);
  const needle = filter.trim().toLowerCase();
  const matches = (text: string | null | undefined) => (text ?? "").toLowerCase().includes(needle);
  const shown =
    needle === ""
      ? inView
      : inView.filter(
          (item) =>
            matches(item.title) || matches(item.username) || item.attachments.some((file) => matches(file.name)),
        );
  const title = data.trash ? "Trash" : (folderName ?? "All items");
  const openVaults = new Set(sessions.map((session) => session.vaultId));
  const locked = lockedLine(
    (vaults ?? [])
      .filter((vault) => vault.available && vault.name !== null && !openVaults.has(vault.id))
      .map((vault) => vault.name ?? ""),
  );
  const problem = data.loadError === null ? null : messageFor(data.loadError);

  return (
    <div className="win">
      <SideMenu data={data} look={look} folders={folders} total={items.length} trashed={inTrash.length} />
      <div className={panel === null && data.tool === null ? "stage" : "stage open"}>
        <main className="mainpane">
          <div className="tb">
            <span className="tb-t" aria-hidden="true">
              {title}
            </span>
            <span className="sp" />
            {data.trash ? null : (
              <div className="fil">
                <FilterIcon />
                <input
                  className="fin"
                  type="search"
                  aria-label="Filter this list"
                  placeholder="Filter"
                  autoComplete="off"
                  spellCheck={false}
                  value={filter}
                  onChange={(event) => {
                    setForm(data.session, FILTER, event.currentTarget.value);
                  }}
                />
                {filter === "" ? null : (
                  <button
                    type="button"
                    className="fx"
                    aria-label="Clear filter"
                    onClick={() => {
                      setForm(data.session, FILTER, "");
                    }}
                  >
                    <CloseIcon />
                  </button>
                )}
              </div>
            )}
            {folderMenu === null ? null : (
              // The folder's own menu (14b): Rename and Delete, and nothing a later plan builds. Not on All items, not in the Trash.
              <Menu
                label="More for this folder"
                icon={<MoreIcon />}
                triggerClassName="ib"
                items={[
                  {
                    label: "Rename folder",
                    onSelect: () => {
                      setAsking({ kind: "rename", folder: folderMenu, count: folderMenu.count });
                    },
                  },
                  {
                    label: "Delete folder",
                    danger: true,
                    onSelect: () => {
                      setAsking({ kind: "delete", folder: folderMenu, count: folderMenu.count });
                    },
                  },
                ]}
              />
            )}
            {data.readOnly || data.trash ? null : <AddMenu session={data.session} />}
          </div>
          <div className="lscroll">
            <h1 className="big" tabIndex={-1}>
              {title}
            </h1>
            {locked === null ? null : <p className="lnote">{locked}</p>}
            <div className="asks">
              <LostOutputsAsk />
              <VaultBanners data={data} />
            </div>
            <DetailsChangedAsk data={data} />
            {problem !== null ? (
              <p className="err" role="alert">
                {problem.title} {problem.body}
              </p>
            ) : data.items === null ? (
              <p className="note" aria-busy="true">
                Opening…
              </p>
            ) : data.trash ? (
              <TrashView
                items={inTrash}
                openId={data.openItem?.id ?? null}
                onOpen={(id) => {
                  pickTrashed(data.session, id);
                }}
              />
            ) : everything.length === 0 && data.folder === null && needle === "" ? (
              <Ready>{data.readOnly ? null : <EmptyAdd session={data.session} />}</Ready>
            ) : inView.length === 0 ? (
              <div className="grp lempty">
                <p className="le-t">
                  {folderName === undefined ? "Nothing in this vault yet." : `Nothing in ${folderName} yet.`}
                </p>
                {data.readOnly ? null : (
                  <>
                    <p className="le-b">Add a login, a key or a note.</p>
                    <EmptyAdd session={data.session} />
                  </>
                )}
              </div>
            ) : shown.length === 0 ? (
              <div className="grp lempty">
                <p className="le-t">Nothing matches “{filter.trim()}”.</p>
              </div>
            ) : (
              <>
                {needle === "" ? null : (
                  <p className="lnote">{`Showing ${String(shown.length)} of ${String(inView.length)}, filtered by “${filter.trim()}”.`}</p>
                )}
                <ItemList
                  items={shown}
                  openId={data.openItem?.id ?? null}
                  folderNames={data.folder === null ? folderNames : null}
                  onOpen={(id) => {
                    void selectItem(data.session, id);
                  }}
                  onCopy={(id, field) => {
                    void copyField(data.session, id, field);
                  }}
                />
              </>
            )}
          </div>
        </main>
        {panel === "item" && data.openItem !== null ? (
          <ItemPanel
            key={data.openItem.id}
            data={data}
            folders={folders}
            folderNames={folderNames}
            onClose={() => {
              void selectItem(data.session, null);
            }}
          />
        ) : null}
        {panel === "trash" && picked !== undefined ? <TrashPanel key={picked.id} data={data} summary={picked} items={everything} /> : null}
        {data.tool?.kind === "new_login" ? (
          <LoginForm key={`${String(data.session)}:${String(data.generation)}`} data={data} folders={folders} title={data.tool.title} />
        ) : null}
        {data.tool?.kind === "new_key" ? (
          <KeyForm key={`${String(data.session)}:${String(data.generation)}`} data={data} folders={folders} />
        ) : null}
        {data.tool?.kind === "new_note" ? (
          <NoteForm key={`${String(data.session)}:${String(data.generation)}`} data={data} folders={folders} />
        ) : null}
        {data.tool?.kind === "edit" ? (
          <EditForm
            key={`${String(data.session)}:${String(data.generation)}:${data.tool.summary.id}`}
            data={data}
            folders={folders}
            summary={data.tool.summary}
            detail={data.tool.detail}
          />
        ) : null}
        {data.tool?.kind === "generator" ? <GeneratorPage key={`${String(data.session)}:${String(data.generation)}`} data={data} /> : null}
        <ToastStack />
      </div>
      <SearchPanel />
      {asking?.kind === "rename" ? (
        <RenameFolderDialog
          session={data.session}
          folder={asking.folder}
          onClose={() => {
            setAsking(null);
          }}
        />
      ) : null}
      {asking?.kind === "delete" ? (
        <DeleteFolderDialog
          session={data.session}
          folder={asking.folder}
          count={asking.count}
          onClose={() => {
            setAsking(null);
          }}
        />
      ) : null}
    </div>
  );
}
