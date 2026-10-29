import { useEffect, useState } from "react";
import { call, callPlain, open, type Opened } from "./bridge";
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
  return `Test login added (session ${String(session)})`;
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
  }, []);

  return (
    <main>
      <h1>Lockbox {version ?? ""}</h1>
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
          Creates &quot;{TEST_VAULT}&quot; in the default vaults folder, then unlocks it from the vault list; adds a
          login to the vault last opened.
          {vaultStatus !== undefined && <output> {vaultStatus}</output>}
        </li>
      </ul>
    </main>
  );
}
