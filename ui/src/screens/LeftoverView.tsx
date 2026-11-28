import { useRef, useState } from "react";
import type { OrphanFile } from "../api";
import { fileFromWords, formatBytes } from "../format";
import { messageFor, messageText } from "../messages";
import { Button } from "../parts/Button";
import { Dialog } from "../parts/Dialog";
import { deleteLeftover, retryLeftover, startRestore, type SessionData } from "../store";

/** The line under the title, in the design's own words (Ask 5). */
export const LEFTOVER_NOTE =
  "These files have no item that uses them. Their names were kept in the item, so only a date and size can show.";

/** What the question promises: only what the code can keep. A delete changes no backup; whether a backup holds these files is not known here. */
const WHOLE = "This can't be undone. Deleting these files won't change your existing backups.";

/** Said in place of Delete them all while an item can't be read (Ask 4): it may be the one that uses a file, and nothing says which. */
export const KEPT_WHILE_UNREADABLE = "Some items in this vault can't be read, so Petalock is keeping these files until that's sorted.";

/** The older file first, as drawn; the shell's order (by id) breaks a tie, so the order never changes between two reads. */
function byDate(a: OrphanFile, b: OrphanFile): number {
  return a.stored - b.stored || a.file_id.localeCompare(b.file_id);
}

/**
 * The "Leftover files" view (Ask 5), as drawn: the design's note, one row for each file (its date and its size, since its name was kept in the
 * item that used it, and nothing else of it: no id, no path), then Restore a backup (filled) and Delete them all. Delete them all asks first, with
 * the same pattern as emptying the trash (32b): Cancel has focus, and the yes is the filled red one. The yes sends the ids of the files the question
 * was asked over, and the vault deletes only if those are the files it has now. The list has three states (`data.leftover`): while it is read again
 * the rows may show but Delete waits; a list the shell refused is said in words with Try again, and offers no rows and no Delete; Delete is on only
 * for a list that was read. While an item can't be read (Ask 4) Delete is withheld and the words say why. The question belongs to the session and
 * generation it was opened for: the window gives this a key made of both, so a switch to another vault or a lock takes it away, and the store sends
 * nothing for a generation that has gone. Only a writable vault has this view (the store opens it for no other).
 */
export function LeftoverView({ data }: { data: SessionData }) {
  const { leftover, asks } = data;
  const files = leftover.phase === "failed" ? null : leftover.files;
  // The ids the question was opened over, in the order shown; `null` while it is shut.
  const [asking, setAsking] = useState<string[] | null>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const { session, generation } = data;
  const sorted = files === null ? [] : [...files].sort(byDate);
  const unreadable = asks.unreadable > 0;
  return (
    <>
      <p className="lnote">{LEFTOVER_NOTE}</p>
      {leftover.phase === "failed" ? (
        <p className="err" role="alert">
          {messageText(messageFor(leftover.error))}
        </p>
      ) : files === null ? (
        <p className="note" aria-busy="true">
          Opening…
        </p>
      ) : (
        <ul className="grp lgrp">
          {sorted.map((file) => (
            <li key={file.file_id} className="frow">
              <span className="ftile" aria-hidden="true">
                ?
              </span>
              <span className="fmeta">
                <b>{fileFromWords(file.stored)}</b>
                <small>{formatBytes(file.length)}</small>
              </span>
            </li>
          ))}
        </ul>
      )}
      {unreadable ? <p className="lnote">{KEPT_WHILE_UNREADABLE}</p> : null}
      <div className="le-a">
        {leftover.phase === "failed" ? (
          <Button
            onClick={() => {
              retryLeftover(session);
            }}
          >
            Try again
          </Button>
        ) : null}
        <Button
          look="pill-main"
          onClick={() => {
            // The open vault goes with the pick, so the restore lands beside this one, as Ask 4's does.
            void startRestore({ vault: data.vaultId });
          }}
        >
          Restore a backup
        </Button>
        {unreadable ? null : (
          <Button
            disabled={leftover.phase !== "ready"}
            onClick={() => {
              if (leftover.phase === "ready") setAsking([...leftover.files].sort(byDate).map((file) => file.file_id));
            }}
          >
            Delete them all
          </Button>
        )}
      </div>
      {asking === null ? null : (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setAsking(null);
          }}
          title={`Delete ${asking.length === 1 ? "1 leftover file" : `${String(asking.length)} leftover files`} permanently?`}
          description={WHOLE}
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
              const shown = asking;
              setAsking(null);
              void deleteLeftover(session, generation, shown);
            }}
          >
            Delete permanently
          </Button>
        </Dialog>
      )}
    </>
  );
}
