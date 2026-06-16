import { describe, expect, it } from "vitest";
import type { PipelineConfig } from "../../config";
import type { ScheduleArtifact } from "../../planning/generate";
import { expandBestOfNCandidates } from "./candidates";

const greenNode = {
  id: "green-implementation",
  kind: "agent",
  models: ["openai/gpt-5.5"],
  needs: ["red-tests"],
  profile: "moka-code-writer",
};

const redNode = {
  id: "red-tests",
  kind: "agent",
  needs: [],
  profile: "moka-test-writer",
};

function artifactWith(nodes: unknown[]): ScheduleArtifact {
  return {
    generated_at: "2026-06-16T00:00:00.000Z",
    kind: "pipeline-schedule",
    root_workflow: "wf",
    schedule_id: "sched-1",
    source_entrypoint: "quick",
    task: "do it",
    version: 1,
    workflows: { wf: { nodes } },
  } as unknown as ScheduleArtifact;
}

function configWith(bestOfN?: PipelineConfig["best_of_n"]): PipelineConfig {
  return { best_of_n: bestOfN } as unknown as PipelineConfig;
}

describe("expandBestOfNCandidates", () => {
  it("is identity when best_of_n is absent, disabled, or n <= 1", () => {
    const artifact = artifactWith([greenNode, redNode]);
    expect(expandBestOfNCandidates(configWith(), artifact)).toEqual(artifact);
    expect(
      expandBestOfNCandidates(
        configWith({ categories: ["green"], enabled: false, n: 3 }),
        artifact
      )
    ).toEqual(artifact);
    expect(
      expandBestOfNCandidates(
        configWith({ categories: ["green"], enabled: true, n: 1 }),
        artifact
      )
    ).toEqual(artifact);
  });

  it("expands a matching node into a parallel of N candidates feeding a select-candidate builtin", () => {
    const artifact = artifactWith([redNode, greenNode]);

    const out = expandBestOfNCandidates(
      configWith({ categories: ["green"], enabled: true, n: 2 }),
      artifact
    );
    const nodes = out.workflows.wf.nodes;

    expect(nodes[0]).toEqual(redNode);

    const parallel = nodes[1];
    if (parallel.kind !== "parallel") {
      throw new Error("expected a parallel candidates node");
    }
    expect(parallel.id).toBe("green-implementation--candidates");
    expect(parallel.needs).toEqual(["red-tests"]);
    expect(parallel.nodes.map((child) => child.id)).toEqual([
      "green-implementation--c1",
      "green-implementation--c2",
    ]);

    const selector = nodes[2];
    if (selector.kind !== "builtin") {
      throw new Error("expected a select-candidate builtin node");
    }
    expect(selector.id).toBe("green-implementation");
    expect(selector.builtin).toBe("select-candidate");
    expect(selector.needs).toEqual(["green-implementation--candidates"]);
  });
});
