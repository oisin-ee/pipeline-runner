# Shared MCP Gateway

Pipeline-launched agents should not each start a full copy of every MCP server.
The scalable shape is one shared MCP gateway per developer machine, CI worker,
or cluster namespace. Agent hosts then connect to that gateway, and the gateway
fans requests out to upstream tools such as Backlog, GitHub, Serena, Context7,
Playwright, Qdrant, or Neon.

## Target Shape

```text
OpenCode / Claude Code
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
4. Run `moka mcp gateway reconcile` to render and apply the full ToolHive vMCP
   backend inventory for the current workspace.
5. Run `moka init` to write OpenCode and Claude Code command surfaces and host
   MCP config.
6. Run `moka mcp gateway doctor` to verify gateway health and required tools.
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
  moka-researcher:
    mcp_servers: [pipeline-gateway]
  moka-test-writer:
    mcp_servers: []
```

## Why This Fixes The File Descriptor Failure

The failure mode seen in nested runs is multiplicative:

```text
orchestrator MCP set * subagent count * host config layers
```

With a gateway, the runtime launches zero local upstream MCP processes for
agents. OpenCode and Claude Code read the same project-level host config, which
contains only `pipeline-gateway`.

OpenCode receives that gateway through `.opencode/opencode.json` alongside the
package-owned runtime projection: `lsp: true`, pinned plugin entries, generated
agents, projected skills, explicit permissions, and local TypeScript plugins.
`moka init` merges this OpenCode project config:
existing repo-local plugin entries are preserved while missing package defaults
such as telemetry and goal-context plugins are appended. Existing
`mcp.pipeline-gateway` settings are also preserved; use
`moka mcp gateway configure-host` when the host MCP config must be deliberately
rewritten. Restart OpenCode after config changes because it loads config at
startup. These resources give OpenCode richer runtime assistance without
changing MCP ownership: upstream servers still live behind the gateway.

## Candidate Gateway Implementations

Use an off-the-shelf aggregator when possible:

- ToolHive vMCP gateway: hosted or local aggregation behind a single MCP URL.

Use `moka mcp gateway reconcile` to render the complete aggregate backend list;
adding one backend must not replace the existing Context7, uidotsh, Playwright,
Qdrant, Fallow, Serena, or Backlog declarations. Use
`moka mcp gateway doctor` to check required environment variables, gateway
health, required `tools/list` prefixes, local ToolHive availability for local
mode, and legacy direct MCP entries. Use `moka init` to install generated
OpenCode and Claude Code host surfaces with the singleton `pipeline-gateway`
remote entry, and `moka init --check` to verify generated host files are current
after package upgrades. Use
`moka mcp gateway configure-host` as an explicit migration or repair command
when existing host MCP config must be rewritten with a backup. The hosted gateway
requires `PIPELINE_MCP_GATEWAY_AUTHORIZATION` to be set in the OpenCode
environment.

The package-owned MCP inventory exposed through the ecosystem manifest includes
`pipeline-gateway`, Context7, uidotsh, Playwright, Qdrant, Fallow, Serena,
Backlog, GitHub, and Neon. Repo-scoped backends must bind to
`PIPELINE_TARGET_PATH` or the current workspace path supplied by the gateway
configuration.

## Browser automation backend (Steel)

The `Playwright` backend's tools (`playwright_browser_*`) are served by a
self-hosted **Steel Browser** (Chromium) pool, not a browser launched inside the
MCP pod. Microsoft's `@playwright/mcp` connects to Steel over CDP, so the tool
surface is unchanged — agents keep calling the same `playwright_browser_*` tools
through `pipeline-gateway`.

Topology (infra repo, `k8s/charts/pipeline-mcp-gateway`):

- A StatefulSet of N backend pods (`playwright.backendReplicas`, default 3). Each
  pod is `mcp` (`@playwright/mcp`) + a private `steel` sidecar (its own Chrome on
  `localhost:3000`) + an `auth-seed` native sidecar. One pod = one isolated,
  verify-bot-authenticated browser.
- Auth: the seed runs a real headless Zitadel login and POSTs the session into
  the pod's Steel (`POST /v1/sessions`); the pod stays NotReady until the first
  seed lands (fail-closed — an unauthenticated browser is never served) and
  re-seeds every ~3 days, inside the oauth2-proxy 7-day cookie window.

Usage:

- **One authenticated browser (default).** Call `playwright_browser_*` through
  `pipeline-gateway` (`https://pipeline-mcp.momokaya.ee/mcp/`). You get a single,
  pre-authenticated browser. After a gateway backend restart the vMCP client
  session can drop — reconnect the MCP client (do not bounce pods).
- **N concurrent isolated browsers.** The single gateway/proxy endpoint does
  **not** auto-distribute sessions across the pool — toolhive pins every session
  to one backend pod (Redis session storage and scaling proxy replicas do not
  change this). To use the pool concurrently, address the backend pods directly:
  each pod's `@playwright/mcp` listens on port `8931` and is a full
  `playwright_browser_*` endpoint (`http://<pod-ip-or-headless-dns>:8931/mcp`).
  Proven: 3 concurrent per-pod sessions, each on a distinct authenticated
  browser.
- Scale the pool with `playwright.backendReplicas`.

Operational notes: Steel runs as root in-pod (its bundled nginx requires it,
otherwise `nginx [emerg] chown(/var/lib/nginx/body) Operation not permitted`);
health is `GET /v1/health`; on ARM nodes set `SKIP_FINGERPRINT_INJECTION=true`;
CDP over a service-DNS host needs `--cdp-header "Host: localhost"` (Chrome's
anti-DNS-rebinding check), but the in-pod `localhost:3000` path needs no header.
See infra `INFRA-074`.
