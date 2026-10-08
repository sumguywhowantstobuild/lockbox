#!/usr/bin/env node
// Safety guard for Claude Code (PreToolUse hook).
// Reads the tool call as JSON on stdin and answers:
//   deny  -> never allowed; Ariel does it by hand if it is ever needed
//   ask   -> Claude Code shows Ariel a permission prompt
//   (no output) -> normal permission rules apply
// It is a seatbelt, not a sandbox: it catches mistakes, not a determined attacker.

import { execFileSync } from "node:child_process";

// Each rule: [decision, pattern, plain-English reason]. Patterns run on a normalised
// command: lower case, backslashes turned into forward slashes, spaces collapsed.
const COMMAND_RULES = [
  // Wiping the computer or the disk
  ["deny", /\b(rm|rmdir)\b[^|;&]*\s-[a-z]*r[a-z]*\b[^|;&]*\s["']?(\/|~|\$home|\/c|c:|c:\/|\/c\/(windows|users|program files[^/]*)|c:\/(windows|users|program files[^/]*))(\/?\*?)?(\s|$|["'])/, "recursive delete of a drive, the home folder or a system folder"],
  ["deny", /\bremove-item\b(?=[^|;&]*-recurse)[^|;&]*\s["']?(c:\/?|~|\$home|\$env:userprofile|c:\/(windows|users|program files[^/]*))\/?\*?["']?(\s|$)/, "recursive delete of a drive, the home folder or a system folder"],
  ["deny", /\b(rd|rmdir|del|erase)\b[^|;&]*\s\/s\b[^|;&]*\s["']?c:\/?(windows|users|program files[^/]*)?\/?["']?(\s|$)/, "recursive delete of a drive or a system folder"],
  ["deny", /\b(rm|remove-item|rd|rmdir|del)\b[^|;&]*(^|[\s"'/])\.git(\/|["']|\s|$)/, "deleting the git history (.git)"],
  ["deny", /\b(format(\.com)?\s+[a-z]:|format-volume|clear-disk|initialize-disk|remove-partition|diskpart|mkfs|dd\s+if=)/, "formatting or wiping a disk"],
  ["deny", /\b(vssadmin\s+delete|wmic\s+shadowcopy|bcdedit|cipher\s+\/w|sdelete)\b/, "deleting restore points or changing how Windows starts"],
  ["deny", /\b(reg\s+delete\s+hk(lm|ey_local_machine)|remove-item\b[^|;&]*hklm:)/, "deleting system registry keys"],
  ["deny", /\b(takeown|icacls)\b[^|;&]*c:\/(windows|program files)/, "changing ownership of Windows system files"],
  ["deny", /\b(set-mppreference|add-mppreference)\b|\bnetsh\s+advfirewall\s+set\b.*\boff\b|\bset-executionpolicy\s+(unrestricted|bypass)\b/, "turning off Windows security settings"],
  ["ask", /\b(shutdown|stop-computer|restart-computer)\b/, "shuts down or restarts the computer"],

  // Git: history and main
  ["deny", /\bgit\b[^|;&]*\bpush\b[^|;&]*(\s--force\b|\s--force-with-lease\b|\s-[a-z]*f[a-z]*\b|\s\+\S)/, "force push (rewrites history on GitHub)"],
  ["deny", /\bgit\b[^|;&]*\bpush\b[^|;&]*(\s|:)(main|master)(\s|$)/, "push to main (main changes only through a reviewed pull request)"],
  ["deny", /\bgit\b[^|;&]*\bpush\b[^|;&]*\s(--all|--mirror)\b/, "push of every branch, including main"],
  ["deny", /\bgit\b[^|;&]*\b(commit|push|merge|rebase|am)\b[^|;&]*(--no-verify|--no-gpg-sign)\b|\bgit\s+-c\s+commit\.gpgsign=false/, "skipping git checks or signing"],
  ["deny", /\bgit\b[^|;&]*\b(filter-branch|filter-repo)\b|\bgit\b[^|;&]*\breflog\s+expire\b|\bgit\b[^|;&]*\bupdate-ref\s+-d\b/, "rewriting or erasing git history"],
  ["ask", /\bgit\b[^|;&]*\bpush\b[^|;&]*(\s--delete\b|\s-d\b|\s:\S)/, "deletes a branch on GitHub"],
  ["ask", /\bgit\b[^|;&]*\breset\b[^|;&]*--hard\b/, "throws away uncommitted work"],
  ["ask", /\bgit\b[^|;&]*\bclean\b[^|;&]*\s-[a-z]*f/, "deletes untracked files"],
  ["ask", /\bgit\b[^|;&]*\b(checkout|restore)\b[^|;&]*\s(--\s+)?\.(\s|$)/, "throws away uncommitted changes"],

  // GitHub: merging, pull requests, visibility, releases
  ["deny", /\bgh\s+pr\s+merge\b|\bgh\s+api\b[^|;&]*\/(merges|pulls\/\d+\/merge)\b/, "merging a pull request (Ariel merges on GitHub)"],
  ["deny", /\bgh\s+repo\s+delete\b|\bgh\s+api\b[^|;&]*(-x|--method)\s+delete\b/, "deleting a repository or GitHub data"],
  ["deny", /\bgh\s+repo\s+(edit|create)\b[^|;&]*(--visibility[\s=]+public|--public)\b/, "making a repository public"],
  ["ask", /\bgh\s+pr\s+(create|close|reopen|ready|review)\b|\bgh\s+api\b[^|;&]*\/pulls\b[^|;&]*(-x|--method)\s+(post|patch)/, "opens, closes or reviews a pull request"],
  ["ask", /\bgh\s+repo\s+(create|edit|rename|archive|fork)\b/, "creates or changes a GitHub repository"],
  ["ask", /\bgh\s+(release|secret|variable|ruleset)\b|\bgh\s+workflow\s+(run|enable|disable)\b/, "changes releases, secrets or automation on GitHub"],

  // Licences and installs
  ["ask", /--accept-(package|source)-agreements\b|--accept-licen[cs]e\b|\/acceptlicen[cs]e|--agree-tos\b|\baccepteula\b/, "accepts a licence agreement on Ariel's behalf"],
  ["ask", /\b(winget|choco|scoop)\s+(install|upgrade|uninstall)\b|\binstall-(module|package|script)\b|\bnpm\s+(i|install)\s[^|;&]*(-g|--global)\b|\bcargo\s+install\b|\bpip3?\s+install\b|\brustup\s+(update|self|default)\b|\brustup\s+(toolchain\s+)?install\s+(?!\d+\.\d+(\.\d+)?(\s|$))/, "installs or removes software on this computer"],
  ["ask", /\b(iwr|irm|invoke-webrequest|invoke-restmethod|curl|wget)\b[^|;&]*\|\s*(iex|invoke-expression|sh|bash|pwsh|powershell)\b/, "downloads a script and runs it straight away"],
];

// The guard protects its own files: changing them needs Ariel's OK.
const PROTECTED_FILES = /(^|\/)\.claude\/(settings(\.local)?\.json|hooks\/)/;
const SHELL_PROTECTED = /(^|[\s"'/])\.claude\/(settings(\.local)?\.json|hooks\/)/;

export function normalise(text) {
  return String(text).toLowerCase().replace(/\\/g, "/").replace(/\s+/g, " ").trim();
}

function currentBranch(cwd) {
  try {
    return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000,
    }).trim();
  } catch {
    return "";
  }
}

// Returns { decision, reason } or null (no opinion).
export function check(input, { branch } = {}) {
  const tool = input?.tool_name ?? "";
  const toolInput = input?.tool_input ?? {};

  if (["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(tool)) {
    const path = normalise(toolInput.file_path ?? toolInput.notebook_path ?? "");
    if (PROTECTED_FILES.test(path)) {
      return { decision: "ask", reason: "changes the safety guard or Claude Code settings" };
    }
    return null;
  }

  if (tool !== "Bash" && tool !== "PowerShell") return null;
  const cmd = normalise(toolInput.command ?? "");

  for (const [decision, pattern, reason] of COMMAND_RULES) {
    if (pattern.test(cmd)) return { decision, reason };
  }

  // Case matters here: "git branch -d" only deletes merged branches (safe); "-D" forces it.
  const cased = String(toolInput.command ?? "").replace(/\s+/g, " ");
  if (/\bgit\b[^|;&]*\bbranch\b[^|;&]*(\s-D\b|\s(-d|--delete)\b[^|;&]*\s(-f|--force)\b|\s(-f|--force)\b[^|;&]*\s(-d|--delete)\b)/.test(cased)) {
    return { decision: "ask", reason: "force-deletes a local branch, including unmerged work" };
  }

  const pushes = /\bgit\b[^|;&]*\bpush\b/.test(cmd);
  const merges = /\bgit\b[^|;&]*\bmerge\b/.test(cmd);
  if ((pushes || merges) && ["main", "master"].includes(branch ?? currentBranch(input.cwd))) {
    return pushes
      ? { decision: "deny", reason: "push while on main (switch to a work branch first)" }
      : { decision: "deny", reason: "merge into main (main changes only through a reviewed pull request)" };
  }
  if (SHELL_PROTECTED.test(cmd) && /(>|\b(rm|del|remove-item|mv|move-item|set-content|out-file|sed\s+-i|cp|copy-item)\b)/.test(cmd)) {
    return { decision: "ask", reason: "changes the safety guard or Claude Code settings" };
  }
  return null;
}

function respond(result) {
  if (!result) return;
  const prefix = result.decision === "deny" ? "Blocked by the safety guard" : "Safety guard: needs Ariel's OK";
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: result.decision,
      permissionDecisionReason: `${prefix}: ${result.reason}.`,
    },
  }));
}

async function main() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    // Fail closed: if the guard can't read the call, the call doesn't run.
    process.stderr.write("Safety guard could not read the tool call; blocked to be safe.");
    process.exit(2);
  }
  respond(check(input));
}

// Run only when called as the hook, not when imported by the tests.
if (process.argv[1]?.endsWith("safety-guard.mjs")) main();
