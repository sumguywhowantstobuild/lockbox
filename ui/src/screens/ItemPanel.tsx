import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ItemDetail, ItemKind, ItemSummary } from "../api";
import { changedText, dayWords, formatBytes } from "../format";
import { messageFor } from "../messages";
import { Button } from "../parts/Button";
import { CopyIcon, KindIcon } from "../parts/Icon";
import { Menu, type MenuItem } from "../parts/Menu";
import { Panel } from "../parts/Panel";
import {
  copyField,
  hideReveal,
  moveOpenItem,
  openEdit,
  openSite,
  revealKey,
  revealValue,
  trashOpenItem,
  type SessionData,
} from "../store";
import { useValueGuard } from "../useValueGuard";
import type { FolderEntry } from "./SideMenu";

const KIND_WORD: Record<ItemKind, string> = { login: "Login", key: "Key", note: "Note", file: "File", collection: "Folder" };
const KIND_TILE: Record<ItemKind, string> = { login: "t0", file: "t1", note: "t2", key: "t3", collection: "t4" };

/**
 * A stored website as an address the shell would open: it parses, and it is `http` or `https` (the shell's own rule, which
 * `URL` shares, ends trimmed included). `null` otherwise.
 */
function webUrl(stored: string): URL | null {
  try {
    const url = new URL(stored);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

/**
 * A website as it is shown: its host and path, without the scheme, a trailing slash, or what must not be copied about
 * (a login in front of the host, the query and the fragment, which can hold a password or a token).
 */
function shown(stored: string): string {
  const url = webUrl(stored);
  if (url !== null) return `${url.host}${url.pathname}`.replace(/\/$/, "");
  return stored
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
    .replace(/^[^/?#]*@/, "")
    .replace(/[?#].*$/, "")
    .replace(/\/$/, "");
}

function Field({ label, children, action }: { label?: string; children: ReactNode; action?: ReactNode }) {
  return (
    <div className="fld">
      <div className="fv">
        {label === undefined ? null : <span className="fl">{label}</span>}
        {children}
      </div>
      {action}
    </div>
  );
}

function LoginFields({
  data,
  summary,
  detail,
  now,
}: {
  data: SessionData;
  summary: ItemSummary;
  detail: ItemDetail | null;
  /** When the panel opened, for the days its earlier passwords say. */
  now: Date;
}) {
  const username = summary.username ?? "";
  return (
    <>
      <section className="gp">
        <div className="grp">
          {username === "" ? null : (
            <Field
              label="Username"
              action={
                <button
                  type="button"
                  className="pill"
                  aria-label="Copy username"
                  onClick={() => {
                    void copyField(data.session, summary.id, "username");
                  }}
                >
                  Copy
                </button>
              }
            >
              <span className="fval">{username}</span>
            </Field>
          )}
          {detail === null ? null : (
            <SecretValue
              data={data}
              summary={summary}
              field="password"
              label="Password"
              boxName="Password"
              copyWords="Copy password"
              has={detail.has_password}
              noneWords="No password saved"
            />
          )}
        </div>
      </section>
      {detail !== null && detail.urls.length > 0 ? (
        <section className="gp">
          <div className="grp">
            {detail.urls.map((url, index) => (
              <Field
                key={`${String(index)}:${url}`}
                label="Website"
                action={
                  // Only an address the shell would open gets the button; the shell opens it by its number, not by this
                  // text. The button is named by the host alone: a label must never hold a login, a path or a query.
                  webUrl(url) !== null ? (
                    <button
                      type="button"
                      className="pill"
                      aria-label={`Open ${webUrl(url)?.hostname ?? ""}`}
                      onClick={() => {
                        void openSite(data.session, summary.id, index);
                      }}
                    >
                      Open
                    </button>
                  ) : undefined
                }
              >
                <span className="fval">{shown(url)}</span>
              </Field>
            ))}
          </div>
        </section>
      ) : null}
      {detail !== null && detail.notes !== "" ? (
        <section className="gp">
          <div className="grp">
            <Field label="Notes">
              <span className="fnote">{detail.notes}</span>
            </Field>
          </div>
        </section>
      ) : null}
      {detail !== null && detail.previous.length > 0 ? (
        <section className="gp">
          <h3 className="gh">Earlier passwords</h3>
          <div className="grp">
            {detail.previous.map((old) => (
              <EarlierPassword key={old.index} data={data} summary={summary} index={old.index} replacedAt={old.replaced_at} now={now} />
            ))}
          </div>
        </section>
      ) : null}
    </>
  );
}

/**
 * One of a login's earlier passwords (11b): "Until <day>" (the day it was replaced), the password hidden as dots, Copy (in
 * Rust, like any copy) and Reveal, which shows it in the guarded box through the same reveal token as the password in use.
 * One value is on screen at a time: Reveal here takes another off, and Hide, another item, a form or a lock takes this one. Its
 * buttons are named by the day, never by what is in it.
 */
function EarlierPassword({
  data,
  summary,
  index,
  replacedAt,
  now,
}: {
  data: SessionData;
  summary: ItemSummary;
  index: number;
  replacedAt: string;
  now: Date;
}) {
  const field = { previous: index };
  const value = data.reveals[revealKey(summary.id, field)];
  const day = dayWords(replacedAt, now);
  // Numbered when the date could not be read, so the rows still tell apart.
  const which = day === "" ? `earlier password ${String(index + 1)}` : `earlier password, until ${day}`;
  const copyIt = () => {
    void copyField(data.session, summary.id, field);
  };
  return (
    <div className="fld">
      <div className="fv">
        <span className="fl">{day === "" ? `Earlier ${String(index + 1)}` : `Until ${day}`}</span>
        {value === undefined ? (
          <>
            {/* Dots that stand for a value, never one. */}
            <span className="sec hid" aria-hidden="true">
              ••••••••••••
            </span>
            <span className="sr">Hidden</span>
          </>
        ) : (
          <RevealedValue value={value} name={which.charAt(0).toUpperCase() + which.slice(1)} onCopy={copyIt} />
        )}
      </div>
      <button type="button" className="pill" aria-label={`Copy ${which}`} onClick={copyIt}>
        Copy
      </button>
      <button
        type="button"
        className="pill"
        aria-label={`${value === undefined ? "Reveal" : "Hide"} ${which}`}
        onClick={() => {
          if (value === undefined) void revealValue(data.session, summary.id, field);
          else hideReveal(data.session);
        }}
      >
        {value === undefined ? "Reveal" : "Hide"}
      </button>
    </div>
  );
}

/**
 * A key's value, once revealed: in Geist Mono where a screen reader can reach it, and not selectable, so a copy aimed at it
 * is stopped and Ctrl+C does what Copy key does, through the shell (`useValueGuard`). It is on the page only while it is
 * shown.
 */
function RevealedValue({ value, name, onCopy }: { value: string; name: string; onCopy: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  useValueGuard(box, onCopy);
  return (
    <div ref={box} className="sec kval" role="textbox" aria-readonly="true" aria-label={name} tabIndex={0}>
      {value}
    </div>
  );
}

/**
 * A value the person can reveal, for a login's password and a key's value alike (one path, with the field that differs): its
 * label, the value hidden as dots, Copy (in Rust) and Reveal. Reveal asks the shell for the value and shows it in the guarded
 * box with Hide in Reveal's place; Hide, opening another item (or this one again), a form, another folder, closing the panel
 * or a lock takes it away, and an answer that comes late never brings it back (`revealValue` in the store). With nothing
 * saved, it says so and offers neither.
 */
function SecretValue({
  data,
  summary,
  field,
  label,
  boxName,
  copyWords,
  has,
  noneWords,
}: {
  data: SessionData;
  summary: ItemSummary;
  field: "password" | "key_value";
  label: string;
  /** What a screen reader calls the box that holds the revealed value. */
  boxName: string;
  copyWords: string;
  has: boolean;
  noneWords: string;
}) {
  const value = data.reveals[summary.id];
  const copyIt = () => {
    void copyField(data.session, summary.id, field);
  };
  return (
    <div className="fld col">
      <span className="fl">{label}</span>
      {has ? (
        <>
          {value === undefined ? (
            <>
              {/* Dots that stand for a value, never one: the value is not on this page until Reveal. */}
              <span className="sec hid" aria-hidden="true">
                ••••••••••••••
              </span>
              <span className="sr">Hidden</span>
            </>
          ) : (
            <RevealedValue value={value} name={boxName} onCopy={copyIt} />
          )}
          <div className="fact">
            <Button look="pill-main" onClick={copyIt}>
              <CopyIcon />
              {copyWords}
            </Button>
            <Button
              onClick={() => {
                if (value === undefined) void revealValue(data.session, summary.id, field);
                else hideReveal(data.session);
              }}
            >
              {value === undefined ? "Reveal" : "Hide"}
            </Button>
          </div>
        </>
      ) : (
        <span className="fval">{noneWords}</span>
      )}
    </div>
  );
}

/**
 * A key's details (3c, 3d): its value, hidden until Reveal (`SecretValue`), and its notes when it has some.
 */
function KeyFields({ data, summary, detail }: { data: SessionData; summary: ItemSummary; detail: ItemDetail | null }) {
  if (detail === null) return null;
  return (
    <>
      <section className="gp">
        <div className="grp">
          <SecretValue
            data={data}
            summary={summary}
            field="key_value"
            label="Value"
            boxName="Key value"
            copyWords="Copy key"
            has={detail.has_value}
            noneWords="No value saved"
          />
        </div>
      </section>
      {detail.notes !== "" ? (
        <section className="gp">
          <div className="grp">
            <Field label="Notes">
              <span className="fnote">{detail.notes}</span>
            </Field>
          </div>
        </section>
      ) : null}
    </>
  );
}

/**
 * A note's text (3g), shown as soon as the note opens (decision A: a note is not hidden like a password or a key's value),
 * with Copy, which copies it in Rust like any copy.
 */
function NoteFields({ data, summary, detail }: { data: SessionData; summary: ItemSummary; detail: ItemDetail | null }) {
  if (detail === null || detail.notes === "") return null;
  return (
    <section className="gp">
      <div className="grp">
        <Field
          action={
            <button
              type="button"
              className="pill"
              aria-label="Copy text"
              onClick={() => {
                void copyField(data.session, summary.id, "notes");
              }}
            >
              Copy
            </button>
          }
        >
          <span className="fnote">{detail.notes}</span>
        </Field>
      </div>
    </section>
  );
}

/** A file's details: what is stored, and its note when it has one (Notes, as a key's details show theirs). */
function FileFields({ summary, detail }: { summary: ItemSummary; detail: ItemDetail | null }) {
  const note = detail !== null && detail.notes !== "";
  if (summary.attachments.length === 0 && !note) return null;
  return (
    <>
      {summary.attachments.length === 0 ? null : (
        <section className="gp">
          <div className="grp">
            {summary.attachments.map((file) => (
              <div className="frow" key={file.file_id}>
                <span className={`ftile ${KIND_TILE.file}`} aria-hidden="true">
                  <KindIcon kind="file" />
                </span>
                <span className="fmeta">
                  <b>{file.name}</b>
                  <small>{formatBytes(file.length)}</small>
                </span>
              </div>
            ))}
          </div>
        </section>
      )}
      {note ? (
        <section className="gp">
          <div className="grp">
            <Field label="Notes">
              <span className="fnote">{detail.notes}</span>
            </Field>
          </div>
        </section>
      ) : null}
    </>
  );
}

/**
 * The details of the item open in the side panel: what kind it is, where, when it changed, and its fields. A password
 * is hidden and stays so: it can be copied (in Rust) and nothing else. Closing the panel drops the item.
 */
export function ItemPanel({
  data,
  folders,
  folderNames,
  onClose,
}: {
  data: SessionData;
  /** The folders to move the item to, by name (the live ones). */
  folders: readonly FolderEntry[];
  folderNames: ReadonlyMap<string, string>;
  onClose: () => void;
}) {
  // When the panel opened: "changed 2 days ago" is said from this, and does not move while it is open.
  const [openedAt] = useState(() => new Date());
  const open = data.openItem;
  // The details' own summary is the freshest there is (read after a save), and is there even when the list could not be
  // read again right after it; the list's is what shows until the details have come.
  const summary = open === null ? undefined : (open.detail?.summary ?? data.items?.find((item) => item.id === open.id));
  // A login just saved from the new-login form takes focus on its heading: the form it came from is gone, and the next
  // thing is its Copy buttons, a Tab away.
  const title = useRef<HTMLHeadingElement>(null);
  const justSaved = open?.saved === true;
  const shown = summary !== undefined;
  useEffect(() => {
    if (justSaved && shown) title.current?.focus();
  }, [justSaved, shown]);
  // Back from its Edit form (saved or cancelled), focus goes to Edit, the button that opened the form, once it is there.
  const editButton = useRef<HTMLButtonElement>(null);
  const backFromEdit = open?.focusEdit === true;
  const hasDetail = open?.detail != null;
  useEffect(() => {
    if (backFromEdit && hasDetail) editButton.current?.focus();
  }, [backFromEdit, hasDetail]);
  if (open === null || summary === undefined) return null;

  const folder = summary.collection === null ? undefined : folderNames.get(summary.collection);
  const subtitle = [KIND_WORD[summary.kind], folder, changedText(summary.modified_at, openedAt)]
    .filter((part) => part !== undefined && part !== "")
    .join(" · ");
  const problem = open.error === null ? null : messageFor(open.error);
  // Move to folder (12a): "No folder", then each folder by name, the one the item is in marked. An item whose folder is gone from
  // the list (in the trash, or missing) counts as in no folder, as the rest of the page does.
  const inFolder = summary.collection !== null && folders.some((entry) => entry.id === summary.collection);
  const moveChoices: MenuItem[] = [
    {
      id: "none",
      label: "No folder",
      checked: !inFolder,
      onSelect: () => {
        void moveOpenItem(data.session, null, null);
      },
    },
    ...folders.map((entry) => ({
      id: entry.id,
      label: entry.name,
      checked: summary.collection === entry.id,
      onSelect: () => {
        void moveOpenItem(data.session, entry.id, entry.name);
      },
    })),
  ];
  return (
    <Panel
      title={summary.title}
      titleRef={justSaved ? title : undefined}
      subtitle={subtitle}
      icon={<KindIcon kind={summary.kind} />}
      onClose={onClose}
      tools={
        data.readOnly ? (
          // A vault opened from a backup: said as drawn, and no Move or Edit (the shell refuses both there as well).
          <span className="chip">Read-only</span>
        ) : open.detail === null ? undefined : (
          <>
            <Menu label="Move" popupLabel="Move to folder" items={moveChoices} />
            <Button
              ref={editButton}
              onClick={() => {
                openEdit(data.session);
              }}
            >
              Edit
            </Button>
          </>
        )
      }
    >
      {problem !== null ? (
        <p className="err" role="alert">
          {problem.title} {problem.body}
        </p>
      ) : null}
      {summary.kind === "login" ? <LoginFields data={data} summary={summary} detail={open.detail} now={openedAt} /> : null}
      {summary.kind === "key" ? <KeyFields data={data} summary={summary} detail={open.detail} /> : null}
      {summary.kind === "note" ? <NoteFields data={data} summary={summary} detail={open.detail} /> : null}
      {summary.kind === "file" ? <FileFields summary={summary} detail={open.detail} /> : null}
      {data.readOnly ? null : (
        // At the foot of the details, as drawn (13a): it goes at once, with no question, and says where to find it.
        <div className="ptrash">
          <Button
            className="dngb"
            onClick={() => {
              void trashOpenItem(data.session);
            }}
          >
            Move to trash
          </Button>
          <p className="tnote">You can restore it from Trash.</p>
        </div>
      )}
    </Panel>
  );
}
