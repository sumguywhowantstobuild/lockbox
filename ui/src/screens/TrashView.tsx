import { useRef, useState } from "react";
import type { ItemKind, ItemSummary } from "../api";
import { deletedText } from "../format";
import { Button } from "../parts/Button";
import { Clip } from "../parts/Clip";
import { Dialog } from "../parts/Dialog";
import { KindIcon } from "../parts/Icon";
import { Panel } from "../parts/Panel";
import { pickTrashed, purgeTrashed, restoreTrashed, type SessionData } from "../store";

/** The line under the title: nothing is removed by the app on its own. */
export const NOTHING_REMOVED = "Nothing here is removed until you say so. Lockbox never empties the trash by itself.";

const KIND_WORD: Record<ItemKind, string> = { login: "Login", key: "Key", note: "Note", file: "File", collection: "Folder" };
const TILE: Record<ItemKind, string> = { login: "t0", file: "t1", note: "t2", key: "t3", collection: "t4" };

/** Folders first, then the one deleted last first (the dates are the engine's own fixed-format text, so their order is time's), then by name. */
function inOrder(a: ItemSummary, b: ItemSummary): number {
  const folders = Number(b.kind === "collection") - Number(a.kind === "collection");
  if (folders !== 0) return folders;
  const when = (b.trashed_at ?? "").localeCompare(a.trashed_at ?? "");
  return when !== 0 ? when : a.title.localeCompare(b.title, undefined, { sensitivity: "base" });
}

/** How many items a folder's restore brings back: those that went to the Trash with it, are still filed in it, and are not being deleted for good. The engine counts the same way. */
export function wentWith(items: readonly ItemSummary[], folder: string): number {
  return items.filter(
    (item) => item.trashed && !item.purging && item.trashed_with === folder && item.collection === folder,
  ).length;
}

/**
 * The Trash view (13b): the line that says nothing leaves by itself, then one row for each item in the trash, folders first and
 * then the one deleted last first, the items that went with a folder among them. A row says its kind, its title and when it was
 * deleted ("Deleted 2 days ago"; a folder's reads "Folder · deleted 2 days ago"). No Add, filter, sort or copy buttons here, and
 * nothing in it is removed by time. An empty Trash says so.
 */
export function TrashView({
  items,
  openId,
  onOpen,
}: {
  /** Every item in the trash, folders included. */
  items: readonly ItemSummary[];
  openId: string | null;
  onOpen: (id: string) => void;
}) {
  // When the view opened: "deleted 2 days ago" is said from this.
  const [now] = useState(() => new Date());
  const rows = [...items].sort(inOrder);
  return (
    <>
      <p className="lnote">{NOTHING_REMOVED}</p>
      {rows.length === 0 ? (
        <div className="grp lempty">
          <p className="le-t">Trash is empty.</p>
        </div>
      ) : (
        <div className="lgroups">
          <ul className="grp lgrp">
            {rows.map((item) => {
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
            })}
          </ul>
        </div>
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
