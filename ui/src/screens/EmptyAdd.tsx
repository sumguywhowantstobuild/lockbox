import { rememberOpener } from "../focus";
import { Button } from "../parts/Button";
import { openNewKey, openNewLogin, openNewNote } from "../store";

/**
 * Add, right there in an empty vault or folder (3e): a button for each kind that can be made, as drawn. A file and a pasted
 * .env are drawn there too, and come with their own tasks. Closing the form it opens gives focus back to the button.
 */
export function EmptyAdd({ session }: { session: number }) {
  const open = (make: (session: number) => void) => (event: { currentTarget: HTMLElement }) => {
    rememberOpener(event.currentTarget);
    make(session);
  };
  return (
    <div className="le-a">
      <Button onClick={open(openNewLogin)}>Login</Button>
      <Button onClick={open(openNewKey)}>Key</Button>
      <Button onClick={open(openNewNote)}>Note</Button>
    </div>
  );
}
