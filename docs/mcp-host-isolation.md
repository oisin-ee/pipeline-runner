# MCP Host Isolation

`oisin-pipeline` treats `.pipeline/profiles.yaml` as the MCP source of truth.
Profiles that need MCP grant `pipeline-gateway`; runtime launch planning renders
exactly one remote MCP server for the target host.

## Codex

Codex `exec` supports `--ignore-user-config`, which skips
`$CODEX_HOME/config.toml` while continuing to use Codex auth. Pipeline-managed
Codex launches use that flag and pass the singleton gateway explicitly with
`--config mcp_servers.pipeline-gateway...` entries.

This prevents user-config MCP fan-out for pipeline-launched Codex agents. It
does not claim to suppress every possible system, managed, plugin, or trusted
project layer outside the CLI flag's documented scope.

Reference: https://developers.openai.com/codex/config-basic

## OpenCode

OpenCode configuration is merged from multiple layers, so `OPENCODE_CONFIG`
alone is not an isolation boundary. Pipeline-managed OpenCode launches create
an isolated temporary runtime root, set `XDG_CONFIG_HOME`, `XDG_DATA_HOME`,
`XDG_STATE_HOME`, `XDG_CACHE_HOME`, and `OPENCODE_TEST_HOME` inside it, disable
project config with `OPENCODE_DISABLE_PROJECT_CONFIG=1`, and pass the
`pipeline-gateway` remote server through `OPENCODE_CONFIG_CONTENT`.

The generated inline config contains only `pipeline-gateway`. Direct upstream
MCP ids are omitted rather than rendered as disabled entries, because enabled
MCP servers can be started during OpenCode MCP service initialization before
per-message tool filtering.

Strict isolation means pipeline-managed OpenCode launches do not read the
user's normal OpenCode account or MCP auth files. Provider credentials should be
available through provider environment variables. Admin-managed OpenCode config
outside the user/project config layers may still require container isolation or
upstream host support.

References:
- https://opencode.ai/docs/config/
- https://dev.opencode.ai/docs/mcp-servers/

For the shared remote/gateway deployment model that avoids starting duplicate
upstream MCP processes per agent, see [`mcp-gateway.md`](mcp-gateway.md).
