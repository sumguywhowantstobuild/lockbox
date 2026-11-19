// The words of the New vault form begun from the vault menu (18b and 18c), as the approved screens have them. The first-use form (21b) has its own, in `screens/setup/CreateVault.tsx`.

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

/** What 18c says about a folder that a cloud service syncs. The shell names no service, so it says "a cloud service" (the picture names OneDrive). */
export const CLOUD_WARNING = "A cloud service syncs this folder. Lockbox doesn't support vaults in cloud folders. Choose a folder on this PC, or continue anyway.";

/** What the shell refuses a create's folder with (`invalid_input`, `what`; `locations.rs`): 18c says it under "Where it lives". */
export const PLACE_REFUSALS = ["removable drive", "network drive", "drive type not supported", "file system not supported", "app data folder", "folder"];
