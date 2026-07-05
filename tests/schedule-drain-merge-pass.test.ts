import { describe, expect, it } from "vitest";

import type { PipelineConfig } from "../src/config";
import { parsePipelineConfigParts } from "../src/config";
import type { ScheduleArtifact } from "../src/planning/generate";
import { integrateParallelWriteFanout } from "../src/schedule/passes/drain-merge";

const config = (): PipelineConfig =>
  parsePipelineConfigParts({
    pipeline: `
version: 1
default_workflow: root
orchestrator:
  profile: reviewer
workflows:
  root:
    nodes: []
`,
    profiles: `
version: 1
profiles:
  writer:
    runner: opencode
    scheduling_roles: [implementation]
    instructions: { inline: write }
    filesystem: { mode: workspace-write, allow: ["**/*"] }
  reviewer:
    runner: opencode
    scheduling_roles: [coverage]
    instructions: { inline: review }
    filesystem: { mode: read-only, allow: ["**/*"] }
`,
    runners: `
version: 1
runners:
  opencode:
    type: opencode
    command: opencode
    capabilities:
      native_subagents: true
      tools: [read, list, grep, glob, bash, edit, write]
      filesystem: [read-only, workspace-write]
      output_formats: [text]
`,
  });

const artifactWith = (nodes: unknown[]): ScheduleArtifact =>
  ({
    generated_at: "2026-06-17T00:00:00.000Z",
    kind: "pipeline-schedule",
    root_workflow: "root",
    schedule_id: "test-schedule",
    source_entrypoint: "execute",
    task: "test",
    version: 1,
    workflows: { root: { nodes } },
  }) as ScheduleArtifact;

const greenChild = (id: string) => ({
  id,
  kind: "agent" as const,
  profile: "writer",
});

describe("integrateParallelWriteFanout", () => {
  it("inserts a drain-merge after a multi-writer parallel and reroutes its dependents", () => {
    const artifact = artifactWith([
      {
        id: "green",
        kind: "parallel",
        nodes: [greenChild("green-a"), greenChild("green-b")],
      },
      { id: "verify", kind: "agent", needs: ["green"], profile: "reviewer" },
    ]);

    const result = integrateParallelWriteFanout(config(), artifact);
    const { nodes } = result.workflows.root;
    const merge = nodes.find((node) => node.kind === "builtin");

    expect(merge).toBeDefined();
    expect(merge?.kind === "builtin" && merge.builtin).toBe("drain-merge");
    expect(merge?.needs).toEqual(["green"]);
    // The downstream verify node now runs after integration, not the raw parallel.
    const verify = nodes.find((node) => node.id === "verify");
    expect(verify?.needs).toEqual([merge?.id]);
  });

  it("leaves a single-writer parallel untouched", () => {
    const artifact = artifactWith([
      {
        id: "green",
        kind: "parallel",
        nodes: [
          greenChild("green-a"),
          { id: "rev", kind: "agent", profile: "reviewer" },
        ],
      },
    ]);

    const result = integrateParallelWriteFanout(config(), artifact);
    expect(result.workflows.root.nodes.some((n) => n.kind === "builtin")).toBe(
      false
    );
  });

  it("does not add a second drain-merge when one is already downstream", () => {
    const artifact = artifactWith([
      {
        id: "green",
        kind: "parallel",
        nodes: [greenChild("green-a"), greenChild("green-b")],
      },
      {
        builtin: "drain-merge",
        id: "merge",
        kind: "builtin",
        needs: ["green"],
      },
    ]);

    const result = integrateParallelWriteFanout(config(), artifact);
    const merges = result.workflows.root.nodes.filter(
      (node) => node.kind === "builtin" && node.builtin === "drain-merge"
    );
    expect(merges).toHaveLength(1);
  });
});
