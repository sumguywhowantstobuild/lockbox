// Tauri's own drag-and-drop handler is off (it would send dropped files' full paths to the page), so a file
// dropped on the window would reach WebView2, which opens it in place of the app. Cancelling every `dragover`
// and `drop` on the document keeps dropped files away from both the page and Rust (spec §4.2).
function cancel(event: Event): void {
  event.preventDefault();
}

export function installDropGuard(): void {
  document.addEventListener("dragover", cancel);
  document.addEventListener("drop", cancel);
}
