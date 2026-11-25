import { APP_POINTS, VaultMark } from "./Pattern";

/**
 * Petalock's own mark, small, beside its name: the two-line drawing at three points, in the app's slate blue (the style sheet's
 * `.appmark`, with a contrast theme's text colour under one). Vaults start at five points, so no vault mark looks like it.
 * It is drawn for the eye only; the name beside it is the words.
 */
export function AppMark() {
  return <VaultMark points={APP_POINTS} className="appmark" />;
}
