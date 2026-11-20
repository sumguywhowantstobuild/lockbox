// What the person calls each cloud service, for every screen that names one (Ask 10, 18c). The shell sends a fixed spelling (`GoogleDrive`), never a path.
import type { CloudProvider } from "./api";

const NAMES: Record<CloudProvider, string> = {
  OneDrive: "OneDrive",
  GoogleDrive: "Google Drive",
  Dropbox: "Dropbox",
  Other: "A cloud service",
};

/** The service's everyday name, as the first words of a sentence ("A cloud service" when the shell found one it can't name). */
export function providerName(provider: CloudProvider): string {
  return NAMES[provider];
}
