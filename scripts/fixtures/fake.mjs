// Stand-in for a scanner in tests. Behaviour comes from FAKE_<NAME>_EXIT and FAKE_<NAME>_REPORT
// (FAKE_<NAME>_STAGED_EXIT / _STAGED_REPORT when called with --staged).
import { writeFileSync } from "node:fs";

export function fake(name) {
  const args = process.argv.slice(2);
  const flag = args.findIndex((a) => ["--report-path", "--output", "--output-file"].includes(a));
  const key = `FAKE_${name}${args.includes("--staged") ? "_STAGED" : ""}`;
  const report = process.env[`${key}_REPORT`];
  if (flag >= 0 && report !== undefined) writeFileSync(args[flag + 1], report);
  process.exit(Number(process.env[`${key}_EXIT`] ?? 0));
}
