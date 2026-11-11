import { rememberOpener } from "../focus";
import { Button } from "../parts/Button";
import { addStoredFile, openNewKey, openNewLogin, openNewNote, openPasteEnv } from "../store";

/**
 * Add, right there in an empty vault or folder (3e), as drawn: a button for each kind that can be made (a login, a key, a note and a
 * file), then a whole .env set apart after "or". File picks one file and stores it in the folder on screen (`folder`, `null` for the
 * vault itself), as the toolbar's Add does. Closing the form a button opens gives focus back to that button.
 */
export function EmptyAdd({ session, folder }: { session: number; folder: string | null }) {
  const open = (make: (session: number) => void) => (event: { currentTarget: HTMLElement }) => {
    rememberOpener(event.currentTarget);
    make(session);
  };
  return (
    <div className="le-a">
      <Button onClick={open(openNewLogin)}>Login</Button>
      <Button onClick={open(openNewKey)}>Key</Button>
      <Button onClick={open(openNewNote)}>Note</Button>
      <Button
        onClick={() => {
          void addStoredFile(session, folder);
        }}
      >
        File
      </Button>
      <span className="le-or">or</span>
      <Button onClick={open(openPasteEnv)}>Paste a .env</Button>
    </div>
  );
}
