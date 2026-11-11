// The save shortcut as words, and a key press as a shortcut to send. The shell's own check (`Settings::check`) is the one that decides what
// is allowed; the page only turns a press into the Windows key code the shell takes, and refuses at once what can have none.
import type { Shortcut } from "./api";

/** A key code's name: A to Z, 0 to 9, F1 to F12 (the only keys the shell takes). */
function keyName(key: number): string {
  if (key >= 0x41 && key <= 0x5a) return String.fromCharCode(key);
  if (key >= 0x30 && key <= 0x39) return String.fromCharCode(key);
  if (key >= 0x70 && key <= 0x7b) return `F${String(key - 0x6f)}`;
  return `Key ${String(key)}`;
}

/** `Ctrl+Shift+L`: the modifiers in the order Ctrl, Shift, Alt, then the key. */
export function shortcutText(shortcut: Shortcut): string {
  return [shortcut.ctrl ? "Ctrl" : null, shortcut.shift ? "Shift" : null, shortcut.alt ? "Alt" : null, keyName(shortcut.key)]
    .filter((part) => part !== null)
    .join("+");
}

/**
 * The Windows virtual-key code of the key pressed: a letter is the letter the key makes in the person's layout (Windows names a letter's
 * key by it, so the key marked A on a French keyboard is 65 whatever its place), `Digit0` to `Digit9` give 48 to 57 and `F1` to `F12` give
 * 112 to 123. A letter key that makes no letter (a symbol, as on Dvorak or with AltGr) is `null`: its place says nothing of the key Windows
 * would name, so it is refused, never guessed. Any other key is `null`.
 */
export function keyCodeOf(code: string, key: string): number | null {
  if (code.startsWith("Key")) return /^[a-zA-Z]$/.test(key) ? key.toUpperCase().charCodeAt(0) : null;
  const digit = /^Digit([0-9])$/.exec(code);
  if (digit !== null) return (digit[1] ?? "").charCodeAt(0);
  const fn = /^F([1-9]|1[0-2])$/.exec(code);
  if (fn !== null) return 0x6f + Number(fn[1]);
  return null;
}
