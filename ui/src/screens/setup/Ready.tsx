import type { ReactNode } from "react";
import { openHelp } from "../../store";

/**
 * 21g: what a vault with nothing in it says, and what to do first. It is the first thing a new vault shows once its
 * recovery key is typed back, and what a vault shows each time it is unlocked with nothing in it. In a vault that can be written to, it says what to do
 * first and `children` are the buttons that add the first item (3e). A read-only copy (a backup, an older copy) can take nothing in and has nothing to
 * back up, so it says only that it is empty. Help, which opens the guide in the browser, is there for every vault (it writes nothing). `session` is the
 * vault the card is in, which Help says its failure to.
 */
export function Ready({ session, writable, children }: { session: number; writable: boolean; children?: ReactNode }) {
  return (
    <div className="grp lempty">
      <p className="le-t">Your vault is empty</p>
      {writable ? (
        <p className="le-b le-first">What to do first: add a login, or a key, a note or a file. Once it holds things you'd miss, make a backup from Settings.</p>
      ) : null}
      {children}
      <div className="le-a">
        <button
          type="button"
          className="lnk"
          onClick={() => {
            void openHelp(session);
          }}
        >
          Help
        </button>
      </div>
    </div>
  );
}
