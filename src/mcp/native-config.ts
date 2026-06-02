import type { PipelineConfig } from "../config.js";
import { isRemoteMcpServer } from "./launch-plan.js";

export function codexNativeMcpConfig(
  config: PipelineConfig,
  profile: PipelineConfig["profiles"][string]
): Record<string, unknown> {
  const mcpServers = Object.fromEntries(
    (profile.mcp_servers ?? []).flatMap((id) => {
      const server = config.mcp_servers[id];
      return server ? [[id, codexNativeMcpServerConfig(server)] as const] : [];
    })
  );
  return Object.keys(mcpServers).length > 0 ? { mcp_servers: mcpServers } : {};
}

function codexNativeMcpServerConfig(
  server: PipelineConfig["mcp_servers"][string]
): Record<string, unknown> {
  if (isRemoteMcpServer(server)) {
    return {
      ...(server.bearer_token_env_var
        ? { bearer_token_env_var: server.bearer_token_env_var }
        : {}),
      ...(server.headers ? { http_headers: server.headers } : {}),
      url: server.url,
    };
  }
  return {
    ...(server.args ? { args: server.args } : {}),
    command: server.command,
    ...(server.env ? { env: server.env } : {}),
  };
}
