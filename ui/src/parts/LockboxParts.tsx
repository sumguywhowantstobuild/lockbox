import { CSPProvider } from "@base-ui/react/csp-provider";
import type { ReactNode } from "react";
import "./LockboxParts.css";

/**
 * Wraps the whole app. The page's Content Security Policy refuses `<style>` elements (`style-src 'self'`), and Base UI's
 * scroll area and select popup write one unless this provider tells them not to. Without it, each would put an error
 * in the console and lose the rule it carried (hiding the native scrollbar). `LockboxParts.css`, imported here, gives
 * that rule to the class `base-ui-disable-scrollbar` instead. The policy has no nonce, so none is passed.
 */
export function LockboxParts({ children }: { children: ReactNode }) {
  return <CSPProvider disableStyleElements>{children}</CSPProvider>;
}
