import type { PipelineConfig } from "../config";
import { PipelineMcpGatewayError } from "./gateway-error";

export const PIPELINE_GATEWAY_SERVER_ID = "pipeline-gateway";

const DEFAULT_LOCAL_GATEWAY_URL = "http://127.0.0.1:4483/mcp";

type ActorConfig = PipelineConfig["profiles"][string];
export type McpServerConfig = PipelineConfig["mcp_servers"][string];
export type McpGatewayConfig = NonNullable<PipelineConfig["mcp_gateway"]>;

const profileNeedsMcpGateway = (actor: ActorConfig | void): boolean =>
  actor !== undefined && (actor.mcp_servers ?? []).length > 0;

export const configuredGateway = (config: PipelineConfig): McpGatewayConfig => {
  if (!config.mcp_gateway) {
    throw new PipelineMcpGatewayError("Profiles that declare mcp_servers require top-level mcp_gateway configuration.");
  }
  return config.mcp_gateway;
};

export const gatewayUrl = (gateway: McpGatewayConfig, env: NodeJS.ProcessEnv = process.env): string => {
  const url = env[gateway.url_env];
  if (url !== undefined && url !== "") {
    return url;
  }
  if (gateway.url !== undefined && gateway.url !== "") {
    return gateway.url;
  }
  if (gateway.mode === "local") {
    return DEFAULT_LOCAL_GATEWAY_URL;
  }
  throw new PipelineMcpGatewayError(`MCP gateway URL is required. Set ${gateway.url_env}.`);
};

export const renderGatewayConfig = (config: PipelineConfig, env: NodeJS.ProcessEnv = process.env): string => {
  const gateway = configuredGateway(config);
  return [
    `provider: ${gateway.provider}`,
    `mode: ${gateway.mode}`,
    gateway.url !== undefined && gateway.url !== "" ? `url: ${gateway.url}` : "",
    `url_env: ${gateway.url_env}`,
    `authorization_env: ${gateway.authorization_env}`,
    gateway.default_profile !== undefined && gateway.default_profile !== ""
      ? `default_profile: ${gateway.default_profile}`
      : "",
    `resolved_url: ${gatewayUrl(gateway, env)}`,
  ]
    .filter((line) => line !== "")
    .join("\n");
};

export const gatewayAuthorizationHeader = (gateway: McpGatewayConfig): string => `{env:${gateway.authorization_env}}`;

const gatewayServer = (config: PipelineConfig, env: NodeJS.ProcessEnv): McpServerConfig => {
  const gateway = configuredGateway(config);
  const url = gatewayUrl(gateway, env);
  return {
    headers: {
      Authorization: gatewayAuthorizationHeader(gateway),
    },
    url,
  };
};

export const gatewayServerForProfile = (
  config: PipelineConfig | void,
  actor: ActorConfig | void,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, McpServerConfig> => {
  if (config === undefined || !profileNeedsMcpGateway(actor)) {
    return {};
  }
  return {
    [PIPELINE_GATEWAY_SERVER_ID]: gatewayServer(config, env),
  };
};
