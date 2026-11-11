import type { ReactNode } from "react";
import { Pattern } from "../../parts/Pattern";

/** The line the dark side of the first-use screens says until the key is on the screen. */
export const SAY_FIRST = "Your passwords, keys, notes and files, kept on this PC.";

/** The line beside the recovery key, which is the only way back in. */
export const SAY_KEY = "This key is the only way back in if you forget your password.";

/**
 * The frame of the first-use and recovery key screens: the lock screen's two sides, with the nine-point pattern on the
 * dark one (the setup screens' own, not a vault's), and the steps on the other. The steps are the screen's `children`.
 */
export function Frame({ say, children }: { say: string; children: ReactNode }) {
  return (
    <div className="lock">
      {/* The page's banner: a screen reader moving by landmarks finds the name and its line, not only the steps. */}
      <header className="field">
        <Pattern points={9} className="rose" />
        <p className="mark">Lockbox</p>
        <p className="say">{say}</p>
      </header>
      <main className="plate">
        <div className="fu">{children}</div>
      </main>
    </div>
  );
}
