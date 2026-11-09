import { Button } from "../parts/Button";
import { Dialog } from "../parts/Dialog";
import { confirmFirstClose, useNotices } from "../store";

/**
 * 5b: what the first close of the window says. Every vault has locked and the window has stayed, so this is over whatever
 * screen is up (normally the lock screen). Escape and a click outside do nothing: neither is "Got it", and the window
 * would otherwise vanish into the tray, or the message would never be marked seen. Only the button answers, and the shell
 * hides the window then. A second close while it shows counts as the button, and the shell takes the message away itself.
 */
export function FirstClose() {
  const { firstClose } = useNotices();
  return (
    <Dialog
      open={firstClose}
      onOpenChange={() => undefined}
      title="Lockbox stays by the clock"
      description={[
        "Closing the window locks every vault, and Lockbox keeps running so the save shortcut works.",
        "To stop it completely, right-click its icon by the clock and choose Quit. This message shows once.",
      ]}
    >
      <Button
        look="pill-main"
        onClick={() => {
          void confirmFirstClose();
        }}
      >
        Got it
      </Button>
    </Dialog>
  );
}
