import { type ActorRefFrom, assign, setup } from "xstate";
import type {
  NodeExecutionEvent,
  NodeRetryPolicyContract,
  RuntimeActorDescriptor,
  RuntimeFailure,
  RuntimeGateResult,
  RuntimeNodeResult,
} from "./contracts";

export interface ActorNodeExecutionState {
  attempts: number;
  evidence: string[];
  exitCode?: number;
  failure?: RuntimeFailure;
  finishedAt?: string;
  gates: RuntimeGateResult[];
  id: string;
  output?: string;
  retry?: {
    attempt: number;
    delayMs: number;
    evidence: string[];
    exhausted: boolean;
    gate: string;
    reason: string;
    retryReason: string;
    scheduled: boolean;
  };
  startedAt?: string;
  status:
    | "cancelled"
    | "failed"
    | "gating"
    | "passed"
    | "pending"
    | "ready"
    | "running"
    | "skipped";
}

export interface NodeExecutionInput {
  actor: RuntimeActorDescriptor;
  nodeId: string;
}

interface NodeExecutionContext {
  input: NodeExecutionInput;
  state: ActorNodeExecutionState;
}

export function initialNodeExecutionState(
  nodeId: string
): ActorNodeExecutionState {
  return {
    attempts: 0,
    evidence: [],
    gates: [],
    id: nodeId,
    status: "pending",
  };
}

export const nodeExecutionMachine = setup({
  types: {
    context: {} as NodeExecutionContext,
    events: {} as NodeExecutionEvent,
    input: {} as NodeExecutionInput,
  },
  actions: {
    markReady: assign({
      state: ({ context, event }) =>
        event.type === "READY"
          ? {
              ...context.state,
              startedAt: context.state.startedAt ?? event.at,
              status:
                context.state.status === "pending"
                  ? ("ready" as const)
                  : context.state.status,
            }
          : context.state,
    }),
    markStarted: assign({
      state: ({ context, event }) =>
        event.type === "STARTED"
          ? {
              ...context.state,
              attempts: event.attempt,
              startedAt: context.state.startedAt ?? event.at,
              status: "running" as const,
            }
          : context.state,
    }),
    markRunnerFinished: assign({
      state: ({ context, event }) =>
        event.type === "RUNNER_FINISHED"
          ? {
              ...context.state,
              evidence: event.evidence,
              exitCode: event.exitCode,
              output: event.output,
              status: "running" as const,
            }
          : context.state,
    }),
    markGating: assign({
      state: ({ context }) => ({
        ...context.state,
        status: "gating" as const,
      }),
    }),
    markGatesFinished: assign({
      state: ({ context, event }) =>
        event.type === "GATES_FINISHED"
          ? {
              ...context.state,
              gates: event.gates,
            }
          : context.state,
    }),
    markRetrying: assign({
      state: ({ context, event }) =>
        event.type === "RETRYING"
          ? {
              ...context.state,
              attempts: event.attempt,
              evidence: event.evidence,
              retry: nodeRetryDecision(event),
              status: "running" as const,
            }
          : context.state,
    }),
    markPassed: assign({
      state: ({ context, event }) =>
        event.type === "PASSED"
          ? stateFromResult(context.state, event.result, event.at, "passed")
          : context.state,
    }),
    markFailed: assign({
      state: ({ context, event }) =>
        event.type === "FAILED"
          ? {
              ...stateFromResult(
                context.state,
                event.result,
                event.at,
                "failed"
              ),
              failure: event.failure,
            }
          : context.state,
    }),
    markCancelled: assign({
      state: ({ context, event }) =>
        event.type === "CANCELLED"
          ? {
              ...context.state,
              failure: event.failure,
              finishedAt: event.at,
              status: "cancelled" as const,
            }
          : context.state,
    }),
    markSkipped: assign({
      state: ({ context, event }) =>
        event.type === "SKIPPED"
          ? {
              ...context.state,
              failure: {
                evidence: [event.reason],
                gate: context.state.id,
                nodeId: context.state.id,
                reason: event.reason,
              },
              finishedAt: event.at,
              status: "skipped" as const,
            }
          : context.state,
    }),
  },
}).createMachine({
  id: "nodeExecution",
  initial: "pending",
  context: ({ input }) => ({
    input,
    state: initialNodeExecutionState(input.nodeId),
  }),
  on: {
    CANCELLED: { actions: "markCancelled", target: ".cancelled" },
  },
  states: {
    pending: {
      on: {
        READY: { actions: "markReady", target: "ready" },
        SKIPPED: { actions: "markSkipped", target: "skipped" },
      },
      tags: ["waiting"],
    },
    ready: {
      on: {
        STARTED: { actions: "markStarted", target: "startingHooks" },
        SKIPPED: { actions: "markSkipped", target: "skipped" },
      },
      tags: ["waiting"],
    },
    startingHooks: {
      on: {
        CANCELLED: { actions: "markCancelled", target: "cancelled" },
        FAILED: { actions: "markFailed", target: "failed" },
        START_HOOKS_FINISHED: "snapshotBefore",
      },
      tags: ["hook", "running"],
    },
    snapshotBefore: {
      on: { SNAPSHOT_BEFORE_FINISHED: "runnerStarting" },
      tags: ["running"],
    },
    runnerStarting: {
      on: { RUNNER_STARTED: "runnerRunning" },
      tags: ["runner", "running"],
    },
    runnerRunning: {
      on: {
        RUNNER_FINISHED: {
          actions: "markRunnerFinished",
          target: "runnerFinished",
        },
        CANCELLED: { actions: "markCancelled", target: "cancelled" },
      },
      tags: ["runner", "running"],
    },
    runnerFinished: {
      on: { OUTPUT_RECORDED: "outputRecording" },
      tags: ["runner", "running"],
    },
    outputRecording: {
      on: { SNAPSHOT_AFTER_FINISHED: "snapshotAfter" },
      tags: ["running"],
    },
    snapshotAfter: {
      on: { GATES_STARTED: { actions: "markGating", target: "gatesStarting" } },
      tags: ["running"],
    },
    gatesStarting: {
      always: "gatesRunning",
      tags: ["gate", "running"],
    },
    gatesRunning: {
      on: {
        GATES_FINISHED: {
          actions: "markGatesFinished",
          target: "gatesFinished",
        },
      },
      tags: ["gate", "running"],
    },
    gatesFinished: {
      on: {
        CANCELLED: { actions: "markCancelled", target: "cancelled" },
        FAILED: { actions: "markFailed", target: "failed" },
        PASSED: { actions: "markPassed", target: "passed" },
        RETRYING: { actions: "markRetrying", target: "retrying" },
        SUCCESS_HOOKS_STARTED: "successHooks",
      },
      tags: ["gate", "running"],
    },
    successHooks: {
      on: {
        FAILED: { actions: "markFailed", target: "failed" },
        PASSED: { actions: "markPassed", target: "passed" },
      },
      tags: ["hook", "running"],
    },
    retrying: {
      on: {
        FAILED: { actions: "markFailed", target: "failed" },
        STARTED: { actions: "markStarted", target: "startingHooks" },
      },
      tags: ["retrying", "running"],
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
    skipped: {
      tags: ["terminal"],
      type: "final",
    },
  },
});

function stateFromResult(
  state: ActorNodeExecutionState,
  result: RuntimeNodeResult,
  at: string,
  status: "failed" | "passed"
): ActorNodeExecutionState {
  return {
    ...state,
    attempts: result.attempts,
    evidence: result.evidence,
    exitCode: result.exitCode,
    finishedAt: at,
    output: result.output,
    status,
  };
}

function nodeRetryDecision(
  event: Extract<NodeExecutionEvent, { type: "RETRYING" }>
): NonNullable<ActorNodeExecutionState["retry"]> {
  const scheduled =
    event.policy.retryOn.includes(event.retryReason) &&
    event.attempt < event.policy.maxAttempts;
  return {
    attempt: event.attempt,
    delayMs: scheduled ? retryDelayMs(event.policy, event.attempt) : 0,
    evidence: event.evidence,
    exhausted: !scheduled,
    gate: event.gate,
    reason: event.reason,
    retryReason: event.retryReason,
    scheduled,
  };
}

function retryDelayMs(
  policy: NodeRetryPolicyContract,
  attempt: number
): number {
  return (
    policy.backoffMs *
    Math.max(1, policy.multiplier) ** Math.max(0, attempt - 1)
  );
}

export type NodeExecutionActor = ActorRefFrom<typeof nodeExecutionMachine>;
