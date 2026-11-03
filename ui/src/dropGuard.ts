// Defence in depth. The window itself refuses files dropped from outside the app (WebView2's external drop is off,
// spec §4.2), so normally no drop event with files reaches the page. If one ever does, cancelling `dragover` and
// `drop` stops WebView2 from opening the file in place of the app. The listeners sit on `window` in the capture
// phase, so they run before any element's own listener and a `stopPropagation()` cannot skip them.
function cancel(event: Event): void {
  event.preventDefault();
}

export function installDropGuard(): void {
  window.addEventListener("dragover", cancel, { capture: true });
  window.addEventListener("drop", cancel, { capture: true });
}
