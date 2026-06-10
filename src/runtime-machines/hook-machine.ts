import { assign, fromPromise, setup } from "xstate";
import type {
  HookInvocationEvent,
  RuntimeActorDescriptor,
  RuntimeFailure,
  RuntimeObservabilityEmitter,
} from "./contracts";

interface HookInvocationResult {
  failure?: RuntimeFailure;
  reason?: string;
  status: "passed" | "failed" | "timedOut" | "skipped";
}

interface HookInvocationInput {
  actor: RuntimeActorDescriptor;
  emit?: RuntimeObservabilityEmitter;
  execute: () => Promise<HookInvocationResult> | HookInvocationResult;
  hookId: string;
  nodeId?: string;
  required: boolean;
  skipReason?: string;
}

interface HookInvocationContext {
  input: HookInvocationInput;
  result?: HookInvocationResult;
}

type HookMachineEvent =
  | HookInvocationEvent
  | {
      output: HookInvocationResult;
      type: "xstate.done.actor.runHook";
    }
  | {
      error: unknown;
      type: "xstate.error.actor.runHook";
    };

function hookTimestamp(): string {
  return new Date().toISOString();
}

function emitHookResult(
  input: HookInvocationInput,
  result: HookInvocationResult
): void {
  if (result.status === "skipped") {
    input.emit?.({
      actor: input.actor,
      hookId: input.hookId,
      nodeId: input.nodeId,
      reason: result.reason ?? "hook skipped",
      timestamp: hookTimestamp(),
      type: "runtime.hook.skipped",
    });
    return;
  }
  input.emit?.({
    actor: input.actor,
    hookId: input.hookId,
    nodeId: input.nodeId,
    passed: result.status === "passed",
    reason: result.reason ?? result.failure?.reason,
    timestamp: hookTimestamp(),
    type: "runtime.hook.finished",
  });
  if (result.status === "failed") {
    input.emit?.({
      actor: input.actor,
      hookId: input.hookId,
      nodeId: input.nodeId,
      reason: result.reason ?? result.failure?.reason ?? "hook failed",
      timestamp: hookTimestamp(),
      type: "runtime.hook.failed",
    });
  }
  if (result.status === "timedOut") {
    input.emit?.({
      actor: input.actor,
      hookId: input.hookId,
      nodeId: input.nodeId,
      reason: result.reason ?? "hook timed out",
      timestamp: hookTimestamp(),
      type: "runtime.hook.timedOut",
    });
  }
}

export const hookInvocationMachine = setup({
  types: {
    context: {} as HookInvocationContext,
    events: {} as HookMachineEvent,
    input: {} as HookInvocationInput,
  },
  actors: {
    runHook: fromPromise(({ input }: { input: HookInvocationInput }) =>
      input.skipReason
        ? Promise.resolve({
            reason: input.skipReason,
            status: "skipped" as const,
          })
        : Promise.resolve(input.execute())
    ),
  },
  actions: {
    markResult: assign({
      result: ({ event }) =>
        event.type === "xstate.done.actor.runHook" ? event.output : undefined,
    }),
    markThrownFailure: assign({
      result: ({ event, context }) =>
        event.type === "xstate.error.actor.runHook"
          ? {
              failure: {
                evidence: [
                  event.error instanceof Error
                    ? event.error.message
                    : String(event.error),
                ],
                gate: context.input.hookId,
                nodeId: context.input.nodeId,
                reason: `hook '${context.input.hookId}' failed`,
              },
              reason:
                event.error instanceof Error
                  ? event.error.message
                  : String(event.error),
              status: "failed" as const,
            }
          : undefined,
    }),
    markSkippedResult: assign({
      result: ({ context }) =>
        context.result ?? {
          reason: context.input.skipReason ?? "hook skipped",
          status: "skipped" as const,
        },
    }),
    emitStarted: ({ context }) => {
      context.input.emit?.({
        actor: context.input.actor,
        hookId: context.input.hookId,
        nodeId: context.input.nodeId,
        timestamp: hookTimestamp(),
        type: "runtime.hook.started",
      });
    },
    emitResult: ({ context }) => {
      if (context.result) {
        emitHookResult(context.input, context.result);
      }
    },
  },
  guards: {
    isFailed: ({ context }) => context.result?.status === "failed",
    isSkipped: ({ context }) => context.result?.status === "skipped",
    isTimedOut: ({ context }) => context.result?.status === "timedOut",
  },
}).createMachine({
  id: "hookInvocation",
  initial: "queued",
  context: ({ input }) => ({ input }),
  states: {
    queued: {
      tags: ["waiting", "hook"],
      on: {
        CANCEL: { target: "skipped" },
        START: { target: "running" },
      },
    },
    running: {
      entry: "emitStarted",
      invoke: {
        id: "runHook",
        input: ({ context }) => context.input,
        onDone: {
          actions: "markResult",
          target: "classifyResult",
        },
        onError: {
          actions: "markThrownFailure",
          target: "failed",
        },
        src: "runHook",
      },
      tags: ["running", "hook"],
    },
    classifyResult: {
      always: [
        { guard: "isSkipped", target: "skipped" },
        { guard: "isTimedOut", target: "timedOut" },
        { guard: "isFailed", target: "failed" },
        { target: "passed" },
      ],
    },
    passed: {
      entry: "emitResult",
      tags: ["terminal", "hook"],
      type: "final",
    },
    failed: {
      entry: "emitResult",
      tags: ["terminal", "failure", "hook"],
      type: "final",
    },
    timedOut: {
      entry: "emitResult",
      tags: ["terminal", "failure", "hook"],
      type: "final",
    },
    skipped: {
      entry: ["markSkippedResult", "emitResult"],
      tags: ["terminal", "cancelled", "hook"],
      type: "final",
    },
  },
});
