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
        | profile-scoped MCP config
        v
pipeline MCP gateway
        |
        | upstream routing, auth, logging, rate limits
        v
Backlog / GitHub / Serena / Context7 / Playwright / Qdrant / Neon
```

The gateway owns long-lived upstream connections and process lifecycle. The
pipeline owns the host projection: profiles that need MCP declare the singleton
`pipeline-gateway` grant, and every Codex/OpenCode session receives only that
remote MCP server.

## Folder Boundary

MCP-specific code belongs in `src/mcp`:

- `gateway.ts`: hosted/local gateway config, diagnostics, and host config
  rewrites.
- `launch-plan.ts`: runtime host projection for Codex and OpenCode.
- `native-config.ts`: generated native Codex agent MCP config.

The rest of the runtime should consume those functions instead of hand-rendering
host-specific MCP config.

## Setup Model

1. Run or deploy a gateway that exposes one remote MCP endpoint.
2. Configure the gateway with upstream servers and credentials.
3. Configure `mcp_gateway` in `.pipeline/profiles.yaml`.
4. Grant `pipeline-gateway` only to profiles that need MCP access.
5. Keep high-risk upstream capabilities controlled by gateway-side policy, not
   by asking every agent host to independently start or filter servers.

Example profile config:

```yaml
mcp_gateway:
  provider: toolhive
  mode: hosted
  url: https://pipeline-mcp.momokaya.ee/mcp/
  url_env: PIPELINE_MCP_GATEWAY_URL
  token_env: MEMORY_MCP_BASIC_AUTH
  default_profile: default

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
agents. Codex receives `--ignore-user-config` plus one
`mcp_servers.pipeline-gateway` remote entry. OpenCode runs with isolated
XDG/config roots and receives inline `OPENCODE_CONFIG_CONTENT` containing only
`pipeline-gateway`.

## Candidate Gateway Implementations

Use an off-the-shelf aggregator when possible:

- ToolHive vMCP gateway: hosted or local aggregation behind a single MCP URL.

Use `pipe mcp gateway doctor` to check required environment variables, gateway
health, local ToolHive availability for local mode, and legacy direct MCP
entries. Use `pipe mcp gateway configure-host` to rewrite project or global
host config with a backup. For Codex, this removes persistent MCP entries and
leaves gateway metadata as comments because the runtime injects the gateway
with `--config` only for pipeline-launched agents.
