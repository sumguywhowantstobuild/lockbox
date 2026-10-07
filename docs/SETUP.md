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

### Not installed yet
- Rust toolchain: needed when the build starts.

## Troubleshooting log

**semgrep: `executing pysemgrep failed ... No such file or directory`**
pip installs semgrep into `%APPDATA%\Python\Python311\Scripts`, which isn't on PATH, so `semgrep.exe` can't find its
helper `pysemgrep`. Fix used here: the scan script calls semgrep by its full path, with that folder added to PATH only
for the script's run. (Alternative: add the folder to your user PATH.)
