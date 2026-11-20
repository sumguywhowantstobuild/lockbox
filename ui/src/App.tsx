import "@fontsource-variable/geist/index.css";
import "@fontsource-variable/geist-mono/index.css";
import { useEffect, useState } from "react";
import { focusButton } from "./focus";
import { LockboxParts } from "./parts/LockboxParts";
import { PortalContainerProvider } from "./parts/Portal";
import { vaultLook } from "./parts/Pattern";
import { CloseQuestion } from "./screens/CloseQuestion";
import { FirstClose } from "./screens/FirstClose";
import { ForgotPassword } from "./screens/ForgotPassword";
import { LockScreen, UnlockStep } from "./screens/LockScreen";
import { MainWindow } from "./screens/MainWindow";
import { OpenBackupSteps } from "./screens/OpenBackup";
import { RestoreFlow } from "./screens/RestoreFlow";
import { RestoreNotices } from "./screens/RestoreNotices";
import { SaveBox } from "./screens/SaveBox";
import { AddFolderStep } from "./screens/setup/AddFolderStep";
import { CreateVault } from "./screens/setup/CreateVault";
import { FirstRun } from "./screens/setup/FirstRun";
import { LostList } from "./screens/setup/LostList";
import { MoveIn } from "./screens/setup/MoveIn";
import { PickWords } from "./screens/setup/PickWords";
import { RecoveryKey } from "./screens/setup/RecoveryKey";
import {
  leaveNewVault,
  startCapture,
  startNotices,
  startStore,
  useAddFolder,
  useCaptureOpening,
  useForgot,
  useMoveIn,
  useNewVault,
  useNotices,
  useOpenBackup,
  useRestore,
  useSessions,
  useStartError,
  useUnlockStep,
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

/** Cancel or Escape on the new vault's form inside the window: the window that was on screen is back, and focus goes to the vault menu that opened the form. */
function leaveNewVaultToMenu(): void {
  leaveNewVault();
  focusButton(".vhead");
}

/**
 * The whole app: first-time setup while there is no vault, the lost-list screen while the list of vaults is damaged, the lock screen while none is open, the main window of the
 * vault on screen when one is open (and the unlock step of another vault, the form of a new vault, or the cloud question of an added folder above it, while one is up), and its recovery key step instead of that while the key has not been confirmed by picking its words. A restore
 * (24a to 24e) takes the whole window above any of these while it is open, and gives it back when it ends; so does the notice of a restore that didn't
 * finish, below an open restore; Open a backup begun from the lock screen (25a) does the same below those; moving to a new computer (26a to 26c) takes the place of the
 * first screen and the lock screen in the same way, and so does Forgot password (28a to 28e), which also stays over the vault its new password opens until 28e is answered. The
 * store starts listening for locks before anything asks the shell for anything. The first close of the window is explained
 * over whichever of these is up (5b). The save box (8a to 8e) is the app's: a waiting copy mounts it here, above the screen, and it is drawn over a vault's main
 * window (see `boxHost`). Light or dark follows the theme chosen in Settings, and Windows' own setting for System.
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
  // The unlock step of another vault (the vault menu, the vault strip, Copy to a vault) takes the window while a vault is open: it wears the colour of the vault it unlocks.
  const unlockStep = useUnlockStep();
  // The form of a new vault (the vault menu's New vault) and the cloud question of Add existing vault folder take the window the same way, while a vault is open.
  const newVault = useNewVault();
  const addFolder = useAddFolder();
  const stepping = active !== undefined && unlockStep !== null;
  const making = active !== undefined && newVault !== null;
  const place = stepping ? unlockStep.vault : active?.vaultId;
  // A new vault will be the last of the list, and wears the colour of that place from its form on.
  const position = making ? (vaults ?? []).length : place === undefined ? 0 : Math.max(0, (vaults ?? []).findIndex((vault) => vault.id === place));
  const look = vaultLook(position, stepping || making ? false : (active?.readOnly ?? false));

  let screen;
  // Whether the screen is a vault's main window: the one place the save box is drawn over.
  let onWindow = false;
  if (active !== undefined) {
    // A vault whose recovery key was not typed back yet shows that step and nothing of the vault (21c, 21d, 21f, and 29b for a key asked for from Settings).
    // Keyed by session: switching to another vault unmounts this one's window, so a form left behind sends nothing and its typed text is gone. The unlock step of
    // another vault, and the form of a new vault, are keyed by their opening, so a step opened again starts empty.
    if (newVault !== null) screen = <CreateVault key={`new-${String(newVault.opening)}`} inside onBack={leaveNewVaultToMenu} />;
    else if (addFolder?.phase === "cloud") screen = <AddFolderStep key={String(addFolder.opening)} step={addFolder} />;
    else if (unlockStep !== null) screen = <UnlockStep key={String(unlockStep.opening)} step={unlockStep} />;
    else if (active.recovery === null) {
      screen = <MainWindow key={String(active.session)} data={active} look={look} />;
      onWindow = true;
    } else if (active.recovery.phase === "pick") screen = <PickWords data={active} />;
    else screen = <RecoveryKey data={active} />;
  } else if (listDamaged) {
    // The list of vaults can't be read (Ask 12): its own screen, with the way out, instead of the lock screen's red sentence.
    screen = <LostList />;
  } else if (vaults !== null && vaults.length === 0 && startError === null) {
    // No vault at all: first-time setup (21a).
    screen = <FirstRun />;
  } else if (addFolder?.phase === "cloud") {
    // The lock screen's Add existing vault folder met a cloud-synced folder: the first screens' question takes the lock screen's place, and its Cancel gives the lock screen back.
    screen = <AddFolderStep key={String(addFolder.opening)} step={addFolder} />;
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
  // The save box (8a to 8e) is the app's, not a window's: it is mounted by its copy and drawn over whichever vault's main window is on screen, so a lock of the vault
  // under it, a switch, or the lock screen showing neither takes it nor loses what was typed in it. It is not drawn (and what is secret in it is wiped) while any
  // other screen or flow has the window.
  const boxOpening = useCaptureOpening();
  const covered = (restoring && moveIn?.step !== "here") || notice || openingFromLock || movingIn || forgetting;
  const boxHost = onWindow && !covered ? (active ?? null) : null;

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
          {boxOpening === null ? null : <SaveBox key={`box-${String(boxOpening)}`} host={boxHost} />}
          <FirstClose />
          <CloseQuestion />
        </div>
      </PortalContainerProvider>
    </LockboxParts>
  );
}
