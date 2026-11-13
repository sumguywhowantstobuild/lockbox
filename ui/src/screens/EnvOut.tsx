import { useEffect, useRef, useState } from "react";
import { focusButton, focusList } from "../focus";
import { Button } from "../parts/Button";
import { Dialog } from "../parts/Dialog";
import { confirmEnvFile, saveEnvFile, type EnvFile } from "../store";

/** The folder's menu button, which this dialog gives focus back to. */
const FOLDER_MENU = '[aria-label="More for this folder"]';

/**
 * Save as .env file (15e, and 15f when it applies), the small dialog that hangs under the folder's menu. It first says that the file is
 * not encrypted, with Cancel (first focus, and the way out) and Save. Save sends the folder's id; Rust opens the save dialog, checks
 * the folder, and writes the file. What it answers is said by the store: where the file went and that the copy is not encrypted, or
 * the sentence for a name that appears twice, or the refusal's words. A closed save dialog does nothing. A cloud-synced folder asks
 * first (15f), the same question as the recovery key's PDF: Continue goes on with the save Rust parked, by its token, and Pick another
 * folder (the safe answer, with the first focus) runs the save again so Rust asks for another folder; Escape writes nothing. A lock
 * takes the dialog away with the vault and says nothing. Focus goes back to the folder's menu button when it closes.
 */
export function EnvFileDialog({
  session,
  folder,
  onClose,
}: {
  session: number;
  folder: { id: string; name: string };
  onClose: () => void;
}) {
  /** The cloud question's token, while that question is on screen. */
  const [token, setToken] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  // A second press before the first has an answer sends nothing.
  const working = useRef(false);
  const mounted = useRef(true);
  const cancel = useRef<HTMLButtonElement>(null);
  const safeAnswer = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // The cloud question takes the place of the first one, and its safe answer has focus at once.
  useEffect(() => {
    if (token !== null) safeAnswer.current?.focus();
  }, [token]);

  const close = () => {
    // While the shell has the save, Rust may still write the file: the warning stays until the save has ended.
    if (working.current) return;
    onClose();
    focusButton(FOLDER_MENU, focusList);
  };

  const go = async (run: () => Promise<EnvFile>) => {
    if (working.current) return;
    working.current = true;
    setRunning(true);
    let result: EnvFile;
    try {
      result = await run();
    } finally {
      working.current = false;
    }
    if (!mounted.current) return;
    setRunning(false);
    if (typeof result === "object") setToken(result.confirm);
    else close();
  };

  const off = running ? true : undefined;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        // Closing it while the shell has the save does nothing (`close` checks); closing the cloud question writes nothing.
        if (!open) close();
      }}
      title={token === null ? "Save as .env file" : "This folder is synced to the cloud"}
      description={
        token === null
          ? "The saved file is not encrypted, so anyone who can open it can read these keys."
          : "This file would be uploaded unprotected."
      }
      initialFocus={cancel}
    >
      {token === null ? (
        <>
          <Button ref={cancel} aria-disabled={off} onClick={close}>
            Cancel
          </Button>
          <Button
            look="pill-main"
            aria-disabled={off}
            aria-busy={running ? true : undefined}
            onClick={() => {
              void go(() => saveEnvFile(session, folder.id));
            }}
          >
            Save
          </Button>
        </>
      ) : (
        <>
          <Button
            aria-disabled={off}
            onClick={() => {
              void go(() => confirmEnvFile(session, token));
            }}
          >
            Continue
          </Button>
          <Button
            ref={safeAnswer}
            look="pill-main"
            aria-disabled={off}
            onClick={() => {
              void go(() => saveEnvFile(session, folder.id));
            }}
          >
            Pick another folder
          </Button>
        </>
      )}
    </Dialog>
  );
}
