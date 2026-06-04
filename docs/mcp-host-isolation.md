# MCP Host Isolation

`oisin-pipeline` treats project host config as the MCP client boundary. The
generated Codex and OpenCode project configs declare exactly one remote MCP
server: `pipeline-gateway`.

## Codex

Codex `exec` supports `--ignore-user-config`, which skips
`$CODEX_HOME/config.toml` while continuing to use Codex auth. Pipeline-managed
Codex launches use that flag and rely on the project `.codex/config.toml`
gateway entry.

This prevents user-config MCP fan-out for pipeline-launched Codex agents. It
does not claim to suppress every possible system, managed, plugin, or trusted
project layer outside the CLI flag's documented scope.

Reference: https://developers.openai.com/codex/config-basic

## OpenCode

OpenCode project config is generated at `.opencode/opencode.json` with only the
`pipeline-gateway` remote MCP server. Runtime launches do not set inline MCP
config environment variables; agents inherit the project-level config.

References:
- https://opencode.ai/docs/config/
- https://dev.opencode.ai/docs/mcp-servers/

For the shared remote/gateway deployment model that avoids starting duplicate
upstream MCP processes per agent, see [`mcp-gateway.md`](mcp-gateway.md).
