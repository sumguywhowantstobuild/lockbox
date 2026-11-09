// Where focus goes back to when a form or tool in the side panel closes: the control that opened it, which is always on
// the page (the Add button in the toolbar, the Generator button in the side menu). The panel is gone by the time focus
// moves, so a keyboard user is not left at the top of the page; the move waits one turn so a menu that is still giving
// focus back to its own button has finished.
const OPENERS = { add: ".addb", generator: ".navgen" } as const;

export function focusBack(opener: keyof typeof OPENERS): void {
  window.setTimeout(() => {
    document.querySelector<HTMLElement>(OPENERS[opener])?.focus();
  }, 0);
}
