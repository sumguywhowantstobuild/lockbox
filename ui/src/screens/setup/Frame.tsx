import type { ReactNode } from "react";
import { Pattern } from "../../parts/Pattern";

/** The line the dark side of the first-use screens says until the key is on the screen. */
export const SAY_FIRST = "Your passwords, keys, notes and files, kept on this PC.";

/** The line beside the recovery key, which is the only way back in. */
export const SAY_KEY = "This key is the only way back in if you forget your password.";

/**
 * The frame of the first-use and recovery key screens: the lock screen's two sides, with the nine-point pattern on the
 * dark one (the setup screens' own, not a vault's), and the steps on the other. The steps are the screen's `children`.
 * The New vault form begun from the vault menu (18b) passes the `points` of the place the new vault will take instead.
 */
export function Frame({ say, points = 9, children }: { say: string; points?: number; children: ReactNode }) {
  return (
    <div className="lock">
      {/* The page's banner: a screen reader moving by landmarks finds the name and its line, not only the steps. */}
      <header className="field">
        <Pattern points={points} className="rose" />
        <p className="mark">Petalock</p>
        <p className="say">{say}</p>
      </header>
      <main className="plate">
        <div className="fu">{children}</div>
      </main>
    </div>
  );
}
