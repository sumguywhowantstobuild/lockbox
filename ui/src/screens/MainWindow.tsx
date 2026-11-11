import { useCallback, useMemo, useState } from "react";
import type { CopyableField } from "../api";
import { rememberOpener } from "../focus";
import { messageFor } from "../messages";
import { Button } from "../parts/Button";
import { CloseIcon, FilterIcon, MoreIcon } from "../parts/Icon";
import { Menu } from "../parts/Menu";
import type { VaultLook } from "../parts/Pattern";
import { ToastStack } from "../parts/Toast";
import {
  copyEnv,
  copyField,
  openPasteEnv,
  openSearch,
  pickTrashed,
  selectItem,
  setForm,
  setSearchQuery,
  useForm,
  useSessions,
  useVaults,
  type SessionData,
} from "../store";
import { AddMenu } from "./AddMenu";
import { DetailsChangedAsk, LostOutputsAsk, OpenFilesAsk, ShortcutAsk, VaultBanners } from "./Asks";
import { EmptyAdd } from "./EmptyAdd";
import { EnvFileDialog } from "./EnvOut";
import { EnvPaste } from "./EnvPaste";
import { BusyNote } from "./FileActions";
import { EditForm } from "./forms/EditForm";
import { DeleteFolderDialog, RenameFolderDialog } from "./forms/FolderForm";
import { KeyForm } from "./forms/KeyForm";
import { LoginForm } from "./forms/LoginForm";
import { NoteForm } from "./forms/NoteForm";
import { GeneratorPage } from "./GeneratorPanel";
import { ItemList } from "./ItemList";
import { FILTER, itemCount, kindCount, kindPlural, ListTools, showAll, useKind, useSort } from "./ListTools";
import { Ready } from "./setup/Ready";
import { ItemPanel } from "./ItemPanel";
import { SaveBox } from "./SaveBox";
import { SearchPanel } from "./SearchPanel";
import { SettingsPanel } from "./SettingsPanel";
import { foldersOf, SideMenu } from "./SideMenu";
import { TrashPanel, TrashView } from "./TrashView";

/** The words for the vaults that are not open, so the list does not look as if their items were missing. */
function lockedLine(names: readonly string[]): string | null {
  if (names.length === 0) return null;
  return names.length === 1
    ? `${names[0] ?? ""} is locked, so its items aren't listed.`
    : `${String(names.length)} other vaults are locked, so their items aren't listed.`;
}

/**
 * The main window of an unlocked vault: the side menu, the toolbar with its filter and its kind and sort lists, the list of
 * items (all of them, or one folder's, narrowed and ordered as chosen) and, when one is picked, its details in the panel;
 * and the search, which Ctrl+F and Ctrl+K open over it. A narrowed list always says so, with a way back, so it never looks
 * like missing items. A failed or stale answer never reaches this far as an error: a vault that locked is simply no longer
 * here.
 */
export function MainWindow({ data, look }: { data: SessionData; look: VaultLook }) {
  const vaults = useVaults();
  const sessions = useSessions();
  const filter = useForm(data.session, FILTER);
  const kind = useKind(data.session);
  const sort = useSort(data.session);
  // The folder's own question, while one is open: which, for which folder (kept as it was when asked).
  const [asking, setAsking] = useState<{ kind: "rename" | "delete" | "env_file"; folder: { id: string; name: string }; count: number } | null>(null);
  const everything = useMemo(() => data.items ?? [], [data.items]);
  // The lists below are kept between redraws while what they come from is unchanged, so the item list's rows are not drawn again.
  const items = useMemo(() => everything.filter((item) => item.kind !== "collection" && !item.trashed), [everything]);
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
  // Taking keys out is offered only where there is a key to take: one in this folder that is not in the Trash (`items` has none of those).
  const folderHasKeys = folderId !== null && items.some((item) => item.kind === "key" && item.collection === folderId);
  const inView = useMemo(
    () => (data.folder === null ? items : items.filter((item) => item.collection === data.folder)),
    [items, data.folder],
  );
  const needle = filter.trim().toLowerCase();
  const ofKind = useMemo(() => (kind === "all" ? inView : inView.filter((item) => item.kind === kind)), [inView, kind]);
  const shown = useMemo(() => {
    if (needle === "") return ofKind;
    const matches = (text: string | null | undefined) => (text ?? "").toLowerCase().includes(needle);
    return ofKind.filter((item) => matches(item.title) || matches(item.username) || item.attachments.some((file) => matches(file.name)));
  }, [ofKind, needle]);
  // The row's two actions stay the same functions for one session, so a row that did not change is not drawn again.
  const onOpen = useCallback(
    (id: string) => {
      void selectItem(data.session, id);
    },
    [data.session],
  );
  const onCopy = useCallback(
    (id: string, field: CopyableField) => {
      void copyField(data.session, id, field);
    },
    [data.session],
  );
  // What is narrowed away, said in words: the kind, the typed word, or both.
  const word = filter.trim();
  const showing =
    kind === "all"
      ? `Showing ${String(shown.length)} of ${String(inView.length)}, filtered by “${word}”.`
      : `Showing ${kindCount(kind, shown.length)} of ${itemCount(inView.length)}${needle === "" ? "" : `, filtered by “${word}”`}.`;
  // The place that holds the items, by name: the folder, or the vault for All items.
  const holder = folderName ?? data.name;
  const rest = inView.length === 1 ? "it" : "them";
  const title = data.trash ? "Trash" : (folderName ?? "All items");
  const openVaults = new Set(sessions.map((session) => session.vaultId));
  const locked = lockedLine(
    (vaults ?? [])
      .filter((vault) => vault.available && vault.name !== null && !openVaults.has(vault.id))
      .map((vault) => vault.name ?? ""),
  );
  const problem = data.loadError === null ? null : messageFor(data.loadError);
  // Which of the list's states is up, in the order they win.
  const state =
    problem !== null
      ? "problem"
      : data.items === null
        ? "opening"
        : data.trash
          ? "trash"
          : everything.length === 0 && data.folder === null && needle === ""
            ? "ready"
            : inView.length === 0
              ? "empty"
              : shown.length === 0 && needle !== ""
                ? "no_match"
                : shown.length === 0 && kind !== "all"
                  ? "no_kind"
                  : "list";
  const narrowed = state === "list" && !(needle === "" && kind === "all");
  // What narrowing left, for a screen reader, when it left nothing: the card below says it on screen, and this says it as it changes.
  let leftNothing: string | null = null;
  if (state === "no_match") leftNothing = `Nothing here matches “${word}”. ${holder} has ${itemCount(inView.length)}.`;
  else if (state === "no_kind" && kind !== "all") leftNothing = `No ${kindPlural(kind)} here. ${holder} has ${itemCount(inView.length)}.`;

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
            {data.trash ? null : <ListTools session={data.session} />}
            {folderMenu === null ? null : (
              // The folder's own menu (14b, 15d): Paste a .env, the two ways to take the keys out (only when the folder holds a key), then
              // Rename and Delete set apart, and nothing a later plan builds. Not on All items, not in the Trash, not in a read-only vault.
              <Menu
                label="More for this folder"
                icon={<MoreIcon />}
                triggerClassName="ib"
                items={[
                  {
                    label: "Paste a .env",
                    onSelect: () => {
                      // Closing the panel gives focus back to the folder's menu button, the way the dialogs below do.
                      rememberOpener(document.querySelector<HTMLElement>('[aria-label="More for this folder"]'));
                      openPasteEnv(data.session);
                    },
                  },
                  ...(folderHasKeys
                    ? [
                        {
                          label: "Copy all as .env",
                          onSelect: () => {
                            void copyEnv(data.session, folderMenu.id);
                          },
                        },
                        {
                          label: "Save as .env file",
                          onSelect: () => {
                            setAsking({ kind: "env_file", folder: folderMenu, count: folderMenu.count });
                          },
                        },
                      ]
                    : []),
                  {
                    label: "Rename folder",
                    apart: true,
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
            {data.readOnly || data.trash ? null : <AddMenu session={data.session} folder={data.folder} />}
          </div>
          <div className="lscroll">
            <h1 className="big" tabIndex={-1}>
              {title}
            </h1>
            {locked === null ? null : <p className="lnote">{locked}</p>}
            <div className="asks">
              <BusyNote data={data} />
              <OpenFilesAsk />
              <LostOutputsAsk />
              <ShortcutAsk />
              <VaultBanners data={data} />
            </div>
            <DetailsChangedAsk data={data} />
            {/* The place that says how the list is narrowed. It is always on the page, so a screen reader speaks the line when it
                appears or changes (it speaks only changes in a place it already knows); a line that came with the change would be silent. */}
            <div className="lsay" aria-live="polite" aria-atomic="true">
              {narrowed ? (
                <p className="lnote">
                  {showing}
                  {kind === "all" ? null : (
                    <>
                      {" "}
                      <button
                        type="button"
                        className="lnk"
                        onClick={() => {
                          showAll(data.session);
                        }}
                      >
                        Show all
                      </button>
                    </>
                  )}
                </p>
              ) : null}
              {leftNothing === null ? null : <span className="sr">{leftNothing}</span>}
            </div>
            {state === "problem" && problem !== null ? (
              <p className="err" role="alert">
                {problem.title} {problem.body}
              </p>
            ) : state === "opening" ? (
              <p className="note" aria-busy="true">
                Opening…
              </p>
            ) : state === "trash" ? (
              <TrashView
                items={inTrash}
                openId={data.openItem?.id ?? null}
                onOpen={(id) => {
                  pickTrashed(data.session, id);
                }}
              />
            ) : state === "ready" ? (
              <Ready>{data.readOnly ? null : <EmptyAdd session={data.session} folder={data.folder} />}</Ready>
            ) : state === "empty" ? (
              <div className="grp lempty">
                <p className="le-t">
                  {folderName === undefined ? "Nothing in this vault yet." : `Nothing in ${folderName} yet.`}
                </p>
                {data.readOnly ? null : (
                  <>
                    <p className="le-b">Add a login, a key, a note or a file, or paste a whole .env.</p>
                    <EmptyAdd session={data.session} folder={data.folder} />
                  </>
                )}
              </div>
            ) : state === "no_match" ? (
              // Nothing matches the typed word (17c): what was typed, how many items there really are, and two ways on.
              <div className="grp lempty">
                <p className="le-t">Nothing here matches “{word}”</p>
                <p className="le-b">{`${holder} has ${itemCount(inView.length)}. Clear the filter to see ${rest}.`}</p>
                <div className="le-a">
                  <Button
                    look="pill-main"
                    onClick={() => {
                      showAll(data.session);
                    }}
                  >
                    Clear filter
                  </Button>
                  <Button
                    onClick={() => {
                      openSearch();
                      void setSearchQuery(word);
                    }}
                  >
                    Search all vaults
                  </Button>
                </div>
              </div>
            ) : state === "no_kind" && kind !== "all" ? (
              // Nothing of the chosen kind here: the same card, in the kind's own word.
              <div className="grp lempty">
                <p className="le-t">{`No ${kindPlural(kind)} here`}</p>
                <p className="le-b">{`${holder} has ${itemCount(inView.length)}. Show all kinds to see ${rest}.`}</p>
                <div className="le-a">
                  <Button
                    look="pill-main"
                    onClick={() => {
                      showAll(data.session);
                    }}
                  >
                    Show all
                  </Button>
                </div>
              </div>
            ) : (
              <ItemList
                items={shown}
                sort={sort}
                openId={data.openItem?.id ?? null}
                folderNames={data.folder === null ? folderNames : null}
                onOpen={onOpen}
                onCopy={onCopy}
              />
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
        {data.tool?.kind === "paste_env" ? (
          <EnvPaste
            key={`${String(data.session)}:${String(data.generation)}:${String(data.tool.opening)}`}
            data={data}
            folders={folders}
            initialRows={data.tool.rows}
            initialFolder={data.tool.folder}
          />
        ) : null}
        {data.tool?.kind === "save_box" ? (
          // Not keyed by the copy: a new copy while the box is open keeps what was typed and chosen.
          <SaveBox key={`${String(data.session)}:${String(data.generation)}`} data={data} folders={folders} />
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
        {data.tool?.kind === "settings" ? <SettingsPanel key={`${String(data.session)}:${String(data.generation)}`} data={data} /> : null}
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
      {asking?.kind === "env_file" ? (
        <EnvFileDialog
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
