// The one part of Node's file API the tests use, declared here because the UI has no `@types/node`. Tests read the
// built style sheets with it: Vitest turns every `.css` file it imports into an empty string.
declare module "node:fs" {
  export function readFileSync(path: string | URL, encoding: "utf8"): string;
}
