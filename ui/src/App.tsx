import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import { call, callPlain, open, type Opened, type Outcome } from "./bridge";
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

// `copy_item_to`'s answer: done, or the question about files the backup lacks. The bridge's `Confirm` type has no
// such variant yet, so the page reads it as it is.
type CopyAnswer =
  | { Done: { id: string; left_out: string[] } }
  | { Confirm: { MissingFiles: { names: string[] } } }
  | "Dismissed";

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
  const copied = await call<CopyAnswer>("copy_item_to", {
    from,
    from_generation: fromGeneration,
    id: item.id,
    to,
    to_generation: toGeneration,
    skip_missing: copyAsked,
  });
  if (copied.data === "Dismissed") return "Closed";
  if ("Confirm" in copied.data) {
    copyAsked = true;
    return `Asked first: the backup lacks ${copied.data.Confirm.MissingFiles.names.join(", ")}. Press "Copy an item out" again to copy without them`;
  }
  copyAsked = false;
  const { left_out: leftOut } = copied.data.Done;
  return `Item copied into session ${String(to)}; left out: ${leftOut.length === 0 ? "nothing" : leftOut.join(", ")}`;
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

  useEffect(() => {
    const listening = listen<{ session: number | null; operations: string[] }>("lockbox://busy", ({ payload }) => {
      const { session, operations } = payload;
      if (session === null) return;
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
