import { alg, Graph } from "@dagrejs/graphlib";
import {
  type ActorRefFrom,
  assign,
  enqueueActions,
  fromCallback,
  fromPromise,
  setup,
} from "xstate";
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

export interface WorkflowScheduleNode {
  dependents: string[];
  id: string;
  index: number;
  needs: string[];
}

export interface WorkflowSchedulerInput {
  actor: RuntimeActorDescriptor;
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
  nodes: WorkflowScheduleNode[];
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
  blocked: string[];
  completed: RuntimeNodeResult[];
  failure?: RuntimeFailure;
  graph: Graph<undefined, WorkflowScheduleNode>;
  input: WorkflowSchedulerInput;
  latestNodeResult?: RuntimeNodeResult;
  nodes: RuntimeNodeResult[];
  queue: string[];
  result?: WorkflowSchedulerResult;
  running: string[];
  status: "cancelled" | "failed" | "passed" | "running" | "waiting";
  successHookFailure?: RuntimeFailure;
}

interface WorkflowHookInvocationInput {
  event: WorkflowHookEvent;
  failure?: RuntimeFailure;
  runWorkflowHook: WorkflowSchedulerInput["runWorkflowHook"];
}

interface WorkflowNodeInvocationInput {
  nodeId: string;
  runNode: WorkflowSchedulerInput["runNode"];
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
      result: RuntimeNodeResult;
      type: "NODE_DONE";
    }
  | {
      error: unknown;
      nodeId: string;
      type: "NODE_ERROR";
    };

export const workflowSchedulerMachine = setup({
  types: {
    context: {} as WorkflowSchedulerContext,
    events: {} as WorkflowMachineEvent,
    input: {} as WorkflowSchedulerInput,
  },
  actors: {
    runNode: fromCallback<WorkflowMachineEvent, WorkflowNodeInvocationInput>(
      ({ input, sendBack }) => {
        let stopped = false;
        input
          .runNode(input.nodeId)
          .then((result) => {
            if (!stopped) {
              sendBack({ result, type: "NODE_DONE" });
            }
          })
          .catch((error: unknown) => {
            if (!stopped) {
              sendBack({ error, nodeId: input.nodeId, type: "NODE_ERROR" });
            }
          });
        return () => {
          stopped = true;
        };
      }
    ),
    runWorkflowHook: fromPromise(
      ({ input }: { input: WorkflowHookInvocationInput }) =>
        Promise.resolve(input.runWorkflowHook(input.event, input.failure))
    ),
  },
  actions: {
    blockFailedNodeDescendants: assign({
      blocked: ({ context }) =>
        context.latestNodeResult &&
        isBlockingFailure(context.latestNodeResult, context)
          ? uniqueStrings([
              ...context.blocked,
              ...(context.input.failFast
                ? unstartedNodeIds(context)
                : unstartedBlockingDescendants(
                    context.latestNodeResult.nodeId,
                    context
                  )),
            ])
          : context.blocked,
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
    markReadyNodesRunning: assign({
      active: ({ context }) =>
        context.running.length + nextLaunchableNodeIds(context).length,
      queue: ({ context }) =>
        queuedReadyNodeIds(context, nextLaunchableNodeIds(context)),
      running: ({ context }) => [
        ...context.running,
        ...nextLaunchableNodeIds(context),
      ],
      status: () => "running" as const,
    }),
    spawnReadyNodeActors: enqueueActions(({ context, enqueue }) => {
      const nodeIds = nextLaunchableNodeIds(context);
      for (const nodeId of nodeIds) {
        context.input.markNodeReady(nodeId);
        enqueue.spawnChild("runNode", {
          id: nodeRunActorId(nodeId),
          input: {
            nodeId,
            runNode: context.input.runNode,
          },
        });
      }
    }),
    stopErroredNodeActor: enqueueActions(({ event, enqueue }) => {
      if (event.type === "NODE_ERROR") {
        enqueue.stopChild(nodeRunActorId(event.nodeId));
      }
    }),
    stopFinishedNodeActor: enqueueActions(({ event, enqueue }) => {
      if (event.type === "NODE_DONE") {
        enqueue.stopChild(nodeRunActorId(event.result.nodeId));
      }
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
    markNodeFailure: assign({
      failure: ({ context }) =>
        context.latestNodeResult &&
        isBlockingFailure(context.latestNodeResult, context)
          ? (context.failure ?? nodeRuntimeFailure(context.latestNodeResult))
          : context.failure,
    }),
    markNodeResult: assign({
      active: ({ context, event }) =>
        event.type === "NODE_DONE"
          ? Math.max(0, context.running.length - 1)
          : context.active,
      completed: ({ context, event }) =>
        event.type === "NODE_DONE"
          ? [...context.completed, event.result]
          : context.completed,
      latestNodeResult: ({ event }) =>
        event.type === "NODE_DONE" ? event.result : undefined,
      nodes: ({ context, event }) =>
        event.type === "NODE_DONE"
          ? [...context.nodes, event.result]
          : context.nodes,
      queue: ({ context }) => readyNodeIds(context),
      running: ({ context, event }) =>
        event.type === "NODE_DONE"
          ? context.running.filter((nodeId) => nodeId !== event.result.nodeId)
          : context.running,
    }),
    markRunning: assign({
      status: () => "running" as const,
    }),
    markServiceFailure: assign({
      failure: ({ event }) =>
        event.type === "NODE_ERROR"
          ? workflowServiceFailure(event.error, "workflow.node")
          : workflowServiceFailure("workflow service failed", "workflow.node"),
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
    skipUnstartedAfterFailFast: ({ context }) => {
      const failedNode = context.latestNodeResult;
      if (
        context.input.failFast &&
        failedNode &&
        isBlockingFailure(failedNode, context)
      ) {
        const reason = `skipped because workflow fail_fast stopped after node '${failedNode.nodeId}' failed`;
        for (const nodeId of unstartedNodeIds(context)) {
          context.input.skipNode(nodeId, reason);
        }
      }
    },
  },
  guards: {
    hasActiveNodes: ({ context }) => context.running.length > 0,
    hasBlockingFailure: ({ context }) => Boolean(context.failure),
    hasLaunchableNodes: ({ context }) =>
      nextLaunchableNodeIds(context).length > 0,
    hasWorkflowHookFailure: ({ context }) =>
      Boolean(context.failure ?? context.successHookFailure),
    isCancelled: ({ context }) => context.input.isCancelled(),
    isFailFastBlockingFailure: ({ context }) =>
      context.input.failFast &&
      Boolean(
        context.latestNodeResult &&
          isBlockingFailure(context.latestNodeResult, context)
      ),
  },
}).createMachine({
  id: "workflowScheduler",
  initial: "planning",
  context: ({ input }) => ({
    active: 0,
    blocked: [],
    completed: [],
    graph: workflowScheduleGraph(input.nodes),
    input,
    nodes: [],
    queue: input.nodes.map((node) => node.id),
    running: [],
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
        { guard: "hasBlockingFailure", target: "failed" },
        { target: "scheduling" },
      ],
    },
    scheduling: {
      always: [
        { guard: "isCancelled", target: "cancelling" },
        {
          actions: ["spawnReadyNodeActors", "markReadyNodesRunning"],
          guard: "hasLaunchableNodes",
          target: "runningGraph",
        },
        { guard: "hasActiveNodes", target: "runningGraph" },
        { guard: "hasBlockingFailure", target: "failureHooks" },
        { target: "successHooks" },
      ],
      on: { CANCEL: "cancelling" },
      tags: ["running"],
    },
    runningGraph: {
      on: {
        CANCEL: { actions: "markCancelled", target: "cancelling" },
        NODE_DONE: {
          actions: [
            "markNodeResult",
            "stopFinishedNodeActor",
            "markNodeFailure",
            "skipUnstartedAfterFailFast",
            "blockFailedNodeDescendants",
          ],
          target: "scheduling",
        },
        NODE_ERROR: {
          actions: ["markServiceFailure", "stopErroredNodeActor"],
          target: "failureHooks",
        },
      },
      tags: ["running"],
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

function workflowScheduleGraph(
  nodes: WorkflowScheduleNode[]
): Graph<undefined, WorkflowScheduleNode> {
  const graph = new Graph<undefined, WorkflowScheduleNode>();
  const orderedNodes = [...nodes].sort(compareScheduleNodeIndex);
  for (const node of orderedNodes) {
    graph.setNode(node.id, node);
  }
  for (const node of orderedNodes) {
    for (const need of node.needs) {
      if (graph.hasNode(need)) {
        graph.setEdge(need, node.id);
      }
    }
  }
  return graph;
}

function compareScheduleNodeIndex(
  a: WorkflowScheduleNode,
  b: WorkflowScheduleNode
): number {
  return a.index - b.index;
}

function nextLaunchableNodeIds(context: WorkflowSchedulerContext): string[] {
  const capacity = workflowNodeCapacity(context);
  if (capacity <= 0) {
    return [];
  }
  return readyNodeIds(context).slice(0, capacity);
}

function queuedReadyNodeIds(
  context: WorkflowSchedulerContext,
  launched: string[]
): string[] {
  const launchedSet = new Set(launched);
  return readyNodeIds(context).filter((nodeId) => !launchedSet.has(nodeId));
}

function readyNodeIds(context: WorkflowSchedulerContext): string[] {
  const blocked = new Set(context.blocked);
  const completed = new Set(context.completed.map((result) => result.nodeId));
  const running = new Set(context.running);
  return context.input.nodes
    .filter((node) => !completed.has(node.id))
    .filter((node) => !running.has(node.id))
    .filter((node) => !blocked.has(node.id))
    .filter((node) =>
      node.needs.every((need) => dependencyPassed(need, context))
    )
    .map((node) => node.id);
}

function dependencyPassed(
  nodeId: string,
  context: WorkflowSchedulerContext
): boolean {
  const result = context.completed.find((item) => item.nodeId === nodeId);
  return result ? context.input.shouldContinueAfterNodeResult(result) : false;
}

function workflowNodeCapacity(context: WorkflowSchedulerContext): number {
  const limit = context.input.failFast
    ? 1
    : (context.input.maxParallelNodes ?? context.input.nodes.length);
  return Math.max(0, limit - context.running.length);
}

function isBlockingFailure(
  result: RuntimeNodeResult,
  context: WorkflowSchedulerContext
): boolean {
  return (
    result.status === "failed" &&
    !context.input.shouldContinueAfterNodeResult(result)
  );
}

function unstartedBlockingDescendants(
  nodeId: string,
  context: WorkflowSchedulerContext
): string[] {
  const unstarted = new Set(unstartedNodeIds(context));
  return alg
    .preorder(context.graph, nodeId)
    .slice(1)
    .filter((descendantId) => unstarted.has(descendantId));
}

function unstartedNodeIds(context: WorkflowSchedulerContext): string[] {
  const completed = new Set(context.completed.map((result) => result.nodeId));
  const running = new Set(context.running);
  return context.input.nodes
    .map((node) => node.id)
    .filter((nodeId) => !completed.has(nodeId))
    .filter((nodeId) => !running.has(nodeId));
}

function nodeRunActorId(nodeId: string): string {
  return `runNode:${nodeId}`;
}

function uniqueStrings(items: string[]): string[] {
  return [...new Set(items)];
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
