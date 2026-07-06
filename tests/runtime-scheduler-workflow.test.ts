import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";

import { Option } from "effect";
import { execa } from "execa";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";

import { buildRunnerArgoWorkflowManifest } from "../src/argo-workflow";
import { parsePipelineConfigParts } from "../src/config";
import type { PipelineRuntimeResult, RuntimeFailure, RuntimeNodeResult } from "../src/pipeline-runtime";
import { compileWorkflowPlan } from "../src/planning/compile";
import type { WorkflowExecutionPlan } from "../src/planning/compile";
import { runRunnerFinalize } from "../src/runner-command/finalize";
import { runRunnerLifecycle } from "../src/runner-command/lifecycle";
import type { RuntimeContext } from "../src/runtime/contracts";
import { LocalScheduler } from "../src/runtime/local-scheduler";
import type { PipelineScheduler } from "../src/runtime/local-scheduler";
import { NodeStateStore } from "../src/runtime/node-state-store";
import { fileRunJournal } from "../src/runtime/run-journal";
import { runWorkflowScheduler } from "../src/runtime/scheduler";
import type { WorkflowScheduleNode, WorkflowSchedulerInput } from "../src/runtime/scheduler";
import { runWorkflowLifecycle } from "../src/runtime/workflow-lifecycle";
import type { WorkflowHookEvent, WorkflowHookResult } from "../src/runtime/workflow-lifecycle";
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
  prepareRunnerGitWorkspace: vi.fn((_payload, options?: { cwd?: string }) => options?.cwd ?? "/workspace"),
  promoteFinalRef: vi.fn(() => "final-sha"),
}));

const mockExeca: ReturnType<typeof vi.fn> = vi.mocked(execa);

afterEach(() => {
  vi.clearAllMocks();
  cleanupRunnerCommandFixtures();
});

const runArgoLifecycleAdapters = async (
  argoStatus: "Failed" | "Succeeded",
): Promise<{
  exitCodes: { finalize: number; start: number };
  finalResults: { outcome: string; workflowId: string }[];
  hookEvents: string[];
}> => {
  const { dir, payloadPath, schedulePath } = writeRunnerCommandFixture();
  writeLifecycleConfig(dir, ["workflow.start", "workflow.failure", "workflow.complete"]);
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
    hookEvents: hookResultEvents(batches).map((event) => event.hookResult?.event ?? ""),
  };
};

const scheduleNode = (
  id: string,
  index: number,
  needs: string[] = [],
  dependents: string[] = [],
): WorkflowScheduleNode => ({ dependents, id, index, needs });

const failFastSkipped = (nodeIds: string[], failedNodeId: string): { nodeId: string; reason: string }[] =>
  nodeIds.map((nodeId) => ({
    nodeId,
    reason: `skipped because workflow fail_fast stopped after node '${failedNodeId}' failed`,
  }));

const nodeResult = (
  nodeId: string,
  status: RuntimeNodeResult["status"],
  overrides: Partial<Pick<RuntimeNodeResult, "attempts" | "exitCode">> = {},
): RuntimeNodeResult => ({
  attempts: overrides.attempts ?? 1,
  evidence: [],
  exitCode: overrides.exitCode ?? (status === "passed" ? 0 : 1),
  nodeId,
  output: status,
  status,
});

const schedulerInput = (overrides: Partial<WorkflowSchedulerInput>): WorkflowSchedulerInput => ({
  failFast: false,
  isCancelled: () => false,
  markNodeReady: () => {},
  nodes: [scheduleNode("a", 0)],
  runNode: async (nodeId: string) => await Promise.resolve(nodeResult(nodeId, "passed")),
  shouldContinueAfterNodeResult: (result: RuntimeNodeResult) => result.status === "passed",
  skipNode: () => {},
  ...overrides,
});

describe("plain workflow scheduler", () => {
  it("exposes the local scheduler behind the PipelineScheduler seam", () => {
    const scheduler: PipelineScheduler = new LocalScheduler();

    expectTypeOf<Parameters<PipelineScheduler["runWorkflow"]>>().toEqualTypeOf<
      [WorkflowExecutionPlan, RuntimeContext]
    >();
    expectTypeOf<ReturnType<PipelineScheduler["runWorkflow"]>>().toEqualTypeOf<Promise<PipelineRuntimeResult>>();
    expect(scheduler).toBeInstanceOf(LocalScheduler);
  });

  it("forces serial execution with failFast when multiple root nodes are ready", async () => {
    let active = 0;
    let maxActive = 0;

    const result = await runWorkflowScheduler(
      schedulerInput({
        failFast: true,
        nodes: [scheduleNode("a", 0), scheduleNode("b", 1), scheduleNode("c", 2)],
        runNode: async (nodeId: string) => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await setTimeout(5);
          active -= 1;
          return nodeResult(nodeId, "passed");
        },
      }),
    );

    expect(maxActive).toBe(1);
    expect(result.completed.map((node: RuntimeNodeResult) => node.nodeId)).toEqual(["a", "b", "c"]);
  });

  it("skips every unstarted node with the exact fail-fast skip reason", async () => {
    const skipped: { nodeId: string; reason: string }[] = [];

    const result = await runWorkflowScheduler(
      schedulerInput({
        failFast: true,
        nodes: [scheduleNode("a", 0), scheduleNode("b", 1), scheduleNode("c", 2, ["a"])],
        runNode: async (nodeId: string) => await Promise.resolve(nodeResult(nodeId, "failed")),
        skipNode: (nodeId: string, reason: string) => {
          skipped.push({ nodeId, reason });
        },
      }),
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
        markNodeReady: (nodeId: string) => {
          readyNodes.push(nodeId);
        },
        maxParallelNodes: 2,
        nodes: [scheduleNode("a", 0), scheduleNode("b", 1), scheduleNode("c", 2)],
        runNode: async (nodeId: string) => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await setTimeout(5);
          active -= 1;
          return nodeResult(nodeId, "passed");
        },
      }),
    );

    expect(readyNodes).toEqual(["a", "b", "c"]);
    expect(maxActive).toBe(2);
    expect(result.completed.map((node: RuntimeNodeResult) => node.nodeId)).toEqual(["a", "b", "c"]);
  });

  it("keeps blocked descendants pending when failFast is disabled", async () => {
    const skipped: { nodeId: string; reason: string }[] = [];
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
          return nodeResult(nodeId, nodeId === "failed-branch" ? "failed" : "passed");
        },
        skipNode: (nodeId: string, reason: string) => {
          skipped.push({ nodeId, reason });
        },
      }),
    );

    expect(started).toEqual(["root", "failed-branch", "independent"]);
    expect(skipped).toEqual([]);
    expect(result.outcome).toBe("FAIL");
    expect(result.completed.map((node: RuntimeNodeResult) => node.nodeId)).toEqual([
      "root",
      "failed-branch",
      "independent",
    ]);
  });

  it("keeps Argo and Kubernetes clients out of the local scheduler seam", () => {
    const schedulerSource = readFileSync(join(import.meta.dirname, "../src/runtime/scheduler.ts"), "utf-8");
    const pipelineRuntimeSource = readFileSync(join(import.meta.dirname, "../src/pipeline-runtime.ts"), "utf-8");

    expect(schedulerSource).not.toContain("@kubernetes/client-node");
    expect(pipelineRuntimeSource).not.toContain("@kubernetes/client-node");
  });
});

const nodeFailure = (nodeId: string): RuntimeFailure => ({
  evidence: [],
  gate: nodeId,
  nodeId,
  reason: `node '${nodeId}' failed`,
});

const runtimeResult = (
  plan: ReturnType<typeof testPlan>,
  outcome: PipelineRuntimeResult["outcome"],
  nodes: RuntimeNodeResult[],
  failure?: RuntimeFailure,
): PipelineRuntimeResult => ({
  agentInvocations: [],
  failureDetails: failure ? [failure] : [],
  gates: [],
  hookFailures: [],
  nodeStates: {},
  nodes,
  outcome,
  plan,
  structuredOutputs: [],
});

const testPlan = () =>
  compileWorkflowPlan(
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
    }),
  );

const lifecycleInput = (overrides: {
  executeWorkflow: () => Promise<{
    completed: RuntimeNodeResult[];
    failure?: RuntimeFailure;
    outcome: PipelineRuntimeResult["outcome"];
  }>;
  runWorkflowHook: (
    event: WorkflowHookEvent,
    failure?: RuntimeFailure,
  ) => Promise<WorkflowHookResult> | WorkflowHookResult;
}) => ({
  buildResult: (outcome: PipelineRuntimeResult["outcome"], nodes: RuntimeNodeResult[], failure?: RuntimeFailure) =>
    runtimeResult(testPlan(), outcome, nodes, failure),
  emitWorkflowPlanned: () => {},
  emitWorkflowStarted: () => {},
  ...overrides,
});

describe("workflow lifecycle", () => {
  it("runs workflow hooks in failure order: start, failure, complete", async () => {
    const hookEvents: string[] = [];

    const result = await runWorkflowLifecycle(
      lifecycleInput({
        executeWorkflow: async () =>
          await Promise.resolve({
            completed: [nodeResult("a", "failed")],
            failure: nodeFailure("a"),
            outcome: "FAIL",
          }),
        runWorkflowHook: (event) => {
          hookEvents.push(event);
          return Option.none();
        },
      }),
    );

    expect(hookEvents).toEqual(["workflow.start", "workflow.failure", "workflow.complete"]);
    expect(result.status).toBe("failed");
    expect(result.result.outcome).toBe("FAIL");
  });

  it("lets success hook failure win over an otherwise passing workflow", async () => {
    const hookEvents: string[] = [];

    const result = await runWorkflowLifecycle(
      lifecycleInput({
        executeWorkflow: async () =>
          await Promise.resolve({
            completed: [nodeResult("a", "passed")],
            outcome: "PASS",
          }),
        runWorkflowHook: (event) => {
          hookEvents.push(event);
          if (event === "workflow.success") {
            return Option.some({
              evidence: ["success hook returned failure"],
              gate: "workflow.success",
              nodeId: "start",
              reason: "success hook failed",
            });
          }
          return Option.none();
        },
      }),
    );

    expect(hookEvents).toEqual(["workflow.start", "workflow.success", "workflow.complete"]);
    expect(result.status).toBe("failed");
    expect(result.successHookFailure?.reason).toBe("success hook failed");
    expect(result.result.outcome).toBe("FAIL");
    expect(result.result.failureDetails).toEqual([expect.objectContaining({ reason: "success hook failed" })]);
  });

  it("runs start, success, complete and finalizes a successful result", async () => {
    const hookEvents: string[] = [];

    const result = await runWorkflowLifecycle(
      lifecycleInput({
        executeWorkflow: async () =>
          await Promise.resolve({
            completed: [nodeResult("a", "passed")],
            outcome: "PASS",
          }),
        runWorkflowHook: (event) => {
          hookEvents.push(event);
          return Option.none();
        },
      }),
    );

    expect(hookEvents).toEqual(["workflow.start", "workflow.success", "workflow.complete"]);
    expect(result.status).toBe("passed");
    expect(result.result.outcome).toBe("PASS");
    expect(result.result.nodes).toEqual([nodeResult("a", "passed")]);
  });
});

const parityFixture = (): {
  config: ReturnType<typeof parsePipelineConfigParts>;
  plan: WorkflowExecutionPlan;
} => {
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
};

const parityRuntimeContext = (
  plan: WorkflowExecutionPlan,
  config: ReturnType<typeof parsePipelineConfigParts>,
): RuntimeContext => ({
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
  nodeStateStore: new NodeStateStore(),
  plan,
  runId: "parity-run",
  task: "PIPE-60.4 parity contract",
  workflowId: plan.workflowId,
  worktreePath: "/tmp/pipeline-parity",
});

const nextReadyArgoTask = (dagTasks: ArgoDagTask[], completed: Set<string>): Option.Option<ArgoDagTask> =>
  Option.fromUndefinedOr(
    dagTasks.find(
      (task) => !completed.has(task.name) && (task.dependencies ?? []).every((dependency) => completed.has(dependency)),
    ),
  );

const argoNodeId = (taskName: string): Option.Option<string> =>
  taskName.startsWith("node-") ? Option.some(taskName.slice("node-".length)) : Option.none();

const projectArgoExecution = (
  dagTasks: ArgoDagTask[],
  terminalStatuses: Record<string, "failed" | "passed">,
): {
  completed: Set<string>;
  executionOrder: string[];
  failedTask: Option.Option<string>;
} => {
  const completed = new Set<string>();
  const executionOrder: string[] = [];
  let failedTask: Option.Option<string> = Option.none();

  while (Option.isNone(failedTask)) {
    const readyTask = nextReadyArgoTask(dagTasks, completed);
    if (Option.isNone(readyTask)) {
      break;
    }
    completed.add(readyTask.value.name);
    const nodeId = argoNodeId(readyTask.value.name);
    if (Option.isSome(nodeId)) {
      executionOrder.push(nodeId.value);
    }
    if (terminalStatuses[readyTask.value.name] === "failed") {
      failedTask = Option.some(readyTask.value.name);
    }
  }

  return { completed, executionOrder, failedTask };
};

const projectArgoSkippedNodes = (
  dagTasks: ArgoDagTask[],
  completed: Set<string>,
  failedNodeId: Option.Option<string>,
): { nodeId: string; reason: string }[] =>
  Option.match(failedNodeId, {
    onNone: () => [],
    onSome: (failed) =>
      dagTasks.flatMap((task) => {
        const nodeId = argoNodeId(task.name);
        if (Option.isNone(nodeId) || completed.has(task.name)) {
          return [];
        }
        return [
          {
            nodeId: nodeId.value,
            reason: `skipped because workflow fail_fast stopped after node '${failed}' failed`,
          },
        ];
      }),
  });

const projectArgoLifecycleEvents = (
  failedNodeId: Option.Option<string>,
): { event: WorkflowHookEvent; status: string }[] => {
  const finalStatus = Option.isNone(failedNodeId) ? "Succeeded" : "Failed";
  return [
    { event: "workflow.start", status: "Running" },
    {
      event: Option.isNone(failedNodeId) ? "workflow.success" : "workflow.failure",
      status: finalStatus,
    },
    { event: "workflow.complete", status: finalStatus },
  ];
};

const projectArgoDagCompletion = (
  manifest: ReturnType<typeof buildRunnerArgoWorkflowManifest>,
  terminalStatuses: Record<string, "failed" | "passed">,
): {
  executionOrder: string[];
  lifecycleEvents: { event: WorkflowHookEvent; status: string }[];
  outcome: PipelineRuntimeResult["outcome"];
  skipped: { nodeId: string; reason: string }[];
} => {
  const dagTasks = manifest.spec.templates.find((template) => template.name === "pipeline")?.dag?.tasks ?? [];
  const execution = projectArgoExecution(dagTasks, terminalStatuses);
  const failedNodeId = Option.match(execution.failedTask, {
    onNone: () => Option.none(),
    onSome: argoNodeId,
  });

  return {
    executionOrder: execution.executionOrder,
    lifecycleEvents: projectArgoLifecycleEvents(failedNodeId),
    outcome: Option.isNone(failedNodeId) ? "PASS" : "FAIL",
    skipped: projectArgoSkippedNodes(dagTasks, execution.completed, failedNodeId),
  };
};

type ArgoDagTask = NonNullable<
  NonNullable<ReturnType<typeof buildRunnerArgoWorkflowManifest>["spec"]["templates"][number]["dag"]>["tasks"]
>[number];

const retryStrategiesByTemplate = (
  manifest: ReturnType<typeof buildRunnerArgoWorkflowManifest>,
): Record<string, unknown> =>
  Object.fromEntries(
    manifest.spec.templates
      .filter((template) => template.retryStrategy !== undefined)
      .map((template) => [template.name, template.retryStrategy]),
  );

const runnerRetryStrategy = () => ({
  expression: "lastRetry.status == 'Error' || (lastRetry.exitCode != '0' && lastRetry.exitCode != '1')",
  limit: "3",
  retryPolicy: "Always",
});

describe("LocalScheduler and Argo workflow parity", () => {
  it("keeps dependency order, fail-fast skips, lifecycle completion, and retry ownership aligned", async () => {
    const { config, plan } = parityFixture();
    const localReadyOrder: string[] = [];
    const localSkipped: { nodeId: string; reason: string }[] = [];
    const localHookEvents: {
      event: WorkflowHookEvent;
      failure?: RuntimeFailure;
    }[] = [];
    const localScheduler = new LocalScheduler({
      buildResult: (outcome, nodes, failure) => runtimeResult(plan, outcome, nodes, failure),
      emitWorkflowPlanned: () => {},
      emitWorkflowStarted: () => {},
      executeNode: async (nodeId) =>
        await Promise.resolve(
          nodeId === "flaky"
            ? nodeResult(nodeId, "failed", { attempts: 2, exitCode: 1 })
            : nodeResult(nodeId, "passed"),
        ),
      isCancelled: () => false,
      markNodeReady: (nodeId) => {
        localReadyOrder.push(nodeId);
      },
      resolveJournal: () => Option.none(),
      runWorkflowHook: (event, _context, failure) => {
        localHookEvents.push({ event, failure });
        return Option.none();
      },
      shouldContinueAfterNodeResult: (result) => result.status === "passed",
      skipNode: (nodeId, reason) => {
        localSkipped.push({ nodeId, reason });
      },
    });

    const localResult = await localScheduler.runWorkflow(plan, parityRuntimeContext(plan, config));
    const argoManifest = buildRunnerArgoWorkflowManifest({
      brokerAuth: {
        secretKey: "api-key",
        secretName: "broker-api-key",
        url: "https://cliproxy.momokaya.ee",
      },
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
    expect(plan.topologicalOrder.map((node) => node.id)).toEqual(["setup", "flaky", "descendant"]);
    expect(plan.topologicalOrder.find((node) => node.id === "flaky")).toEqual(
      expect.objectContaining({ retries: { max_attempts: 2 } }),
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
    expect(localHookEvents[0]).toEqual({
      event: "workflow.start",
      failure: undefined,
    });
    expect(localHookEvents[1]?.event).toBe("workflow.failure");
    expect(localHookEvents[1]?.failure).toEqual(expect.objectContaining({ nodeId: "flaky" }));
    expect(localHookEvents[2]?.event).toBe("workflow.complete");
    expect(localHookEvents[2]?.failure).toEqual(expect.objectContaining({ nodeId: "flaky" }));
    expect(argoProjection.lifecycleEvents).toEqual([
      { event: "workflow.start", status: "Running" },
      { event: "workflow.failure", status: "Failed" },
      { event: "workflow.complete", status: "Failed" },
    ]);
    expect(argoAdapters.exitCodes).toEqual({ finalize: 1, start: 0 });
    expect(argoAdapters.hookEvents).toEqual(["workflow.start", "workflow.failure", "workflow.complete"]);
    expect(argoAdapters.finalResults).toEqual([{ outcome: "FAIL", workflowId: "schedule-run-1-root" }]);
    expect(argoManifest.spec.templates.find((template) => template.name === "workflow-start")?.container?.args).toEqual(
      [
        "runner-lifecycle",
        "--phase",
        "workflow.start",
        "--payload-file",
        "/etc/pipeline/payload.json",
        "--schedule-file",
        "/etc/pipeline/schedule.yaml",
      ],
    );
    expect(
      argoManifest.spec.templates.find((template) => template.name === "pipeline-finalizer")?.container?.args,
    ).toEqual([
      "runner-finalize",
      "--payload-file",
      "/etc/pipeline/payload.json",
      "--schedule-file",
      "/etc/pipeline/schedule.yaml",
      "--argo-status",
      "{{workflow.status}}",
      "--argo-failures",
      "{{workflow.failures}}",
    ]);

    expect(retryStrategiesByTemplate(argoManifest)).toEqual({
      "task-descendant": runnerRetryStrategy(),
      "task-flaky": runnerRetryStrategy(),
      "task-setup": runnerRetryStrategy(),
      "workflow-start": runnerRetryStrategy(),
    });
    expect(argoManifest.spec.templates.find((template) => template.name === "pipeline-finalizer")).not.toHaveProperty(
      "retryStrategy",
    );
    expect(retryStrategiesByTemplate(argoManifest)["task-flaky"]).toEqual(runnerRetryStrategy());
  });
});

const categorizedNodes = (ids: string[], category: string): WorkflowScheduleNode[] =>
  ids.map((id, index) => ({
    category,
    dependents: [],
    id,
    index,
    needs: [],
  }));

describe("runWorkflowScheduler durable crash-resume", () => {
  it("does not re-run or re-ready nodes the journal already recorded as passed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scheduler-resume-seed-"));
    try {
      const path = join(dir, "run.jsonl");
      // Seed the durable journal as if "a" had already passed in a prior run.
      fileRunJournal(path).record(nodeResult("a", "passed"));

      const ran: string[] = [];
      const readied: string[] = [];
      const result = await runWorkflowScheduler(
        schedulerInput({
          journal: fileRunJournal(path),
          markNodeReady: (nodeId: string) => {
            readied.push(nodeId);
          },
          nodes: [scheduleNode("a", 0), scheduleNode("b", 1, ["a"])],
          runNode: async (nodeId: string) => {
            ran.push(nodeId);
            return await Promise.resolve(nodeResult(nodeId, "passed"));
          },
        }),
      );

      // "a" was resumed from the journal: never re-run, never re-readied.
      expect(ran).toEqual(["b"]);
      expect(readied).toEqual(["b"]);
      // ...but it is still part of the completed run, ahead of its dependent.
      expect(result.outcome).toBe("PASS");
      expect(result.completed.map((node) => node.nodeId)).toEqual(["a", "b"]);
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it("resumes a killed run from a file journal without re-spending the finished node", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scheduler-resume-"));
    try {
      const path = join(dir, "run.jsonl");
      const firstRan: string[] = [];

      // First attempt: "a" completes and is journaled, then the run is "killed"
      // before "b" by cancelling immediately after the first node.
      await runWorkflowScheduler(
        schedulerInput({
          isCancelled: () => firstRan.length >= 1,
          journal: fileRunJournal(path),
          nodes: [scheduleNode("a", 0), scheduleNode("b", 1, ["a"])],
          runNode: async (nodeId: string) => {
            firstRan.push(nodeId);
            return await Promise.resolve(nodeResult(nodeId, "passed"));
          },
        }),
      );
      expect(firstRan).toEqual(["a"]);

      // Resume with a fresh journal handle over the same file: only "b" runs.
      const resumedRan: string[] = [];
      const resumed = await runWorkflowScheduler(
        schedulerInput({
          journal: fileRunJournal(path),
          nodes: [scheduleNode("a", 0), scheduleNode("b", 1, ["a"])],
          runNode: async (nodeId: string) => {
            resumedRan.push(nodeId);
            return await Promise.resolve(nodeResult(nodeId, "passed"));
          },
        }),
      );

      expect(resumedRan).toEqual(["b"]);
      expect(resumed.outcome).toBe("PASS");
      expect(resumed.completed.map((node) => node.nodeId)).toEqual(["a", "b"]);
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });
});

describe("runWorkflowScheduler per-category fan-out", () => {
  it("never runs more than a category's fan-out width concurrently", async () => {
    let active = 0;
    let maxActive = 0;

    await runWorkflowScheduler(
      schedulerInput({
        fanOutWidth: { by_category: { green: 2 }, default: 4 },
        maxParallelNodes: 10,
        nodes: categorizedNodes(["g1", "g2", "g3", "g4"], "green"),
        runNode: async (nodeId: string) => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await setTimeout(5);
          active -= 1;
          return nodeResult(nodeId, "passed");
        },
      }),
    );

    expect(maxActive).toBe(2);
  });

  it("lets uncategorized nodes run up to the global capacity", async () => {
    let active = 0;
    let maxActive = 0;

    await runWorkflowScheduler(
      schedulerInput({
        fanOutWidth: { by_category: { green: 2 }, default: 4 },
        maxParallelNodes: 3,
        nodes: [scheduleNode("a", 0), scheduleNode("b", 1), scheduleNode("c", 2)],
        runNode: async (nodeId: string) => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await setTimeout(5);
          active -= 1;
          return nodeResult(nodeId, "passed");
        },
      }),
    );

    expect(maxActive).toBe(3);
  });
});
