// Hands-on probe for the window's drop protection (spec §4.2). It listens for drops before the drop guard does
// (installed first, capture phase on `window`), so it sees any drop event that carries files, whether or not the
// guard cancels it afterwards. A file dragged in from Explorer must never be seen here.
import { useSyncExternalStore } from "react";

let reached = false;
const subscribers = new Set<() => void>();

function carriesFiles(event: DragEvent): boolean {
  const data = event.dataTransfer;
  return data !== null && (data.files.length > 0 || data.types.includes("Files"));
}

export function installDropProbe(): void {
  window.addEventListener(
    "drop",
    (event) => {
      if (!reached && carriesFiles(event)) {
        reached = true;
        for (const notify of subscribers) notify();
      }
    },
    { capture: true },
  );
}

function subscribe(notify: () => void): () => void {
  subscribers.add(notify);
  return () => subscribers.delete(notify);
}

/** Whether a drop event carrying files has reached the page since it loaded. */
export function useDroppedFileReachedPage(): boolean {
  return useSyncExternalStore(subscribe, () => reached);
}
