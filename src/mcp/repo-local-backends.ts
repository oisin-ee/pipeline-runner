import { join } from "node:path";

import { Effect } from "effect";

import type { PipelineConfig } from "../config";
import { RepoIoService, runRepoIoSync } from "../runtime/services/repo-io-service";

type McpGatewayConfig = NonNullable<PipelineConfig["mcp_gateway"]>;
type McpGatewayBackend = McpGatewayConfig["backends"][string];

export interface RepoLocalBackendReadiness {
  ok: boolean;
  reason?: string;
}

export interface RepoLocalBackendMount {
  containerPath: string;
  hostPath: string;
}

export interface RepoLocalBackendSpec {
  args: string[];
  command: string;
  cwd: string;
  enabled: boolean;
  env: Record<string, string>;
  id: string;
  mount: RepoLocalBackendMount;
  readiness: RepoLocalBackendReadiness;
  required: boolean;
  toolPrefixes: string[];
  workspacePath: string;
}

export interface ResolveRepoLocalBackendSpecsOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  exists?: (path: string) => boolean;
}

interface BackendTemplate {
  args: (workspacePath: string) => string[];
  command: string;
  requiredPath: string;
}

const BACKEND_TEMPLATES: Record<string, BackendTemplate> = {
  backlog: {
    args: () => ["mcp"],
    command: "backlog",
    requiredPath: "backlog",
  },
  fallow: {
    args: () => [],
    command: "fallow-mcp",
    requiredPath: "package.json",
  },
  serena: {
    args: (workspacePath) => ["start-mcp-server", "--project", workspacePath],
    command: "serena",
    requiredPath: ".serena/project.yml",
  },
};

interface RepoLocalBackendSpecOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  exists?: (path: string) => boolean;
}

const backendPathExists = (
  path: string,
  exists: ((path: string) => boolean) | void,
): Effect.Effect<boolean, unknown, RepoIoService> => {
  if (exists !== undefined) {
    return Effect.sync(() => exists(path));
  }
  return Effect.gen(function* effectBody() {
    const service = yield* RepoIoService;
    return yield* service.exists(path);
  });
};

const workspacePathForBackend = (
  backend: McpGatewayBackend,
  options: Pick<RepoLocalBackendSpecOptions, "cwd" | "env">,
): string => {
  if (backend.workspace_path_source !== "PIPELINE_TARGET_PATH") {
    return options.cwd;
  }
  const pipelineTargetPath = options.env.PIPELINE_TARGET_PATH;
  return pipelineTargetPath !== undefined && pipelineTargetPath !== "" ? pipelineTargetPath : options.cwd;
};

const repoLocalBackendSpecEffect = (
  id: string,
  backend: McpGatewayBackend,
  options: RepoLocalBackendSpecOptions,
): Effect.Effect<RepoLocalBackendSpec, unknown, RepoIoService> =>
  Effect.gen(function* effectBody() {
    const workspacePath = workspacePathForBackend(backend, options);
    const template = BACKEND_TEMPLATES[id] ?? {
      args: () => [],
      command: id,
      requiredPath: ".",
    };
    const requiredPath = join(workspacePath, template.requiredPath);
    const ready = yield* backendPathExists(requiredPath, options.exists);
    const readiness = ready
      ? { ok: true }
      : {
          ok: false,
          reason: `Missing ${template.requiredPath} in ${workspacePath}`,
        };
    const enabled = ready || backend.required;

    return {
      args: template.args(workspacePath),
      command: template.command,
      cwd: workspacePath,
      enabled,
      env: {
        PIPELINE_TARGET_PATH: workspacePath,
      },
      id,
      mount: {
        containerPath: "/workspace",
        hostPath: workspacePath,
      },
      readiness,
      required: backend.required,
      toolPrefixes: backend.tool_prefixes,
      workspacePath,
    };
  });

const resolveRepoLocalBackendSpecsEffect = (
  config: PipelineConfig,
  options: ResolveRepoLocalBackendSpecsOptions,
): Effect.Effect<RepoLocalBackendSpec[], unknown, RepoIoService> =>
  Effect.gen(function* effectBody() {
    const gateway = config.mcp_gateway;
    if (!gateway) {
      return [];
    }
    return yield* Effect.all(
      Object.entries(gateway.backends)
        .filter(([, backend]) => backend.locality === "repo-local")
        .map(([id, backend]) =>
          repoLocalBackendSpecEffect(id, backend, {
            cwd: options.cwd,
            env: options.env ?? process.env,
            exists: options.exists,
          }),
        ),
    );
  });

export const resolveRepoLocalBackendSpecs = (
  config: PipelineConfig,
  options: ResolveRepoLocalBackendSpecsOptions,
): RepoLocalBackendSpec[] => runRepoIoSync(resolveRepoLocalBackendSpecsEffect(config, options));
