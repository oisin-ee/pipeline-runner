import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Effect } from "effect";
import type { PipelineConfig } from "../config";
import { McpGatewayService } from "../runtime/services/mcp-gateway-service";
import { configuredGateway } from "./gateway-config";
import { PipelineMcpGatewayError } from "./gateway-error";
import { runMcpGatewayEffect } from "./gateway-runtime";
import { resolveRepoLocalBackendSpecs } from "./repo-local-backends";
import { renderToolHiveVmcpInventory } from "./toolhive-vmcp";

export interface GatewayReconcileResult {
  backendCount: number;
  configPath: string;
  readinessFailures: string[];
  workspacePath: string;
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
