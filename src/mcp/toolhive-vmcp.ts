import { stringify } from "yaml";
import type { PipelineConfig } from "../config";
import type { RepoLocalBackendSpec } from "./repo-local-backends";

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
  transport?: string;
  type: ToolHiveVmcpBackendType;
  url?: string;
  workloadName?: string;
}

export interface ToolHiveVmcpInventory {
  backends: ToolHiveVmcpBackend[];
  group: string;
  yaml: string;
}

export interface RenderToolHiveVmcpInventoryOptions {
  repoLocalBackends?: RepoLocalBackendSpec[];
  toolHiveWorkloads?: ToolHiveWorkload[];
}

export interface ToolHiveWorkload {
  name: string;
  status?: string;
  transport?: string;
  url?: string;
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
  const toolHiveWorkloads = options.toolHiveWorkloads ?? [];
  const backends = Object.entries(gateway.backends)
    .map(([id, backend]) =>
      toolHiveBackend(
        id,
        backend,
        repoLocalBackends.get(id),
        matchingWorkload(id, toolHiveWorkloads)
      )
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
      backends: backends.map((backend) => ({
        name: backend.name,
        ...(backend.transport ? { transport: backend.transport } : {}),
        ...(backend.url ? { url: backend.url } : {}),
      })),
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
  repoLocalBackend: RepoLocalBackendSpec | undefined,
  workload: ToolHiveWorkload | undefined
): ToolHiveVmcpBackend {
  if (backend.locality !== "repo-local") {
    return {
      enabled: true,
      locality: backend.locality,
      name: id,
      required: backend.required,
      transport: workload?.transport,
      toolPrefixes: backend.tool_prefixes,
      type: "entry",
      url: workload?.url,
      workloadName: workload?.name,
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
    transport: workload?.transport,
    toolPrefixes: backend.tool_prefixes,
    type: "stdio",
    url: workload?.url,
    workloadName: workload?.name,
  };
}

function matchingWorkload(
  backendId: string,
  workloads: ToolHiveWorkload[]
): ToolHiveWorkload | undefined {
  const expectedPackageOwnedName = `oisin-pipeline-${backendId}`;
  return workloads.find(
    (workload) =>
      workload.name === backendId || workload.name === expectedPackageOwnedName
  );
}
