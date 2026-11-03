import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import { call, callPair, callPlain, onLocked, open, type Opened, type Outcome, type RestoreNotice } from "./bridge";
import { useDroppedFileReachedPage } from "./dropProbe";

interface AppInfo {
  version: string;
}

interface VaultEntry {
  id: number;
  name: string | null;
  available: boolean;
}

const OUTSIDE = "https://example.com";

// The hands-on checks' own vault, in the default vaults folder. Its password guards nothing real.
const TEST_VAULT = "Lockbox test vault";
const TEST_VAULT_PASSWORD = "hands-on check only";

// The test login the hands-on checks add. Its password guards nothing real.
const TEST_LOGIN = {
  title: "Test login",
  username: "test@example.com",
  password: "hands-on check only",
  url: "https://example.com",
};

// The session the last create or unlock opened: "Add test login" adds to it.
let testSession: { session: number; generation: number } | undefined;

// The test login "Add test login" made last, with the session it was made in: "Copy test password" copies its password.
let testLogin: { session: number; generation: number; id: string } | undefined;

// A stored file, with the session it was added in.
interface StoredFile {
  session: number;
  generation: number;
  id: string;
  fileId: string;
}

// The file item "Add test file" made last, and its stored file: "Save a copy" saves that file.
let testFile: StoredFile | undefined;

// What the two "Open test" buttons open, each added once through the open dialog. A file whose open asked first is
// confirmed by pressing its button again.
const testOpens = {
  PDF: { file: undefined as StoredFile | undefined, asked: false },
  ".cmd": { file: undefined as StoredFile | undefined, asked: false },
};

// The part of `get_item`'s answer the test page reads: the stored files' IDs.
interface ItemFiles {
  summary: { attachments: { file_id: string }[] };
}

// What an opening command's answer means for the test page.
function describe(answer: Opened<unknown>, done: string): string {
  if (answer === "Dismissed") return "Closed";
  if ("Confirm" in answer) return "Asked first: the folder is synced by a cloud provider";
  testSession = { session: answer.session, generation: answer.generation };
  return `${done} (session ${String(answer.session)})`;
}

// Errors carry fixed fields only (a code and fixed text), so the page shows them as they are.
function failed(error: unknown): string {
  return `Refused: ${JSON.stringify(error)}`;
}

async function createTestVault(): Promise<string> {
  const answer = await open("create_vault", {
    name: TEST_VAULT,
    password: TEST_VAULT_PASSWORD,
    choose_folder: false,
  });
  return describe(answer, "Created and unlocked");
}

async function unlockTestVault(): Promise<string> {
  const vaults = await callPlain<VaultEntry[]>("list_vaults");
  const vault = vaults.find((entry) => entry.name === TEST_VAULT);
  if (vault === undefined) return "No test vault yet: create it first";
  const answer = await open("unlock_vault", { id: vault.id, password: TEST_VAULT_PASSWORD });
  return describe(answer, "Unlocked");
}

// A new login in the open test vault, then its first edit (revision 0): the item commands end to end.
async function addTestLogin(): Promise<string> {
  if (testSession === undefined) return "No test vault open: create or unlock it first";
  const { session, generation } = testSession;
  const created = await call<string>("new_item", {
    session,
    generation,
    kind: "login",
    title: TEST_LOGIN.title,
    collection: null,
  });
  await call<null>("update_item", {
    session,
    generation,
    edit: {
      id: created.data,
      revision: 0,
      title: TEST_LOGIN.title,
      notes: "",
      collection: null,
      username: TEST_LOGIN.username,
      password: TEST_LOGIN.password,
      urls: [TEST_LOGIN.url],
    },
  });
  testLogin = { session, generation, id: created.data };
  return `Test login added (session ${String(session)})`;
}

// The test login's password onto the clipboard, copied in Rust: the password never reaches this page.
async function copyTestPassword(): Promise<string> {
  if (testLogin === undefined) return "No test login yet: add it first";
  const { session, generation, id } = testLogin;
  await call<null>("copy_field", { session, generation, id, field: "password" });
  return `Test password copied (session ${String(session)}): paste it, then wait for the clear`;
}

// A file picked in Rust's own open dialog, stored as a new file item in the open test vault: its path never reaches
// this page. A string says why there is none.
async function storePickedFile(): Promise<StoredFile | string> {
  if (testSession === undefined) return "No test vault open: create or unlock it first";
  const { session, generation } = testSession;
  const added = await call<Outcome<string>>("add_file", { session, generation, collection: null });
  if (added.data === "Dismissed") return "Closed";
  if (!("Done" in added.data)) return "Asked first";
  const id = added.data.Done;
  const item = await call<ItemFiles>("get_item", { session, generation, id });
  const fileId = item.data.summary.attachments[0]?.file_id;
  if (fileId === undefined) return "The new item holds no file";
  return { session, generation, id, fileId };
}

async function addTestFile(): Promise<string> {
  const file = await storePickedFile();
  if (typeof file === "string") return file;
  testFile = file;
  return `Test file added (session ${String(file.session)})`;
}

// Opens the file this button stored (picking it first, or again when the vault has been locked since). A type that can
// run code asks first; pressing the button again says yes.
async function openTestFile(kind: keyof typeof testOpens): Promise<string> {
  const test = testOpens[kind];
  const current = test.file?.session === testSession?.session && test.file?.generation === testSession?.generation;
  if (test.file === undefined || !current) {
    const file = await storePickedFile();
    if (typeof file === "string") return file;
    test.file = file;
    test.asked = false;
  }
  const { session, generation, id, fileId } = test.file;
  const opened = await call<Outcome<null>>("open_file", {
    session,
    generation,
    id,
    file_id: fileId,
    confirmed_executable: test.asked,
  });
  if (opened.data !== "Dismissed" && "Confirm" in opened.data) {
    test.asked = true;
    return `Asked first: this file can run code. Press "Open test ${kind}" again to open it`;
  }
  test.asked = false;
  return `Opened read-only (session ${String(session)}): it goes when the vault locks`;
}

// Tries again to remove the opened copies a viewer held when the vault locked.
async function retryOpenCleanup(): Promise<string> {
  const { removed, still_open } = await callPlain<{ removed: number; still_open: number }>("retry_open_cleanup");
  return `Opened copies: ${String(removed)} removed, ${String(still_open)} still held`;
}

// A decrypted copy of the test file, where Rust's own save dialog says (Windows asks there before replacing a file).
async function saveTestCopy(): Promise<string> {
  if (testFile === undefined) return "No test file yet: add it first";
  const { session, generation, id, fileId } = testFile;
  const saved = await call<Outcome<null>>("save_file_copy", { session, generation, id, file_id: fileId });
  if (saved.data === "Dismissed") return "Closed";
  return `Copy saved (session ${String(session)})`;
}

// What the backup commands answer, as the test page reads them (the shell's `BackupView` and `BackupSummaryView`).
interface BackupMade {
  items: number;
  files: number;
  damaged_items: number;
  damaged_files: number;
  missing_files: number;
  size_on_disk: number;
}

interface BackupFound {
  created_at: string;
  items: number;
  files: number;
  missing_files: number;
  size_on_disk: number;
}

// The part of `list_items`'s answer the test page reads.
interface ItemsListed {
  items: { id: string; kind: string; trashed: boolean }[];
}

// The backup opened read-only last, and whether the last copy out asked about missing files (pressing the button
// again says yes).
let testBackup: { session: number; generation: number } | undefined;
let copyAsked = false;

// The test vault's backup, where Rust's save dialog says. The name must end in .lockbox-backup.
async function backUpTestVault(): Promise<string> {
  if (testSession === undefined) return "No test vault open: create or unlock it first";
  const { session, generation } = testSession;
  const made = await call<Outcome<BackupMade>>("backup_vault", { session, generation });
  if (made.data === "Dismissed") return "Closed";
  if (!("Done" in made.data)) return "Asked first";
  const b = made.data.Done;
  return (
    `Backup made (session ${String(session)}): ${String(b.items)} items, ${String(b.files)} files; left out: ` +
    `${String(b.damaged_items)} damaged items, ${String(b.damaged_files)} damaged files, ` +
    `${String(b.missing_files)} missing files; ${String(b.size_on_disk)} bytes on disk`
  );
}

// Checks a backup the test vault's password opens, without restoring it.
async function testTheBackup(): Promise<string> {
  const tested = await callPlain<Outcome<BackupFound>>("test_backup", {
    credential: { password: TEST_VAULT_PASSWORD },
  });
  if (tested === "Dismissed") return "Closed";
  if (!("Done" in tested)) return "Asked first";
  const b = tested.Done;
  return (
    `Backup is good: made ${b.created_at}, ${String(b.items)} items, ${String(b.files)} files, ` +
    `${String(b.missing_files)} files missing; ${String(b.size_on_disk)} bytes on disk`
  );
}

// Opens a backup the test vault's password opens, as a read-only session of its own: "Copy an item out" copies from it.
async function openBackupReadOnly(): Promise<string> {
  const opened = await open<unknown>("open_backup_read_only", { credential: { password: TEST_VAULT_PASSWORD } });
  if (opened === "Dismissed") return "Closed";
  if ("Confirm" in opened) return "Asked first";
  testBackup = { session: opened.session, generation: opened.generation };
  copyAsked = false;
  return `Backup opened read-only (session ${String(opened.session)})`;
}

// The backup's first item (not a collection, not in the trash) copied into the open test vault. A backup that lacks
// some of its files asks first; pressing the button again copies it without them.
async function copyItemOut(): Promise<string> {
  if (testBackup === undefined) return "No backup open: open one read-only first";
  if (testSession === undefined) return "No test vault open: create or unlock it first";
  const { session: from, generation: fromGeneration } = testBackup;
  const { session: to, generation: toGeneration } = testSession;
  const listed = await call<ItemsListed>("list_items", { session: from, generation: fromGeneration });
  const item = listed.data.items.find((entry) => entry.kind !== "collection" && !entry.trashed);
  if (item === undefined) return "The backup holds no item to copy";
  // Tagged with the vault; dropped too when the backup (the source) locked meanwhile.
  const copied = await callPair<Outcome<{ id: string; left_out: string[] }>>(
    "copy_item_to",
    {
      from,
      from_generation: fromGeneration,
      id: item.id,
      to,
      to_generation: toGeneration,
      skip_missing: copyAsked,
    },
    { session: from, generation: fromGeneration },
  );
  if (copied.data === "Dismissed") return "Closed";
  if ("Confirm" in copied.data) {
    const { Confirm: question } = copied.data;
    if (typeof question !== "object" || !("MissingFiles" in question)) return "Asked first";
    copyAsked = true;
    return `Asked first: the backup lacks ${question.MissingFiles.names.join(", ")}. Press "Copy an item out" again to copy without them`;
  }
  copyAsked = false;
  const { left_out: leftOut } = copied.data.Done;
  return `Item copied into session ${String(to)}; left out: ${leftOut.length === 0 ? "nothing" : leftOut.join(", ")}`;
}

// What the restore commands answer, as the test page reads them (the shell's `RestorePreparedView`, `RestoredView` and
// `PreRestoreEntry`).
interface RestorePrepared {
  restore: number;
  name: string;
  replaces_existing: boolean;
}

interface Restored {
  vault: number;
  before_restore: boolean;
}

interface PreRestoreEntry {
  id: number;
  vault: number;
  name: string | null;
  folder: string;
}

// The restore the last "Restore a backup" prepared, waiting for "Finish restore" or "Cancel restore"; the question it
// asked (answered by "Answer restore question"); the pre-restore copies last listed; and whether the last delete or
// dismissal asked first (pressing the button again says yes).
let testRestore: number | undefined;
let restoreQuestion: { token: string; name: string | null } | undefined;
let preRestoreCopies: PreRestoreEntry[] = [];
let deleteAsked = false;
let dismissAsked = false;

// What a notice says, in words for the test page. The paths are the user's own folders, shown so they can act.
function describeNotice(notice: RestoreNotice): string {
  switch (notice.state) {
    case "none":
      return "nothing to tell";
    case "recovered":
      return `recovered (${notice.how})`;
    case "drive_missing":
      return `the drive is not connected; ${notice.paths.target} cannot be checked`;
    case "pending":
      return `recovery is not finished (${notice.paths.step}) in ${notice.paths.target}; try again or dismiss`;
    case "unclear":
      return `the journal ${notice.journal} cannot be acted on; dismiss it${
        notice.paths === null ? "" : ` (it names ${notice.paths.target})`
      }`;
  }
}

// What a restore_prepare or restore_prepare_confirm answer means for the test page.
function describeRestore(answer: Outcome<RestorePrepared>): string {
  restoreQuestion = undefined;
  if (answer === "Dismissed") return "Closed";
  if ("Confirm" in answer) {
    const { Confirm: question } = answer;
    if (typeof question === "object" && "NewFolder" in question) {
      restoreQuestion = { token: question.NewFolder.token, name: question.NewFolder.suggested };
      return `Asked first: the vault folder there cannot be read. Press "Answer restore question" to restore beside it as ${question.NewFolder.suggested}`;
    }
    if (typeof question === "object" && "CloudFolder" in question) {
      restoreQuestion = { token: question.CloudFolder.token, name: null };
      return 'Asked first: the folder is synced by a cloud provider. Press "Answer restore question" to go on';
    }
    if (typeof question === "object" && "Recovery" in question) {
      return `A restore was left half-done; recovery ran: ${describeNotice(question.Recovery.notice)}. Press "Restore a backup" again to start`;
    }
    return "Asked first";
  }
  const { restore, name, replaces_existing: replaces } = answer.Done;
  testRestore = restore;
  return `Restore ready: ${name} ${replaces ? "replaces the vault there" : "is added as a new vault"}. Press "Finish restore" to swap it in, or "Cancel restore"`;
}

// Restores a backup (picked in Rust's dialogs, with the folder to restore into) with the test vault's password.
async function restoreTestBackup(): Promise<string> {
  const answer = await callPlain<Outcome<RestorePrepared>>("restore_prepare", {
    credential: { password: TEST_VAULT_PASSWORD },
    destination: "same_vault",
  });
  return describeRestore(answer);
}

async function answerRestoreQuestion(): Promise<string> {
  if (restoreQuestion === undefined) return "No restore question to answer";
  const { token, name } = restoreQuestion;
  return describeRestore(await callPlain<Outcome<RestorePrepared>>("restore_prepare_confirm", { token, name }));
}

// Whether a refusal means Rust no longer has the restore: it was cancelled by a lock, is not there, or ended in a state
// recovery handles (or the vault is on disk but not listed). Any other refusal (busy, the vault in use, an engine
// error it kept the staged restore for) leaves it prepared, so the same ID can be retried or discarded.
function endsRestore(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const refusal = error as { code?: string; kind?: string; what?: string };
  return (
    refusal.code === "cancelled" ||
    refusal.code === "not_found" ||
    (refusal.code === "core" && refusal.kind === "restore_pending") ||
    (refusal.code === "invalid_input" && refusal.what === "vault not listed")
  );
}

async function finishRestore(): Promise<string> {
  if (testRestore === undefined) return "No restore prepared: press Restore a backup first";
  const restore = testRestore;
  let restored: Restored;
  try {
    restored = await callPlain<Restored>("restore_commit", { restore });
  } catch (error) {
    if (endsRestore(error)) testRestore = undefined;
    throw error;
  }
  testRestore = undefined;
  return `Restored (vault ${String(restored.vault)})${
    restored.before_restore ? ': the old vault is kept beside it; see "List pre-restore copies"' : ""
  }`;
}

async function cancelRestore(): Promise<string> {
  if (testRestore === undefined) return "No restore prepared";
  const restore = testRestore;
  try {
    await callPlain<null>("restore_discard", { restore });
  } catch (error) {
    if (endsRestore(error)) testRestore = undefined;
    throw error;
  }
  testRestore = undefined;
  return "Restore cancelled; nothing changed";
}

async function restoreStatus(): Promise<string> {
  return `Restore status: ${describeNotice(await callPlain<RestoreNotice>("restore_notice"))}`;
}

async function retryRestoreRecovery(): Promise<string> {
  return `Restore recovery: ${describeNotice(await callPlain<RestoreNotice>("retry_restore_recovery"))}`;
}

// Dismisses a restore journal recovery could not act on: asks first, with what is left behind; again says yes.
async function dismissRestoreJournal(): Promise<string> {
  const answer = await callPlain<Outcome<null>>("dismiss_restore", { confirm: dismissAsked });
  if (answer !== "Dismissed" && "Confirm" in answer) {
    dismissAsked = true;
    const { Confirm: question } = answer;
    const leaves = typeof question === "object" && "Dismissal" in question ? question.Dismissal.leaves : undefined;
    return `Asked first: dismissing leaves ${leaves?.staging ?? "no staging folder"} and ${
      leaves?.before_restore ?? "no pre-restore folder"
    }. Press "Dismiss restore journal" again to dismiss`;
  }
  dismissAsked = false;
  return "Restore journal dismissed (or there was none)";
}

async function listPreRestore(): Promise<string> {
  preRestoreCopies = await callPlain<PreRestoreEntry[]>("list_pre_restore");
  deleteAsked = false;
  if (preRestoreCopies.length === 0) return "No pre-restore copies";
  return `Pre-restore copies: ${preRestoreCopies.map((copy) => copy.folder).join(", ")}`;
}

// The first listed copy opened read-only (with the test vault's password), as the backup session "Copy an item out" uses.
async function openPreRestore(): Promise<string> {
  const copy = preRestoreCopies[0];
  if (copy === undefined) return "No pre-restore copy listed: press List pre-restore copies first";
  const opened = await open<unknown>("open_pre_restore_read_only", {
    id: copy.id,
    credential: { password: TEST_VAULT_PASSWORD },
  });
  if (opened === "Dismissed" || "Confirm" in opened) return "Asked first";
  testBackup = { session: opened.session, generation: opened.generation };
  copyAsked = false;
  return `${copy.folder} opened read-only (session ${String(opened.session)})`;
}

// Deletes the first listed copy for good: asks first; pressing the button again says yes.
async function deletePreRestore(): Promise<string> {
  const copy = preRestoreCopies[0];
  if (copy === undefined) return "No pre-restore copy listed: press List pre-restore copies first";
  const answer = await callPlain<Outcome<null>>("delete_pre_restore", { id: copy.id, confirm: deleteAsked });
  if (answer !== "Dismissed" && "Confirm" in answer) {
    deleteAsked = true;
    return `Asked first: delete ${copy.folder} for good? Press "Delete a pre-restore copy" again to delete it`;
  }
  deleteAsked = false;
  preRestoreCopies = preRestoreCopies.slice(1);
  return `${copy.folder} deleted`;
}

// A same-origin `blob:` download, which WebView2 saves straight to Downloads unless the window refuses it (a
// `data:` link does not reliably start a download, so it could not show the rule failing).
function downloadProbeFile(): void {
  const url = URL.createObjectURL(new Blob(["x"], { type: "text/plain" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "lockbox-probe.txt";
  link.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 10_000);
}

// A bare test page: the real screens come in Plan 4. Each hands-on check gets a probe here, with what "passes" means.
export default function App() {
  const [version, setVersion] = useState<string>();
  const [launchNotices, setLaunchNotices] = useState<string>();
  const [vaultStatus, setVaultStatus] = useState<string>();
  // The sessions a backup is running for (`lockbox://busy` lists each session's running operations).
  const [backingUp, setBackingUp] = useState<number[]>([]);
  // A restore is preparing or swapping (it has no session: `lockbox://busy` names it with a null one).
  const [restoring, setRestoring] = useState(false);
  const droppedFileReachedPage = useDroppedFileReachedPage();

  function run(step: () => Promise<string>): void {
    step().then(setVaultStatus, (error: unknown) => {
      setVaultStatus(failed(error));
    });
  }

  useEffect(() => {
    callPlain<AppInfo>("app_info").then(
      (info) => {
        setVersion(info.version);
      },
      () => {
        setVersion("(version unavailable)");
      },
    );
    // What launch found (the output sweep's counts), kept by Rust: its event went out before this page listened.
    callPlain<unknown[]>("launch_notices").then(
      (notices) => {
        setLaunchNotices(notices.length === 0 ? "none" : JSON.stringify(notices));
      },
      (error: unknown) => {
        setLaunchNotices(failed(error));
      },
    );
  }, []);

  // A lock: what the page shows of vault data goes (a missing-files question names the user's files), and so does a
  // session of the test page that locked, so its buttons say nothing is open.
  useEffect(() => {
    const listening = onLocked(({ session }) => {
      setVaultStatus(undefined);
      if (testSession?.session === session) testSession = undefined;
      if (testBackup?.session === session) testBackup = undefined;
      copyAsked = false;
      // A lock may have dropped the questions waiting for a yes (a restore's, whose token a lock of all vaults drops).
      restoreQuestion = undefined;
      deleteAsked = false;
      dismissAsked = false;
    });
    return () => {
      listening.then(
        (unlisten) => {
          unlisten();
        },
        () => undefined,
      );
    };
  }, []);

  useEffect(() => {
    const listening = listen<{ session: number | null; operations: string[] }>("lockbox://busy", ({ payload }) => {
      const { session, operations } = payload;
      if (session === null) {
        setRestoring(operations.includes("restore"));
        return;
      }
      const running = operations.includes("backup");
      setBackingUp((now) => [...now.filter((other) => other !== session), ...(running ? [session] : [])]);
    });
    return () => {
      listening.then(
        (unlisten) => {
          unlisten();
        },
        () => undefined,
      );
    };
  }, []);

  // What a restore left that the user must hear about, while the app runs (launch's is in "Launch notices").
  useEffect(() => {
    const listening = listen<{ kind: string }>("lockbox://notice", ({ payload }) => {
      if (payload.kind !== "restore") return;
      setVaultStatus(`Restore notice: ${describeNotice(payload as unknown as RestoreNotice)}`);
    });
    return () => {
      listening.then(
        (unlisten) => {
          unlisten();
        },
        () => undefined,
      );
    };
  }, []);

  return (
    <main>
      <h1>Lockbox {version ?? ""}</h1>
      <p>Launch notices: {launchNotices ?? "…"}</p>
      <h2>Hands-on checks</h2>
      <ul>
        <li>
          <button
            type="button"
            onClick={() => {
              location.href = OUTSIDE;
            }}
          >
            Navigate away
          </button>{" "}
          Passes when this page stays.
        </li>
        <li>
          <button
            type="button"
            onClick={() => {
              window.open(OUTSIDE);
            }}
          >
            Open a popup
          </button>{" "}
          Passes when no window opens. (Checks the outcome only: wry refuses new windows even without the app&apos;s
          rule.)
        </li>
        <li>
          <button type="button" onClick={downloadProbeFile}>
            Download a file
          </button>{" "}
          Passes when no lockbox-probe.txt lands in Downloads.
        </li>
        <li>
          <div data-testid="drop-zone">Drop a file here</div>
          Passes when, after dragging a file in from Explorer, this never says otherwise.
          {droppedFileReachedPage && <strong> A dropped file reached the page</strong>}
        </li>
        <li>
          <button
            type="button"
            onClick={() => {
              run(createTestVault);
            }}
          >
            Create test vault
          </button>{" "}
          <button
            type="button"
            onClick={() => {
              run(unlockTestVault);
            }}
          >
            Unlock test vault
          </button>{" "}
          <button
            type="button"
            onClick={() => {
              run(addTestLogin);
            }}
          >
            Add test login
          </button>{" "}
          <button
            type="button"
            onClick={() => {
              run(copyTestPassword);
            }}
          >
            Copy test password
          </button>{" "}
          <button
            type="button"
            onClick={() => {
              run(addTestFile);
            }}
          >
            Add test file
          </button>{" "}
          <button
            type="button"
            onClick={() => {
              run(saveTestCopy);
            }}
          >
            Save a copy
          </button>{" "}
          <button
            type="button"
            onClick={() => {
              run(() => openTestFile("PDF"));
            }}
          >
            Open test PDF
          </button>{" "}
          <button
            type="button"
            onClick={() => {
              run(() => openTestFile(".cmd"));
            }}
          >
            Open test .cmd
          </button>{" "}
          <button
            type="button"
            onClick={() => {
              run(retryOpenCleanup);
            }}
          >
            Retry opened copies
          </button>{" "}
          <button
            type="button"
            onClick={() => {
              run(backUpTestVault);
            }}
          >
            Back up test vault
          </button>{" "}
          <button
            type="button"
            onClick={() => {
              run(testTheBackup);
            }}
          >
            Test a backup
          </button>{" "}
          <button
            type="button"
            onClick={() => {
              run(openBackupReadOnly);
            }}
          >
            Open backup read-only
          </button>{" "}
          <button
            type="button"
            onClick={() => {
              run(copyItemOut);
            }}
          >
            Copy an item out
          </button>{" "}
          {backingUp.length > 0 && <strong>Backup in progress </strong>}
          Backs up the test vault where you choose (a name ending in .lockbox-backup); checks a backup you pick with
          the test vault&apos;s password; opens one you pick as a read-only vault; copies its first item into the vault
          last opened (a backup that lacks some of the item&apos;s files asks first, and the same button again copies
          without them).{" "}
          <button
            type="button"
            onClick={() => {
              run(restoreTestBackup);
            }}
          >
            Restore a backup
          </button>{" "}
          <button
            type="button"
            onClick={() => {
              run(answerRestoreQuestion);
            }}
          >
            Answer restore question
          </button>{" "}
          <button
            type="button"
            onClick={() => {
              run(finishRestore);
            }}
          >
            Finish restore
          </button>{" "}
          <button
            type="button"
            onClick={() => {
              run(cancelRestore);
            }}
          >
            Cancel restore
          </button>{" "}
          <button
            type="button"
            onClick={() => {
              run(restoreStatus);
            }}
          >
            Restore status
          </button>{" "}
          <button
            type="button"
            onClick={() => {
              run(retryRestoreRecovery);
            }}
          >
            Retry restore recovery
          </button>{" "}
          <button
            type="button"
            onClick={() => {
              run(dismissRestoreJournal);
            }}
          >
            Dismiss restore journal
          </button>{" "}
          <button
            type="button"
            onClick={() => {
              run(listPreRestore);
            }}
          >
            List pre-restore copies
          </button>{" "}
          <button
            type="button"
            onClick={() => {
              run(openPreRestore);
            }}
          >
            Open a pre-restore copy
          </button>{" "}
          <button
            type="button"
            onClick={() => {
              run(deletePreRestore);
            }}
          >
            Delete a pre-restore copy
          </button>{" "}
          {restoring && <strong>Restore in progress </strong>}
          Restores a backup you pick (with the folder to restore into) with the test vault&apos;s password: the vault
          already there is kept beside it as a pre-restore copy, a question first (a cloud folder, a vault folder that
          cannot be read) is answered with the second button, and nothing is swapped until Finish restore; lists the
          pre-restore copies beside the vaults, opens the first read-only, and deletes it after asking; shows what
          recovery of a half-done restore found, tries it again, and dismisses a journal it could not act on (asking
          first, and the same button again says yes).{" "}
          Creates &quot;{TEST_VAULT}&quot; in the default vaults folder, then unlocks it from the vault list; adds a
          login to the vault last opened; copies that login&apos;s password to the clipboard; adds a file you pick to
          that vault; saves a copy of that file where you choose; adds a PDF or a .cmd file you pick and opens it (the
          .cmd asks first, and the same button again says yes); after a lock, tries again to remove opened copies a
          viewer held, and says how many are left.
          {vaultStatus !== undefined && <output> {vaultStatus}</output>}
        </li>
      </ul>
    </main>
  );
}
