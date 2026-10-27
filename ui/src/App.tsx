import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { useDroppedFileReachedPage } from "./dropProbe";

interface AppInfo {
  version: string;
}

const OUTSIDE = "https://example.com";

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
  const droppedFileReachedPage = useDroppedFileReachedPage();

  useEffect(() => {
    invoke<AppInfo>("app_info").then(
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
      </ul>
    </main>
  );
}
