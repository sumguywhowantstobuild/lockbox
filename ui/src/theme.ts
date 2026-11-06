// Light or dark. The theme follows Windows' own setting until the settings screen lets a person choose.
import { useSyncExternalStore } from "react";

export type Mode = "light" | "dark";

const DARK = "(prefers-color-scheme: dark)";

function windowsSetting(): MediaQueryList | null {
  // A window without the call (the tests' browser stand-in) is light.
  return typeof window.matchMedia === "function" ? window.matchMedia(DARK) : null;
}

function subscribe(notify: () => void): () => void {
  const setting = windowsSetting();
  setting?.addEventListener("change", notify);
  return () => {
    setting?.removeEventListener("change", notify);
  };
}

function current(): Mode {
  return windowsSetting()?.matches === true ? "dark" : "light";
}

/** Windows' light or dark setting, kept up to date while the screen is open. */
export function useMode(): Mode {
  return useSyncExternalStore(subscribe, current);
}
