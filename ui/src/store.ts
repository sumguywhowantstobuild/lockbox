// What the page keeps of each unlocked vault: its item list, the item open in the panel, values the person asked to
// see, text typed into a form, the message about the last copy, and a recovery key being shown or picked back (with the
// questions asked of it), and what its unlock found that is still to be answered (the app's questions, `SessionAsks`).
// Beside the sessions, only what launch told, a refusal for the lock screen, and the one search (what is typed and what
// each vault found, which a lock takes away vault by vault). Nothing else. A lock wipes the lot at once: the
// store listens for `lockbox://locked` before any command is sent, and a lock event drops the vault's whole record
// (`dropSession`). An answer that comes back for a vault that has locked since is dropped without a word (it is the
// expected outcome of a lock, not an error): the bridge refuses it with `StaleAnswer`, and so does this file when the
// session it was for is gone.
import { useSyncExternalStore } from "react";
import * as api from "./api";
import { batchHasFocus, focusList, takeJobFocus } from "./focus";
import { resetCloseAskForTests, startCloseAsk } from "./closeAsk";
import { awayMessage, partialWords, refusalWords, wasClean } from "./addFilesWords";
import { spokenEnd } from "./saveAllWords";
import { announceJob, cancelRequest, currentLockEpoch, jobOfRequest, nextRequest, releaseRequest, resetJobsForTests, startJobs } from "./jobs";
import { leftOutWords } from "./format";
import { backupNotFinishedMore, BACKUP_NOT_FINISHED } from "./messages";
import { listedName } from "./vaultWords";
import type { CopyableField, CopyTarget, FileView, ItemDetail, ItemSummary, LockEpochEvent, SearchHit, VaultEntry } from "./api";
import type { Ask } from "./screens/setup/keyWords";

/** A stored file the shell refused to open or save as damaged, for the item panel to say beside that file. */
export interface FileError {
  fileId: string;
  error: unknown;
}

/** The item open in the panel: its summary row's id, and what the shell said of it once it has. */
export interface OpenItem {
  id: string;
  detail: ItemDetail | null;
  /** The shell's refusal, when it would not give the item. */
  error: unknown;
  /** A stored file of this item that did not decrypt when it was opened or saved (10d); gone when the panel is opened again. */
  fileError?: FileError | null;
  /** It was just saved from the new-login form: the panel takes focus when it opens, as the form's next step. */
  saved: boolean;
  /** It comes back from its Edit form (saved or cancelled): focus goes to Edit, the button that opened the form. */
  focusEdit: boolean;
}

/**
 * A form or tool open in the side panel instead of an item's details. What is typed into it is that form's own state, not
 * kept here: a lock takes the session's record, this with it, and the form goes with nothing saved and nothing said.
 */
export type Tool =
  /** The new-login form (6b), its title started with `title` (the search text it was opened from, or empty). */
  | { kind: "new_login"; title: string }
  /** The new-key form (7a). */
  | { kind: "new_key" }
  /** The new-note form (7b). */
  | { kind: "new_note" }
  /**
   * Paste a .env (15a to 15c). What is pasted never comes here: the panel sends it to Rust at once, and keeps only the rows' names
   * and the token the values wait under, in its own state. `opening` numbers each time it is opened, so opening it again (from another
   * folder's menu, say) is a new panel with nothing of the old one's rows or folder in it. `rows` and `folder` are for a panel opened
   * on a copy that was read in Rust already (`captureAsEnv`): the answer's names and token, and the folder the save box had chosen.
   */
  | { kind: "paste_env"; opening: number; rows?: api.EnvRows; folder?: string }
  /**
   * The Edit form of an item (11a, and 7a, 7b and 10f for the other kinds), from the summary and the details the panel had
   * when Edit was pressed. What the form asks of Rust (the password, a key's value) and what is typed live in the form.
   */
  | { kind: "edit"; summary: ItemSummary; detail: ItemDetail }
  /**
   * Add files (9a to 9e) and Attach files: the panel for one batch. What it shows is the session's `addFiles` (the picked list, the bar, the
   * end), and the panel is only where it is on screen: leaving it while the batch works leaves the batch and its bar going.
   */
  | { kind: "add_files" }
  /**
   * Save all of a folder's files (the bar, then the end): the panel for one save. What it shows is the session's `saveAll` (the plan, the bar, the
   * summary), and the panel is only where it is on screen: leaving it while the save works leaves the save and its bar going.
   */
  | { kind: "save_all" }
  /** The Generator page (16a). */
  | { kind: "generator" }
  /** Settings (31a, 31b): the app's, for every vault, so a read-only vault opens it too. What it shows is `StoreState.settings`. */
  | { kind: "settings" }
  /** Back up this vault (22a to 22d). Where it is, is `SessionData.backup`, which outlives the panel while the backup runs. */
  | { kind: "backup" }
  /** Test a backup (23a to 23d), on the vault whose Settings or 22c opened it. Where it is, is `SessionData.test`, which goes with the panel. */
  | { kind: "test_backup" }
  /** Open a backup (25a), begun from this window: where it is, is `StoreState.openBackup` (its `host` is this session), which goes with the panel. */
  | { kind: "open_backup" }
  /** Older copies (24f), from Settings: the copies a restore kept of this vault, opened read-only or deleted. What it lists is `StoreState.olderCopies`. */
  | { kind: "older_copies" }
  /** Change password (27a, 27b), for this vault, from Settings, Ask 9 or Ask 2. Where it is, is `SessionData.passwordChange`; what is typed is the form's own state. */
  | { kind: "change_password" }
  /** A new recovery key (29a), for this vault, from Settings or Ask 2. Where it is, is `SessionData.newKey`; what is typed is the form's own state. */
  | { kind: "new_recovery_key" };

/**
 * Where a new recovery key the person asked for is (29a, and 29c after it), or `null` when none is begun. Like `PasswordChange` it lives in the session's
 * record, so it belongs to its vault: a switch leaves it as it is, a lock takes it, and an answer that comes for one vault lands in that vault's record. The
 * key itself is never here: once it is made it is the session's `recovery` step (29b), and what is typed is the form's own state, wiped as it is sent.
 */
export type NewKeyFlow =
  /** The form. `sending`: a key is asked for and has no answer yet, so a second press does nothing. `problem`: what the last try was refused with, and which field says it. */
  | { phase: "ask"; sending: boolean; problem: PasswordProblem | null }
  /** The key was picked back and the shell heard it: 29c, the offer of a fresh backup. */
  | { phase: "done" };

/**
 * Where a change of this vault's password is (27a to 27c), or `null` when none is begun. It lives in the session's record, so it belongs to its
 * vault: a switch leaves it as it is, a lock takes it, and an answer that comes for one vault lands in that vault's record and shows when it is
 * on screen. No password is ever in it: what is typed is the form's own state, wiped as it is sent.
 */
export type PasswordChange =
  /** The form. `sending`: a change is out and has no answer yet, so a second press does nothing. `problem`: what the last try was refused with, and which field says it. */
  | { phase: "ask"; sending: boolean; problem: PasswordProblem | null }
  /** The change landed and the page heard: 27c, the offer of a fresh backup. */
  | { phase: "done" };

/** A refusal of a change of password, and the field of the form that says it (`form` for the form as a whole). */
export interface PasswordProblem {
  field: "current" | "new" | "form";
  error: unknown;
}

/**
 * Where a backup of this vault is (22a to 22d, and Ask 2), or `null` when none is begun. It lives in the session's record, so a lock takes it with
 * the rest; it stays when the panel is closed while the backup runs, so Back up opens on the running one and starts no second.
 */
export type BackupStep =
  /** 22a. Where it goes is picked in Windows' own dialog, after Back up. `error` is what the last try was refused with, before anything was written (22d's numbers among them). */
  | { phase: "ask"; error: unknown }
  /** Back up was pressed: the dialog is open, then the work runs. `request` names its job by `lockbox://job-started`, which is when the bar appears. */
  | { phase: "running"; request: number }
  /** 22c. */
  | { phase: "saved"; view: api.BackupView }
  /** The work began and did not finish: stopped, or failed. Nothing half-made was left. */
  | { phase: "failed"; error: unknown }
  /** Refused before anything was written, for a reason a backup made now might not open (Ask 2 and the three beside it): the question is on screen. */
  | { phase: "refused"; error: unknown };

/**
 * Where Test a backup is (23a to 23d), or `null` when it is not begun. The backup's path never comes here: the shell holds it under `choice`, and
 * the page holds the name and size it was told, to show. It is the panel's own, on the session that opened it: the panel closing, another panel
 * taking its place, or the vault locking ends it, and its end lets the choice go and stops a test that runs (`letGoOfTest`). The typed text is not
 * kept here: it is the box's own state, wiped after every send.
 */
export interface TestFlow {
  /** Counts the times Test a backup was begun: an answer meant for an earlier one is dropped. */
  opening: number;
  /**
   * `picking`: Windows' picker is open (Settings is still on screen); `ask`: 23a (and 23c, with `problem`); `testing`: the bar, from the moment
   * Test was pressed; `good`: 23b; `damaged`: 23d.
   */
  phase: "picking" | "ask" | "testing" | "good" | "damaged";
  /** The choice the shell holds the backup's path under, or `null` while none is picked (before the first pick, or once the shell let it go). */
  choice: string | null;
  fileName: string | null;
  size: number;
  /** Pick another is waiting for the shell. */
  busy: boolean;
  /** What the last try was refused with, to say under the box (a wrong password among them), or `null`. */
  problem: unknown;
  /** The number the test's command was sent with, while it runs: the shell names the job by `lockbox://job-started` with it. */
  request: number | null;
  /** What the test found, for 23b. */
  view: api.BackupSummaryView | null;
  /** The engine's refusal for a damaged backup, for 23d. */
  damage: unknown;
}

/**
 * Where Open a backup is (25a), or `null` when it is not begun. It is the app's, not a vault's: a backup needs no vault. It shows as a panel in the window of the
 * session that was on screen when it began (`host`, whose tool is then `open_backup`), or full-screen in the setup frame when begun from the lock screen (`host`
 * is `null`). The backup's path and what is typed are never here: the shell holds the path under `choice`, the page holds the name and size it was told, and the
 * typed text is the box's own state, wiped as it is sent and on every lock epoch. Whatever ends the flow (Cancel, another panel taking its window, its host locking, a
 * lock of every vault) lets the choice go and stops an open that runs (`letGoOfOpen`); a session opened ends it too.
 */
export interface OpenFlow {
  /** Counts the times Open a backup was begun: an answer meant for an earlier one is dropped. */
  opening: number;
  /** The session whose window holds the panel, or `null` for the lock screen's full-screen steps. */
  host: number | null;
  /** `picking`: Windows' picker is open (nothing is on screen yet); `ask`: 25a, and its refusals; `opening`: the bar, from the moment Open read-only was pressed. */
  phase: "picking" | "ask" | "opening";
  /** The choice the shell holds the backup's path under, or `null` while none is picked (before the first pick, or once the shell let it go). */
  choice: string | null;
  fileName: string | null;
  size: number;
  /** Pick another is waiting for the shell. */
  busy: boolean;
  /** What the last try was refused with, to say under the box (a wrong password among them) or the row, or `null`. */
  problem: unknown;
  /** The number the open's command was sent with, while it runs: the shell names the job by `lockbox://job-started` with it. */
  request: number | null;
}

/** Where a restore was begun from, when that decides what Cancel goes back to: the first screen's "A backup file" (26a). Every other caller has none. */
export type RestoreOrigin = "first_screen";

/** What `startRestore` is told: the listed vault it is for (Ask 4, Ask 8), and where it was begun from (26a). */
export type RestoreStart = { vault?: number; origin?: RestoreOrigin };

/**
 * Where Forgot password is (28a to 28e), or `null` when it is not begun. It is the app's, not a vault's, like the restore: it belongs to the listed vault it
 * was opened for (`vault`, its registry ID) and is shown full-screen above the lock screen, and above the vault it opens, so 28e still shows once the session
 * is there. The typed key and the typed passwords are never here: they are the screen's own state, wiped as they are sent. The shell holds the checked key
 * under `choice`; the page holds only that token.
 */
export interface ForgotFlow {
  /** Counts the times the flow was begun: an answer meant for an earlier one is dropped (and the choice it brought is let go). */
  opening: number;
  /** Moves on at every step: an answer meant for an earlier step of this flow is dropped. */
  run: number;
  /** The listed vault it is for. */
  vault: number;
  /** The identity of the list the vault was read from, with `vault` the row the key check names (Task 9). */
  list: number;
  /**
   * `key`: 28a, and 28b when `problem` says what was wrong with the key; `no_key`: 28c; `changed`: the question about details changed outside Lockbox, over 28a,
   * asked before the new password; `password`: 28d; `done`: 28e, with the vault open under it.
   */
  phase: "key" | "no_key" | "changed" | "password" | "done";
  /** The key is out to be checked: its box can't be typed in meanwhile. */
  checking: boolean;
  /** The new password is out: its boxes can't be typed in, and the flow can't be left, meanwhile. */
  sending: boolean;
  /** What 28b says under the key's box: the shell's refusal, or the page's own of the same shape. `null` for none. */
  problem: unknown;
  /** What 28d says about the new password when the shell refused it and kept the key's choice (too short, or the changed details not accepted). */
  passwordProblem: { field: "new" | "form"; error: unknown } | null;
  /** The shell's choice for the checked key, while one is held. */
  choice: string | null;
  /** The vault's name from the details the key opened, once checked. */
  name: string | null;
  /** The person said yes to details changed outside Lockbox: it goes with the new password. */
  accepted: boolean;
  /** The session the new password opened, once it has: 28e's Back up now is for it. */
  session: number | null;
}

/**
 * The unlock step of one listed vault, shown while another vault is open (Task 6). It is the app's, not a vault's, and it holds no password: what is typed is the
 * step's own state, wiped as it is sent, by Back and on every lock epoch. `vault` is the registry ID it was opened for, so the answer lands on that vault and no other.
 * `opening` counts the steps begun: a vault that a step opened after it was left (Back while the answer was out) is held behind the window on screen and never takes
 * its place. `stay`: the step was opened from Copy to a vault, so the window it came from is the one on screen again once the vault is open, with the vault behind it.
 */
export interface UnlockStep {
  opening: number;
  vault: number;
  /** The identity of the list the vault was read from when the step was opened: the unlock names the row as `{ list, id: vault }`. */
  list: number;
  stay: boolean;
}

/**
 * The form of a new vault begun from the vault menu (Task 7), shown while other vaults are open: setup's step 1 of 2 with Back. It is the app's, not a vault's, and holds
 * no password: what is typed is the form's own state, wiped as it is sent, by Back and on every lock epoch. `opening` counts the forms begun, so a form opened again starts
 * empty. The new vault's key and questions are the new session's own `recovery` step, as at first setup.
 */
export interface NewVault {
  opening: number;
}

/**
 * Add existing vault folder begun from the vault menu (Task 7) or from the lock screen (Task 9, `from` "lock"): `picking` while Windows' folder picker is open (nothing is on
 * screen for it), `cloud` once the shell asked about a cloud-synced folder first (the first screens' question, with the token the yes goes on with). It is the app's, and a
 * lock epoch takes it.
 */
export type AddFolder = { opening: number; from: "window" | "lock"; phase: "picking" } | { opening: number; from: "window" | "lock"; phase: "cloud"; token: string };

/**
 * Moving to a new computer (26a to 26c), the app's own like the restore: `what` is 26a ("What do you have?"), `here` is 26c, a vault has come in (`how`: its
 * backup was restored, or its folder was added). The vault list stops being empty after the first vault comes in, so these steps are held here and not in the
 * first screen's own state, or the app would switch to the lock screen under 26c.
 */
export type MoveIn = { step: "what" } | { step: "here"; how: "restore" | "folder"; name: string; vault: number };

/**
 * Where Restore a backup is (24a to 24e), or `null` when it is not begun. It is the app's, not a vault's: it lives beside the sessions, so a lock of the
 * open vault (or the swap closing the vault it replaces) does not take its screens away. The backup's path and the credential typed for it are never
 * here: the shell holds the path, and the credential waits in the shell beside the pick once the backup is checked. The page holds the name and size it
 * was told and the choice, and the typed text is the box's own state, wiped as it is sent.
 */
export interface RestoreFlow {
  /** Counts the times a restore was begun: an answer meant for an earlier one is dropped. */
  opening: number;
  /** Moves on at every step: an answer meant for an earlier step of this restore is dropped. */
  run: number;
  /**
   * `picking`: Windows' picker is open (nothing is on screen yet); `pick`: 24a (and 24c's refusals' way back, with `problem`); `checking`: the backup is
   * being opened with what was typed; `where`: 24b; `cloud` and `name`: the questions the copy asked first, over 24b; `copying`: 24c's bar; `replace`: 24d;
   * `swapping`: 24c's last words, with no bar; `refused`: a refusal on a screen of its own; `older`: the refusal for too many older copies' way to delete
   * some (24f, with Delete only), the finished copy still waiting; `done`: 24e.
   */
  phase: "picking" | "pick" | "checking" | "where" | "cloud" | "name" | "copying" | "replace" | "swapping" | "refused" | "older" | "done";
  /** The listed vault this restore was started for (Ask 4's open vault, Ask 8's damaged one), or `null`: every pick goes with it, so the backup unpacks in that vault's folder. */
  vault: number | null;
  /** While the folder is the one that vault gave it (the person has not chosen another): whose, for 24b's words; `null` otherwise. */
  beside: "damaged" | "open" | null;
  /** The choice the shell holds the backup's path under, or `null` while none is picked (before the first pick, or once the shell let it go). */
  choice: string | null;
  fileName: string | null;
  size: number;
  /** The picker is open for Pick another or Choose another. */
  busy: boolean;
  /** Where the restore was begun from, or `null` for Settings and the lock screen. */
  origin: RestoreOrigin | null;
  /** What the last step was refused with, said under the box (a wrong password), under the file, or on the refusal's own screen; or `null`. */
  problem: unknown;
  /** What the checked backup is and where it would go (24b, and the date 24e names). `null` before the check. */
  checked: api.RestoreChecked | null;
  /** The number the check's, the copy's or the swap's command was sent with, while it runs: the shell names the job by `lockbox://job-started` with it. */
  request: number | null;
  /** The token a question waits under (`cloud`, `name`), and the name suggested for a new folder (`name`). */
  token: string | null;
  suggested: string;
  /** The finished copy, waiting for its swap (24d), until the swap is done. */
  prepared: api.RestorePreparedView | null;
  /** The swap's answer: the vault to unlock (24e). */
  restored: api.RestoredView | null;
  /** On `refused`: whether OK goes back to 24b with the pick kept (`again`), or the finished copy can only be let go (`discard`). */
  refusedAs: "again" | "discard";
  /** During the copy: a lock that is not an idle one came, so the shell has ended whatever the copy was making. An answer that comes after it is not acted on. */
  lockEnded: boolean;
}

/** What the new-login form sends: the person's own text, as typed. The shell completes the website and checks the limits. */
export interface LoginDraft {
  title: string;
  username: string;
  website: string;
  password: string;
  /** The folder's id, or `null` for none. */
  folder: string | null;
}

/** What the new-key form sends: the name, and the value exactly as typed or pasted. The shell checks the name and the limits. */
export interface KeyDraft {
  name: string;
  value: string;
  /** The folder's id, or `null` for none. */
  folder: string | null;
}

/** What the new-note form sends: the title and the text as typed. */
export interface NoteDraft {
  title: string;
  text: string;
  /** The folder's id, or `null` for none. */
  folder: string | null;
}

/**
 * Where a vault is in its recovery key step (21c, 21d, 21f), or `null` when it is not in one. The key is held here, like
 * the rest of a session's data, so a lock of any kind drops it with the session: nothing of it outlives the unlock it
 * was made in. Whatever the lock cuts short, the shell's "not confirmed" mark makes the next unlock start again.
 */
export type RecoveryStep =
  /** A new key has been asked for (an unlock found the mark) and has not come yet. */
  | { phase: "making" }
  /** The shell would not make the key (it could not write its mark first); the person can ask again. */
  | { phase: "failed"; error: unknown }
  /**
   * The key on screen, to be saved. `unfinished` is the key of an earlier step that never finished (21f); `missed` is
   * that a wrong pick brought the person back here; `back` is that the questions did (a wrong pick or "Show the key again"),
   * so focus goes to the heading. `issue` is the number the shell gave the key: the page confirms it by that number, and acts
   * on a confirmation or on a newer key only when it belongs to the step's current one. `voluntary` is the key the person asked for
   * from inside the vault (29b): it has its own headings, its confirmation is followed by 29c's offer, and the key and the questions are
   * dropped when the person leaves the vault for another or a lock epoch comes, as well as on a lock.
   */
  | { phase: "show"; key: string; issue: number; unfinished: boolean; voluntary: boolean; missed: boolean; back?: boolean }
  /** The key hidden, and three words to pick, one question at a time: `at` (from 0) is the one now asked. */
  | { phase: "pick"; key: string; issue: number; unfinished: boolean; voluntary: boolean; asks: readonly Ask[]; at: number };

/** The banners an unlock can raise, each closed with its own button (Asks 4, 5, 9 and 10). */
export type Banner = "unreadable" | "leftover" | "spare" | "cloud" | "backup" | "details";

/**
 * What an unlock found that the person has not answered yet. It lives in the session's record, so a lock drops it with
 * the rest, and the next unlock is told again by the shell: the page keeps no memory that would hide a question.
 */
export interface SessionAsks {
  /** Ask 3 waits: the vault's details were changed outside Lockbox. */
  detailsChanged: boolean;
  /**
   * An older copy opened read-only whose details were changed outside Lockbox (the shell's `header_changed`). It is no question, since nothing in a read-only
   * copy can be accepted: a banner says it, and closes (`"details"`).
   */
  headerChanged: boolean;
  /** The vault's recovery key was never confirmed, and its new key (21f) follows Ask 3's yes, not before. */
  keyWaits: boolean;
  /** Ask 3's answer is on its way, so a second press does nothing. */
  answering: boolean;
  /** The shell's refusal of Ask 3's answer, to say in words; the question stays. */
  detailsError: unknown;
  /** How many items can't be read (Ask 4): the unlock's count, or the item list's if that is more. */
  unreadable: number;
  /** How many leftover files the cleanup moved aside (Ask 5). */
  leftover: number;
  /** Opened from the spare copy of the vault's details (Ask 9). */
  spareDetails: boolean;
  /** The cloud service syncing the vault's folder (Ask 10), or `null`. */
  cloud: api.CloudProvider | null;
  /** The whole days since the vault's last backup, when that is 30 or more (Ask 1), else `null`. Never for a read-only copy. */
  backupDue: number | null;
  /** The banners and questions the person has closed since this unlock (`"backup"` is the reminder's Later). */
  closed: Banner[];
}

const NO_ASKS: SessionAsks = {
  detailsChanged: false,
  headerChanged: false,
  keyWaits: false,
  answering: false,
  detailsError: null,
  unreadable: 0,
  leftover: 0,
  spareDetails: false,
  cloud: null,
  backupDue: null,
  closed: [],
};

/**
 * What a restore's notice says, as far as a screen needs it (Plan 4B Task 6): Ask 6 (`undone`, with the vault's name or `null`), the finished notice on the lock
 * screen (`finished`, with the vault to unlock or `null`), Ask 7 (`drive_missing`, with the folder as text), and the two states with no drawn screen. The journal's
 * own paths are never kept: the page shows a folder as text and takes no path back.
 */
export type RestoreAsk =
  | { ask: "undone"; name: string | null }
  | { ask: "finished"; vault: { id: number; name: string } | null }
  | { ask: "drive_missing"; folder: string | null }
  | { ask: "pending" }
  | { ask: "unclear" };

/** What launch, or a running app, told that is still to be answered; not tied to a vault. */
export interface Notices {
  /** The record of opened files is damaged (Ask 11) until the person sets it aside. */
  lostOutputs: boolean;
  /** What a restore that didn't finish left (launch's notice, or what a refused restore or a Try again found), or `null`: the screens for it are `RestoreNotices` and the lock screen's. */
  restore: RestoreAsk | null;
  /**
   * The window was closed for the first time: every vault is locked, the window stayed, and 5b says why Lockbox is still
   * running. It is only ever heard as an event (never at launch), and it goes with the shell's `explain: false`.
   */
  firstClose: boolean;
  /**
   * The save shortcut is off: `taken` (another app holds it) or `not_set` (it could not be turned on for another reason). Both stay until the
   * person closes the message, and are told again only when Lockbox starts again.
   */
  shortcut: "taken" | "not_set" | null;
  /** How many opened copies of stored files another program still holds after a cleanup (10e): the count of the last `open_cleanup`, 0 for none. */
  openFiles: number;
}

/** The vault chosen in the save box: an open, writable session, or a listed vault that is locked (its unlock step shows in the box). */
export type SaveChoice = { kind: "open"; session: number } | { kind: "locked"; vault: number; list: number };

/** One entry of the box's Vault list. `value` is `s:<session>` or `v:<registry id>`. */
export interface SaveOption {
  value: string;
  label: string;
  /** The vault's name alone, as the box's lines say it (the label adds its place on the list when two names are alike). */
  name: string;
  choice: SaveChoice;
}

/**
 * The copy the save shortcut left waiting in the shell, as far as the page knows it: never its value. It is not a vault's: it can wait while
 * every vault is locked (the lock screen asks for an unlock first, 8b), and goes when the person saves or cancels, a lock of the vault chosen
 * in the box (the shell lets it go and says so), Lock all, idle, or the paste panel takes it over. A lock of the vault on screen, when another
 * is chosen, leaves it.
 */
export interface CaptureView {
  /** The copy's id: 32 lowercase hex characters, new for every press. A command about an older id is refused `not_found`. */
  id: string;
  /** What the clipboard held: a value, no text, or too much. The save box differs for the last two (8c). */
  state: "value" | "empty" | "too_large";
  /** How many keys the copy reads as, when it is a `.env` of one or more keys and no line that can't be read; otherwise `null`. */
  envKeys: number | null;
  /** A later press found a different value while this was waiting: the box says so and keeps what was typed. */
  changed: boolean;
  /** The session the shell holds the copy for (`capture_choose` was asked), or `null` (none yet, or a locked vault is chosen). */
  chosen: number | null;
  /** Counts the boxes: new when a copy comes with none waiting, the same for a copy that replaces a waiting one. The box is keyed by it. */
  opening: number;
  /** The vault chosen in the box; `null` until a window is on screen to start from (8b). Carried to a copy that replaces this one. Only the person's own pick changes it. */
  choice: SaveChoice | null;
  /** The chosen vault's name, kept with the choice: the box's lines say it even when the vault has left the list. */
  choiceName: string | null;
}

/** One unlocked vault. */
export interface SessionData {
  session: number;
  generation: number;
  /** The vault's place on the registry's list. A session that is no listed vault's (an older copy, a backup) has `NOT_ON_THE_LIST`. */
  vaultId: number;
  /**
   * The identity of the registry list `vaultId` belongs to (`VaultEntry.list`): a registry ID is only a vault within its own list, and a replaced list may give an ID to another
   * vault. `0` for a session that is on no list.
   */
  vaultList: number;
  /** A backup's is the backup file's name without its ending; an older copy keeps its vault's name (the header says "older copy" beside it). */
  name: string;
  readOnly: boolean;
  /** What the session is: a vault, an older copy a restore kept, or a backup, which are the two read-only kinds. */
  kind: api.SessionKind;
  /** The order the sessions were unlocked or opened in (a later one has a larger number): the window shows the last of `sessions`, which a switch moves, so this stays. */
  opened: number;
  /** `null` until the list has come. */
  items: ItemSummary[] | null;
  /** The shell's refusal, when it would not give the list. */
  loadError: unknown;
  openItem: OpenItem | null;
  /** The form or tool open in the panel (it and an open item are never both), or `null`. */
  tool: Tool | null;
  /** The folder shown, or `null` for All items. */
  folder: string | null;
  /** The Trash view is on screen instead of the list (then `folder` is `null`, and a picked row's panel is the Trash panel). */
  trash: boolean;
  /**
   * Values the person asked to see (a key's value or a login's password on Reveal), by item. Only the item open in the panel
   * can have one: Hide, opening an item (the same one again too), a form or another folder, or closing the panel, takes it
   * away, and a lock takes the whole record.
   */
  reveals: Record<string, string>;
  /**
   * The reveal token: a Reveal request keeps the number it was asked under, and every one of those events moves it on
   * (`endReveals`), so an answer that comes after is known to be late and is dropped.
   */
  revealEpoch: number;
  /** Text typed and not saved, by name. */
  forms: Record<string, string>;
  /** The recovery key step this vault is in, or `null`. */
  recovery: RecoveryStep | null;
  /** What the unlock found, still to be answered. */
  asks: SessionAsks;
  /**
   * The stored-file action this page began and has no answer to yet (Open, Save a copy, Replace, Attach, or Add), for the buttons to say
   * they are working and the others to wait: one at a time. A lock takes it with the record.
   */
  fileJob: FileJob | null;
  /** The backup of this vault that is begun and not put away: see {@link BackupStep}. */
  backup: BackupStep | null;
  /** Test a backup, begun from this vault's Settings or 22c and not put away: see {@link TestFlow}. */
  test: TestFlow | null;
  /**
   * The batch of files being picked, added or just ended (Task 10), or `null`: the Add files panel shows it. An end that left something out
   * (a file not read, a stop) is kept here after the person has gone from the panel, for a card in the list's column to name what was never
   * stored. A lock takes it with the record.
   */
  addFiles: AddFilesFlow | null;
  /**
   * The save of a folder's files being asked (the cloud question), run or just ended (Task 11), or `null`: the Save all panel shows it. The end is
   * kept here after the person has gone from the panel, for a card in the list's column, since the copies are not encrypted and the summary holds
   * the handle that Show in Explorer uses. A lock takes it with the record.
   */
  saveAll: SaveAllFlow | null;
  /** The long operations the shell says are running for this vault (`lockbox://busy`): while there are any, auto-lock waits and the window says so. */
  operations: string[];
  /** Change password, begun from Settings, Ask 9 or Ask 2 and not put away: see {@link PasswordChange}. */
  passwordChange: PasswordChange | null;
  /** A new recovery key, begun from Settings or Ask 2 and not put away: see {@link NewKeyFlow}. The key it makes is `recovery`. */
  newKey: NewKeyFlow | null;
}

/** One batch of files, from the pick to its end. The paths stay in Rust: the page holds names and sizes for display, and the choice (a token). */
export interface AddFilesFlow {
  /** Counts the times the panel was opened: a new pick is a new panel. */
  opening: number;
  /** Where the batch goes: a folder (the one chosen in the panel when it is added) or the item the files are attached to. */
  into: api.AddInto;
  /** The choice the shell holds the picked paths under, or `null` once the shell let it go (the person picks again). */
  choice: string | null;
  /** The files picked so far, in the order they will go in. */
  files: api.PickedFile[];
  /** `pick`: 9a (and 9e); `adding`: 9b; `done`: 9c. */
  phase: "pick" | "adding" | "done";
  /** A Pick more or a removal is waiting for the shell. */
  busy: boolean;
  /** The shell's refusal to say in the panel (no room, a file too big, an expired choice), or `null`. */
  problem: unknown;
  /** How the batch ended, once it has. */
  result: api.AddFilesView | null;
  /** The panel's result takes focus: focus was in this batch's own panel or bar when it ended. Otherwise focus stays where the person put it. */
  focusResult: boolean;
}

/** One save of a folder's files, from the cloud question to its end. The paths stay in Rust: the page holds names, sizes and tokens. */
export interface SaveAllFlow {
  /** Counts the times a save was begun: a new one is a new panel. */
  opening: number;
  /** The folder being saved: its id, and its name as the menu showed it. */
  folder: { id: string; name: string };
  /** `cloud`: the question waits for yes or no; `saving`: the bar; `done`: the summary. */
  phase: "cloud" | "saving" | "done";
  /** The token the cloud question's yes goes on with (`cloud`), else `null`. */
  token: string | null;
  /** What the shell planned once the picker answered (`saving`, `done`): where it goes and each file in order, for "3 of 4". */
  plan: api.SavePlan | null;
  /** How it ended, once it has. */
  result: api.SaveAllView | null;
  /** The panel's result takes focus: focus was in this save's own panel or bar when it ended. Otherwise focus stays where the person put it. */
  focusResult: boolean;
}

/** What a stored-file action is doing: its kind, and the item and file it is about (`null` where there is none: Add has neither, Attach has no file). */
export interface FileJob {
  /** `add` and `attach` are the picker being open for a new batch; `add_files` is the batch itself; `save_all` is a folder's files being saved (the picker, then the job). */
  kind: "open" | "save" | "replace" | "attach" | "add" | "add_files" | "save_all";
  id: string | null;
  fileId: string | null;
  /**
   * The number this job's command was sent with. The shell names the job's operation by `lockbox://job-started` with this number, so the
   * screen reads its progress with `useJob(request)`. Open and Replace send none and never get a job, so theirs matches nothing.
   */
  request: number;
}

/** A stored-file action as its caller names it: `runFile` gives it its request. */
type FileJobStart = Omit<FileJob, "request">;

/** The message about the last copy (or the refusal of one), save, move or restore, and the vault that made it. */
export type Toast =
  | { kind: "copied"; session: number; text: string; seconds: number; endsAt: number }
  | { kind: "saved"; session: number }
  /** A short message of its own words ("Moved to Lineproof", "Restored"): it says it once and goes after a few seconds. */
  | { kind: "said"; session: number; text: string }
  /**
   * "Moved to Trash" with Undo: `id` is the item or folder that went (held here, never found again from a title), for Undo to
   * bring back. It stays about ten seconds, and waits while the pointer or focus is on it.
   */
  | { kind: "trashed"; session: number; id: string }
  /**
   * A sentence of the page's own that the person has to read and act on (a name found twice, a file saved without encryption): it
   * stays until it is dismissed or another message takes its place, since four seconds is too short to read it.
   */
  | { kind: "told"; session: number; text: string }
  /**
   * A sentence the person is told once and puts away with "Got it" (a file opened as a read-only copy, a saved copy that is not encrypted,
   * a file added with its original still on the PC): it stays until then or until another message takes its place. It holds no file name.
   */
  | { kind: "noted"; session: number; text: string }
  | { kind: "failed"; session: number | null; error: unknown };

/** What one vault answered to the search: its results, tagged with the generation they were read in. */
export interface SearchHits {
  session: number;
  generation: number;
  items: SearchHit[];
}

/**
 * The one search (Ctrl+F, Ctrl+K), while it is open: what is typed (it is not a secret, but it never goes in a URL or a
 * log), what each unlocked vault found, the vaults that were busy, and the refusal of the last copy or open from it. It
 * is across vaults, so it lives here rather than in a session's record; a lock takes that vault's part away at once
 * (`dropSession`), and the last lock closes it.
 */
export interface SearchState {
  query: string;
  /** The word the shell last answered for, or `null` before any answer (and for a blank one): "Nothing for ..." says it. */
  answered: string | null;
  hits: SearchHits[];
  /** The sessions that were busy with a long change when asked: their results are missing. */
  busy: number[];
  /** The shell's refusal of the last search, copy or open from the search, to say in words. */
  error: unknown;
  /**
   * A question the shell asked about a file result, on screen over the search: Open on a program file (`program`), or Save a copy to a
   * cloud-synced folder (`cloud`, with the token the yes goes on with).
   */
  asking: { kind: "program"; session: number; id: string; file: FileView } | { kind: "cloud"; session: number; id: string; file: FileView; token: string } | null;
}

export interface StoreState {
  /** `null` until the vault list has come. */
  vaults: VaultEntry[] | null;
  /** The shell's refusal, when the vault list could not be read. */
  startError: unknown;
  /** The unlocked vaults, in the order they were unlocked (the last is the one on screen). */
  sessions: SessionData[];
  toast: Toast | null;
  notices: Notices;
  /**
   * What to say on the lock screen about a vault that locked after its change landed (Ask 16), each for one vault by its registry ID: it shows when that
   * vault is the one chosen to unlock, and only that vault's unlock uses it up. A refusal as the shell sent it, or the page's own of the same shape.
   */
  lockNotes: { vault: number; refusal: unknown }[];
  /** The search, or `null` while it is closed. */
  search: SearchState | null;
  /** The copy the shortcut left waiting, or `null` for none. */
  capture: CaptureView | null;
  /** Restore a backup, or `null` while none is begun. It is the app's own: no vault's lock takes it away. */
  restore: RestoreFlow | null;
  /** Open a backup, or `null` while none is begun. It is the app's own, shown in one window's panel or full-screen from the lock screen: see {@link OpenFlow}. */
  openBackup: OpenFlow | null;
  /** Forgot password (28a to 28e), or `null` while it is not open. It is the app's own, shown full-screen above the lock screen and the vault it opens: see {@link ForgotFlow}. */
  forgot: ForgotFlow | null;
  /** Moving to a new computer (26a to 26c), or `null` while it is not open. */
  moveIn: MoveIn | null;
  /** The vault the lock screen chooses when it next opens (26c's Unlock after a folder came in), or `null`; the lock screen takes it once. */
  unlockPick: number | null;
  /** The unlock step of one more vault, shown while another vault is open (the vault menu, the vault strip, Copy to a vault), or `null`: see {@link UnlockStep}. */
  unlockStep: UnlockStep | null;
  /** The form of a new vault begun from the vault menu, or `null`: see {@link NewVault}. */
  newVault: NewVault | null;
  /** Add existing vault folder begun from the vault menu or the lock screen, or `null`: see {@link AddFolder}. */
  addFolder: AddFolder | null;
  /** The shell's refusal of the lock screen's Add existing vault folder, said in its plate until the next add or unlock; `null` for none. Nothing in it is secret. */
  addRefusal: unknown;
  /**
   * The older copies the shell last listed, or `null` until a listing has come. The shell replaces every ID at each listing, so this is the page's one
   * listing: it is read again when Settings opens, when 24f opens and after each delete or open, and every button sends an ID from it as it is now.
   */
  olderCopies: api.PreRestoreEntry[] | null;
  /**
   * The app's settings as the shell has them saved: read once at the start and made current by each save (`saveSettings`). `null` until
   * they come, and when they could not be read; the screens then use `DEFAULT_SETTINGS`. Nothing secret is in them, so a lock leaves them.
   */
  settings: api.Settings | null;
}

/** What the settings are when the page has none yet: the shell's own defaults (`Settings::default`). */
export const DEFAULT_SETTINGS: api.Settings = {
  idle_minutes: 5,
  clipboard_seconds: 30,
  theme: "system",
  shortcut: { ctrl: true, shift: true, alt: false, key: 76 },
  capture_protected: true,
};

/** The page's own refusal for a lock listener that could not be set up; `messages.ts` has its words. */
const LISTENER_FAILED = { code: "page", kind: "lock_listener" };

function refusedWith(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === code;
}

/** Whether the shell refused as locked: the vault is locked and the page missed the event that said so. */
function refusedAsLocked(error: unknown): boolean {
  return refusedWith(error, "locked");
}

const EMPTY: StoreState = {
  vaults: null,
  startError: null,
  sessions: [],
  toast: null,
  notices: { lostOutputs: false, restore: null, firstClose: false, shortcut: null, openFiles: 0 },
  lockNotes: [],
  search: null,
  capture: null,
  restore: null,
  openBackup: null,
  forgot: null,
  moveIn: null,
  unlockPick: null,
  unlockStep: null,
  newVault: null,
  addFolder: null,
  addRefusal: null,
  olderCopies: null,
  settings: null,
};

let state: StoreState = EMPTY;
const listeners = new Set<() => void>();
let started: Promise<void> | undefined;
/** Which search is the latest asked (and 0 more each time the search closes): an older answer is dropped. */
let searchRun = 0;
/**
 * Which search's results are on screen: the run of the last answer shown (or of the blank word or opening that cleared them). Until a newer
 * word's answer comes, the results of the one before stay on screen, and an action pressed on one of them belongs to that one.
 */
let searchShown = 0;
/** Which opening of the search is on screen: it moves on each time the search opens or closes, so a file action that began in one is known not to belong to the next. */
let searchOpening = 0;

/** A session's record with every revealed value gone and the reveal token moved on, so no request still out can show one. */
function endReveals(entry: SessionData): SessionData {
  return { ...entry, reveals: {}, revealEpoch: entry.revealEpoch + 1 };
}

function set(next: StoreState): void {
  state = next;
  for (const notify of listeners) notify();
}

function subscribe(notify: () => void): () => void {
  listeners.add(notify);
  return () => listeners.delete(notify);
}

function useSelect<T>(select: (current: StoreState) => T): T {
  return useSyncExternalStore(subscribe, () => select(state));
}

function sessionOf(session: number): SessionData | undefined {
  return state.sessions.find((entry) => entry.session === session);
}

/**
 * Changes one session's record, when it is still there. Test a backup is the panel's own, so it ends wherever its panel does: whatever takes the
 * panel (another tool, an item, the Trash, a folder) leaves no test behind, and a test that ends this way lets its backup go (`letGoOfTest`).
 */
function update(session: number, change: (entry: SessionData) => SessionData): void {
  const before = sessionOf(session);
  if (before === undefined) return;
  let next = change(before);
  if (next.test !== null && next.test.phase !== "picking" && next.tool?.kind !== "test_backup") next = { ...next, test: null };
  // Open a backup shown in this window's panel is the panel's own too: whatever takes the panel from it ends the flow.
  const flow = state.openBackup;
  const endsOpen = flow !== null && flow.host === session && flow.phase !== "picking" && next.tool?.kind !== "open_backup";
  // The save box is the app's, drawn over the window on screen: another panel taking that window's place (a tool, an item or the Trash) lets the copy go,
  // as it did when the box was a panel of the window's own.
  const takesThePlace =
    state.capture !== null &&
    state.sessions.at(-1)?.session === session &&
    ((next.tool !== null && next.tool !== before.tool) || (next.openItem !== null && next.openItem.id !== before.openItem?.id) || (next.trash && !before.trash));
  set({ ...state, sessions: state.sessions.map((entry) => (entry.session === session ? next : entry)), openBackup: endsOpen ? null : state.openBackup });
  if (before.test !== null && next.test?.opening !== before.test.opening) letGoOfTest(before.test);
  if (endsOpen) letGoOfOpen(flow);
  if (takesThePlace) endCapture(true);
}

/** Whether the session is still open in the generation the caller read it in. */
function stillOpen(session: number, generation: number): boolean {
  return sessionOf(session)?.generation === generation;
}

/**
 * A command asked in `generation` was refused as locked: the news of a lock the page may have missed, so the vault goes. Only
 * while the page still holds that generation: unlocking again keeps the session's number with the next generation, and a late
 * refusal of a command asked before must not drop the vault the person has now.
 */
function dropIfStillOpen(session: number, generation: number): void {
  if (stillOpen(session, generation)) dropSession(session);
}

/**
 * Begins listening for locks, and only then reads the vault list: a lock must never be missed because a command was in
 * flight first. Safe to call twice (React's strict mode does): the second call gets the first's answer.
 */
export function startStore(): Promise<void> {
  started ??= (async () => {
    try {
      await api.onLocked((event) => {
        dropSession(event.session);
        // The drive went while the vault was open: its row reads unavailable at once, not at the next read of the list.
        if (event.reason === "drive_gone") void refreshVaults();
      });
    } catch {
      // Without the lock listener the page could not hear a lock, so it asks the shell for nothing: no vault list, no
      // unlock. The screen says so in words (a fixed refusal of the page's own, never the listener's error).
      set({ ...state, startError: LISTENER_FAILED });
      return;
    }
    try {
      // The settings first, so the first screen is drawn in the saved theme. When they can't be read the page uses the defaults.
      const settings = await api.getSettings();
      set({ ...state, settings });
    } catch {
      // Nothing to say: the screens that read them fall back to `DEFAULT_SETTINGS`, and Settings reads them again when it opens.
    }
    try {
      set({ ...state, vaults: await api.listVaults(), startError: null });
    } catch (error) {
      set({ ...state, startError: error });
    }
  })();
  return started;
}

/** Forgets everything the page holds of the vault: the list, the open item, revealed values and typed text. */
export function dropSession(session: number): void {
  // A new recovery key that reached this vault while another was on screen was never shown: its unlock says so.
  sayOfUnseenKeys(state.sessions, session);
  // A test running for this vault is stopped and its backup let go: the vault's lock ends the panel the test lived in.
  const leaving = sessionOf(session)?.test ?? null;
  if (leaving !== null) letGoOfTest(leaving);
  // An Open a backup panel in this window goes with it: the choice is let go and an open that runs is stopped.
  const leavingOpen = state.openBackup;
  if (leavingOpen !== null && leavingOpen.host === session) {
    set({ ...state, openBackup: null });
    letGoOfOpen(leavingOpen);
  }
  const toast = state.toast;
  const keepToast = toast === null || toast.session !== session;
  const sessions = state.sessions.filter((entry) => entry.session !== session);
  const search = state.search;
  // The search goes with the last vault, and a vault's results with the vault: nothing said, no error.
  if (sessions.length === 0) {
    searchRun += 1;
    searchOpening += 1;
  }
  // 28e's offer is for the vault the new password opened: when that vault locks, the offer has nothing to back up and goes.
  const forgot = state.forgot?.phase === "done" && state.forgot.session === session ? null : state.forgot;
  set({
    ...state,
    sessions,
    forgot,
    // The unlock step is for a window with a vault in it to go back to: the last lock takes it, and the lock screen follows.
    unlockStep: sessions.length === 0 ? null : state.unlockStep,
    // So are the new vault's form and Add existing vault folder: both are begun from a window, and the last lock leaves none to go back to. An add begun from
    // the lock screen has no window to go back to in the first place, so a lock leaves it be (a lock epoch takes it, as it takes any step).
    newVault: sessions.length === 0 ? null : state.newVault,
    addFolder: sessions.length === 0 && state.addFolder?.from !== "lock" ? null : state.addFolder,
    toast: keepToast ? toast : null,
    search:
      search === null || sessions.length === 0
        ? null
        : {
            ...search,
            hits: search.hits.filter((found) => found.session !== session),
            busy: search.busy.filter((busy) => busy !== session),
            asking: search.asking?.session === session ? null : search.asking,
          },
  });
  // The copy that was handed to this vault, or that the box has chosen it for, goes with its lock (the shell lets it go too, and says so with `gone`): none of it
  // stays on screen. The lock of any other vault, the one on screen among them, leaves it.
  const held = state.capture;
  if (held !== null && (held.chosen === session || (held.choice?.kind === "open" && held.choice.session === session))) endCapture(true);
}

/**
 * Unlocks the vault and reads its list. `"opened"` when the list is on the page; `"stale"` when the vault locked again
 * before an answer was read, which is not an error. A refusal (a wrong password) is thrown for the lock screen to say.
 */
export async function unlock(vault: api.VaultRef, password: string, keepsChoice = false): Promise<"opened" | "stale"> {
  // The lock screen's add said its refusal until the next unlock: this is it.
  if (state.addRefusal !== null) set({ ...state, addRefusal: null });
  let answer;
  try {
    answer = await api.unlockVault(vault, password);
  } catch (error) {
    // A lock of every vault, or the window's close, that lands during the unlock is refused as locked: no session exists yet
    // for a lock event to clear, and it is no more an error to show than a stale answer (Review Focus 1).
    if (error instanceof api.StaleAnswer || refusedAsLocked(error)) return "stale";
    throw error;
  }
  // With a copy waiting (8b), this unlock is the one for the save: the vault that opens becomes the box's choice, whatever it had chosen before. Only once the
  // password was right: a refusal changes nothing. A restore's unlock (`keepsChoice`) is not the person choosing a vault for the copy, so the choice stays.
  if (!keepsChoice && state.capture !== null && state.capture.choice !== null) set({ ...state, capture: { ...state.capture, choice: null, choiceName: null } });
  return publishUnlock(answer, vault.id, "front", false, vault.list);
}

/**
 * What the page does with a vault that has just opened, whether a password opened it (`unlock`) or a recovery key did (`finishRecovery`): the session's
 * record is made, the asks are set from what the unlock found, what the lock screen was saying about this vault is let go, a new recovery key is begun when the
 * old one was never confirmed (21f), the backup reminder is read, a copy that waited is seated, and the list is read. `vaultId` is the registry ID the
 * flow was opened for. Gives `"opened"` when the list is on the page, `"stale"` when the vault locked again before it was read. The vault is the window on screen
 * (`place` "front"), or is held behind the one that is (`"behind"`: an unlock step that was left, or that came from Copy to a vault); `endsStep` takes the unlock step
 * away in the same change.
 */
function publishUnlock(
  answer: api.Tagged<api.UnlockView>,
  vaultId: number,
  place: "front" | "behind" = "front",
  endsStep = false,
  list?: number,
): Promise<"opened" | "stale"> {
  const { info } = answer.data;
  // The recovery key of this vault was made and never confirmed by picking: the page goes straight to a new one (21f), before it
  // shows anything of the vault. A read-only copy never does (the shell says false for it).
  const unfinished = answer.data.recovery_unconfirmed && !info.read_only;
  // But Ask 3 first: the engine refuses a new key while the changed details wait for a yes, so the key waits for it.
  const details = answer.data.header_mac_mismatch;
  const record = newRecord(answer, vaultId, info, unfinished && !details ? { phase: "making" } : null, {
    ...NO_ASKS,
    detailsChanged: details,
    keyWaits: unfinished && details,
    unreadable: answer.data.cleanup.skipped_damaged,
    leftover: answer.data.cleanup.orphans_quarantined,
    spareDetails: answer.data.used_backup_header,
    cloud: answer.data.cloud,
  }, list);
  // The vault is open: what the lock screen was still saying about it (a restore finished, a change saved before a lock) has been read. What it said
  // about another vault waits for that vault's own unlock.
  set({
    ...state,
    sessions: place === "front" ? withFront(state.sessions, record) : withBehind(state.sessions, record),
    unlockStep: endsStep ? null : state.unlockStep,
    notices: { ...state.notices, restore: state.notices.restore?.ask === "finished" ? null : state.notices.restore },
    lockNotes: state.lockNotes.filter((note) => note.vault !== vaultId),
  });
  if (unfinished && !details) void makeNewKey(record.session);
  // The 30-day reminder (Ask 1) is read beside the list, never ahead of it. A read-only copy has none to make.
  if (!info.read_only) void readBackupDue(record.session, record.generation);
  // A copy that waited on the lock screen (8b) opens its box in this vault, and is handed to it.
  seatCapture();
  return loadItems(record);
}

/** How many sessions the page has made a record for: each record's `opened`. */
let sessionsOpened = 0;

function newRecord(
  answer: { session: number; generation: number },
  vaultId: number,
  info: { name: string; read_only: boolean; kind: api.SessionKind },
  recovery: RecoveryStep | null,
  asks: SessionAsks = NO_ASKS,
  list?: number,
): SessionData {
  sessionsOpened += 1;
  // The list the vault was opened from: the one the caller sent its row of, else the list the page holds the vault on (a session on no list has `0`).
  const vaultList = list ?? (vaultId <= 0 ? 0 : (state.vaults?.find((entry) => entry.id === vaultId)?.list ?? state.vaults?.[0]?.list ?? 0));
  return {
    session: answer.session,
    generation: answer.generation,
    vaultId,
    vaultList,
    name: info.name,
    readOnly: info.read_only,
    kind: info.kind,
    opened: sessionsOpened,
    items: null,
    loadError: null,
    openItem: null,
    tool: null,
    folder: null,
    trash: false,
    reveals: {},
    revealEpoch: 0,
    forms: {},
    recovery,
    asks,
    fileJob: null,
    backup: null,
    test: null,
    addFiles: null,
    saveAll: null,
    operations: [],
    passwordChange: null,
    newKey: null,
  };
}

/** The page's own refusal for an answer it did not expect; `messages.ts` gives it the generic words. */
const UNEXPECTED = { code: "page", kind: "unexpected_answer" };

/** The vault list again, from the shell: after a vault was created or added. `null` when it could not be read. */
export async function refreshVaults(): Promise<VaultEntry[] | null> {
  try {
    const list = await api.listVaults();
    set({ ...state, vaults: list, startError: null });
    return list;
  } catch (error) {
    set({ ...state, startError: error });
    return null;
  }
}

/**
 * Whether the shell refused the vault list because the file is damaged (and only that: any other refusal is not this one). The
 * words of the refusal never decide anything here, only its fixed code, kind and label.
 */
export function isVaultListDamaged(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "core" &&
    (error as { kind?: unknown }).kind === "damaged" &&
    (error as { what?: unknown }).what === "vault list"
  );
}

/**
 * Sets the damaged vault list aside and starts a new one (Ask 12), then reads the list again: it comes back empty, so the first
 * screen opens, where each vault is added back. A refusal is thrown for the screen to say. Whatever the command came to, the list is
 * read again: a refusal can come after the damaged file was moved (the new list could not be written, so the list now reads as
 * empty), or because someone mended the list meanwhile. When the read is good the lost-list screen goes by itself; while the list
 * still can't be read the screen stays, with the refusal in words.
 */
export async function startNewVaultList(): Promise<void> {
  try {
    await api.startNewVaultList();
  } finally {
    // `refreshVaults` catches its own errors, so the command's refusal is still what the caller gets.
    await refreshVaults();
  }
}

/** What a create, or an add of an existing vault, came to. */
export type SetupResult =
  | "done"
  /** The vault locked, or the PC did, before the answer was read: nothing to say. */
  | "stale"
  /** The person closed the folder picker. */
  | "dismissed"
  /** A cloud-synced folder: nothing is done until the person says yes, with this token. `provider` is the service the shell found, for 18c to name. */
  | { confirm: string; provider: api.CloudProvider };

/** Pulls the token and the service out of a cloud-folder question, or refuses any other question (none is expected here). */
function cloudQuestion(question: api.Confirm): { confirm: string; provider: api.CloudProvider } {
  if (typeof question === "object" && "CloudFolder" in question) return { confirm: question.CloudFolder.token, provider: question.CloudFolder.provider };
  // eslint-disable-next-line @typescript-eslint/only-throw-error -- a refusal is a plain object, as the shell's are
  throw UNEXPECTED;
}

/**
 * Creates a vault and opens it on its recovery key. The vault is unlocked and marked "not confirmed" by the shell
 * before this answers; its key is on the page only here, in its session's record. If a lock overtook the answer, the
 * record is never made, and the vault list is read again so the lock screen offers the vault.
 */
export function createVault(name: string, password: string, chooseFolder: boolean): Promise<SetupResult> {
  return finishCreate(() => api.createVault(name, password, chooseFolder));
}

/** The person's yes to creating the vault in a cloud-synced folder. */
export function confirmCreateVault(token: string): Promise<SetupResult> {
  return finishCreate(() => api.createVaultConfirm(token));
}

async function finishCreate(run: () => Promise<api.Opened<api.CreatedView>>): Promise<SetupResult> {
  let answer;
  try {
    answer = await run();
  } catch (error) {
    // The vault may have been made all the same (a lock after it, or a list that wouldn't take it): read the list again.
    if (error instanceof api.StaleAnswer || refusedWith(error, "locked_after_change")) await refreshVaults();
    // A lock overtook a vault that was made and listed: its key was never seen, and the shell says which vault it is (its registry ID). The words are kept for that
    // vault's own unlock (the lock screen, or its unlock step in the vault menu), where 21f follows by the shell's mark.
    if (refusedWith(error, "locked_after_change")) {
      const named = (error as { vault?: unknown }).vault;
      if (typeof named === "number" && Number.isSafeInteger(named) && named > 0) sayOnLockScreen(landedBeforeLock(named, "vault created"), named);
    }
    if (error instanceof api.StaleAnswer) return "stale";
    // A lock that ended the create before anything was made (the picker was open when Windows locked): no vault exists
    // and the person did nothing wrong, so there is nothing to say.
    if (refusedAsLocked(error)) return "stale";
    throw error;
  }
  if (answer === "Dismissed") return "dismissed";
  if ("Confirm" in answer) return cloudQuestion(answer.Confirm);
  const { info, recovery_key, issue, vault_id } = answer.data;
  // The vault's place on the list is the registry ID the shell gave it, from the answer itself, never found by comparing lists: another vault may have been
  // listed at the same moment (an add in another window). An answer without a whole number above 0 leaves the record with the stand-in `-1`.
  const vaultId = Number.isSafeInteger(vault_id) && vault_id > 0 ? vault_id : -1;
  // The creation key keeps the number the shell gave it, to confirm it by.
  const record = newRecord(answer, vaultId, info, {
    phase: "show",
    key: recovery_key,
    issue,
    unfinished: false,
    voluntary: false,
    missed: false,
  });
  // The window of the new vault takes the place of the form that made it (when one was up), with the vaults that were open still open behind it.
  set({ ...state, sessions: withFront(state.sessions, record), newVault: null });
  void loadItems(record);
  const list = await refreshVaults();
  // Now the list says which list the new vault is on.
  const listed = state.vaults?.find((entry) => entry.id === vaultId);
  if (listed !== undefined) update(record.session, (current) => ({ ...current, vaultList: listed.list }));
  // The list could not be read again (the old one is kept): the vault that was made is put on it all the same, so the menu and the lock screen have it.
  if (list === null && vaultId > 0 && !(state.vaults ?? []).some((vault) => vault.id === vaultId)) {
    // Its list is the one the other entries came from; with none held there is no identity to give it, and `0` is one no list has (a send for it is `not_found`, never another vault).
    const list = state.vaults?.[0]?.list ?? 0;
    set({ ...state, vaults: [...(state.vaults ?? []), { list, id: vaultId, name: info.name, available: true, details_damaged: false }] });
  }
  return "done";
}

/** Adds a vault folder the person picks (26a's "A vault folder"); once it is in, 26c says so. */
export async function addExistingVault(): Promise<SetupResult> {
  return finishAdd(() => api.addExistingVault());
}

export function confirmAddExistingVault(token: string): Promise<SetupResult> {
  return finishAdd(() => api.addExistingVaultConfirm(token));
}

async function finishAdd(run: () => Promise<api.Outcome<VaultEntry>>): Promise<SetupResult> {
  const answer = await run();
  if (answer === "Dismissed") return "dismissed";
  if ("Confirm" in answer) return cloudQuestion(answer.Confirm);
  const list = await refreshVaults();
  // 26c: the vault's own name, from the entry the shell answered with.
  const { id, name } = answer.Done;
  // The list could not be read again (the old one is kept): the vault that was added is put on it all the same, so Unlock has it to choose.
  if (list === null && !(state.vaults ?? []).some((vault) => vault.id === id)) set({ ...state, vaults: [...(state.vaults ?? []), answer.Done] });
  if (state.moveIn?.step === "what") set({ ...state, moveIn: { step: "here", how: "folder", name: name ?? "Your vault", vault: id } });
  return "done";
}

/** The number of the key a step holds, or `null` while it holds none (making one, or the shell would not). */
function issueOf(step: RecoveryStep | null): number | null {
  return step?.phase === "show" || step?.phase === "pick" ? step.issue : null;
}

/**
 * Whether the shell refused a new key for want of 21f's permission (`invalid_input`, what `"recovery key"`): this session never
 * entered 21f the way that grants a key without the password, so no number of tries would make one.
 */
function refusedForWantOfPermission(error: unknown): boolean {
  return refusedWith(error, "invalid_input") && (error as { what?: unknown }).what === "recovery key";
}

/**
 * Asks the shell for a new recovery key for the unlocked vault and puts it on screen, shown once more (21f). No password
 * is asked. A refusal (the shell could not write its mark first, and so made no key) is kept for the screen to say,
 * with a way to ask again; a refusal for want of the session's permission ends the step (nothing to try again); a vault
 * that locked meanwhile gets nothing. A key whose number is not newer than the one the step holds (its reply came after a
 * newer key's) is not the step's: the page acts only on the current one.
 */
export async function makeNewKey(session: number): Promise<void> {
  const entry = sessionOf(session);
  if (entry === undefined || entry.readOnly) return;
  const { generation } = entry;
  update(session, (current) => ({ ...current, recovery: { phase: "making" } }));
  try {
    const answer = await api.regenerateRecovery({ session, generation });
    if (!stillOpen(session, generation)) return;
    const { words, issue } = answer.data;
    update(session, (current) => {
      if ((issueOf(current.recovery) ?? 0) >= issue) return current;
      return { ...current, recovery: { phase: "show", key: words, issue, unfinished: true, voluntary: false, missed: false } };
    });
  } catch (error) {
    if (refusedAsLocked(error)) dropIfStillOpen(session, generation);
    if (error instanceof api.StaleAnswer || !stillOpen(session, generation)) return;
    // Only this call's own step ("making") is ended or failed: a newer key that arrived first stays on screen.
    update(session, (current) => {
      if (current.recovery?.phase !== "making") return current;
      return { ...current, recovery: refusedForWantOfPermission(error) ? null : { phase: "failed", error } };
    });
  }
}

/** Hides the key and asks the first of `asks`, three words to pick (made by the screen, from the key's own words). */
export function startPicking(session: number, asks: readonly Ask[]): void {
  update(session, (entry) => {
    if (entry.recovery?.phase !== "show") return entry;
    const { key, issue, unfinished, voluntary } = entry.recovery;
    return { ...entry, recovery: { phase: "pick", key, issue, unfinished, voluntary, asks, at: 0 } };
  });
}

/** A right pick on question `at` that is not the last: on to the next. A second click on the same question does nothing. */
export function nextQuestion(session: number, at: number): void {
  update(session, (entry) => {
    if (entry.recovery?.phase !== "pick" || entry.recovery.at !== at) return entry;
    return { ...entry, recovery: { ...entry.recovery, at: at + 1 } };
  });
}

/** A wrong pick on question `at`: the key is shown again, with a note that says so, to start over with new words. */
export function missedPick(session: number, at: number): void {
  update(session, (entry) => {
    if (entry.recovery?.phase !== "pick" || entry.recovery.at !== at) return entry;
    const { key, issue, unfinished, voluntary } = entry.recovery;
    return { ...entry, recovery: { phase: "show", key, issue, unfinished, voluntary, missed: true, back: true } };
  });
}

/**
 * Shows the key again, with no note: the questions are dropped, and new ones are made when the person goes on. `back` gives focus to the
 * key's heading, as a wrong pick does, since the button that had it went with the questions.
 */
export function showKeyAgain(session: number): void {
  update(session, (entry) => {
    if (entry.recovery?.phase !== "pick") return entry;
    const { key, issue, unfinished, voluntary } = entry.recovery;
    return { ...entry, recovery: { phase: "show", key, issue, unfinished, voluntary, missed: false, back: true } };
  });
}

/**
 * The three words were right: tells the shell, by the key's number, which clears its mark only when that is the latest key
 * it made, and only then lets the key go. The key and the questions are dropped on `Confirmed`, and only while the step
 * still holds that same key. `Superseded` (a newer key was made, and its step is on the page or on its way) changes nothing
 * here. A refusal is thrown for the screen to say, and the step stays. The key the person asked for from inside the vault (`voluntary`) is
 * followed by 29c's offer of a fresh backup, and only while the step still held that key: a person who left, or a lock, gets no offer.
 */
export async function confirmRecovery(session: number): Promise<void> {
  const entry = sessionOf(session);
  if (entry?.recovery?.phase !== "pick") return;
  const { generation } = entry;
  const { issue } = entry.recovery;
  let answer;
  try {
    answer = await api.recoveryConfirmed({ session, generation }, issue);
  } catch (error) {
    if (refusedAsLocked(error)) dropIfStillOpen(session, generation);
    if (error instanceof api.StaleAnswer || !stillOpen(session, generation)) return;
    throw error;
  }
  if (!stillOpen(session, generation) || answer.data !== "Confirmed") return;
  update(session, (current) => {
    if (issueOf(current.recovery) !== issue) return current;
    const asked = current.recovery?.phase === "show" || current.recovery?.phase === "pick" ? current.recovery.voluntary : false;
    return { ...current, recovery: null, newKey: asked ? { phase: "done" } : current.newKey };
  });
}

/**
 * What saving the key's PDF came to, for the screen: the folder picker was closed (`dismissed`), the folder is a cloud
 * one and the person is asked first (`confirm` is the token to answer with), the file is written (`saved` is the folder
 * that holds it), or the vault locked meanwhile (`stale`: nothing to say, nothing was written).
 */
export type KeyPdf = "dismissed" | "stale" | { confirm: string } | { saved: string };

/**
 * Runs a print command of the key screen. A vault that locked meanwhile (the bridge's `StaleAnswer`, or the shell's
 * `locked` when the page missed the event, which also takes the vault's record away) comes back as `"stale"`; any other
 * refusal is thrown for the screen to say.
 */
async function printCommand<T>(session: number, run: (vault: api.SessionRef) => Promise<T>): Promise<T | "stale"> {
  const entry = sessionOf(session);
  if (entry === undefined) return "stale";
  const { generation } = entry;
  try {
    const answer = await run({ session, generation });
    return stillOpen(session, generation) ? answer : "stale";
  } catch (error) {
    // A stale answer says the bridge has seen a later generation than this call began in, as a `locked` refusal does: a session the
    // page still holds at the generation the call started with is dropped; one that was opened again since is left alone.
    const missedLock = refusedAsLocked(error) || (error instanceof api.StaleAnswer && stillOpen(session, generation));
    if (missedLock) dropIfStillOpen(session, generation);
    if (error instanceof api.StaleAnswer || missedLock || !stillOpen(session, generation)) return "stale";
    throw error;
  }
}

/**
 * The page's own refusal for a cloud question whose yes found nothing parked (`not_found`): the shell lets go of a parked save after
 * five minutes as well as at a lock, so it says nothing of a lock. A real lock is heard as the lock event, or as the `locked` refusal of
 * the next command, and takes the session then. Carries only the words' key, never anything the shell sent.
 */
function expiredQuestion(kind: "key_pdf_expired" | "env_file_expired" | "file_copy_expired"): Error {
  return Object.assign(new Error(kind), { code: "page", kind });
}

/**
 * What a cloud question's `not_found` means, found out by asking the shell about the session itself: a lock also lets go of a parked
 * save, and the page may have missed its event. The item list is asked for (`list_items`: the one command of a session that takes
 * nothing, changes nothing and sends nothing secret), through `printCommand`, so a `locked` refusal or a stale answer takes the session
 * off the page and comes back as `"stale"`: nothing is said. A session that is still live had only an old question: the page's refusal
 * (`expiredQuestion`) is thrown to say so. If the lookup itself fails another way, that failure is thrown to be said, and the session stays.
 */
async function whyNotFound(session: number, kind: "key_pdf_expired" | "env_file_expired" | "file_copy_expired"): Promise<"stale"> {
  const seen = await printCommand(session, (vault) => api.listItems(vault));
  if (seen === "stale") return "stale";
  throw expiredQuestion(kind);
}

function keyPdfFrom(answer: api.Tagged<api.Outcome<api.SavedView>>): KeyPdf {
  return keyPdfOf(answer.data);
}

/** What a save dialog's outcome means for the screen (the recovery key's PDF and a saved `.env` file are answered alike). */
function keyPdfOf(outcome: api.Outcome<api.SavedView>): KeyPdf {
  if (outcome === "Dismissed") return "dismissed";
  if ("Done" in outcome) return { saved: outcome.Done.folder };
  if (typeof outcome.Confirm === "object" && "CloudFolder" in outcome.Confirm) {
    return { confirm: outcome.Confirm.CloudFolder.token };
  }
  throw new Error("unexpected answer to save_recovery_pdf");
}

/** Saves the key on screen as a PDF: the shell asks where, prints the page as it shows, and writes the file. */
export async function saveKeyPdf(session: number): Promise<KeyPdf> {
  const answer = await printCommand(session, (vault) => api.saveRecoveryPdf(vault));
  return answer === "stale" ? answer : keyPdfFrom(answer);
}

/**
 * The person's yes to saving it in a cloud-synced folder: the shell goes on with the save it parked. The shell lets go of a
 * parked save at a lock and also after five minutes, so `not_found` is not news of a lock by itself: the shell is asked about the
 * session (`whyNotFound`). Locked: the session leaves the page and nothing is said (`"stale"`). Still live: the page's own refusal
 * ("that took too long, press Save as PDF again") is thrown for the screen to say, the question closes, and the session stays.
 */
export async function confirmKeyPdf(session: number, token: string): Promise<KeyPdf> {
  let answer;
  try {
    answer = await printCommand(session, () => api.saveReadableConfirm(token));
  } catch (error) {
    if (refusedWith(error, "not_found")) return whyNotFound(session, "key_pdf_expired");
    throw error;
  }
  return answer === "stale" ? answer : keyPdfFrom(answer);
}

/**
 * The printers the key can be printed to, for the picker: `"stale"` when the vault locked while Windows was being asked
 * (nothing to show). The list holds no vault data, so it is asked for without a session, but a lock still makes the
 * answer stale. Any refusal is thrown for the screen to say.
 */
export async function loadPrinters(session: number): Promise<api.PrinterList | "stale"> {
  const entry = sessionOf(session);
  if (entry === undefined) return "stale";
  const { generation } = entry;
  try {
    const list = await api.listPrinters();
    return stillOpen(session, generation) ? list : "stale";
  } catch (error) {
    if (!stillOpen(session, generation)) return "stale";
    throw error;
  }
}

/** Whether the shell refused because the printer asked for is not listed any more (so the list is out of date). */
export function refusedAsPrinterGone(error: unknown): boolean {
  return refusedWith(error, "invalid_input") && (error as { what?: unknown }).what === "printer name";
}

/** Prints the key on screen to `printer` (a name from `loadPrinters`): the shell sends the job and answers once it has it. */
export async function printKey(session: number, printer: string): Promise<"done" | "stale"> {
  const answer = await printCommand(session, (vault) => api.printRecoveryKey(vault, printer));
  return answer === "stale" ? answer : "done";
}

/**
 * The number of the latest list asked of each session. Every list load goes through `loadItems`, which takes the next number as
 * it asks and keeps an answer only while its number is still the latest: an older answer that comes after a newer one (a delayed
 * list from a move that arrives after the list from a delete) is dropped, so it can never put back what the newer one took away.
 * A lock or a new generation still wins over all of it (`stillOpen`).
 */
const listRuns = new Map<number, number>();

/**
 * Reads the vault's list again and puts it on the page, along with what depends on it: an open panel that no longer belongs (its
 * item has gone to the Trash, or is gone, outside the Trash view; or has left the Trash, in it) closes, and a value revealed in it
 * goes with it. `quiet` says a refusal of the read changes nothing on the page (a read on top of a refusal that is already being
 * said). `"stale"` when the vault locked meanwhile; an answer overtaken by a newer ask is `"opened"` and installs nothing.
 */
async function loadItems(record: SessionData, options: { quiet?: boolean } = {}): Promise<"opened" | "stale"> {
  const { session, generation } = record;
  const run = (listRuns.get(session) ?? 0) + 1;
  listRuns.set(session, run);
  const latest = () => listRuns.get(session) === run;
  try {
    const list = await api.listItems(record);
    if (!stillOpen(session, generation)) return "stale";
    if (!latest()) return "opened";
    // Items that can't be read are told at unlock (Ask 4); the list's own count counts too, whichever is more.
    update(session, (entry) => {
      const items = list.data.items;
      const open = entry.openItem;
      const row = open === null ? undefined : items.find((item) => item.id === open.id);
      const orphaned = open !== null && (row === undefined || row.trashed !== entry.trash);
      const next = {
        ...entry,
        items,
        loadError: null,
        asks: { ...entry.asks, unreadable: Math.max(entry.asks.unreadable, list.data.damaged.length) },
      };
      return orphaned ? { ...endReveals(next), openItem: null } : next;
    });
    return "opened";
  } catch (error) {
    // A lock that overtook the question: the bridge says so, and so does the shell ("locked"). If the page never heard
    // the lock, the refusal is the news of it: the vault goes.
    if (refusedAsLocked(error)) dropIfStillOpen(session, generation);
    if (error instanceof api.StaleAnswer || refusedAsLocked(error) || !stillOpen(session, generation)) return "stale";
    if (!latest() || options.quiet === true) return "opened";
    update(session, (entry) => ({ ...entry, loadError: error }));
    return "opened";
  }
}

/**
 * Locks every vault. The lock events drop their records; if one is lost on the way, the shell's answer that it has
 * locked everything drops what the page held when Lock all was pressed. A refusal is shown as a message.
 */
export async function lockEverything(): Promise<void> {
  // With their generations: a vault unlocked again before the answer came is not one this Lock all locked.
  const held = state.sessions.map((entry) => ({ session: entry.session, generation: entry.generation }));
  try {
    await api.lockAll();
    for (const { session, generation } of held) dropIfStillOpen(session, generation);
  } catch (error) {
    set({ ...state, toast: { kind: "failed", session: null, error } });
  }
}

/** Changes what the unlock found for one session, when it is still there. */
function updateAsks(session: number, change: (asks: SessionAsks) => SessionAsks): void {
  update(session, (entry) => ({ ...entry, asks: change(entry.asks) }));
}

/**
 * Ask 3's "Accept": the shell signs the vault's details again. Only then does the question close, and the new recovery
 * key (21f) that waited behind it start. A refusal is kept for the question to say, and it stays. A vault that locked
 * meanwhile (the bridge's `StaleAnswer`, or the shell's `locked` when the page missed the event) closes it with nothing
 * said. A second press while the first has no answer does nothing.
 */
export async function acceptDetails(session: number): Promise<void> {
  const entry = sessionOf(session);
  if (entry === undefined || !entry.asks.detailsChanged || entry.asks.answering) return;
  const { generation } = entry;
  updateAsks(session, (asks) => ({ ...asks, answering: true, detailsError: null }));
  try {
    await api.acceptHeader({ session, generation });
  } catch (error) {
    if (refusedAsLocked(error)) dropIfStillOpen(session, generation);
    if (error instanceof api.StaleAnswer || !stillOpen(session, generation)) return;
    updateAsks(session, (asks) => ({ ...asks, answering: false, detailsError: error }));
    return;
  }
  const now = sessionOf(session);
  if (now?.generation !== generation) return;
  const newKey = now.asks.keyWaits;
  update(session, (current) => ({
    ...current,
    asks: { ...current.asks, detailsChanged: false, keyWaits: false, answering: false, detailsError: null },
    recovery: newKey ? { phase: "making" } : current.recovery,
  }));
  if (newKey) void makeNewKey(session);
}

/**
 * Ask 3's "Lock this vault": the lock that already exists, for this vault. Its event drops the record; if the event was
 * lost on the way, the shell's answer that it has locked drops it. The question is asked again at the next unlock,
 * because the shell reports the change again, and the page keeps nothing of this answer. A refusal is kept for the
 * question to say. An answer that comes late, after the lock's event cleared this session and the vault was unlocked
 * again, belongs to the old generation and touches nothing of the new session.
 */
export async function lockThisVault(session: number): Promise<void> {
  const entry = sessionOf(session);
  if (entry === undefined || entry.asks.answering) return;
  const { generation } = entry;
  updateAsks(session, (asks) => ({ ...asks, answering: true, detailsError: null }));
  try {
    await api.lockVault(session);
  } catch (error) {
    if (error instanceof api.StaleAnswer || !stillOpen(session, generation)) return;
    if (refusedAsLocked(error)) {
      dropSession(session);
      return;
    }
    updateAsks(session, (asks) => ({ ...asks, answering: false, detailsError: error }));
    return;
  }
  if (stillOpen(session, generation)) dropSession(session);
}

/**
 * Locks one vault, from the vault menu: the lock that already exists, for this vault alone. Its event drops the record;
 * if the event was lost on the way, the shell's answer that it has locked drops it. An answer that comes late, after the
 * lock's event cleared this session and the vault was unlocked again, belongs to the old generation and touches nothing of
 * the new session. A refusal is said as a message, and the vault stays; a refusal as locked means it is locked already.
 */
export async function lockOneVault(session: number): Promise<void> {
  const entry = sessionOf(session);
  if (entry === undefined) return;
  const { generation } = entry;
  try {
    await api.lockVault(session);
  } catch (error) {
    if (error instanceof api.StaleAnswer || !stillOpen(session, generation)) return;
    if (refusedAsLocked(error)) {
      dropSession(session);
      return;
    }
    set({ ...state, toast: { kind: "failed", session, error } });
    return;
  }
  if (stillOpen(session, generation)) dropSession(session);
}

/** Closes one of an unlock's banners. It comes back at the next unlock if the shell still has it to report. */
export function closeBanner(session: number, banner: Banner): void {
  updateAsks(session, (asks) => (asks.closed.includes(banner) ? asks : { ...asks, closed: [...asks.closed, banner] }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The vault a restore's notice names, as `{ id, name }`; anything else (no vault listed there, a name that can't be read) is `null`. */
function noticeVault(value: unknown): { id: number; name: string } | null {
  if (!isRecord(value) || typeof value.id !== "number" || typeof value.name !== "string") return null;
  return { id: value.id, name: value.name };
}

/**
 * A restore's notice, as a screen says it. Only what a screen shows is kept: the vault's name and id, and the folder as text; the journal's paths are dropped
 * here, so the page never holds one. `null` for `none` and for a state a screen has no words for.
 */
function askOfNotice(notice: unknown): RestoreAsk | null {
  if (!isRecord(notice)) return null;
  if (notice.state === "recovered") {
    const vault = noticeVault(notice.vault);
    if (notice.how === "finished") return { ask: "finished", vault };
    if (notice.how === "staging_removed" || notice.how === "rolled_back") return { ask: "undone", name: vault?.name ?? null };
    return null;
  }
  if (notice.state === "drive_missing") return { ask: "drive_missing", folder: typeof notice.folder === "string" ? notice.folder : null };
  if (notice.state === "pending") return { ask: "pending" };
  if (notice.state === "unclear") return { ask: "unclear" };
  return null;
}

/**
 * Takes in what launch, or a running app, tells. Only the kinds that have a question change anything: the record of
 * opened files that could not be read (Ask 11), a restore that did not finish (Asks 6 and 7, the finished notice), and the first close (5b). The shell keeps its launch notices
 * and may send one again as an event, so the latest of each kind replaces the one before. `live` is an event of a running app (not what launch kept): a restore's
 * recovery that settles meanwhile may have added a vault to the list or brought one back, so the list is read again.
 */
function takeNotice(notice: unknown, live = false): void {
  if (!isRecord(notice)) return;
  if (notice.kind === "output_sweep") {
    set({ ...state, notices: { ...state.notices, lostOutputs: notice.unreadable === true } });
  } else if (notice.kind === "restore") {
    // The latest replaces the one before; `none` (or anything that isn't a state a screen says) takes the notice away.
    set({ ...state, notices: { ...state.notices, restore: askOfNotice(notice) } });
    if (live) void refreshVaults();
  } else if (notice.kind === "first_close" && typeof notice.explain === "boolean") {
    set({ ...state, notices: { ...state.notices, firstClose: notice.explain } });
  } else if (notice.kind === "shortcut_taken") {
    if (!shortcutNoticeVoid) set({ ...state, notices: { ...state.notices, shortcut: "taken" } });
  } else if (notice.kind === "shortcut_not_set") {
    if (!shortcutNoticeVoid) set({ ...state, notices: { ...state.notices, shortcut: "not_set" } });
  } else if (notice.kind === "open_cleanup" && typeof notice.still_open === "number") {
    // Opened copies another program still holds, after a lock's cleanup or at launch. The latest count is the one that counts; none says nothing.
    cleanupNotices += 1;
    set({ ...state, notices: { ...state.notices, openFiles: Math.max(0, Math.floor(notice.still_open)) } });
  }
}

/**
 * Takes in `lockbox://busy`: the long operations running for a vault, which the window says (auto-lock waits for them). It is kept in that
 * vault's record, so a lock takes it away; an event for a vault the page does not hold, or for none, changes nothing. It holds only the
 * shell's fixed names of operations: anything else is not kept.
 */
function takeBusy(event: unknown): void {
  if (!isRecord(event) || typeof event.session !== "number" || !Array.isArray(event.operations)) return;
  const operations = event.operations.filter((name): name is string => typeof name === "string");
  update(event.session, (entry) => ({ ...entry, operations }));
}

let retryingOpen = false;
/** How many `open_cleanup` notices have been heard: a Retry whose answer comes after a newer notice is older news and is not kept. */
let cleanupNotices = 0;

/**
 * 10e's Retry: the shell tries again to remove the opened copies another program held, and answers how many it still cannot. The
 * message goes when none are left. A second press before the answer does nothing. A refusal is thrown, for the message to say.
 */
export async function retryOpenFiles(): Promise<void> {
  if (retryingOpen) return;
  retryingOpen = true;
  const heard = cleanupNotices;
  try {
    const report = await api.retryOpenCleanup();
    // A notice that came while Retry was out (another vault's lock could not remove a copy) is newer than this answer.
    if (cleanupNotices === heard) set({ ...state, notices: { ...state.notices, openFiles: Math.max(0, report.still_open) } });
  } finally {
    retryingOpen = false;
  }
}

/** Closes the message that the save shortcut is off. It comes back only when Lockbox starts again, or if the shell tells it again. */
export function dismissShortcutNotice(): void {
  set({ ...state, notices: { ...state.notices, shortcut: null } });
}

/** Closes the notice of a restore that didn't finish (Ask 6's Not now, the finished notice's Unlock): nothing is sent, there is nothing to dismiss in the shell. */
export function closeRestoreNotice(): void {
  if (state.notices.restore === null) return;
  set({ ...state, notices: { ...state.notices, restore: null } });
}

let retryingRestore = false;

/**
 * Ask 7's and the pending notice's Try again: the shell runs recovery again and answers what it found, which replaces the notice (Ask 6 or the finished notice
 * when it worked, none when nothing is left). Answers `"still"` when the answer is the same notice as before, so the screen says so; `"changed"` otherwise. A
 * refusal (`busy` while a restore is running) is thrown for the screen to say. A second press before the answer does nothing.
 */
export async function retryUnfinishedRestore(): Promise<"still" | "changed" | "ignored"> {
  if (retryingRestore) return "ignored";
  retryingRestore = true;
  const before = state.notices.restore;
  try {
    const next = askOfNotice(await api.retryRestoreRecovery());
    // Recovery may have brought a vault back (its drive is there again) or listed a restored one: the list is read again before the notice shows, so the
    // finished notice's Unlock can choose that vault and the lock screen no longer marks it as not available.
    await refreshVaults();
    set({ ...state, notices: { ...state.notices, restore: next } });
    return before !== null && next?.ask === before.ask ? "still" : "changed";
  } finally {
    retryingRestore = false;
  }
}

let dismissingRestore = false;

/**
 * Dismiss, on Ask 7, the pending notice and the unreadable one: the shell lets the journal go and leaves the folders where they are (the notice's own words say
 * so, so there is no second question), and the notice closes. A refusal (`busy` while a restore is running) is thrown for the screen to say, and the notice
 * stays. A second press before the answer does nothing.
 */
export async function dismissUnfinishedRestore(): Promise<void> {
  if (dismissingRestore) return;
  dismissingRestore = true;
  try {
    const answer = await api.dismissRestore(true);
    if (typeof answer !== "object" || !("Done" in answer)) throw Object.assign(new Error("unexpected"), UNEXPECTED);
    closeRestoreNotice();
  } finally {
    dismissingRestore = false;
  }
}

let confirmingClose = false;

/**
 * 5b's "Got it": the shell keeps that the explanation was seen and hides the window. The message goes with the shell's own
 * `explain: false`, and on the answer too, in case that event was lost. A second press before the answer does nothing. The
 * command never refuses; if the call fails all the same (the bridge itself), the message stays so the button can be pressed
 * again, and nothing is said of why.
 */
export async function confirmFirstClose(): Promise<void> {
  if (confirmingClose) return;
  confirmingClose = true;
  try {
    await api.closeExplainedOk();
    set({ ...state, notices: { ...state.notices, firstClose: false } });
  } catch {
    // The message stays.
  } finally {
    confirmingClose = false;
  }
}

let noticesStarted: Promise<void> | undefined;

/**
 * Starts hearing notices, once the lock listener is up (call it after `startStore`): listens for `lockbox://notice`
 * first, then asks for what launch kept, so none falls between. A notice that can't be heard or read tells nothing and
 * stops nothing: the shell keeps launch notices for the next time the page asks.
 */
export function startNotices(): Promise<void> {
  noticesStarted ??= (async () => {
    if (refusedWith(state.startError, "page")) return;
    try {
      await api.onNotice((notice) => {
        takeNotice(notice, true);
      });
    } catch {
      // Launch notices are still read below; only later ones are missed.
    }
    try {
      await api.onBusy(takeBusy);
    } catch {
      // Without it the window does not say why auto-lock waits; the wait itself is the shell's, and unchanged.
    }
    // The jobs' progress; each of its listeners can fail alone, and the window then shows no bar.
    await startJobs();
    // Where a lock epoch leaves the restore's steps (24a to 24e): the reason matters there, and nowhere else.
    try {
      await api.onLockEpoch((event) => {
        takeRestoreEpoch(event);
        takeOpenEpoch();
        takeForgotEpoch();
        takeKeyEpoch();
        takeUnlockEpoch();
        takeNewVaultEpoch();
      });
    } catch {
      // Without it a restore's or an open's steps stay up after a lock, and the shell's answers to what they send say it has gone.
    }
    // The question a close or a Quit asks while a job runs (33b); it is heard from here on, whichever screen is up.
    await startCloseAsk();
    try {
      for (const notice of await api.launchNotices()) takeNotice(notice);
    } catch {
      // Nothing to tell, as far as the page can know.
    }
  })();
  return noticesStarted;
}

/**
 * Ask 11's "Set it aside": the shell sets the damaged record of opened files aside, and the banner goes. A refusal is
 * thrown for the banner to say, and the banner stays.
 */
export async function setOutputRecordAside(): Promise<void> {
  await api.resetOutputJournal();
  set({ ...state, notices: { ...state.notices, lostOutputs: false } });
}

/**
 * Keeps a refusal for the lock screen to say, for the vault it was about (by its registry ID), which is locked already (Ask 16: a new password was
 * saved but the vault locked before the page could say so). It shows when that vault is the one chosen to unlock, and goes when that vault is
 * unlocked: another vault's unlock leaves it, and a second one for the same vault takes the first's place. Nothing in it is secret.
 */
export function sayOnLockScreen(refusal: unknown, vault: number): void {
  set({ ...state, lockNotes: [...state.lockNotes.filter((note) => note.vault !== vault), { vault, refusal }] });
}

/** How an item comes to the panel, beyond which one: from where it was opened. */
export interface OpenedHow {
  /** Just saved from a new-item form: the panel takes focus on its heading. */
  saved?: boolean;
  /** Back from its Edit form: focus goes to Edit. */
  focusEdit?: boolean;
  /** What the panel had a moment ago (Cancel on a form): shown at once, and read again from the shell meanwhile. */
  detail?: ItemDetail;
}

/**
 * Opens an item in the panel, or closes the panel (`null`). An item takes the panel from a form or tool open in it:
 * what was typed there goes with it.
 */
export async function selectItem(session: number, id: string | null, opened: OpenedHow = {}): Promise<void> {
  const entry = sessionOf(session);
  if (entry === undefined) return;
  if (id === null) {
    update(session, (current) => ({ ...endReveals(current), openItem: null }));
    return;
  }
  const { generation } = entry;
  const saved = opened.saved ?? false;
  const focusEdit = opened.focusEdit ?? false;
  // A value revealed for the item that was open does not stay for the next, or for the same one opened again.
  update(session, (current) => ({
    ...endReveals(current),
    tool: null,
    // An item of the list is never opened in the Trash view: a result of the search takes the person out of it.
    trash: false,
    openItem: { id, detail: opened.detail ?? null, error: null, saved, focusEdit },
  }));
  const run = nextDetailRun(session);
  const shows = () => sessionOf(session)?.openItem?.id === id && stillOpen(session, generation) && detailRuns.get(session) === run;
  try {
    const answer = await api.getItem({ session, generation }, id);
    if (shows()) {
      update(session, (current) => ({ ...current, openItem: { id, detail: answer.data, error: null, saved, focusEdit } }));
    }
  } catch (error) {
    if (refusedAsLocked(error)) dropIfStillOpen(session, generation);
    if (error instanceof api.StaleAnswer || !shows()) return;
    // What was shown stays when only the second read failed.
    update(session, (current) => ({
      ...current,
      openItem: { id, detail: opened.detail ?? null, error, saved, focusEdit },
    }));
  }
}

/**
 * Edit on an open item's details: the item's form takes the panel, from the summary and the details the panel has. Nothing in a
 * vault that is read-only, and nothing until the details have come. The form asks for what it needs itself
 * (`revealForEdit`), so no value is kept here.
 */
export function openEdit(session: number): void {
  const entry = sessionOf(session);
  const open = entry?.openItem;
  if (entry === undefined || entry.readOnly || open === null || open === undefined || open.detail === null) return;
  const detail = open.detail;
  update(session, (current) => ({
    ...endReveals(current),
    openItem: null,
    tool: { kind: "edit", summary: detail.summary, detail },
  }));
}

/**
 * Cancel on an Edit form: nothing was saved. The item's details come back at once, from what the panel had, and are read
 * again from the shell (the item may have changed since), with focus on Edit.
 */
export function closeEdit(session: number): void {
  const tool = sessionOf(session)?.tool;
  if (tool?.kind !== "edit") return;
  void selectItem(session, tool.summary.id, { focusEdit: true, detail: tool.detail });
}

/** What `revealForEdit` came to: the stored value, a refusal to say, or nothing to say (a lock, or the form is gone). */
export type StoredValue = { value: string } | { failed: unknown } | "gone";

/**
 * The stored password or key's value an Edit form shows, asked of Rust as the form opens, through the same reveal command
 * as Reveal. The request carries the reveal token as it was when asked: Cancel, another item, another form and a lock move
 * it on (or drop the session), so an answer that is late, or for a form that is no longer there, comes back as `"gone"`
 * and fills nothing. The value goes to the form's state alone, never into the store.
 */
export async function revealForEdit(session: number, id: string, field: "password" | "key_value"): Promise<StoredValue> {
  const entry = sessionOf(session);
  if (entry === undefined) return "gone";
  const { generation, revealEpoch: token } = entry;
  const current = () => {
    const now = sessionOf(session);
    return stillOpen(session, generation) && now?.revealEpoch === token && now.tool?.kind === "edit" && now.tool.summary.id === id;
  };
  try {
    const answer = await api.revealValue({ session, generation }, id, field);
    return current() ? { value: answer.data } : "gone";
  } catch (error) {
    if (refusedAsLocked(error)) dropIfStillOpen(session, generation);
    if (error instanceof api.StaleAnswer || !current()) return "gone";
    return { failed: error };
  }
}

/** Opens the new-login form in the vault's panel, its title started with `title`. Nothing in a vault that is read-only. */
export function openNewLogin(session: number, title = ""): void {
  openTool(session, { kind: "new_login", title });
}

/** Opens the new-key form in the vault's panel. Nothing in a vault that is read-only. */
export function openNewKey(session: number): void {
  openTool(session, { kind: "new_key" });
}

/** Opens the new-note form in the vault's panel. Nothing in a vault that is read-only. */
export function openNewNote(session: number): void {
  openTool(session, { kind: "new_note" });
}

/** The number of the last time Paste a .env was opened. */
let pasteOpenings = 0;

/** Opens Paste a .env in the vault's panel, as a new panel each time. Nothing in a vault that is read-only. */
export function openPasteEnv(session: number): void {
  pasteOpenings += 1;
  openTool(session, { kind: "paste_env", opening: pasteOpenings });
}

/**
 * Puts a form in the vault's panel in place of the item open there (and of the value revealed for it). A `paste_env` that is told its `rows`
 * and `folder` opens on those, as if they had been pasted.
 */
function openTool(session: number, tool: Tool): void {
  const entry = sessionOf(session);
  if (entry === undefined || entry.readOnly) return;
  update(session, (current) => ({ ...endReveals(current), openItem: null, tool, trash: false }));
}

/** Opens the Generator page in the vault's panel. */
export function openGenerator(session: number): void {
  update(session, (current) => ({ ...endReveals(current), openItem: null, tool: { kind: "generator" } }));
}

/** Opens Settings in the vault's panel. It is the app's, not the vault's, so a read-only vault opens it as well. */
export function openSettings(session: number): void {
  update(session, (current) => ({ ...endReveals(current), openItem: null, tool: { kind: "settings" } }));
}

/** What a settings save came to: saved (the page's copy has it now), or the shell's refusal, with the page's copy as it was. */
export type SettingsResult = "saved" | "cancelled" | { failed: unknown };

/**
 * A save the screen may call back while it still waits in line (`cancelled`), until its turn comes and it is sent (`sent`): after that the
 * shell has it, and it cannot be taken back from here.
 */
export interface SaveTicket {
  cancelled: boolean;
  sent: boolean;
  /** Called once, as it is sent, so the screen can say from then on that it can no longer be cancelled. */
  onSent?: () => void;
}

/** The saves in line: each waits for the one before it, so an older answer can never land over a newer save. */
let settingsLine: Promise<unknown> = Promise.resolve();

/** Whether the launch notice that the save shortcut is off was made untrue by a shortcut saved since (it stays gone, and is not taken in again). */
let shortcutNoticeVoid = false;

/**
 * Saves one change to the settings, as the whole settings: the saved ones with `change` over them, built when its turn comes so a refused
 * change before it is not carried along. The shell applies it at once (the shortcut registered, the capture protection changed). On
 * success the page's copy is the new settings; on a refusal it is left as it was and the refusal comes back for the screen to say. A
 * `ticket` marked cancelled before its turn comes is not sent at all. A saved shortcut makes the launch notice (the shortcut is off) untrue,
 * so it goes, and a kept copy of it that the shell tells again is not shown.
 */
export function saveSettings(change: Partial<api.Settings>, ticket?: SaveTicket): Promise<SettingsResult> {
  const turn = async (): Promise<SettingsResult> => {
    if (ticket?.cancelled === true) return "cancelled";
    if (ticket !== undefined) {
      ticket.sent = true;
      ticket.onSent?.();
    }
    try {
      const next = { ...(state.settings ?? (await api.getSettings())), ...change };
      await api.setSettings(next);
      if (change.shortcut !== undefined) shortcutNoticeVoid = true;
      set({ ...state, settings: next, notices: change.shortcut === undefined ? state.notices : { ...state.notices, shortcut: null } });
      return "saved";
    } catch (error) {
      return { failed: error };
    }
  };
  const result = settingsLine.then(turn);
  settingsLine = result;
  return result;
}

/** Reads the settings again when the page has none (they could not be read at the start); the screens fall back to the defaults meanwhile. */
export function loadSettings(): void {
  if (state.settings !== null) return;
  api.getSettings().then(
    (settings) => {
      if (state.settings === null) set({ ...state, settings });
    },
    () => undefined,
  );
}

/** Closes the form or tool in the panel; what was typed in it is gone. */
export function closeTool(session: number): void {
  update(session, (current) => ({ ...current, tool: null }));
}

// ---- Change password (Plan 4C Task 3: 27a to 27c, and Ask 16) ----
//
// The form is opened for one session (from Settings, Ask 9 or Ask 2) and what is typed lives in the form alone: it is wiped from the fields as it is sent and
// comes here only as the two arguments of `changePassword`, which hand them to the shell once and keep them nowhere. Every step names its session and the
// generation it was opened in, never whatever is on screen: a form is its vault's, an answer lands in that vault's record and shows when that vault is on
// screen, and a lock drops the lot. A change that landed before a lock is the one thing kept (a registry ID and fixed words, no secret), for that vault's next
// unlock to say (`sayOnLockScreen`, Ask 16).

/** The page's own refusal for a current password the shell refused as wrong: the form's words for it (`messages.ts`). */
const WRONG_CURRENT = { code: "page", kind: "wrong_current_password" };

/**
 * What the lock screen says about a change that landed before the lock (Ask 16, and the new recovery key that was made and never seen): the shell's own refusal's
 * shape, which `messages.ts` has the words for.
 */
function landedBeforeLock(vault: number, what: "password" | "recovery key" | "vault created" = "password"): { code: string; what: string; vault: number } {
  return { code: "locked_after_change", what, vault };
}

/** Opens Change password (27a) in the vault's panel. Not in a read-only copy, which has nothing to change. A change that is out keeps its place. */
export function openChangePassword(session: number): void {
  const entry = sessionOf(session);
  if (entry === undefined || entry.readOnly) return;
  const out = entry.passwordChange?.phase === "ask" && entry.passwordChange.sending;
  update(session, (current) => ({
    ...endReveals(current),
    openItem: null,
    trash: false,
    tool: { kind: "change_password" },
    passwordChange: out ? current.passwordChange : { phase: "ask", sending: false, problem: null },
  }));
}

/** Closes the form (Cancel, Close panel, Escape). What was typed goes with it. A change that is out goes on, and is answered where its vault is on screen. */
export function closeChangePassword(session: number): void {
  update(session, (current) => ({
    ...current,
    tool: current.tool?.kind === "change_password" ? null : current.tool,
    passwordChange: current.passwordChange?.phase === "ask" && current.passwordChange.sending ? current.passwordChange : null,
  }));
}

/** The person has begun to mend the form: what the last refusal said goes. */
export function clearPasswordProblem(session: number): void {
  update(session, (current) =>
    current.passwordChange?.phase === "ask" && current.passwordChange.problem !== null
      ? { ...current, passwordChange: { ...current.passwordChange, problem: null } }
      : current,
  );
}

/** 27c's answer: "Back up now" opens 22a for this vault, "Not now" only closes the offer. Either way the change is finished. */
export function finishPasswordChange(session: number, backUp: boolean): void {
  update(session, (current) => (current.passwordChange?.phase === "done" ? { ...current, passwordChange: null } : current));
  if (backUp) openBackup(session);
}

/**
 * Sets the vault's new password, with the current one checked in the same call. The passwords are the form's, already gone from its fields: they go
 * to the shell once and are not kept here. The session and generation are those the form was opened in. A second press while a change is out sends
 * nothing.
 *
 * - **Done:** the form closes and 27c's offer of a fresh backup waits in this vault's record, shown when it is on screen. Ask 9's question about the
 *   spare details is answered by it, so it goes.
 * - **A wrong current password, a new one the shell calls too short, or any other refusal:** said on the form (its own field for the first two), with
 *   the form's fields empty. Nothing changed (see the last point).
 * - **A lock before the headers were written (`locked`):** nothing changed and nothing is said; the old password still opens.
 * - **A lock after the change landed:** the shell's `locked_after_change` (with the vault's registry ID), or its good answer dropped by the bridge as
 *   from before the lock, which the shell only gives a change that was written. Either way Ask 16 is kept for that vault's unlock. The shell answers
 *   the same way (locking the vault first) for a write that came back as an error after `vault.json` landed and the new password is live, so a
 *   disk error that left the new password in effect never reaches the form as a plain refusal.
 * - Any other refusal (a disk error included) is the shell saying the write failed before anything landed: the old password still opens, so it is
 *   said on the form, and no Ask 16 is kept for it.
 */
export async function changePassword(session: number, currentPassword: string, newPassword: string): Promise<void> {
  const entry = sessionOf(session);
  const flow = entry?.passwordChange;
  if (entry === undefined || entry.readOnly || flow?.phase !== "ask" || flow.sending) return;
  const { generation, vaultId } = entry;
  update(session, (current) => ({ ...current, passwordChange: { phase: "ask", sending: true, problem: null } }));
  try {
    await api.changePassword({ session, generation }, currentPassword, newPassword);
  } catch (error) {
    if (error instanceof api.StaleAnswer || refusedWith(error, "locked_after_change")) {
      const named = refusedWith(error, "locked_after_change") ? (error as { vault?: unknown }).vault : undefined;
      const vault = typeof named === "number" && Number.isInteger(named) && named > 0 ? named : vaultId;
      if (vault > 0) sayOnLockScreen(landedBeforeLock(vault), vault);
      dropIfStillOpen(session, generation);
      return;
    }
    if (refusedAsLocked(error)) {
      dropIfStillOpen(session, generation);
      return;
    }
    if (!stillOpen(session, generation)) return;
    const wrong = refusedWith(error, "core") && (error as { kind?: unknown }).kind === "wrong_password";
    const short = refusedWith(error, "core") && (error as { kind?: unknown }).kind === "password_too_short";
    const problem: PasswordProblem = wrong
      ? { field: "current", error: WRONG_CURRENT }
      : { field: short ? "new" : "form", error };
    update(session, (current) => ({ ...current, passwordChange: { phase: "ask", sending: false, problem } }));
    return;
  }
  if (!stillOpen(session, generation)) return;
  update(session, (current) => ({
    ...current,
    tool: current.tool?.kind === "change_password" ? null : current.tool,
    passwordChange: { phase: "done" },
    asks: current.asks.closed.includes("spare") ? current.asks : { ...current.asks, closed: [...current.asks.closed, "spare"] },
  }));
}

// ---- Rename a vault (Plan 4C Task 8: 18d) ----
//
// The small box in the vault menu's place is opened for one session and sends the session and the generation it was opened in, never whatever is on screen (the box goes with
// its vault, so an answer for a vault that is no longer on screen still lands in that vault's record). What is typed is the vault's name, which is not a secret: the shell keeps
// it in the vault's details and the list reads it from there, so the page takes the new name from what it sent and reads the list again.

/** The four reasons a backup is refused, which Rename is refused for as well, and the page's own kind for each: its words end "then rename it" (`messages.ts`). */
const RENAME_REFUSALS: Readonly<Record<string, string>> = {
  "details changed": "rename_details_changed",
  "details unchecked": "rename_details_unchecked",
  "password copies disagree": "rename_password_copies_disagree",
  "recovery key copies disagree": "rename_recovery_key_copies_disagree",
};

/** A refusal of a rename as the box says it: one of the four backup reasons becomes the page's own kind, any other is passed as it is. */
function asRenameRefusal(error: unknown): unknown {
  if (!refusedWith(error, "invalid_input")) return error;
  const what = (error as { what?: unknown }).what;
  const kind = typeof what === "string" && Object.hasOwn(RENAME_REFUSALS, what) ? RENAME_REFUSALS[what] : undefined;
  return kind === undefined ? error : { code: "page", kind };
}

/**
 * Reads the vault list again after a rename that landed. The list reads each name from the vault's details, so this is what the lock screen and the vault menu's rows
 * say; when it can't be read, the entry of the vault the record held (by its registry ID, never by name) is given the new name instead.
 */
async function readListAfterRename(vaultId: number, name: string): Promise<void> {
  const list = await refreshVaults();
  if (list !== null || vaultId <= 0 || state.vaults === null) return;
  set({ ...state, vaults: state.vaults.map((entry) => (entry.id === vaultId ? { ...entry, name } : entry)) });
}

/**
 * Gives the vault a new name (18d). `name` is sent exactly as given (the box has trimmed it). The session and generation are those the box was opened in.
 *
 * - **`"done"`:** the vault's record takes the name (so the side menu's head, the vault menu's row and its Lock and Rename items, and the vault strip change at once) and the
 *   list is read again for the lock screen.
 * - **A lock after the name landed** (`locked_after_change`, or the shell's good answer dropped by the bridge as from before the lock): the list is read again, the record
 *   goes if it is still that generation, and nothing is said: the lock screen shows the new name. `"stale"`.
 * - **A lock before it was written** (`locked`): nothing changed; the record goes if still that generation. `"stale"`.
 * - **Any other refusal:** the list is read again (it says what is really on disk), and the refusal comes back as `{ failed }` for the box to say, the four backup reasons
 *   as the page's own kinds.
 */
export async function renameVault(vault: api.SessionRef, name: string): Promise<"done" | "stale" | { failed: unknown }> {
  const { session, generation } = vault;
  const vaultId = sessionOf(session)?.vaultId ?? NOT_ON_THE_LIST;
  try {
    await api.renameVault(vault, name);
  } catch (error) {
    if (error instanceof api.StaleAnswer || refusedWith(error, "locked_after_change")) {
      await readListAfterRename(vaultId, name);
      dropIfStillOpen(session, generation);
      return "stale";
    }
    if (refusedAsLocked(error)) {
      dropIfStillOpen(session, generation);
      return "stale";
    }
    await refreshVaults();
    return { failed: asRenameRefusal(error) };
  }
  if (stillOpen(session, generation)) update(session, (current) => ({ ...current, name }));
  await readListAfterRename(vaultId, name);
  return "done";
}

// ---- A new recovery key (Plan 4C Task 5: 29a to 29c) ----
//
// Asked for from inside an open vault, with the current password checked in the same call. The form (29a) is the vault's own, as the change-password form is: what is
// typed lives in the form and is wiped as it is sent. The key that comes back is the session's `recovery` step (shown by 29b, picked back as 21d does), marked
// `voluntary`, and it is held only in that record: a lock, a lock epoch or leaving the vault for another takes it, and the shell's mark makes the vault's next
// unlock say so (21f). An answer that comes for another vault than the one on screen waits in its own vault's record and shows when that vault is on screen.

/** Opens the New recovery key form (29a) in the vault's panel. Not in a read-only copy, which has no key to replace. A key that is asked for keeps its place. */
export function openNewRecoveryKey(session: number): void {
  const entry = sessionOf(session);
  if (entry === undefined || entry.readOnly) return;
  const out = entry.newKey?.phase === "ask" && entry.newKey.sending;
  update(session, (current) => ({
    ...endReveals(current),
    openItem: null,
    trash: false,
    tool: { kind: "new_recovery_key" },
    newKey: out ? current.newKey : { phase: "ask", sending: false, problem: null },
  }));
}

/** Closes the form (Cancel, Close panel, Escape). What was typed goes with it. A key that is asked for goes on, and is answered where its vault is on screen. */
export function closeNewRecoveryKey(session: number): void {
  update(session, (current) => ({
    ...current,
    tool: current.tool?.kind === "new_recovery_key" ? null : current.tool,
    newKey: current.newKey?.phase === "ask" && current.newKey.sending ? current.newKey : null,
  }));
}

/** The person has begun to mend the form: what the last refusal said goes. */
export function clearNewKeyProblem(session: number): void {
  update(session, (current) =>
    current.newKey?.phase === "ask" && current.newKey.problem !== null ? { ...current, newKey: { ...current.newKey, problem: null } } : current,
  );
}

/** 29c's answer: "Back up now" opens 22a for this vault, "Not now" only closes the offer. Either way the new key is finished. */
export function finishNewKey(session: number, backUp: boolean): void {
  update(session, (current) => (current.newKey?.phase === "done" ? { ...current, newKey: null } : current));
  if (backUp) openBackup(session);
}

/**
 * Asks the shell for a new recovery key for the vault, with the current password checked in the same call. The password is the form's, already gone from its
 * field: it goes to the shell once and is kept nowhere here. The session and generation are those the form was opened in. A second press while a key is asked for
 * sends nothing.
 *
 * - **Made:** the key is the session's `recovery` step (29b) and the form is gone. An answer for a key older than the one the step holds changes nothing.
 * - **A wrong current password, or any other refusal (the shell could not write its mark first, say):** said on the form (its own field for the first), with the field
 *   empty. Nothing was made, and no mark was written.
 * - **A lock before anything was written (`locked`):** nothing changed and nothing is said.
 * - **A lock after the key was made** (`locked_after_change` with the vault's registry ID, or the shell's good answer dropped by the bridge as from before the lock,
 *   which the shell only gives a key that was made): the key was never seen, so that vault's next unlock says so (the session's words), and 21f follows it by the mark.
 */
export async function makeNewRecoveryKey(session: number, currentPassword: string): Promise<void> {
  const entry = sessionOf(session);
  const flow = entry?.newKey;
  if (entry === undefined || entry.readOnly || flow?.phase !== "ask" || flow.sending) return;
  const { generation, vaultId } = entry;
  // The lock epoch the key was asked for in: a lock that starts before the reply lands (Windows locking, an idle lock) can reach the page before this vault's own
  // `locked` event, and the reply must not put the words back.
  const epoch = currentLockEpoch();
  update(session, (current) => ({ ...current, newKey: { phase: "ask", sending: true, problem: null } }));
  let answer;
  try {
    answer = await api.newRecoveryKey({ session, generation }, currentPassword);
  } catch (error) {
    if (error instanceof api.StaleAnswer || refusedWith(error, "locked_after_change")) {
      const named = refusedWith(error, "locked_after_change") ? (error as { vault?: unknown }).vault : undefined;
      const vault = typeof named === "number" && Number.isInteger(named) && named > 0 ? named : vaultId;
      if (vault > 0) sayOnLockScreen(landedBeforeLock(vault, "recovery key"), vault);
      dropIfStillOpen(session, generation);
      return;
    }
    if (refusedAsLocked(error)) {
      dropIfStillOpen(session, generation);
      return;
    }
    if (!stillOpen(session, generation)) return;
    const wrong = refusedWith(error, "core") && (error as { kind?: unknown }).kind === "wrong_password";
    const problem: PasswordProblem = wrong ? { field: "current", error: WRONG_CURRENT } : { field: "form", error };
    update(session, (current) => ({ ...current, newKey: { phase: "ask", sending: false, problem } }));
    return;
  }
  if (!stillOpen(session, generation)) return;
  if (currentLockEpoch() !== epoch) {
    // The key was made and a lock has started: its words are dropped unread, and that vault's unlock says so (the mark makes 21f follow).
    if (vaultId > 0) sayOnLockScreen(landedBeforeLock(vaultId, "recovery key"), vaultId);
    dropSession(session);
    return;
  }
  const { words, issue } = answer.data;
  update(session, (current) => {
    const closed = { ...current, tool: current.tool?.kind === "new_recovery_key" ? null : current.tool, newKey: null };
    // A key whose number is not newer than the one the step holds (its reply came after a newer key's) is not the step's: the page acts only on the current one.
    if ((issueOf(current.recovery) ?? 0) >= issue) return closed;
    return { ...closed, recovery: { phase: "show", key: words, issue, unfinished: false, voluntary: true, missed: false } };
  });
}

// ---- Back up a vault (Plan 4B Task 3: 22a to 22d, Ask 1 and Ask 2) ----
//
// Back up is pressed in the panel; Rust opens Windows' save dialog and writes the file, so the page never holds a path. The command is a long job
// with a `request` the page chose, which the shell turns into an operation by `lockbox://job-started` once the work starts (not for a closed
// dialog, nor for a refusal before anything is written). What an answer does depends on where the person is when it comes: the panel, when it is
// still open, shows the result; a panel closed meanwhile gets the result as a message instead. A lock, or a stale answer, says nothing at all.

/** The four reasons a backup is refused before anything is written, because one made now might not open: the shell's fixed `what` for each. */
const BACKUP_REFUSED = ["details changed", "password copies disagree", "recovery key copies disagree", "details unchecked"];

function isBackupRefused(error: unknown): boolean {
  return refusedWith(error, "invalid_input") && BACKUP_REFUSED.includes(String((error as { what?: unknown }).what));
}

/**
 * Reads whether a backup is due (Ask 1) for a session just unlocked, and keeps the days when it is. A failure, or a vault locked meanwhile, says
 * nothing: the reminder is only a reminder, and the next unlock asks again.
 */
async function readBackupDue(session: number, generation: number): Promise<void> {
  try {
    const answer = await api.vaultBackupDue({ session, generation });
    const due = answer.data;
    if (due !== null && stillOpen(session, generation)) updateAsks(session, (asks) => ({ ...asks, backupDue: due.days }));
  } catch (error) {
    if (refusedAsLocked(error)) dropIfStillOpen(session, generation);
  }
}

/**
 * Opens Back up (22a) in the vault's panel, from Settings or from the reminder's "Back up now". One that is running is shown as it is, and no
 * second starts. Not in a read-only copy, which has nothing of its own to back up.
 */
export function openBackup(session: number): void {
  const entry = sessionOf(session);
  if (entry === undefined || entry.readOnly) return;
  const running = entry.backup?.phase === "running";
  update(session, (current) => ({
    ...endReveals(current),
    openItem: null,
    trash: false,
    tool: { kind: "backup" },
    backup: running ? current.backup : { phase: "ask", error: null },
  }));
}

/** Closes the Back up panel. A backup that runs goes on, and its result is said when it comes. */
export function closeBackup(session: number): void {
  update(session, (current) => ({
    ...current,
    tool: current.tool?.kind === "backup" ? null : current.tool,
    backup: current.backup?.phase === "running" ? current.backup : null,
  }));
}

/** Ask 2's "Not now", and the other refusals' only answer: the question goes. */
export function putBackupAside(session: number): void {
  update(session, (current) => (current.backup?.phase === "refused" ? { ...current, backup: null } : current));
}

/**
 * Ask 2's "See the change": the details were changed outside Lockbox and not accepted, which is Ask 3's question. It opens for this vault, and
 * its Accept or Lock this vault answer it as they do after an unlock.
 */
export function seeTheChange(session: number): void {
  update(session, (current) =>
    current.backup?.phase === "refused" ? { ...current, backup: null, asks: { ...current.asks, detailsChanged: true, detailsError: null } } : current,
  );
}

/**
 * The rename box's "See the change" (4C Task 13b): the shell refused the rename because this vault's details were changed outside Lockbox, so Ask 3 opens for it, as Ask 2's
 * button does for a backup. A vault opened read-only has nothing to accept.
 */
export function openDetailsChanged(session: number): void {
  const entry = sessionOf(session);
  if (entry === undefined || entry.readOnly) return;
  update(session, (current) => ({ ...current, asks: { ...current.asks, detailsChanged: true, detailsError: null } }));
}

/** Says how a backup ended, where the person is: in the panel when it is still open, else as a message. Nothing for a vault that locked. */
function endBackup(session: number, generation: number, step: BackupStep & { phase: "saved" | "failed" }): void {
  const entry = sessionOf(session);
  if (entry?.generation !== generation) return;
  if (entry.tool?.kind === "backup") {
    update(session, (current) => ({ ...current, backup: step }));
    return;
  }
  update(session, (current) => ({ ...current, backup: null }));
  if (step.phase === "saved") {
    const left = leftOutWords(step.view);
    noted(session, left === null ? "Backup saved." : `Backup saved. ${left}`);
  } else {
    const more = backupNotFinishedMore(step.error);
    told(session, more === null ? BACKUP_NOT_FINISHED : `${BACKUP_NOT_FINISHED} ${more}`);
  }
}

/**
 * Back up, pressed on 22a: sends the command with a new request and waits. `"Dismissed"` (the save dialog closed) goes back to 22a with nothing
 * said. A refusal before anything was written (no job ever started) is said on 22a: 22d's numbers for a drive too small, the table's words for the
 * rest, and the four that mean a backup made now might not open leave 22a for their own question. A refusal after the work began, and a stop, are
 * "didn't finish". A second press while one is out sends nothing.
 */
export async function startBackup(session: number): Promise<void> {
  const entry = sessionOf(session);
  if (entry === undefined || entry.readOnly || entry.backup?.phase !== "ask") return;
  const { generation } = entry;
  const request = nextRequest();
  update(session, (current) => ({ ...current, backup: { phase: "running", request } }));
  try {
    const answer = await api.backupVault({ session, generation }, request);
    if (!stillOpen(session, generation)) return;
    const outcome = answer.data;
    if (outcome === "Dismissed") {
      update(session, (current) => ({ ...current, backup: { phase: "ask", error: null } }));
    } else if ("Done" in outcome) {
      endBackup(session, generation, { phase: "saved", view: outcome.Done });
    } else {
      // This command never asks a question.
      endBackup(session, generation, { phase: "failed", error: UNEXPECTED });
    }
  } catch (error) {
    if (refusedAsLocked(error)) dropIfStillOpen(session, generation);
    if (error instanceof api.StaleAnswer || !stillOpen(session, generation)) return;
    // Whether the work began is what the shell said by `job-started`, read before the job is let go below.
    const began = jobOfRequest(request) !== null;
    if (isBackupRefused(error)) {
      update(session, (current) => ({
        ...current,
        tool: current.tool?.kind === "backup" ? null : current.tool,
        backup: { phase: "refused", error },
      }));
    } else if (refusedWith(error, "cancelled") || began) {
      endBackup(session, generation, { phase: "failed", error });
    } else {
      // Refused before anything was written. With the panel closed meanwhile, the sentence is said as a message.
      if (sessionOf(session)?.tool?.kind === "backup") update(session, (current) => ({ ...current, backup: { phase: "ask", error } }));
      else {
        update(session, (current) => ({ ...current, backup: null }));
        sayFailure(session, error);
      }
    }
  } finally {
    releaseRequest(request);
  }
}

// ---- Test a backup (Plan 4B Task 4: 23a to 23d) ----
//
// The backup is picked first, in Windows' own dialog that Rust opens, and Rust holds its path under a choice; the page holds the name and size it was told
// and the choice, in the session whose panel it is (`SessionData.test`). Then the password or recovery key is typed in one box and sent with the choice: the
// shell tests the backup as a launch-scoped job (a progress bar and a Cancel) and writes nothing. Every answer keeps the choice, so a wrong password is tried
// again without picking the file again; the choice is let go when the panel closes, when another panel takes its place, when the vault locks, and after
// five minutes unused (the shell's side). The typed text is the box's own state and is wiped after every send, so nothing typed is kept here.

/** The number of the last time Test a backup was begun. */
let testOpenings = 0;

/** What the page says when the shell has let the picked backup go (an answer of `choice_expired`, or of `locked` while it ran): `messages.ts` has its words. */
const TEST_CHOICE_EXPIRED = { code: "page", kind: "test_choice_expired" };

/** A test's flow at its start: waiting for the picker (`pick` is `null`), or with a backup picked, at 23a. */
function newTest(opening: number, pick: api.TestPick | null): TestFlow {
  return {
    opening,
    phase: pick === null ? "picking" : "ask",
    choice: pick?.choice ?? null,
    fileName: pick?.file_name ?? null,
    size: pick?.size ?? 0,
    busy: false,
    problem: null,
    request: null,
    view: null,
    damage: null,
  };
}

/**
 * Test a backup has ended (its panel closed, was replaced, or its vault locked): the test that runs is stopped, and the shell lets the backup picked go.
 * Both are best effort: a lock may have taken either already, and the answer of a test that was stopped comes to nothing here.
 */
function letGoOfTest(flow: TestFlow): void {
  // A test whose `job-started` has not come yet is stopped when it does (the shell has already begun it; forgetting the choice cannot stop it).
  if (flow.request !== null) cancelRequest(flow.request);
  if (flow.choice !== null) void api.forgetTestBackup(flow.choice).catch(() => undefined);
}

/** Changes one session's test while it is still the opening and generation the caller began in. */
function changeTest(session: number, generation: number, opening: number, change: (flow: TestFlow) => TestFlow): void {
  if (!stillOpen(session, generation)) return;
  update(session, (current) => (current.test?.opening === opening ? { ...current, test: change(current.test) } : current));
}

/** Whether the test the caller began is still this session's (the panel not closed or replaced, the vault not locked since). */
function testIsStill(session: number, generation: number, opening: number): boolean {
  const entry = sessionOf(session);
  return entry?.generation === generation && entry.test?.opening === opening;
}

/** A pick the page no longer has a place for (the vault locked or the panel went while the picker was open): the shell is told to forget it. */
function forgetStray(pick: api.TestPick): void {
  void api.forgetTestBackup(pick.choice).catch(() => undefined);
}

/**
 * Settings' "Test a backup": opens Windows' picker for the backup file first, and 23a opens on it, with nothing sent but the pick. A closed picker says
 * and changes nothing. While the picker is open the button waits (`phase: "picking"`), so a second press sends nothing. Settings stays on screen
 * until a file is picked; the panel takes its place then.
 */
export async function startTestBackup(session: number): Promise<void> {
  const entry = sessionOf(session);
  if (entry === undefined || entry.test !== null) return;
  const { generation } = entry;
  testOpenings += 1;
  const opening = testOpenings;
  update(session, (current) => ({ ...current, test: newTest(opening, null) }));
  let answer: Awaited<ReturnType<typeof api.testBackupPick>>;
  try {
    answer = await api.testBackupPick(null);
  } catch (error) {
    // Nothing was picked: no panel. A vault that locked meanwhile says nothing, as with every lock.
    if (!testIsStill(session, generation, opening)) return;
    update(session, (current) => ({ ...current, test: null }));
    if (!refusedAsLocked(error)) sayFailure(session, error);
    return;
  }
  const mine = testIsStill(session, generation, opening);
  if (answer === "Dismissed") {
    if (mine) update(session, (current) => ({ ...current, test: null }));
    return;
  }
  if (!("Done" in answer)) {
    // This command never asks a question.
    if (mine) {
      update(session, (current) => ({ ...current, test: null }));
      sayFailure(session, UNEXPECTED);
    }
    return;
  }
  if (!mine) {
    forgetStray(answer.Done);
    return;
  }
  update(session, (current) => ({
    ...endReveals(current),
    openItem: null,
    trash: false,
    tool: { kind: "test_backup" },
    test: newTest(opening, answer.Done),
  }));
}

/**
 * 22c's "Test this backup": straight to 23a with the backup just written already picked (the shell parked its choice and told the page its name and size).
 * Nothing is picked and nothing is sent.
 */
export function testThisBackup(session: number): void {
  const step = sessionOf(session)?.backup;
  if (step?.phase !== "saved") return;
  testOpenings += 1;
  const opening = testOpenings;
  const { test } = step.view;
  update(session, (current) => ({
    ...endReveals(current),
    openItem: null,
    trash: false,
    tool: { kind: "test_backup" },
    backup: null,
    test: newTest(opening, test),
  }));
}

/**
 * Pick another (and Pick a backup, when the choice has gone): the picker adds nothing to the old file, it replaces it. The sent choice is the current one
 * (`null` when none is left); a closed picker leaves the file as it was.
 */
export async function pickAnotherBackup(session: number): Promise<void> {
  const entry = sessionOf(session);
  const flow = entry?.test ?? null;
  if (entry === undefined || flow === null || flow.phase !== "ask" || flow.busy) return;
  const { generation } = entry;
  const { opening, choice } = flow;
  changeTest(session, generation, opening, (now) => ({ ...now, busy: true, problem: null }));
  try {
    const answer = await api.testBackupPick(choice);
    const mine = testIsStill(session, generation, opening);
    if (answer === "Dismissed") {
      changeTest(session, generation, opening, (now) => ({ ...now, busy: false }));
    } else if ("Done" in answer) {
      const pick = answer.Done;
      if (!mine) forgetStray(pick);
      changeTest(session, generation, opening, (now) => ({ ...now, busy: false, choice: pick.choice, fileName: pick.file_name, size: pick.size, problem: null }));
    } else {
      changeTest(session, generation, opening, (now) => ({ ...now, busy: false, problem: UNEXPECTED }));
    }
  } catch (error) {
    // A choice the shell let go takes the file with it: the person picks again.
    const gone = refusedWith(error, "choice_expired") || refusedAsLocked(error);
    changeTest(session, generation, opening, (now) =>
      gone ? { ...now, busy: false, choice: null, fileName: null, size: 0, problem: TEST_CHOICE_EXPIRED } : { ...now, busy: false, problem: error },
    );
  }
}

/**
 * Test, pressed on 23a with the text typed: sends the choice, the text as one box's (`password_or_key`) and a new request, and the bar takes the panel. The
 * text is the caller's and is not kept: the screen wipes its box as it calls this. Every answer keeps the choice. A wrong password (or any refusal) goes
 * back to 23a with its words under the box and the file still picked (23c); a stop goes back quietly; a damaged backup is 23d; a choice the shell no longer
 * holds takes the file away and asks to pick again. The result is said in the page's spoken place. An answer for a panel closed or replaced meanwhile,
 * or a vault locked, comes to nothing.
 */
export async function runTestBackup(session: number, credential: string): Promise<void> {
  const entry = sessionOf(session);
  const flow = entry?.test ?? null;
  if (entry === undefined || flow === null || flow.phase !== "ask" || flow.busy || flow.choice === null || credential === "") return;
  const { generation } = entry;
  const { opening, choice } = flow;
  const request = nextRequest();
  changeTest(session, generation, opening, (now) => ({ ...now, phase: "testing", request, problem: null }));
  let ran: { view: api.BackupSummaryView } | { refused: unknown };
  try {
    const answer = await api.testBackup(choice, { password_or_key: credential }, request);
    ran = typeof answer === "object" && "Done" in answer ? { view: answer.Done } : { refused: UNEXPECTED };
  } catch (error) {
    ran = { refused: error };
  } finally {
    // Before anything is said below: the job's own start words are cleared by this, and the result's are said after.
    releaseRequest(request);
  }
  if (!testIsStill(session, generation, opening)) return;
  if ("view" in ran) {
    const { view } = ran;
    changeTest(session, generation, opening, (now) => ({ ...now, phase: "good", request: null, view }));
    announceJob("This backup is good.", request);
    return;
  }
  const error = ran.refused;
  if (refusedWith(error, "core") && (error as { kind?: unknown }).kind === "damaged") {
    changeTest(session, generation, opening, (now) => ({ ...now, phase: "damaged", request: null, damage: error }));
    announceJob("This backup is damaged.", request);
  } else if (refusedWith(error, "cancelled")) {
    changeTest(session, generation, opening, (now) => ({ ...now, phase: "ask", request: null }));
  } else if (refusedWith(error, "choice_expired") || refusedAsLocked(error)) {
    changeTest(session, generation, opening, (now) => ({
      ...now,
      phase: "ask",
      request: null,
      choice: null,
      fileName: null,
      size: 0,
      problem: TEST_CHOICE_EXPIRED,
    }));
  } else {
    changeTest(session, generation, opening, (now) => ({ ...now, phase: "ask", request: null, problem: error }));
  }
}

/** Takes the refusal under the box away, as typing again does (a wrong password's line stays only until the next try is begun). */
export function clearTestProblem(session: number): void {
  const flow = sessionOf(session)?.test ?? null;
  if (flow === null || flow.problem === null) return;
  changeTest(session, sessionOf(session)?.generation ?? 0, flow.opening, (now) => ({ ...now, problem: null }));
}

/** Closes the Test a backup panel (Cancel, Done, Close, Escape): a test that runs is stopped and the backup picked is let go. */
export function closeTestBackup(session: number): void {
  update(session, (current) => ({ ...current, tool: current.tool?.kind === "test_backup" ? null : current.tool, test: null }));
}

// ---- Open a backup read-only (Plan 4B Task 7: 25a to 25d) ----
//
// The backup is picked first, in Windows' own dialog that Rust opens, and Rust holds its path under a choice (of Open a backup's own kind). The password or recovery key
// is typed once in one box and sent with the choice; the open is a launch-scoped job with a bar and a Stop. A wrong password, damage, a stop and a refusal keep the
// choice, so the next try needs no new pick; a session opened uses it up. The new session is a read-only one, added and brought to the front. The flow is the app's
// (a backup needs no vault): its panel is in the window that began it, or it is full-screen from the lock screen. The typed text is the box's own state.

/** The number of the last time Open a backup was begun. */
let openOpenings = 0;

/** A flow's first step: waiting for the picker (`pick` is `null`), or with a backup picked. */
function newOpen(opening: number, host: number | null, pick: api.OpenPick | null): OpenFlow {
  return {
    opening,
    host,
    phase: pick === null ? "picking" : "ask",
    choice: pick?.choice ?? null,
    fileName: pick?.file_name ?? null,
    size: pick?.size ?? 0,
    busy: false,
    problem: null,
    request: null,
  };
}

/** Open a backup has ended (cancelled, its panel taken, its host locked): an open that runs is stopped, and the shell lets the backup picked go. Both are best effort. */
function letGoOfOpen(flow: OpenFlow): void {
  if (flow.request !== null) cancelRequest(flow.request);
  if (flow.choice !== null) void api.forgetOpenBackup(flow.choice).catch(() => undefined);
}

/** Whether the flow the caller began is still on. */
function openIsStill(opening: number): boolean {
  return state.openBackup?.opening === opening;
}

/** Changes the flow while it is still the opening the caller began. */
function changeOpen(opening: number, change: (flow: OpenFlow) => OpenFlow): void {
  const flow = state.openBackup;
  if (flow?.opening !== opening) return;
  set({ ...state, openBackup: change(flow) });
}

/** A pick the page no longer has a place for (the flow was left while the picker was open): the shell is told to forget it. */
function forgetOpenStray(choice: string): void {
  void api.forgetOpenBackup(choice).catch(() => undefined);
}

/** Puts the panel away from its window: the host's tool goes when it is Open a backup's. */
function closeOpenPanel(host: number | null): void {
  if (host !== null) update(host, (current) => ({ ...current, tool: current.tool?.kind === "open_backup" ? null : current.tool }));
}

/**
 * "Open a backup", from Ask 4, 10d, Save all's summary, Settings or the lock screen: opens Windows' picker for the backup file first, and 25a opens on it, with nothing sent but
 * the pick. A closed picker says nothing and opens nothing; a lock while it was open too. Any other refusal opens 25a with no file and its words under the row. Only one runs
 * at a time (and none while a restore's steps are up). From a window it is that window's panel (its tool is then Open a backup, which replaces what was there once a file
 * is picked); with no vault open it is the lock screen's full-screen steps.
 */
export async function startOpenBackup(): Promise<void> {
  if (state.openBackup !== null || state.restore !== null) return;
  const host = state.sessions.at(-1)?.session ?? null;
  openOpenings += 1;
  const opening = openOpenings;
  set({ ...state, openBackup: newOpen(opening, host, null) });
  let answer: Awaited<ReturnType<typeof api.openBackupPick>>;
  try {
    answer = await api.openBackupPick(null);
  } catch (error) {
    if (!openIsStill(opening)) return;
    if (refusedAsLocked(error)) {
      set({ ...state, openBackup: null });
      return;
    }
    changeOpen(opening, (now) => ({ ...now, phase: "ask", problem: error }));
    if (host !== null) showOpenPanel(host);
    return;
  }
  if (!openIsStill(opening)) {
    if (typeof answer === "object" && "Done" in answer) forgetOpenStray(answer.Done.choice);
    return;
  }
  if (answer === "Dismissed") {
    set({ ...state, openBackup: null });
    return;
  }
  if ("Done" in answer) {
    const pick = answer.Done;
    changeOpen(opening, () => newOpen(opening, host, pick));
  } else {
    // This command never asks a question.
    changeOpen(opening, (now) => ({ ...now, phase: "ask", problem: UNEXPECTED }));
  }
  if (host !== null) showOpenPanel(host);
}

/** The panel takes its window's side: what was open there (an item, Settings, a form) goes, as another tool does. */
function showOpenPanel(host: number): void {
  update(host, (current) => ({ ...endReveals(current), openItem: null, trash: false, tool: { kind: "open_backup" } }));
}

/** Pick another (and Pick a backup, when the choice has gone): the new file replaces the old one in the shell; a closed picker leaves the file as it was. */
export async function pickAnotherOpenBackup(): Promise<void> {
  const flow = state.openBackup;
  if (flow === null || flow.phase !== "ask" || flow.busy) return;
  const { opening, choice } = flow;
  changeOpen(opening, (now) => ({ ...now, busy: true, problem: null }));
  try {
    const answer = await api.openBackupPick(choice);
    const mine = openIsStill(opening);
    if (answer === "Dismissed") {
      changeOpen(opening, (now) => ({ ...now, busy: false }));
    } else if ("Done" in answer) {
      const pick = answer.Done;
      if (!mine) forgetOpenStray(pick.choice);
      changeOpen(opening, (now) => ({ ...now, busy: false, choice: pick.choice, fileName: pick.file_name, size: pick.size, problem: null }));
    } else {
      changeOpen(opening, (now) => ({ ...now, busy: false, problem: UNEXPECTED }));
    }
  } catch (error) {
    // A choice the shell let go takes the file with it: the person picks again.
    const gone = refusedWith(error, "choice_expired") || refusedAsLocked(error);
    changeOpen(opening, (now) =>
      gone ? { ...now, busy: false, choice: null, fileName: null, size: 0, problem: TEST_CHOICE_EXPIRED } : { ...now, busy: false, problem: error },
    );
  }
}

/**
 * Open read-only, pressed on 25a with the text typed: sends the choice, the text as one box's (`password_or_key`) and a new request, and the bar takes the panel. The text is the
 * caller's and is not kept: the screen wipes its box as it calls this. A wrong password, damage or any other refusal goes back to 25a with its words and the file still picked; a
 * stop goes back quietly; a choice the shell no longer holds takes the file away and asks to pick again. A backup opened is a new read-only session, added and brought to the
 * front, and the panel closes. An answer for a flow left meanwhile comes to nothing (a session the shell made for it is locked again, unless the page holds it already).
 */
export async function runOpenBackup(credential: string): Promise<void> {
  const flow = state.openBackup;
  if (flow === null || flow.phase !== "ask" || flow.busy || flow.choice === null || credential === "") return;
  const { opening, choice, host } = flow;
  const request = nextRequest();
  changeOpen(opening, (now) => ({ ...now, phase: "opening", request, problem: null }));
  let ended: { opened: api.Tagged<api.SessionInfo> } | { refused: unknown };
  try {
    const answer = await api.openBackupReadOnly(choice, { password_or_key: credential }, request);
    ended = typeof answer === "object" && typeof (answer as { session?: unknown }).session === "number" ? { opened: answer } : { refused: UNEXPECTED };
  } catch (error) {
    ended = { refused: error };
  } finally {
    releaseRequest(request);
  }
  if (!openIsStill(opening)) {
    // The flow was left meanwhile: a session the shell made for it is not shown, and is locked again, unless the page holds that one already.
    if ("opened" in ended && sessionOf(ended.opened.session) === undefined) void api.lockVault(ended.opened.session).catch(() => undefined);
    return;
  }
  if ("opened" in ended) {
    const { opened } = ended;
    const held = sessionOf(opened.session);
    set({ ...state, openBackup: null });
    closeOpenPanel(host);
    if (held?.generation === opened.generation) {
      // A backup that was open already: its window comes to the front as it was.
      showSession(opened.session);
    } else {
      const record = newRecord(opened, NOT_ON_THE_LIST, opened.data, null);
      set({ ...state, sessions: withFront(state.sessions, record) });
      void loadItems(record);
    }
    focusList();
    return;
  }
  const error = ended.refused;
  if (refusedWith(error, "cancelled")) {
    changeOpen(opening, (now) => ({ ...now, phase: "ask", request: null }));
  } else if (refusedWith(error, "choice_expired") || refusedAsLocked(error)) {
    changeOpen(opening, (now) => ({ ...now, phase: "ask", request: null, choice: null, fileName: null, size: 0, problem: TEST_CHOICE_EXPIRED }));
  } else {
    changeOpen(opening, (now) => ({ ...now, phase: "ask", request: null, problem: error }));
  }
}

/** Takes the refusal under the box away, as typing again does. No step is taken. */
export function clearOpenProblem(): void {
  const flow = state.openBackup;
  if (flow === null || flow.phase !== "ask" || flow.problem === null) return;
  set({ ...state, openBackup: { ...flow, problem: null } });
}

/** Cancel (and Close, and Escape), on any step: the flow goes. An open that runs is stopped and the shell lets the pick go. */
export function closeOpenBackup(): void {
  const flow = state.openBackup;
  if (flow === null) return;
  set({ ...state, openBackup: null });
  letGoOfOpen(flow);
  closeOpenPanel(flow.host);
}

/** A lock epoch (Lock all, an idle lock, Windows locking or sleeping, the app closing): the shell dropped the pick and ended the open, so the flow goes, with what was typed. */
function takeOpenEpoch(): void {
  const flow = state.openBackup;
  if (flow === null) return;
  set({ ...state, openBackup: null });
  closeOpenPanel(flow.host);
}

/** Open a backup as the screens read it: `null` while none is begun. */
export function useOpenBackup(): OpenFlow | null {
  return useSelect((current) => current.openBackup);
}

/** A session's record without the key of a new recovery key that was asked for (29b), shown or being picked: the key and its questions are gone. Any other step stays. */
function withoutVoluntaryKey(entry: SessionData): SessionData {
  const step = entry.recovery;
  return (step?.phase === "show" || step?.phase === "pick") && step.voluntary ? { ...entry, recovery: null } : entry;
}

/**
 * A lock epoch (Lock all, an idle lock, Windows locking or sleeping): every vault is about to lock, and the key of a new recovery key on screen goes from the page
 * now, without waiting for its vault's own `locked` event. The shell's mark stays, so the vault's next unlock makes another key (21f).
 */
function takeKeyEpoch(): void {
  if (!state.sessions.some((entry) => withoutVoluntaryKey(entry) !== entry)) return;
  sayOfUnseenKeys(state.sessions);
  set({ ...state, sessions: state.sessions.map((entry) => withoutVoluntaryKey(entry)) });
}

/**
 * A new recovery key that reached a vault in the background (another vault was on screen) was never shown. When the record that holds it goes (a lock, a lock
 * epoch), that vault's next unlock says so, as it does for a key whose reply came after the lock. Only the front session's key was ever on screen. `only` limits
 * it to one session (the one that is being dropped).
 */
function sayOfUnseenKeys(sessions: readonly SessionData[], only?: number): void {
  const front = sessions.at(-1);
  for (const entry of sessions) {
    if (only !== undefined && entry.session !== only) continue;
    if (entry.session === front?.session || entry.vaultId <= 0 || withoutVoluntaryKey(entry) === entry) continue;
    sayOnLockScreen(landedBeforeLock(entry.vaultId, "recovery key"), entry.vaultId);
  }
}

/**
 * The sessions with `entry` last, which is the one the window shows. The session that was on screen before it loses a new recovery key it was showing (29b), with
 * its questions: the person is leaving it unsaved, and the shell's mark makes that vault's next unlock say so (21f). Every path that changes the foreground session
 * goes through here.
 */
function withFront(sessions: readonly SessionData[], entry: SessionData): SessionData[] {
  const before = sessions.at(-1);
  const rest = sessions.filter((one) => one.session !== entry.session).map((one) => (one.session === before?.session ? withoutVoluntaryKey(one) : one));
  return [...rest, entry];
}

/** The sessions with `entry` just behind the last, which is the window on screen and stays so. With none open, `entry` is the only one and so the window. */
function withBehind(sessions: readonly SessionData[], entry: SessionData): SessionData[] {
  const rest = sessions.filter((one) => one.session !== entry.session);
  const front = rest.at(-1);
  return front === undefined ? [entry] : [...rest.slice(0, -1), entry, front];
}

// ---- Unlock another vault from inside (Plan 4C Task 6) ----
//
// A locked vault of the list is a row of the vault menu and a button of the vault strip. Choosing it opens its unlock step (`startUnlockStep`), which is the lock screen's
// form for that one vault, with Back: the vaults that are open stay open and are not touched. The password is typed once and goes with the vault's registry ID
// (`unlockInStep`); it is the step's own state and is wiped as it is sent, so nothing here holds one. An answer lands on the vault it was asked for, and takes the window
// only while a step for that vault is still up: Back, or a step for another vault, leaves the screen as it is and holds the vault open behind it.

/** The number of the last unlock step begun. */
let unlockOpenings = 0;

/**
 * Opens the unlock step of a listed vault, with another vault open. Nothing is sent. A vault that is not on the list, one that is not available, a vault that is open
 * already (a stale button: it is brought to the front instead, unless the step is from Copy to a vault, which changes nothing) and a page with no vault open (the lock
 * screen has its own list) open nothing. `stay` is Copy to a vault's: see {@link UnlockStep}.
 */
export function startUnlockStep(vault: number, stay = false): void {
  const listed = state.vaults?.find((entry) => entry.id === vault);
  if (listed?.available !== true || state.sessions.length === 0) return;
  const open = state.sessions.find((entry) => entry.vaultId === vault);
  if (open !== undefined) {
    if (!stay) showSession(open.session);
    return;
  }
  unlockOpenings += 1;
  set({ ...state, unlockStep: { opening: unlockOpenings, vault, list: listed.list, stay } });
}

/** Back, on the unlock step: the step goes and the window that was on screen is back. A password still out is not taken back: its answer is held behind that window. */
export function leaveUnlockStep(): void {
  if (state.unlockStep !== null) set({ ...state, unlockStep: null });
}

/**
 * The unlock step's Unlock, with the password typed: sends the vault's registry ID and the text, once, and nothing else; the screen wipes its box as it calls this. `"opened"`
 * when the vault is on the page (on screen, or behind the window that was, see {@link UnlockStep}), `"stale"` when the step was left before the send, or the vault locked
 * again before the answer was read, which is not an error. A refusal (a wrong password) is thrown for the step to say.
 */
export async function unlockInStep(opening: number, password: string): Promise<"opened" | "stale"> {
  const step = state.unlockStep;
  if (step?.opening !== opening || password === "") return "stale";
  const { vault } = step;
  let answer: api.Tagged<api.UnlockView>;
  try {
    answer = await api.unlockVault({ list: step.list, id: vault }, password);
  } catch (error) {
    // A lock of every vault, or the window's close, that lands during the unlock is refused as locked: no session exists yet for a lock event to clear.
    if (error instanceof api.StaleAnswer || refusedAsLocked(error)) return "stale";
    throw error;
  }
  // A step for this same vault is up (the one that asked, or one opened again after Back): the vault is what it was waiting for. Any other screen is left as it is.
  const waiting = state.unlockStep?.vault === vault ? state.unlockStep : null;
  const held = sessionOf(answer.session);
  if (held?.generation === answer.generation) {
    // Held already (two steps for one vault, answered twice): nothing is made twice.
    if (waiting !== null) {
      set({ ...state, unlockStep: null });
      if (!waiting.stay) showSession(answer.session);
    }
    return "opened";
  }
  return publishUnlock(answer, vault, waiting === null || waiting.stay ? "behind" : "front", waiting !== null, step.list);
}

/** A lock epoch (Lock all, an idle lock, Windows locking or sleeping): every vault is about to lock, so the step has no window to go back to. */
function takeUnlockEpoch(): void {
  if (state.unlockStep !== null) set({ ...state, unlockStep: null });
}

/** The unlock step as the screens read it: `null` while none is up. */
export function useUnlockStep(): UnlockStep | null {
  return useSelect((current) => current.unlockStep);
}

// ---- Make another vault, or add one, from inside (Plan 4C Task 7) ----
//
// New vault and Add existing vault folder are actions of the vault menu, with other vaults open. New vault is setup's two steps again: its form (step 1 of 2, with Back)
// takes the window until it is left, and the vault it makes comes up on its own recovery key (step 2 of 2) as a first vault's does, with the vaults that were open still
// open behind it (`finishCreate`). Add existing vault folder runs the same add as 26a's "A vault folder", with the same cloud question, and opens the added vault's unlock
// step. Neither holds a password: the form's is its own state, wiped as it is sent. A lock epoch takes both, and the last lock does too.

/** The number of the last new-vault form begun. */
let newVaultOpenings = 0;

/**
 * Opens the new vault's form, over the window on screen: nothing is sent. A page with no vault open (the first screen has its own form), a form already up and an add
 * that is under way open nothing. An unlock step that was up is replaced by it.
 */
export function startNewVault(): void {
  if (state.sessions.length === 0 || state.newVault !== null || state.addFolder !== null) return;
  newVaultOpenings += 1;
  set({ ...state, newVault: { opening: newVaultOpenings }, unlockStep: null });
}

/** Back, on the new vault's form: the form goes and the window that was on screen is back. Nothing was sent, and the form's own state goes with it. */
export function leaveNewVault(): void {
  if (state.newVault !== null) set({ ...state, newVault: null });
}

/** A lock epoch (Lock all, an idle lock, Windows locking or sleeping): every vault is about to lock, so these steps have no window to go back to. */
function takeNewVaultEpoch(): void {
  if (state.newVault !== null || state.addFolder !== null || state.addRefusal !== null) set({ ...state, newVault: null, addFolder: null, addRefusal: null });
}

/** The new vault's form as the screens read it: `null` while none is up. */
export function useNewVault(): NewVault | null {
  return useSelect((current) => current.newVault);
}

/** Add existing vault folder's step as the screens read it: `null` while none is up. */
export function useAddFolder(): AddFolder | null {
  return useSelect((current) => current.addFolder);
}

/** The number of the last Add existing vault folder begun. */
let addFolderOpenings = 0;

/**
 * Add existing vault folder, from the vault menu: Windows' folder picker opens at once (nothing is drawn for it, the window stays), and what comes of it is one of: the
 * picker closed (nothing), a refusal (said in words on the window, where nothing was changed), a cloud-synced folder (the first screens' question, `cloud`), or the folder
 * added, which opens that vault's unlock step. Nothing is sent when a step is already up or no vault is open.
 *
 * From the lock screen (`"lock"`, 01a's second row) it needs no open session: the cloud question is drawn in the lock screen's place, a refusal is kept (`addRefusal`) for
 * the lock screen's own line instead of a toast, and a folder that was added is the vault the lock screen chooses next (`unlockPick`), its password box focused.
 */
export function startAddFolder(from: "window" | "lock" = "window"): void {
  // A menu item hands its click to whatever it calls: anything but "lock" is the window's own add.
  const where = from === "lock" ? "lock" : "window";
  if (state.addFolder !== null) return;
  if (where === "window" && (state.sessions.length === 0 || state.newVault !== null)) return;
  if (where === "lock" && state.sessions.length > 0) return;
  addFolderOpenings += 1;
  const opening = addFolderOpenings;
  set({ ...state, addFolder: { opening, from: where, phase: "picking" }, addRefusal: null });
  void runAddFolder(opening, () => api.addExistingVault());
}

/** The cloud question's yes: the token it was given goes back, and the add goes on. */
export function confirmAddFolder(opening: number, token: string): Promise<void> {
  return runAddFolder(opening, () => api.addExistingVaultConfirm(token));
}

/** The cloud question's "Choose another": the picker opens again. */
export function chooseAnotherFolder(opening: number): Promise<void> {
  return runAddFolder(opening, () => api.addExistingVault());
}

/** The cloud question's Cancel: nothing was done, and the window that was on screen is back. */
export function leaveAddFolder(opening: number): void {
  if (state.addFolder?.opening === opening) set({ ...state, addFolder: null });
}

/**
 * What one asking of the shell for an add came to. An answer that comes after a lock epoch took the step does nothing here (the list is read again all the same, so the
 * vault that was added is on it).
 */
async function runAddFolder(opening: number, run: () => Promise<api.Outcome<VaultEntry>>): Promise<void> {
  // Read again after each wait: the page's state moves on meanwhile (a lock epoch takes the step).
  const stillUp = (): boolean => state.addFolder?.opening === opening;
  if (!stillUp()) return;
  const got: { id: number | null } = { id: null };
  let result: SetupResult;
  try {
    result = await finishAdd(async () => {
      const answer = await run();
      if (answer !== "Dismissed" && "Done" in answer) got.id = answer.Done.id;
      return answer;
    });
  } catch (error) {
    if (!stillUp()) return;
    // A lock the page had not heard of is no refusal to say.
    if (state.addFolder?.from === "lock") {
      set({ ...state, addFolder: null, addRefusal: refusedAsLocked(error) ? null : error });
      return;
    }
    const front = state.sessions.at(-1);
    set({ ...state, addFolder: null, toast: refusedAsLocked(error) ? state.toast : { kind: "failed", session: front?.session ?? null, error } });
    return;
  }
  const from = state.addFolder?.from;
  if (!stillUp() || from === undefined) return;
  if (typeof result === "object") {
    set({ ...state, addFolder: { opening, from, phase: "cloud", token: result.confirm } });
    return;
  }
  // From the lock screen the vault added is the one it chooses next; from a window it opens its unlock step.
  set({ ...state, addFolder: null, unlockPick: from === "lock" && result === "done" && got.id !== null ? got.id : state.unlockPick });
  if (from === "window" && result === "done" && got.id !== null) startUnlockStep(got.id);
}

// ---- Remove, Show in Explorer and Try again (Plan 4C Task 9) ----
//
// A vault of the list can be taken off it (its folder stays), shown in Explorer, and, when its folder or drive isn't there, tried again. Every one names the row as the list
// gave it (`{ list, id }`, taken from a `VaultEntry` the page holds), never an ID made up from a number, and the page never sends or holds a path.

/**
 * Remove from list: the shell locks the vault when it is open, then takes it off the list, and the folder and everything in it stay. Done, the page lets go of everything
 * it held for that vault (its session record if the lock event has not come yet, its unlock step or recovery flow with the checked key, what the lock screen was
 * saying about it) and reads the list again; when that read fails, the row is taken out of the held list all the same. A refusal (it is busy, the row has gone, the list
 * can't be written) reads the list again and comes back as `{ failed }`, for the box to say in words, and the vault stays as it was.
 */
export async function removeVault(vault: api.VaultRef): Promise<"done" | { failed: unknown }> {
  const wasOpen = state.sessions.some((entry) => entry.vaultId === vault.id);
  try {
    await api.forgetVault(vault);
  } catch (error) {
    await refreshVaults();
    // The shell locks an open vault before it writes the list, so a write that failed afterwards leaves the vault locked and listed, and the window the box was in has gone with
    // the lock: the refusal is said on the window that is left, since the box can't say it.
    const front = state.sessions.at(-1);
    if (wasOpen && front !== undefined && !state.sessions.some((entry) => entry.vaultId === vault.id)) {
      set({ ...state, toast: { kind: "failed", session: front.session, error } });
    }
    return { failed: error };
  }
  for (const entry of state.sessions.filter((one) => one.vaultId === vault.id)) dropSession(entry.session);
  const flow = state.forgot;
  const leavesForgot = flow !== null && flow.vault === vault.id;
  set({
    ...state,
    unlockStep: state.unlockStep?.vault === vault.id ? null : state.unlockStep,
    forgot: leavesForgot ? null : state.forgot,
    lockNotes: state.lockNotes.filter((note) => note.vault !== vault.id),
    unlockPick: state.unlockPick === vault.id ? null : state.unlockPick,
  });
  // A key that was checked for this vault waits in the shell for a new password nobody will set: it is let go.
  if (flow !== null && leavesForgot && flow.choice !== null) forgetRecovery(flow.choice);
  const list = await refreshVaults();
  if (list === null) set({ ...state, vaults: (state.vaults ?? []).filter((entry) => entry.id !== vault.id) });
  return "done";
}

/**
 * Asks the shell to show the vault's folder in Explorer; gives `null` when it did, or the refusal as the page says it (`{ failed }`). A refusal that says the row or its folder
 * is gone reads the list again first, so the row then reads unavailable or goes. A list entry that is not a plain folder is the page's own words (`show_not_a_folder`).
 */
async function showFolder(vault: api.VaultRef): Promise<{ failed: unknown } | null> {
  try {
    await api.showVaultInExplorer(vault);
    return null;
  } catch (error) {
    if (refusedWith(error, "not_found")) await refreshVaults();
    const folder = refusedWith(error, "invalid_input") && (error as { what?: unknown }).what === "folder";
    return { failed: folder ? SHOW_NOT_A_FOLDER : error };
  }
}

/** The page's own refusal for a list entry that is not a plain folder; `messages.ts` has its words. */
const SHOW_NOT_A_FOLDER = { code: "page", kind: "show_not_a_folder" };

/** The vault menu's Show in Explorer: a refusal is the message bar's, on the window that is on screen. Nothing is drawn when the folder opens. */
export async function showVaultInExplorer(vault: api.VaultRef): Promise<void> {
  const outcome = await showFolder(vault);
  if (outcome === null) return;
  const front = state.sessions.at(-1);
  set({ ...state, toast: { kind: "failed", session: front?.session ?? null, error: outcome.failed } });
}

/** Show in Explorer on the unlock step and Ask 8 (no message bar there): `"done"`, or the refusal for the screen's own line. */
export async function showVaultFolder(vault: api.VaultRef): Promise<"done" | { failed: unknown }> {
  return (await showFolder(vault)) ?? "done";
}

/**
 * Try again on an unavailable vault: the list is read again. `"back"` when the vault's row is available now, `"still"` when it is not, `"gone"` when the list has no such row
 * any more, `{ failed }` when the list could not be read (the refusal the page keeps for the lock screen's line).
 */
export async function tryVaultAgain(id: number): Promise<"back" | "still" | "gone" | { failed: unknown }> {
  const list = await refreshVaults();
  if (list === null) return { failed: state.startError };
  const row = list.find((entry) => entry.id === id);
  if (row === undefined) return "gone";
  return row.available ? "back" : "still";
}

/** The lock screen's add: its refusal, as the shell sent it, or `null` (see {@link StoreState.addRefusal}). */
export function useAddRefusal(): unknown {
  return useSelect((current) => current.addRefusal);
}

/**
 * Brings an open session to the front: the window shows the last of the sessions, so it goes last. Nothing else about any session changes. An Open a backup panel that was
 * waiting for a password in the window that is left goes with it (its choice is let go); one that is opening carries on, and its backup comes to the front when it is open.
 */
export function showSession(session: number): void {
  const entry = sessionOf(session);
  const current = state.sessions.at(-1);
  if (entry === undefined || current === undefined || current.session === session) return;
  const flow = state.openBackup;
  const leaving = flow !== null && flow.host === current.session && flow.phase === "ask";
  set({ ...state, sessions: withFront(state.sessions, entry), openBackup: leaving ? null : state.openBackup });
  if (leaving) {
    letGoOfOpen(flow);
    closeOpenPanel(flow.host);
  }
}

/**
 * What a copy out of an open backup (or older copy) into a vault came to, for the form to say: `done` (the vault's name, and the names of the files left out), `missing` (the
 * backup lacks these files: nothing was copied, and 25d asks), `refused` (the shell's refusal, for `messageFor`) or `stale` (a session locked meanwhile: nothing to say).
 */
export type CopyOut = { done: { name: string; leftOut: string[] } } | { missing: string[] } | { refused: unknown } | "stale";

/**
 * Copy to a vault: the item `id` of the session `from` goes into the vault `to`, in its folder `folder` (`null` for none). With `skipMissing` false the shell asks first when the
 * backup lacks files attached to the item; sent again with it, the item copies without them. The vault's list is read again, and the window stays on the session it was on. Says
 * "Copied to <vault>." in the page's spoken place when it is done.
 */
export async function copyItemOut(from: api.SessionRef, id: string, to: number, folder: string | null, skipMissing: boolean): Promise<CopyOut> {
  // The source is the session and generation the copy (or the question) was begun in, never whatever is on screen now: if it is not that one any more, nothing is sent.
  if (!stillOpen(from.session, from.generation)) return "stale";
  const target = sessionOf(to);
  if (target === undefined || target.readOnly) return "stale";
  let answer;
  try {
    answer = await api.copyItemTo(from, id, { session: to, generation: target.generation }, folder, skipMissing);
  } catch (error) {
    // The lock events clear the sessions that locked; a refusal as locked, or an answer made stale by one, has nothing to say.
    if (error instanceof api.StaleAnswer || refusedAsLocked(error)) return "stale";
    return { refused: error };
  }
  if (!stillOpen(from.session, from.generation) || !stillOpen(to, target.generation)) return "stale";
  const outcome = answer.data;
  if (typeof outcome === "object" && "Done" in outcome) {
    const record = sessionOf(to);
    if (record !== undefined) void loadItems(record, { quiet: true });
    const leftOut = outcome.Done.left_out;
    say(from.session, leftOut.length === 0 ? `Copied to ${target.name}.` : `Copied to ${target.name}, without the files the backup doesn't have.`);
    return { done: { name: target.name, leftOut } };
  }
  if (typeof outcome === "object" && "Confirm" in outcome && typeof outcome.Confirm === "object" && "MissingFiles" in outcome.Confirm) {
    return { missing: outcome.Confirm.MissingFiles.names };
  }
  return { refused: UNEXPECTED };
}

// ---- Restore a backup (24a to 24e) ----
//
// The backup is picked first, in Windows' own dialog that Rust opens, and Rust holds its path under a choice. The password or recovery key is typed once and
// sent with the choice to check the backup (`restoreCheck`); Rust keeps the working credential beside the pick, so the page never holds it after it is sent.
// Then the folder, the copy (a job with a bar and a Cancel), the question when a vault is replaced, and the swap (a job with no Cancel). Every answer is
// matched to the step it was asked in (`opening` and `run`): one that comes after the flow was left or moved on comes to nothing.

/** The number of the last time Restore a backup was begun, and of the last step taken in any of them. */
let restoreOpenings = 0;
let restoreRuns = 0;

/** What the first step says after a copy was stopped (Cancel, Windows locking or sleeping, Lock all, closing): `messages.ts` has its words. */
const RESTORE_CANCELLED = { code: "page", kind: "restore_cancelled" };

/** The flow's first step, waiting for the picker (`pick` is `null`) or with a backup picked. */
function newRestore(
  opening: number,
  run: number,
  pick: api.RestorePick | null,
  vault: number | null,
  beside: RestoreFlow["beside"],
  origin: RestoreOrigin | null = null,
): RestoreFlow {
  return {
    opening,
    run,
    vault,
    beside,
    phase: pick === null ? "picking" : "pick",
    choice: pick?.choice ?? null,
    fileName: pick?.file_name ?? null,
    size: pick?.size ?? 0,
    busy: false,
    origin,
    problem: null,
    checked: null,
    request: null,
    token: null,
    suggested: "",
    prepared: null,
    restored: null,
    refusedAs: "again",
    lockEnded: false,
  };
}

/** Whether the restore the caller began is still at the step it was in. */
function restoreStill(opening: number, run: number): boolean {
  return state.restore?.opening === opening && state.restore.run === run;
}

/**
 * Takes the flow to its next step while it is still at `run`: the changes are made and the run number moves on, so an answer to the step before is
 * dropped. Returns the new run, or `null` when the flow had been left or had moved on.
 */
function moveRestore(opening: number, run: number, change: (flow: RestoreFlow) => Partial<RestoreFlow>): number | null {
  const flow = state.restore;
  if (flow?.opening !== opening || flow.run !== run) return null;
  restoreRuns += 1;
  set({ ...state, restore: { ...flow, ...change(flow), run: restoreRuns } });
  return restoreRuns;
}

/** What the first step says when the shell has let the picked backup go, and nothing is picked: the same words as Test a backup's. */
function noFile(problem: unknown): Partial<RestoreFlow> {
  return { phase: "pick", busy: false, choice: null, fileName: null, size: 0, checked: null, request: null, token: null, problem };
}

/** A pick the page no longer has a place for (the flow was left, or a lock came while the picker was open): the shell is told to forget it. */
function forgetRestoreStray(choice: string): void {
  void api.forgetRestorePick(choice).catch(() => undefined);
}

/**
 * Settings' and the lock screen's "Restore a backup": opens Windows' picker for the backup file first, and the first step opens on it, with nothing sent
 * but the pick. A closed picker says nothing and opens nothing; a lock while it was open too. Any other refusal (another restore is going) opens the first
 * step with no file and its words under the row. While the picker is open the button waits, so a second press sends nothing. From the first screen's
 * 26a (`origin`), Cancel goes back to 26a and the end is 26c; the usual folder is suggested as for every restore, and no vault need be listed.
 * With a `vault` (Ask 4's open vault, Ask 8's damaged one) the pick is made for it: the backup unpacks in that vault's own folder, not the usual one.
 */
export async function startRestore(options: RestoreStart = {}): Promise<void> {
  if (state.restore !== null) return;
  restoreOpenings += 1;
  restoreRuns += 1;
  const opening = restoreOpenings;
  const run = restoreRuns;
  const vault = options.vault ?? null;
  // A vault listed with `details_damaged` is Ask 8's: its folder can't be read, so the backup goes in a new folder beside it.
  const beside = vault === null ? null : state.vaults?.find((entry) => entry.id === vault)?.details_damaged === true ? "damaged" : "open";
  set({ ...state, restore: newRestore(opening, run, null, vault, beside, options.origin ?? null) });
  let answer: Awaited<ReturnType<typeof api.restorePick>>;
  try {
    answer = await api.restorePick(null, vault);
  } catch (error) {
    if (!restoreStill(opening, run)) return;
    if (refusedAsLocked(error)) set({ ...state, restore: null });
    else moveRestore(opening, run, () => ({ phase: "pick", problem: error }));
    return;
  }
  if (!restoreStill(opening, run)) {
    if (typeof answer === "object" && "Done" in answer) forgetRestoreStray(answer.Done.choice);
    return;
  }
  if (answer === "Dismissed") {
    set({ ...state, restore: null });
  } else if ("Done" in answer) {
    const pick = answer.Done;
    moveRestore(opening, run, () => ({ phase: "pick", choice: pick.choice, fileName: pick.file_name, size: pick.size }));
  } else {
    moveRestore(opening, run, () => ({ phase: "pick", problem: UNEXPECTED }));
  }
}

/** Pick another (and Pick a backup, when the choice has gone): the new file replaces the old one in the shell; a closed picker leaves the file as it was. */
export async function pickAnotherRestore(): Promise<void> {
  const flow = state.restore;
  if (flow === null || flow.phase !== "pick" || flow.busy) return;
  const { opening, choice } = flow;
  const run = moveRestore(opening, flow.run, () => ({ busy: true, problem: null }));
  if (run === null) return;
  try {
    // The vault the restore was started for goes again: a new pick starts from the usual folder otherwise.
    const answer = await api.restorePick(choice, flow.vault);
    if (answer === "Dismissed") {
      moveRestore(opening, run, () => ({ busy: false }));
    } else if ("Done" in answer) {
      const pick = answer.Done;
      const moved = moveRestore(opening, run, () => ({ busy: false, choice: pick.choice, fileName: pick.file_name, size: pick.size, checked: null, problem: null }));
      if (moved === null) forgetRestoreStray(pick.choice);
    } else {
      moveRestore(opening, run, () => ({ busy: false, problem: UNEXPECTED }));
    }
  } catch (error) {
    // A choice the shell let go takes the file with it: the person picks again.
    const gone = refusedWith(error, "choice_expired") || refusedAsLocked(error);
    moveRestore(opening, run, () => (gone ? noFile(TEST_CHOICE_EXPIRED) : { busy: false, problem: error }));
  }
}

/**
 * Continue, pressed on 24a with the text typed: sends the choice and the text as one box's (`password_or_key`) and nothing else. The screen wipes its box as
 * it calls this; the shell keeps the working credential beside the pick. A wrong password (or any refusal) comes back to 24a with its words and the file
 * still picked; a choice the shell no longer holds takes the file away. The backup opened, 24b follows. The check is a job the shell tells the page
 * of (`request`): Cancel at 24a (`closeRestore`) stops it by that number, even before the shell's `job-started` has arrived.
 */
export async function checkRestore(credential: string): Promise<void> {
  const flow = state.restore;
  if (flow === null || flow.phase !== "pick" || flow.busy || flow.choice === null || credential === "") return;
  const { opening, choice } = flow;
  const request = nextRequest();
  const run = moveRestore(opening, flow.run, () => ({ phase: "checking", problem: null, request }));
  if (run === null) {
    releaseRequest(request);
    return;
  }
  let checked: api.RestoreChecked | { refused: unknown };
  try {
    const answer = await api.restoreCheck(choice, { password_or_key: credential }, request);
    checked = typeof answer === "object" && typeof (answer as { name?: unknown }).name === "string" ? answer : { refused: UNEXPECTED };
  } catch (error) {
    checked = { refused: error };
  } finally {
    releaseRequest(request);
  }
  if ("refused" in checked) {
    const { refused } = checked;
    const gone = refusedWith(refused, "choice_expired") || refusedAsLocked(refused);
    moveRestore(opening, run, () => (gone ? noFile(TEST_CHOICE_EXPIRED) : { phase: "pick", problem: refused, request: null }));
  } else {
    const found = checked;
    moveRestore(opening, run, () => ({ phase: "where", checked: found, problem: null, request: null }));
  }
}

/**
 * 24b's Choose another (and the cloud question's): Windows' picker for another parent folder, opened by the shell. The question goes at once; 24b follows
 * whatever the picker comes to, with the new folder when one was chosen and the old one when it was closed.
 */
export async function chooseRestoreFolder(): Promise<void> {
  const flow = state.restore;
  if (flow === null || (flow.phase !== "where" && flow.phase !== "cloud") || flow.busy || flow.choice === null) return;
  const { opening, choice } = flow;
  const run = moveRestore(opening, flow.run, () => ({ phase: "where", busy: true, token: null, problem: null }));
  if (run === null) return;
  try {
    const answer = await api.restoreChooseFolder(choice);
    if (answer === "Dismissed") {
      moveRestore(opening, run, () => ({ busy: false }));
    } else if ("Done" in answer) {
      const found = answer.Done;
      // The person chose the folder: it is no longer the one beside the vault the restore started from.
      moveRestore(opening, run, () => ({ busy: false, checked: found, beside: null }));
    } else {
      moveRestore(opening, run, () => ({ busy: false, problem: UNEXPECTED }));
    }
  } catch (error) {
    const gone = refusedWith(error, "choice_expired") || refusedAsLocked(error);
    moveRestore(opening, run, () => (gone ? noFile(TEST_CHOICE_EXPIRED) : { busy: false, problem: error }));
  }
}

/** The copy's own end, however it came: a finished copy goes on (to its question, or straight to the swap), and every refusal has its step. */
async function copyRestore(flow: RestoreFlow, send: (request: number) => Promise<api.Outcome<api.RestorePreparedView>>): Promise<void> {
  const { opening } = flow;
  const request = nextRequest();
  const run = moveRestore(opening, flow.run, () => ({ phase: "copying", busy: false, request, problem: null, token: null, lockEnded: false }));
  if (run === null) {
    releaseRequest(request);
    return;
  }
  let ended: { answer: api.Outcome<api.RestorePreparedView> } | { refused: unknown };
  try {
    ended = { answer: await send(request) };
  } catch (error) {
    ended = { refused: error };
  } finally {
    releaseRequest(request);
  }
  if (!restoreStill(opening, run)) {
    // The flow was left meanwhile: a copy that finished is let go.
    if ("answer" in ended && typeof ended.answer === "object" && "Done" in ended.answer) void api.restoreDiscard(ended.answer.Done.restore).catch(() => undefined);
    return;
  }
  if ("refused" in ended) {
    const { refused } = ended;
    if (refusedWith(refused, "cancelled") || refusedAsLocked(refused)) {
      // A stop (the person's, Windows locking or sleeping, Lock all, closing): nothing was changed, and the shell let the pick go.
      moveRestore(opening, run, () => noFile(RESTORE_CANCELLED));
    } else if (refusedWith(refused, "choice_expired")) {
      moveRestore(opening, run, () => noFile(TEST_CHOICE_EXPIRED));
    } else if (refusedWith(refused, "invalid_input") && (refused as { what?: unknown }).what === "backup changed") {
      // The archive the copy opened is not the one that was checked: nothing was copied and the shell forgot the pick, so the person picks again.
      moveRestore(opening, run, () => noFile(refused));
    } else {
      moveRestore(opening, run, () => ({ phase: "refused", refusedAs: "again", request: null, problem: refused }));
    }
    return;
  }
  const { answer } = ended;
  if (state.restore?.lockEnded === true) {
    // A lock that is not idle came while the answer was on its way: the shell ended the finished restore (and dropped the questions), so whatever the
    // answer says is for a restore that is gone. The flow closes without a word, and a copy the shell may still hold is let go.
    set({ ...state, restore: null });
    if (typeof answer === "object" && "Done" in answer) void api.restoreDiscard(answer.Done.restore).catch(() => undefined);
    return;
  }
  if (typeof answer === "object" && "Done" in answer) {
    const view = answer.Done;
    // The shell let the pick go as the copy finished: what 24d and 24e need is in the finished copy's answer and the checked backup.
    const next = moveRestore(opening, run, () => ({
      phase: view.replaces_existing ? "replace" : "swapping",
      request: null,
      choice: null,
      prepared: view,
    }));
    if (next === null) void api.restoreDiscard(view.restore).catch(() => undefined);
    else if (!view.replaces_existing) await swapRestore(opening, next);
  } else if (typeof answer === "object" && "Confirm" in answer) {
    const question = answer.Confirm;
    if (typeof question === "object" && "CloudFolder" in question) {
      const { token } = question.CloudFolder;
      moveRestore(opening, run, () => ({ phase: "cloud", request: null, token }));
    } else if (typeof question === "object" && "NewFolder" in question) {
      const { token, suggested } = question.NewFolder;
      moveRestore(opening, run, () => ({ phase: "name", request: null, token, suggested }));
    } else if (typeof question === "object" && "Recovery" in question && askOfNotice(question.Recovery.notice) !== null) {
      // An unfinished restore's journal was still there, and the shell ran its recovery instead of copying: the flow is closed (the pick is let go) and its
      // notice is shown, whichever screen the person was on.
      const ask = askOfNotice(question.Recovery.notice);
      const held = state.restore?.choice ?? null;
      set({ ...state, restore: null, notices: { ...state.notices, restore: ask } });
      if (held !== null) forgetRestoreStray(held);
      // Recovery ran: it may have listed a restored vault or brought one back, so the list is read again.
      void refreshVaults();
    } else {
      moveRestore(opening, run, () => ({ phase: "refused", refusedAs: "again", request: null, problem: UNEXPECTED }));
    }
  } else {
    // Nothing was picked or asked: 24b as it was.
    moveRestore(opening, run, () => ({ phase: "where", request: null }));
  }
}

/** 24b's Restore: the copy of the picked backup, as a job with a bar and a Cancel. */
export async function runRestore(): Promise<void> {
  const flow = state.restore;
  if (flow === null || flow.phase !== "where" || flow.busy || flow.choice === null) return;
  const { choice } = flow;
  await copyRestore(flow, (request) => api.restorePrepare(choice, request));
}

/**
 * The answer to the question the copy asked first: the cloud folder's yes (`name` is `null`), or the new folder's name. The same copy then runs. A no is
 * `backToRestoreFolder`.
 */
export async function answerRestoreQuestion(name: string | null): Promise<void> {
  const flow = state.restore;
  if (flow === null || (flow.phase !== "cloud" && flow.phase !== "name") || flow.token === null) return;
  const { token } = flow;
  await copyRestore(flow, (request) => api.restorePrepareConfirm(token, name, request));
}

/** The swap, as a job with a bar's worth of progress and no Cancel; the vault it replaces is closed by it. A finished swap reads the vault list again, and 24e follows. */
async function swapRestore(opening: number, from: number): Promise<void> {
  const flow = state.restore;
  if (flow?.opening !== opening || flow.run !== from || flow.prepared === null) return;
  const { restore } = flow.prepared;
  const request = nextRequest();
  const run = moveRestore(opening, from, () => ({ phase: "swapping", request, problem: null }));
  if (run === null) {
    releaseRequest(request);
    return;
  }
  let ended: { restored: api.RestoredView } | { refused: unknown };
  try {
    const answer = await api.restoreCommit(restore, request);
    ended = typeof answer === "object" && typeof (answer as { vault?: unknown }).vault === "number" ? { restored: answer } : { refused: UNEXPECTED };
  } catch (error) {
    ended = { refused: error };
  } finally {
    releaseRequest(request);
  }
  if (!restoreStill(opening, run)) return;
  if ("refused" in ended) {
    const { refused } = ended;
    if (refusedWith(refused, "cancelled") || refusedAsLocked(refused)) {
      // The finished restore was ended by Windows locking, sleep, Lock all or closing: nothing was changed.
      moveRestore(opening, run, () => ({ ...noFile(RESTORE_CANCELLED), prepared: null }));
    } else {
      // The copy is made and waits: the person can only let it go.
      moveRestore(opening, run, () => ({ phase: "refused", refusedAs: "discard", request: null, problem: refused }));
    }
    return;
  }
  const { restored } = ended;
  // The restored vault may be new to the list.
  await refreshVaults();
  const done = moveRestore(opening, run, () => ({ phase: "done", request: null, restored }));
  // Begun from 26a: 26c comes in place of 24e, and its Unlock goes to 24e.
  const finished = state.restore;
  if (done !== null && finished?.origin === "first_screen") {
    const name = finished.prepared?.name ?? finished.checked?.name ?? "Your vault";
    set({ ...state, moveIn: { step: "here", how: "restore", name, vault: restored.vault } });
  }
}

/** 24d's Replace: the swap, with the finished copy the question was about. */
export function replaceRestore(): void {
  const flow = state.restore;
  if (flow === null || flow.phase !== "replace" || flow.prepared === null) return;
  void swapRestore(flow.opening, flow.run);
}

/** Takes the refusal under 24a's box away, as typing again does (a wrong password's line stays only until the next try is begun). No step is taken. */
export function clearRestoreProblem(): void {
  const flow = state.restore;
  if (flow === null || flow.phase !== "pick" || flow.problem === null) return;
  set({ ...state, restore: { ...flow, problem: null } });
}

/** 24b's Back: to 24a with the file still picked; what was typed there is in the shell, and is typed again. */
export function backToRestoreFile(): void {
  const flow = state.restore;
  if (flow === null || flow.phase !== "where" || flow.busy) return;
  moveRestore(flow.opening, flow.run, () => ({ phase: "pick", checked: null, problem: null }));
}

/** OK on a refusal of the copy, and No on the copy's questions: back to 24b, with the pick kept. */
export function backToRestoreFolder(): void {
  const flow = state.restore;
  if (flow === null || (flow.phase !== "refused" && flow.phase !== "cloud" && flow.phase !== "name") || flow.refusedAs === "discard") return;
  moveRestore(flow.opening, flow.run, () => ({ phase: "where", token: null, problem: null }));
}

/**
 * Cancel, on any step that has one: the restore goes. A check at 24a or a copy that runs is stopped (by its request, as every job's Cancel is), the shell
 * lets the pick go, and a finished copy that was not swapped is let go. Nothing of the vault changes. Where the flow had come from is what the app shows
 * next.
 */
export function closeRestore(): void {
  const flow = state.restore;
  if (flow === null) return;
  set({ ...state, restore: null });
  if ((flow.phase === "copying" || flow.phase === "checking") && flow.request !== null) cancelRequest(flow.request);
  if (flow.choice !== null) forgetRestoreStray(flow.choice);
  if (flow.prepared !== null && flow.restored === null && flow.phase !== "swapping") void api.restoreDiscard(flow.prepared.restore).catch(() => undefined);
}

/**
 * 24e's Unlock: the restored vault, with the password from when the backup was made. A refusal (a wrong password) is thrown for the screen to say, and the
 * step stays. Once the vault is open the restore is over, and the app shows the vault.
 */
export async function unlockRestored(password: string): Promise<"opened" | "stale"> {
  const flow = state.restore;
  if (flow === null || flow.phase !== "done" || flow.restored === null) return "stale";
  const { opening } = flow;
  // The row is the one the list gave, read again after the restore: no row, nothing is sent.
  const row = state.vaults?.find((entry) => entry.id === flow.restored?.vault);
  if (row === undefined) {
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- a refusal is a plain object, as the shell's are
    throw { code: "not_found" };
  }
  const result = await unlock({ list: row.list, id: row.id }, password, true);
  if (result === "opened" && state.restore?.opening === opening) set({ ...state, restore: null });
  return result;
}

/**
 * A lock epoch (Lock all, an idle lock, Windows locking or sleeping, the app closing), as the restore's steps meet it. Before the copy, the shell dropped
 * the pick whatever the reason, so the flow goes back to the first step with nothing picked. A finished restore waits through an idle lock, which the
 * shell lets it do, and is gone for every other reason (the shell discarded it), so 24d goes away without a word. The copy's and the swap's own answers
 * say how they ended.
 */
function takeRestoreEpoch(event: LockEpochEvent): void {
  const flow = state.restore;
  if (flow === null) return;
  const { opening, run } = flow;
  switch (flow.phase) {
    case "pick":
    case "checking":
    case "where":
    case "cloud":
    case "name":
      moveRestore(opening, run, () => noFile(TEST_CHOICE_EXPIRED));
      break;
    case "refused":
      if (flow.refusedAs === "again") moveRestore(opening, run, () => noFile(TEST_CHOICE_EXPIRED));
      else if (event.reason !== "idle") set({ ...state, restore: null });
      break;
    case "replace":
    case "older":
      if (event.reason !== "idle") set({ ...state, restore: null });
      break;
    case "copying":
      // The copy's own answer says how it ended, and a refusal (`locked`, `cancelled`) takes the flow back to the first step. A copy that had finished is
      // another matter: its successful answer may be on its way when the lock lands, and the shell has ended what it made. The run is not moved on (the
      // answer is still the one this step waits for); the flag says not to act on it. An idle lock leaves a finished restore, so it leaves this too.
      if (event.reason !== "idle") set({ ...state, restore: { ...flow, lockEnded: true } });
      break;
    default:
      break;
  }
}

/** Restore a backup as the screens read it: `null` while none is begun. */
export function useRestore(): RestoreFlow | null {
  return useSelect((current) => current.restore);
}

// ---- Forgot password (Plan 4C Task 4: 28a to 28e) ----
//
// Two steps, as the shell has them. The recovery key is typed once and sent with the listed vault's registry ID (`recoverCheck`): the shell reads its form, checks
// that it opens this vault's recovery slot, and holds it under a choice. The new password is typed once and sent with the choice (`recoverFinish`): the shell
// sets it, and only then opens the vault. What is typed is the screen's own state and is wiped as it is sent, so nothing here holds a key or a password: only the
// choice's token, which the shell gave. Every answer is matched to the step it was asked in (`opening` and `run`): one that comes after the flow was left or moved
// on comes to nothing, and a choice it brings is let go at once. A lock epoch drops the shell's choice, so the flow goes back to the key with nothing typed.

/** The number of the last time Forgot password was begun, and of the last step taken in any of them. */
let forgotOpenings = 0;
let forgotRuns = 0;

/** The page's own refusal for a key the shell read as a key that doesn't open the vault (`wrong_password`); `messages.ts` has the design's words for it. */
const KEY_DOES_NOT_OPEN = { code: "page", kind: "recovery_key_does_not_open" };

/** The page's own refusal for a choice the shell no longer holds, or details that changed since the check; `messages.ts` has its words. */
const RECOVERY_CHOICE_EXPIRED = { code: "page", kind: "recovery_choice_expired" };

/** The flow at its first step, with nothing checked and nothing said: where a lock, a refused finish or Back leaves it. */
const AT_THE_KEY: Pick<ForgotFlow, "phase" | "checking" | "sending" | "problem" | "passwordProblem" | "choice" | "name" | "accepted"> = {
  phase: "key",
  checking: false,
  sending: false,
  problem: null,
  passwordProblem: null,
  choice: null,
  name: null,
  accepted: false,
};

/** Whether the flow the caller began is still at the step it was in. */
function forgotStill(opening: number, run: number): boolean {
  return state.forgot?.opening === opening && state.forgot.run === run;
}

/**
 * Takes the flow to its next step while it is still at `run`: the changes are made and the run number moves on, so an answer to the step before is dropped.
 * Returns the new run, or `null` when the flow had been left or had moved on.
 */
function moveForgot(opening: number, run: number, change: (flow: ForgotFlow) => Partial<ForgotFlow>): number | null {
  const flow = state.forgot;
  if (flow?.opening !== opening || flow.run !== run) return null;
  forgotRuns += 1;
  set({ ...state, forgot: { ...flow, ...change(flow), run: forgotRuns } });
  return forgotRuns;
}

/** Lets a checked key go: the shell drops the choice (a choice already gone is no error, and nothing is said of a failure to ask). */
function forgetRecovery(choice: string): void {
  void api.recoverForget(choice).catch(() => undefined);
}

/**
 * The lock screen's "Forgot password?": 28a for the vault chosen there, by its registry ID. Nothing is sent by opening it. A vault that is not on the list
 * opens nothing, and one flow is open at a time.
 */
export function startForgot(vault: number): void {
  const listed = state.vaults?.find((entry) => entry.id === vault);
  if (state.forgot !== null || listed === undefined) return;
  forgotOpenings += 1;
  forgotRuns += 1;
  set({ ...state, forgot: { opening: forgotOpenings, run: forgotRuns, vault, list: listed.list, ...AT_THE_KEY, session: null } });
}

/**
 * Back on 28a, Cancel's way out of the flow: it goes, and the lock screen shows with this vault chosen. A key still out is let go by its answer (the flow it
 * was for is gone), and a choice already held is let go now. The flow can't be left while the new password is out, whose answer is the flow's own. On 28e it
 * is "Not now" (see `finishForgot`).
 */
export function closeForgot(): void {
  const flow = state.forgot;
  if (flow === null || flow.sending || flow.phase === "done") return;
  // Begun from a vault's unlock step (another vault open), Back gives that step back as it was, and leaves the lock screen nothing to choose later.
  set({ ...state, forgot: null, unlockPick: state.sessions.length === 0 ? flow.vault : state.unlockPick });
  if (flow.choice !== null) forgetRecovery(flow.choice);
}

/** 28a's "I don't have my recovery key": 28c. Not while a key is out. */
export function noRecoveryKey(): void {
  const flow = state.forgot;
  if (flow === null || flow.phase !== "key" || flow.checking) return;
  moveForgot(flow.opening, flow.run, () => ({ phase: "no_key", problem: null }));
}

/** Back, on 28c and 28d (and No to the changed details): 28a with nothing typed, and the checked key, if one is held, let go. */
export function backToForgotKey(): void {
  const flow = state.forgot;
  if (flow === null || flow.sending || flow.checking || (flow.phase !== "no_key" && flow.phase !== "password" && flow.phase !== "changed")) return;
  const { choice } = flow;
  moveForgot(flow.opening, flow.run, () => ({ ...AT_THE_KEY }));
  if (choice !== null) forgetRecovery(choice);
}

/** The person has begun to mend what 28b or 28d said was wrong: the line goes. */
export function clearForgotProblem(): void {
  const flow = state.forgot;
  if (flow === null || (flow.problem === null && flow.passwordProblem === null)) return;
  set({ ...state, forgot: { ...flow, problem: null, passwordProblem: null } });
}

/**
 * 28a's Continue, with the key typed: sends the vault's registry ID and the text, once, and nothing else. The screen keeps the key in its box, read-only, until
 * the answer. The key's own refusals (a typo, a word that is no listed word, a wrong count) and every other refusal come back to 28a with their words, the key
 * still in the box to be mended (Plan 4C Task 13c); an accepted key moves the flow on, and the screen wipes it; the shell's
 * `wrong_password` is the page's "doesn't open this vault", since it is the same to the person for another vault's key and an old one. A key that opens
 * the vault goes to 28d, or to the question about details changed outside Lockbox first when the shell says so.
 */
export async function checkRecoveryKey(key: string): Promise<void> {
  const flow = state.forgot;
  if (flow === null || flow.phase !== "key" || flow.checking || key === "") return;
  const { opening, vault, list } = flow;
  const run = moveForgot(opening, flow.run, () => ({ checking: true, problem: null }));
  if (run === null) return;
  let answer: api.RecoveryCheckView;
  try {
    answer = await api.recoverCheck({ list, id: vault }, key);
  } catch (error) {
    if (!forgotStill(opening, run)) return;
    // A lock that overtook the check leaves nothing to say: the key is typed again.
    const wrong = refusedWith(error, "core") && (error as { kind?: unknown }).kind === "wrong_password";
    moveForgot(opening, run, () => ({ ...AT_THE_KEY, problem: refusedAsLocked(error) ? null : wrong ? KEY_DOES_NOT_OPEN : error }));
    return;
  }
  if (!forgotStill(opening, run)) {
    // The flow was left (Back, a lock) while the key was out: the shell holds a choice nobody will use.
    forgetRecovery(answer.choice);
    return;
  }
  moveForgot(opening, run, () => ({
    checking: false,
    choice: answer.choice,
    name: answer.vault_name,
    phase: answer.kind === "header_changed" ? "changed" : "password",
  }));
}

/**
 * The question about details changed outside Lockbox (Ask 3's words), asked before the new password. Yes goes to 28d, and the yes goes to the shell with the
 * password; No lets the key go and is 28a again, with nothing changed.
 */
export function answerChangedDetails(yes: boolean): void {
  const flow = state.forgot;
  if (flow === null || flow.phase !== "changed") return;
  if (yes) moveForgot(flow.opening, flow.run, () => ({ phase: "password", accepted: true }));
  else backToForgotKey();
}

/**
 * 28d's Set new password, with the password typed (once: the screen has checked it is long enough and that the two match, and wipes its boxes as it calls this).
 * The choice and the password go to the shell, and the shell sets it and opens the vault. A second press while it is out sends nothing.
 *
 * - **Done:** the vault is published as an unlock publishes it (`publishUnlock`) and 28e's offer of a fresh backup shows over it.
 * - **A new password the shell calls too short, or the changed details not accepted:** said on 28d; the shell kept the choice.
 * - **The choice gone (`choice_expired`), or any other refusal:** the shell used the choice up, so the key is typed again on 28a, with the refusal said there.
 * - **A lock before the password was written (`locked`):** nothing changed and nothing is said; 28a, empty.
 * - **A lock after it was written** (`locked_after_change` with the vault's registry ID, or the shell's good answer dropped by the bridge as from before the lock):
 *   the new password is in effect, so Ask 16 is kept for that vault's unlock and the flow ends at the lock screen.
 */
export async function finishRecovery(newPassword: string): Promise<void> {
  const flow = state.forgot;
  if (flow === null || flow.phase !== "password" || flow.sending || flow.choice === null) return;
  const { opening, vault, choice, accepted } = flow;
  const run = moveForgot(opening, flow.run, () => ({ sending: true, passwordProblem: null }));
  if (run === null) return;
  let answer: api.Tagged<api.UnlockView>;
  try {
    answer = await api.recoverFinish(choice, newPassword, accepted);
  } catch (error) {
    if (error instanceof api.StaleAnswer || refusedWith(error, "locked_after_change")) {
      const named = refusedWith(error, "locked_after_change") ? (error as { vault?: unknown }).vault : undefined;
      const landed = typeof named === "number" && Number.isInteger(named) && named > 0 ? named : vault;
      sayOnLockScreen(landedBeforeLock(landed), landed);
      if (state.forgot?.opening === opening) set({ ...state, forgot: null, unlockPick: vault });
      return;
    }
    if (!forgotStill(opening, run)) return;
    const kind = refusedWith(error, "core") ? (error as { kind?: unknown }).kind : undefined;
    const keptShort = kind === "password_too_short";
    const keptHeader = refusedWith(error, "invalid_input") && (error as { what?: unknown }).what === "header changed on disk";
    if (keptShort || keptHeader) {
      moveForgot(opening, run, () => ({ sending: false, passwordProblem: { field: keptShort ? "new" : "form", error } }));
      return;
    }
    // The page lets go of its handle on the key here, so it tells the shell too: usually the shell already dropped it (a harmless success), but a refusal that
    // came before the shell took the choice (an IPC failure) would leave the key held for five minutes.
    forgetRecovery(choice);
    moveForgot(opening, run, () => ({
      ...AT_THE_KEY,
      problem: refusedAsLocked(error) ? null : refusedWith(error, "choice_expired") ? RECOVERY_CHOICE_EXPIRED : error,
    }));
    return;
  }
  // The password is set and the vault is open: published as an unlock publishes it, and 28e shows over it. Begun from that vault's unlock step (another vault open),
  // the vault comes to the front and the step it was begun from goes, as an unlock from the step ends it.
  void publishUnlock(answer, vault, "front", state.unlockStep?.vault === vault);
  moveForgot(opening, run, () => ({ phase: "done", sending: false, choice: null, session: answer.session }));
}

/** 28e's answer: Back up now opens 22a for the vault that was opened, Not now only closes the offer. Either way the flow is over. */
export function finishForgot(backUp: boolean): void {
  const flow = state.forgot;
  if (flow?.phase !== "done") return;
  set({ ...state, forgot: null });
  if (backUp && flow.session !== null) openBackup(flow.session);
}

/**
 * A lock epoch (Lock all, an idle lock, Windows locking or sleeping, the app closing): the shell dropped the checked key, so the steps that hold or wait for
 * one are 28a again, with nothing said, and the answer of a key still out is let go when it comes. A new password that is out is the flow's own: its answer says
 * whether the lock came before or after the password was written. 28c and 28e hold nothing the lock took.
 */
function takeForgotEpoch(): void {
  const flow = state.forgot;
  if (flow === null || flow.sending) return;
  if (flow.phase === "key" || flow.phase === "changed" || flow.phase === "password") moveForgot(flow.opening, flow.run, () => ({ ...AT_THE_KEY }));
}

/** Forgot password as the screens read it: `null` while it is not begun. */
export function useForgot(): ForgotFlow | null {
  return useSelect((current) => current.forgot);
}

// ---- Moving to a new computer (26a to 26c) ----

/** The first screen's "I already have a vault or a backup": 26a. */
export function openMoveIn(): void {
  if (state.moveIn !== null) return;
  set({ ...state, moveIn: { step: "what" } });
}

/** 26a's Back: the steps close, and the app shows the first screen, or the lock screen when a vault has come in. Nothing happens while a backup is being picked or restored. */
export function leaveMoveIn(): void {
  if (state.moveIn?.step !== "what" || state.restore !== null) return;
  set({ ...state, moveIn: null });
}

/** 26c's Bring in another vault: back to 26a. A restore that finished is over (its vault is listed and stays). */
export function bringInAnother(): void {
  if (state.moveIn?.step !== "here") return;
  if (state.restore !== null) closeRestore();
  set({ ...state, moveIn: { step: "what" } });
}

/**
 * 26c's Unlock: after a restore, the restore's own 24e (the password from when the backup was made); after a folder, the lock screen with that vault chosen
 * and its password field ready. Either way the moving-in steps are over.
 */
export function unlockBroughtIn(): void {
  const here = state.moveIn;
  if (here?.step !== "here") return;
  set({ ...state, moveIn: null, unlockPick: here.how === "folder" ? here.vault : null });
}

/** The moving-in steps as the screens read them: `null` while they are not open. */
export function useMoveIn(): MoveIn | null {
  return useSelect((current) => current.moveIn);
}

/** The vault the lock screen is to choose when it opens, once (see `clearUnlockPick`). */
export function useUnlockPick(): number | null {
  return useSelect((current) => current.unlockPick);
}

/** The lock screen has taken the vault it was asked to choose. */
export function clearUnlockPick(): void {
  if (state.unlockPick !== null) set({ ...state, unlockPick: null });
}

// ---- Older copies (Plan 4B Task 8: 24f and 24g) ----
//
// A restore keeps the vault it replaced beside the restored one. The shell lists those copies (`list_pre_restore`) and replaces every ID at each listing, so the page
// holds one listing, here: it is read again when Settings opens, when 24f opens and after each delete or open, and a button names its copy by the vault and the folder's
// name, which this store turns into the ID of the newest listing at the moment it sends. An answer of `not_found` means the listing changed under the page: it is read
// again and the screen says so. Nothing typed is kept here: the box is the screen's own state, wiped as it is sent.

/**
 * The place on the vault list of a session that is not a vault's own: an older copy opened read-only. It is no listed vault's, so the places that mark a vault
 * open (the side menu, the window's locked line, the search) never count the live vault as unlocked because its older copy is, and Settings, which counts the
 * copies of the vault it is open on, finds none beside a copy.
 */
export const NOT_ON_THE_LIST = -1;

/**
 * The listings go one at a time: the shell replaces every ID when a listing ends, in the order they end, so two out at once could leave the page with IDs the
 * shell has already replaced. This is the end of the last one asked; the next is sent only when it is over, and a press that needs an ID waits for it.
 */
let olderListingLine: Promise<void> = Promise.resolve();

/** Reads the older copies again, after any listing already on its way. The shell never refuses a listing; if the bridge itself fails the page keeps what it had. */
export function loadOlderCopies(): Promise<void> {
  const run = olderListingLine.then(async () => {
    try {
      const list = await api.listPreRestore();
      if (Array.isArray(list)) set({ ...state, olderCopies: list });
    } catch {
      // Nothing to say: the screens show the listing they had.
    }
  });
  olderListingLine = run;
  return run;
}

/** Opens asked for, and how many of them (the oldest first) were walked away from: the box's Cancel, or its panel closing, before the answer came. */
let olderOpenTickets = 0;
let olderOpenAbandoned = 0;
/** The end of the last open asked: opens go one at a time too, so an abandoned one is over before the next is sent. */
let olderOpenLine: Promise<void> = Promise.resolve();

/**
 * Walks away from every open that was asked and has not answered: its box was cancelled or its panel closed. One that has not been sent is never sent; one whose
 * answer comes later is not shown, and the session the shell made for it is locked again.
 */
export function abandonOlderOpens(): void {
  olderOpenAbandoned = olderOpenTickets;
}

/** The older copies as the screens read them: `null` until the first listing. */
export function useOlderCopies(): api.PreRestoreEntry[] | null {
  return useSelect((current) => current.olderCopies);
}

/** The ID the newest listing gives the copy in `folder` of `vault`, or `null` when it is not in it any more. */
function olderCopyId(vault: number, folder: string): number | null {
  return state.olderCopies?.find((entry) => entry.vault === vault && entry.folder === folder)?.id ?? null;
}

/** Opens 24f in the vault's panel, from Settings. It is the vault's copies, which a read-only session of it lists as well. */
export function openOlderCopies(session: number): void {
  update(session, (current) => ({ ...endReveals(current), openItem: null, tool: { kind: "older_copies" } }));
}

/** What opening an older copy came to: it is open (a read-only session, the window's now), the listing had changed (read again), or the vault locked meanwhile. */
export type OlderOpen = "opened" | "changed" | "stale";

/**
 * Open read-only, with what was typed in one box (a password or a recovery key; the shell tries a well-formed key as a key, then as a password). A wrong one is
 * thrown, for the step to say in the field. The copy opens as a read-only session of its own whose place on the list is `NOT_ON_THE_LIST`, so the live vault does
 * not show as unlocked because of it. The listing is read again afterwards. A copy whose details were changed outside Lockbox (`header_changed`) opens all the
 * same, with a banner that says so. An open that was walked away from (`abandonOlderOpens`) before its answer came shows nothing: the session the shell made is
 * locked again, and `"stale"` is the answer.
 */
export async function openOlderCopy(vault: number, folder: string, passwordOrKey: string): Promise<OlderOpen> {
  olderOpenTickets += 1;
  const ticket = olderOpenTickets;
  const abandoned = () => ticket <= olderOpenAbandoned;
  const before = olderOpenLine;
  let over = () => undefined;
  olderOpenLine = new Promise<void>((resolve) => {
    over = () => {
      resolve();
    };
  });
  try {
    await before;
    // The IDs of a listing on its way are the ones to send.
    await olderListingLine;
    if (abandoned()) return "stale";
    const id = olderCopyId(vault, folder);
    if (id === null) {
      await loadOlderCopies();
      return abandoned() ? "stale" : "changed";
    }
    let answer;
    try {
      answer = await api.openPreRestoreReadOnly(id, passwordOrKey);
    } catch (error) {
      // A press that was walked away from says nothing, whatever the shell answered: its words are not for the box that is on screen now.
      if (abandoned() || error instanceof api.StaleAnswer || refusedAsLocked(error)) return "stale";
      if (refusedWith(error, "not_found")) {
        await loadOlderCopies();
        return abandoned() ? "stale" : "changed";
      }
      throw error;
    }
    if (abandoned()) {
      // Cancelled, or its panel closed, while the shell worked: the copy is not shown. What the shell opened is let go, unless the page holds that session already
      // (the copy was open, and the shell answered with it): that one was not made by this open, and stays.
      if (sessionOf(answer.session) === undefined) void api.lockVault(answer.session).catch(() => undefined);
      return "stale";
    }
    const record = newRecord(answer, NOT_ON_THE_LIST, answer.data, null, { ...NO_ASKS, headerChanged: answer.data.header_changed });
    set({ ...state, sessions: withFront(state.sessions, record) });
    void loadOlderCopies();
    return await loadItems(record);
  } finally {
    over();
  }
}

/**
 * What a delete came to: the question is asked (24g), the copy is gone (the listing is read again), the listing had changed (read again), the shell's refusal, or
 * `"cancelled"`: the question or its panel went (or a lock came) before the send, so nothing was sent.
 */
export type OlderDelete = "asked" | "deleted" | "changed" | "cancelled" | { failed: unknown };

/** Deletes asked for, and how many of them (the oldest first) were walked away from: the question's Cancel, its panel closing, or a lock, before the send. */
let olderDeleteTickets = 0;
let olderDeleteAbandoned = 0;

/**
 * Walks away from every delete that was asked and has not been sent: a yes that waits for a listing on its way is dropped, so a copy is never deleted after the
 * question was cancelled or the panel or the vault went. One the shell already has cannot be taken back.
 */
export function abandonOlderDeletes(): void {
  olderDeleteAbandoned = olderDeleteTickets;
}

/**
 * Delete, in two sends: without `confirm` the shell only asks (24g), touching nothing; with it the copy is deleted for good and the listing is read again. `busy`
 * (the copy is open) and any other refusal come back as `failed`, for the screen to say through `messageFor`. Whether the call was walked away from
 * (`abandonOlderDeletes`) is checked again right before the send, after the wait for a listing on its way; `onSend` runs at that moment, when the shell is handed a
 * yes that nothing can stop any more.
 */
export async function deleteOlderCopy(vault: number, folder: string, confirm: boolean, onSend?: () => void): Promise<OlderDelete> {
  olderDeleteTickets += 1;
  const ticket = olderDeleteTickets;
  const abandoned = () => ticket <= olderDeleteAbandoned;
  // The IDs of a listing on its way are the ones to send.
  await olderListingLine;
  if (abandoned()) return "cancelled";
  const id = olderCopyId(vault, folder);
  if (id === null) {
    await loadOlderCopies();
    return "changed";
  }
  let answer;
  try {
    if (confirm) onSend?.();
    answer = await api.deletePreRestore(id, confirm);
  } catch (error) {
    if (refusedWith(error, "not_found")) {
      await loadOlderCopies();
      return "changed";
    }
    return { failed: error };
  }
  if (typeof answer === "object" && "Done" in answer) {
    await loadOlderCopies();
    return "deleted";
  }
  return typeof answer === "object" && "Confirm" in answer && answer.Confirm === "DeletePreRestore" ? "asked" : { failed: UNEXPECTED };
}

/** The refusal for too many older copies: its Older copies button lists the copies of the vault the swap would replace, with Delete only. */
export function showOlderCopiesInRestore(): void {
  const flow = state.restore;
  if (flow?.phase !== "refused" || flow.refusedAs !== "discard") return;
  // The vault the swap would replace is on the list, or there is no list of its copies to show.
  const replaces = flow.prepared?.replaces ?? null;
  if (replaces === null) return;
  moveRestore(flow.opening, flow.run, () => ({ phase: "older" }));
}

/** 24f's Back, inside the restore: the refusal again, with the finished copy still waiting. */
export function backToTooManyRefusal(): void {
  const flow = state.restore;
  if (flow?.phase !== "older") return;
  moveRestore(flow.opening, flow.run, () => ({ phase: "refused" }));
}

/** A copy was deleted inside the restore: back to 24d, so Replace can be pressed again for the same finished copy. */
export function backToReplaceQuestion(): void {
  const flow = state.restore;
  if (flow?.phase !== "older") return;
  moveRestore(flow.opening, flow.run, () => ({ phase: "replace", problem: null }));
}

/** How a save came out: made (the form is gone and the login is open), the vault locked meanwhile, or the shell's refusal. */
export type SaveResult = "saved" | "stale" | { failed: unknown };

/**
 * Saves the new-login form's text as a login, whole, in one write by the shell. On success the form goes, the list is read
 * again, the new login opens in the panel and "Saved" is said. A vault that locked meanwhile (the bridge's `StaleAnswer`,
 * or the shell's `locked` when the page missed the event) gets nothing said: the form is already gone with the vault's
 * record, and what was written stays written. A refusal comes back for the form to say, and the form stays as it was.
 */
export function saveNewLogin(session: number, draft: LoginDraft): Promise<SaveResult> {
  const website = draft.website.trim();
  return saveNew(session, (vault) =>
    api.newLogin(vault, draft.title.trim(), draft.folder, {
      username: draft.username,
      password: draft.password,
      urls: website === "" ? [] : [website],
    }),
  );
}

/**
 * Saves the new-key form as a key, whole, in one write: the name (trimmed) is its title, the value goes to Rust exactly as
 * typed and is never kept here. Everything else is as `saveNewLogin`: the key opens hidden with "Saved", a vault that locked
 * meanwhile gets nothing said, and a refusal (a name that is not a variable name) comes back for the form to say.
 */
export function saveNewKey(session: number, draft: KeyDraft): Promise<SaveResult> {
  return saveNew(session, (vault) => api.newKey(vault, draft.name.trim(), draft.folder, draft.value));
}

/** Saves the new-note form as a note, whole, in one write, and opens it with its text showing. As `saveNewLogin`. */
export function saveNewNote(session: number, draft: NoteDraft): Promise<SaveResult> {
  return saveNew(session, (vault) => api.newNote(vault, draft.title.trim(), draft.folder, draft.text));
}

/**
 * Saves the Edit form: the one write the shell makes of the changes, whole. On success the form goes, the list is read again,
 * the item's details open with "Saved" and focus on Edit. A refusal comes back for the form to say (a stale revision among
 * them: the item changed while it was open), and the form stays as it was. A vault that locked meanwhile gets nothing said,
 * as `saveNewLogin`.
 */
export function saveEdit(session: number, edit: api.ItemEdit): Promise<SaveResult> {
  return saveThen(session, async (vault) => {
    await api.updateItem(vault, edit);
    return edit.id;
  }, { focusEdit: true });
}

function saveNew(session: number, make: (vault: api.SessionRef) => Promise<api.Tagged<string>>): Promise<SaveResult> {
  return saveThen(session, async (vault) => (await make(vault)).data, { saved: true });
}

/**
 * Runs a save that the shell writes in one step (`write` answers the id of the item to show), then reads the list again and
 * opens the item. The item exists once the write is done: whatever the list refresh says (it may be refused), the item's
 * details still open, from their own read.
 */
async function saveThen(
  session: number,
  write: (vault: api.SessionRef) => Promise<string>,
  opened: OpenedHow,
): Promise<SaveResult> {
  const entry = sessionOf(session);
  if (entry === undefined) return "stale";
  const { generation } = entry;
  // The form that started this save, by its own object (a second form of the same kind for another item is another one).
  const starter = entry.tool;
  try {
    const id = await write({ session, generation });
    if (!stillOpen(session, generation)) return "stale";
    // It is written now. Whatever the list says next, the form's job is done.
    const record = sessionOf(session);
    if (record === undefined) return "stale";
    const read = await loadItems(record);
    if (read === "stale" || !stillOpen(session, generation)) return "stale";
    set({ ...state, toast: { kind: "saved", session } });
    // The saved item opens only if the form that saved it is still what the panel shows. If the person has cancelled and
    // gone on to something else (another item, a newer form with text in it), the panel stays as they have it.
    if (sessionOf(session)?.tool === starter) void selectItem(session, id, opened);
    return "saved";
  } catch (error) {
    if (refusedAsLocked(error)) dropIfStillOpen(session, generation);
    if (error instanceof api.StaleAnswer || !stillOpen(session, generation)) return "stale";
    return { failed: error };
  }
}

/** Shows a folder's items (`null`: all items), and closes the panel. */
export function selectFolder(session: number, folder: string | null): void {
  update(session, (entry) => ({ ...endReveals(entry), folder, trash: false, openItem: null }));
}

/** Shows the Trash view in place of the list, and closes the panel and any form (the Trash has nothing to add). */
export function openTrash(session: number): void {
  update(session, (entry) => ({ ...endReveals(entry), folder: null, trash: true, openItem: null, tool: null }));
}

/**
 * Picks a row of the Trash view (`null` closes the panel). Nothing of the item is asked of the shell for it: the Trash panel
 * shows what the list already says (its title, kind, folder and when), and no password, key or note.
 */
export function pickTrashed(session: number, id: string | null): void {
  update(session, (entry) => ({
    ...endReveals(entry),
    openItem: id === null ? null : { id, detail: null, error: null, saved: false, focusEdit: false },
  }));
}

/** How a copy or an open ended: it worked, the vault locked meanwhile (nothing to say), or the shell's refusal. */
type Done = "done" | "stale" | { failed: unknown };

/**
 * Asks the shell to put a field of the item on the clipboard (it never reaches the page) and, once it has, tells the
 * person when it will be cleared. The shell's refusal comes back for the caller to say where it fits.
 */
async function copyAndTell(session: number, id: string, field: CopyTarget): Promise<Done> {
  const words = typeof field === "string" ? COPIED[field] : "Password copied";
  return copyThenTell(session, words, (vault) => api.copyField(vault, id, field));
}

/** What the message says after each copy. */
const COPIED: Record<CopyableField, string> = {
  password: "Password copied",
  username: "Username copied",
  key_value: "Key copied",
  notes: "Text copied",
};

/**
 * Runs a copy the shell makes, and once it has, says `text` and when the clipboard clears. `copied` looks at the shell's answer and
 * says whether anything was put on the clipboard: when it says no (nothing was copied), nothing is said here and the caller does.
 */
async function copyThenTell(
  session: number,
  text: string,
  copy: (vault: api.SessionRef) => Promise<unknown>,
  copied: (answer: unknown) => boolean = () => true,
): Promise<Done> {
  const entry = sessionOf(session);
  if (entry === undefined) return "stale";
  const { generation } = entry;
  try {
    const { clipboard_seconds } = await api.getSettings();
    const answer = await copy({ session, generation });
    if (!stillOpen(session, generation)) return "stale";
    if (!copied(answer)) return "done";
    set({
      ...state,
      toast: {
        kind: "copied",
        session,
        text,
        seconds: clipboard_seconds,
        endsAt: Date.now() + clipboard_seconds * 1000,
      },
    });
    return "done";
  } catch (error) {
    if (refusedAsLocked(error)) dropIfStillOpen(session, generation);
    if (error instanceof api.StaleAnswer || !stillOpen(session, generation)) return "stale";
    return { failed: error };
  }
}

/**
 * Copies the password the Generator page shows: the value goes back to the shell, which puts it on the clipboard with the
 * marks and timer of any copy, owned by this vault. The page never uses its own clipboard, which skips those marks. The
 * message says when it clears; a refusal is said as a message. A vault that locked meanwhile gets nothing.
 */
export async function copyGenerated(session: number, value: string): Promise<void> {
  const done = await copyThenTell(session, "Password copied", (vault) => api.copyGenerated(vault, value));
  if (typeof done === "object") set({ ...state, toast: { kind: "failed", session, error: done.failed } });
}

/**
 * Asks the shell to put a field of the item on the clipboard (it never reaches the page) and tells the person when it
 * will be cleared. A vault that locked meanwhile gets no message.
 */
export async function copyField(session: number, id: string, field: CopyTarget): Promise<void> {
  const done = await copyAndTell(session, id, field);
  if (typeof done === "object") set({ ...state, toast: { kind: "failed", session, error: done.failed } });
}

/**
 * Where `SessionData.reveals` keeps a revealed value: under the item's id for its password or key's value, and under the id and
 * the number for one of a login's earlier passwords.
 */
export function revealKey(id: string, field: api.RevealableField): string {
  return typeof field === "string" ? id : `${id}:previous:${String(field.previous)}`;
}

/**
 * Reveal on an item's details: asks the shell for a login's password, a key's value or an earlier password (`field`) and keeps
 * it in the session's record while the item stays open. Each request carries the session's reveal token as it was when asked; Hide, another item,
 * a form or tool, another folder, the panel closing and the same item opening again all change it (`endReveals`), and an
 * answer whose token is no longer the current one is dropped, so a late answer, or a second one from a second press, never
 * puts a hidden value back. An answer from a vault that locked is dropped too. Neither says anything; a refusal that is still
 * current is said as a message.
 */
export async function revealValue(session: number, id: string, field: api.RevealableField): Promise<void> {
  const entry = sessionOf(session);
  if (entry === undefined) return;
  const { generation } = entry;
  // Each request moves the token on as it starts and accepts only its own answer, so the latest press wins whatever order the
  // answers come in. What is shown stays until the answer replaces it.
  const token = entry.revealEpoch + 1;
  update(session, (record) => ({ ...record, revealEpoch: token }));
  const current = () => stillOpen(session, generation) && sessionOf(session)?.revealEpoch === token;
  try {
    const answer = await api.revealValue({ session, generation }, id, field);
    if (!current() || sessionOf(session)?.openItem?.id !== id) return;
    // One value on screen at a time: this one takes the place of any other the item's details were showing.
    update(session, (record) => ({ ...record, reveals: { [revealKey(id, field)]: answer.data } }));
  } catch (error) {
    if (refusedAsLocked(error)) dropIfStillOpen(session, generation);
    if (error instanceof api.StaleAnswer || !current()) return;
    set({ ...state, toast: { kind: "failed", session, error } });
  }
}

/** Hide on a revealed value: it goes off the page and out of the store, and any answer still on its way is no longer wanted. */
export function hideReveal(session: number): void {
  update(session, endReveals);
}

/** Opens the login's website number `index` through the shell, which opens only an `http` or `https` one. */
async function openAndTell(session: number, id: string, index: number): Promise<Done> {
  const entry = sessionOf(session);
  if (entry === undefined) return "stale";
  const { generation } = entry;
  try {
    await api.openUrl({ session, generation }, id, index);
    return stillOpen(session, generation) ? "done" : "stale";
  } catch (error) {
    if (refusedAsLocked(error)) dropIfStillOpen(session, generation);
    if (error instanceof api.StaleAnswer || !stillOpen(session, generation)) return "stale";
    return { failed: error };
  }
}

/** "Open" beside a website on the login's details: a refusal is said as a message. */
export async function openSite(session: number, id: string, index: number): Promise<void> {
  const done = await openAndTell(session, id, index);
  if (typeof done === "object") set({ ...state, toast: { kind: "failed", session, error: done.failed } });
}

/** What a change the shell writes came to: done, the vault locked meanwhile (nothing to say), or the shell's refusal. */
type Changed<T> = { done: T } | "stale" | { failed: unknown };

/**
 * Runs a change the shell writes (a move, a trash, a restore, a folder made or renamed) and, once it is written, reads the
 * list again. A vault that locked meanwhile (the bridge's `StaleAnswer`, or the shell's `locked` when the page missed the event,
 * which also takes the vault's record away) comes back as `"stale"`: nothing to say. The caller decides what the answer does to
 * the screen, and checks that the view it started from is still the one on screen first (a late answer never acts on a view that
 * is gone or newer); the list is read whatever the view, since the change is written.
 */
async function change<T>(session: number, run: (vault: api.SessionRef) => Promise<T>): Promise<Changed<T>> {
  const entry = sessionOf(session);
  if (entry === undefined) return "stale";
  const { generation } = entry;
  try {
    const done = await run({ session, generation });
    if (!stillOpen(session, generation)) return "stale";
    const record = sessionOf(session);
    if (record === undefined) return "stale";
    const read = await loadItems(record);
    if (read === "stale" || !stillOpen(session, generation)) return "stale";
    return { done };
  } catch (error) {
    if (refusedAsLocked(error)) dropIfStillOpen(session, generation);
    if (error instanceof api.StaleAnswer || !stillOpen(session, generation)) return "stale";
    // A refusal can come after some of the change was written (a folder's items go one at a time), or after the write landed.
    // The list is read again so the page agrees with the vault, a panel that no longer belongs closes with its revealed value,
    // and the refusal is still what is said: a refused read on top of it says nothing and throws nothing.
    const record = sessionOf(session);
    if (record !== undefined) {
      const read = await loadItems(record, { quiet: true });
      if (read === "stale" || !stillOpen(session, generation)) return "stale";
    }
    return { failed: error };
  }
}

function say(session: number, text: string): void {
  set({ ...state, toast: { kind: "said", session, text } });
}

function sayFailure(session: number, error: unknown): void {
  set({ ...state, toast: { kind: "failed", session, error } });
}

/**
 * Whether the panel is still the one a change began from: it is on `id` (`openAtStart` says it was when the change began), or the
 * list read that followed the change closed it because its item had gone. A panel the person has since moved to another item is
 * not, and is left as it is.
 */
function panelWasOurs(session: number, id: string, openAtStart: boolean): boolean {
  const now = sessionOf(session)?.openItem ?? null;
  return now === null ? openAtStart : now.id === id;
}

/**
 * The number of the latest read of the open item's details asked of each session (by `selectItem` and `reloadOpen`): an answer is kept only
 * while its number is still the latest, so a slow older answer never puts back details a newer one replaced.
 */
const detailRuns = new Map<number, number>();

function nextDetailRun(session: number): number {
  const run = (detailRuns.get(session) ?? 0) + 1;
  detailRuns.set(session, run);
  return run;
}

/** Reads the open item's details again after a change to it, in place: what the panel shows stays, and Reveal's value too. */
async function reloadOpen(session: number, id: string): Promise<void> {
  const entry = sessionOf(session);
  // An item the person has moved away from is read again when they come back to it. Counting a read for it here would make the
  // details of the item now open, still on their way, look older than this one, and they would never show.
  if (entry === undefined || entry.openItem?.id !== id) return;
  const { generation } = entry;
  const run = nextDetailRun(session);
  try {
    const answer = await api.getItem({ session, generation }, id);
    // An older read that comes after a newer one (two changes in a row, delayed answers) is not the details any more.
    if (!stillOpen(session, generation) || sessionOf(session)?.openItem?.id !== id || detailRuns.get(session) !== run) return;
    update(session, (current) =>
      current.openItem?.id === id ? { ...current, openItem: { ...current.openItem, detail: answer.data, error: null } } : current,
    );
  } catch (error) {
    // What the panel shows stays; only a lock is news.
    if (refusedAsLocked(error)) dropIfStillOpen(session, generation);
  }
}

/**
 * Move on the open item: it goes to `folder` (a folder's id, or `null` for none) at once, as an edit that sends the revision the
 * panel read, so a change made meanwhile makes it stale and nothing moves (the shell's refusal is said as a message). Says
 * "Moved to <name>" (`name` is the folder's, `null` for none). The panel reads the item again, and only when it is still the
 * one open. Picking the folder it is in does nothing. Nothing in a vault that is read-only.
 */
export async function moveOpenItem(session: number, folder: string | null, name: string | null): Promise<void> {
  const entry = sessionOf(session);
  const open = entry?.openItem;
  if (entry === undefined || entry.readOnly || open === null || open === undefined || open.detail === null) return;
  const { id, detail } = open;
  if (detail.summary.collection === folder) return;
  const edit: api.ItemEdit = {
    id,
    revision: detail.revision,
    title: detail.summary.title,
    notes: detail.notes,
    collection: folder,
  };
  const done = await change(session, (vault) => api.updateItem(vault, edit));
  if (done === "stale") return;
  if ("failed" in done) {
    sayFailure(session, done.failed);
    return;
  }
  say(session, `Moved to ${name ?? "No folder"}`);
  void reloadOpen(session, id);
}

/**
 * Move to trash on the open item: it goes at once, with no question. The panel closes (when it is still that item's), the list
 * is read again, and "Moved to Trash" shows with Undo, which holds the item's id. Focus goes to the list. A refusal is said as a
 * message and the panel stays. A vault that locked meanwhile gets nothing.
 */
export async function trashOpenItem(session: number): Promise<void> {
  const entry = sessionOf(session);
  const open = entry?.openItem;
  if (entry === undefined || entry.readOnly || open === null || open === undefined) return;
  const { id } = open;
  const done = await change(session, (vault) => api.trashItem(vault, id));
  if (done === "stale") return;
  if ("failed" in done) {
    sayFailure(session, done.failed);
    return;
  }
  const stillThere = panelWasOurs(session, id, true);
  if (stillThere) update(session, (current) => ({ ...endReveals(current), openItem: null }));
  set({ ...state, toast: { kind: "trashed", session, id } });
  if (stillThere) focusList();
}

/**
 * Delete on the folder on screen, once the person said yes: it and its items go to the trash, the view goes to All items
 * (when it is still that folder's), and "Moved to Trash" shows with Undo, which holds the folder's id and brings the folder back
 * with what went with it. A refusal is said as a message.
 */
export async function deleteFolderOnScreen(session: number, id: string): Promise<void> {
  const entry = sessionOf(session);
  if (entry === undefined || entry.readOnly) return;
  const done = await change(session, (vault) => api.deleteFolder(vault, id));
  if (done === "stale") return;
  if ("failed" in done) {
    sayFailure(session, done.failed);
    return;
  }
  const leaving = sessionOf(session)?.folder === id;
  if (leaving) selectFolder(session, null);
  set({ ...state, toast: { kind: "trashed", session, id } });
  if (leaving) focusList();
}

/** Undo on "Moved to Trash": brings back what went (the item, or the folder with its items) and says "Restored". */
export async function undoTrash(session: number, id: string): Promise<void> {
  const entry = sessionOf(session);
  if (entry === undefined || entry.readOnly) return;
  const done = await change(session, (vault) => api.restoreItem(vault, id));
  if (done === "stale") return;
  // Whatever comes next replaces the message, and with it the Undo button. If that button has focus now, focus goes to the
  // list (or the heading, when there is none) rather than to the top of the page; if focus is elsewhere, it stays there.
  const hadFocus = document.activeElement?.closest(".tstack") != null;
  if ("failed" in done) sayFailure(session, done.failed);
  else say(session, "Restored");
  if (hadFocus) focusList();
}

// ---- Stored files (Task 19): open, save a copy, replace, attach, add ----
//
// Each is one long job in the shell, which opens the Windows picker or save dialog itself, so the page sends ids and never a path. One
// job at a time per vault (`SessionData.fileJob`): a second press while one works sends nothing. What an answer does depends on where the
// person is when it comes. A success is a fact about the vault (a copy was opened, a file stored) and is said whenever the vault is still
// open; a refusal is said only where the action began (the item's panel, or the search it was pressed in), so a late refusal never lands on
// something the person has moved on to. A lock, or a stale answer, says nothing at all.

const OPENED_COPY = "Opened a temporary read-only copy. Edits there aren't saved back. To change the stored file, use Replace file.";
const SAVED_COPY = "Saved a copy. It isn't encrypted. Delete it when you're finished.";

/** Says something the person reads and puts away with "Got it", and that holds no file name. */
function noted(session: number, text: string): void {
  set({ ...state, toast: { kind: "noted", session, text } });
}

/**
 * Where a file action began: the item panel it was pressed in, the search it was pressed in (the opening, the query whose results were on
 * screen, and the word typed at that moment: a newer word typed, or a newer word's results shown, is not where it was pressed), or the
 * window (Add).
 */
type FileOrigin = { panel: string } | { search: number; shown: number; typed: number } | "anywhere";

/** The search as it is now, for an action that begins in it. */
function searchOrigin(): FileOrigin {
  return { search: searchOpening, shown: searchShown, typed: searchRun };
}

/** Whether the person is still where the action began. */
function stillWhere(session: number, origin: FileOrigin): boolean {
  if (origin === "anywhere") return sessionOf(session) !== undefined;
  if ("search" in origin) {
    return state.search !== null && searchOpening === origin.search && searchShown === origin.shown && searchRun === origin.typed;
  }
  return sessionOf(session)?.openItem?.id === origin.panel;
}

/** Whether the shell refused because the stored file does not decrypt (`damaged`, of the file, or one that is missing). */
function damagedFile(error: unknown): boolean {
  return refusedWith(error, "core") && isRecord(error) && error.kind === "damaged" && (error.what === "file" || error.what === "file missing");
}

function endFileJob(session: number, generation: number): void {
  if (stillOpen(session, generation)) update(session, (current) => ({ ...current, fileJob: null }));
}

/** What a stopped add or Save a copy says. Cancel is the person's own press, so it is a result, said whenever the vault is still open. */
const NOTHING_ADDED = "Nothing was added.";
const NO_COPY_SAVED = "No copy was saved.";

/**
 * Says a refusal where the action began: a damaged file beside that file in the panel, anything else in the search or as a message. A
 * stop is not a refusal: an add or a Save a copy that was cancelled says what was left undone, in the way a finished one says what it did.
 */
function refuseFile(session: number, origin: FileOrigin, job: FileJobStart, error: unknown): void {
  if (refusedWith(error, "cancelled") && (job.kind === "add" || job.kind === "attach" || job.kind === "save")) {
    noted(session, job.kind === "save" ? NO_COPY_SAVED : NOTHING_ADDED);
    return;
  }
  if (!stillWhere(session, origin)) return;
  if (origin === "anywhere") sayFailure(session, error);
  else if ("search" in origin) sayInSearch(error);
  else if (damagedFile(error) && job.fileId !== null) {
    const fileId = job.fileId;
    update(session, (current) =>
      current.openItem?.id === origin.panel ? { ...current, openItem: { ...current.openItem, fileError: { fileId, error } } } : current,
    );
  } else sayFailure(session, error);
}

/** What a stored-file action came to when it did not answer a plain yes: the shell's answer, the vault locked (nothing to say), another action is working, or a refusal that was said. */
type FileRan<T> = { outcome: api.Outcome<T> } | "stale" | "busy" | "refused";

/**
 * Runs one stored-file job: marks the vault as working, asks the shell, and gives the answer back unless the vault locked meanwhile. With
 * `reload` the list is read again after it (a change that writes), through the same path as every other change.
 */
async function runFile<T>(
  session: number,
  job: FileJobStart,
  origin: FileOrigin,
  reload: boolean,
  run: (vault: api.SessionRef, request: number) => Promise<api.Tagged<api.Outcome<T>>>,
): Promise<FileRan<T>> {
  const entry = sessionOf(session);
  if (entry === undefined) return "stale";
  if (entry.fileJob !== null) return "busy";
  const { generation } = entry;
  // The number this command is sent with: the shell names the job it becomes by `lockbox://job-started`, and the progress card reads it by this number.
  const request = nextRequest();
  // A new job takes away what the last one said about this item's files.
  update(session, (current) => ({
    ...current,
    fileJob: { ...job, request },
    openItem: current.openItem !== null && current.openItem.id === job.id ? { ...current.openItem, fileError: null } : current.openItem,
  }));
  try {
    if (reload) {
      const done = await change(session, async (vault) => (await run(vault, request)).data);
      if (done === "stale") return "stale";
      if ("failed" in done) {
        refuseFile(session, origin, job, done.failed);
        return "refused";
      }
      return { outcome: done.done };
    }
    try {
      const answer = await run({ session, generation }, request);
      return stillOpen(session, generation) ? { outcome: answer.data } : "stale";
    } catch (error) {
      if (refusedAsLocked(error)) dropIfStillOpen(session, generation);
      if (error instanceof api.StaleAnswer || !stillOpen(session, generation)) return "stale";
      refuseFile(session, origin, job, error);
      return "refused";
    }
  } finally {
    // The command has answered, whatever it came to: its job, if it had one, is over, and so is its progress card. Focus that was on the
    // card's Cancel goes to the result's message, not to the top of the page.
    // Only if focus was in this job's own card: another job's card (in another vault's window, or the search) is left alone.
    const refocus = takeJobFocus(jobOfRequest(request)?.operation ?? null);
    releaseRequest(request);
    endFileJob(session, generation);
    refocus();
  }
}

/** How Open came out. `asks`: a program file, and the question is the screen's to ask. */
export type OpenResult = "done" | "asks" | "stale" | "busy" | "refused";

function openResult(session: number, ran: FileRan<null>): OpenResult {
  if (typeof ran === "string") return ran;
  const { outcome } = ran;
  if (typeof outcome === "object" && "Done" in outcome) {
    noted(session, OPENED_COPY);
    return "done";
  }
  if (typeof outcome === "object" && "Confirm" in outcome && outcome.Confirm === "Executable") return "asks";
  sayFailure(session, UNEXPECTED);
  return "refused";
}

/**
 * Open on a stored file of the item open in the panel: the shell decrypts a read-only copy and opens it in its app, and says so (the
 * copy is removed at the next lock, and edits to it are not kept). A program file answers `asks` first, before anything is decrypted; send
 * it again with `confirmed` once the person says yes. A file that does not decrypt is said beside the file in the panel.
 */
export async function openStoredFile(session: number, id: string, fileId: string, confirmed = false): Promise<OpenResult> {
  const ran = await runFile(session, { kind: "open", id, fileId }, { panel: id }, false, (vault) => api.openFile(vault, id, fileId, confirmed));
  return openResult(session, ran);
}

/**
 * How Save a copy came out: `dismissed` is a closed Windows dialog, which says nothing; `confirm` is a cloud-synced folder, with the token
 * the yes goes on with (nothing was decrypted or written).
 */
export type CopyResult = "done" | "dismissed" | "stale" | "busy" | "refused" | { confirm: string };

function saveResult(session: number, ran: FileRan<null>): CopyResult {
  if (typeof ran === "string") return ran;
  const { outcome } = ran;
  if (outcome === "Dismissed") return "dismissed";
  if (typeof outcome === "object" && "Done" in outcome) {
    noted(session, SAVED_COPY);
    return "done";
  }
  if (typeof outcome === "object" && "Confirm" in outcome && typeof outcome.Confirm === "object" && "CloudFolder" in outcome.Confirm) {
    return { confirm: outcome.Confirm.CloudFolder.token };
  }
  sayFailure(session, UNEXPECTED);
  return "refused";
}

/**
 * Save a copy on a stored file of the item open in the panel: Rust opens the Windows save dialog and writes the copy, which is not encrypted.
 * A cloud-synced folder answers `{ confirm }` first, for the screen to ask (21e); `confirmStoredCopy` goes on with it.
 */
export async function saveStoredFile(session: number, id: string, fileId: string): Promise<CopyResult> {
  const ran = await runFile(session, { kind: "save", id, fileId }, { panel: id }, false, (vault, request) =>
    api.saveFileCopy(vault, id, fileId, request),
  );
  return saveResult(session, ran);
}

/**
 * The run of a cloud question's yes. The shell lets go of a parked copy after five minutes as well as at a lock, so `not_found` is not news of
 * a lock by itself: the shell is asked about the session (`whyNotFound`). Locked: the session leaves the page and nothing is said. Still live:
 * the page's own "that took too long" is the refusal, said where the save began.
 */
function confirmCopy(session: number, token: string): (vault: api.SessionRef, request: number) => Promise<api.Tagged<api.Outcome<null>>> {
  return async (_vault, request) => {
    try {
      // The yes is its own command with its own request: that one names the job, not the save that asked the question.
      return await api.saveFileCopyConfirm(token, request);
    } catch (error) {
      if (refusedWith(error, "not_found")) await whyNotFound(session, "file_copy_expired");
      throw error;
    }
  };
}

/** The person's yes to the cloud question of a copy saved from the item open in the panel: the shell goes on with the copy it parked. */
export async function confirmStoredCopy(session: number, id: string, fileId: string, token: string): Promise<CopyResult> {
  const ran = await runFile(session, { kind: "save", id, fileId }, { panel: id }, false, confirmCopy(session, token));
  return saveResult(session, ran);
}

/** How a replace, attach or add came out: `dismissed` is a closed picker, which says nothing and changes nothing. */
export type StoreResult = "done" | "dismissed" | "stale" | "busy" | "refused";

/** What a stored file's import came to once it is said: the new item or file's ID, for the caller that needs it. */
function storeResult(ran: FileRan<string>, done: (id: string) => void): StoreResult {
  if (typeof ran === "string") return ran;
  const { outcome } = ran;
  if (outcome === "Dismissed") return "dismissed";
  if (typeof outcome === "object" && "Done" in outcome) {
    done(outcome.Done);
    return "done";
  }
  return "refused";
}

/**
 * Replace file on a stored file of the item open in the panel, once the person has said yes to the warning: Rust opens the Windows picker and
 * puts the chosen file in the old one's place. The panel reads the item again only if it is still that item's; "File replaced" is said either way.
 */
export async function replaceStoredFile(session: number, id: string, fileId: string): Promise<StoreResult> {
  const ran = await runFile(session, { kind: "replace", id, fileId }, { panel: id }, true, (vault) => api.replaceFile(vault, id, fileId));
  return storeResult(ran, () => {
    say(session, "File replaced");
    void reloadOpen(session, id);
  });
}

// ---- Many files in (Plan 4B Task 10): Add, then File, and Attach files ----
//
// One picker, for one file or many. The shell holds the picked paths under a choice and the page holds names and sizes (`AddFilesFlow`), shown
// in the Add files panel: 9a the list (Pick more, leave one out, the folder), 9b one bar for the whole batch, 9c the end. The batch is one
// long job (`add_files`), so it is the vault's one file job while it runs, and a second Add or Attach sends nothing. The panel is where it is on
// screen, no more: leaving it leaves the batch and its bar (in the list's column) going, and an end that left something out keeps its names in
// a card, since a file that was never stored is one nobody should delete the original of.

/** The number of the last time the Add files panel was opened. */
let addOpenings = 0;

/** Changes one session's batch while it is still the opening and generation the caller began in. */
function changeFlow(session: number, generation: number, opening: number, change: (flow: AddFilesFlow) => AddFilesFlow): void {
  if (!stillOpen(session, generation)) return;
  update(session, (current) => (current.addFiles?.opening === opening ? { ...current, addFiles: change(current.addFiles) } : current));
}

/**
 * A refusal of something done in the panel (a pick, a removal, the batch before it starts): the vault locked (nothing is said, the vault is
 * gone), or the shell's refusal is kept for the panel to say in words. A choice the shell let go takes the list with it, since the paths it
 * stood for are gone and the person picks again.
 */
function flowRefused(session: number, generation: number, opening: number, error: unknown): void {
  if (refusedAsLocked(error)) dropIfStillOpen(session, generation);
  if (error instanceof api.StaleAnswer || !stillOpen(session, generation)) return;
  const gone = refusedWith(error, "choice_expired");
  changeFlow(session, generation, opening, (flow) => ({
    ...flow,
    busy: false,
    phase: "pick",
    problem: error,
    choice: gone ? null : flow.choice,
    files: gone ? [] : flow.files,
  }));
}

/**
 * Add, then File, or Attach files on a login, key or note (`into`): opens the Windows picker for one file or many. A closed picker says and
 * changes nothing; files picked open the Add files panel on the list, with nothing sent to be written yet.
 */
export async function startAddFiles(session: number, into: api.AddInto): Promise<StoreResult> {
  const item = into.type === "item" ? into.id : null;
  const ran = await runFile(
    session,
    { kind: item === null ? "add" : "attach", id: item, fileId: null },
    item === null ? "anywhere" : { panel: item },
    false,
    (vault) => api.pickFilesToAdd(vault, null),
  );
  if (typeof ran === "string") return ran;
  const { outcome } = ran;
  if (outcome === "Dismissed") return "dismissed";
  if (typeof outcome === "object" && "Done" in outcome) {
    const picked = outcome.Done;
    addOpenings += 1;
    const opening = addOpenings;
    update(session, (current) => ({
      ...endReveals(current),
      openItem: null,
      trash: false,
      tool: { kind: "add_files" },
      addFiles: { opening, into, choice: picked.choice, files: picked.files, phase: "pick", busy: false, problem: null, result: null, focusResult: false },
    }));
    return "done";
  }
  sayFailure(session, UNEXPECTED);
  return "refused";
}

/** Pick more (9a): the picker adds its files to the same choice, and the list is the whole of it. With no choice left (it expired) it starts a new pick. A closed picker changes nothing. */
export async function pickMoreFiles(session: number): Promise<void> {
  const entry = sessionOf(session);
  const flow = entry?.addFiles ?? null;
  if (entry === undefined || flow === null || flow.phase !== "pick" || flow.busy) return;
  const { generation } = entry;
  const { opening } = flow;
  changeFlow(session, generation, opening, (now) => ({ ...now, busy: true, problem: null }));
  try {
    const answer = await api.pickFilesToAdd({ session, generation }, flow.choice);
    if (!stillOpen(session, generation)) return;
    const outcome = answer.data;
    if (typeof outcome === "object" && "Done" in outcome) {
      const { choice, files } = outcome.Done;
      changeFlow(session, generation, opening, (now) => ({ ...now, busy: false, choice, files }));
    } else if (outcome === "Dismissed") {
      changeFlow(session, generation, opening, (now) => ({ ...now, busy: false }));
    } else {
      flowRefused(session, generation, opening, UNEXPECTED);
    }
  } catch (error) {
    flowRefused(session, generation, opening, error);
  }
}

/** Leaves file number `index` out of the pick (9a's button on each row): the list that is left, from the shell. */
export async function leaveOutPickedFile(session: number, index: number): Promise<void> {
  const entry = sessionOf(session);
  const flow = entry?.addFiles ?? null;
  if (entry === undefined || flow === null || flow.phase !== "pick" || flow.busy || flow.choice === null) return;
  const { generation } = entry;
  const { opening, choice } = flow;
  changeFlow(session, generation, opening, (now) => ({ ...now, busy: true, problem: null }));
  try {
    const answer = await api.removePickedFile({ session, generation }, choice, index);
    if (!stillOpen(session, generation)) return;
    const outcome = answer.data;
    if (typeof outcome === "object" && "Done" in outcome) {
      const { files } = outcome.Done;
      changeFlow(session, generation, opening, (now) => ({ ...now, busy: false, files }));
    } else {
      flowRefused(session, generation, opening, UNEXPECTED);
    }
  } catch (error) {
    flowRefused(session, generation, opening, error);
  }
}

/**
 * What the batch's command comes to for the page: how it ended (with its operation, and whether focus was in its own panel or bar as it did, both
 * read while the bar is still there), or the shell's refusal before it began (the page's refusals are data, so the panel says them).
 */
type BatchRun = { view: api.AddFilesView; operation: number | null; focused: boolean } | { refused: unknown };

/**
 * Add N files (9a): sends the choice and where it goes (`into`, the folder the panel chose, or the item), and the batch is one job with one bar.
 * A refusal before it starts (no room for the whole batch, a file over 256 GB, a choice that expired) is said in the panel and the choice stays
 * (the shell uses it up only when the job starts); how it ended is the batch's own answer, kept for 9c, or for a card when the person has gone.
 */
export async function runAddFiles(session: number, into: api.AddInto): Promise<void> {
  const entry = sessionOf(session);
  const flow = entry?.addFiles ?? null;
  if (entry === undefined || flow === null || flow.phase !== "pick" || flow.busy || flow.choice === null || flow.files.length === 0) return;
  if (entry.readOnly || entry.fileJob !== null) return;
  const { generation } = entry;
  const { opening, choice } = flow;
  changeFlow(session, generation, opening, (now) => ({ ...now, into, phase: "adding", problem: null }));
  const ran = await runFile<BatchRun>(
    session,
    { kind: "add_files", id: into.type === "item" ? into.id : null, fileId: null },
    "anywhere",
    true,
    async (vault, request) => {
      try {
        const answer = await api.addFiles(vault, choice, into, request);
        const { data } = answer;
        if (typeof data === "object" && "Done" in data) {
          // The command has answered but its bar is still on the page: whose place focus is in is read now, before the result replaces the bar.
          const operation = jobOfRequest(request)?.operation ?? null;
          const focused = batchHasFocus(operation, sessionOf(session)?.tool?.kind === "add_files");
          return { ...answer, data: { Done: { view: data.Done, operation, focused } } };
        }
        return { ...answer, data: { Done: { refused: UNEXPECTED } } };
      } catch (error) {
        // A lock is the vault going (the caller's business); anything else came before the job started, and is the panel's to say.
        if (error instanceof api.StaleAnswer || refusedAsLocked(error)) throw error;
        return { session: vault.session, generation: vault.generation, data: { Done: { refused: error } } };
      }
    },
  );
  if (ran === "stale") return;
  if (typeof ran === "string") {
    // Another job was working (it was checked above, so this is a race), or the read after the batch was refused: back to the list.
    changeFlow(session, generation, opening, (now) => ({ ...now, phase: "pick" }));
    return;
  }
  const { outcome } = ran;
  const done = typeof outcome === "object" && "Done" in outcome ? outcome.Done : { refused: UNEXPECTED };
  if ("refused" in done) {
    flowRefused(session, generation, opening, done.refused);
    return;
  }
  // The item the files were attached to, when it is open now (the person went to another item and came back while the batch worked), still holds
  // the details it was read with, and its revision: read it again (only the open one is, as after every other change to an item).
  if (into.type === "item") void reloadOpen(session, into.id);
  endBatch(session, generation, opening, into, done);
}

/**
 * Where a batch's end goes: the panel when it is still on screen; else, when everything went in, one message that says so (and the originals
 * stay); else the flow stays at its end, and the card in the list's column names what was left out until it is put away. The result takes
 * focus only for a person who was in the batch's own panel or bar; for anyone else (in the filter, on another item) the end is said in the
 * page's spoken place instead, by the operation, which the card or the panel drawn after it could not do (a screen reader does not speak a
 * region that is new).
 */
function endBatch(
  session: number,
  generation: number,
  opening: number,
  into: api.AddInto,
  run: { view: api.AddFilesView; operation: number | null; focused: boolean },
): void {
  if (!stillOpen(session, generation)) return;
  const entry = sessionOf(session);
  if (entry?.addFiles?.opening !== opening) return;
  const { view: result, operation, focused } = run;
  const showing = entry.tool?.kind === "add_files";
  if (!showing && wasClean(result)) {
    update(session, (current) => ({ ...current, addFiles: null }));
    noted(session, awayMessage(result, into));
    return;
  }
  const total = entry.addFiles.files.length;
  const takesFocus = showing && focused;
  changeFlow(session, generation, opening, (now) => ({ ...now, phase: "done", result, busy: false, focusResult: takesFocus }));
  if (!takesFocus) announceJob(wasClean(result) ? awayMessage(result, into) : partialWords(result, total, into), operation ?? 0);
}

/**
 * Closes the Add files panel. Before the batch starts it is Cancel: nothing was written, and the choice is let to expire. While it works the
 * panel goes and the batch carries on (its bar moves to the list's column). At its end it is Done, and it is also what puts away the card that
 * kept an end the person had left. An item the files were attached to comes back in the panel, with the files it has now.
 */
export function closeAddFiles(session: number): void {
  const entry = sessionOf(session);
  if (entry === undefined) return;
  const flow = entry.addFiles;
  const showing = entry.tool?.kind === "add_files";
  update(session, (current) => ({
    ...current,
    tool: current.tool?.kind === "add_files" ? null : current.tool,
    addFiles: flow?.phase === "adding" ? current.addFiles : null,
  }));
  if (showing && flow?.into.type === "item" && flow.phase !== "adding") void selectItem(session, flow.into.id);
}

// ---- Save all of a folder's files (Plan 4B Task 11): the folder's menu, the bar, the summary ----
//
// Two commands: `save_all_files` opens the Windows folder picker, checks and answers a plan (or the cloud question), and `save_all_start` runs the
// job. The page chains them in one file job, so no other file action slips between, and the panel opens once the plan is known: it needs the folder
// the files go to and their sizes for "3 of 4". The destination stays in Rust under the plan's choice; the page holds names, sizes and tokens.
// The end is kept (the panel, or a card in the list's column when the person has gone) until Done, since the copies are not encrypted and the
// summary's handle is what Show in Explorer uses; Done puts the handle away.

/** The number of the last time a save was begun. */
let saveAllOpenings = 0;

/** Changes one session's save while it is still the opening and generation the caller began in. */
function changeSaveAll(session: number, generation: number, opening: number, change: (flow: SaveAllFlow) => SaveAllFlow): void {
  if (!stillOpen(session, generation)) return;
  update(session, (current) => (current.saveAll?.opening === opening ? { ...current, saveAll: change(current.saveAll) } : current));
}

/** Puts a summary's handle away. A handle that is gone already, or a failure, is nothing to say: the shell lets go of it at a lock anyway. */
function putAwayOutput(output: string): void {
  void api.closeOutput(output).catch(() => undefined);
}

/** The page's own refusal for a plan or a choice the shell let go of (it is held a few minutes), said in Save all's own words. */
function expiredSave(): Error {
  return Object.assign(new Error("save_all_expired"), { code: "page", kind: "save_all_expired" });
}

/** What a save's first step or its start came to: the cloud question to ask (its token), or how the job ended (with its operation, and whether focus was in its own place). */
type SaveAllRun = { cloud: string } | { view: api.SaveAllView; operation: number | null; focused: boolean };

/** Whether the shell refused for want of room, with the numbers the page says (the plan's check, or the start's). */
function noRoom(error: unknown): boolean {
  return refusedWith(error, "core") && isRecord(error) && error.kind === "not_enough_space" && typeof error.needed === "number" && typeof error.available === "number";
}

/**
 * One save: `plan` is the first step (the picker and the checks, or a cloud question's yes). A closed picker changes nothing and says nothing; a
 * cloud folder parks the question; a plan opens the panel on the bar and starts the job. A refusal at either step is said in the page's words
 * (the numbers, for want of room) and nothing is left of the panel; one that says the folder changed reads the list again, since it is out of date.
 */
async function runSaveAll(
  session: number,
  folder: { id: string; name: string },
  opening: number,
  plan: (vault: api.SessionRef) => Promise<api.Tagged<api.Outcome<api.SavePlan>>>,
): Promise<void> {
  const entry = sessionOf(session);
  if (entry === undefined || entry.fileJob !== null) return;
  const { generation } = entry;
  let refusal: unknown = null;
  const ran = await runFile<SaveAllRun>(session, { kind: "save_all", id: folder.id, fileId: null }, "anywhere", false, async (vault, request) => {
    try {
      const planned = await plan(vault);
      const first = planned.data;
      if (first === "Dismissed") return { ...planned, data: "Dismissed" };
      if ("Confirm" in first) {
        if (typeof first.Confirm === "object" && "CloudFolder" in first.Confirm) {
          return { ...planned, data: { Done: { cloud: first.Confirm.CloudFolder.token } } };
        }
        throw Object.assign(new Error("unexpected"), UNEXPECTED);
      }
      // The picker answered: the panel opens on the bar. A summary still held from an earlier save is put away now, since this one replaces it.
      const earlier = sessionOf(session)?.saveAll?.result?.output;
      update(session, (current) => ({
        ...endReveals(current),
        openItem: null,
        tool: { kind: "save_all" },
        saveAll: { opening, folder, phase: "saving", token: null, plan: first.Done, result: null, focusResult: false },
      }));
      if (earlier !== undefined) putAwayOutput(earlier);
      const started = await api.saveAllStart(first.Done.choice, request);
      const end = started.data;
      if (typeof end !== "object" || !("Done" in end)) throw Object.assign(new Error("unexpected"), UNEXPECTED);
      // The command has answered but its bar is still on the page: whose place focus is in is read now, before the result replaces the bar.
      const operation = jobOfRequest(request)?.operation ?? null;
      const focused = batchHasFocus(operation, sessionOf(session)?.tool?.kind === "save_all");
      return { ...started, data: { Done: { view: end.Done, operation, focused } } };
    } catch (error) {
      refusal = error;
      // A plan or choice the shell let go of: Save all's own words, not "pick the files again".
      throw refusedWith(error, "choice_expired") ? expiredSave() : error;
    }
  });
  if (ran === "stale" || ran === "busy") return;
  const leave = () => {
    update(session, (current) => ({
      ...current,
      tool: current.tool?.kind === "save_all" ? null : current.tool,
      saveAll: current.saveAll?.opening === opening ? null : current.saveAll,
    }));
  };
  if (ran === "refused") {
    // The refusal was said by `runFile`; want of room is said again with its numbers, and a changed folder means the list is out of date.
    if (noRoom(refusal) && stillOpen(session, generation)) told(session, refusalWords(refusal, []).text);
    leave();
    const record = sessionOf(session);
    if (refusedWith(refusal, "invalid_input") && isRecord(refusal) && refusal.what === "folder changed" && record !== undefined) {
      void loadItems(record, { quiet: true });
    }
    return;
  }
  const { outcome } = ran;
  if (outcome === "Dismissed" || !("Done" in outcome)) return;
  const done = outcome.Done;
  if ("cloud" in done) {
    // The question replaces a summary still held from an earlier save: its handle is put away first, as when a plan replaces it.
    const earlier = sessionOf(session)?.saveAll?.result?.output;
    if (earlier !== undefined) putAwayOutput(earlier);
    update(session, (current) => ({
      ...current,
      saveAll: { opening, folder, phase: "cloud", token: done.cloud, plan: null, result: null, focusResult: false },
    }));
    return;
  }
  endSaveAll(session, generation, opening, done);
}

/**
 * Where a save's end goes: the panel when it is on screen, else the flow stays at its end and the card in the list's column holds the summary. The
 * result takes focus only for a person who was in the save's own panel or bar; for anyone else (in the filter, on another item) the end is said in
 * the page's spoken place instead, by the operation, which a card drawn after it could not do.
 */
function endSaveAll(session: number, generation: number, opening: number, run: { view: api.SaveAllView; operation: number | null; focused: boolean }): void {
  if (!stillOpen(session, generation)) return;
  const entry = sessionOf(session);
  if (entry?.saveAll?.opening !== opening) return;
  const { view, operation, focused } = run;
  const total = entry.saveAll.plan?.files.length ?? 0;
  const takesFocus = entry.tool?.kind === "save_all" && focused;
  changeSaveAll(session, generation, opening, (now) => ({ ...now, phase: "done", result: view, focusResult: takesFocus }));
  if (!takesFocus) announceJob(spokenEnd(view, total), operation ?? 0);
}

/**
 * Save all files (N) in the folder's menu: Windows' folder picker opens (the shell's, titled with the count), then the save runs. Nothing is sent
 * while another file action works in the vault. Allowed in a vault opened from a backup.
 */
export async function startSaveAll(session: number, folder: { id: string; name: string }): Promise<void> {
  if (sessionOf(session) === undefined) return;
  saveAllOpenings += 1;
  await runSaveAll(session, folder, saveAllOpenings, (vault) => api.saveAllFiles(vault, folder.id));
}

/** The cloud question's yes ("Save here anyway"): the shell checks again and the save goes on with the folder it parked. */
export async function confirmSaveAll(session: number): Promise<void> {
  const flow = sessionOf(session)?.saveAll ?? null;
  if (flow === null || flow.phase !== "cloud" || flow.token === null) return;
  const { token, folder } = flow;
  update(session, (current) => ({ ...current, saveAll: null }));
  saveAllOpenings += 1;
  await runSaveAll(session, folder, saveAllOpenings, () => api.saveAllFilesConfirm(token));
}

/** The cloud question's other answers: "No" (Escape) writes nothing and leaves the question; "Pick another folder" asks Windows for a folder again. */
export function leaveSaveAllQuestion(session: number, pickAnother: boolean): void {
  const flow = sessionOf(session)?.saveAll ?? null;
  if (flow === null || flow.phase !== "cloud") return;
  update(session, (current) => ({ ...current, saveAll: null }));
  if (pickAnother) void startSaveAll(session, flow.folder);
}

/**
 * Closes the Save all panel. While the save works the panel goes and the save carries on (its bar moves to the list's column). At its end it is
 * Done, which puts the summary's handle away, and it is also what puts away the card that kept an end the person had left.
 */
export function closeSaveAll(session: number): void {
  const entry = sessionOf(session);
  if (entry === undefined) return;
  const flow = entry.saveAll;
  if (flow?.phase === "done" && flow.result !== null) putAwayOutput(flow.result.output);
  update(session, (current) => ({
    ...current,
    tool: current.tool?.kind === "save_all" ? null : current.tool,
    saveAll: flow?.phase === "saving" ? current.saveAll : null,
  }));
}

/**
 * Show in Explorer on the summary: the shell opens the saved folder by the handle (no path comes to the page). A handle the shell has let go of says
 * to open the folder from Windows; a failed open is said in words, with no path.
 */
export async function showSavedFolder(session: number): Promise<void> {
  const entry = sessionOf(session);
  const output = entry?.saveAll?.result?.output;
  if (entry === undefined || output === undefined) return;
  const { generation } = entry;
  try {
    await api.showOutputInExplorer(output);
  } catch (error) {
    if (refusedAsLocked(error)) dropIfStillOpen(session, generation);
    if (!stillOpen(session, generation)) return;
    sayFailure(session, refusedWith(error, "choice_expired") ? { code: "page", kind: "output_expired" } : error);
  }
}

/** Open on a file result of the search: as the panel's, and the search steps aside once it worked. A program file is asked over the search. */
export async function openFileFromSearch(session: number, id: string, file: FileView, confirmed = false): Promise<void> {
  const origin = searchOrigin();
  const ran = await runFile(session, { kind: "open", id, fileId: file.file_id }, origin, false, (vault) =>
    api.openFile(vault, id, file.file_id, confirmed),
  );
  const result = openResult(session, ran);
  if (!stillWhere(session, origin)) return;
  if (result === "asks" && state.search !== null) {
    set({ ...state, search: { ...state.search, asking: { kind: "program", session, id, file } } });
  } else if (result === "done") closeSearch();
}

/** What a save from the search came to: the search steps aside once it worked, and a cloud folder is asked over the search. */
function afterSearchSave(session: number, id: string, file: FileView, origin: FileOrigin, result: CopyResult): void {
  if (!stillWhere(session, origin)) return;
  if (result === "done") closeSearch();
  else if (typeof result === "object" && state.search !== null) {
    set({ ...state, search: { ...state.search, asking: { kind: "cloud", session, id, file, token: result.confirm } } });
  }
}

/** Save a copy on a file result of the search: as the panel's, and the search steps aside once it worked. */
export async function saveFileFromSearch(session: number, id: string, file: FileView): Promise<void> {
  const origin = searchOrigin();
  const ran = await runFile(session, { kind: "save", id, fileId: file.file_id }, origin, false, (vault, request) =>
    api.saveFileCopy(vault, id, file.file_id, request),
  );
  afterSearchSave(session, id, file, origin, saveResult(session, ran));
}

/** The person's answer to a question asked over the search: yes goes on (Open anyway, or Continue to a cloud folder); no leaves it, with nothing done. */
export function answerSearchQuestion(yes: boolean): void {
  const search = state.search;
  const asking = search?.asking ?? null;
  if (search === null || asking === null) return;
  set({ ...state, search: { ...search, asking: null } });
  if (!yes) return;
  if (asking.kind === "program") {
    void openFileFromSearch(asking.session, asking.id, asking.file, true);
    return;
  }
  const origin = searchOrigin();
  const { session, id, file, token } = asking;
  void (async () => {
    const ran = await runFile(session, { kind: "save", id, fileId: file.file_id }, origin, false, confirmCopy(session, token));
    afterSearchSave(session, id, file, origin, saveResult(session, ran));
  })();
}

/** "Pick another folder" over the search: the question goes and Windows is asked for a folder again. */
export function pickAnotherFolderFromSearch(): void {
  const asking = state.search?.asking ?? null;
  if (state.search === null || asking === null || asking.kind !== "cloud") return;
  set({ ...state, search: { ...state.search, asking: null } });
  void saveFileFromSearch(asking.session, asking.id, asking.file);
}

/**
 * Restore on a Trash row's panel: the item comes back (its folder with it when that is in the trash too; a folder brings back
 * the items that went with it). The panel closes when it is still that row's, and "Restored" is said. A refusal is said as a message.
 */
export async function restoreTrashed(session: number, id: string): Promise<void> {
  const entry = sessionOf(session);
  if (entry === undefined || entry.readOnly) return;
  const openAtStart = entry.openItem?.id === id;
  const done = await change(session, (vault) => api.restoreItem(vault, id));
  if (done === "stale") return;
  if ("failed" in done) {
    sayFailure(session, done.failed);
    return;
  }
  const stillThere = panelWasOurs(session, id, openAtStart);
  if (stillThere) update(session, (current) => ({ ...endReveals(current), openItem: null }));
  say(session, "Restored");
  if (stillThere) focusList();
}

/**
 * Delete for good on a Trash row, once the person said yes in the question: the item (a folder alone) goes for good. The panel
 * closes when it is still that row's. A refusal is said as a message and the row stays.
 */
export async function purgeTrashed(session: number, id: string): Promise<void> {
  const entry = sessionOf(session);
  if (entry === undefined || entry.readOnly) return;
  const openAtStart = entry.openItem?.id === id;
  const done = await change(session, (vault) => api.purgeItem(vault, id));
  if (done === "stale") return;
  if ("failed" in done) {
    sayFailure(session, done.failed);
    return;
  }
  const stillThere = panelWasOurs(session, id, openAtStart);
  if (stillThere) update(session, (current) => ({ ...endReveals(current), openItem: null }));
  say(session, "Deleted for good");
  if (stillThere) focusList();
}

/** What making a folder came to: its id, a lock meanwhile (nothing to say), or the shell's refusal to say under the box. */
export type FolderMade = { made: string } | "stale" | { failed: unknown };

/**
 * Makes a folder named `name` (the shell trims it, and refuses one with nothing in it). The list is read again; the new folder is
 * not opened here: the name box that asked opens it when it is still there (the late answer of a box that is gone opens nothing).
 */
export async function addFolder(session: number, name: string): Promise<FolderMade> {
  const done = await change(session, (vault) => api.newFolder(vault, name));
  if (done === "stale") return "stale";
  if ("failed" in done) return { failed: done.failed };
  return { made: done.done.data };
}

/** What the page read of a folder to rename it: its revision and notes, as `get_item` says them. */
export type FolderRead = { revision: number; notes: string } | "stale" | { failed: unknown };

/** Reads a folder's revision (for a rename to send back) and notes (which a rename keeps). */
export async function readFolder(session: number, id: string): Promise<FolderRead> {
  const entry = sessionOf(session);
  if (entry === undefined) return "stale";
  const { generation } = entry;
  try {
    const answer = await api.getItem({ session, generation }, id);
    return stillOpen(session, generation) ? { revision: answer.data.revision, notes: answer.data.notes } : "stale";
  } catch (error) {
    if (refusedAsLocked(error)) dropIfStillOpen(session, generation);
    if (error instanceof api.StaleAnswer || !stillOpen(session, generation)) return "stale";
    return { failed: error };
  }
}

/**
 * Renames a folder, as an edit that sends the folder's revision (from `readFolder`): a change made meanwhile makes it stale and
 * nothing changes (the shell's refusal comes back for the dialog to say). The list is read again, so the folder's name changes
 * wherever it is shown. A vault that locked meanwhile gets nothing said.
 */
export async function renameFolder(session: number, id: string, read: { revision: number; notes: string }, name: string): Promise<SaveResult> {
  const edit: api.ItemEdit = { id, revision: read.revision, title: name, notes: read.notes, collection: null };
  const done = await change(session, (vault) => api.updateItem(vault, edit));
  if (done === "stale") return "stale";
  if ("failed" in done) return { failed: done.failed };
  return "saved";
}

/** What reading a pasted `.env` came to: its rows (names only), a vault that locked meanwhile (nothing to say), or the shell's refusal. */
export type EnvRead = { rows: api.EnvRows } | "stale" | { failed: unknown };

/**
 * Sends a pasted `.env`'s text to Rust, once, and answers what it came to: names, the numbers of lines that could not be read, and
 * which names clash in which folder, never a value. The text is only an argument of this one call: nothing here keeps it, logs it
 * or puts it in the session's record, and a refusal comes back as the shell's own object, which holds none of it.
 */
export async function readEnv(session: number, text: string): Promise<EnvRead> {
  const entry = sessionOf(session);
  if (entry === undefined) return "stale";
  const { generation } = entry;
  try {
    const answer = await api.envRead({ session, generation }, text);
    return stillOpen(session, generation) ? { rows: answer.data } : "stale";
  } catch (error) {
    if (refusedAsLocked(error)) dropIfStillOpen(session, generation);
    if (error instanceof api.StaleAnswer || !stillOpen(session, generation)) return "stale";
    return { failed: error };
  }
}

/**
 * Lets Rust forget the values of a pasted `.env` at once: a save in which every row is left out writes nothing, and uses the token
 * up. It is sent without waiting and its outcome is not shown (a token already gone is the same as one let go). A vault that has
 * locked since sends nothing: the lock already let the values go, and a stale call would only be refused.
 */
export function releaseEnv(session: number, generation: number, token: string, indexes: readonly number[]): void {
  if (!stillOpen(session, generation)) return;
  const choices = indexes.map((index): api.EnvChoice => ({ index, action: "leave_out" }));
  void api.envSave({ session, generation }, token, choices, null, false).then(undefined, (error: unknown) => {
    if (refusedAsLocked(error)) dropIfStillOpen(session, generation);
  });
}

/** Whether the shell refused a save because it no longer holds the pasted values (used, five minutes old, or let go by a lock). */
export function refusedAsEnvGone(error: unknown): boolean {
  return refusedWith(error, "not_found");
}

/** How a pasted `.env`'s save came out: how many keys were written (the panel is gone), a lock meanwhile (nothing to say), or the refusal. */
export type EnvSaved = { saved: number; closed: boolean } | "stale" | { failed: unknown };

/** "3 keys", "1 key". */
function keysWords(count: number): string {
  return `${String(count)} ${count === 1 ? "key" : "keys"}`;
}

/**
 * Saves the pasted keys with one choice for every row, into `collection` (a folder's id, or `null`), by the token Rust holds them
 * under. The list is read again whatever the answer (a save cut short can have written some). Written: the panel closes (when it is
 * still the one that saved) and "Saved 3 keys to <where>" is said, `where` being the folder's name or "No folder", as a move says it, and
 * after it what became of the clipboard when `clearClipboard` asked for it to be cleared (`sayAfterSave`).
 * A refusal comes back for the panel to say. A vault that locked meanwhile gets nothing said. `onScreen` says whether the panel that
 * asked is still the one on screen; it is asked at the moment the panel is closed, and `closed` is true only then, so a panel that
 * left the screen meanwhile (the person went to another vault) is closed in its record without asking for focus.
 */
export async function saveEnv(
  session: number,
  token: string,
  choices: api.EnvChoice[],
  collection: string | null,
  where: string,
  clearClipboard: boolean,
  onScreen: () => boolean,
): Promise<EnvSaved> {
  const starter = sessionOf(session)?.tool;
  const done = await change(session, (vault) => api.envSave(vault, token, choices, collection, clearClipboard));
  if (done === "stale") return "stale";
  if ("failed" in done) return { failed: done.failed };
  const { saved: count, clipboard } = done.done.data;
  sayAfterSave(session, `Saved ${keysWords(count)} to ${where}`, clipboard);
  const closes = starter !== undefined && starter !== null && sessionOf(session)?.tool === starter;
  const shown = closes && onScreen();
  if (closes) closeTool(session);
  return { saved: count, closed: shown };
}

/** Says something the person has to read and act on, until it is dismissed. */
function told(session: number, text: string): void {
  set({ ...state, toast: { kind: "told", session, text } });
}

/** What a save says of the clipboard after its own words, by what the shell answered. Nothing is said when the clear was not asked for. */
const CLIPBOARD_WORDS: Record<api.ClipboardAfter, string> = {
  cleared: "Clipboard cleared.",
  not_ours: "The clipboard had changed, so it was left alone.",
  failed: "The clipboard couldn't be cleared.",
  not_asked: "",
};

/**
 * Says what a save did (`base`, with no full stop) and what became of the clipboard. A clipboard that could not be cleared still holds
 * what was copied, so that one stays until it is dismissed; the others are said once, as any short message.
 */
function sayAfterSave(session: number, base: string, clipboard: api.ClipboardAfter): void {
  const after = CLIPBOARD_WORDS[clipboard];
  if (after === "") say(session, base);
  else if (clipboard === "failed") told(session, `${base}. ${after}`);
  else say(session, `${base}. ${after}`);
}

/** What a folder's keys taken out says when two of them share a name: nothing was copied or written. */
function twiceWords(name: string): string {
  return `${name} appears twice in this folder. Rename or move one, then try again.`;
}

/** What is said after a `.env` file is written: where it went, and that it is not encrypted. */
const UNENCRYPTED_COPY = "This copy isn't encrypted. Delete it when you're finished.";

/**
 * Copy all as .env: Rust makes the text and puts it on the clipboard with the marks and timer of any copy; the page hears only
 * whether it worked. Worked: "Keys copied" and when the clipboard clears. Two keys with one name: nothing is copied, and the
 * sentence says which. A refusal is said as a message; a vault that locked meanwhile gets nothing.
 */
export async function copyEnv(session: number, collection: string): Promise<void> {
  // What the shell answered besides `Done`, for after the copy is over (an object, so what is read is the answer and not a guess).
  const found: { twice: string | null } = { twice: null };
  const done = await copyThenTell(
    session,
    "Keys copied",
    async (vault) => {
      const answer = await api.envCopy(vault, collection);
      if (typeof answer.data === "object" && "Duplicate" in answer.data) found.twice = answer.data.Duplicate.name;
      return answer;
    },
    () => found.twice === null,
  );
  if (typeof done === "object") sayFailure(session, done.failed);
  else if (done === "done" && found.twice !== null) told(session, twiceWords(found.twice));
}

/**
 * What Save as .env file left for the dialog: nothing more (`done`: it was written, dismissed, said in words or refused), a vault
 * that locked meanwhile (`stale`: nothing to say, nothing was written), or a cloud-synced folder, with the token to answer with.
 */
export type EnvFile = "done" | "stale" | { confirm: string };

/** Says what a save dialog's outcome came to for a `.env` file, and what is left for the dialog. */
function sayEnvFile(session: number, outcome: api.Outcome<api.SavedView>): EnvFile {
  const result = keyPdfOf(outcome);
  if (typeof result === "object" && "confirm" in result) return result;
  if (typeof result === "object" && "saved" in result) told(session, `Saved in ${result.saved}. ${UNENCRYPTED_COPY}`);
  return "done";
}

/**
 * Saves the folder's keys as a readable `.env` file: Rust opens the save dialog and writes the file. Written: where it went, and that
 * the copy is not encrypted. A closed dialog does nothing. Two keys with one name: the same sentence as Copy all, and no file. A
 * refusal is said as a message. A lock while it runs makes the answer stale: no file, and nothing said.
 */
export async function saveEnvFile(session: number, collection: string): Promise<EnvFile> {
  let answer;
  try {
    answer = await printCommand(session, (vault) => api.envSaveFile(vault, collection));
  } catch (error) {
    sayFailure(session, error);
    return "done";
  }
  if (answer === "stale") return "stale";
  const out = answer.data;
  if (typeof out === "object" && "Duplicate" in out) {
    told(session, twiceWords(out.Duplicate.name));
    return "done";
  }
  if (typeof out === "object" && "Saved" in out) return sayEnvFile(session, out.Saved);
  // `"Done"` is the answer of a copy: not one a save can give, so it is said in the plain words rather than as a success.
  sayFailure(session, new Error("unexpected answer to env_save_file"));
  return "done";
}

/**
 * The person's yes to saving the `.env` file in a cloud-synced folder: the shell goes on with the save it parked. As the recovery key's
 * PDF: `not_found` alone is not news of a lock, so the shell is asked about the session (`whyNotFound`). Locked: the session leaves the
 * page and nothing is said. Still live: it is said in words as something to do again, the question closes, and the session stays.
 * A lookup that fails another way is said as that failure.
 */
export async function confirmEnvFile(session: number, token: string): Promise<EnvFile> {
  let answer;
  try {
    answer = await printCommand(session, () => api.saveReadableConfirm(token));
  } catch (error) {
    let failure = error;
    if (refusedWith(error, "not_found")) {
      try {
        return await whyNotFound(session, "env_file_expired");
      } catch (lookup) {
        failure = lookup;
      }
    }
    sayFailure(session, failure);
    return "done";
  }
  return answer === "stale" ? "stale" : sayEnvFile(session, answer.data);
}

// ---- The copy the save shortcut left (Task 18) ----
//
// The shell reads the clipboard when the shortcut is pressed and keeps the text in one slot; the page hears a state and an id
// (`lockbox://capture`) and never the text, which comes only on Reveal and is kept by the box that asked for it, never here. The copy
// is not a vault's: with every vault locked the lock screen asks for an unlock first (8b), and once a window is on screen the save box (8a, 8c)
// is drawn over it, with the vault it saves into chosen in the box (Plan 4C Task 10). The box is the app's, not a window's: it stays through a
// switch and a lock of the vault under it. The copy is handed to the vault chosen (`capture_choose`), or to none while a locked vault is chosen
// (`capture_unchoose`), so only a lock of that vault, or of every vault, lets the copy go.

/** The copy, session and generation a `capture_choose` was last sent for, so one is not sent twice for the same. */
let chooseSent: string | null = null;

/** The copy being read as a `.env` right now: its `gone` (the shell empties the slot as it reads it) must not close the box that asked. */
let converting: string | null = null;

/** The copy whose `gone` came while it was being read as a `.env`: the read says what became of it. */
let goneWhileConverting: string | null = null;

/** How many boxes have been opened: a copy that comes with none waiting is a new one. */
let captureOpenings = 0;

/**
 * The hand-over of a copy as it was last asked (`capture_choose`, or `capture_unchoose`), and whether it worked: Reveal and Save wait for it while `out`, since the
 * shell calls the vault locked until a hand-over is done. Hand-overs go one at a time: two on the shell's pool could land out of order, so one asked while another
 * is out waits for it, and only the last asked is then sent (`handTicket`).
 */
let choosing: { id: string; kind: "choose" | "unchoose"; out: boolean; failed: boolean; done: Promise<boolean> } | null = null;

/** The number of the last hand-over asked: a waiting one that is no longer the last is not sent. */
let handTicket = 0;

/** How many `lockbox://capture` events the page has heard: an answer to `capture_state` that was asked before one came is older than it. */
let captureHeard = 0;

let captureStarted: Promise<void> | undefined;

/**
 * Starts hearing the shortcut, once the lock listener is up (call it after `startStore`): listens for `lockbox://capture` first, then
 * asks what is waiting, so a copy made before the page loaded is shown and one made between is not lost. The answer is as old as the
 * moment the shell read the slot: if any event was heard while it was on its way, the event is newer and the answer is dropped (a newer
 * copy is not replaced by an older one, and a `gone` is not undone). Nothing is said when the listener or the question fails: the
 * next press is told by the event if the listener is up.
 */
export function startCapture(): Promise<void> {
  captureStarted ??= (async () => {
    if (refusedWith(state.startError, "page")) return;
    try {
      await api.onCapture((event) => {
        captureHeard += 1;
        takeCapture(event);
      });
    } catch {
      return;
    }
    try {
      const heardBefore = captureHeard;
      const waiting = await api.captureState();
      if (waiting !== null && captureHeard === heardBefore) takeCapture(waiting);
    } catch {
      // Nothing waiting, as far as the page can know.
    }
  })();
  return captureStarted;
}

/** Lets the shell forget the copy at once. An id that is not the waiting one's is a quiet no-op there, and any refusal is not news. */
function letGo(id: string): void {
  void api.captureCancel(id).catch(() => undefined);
}

/**
 * The copy is over, as far as the page goes: the box goes and nothing of it stays. `tellShell` is for when the shell may still hold it (Cancel, a panel
 * that took the place, a lock): it is asked to let go, and a copy it has let go already makes that a no-op.
 */
function endCapture(tellShell: boolean): void {
  const capture = state.capture;
  if (capture === null) return;
  chooseSent = null;
  choosing = null;
  set({ ...state, capture: null });
  if (tellShell) letGo(capture.id);
}

/** Cancel (the box's, or the lock screen's): the copy is let go at once, here and in the shell. */
export function cancelCapture(): void {
  endCapture(true);
}

/**
 * Takes in what the shortcut did: a copy (`value`, `empty`, `too_large`), or `gone` for one the shell let go of. A `gone` for another id than the
 * one held is an old copy's and changes nothing. With no vault in existence at all (first-time setup is showing) the copy is let go and nothing
 * shows. A copy that comes while another waits replaces it: what was typed in the box is kept, the choice and the hand-over too, and `changed` says
 * the value differs.
 */
function takeCapture(event: unknown): void {
  if (!isRecord(event) || typeof event.capture_id !== "string") return;
  const id = event.capture_id;
  const copied = event.state;
  if (copied === "gone") {
    if (state.capture?.id !== id) return;
    // The shell empties its slot as it reads the copy as a `.env`: the read says what comes of the box.
    if (converting === id) goneWhileConverting = id;
    else endCapture(false);
    return;
  }
  if (copied !== "value" && copied !== "empty" && copied !== "too_large") return;
  if (state.vaults !== null && state.vaults.length === 0) {
    letGo(id);
    return;
  }
  const before = state.capture;
  captureOpenings += before === null ? 1 : 0;
  set({
    ...state,
    capture: {
      id,
      state: copied,
      envKeys: copied === "value" && typeof event.env_keys === "number" ? event.env_keys : null,
      changed: (before?.changed ?? false) || event.changed === true,
      chosen: before?.chosen ?? null,
      opening: before?.opening ?? captureOpenings,
      choice: before?.choice ?? null,
      choiceName: before?.choiceName ?? null,
    },
  });
  // The shell keeps a copy's binding when another replaces it. With a locked vault chosen, `seatCapture` asks the shell again for this copy while the page still counts
  // it as handed to a vault (an unchoose still out for the copy that went answers `not_found` and changes nothing here).
  seatCapture();
}

/** Whether two choices are the same vault: the same open session, or the same locked listed vault. */
function sameChoice(a: SaveChoice | null, b: SaveChoice | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.kind === "open") return b.kind === "open" && a.session === b.session;
  return b.kind === "locked" && a.vault === b.vault && a.list === b.list;
}

/** Whether an open session is the vault `id` of registry list `list`: an ID is only a vault within its own list. */
function isListed(session: SessionData, list: number, id: number): boolean {
  return session.vaultId === id && session.vaultList === list;
}

/** The value a choice has in the box's Vault list (`SaveOption.value`): an open session, or a listed vault by its list and ID. */
export function saveChoiceValue(choice: SaveChoice): string {
  return choice.kind === "open" ? `s:${String(choice.session)}` : `v:${String(choice.list)}:${String(choice.vault)}`;
}

/** Whether an open vault is waiting on a step the design says shows nothing of the vault yet: its recovery key (21f, 29b) or Ask 3 (its details changed outside Lockbox). */
function waitsOnStep(entry: SessionData): boolean {
  return entry.recovery !== null || entry.asks.detailsChanged;
}

/** Whether an open session can take the copy now: writable and not waiting on a step. */
function ready(session: SessionData): boolean {
  return !session.readOnly && !waitsOnStep(session);
}

/**
 * Why the vault chosen in the box can't take the copy now, or `null` when it can (or it is a locked one to unlock): `read_only` (it is open and read-only, on screen or
 * behind), `step` (it is open and waiting on a step: its recovery key, or Ask 3), or `gone` (a locked one that left the list or can't be reached). The box stays on that
 * vault, says why, and offers no Save; only the person's own pick moves it. A locked choice whose vault is open and ready returns `null`: the store settles it onto the session.
 */
export function boxBlock(choice: SaveChoice, sessions: readonly SessionData[], vaults: readonly VaultEntry[] | null): "read_only" | "step" | "gone" | null {
  const open = choice.kind === "open" ? sessions.find((one) => one.session === choice.session) : sessions.find((one) => isListed(one, choice.list, choice.vault));
  if (open !== undefined) return open.readOnly ? "read_only" : waitsOnStep(open) ? "step" : null;
  if (choice.kind === "open" || vaults === null) return null;
  const listed = vaults.find((entry) => entry.list === choice.list && entry.id === choice.vault);
  return listed === undefined || !listed.available || listed.details_damaged || listed.name === null ? "gone" : null;
}

/** The name the box says a choice by: the open session's (renamed since it was listed), the list's for a locked one, else the one kept (`fallback`) when it is gone. */
function choiceNameOf(choice: SaveChoice, sessions: readonly SessionData[], vaults: readonly VaultEntry[] | null, fallback: string | null): string {
  if (choice.kind === "open") return sessions.find((one) => one.session === choice.session)?.name ?? fallback ?? "";
  const open = sessions.find((one) => isListed(one, choice.list, choice.vault));
  if (open !== undefined) return open.name;
  const listed = vaults?.find((entry) => entry.list === choice.list && entry.id === choice.vault);
  return listed?.name ?? fallback ?? "";
}

/**
 * The vaults the save box offers to save into, the one on screen first when it can take a key, then every listed vault in the list's order that can: an open one
 * that is writable, or a locked one (it is unlocked in the box). One that is unavailable, whose details can't be read or that is open read-only is not a choice, and
 * neither is a writable session that is not on the list unless it is the one on screen. Two labels alike say their place on the list ("Home, 2 of 3", as the vault
 * strip does). Before the list has come, only the window on screen is offered. An open vault behind the window that is waiting on a step (its recovery key, 21f
 * and 29b, or Ask 3) shows nothing of itself until the step is done, so it is not offered either. `keep` is the box's own choice, with the name kept for it: the box never
 * moves it by itself, so it is always on offer as its own entry, whatever became of its vault (open but read-only or waiting on a step, on screen or behind; left the
 * list; unavailable), where the vault's own row would be skipped or would stand for another choice. A locked choice whose vault is open and ready is left to the open
 * session, which the store settles it onto.
 */
export function saveChoices(
  front: SessionData | undefined,
  sessions: readonly SessionData[],
  vaults: readonly VaultEntry[] | null,
  keep: { choice: SaveChoice; name: string } | null = null,
): SaveOption[] {
  // A vault is its list's identity and its ID together: a replaced list may give an ID to another vault.
  type Vault = { list: number; id: number };
  const found: { choice: SaveChoice; name: string; place: number | null; vault: Vault | null }[] = [];
  const list = vaults ?? [];
  const same = (one: Vault | null, other: Vault) => one !== null && one.list === other.list && one.id === other.id;
  if (front !== undefined && !front.readOnly) {
    const own = { list: front.vaultList, id: front.vaultId };
    const at = list.findIndex((entry) => same(own, entry));
    found.push({ choice: { kind: "open", session: front.session }, name: front.name, place: at < 0 ? null : at + 1, vault: own });
  }
  list.forEach((entry, at) => {
    if ((front !== undefined && isListed(front, entry.list, entry.id)) || !entry.available || entry.details_damaged || entry.name === null) return;
    const open = sessions.find((one) => isListed(one, entry.list, entry.id));
    const vault = { list: entry.list, id: entry.id };
    if (open === undefined) found.push({ choice: { kind: "locked", vault: entry.id, list: entry.list }, name: listedName(entry), place: at + 1, vault });
    else if (ready(open)) found.push({ choice: { kind: "open", session: open.session }, name: open.name, place: at + 1, vault });
  });
  if (keep !== null) {
    const chosen = keep.choice;
    const own = chosen.kind === "open" ? sessions.find((one) => one.session === chosen.session) : undefined;
    const vault: Vault | null = chosen.kind === "locked" ? { list: chosen.list, id: chosen.vault } : own === undefined ? null : { list: own.vaultList, id: own.vaultId };
    const at = vault === null ? -1 : list.findIndex((entry) => same(vault, entry));
    const kept = { choice: keep.choice, name: keep.name, place: at < 0 ? null : at + 1, vault };
    const there = vault === null ? -1 : found.findIndex((one) => same(one.vault, vault));
    if (there < 0) found.push(kept);
    else if (!sameChoice(found[there]?.choice ?? null, keep.choice)) {
      // The vault has a row of its own that is not the choice: a locked choice whose vault is open and ready becomes that session (the store settles it); any other
      // is kept as the entry the person chose in that row's place.
      const session = vault === null ? undefined : sessions.find((one) => isListed(one, vault.list, vault.id));
      if (session === undefined || !ready(session)) found[there] = kept;
    }
  }
  return found.map((one) => {
    const alike = found.filter((other) => other.name === one.name).length > 1;
    return {
      value: saveChoiceValue(one.choice),
      label: alike && one.place !== null ? `${one.name}, ${String(one.place)} of ${String(list.length)}` : one.name,
      name: one.name,
      choice: one.choice,
    };
  });
}

/** The window on screen's panel closes (the box takes its place, as opening a tool did); the records of its other panels are left as they are. */
function closePanelFor(session: number): void {
  update(session, (current) => ({ ...endReveals(current), openItem: null, tool: null }));
}

/**
 * Puts a waiting copy in front of the person, and settles the vault it is for. With no window on screen there is nothing to do: the lock screen shows the step
 * (8b), and `unlock` comes back here. The first time a window is on screen the box starts on the first vault it offers (the window on screen when it can take a
 * key, else the first listed vault that can), and the panel of that window closes. After that the box never moves the choice by itself (Task 10b): when the vault
 * chosen can't take the copy (read-only, waiting on a step, left the list, unavailable, on screen or behind) the choice stays, the box says why and offers no Save, and
 * nothing is handed to another vault; only the person's own pick (`chooseSaveVault`) changes it. The one thing done on its own is to settle a locked choice onto its
 * vault's session once that is open and ready. An open choice is handed to the shell (`capture_choose`) once for its session and generation. A locked one is handed to
 * none: if the page still counts the copy as handed to a vault (the shell has not answered that it was let go for this copy), the unchoose is asked, once at a time.
 * With nothing to offer at the first seat the copy is let go and "This vault is read-only." is said, as before. Safe to call again: nothing is sent twice for the same.
 */
function seatCapture(): void {
  const capture = state.capture;
  const front = state.sessions.at(-1);
  if (capture === null || front === undefined) return;
  let choice = capture.choice;
  let name = capture.choiceName;
  if (choice === null) {
    // The first seat: the first vault the box offers.
    const first = saveChoices(front, state.sessions, state.vaults, null)[0];
    if (first === undefined) {
      sayFailure(front.session, { code: "read_only" });
      endCapture(true);
      return;
    }
    if (first.choice.kind === "open" && first.choice.session === front.session) closePanelFor(front.session);
    choice = first.choice;
    name = first.name;
  } else if (choice.kind === "locked") {
    // Its vault is open now and can take a key: the choice is that session. Anything else (still locked, or open but unable) stays as it is.
    const { vault, list } = choice;
    const opened = state.sessions.find((one) => isListed(one, list, vault));
    if (opened !== undefined && boxBlock(choice, state.sessions, state.vaults) === null) {
      choice = { kind: "open", session: opened.session };
      name = opened.name;
    }
  }
  const now = state.capture;
  if (now === null) return;
  // The name is kept with the choice, and follows the vault's own (a rename) while it can be read.
  name = choiceNameOf(choice, state.sessions, state.vaults, name);
  const entry = choice.kind === "open" ? sessionOf(choice.session) : undefined;
  const bound = choice.kind === "open" ? (entry?.session ?? now.chosen) : now.chosen;
  if (!sameChoice(now.choice, choice) || now.choiceName !== name || now.chosen !== bound) set({ ...state, capture: { ...now, choice, choiceName: name, chosen: bound } });
  if (choice.kind === "locked") {
    // Handed to no vault. The page counts the copy as unbound only once the shell has answered for this copy's id (`unchooseCapture`), so until then a lock of the vault it
    // was handed to still ends it here as it does there, and a copy that replaced it (which keeps the binding in the shell) is asked again.
    if (state.capture?.chosen !== null && !unchoosing(now.id)) {
      chooseSent = null;
      handOver(now.id, { kind: "unchoose" });
    }
    return;
  }
  if (entry === undefined) return;
  const sent = `${now.id}:${String(entry.session)}:${String(entry.generation)}`;
  if (chooseSent === sent) return;
  chooseSent = sent;
  handOver(now.id, { kind: "choose", session: entry.session, generation: entry.generation });
}

/** The box's Vault list, settled again after the vaults on offer changed under it (a vault went unavailable, a window was switched): the store's own `seatCapture`. */
export function settleSaveChoice(): void {
  seatCapture();
}

/**
 * The box's Vault list: the vault chosen is the one the copy is for. The same choice does nothing. An open vault is handed the copy (`capture_choose`, once for its
 * session and generation). A locked one hands it to none (`capture_unchoose`), so only a lock of every vault lets it go while its password is asked for in the box:
 * an `unchoose` that finds the copy gone closes the box quietly, and another refusal is not said (the old binding stays, whose lock still closes the box).
 */
export function chooseSaveVault(choice: SaveChoice): void {
  const capture = state.capture;
  if (capture === null || sameChoice(capture.choice, choice)) return;
  // The name goes with the choice, from the entry the person picked in the list.
  const name = saveChoices(state.sessions.at(-1), state.sessions, state.vaults, capture.choice === null ? null : { choice: capture.choice, name: capture.choiceName ?? "" }).find((one) =>
    sameChoice(one.choice, choice),
  )?.name;
  chooseSent = null;
  set({ ...state, capture: { ...capture, choice, choiceName: name ?? choiceNameOf(choice, state.sessions, state.vaults, null) } });
  seatCapture();
}

/** What a hand-over asks of the shell: the copy for one session at one generation, or for none. */
type HandOver = { kind: "choose"; session: number; generation: number } | { kind: "unchoose" };

/**
 * Asks the shell to hand copy `id` over, one at a time and the last asked only: it waits for the one that is out, and is not sent if another was asked after it, or
 * the copy has gone meanwhile. `choosing` is for the one asked last, which Reveal and Save wait for (`handedOver`).
 */
function handOver(id: string, what: HandOver): void {
  handTicket += 1;
  const ticket = handTicket;
  const before = choosing?.id === id ? choosing.done : Promise.resolve(true);
  const mine: { id: string; kind: "choose" | "unchoose"; out: boolean; failed: boolean; done: Promise<boolean> } = {
    id,
    kind: what.kind,
    out: true,
    failed: false,
    done: Promise.resolve(true),
  };
  mine.done = (async () => {
    let worked = false;
    try {
      await before;
      if (state.capture?.id !== id) return false;
      // Asked again since: that one is sent, and this is no news for whoever waited on it.
      if (ticket !== handTicket) {
        worked = true;
        return true;
      }
      worked = what.kind === "choose" ? await chooseCapture(what.session, what.generation, id) : await unchooseCapture(id);
      return worked;
    } finally {
      mine.out = false;
      mine.failed = !worked;
    }
  })();
  choosing = mine;
}

/**
 * Whether the copy is handed over, once the hand-over that is out has been answered: false when it did not work (the page has said so, or the box is gone). A newer one
 * asked meanwhile is waited for too. A caller that finds none out (`handingOver`) goes on in the same step instead of waiting a turn for nothing.
 */
async function handedOver(id: string): Promise<boolean> {
  for (;;) {
    const waiting = choosing;
    if (waiting === null || waiting.id !== id || !waiting.out) return true;
    if (!(await waiting.done)) return false;
    if (choosing === waiting) return true;
  }
}

/** Whether a hand-over of copy `id` is out right now. */
function handingOver(id: string): boolean {
  return choosing?.id === id && choosing.out;
}

/** Whether the hand-over asked last for copy `id` is an unchoose that is still out. */
function unchoosing(id: string): boolean {
  return choosing?.id === id && choosing.out && choosing.kind === "unchoose";
}

/**
 * `capture_choose`: tells the shell which vault the copy was handed to, and answers whether that worked. A lock the page missed takes the
 * vault off; an old id means the shell has let go or replaced the copy (its `gone` or a new copy is on its way), so the box goes quietly;
 * another refusal is said.
 */
async function chooseCapture(session: number, generation: number, id: string): Promise<boolean> {
  try {
    await api.captureChoose({ session, generation }, id);
    return true;
  } catch (error) {
    if (refusedAsLocked(error)) {
      dropIfStillOpen(session, generation);
      return false;
    }
    if (error instanceof api.StaleAnswer || !stillOpen(session, generation)) return false;
    if (refusedWith(error, "not_found")) {
      if (state.capture?.id === id) endCapture(false);
      return false;
    }
    sayFailure(session, error);
    return false;
  }
}

/**
 * `capture_unchoose`: tells the shell the copy is handed to no vault. An old id means the shell has let go or replaced the copy, so the box goes quietly. Any other
 * refusal is not said: the old binding stays, and its lock still closes the box. Nothing waits on the answer being good: there is no vault to ask anything of.
 */
async function unchooseCapture(id: string): Promise<boolean> {
  try {
    await api.captureUnchoose(id);
  } catch (error) {
    if (refusedWith(error, "not_found") && state.capture?.id === id) endCapture(false);
    return true;
  }
  // The shell has answered for this copy: only now is it unbound here. (An answer for a copy that was replaced since is not about the one on screen.)
  const now = state.capture;
  if (now?.id === id && now.choice?.kind === "locked" && now.chosen !== null) set({ ...state, capture: { ...now, chosen: null } });
  return true;
}

/** What Reveal came to: the value (for the box that asked to keep, never here), a copy that is gone (nothing to say), or a refusal. */
export type CaptureRevealed = { value: string } | "gone" | { failed: unknown };

/**
 * Reveal on the copied value: asked of the shell by the copy's id. The answer is only for that copy: one that comes after the copy was
 * replaced or let go is dropped, and so is its value. A copy the shell no longer has closes the box quietly, and a vault that locked takes the
 * copy with it (the page missed the lock). The value is handed back to the caller and kept nowhere here. The shell calls the vault locked until
 * the copy has been handed to it, so Reveal waits for that hand-over (`capture_choose`) to finish, and asks nothing if it did not work: a `locked`
 * that came only from asking too early would otherwise be taken for a lock and take the vault off the screen.
 */
export async function revealCapture(id: string): Promise<CaptureRevealed> {
  const current = () => state.capture?.id === id;
  // A hand-over that is out is waited for, and one that did not work (the page has said so) is not asked past: nothing is asked of a copy that was not handed over.
  const handing = choosing?.id === id ? choosing : null;
  if (handing !== null && (handing.out ? !(await handedOver(id)) : handing.failed)) return "gone";
  if (!current()) return "gone";
  try {
    const value = await api.captureReveal(id);
    return current() ? { value } : "gone";
  } catch (error) {
    if (!current()) return "gone";
    if (refusedWith(error, "not_found")) {
      endCapture(false);
      return "gone";
    }
    const chosen = state.capture?.chosen;
    if (refusedAsLocked(error) && chosen !== null && chosen !== undefined) {
      dropSession(chosen);
      return "gone";
    }
    return { failed: error };
  }
}

/**
 * Asks the shell whether copy `id` is still waiting, after a `not_found` that could be about something else (a folder that is not there):
 * a copy that is gone, or replaced by another, is dealt with as its event would have, and the answer is false; one that is still there is true.
 * When the question itself fails the copy is taken to be there, so the person sees the refusal and can cancel.
 */
async function copyStillThere(id: string): Promise<boolean> {
  let waiting: api.CaptureEvent | null;
  try {
    waiting = await api.captureState();
  } catch {
    return true;
  }
  if (state.capture?.id !== id) return false;
  if (waiting === null || waiting.state === "gone") {
    endCapture(false);
    return false;
  }
  if (waiting.capture_id !== id) {
    takeCapture(waiting);
    return false;
  }
  return true;
}

/** How saving the copy came out: saved (the box is gone, the key is open), a name taken (`clash` is the name Keep both would use), a lock or a gone copy (nothing to say), or the refusal. */
export type CaptureSaveResult = "saved" | "stale" | "gone" | { clash: string } | { failed: unknown };

/** What Save is told when the copy is not handed to the vault it was asked for: the shell's own refusal of the same, so the box says it the same way. */
const NOT_HANDED_OVER = { code: "invalid_input", what: "capture vault" };

/**
 * Saves the copy as a key in the vault, in one write by the shell, which also clears the clipboard when asked. The shell saves only into the vault the copy is
 * handed to: Save waits for a hand-over that is out, and asks nothing when the box's choice is not that session (the hand-over is settled again, and the refusal
 * comes back as the shell's own would: the box says it and nothing was written). A name that is taken comes back as `clash`, with nothing written. Saved: the copy
 * is over, the vault's list is read again, the new key is selected when that vault is the window on screen, and `where` is said (`<name> saved in <where>`), with
 * what became of the clipboard (`sayAfterSave`). A refusal comes back for the box to say, and the box stays. A lock meanwhile gets nothing said (what was written
 * stays written); a copy the shell no longer has closes the box quietly, but a `not_found` while the copy is still waiting is about the folder, and is said.
 */
export async function saveCapture(session: number, save: api.CaptureSave, where: string): Promise<CaptureSaveResult> {
  if (handingOver(save.captureId) && !(await handedOver(save.captureId))) return "gone";
  const capture = state.capture;
  if (capture?.id !== save.captureId) return "gone";
  const entry = sessionOf(session);
  if (entry === undefined) return "stale";
  if (capture.chosen !== session) {
    seatCapture();
    return { failed: NOT_HANDED_OVER };
  }
  // The choice as it is now, right before sending: this vault, open, writable and not waiting on a step. A vault that has become blocked (an open name question
  // outlived it), or that is no longer the choice (a Save queued while another vault was picked and the shell's unbinding failed), is sent nothing.
  const choice = capture.choice;
  if (choice?.kind !== "open" || choice.session !== session || !ready(entry)) return "stale";
  const { generation } = entry;
  try {
    const answer = await api.captureSave({ session, generation }, save);
    if (!stillOpen(session, generation)) return "stale";
    if ("Clash" in answer.data) return { clash: answer.data.Clash.saved_as };
    const { id, name, clipboard } = answer.data.Saved;
    // The shell has let go of the copy (its `gone` may have come already): so does the page.
    if (state.capture?.id === save.captureId) endCapture(false);
    const record = sessionOf(session);
    if (record === undefined) return "stale";
    if ((await loadItems(record)) === "stale" || !stillOpen(session, generation)) return "stale";
    // The saved key is selected only if that vault is the window on screen and its panel is still free: another press, or another form or item opened while this
    // was on its way, has the panel now, and it is left as it is (its copy, or what was typed in it). A vault saved into behind the window on screen stays
    // behind it. The save is still said.
    const now = sessionOf(session);
    if (state.capture === null && now !== undefined && state.sessions.at(-1)?.session === session && now.tool === null && now.openItem === null) {
      void selectItem(session, id, { saved: true });
    }
    sayAfterSave(session, `${name} saved in ${where}`, clipboard);
    return "saved";
  } catch (error) {
    if (refusedAsLocked(error)) dropIfStillOpen(session, generation);
    if (error instanceof api.StaleAnswer || !stillOpen(session, generation)) return "stale";
    if (refusedWith(error, "invalid_input") && (error as { what?: unknown }).what === "capture vault") {
      // The shell holds the copy for another vault than the box's choice: the hand-over is sent again, and the refusal is said.
      chooseSent = null;
      seatCapture();
      return { failed: error };
    }
    if (refusedWith(error, "not_found") && !(await copyStillThere(save.captureId))) return "gone";
    return { failed: error };
  }
}

/** How reading the copy as a `.env` came out: the paste panel is open on its rows, a lock or a gone copy (nothing to say), or the refusal. */
export type CaptureEnvResult = "opened" | "stale" | "gone" | { failed: unknown };

/**
 * "Save as separate keys": the shell reads the copy as a `.env` and parks it as a paste (names only come back); the copy goes into the paste, so
 * the shell's slot is empty, and the paste panel opens on the rows as if they had been pasted, in `folder` (what the box had chosen). If the box was
 * closed meanwhile (Cancel while the shell was reading), the panel does not open and the values are let go as Cancel would. A refusal is said in the box.
 */
export async function captureAsEnv(session: number, id: string, folder: string): Promise<CaptureEnvResult> {
  const entry = sessionOf(session);
  if (entry === undefined || entry.readOnly) return "stale";
  const { generation } = entry;
  converting = id;
  let opened = false;
  try {
    const answer = await api.captureEnv({ session, generation }, id);
    if (!stillOpen(session, generation)) return "stale";
    const rows = answer.data;
    // The box that asked is still the one on screen, with no newer copy in it: a second press while this was on its way has a copy of its own (the
    // same box, which this must not close), and a box that was cancelled has nothing to open on. Either way the values this read parked are let go.
    if (state.capture?.id !== id) {
      if (rows.token !== null) releaseEnv(session, generation, rows.token, rows.rows.map((row) => row.index));
      return "gone";
    }
    endCapture(false);
    opened = true;
    pasteOpenings += 1;
    openTool(session, { kind: "paste_env", opening: pasteOpenings, rows, folder });
    return "opened";
  } catch (error) {
    if (refusedAsLocked(error)) dropIfStillOpen(session, generation);
    if (error instanceof api.StaleAnswer || !stillOpen(session, generation)) return "stale";
    if (refusedWith(error, "not_found")) {
      if (state.capture?.id === id) endCapture(false);
      return "gone";
    }
    return { failed: error };
  } finally {
    if (converting === id) converting = null;
    // The shell let go of the copy as it read it, and the read did not take it over: the box goes, as the shell's `gone` would have closed it.
    if (goneWhileConverting === id) {
      goneWhileConverting = null;
      if (!opened && state.capture?.id === id) endCapture(false);
    }
  }
}

/**
 * The box's own unlock, for the vault chosen in it while it is locked (8b's content in the panel): sends the vault's registry ID and the text, once, and nothing else;
 * the screen wipes its box as it calls this. `"stale"` (nothing sent) unless the box is still the one that asked (`opening`) with that same vault chosen, and also when
 * the vault locked again before the answer was read, which is not an error. A refusal (a wrong password) is thrown for the box to say. The vault opens behind the window
 * on screen (the window stays; with none open it is the window): its session is seated like any, which turns the box's choice into that session and hands the copy to
 * it (`capture_choose`) only while the box's choice is still that vault. A choice changed meanwhile leaves the vault open behind, with the copy handed to none.
 */
export async function unlockInBox(opening: number, choice: Extract<SaveChoice, { kind: "locked" }>, password: string): Promise<"opened" | "stale"> {
  const capture = state.capture;
  if (capture?.opening !== opening || !sameChoice(capture.choice, choice) || password === "") return "stale";
  let answer: api.Tagged<api.UnlockView>;
  try {
    answer = await api.unlockVault({ list: choice.list, id: choice.vault }, password);
  } catch (error) {
    // A lock of every vault, or the window's close, that lands during the unlock is refused as locked: no session exists yet for a lock event to clear.
    if (error instanceof api.StaleAnswer || refusedAsLocked(error)) return "stale";
    throw error;
  }
  // Held already (the same vault unlocked elsewhere meanwhile): nothing is made twice; the box's choice is settled on it.
  if (sessionOf(answer.session)?.generation === answer.generation) {
    seatCapture();
    return "opened";
  }
  return publishUnlock(answer, choice.vault, "behind", false, choice.list);
}

/** Opens the search (Ctrl+F, Ctrl+K): the one search, empty. It does nothing when there is no vault open, or one is open already. */
export function openSearch(): void {
  if (state.search !== null || state.sessions.length === 0) return;
  searchRun += 1;
  searchShown = searchRun;
  searchOpening += 1;
  set({ ...state, search: { query: "", answered: null, hits: [], busy: [], error: null, asking: null } });
}

/** Closes the search and forgets what was typed and found; an answer still on its way is dropped. */
export function closeSearch(): void {
  searchRun += 1;
  searchShown = searchRun;
  searchOpening += 1;
  if (state.search !== null) set({ ...state, search: null });
}

/**
 * Types in the search: what each unlocked vault finds comes back through the shell, and only the latest question's
 * answer is kept. A vault that locked meanwhile is left out with nothing said. Nothing is asked for a blank word.
 */
export async function setSearchQuery(query: string): Promise<void> {
  const current = state.search;
  if (current === null) return;
  searchRun += 1;
  const run = searchRun;
  const blank = query.trim() === "";
  if (blank) searchShown = run;
  set({ ...state, search: { ...current, query, error: null, ...(blank ? { answered: null, hits: [], busy: [] } : {}) } });
  if (blank) return;
  try {
    const answer = await api.searchAll(query);
    if (run !== searchRun || state.search === null) return;
    // Only the vaults still open as they were read: a lock on the way takes that vault's results away, with no error.
    const hits = answer.hits
      .filter((found) => stillOpen(found.session, found.generation))
      .map((found) => ({ session: found.session, generation: found.generation, items: found.data }));
    const busy = answer.busy.filter((session) => sessionOf(session) !== undefined);
    searchShown = run;
    set({ ...state, search: { ...state.search, answered: query, hits, busy, error: null } });
  } catch (error) {
    if (run !== searchRun || state.search === null) return;
    searchShown = run;
    set({ ...state, search: { ...state.search, answered: null, hits: [], busy: [], error } });
  }
}

function sayInSearch(error: unknown): void {
  if (state.search !== null) set({ ...state, search: { ...state.search, error } });
}

/** Puts the vault on screen (the one opened last is shown) and opens the item in its panel, closing the search. */
export function showResult(session: number, id: string): void {
  const entry = sessionOf(session);
  if (entry === undefined) return;
  set({ ...state, sessions: withFront(state.sessions, entry) });
  closeSearch();
  void selectItem(session, id);
}

/**
 * Copy from a search result: the copy is made by the shell, then the search steps aside and the login opens behind it
 * with the message about the copy and its clear time. A refusal is said in the search, which stays.
 */
export async function copyFromSearch(session: number, id: string, field: CopyableField): Promise<void> {
  // As the file actions do: an answer that comes after the person left this search (closed it, typed another word, opened a
  // form) still tells the copy, but neither opens the old result over what is on screen now nor says a refusal in a newer search.
  const origin = searchOrigin();
  const done = await copyAndTell(session, id, field);
  if (!stillWhere(session, origin)) return;
  if (done === "done") showResult(session, id);
  else if (typeof done === "object") sayInSearch(done.failed);
}

/** "Open site" on a search result: the login's first website, opened by the shell. A refusal is said in the search. */
export async function openFromSearch(session: number, id: string): Promise<void> {
  const done = await openAndTell(session, id, 0);
  if (typeof done === "object") sayInSearch(done.failed);
}

/**
 * 2c's Clear now, on a copy message: asks the shell to take Lockbox's copy off the clipboard, and says what it found in place of the
 * countdown. A message that changed meanwhile (a newer copy, anything else) is left as it is.
 */
export async function clearCopiedNow(): Promise<void> {
  const shown = state.toast;
  if (shown?.kind !== "copied") return;
  try {
    const found = await api.clearCopied();
    if (state.toast !== shown) return;
    say(
      shown.session,
      found === "cleared"
        ? "Clipboard cleared"
        : found === "gone"
          ? "It's no longer on the clipboard"
          : "Another app is using the clipboard. Lockbox clears it as soon as it can.",
    );
  } catch (error) {
    if (state.toast === shown) sayFailure(shown.session, error);
  }
}

/** Takes the message away. */
export function clearToast(): void {
  if (state.toast !== null) set({ ...state, toast: null });
}

/** Keeps a value the person asked to see, for as long as the vault stays unlocked. Refused for a vault that is not. */
export function addReveal(session: number, id: string, value: string): void {
  update(session, (entry) => ({ ...entry, reveals: { ...entry.reveals, [id]: value } }));
}

export function getReveal(session: number, id: string): string | undefined {
  return sessionOf(session)?.reveals[id];
}

/** Keeps text typed into a form, by name, for as long as the vault stays unlocked. */
export function setForm(session: number, name: string, value: string): void {
  update(session, (entry) => ({ ...entry, forms: { ...entry.forms, [name]: value } }));
}

export function getForm(session: number, name: string): string | undefined {
  return sessionOf(session)?.forms[name];
}

export function useSessions(): SessionData[] {
  return useSelect((current) => current.sessions);
}

export function useVaults(): VaultEntry[] | null {
  return useSelect((current) => current.vaults);
}

export function useStartError(): unknown {
  return useSelect((current) => current.startError);
}

/** Whether the vault list could not be read because the file is damaged (see `isVaultListDamaged`). */
export function useVaultListDamaged(): boolean {
  return useSelect((current) => isVaultListDamaged(current.startError));
}

export function useToast(): Toast | null {
  return useSelect((current) => current.toast);
}

export function useNotices(): Notices {
  return useSelect((current) => current.notices);
}

/** What the lock screen says about the vault with this registry ID (Ask 16), or `null` for nothing (and for no vault chosen). */
export function useLockNote(vault: number | null): unknown {
  return useSelect((current) => (vault === null ? null : (current.lockNotes.find((note) => note.vault === vault)?.refusal ?? null)));
}

/** The search, or `null` while it is closed. */
export function useSearch(): SearchState | null {
  return useSelect((current) => current.search);
}

/** The settings as the shell has them saved, or the defaults while the page has none. */
export function useSettings(): api.Settings {
  return useSelect((current) => current.settings ?? DEFAULT_SETTINGS);
}

/** The copy the save shortcut left waiting, or `null` for none. */
export function useCapture(): CaptureView | null {
  return useSelect((current) => current.capture);
}

/** The number of the box the waiting copy is in, or `null` for no copy: for the app, which mounts the box by it, with no redraw for the copy's other changes. */
export function useCaptureOpening(): number | null {
  return useSelect((current) => current.capture?.opening ?? null);
}

/** Whether a copy waits, and so the save box is up: for a window that makes room for the box and leaves its own panels be, with no redraw for the copy's changes. */
export function useCaptureWaiting(): boolean {
  return useSelect((current) => current.capture !== null);
}

/** The vault's item list, or `null` while it is on its way or when the vault is not unlocked. */
export function useItems(session: number): ItemSummary[] | null {
  return useSelect((current) => current.sessions.find((entry) => entry.session === session)?.items ?? null);
}

/** The same, for code that is not a component. */
export function openedItems(session: number): ItemSummary[] | null {
  return sessionOf(session)?.items ?? null;
}

export function useForm(session: number, name: string): string {
  return useSelect((current) => current.sessions.find((entry) => entry.session === session)?.forms[name] ?? "");
}

/** For tests: the store as it stands. */
export function debugState(): StoreState {
  return state;
}

/** For tests: back to a page that has just opened. */
export function resetStoreForTests(): void {
  started = undefined;
  noticesStarted = undefined;
  captureStarted = undefined;
  captureHeard = 0;
  choosing = null;
  chooseSent = null;
  converting = null;
  goneWhileConverting = null;
  captureOpenings = 0;
  handTicket = 0;
  confirmingClose = false;
  searchRun = 0;
  searchShown = 0;
  searchOpening = 0;
  retryingOpen = false;
  retryingRestore = false;
  dismissingRestore = false;
  forgotOpenings = 0;
  forgotRuns = 0;
  unlockOpenings = 0;
  newVaultOpenings = 0;
  addFolderOpenings = 0;
  settingsLine = Promise.resolve();
  shortcutNoticeVoid = false;
  listRuns.clear();
  detailRuns.clear();
  olderListingLine = Promise.resolve();
  olderOpenLine = Promise.resolve();
  olderOpenTickets = 0;
  olderOpenAbandoned = 0;
  olderDeleteTickets = 0;
  olderDeleteAbandoned = 0;
  cleanupNotices = 0;
  resetJobsForTests();
  resetCloseAskForTests();
  state = EMPTY;
  for (const notify of listeners) notify();
}
