import { type ActorRefFrom, assign, fromPromise, setup } from "xstate";
import type {
  RuntimeActorDescriptor,
  RuntimeNodeResult,
  WorkflowSchedulerEvent,
  WorkflowSchedulerResult,
} from "./contracts.js";

export interface WorkflowSchedulerInput {
  actor: RuntimeActorDescriptor;
  failFast: boolean;
  maxParallelNodes?: number;
  nodeIds: string[];
  runWorkflow: () => Promise<WorkflowSchedulerResult> | WorkflowSchedulerResult;
}

interface WorkflowSchedulerContext {
  active: number;
  completed: RuntimeNodeResult[];
  input: WorkflowSchedulerInput;
  queue: string[];
  result?: WorkflowSchedulerResult;
  status: "cancelled" | "failed" | "passed" | "running" | "waiting";
}

type WorkflowMachineEvent =
  | WorkflowSchedulerEvent
  | {
      output: WorkflowSchedulerResult;
      type: "xstate.done.actor.runWorkflow";
    }
  | {
      error: unknown;
      type: "xstate.error.actor.runWorkflow";
    };

export const workflowSchedulerMachine = setup({
  types: {
    context: {} as WorkflowSchedulerContext,
    events: {} as WorkflowMachineEvent,
    input: {} as WorkflowSchedulerInput,
  },
  actors: {
    runWorkflow: fromPromise(({ input }: { input: WorkflowSchedulerInput }) =>
      Promise.resolve(input.runWorkflow())
    ),
  },
  actions: {
    markNodeDone: assign({
      active: ({ context }) => Math.max(0, context.active - 1),
      completed: ({ context, event }) =>
        event.type === "NODE_DONE"
          ? [...context.completed, event.result]
          : context.completed,
    }),
    markRunning: assign({
      status: () => "running" as const,
    }),
    markCancelled: assign({
      status: () => "cancelled" as const,
    }),
    markFailed: assign({
      status: () => "failed" as const,
    }),
    markPassed: assign({
      status: () => "passed" as const,
    }),
    markResult: assign({
      result: ({ event }) =>
        event.type === "xstate.done.actor.runWorkflow"
          ? event.output
          : undefined,
    }),
  },
  guards: {
    hasFailure: ({ context }) =>
      context.result?.outcome === "FAIL" ||
      context.completed.some((node) => node.status === "failed"),
    isCancelled: ({ context }) => context.result?.outcome === "CANCELLED",
  },
}).createMachine({
  id: "workflowScheduler",
  initial: "planning",
  context: ({ input }) => ({
    active: 0,
    completed: [],
    input,
    queue: input.nodeIds,
    status: "waiting",
  }),
  states: {
    planning: {
      on: {
        CANCEL: { actions: "markCancelled", target: "cancelling" },
        START: { actions: "markRunning", target: "startingHooks" },
      },
      tags: ["waiting"],
    },
    startingHooks: {
      on: { CANCEL: "cancelling" },
      tags: ["hook", "running"],
      always: "scheduling",
    },
    scheduling: {
      on: { CANCEL: "cancelling" },
      tags: ["running"],
      always: "runningBatch",
    },
    runningBatch: {
      invoke: {
        id: "runWorkflow",
        input: ({ context }) => context.input,
        onDone: {
          actions: "markResult",
          target: "completingHooks",
        },
        onError: {
          actions: "markFailed",
          target: "failed",
        },
        src: "runWorkflow",
      },
      on: {
        CANCEL: { actions: "markCancelled", target: "cancelling" },
        COMPLETE: "completingHooks",
        NODE_DONE: { actions: "markNodeDone" },
      },
      tags: ["running"],
    },
    failFastStopping: {
      tags: ["failure", "running"],
      always: "completingHooks",
    },
    cancelling: {
      tags: ["cancelled", "running"],
      always: "cancelled",
    },
    completingHooks: {
      tags: ["hook", "running"],
      always: [
        { actions: "markCancelled", guard: "isCancelled", target: "cancelled" },
        { actions: "markFailed", guard: "hasFailure", target: "failed" },
        { actions: "markPassed", target: "passed" },
      ],
    },
    passed: {
      tags: ["terminal"],
      type: "final",
    },
    failed: {
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
