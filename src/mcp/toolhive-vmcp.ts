import { stringify } from "yaml";
import type { PipelineConfig } from "../config.js";
import type { RepoLocalBackendSpec } from "./repo-local-backends.js";

type McpGatewayConfig = NonNullable<PipelineConfig["mcp_gateway"]>;
type McpGatewayBackend = McpGatewayConfig["backends"][string];

export type ToolHiveVmcpBackendType = "entry" | "stdio";

export interface ToolHiveVmcpBackend {
  args?: string[];
  command?: string;
  cwd?: string;
  enabled: boolean;
  env?: Record<string, string>;
  locality: McpGatewayBackend["locality"];
  mount?: RepoLocalBackendSpec["mount"];
  name: string;
  required: boolean;
  toolPrefixes: string[];
  type: ToolHiveVmcpBackendType;
}

export interface ToolHiveVmcpInventory {
  backends: ToolHiveVmcpBackend[];
  group: string;
  yaml: string;
}

export interface RenderToolHiveVmcpInventoryOptions {
  repoLocalBackends?: RepoLocalBackendSpec[];
}

export function renderToolHiveVmcpInventory(
  config: PipelineConfig,
  options: RenderToolHiveVmcpInventoryOptions = {}
): ToolHiveVmcpInventory {
  const gateway = config.mcp_gateway;
  if (!gateway) {
    return {
      backends: [],
      group: "default",
      yaml: stringify({ backends: [], group: "default", provider: "toolhive" }),
    };
  }
  const repoLocalBackends = new Map(
    (options.repoLocalBackends ?? []).map((backend) => [backend.id, backend])
  );
  const backends = Object.entries(gateway.backends)
    .map(([id, backend]) =>
      toolHiveBackend(id, backend, repoLocalBackends.get(id))
    )
    .sort((left, right) => left.name.localeCompare(right.name));
  const group = gateway.default_profile ?? "default";
  return {
    backends,
    group,
    yaml: stringify({
      aggregation: {
        conflictResolution: "prefix",
        conflictResolutionConfig: {
          prefixFormat: "{workload}_",
        },
      },
      backends: backends.map((backend) => ({ name: backend.name })),
      groupRef: group,
      incomingAuth: {
        type: "anonymous",
      },
      name: `${group}-vmcp`,
      outgoingAuth: {
        source: "inline",
      },
    }),
  };
}

function toolHiveBackend(
  id: string,
  backend: McpGatewayBackend,
  repoLocalBackend: RepoLocalBackendSpec | undefined
): ToolHiveVmcpBackend {
  if (backend.locality !== "repo-local") {
    return {
      enabled: true,
      locality: backend.locality,
      name: id,
      required: backend.required,
      toolPrefixes: backend.tool_prefixes,
      type: "entry",
    };
  }
  return {
    args: repoLocalBackend?.args ?? [],
    command: repoLocalBackend?.command ?? id,
    cwd: repoLocalBackend?.cwd,
    enabled: repoLocalBackend?.enabled ?? backend.required,
    env: repoLocalBackend?.env,
    locality: backend.locality,
    mount: repoLocalBackend?.mount,
    name: id,
    required: backend.required,
    toolPrefixes: backend.tool_prefixes,
    type: "stdio",
  };
}
