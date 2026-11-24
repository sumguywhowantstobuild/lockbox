// Where focus goes back to when a form or tool in the side panel closes: the control that opened it, which is always on
// the page (the Add button in the toolbar, the Generator button in the side menu). The panel is gone by the time focus
// moves, so a keyboard user is not left at the top of the page; the move waits one turn so a menu that is still giving
// focus back to its own button has finished.
const OPENERS = { add: ".addb", generator: ".navgen", settings: ".navset" } as const;

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

/**
 * [`focusList`](focusList) for a change that may have taken the focused control off the page (the Empty trash button when the Trash
 * empties), and only then: one turn later, if focus is still on a control the page has, the person has moved on (to the Filter, say,
 * while the answer was on its way) and focus stays where they put it. A focus that fell to the top of the page, or to something no
 * longer on it, goes to the list.
 */
export function focusListIfLost(): void {
  window.setTimeout(() => {
    const now = document.activeElement;
    const lost = now === null || now === document.body || !now.isConnected;
    if (!lost) return;
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

/**
 * A progress card goes when its job ends, and a keyboard user whose focus was on its Cancel would be left at the top of the page. Call this
 * before the card goes, with the operation that is ending (`null` for a job that never had a card): when focus is inside that job's own card
 * (not another job's), the function it returns, called once the card is gone, puts focus on the message the
 * job's result shows (its "Got it" or Dismiss, the first button of the message stack), or on the list when there is none. A card inside the
 * search box (a Save a copy begun there) sends focus back to the search box instead, since the box is still open and holds focus.
 */
export function takeJobFocus(operation: number | null): () => void {
  const active = document.activeElement;
  const card = active instanceof Element ? active.closest(".job") : null;
  // Only the ending job's own card counts: with two jobs side by side, one ending leaves focus in the other's card alone.
  if (card === null || operation === null || card.getAttribute("data-operation") !== String(operation)) return () => undefined;
  // A card in the Add files panel: the panel's own result takes focus (its heading), so nothing here races it.
  if (card.closest("aside.panel") !== null) return () => undefined;
  const inSearch = card.closest('[role="dialog"]') !== null;
  return () => {
    focusButton(inSearch ? ".pin" : ".tstack .tb2", focusList);
  };
}

/**
 * Whether focus is now in an Add files batch's own place: its progress card (the one with this operation, whether the card is in the panel or in
 * the list's column), or, while the panel is on screen (`panelShowing`), anywhere in that panel. Asked while the bar is still there, before the
 * result takes its place: the result moves focus to itself only for a person who was in the batch's place, and never pulls focus back from the
 * filter, the list or a field they went to meanwhile.
 */
export function batchHasFocus(operation: number | null, panelShowing: boolean): boolean {
  const active = document.activeElement;
  if (!(active instanceof Element)) return false;
  const card = active.closest(".job");
  if (card !== null) return operation !== null && card.getAttribute("data-operation") === String(operation);
  return panelShowing && active.closest("aside.panel") !== null;
}

export function focusBack(fallback: keyof typeof OPENERS): void {
  const button = opener;
  opener = null;
  window.setTimeout(() => {
    if (button?.isConnected === true) button.focus();
    else document.querySelector<HTMLElement>(OPENERS[fallback])?.focus();
  }, 0);
}
