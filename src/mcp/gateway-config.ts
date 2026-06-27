import type { PipelineConfig } from "../config";
import { PipelineMcpGatewayError } from "./gateway-error";

export const PIPELINE_GATEWAY_SERVER_ID = "pipeline-gateway";

const DEFAULT_LOCAL_GATEWAY_URL = "http://127.0.0.1:4483/mcp";

type ActorConfig = PipelineConfig["profiles"][string];
export type McpServerConfig = PipelineConfig["mcp_servers"][string];
export type McpGatewayConfig = NonNullable<PipelineConfig["mcp_gateway"]>;

function profileNeedsMcpGateway(actor: ActorConfig | undefined): boolean {
  return (actor?.mcp_servers ?? []).length > 0;
}

export function gatewayServerForProfile(
  config: PipelineConfig | undefined,
  actor: ActorConfig | undefined,
  env: NodeJS.ProcessEnv = process.env
): Record<string, McpServerConfig> {
  if (!(config && profileNeedsMcpGateway(actor))) {
    return {};
  }
  return {
    [PIPELINE_GATEWAY_SERVER_ID]: gatewayServer(config, env),
  };
}

function gatewayServer(
  config: PipelineConfig,
  env: NodeJS.ProcessEnv
): McpServerConfig {
  const gateway = configuredGateway(config);
  const url = gatewayUrl(gateway, env);
  return {
    headers: {
      Authorization: gatewayAuthorizationHeader(gateway),
    },
    url,
  };
}

export function configuredGateway(config: PipelineConfig): McpGatewayConfig {
  if (!config.mcp_gateway) {
    throw new PipelineMcpGatewayError(
      "Profiles that declare mcp_servers require top-level mcp_gateway configuration."
    );
  }
  return config.mcp_gateway;
}

export function gatewayUrl(
  gateway: McpGatewayConfig,
  env: NodeJS.ProcessEnv = process.env
): string {
  const url = env[gateway.url_env];
  if (url) {
    return url;
  }
  if (gateway.url) {
    return gateway.url;
  }
  if (gateway.mode === "local") {
    return DEFAULT_LOCAL_GATEWAY_URL;
  }
  throw new PipelineMcpGatewayError(
    `MCP gateway URL is required. Set ${gateway.url_env}.`
  );
}

export function renderGatewayConfig(
  config: PipelineConfig,
  env: NodeJS.ProcessEnv = process.env
): string {
  const gateway = configuredGateway(config);
  return [
    `provider: ${gateway.provider}`,
    `mode: ${gateway.mode}`,
    gateway.url ? `url: ${gateway.url}` : "",
    `url_env: ${gateway.url_env}`,
    `authorization_env: ${gateway.authorization_env}`,
    gateway.default_profile
      ? `default_profile: ${gateway.default_profile}`
      : "",
    `resolved_url: ${gatewayUrl(gateway, env)}`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function gatewayAuthorizationHeader(gateway: McpGatewayConfig): string {
  return `{env:${gateway.authorization_env}}`;
}
