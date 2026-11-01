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

// The file item "Add test file" made last, and its stored file: "Save a copy" saves that file.
let testFile: { session: number; generation: number; id: string; fileId: string } | undefined;

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
// this page.
async function addTestFile(): Promise<string> {
  if (testSession === undefined) return "No test vault open: create or unlock it first";
  const { session, generation } = testSession;
  const added = await call<Outcome<string>>("add_file", { session, generation, collection: null });
  if (added.data === "Dismissed") return "Closed";
  if (!("Done" in added.data)) return "Asked first";
  const id = added.data.Done;
  const item = await call<ItemFiles>("get_item", { session, generation, id });
  const fileId = item.data.summary.attachments[0]?.file_id;
  if (fileId === undefined) return "The new item holds no file";
  testFile = { session, generation, id, fileId };
  return `Test file added (session ${String(session)})`;
}

// A decrypted copy of the test file, where Rust's own save dialog says (Windows asks there before replacing a file).
async function saveTestCopy(): Promise<string> {
  if (testFile === undefined) return "No test file yet: add it first";
  const { session, generation, id, fileId } = testFile;
  const saved = await call<Outcome<null>>("save_file_copy", { session, generation, id, file_id: fileId });
  if (saved.data === "Dismissed") return "Closed";
  return `Copy saved (session ${String(session)})`;
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
          Creates &quot;{TEST_VAULT}&quot; in the default vaults folder, then unlocks it from the vault list; adds a
          login to the vault last opened; copies that login&apos;s password to the clipboard; adds a file you pick to
          that vault; saves a copy of that file where you choose.
          {vaultStatus !== undefined && <output> {vaultStatus}</output>}
        </li>
      </ul>
    </main>
  );
}
