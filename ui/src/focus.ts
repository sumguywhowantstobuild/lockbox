// Where focus goes back to when a form or tool in the side panel closes: the control that opened it, which is always on
// the page (the Add button in the toolbar, the Generator button in the side menu). The panel is gone by the time focus
// moves, so a keyboard user is not left at the top of the page; the move waits one turn so a menu that is still giving
// focus back to its own button has finished.
const OPENERS = { add: ".addb", generator: ".navgen" } as const;

/** The button on the page that opened the form now open, when it stays there (an empty list's own Add buttons), or `null`. */
let opener: HTMLElement | null = null;

/**
 * Says which button opened the next form, so closing it gives focus back to that button: the empty list's Login, Key and
 * Note, which stay on the page. A form opened from a menu or the search says `null`, and focus goes to the toolbar's Add.
 */
export function rememberOpener(button: HTMLElement | null): void {
  opener = button;
}

/**
 * Focus goes to the list (the first row of the list or of the Trash view, or the heading when there is none) after something
 * that took its own place off the page: a panel closed by Move to trash, Restore or a delete, or a folder that went. The move
 * waits one turn so a menu or a dialog that is still giving focus back has finished.
 */
export function focusList(): void {
  window.setTimeout(() => {
    const target = document.querySelector<HTMLElement>(".lgroups .rgo") ?? document.querySelector<HTMLElement>("h1.big");
    target?.focus();
  }, 0);
}

/** Focus goes to the control `selector` finds (one turn later, as above), or `fallback` runs when it is not there any more. */
export function focusButton(selector: string, fallback?: () => void): void {
  window.setTimeout(() => {
    const target = document.querySelector<HTMLElement>(selector);
    if (target !== null) target.focus();
    else fallback?.();
  }, 0);
}

export function focusBack(fallback: keyof typeof OPENERS): void {
  const button = opener;
  opener = null;
  window.setTimeout(() => {
    if (button?.isConnected === true) button.focus();
    else document.querySelector<HTMLElement>(OPENERS[fallback])?.focus();
  }, 0);
}
