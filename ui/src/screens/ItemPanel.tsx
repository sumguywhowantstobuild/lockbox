import { useEffect, useRef, useState, type ReactNode } from "react";
import type { CopyableField, ItemDetail, ItemKind, ItemSummary, RevealableField } from "../api";
import { changedText, formatBytes } from "../format";
import { messageFor } from "../messages";
import { Button } from "../parts/Button";
import { CopyIcon, KindIcon } from "../parts/Icon";
import { Panel } from "../parts/Panel";
import { copyField, hideReveal, openSite, revealValue, type SessionData } from "../store";
import { useValueGuard } from "../useValueGuard";

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

function LoginFields({ data, summary, detail }: { data: SessionData; summary: ItemSummary; detail: ItemDetail | null }) {
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
    </>
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
  field: RevealableField & CopyableField;
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

function FileFields({ summary }: { summary: ItemSummary }) {
  if (summary.attachments.length === 0) return null;
  return (
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
  );
}

/**
 * The details of the item open in the side panel: what kind it is, where, when it changed, and its fields. A password
 * is hidden and stays so: it can be copied (in Rust) and nothing else. Closing the panel drops the item.
 */
export function ItemPanel({
  data,
  folderNames,
  onClose,
}: {
  data: SessionData;
  folderNames: ReadonlyMap<string, string>;
  onClose: () => void;
}) {
  // When the panel opened: "changed 2 days ago" is said from this, and does not move while it is open.
  const [openedAt] = useState(() => new Date());
  const open = data.openItem;
  const summary = open === null ? undefined : data.items?.find((item) => item.id === open.id);
  // A login just saved from the new-login form takes focus on its heading: the form it came from is gone, and the next
  // thing is its Copy buttons, a Tab away.
  const title = useRef<HTMLHeadingElement>(null);
  const justSaved = open?.saved === true;
  const shown = summary !== undefined;
  useEffect(() => {
    if (justSaved && shown) title.current?.focus();
  }, [justSaved, shown]);
  if (open === null || summary === undefined) return null;

  const folder = summary.collection === null ? undefined : folderNames.get(summary.collection);
  const subtitle = [KIND_WORD[summary.kind], folder, changedText(summary.modified_at, openedAt)]
    .filter((part) => part !== undefined && part !== "")
    .join(" · ");
  const problem = open.error === null ? null : messageFor(open.error);
  return (
    <Panel
      title={summary.title}
      titleRef={justSaved ? title : undefined}
      subtitle={subtitle}
      icon={<KindIcon kind={summary.kind} />}
      onClose={onClose}
    >
      {problem !== null ? (
        <p className="err" role="alert">
          {problem.title} {problem.body}
        </p>
      ) : null}
      {summary.kind === "login" ? <LoginFields data={data} summary={summary} detail={open.detail} /> : null}
      {summary.kind === "key" ? <KeyFields data={data} summary={summary} detail={open.detail} /> : null}
      {summary.kind === "note" ? <NoteFields data={data} summary={summary} detail={open.detail} /> : null}
      {summary.kind === "file" ? <FileFields summary={summary} /> : null}
    </Panel>
  );
}
