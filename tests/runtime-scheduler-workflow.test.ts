import { readFileSync } from "node:fs";
import { join } from "node:path";
import { execa } from "execa";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { buildRunnerArgoWorkflowManifest } from "../src/argo-workflow";
import { parsePipelineConfigParts } from "../src/config";
import type {
  PipelineRuntimeResult,
  RuntimeFailure,
  RuntimeNodeResult,
} from "../src/pipeline-runtime";
import {
  compileWorkflowPlan,
  type WorkflowExecutionPlan,
} from "../src/planning/compile";
import { runRunnerFinalize } from "../src/runner-command/finalize";
import { runRunnerLifecycle } from "../src/runner-command/lifecycle";
import type { RuntimeContext } from "../src/runtime/contracts";
import {
  LocalScheduler,
  type PipelineScheduler,
  readyNodeIds,
  runWorkflowScheduler,
  unstartedBlockingDescendants,
  type WorkflowScheduleNode,
  type WorkflowSchedulerInput,
  workflowNodeCapacity,
} from "../src/runtime/scheduler";
import {
  runWorkflowLifecycle,
  type WorkflowHookEvent,
} from "../src/runtime/workflow-lifecycle";
import {
  captureEventBatches,
  cleanupRunnerCommandFixtures,
  commandHookResult,
  finalResults,
  hookResultEvents,
  writeLifecycleConfig,
  writeRunnerCommandFixture,
} from "./runner-command-fixture";

vi.mock("execa", () => ({
  execa: vi.fn(),
}));

vi.mock("../src/run-state/git-refs", () => ({
  prepareRunnerGitWorkspace: vi.fn(
    async (_payload, options?: { cwd?: string }) => options?.cwd ?? "/workspace"
  ),
  promoteFinalRef: vi.fn(async () => "final-sha"),
}));

const mockExeca = execa as unknown as ReturnType<typeof vi.fn>;

afterEach(() => {
  vi.clearAllMocks();
  cleanupRunnerCommandFixtures();
});

describe("plain workflow scheduler", () => {
  it("exposes the local scheduler behind the PipelineScheduler seam", () => {
    const scheduler: PipelineScheduler = new LocalScheduler();

    expectTypeOf<Parameters<PipelineScheduler["runWorkflow"]>>().toEqualTypeOf<
      [WorkflowExecutionPlan, RuntimeContext]
    >();
    expectTypeOf<ReturnType<PipelineScheduler["runWorkflow"]>>().toEqualTypeOf<
      Promise<PipelineRuntimeResult>
    >();
    expect(scheduler).toBeInstanceOf(LocalScheduler);
  });

  it("forces serial execution with failFast when multiple root nodes are ready", async () => {
    let active = 0;
    let maxActive = 0;

    const result = await runWorkflowScheduler(
      schedulerInput({
        failFast: true,
        nodes: [
          scheduleNode("a", 0),
          scheduleNode("b", 1),
          scheduleNode("c", 2),
        ],
        runNode: async (nodeId: string) => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolve) => setTimeout(resolve, 5));
          active -= 1;
          return nodeResult(nodeId, "passed");
        },
      })
    );

    expect(maxActive).toBe(1);
    expect(
      result.completed.map((node: RuntimeNodeResult) => node.nodeId)
    ).toEqual(["a", "b", "c"]);
  });

  it("skips every unstarted node with the exact fail-fast skip reason", async () => {
    const skipped: Array<{ nodeId: string; reason: string }> = [];

    const result = await runWorkflowScheduler(
      schedulerInput({
        failFast: true,
        nodes: [
          scheduleNode("a", 0),
          scheduleNode("b", 1),
          scheduleNode("c", 2, ["a"]),
        ],
        runNode: async (nodeId: string) => nodeResult(nodeId, "failed"),
        skipNode: (nodeId: string, reason: string) =>
          skipped.push({ nodeId, reason }),
      })
    );

    expect(result.outcome).toBe("FAIL");
    expect(result.completed).toEqual([nodeResult("a", "failed")]);
    expect(skipped).toEqual(failFastSkipped(["b", "c"], "a"));
  });

  it("schedules ready nodes up to maxParallelNodes", async () => {
    const readyNodes: string[] = [];
    let active = 0;
    let maxActive = 0;

    const result = await runWorkflowScheduler(
      schedulerInput({
        markNodeReady: (nodeId: string) => readyNodes.push(nodeId),
        maxParallelNodes: 2,
        nodes: [
          scheduleNode("a", 0),
          scheduleNode("b", 1),
          scheduleNode("c", 2),
        ],
        runNode: async (nodeId: string) => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolve) => setTimeout(resolve, 5));
          active -= 1;
          return nodeResult(nodeId, "passed");
        },
      })
    );

    expect(readyNodes).toEqual(["a", "b", "c"]);
    expect(maxActive).toBe(2);
    expect(
      result.completed.map((node: RuntimeNodeResult) => node.nodeId)
    ).toEqual(["a", "b", "c"]);
  });

  it("keeps blocked descendants pending when failFast is disabled", async () => {
    const skipped: Array<{ nodeId: string; reason: string }> = [];
    const started: string[] = [];

    const result = await runWorkflowScheduler(
      schedulerInput({
        failFast: false,
        maxParallelNodes: 1,
        nodes: [
          scheduleNode("root", 0),
          scheduleNode("failed-branch", 1, ["root"]),
          scheduleNode("blocked-child", 2, ["failed-branch"]),
          scheduleNode("independent", 3, ["root"]),
        ],
        runNode: async (nodeId: string) => {
          await Promise.resolve();
          started.push(nodeId);
          return nodeResult(
            nodeId,
            nodeId === "failed-branch" ? "failed" : "passed"
          );
        },
        skipNode: (nodeId: string, reason: string) =>
          skipped.push({ nodeId, reason }),
      })
    );

    expect(started).toEqual(["root", "failed-branch", "independent"]);
    expect(skipped).toEqual([]);
    expect(result.outcome).toBe("FAIL");
    expect(
      result.completed.map((node: RuntimeNodeResult) => node.nodeId)
    ).toEqual(["root", "failed-branch", "independent"]);
  });

  it("exports pure helpers for ready nodes, capacity, and unstarted blocking descendants", () => {
    const nodes = [
      scheduleNode("a", 0),
      scheduleNode("b", 1, ["a"]),
      scheduleNode("c", 2, ["b"]),
      scheduleNode("d", 3),
    ];
    const passedA = nodeResult("a", "passed");

    expect(
      readyNodeIds({
        blocked: ["c"],
        completed: [passedA],
        nodes,
        running: [],
        shouldContinueAfterNodeResult: (result: RuntimeNodeResult) =>
          result.status === "passed",
      })
    ).toEqual(["b", "d"]);

    expect(
      workflowNodeCapacity({
        failFast: false,
        maxParallelNodes: 3,
        nodes,
        running: ["b"],
      })
    ).toBe(2);
    expect(
      workflowNodeCapacity({
        failFast: true,
        maxParallelNodes: 3,
        nodes,
        running: ["b"],
      })
    ).toBe(0);

    expect(
      unstartedBlockingDescendants("b", {
        completed: [passedA],
        nodes,
        running: [],
      })
    ).toEqual(["c"]);
  });

  it("keeps Argo and Kubernetes clients out of the local scheduler seam", () => {
    const schedulerSource = readFileSync(
      join(import.meta.dirname, "../src/runtime/scheduler.ts"),
      "utf8"
    );
    const pipelineRuntimeSource = readFileSync(
      join(import.meta.dirname, "../src/pipeline-runtime.ts"),
      "utf8"
    );

    expect(schedulerSource).not.toContain("@kubernetes/client-node");
    expect(pipelineRuntimeSource).not.toContain("@kubernetes/client-node");
  });
});

describe("workflow lifecycle", () => {
  it("runs workflow hooks in failure order: start, failure, complete", async () => {
    const hookEvents: string[] = [];

    const result = await runWorkflowLifecycle(
      lifecycleInput({
        executeWorkflow: async () => ({
          completed: [nodeResult("a", "failed")],
          failure: nodeFailure("a"),
          outcome: "FAIL",
        }),
        runWorkflowHook: (event) => {
          hookEvents.push(event);
          return null;
        },
      })
    );

    expect(hookEvents).toEqual([
      "workflow.start",
      "workflow.failure",
      "workflow.complete",
    ]);
    expect(result.status).toBe("failed");
    expect(result.result.outcome).toBe("FAIL");
  });

  it("lets success hook failure win over an otherwise passing workflow", async () => {
    const hookEvents: string[] = [];

    const result = await runWorkflowLifecycle(
      lifecycleInput({
        executeWorkflow: async () => ({
          completed: [nodeResult("a", "passed")],
          outcome: "PASS",
        }),
        runWorkflowHook: (event) => {
          hookEvents.push(event);
          if (event === "workflow.success") {
            return {
              evidence: ["success hook returned failure"],
              gate: "workflow.success",
              nodeId: "start",
              reason: "success hook failed",
            };
          }
          return null;
        },
      })
    );

    expect(hookEvents).toEqual([
      "workflow.start",
      "workflow.success",
      "workflow.complete",
    ]);
    expect(result.status).toBe("failed");
    expect(result.successHookFailure?.reason).toBe("success hook failed");
    expect(result.result.outcome).toBe("FAIL");
    expect(result.result.failureDetails).toEqual([
      expect.objectContaining({ reason: "success hook failed" }),
    ]);
  });

  it("runs start, success, complete and finalizes a successful result", async () => {
    const hookEvents: string[] = [];

    const result = await runWorkflowLifecycle(
      lifecycleInput({
        executeWorkflow: async () => ({
          completed: [nodeResult("a", "passed")],
          outcome: "PASS",
        }),
        runWorkflowHook: (event) => {
          hookEvents.push(event);
          return null;
        },
      })
    );

    expect(hookEvents).toEqual([
      "workflow.start",
      "workflow.success",
      "workflow.complete",
    ]);
    expect(result.status).toBe("passed");
    expect(result.result.outcome).toBe("PASS");
    expect(result.result.nodes).toEqual([nodeResult("a", "passed")]);
  });
});

describe("LocalScheduler and Argo workflow parity", () => {
  it("keeps dependency order, fail-fast skips, lifecycle completion, and retry ownership aligned", async () => {
    const { config, plan } = parityFixture();
    const localReadyOrder: string[] = [];
    const localSkipped: Array<{ nodeId: string; reason: string }> = [];
    const localHookEvents: Array<{
      event: WorkflowHookEvent;
      failure?: RuntimeFailure;
    }> = [];
    const localScheduler = new LocalScheduler({
      buildResult: (outcome, nodes, failure) =>
        runtimeResult(plan, outcome, nodes, failure),
      emitWorkflowPlanned: () => undefined,
      emitWorkflowStarted: () => undefined,
      executeNode: async (nodeId) =>
        nodeId === "flaky"
          ? nodeResult(nodeId, "failed", { attempts: 2, exitCode: 1 })
          : nodeResult(nodeId, "passed"),
      isCancelled: () => false,
      markNodeReady: (nodeId) => localReadyOrder.push(nodeId),
      runWorkflowHook: (event, failure) => {
        localHookEvents.push({ event, failure });
        return null;
      },
      shouldContinueAfterNodeResult: (result) => result.status === "passed",
      skipNode: (nodeId, reason) => localSkipped.push({ nodeId, reason }),
    });

    const localResult = await localScheduler.runWorkflow(
      plan,
      parityRuntimeContext(plan, config)
    );
    const argoManifest = buildRunnerArgoWorkflowManifest({
      generateName: "pipeline-parity-",
      namespace: "workflow-namespace",
      payloadConfigMapName: "pipeline-payload-parity",
      plan,
      scheduleConfigMapName: "pipeline-schedule-parity",
      taskDescriptorConfigMapName: "pipeline-task-descriptors-parity",
    });
    const argoProjection = projectArgoDagCompletion(argoManifest, {
      "node-flaky": "failed",
      "node-setup": "passed",
      "workflow-start": "passed",
    });
    const argoAdapters = await runArgoLifecycleAdapters("Failed");

    expect(plan.execution).toMatchObject({
      failFast: true,
      maxParallelNodes: 1,
    });
    expect(plan.topologicalOrder.map((node) => node.id)).toEqual([
      "setup",
      "flaky",
      "descendant",
    ]);
    expect(plan.topologicalOrder.find((node) => node.id === "flaky")).toEqual(
      expect.objectContaining({ retries: { max_attempts: 2 } })
    );
    expect(config.hooks.on["workflow.start"]).toHaveLength(1);
    expect(config.hooks.on["workflow.failure"]).toHaveLength(1);
    expect(config.hooks.on["workflow.complete"]).toHaveLength(1);

    expect(localReadyOrder).toEqual(["setup", "flaky"]);
    expect(argoProjection.executionOrder).toEqual(localReadyOrder);
    expect(localSkipped).toEqual(failFastSkipped(["descendant"], "flaky"));
    expect(argoProjection.skipped).toEqual(localSkipped);
    expect(localResult.outcome).toBe("FAIL");
    expect(argoProjection.outcome).toBe(localResult.outcome);
    expect(localResult.nodes).toEqual([
      nodeResult("setup", "passed"),
      nodeResult("flaky", "failed", { attempts: 2, exitCode: 1 }),
    ]);

    expect(localHookEvents.map(({ event }) => event)).toEqual([
      "workflow.start",
      "workflow.failure",
      "workflow.complete",
    ]);
    expect(localHookEvents).toEqual([
      { event: "workflow.start", failure: undefined },
      {
        event: "workflow.failure",
        failure: expect.objectContaining({ nodeId: "flaky" }),
      },
      {
        event: "workflow.complete",
        failure: expect.objectContaining({ nodeId: "flaky" }),
      },
    ]);
    expect(argoProjection.lifecycleEvents).toEqual([
      { event: "workflow.start", status: "Running" },
      { event: "workflow.failure", status: "Failed" },
      { event: "workflow.complete", status: "Failed" },
    ]);
    expect(argoAdapters.exitCodes).toEqual({ finalize: 1, start: 0 });
    expect(argoAdapters.hookEvents).toEqual([
      "workflow.start",
      "workflow.failure",
      "workflow.complete",
    ]);
    expect(argoAdapters.finalResults).toEqual([
      { outcome: "FAIL", workflowId: "schedule-run-1-root" },
    ]);
    expect(
      argoManifest.spec.templates.find(
        (template) => template.name === "workflow-start"
      )?.container?.args
    ).toEqual([
      "runner-lifecycle",
      "--phase",
      "workflow.start",
      "--payload-file",
      "/etc/pipeline/payload.json",
      "--schedule-file",
      "/etc/pipeline/schedule.yaml",
    ]);
    expect(
      argoManifest.spec.templates.find(
        (template) => template.name === "pipeline-finalizer"
      )?.container?.args
    ).toEqual([
      "runner-finalize",
      "--payload-file",
      "/etc/pipeline/payload.json",
      "--schedule-file",
      "/etc/pipeline/schedule.yaml",
      "--argo-status",
      "{{workflow.status}}",
    ]);

    expect(retryStrategiesByTemplate(argoManifest)).toEqual({
      "task-descendant": startupOnlyRetryStrategy(),
      "task-flaky": startupOnlyRetryStrategy(),
      "task-setup": startupOnlyRetryStrategy(),
      "workflow-start": startupOnlyRetryStrategy(),
    });
    expect(
      argoManifest.spec.templates.find(
        (template) => template.name === "pipeline-finalizer"
      )
    ).not.toHaveProperty("retryStrategy");
    expect(retryStrategiesByTemplate(argoManifest)["task-flaky"]).toEqual(
      startupOnlyRetryStrategy()
    );
  });
});

function schedulerInput(
  overrides: Partial<WorkflowSchedulerInput>
): WorkflowSchedulerInput {
  return {
    failFast: false,
    isCancelled: () => false,
    markNodeReady: () => undefined,
    nodes: [scheduleNode("a", 0)],
    runNode: async (nodeId: string) => nodeResult(nodeId, "passed"),
    shouldContinueAfterNodeResult: (result: RuntimeNodeResult) =>
      result.status === "passed",
    skipNode: () => undefined,
    ...overrides,
  };
}

async function runArgoLifecycleAdapters(
  argoStatus: "Failed" | "Succeeded"
): Promise<{
  exitCodes: { finalize: number; start: number };
  finalResults: Array<{ outcome: string; workflowId: string }>;
  hookEvents: string[];
}> {
  const { dir, payloadPath, schedulePath } = writeRunnerCommandFixture();
  writeLifecycleConfig(dir, [
    "workflow.start",
    "workflow.failure",
    "workflow.complete",
  ]);
  const batches: unknown[][] = [];
  mockExeca.mockImplementation(commandHookResult());

  const start = await runRunnerLifecycle({
    cwd: dir,
    fetch: captureEventBatches(batches),
    payloadFile: payloadPath,
    phase: "workflow.start",
    scheduleFile: schedulePath,
    stderr: { write: () => true },
  });
  const finalize = await runRunnerFinalize({
    argoStatus,
    cwd: dir,
    fetch: captureEventBatches(batches),
    payloadFile: payloadPath,
    scheduleFile: schedulePath,
    stderr: { write: () => true },
  });

  return {
    exitCodes: { finalize, start },
    finalResults: finalResults(batches),
    hookEvents: hookResultEvents(batches).map(
      (event) => event.hookResult?.event ?? ""
    ),
  };
}

function lifecycleInput(overrides: {
  executeWorkflow: () => Promise<{
    completed: RuntimeNodeResult[];
    failure?: RuntimeFailure;
    outcome: PipelineRuntimeResult["outcome"];
  }>;
  runWorkflowHook: (
    event: WorkflowHookEvent,
    failure?: RuntimeFailure
  ) => Promise<RuntimeFailure | null> | RuntimeFailure | null;
}) {
  return {
    buildResult: (
      outcome: PipelineRuntimeResult["outcome"],
      nodes: RuntimeNodeResult[],
      failure?: RuntimeFailure
    ) => runtimeResult(testPlan(), outcome, nodes, failure),
    emitWorkflowPlanned: () => undefined,
    emitWorkflowStarted: () => undefined,
    ...overrides,
  };
}

function scheduleNode(
  id: string,
  index: number,
  needs: string[] = [],
  dependents: string[] = []
): WorkflowScheduleNode {
  return { dependents, id, index, needs };
}

function failFastSkipped(
  nodeIds: string[],
  failedNodeId: string
): Array<{ nodeId: string; reason: string }> {
  return nodeIds.map((nodeId) => ({
    nodeId,
    reason: `skipped because workflow fail_fast stopped after node '${failedNodeId}' failed`,
  }));
}

function nodeResult(
  nodeId: string,
  status: RuntimeNodeResult["status"],
  overrides: Partial<Pick<RuntimeNodeResult, "attempts" | "exitCode">> = {}
): RuntimeNodeResult {
  return {
    attempts: overrides.attempts ?? 1,
    evidence: [],
    exitCode: overrides.exitCode ?? (status === "passed" ? 0 : 1),
    nodeId,
    output: status,
    status,
  };
}

function nodeFailure(nodeId: string): RuntimeFailure {
  return {
    evidence: [],
    gate: nodeId,
    nodeId,
    reason: `node '${nodeId}' failed`,
  };
}

function runtimeResult(
  plan: ReturnType<typeof testPlan>,
  outcome: PipelineRuntimeResult["outcome"],
  nodes: RuntimeNodeResult[],
  failure?: RuntimeFailure
): PipelineRuntimeResult {
  return {
    agentInvocations: [],
    failureDetails: failure ? [failure] : [],
    gates: [],
    hookFailures: [],
    nodeStates: {},
    nodes,
    outcome,
    plan,
    structuredOutputs: [],
  };
}

function testPlan() {
  return compileWorkflowPlan(
    parsePipelineConfigParts({
      pipeline: `
version: 1
default_workflow: default
orchestrator:
  profile: orchestrator
workflows:
  default:
    nodes:
      - id: a
        kind: command
        command: [echo, ok]
`,
      profiles:
        "version: 1\nprofiles:\n  orchestrator:\n    runner: command\n    instructions: { inline: Orchestrate }\n",
      runners:
        "version: 1\nrunners:\n  command:\n    type: command\n    command: echo\n    capabilities:\n      native_subagents: false\n      output_formats: [text]\n",
    })
  );
}

function parityFixture(): {
  config: ReturnType<typeof parsePipelineConfigParts>;
  plan: WorkflowExecutionPlan;
} {
  const config = parsePipelineConfigParts({
    pipeline: `
version: 1
default_workflow: parity
orchestrator:
  profile: orchestrator
hooks:
  functions:
    lifecycle:
      kind: command
      command: [hook-bin]
      trusted: true
  on:
    workflow.start:
      - id: start
        function: lifecycle
        failure: fail
    workflow.failure:
      - id: failure
        function: lifecycle
        failure: fail
    workflow.complete:
      - id: complete
        function: lifecycle
        failure: fail
workflows:
  parity:
    execution:
      fail_fast: true
      max_parallel_nodes: 1
    nodes:
      - id: setup
        kind: command
        command: [echo, setup]
      - id: flaky
        kind: command
        command: [echo, flaky]
        needs: [setup]
        retries:
          max_attempts: 2
      - id: descendant
        kind: command
        command: [echo, descendant]
        needs: [flaky]
`,
    profiles:
      "version: 1\nprofiles:\n  orchestrator:\n    runner: command\n    instructions: { inline: Orchestrate }\n",
    runners:
      "version: 1\nrunners:\n  command:\n    type: command\n    command: echo\n    capabilities:\n      native_subagents: false\n      output_formats: [text]\n",
  });
  return { config, plan: compileWorkflowPlan(config) };
}

function parityRuntimeContext(
  plan: WorkflowExecutionPlan,
  config: ReturnType<typeof parsePipelineConfigParts>
): RuntimeContext {
  return {
    agentInvocations: [],
    config,
    executor: () => ({ exitCode: 0, output: "", stdout: "" }),
    gates: [],
    hookFailures: [],
    hookPolicy: {
      allowCommandHooks: false,
      allowUntrustedCommandHooks: false,
      env: {},
      envPassthrough: [],
      outputLimitBytes: 1024,
      timeoutMs: 1000,
    },
    hookResults: new Map(),
    maxParallelNodes: plan.execution.maxParallelNodes,
    nodeStateStore: {} as RuntimeContext["nodeStateStore"],
    plan,
    runId: "parity-run",
    task: "PIPE-60.4 parity contract",
    workflowId: plan.workflowId,
    worktreePath: "/tmp/pipeline-parity",
  };
}

function projectArgoDagCompletion(
  manifest: ReturnType<typeof buildRunnerArgoWorkflowManifest>,
  terminalStatuses: Record<string, "failed" | "passed">
): {
  executionOrder: string[];
  lifecycleEvents: Array<{ event: WorkflowHookEvent; status: string }>;
  outcome: PipelineRuntimeResult["outcome"];
  skipped: Array<{ nodeId: string; reason: string }>;
} {
  const dagTasks =
    manifest.spec.templates.find((template) => template.name === "pipeline")
      ?.dag?.tasks ?? [];
  const execution = projectArgoExecution(dagTasks, terminalStatuses);
  const failedNodeId = argoNodeId(execution.failedTask);

  return {
    executionOrder: execution.executionOrder,
    lifecycleEvents: projectArgoLifecycleEvents(failedNodeId),
    outcome: failedNodeId ? "FAIL" : "PASS",
    skipped: projectArgoSkippedNodes(
      dagTasks,
      execution.completed,
      failedNodeId
    ),
  };
}

function projectArgoExecution(
  dagTasks: ArgoDagTask[],
  terminalStatuses: Record<string, "failed" | "passed">
): {
  completed: Set<string>;
  executionOrder: string[];
  failedTask?: string;
} {
  const completed = new Set<string>();
  const executionOrder: string[] = [];
  let failedTask: string | undefined;

  while (!failedTask) {
    const readyTask = nextReadyArgoTask(dagTasks, completed);
    if (!readyTask) {
      break;
    }
    completed.add(readyTask.name);
    const nodeId = argoNodeId(readyTask.name);
    if (nodeId) {
      executionOrder.push(nodeId);
    }
    if (terminalStatuses[readyTask.name] === "failed") {
      failedTask = readyTask.name;
    }
  }

  return { completed, executionOrder, failedTask };
}

function nextReadyArgoTask(
  dagTasks: ArgoDagTask[],
  completed: Set<string>
): ArgoDagTask | undefined {
  return dagTasks.find(
    (task) =>
      !completed.has(task.name) &&
      (task.dependencies ?? []).every((dependency) => completed.has(dependency))
  );
}

function argoNodeId(taskName: string | undefined): string | undefined {
  return taskName?.startsWith("node-")
    ? taskName.slice("node-".length)
    : undefined;
}

function projectArgoSkippedNodes(
  dagTasks: ArgoDagTask[],
  completed: Set<string>,
  failedNodeId: string | undefined
): Array<{ nodeId: string; reason: string }> {
  if (!failedNodeId) {
    return [];
  }
  return dagTasks
    .map((task) => ({ nodeId: argoNodeId(task.name), task }))
    .filter(({ nodeId, task }) => nodeId && !completed.has(task.name))
    .map(({ nodeId }) => ({
      nodeId: nodeId ?? "",
      reason: `skipped because workflow fail_fast stopped after node '${failedNodeId}' failed`,
    }));
}

function projectArgoLifecycleEvents(
  failedNodeId: string | undefined
): Array<{ event: WorkflowHookEvent; status: string }> {
  const finalStatus = failedNodeId ? "Failed" : "Succeeded";
  return [
    { event: "workflow.start", status: "Running" },
    {
      event: failedNodeId ? "workflow.failure" : "workflow.success",
      status: finalStatus,
    },
    { event: "workflow.complete", status: finalStatus },
  ];
}

type ArgoDagTask = NonNullable<
  NonNullable<
    ReturnType<
      typeof buildRunnerArgoWorkflowManifest
    >["spec"]["templates"][number]["dag"]
  >["tasks"]
>[number];

function retryStrategiesByTemplate(
  manifest: ReturnType<typeof buildRunnerArgoWorkflowManifest>
): Record<string, unknown> {
  return Object.fromEntries(
    manifest.spec.templates
      .filter((template) => template.retryStrategy !== undefined)
      .map((template) => [template.name, template.retryStrategy])
  );
}

function startupOnlyRetryStrategy() {
  return {
    expression: "asInt(lastRetry.exitCode) == 70",
    limit: "3",
    retryPolicy: "OnFailure",
  };
}
