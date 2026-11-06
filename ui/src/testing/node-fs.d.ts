// The parts of Node's file API the tests use, declared here because the UI has no `@types/node`. Tests read the
// built style sheets with it (Vitest turns every `.css` file it imports into an empty string), the style sources, and
// the Rust sources.
declare module "node:fs" {
  export function readFileSync(path: string | URL, encoding: "utf8"): string;
  export function readdirSync(path: string | URL, options: { recursive: true }): string[];
}
