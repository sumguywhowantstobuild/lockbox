import "@fontsource-variable/geist/index.css";
import "@fontsource-variable/geist-mono/index.css";
import { useEffect, useState } from "react";
import { LockboxParts } from "./parts/LockboxParts";
import { PortalContainerProvider } from "./parts/Portal";
import { vaultLook } from "./parts/Pattern";
import { CloseQuestion } from "./screens/CloseQuestion";
import { FirstClose } from "./screens/FirstClose";
import { ForgotPassword } from "./screens/ForgotPassword";
import { LockScreen } from "./screens/LockScreen";
import { MainWindow } from "./screens/MainWindow";
import { OpenBackupSteps } from "./screens/OpenBackup";
import { RestoreFlow } from "./screens/RestoreFlow";
import { RestoreNotices } from "./screens/RestoreNotices";
import { FirstRun } from "./screens/setup/FirstRun";
import { LostList } from "./screens/setup/LostList";
import { MoveIn } from "./screens/setup/MoveIn";
import { PickWords } from "./screens/setup/PickWords";
import { RecoveryKey } from "./screens/setup/RecoveryKey";
import {
  startCapture,
  startNotices,
  startStore,
  useForgot,
  useMoveIn,
  useNotices,
  useOpenBackup,
  useRestore,
  useSessions,
  useStartError,
  useVaultListDamaged,
  useVaults,
} from "./store";
import { useMode } from "./theme";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/components.css";
import "./styles/short-window.css";
import "./styles/high-contrast.css";
import "./styles/print.css";

/**
 * The whole app: first-time setup while there is no vault, the lost-list screen while the list of vaults is damaged, the lock screen while none is open, the main window of the
 * vault opened last when one is, and its recovery key step instead of that while the key has not been confirmed by picking its words. A restore
 * (24a to 24e) takes the whole window above any of these while it is open, and gives it back when it ends; so does the notice of a restore that didn't
 * finish, below an open restore; Open a backup begun from the lock screen (25a) does the same below those; moving to a new computer (26a to 26c) takes the place of the
 * first screen and the lock screen in the same way, and so does Forgot password (28a to 28e), which also stays over the vault its new password opens until 28e is answered. The
 * store starts listening for locks before anything asks the shell for anything. The first close of the window is explained
 * over whichever of these is up (5b). Light or dark follows the theme chosen in Settings, and Windows' own setting for System.
 */
export default function App() {
  const mode = useMode();
  const sessions = useSessions();
  const vaults = useVaults();
  const startError = useStartError();
  const listDamaged = useVaultListDamaged();
  // The element the floating parts (dialogs, menus) are drawn in, so they carry the screen's colours.
  const [root, setRoot] = useState<HTMLElement | null>(null);

  useEffect(() => {
    // Its refusals are kept in the store and said by the screens; nothing here is left unhandled. The notices that launch
    // kept (a damaged record of opened files, a finished restore) are asked for once locks can be heard, and then the save shortcut's
    // copy, if one is waiting from before the page loaded.
    void startStore()
      .then(() => startNotices())
      .then(() => startCapture());
  }, []);

  const active = sessions.at(-1);
  const position = active === undefined ? 0 : Math.max(0, (vaults ?? []).findIndex((vault) => vault.id === active.vaultId));
  const look = vaultLook(position, active?.readOnly ?? false);

  let screen;
  if (active !== undefined) {
    // A vault whose recovery key was not typed back yet shows that step and nothing of the vault (21c, 21d, 21f, and 29b for a key asked for from Settings).
    // Keyed by session: switching to another vault unmounts this one's window, so a form left behind sends nothing and its typed text is gone.
    if (active.recovery === null) screen = <MainWindow key={String(active.session)} data={active} look={look} />;
    else if (active.recovery.phase === "pick") screen = <PickWords data={active} />;
    else screen = <RecoveryKey data={active} />;
  } else if (listDamaged) {
    // The list of vaults can't be read (Ask 12): its own screen, with the way out, instead of the lock screen's red sentence.
    screen = <LostList />;
  } else if (vaults !== null && vaults.length === 0 && startError === null) {
    // No vault at all: first-time setup (21a).
    screen = <FirstRun />;
  } else {
    screen = <LockScreen />;
  }
  // A restore (24a to 24e) takes the whole window above whatever the app would show, and goes back to it when it ends. It is the app's, not a vault's:
  // a lock of the open vault does not take its steps away.
  const restore = useRestore();
  const restoring = restore !== null && restore.phase !== "picking";
  // Moving to a new computer (26a to 26c) is the app's too: it takes the place of the first screen and the lock screen while it is open, and a restore
  // begun from it comes above it, except that 26c takes the place of the restore's last step (24e) until its Unlock goes there.
  const moveIn = useMoveIn();
  const movingIn = moveIn !== null && active === undefined;
  // A restore that didn't finish (Asks 6 and 7, the two states beside them) takes the window the same way, below an open restore and above moving in: the
  // finished one is the lock screen's own and is not here.
  const { restore: unfinished } = useNotices();
  const notice = unfinished !== null && unfinished.ask !== "finished";
  // Open a backup (25a) begun from the lock screen takes the window the same way, below a restore and its notices; begun from a window it is that window's panel.
  const openFlow = useOpenBackup();
  const openingFromLock = openFlow !== null && openFlow.host === null && openFlow.phase !== "picking";
  // Forgot password (28a to 28e) is the app's too, begun from the lock screen: it takes the window above the lock screen and, at 28e, above the vault the new
  // password just opened, until its offer is answered.
  const forgetting = useForgot() !== null;

  return (
    <LockboxParts>
      <PortalContainerProvider value={root ?? undefined}>
        <div ref={setRoot} className={`app mode-${mode} v-${look.accent}`}>
          {restoring && moveIn?.step !== "here" ? (
            <RestoreFlow />
          ) : notice ? (
            <RestoreNotices />
          ) : openingFromLock ? (
            <OpenBackupSteps />
          ) : movingIn ? (
            <MoveIn />
          ) : forgetting ? (
            <ForgotPassword />
          ) : (
            screen
          )}
          <FirstClose />
          <CloseQuestion />
        </div>
      </PortalContainerProvider>
    </LockboxParts>
  );
}
