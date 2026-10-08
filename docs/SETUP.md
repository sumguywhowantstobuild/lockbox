# Setup runbook

Every setup step for Lockbox, the choice made and one line on why. Updated as we go.
It becomes the README's "build it yourself" section and the starting point for the next app.
Never passwords or keys here, only where they're kept.

## Dev machine (Windows 11)

### Already present
| Tool | Version | Used for |
|---|---|---|
| Git | 2.41.0 | Version control |
| Node.js | 24.12.0 | Frontend tooling (React, TypeScript) |
| GitHub CLI (`gh`) | — | Pull requests, CI status, Greptile review loop |
| Python | 3.11.4 | Runs semgrep |

### Installed 2026-10-07
| Tool | Version | How | Why |
|---|---|---|---|
| gitleaks | 8.30.1 | `winget install --id Gitleaks.Gitleaks --source winget` | Finds passwords/keys accidentally committed to git |
| osv-scanner | 2.6.0 | `winget install --id Google.OSVScanner --source winget` | Flags dependencies with known vulnerabilities |
| semgrep | 1.179.0 | `python -m pip install --user semgrep` | Spots risky code patterns |
| opensrc | 0.7.3 | `npm install -g opensrc@0.7.3` | Lets the AI read a library's real source instead of guessing |

### Claude Code skills (global, `~/.claude/skills/`)
| Skill | Source | Why |
|---|---|---|
| greploop, check-pr | [greptileai/skills](https://github.com/greptileai/skills) (MIT) | Greptile review loop on every pull request |
| code-structure | [michaelshimeles/skills](https://github.com/michaelshimeles/skills) | Keeps one shared version of repeated logic |

These live on the dev machine only, not in this repo.

### Safety guard (Claude Code hook, added 2026-10-08)
`.claude/settings.json` runs `.claude/hooks/safety-guard.mjs` before every shell command and file edit Claude makes.
Rules can't be forgotten the way instructions can. Three outcomes:
- **Blocked:** wiping drives or system folders, deleting `.git`, formatting disks, turning off Windows security,
  force push, push to `main` (or any push or merge while on `main`), skipping git checks, merging pull requests,
  deleting or publishing the repo.
- **Asks Ariel:** accepting licence agreements, installing software, piping a download into a shell, discarding work
  (`reset --hard`, `clean -f`, deleting branches), opening or closing pull requests, creating or changing the GitHub
  repo, releases, shutdown, and any change to the guard or Claude settings.
- **Allowed:** everything else, under normal permissions.
Test it: `node --test .claude/hooks/safety-guard.test.mjs`. It's a seatbelt, not a sandbox: it catches mistakes, but a
deliberately disguised command could slip past.

### Not installed yet
- Rust toolchain: needed when the build starts. A first attempt on 2026-10-08 was stopped; `rustup` itself got
  installed to `~/.cargo/bin`, the toolchain did not.
- Visual Studio 2022 Build Tools (C++): the install on 2026-10-08 was stopped before anything was installed.

## Troubleshooting log

**semgrep: `executing pysemgrep failed ... No such file or directory`**
pip installs semgrep into `%APPDATA%\Python\Python311\Scripts`, which isn't on PATH, so `semgrep.exe` can't find its
helper `pysemgrep`. Fix used here: the scan script calls semgrep by its full path, with that folder added to PATH only
for the script's run. (Alternative: add the folder to your user PATH.)

**`node --test <folder>/` fails with `Cannot find module` (Node 24)**
Node 24 treats a folder argument as a file to run. Pass the test files instead: `node --test "scripts/*.test.mjs"`.
