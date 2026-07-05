import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { Effect, Option } from "effect";

import type { PipelineConfig } from "../config";
import { McpGatewayService } from "../runtime/services/mcp-gateway-service";
import { configuredGateway, gatewayUrl } from "./gateway-config";
import type { McpGatewayConfig } from "./gateway-config";
import { PipelineMcpGatewayError } from "./gateway-error";
import { runMcpGatewayEffect } from "./gateway-runtime";

const LEGACY_OPENCODE_MCP_RE = /"mcp"\s*:\s*\{(?!\s*"pipeline-gateway")/su;
const LEGACY_PIPELINE_MCP_RE = /path:\s*\.mcp\.json|uvx\s+mcpm|mcpm\s+run/u;

export interface GatewayDoctorCheck {
  detail: string;
  name: string;
  passed: boolean;
}

export interface GatewayDoctorResult {
  checks: GatewayDoctorCheck[];
  passed: boolean;
}

const checkGatewayUrl = (gateway: McpGatewayConfig): GatewayDoctorCheck => {
  try {
    const url = gatewayUrl(gateway);
    return { detail: url, name: "gateway-url", passed: true };
  } catch (error) {
    return {
      detail: error instanceof Error ? error.message : String(error),
      name: "gateway-url",
      passed: false,
    };
  }
};

const checkGatewayToken = (gateway: McpGatewayConfig): GatewayDoctorCheck =>
  process.env[gateway.authorization_env] !== undefined &&
  process.env[gateway.authorization_env] !== ""
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

const checkThv = (
  cwd: string
): Effect.Effect<GatewayDoctorCheck, never, McpGatewayService> =>
  Effect.gen(function* effectBody() {
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

const gatewayHealthUrls = (url: string): string[] => {
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
};

const checkGatewayHealth = (
  gateway: McpGatewayConfig
): Effect.Effect<GatewayDoctorCheck, never, McpGatewayService> => {
  let url: string;
  try {
    url = gatewayUrl(gateway);
  } catch (error) {
    return Effect.succeed({
      detail: error instanceof Error ? error.message : String(error),
      name: "gateway-health",
      passed: false,
    });
  }
  return Effect.gen(function* effectBody() {
    const service = yield* McpGatewayService;
    const response = yield* service.firstHealthyGatewayResponse(
      gatewayHealthUrls(url),
      process.env[gateway.authorization_env]
    );
    const passed = Option.isSome(response);
    return {
      detail: Option.isSome(response)
        ? `HTTP ${response.value.status} ${response.value.url}`
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
};

const requiredGatewayToolPrefixes = (gateway: McpGatewayConfig): string[] =>
  [
    ...new Set(
      Object.values(gateway.backends)
        .filter((backend) => backend.required)
        .flatMap((backend) => backend.tool_prefixes)
    ),
  ].toSorted();

const callGatewayRpc = (
  gateway: McpGatewayConfig,
  url: string,
  body: Record<string, unknown>
): Effect.Effect<
  { result?: { tools?: unknown } },
  PipelineMcpGatewayError,
  McpGatewayService
> =>
  Effect.gen(function* effectBody() {
    const service = yield* McpGatewayService;
    return yield* service.callGatewayRpc(
      url,
      body,
      process.env[gateway.authorization_env]
    );
  });

const listGatewayTools = (
  gateway: McpGatewayConfig
): Effect.Effect<string[], PipelineMcpGatewayError, McpGatewayService> => {
  const url = gatewayUrl(gateway);
  return Effect.gen(function* effectBody() {
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
      typeof tool === "object" &&
      tool !== null &&
      "name" in tool &&
      typeof tool.name === "string"
        ? [tool.name]
        : []
    );
  });
};

const checkGatewayRequiredTools = (
  gateway: McpGatewayConfig
): Effect.Effect<GatewayDoctorCheck, never, McpGatewayService> => {
  const requiredPrefixes = requiredGatewayToolPrefixes(gateway);
  if (requiredPrefixes.length === 0) {
    return Effect.succeed({
      detail: "no required tools declared",
      name: "gateway-required-tools",
      passed: true,
    });
  }
  return Effect.gen(function* effectBody() {
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
};

const legacyFileHit = (cwd: string, path: string): string | void =>
  existsSync(join(cwd, path)) ? path : undefined;

const legacyContentHit = (
  cwd: string,
  path: string,
  pattern: RegExp
): string | void => {
  const fullPath = join(cwd, path);
  if (!existsSync(fullPath)) {
    return;
  }
  return pattern.test(readFileSync(fullPath, "utf-8")) ? path : undefined;
};

const checkLegacyDirectMcp = (cwd: string): GatewayDoctorCheck => {
  const hits = [
    legacyFileHit(cwd, ".mcp.json"),
    legacyContentHit(cwd, ".opencode/opencode.json", LEGACY_OPENCODE_MCP_RE),
    legacyContentHit(cwd, ".pipeline/profiles.yaml", LEGACY_PIPELINE_MCP_RE),
  ].filter((hit): hit is string => hit !== undefined && hit !== "");
  return hits.length === 0
    ? { detail: "none found", name: "legacy-direct-mcp", passed: true }
    : {
        detail: hits.join(", "),
        name: "legacy-direct-mcp",
        passed: false,
      };
};

export const runGatewayDoctor = async (
  config: PipelineConfig,
  cwd: string
): Promise<GatewayDoctorResult> =>
  await runMcpGatewayEffect(
    Effect.gen(function* effectBody() {
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
