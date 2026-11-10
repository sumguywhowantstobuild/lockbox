import type { ReactNode } from "react";

/**
 * 21g: what a vault with nothing in it says, and what to do first. It is the first thing a new vault shows once its
 * recovery key is typed back. `children` are the buttons that add the first item (3e), when this vault can take one; Help
 * comes with the guide.
 */
export function Ready({ children }: { children?: ReactNode }) {
  return (
    <div className="grp lempty">
      <p className="le-t">Your vault is empty</p>
      <p className="le-b">What to do first: add a login, or a key, a note or a file.</p>
      {children}
    </div>
  );
}
