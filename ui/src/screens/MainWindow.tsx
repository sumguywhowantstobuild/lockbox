import { messageFor } from "../messages";
import { CloseIcon, FilterIcon } from "../parts/Icon";
import type { VaultLook } from "../parts/Pattern";
import { ToastStack } from "../parts/Toast";
import {
  copyField,
  selectItem,
  setForm,
  useForm,
  useSessions,
  useVaults,
  type SessionData,
} from "../store";
import { DetailsChangedAsk, LostOutputsAsk, VaultBanners } from "./Asks";
import { ItemList } from "./ItemList";
import { Ready } from "./setup/Ready";
import { ItemPanel } from "./ItemPanel";
import { foldersOf, SideMenu } from "./SideMenu";

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
 * one folder's) and, when one is picked, its details in the panel. A failed or stale answer never reaches this far as
 * an error: a vault that locked is simply no longer here.
 */
export function MainWindow({ data, look }: { data: SessionData; look: VaultLook }) {
  const vaults = useVaults();
  const sessions = useSessions();
  const filter = useForm(data.session, FILTER);
  const everything = data.items ?? [];
  const items = everything.filter((item) => item.kind !== "collection" && !item.trashed);
  const folders = foldersOf(everything);
  const folderNames = new Map(folders.map((folder) => [folder.id, folder.name]));
  const folderName = data.folder === null ? undefined : folderNames.get(data.folder);
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
  const title = folderName ?? "All items";
  const openVaults = new Set(sessions.map((session) => session.vaultId));
  const locked = lockedLine(
    (vaults ?? [])
      .filter((vault) => vault.available && vault.name !== null && !openVaults.has(vault.id))
      .map((vault) => vault.name ?? ""),
  );
  const problem = data.loadError === null ? null : messageFor(data.loadError);

  return (
    <div className="win">
      <SideMenu data={data} look={look} folders={folders} total={items.length} />
      <div className={data.openItem === null ? "stage" : "stage open"}>
        <main className="mainpane">
          <div className="tb">
            <span className="tb-t" aria-hidden="true">
              {title}
            </span>
            <span className="sp" />
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
          </div>
          <div className="lscroll">
            <h1 className="big">{title}</h1>
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
            ) : everything.length === 0 && data.folder === null && needle === "" ? (
              <Ready />
            ) : inView.length === 0 ? (
              <div className="grp lempty">
                <p className="le-t">
                  {folderName === undefined ? "Nothing in this vault yet." : `Nothing in ${folderName} yet.`}
                </p>
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
                  onCopyPassword={(id) => {
                    void copyField(data.session, id, "password");
                  }}
                />
              </>
            )}
          </div>
        </main>
        {data.openItem === null ? null : (
          <ItemPanel
            key={data.openItem.id}
            data={data}
            folderNames={folderNames}
            onClose={() => {
              void selectItem(data.session, null);
            }}
          />
        )}
        <ToastStack />
      </div>
    </div>
  );
}
