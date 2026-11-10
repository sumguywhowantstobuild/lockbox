import { useEffect, useRef, type KeyboardEvent } from "react";
import type { ItemKind, ItemSummary } from "../api";
import { rememberOpener } from "../focus";
import { messageFor } from "../messages";
import { Button } from "../parts/Button";
import { Clip } from "../parts/Clip";
import { KindIcon, SearchIcon } from "../parts/Icon";
import { Palette } from "../parts/Palette";
import {
  closeSearch,
  copyFromSearch,
  lockEverything,
  openFromSearch,
  openNewLogin,
  openSearch,
  setSearchQuery,
  showResult,
  useSearch,
  useSessions,
  useVaults,
  type SessionData,
} from "../store";

const LABEL = "Search every unlocked vault";

/** The most one vault gives a search, of every kind (`SEARCH_LIMIT` in the shell's `commands/items.rs`). */
const SEARCH_LIMIT = 100;
const TOO_MANY = "Too many matches. Type more of the name.";

// A picture colour for each kind a search offers, as in the list.
const TILE: Partial<Record<ItemKind, string>> = { login: "t0", key: "t3", note: "t2" };
const WORD: Partial<Record<ItemKind, string>> = { login: "Login", key: "Key", note: "Note" };

/** Names in plain words: "Home", "Home and Work", "Home, Work and Old copy". */
function listOf(names: readonly string[]): string {
  const last = names.at(-1) ?? "";
  return names.length < 2 ? last : `${names.slice(0, -1).join(", ")} and ${last}`;
}

/** One result: the item, and the vault it came from. */
interface Result {
  session: SessionData;
  item: ItemSummary;
  /** What tells one result from another: the username, the website's host and the vault, or the folder and the vault. */
  detail: string;
}

function detailOf(session: SessionData, item: ItemSummary): string {
  const folder = item.collection === null ? undefined : session.items?.find((other) => other.id === item.collection)?.title;
  const parts = item.kind === "login" ? [item.username, item.site, session.name] : [folder, session.name];
  return parts.filter((part) => part !== undefined && part !== null && part !== "").join(" · ");
}

/**
 * The one search, over the main window (Ctrl+F or Ctrl+K from anywhere in it: the page takes the keys, since WebView2 has
 * no find bar to give them to). It looks in every unlocked vault, names the locked ones when nothing is found, says which
 * vaults were too busy to answer, and puts the actions of a sign-in on each result: copy the username, copy the password,
 * open the site (the shell opens it, from the login's own saved address). Copying steps the search aside and opens the
 * login, so the message about the copy and its clear time is on screen. A lock takes its vault's results away with no
 * message; the last lock closes the search. A key's result has Copy key (the shell copies the value; a search never finds a
 * key by its value). New item (and the clause that offers a new login when nothing is found) opens the new-login form in
 * the vault on screen, its title started with what was typed. Files come with a later task.
 */
export function SearchPanel() {
  const search = useSearch();
  const sessions = useSessions();
  const vaults = useVaults();
  const box = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const isOpen = search !== null;

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (!event.ctrlKey || event.shiftKey || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key !== "f" && key !== "k") return;
      event.preventDefault();
      // A question (a dialog) is up: the search does not open over it.
      if (!isOpen && document.querySelector('[role="dialog"]') !== null) return;
      openSearch();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [isOpen]);

  const results: Result[] = [];
  // Whether a vault's answer was cut at the shell's limit: files and folders count toward it but are not shown, so a login
  // that matches may be missing, and "nothing found" would be untrue. Below the limit nothing was cut.
  let tooMany = false;
  for (const found of search?.hits ?? []) {
    const session = sessions.find((entry) => entry.session === found.session);
    if (session === undefined) continue;
    if (found.items.length >= SEARCH_LIMIT) tooMany = true;
    for (const item of found.items) {
      // Files and folders are not offered here; a trashed item is not found at all.
      if (item.trashed || (item.kind !== "login" && item.kind !== "key" && item.kind !== "note")) continue;
      results.push({ session, item, detail: detailOf(session, item) });
    }
  }

  // New item adds to the vault on screen (the one opened last), unless that one is a backup opened to read.
  const active = sessions.at(-1);
  const canAdd = active !== undefined && !active.readOnly;
  const nameOf = (session: number) => sessions.find((entry) => entry.session === session)?.name ?? "";
  const busy = (search?.busy ?? []).map(nameOf).filter((name) => name !== "");
  const openVaults = new Set(sessions.map((entry) => entry.vaultId));
  const locked = (vaults ?? [])
    .filter((vault) => vault.available && vault.name !== null && !openVaults.has(vault.id))
    .map((vault) => vault.name ?? "");
  const lockedWords =
    locked.length === 0
      ? ""
      : locked.length === 1
        ? `${listOf(locked)} is locked, so it isn't searched. `
        : `${listOf(locked)} are locked, so they aren't searched. `;
  const busyWords =
    busy.length === 0
      ? null
      : busy.length === 1
        ? `${listOf(busy)} is busy, so its results are missing for now.`
        : `${listOf(busy)} are busy, so their results are missing for now.`;
  const problem = search === null || search.error === null ? null : messageFor(search.error);

  // The arrow keys go between the box and the results, one result at a time; Tab goes through each result's buttons.
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const stops = [box.current, ...(list.current?.querySelectorAll<HTMLElement>("button.hgo") ?? [])];
    const here = stops.findIndex((stop) => stop !== null && stop === document.activeElement);
    if (here === -1) return;
    const next = stops[Math.min(stops.length - 1, Math.max(0, here + (event.key === "ArrowDown" ? 1 : -1)))];
    if (next === undefined || next === null || next === stops[here]) return;
    event.preventDefault();
    next.focus();
  };

  return (
    <Palette
      open={isOpen}
      onOpenChange={(next) => {
        if (!next) closeSearch();
      }}
      label={LABEL}
      initialFocus={box}
      onKeyDown={onKeyDown}
    >
      {search === null ? null : (
        <>
          <div className="stop">
            <SearchIcon />
            <input
              ref={box}
              className="pin"
              type="text"
              aria-label={LABEL}
              placeholder="Search unlocked vaults"
              autoComplete="off"
              spellCheck={false}
              maxLength={256}
              value={search.query}
              onChange={(event) => {
                void setSearchQuery(event.currentTarget.value);
              }}
            />
            <kbd className="kc" aria-hidden="true">
              Esc
            </kbd>
          </div>
          <p className="sr" role="status">
            {results.length === 0 ? "" : results.length === 1 ? "1 result" : `${String(results.length)} results`}
          </p>
          {busyWords === null ? null : <p className="snote">{busyWords}</p>}
          {tooMany && results.length > 0 ? <p className="snote">{TOO_MANY}</p> : null}
          {problem === null ? null : (
            <p className="err serr" role="alert">
              {problem.title} {problem.body}
            </p>
          )}
          {results.length > 0 ? (
            <div className="hlist">
              <ul ref={list}>
                {results.map(({ session, item, detail }, index) => (
                  <li key={`${String(session.session)}:${item.id}`} className={index === 0 ? "res first" : "res"}>
                    <button
                      type="button"
                      className="hgo"
                      onClick={() => {
                        showResult(session.session, item.id);
                      }}
                    >
                      <span className={`ktile ${TILE[item.kind] ?? "t0"}`}>
                        <KindIcon kind={item.kind} />
                      </span>{" "}
                      <span className="sr">{`${WORD[item.kind] ?? ""}:`}</span>{" "}
                      <span className="hmeta">
                        <Clip className="ht" text={item.title} /> <Clip className="hd" text={detail} />
                      </span>
                    </button>
                    {item.kind === "login" ? (
                      <div className="ra" role="group" aria-label={`${item.title}, ${detail}`}>
                        {(item.username ?? "") === "" ? null : (
                          <Button
                            onClick={() => {
                              void copyFromSearch(session.session, item.id, "username");
                            }}
                          >
                            Copy username
                          </Button>
                        )}
                        <Button
                          onClick={() => {
                            void copyFromSearch(session.session, item.id, "password");
                          }}
                        >
                          Copy password
                        </Button>
                        {item.site === null ? null : (
                          <Button
                            onClick={() => {
                              void openFromSearch(session.session, item.id);
                            }}
                          >
                            Open site
                          </Button>
                        )}
                      </div>
                    ) : null}
                    {item.kind === "key" ? (
                      <div className="ra" role="group" aria-label={`${item.title}, ${detail}`}>
                        <Button
                          onClick={() => {
                            void copyFromSearch(session.session, item.id, "key_value");
                          }}
                        >
                          Copy key
                        </Button>
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : search.answered === null ? null : tooMany ? (
            <div className="hempty">
              <b>{TOO_MANY}</b>
            </div>
          ) : (
            <div className="hempty">
              <b>{`Nothing for "${search.answered.trim()}"`}</b>
              <span>{`${lockedWords}Try another word${canAdd ? ", or add a new login" : ""}.`}</span>
            </div>
          )}
          <div className="sfoot">
            {active === undefined || !canAdd ? null : (
              <Button
                onClick={() => {
                  // What was typed starts the title: it is the name the person was looking for. The login form is the one
                  // this opens (as it did before keys and notes had forms): the search does not ask which kind.
                  rememberOpener(null);
                  openNewLogin(active.session, search.query.trim());
                  closeSearch();
                }}
              >
                New item
              </Button>
            )}
            <Button
              onClick={() => {
                void lockEverything();
              }}
            >
              Lock all
            </Button>
            <span className="sp" />
            <Button onClick={closeSearch}>Close</Button>
          </div>
        </>
      )}
    </Palette>
  );
}
