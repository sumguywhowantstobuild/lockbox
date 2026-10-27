import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";

interface AppInfo {
  version: string;
}

// A bare test page: the real screens come in Plan 4. Each later task adds a button for its hands-on check.
export default function App() {
  const [version, setVersion] = useState<string>();

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
      <ul></ul>
    </main>
  );
}
