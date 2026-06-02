import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { PipelineConfig } from "../src/config.js";
import { loadPipelineConfig } from "../src/config.js";
import { defaultPipelineScaffoldFiles } from "../src/pipeline-init.js";
import {
  compileWorkflowPlan,
  WorkflowPlannerError,
} from "../src/workflow-planner.js";

// Literal pipeline template tokens; interpolating the inner literal keeps the
// "${" sequence out of the source so noTemplateCurlyInString stays satisfied.
const WORKTREE_TEMPLATE = `.pipeline/worktrees/$${"{runId}"}/$${"{nodeId}"}`;

const DEFAULT_FILES = defaultPipelineScaffoldFiles();
const DEFAULT_PROJECT = mkdtempSync(
  join(tmpdir(), "workflow-planner-default-")
);
for (const [path, content] of Object.entries(DEFAULT_FILES)) {
  const target = join(DEFAULT_PROJECT, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}
for (const skill of [
  "critique",
  "diagnose",
  "doubt",
  "fix",
  "improve",
  "library-first-development",
  "migrate",
  "optimize",
  "research",
  "scope",
  "secure",
  "spec",
  "test",
  "trace",
  "verify",
]) {
  const target = join(DEFAULT_PROJECT, ".agents", "skills", skill, "SKILL.md");
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `---\nname: ${skill}\n---\n\n# ${skill}\n`);
}
const DEFAULT_CONFIG = loadPipelineConfig(DEFAULT_PROJECT);

afterAll(() => {
  rmSync(DEFAULT_PROJECT, { force: true, recursive: true });
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
    expect(plan.execution).toEqual({ failFast: false });
    expect(plan.topologicalOrder.map((node) => node.id)).toEqual([
      "research",
      "red",
      "green",
      "acceptance",
      "verify",
      "learn",
    ]);
    expect(
      plan.parallelBatches.map((batch) => batch.map((node) => node.id))
    ).toEqual([
      ["research"],
      ["red"],
      ["green"],
      ["acceptance"],
      ["verify"],
      ["learn"],
    ]);
    expect(plan.topologicalOrder[0]).toMatchObject({
      dependents: ["red"],
      kind: "agent",
      needs: [],
      profile: "pipeline-researcher",
    });
  });

  it("compiles the epic-drain entrypoint workflow with the implementation fanout", () => {
    const config = loadPipelineConfig(process.cwd(), {
      allowMissingLintFileReferences: true,
    });

    const plan = compileWorkflowPlan(config, "epic-drain");

    expect(plan.topologicalOrder.map((node) => node.id)).toEqual([
      "research",
      "plan",
      "implement",
      "merge",
      "review",
    ]);
    expect(
      plan.parallelBatches.map((batch) => batch.map((node) => node.id))
    ).toEqual([["research"], ["plan"], ["implement"], ["merge"], ["review"]]);
    expect(plan.topologicalOrder[0]).toMatchObject({
      id: "research",
      kind: "agent",
      profile: "pipeline-researcher",
    });
    expect(plan.topologicalOrder[1]).toMatchObject({
      id: "plan",
      kind: "agent",
      needs: ["research"],
      profile: "pipeline-epic-router",
    });

    const implement = plan.topologicalOrder[2];
    expect(implement).toMatchObject({
      id: "implement",
      kind: "parallel",
      needs: ["plan"],
    });
    expect(implement.children?.map((child) => child.id)).toEqual([
      "test",
      "frontend",
      "backend",
      "k8s",
    ]);
    const expectedChildWorkflows = {
      test: "default",
      frontend: "default",
      backend: "default",
      k8s: "infra",
    };
    for (const [track, childWorkflow] of Object.entries(
      expectedChildWorkflows
    )) {
      expect(
        implement.children?.find((child) => child.id === track)
      ).toMatchObject({
        id: track,
        kind: "workflow",
        workflow: childWorkflow,
        worktreeRoot: `.pipeline/runs/\${runId}/${track}`,
      });
    }

    expect(plan.topologicalOrder[3]).toMatchObject({
      id: "merge",
      builtin: "drain-merge",
      kind: "builtin",
      needs: ["implement"],
    });
    expect(plan.topologicalOrder[4]).toMatchObject({
      id: "review",
      kind: "agent",
      needs: ["merge"],
      profile: "pipeline-thermo-nuclear-reviewer",
    });
    expect(plan.topologicalOrder[4].gates).toEqual([
      { id: "review-verdict", kind: "verdict", target: "stdout" },
    ]);
  });

  it("carries workflow-node worktree_root as planned worktreeRoot", () => {
    const config = cloneConfig();
    config.workflows.default.nodes = [
      {
        id: "child",
        kind: "workflow",
        workflow: "subflow",
      } as PipelineConfig["workflows"][string]["nodes"][number] & {
        worktree_root: string;
      },
    ];
    (
      config.workflows.default
        .nodes[0] as PipelineConfig["workflows"][string]["nodes"][number] & {
        worktree_root: string;
      }
    ).worktree_root = WORKTREE_TEMPLATE;
    config.workflows.subflow = {
      nodes: [
        {
          id: "research",
          kind: "agent",
          profile: "pipeline-researcher",
        },
      ],
    };

    const plan = compileWorkflowPlan(config);

    expect(plan.topologicalOrder[0]).toMatchObject({
      id: "child",
      kind: "workflow",
      worktreeRoot: WORKTREE_TEMPLATE,
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

  it("treats group child nodes as implicit dependencies", () => {
    const config = cloneConfig();
    config.workflows.grouped = {
      nodes: [
        {
          id: "left",
          kind: "agent",
          profile: "pipeline-researcher",
        },
        {
          id: "right",
          kind: "agent",
          profile: "pipeline-test-writer",
        },
        {
          id: "quality",
          kind: "group",
          nodes: ["left", "right"],
        },
      ],
    };

    const plan = compileWorkflowPlan(config, "grouped");

    expect(plan.topologicalOrder.map((node) => node.id)).toEqual([
      "left",
      "right",
      "quality",
    ]);
    expect(
      plan.topologicalOrder.find((node) => node.id === "quality")
    ).toMatchObject({
      needs: ["left", "right"],
    });
    expect(
      plan.parallelBatches.map((batch) => batch.map((node) => node.id))
    ).toEqual([["left", "right"], ["quality"]]);
  });

  it("normalizes workflow execution settings", () => {
    const config = cloneConfig();
    config.workflows.limited = {
      execution: {
        fail_fast: true,
        max_parallel_nodes: 2,
        timeout_ms: 10_000,
      },
      nodes: [
        {
          id: "research",
          kind: "agent",
          profile: "pipeline-researcher",
          retries: {
            backoff_ms: 500,
            max_attempts: 3,
            multiplier: 2,
            retry_on: ["timeout", "exit_nonzero"],
          },
          timeout_ms: 5000,
        },
      ],
    };

    const plan = compileWorkflowPlan(config, "limited");

    expect(plan.execution).toEqual({
      failFast: true,
      maxParallelNodes: 2,
      timeoutMs: 10_000,
    });
    expect(plan.topologicalOrder[0]).toMatchObject({
      retries: {
        backoff_ms: 500,
        max_attempts: 3,
        multiplier: 2,
        retry_on: ["timeout", "exit_nonzero"],
      },
      timeoutMs: 5000,
    });
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
