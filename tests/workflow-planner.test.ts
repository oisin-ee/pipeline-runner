import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { alg } from "@dagrejs/graphlib";
import { afterAll, describe, expect, it } from "vitest";
import type { PipelineConfig } from "../src/config";
import { loadPipelineConfig } from "../src/config";
import {
  compileWorkflowPlan,
  WorkflowPlannerError,
} from "../src/workflow-planner";

// Literal pipeline template tokens; interpolating the inner literal keeps the
// "${" sequence out of the source so noTemplateCurlyInString stays satisfied.
const DEFAULT_PROJECT = mkdtempSync(
  join(tmpdir(), "workflow-planner-default-")
);
const DEFAULT_CONFIG = loadPipelineConfig(DEFAULT_PROJECT, {
  allowMissingLintFileReferences: true,
});

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

function genericWorkflowConfig(): PipelineConfig {
  const config = cloneConfig();
  config.default_workflow = "scratch";
  config.workflows.scratch = {
    nodes: [commandNode("start")],
  };
  return config;
}

function commandNode(
  id: string,
  needs?: string[]
): PipelineConfig["workflows"][string]["nodes"][number] {
  return {
    command: ["echo", id],
    id,
    kind: "command",
    ...(needs ? { needs } : {}),
  };
}

function deterministicDagNodes(
  size: number,
  seed: number
): PipelineConfig["workflows"][string]["nodes"] {
  let state = seed;
  const random = () => {
    state = (state * 1_664_525 + 1_013_904_223) % 2 ** 32;
    return state / 2 ** 32;
  };
  return Array.from({ length: size }, (_, index) => {
    const needs: string[] = [];
    for (let candidate = 0; candidate < index; candidate++) {
      if (random() < 0.12) {
        needs.push(`node-${candidate}`);
      }
    }
    return commandNode(`node-${index}`, needs.length > 0 ? needs : undefined);
  });
}

function batchIds(plan: ReturnType<typeof compileWorkflowPlan>): string[][] {
  return plan.parallelBatches.map((batch) => batch.map((node) => node.id));
}

function dependentIds(
  plan: ReturnType<typeof compileWorkflowPlan>
): Record<string, string[]> {
  return Object.fromEntries(
    plan.topologicalOrder.map((node) => [node.id, node.dependents])
  );
}

function graphlibSuccessorIds(
  plan: ReturnType<typeof compileWorkflowPlan>
): Record<string, string[]> {
  return Object.fromEntries(
    plan.topologicalOrder.map((node) => [
      node.id,
      plan.graph.successors(node.id) ?? [],
    ])
  );
}

function graphlibReferenceBatchIds(
  plan: ReturnType<typeof compileWorkflowPlan>
): string[][] {
  const completed = new Set<string>();
  const remaining = [...plan.topologicalOrder];
  const batches: string[][] = [];

  while (remaining.length > 0) {
    const batch = remaining.filter((node) =>
      (plan.graph.predecessors(node.id) ?? []).every((need) =>
        completed.has(need)
      )
    );
    batch.sort((a, b) => a.index - b.index);
    batches.push(batch.map((node) => node.id));
    for (const node of batch) {
      completed.add(node.id);
      remaining.splice(remaining.indexOf(node), 1);
    }
  }

  return batches;
}

function graphlibReferenceTopologicalOrder(
  plan: ReturnType<typeof compileWorkflowPlan>
): string[] {
  return alg.topsort(plan.graph);
}

describe("compileWorkflowPlan", () => {
  it("compiles the package default inspect workflow into stable topological order", () => {
    const plan = compileWorkflowPlan(DEFAULT_CONFIG);

    expect(plan.workflowId).toBe("inspect");
    expect(plan.execution).toEqual({ failFast: false });
    expect(plan.topologicalOrder.map((node) => node.id)).toEqual(["inspect"]);
    expect(
      plan.parallelBatches.map((batch) => batch.map((node) => node.id))
    ).toEqual([["inspect"]]);
    expect(plan.topologicalOrder[0]).toMatchObject({
      dependents: [],
      kind: "agent",
      needs: [],
      profile: "moka-inspector",
    });
  });

  it("keeps legacy workflows out of package defaults while exposing scheduled entrypoints", () => {
    const config = loadPipelineConfig(process.cwd(), {
      allowMissingLintFileReferences: true,
    });

    expect(config.workflows.scratch).toBeUndefined();
    expect(config.workflows["epic-drain"]).toBeUndefined();
    expect(config.workflows.infra).toBeUndefined();
    expect(config.profiles["moka-epic-router"]).toBeUndefined();
    expect(config.entrypoints.execute).toMatchObject({
      schedule: "execute-schedule",
    });
    expect(config.entrypoints.quick).toMatchObject({
      schedule: "quick-schedule",
    });
  });

  it("preserves task_context on parallel children", () => {
    const config = genericWorkflowConfig();
    config.workflows.scratch.nodes = [
      {
        id: "fanout",
        kind: "parallel",
        nodes: [
          {
            id: "branch-a",
            kind: "agent",
            profile: "moka-researcher",
            task_context: {
              id: "PIPE-41.8",
              title: "Branch context",
              acceptance_criteria: [
                { id: "1", text: "Preserve child branch context." },
              ],
            },
          },
        ],
      } as PipelineConfig["workflows"][string]["nodes"][number],
    ];

    const plan = compileWorkflowPlan(config, "scratch");

    expect(plan.topologicalOrder[0].children?.[0]?.taskContext).toEqual({
      id: "PIPE-41.8",
      title: "Branch context",
      acceptanceCriteria: [{ id: "1", text: "Preserve child branch context." }],
    });
  });

  it("identifies independent nodes as parallelizable with deterministic ordering", () => {
    const config = genericWorkflowConfig();
    config.workflows.parallel = {
      nodes: [
        {
          id: "research",
          kind: "agent",
          profile: "moka-researcher",
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
          profile: "moka-verifier",
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
    const config = genericWorkflowConfig();
    config.workflows.grouped = {
      nodes: [
        {
          id: "left",
          kind: "agent",
          profile: "moka-researcher",
        },
        {
          id: "right",
          kind: "agent",
          profile: "moka-test-writer",
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

  it("deduplicates and sorts merged explicit and implicit group dependencies", () => {
    const config = genericWorkflowConfig();
    config.workflows.grouped = {
      nodes: [
        commandNode("zeta"),
        commandNode("alpha"),
        {
          id: "quality",
          kind: "group",
          needs: ["zeta", "alpha", "zeta"],
          nodes: ["alpha", "zeta", "alpha"],
        },
      ],
    };

    const plan = compileWorkflowPlan(config, "grouped");

    expect(
      plan.topologicalOrder.find((node) => node.id === "quality")?.needs
    ).toEqual(["alpha", "zeta"]);
  });

  it("matches graphlib-derived batches and dependents for representative DAG shapes", () => {
    const cases: Array<{
      name: string;
      nodes: PipelineConfig["workflows"][string]["nodes"];
    }> = [
      {
        name: "diamond fanout/fanin",
        nodes: [
          commandNode("root"),
          commandNode("left", ["root"]),
          commandNode("right", ["root"]),
          commandNode("join", ["left", "right"]),
          commandNode("tail", ["join"]),
        ],
      },
      {
        name: "staggered fanout with independent root",
        nodes: [
          commandNode("alpha"),
          commandNode("beta"),
          commandNode("alpha-left", ["alpha"]),
          commandNode("alpha-right", ["alpha"]),
          commandNode("mixed", ["beta", "alpha-left"]),
          commandNode("final", ["alpha-right", "mixed"]),
        ],
      },
      {
        name: "duplicate needs are collapsed like graph edges",
        nodes: [
          commandNode("seed"),
          commandNode("deduped", ["seed", "seed"]),
          commandNode("consumer", ["seed", "deduped", "deduped"]),
        ],
      },
    ];

    for (const testCase of cases) {
      const config = genericWorkflowConfig();
      config.workflows.scratch.nodes = testCase.nodes;

      const plan = compileWorkflowPlan(config, "scratch");

      expect(batchIds(plan), testCase.name).toEqual(
        graphlibReferenceBatchIds(plan)
      );
      expect(dependentIds(plan), testCase.name).toEqual(
        graphlibSuccessorIds(plan)
      );
    }
  });

  it("matches graphlib topological order for representative DAG shapes", () => {
    const cases: Array<{
      name: string;
      nodes: PipelineConfig["workflows"][string]["nodes"];
    }> = [
      {
        name: "diamond fanout/fanin",
        nodes: [
          commandNode("root"),
          commandNode("left", ["root"]),
          commandNode("right", ["root"]),
          commandNode("join", ["left", "right"]),
        ],
      },
      {
        name: "staggered fanout with independent root",
        nodes: [
          commandNode("alpha"),
          commandNode("beta"),
          commandNode("alpha-left", ["alpha"]),
          commandNode("alpha-right", ["alpha"]),
          commandNode("mixed", ["beta", "alpha-left"]),
          commandNode("final", ["alpha-right", "mixed"]),
        ],
      },
      {
        name: "shared dependencies",
        nodes: [
          commandNode("a"),
          commandNode("b"),
          commandNode("c", ["a", "b"]),
          commandNode("d", ["a"]),
        ],
      },
    ];

    for (const testCase of cases) {
      const config = genericWorkflowConfig();
      config.workflows.scratch.nodes = testCase.nodes;

      const plan = compileWorkflowPlan(config, "scratch");

      expect(
        plan.topologicalOrder.map((node) => node.id),
        testCase.name
      ).toEqual(graphlibReferenceTopologicalOrder(plan));
    }
  });

  it("matches graphlib planning metadata for deterministic generated DAGs", () => {
    for (const size of [1, 2, 5, 10, 25, 50]) {
      for (const seed of [1, 2, 3, 5, 8, 13, 21]) {
        const config = genericWorkflowConfig();
        config.workflows.scratch.nodes = deterministicDagNodes(size, seed);

        const plan = compileWorkflowPlan(config, "scratch");
        const caseName = `size=${size} seed=${seed}`;

        expect(
          plan.topologicalOrder.map((node) => node.id),
          caseName
        ).toEqual(graphlibReferenceTopologicalOrder(plan));
        expect(batchIds(plan), caseName).toEqual(
          graphlibReferenceBatchIds(plan)
        );
        expect(dependentIds(plan), caseName).toEqual(
          graphlibSuccessorIds(plan)
        );
      }
    }
  });

  it("compiles long generated dependency chains without recursive topsort overflow", () => {
    const config = genericWorkflowConfig();
    config.workflows.scratch.nodes = Array.from(
      { length: 10_000 },
      (_, index) =>
        commandNode(
          `node-${index}`,
          index === 0 ? undefined : [`node-${index - 1}`]
        )
    );

    const plan = compileWorkflowPlan(config, "scratch");

    expect(plan.topologicalOrder).toHaveLength(10_000);
    expect(plan.parallelBatches).toHaveLength(10_000);
    expect(plan.topologicalOrder.at(0)?.id).toBe("node-0");
    expect(plan.topologicalOrder.at(-1)?.id).toBe("node-9999");
  });

  it("normalizes workflow execution settings", () => {
    const config = genericWorkflowConfig();
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
          profile: "moka-researcher",
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
    const config = genericWorkflowConfig();
    config.workflows.scratch.nodes = [
      {
        id: "research",
        kind: "agent",
        profile: "moka-researcher",
      },
      {
        id: "research",
        kind: "agent",
        profile: "moka-test-writer",
      },
    ];

    const error = capturePlannerError(() =>
      compileWorkflowPlan(config, "scratch")
    );

    expect(error.code).toBe("WORKFLOW_DUPLICATE_NODE");
    expect(error.message).toContain("duplicate node id 'research'");
    expect(error.issues.length).toBeGreaterThan(0);
  });

  it("rejects orphan dependencies", () => {
    const config = genericWorkflowConfig();
    config.workflows.scratch.nodes[0] = {
      id: "research",
      kind: "agent",
      needs: ["missing"],
      profile: "moka-researcher",
    };

    const error = capturePlannerError(() =>
      compileWorkflowPlan(config, "scratch")
    );

    expect(error.code).toBe("WORKFLOW_MISSING_DEPENDENCY");
    expect(error.message).toContain("missing dependency 'missing'");
    expect(error.issues.length).toBeGreaterThan(0);
  });

  it("rejects dependency cycles", () => {
    const config = genericWorkflowConfig();
    config.workflows.scratch.nodes = [
      {
        id: "a",
        kind: "agent",
        needs: ["b"],
        profile: "moka-researcher",
      },
      {
        id: "b",
        kind: "agent",
        needs: ["a"],
        profile: "moka-test-writer",
      },
    ];

    const error = capturePlannerError(() =>
      compileWorkflowPlan(config, "scratch")
    );

    expect(error.code).toBe("WORKFLOW_CYCLE");
    expect(error.message).toContain("dependency cycle");
    expect(error.issues.length).toBeGreaterThan(0);
  });

  it("rejects malformed group references", () => {
    const config = genericWorkflowConfig();
    config.workflows.scratch.nodes = [
      {
        id: "quality",
        kind: "group",
        nodes: ["missing-child"],
      },
    ];

    const error = capturePlannerError(() =>
      compileWorkflowPlan(config, "scratch")
    );

    expect(error.code).toBe("WORKFLOW_GROUP_REFERENCE");
    expect(error.message).toContain("missing child node 'missing-child'");
    expect(error.issues.length).toBeGreaterThan(0);
  });
});
