# MCP Host Isolation

`moka` treats project host config as the MCP client boundary. The generated
OpenCode project config declares exactly one remote MCP server:
`pipeline-gateway`. `moka init` owns that generated project config during setup.

## OpenCode

OpenCode project config is generated at `.opencode/opencode.json` with only the
`pipeline-gateway` remote MCP server. Runtime launches do not set inline MCP
config environment variables; agents inherit the project-level config.

References:
- https://opencode.ai/docs/config/
- https://dev.opencode.ai/docs/mcp-servers/

For the shared remote/gateway deployment model that avoids starting duplicate
upstream MCP processes per agent, see [`mcp-gateway.md`](mcp-gateway.md).
