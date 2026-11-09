import { useState, type ReactNode } from "react";
import type { ItemDetail, ItemKind, ItemSummary } from "../api";
import { changedText, formatBytes } from "../format";
import { messageFor } from "../messages";
import { CopyIcon, KindIcon } from "../parts/Icon";
import { Panel } from "../parts/Panel";
import { copyField, openSite, type SessionData } from "../store";

const KIND_WORD: Record<ItemKind, string> = { login: "Login", note: "Note", file: "File", collection: "Folder" };
const KIND_TILE: Record<ItemKind, string> = { login: "t0", file: "t1", note: "t2", collection: "t4" };

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

function Field({ label, children, action }: { label: string; children: ReactNode; action?: ReactNode }) {
  return (
    <div className="fld">
      <div className="fv">
        <span className="fl">{label}</span>
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
            <div className="fld col">
              <span className="fl">Password</span>
              {detail.has_password ? (
                <>
                  {/* Dots that stand for a password, never one: the password is not on this page. */}
                  <span className="sec hid" aria-hidden="true">
                    ••••••••••••••
                  </span>
                  <span className="sr">Hidden</span>
                  <div className="fact">
                    <button
                      type="button"
                      className="pill t cp"
                      onClick={() => {
                        void copyField(data.session, summary.id, "password");
                      }}
                    >
                      <CopyIcon />
                      Copy password
                    </button>
                  </div>
                </>
              ) : (
                <span className="fval">No password saved</span>
              )}
            </div>
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

function NoteFields({ detail }: { detail: ItemDetail | null }) {
  if (detail === null || detail.notes === "") return null;
  return (
    <section className="gp">
      <div className="grp">
        <div className="fld">
          <div className="fv">
            <span className="fnote">{detail.notes}</span>
          </div>
        </div>
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
  if (open === null || summary === undefined) return null;

  const folder = summary.collection === null ? undefined : folderNames.get(summary.collection);
  const subtitle = [KIND_WORD[summary.kind], folder, changedText(summary.modified_at, openedAt)]
    .filter((part) => part !== undefined && part !== "")
    .join(" · ");
  const problem = open.error === null ? null : messageFor(open.error);
  return (
    <Panel
      title={summary.title}
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
      {summary.kind === "note" ? <NoteFields detail={open.detail} /> : null}
      {summary.kind === "file" ? <FileFields summary={summary} /> : null}
    </Panel>
  );
}
