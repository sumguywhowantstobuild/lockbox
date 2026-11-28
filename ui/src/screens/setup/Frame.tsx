import type { ReactNode } from "react";
import { AppMark } from "../../parts/AppMark";
import { Intaglio } from "../../parts/Intaglio";

/** The line the dark side of the first-use screens says until the key is on the screen. */
export const SAY_FIRST = "Your passwords, keys, notes and files, kept on this PC.";

/** The line beside the recovery key, which is the only way back in. */
export const SAY_KEY = "This key is the only way back in if you forget your password.";

/**
 * The frame of the first-use and recovery key screens: the lock screen's two sides, with Petalock's engraved logo on the
 * dark one (Plan 5 Task 9b, as on the lock screen; a new vault's shape is not previewed here, its small mark shows it once
 * the vault is made), the app's small mark beside its name as on the lock screen, and the steps on the other side. The
 * steps are the screen's `children`.
 */
export function Frame({ say, children }: { say: string; children: ReactNode }) {
  return (
    <div className="lock">
      {/* The page's banner: a screen reader moving by landmarks finds the name and its line, not only the steps. */}
      <header className="field">
        <Intaglio className="rose" />
        <p className="mark">
          <AppMark />
          Petalock
        </p>
        <p className="say">{say}</p>
      </header>
      <main className="plate">
        <div className="fu">{children}</div>
      </main>
    </div>
  );
}
