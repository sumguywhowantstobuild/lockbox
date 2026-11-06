import { useState } from "react";
import { CreateVault } from "./CreateVault";
import { Welcome } from "./Welcome";

/**
 * Everything before a vault exists: the first screen (21a) and the form that follows it (21b). Once the vault is made it
 * is unlocked, and the app moves on to its recovery key on its own, from the session.
 */
export function FirstRun() {
  const [creating, setCreating] = useState(false);
  return creating ? (
    <CreateVault
      onBack={() => {
        setCreating(false);
      }}
    />
  ) : (
    <Welcome
      onCreate={() => {
        setCreating(true);
      }}
    />
  );
}
