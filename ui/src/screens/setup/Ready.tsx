/**
 * 21g: what a vault with nothing in it says, and what to do first. It is the first thing a new vault shows once its
 * recovery key is typed back. Nothing here leads to a screen a later task builds, so it offers no button yet: Add comes
 * with the task that adds items, and Help with the guide.
 */
export function Ready() {
  return (
    <div className="grp lempty">
      <p className="le-t">Your vault is empty</p>
      <p className="le-b">What to do first: add a login, or a key, a note or a file.</p>
    </div>
  );
}
