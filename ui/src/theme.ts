// Light or dark. The setting the person chose in Settings decides; Windows' own setting is followed only while it is "system".
import { useSyncExternalStore } from "react";
import { useSettings } from "./store";

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

/** The saved theme, or Windows' light or dark setting (kept up to date while the screen is open) for "system". */
export function useMode(): Mode {
  const windows = useSyncExternalStore(subscribe, current);
  const { theme } = useSettings();
  return theme === "system" ? windows : theme;
}
