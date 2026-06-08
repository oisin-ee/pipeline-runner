# Shared MCP Gateway

Pipeline-launched agents should not each start a full copy of every MCP server.
The scalable shape is one shared MCP gateway per developer machine, CI worker,
or cluster namespace. Agent hosts then connect to that gateway, and the gateway
fans requests out to upstream tools such as Backlog, GitHub, Serena, Context7,
Playwright, Qdrant, or Neon.

## Target Shape

```text
Codex/OpenCode
        |
        | project-level MCP config
        v
pipeline MCP gateway
        |
        | upstream routing, auth, logging, rate limits
        v
Backlog / GitHub / Serena / Context7 / Playwright / Qdrant / Neon
```

The gateway owns long-lived upstream connections and process lifecycle. The
pipeline owns the host projection: project host config declares only the
singleton `pipeline-gateway` remote MCP server. Agents inherit that project
config instead of receiving profile-scoped native MCP config.

Repo-aware upstreams bind to the current checkout. Local commands resolve the
workspace from `PIPELINE_TARGET_PATH` or the current working directory; runner
jobs use the already-prepared `/workspace` worktree. Gateway setup must not
clone, mirror, or copy the repository for MCP.

## Folder Boundary

MCP-specific code belongs in `src/mcp`:

- `gateway.ts`: hosted/local gateway config, diagnostics, and host config
  rewrites.

The rest of the runtime should consume those functions instead of hand-rendering
host-specific MCP config.

## Setup Model

1. Run or deploy a gateway that exposes one remote MCP endpoint.
2. Configure the gateway with upstream servers and credentials.
3. Configure `mcp_gateway` in package-owned profile config.
4. Run `pipe mcp gateway reconcile` to render and apply the full ToolHive vMCP
   backend inventory for the current workspace.
5. Run `pipe init` to write project Codex/OpenCode command surfaces and host
   MCP config.
6. Run `pipe mcp gateway doctor` to verify gateway health and required tools.
7. Keep high-risk upstream capabilities controlled by gateway-side policy, not
   by asking every agent host to independently start or filter servers.

Example profile config:

```yaml
mcp_gateway:
  provider: toolhive
  mode: hosted
  url: https://pipeline-mcp.momokaya.ee/mcp/
  url_env: PIPELINE_MCP_GATEWAY_URL
  authorization_env: PIPELINE_MCP_GATEWAY_AUTHORIZATION
  default_profile: default
  backends:
    context7:
      locality: shared-remote
      tool_prefixes: [context7]
    backlog:
      locality: repo-local
      workspace_path_source: PIPELINE_TARGET_PATH
      tool_prefixes: [backlog]

profiles:
  pipeline-researcher:
    mcp_servers: [pipeline-gateway]
  pipeline-test-writer:
    mcp_servers: []
```

## Why This Fixes The File Descriptor Failure

The failure mode seen in nested runs is multiplicative:

```text
orchestrator MCP set * subagent count * host config layers
```

With a gateway, the runtime launches zero local upstream MCP processes for
agents. Codex and OpenCode read the same project-level host config, which
contains only `pipeline-gateway`.

OpenCode receives that gateway through `.opencode/opencode.json` alongside the
package-owned runtime projection: `lsp: true`, pinned plugin entries, generated
agents, projected skills, explicit permissions, and local TypeScript plugins.
Those resources give OpenCode richer runtime assistance without changing MCP
ownership: upstream servers still live behind the gateway.

## Candidate Gateway Implementations

Use an off-the-shelf aggregator when possible:

- ToolHive vMCP gateway: hosted or local aggregation behind a single MCP URL.

Use `pipe mcp gateway reconcile` to render the complete aggregate backend list;
adding one backend must not replace the existing Context7, uidotsh, Qdrant,
Fallow, Serena, or Backlog declarations. Use `pipe mcp gateway doctor` to check
required environment variables, gateway health, required `tools/list` prefixes,
local ToolHive availability for local mode, and legacy direct MCP entries. Use
`pipe init` to install generated Codex and OpenCode host surfaces with the
singleton `pipeline-gateway` remote entry. Use `pipe install-commands --host all`
to refresh generated host files after package upgrades, and use
`pipe mcp gateway configure-host` as an explicit migration or repair command
when existing host MCP config must be rewritten with a backup.

The package-owned MCP inventory exposed through the ecosystem manifest includes
`pipeline-gateway`, Context7, uidotsh, Qdrant, Fallow, Serena, Backlog, GitHub,
Playwright Browser, and Neon. Repo-scoped backends must bind to
`PIPELINE_TARGET_PATH` or the current workspace path supplied by the gateway
configuration.
