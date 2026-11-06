// Reading files that sit beside a test, or in the Rust crates. Vite rewrites `new URL("literal", import.meta.url)`
// into an address on its dev server, which Node's file calls refuse, so the path is joined here, from variables.
import { readdirSync, readFileSync } from "node:fs";

/** The text of `relative`, a path beside the file whose `import.meta.url` is `from`. */
export function readBeside(from: string, relative: string): string {
  return readFileSync(new URL(relative, from), "utf8");
}

/** Every file under `relative` (beside `from`), as paths below it with forward slashes. */
export function listBelow(from: string, relative: string): string[] {
  return readdirSync(new URL(relative, from), { recursive: true }).map((path) => path.replaceAll("\\", "/"));
}
