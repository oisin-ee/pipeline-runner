import { describe, expect, it } from "@effect/vitest";
import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import * as Effect from "effect/Effect";
import { vi } from "vitest";

import type { PipelineConfig } from "../../config";
import type { PlannedWorkflowNode } from "../../planning/compile";
import { createDependencyGraph } from "../../planning/graph";
import type { RuntimeContext, RuntimeNodeResult } from "../contracts";
import { NodeStateStore } from "../node-state-store";
import type { leaseOpencodeRuntime } from "../opencode-runtime";
import type { OpencodeServerHandle } from "../opencode-server";
import { executeParallelNode } from "./parallel-node";

interface OpencodeRuntimeModule {
  readonly leaseOpencodeRuntime: typeof leaseOpencodeRuntime;
}

const worktreeRecords = vi.hoisted(() => ({ creates: 0, releases: 0 }));
const opencodeRecords = vi.hoisted(
  (): {
    executor: unknown;
    leases: number;
    releases: number;
  } => ({
    executor: undefined,
    leases: 0,
    releases: 0,
  })
);

const testOpencodeServer = async (): Promise<OpencodeServerHandle> =>
  await Promise.resolve({
    client: createOpencodeClient({ baseUrl: "http://127.0.0.1:0" }),
    close: async () => {
      await Promise.resolve();
    },
    owned: true,
    url: "http://127.0.0.1:0",
  });

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
  const actual = await importOriginal<OpencodeRuntimeModule>();
  return {
    ...actual,
    leaseOpencodeRuntime: async (
      input: Parameters<typeof actual.leaseOpencodeRuntime>[0]
    ) => {
      opencodeRecords.leases += 1;
      const lease = await actual.leaseOpencodeRuntime({
        ...input,
        openServer: async () => await testOpencodeServer(),
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

const promiseResult = async (
  result: RuntimeNodeResult
): Promise<RuntimeNodeResult> => await Promise.resolve(result);

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

const emptyWorkflowGraph = () =>
  createDependencyGraph<PlannedWorkflowNode, PlannedWorkflowNode>([], {
    dependenciesOf: (node) => node.needs,
    valueOf: (node) => node,
  });

const opencodeConfig = (): PipelineConfig => ({
  default_workflow: "workflow",
  entrypoints: {},
  hooks: { functions: {}, on: {} },
  mcp_servers: {},
  parallel_worktrees: { enabled: true },
  profiles: {},
  rules: {},
  runner_command: {
    environment: { setup: [], smoke: [] },
    git: { committer: { email: "bot@example.com", name: "Bot" } },
  },
  runners: {
    opencode: { capabilities: {}, type: "opencode" },
  },
  scheduler: { commands: {}, node_catalogs: {} },
  schedules: {},
  skills: {},
  token_budget: {
    default_context_window: 200_000,
    fan_out_width: { by_category: {}, default: 4 },
    max_context_pct: 50,
    model_context_windows: {},
  },
  version: 1,
  workflows: {},
});

const plainConfig = (
  byCategory: Record<string, number> = {}
): PipelineConfig => ({
  ...opencodeConfig(),
  parallel_worktrees: { enabled: false },
  token_budget: {
    default_context_window: 200_000,
    fan_out_width: { by_category: byCategory, default: 4 },
    max_context_pct: 50,
    model_context_windows: {},
  },
});

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
    graph: emptyWorkflowGraph(),
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
  it.effect(
    "uses a per-worktree opencode executor for isolated opencode children",
    () =>
      Effect.gen(function* effectBody() {
        worktreeRecords.creates = 0;
        worktreeRecords.releases = 0;
        opencodeRecords.executor = undefined;
        opencodeRecords.leases = 0;
        opencodeRecords.releases = 0;

        const parentExecutor = vi.fn();
        let childExecutor: unknown;
        const result = yield* Effect.tryPromise({
          catch: (error) => error,
          try: async () =>
            await executeParallelNode(
              parallelNode(),
              runtimeContext(parentExecutor),
              {
                executeNode: async (child, context) => {
                  childExecutor = context.executor;
                  return await promiseResult(passedNodeResult(child.id));
                },
                markNodeReady: () => {},
              }
            ),
        });

        expect(result.exitCode).toBe(0);
        expect(worktreeRecords.creates).toBe(1);
        expect(worktreeRecords.releases).toBe(1);
        expect(opencodeRecords.leases).toBe(1);
        expect(opencodeRecords.releases).toBe(1);
        expect(childExecutor).toBe(opencodeRecords.executor);
        expect(childExecutor).not.toBe(parentExecutor);
      })
  );

  it.effect(
    "reports successful child completion in the aggregate evidence",
    () =>
      Effect.gen(function* effectBody() {
        const result = yield* Effect.tryPromise({
          catch: (error) => error,
          try: async () =>
            await executeParallelNode(
              parallelWith(["green-a", "green-b"]),
              runtimeContextWith(vi.fn(), plainConfig()),
              {
                executeNode: async (child) =>
                  await promiseResult(passedNodeResult(child.id)),
                markNodeReady: () => {},
              }
            ),
        });

        expect(result.exitCode).toBe(0);
        expect(result.evidence).toEqual([
          "parallel node 'green' completed 2 child nodes",
        ]);
      })
  );

  it.effect("surfaces failed children in the aggregate evidence", () =>
    Effect.gen(function* effectBody() {
      const result = yield* Effect.tryPromise({
        catch: (error) => error,
        try: async () =>
          await executeParallelNode(
            parallelWith(["green-a", "green-b"]),
            runtimeContextWith(vi.fn(), plainConfig()),
            {
              executeNode: async (child) => {
                if (child.id === "green-b") {
                  return await promiseResult({
                    attempts: 1,
                    evidence: ["green-b failed"],
                    exitCode: 1,
                    nodeId: child.id,
                    output: "",
                    status: "failed",
                  });
                }
                return await promiseResult(passedNodeResult(child.id));
              },
              markNodeReady: () => {},
            }
          ),
      });

      expect(result.exitCode).toBe(1);
      expect(result.evidence).toContain(
        "parallel node 'green' failed with 1 failed child nodes"
      );
      expect(result.evidence).toContain("green-b failed");
    })
  );

  it.effect("serializes child outputs in declaration order", () =>
    Effect.gen(function* effectBody() {
      const result = yield* Effect.tryPromise({
        catch: (error) => error,
        try: async () =>
          await executeParallelNode(
            parallelWith(["left", "right"]),
            runtimeContextWith(vi.fn(), plainConfig()),
            {
              executeNode: async (child) =>
                await promiseResult({
                  ...passedNodeResult(child.id),
                  output: child.id === "left" ? "L" : "R",
                }),
              markNodeReady: () => {},
            }
          ),
      });

      expect(JSON.parse(result.output)).toEqual({
        children: { left: "L", right: "R" },
      });
    })
  );

  it.effect("throttles children that share a fan-out category", () =>
    Effect.gen(function* effectBody() {
      let active = 0;
      let maxActive = 0;
      const result = yield* Effect.tryPromise({
        catch: (error) => error,
        try: async () =>
          await executeParallelNode(
            parallelWith(["green-1", "green-2"]),
            runtimeContextWith(vi.fn(), plainConfig({ green: 1 })),
            {
              executeNode: async (child) => {
                active += 1;
                maxActive = Math.max(maxActive, active);
                await Promise.resolve();
                active -= 1;
                return passedNodeResult(child.id);
              },
              markNodeReady: () => {},
            }
          ),
      });

      expect(result.exitCode).toBe(0);
      expect(maxActive).toBe(1);
    })
  );

  it.effect("does not throttle children outside the capped category", () =>
    Effect.gen(function* effectBody() {
      let active = 0;
      let maxActive = 0;
      yield* Effect.tryPromise({
        catch: (error) => error,
        try: async () =>
          await executeParallelNode(
            parallelWith(["intake-1", "intake-2"]),
            runtimeContextWith(vi.fn(), plainConfig({ green: 1 })),
            {
              executeNode: async (child) => {
                active += 1;
                maxActive = Math.max(maxActive, active);
                await Promise.resolve();
                active -= 1;
                return passedNodeResult(child.id);
              },
              markNodeReady: () => {},
            }
          ),
      });

      expect(maxActive).toBe(2);
    })
  );
});
