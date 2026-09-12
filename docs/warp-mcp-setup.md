# Local Ruflo, Claude Flow, AgentDB, and Warp MCP setup

## Installed prerequisites

- Node.js LTS: `v24.19.0`
- npm/npx: `11.17.0`
- Git: `2.55.0.windows.5`

Node.js was installed with:

```powershell
winget install --id OpenJS.NodeJS.LTS --exact --accept-package-agreements --accept-source-agreements
```

## Repository checkouts

The requested source repositories are cloned here:

- `ruflo/` — `https://github.com/ruvnet/ruflo.git`
- `claude-flow/` — `https://github.com/ruvnet/claude-flow.git`
- `agentdb/` — `https://github.com/ruvnet/agentdb.git`

Ruflo and Claude Flow are compatible branding/package aliases of the same platform. They are both checked out as requested, but only Ruflo is configured as an MCP server to avoid duplicating its MCP tools.

## MCP configuration

`docs/warp-mcp-servers.json` defines two local stdio MCP servers:

| Server | Command |
| --- | --- |
| Ruflo | `C:\Program Files\nodejs\npx.cmd --yes ruflo@latest mcp start` |
| AgentDB | `C:\Program Files\nodejs\npx.cmd --yes agentdb@latest mcp start` |

The configuration uses the absolute `npx.cmd` path so it works even when a current PowerShell session has not refreshed its `PATH` after Node.js installation.

Published package entry points were verified from downloaded package archives:

- `ruflo@3.38.19` exposes `bin/ruflo.js`.
- `agentdb@3.0.0-alpha.20` exposes `dist/src/cli/agentdb-cli.js`.

## Run Warp with the MCP configuration

From the repository root, use the configuration for an Oz/Warp agent run:

```powershell
$env:npm_config_cache = Join-Path $env:LOCALAPPDATA 'npm-cache-warp-mcp'
oz agent run --mcp "$PWD\docs\warp-mcp-servers.json" --prompt "Your task here"
```

The `npm_config_cache` line is optional, but makes the location used by transient `npx` package downloads explicit.

## Retry the read-only connection probe

The first probe could not execute because the Warp account had no remaining AI credits. After credits are available, run:

```powershell
oz agent run --mcp "$PWD\docs\warp-mcp-servers.json" --prompt "Do not invoke any MCP tools. Report the names of the MCP servers and tools available to you, and state whether both servers connected successfully."
```

Expected result: the agent reports both `ruflo` and `agentdb` as connected and lists their available tools. The probe deliberately asks the agent not to invoke any MCP tools.

## Global Ruflo skills

Ruflo has two skill surfaces:

- Base collections: `.agents/skills/` and `.claude/skills/`.
- Plugin collections: `plugins/*/skills/`.

The global `.agents/skills/` directory is a real directory containing one Windows directory junction per exposed skill. Each junction targets its canonical skill directory in the Ruflo checkout; skill files are not copied or moved for global exposure. Updating the Ruflo checkout therefore updates the linked global skill immediately.

The junction set includes tracked Ruflo base skills, plugin skills, and pre-existing non-plugin skill sources. The plugin set includes `ruflo-goals` skills such as `goal-plan`, `horizon-track`, `deep-research`, `research-synthesize`, and `dossier-collect`. The `horizon-track` junction targets `plugins/ruflo-goals/skills/horizon-track` and is globally available as `horizon-track`.

Name collisions do not overwrite an existing source. An identical source can retain its direct name; a different Ruflo plugin skill is exposed under `ruflo-<plugin>-<skill>`.

Many plugin skills declare Ruflo MCP tools. Discovery means their instructions are available; stateful behavior such as Horizon persistence requires the external agent host to expose the configured Ruflo MCP server and its memory/AgentDB tools.

### Add junctions for newly added Ruflo plugin skills

After updating Ruflo, add a junction for each newly introduced plugin skill. Do not replace an existing skill directory or junction without comparing its source first.

```powershell
$pluginRoot = Join-Path $HOME 'source\ruflo\plugins'
$globalRoot = Join-Path $HOME '.agents\skills'
Get-ChildItem $pluginRoot -Directory | ForEach-Object {
  $plugin = $_.Name
  $skillsRoot = Join-Path $_.FullName 'skills'
  if (-not (Test-Path $skillsRoot)) { return }
  Get-ChildItem $skillsRoot -Directory | ForEach-Object {
    $target = Join-Path $globalRoot $_.Name
    if (-not (Test-Path $target)) {
      New-Item -ItemType Junction -Path $target -Target $_.FullName
    }
  }
}
```

### Skill invocation in grouped-agent work

Available skills are discoverable by each agent whose host indexes the applicable global or project skill roots. An agent may load a relevant skill automatically based on its name and description, but availability does not guarantee invocation.

For deterministic group behavior, assign the skill explicitly in each relevant agent's task or launch configuration, such as `/horizon-track <objective>` or an equivalent skill/base-prompt setting. Parent-agent skill availability does not force child agents to invoke the same skill. Restart the agent host or refresh its skill registry after adding links; if the host exposes a skill list, verify `horizon-track` appears before relying on it.

## Notes and troubleshooting

- `oz mcp list` lists Warp-shared registrations, but the installed CLI exposes no `add` or `register` subcommand. Use `--mcp docs/warp-mcp-servers.json` for repeatable local runs.
- Initial direct `npx` smoke attempts encountered Windows `EPERM`/`EBUSY` errors while npm cleaned up temporary package directories. This did not invalidate the configuration syntax or published executable mappings, but a successful agent probe is still needed to verify live MCP handshakes.
- No credentials are required by the current local stdio configuration. Do not place future tokens or API keys in `docs/warp-mcp-servers.json`; inject them from a secrets manager instead.
