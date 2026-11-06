// A stand-in for the Rust side, for the screens' tests. It answers the commands the first screens call, in the shapes
// the shell's own serialisers pin (`views.rs`, `error.rs`, `session.rs`): an answer carries its session and
// generation, a refusal is a plain object with a `code`, and a command refuses a field it does not know with the
// shell's fixed malformed-request answer. A lock changes the generation and sends `lockbox://locked` before the
// command that caused it answers, as the shell does.
import type { Mock } from "vitest";

export const PASSWORD = "correct horse battery";

export interface FakeItem {
  id: string;
  kind: "login" | "note" | "file" | "collection";
  title: string;
  username?: string | null;
  collection?: string | null;
  trashed?: boolean;
  modified_at?: string;
  notes?: string;
  urls?: string[];
  has_password?: boolean;
  attachments?: { file_id: string; name: string; length: number; media_type: string }[];
}

export interface FakeVault {
  id: number;
  name: string | null;
  available?: boolean;
  password?: string;
  readOnly?: boolean;
  items?: FakeItem[];
}

interface Live {
  session: number;
  generation: number;
  unlocked: boolean;
}

export const MALFORMED = { code: "invalid_input", what: "request" };
export const WRONG_PASSWORD = { code: "core", kind: "wrong_password" };
export const LOCKED = { code: "locked" };

export function itemId(n: number): string {
  return n.toString(16).padStart(32, "0");
}

export const FOLDER = itemId(0xf1);
export const FOLDER_2 = itemId(0xf2);

/** Items for a vault: two folders, logins in and out of a folder, a note, a stored file and one in the trash. */
export function sampleItems(): FakeItem[] {
  return [
    { id: FOLDER, kind: "collection", title: "Agency support agent" },
    { id: FOLDER_2, kind: "collection", title: "Lineproof" },
    {
      id: itemId(1),
      kind: "login",
      title: "Bot admin console",
      username: "admin@example.com",
      collection: FOLDER,
      urls: ["https://support.example.com"],
      has_password: true,
      modified_at: "2026-11-04T09:00:00Z",
    },
    {
      id: itemId(2),
      kind: "login",
      title: "Error tracker",
      username: "team@example.com",
      collection: FOLDER_2,
      has_password: true,
      modified_at: "2026-10-12T09:00:00Z",
    },
    { id: itemId(3), kind: "note", title: "Rotation steps", collection: FOLDER, notes: "Made-up note", modified_at: "2026-09-20T09:00:00Z" },
    {
      id: itemId(4),
      kind: "file",
      title: "Client contract",
      collection: null,
      attachments: [{ file_id: itemId(0xa1), name: "contract-demo.pdf", length: 98304, media_type: "application/pdf" }],
      modified_at: "2026-09-02T09:00:00Z",
    },
    { id: itemId(5), kind: "login", title: "Old login in the trash", username: "gone@example.com", trashed: true, has_password: true },
  ];
}

function summary(item: FakeItem) {
  return {
    id: item.id,
    kind: item.kind,
    title: item.title,
    username: item.kind === "login" ? (item.username ?? "") : null,
    collection: item.collection ?? null,
    trashed: item.trashed ?? false,
    created_at: "2026-08-01T09:00:00Z",
    modified_at: item.modified_at ?? "2026-08-01T09:00:00Z",
    attachments: item.attachments ?? [],
  };
}

export interface FakeShell {
  /** Every command sent, in order, with its arguments. */
  calls: { cmd: string; args: unknown }[];
  /** Every `copy_field` that reached the shell, as it was sent. */
  copied: Record<string, unknown>[];
  /** Sends `lockbox://locked` for the session and moves its generation on, as a lock does. */
  lock(session: number, reason?: string): void;
  /** The session the vault is open in, if it is. */
  sessionOf(vaultId: number): Live | undefined;
  /** Holds every `list_items` answer until `release` is called, to lock while one is in flight. */
  holdListItems(): () => void;
}

let sessionRange = 0;

/** Refuses as the shell does: Tauri rejects with the plain object the error was serialised to, not an `Error`. */
function refuse(error: object): never {
  // eslint-disable-next-line @typescript-eslint/only-throw-error -- see above
  throw error;
}

function exactly(args: unknown, keys: string[]): Record<string, unknown> {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return refuse(MALFORMED);
  const found = Object.keys(args).sort();
  if (found.join() !== [...keys].sort().join()) return refuse(MALFORMED);
  return args as Record<string, unknown>;
}

/**
 * Wires `invoke` and `listen` (the mocked Tauri modules) to a fake shell holding `vaults`. `listen` keeps the handlers
 * it was given, so `lock` can call them.
 */
export function installFakeShell(
  invoke: Mock,
  listen: Mock,
  vaults: FakeVault[],
  settings = { idle_minutes: 5, clipboard_seconds: 30 },
): FakeShell {
  const handlers: ((event: { payload: unknown }) => void)[] = [];
  const live = new Map<number, Live>();
  const sessionVault = new Map<number, FakeVault>();
  // A fresh range of session numbers for each fake, because the bridge remembers every session's generation for the
  // life of the test file, and a later test must not meet an earlier test's.
  sessionRange += 100;
  let nextSession = sessionRange;
  let held: (() => void)[] | undefined;
  const calls: FakeShell["calls"] = [];
  const copied: FakeShell["copied"] = [];

  listen.mockImplementation((event: string, handler: (event: { payload: unknown }) => void) => {
    calls.push({ cmd: `listen:${event}`, args: undefined });
    handlers.push(handler);
    return Promise.resolve(() => undefined);
  });

  const lock = (session: number, reason = "manual"): void => {
    const entry = live.get(session);
    if (entry?.unlocked !== true) return;
    entry.unlocked = false;
    entry.generation += 1;
    for (const handler of handlers) handler({ payload: { session, generation: entry.generation, reason } });
  };

  const vaultFor = (session: number, generation: number): FakeVault => {
    const entry = live.get(session);
    const vault = sessionVault.get(session);
    if (entry?.unlocked !== true || entry.generation !== generation || vault === undefined) return refuse(LOCKED);
    return vault;
  };

  const tagged = (session: number, generation: number, data: unknown) => ({ session, generation, data });

  const answer = (cmd: string, args: unknown): unknown => {
    switch (cmd) {
      case "list_vaults":
        exactly(args ?? {}, []);
        return vaults.map((v) => ({ id: v.id, name: v.name, available: v.available ?? true }));
      case "get_settings":
        exactly(args ?? {}, []);
        return settings;
      case "unlock_vault": {
        const { id, password } = exactly(args, ["id", "password"]);
        const vault = vaults.find((v) => v.id === id);
        if (vault === undefined) return refuse({ code: "not_found" });
        if (password !== (vault.password ?? PASSWORD)) return refuse(WRONG_PASSWORD);
        let entry = [...live.entries()].find(([session]) => sessionVault.get(session) === vault);
        if (entry === undefined) {
          nextSession += 1;
          entry = [nextSession, { session: nextSession, generation: 0, unlocked: false }];
          live.set(nextSession, entry[1]);
          sessionVault.set(nextSession, vault);
        }
        const [session, state] = entry;
        state.unlocked = true;
        state.generation += 1;
        return tagged(session, state.generation, {
          info: {
            session,
            generation: state.generation,
            name: vault.name ?? "",
            read_only: vault.readOnly ?? false,
            state: "unlocked",
          },
          used_backup_header: false,
          header_mac_mismatch: false,
          header_repair_failed: false,
          cleanup: {
            partials_removed: 0,
            temps_removed: 0,
            retired_deleted: 0,
            purges_finished: 0,
            orphans_quarantined: 0,
            orphans_restored: 0,
            skipped_damaged: 0,
            failed: 0,
          },
          cloud: null,
        });
      }
      case "list_items": {
        const { session, generation } = exactly(args, ["session", "generation"]) as { session: number; generation: number };
        const vault = vaultFor(session, generation);
        return tagged(session, generation, { items: (vault.items ?? []).map(summary), damaged: [] });
      }
      case "get_item": {
        const { session, generation, id } = exactly(args, ["session", "generation", "id"]) as {
          session: number;
          generation: number;
          id: string;
        };
        const item = vaultFor(session, generation).items?.find((i) => i.id === id);
        if (item === undefined) return refuse({ code: "core", kind: "not_found" });
        return tagged(session, generation, {
          summary: summary(item),
          revision: 2,
          notes: item.notes ?? "",
          urls: item.urls ?? [],
          has_password: item.has_password ?? false,
        });
      }
      case "copy_field": {
        const sent = exactly(args, ["session", "generation", "id", "field"]) as {
          session: number;
          generation: number;
        };
        vaultFor(sent.session, sent.generation);
        copied.push(sent);
        return tagged(sent.session, sent.generation, null);
      }
      case "lock_vault": {
        const { session } = exactly(args, ["session"]) as { session: number };
        lock(session);
        return null;
      }
      case "lock_all":
        exactly(args ?? {}, []);
        for (const session of [...live.keys()]) lock(session);
        return null;
      default:
        throw new Error(`the fake shell has no command ${cmd}`);
    }
  };

  invoke.mockImplementation((cmd: string, args?: unknown) => {
    calls.push({ cmd, args });
    try {
      const result = answer(cmd, args);
      if (cmd === "list_items" && held !== undefined) {
        const release = held;
        return new Promise((resolve) => {
          release.push(() => {
            resolve(result);
          });
        });
      }
      return Promise.resolve(result);
    } catch (error) {
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- Tauri rejects with the plain object
      return Promise.reject(error);
    }
  });

  return {
    calls,
    copied,
    lock,
    sessionOf: (vaultId) => {
      const vault = vaults.find((v) => v.id === vaultId);
      return [...live.values()].find((entry) => sessionVault.get(entry.session) === vault);
    },
    holdListItems: () => {
      const waiting: (() => void)[] = [];
      held = waiting;
      return () => {
        held = undefined;
        for (const release of waiting) release();
      };
    },
  };
}
