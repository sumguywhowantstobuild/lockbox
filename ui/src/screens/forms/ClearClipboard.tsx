import { useId } from "react";

/** What the tick box's hint says: Windows can keep a copy of what was copied that Lockbox cannot clear. */
export const CLEAR_HINT = "Windows clipboard history may keep its own copy, if you've turned it on.";

/**
 * "Clear the clipboard after saving", with its hint: the choice of the save box and of the paste panel, on to begin with. What it asks for is
 * done by the shell after the keys are written, and only if the clipboard still holds what was copied. The state is the caller's.
 */
export function ClearClipboardBox({ checked, onChange }: { checked: boolean; onChange: (next: boolean) => void }) {
  const id = useId();
  return (
    <div className="fbox">
      <label className="fchk">
        <input
          type="checkbox"
          checked={checked}
          aria-describedby={`${id}-hint`}
          onChange={(event) => {
            onChange(event.currentTarget.checked);
          }}
        />
        Clear the clipboard after saving
      </label>
      <p className="fhint" id={`${id}-hint`}>
        {CLEAR_HINT}
      </p>
    </div>
  );
}
