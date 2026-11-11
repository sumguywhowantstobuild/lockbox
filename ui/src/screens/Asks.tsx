import { useId, useRef, useState, type ReactNode } from "react";
import type { CloudProvider } from "../api";
import { messageFor, messageText } from "../messages";
import { Button } from "../parts/Button";
import { Dialog } from "../parts/Dialog";
import {
  acceptDetails,
  closeBanner,
  dismissShortcutNotice,
  lockThisVault,
  retryOpenFiles,
  setOutputRecordAside,
  useLockNote,
  useNotices,
  type Banner,
  type SessionData,
} from "../store";

// The app's questions that an unlock, or the launch before it, has to tell (the design's "The app's questions"). Each
// shows the design's words and only the buttons whose screen exists in 4A: a button that leads to a later plan's screen
// is not drawn, and a sentence that names one waits with it. Words come from fixed text, the vault's own name and a
// count, never from a refusal's own text: a refusal goes through `messageFor`.

/** What the person calls each cloud service; the shell sends a fixed spelling (`GoogleDrive`). */
const PROVIDER: Record<CloudProvider, string> = {
  OneDrive: "OneDrive",
  GoogleDrive: "Google Drive",
  Dropbox: "Dropbox",
  Other: "A cloud service",
};

/** Ask 3's message after its first sentence, which names the vault. */
const DETAILS_CHANGED =
  "Its name, or other details kept beside your items, don't match what Lockbox last saved. Moving a vault or restoring a backup doesn't cause this. If you edited that file yourself, accept it. If you didn't, lock it and check your PC first; restoring a backup you trust is the safer way back. Backups stay off until you accept.";

/** The one word that fits one or many. */
function count(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/**
 * A banner: its words and, under them, its buttons. A banner holds no focus and is not a dialog, so the person can read
 * the list under it and close it, or leave it. Each button is described by the words, so a screen reader that reaches
 * "Close" hears which banner it closes.
 */
function Notice({
  text,
  actions,
  children,
}: {
  text: string;
  actions: { name: string; onPress: () => void; disabled?: boolean }[];
  children?: ReactNode;
}) {
  const words = useId();
  return (
    <div className="ask">
      <p id={words}>{text}</p>
      {children}
      {actions.length === 0 ? null : (
        <div className="ask-acts">
          {actions.map((action) => (
            <Button key={action.name} aria-describedby={words} disabled={action.disabled} onClick={action.onPress}>
              {action.name}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Ask 3, "Details changed": a dialog that holds focus, since it is a security question and the vault should not be used
 * until it is answered. Escape is not a yes, and neither is a click outside: only a button answers. The safe answer,
 * Lock this vault, has focus first. Accept calls `accept_header`, and the new recovery key (21f), if one waits, follows.
 * Lock this vault locks it, and the question comes back at the next unlock. A lock that comes first closes it unsaid.
 */
export function DetailsChangedAsk({ data }: { data: SessionData }) {
  const lock = useRef<HTMLButtonElement>(null);
  const { asks } = data;
  const refusal = asks.detailsError === null ? null : messageText(messageFor(asks.detailsError));
  return (
    <Dialog
      open={asks.detailsChanged}
      onOpenChange={() => undefined}
      title={`${data.name}'s details were changed outside Lockbox.`}
      description={DETAILS_CHANGED}
      initialFocus={lock}
    >
      {refusal === null ? null : (
        <p className="err" role="alert">
          {refusal}
        </p>
      )}
      <Button
        ref={lock}
        disabled={asks.answering}
        onClick={() => {
          void lockThisVault(data.session);
        }}
      >
        Lock this vault
      </Button>
      <Button
        look="pill-main"
        disabled={asks.answering}
        onClick={() => {
          void acceptDetails(data.session);
        }}
      >
        Accept
      </Button>
    </Dialog>
  );
}

/**
 * The banners an unlock raises over the list: Ask 4 (items that can't be read), Ask 5 (leftover files, the count only: the
 * sentences about "these files" and their date and size need the list, which 4B builds, and so does Delete them all),
 * Ask 9 (opened from the spare details; its last sentence sends the person to Change password, a 4C screen, so it waits)
 * and Ask 10 (a cloud folder). Each closes with its button and comes back at the next unlock.
 */
export function VaultBanners({ data }: { data: SessionData }) {
  const { asks, session } = data;
  const open = (banner: Banner) => !asks.closed.includes(banner);
  const close = (banner: Banner) => () => {
    closeBanner(session, banner);
  };
  const cloud = asks.cloud;
  return (
    <>
      {asks.unreadable > 0 && open("unreadable") ? (
        <Notice
          text={`${String(asks.unreadable)} ${count(asks.unreadable, "item in this vault can't be read. Everything else works. It may be damaged", "items in this vault can't be read. Everything else works. They may be damaged")}, so Lockbox left all stored files where they are until this is sorted.`}
          actions={[{ name: "Close", onPress: close("unreadable") }]}
        />
      ) : null}
      {asks.leftover > 0 && open("leftover") ? (
        <Notice
          text={`${String(asks.leftover)} ${count(asks.leftover, "leftover file has no item that uses it.", "leftover files have no item that uses them.")}`}
          actions={[{ name: "Close", onPress: close("leftover") }]}
        />
      ) : null}
      {asks.spareDetails && open("spare") ? (
        <Notice
          text="Opened from the backup copy of this vault's details. If you changed this vault's password recently, it may need your previous password."
          actions={[{ name: "Later", onPress: close("spare") }]}
        />
      ) : null}
      {cloud !== null && open("cloud") ? (
        <Notice
          text={`${PROVIDER[cloud]} syncs ${data.name}'s folder. Lockbox doesn't support vaults in cloud folders. To stop this message, move the vault to a folder on this PC.`}
          actions={[{ name: "Keep it there", onPress: close("cloud") }]}
        />
      ) : null}
    </>
  );
}

/**
 * Ask 11, "Lost track of opened files": the record of files the person opened is damaged, so Lockbox can't clean them
 * up. Its one button sets the record aside; it has no Close, since backing up, Save a copy and Open stay off until then.
 * Shown on the lock screen and in the vault. A refusal of the button is said under the words.
 */
export function LostOutputsAsk() {
  const { lostOutputs } = useNotices();
  const [refusal, setRefusal] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!lostOutputs) return null;
  const setAside = async () => {
    setBusy(true);
    setRefusal(null);
    try {
      await setOutputRecordAside();
    } catch (error) {
      setRefusal(messageText(messageFor(error)));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Notice
      text="Lockbox lost track of some opened files. Its record of files you opened is damaged, so it can't clean them up. Until you set the record aside, backing up, Save a copy and Open stay off."
      actions={[
        {
          name: "Set it aside",
          disabled: busy,
          onPress: () => {
            void setAside();
          },
        },
      ]}
    >
      {refusal === null ? null : (
        <p className="err" role="alert">
          {refusal}
        </p>
      )}
    </Notice>
  );
}

/**
 * 10e, "Opened copies still in use": a lock's cleanup could not remove a copy of a stored file, because another program holds it open. The
 * words are the design's, with the count, and Retry asks the shell to try again; the message goes when none are left. Shown on the lock
 * screen, where the lock leaves the person, and in the vault. A refusal of Retry is said under the words, and the message stays. The copies
 * are read-only and marked as from the internet, and stay on this PC until removed, which the words say.
 */
export function OpenFilesAsk() {
  const { openFiles } = useNotices();
  const [refusal, setRefusal] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (openFiles === 0) return null;
  const retry = async () => {
    setBusy(true);
    setRefusal(null);
    try {
      await retryOpenFiles();
    } catch (error) {
      setRefusal(messageText(messageFor(error)));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Notice
      text={`Couldn't remove ${String(openFiles)} opened ${count(openFiles, "file", "files")}.`}
      actions={[
        {
          name: "Retry",
          disabled: busy,
          onPress: () => {
            void retry();
          },
        },
      ]}
    >
      <p>Close the app using them, then Retry. They stay readable on this PC until then.</p>
      {refusal === null ? null : (
        <p className="err" role="alert">
          {refusal}
        </p>
      )}
    </Notice>
  );
}

/**
 * The save shortcut (Ctrl+Shift+L) is off: another app holds it, or it could not be turned on for another reason. Words and a Close; shown on
 * the lock screen and in the vault until it is closed, and told again only when Lockbox starts again.
 */
export function ShortcutAsk() {
  const { shortcut } = useNotices();
  if (shortcut === null) return null;
  return (
    <Notice
      text={
        shortcut === "taken"
          ? "Ctrl+Shift+L is used by another app, so the save shortcut is off. Close that app and restart Lockbox to use it."
          : "The save shortcut couldn't be turned on. Restart Lockbox to try again."
      }
      actions={[{ name: "Close", onPress: dismissShortcutNotice }]}
    />
  );
}

/**
 * What the lock screen says beside the password: a restore that Lockbox finished at launch (words only; the lock
 * screen's own Unlock is its button, and unlocking is what clears it), and a refusal that the vault it was about has
 * locked before (Ask 16, "Locked before it could say"; words, no button).
 */
export function LockScreenAsks() {
  const { restoreFinished } = useNotices();
  const note = useLockNote();
  return (
    <div className="asks">
      {note === null ? null : <Notice text={messageText(messageFor(note))} actions={[]} />}
      {restoreFinished ? (
        <Notice
          text="Lockbox finished restoring a vault. Unlock with the password from when that backup was made."
          actions={[]}
        />
      ) : null}
      <OpenFilesAsk />
      <LostOutputsAsk />
      <ShortcutAsk />
    </div>
  );
}
