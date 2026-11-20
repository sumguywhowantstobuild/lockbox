// The words of the New vault form begun from the vault menu (18b and 18c), as the approved screens have them. The first-use form (21b) has its own, in `screens/setup/CreateVault.tsx`.
import type { CloudProvider } from "./api";
import { providerName } from "./cloudWords";

/** The dark side's line on the New vault form (18b). */
export const SAY_NEW_VAULT = "A new vault has its own password and its own recovery key.";

/** 18b's heading, which 18c keeps. */
export const NEW_VAULT_HEADING = "New vault";

/** The hint under the name: the name is stored in the clear (the engine's header), so a secret does not belong in it. */
export const NAME_HINT = "The name isn't encrypted, so don't put secrets in it.";

/** The second password box's label. */
export const REPEAT_PASSWORD = "Repeat the password";

/** The name of the part that says where the vault goes. */
export const WHERE_IT_LIVES = "Where it lives";

/** What 18c says about a folder that a cloud service syncs, naming the service the shell found ("OneDrive syncs this folder."; "A cloud service" when it can't name it). */
export function cloudWarning(provider: CloudProvider): string {
  return `${providerName(provider)} syncs this folder. Lockbox doesn't support vaults in cloud folders. Choose a folder on this PC, or continue anyway.`;
}

/** 18c's line where the path was drawn: the folder's place in words, as 18b says it (the session's words). */
export const IN_THE_USUAL_FOLDER = "Kept in your Lockbox Vaults folder.";
export const IN_THE_PICKED_FOLDER = "Kept in the folder you picked.";

/** What the shell refuses a create's folder with (`invalid_input`, `what`; `locations.rs`): 18c says it under "Where it lives". */
export const PLACE_REFUSALS = ["removable drive", "network drive", "drive type not supported", "file system not supported", "app data folder", "folder"];
