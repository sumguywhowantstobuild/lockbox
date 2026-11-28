import { openMoveIn } from "../../store";
import { Frame, SAY_FIRST } from "./Frame";

/**
 * 21a, the first screen when there is no vault: create one, or bring in one that is already on this PC or in a backup. The second way in opens 26a, where the
 * person says which they have (`MoveIn`); the folder picker, the backup picker and the cloud question all come after it.
 */
export function Welcome({ onCreate }: { onCreate: () => void }) {
  return (
    <Frame say={SAY_FIRST}>
      <h1>Welcome to Petalock</h1>
      <p className="fu-sub">
        There is no account and no server. Start with a vault, or bring in one you already have.
      </p>
      <div className="fu-row">
        <button type="button" className="prim" onClick={onCreate}>
          Create a vault
        </button>
        <button type="button" className="lnk" onClick={openMoveIn}>
          I already have a vault or a backup
        </button>
      </div>
    </Frame>
  );
}
