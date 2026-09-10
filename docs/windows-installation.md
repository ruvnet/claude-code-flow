# Windows Installation Guide

Ruflo runs natively on Windows — PowerShell and `cmd.exe` both work — as well
as under WSL and Git-Bash. This guide covers the install path, config file
locations, and the handful of quirks that only show up on native Windows.

## Prerequisites

- Node.js 20 or newer (`node --version`)
- npm 9 or newer (`npm --version`)
- Git for Windows (optional, needed only for Git-Bash / the POSIX install
  script below)

## Installing

**Recommended — works identically on PowerShell, cmd.exe, WSL, and macOS/Linux:**

```powershell
npx ruflo@latest init wizard
```

This runs the interactive setup wizard with no shell-specific steps. For a
quick non-interactive setup, use `npx ruflo@latest init` instead, or install
the CLI globally:

```powershell
npm install -g ruflo@latest
```

**POSIX one-line installer (`curl | bash`) — Git-Bash, WSL, or MSYS only:**

```bash
curl -fsSL https://cdn.jsdelivr.net/gh/ruvnet/ruflo@main/scripts/install.sh | bash
```

This script requires a POSIX shell and will not run in plain PowerShell or
`cmd.exe` — if you see `'bash' is not recognized as an internal or external
command`, you're in a non-POSIX shell; switch to one of the `npx`/`npm`
commands above instead. Both paths end up running the same init flow.

## MCP server registration

```powershell
claude mcp add claude-flow -- npx ruflo@latest mcp start
```

Claude Desktop's config file on Windows lives at:

```text
%APPDATA%\Claude\claude_desktop_config.json
```

## Verifying your setup

```powershell
npx ruflo@latest doctor --fix
```

`doctor` checks Node/npm versions, git, config file validity, and MCP server
registration, and will attempt to auto-fix common problems.

## Common Windows-specific issues

**Path escaping in environment variables** — PowerShell backslash paths can
trip up tools that expect POSIX-style paths. Use forward slashes, or an
absolute path with forward slashes:

```powershell
$env:CLAUDE_FLOW_MEMORY_PATH = "./data"
# or
$env:CLAUDE_FLOW_MEMORY_PATH = "C:/Users/name/ruflo/data"
```

**`'bash' is not recognized`** — you're running the POSIX one-line installer
in PowerShell or `cmd.exe`. Use `npx ruflo@latest init wizard` instead (see
above).

**Permission errors on global install** — if `npm install -g ruflo@latest`
fails with an EACCES/permission error, run your terminal as Administrator,
or use a Node version manager (e.g. `nvm-windows`) so npm's global prefix is
writable by your user account.

If you hit something not covered here, please open an issue with the exact
command you ran, `npx ruflo@latest doctor` output, and your Windows/terminal
version (PowerShell vs. `cmd.exe`, Windows 10 vs. 11) — that detail is what
lets a Windows-specific bug get diagnosed and fixed.
