# MCP Host Isolation

`oisin-pipeline` treats `.pipeline/profiles.yaml` as the MCP source of truth.
Each profile grants a small list of `mcp_servers`, and runtime launch planning
must render only that profile-selected set for the target host.

## Codex

Codex `exec` supports `--ignore-user-config`, which skips
`$CODEX_HOME/config.toml` while continuing to use Codex auth. Pipeline-managed
Codex launches use that flag and pass the selected MCP servers explicitly with
`--config mcp_servers.<id>...` entries.

This prevents user-config MCP fan-out for pipeline-launched Codex agents. It
does not claim to suppress every possible system, managed, plugin, or trusted
project layer outside the CLI flag's documented scope.

Reference: https://developers.openai.com/codex/config-basic

## OpenCode

OpenCode configuration is merged from multiple layers. Pipeline-managed
OpenCode launches provide a temporary config file through `OPENCODE_CONFIG`
containing the selected profile MCP servers. The generated config also writes
`enabled: false` entries for MCP server ids declared by this pipeline config
but not selected by the current profile.

This prevents leakage from pipeline-known MCP ids. OpenCode does not currently
offer a documented `run` flag equivalent to Codex `--ignore-user-config`, so
arbitrary global or managed MCP servers outside the pipeline's declared ids may
still be present unless the operator isolates OpenCode's config home or the
host adds stronger isolation support.

References:
- https://dev.opencode.ai/docs/config/
- https://thdxr.dev.opencode.ai/docs/mcp-servers/

For the shared remote/gateway deployment model that avoids starting duplicate
upstream MCP processes per agent, see [`mcp-gateway.md`](mcp-gateway.md).
