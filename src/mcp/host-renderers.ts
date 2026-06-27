import type { PipelineConfig } from "../config";
import {
  configuredGateway,
  gatewayAuthorizationHeader,
  gatewayUrl,
  type McpGatewayConfig,
  PIPELINE_GATEWAY_SERVER_ID,
} from "./gateway-config";

export function renderOpenCodeGatewayConfig(
  config: PipelineConfig,
  env: NodeJS.ProcessEnv = process.env
): string {
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
}

export function renderClaudeGatewayMcpServers(
  config: PipelineConfig,
  env: NodeJS.ProcessEnv = process.env
): Record<string, unknown> {
  const gateway = configuredGateway(config);
  return {
    [PIPELINE_GATEWAY_SERVER_ID]: {
      headers: gatewayClaudeHeaders(gateway),
      type: "http",
      url: gatewayUrl(gateway, env),
    },
  };
}

export function renderClaudeGatewayUserConfig(
  config: PipelineConfig,
  env: NodeJS.ProcessEnv = process.env
): string {
  return `${JSON.stringify(
    {
      mcpServers: renderClaudeGatewayMcpServers(config, env),
    },
    null,
    2
  )}\n`;
}

export function renderCodexGatewayConfig(
  config: PipelineConfig,
  env: NodeJS.ProcessEnv = process.env
): string {
  const gateway = configuredGateway(config);
  return [
    `[mcp_servers.${PIPELINE_GATEWAY_SERVER_ID}]`,
    `url = ${tomlString(gatewayUrl(gateway, env))}`,
    "",
    `[mcp_servers.${PIPELINE_GATEWAY_SERVER_ID}.env_http_headers]`,
    `Authorization = ${tomlString(gateway.authorization_env)}`,
    "",
  ].join("\n");
}

function gatewayOpenCodeHeaders(
  gateway: McpGatewayConfig
): Record<string, string> {
  return {
    Authorization: gatewayAuthorizationHeader(gateway),
  };
}

function gatewayClaudeHeaders(
  gateway: McpGatewayConfig
): Record<string, string> {
  return {
    Authorization: `\${${gateway.authorization_env}}`,
  };
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}
