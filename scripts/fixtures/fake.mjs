// Stand-in for a scanner in tests. Behaviour comes from FAKE_<NAME>_EXIT and FAKE_<NAME>_REPORT.
import { writeFileSync } from "node:fs";

export function fake(name) {
  const args = process.argv.slice(2);
  const flag = args.findIndex((a) => ["--report-path", "--output", "--output-file"].includes(a));
  const report = process.env[`FAKE_${name}_REPORT`];
  if (flag >= 0 && report !== undefined) writeFileSync(args[flag + 1], report);
  process.exit(Number(process.env[`FAKE_${name}_EXIT`] ?? 0));
}
