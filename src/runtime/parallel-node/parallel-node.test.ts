import { describe, expect, it, vi } from "vitest";
import type { PipelineConfig } from "../../config";
import type { PlannedWorkflowNode } from "../../planning/compile";
import type { RuntimeContext, RuntimeNodeResult } from "../contracts";
import { NodeStateStore } from "../node-state-store";
import {
  childCategory,
  executeParallelNode,
  parallelEvidence,
  parallelOutput,
} from "./parallel-node";

const worktreeRecords = vi.hoisted(() => ({ creates: 0, releases: 0 }));
const opencodeRecords = vi.hoisted(() => ({
  executor: undefined as unknown,
  leases: 0,
  releases: 0,
}));

vi.mock("../parallel-worktrees/parallel-worktrees", () => ({
  createChildWorktree: () => {
    worktreeRecords.creates += 1;
    return {
      path: "/repo/.git/pipeline-worktrees/child",
      release: () => {
        worktreeRecords.releases += 1;
      },
    };
  },
  gcParallelWorktrees: () => [],
}));

vi.mock("../opencode-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../opencode-runtime")>();
  return {
    ...actual,
    leaseOpencodeRuntime: async (
      input: Parameters<typeof actual.leaseOpencodeRuntime>[0]
    ) => {
      opencodeRecords.leases += 1;
      const lease = await actual.leaseOpencodeRuntime({
        ...input,
        openServer: async () => ({
          client: {} as never,
          close: async () => undefined,
          owned: true,
          url: "http://127.0.0.1:0",
        }),
      });
      opencodeRecords.executor = lease.executor;
      return {
        executor: lease.executor,
        release: async () => {
          opencodeRecords.releases += 1;
          await lease.release();
        },
      };
    },
  };
});

describe("childCategory", () => {
  const fanOut = { by_category: { green: 2, verification: 1 }, default: 4 };

  it("returns the matching category whose name the child id includes", () => {
    expect(childCategory("green-implementation--c1", fanOut)).toBe("green");
    expect(childCategory("verification", fanOut)).toBe("verification");
  });

  it("returns undefined when no category matches or fan-out is absent", () => {
    expect(childCategory("intake", fanOut)).toBeUndefined();
    expect(childCategory("green-x", undefined)).toBeUndefined();
  });
});

describe("runtime parallel node", () => {
  it("uses a per-worktree opencode executor for isolated opencode children", async () => {
    worktreeRecords.creates = 0;
    worktreeRecords.releases = 0;
    opencodeRecords.executor = undefined;
    opencodeRecords.leases = 0;
    opencodeRecords.releases = 0;

    const parentExecutor = vi.fn();
    let childExecutor: unknown;
    const result = await executeParallelNode(
      parallelNode(),
      runtimeContext(parentExecutor),
      {
        executeNode: (_child, context) => {
          childExecutor = context.executor;
          return Promise.resolve(passedNodeResult(_child.id));
        },
        markNodeReady: () => undefined,
      }
    );

    expect(result.exitCode).toBe(0);
    expect(worktreeRecords.creates).toBe(1);
    expect(worktreeRecords.releases).toBe(1);
    expect(opencodeRecords.leases).toBe(1);
    expect(opencodeRecords.releases).toBe(1);
    expect(childExecutor).toBe(opencodeRecords.executor);
    expect(childExecutor).not.toBe(parentExecutor);
  });

  it("reports successful child completion", () => {
    const results: RuntimeNodeResult[] = [
      {
        attempts: 1,
        evidence: ["left passed"],
        exitCode: 0,
        nodeId: "left",
        output: "L",
        status: "passed",
      },
    ];

    expect(parallelEvidence("fanout", results, [])).toEqual([
      "parallel node 'fanout' completed 1 child nodes",
    ]);
  });

  it("serializes child outputs in declaration order", () => {
    const output = parallelOutput(
      [
        {
          children: [],
          dependents: [],
          id: "left",
          index: 0,
          kind: "command",
          command: ["left"],
          needs: [],
        },
        {
          children: [],
          dependents: [],
          id: "right",
          index: 1,
          kind: "command",
          command: ["right"],
          needs: [],
        },
      ],
      [
        {
          attempts: 1,
          evidence: [],
          exitCode: 0,
          nodeId: "right",
          output: "R",
          status: "passed",
        },
        {
          attempts: 1,
          evidence: [],
          exitCode: 0,
          nodeId: "left",
          output: "L",
          status: "passed",
        },
      ]
    );

    expect(JSON.parse(output)).toEqual({
      children: { left: "L", right: "R" },
    });
  });
});

function passedNodeResult(nodeId: string): RuntimeNodeResult {
  return {
    attempts: 1,
    evidence: [],
    exitCode: 0,
    nodeId,
    output: "ok",
    status: "passed",
  };
}

function parallelNode(): PlannedWorkflowNode {
  const child = plannedNode("green-candidate-1", "agent");
  return { ...plannedNode("green", "parallel"), children: [child] };
}

function plannedNode(
  id: string,
  kind: PlannedWorkflowNode["kind"]
): PlannedWorkflowNode {
  return {
    dependents: [],
    id,
    index: 0,
    kind,
    needs: [],
  };
}

function runtimeContext(
  executor: RuntimeContext["executor"]
): Parameters<typeof executeParallelNode>[1] {
  return {
    agentInvocations: [],
    config: opencodeConfig(),
    executor,
    gates: [],
    hookFailures: [],
    hookPolicy: {
      allowCommandHooks: false,
      allowUntrustedCommandHooks: false,
      env: {},
      envPassthrough: [],
      outputLimitBytes: 0,
      timeoutMs: 0,
    },
    hookResults: new Map(),
    nodeStateStore: new NodeStateStore(),
    plan: {
      execution: { failFast: false },
      graph: {} as never,
      parallelBatches: [],
      topologicalOrder: [],
      workflowId: "workflow",
    },
    task: "task",
    workflowId: "workflow",
    worktreePath: "/repo",
  };
}

function opencodeConfig(): PipelineConfig {
  return {
    default_workflow: "workflow",
    hooks: { functions: {}, on: {} },
    parallel_worktrees: { enabled: true },
    runner_command: {
      environment: { setup: [], smoke: [] },
      git: { committer: { email: "bot@example.com", name: "Bot" } },
    },
    runners: {
      opencode: { capabilities: {}, type: "opencode" },
    },
    scheduler: { commands: {}, node_catalogs: {} },
    token_budget: {
      default_context_window: 200_000,
      fan_out_width: { by_category: {}, default: 4 },
      max_context_pct: 50,
      model_context_windows: {},
    },
    workflows: {},
  } as unknown as PipelineConfig;
}
