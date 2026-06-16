import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Data } from "effect";
import { execa } from "execa";
import type { PipelineConfig } from "../config";
import { resolveRepoLocalBackendSpecs } from "./repo-local-backends";
import { renderToolHiveVmcpInventory } from "./toolhive-vmcp";

const PIPELINE_GATEWAY_SERVER_ID = "pipeline-gateway";
const DEFAULT_LOCAL_GATEWAY_URL = "http://127.0.0.1:4483/mcp";
const LEGACY_OPENCODE_MCP_RE = /"mcp"\s*:\s*{(?!\s*"pipeline-gateway")/s;
const LEGACY_PIPELINE_MCP_RE = /path:\s*\.mcp\.json|uvx\s+mcpm|mcpm\s+run/;

type ActorConfig = PipelineConfig["profiles"][string];
type McpServerConfig = PipelineConfig["mcp_servers"][string];
type McpGatewayConfig = NonNullable<PipelineConfig["mcp_gateway"]>;
export type GatewayHostSelection = "all" | "opencode";
export type GatewayHostScope = "global" | "project";

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
  host: Exclude<GatewayHostSelection, "all">;
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

interface ToolHiveListWorkload {
  name?: unknown;
  status?: unknown;
  transport?: unknown;
  transport_type?: unknown;
  url?: unknown;
}

class PipelineMcpGatewayError extends Data.TaggedError(
  "PipelineMcpGatewayError"
)<{
  readonly message: string;
}> {
  constructor(message: string) {
    super({ message });
  }
}

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

export function renderClaudeGatewayMcpServers(
  config: PipelineConfig
): Record<string, unknown> {
  const gateway = configuredGateway(config);
  return {
    [PIPELINE_GATEWAY_SERVER_ID]: {
      headers: gatewayOpenCodeHeaders(gateway),
      type: "http",
      url: gatewayUrl(gateway),
    },
  };
}

export function configureGatewayHosts(
  config: PipelineConfig,
  options: GatewayConfigureHostOptions
): GatewayHostConfigResult[] {
  return selectedGatewayHosts(options.host).map((host) => {
    const path = gatewayHostConfigPath(options.scope, options.cwd);
    const content = renderOpenCodeGatewayConfig(config);
    const backupPath = backupIfExists(path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    return { backupPath, host, path };
  });
}

export async function runGatewayDoctor(
  config: PipelineConfig,
  cwd: string
): Promise<GatewayDoctorResult> {
  const gateway = configuredGateway(config);
  const checks: GatewayDoctorCheck[] = [
    {
      detail: `${gateway.provider}/${gateway.mode}`,
      name: "gateway-config",
      passed: true,
    },
    checkGatewayUrl(gateway),
    checkGatewayToken(gateway),
    ...(gateway.mode === "local" ? [await checkThv(cwd)] : []),
    await checkGatewayHealth(gateway),
    await checkGatewayRequiredTools(gateway),
    checkLegacyDirectMcp(cwd),
  ];
  return {
    checks,
    passed: checks.every((check) => check.passed),
  };
}

export async function startLocalGateway(
  config: PipelineConfig,
  cwd: string
): Promise<void> {
  const gateway = configuredGateway(config);
  if (gateway.mode !== "local") {
    throw new PipelineMcpGatewayError(
      "mcp gateway local-start is only valid when mcp_gateway.mode is local."
    );
  }
  const result = await reconcileGateway(config, cwd);
  if (result.readinessFailures.length > 0) {
    throw new PipelineMcpGatewayError(
      `Cannot start local MCP gateway; readiness failures: ${result.readinessFailures.join("; ")}`
    );
  }
  await execa(
    "thv",
    [
      "vmcp",
      "serve",
      "--config",
      result.configPath,
      "--host",
      "127.0.0.1",
      "--port",
      "4483",
    ],
    {
      cwd,
      env: await toolhiveEnv(cwd),
      stderr: "inherit",
      stdout: "inherit",
    }
  );
}

export async function reconcileGateway(
  config: PipelineConfig,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<GatewayReconcileResult> {
  const gateway = configuredGateway(config);
  if (gateway.provider !== "toolhive") {
    throw new PipelineMcpGatewayError(
      `Unsupported MCP gateway provider '${gateway.provider}'.`
    );
  }
  const workspacePath = env.PIPELINE_TARGET_PATH || cwd;
  const repoLocalBackends = resolveRepoLocalBackendSpecs(config, {
    cwd: workspacePath,
    env,
  });
  const toolHiveWorkloads = await listToolHiveGroupWorkloads(
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
  await execa("thv", ["vmcp", "validate", "--config", configPath], {
    cwd: workspacePath,
    env: await toolhiveEnv(workspacePath),
    stdin: "ignore",
  });
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
}

async function listToolHiveGroupWorkloads(
  group: string,
  cwd: string
): Promise<
  Array<{ name: string; status?: string; transport?: string; url?: string }>
> {
  const result = await execa(
    "thv",
    ["list", "--group", group, "--format", "json"],
    {
      cwd,
      env: await toolhiveEnv(cwd),
      stdin: "ignore",
    }
  );
  let parsed: unknown;
  const stdout = result.stdout.trim();
  if (!stdout) {
    return [];
  }
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new PipelineMcpGatewayError(
      "ToolHive list returned malformed JSON while reconciling MCP gateway workloads."
    );
  }
  if (!Array.isArray(parsed)) {
    throw new PipelineMcpGatewayError(
      "ToolHive list returned a non-array payload while reconciling MCP gateway workloads."
    );
  }
  return parsed.flatMap((item: ToolHiveListWorkload) => {
    if (!item || typeof item.name !== "string") {
      return [];
    }
    return [
      {
        name: item.name,
        status: typeof item.status === "string" ? item.status : undefined,
        transport: toolHiveWorkloadTransport(item),
        url: typeof item.url === "string" ? item.url : undefined,
      },
    ];
  });
}

function toolHiveWorkloadTransport(
  item: ToolHiveListWorkload
): string | undefined {
  if (typeof item.transport_type === "string") {
    return item.transport_type;
  }
  if (typeof item.transport === "string") {
    return item.transport;
  }
  return;
}

export async function localGatewayStatus(cwd: string): Promise<string> {
  const result = await execa("thv", ["list"], {
    cwd,
    env: await toolhiveEnv(cwd),
  });
  return result.stdout.trim();
}

async function checkGatewayRequiredTools(
  gateway: McpGatewayConfig
): Promise<GatewayDoctorCheck> {
  const requiredPrefixes = requiredGatewayToolPrefixes(gateway);
  if (requiredPrefixes.length === 0) {
    return {
      detail: "no required tools declared",
      name: "gateway-required-tools",
      passed: true,
    };
  }
  try {
    const tools = await listGatewayTools(gateway);
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
  } catch (err) {
    return {
      detail: err instanceof Error ? err.message : String(err),
      name: "gateway-required-tools",
      passed: false,
    };
  }
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

async function listGatewayTools(gateway: McpGatewayConfig): Promise<string[]> {
  const url = gatewayUrl(gateway);
  await callGatewayRpc(gateway, url, {
    id: 1,
    jsonrpc: "2.0",
    method: "initialize",
    params: {
      capabilities: {},
      clientInfo: { name: "@oisincoveney/pipeline", version: "1" },
      protocolVersion: "2025-06-18",
    },
  });
  const listed = await callGatewayRpc(gateway, url, {
    id: 2,
    jsonrpc: "2.0",
    method: "tools/list",
    params: {},
  });
  const tools = listed.result?.tools;
  if (!Array.isArray(tools)) {
    throw new PipelineMcpGatewayError("Malformed tools/list response.");
  }
  return tools.flatMap((tool) =>
    tool && typeof tool.name === "string" ? [tool.name] : []
  );
}

async function callGatewayRpc(
  gateway: McpGatewayConfig,
  url: string,
  body: Record<string, unknown>
): Promise<{ result?: { tools?: unknown } }> {
  const authorization = process.env[gateway.authorization_env];
  const response = await fetch(url, {
    body: JSON.stringify(body),
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(authorization ? { Authorization: authorization } : {}),
    },
    method: "POST",
  });
  if (!response.ok) {
    throw new PipelineMcpGatewayError(
      `Gateway MCP request failed: HTTP ${response.status}.`
    );
  }
  return (await response.json()) as { result?: { tools?: unknown } };
}

function selectedGatewayHosts(
  host: GatewayHostSelection
): Exclude<GatewayHostSelection, "all">[] {
  return host === "all" ? ["opencode"] : [host];
}

function gatewayHostConfigPath(scope: GatewayHostScope, cwd: string): string {
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

async function checkThv(cwd: string): Promise<GatewayDoctorCheck> {
  try {
    await execa("thv", ["version"], {
      cwd,
      env: await toolhiveEnv(cwd),
      stdin: "ignore",
    });
    return { detail: "available", name: "toolhive", passed: true };
  } catch (err) {
    const error = err as { shortMessage?: string; stderr?: string };
    return {
      detail: (error.shortMessage || error.stderr || "not available").trim(),
      name: "toolhive",
      passed: false,
    };
  }
}

async function toolhiveEnv(cwd: string): Promise<NodeJS.ProcessEnv> {
  if (process.env.DOCKER_HOST) {
    return process.env;
  }
  const dockerHost = await activeDockerHost(cwd);
  return dockerHost ? { ...process.env, DOCKER_HOST: dockerHost } : process.env;
}

async function activeDockerHost(cwd: string): Promise<string | undefined> {
  try {
    const result = await execa("docker", ["context", "inspect"], {
      cwd,
      stdin: "ignore",
    });
    const contexts = JSON.parse(result.stdout) as Array<{
      Endpoints?: { docker?: { Host?: unknown } };
    }>;
    const host = contexts[0]?.Endpoints?.docker?.Host;
    return typeof host === "string" && host.length > 0 ? host : undefined;
  } catch {
    return;
  }
}

async function checkGatewayHealth(
  gateway: McpGatewayConfig
): Promise<GatewayDoctorCheck> {
  let url: string;
  try {
    url = gatewayUrl(gateway);
  } catch (err) {
    return {
      detail: err instanceof Error ? err.message : String(err),
      name: "gateway-health",
      passed: false,
    };
  }
  try {
    const response = await firstHealthyGatewayResponse(url, gateway);
    const passed = Boolean(response);
    return {
      detail: response
        ? `HTTP ${response.status} ${response.url}`
        : "gateway endpoint did not report healthy",
      name: "gateway-health",
      passed,
    };
  } catch (err) {
    return {
      detail: err instanceof Error ? err.message : String(err),
      name: "gateway-health",
      passed: false,
    };
  }
}

async function firstHealthyGatewayResponse(
  url: string,
  gateway: McpGatewayConfig
): Promise<Response | undefined> {
  const authorization = process.env[gateway.authorization_env];
  for (const healthUrl of gatewayHealthUrls(url)) {
    const response = await fetch(healthUrl, {
      headers: {
        Accept: "application/json, text/event-stream",
        ...(authorization ? { Authorization: authorization } : {}),
      },
      method: "GET",
    });
    if (
      (response.status >= 200 && response.status < 300) ||
      response.status === 405
    ) {
      return response;
    }
  }
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
