import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PipelineConfig, RunnerType } from "../config.js";

const TOML_BARE_KEY_PATTERN = /^[A-Za-z0-9_-]+$/;

type ActorConfig = PipelineConfig["profiles"][string];
type McpServerConfig = PipelineConfig["mcp_servers"][string];

export interface McpLaunchPlan {
  args: string[];
  env: Record<string, string>;
  selectedServers: Record<string, McpServerConfig>;
}

export interface McpLaunchPlanInput {
  actor?: ActorConfig;
  config?: PipelineConfig;
  nodeId: string;
  runnerType: RunnerType;
  worktreePath: string;
}

export function buildMcpLaunchPlan(input: McpLaunchPlanInput): McpLaunchPlan {
  const selectedServers = selectedMcpServers(input.config, input.actor);
  return {
    args: mcpArgsFor(input.runnerType, selectedServers, Boolean(input.config)),
    env: mcpEnvFor(input, selectedServers),
    selectedServers,
  };
}

export function selectedMcpServers(
  config: PipelineConfig | undefined,
  actor: ActorConfig | undefined
): Record<string, McpServerConfig> {
  return Object.fromEntries(
    (actor?.mcp_servers ?? []).flatMap((id) => {
      const server = config?.mcp_servers[id];
      return server ? [[id, server] as const] : [];
    })
  );
}

function mcpArgsFor(
  runnerType: RunnerType,
  servers: Record<string, McpServerConfig>,
  hasPipelineConfig: boolean
): string[] {
  if (runnerType === "codex") {
    return [
      ...(hasPipelineConfig ? ["--ignore-user-config"] : []),
      ...codexMcpArgs(servers),
    ];
  }
  if (Object.keys(servers).length === 0) {
    return [];
  }
  return [];
}

function mcpEnvFor(
  input: McpLaunchPlanInput,
  servers: Record<string, McpServerConfig>
): Record<string, string> {
  const declaredServers = input.config?.mcp_servers ?? {};
  if (
    input.runnerType !== "opencode" ||
    (Object.keys(servers).length === 0 &&
      Object.keys(declaredServers).length === 0)
  ) {
    return {};
  }
  const config = toOpenCodeMcpConfig(servers, declaredServers);
  const dir = mkdtempSync(join(tmpdir(), "pipeline-opencode-mcp-"));
  const path = join(dir, `${input.nodeId}.json`);
  writeFileSync(path, JSON.stringify(config));
  return {
    OPENCODE_CONFIG: path,
    PIPELINE_WORKTREE: input.worktreePath,
  };
}

export function isRemoteMcpServer(
  server: McpServerConfig
): server is McpServerConfig & { url: string } {
  return typeof server.url === "string";
}

function headersWithBearerTokenEnv(
  server: McpServerConfig & { bearer_token_env_var?: string },
  renderTokenRef: (envVar: string) => string
): Record<string, string> | undefined {
  const headers = { ...(server.headers ?? {}) };
  if (server.bearer_token_env_var) {
    headers.Authorization = `Bearer ${renderTokenRef(server.bearer_token_env_var)}`;
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

function toOpenCodeMcpConfig(
  selectedServers: Record<string, McpServerConfig>,
  declaredServers: Record<string, McpServerConfig>
): {
  mcp: Record<string, Record<string, unknown>>;
} {
  const disabledServers = Object.fromEntries(
    Object.keys(declaredServers)
      .filter((id) => !selectedServers[id])
      .map((id) => [id, { enabled: false }])
  );
  return {
    mcp: {
      ...disabledServers,
      ...Object.fromEntries(
        Object.entries(selectedServers).map(([id, server]) => {
          if (isRemoteMcpServer(server)) {
            const headers = headersWithBearerTokenEnv(
              server,
              (envVar) => `{env:${envVar}}`
            );
            return [
              id,
              {
                enabled: true,
                ...(headers ? { headers } : {}),
                type: "remote",
                url: server.url,
              },
            ];
          }
          return [
            id,
            {
              command: [server.command, ...(server.args ?? [])],
              enabled: true,
              ...(server.env ? { environment: server.env } : {}),
              type: "local",
            },
          ];
        })
      ),
    },
  };
}

function codexMcpArgs(servers: Record<string, McpServerConfig>): string[] {
  return Object.entries(servers).flatMap(([id, server]) => {
    if (isRemoteMcpServer(server)) {
      return [
        "--config",
        `mcp_servers.${id}.url=${tomlValue(server.url)}`,
        ...(server.headers
          ? [
              "--config",
              `mcp_servers.${id}.http_headers=${tomlValue(server.headers)}`,
            ]
          : []),
        ...(server.bearer_token_env_var
          ? [
              "--config",
              `mcp_servers.${id}.bearer_token_env_var=${tomlValue(server.bearer_token_env_var)}`,
            ]
          : []),
      ];
    }
    return [
      "--config",
      `mcp_servers.${id}.command=${tomlValue(server.command)}`,
      ...(server.args
        ? ["--config", `mcp_servers.${id}.args=${tomlValue(server.args)}`]
        : []),
      ...(server.env
        ? ["--config", `mcp_servers.${id}.env=${tomlValue(server.env)}`]
        : []),
    ];
  });
}

export function tomlValue(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(tomlValue).join(", ")}]`;
  }
  if (value && typeof value === "object") {
    return `{ ${Object.entries(value)
      .map(([key, item]) => `${tomlKey(key)} = ${tomlValue(item)}`)
      .join(", ")} }`;
  }
  return JSON.stringify(value);
}

function tomlKey(key: string): string {
  return TOML_BARE_KEY_PATTERN.test(key) ? key : JSON.stringify(key);
}
