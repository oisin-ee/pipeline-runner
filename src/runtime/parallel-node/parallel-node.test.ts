import { describe, expect, it, vi } from "vitest";

import type { PipelineConfig } from "../../config";
import type { PlannedWorkflowNode } from "../../planning/compile";
import type { RuntimeContext, RuntimeNodeResult } from "../contracts";
import { NodeStateStore } from "../node-state-store";
import { executeParallelNode } from "./parallel-node";

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
          close: async () => {},
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

const passedNodeResult = (nodeId: string): RuntimeNodeResult => ({
  attempts: 1,
  evidence: [],
  exitCode: 0,
  nodeId,
  output: "ok",
  status: "passed",
});

const plannedNode = (
  id: string,
  kind: PlannedWorkflowNode["kind"]
): PlannedWorkflowNode => ({
  dependents: [],
  id,
  index: 0,
  kind,
  needs: [],
});

const parallelNode = (): PlannedWorkflowNode => {
  const child = plannedNode("green-candidate-1", "agent");
  return { ...plannedNode("green", "parallel"), children: [child] };
};

const parallelWith = (childIds: string[]): PlannedWorkflowNode => ({
  ...plannedNode("green", "parallel"),
  children: childIds.map((id) => plannedNode(id, "agent")),
});

const opencodeConfig = (): PipelineConfig =>
  ({
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
  }) as unknown as PipelineConfig;

const plainConfig = (byCategory: Record<string, number> = {}): PipelineConfig =>
  ({
    ...opencodeConfig(),
    parallel_worktrees: { enabled: false },
    token_budget: {
      default_context_window: 200_000,
      fan_out_width: { by_category: byCategory, default: 4 },
      max_context_pct: 50,
      model_context_windows: {},
    },
  }) as unknown as PipelineConfig;

const runtimeContext = (
  executor: RuntimeContext["executor"]
): Parameters<typeof executeParallelNode>[1] => ({
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
});

const runtimeContextWith = (
  executor: RuntimeContext["executor"],
  config: PipelineConfig
): Parameters<typeof executeParallelNode>[1] => ({
  ...runtimeContext(executor),
  config,
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
        executeNode: async (_child, context) => {
          childExecutor = context.executor;
          return passedNodeResult(_child.id);
        },
        markNodeReady: () => {},
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

  it("reports successful child completion in the aggregate evidence", async () => {
    const result = await executeParallelNode(
      parallelWith(["green-a", "green-b"]),
      runtimeContextWith(vi.fn(), plainConfig()),
      {
        executeNode: async (child) => passedNodeResult(child.id),
        markNodeReady: () => {},
      }
    );

    expect(result.exitCode).toBe(0);
    expect(result.evidence).toEqual([
      "parallel node 'green' completed 2 child nodes",
    ]);
  });

  it("surfaces failed children in the aggregate evidence", async () => {
    const result = await executeParallelNode(
      parallelWith(["green-a", "green-b"]),
      runtimeContextWith(vi.fn(), plainConfig()),
      {
        executeNode: async (child) =>
          child.id === "green-b"
            ? {
                attempts: 1,
                evidence: ["green-b failed"],
                exitCode: 1,
                nodeId: child.id,
                output: "",
                status: "failed",
              }
            : passedNodeResult(child.id),
        markNodeReady: () => {},
      }
    );

    expect(result.exitCode).toBe(1);
    expect(result.evidence).toContain(
      "parallel node 'green' failed with 1 failed child nodes"
    );
    expect(result.evidence).toContain("green-b failed");
  });

  it("serializes child outputs in declaration order", async () => {
    const result = await executeParallelNode(
      parallelWith(["left", "right"]),
      runtimeContextWith(vi.fn(), plainConfig()),
      {
        executeNode: async (child) => ({
          ...passedNodeResult(child.id),
          output: child.id === "left" ? "L" : "R",
        }),
        markNodeReady: () => {},
      }
    );

    expect(JSON.parse(result.output)).toEqual({
      children: { left: "L", right: "R" },
    });
  });

  it("throttles children that share a fan-out category", async () => {
    let active = 0;
    let maxActive = 0;
    const result = await executeParallelNode(
      parallelWith(["green-1", "green-2"]),
      runtimeContextWith(vi.fn(), plainConfig({ green: 1 })),
      {
        executeNode: async (child) => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolve) => setTimeout(resolve, 0));
          active -= 1;
          return passedNodeResult(child.id);
        },
        markNodeReady: () => {},
      }
    );

    expect(result.exitCode).toBe(0);
    expect(maxActive).toBe(1);
  });

  it("does not throttle children outside the capped category", async () => {
    let active = 0;
    let maxActive = 0;
    await executeParallelNode(
      parallelWith(["intake-1", "intake-2"]),
      runtimeContextWith(vi.fn(), plainConfig({ green: 1 })),
      {
        executeNode: async (child) => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolve) => setTimeout(resolve, 0));
          active -= 1;
          return passedNodeResult(child.id);
        },
        markNodeReady: () => {},
      }
    );

    expect(maxActive).toBe(2);
  });
});
