import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ItemKind, ItemSummary } from "../api";
import { deletedText } from "../format";
import { Button } from "../parts/Button";
import { Clip } from "../parts/Clip";
import { Dialog } from "../parts/Dialog";
import { KindIcon } from "../parts/Icon";
import { Panel } from "../parts/Panel";
import { emptyTrash, OLD_TRASH_DAYS, pickTrashed, purgeTrashed, restoreTrashed, type SessionData } from "../store";
import type { SortChoice } from "./ListTools";

/** The line under the title: nothing is removed by the app on its own. */
export const NOTHING_REMOVED = "Nothing here is removed until you say so. Lockbox never empties the trash by itself.";

const KIND_WORD: Record<ItemKind, string> = { login: "Login", key: "Key", note: "Note", file: "File", collection: "Folder" };
const TILE: Record<ItemKind, string> = { login: "t0", file: "t1", note: "t2", key: "t3", collection: "t4" };

const byName = (a: ItemSummary, b: ItemSummary) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" });

/** The one deleted last first (the dates are the engine's own fixed-format text, so their order is time's), then by name. */
function byWhenDeleted(a: ItemSummary, b: ItemSummary): number {
  const when = (b.trashed_at ?? "").localeCompare(a.trashed_at ?? "");
  return when !== 0 ? when : byName(a, b);
}

/** By kind: folders first, then the one deleted last first, then by name. */
function byKind(a: ItemSummary, b: ItemSummary): number {
  const folders = Number(b.kind === "collection") - Number(a.kind === "collection");
  return folders !== 0 ? folders : byWhenDeleted(a, b);
}

const ORDER: Record<SortChoice, (a: ItemSummary, b: ItemSummary) => number> = {
  kind: byKind,
  name: byName,
  changed: byWhenDeleted,
};

/** How many items a folder's restore brings back: those that went to the Trash with it, are still filed in it, and are not being deleted for good. The engine counts the same way. */
export function wentWith(items: readonly ItemSummary[], folder: string): number {
  return items.filter(
    (item) => item.trashed && !item.purging && item.trashed_with === folder && item.collection === folder,
  ).length;
}

/** 32a's group of the items that have been in the Trash 30 days or more. */
const OLD_GROUP = "In the trash 30 days or more";

/**
 * The Trash view (13b, 32a): the line that says nothing leaves by itself, the Empty trash button when the vault has a trash to empty (`bar`),
 * then one row for each item in the trash the toolbar's Filter and kind let through, in the order chosen (by kind: folders first, then the
 * one deleted last first, the items that went with a folder among them). A row says its kind, its title and when it was deleted ("Deleted 2
 * days ago"; a folder's reads "Folder · deleted 2 days ago"). When some of the rows have been there 30 days or more (`old`, from the shell)
 * they are a group of their own, first, with the pill that deletes them (`oldPill`) in its header, and the rest are "Newer"; with none, one
 * list. No Add or copy buttons here, and nothing in it is removed by time. An empty Trash says so.
 */
export function TrashView({
  items,
  sort,
  openId,
  onOpen,
  old,
  bar,
  oldPill,
}: {
  /** The items in the trash the list shows (folders included), after the Filter and the kind. */
  items: readonly ItemSummary[];
  /** The order chosen in the toolbar: by kind (folders first), by name, or the one deleted last first. */
  sort: SortChoice;
  openId: string | null;
  onOpen: (id: string) => void;
  /** The ids the shell says have been in the trash 30 days or more; empty for a vault that is read-only or not yet answered. */
  old: readonly string[];
  /** The Empty trash button, or nothing. */
  bar?: ReactNode;
  /** The pill in the old group's header ("Delete these N permanently"), or nothing. */
  oldPill?: ReactNode;
}) {
  // When the view opened: "deleted 2 days ago" is said from this.
  const [now] = useState(() => new Date());
  const rows = [...items].sort(ORDER[sort]);
  const oldIds = new Set(old);
  const longAgo = rows.filter((item) => oldIds.has(item.id));
  const newer = rows.filter((item) => !oldIds.has(item.id));
  const row = (item: ItemSummary) => {
    const when = deletedText(item.trashed_at ?? "", now);
    const detail =
      item.kind === "collection"
        ? ["Folder", when].filter((part) => part !== "").join(" · ")
        : when === ""
          ? ""
          : `${when.charAt(0).toUpperCase()}${when.slice(1)}`;
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
          <span className="sr">{`${KIND_WORD[item.kind]}:`}</span>{" "}
          <span className="rn">
            <Clip className={item.kind === "key" ? "rname m" : "rname"} text={item.title} />
          </span>{" "}
          <Clip className="rdet" text={detail} />
        </button>
      </li>
    );
  };
  return (
    <>
      <p className="lnote">{NOTHING_REMOVED}</p>
      {bar}
      {rows.length === 0 ? (
        <div className="grp lempty">
          <p className="le-t">Trash is empty.</p>
        </div>
      ) : (
        <div className="lgroups">
          {longAgo.length === 0 ? (
            <ul className="grp lgrp">{rows.map(row)}</ul>
          ) : (
            <>
              <section>
                {/* As drawn (32a): the heading and its count at the left, the pill that deletes the group at the right. */}
                <div className="sechbar">
                  <h2 className="sech">
                    {OLD_GROUP}
                    <span>{longAgo.length}</span>
                  </h2>
                  {oldPill}
                </div>
                <ul className="grp lgrp">{longAgo.map(row)}</ul>
              </section>
              {newer.length === 0 ? null : (
                <section>
                  <h2 className="sech">
                    Newer
                    <span>{newer.length}</span>
                  </h2>
                  <ul className="grp lgrp">{newer.map(row)}</ul>
                </section>
              )}
            </>
          )}
        </div>
      )}
    </>
  );
}

/**
 * Empty trash (32a, 32b): the button above the Trash's rows, and its question. The question says how many items go, that their attached
 * files go too, that it can't be undone and that backups already made still hold them, with Cancel focused first; a yes asks the shell to
 * empty this vault's whole trash (never the rows a Filter left on screen). The count is the vault's whole trash when the question was
 * opened. The question belongs to the session and generation it was opened for: the window gives this a key made of both, so a switch to
 * another vault or a lock takes it away, and the store sends nothing for a generation that has gone. A read-only vault has none.
 */
export function EmptyTrash({ data, count }: { data: SessionData; count: number }) {
  return (
    <div className="trashbar">
      <AskToDelete data={data} count={count} button="Empty trash" yes="Empty trash" />
    </div>
  );
}

/**
 * The old group's pill (32a, "Delete these N permanently"): the same question as Empty trash's with the old group's count, and a yes asks
 * the shell to delete only what has been in the Trash 30 days or more (`older_than_days`), never the newer ones. The count is the vault's
 * whole old group, whatever a Filter hides. Bound to its vault and generation as Empty trash is; a read-only vault has none.
 */
export function DeleteOld({ data, count }: { data: SessionData; count: number }) {
  return (
    <AskToDelete
      data={data}
      count={count}
      button={count === 1 ? "Delete this item permanently" : `Delete these ${String(count)} permanently`}
      yes="Delete permanently"
      olderThanDays={OLD_TRASH_DAYS}
    />
  );
}

/** A button and the question it opens (32b), shared by Empty trash and the old group's pill: Cancel focused first, a filled red yes. */
function AskToDelete({
  data,
  count,
  button,
  yes,
  olderThanDays,
}: {
  data: SessionData;
  count: number;
  button: string;
  yes: string;
  olderThanDays?: number;
}) {
  // How many items the question was opened over; `null` while it is shut.
  const [asking, setAsking] = useState<number | null>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  // The count the window shows now, for a question that has to be asked again.
  const latest = useRef(count);
  useEffect(() => {
    latest.current = count;
  }, [count]);
  const { session, generation } = data;
  const many = asking !== null && asking !== 1;
  return (
    <>
      <Button
        onClick={() => {
          setAsking(count);
        }}
      >
        {button}
      </Button>
      {asking === null ? null : (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setAsking(null);
          }}
          title={`Delete ${many ? `${String(asking)} items` : "1 item"} for good?`}
          description={`${many ? "Their" : "Its"} attached files go too. This can't be undone. Backups you already made still hold ${many ? "them" : "it"}.`}
          initialFocus={cancel}
        >
          <Button
            ref={cancel}
            onClick={() => {
              setAsking(null);
            }}
          >
            Cancel
          </Button>
          <Button
            look="danger"
            onClick={() => {
              // The count the question showed goes with the yes: a trash of another size at the call deletes nothing, and the question
              // comes back with the new count.
              const expected = asking;
              setAsking(null);
              void (async () => {
                if ((await emptyTrash(session, generation, expected, olderThanDays)) !== "changed") return;
                // One turn for the window to show the list read again, then the question again, if there is still something to ask about.
                await new Promise((resolve) => window.setTimeout(resolve, 0));
                if (latest.current > 0) setAsking(latest.current);
              })();
            }}
          >
            {yes}
          </Button>
        </Dialog>
      )}
    </>
  );
}

/**
 * The panel of a picked Trash row (13b, 13c): its title, a line that says what it is, where it was and when it was deleted, and
 * Restore and Delete for good, and nothing else: no fields, no Reveal, Copy, Edit, Move or Open (nothing of the item is asked of
 * the shell for it). A folder says first what Restore brings back. Delete for good asks first (13d), with Cancel having focus; in a
 * vault that is read-only there are neither buttons. The panel goes with its row.
 */
export function TrashPanel({ data, summary, items }: { data: SessionData; summary: ItemSummary; items: readonly ItemSummary[] }) {
  // When the panel opened: "deleted 2 days ago" is said from this, and does not move while it is open.
  const [now] = useState(() => new Date());
  const [asking, setAsking] = useState(false);
  const cancel = useRef<HTMLButtonElement>(null);
  const isFolder = summary.kind === "collection";
  // "was in" only for a folder that is still there, in the list or in the trash.
  const folder = summary.collection === null ? undefined : items.find((other) => other.id === summary.collection);
  const subtitle = [
    KIND_WORD[summary.kind],
    folder === undefined ? "" : `was in ${folder.title}`,
    deletedText(summary.trashed_at ?? "", now),
  ]
    .filter((part) => part !== "")
    .join(" · ");
  const count = isFolder ? wentWith(items, summary.id) : 0;
  const restoreWords = isFolder
    ? count === 0
      ? "Restore brings back the folder. Items you trashed before that stay in the Trash."
      : `Restore brings back the folder and the ${count === 1 ? "1 item" : `${String(count)} items`} that went with it. Items you trashed before that stay in the Trash.`
    : null;
  const forGoodWords = isFolder
    ? "Only the folder goes. Items in the Trash stay there. This can't be undone. Backups you already made still hold it."
    : "Its attached files go too. This can't be undone. Backups you already made still hold it.";
  return (
    <Panel
      title={summary.title}
      titleClassName={summary.kind === "key" ? "m" : undefined}
      subtitle={subtitle}
      icon={<KindIcon kind={summary.kind} />}
      onClose={() => {
        pickTrashed(data.session, null);
      }}
      tools={data.readOnly ? <span className="chip">Read-only</span> : undefined}
    >
      {data.readOnly ? null : (
        <>
          {restoreWords === null ? null : <p className="tnote">{restoreWords}</p>}
          {/* As drawn (13b): one card, Restore in the accent above Delete for good in red, each row its full width. */}
          <div className="gapart">
            <div className="grp">
              <button
                type="button"
                className="dgr calm"
                onClick={() => {
                  void restoreTrashed(data.session, summary.id);
                }}
              >
                Restore
              </button>
              <button
                type="button"
                className="dgr"
                onClick={() => {
                  setAsking(true);
                }}
              >
                Delete for good
              </button>
            </div>
          </div>
          {asking ? (
            <Dialog
              open
              onOpenChange={(open) => {
                if (!open) setAsking(false);
              }}
              title={`Delete ${summary.title} for good?`}
              description={forGoodWords}
              initialFocus={cancel}
            >
              <Button
                ref={cancel}
                onClick={() => {
                  setAsking(false);
                }}
              >
                Cancel
              </Button>
              <Button
                look="danger"
                onClick={() => {
                  setAsking(false);
                  void purgeTrashed(data.session, summary.id);
                }}
              >
                Delete for good
              </Button>
            </Dialog>
          ) : null}
        </>
      )}
    </Panel>
  );
}
