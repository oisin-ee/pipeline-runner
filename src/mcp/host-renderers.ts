import type { PipelineConfig } from "../config";
import {
  configuredGateway,
  gatewayAuthorizationHeader,
  gatewayUrl,
  PIPELINE_GATEWAY_SERVER_ID,
} from "./gateway-config";
import type { McpGatewayConfig } from "./gateway-config";

const gatewayOpenCodeHeaders = (
  gateway: McpGatewayConfig
): Record<string, string> => ({
  Authorization: gatewayAuthorizationHeader(gateway),
});

export const renderOpenCodeGatewayConfig = (
  config: PipelineConfig,
  env: NodeJS.ProcessEnv = process.env
): string => {
  const gateway = configuredGateway(config);
  return `${JSON.stringify(
    {
      $schema: "https://opencode.ai/config.json",
      mcp: {
        [PIPELINE_GATEWAY_SERVER_ID]: {
          enabled: true,
          headers: gatewayOpenCodeHeaders(gateway),
          oauth: false,
          type: "remote",
          url: gatewayUrl(gateway, env),
        },
      },
    },
    null,
    2
  )}\n`;
};

const gatewayClaudeHeaders = (
  gateway: McpGatewayConfig
): Record<string, string> => ({
  Authorization: `\${${gateway.authorization_env}}`,
});

export const renderClaudeGatewayMcpServers = (
  config: PipelineConfig,
  env: NodeJS.ProcessEnv = process.env
): Record<string, unknown> => {
  const gateway = configuredGateway(config);
  return {
    [PIPELINE_GATEWAY_SERVER_ID]: {
      headers: gatewayClaudeHeaders(gateway),
      type: "http",
      url: gatewayUrl(gateway, env),
    },
  };
};

export const renderClaudeGatewayUserConfig = (
  config: PipelineConfig,
  env: NodeJS.ProcessEnv = process.env
): string =>
  `${JSON.stringify(
    {
      mcpServers: renderClaudeGatewayMcpServers(config, env),
    },
    null,
    2
  )}\n`;

const tomlString = (value: string): string => JSON.stringify(value);

export const renderCodexGatewayConfig = (
  config: PipelineConfig,
  env: NodeJS.ProcessEnv = process.env
): string => {
  const gateway = configuredGateway(config);
  return [
    `[mcp_servers.${PIPELINE_GATEWAY_SERVER_ID}]`,
    `url = ${tomlString(gatewayUrl(gateway, env))}`,
    "",
    `[mcp_servers.${PIPELINE_GATEWAY_SERVER_ID}.env_http_headers]`,
    `Authorization = ${tomlString(gateway.authorization_env)}`,
    "",
  ].join("\n");
};
