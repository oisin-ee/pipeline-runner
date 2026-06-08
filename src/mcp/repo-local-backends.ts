import { existsSync } from "node:fs";
import { join } from "node:path";
import type { PipelineConfig } from "../config";

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
  env?: Record<string, string | undefined>;
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

export function resolveRepoLocalBackendSpecs(
  config: PipelineConfig,
  options: ResolveRepoLocalBackendSpecsOptions
): RepoLocalBackendSpec[] {
  const gateway = config.mcp_gateway;
  if (!gateway) {
    return [];
  }
  const exists = options.exists ?? existsSync;
  return Object.entries(gateway.backends)
    .filter(([, backend]) => backend.locality === "repo-local")
    .map(([id, backend]) =>
      repoLocalBackendSpec(id, backend, {
        cwd: options.cwd,
        env: options.env ?? process.env,
        exists,
      })
    );
}

function repoLocalBackendSpec(
  id: string,
  backend: McpGatewayBackend,
  options: Required<ResolveRepoLocalBackendSpecsOptions>
): RepoLocalBackendSpec {
  const workspacePath = workspacePathForBackend(backend, options);
  const template = BACKEND_TEMPLATES[id] ?? {
    args: () => [],
    command: id,
    requiredPath: ".",
  };
  const requiredPath = join(workspacePath, template.requiredPath);
  const ready = options.exists(requiredPath);
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
}

function workspacePathForBackend(
  backend: McpGatewayBackend,
  options: Pick<Required<ResolveRepoLocalBackendSpecsOptions>, "cwd" | "env">
): string {
  return backend.workspace_path_source === "PIPELINE_TARGET_PATH"
    ? options.env.PIPELINE_TARGET_PATH || options.cwd
    : options.cwd;
}
