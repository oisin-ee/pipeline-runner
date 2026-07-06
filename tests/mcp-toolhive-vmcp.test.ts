import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { parsePipelineConfigParts } from "../src/config";
import type { PipelineConfigParts } from "../src/config";
import { resolveRepoLocalBackendSpecs } from "../src/mcp/repo-local-backends";
import { renderToolHiveVmcpInventory } from "../src/mcp/toolhive-vmcp";
import { parseWithSchema, struct } from "../src/schema-boundary";

const PARTS: PipelineConfigParts = {
  pipeline: `
version: 1
default_workflow: default
orchestrator:
  profile: orchestrator
workflows:
  default:
    nodes: []
`,
  profiles: `
version: 1
mcp_gateway:
  provider: toolhive
  mode: local
  default_profile: pipeline-tools
  backends:
    context7:
      locality: shared-remote
      tool_prefixes: [context7]
    uidotsh:
      locality: shared-remote
      tool_prefixes: [uidotsh]
    playwright:
      locality: shared-remote
      tool_prefixes: [playwright]
    qdrant:
      locality: repo-scoped-remote
      tool_prefixes: [qdrant]
    fallow:
      locality: repo-local
      workspace_path_source: PIPELINE_TARGET_PATH
      required: false
      tool_prefixes: [fallow]
    serena:
      locality: repo-local
      workspace_path_source: PIPELINE_TARGET_PATH
      tool_prefixes: [serena]
    backlog:
      locality: repo-local
      workspace_path_source: PIPELINE_TARGET_PATH
      tool_prefixes: [backlog]
profiles:
  orchestrator:
    runner: opencode
    instructions: { inline: "Run." }
    mcp_servers: [pipeline-gateway]
    tools: [read]
    filesystem: { mode: read-only }
    network: { mode: inherit }
`,
  runners: `
version: 1
runners:
  opencode:
    type: opencode
    capabilities:
      mcp_servers: true
      tools: [read]
      filesystem: [read-only]
      network: [inherit]
      output_formats: [text]
`,
};
const inventoryYamlSchema = struct({
  backends: Schema.mutable(
    Schema.Array(
      struct({
        name: Schema.String,
        transport: Schema.optional(Schema.String),
        url: Schema.optional(Schema.String),
      }),
    ),
  ),
});

const parseInventoryYaml = (source: string) => parseWithSchema(inventoryYamlSchema, parse(source));

describe("ToolHive vMCP inventory rendering", () => {
  it("renders deterministic backend config for every declared backend", () => {
    const config = parsePipelineConfigParts(PARTS);
    const repoLocalBackends = resolveRepoLocalBackendSpecs(config, {
      cwd: "/repo",
      env: { PIPELINE_TARGET_PATH: "/repo" },
      exists: () => true,
    });

    const inventory = renderToolHiveVmcpInventory(config, {
      repoLocalBackends,
    });
    const parsed = parseInventoryYaml(inventory.yaml);

    expect(parsed.backends.map((backend) => backend.name)).toEqual([
      "backlog",
      "context7",
      "fallow",
      "playwright",
      "qdrant",
      "serena",
      "uidotsh",
    ]);
    expect(inventory.backends).toContainEqual(
      expect.objectContaining({
        cwd: "/repo",
        mount: {
          containerPath: "/workspace",
          hostPath: "/repo",
        },
        name: "serena",
        type: "stdio",
      }),
    );
    expect(inventory.backends).toContainEqual(
      expect.objectContaining({
        locality: "shared-remote",
        name: "context7",
        type: "entry",
      }),
    );
  });

  it("uses discovered ToolHive workload URLs while keeping pipeline backend aliases", () => {
    const config = parsePipelineConfigParts(PARTS);
    const repoLocalBackends = resolveRepoLocalBackendSpecs(config, {
      cwd: "/repo",
      env: { PIPELINE_TARGET_PATH: "/repo" },
      exists: () => true,
    });
    const inventory = renderToolHiveVmcpInventory(config, {
      repoLocalBackends,
      toolHiveWorkloads: [
        {
          name: "oisin-pipeline-qdrant",
          transport: "streamable-http",
          url: "http://127.0.0.1:20222/mcp/",
        },
      ],
    });
    const parsed = parseInventoryYaml(inventory.yaml);

    expect(parsed.backends.find((backend) => backend.name === "qdrant")).toEqual({
      name: "qdrant",
      transport: "streamable-http",
      url: "http://127.0.0.1:20222/mcp/",
    });
    expect(inventory.backends.find((backend) => backend.name === "qdrant")).toMatchObject({
      name: "qdrant",
      workloadName: "oisin-pipeline-qdrant",
    });
  });

  it("keeps the complete aggregate backend list when one backend is added", () => {
    const config = parsePipelineConfigParts(PARTS);
    const inventory = renderToolHiveVmcpInventory(config, {
      repoLocalBackends: resolveRepoLocalBackendSpecs(config, {
        cwd: "/repo",
        env: { PIPELINE_TARGET_PATH: "/repo" },
        exists: () => true,
      }),
    });

    expect(inventory.backends.map((backend) => backend.name)).toEqual([
      "backlog",
      "context7",
      "fallow",
      "playwright",
      "qdrant",
      "serena",
      "uidotsh",
    ]);
  });
});
