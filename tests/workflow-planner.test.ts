import { describe, expect, it } from "vitest";
import type { PipelineConfig } from "../src/config.js";
import { parsePipelineConfigParts } from "../src/config.js";
import { defaultPipelineScaffoldFiles } from "../src/pipeline-init.js";
import {
  compileWorkflowPlan,
  WorkflowPlannerError,
} from "../src/workflow-planner.js";

const DEFAULT_FILES = defaultPipelineScaffoldFiles();
const DEFAULT_CONFIG = parsePipelineConfigParts({
  pipeline: DEFAULT_FILES[".pipeline/pipeline.yaml"] as string,
  profiles: DEFAULT_FILES[".pipeline/profiles.yaml"] as string,
  runners: DEFAULT_FILES[".pipeline/runners.yaml"] as string,
});

function capturePlannerError(action: () => unknown): WorkflowPlannerError {
  try {
    action();
  } catch (err) {
    if (err instanceof WorkflowPlannerError) {
      return err;
    }
    throw err;
  }
  throw new Error("Expected WorkflowPlannerError");
}

function cloneConfig(config: PipelineConfig = DEFAULT_CONFIG): PipelineConfig {
  return structuredClone(config);
}

describe("compileWorkflowPlan", () => {
  it("compiles the default scaffold workflow into stable topological order", () => {
    const plan = compileWorkflowPlan(DEFAULT_CONFIG);

    expect(plan.workflowId).toBe("default");
    expect(plan.topologicalOrder.map((node) => node.id)).toEqual([
      "research",
      "red",
      "green",
      "verify",
      "learn",
    ]);
    expect(
      plan.parallelBatches.map((batch) => batch.map((node) => node.id))
    ).toEqual([["research"], ["red"], ["green"], ["verify"], ["learn"]]);
    expect(plan.topologicalOrder[0]).toMatchObject({
      dependents: ["red"],
      kind: "agent",
      needs: [],
      profile: "pipeline-researcher",
    });
  });

  it("identifies independent nodes as parallelizable with deterministic ordering", () => {
    const config = cloneConfig();
    config.workflows.parallel = {
      nodes: [
        {
          id: "research",
          kind: "agent",
          profile: "pipeline-researcher",
        },
        {
          command: ["bun", "test"],
          id: "unit-tests",
          kind: "command",
          needs: ["research"],
        },
        {
          builtin: "typecheck",
          id: "typecheck",
          kind: "builtin",
          needs: ["research"],
        },
        {
          id: "quality",
          kind: "group",
          needs: ["unit-tests", "typecheck"],
          nodes: ["unit-tests", "typecheck"],
        },
        {
          id: "verify",
          kind: "agent",
          needs: ["quality"],
          profile: "pipeline-verifier",
        },
      ],
    };

    const plan = compileWorkflowPlan(config, "parallel");

    expect(plan.topologicalOrder.map((node) => node.id)).toEqual([
      "research",
      "unit-tests",
      "typecheck",
      "quality",
      "verify",
    ]);
    expect(
      plan.parallelBatches.map((batch) => batch.map((node) => node.id))
    ).toEqual([
      ["research"],
      ["unit-tests", "typecheck"],
      ["quality"],
      ["verify"],
    ]);
    expect(plan.topologicalOrder.map((node) => node.kind)).toEqual([
      "agent",
      "command",
      "builtin",
      "group",
      "agent",
    ]);
  });

  it("rejects missing workflows", () => {
    const error = capturePlannerError(() =>
      compileWorkflowPlan(DEFAULT_CONFIG, "missing")
    );

    expect(error.code).toBe("WORKFLOW_MISSING_WORKFLOW");
    expect(error.message).toContain("not declared");
    expect(error.issues.length).toBeGreaterThan(0);
  });

  it("rejects duplicate node ids", () => {
    const config = cloneConfig();
    config.workflows.default.nodes = [
      {
        id: "research",
        kind: "agent",
        profile: "pipeline-researcher",
      },
      {
        id: "research",
        kind: "agent",
        profile: "pipeline-test-writer",
      },
    ];

    const error = capturePlannerError(() => compileWorkflowPlan(config));

    expect(error.code).toBe("WORKFLOW_DUPLICATE_NODE");
    expect(error.message).toContain("duplicate node id 'research'");
    expect(error.issues.length).toBeGreaterThan(0);
  });

  it("rejects orphan dependencies", () => {
    const config = cloneConfig();
    config.workflows.default.nodes[0] = {
      id: "research",
      kind: "agent",
      needs: ["missing"],
      profile: "pipeline-researcher",
    };

    const error = capturePlannerError(() => compileWorkflowPlan(config));

    expect(error.code).toBe("WORKFLOW_MISSING_DEPENDENCY");
    expect(error.message).toContain("missing dependency 'missing'");
    expect(error.issues.length).toBeGreaterThan(0);
  });

  it("rejects dependency cycles", () => {
    const config = cloneConfig();
    config.workflows.default.nodes = [
      {
        id: "a",
        kind: "agent",
        needs: ["b"],
        profile: "pipeline-researcher",
      },
      {
        id: "b",
        kind: "agent",
        needs: ["a"],
        profile: "pipeline-test-writer",
      },
    ];

    const error = capturePlannerError(() => compileWorkflowPlan(config));

    expect(error.code).toBe("WORKFLOW_CYCLE");
    expect(error.message).toContain("dependency cycle");
    expect(error.issues.length).toBeGreaterThan(0);
  });

  it("rejects malformed group references", () => {
    const config = cloneConfig();
    config.workflows.default.nodes = [
      {
        id: "quality",
        kind: "group",
        nodes: ["missing-child"],
      },
    ];

    const error = capturePlannerError(() => compileWorkflowPlan(config));

    expect(error.code).toBe("WORKFLOW_GROUP_REFERENCE");
    expect(error.message).toContain("missing child node 'missing-child'");
    expect(error.issues.length).toBeGreaterThan(0);
  });
});
