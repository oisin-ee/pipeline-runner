import * as Option from "effect/Option";
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

interface RepoLocalBackendFields {
  args: string[];
  command: string;
  cwd?: string;
  enabled: boolean;
  env?: Record<string, string>;
  mount?: RepoLocalBackendSpec["mount"];
}

interface ToolHiveWorkloadFields {
  transport?: string;
  url?: string;
  workloadName?: string;
}

const repoLocalBackendFields = (
  id: string,
  backend: McpGatewayBackend,
  repoLocalBackend: Option.Option<RepoLocalBackendSpec>
): RepoLocalBackendFields =>
  Option.match(repoLocalBackend, {
    onNone: () => ({
      args: [],
      command: id,
      enabled: backend.required,
    }),
    onSome: (backendSpec) => ({
      args: backendSpec.args,
      command: backendSpec.command,
      cwd: backendSpec.cwd,
      enabled: backendSpec.enabled,
      env: backendSpec.env,
      mount: backendSpec.mount,
    }),
  });

const toolHiveWorkloadFields = (
  workload: Option.Option<ToolHiveWorkload>
): ToolHiveWorkloadFields =>
  Option.match(workload, {
    onNone: () => ({}),
    onSome: (value) => ({
      transport: value.transport,
      url: value.url,
      workloadName: value.name,
    }),
  });

const toolHiveBackend = (
  id: string,
  backend: McpGatewayBackend,
  repoLocalBackend: Option.Option<RepoLocalBackendSpec>,
  workload: Option.Option<ToolHiveWorkload>
): ToolHiveVmcpBackend => {
  if (backend.locality !== "repo-local") {
    return {
      enabled: true,
      locality: backend.locality,
      name: id,
      required: backend.required,
      toolPrefixes: backend.tool_prefixes,
      ...toolHiveWorkloadFields(workload),
      type: "entry",
    };
  }
  const backendFields = repoLocalBackendFields(id, backend, repoLocalBackend);
  return {
    ...backendFields,
    locality: backend.locality,
    name: id,
    required: backend.required,
    toolPrefixes: backend.tool_prefixes,
    ...toolHiveWorkloadFields(workload),
    type: "stdio",
  };
};

const matchingWorkload = (
  backendId: string,
  workloads: ToolHiveWorkload[]
): Option.Option<ToolHiveWorkload> => {
  const expectedPackageOwnedName = `oisin-pipeline-${backendId}`;
  return Option.fromUndefinedOr(
    workloads.find(
      (workload) =>
        workload.name === backendId ||
        workload.name === expectedPackageOwnedName
    )
  );
};

export const renderToolHiveVmcpInventory = (
  config: PipelineConfig,
  options: RenderToolHiveVmcpInventoryOptions = {}
): ToolHiveVmcpInventory => {
  const gateway = config.mcp_gateway;
  if (gateway === undefined) {
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
        Option.fromUndefinedOr(repoLocalBackends.get(id)),
        matchingWorkload(id, toolHiveWorkloads)
      )
    )
    .toSorted((left, right) => left.name.localeCompare(right.name));
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
        ...(backend.transport !== undefined && backend.transport !== ""
          ? { transport: backend.transport }
          : {}),
        ...(backend.url !== undefined && backend.url !== ""
          ? { url: backend.url }
          : {}),
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
};
