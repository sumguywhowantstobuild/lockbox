import "@fontsource-variable/geist/index.css";
import "@fontsource-variable/geist-mono/index.css";
import { useEffect, useState } from "react";
import { LockboxParts } from "./parts/LockboxParts";
import { PortalContainerProvider } from "./parts/Portal";
import { vaultLook } from "./parts/Pattern";
import { LockScreen } from "./screens/LockScreen";
import { MainWindow } from "./screens/MainWindow";
import { FirstRun } from "./screens/setup/FirstRun";
import { PickWords } from "./screens/setup/PickWords";
import { RecoveryKey } from "./screens/setup/RecoveryKey";
import { startStore, useSessions, useStartError, useVaults } from "./store";
import { useMode } from "./theme";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/components.css";
import "./styles/short-window.css";
import "./styles/high-contrast.css";
import "./styles/print.css";

/**
 * The whole app: first-time setup while there is no vault, the lock screen while none is open, the main window of the
 * vault opened last when one is, and its recovery key step instead of that while the key has not been confirmed by picking its words. The
 * store starts listening for locks before anything asks the shell for anything. Light or dark follows Windows.
 */
export default function App() {
  const mode = useMode();
  const sessions = useSessions();
  const vaults = useVaults();
  const startError = useStartError();
  // The element the floating parts (dialogs, menus) are drawn in, so they carry the screen's colours.
  const [root, setRoot] = useState<HTMLElement | null>(null);

  useEffect(() => {
    // Its refusals are kept in the store and said by the screens; nothing here is left unhandled.
    void startStore();
  }, []);

  const active = sessions.at(-1);
  const position = active === undefined ? 0 : Math.max(0, (vaults ?? []).findIndex((vault) => vault.id === active.vaultId));
  const look = vaultLook(position, active?.readOnly ?? false);

  let screen;
  if (active !== undefined) {
    // A vault whose recovery key was not typed back yet shows that step and nothing of the vault (21c, 21d, 21f).
    if (active.recovery === null) screen = <MainWindow data={active} look={look} />;
    else if (active.recovery.phase === "pick") screen = <PickWords data={active} />;
    else screen = <RecoveryKey data={active} />;
  } else if (vaults !== null && vaults.length === 0 && startError === null) {
    // No vault at all: first-time setup (21a).
    screen = <FirstRun />;
  } else {
    screen = <LockScreen />;
  }

  return (
    <LockboxParts>
      <PortalContainerProvider value={root ?? undefined}>
        <div ref={setRoot} className={`app mode-${mode} v-${look.accent}`}>
          {screen}
        </div>
      </PortalContainerProvider>
    </LockboxParts>
  );
}
