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
pipeline owns per-profile grants: a profile may talk to the gateway, but only
with the tool set declared in `.pipeline/profiles.yaml`.

## Folder Boundary

MCP-specific code belongs in `src/mcp`:

- `bootstrap.ts`: default MCPM registration, generated `.mcp.json`, and install
  manifest parsing.
- `launch-plan.ts`: runtime host projection for Codex and OpenCode, including
  profile-scoped server selection.
- `native-config.ts`: generated native Codex agent MCP config.

The rest of the runtime should consume those functions instead of hand-rendering
host-specific MCP config.

## Setup Model

1. Run or deploy a gateway that exposes one remote MCP endpoint.
2. Configure the gateway with upstream servers and credentials.
3. Register one pipeline MCP server id, for example `gateway`, in
   `.pipeline/profiles.yaml`.
4. Grant `gateway` only to profiles that need MCP access.
5. Keep high-risk upstream capabilities controlled by gateway-side policy, not
   by asking every agent host to independently start or filter servers.

Example profile registry:

```yaml
mcp_servers:
  gateway:
    url: http://127.0.0.1:8787/mcp
    bearer_token_env_var: PIPELINE_MCP_GATEWAY_TOKEN

profiles:
  pipeline-researcher:
    mcp_servers: [gateway]
  pipeline-test-writer:
    mcp_servers: []
```

## Why This Fixes The File Descriptor Failure

The failure mode seen in nested runs is multiplicative:

```text
orchestrator MCP set * subagent count * host config layers
```

With a gateway, the runtime launches zero local upstream MCP processes for most
agents. Codex receives `--ignore-user-config` plus the profile-selected gateway
entry. OpenCode receives a temporary `OPENCODE_CONFIG` containing the selected
gateway entry and disabled entries for other pipeline-known MCP ids.

## Candidate Gateway Implementations

Use an off-the-shelf aggregator when possible:

- ToolHive Gateway: local or Kubernetes MCP gateway with managed upstream
  server lifecycle.
- ContextForge MCP Gateway: central gateway/registry pattern for multiple MCP
  servers.
- A thin custom gateway: acceptable only if it mostly composes existing MCP
  server processes and adds auth, routing, logging, and allow-list policy.

Whichever gateway is chosen, keep pipeline configuration host-agnostic: define
remote MCP endpoints in `.pipeline/profiles.yaml`, then let `src/mcp` project
that config into each host's native launch format.
