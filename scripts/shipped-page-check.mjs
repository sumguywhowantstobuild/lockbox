// Proves the page Petalock ships holds no code from the build tools whose advisories ui/osv-scanner.toml accepts (or
// once accepted): picomatch, minimatch and tinyglobby. Those reach the lock file only through Vite, Vitest, ESLint and
// typescript-eslint; this check is what makes "never shipped" in that file a tested fact rather than a claim.
//
//   node scripts/shipped-page-check.mjs
//
// It builds the page with Vite's own build, from ui/vite.config.ts, in memory (nothing is written, so ui/dist stays
// as it was), and reads the list of modules Vite put in every emitted chunk. It fails when a chunk holds a module from
// one of those packages, or when the build emitted nothing to check: no chunk, or no module of our own code (an empty
// list would otherwise pass).

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** The build-time packages that must never reach the shipped page. */
const BUILD_TOOLS = ["picomatch", "minimatch", "tinyglobby"];

/** The UI's folder, found from this file, so the check runs from any working directory. */
export const UI = fileURLToPath(new URL("../ui/", import.meta.url));

/** The package a module path comes from: the name after its last `node_modules`, or null for our own code. */
function packageOf(moduleId) {
  const parts = moduleId.replaceAll("\\", "/").split("/");
  const at = parts.lastIndexOf("node_modules");
  if (at < 0 || at + 1 >= parts.length) return null;
  const name = parts[at + 1];
  return name.startsWith("@") && at + 2 < parts.length ? `${name}/${parts[at + 2]}` : name;
}

/**
 * What is wrong with a build's output, one sentence each: every chunk module from a build tool, or the build having
 * emitted nothing to check (no chunk, or no module of our own code). An empty list means the page is clean.
 */
export function buildToolProblems(output) {
  const chunks = output.filter((item) => item.type === "chunk");
  if (chunks.length === 0) return ["the build emitted no chunk, so there was nothing to check"];
  const problems = [];
  let ownModules = 0;
  for (const chunk of chunks) {
    for (const id of chunk.moduleIds) {
      const name = packageOf(id);
      // Rollup's virtual modules start with a NUL byte: they are neither ours nor a package's.
      if (name === null && !id.startsWith("\0")) ownModules += 1;
      if (BUILD_TOOLS.includes(name)) problems.push(`${chunk.fileName} holds ${name} (${id})`);
    }
  }
  if (ownModules === 0) problems.push("no chunk holds a module of our own code, so the module lists can't be trusted");
  return problems;
}

/** True when the UI's packages are installed, so the page can be built (the scan job in CI doesn't install them). */
export const canBuild = () => existsSync(join(UI, "node_modules", "vite", "package.json"));

/** Builds the page in memory with Vite, from ui/vite.config.ts plus `plugins`, and returns every emitted item. */
export async function buildPage(plugins = []) {
  // Vite lives in ui/node_modules, not beside this script: load it from there, by the entry its package names.
  const vitePackage = JSON.parse(readFileSync(join(UI, "node_modules", "vite", "package.json"), "utf8"));
  const { build } = await import(pathToFileURL(join(UI, "node_modules", "vite", vitePackage.exports["."])).href);
  const result = await build({
    root: UI,
    configFile: join(UI, "vite.config.ts"),
    logLevel: "warn",
    plugins,
    build: { write: false },
  });
  return (Array.isArray(result) ? result : [result]).flatMap((r) => r.output);
}

async function main() {
  const output = await buildPage();
  const problems = buildToolProblems(output);
  if (problems.length > 0) {
    console.error(`the shipped page holds build-tool code:\n${problems.join("\n")}`);
    process.exitCode = 1;
    return;
  }
  const chunks = output.filter((item) => item.type === "chunk");
  const modules = chunks.reduce((sum, chunk) => sum + chunk.moduleIds.length, 0);
  console.log(`shipped page clean: ${chunks.length} chunk(s), ${modules} module(s), none from ${BUILD_TOOLS.join(", ")}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
