import { describe, expect, it } from "vitest";
import { createActor } from "xstate";
import { parsePipelineConfigParts } from "../src/config.js";
import type {
  PipelineRuntimeResult,
  RuntimeFailure,
  RuntimeNodeResult,
} from "../src/pipeline-runtime.js";
import { runtimeActorId } from "../src/runtime-machines/contracts.js";
import {
  type WorkflowSchedulerInput,
  workflowSchedulerMachine,
} from "../src/runtime-machines/workflow-machine.js";
import { compileWorkflowPlan } from "../src/workflow-planner.js";

describe("workflowSchedulerMachine", () => {
  it("owns workflow hooks and successful result finalization", async () => {
    const plan = testPlan();
    const hookEvents: string[] = [];
    const actor = createActor(workflowSchedulerMachine, {
      input: testInput({
        buildResult: (outcome, nodes, failure) =>
          runtimeResult(plan, outcome, nodes, failure),
        runNode: async (nodeId) => nodeResult(nodeId, "passed"),
        runWorkflowHook: (event) => {
          hookEvents.push(event);
          return null;
        },
      }),
    });

    actor.start();
    actor.send({ type: "START" });
    await waitForDone(actor);

    expect(hookEvents).toEqual([
      "workflow.start",
      "workflow.success",
      "workflow.complete",
    ]);
    expect(actor.getSnapshot().value).toBe("passed");
    expect(actor.getSnapshot().context.result?.outcome).toBe("PASS");
    expect(actor.getSnapshot().context.result?.nodes).toEqual([
      nodeResult("a", "passed"),
    ]);
  });

  it("schedules ready nodes through the machine maxParallelNodes limit", async () => {
    const plan = testPlan();
    const readyNodes: string[] = [];
    let active = 0;
    let maxActive = 0;
    const actor = createActor(workflowSchedulerMachine, {
      input: testInput({
        buildResult: (outcome, nodes, failure) =>
          runtimeResult(plan, outcome, nodes, failure),
        markNodeReady: (nodeId) => readyNodes.push(nodeId),
        maxParallelNodes: 2,
        nodes: [
          scheduleNode("a", 0),
          scheduleNode("b", 1),
          scheduleNode("c", 2),
        ],
        runNode: async (nodeId) => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolve) => setTimeout(resolve, 5));
          active -= 1;
          return nodeResult(nodeId, "passed");
        },
      }),
    });

    actor.start();
    actor.send({ type: "START" });
    await waitForDone(actor);

    expect(readyNodes).toEqual(["a", "b", "c"]);
    expect(maxActive).toBe(2);
    expect(
      actor.getSnapshot().context.completed.map((node) => node.nodeId)
    ).toEqual(["a", "b", "c"]);
  });

  it("stops a fail-fast workflow and skips unstarted nodes", async () => {
    const plan = testPlan();
    const skipped: Array<{ nodeId: string; reason: string }> = [];
    const actor = createActor(workflowSchedulerMachine, {
      input: testInput({
        buildResult: (outcome, nodes, failure) =>
          runtimeResult(plan, outcome, nodes, failure),
        failFast: true,
        nodes: [
          scheduleNode("a", 0),
          scheduleNode("b", 1),
          scheduleNode("c", 2),
        ],
        runNode: async (nodeId) => nodeResult(nodeId, "failed"),
        skipNode: (nodeId, reason) => skipped.push({ nodeId, reason }),
      }),
    });

    actor.start();
    actor.send({ type: "START" });
    await waitForDone(actor);

    expect(skipped).toEqual([
      {
        nodeId: "b",
        reason:
          "skipped because workflow fail_fast stopped after node 'a' failed",
      },
      {
        nodeId: "c",
        reason:
          "skipped because workflow fail_fast stopped after node 'a' failed",
      },
    ]);
    expect(actor.getSnapshot().value).toBe("failed");
    expect(actor.getSnapshot().context.result?.outcome).toBe("FAIL");
    expect(actor.getSnapshot().context.result?.nodes).toEqual([
      nodeResult("a", "failed"),
    ]);
  });
});

function testInput(overrides: Partial<WorkflowSchedulerInput>) {
  const nodes = overrides.nodes ?? [scheduleNode("a", 0)];
  return {
    actor: {
      id: runtimeActorId("workflow", { workflowId: "default" }),
      kind: "workflow" as const,
    },
    buildResult:
      overrides.buildResult ??
      ((outcome, nodes, failure) =>
        runtimeResult(testPlan(), outcome, nodes, failure)),
    emitWorkflowPlanned: overrides.emitWorkflowPlanned ?? (() => undefined),
    emitWorkflowStarted: overrides.emitWorkflowStarted ?? (() => undefined),
    failFast: overrides.failFast ?? false,
    isCancelled: overrides.isCancelled ?? (() => false),
    markNodeReady: overrides.markNodeReady ?? (() => undefined),
    maxParallelNodes: overrides.maxParallelNodes,
    nodes,
    runNode:
      overrides.runNode ?? (async (nodeId) => nodeResult(nodeId, "passed")),
    runWorkflowHook: overrides.runWorkflowHook ?? (async () => null),
    shouldContinueAfterNodeResult:
      overrides.shouldContinueAfterNodeResult ?? (() => false),
    skipNode: overrides.skipNode ?? (() => undefined),
  };
}

function scheduleNode(
  id: string,
  index: number,
  needs: string[] = [],
  dependents: string[] = []
): WorkflowSchedulerInput["nodes"][number] {
  return { dependents, id, index, needs };
}

function waitForDone(actor: ReturnType<typeof createActor>): Promise<void> {
  return new Promise((resolve) => {
    const sub = actor.subscribe((snapshot) => {
      if (snapshot.status === "done") {
        sub.unsubscribe();
        resolve();
      }
    });
  });
}

function nodeResult(
  nodeId: string,
  status: RuntimeNodeResult["status"]
): RuntimeNodeResult {
  return {
    attempts: 1,
    evidence: [],
    exitCode: status === "passed" ? 0 : 1,
    nodeId,
    output: status,
    status,
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
