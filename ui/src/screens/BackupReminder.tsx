import { useRef } from "react";
import { Button } from "../parts/Button";
import { Dialog } from "../parts/Dialog";
import { closeBanner, openBackup, type SessionData } from "../store";

/**
 * Ask 1, "Backup overdue": after an unlock, when the shell says the vault's last backup (or its making) is 30 or more days ago. A dialog named for the
 * vault, with the design's words. "Later" puts it away until the vault's next unlock (the page keeps that in the session's record, which a lock
 * drops), and so does Escape: it is never a yes to anything. "Back up now" opens 22a for this vault. It is shown once per unlock, and waits behind
 * the questions that come first (Ask 3, a new recovery key), so two never stack. The days are not said: the design says "30 days".
 */
export function BackupReminder({ data }: { data: SessionData }) {
  const later = useRef<HTMLButtonElement>(null);
  const { asks, session } = data;
  const open =
    asks.backupDue !== null && !asks.closed.includes("backup") && !asks.detailsChanged && data.recovery === null && data.backup === null;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) closeBanner(session, "backup");
      }}
      title={`${data.name} hasn't been backed up in 30 days`}
      description="A backup on another drive is what saves you if this PC fails."
      initialFocus={later}
    >
      <Button
        ref={later}
        onClick={() => {
          closeBanner(session, "backup");
        }}
      >
        Later
      </Button>
      <Button
        look="pill-main"
        onClick={() => {
          closeBanner(session, "backup");
          openBackup(session);
        }}
      >
        Back up now
      </Button>
    </Dialog>
  );
}
