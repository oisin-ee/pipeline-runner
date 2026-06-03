import pLimit from "p-limit";
import { type ActorRefFrom, assign, fromPromise, setup } from "xstate";
import type {
  RuntimeActorDescriptor,
  RuntimeFailure,
  RuntimeNodeResult,
  WorkflowSchedulerEvent,
  WorkflowSchedulerResult,
} from "./contracts.js";

type WorkflowHookEvent =
  | "workflow.complete"
  | "workflow.failure"
  | "workflow.start"
  | "workflow.success";

export interface WorkflowSchedulerInput {
  actor: RuntimeActorDescriptor;
  batches: string[][];
  buildResult: (
    outcome: WorkflowSchedulerResult["outcome"],
    nodes: RuntimeNodeResult[],
    failure?: RuntimeFailure
  ) => WorkflowSchedulerResult;
  emitWorkflowPlanned: () => void;
  emitWorkflowStarted: () => void;
  failFast: boolean;
  isCancelled: () => boolean;
  markNodeReady: (nodeId: string) => void;
  maxParallelNodes?: number;
  nodeIds: string[];
  runNode: (nodeId: string) => Promise<RuntimeNodeResult>;
  runWorkflowHook: (
    event: WorkflowHookEvent,
    failure?: RuntimeFailure
  ) => Promise<RuntimeFailure | null> | RuntimeFailure | null;
  shouldContinueAfterNodeResult: (result: RuntimeNodeResult) => boolean;
  skipNode: (nodeId: string, reason: string) => void;
}

interface WorkflowSchedulerContext {
  active: number;
  batches: string[][];
  batchIndex: number;
  completed: RuntimeNodeResult[];
  failure?: RuntimeFailure;
  input: WorkflowSchedulerInput;
  latestBatchResults: RuntimeNodeResult[];
  nodes: RuntimeNodeResult[];
  queue: string[];
  result?: WorkflowSchedulerResult;
  status: "cancelled" | "failed" | "passed" | "running" | "waiting";
  successHookFailure?: RuntimeFailure;
}

interface WorkflowHookInvocationInput {
  event: WorkflowHookEvent;
  failure?: RuntimeFailure;
  runWorkflowHook: WorkflowSchedulerInput["runWorkflowHook"];
}

interface WorkflowBatchInvocationInput {
  batch: string[];
  failFast: boolean;
  markNodeReady: WorkflowSchedulerInput["markNodeReady"];
  maxParallelNodes?: number;
  runNode: WorkflowSchedulerInput["runNode"];
  skipNode: WorkflowSchedulerInput["skipNode"];
}

type WorkflowMachineEvent =
  | WorkflowSchedulerEvent
  | {
      output: RuntimeFailure | null;
      type:
        | "xstate.done.actor.workflowCompleteHook"
        | "xstate.done.actor.workflowFailureHook"
        | "xstate.done.actor.workflowStartHook"
        | "xstate.done.actor.workflowSuccessHook";
    }
  | {
      error: unknown;
      type:
        | "xstate.error.actor.workflowCompleteHook"
        | "xstate.error.actor.workflowFailureHook"
        | "xstate.error.actor.workflowStartHook"
        | "xstate.error.actor.workflowSuccessHook";
    }
  | {
      output: RuntimeNodeResult[];
      type: "xstate.done.actor.runBatch";
    }
  | {
      error: unknown;
      type: "xstate.error.actor.runBatch";
    };

export const workflowSchedulerMachine = setup({
  types: {
    context: {} as WorkflowSchedulerContext,
    events: {} as WorkflowMachineEvent,
    input: {} as WorkflowSchedulerInput,
  },
  actors: {
    runBatch: fromPromise(
      ({ input }: { input: WorkflowBatchInvocationInput }) =>
        runWorkflowBatch(input)
    ),
    runWorkflowHook: fromPromise(
      ({ input }: { input: WorkflowHookInvocationInput }) =>
        Promise.resolve(input.runWorkflowHook(input.event, input.failure))
    ),
  },
  actions: {
    advanceBatch: assign({
      batchIndex: ({ context }) => context.batchIndex + 1,
    }),
    buildCancelledResult: assign({
      result: ({ context }) =>
        context.input.buildResult("CANCELLED", context.nodes),
      status: () => "cancelled" as const,
    }),
    buildFailedResult: assign({
      result: ({ context }) =>
        context.input.buildResult("FAIL", context.nodes, context.failure),
      status: () => "failed" as const,
    }),
    buildPassedResult: assign({
      result: ({ context }) => context.input.buildResult("PASS", context.nodes),
      status: () => "passed" as const,
    }),
    emitWorkflowStart: ({ context }) => {
      context.input.emitWorkflowPlanned();
      context.input.emitWorkflowStarted();
    },
    markBatchFailure: assign({
      failure: ({ context }) =>
        nodeRuntimeFailure(
          context.latestBatchResults.find(
            (result) => result.status === "failed"
          )
        ),
    }),
    markBatchRunning: assign({
      active: ({ context }) =>
        workflowBatchConcurrency(currentBatch(context), context.input),
      queue: ({ context }) =>
        context.batches.slice(context.batchIndex + 1).flat(),
      status: () => "running" as const,
    }),
    markBatchResults: assign({
      active: () => 0,
      completed: ({ context, event }) =>
        event.type === "xstate.done.actor.runBatch"
          ? [...context.completed, ...event.output]
          : context.completed,
      latestBatchResults: ({ event }) =>
        event.type === "xstate.done.actor.runBatch" ? event.output : [],
      nodes: ({ context, event }) =>
        event.type === "xstate.done.actor.runBatch"
          ? [...context.nodes, ...event.output]
          : context.nodes,
    }),
    markCancelled: assign({
      status: () => "cancelled" as const,
    }),
    markCompleteHookFailure: assign({
      failure: ({ context, event }) =>
        context.successHookFailure ??
        (isHookDoneEvent(event)
          ? (event.output ?? context.failure)
          : context.failure),
    }),
    markHookErrorFailure: assign({
      failure: ({ event }) =>
        isHookErrorEvent(event)
          ? workflowServiceFailure(event.error, "workflow.hook")
          : workflowServiceFailure("workflow hook failed", "workflow.hook"),
    }),
    markRunning: assign({
      status: () => "running" as const,
    }),
    markServiceFailure: assign({
      failure: ({ event }) =>
        event.type === "xstate.error.actor.runBatch"
          ? workflowServiceFailure(event.error, "workflow.batch")
          : workflowServiceFailure("workflow service failed", "workflow.batch"),
    }),
    markStartHookFailure: assign({
      failure: ({ event }) =>
        event.type === "xstate.done.actor.workflowStartHook"
          ? (event.output ?? undefined)
          : undefined,
    }),
    markSuccessHookFailure: assign({
      successHookFailure: ({ event }) =>
        event.type === "xstate.done.actor.workflowSuccessHook"
          ? (event.output ?? undefined)
          : undefined,
    }),
  },
  guards: {
    hasBlockingBatchFailure: ({ context }) => {
      const failed = context.latestBatchResults.find(
        (result) => result.status === "failed"
      );
      return (
        Boolean(failed) &&
        !context.latestBatchResults.every((result) =>
          context.input.shouldContinueAfterNodeResult(result)
        )
      );
    },
    hasFailure: ({ context }) => Boolean(context.failure),
    hasMoreBatches: ({ context }) =>
      context.batchIndex < context.batches.length,
    hasWorkflowHookFailure: ({ context }) =>
      Boolean(context.failure ?? context.successHookFailure),
    isCancelled: ({ context }) => context.input.isCancelled(),
  },
}).createMachine({
  id: "workflowScheduler",
  initial: "planning",
  context: ({ input }) => ({
    active: 0,
    batchIndex: 0,
    batches: input.batches,
    completed: [],
    input,
    latestBatchResults: [],
    nodes: [],
    queue: input.nodeIds,
    status: "waiting",
  }),
  states: {
    planning: {
      on: {
        CANCEL: { actions: "markCancelled", target: "cancelling" },
        START: {
          actions: ["markRunning", "emitWorkflowStart"],
          target: "startingHooks",
        },
      },
      tags: ["waiting"],
    },
    startingHooks: {
      invoke: {
        id: "workflowStartHook",
        input: ({ context }) => ({
          event: "workflow.start" as const,
          runWorkflowHook: context.input.runWorkflowHook,
        }),
        onDone: {
          actions: "markStartHookFailure",
          target: "checkingStartHooks",
        },
        onError: {
          actions: "markHookErrorFailure",
          target: "failed",
        },
        src: "runWorkflowHook",
      },
      on: { CANCEL: "cancelling" },
      tags: ["hook", "running"],
    },
    checkingStartHooks: {
      always: [
        { guard: "isCancelled", target: "cancelling" },
        { guard: "hasFailure", target: "failed" },
        { target: "scheduling" },
      ],
    },
    scheduling: {
      always: [
        { guard: "isCancelled", target: "cancelling" },
        {
          actions: "markBatchRunning",
          guard: "hasMoreBatches",
          target: "runningBatch",
        },
        { target: "successHooks" },
      ],
      on: { CANCEL: "cancelling" },
      tags: ["running"],
    },
    runningBatch: {
      invoke: {
        id: "runBatch",
        input: ({ context }) => ({
          batch: currentBatch(context),
          failFast: context.input.failFast,
          markNodeReady: context.input.markNodeReady,
          maxParallelNodes: context.input.maxParallelNodes,
          runNode: context.input.runNode,
          skipNode: context.input.skipNode,
        }),
        onDone: {
          actions: "markBatchResults",
          target: "evaluatingBatch",
        },
        onError: {
          actions: "markServiceFailure",
          target: "failureHooks",
        },
        src: "runBatch",
      },
      on: {
        CANCEL: { actions: "markCancelled", target: "cancelling" },
      },
      tags: ["running"],
    },
    evaluatingBatch: {
      always: [
        { guard: "isCancelled", target: "cancelling" },
        {
          actions: "markBatchFailure",
          guard: "hasBlockingBatchFailure",
          target: "failureHooks",
        },
        { actions: "advanceBatch", target: "scheduling" },
      ],
    },
    failureHooks: {
      invoke: {
        id: "workflowFailureHook",
        input: ({ context }) => ({
          event: "workflow.failure" as const,
          failure: context.failure,
          runWorkflowHook: context.input.runWorkflowHook,
        }),
        onDone: "failureCompleteHooks",
        onError: {
          actions: "markHookErrorFailure",
          target: "failed",
        },
        src: "runWorkflowHook",
      },
      on: { CANCEL: "cancelling" },
      tags: ["failure", "hook", "running"],
    },
    failureCompleteHooks: {
      invoke: {
        id: "workflowCompleteHook",
        input: ({ context }) => ({
          event: "workflow.complete" as const,
          failure: context.failure,
          runWorkflowHook: context.input.runWorkflowHook,
        }),
        onDone: "failed",
        onError: {
          actions: "markHookErrorFailure",
          target: "failed",
        },
        src: "runWorkflowHook",
      },
      on: { CANCEL: "cancelling" },
      tags: ["failure", "hook", "running"],
    },
    successHooks: {
      invoke: {
        id: "workflowSuccessHook",
        input: ({ context }) => ({
          event: "workflow.success" as const,
          runWorkflowHook: context.input.runWorkflowHook,
        }),
        onDone: {
          actions: "markSuccessHookFailure",
          target: "completeHooks",
        },
        onError: {
          actions: "markHookErrorFailure",
          target: "completeHooks",
        },
        src: "runWorkflowHook",
      },
      on: { CANCEL: "cancelling" },
      tags: ["hook", "running"],
    },
    completeHooks: {
      invoke: {
        id: "workflowCompleteHook",
        input: ({ context }) => ({
          event: "workflow.complete" as const,
          runWorkflowHook: context.input.runWorkflowHook,
        }),
        onDone: {
          actions: "markCompleteHookFailure",
          target: "checkingCompleteHooks",
        },
        onError: {
          actions: "markHookErrorFailure",
          target: "checkingCompleteHooks",
        },
        src: "runWorkflowHook",
      },
      on: { CANCEL: "cancelling" },
      tags: ["hook", "running"],
    },
    checkingCompleteHooks: {
      always: [
        { guard: "isCancelled", target: "cancelling" },
        { guard: "hasWorkflowHookFailure", target: "failed" },
        { target: "passed" },
      ],
    },
    cancelling: {
      entry: "buildCancelledResult",
      tags: ["cancelled", "running"],
      always: "cancelled",
    },
    passed: {
      entry: "buildPassedResult",
      tags: ["terminal"],
      type: "final",
    },
    failed: {
      entry: "buildFailedResult",
      tags: ["terminal", "failure"],
      type: "final",
    },
    cancelled: {
      tags: ["terminal", "cancelled"],
      type: "final",
    },
  },
});

export type WorkflowSchedulerActor = ActorRefFrom<
  typeof workflowSchedulerMachine
>;

function runWorkflowBatch(
  input: WorkflowBatchInvocationInput
): Promise<RuntimeNodeResult[]> {
  for (const nodeId of input.batch) {
    input.markNodeReady(nodeId);
  }
  if (input.failFast) {
    return runFailFastWorkflowBatch(input);
  }
  if (!input.maxParallelNodes) {
    return Promise.all(input.batch.map((nodeId) => input.runNode(nodeId)));
  }
  const limit = pLimit(input.maxParallelNodes);
  return Promise.all(
    input.batch.map((nodeId) => limit(() => input.runNode(nodeId)))
  );
}

async function runFailFastWorkflowBatch(
  input: WorkflowBatchInvocationInput
): Promise<RuntimeNodeResult[]> {
  const results: RuntimeNodeResult[] = [];
  for (const [index, nodeId] of input.batch.entries()) {
    const result = await input.runNode(nodeId);
    results.push(result);
    if (result.status === "failed") {
      skipRemainingBatchNodes(input, index + 1, result.nodeId);
      return results;
    }
  }
  return results;
}

function skipRemainingBatchNodes(
  input: WorkflowBatchInvocationInput,
  startIndex: number,
  failedNodeId: string
): void {
  const reason = `skipped because workflow fail_fast stopped after node '${failedNodeId}' failed`;
  for (const nodeId of input.batch.slice(startIndex)) {
    input.skipNode(nodeId, reason);
  }
}

function currentBatch(context: WorkflowSchedulerContext): string[] {
  return context.batches[context.batchIndex] ?? [];
}

function workflowBatchConcurrency(
  batch: string[],
  input: WorkflowSchedulerInput
): number {
  if (batch.length === 0) {
    return 0;
  }
  if (input.failFast) {
    return 1;
  }
  return Math.min(batch.length, input.maxParallelNodes ?? batch.length);
}

function nodeRuntimeFailure(
  node: RuntimeNodeResult | undefined
): RuntimeFailure {
  if (!node) {
    return workflowServiceFailure(
      "workflow failed without a node result",
      "workflow"
    );
  }
  return {
    evidence: node.evidence,
    gate: node.nodeId,
    nodeId: node.nodeId,
    reason: `node '${node.nodeId}' failed`,
  };
}

function workflowServiceFailure(error: unknown, gate: string): RuntimeFailure {
  const reason = error instanceof Error ? error.message : String(error);
  return {
    evidence: [reason],
    gate,
    reason,
  };
}

function isHookDoneEvent(event: WorkflowMachineEvent): event is Extract<
  WorkflowMachineEvent,
  {
    type:
      | "xstate.done.actor.workflowCompleteHook"
      | "xstate.done.actor.workflowFailureHook"
      | "xstate.done.actor.workflowStartHook"
      | "xstate.done.actor.workflowSuccessHook";
  }
> {
  return event.type.startsWith("xstate.done.actor.workflow");
}

function isHookErrorEvent(event: WorkflowMachineEvent): event is Extract<
  WorkflowMachineEvent,
  {
    type:
      | "xstate.error.actor.workflowCompleteHook"
      | "xstate.error.actor.workflowFailureHook"
      | "xstate.error.actor.workflowStartHook"
      | "xstate.error.actor.workflowSuccessHook";
  }
> {
  return event.type.startsWith("xstate.error.actor.workflow");
}
