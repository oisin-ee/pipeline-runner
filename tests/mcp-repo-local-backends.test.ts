import { describe, expect, it } from "vitest";

import { parsePipelineConfigParts } from "../src/config";
import type { PipelineConfigParts } from "../src/config";
import { resolveRepoLocalBackendSpecs } from "../src/mcp/repo-local-backends";

const NO_REPO_COPY_COMMAND_RE = /clone|copy|mirror|git\s+clone/iu;

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
  backends:
    serena:
      locality: repo-local
      workspace_path_source: PIPELINE_TARGET_PATH
      tool_prefixes: [serena]
    backlog:
      locality: repo-local
      workspace_path_source: cwd
      tool_prefixes: [backlog]
    fallow:
      locality: repo-local
      workspace_path_source: PIPELINE_TARGET_PATH
      required: false
      tool_prefixes: [fallow]
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

describe("repo-local MCP backend specs", () => {
  it("reuses PIPELINE_TARGET_PATH or cwd exactly and generates no clone command", () => {
    const config = parsePipelineConfigParts(PARTS);
    const specs = resolveRepoLocalBackendSpecs(config, {
      cwd: "/workspace/cwd",
      env: { PIPELINE_TARGET_PATH: "/workspace/prepared" },
      exists: () => true,
    });

    expect(specs.map((spec) => [spec.id, spec.workspacePath])).toEqual([
      ["serena", "/workspace/prepared"],
      ["backlog", "/workspace/cwd"],
      ["fallow", "/workspace/prepared"],
    ]);
    expect(specs.flatMap((spec) => [spec.command, ...spec.args]).join(" ")).not.toMatch(NO_REPO_COPY_COMMAND_RE);
    expect(specs.find((spec) => spec.id === "fallow")).toMatchObject({
      args: [],
      command: "fallow-mcp",
    });
    expect(specs).toContainEqual(
      expect.objectContaining({
        cwd: "/workspace/prepared",
        env: expect.objectContaining({
          PIPELINE_TARGET_PATH: "/workspace/prepared",
        }),
        id: "serena",
        mount: {
          containerPath: "/workspace",
          hostPath: "/workspace/prepared",
        },
        toolPrefixes: ["serena"],
      }),
    );
  });

  it("reports readiness failures for missing required repo-local files", () => {
    const config = parsePipelineConfigParts(PARTS);
    const specs = resolveRepoLocalBackendSpecs(config, {
      cwd: "/repo",
      env: { PIPELINE_TARGET_PATH: "/repo" },
      exists: (path) => !path.endsWith(".serena/project.yml"),
    });

    expect(specs.find((spec) => spec.id === "serena")).toMatchObject({
      enabled: true,
      readiness: {
        ok: false,
        reason: "Missing .serena/project.yml in /repo",
      },
    });
    expect(specs.find((spec) => spec.id === "backlog")).toMatchObject({
      enabled: true,
      readiness: { ok: true },
    });
  });

  it("disables optional repo-local backends when their required files are missing", () => {
    const config = parsePipelineConfigParts(PARTS);
    const specs = resolveRepoLocalBackendSpecs(config, {
      cwd: "/repo",
      env: { PIPELINE_TARGET_PATH: "/repo" },
      exists: (path) => !path.endsWith("package.json"),
    });

    expect(specs.find((spec) => spec.id === "fallow")).toMatchObject({
      enabled: false,
      readiness: {
        ok: false,
        reason: "Missing package.json in /repo",
      },
    });
  });
});
