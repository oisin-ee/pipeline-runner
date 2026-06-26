import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Effect } from "effect";
import { replaceClaudeUserMcpServers } from "../claude-user-config";
import { mergeCodexConfig } from "../codex-config";
import type { PipelineConfig } from "../config";
import {
  McpGatewayService,
  McpGatewayServiceLive,
} from "../runtime/services/mcp-gateway-service";
import { PipelineMcpGatewayError } from "./gateway-error";
import { resolveRepoLocalBackendSpecs } from "./repo-local-backends";
import { renderToolHiveVmcpInventory } from "./toolhive-vmcp";

const PIPELINE_GATEWAY_SERVER_ID = "pipeline-gateway";
const DEFAULT_LOCAL_GATEWAY_URL = "http://127.0.0.1:4483/mcp";
const LEGACY_OPENCODE_MCP_RE = /"mcp"\s*:\s*{(?!\s*"pipeline-gateway")/s;
const LEGACY_PIPELINE_MCP_RE = /path:\s*\.mcp\.json|uvx\s+mcpm|mcpm\s+run/;

type ActorConfig = PipelineConfig["profiles"][string];
type McpServerConfig = PipelineConfig["mcp_servers"][string];
type McpGatewayConfig = NonNullable<PipelineConfig["mcp_gateway"]>;
export type GatewayHostSelection = "all" | GatewayHost;
export type GatewayHostScope = "global" | "project";
type GatewayHost = "opencode" | "claude-code" | "codex";

export interface GatewayDoctorCheck {
  detail: string;
  name: string;
  passed: boolean;
}

export interface GatewayDoctorResult {
  checks: GatewayDoctorCheck[];
  passed: boolean;
}

export interface GatewayHostConfigResult {
  backupPath?: string;
  host: GatewayHost;
  path: string;
}

export interface GatewayConfigureHostOptions {
  cwd: string;
  host: GatewayHostSelection;
  scope: GatewayHostScope;
}

export interface GatewayReconcileResult {
  backendCount: number;
  configPath: string;
  readinessFailures: string[];
  workspacePath: string;
}

function profileNeedsMcpGateway(actor: ActorConfig | undefined): boolean {
  return (actor?.mcp_servers ?? []).length > 0;
}

function runMcpGatewayEffect<A>(
  program: Effect.Effect<A, PipelineMcpGatewayError, McpGatewayService>
): Promise<A> {
  return Effect.runPromise(Effect.provide(program, McpGatewayServiceLive));
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
  env: NodeJS.ProcessEnv = process.env
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

function configuredGateway(config: PipelineConfig): McpGatewayConfig {
  if (!config.mcp_gateway) {
    throw new PipelineMcpGatewayError(
      "Profiles that declare mcp_servers require top-level mcp_gateway configuration."
    );
  }
  return config.mcp_gateway;
}

function gatewayUrl(
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

export function renderGatewayConfig(config: PipelineConfig): string {
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
    `resolved_url: ${gatewayUrl(gateway)}`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function renderOpenCodeGatewayConfig(config: PipelineConfig): string {
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
          url: gatewayUrl(gateway),
        },
      },
    },
    null,
    2
  )}\n`;
}

function renderClaudeGatewayMcpServers(
  config: PipelineConfig
): Record<string, unknown> {
  const gateway = configuredGateway(config);
  return {
    [PIPELINE_GATEWAY_SERVER_ID]: {
      headers: gatewayClaudeHeaders(gateway),
      type: "http",
      url: gatewayUrl(gateway),
    },
  };
}

export function renderClaudeGatewayUserConfig(config: PipelineConfig): string {
  return `${JSON.stringify(
    {
      mcpServers: renderClaudeGatewayMcpServers(config),
    },
    null,
    2
  )}\n`;
}

export function renderCodexGatewayConfig(config: PipelineConfig): string {
  const gateway = configuredGateway(config);
  return [
    `[mcp_servers.${PIPELINE_GATEWAY_SERVER_ID}]`,
    `url = ${tomlString(gatewayUrl(gateway))}`,
    "",
    `[mcp_servers.${PIPELINE_GATEWAY_SERVER_ID}.env_http_headers]`,
    `Authorization = ${tomlString(gateway.authorization_env)}`,
    "",
  ].join("\n");
}

export function configureGatewayHosts(
  config: PipelineConfig,
  options: GatewayConfigureHostOptions
): GatewayHostConfigResult[] {
  return selectedGatewayHosts(options.host).map((host) => {
    const adapter = GATEWAY_HOST_CONFIGS[host];
    const path = adapter.path(options.scope, options.cwd);
    const current = existsSync(path) ? readFileSync(path, "utf8") : undefined;
    const content = adapter.configureContent(config, current);
    const backupPath = backupIfExists(path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    return { backupPath, host, path };
  });
}

export function runGatewayDoctor(
  config: PipelineConfig,
  cwd: string
): Promise<GatewayDoctorResult> {
  return runMcpGatewayEffect(
    Effect.gen(function* () {
      const gateway = configuredGateway(config);
      const checks: GatewayDoctorCheck[] = [
        {
          detail: `${gateway.provider}/${gateway.mode}`,
          name: "gateway-config",
          passed: true,
        },
        checkGatewayUrl(gateway),
        checkGatewayToken(gateway),
        ...(gateway.mode === "local" ? [yield* checkThv(cwd)] : []),
        yield* checkGatewayHealth(gateway),
        yield* checkGatewayRequiredTools(gateway),
        checkLegacyDirectMcp(cwd),
      ];
      return {
        checks,
        passed: checks.every((check) => check.passed),
      };
    })
  );
}

export function startLocalGateway(
  config: PipelineConfig,
  cwd: string
): Promise<void> {
  return runMcpGatewayEffect(
    Effect.gen(function* () {
      const gateway = configuredGateway(config);
      if (gateway.mode !== "local") {
        return yield* Effect.fail(
          new PipelineMcpGatewayError(
            "mcp gateway local-start is only valid when mcp_gateway.mode is local."
          )
        );
      }
      const result = yield* reconcileGatewayEffect(config, cwd, process.env);
      if (result.readinessFailures.length > 0) {
        return yield* Effect.fail(
          new PipelineMcpGatewayError(
            `Cannot start local MCP gateway; readiness failures: ${result.readinessFailures.join("; ")}`
          )
        );
      }
      const service = yield* McpGatewayService;
      yield* service.serveToolHiveVmcp(result.configPath, cwd);
    })
  );
}

export function reconcileGateway(
  config: PipelineConfig,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<GatewayReconcileResult> {
  return runMcpGatewayEffect(reconcileGatewayEffect(config, cwd, env));
}

function reconcileGatewayEffect(
  config: PipelineConfig,
  cwd: string,
  env: NodeJS.ProcessEnv
): Effect.Effect<
  GatewayReconcileResult,
  PipelineMcpGatewayError,
  McpGatewayService
> {
  const gateway = configuredGateway(config);
  if (gateway.provider !== "toolhive") {
    return Effect.fail(
      new PipelineMcpGatewayError(
        `Unsupported MCP gateway provider '${gateway.provider}'.`
      )
    );
  }
  return Effect.gen(function* () {
    const service = yield* McpGatewayService;
    const workspacePath = env.PIPELINE_TARGET_PATH || cwd;
    const repoLocalBackends = resolveRepoLocalBackendSpecs(config, {
      cwd: workspacePath,
      env,
    });
    const toolHiveWorkloads = yield* service.listToolHiveGroupWorkloads(
      gateway.default_profile ?? "default",
      workspacePath
    );
    const inventory = renderToolHiveVmcpInventory(config, {
      repoLocalBackends,
      toolHiveWorkloads,
    });
    const configPath = join(
      workspacePath,
      ".pipeline",
      "mcp-gateway",
      "vmcp.yaml"
    );
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, inventory.yaml);
    yield* service.validateToolHiveVmcp(configPath, workspacePath);
    return {
      backendCount: inventory.backends.length,
      configPath,
      readinessFailures: [
        ...repoLocalBackends
          .filter((backend) => backend.enabled && !backend.readiness.ok)
          .map((backend) => `${backend.id}: ${backend.readiness.reason}`),
        ...inventory.backends
          .filter(
            (backend) => backend.enabled && backend.required && !backend.url
          )
          .map((backend) => `${backend.name}: missing ToolHive workload`),
      ],
      workspacePath,
    };
  });
}

export function localGatewayStatus(cwd: string): Promise<string> {
  return runMcpGatewayEffect(
    Effect.gen(function* () {
      const service = yield* McpGatewayService;
      return yield* service.localGatewayStatus(cwd);
    })
  );
}

function checkGatewayRequiredTools(
  gateway: McpGatewayConfig
): Effect.Effect<GatewayDoctorCheck, never, McpGatewayService> {
  const requiredPrefixes = requiredGatewayToolPrefixes(gateway);
  if (requiredPrefixes.length === 0) {
    return Effect.succeed({
      detail: "no required tools declared",
      name: "gateway-required-tools",
      passed: true,
    });
  }
  return Effect.gen(function* () {
    const tools = yield* listGatewayTools(gateway);
    const missing = requiredPrefixes.filter(
      (prefix) =>
        !tools.some((tool) => tool === prefix || tool.startsWith(`${prefix}_`))
    );
    return missing.length === 0
      ? {
          detail: `found: ${requiredPrefixes.join(", ")}`,
          name: "gateway-required-tools",
          passed: true,
        }
      : {
          detail: `missing: ${missing.join(", ")}`,
          name: "gateway-required-tools",
          passed: false,
        };
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed({
        detail: error instanceof Error ? error.message : String(error),
        name: "gateway-required-tools",
        passed: false,
      })
    )
  );
}

function requiredGatewayToolPrefixes(gateway: McpGatewayConfig): string[] {
  return [
    ...new Set(
      Object.values(gateway.backends)
        .filter((backend) => backend.required)
        .flatMap((backend) => backend.tool_prefixes)
    ),
  ].sort();
}

function listGatewayTools(
  gateway: McpGatewayConfig
): Effect.Effect<string[], PipelineMcpGatewayError, McpGatewayService> {
  const url = gatewayUrl(gateway);
  return Effect.gen(function* () {
    yield* callGatewayRpc(gateway, url, {
      id: 1,
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        capabilities: {},
        clientInfo: { name: "@oisincoveney/pipeline", version: "1" },
        protocolVersion: "2025-06-18",
      },
    });
    const listed = yield* callGatewayRpc(gateway, url, {
      id: 2,
      jsonrpc: "2.0",
      method: "tools/list",
      params: {},
    });
    const tools = listed.result?.tools;
    if (!Array.isArray(tools)) {
      return yield* Effect.fail(
        new PipelineMcpGatewayError("Malformed tools/list response.")
      );
    }
    return tools.flatMap((tool) =>
      tool && typeof tool.name === "string" ? [tool.name] : []
    );
  });
}

function callGatewayRpc(
  gateway: McpGatewayConfig,
  url: string,
  body: Record<string, unknown>
): Effect.Effect<
  { result?: { tools?: unknown } },
  PipelineMcpGatewayError,
  McpGatewayService
> {
  return Effect.gen(function* () {
    const service = yield* McpGatewayService;
    return yield* service.callGatewayRpc(
      url,
      body,
      process.env[gateway.authorization_env]
    );
  });
}

function selectedGatewayHosts(host: GatewayHostSelection): GatewayHost[] {
  return host === "all" ? ["opencode", "claude-code", "codex"] : [host];
}

interface GatewayHostConfigAdapter {
  configureContent: (
    config: PipelineConfig,
    current: string | undefined
  ) => string;
  path: (scope: GatewayHostScope, cwd: string) => string;
}

const GATEWAY_HOST_CONFIGS: Record<GatewayHost, GatewayHostConfigAdapter> = {
  "claude-code": {
    configureContent: (config, current) => {
      const merged = replaceClaudeUserMcpServers(current, {
        mcpServers: renderClaudeGatewayMcpServers(config),
      });
      if (!merged.ok) {
        throw new PipelineMcpGatewayError(
          "Cannot parse Claude Code user config."
        );
      }
      return merged.content;
    },
    path: claudeGatewayConfigPath,
  },
  codex: {
    configureContent: (config, current) =>
      mergeCodexConfig(current, renderCodexGatewayConfig(config)),
    path: codexGatewayConfigPath,
  },
  opencode: {
    configureContent: (config) => renderOpenCodeGatewayConfig(config),
    path: opencodeGatewayConfigPath,
  },
};

function opencodeGatewayConfigPath(
  scope: GatewayHostScope,
  cwd: string
): string {
  if (scope === "project") {
    return join(cwd, ".opencode", "opencode.json");
  }
  return join(
    process.env.OPENCODE_CONFIG_DIR ??
      join(
        process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
        "opencode"
      ),
    "opencode.json"
  );
}

function claudeGatewayConfigPath(scope: GatewayHostScope, cwd: string): string {
  if (scope === "project") {
    return join(cwd, ".mcp.json");
  }
  return join(
    dirname(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude")),
    ".claude.json"
  );
}

function codexGatewayConfigPath(scope: GatewayHostScope, cwd: string): string {
  if (scope === "project") {
    return join(cwd, ".codex", "config.toml");
  }
  return join(
    process.env.CODEX_HOME ?? join(homedir(), ".codex"),
    "config.toml"
  );
}

function backupIfExists(path: string): string | undefined {
  if (!existsSync(path)) {
    return;
  }
  const backupPath = `${path}.bak-${Date.now()}`;
  copyFileSync(path, backupPath);
  return backupPath;
}

function checkGatewayUrl(gateway: McpGatewayConfig): GatewayDoctorCheck {
  try {
    const url = gatewayUrl(gateway);
    return { detail: url, name: "gateway-url", passed: true };
  } catch (err) {
    return {
      detail: err instanceof Error ? err.message : String(err),
      name: "gateway-url",
      passed: false,
    };
  }
}

function checkGatewayToken(gateway: McpGatewayConfig): GatewayDoctorCheck {
  return process.env[gateway.authorization_env]
    ? {
        detail: gateway.authorization_env,
        name: "gateway-authorization",
        passed: true,
      }
    : {
        detail: `Set ${gateway.authorization_env}.`,
        name: "gateway-authorization",
        passed: false,
      };
}

function gatewayAuthorizationHeader(gateway: McpGatewayConfig): string {
  return `{env:${gateway.authorization_env}}`;
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

function checkThv(
  cwd: string
): Effect.Effect<GatewayDoctorCheck, never, McpGatewayService> {
  return Effect.gen(function* () {
    const service = yield* McpGatewayService;
    yield* service.runToolHiveVersion(cwd);
    return { detail: "available", name: "toolhive", passed: true };
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed({
        detail: error.message || "not available",
        name: "toolhive",
        passed: false,
      })
    )
  );
}

function checkGatewayHealth(
  gateway: McpGatewayConfig
): Effect.Effect<GatewayDoctorCheck, never, McpGatewayService> {
  let url: string;
  try {
    url = gatewayUrl(gateway);
  } catch (err) {
    return Effect.succeed({
      detail: err instanceof Error ? err.message : String(err),
      name: "gateway-health",
      passed: false,
    });
  }
  return Effect.gen(function* () {
    const service = yield* McpGatewayService;
    const response = yield* service.firstHealthyGatewayResponse(
      gatewayHealthUrls(url),
      process.env[gateway.authorization_env]
    );
    const passed = Boolean(response);
    return {
      detail: response
        ? `HTTP ${response.status} ${response.url}`
        : "gateway endpoint did not report healthy",
      name: "gateway-health",
      passed,
    };
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed({
        detail: error instanceof Error ? error.message : String(error),
        name: "gateway-health",
        passed: false,
      })
    )
  );
}

function gatewayHealthUrls(url: string): string[] {
  const urls: string[] = [];
  try {
    const parsed = new URL(url);
    const healthUrl = new URL("/health", parsed).toString();
    urls.push(healthUrl);
  } catch {
    // gatewayUrl validates URLs before this function is called.
  }
  if (!urls.includes(url)) {
    urls.push(url);
  }
  return urls;
}

function checkLegacyDirectMcp(cwd: string): GatewayDoctorCheck {
  const hits = [
    legacyFileHit(cwd, ".mcp.json"),
    legacyContentHit(cwd, ".opencode/opencode.json", LEGACY_OPENCODE_MCP_RE),
    legacyContentHit(cwd, ".pipeline/profiles.yaml", LEGACY_PIPELINE_MCP_RE),
  ].filter((hit): hit is string => Boolean(hit));
  return hits.length === 0
    ? { detail: "none found", name: "legacy-direct-mcp", passed: true }
    : {
        detail: hits.join(", "),
        name: "legacy-direct-mcp",
        passed: false,
      };
}

function legacyFileHit(cwd: string, path: string): string | undefined {
  return existsSync(join(cwd, path)) ? path : undefined;
}

function legacyContentHit(
  cwd: string,
  path: string,
  pattern: RegExp
): string | undefined {
  const fullPath = join(cwd, path);
  if (!existsSync(fullPath)) {
    return;
  }
  return pattern.test(readFileSync(fullPath, "utf8")) ? path : undefined;
}
