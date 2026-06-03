import { assign, fromPromise, setup } from "xstate";
import type {
  RuntimeActorDescriptor,
  RuntimeNodeResult,
  WorkflowSchedulerEvent,
} from "./contracts.js";

export interface WorkflowSchedulerInput {
  actor: RuntimeActorDescriptor;
  failFast: boolean;
  maxParallelNodes?: number;
  nodeIds: string[];
  runNode?: (nodeId: string) => Promise<RuntimeNodeResult> | RuntimeNodeResult;
}

interface WorkflowSchedulerContext {
  active: number;
  completed: RuntimeNodeResult[];
  input: WorkflowSchedulerInput;
  queue: string[];
}

export const workflowSchedulerMachine = setup({
  types: {
    context: {} as WorkflowSchedulerContext,
    events: {} as WorkflowSchedulerEvent,
    input: {} as WorkflowSchedulerInput,
  },
  actors: {
    runWorkflowNode: fromPromise(
      ({ input }: { input: WorkflowSchedulerInput }) =>
        Promise.resolve(
          input.runNode
            ? input.runNode(input.nodeIds[0] ?? "")
            : {
                attempts: 1,
                evidence: [],
                exitCode: 0,
                nodeId: input.nodeIds[0] ?? "",
                output: "",
                status: "passed" as const,
              }
        )
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
  },
  guards: {
    hasFailure: ({ context }) =>
      context.completed.some((node) => node.status === "failed"),
  },
}).createMachine({
  id: "workflowScheduler",
  initial: "planning",
  context: ({ input }) => ({
    active: 0,
    completed: [],
    input,
    queue: input.nodeIds,
  }),
  states: {
    planning: {
      on: { CANCEL: "cancelling", START: "startingHooks" },
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
      on: {
        CANCEL: "cancelling",
        NODE_DONE: { actions: "markNodeDone", target: "completingHooks" },
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
      always: [{ guard: "hasFailure", target: "failed" }, { target: "passed" }],
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
