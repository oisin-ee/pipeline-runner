import { assign, fromPromise, setup } from "xstate";
import type {
  GateEvaluationEvent,
  RuntimeActorDescriptor,
  RuntimeGateResult,
  RuntimeObservabilityEmitter,
} from "./contracts";

interface GateEvaluationInput {
  actor: RuntimeActorDescriptor;
  emit?: RuntimeObservabilityEmitter;
  evaluate: () => Promise<RuntimeGateResult> | RuntimeGateResult;
  gateId: string;
  kind: string;
  nodeId: string;
}

interface GateEvaluationContext {
  input: GateEvaluationInput;
  result?: RuntimeGateResult;
}

type GateMachineEvent =
  | GateEvaluationEvent
  | {
      output: RuntimeGateResult;
      type: "xstate.done.actor.evaluateGate";
    }
  | {
      error: unknown;
      type: "xstate.error.actor.evaluateGate";
    };

function gateTimestamp(): string {
  return new Date().toISOString();
}

export const gateEvaluationMachine = setup({
  types: {
    context: {} as GateEvaluationContext,
    events: {} as GateMachineEvent,
    input: {} as GateEvaluationInput,
  },
  actors: {
    evaluateGate: fromPromise(({ input }: { input: GateEvaluationInput }) =>
      Promise.resolve(input.evaluate())
    ),
  },
  actions: {
    markResult: assign({
      result: ({ event }) =>
        event.type === "xstate.done.actor.evaluateGate"
          ? event.output
          : undefined,
    }),
    markThrownFailure: assign({
      result: ({ event, context }) =>
        event.type === "xstate.error.actor.evaluateGate"
          ? {
              evidence: [
                event.error instanceof Error
                  ? event.error.message
                  : String(event.error),
              ],
              gateId: context.input.gateId,
              kind: context.input.kind,
              nodeId: context.input.nodeId,
              passed: false,
              reason:
                event.error instanceof Error
                  ? event.error.message
                  : "gate evaluation failed",
            }
          : undefined,
    }),
    emitStarted: ({ context }) => {
      context.input.emit?.({
        actor: context.input.actor,
        gateId: context.input.gateId,
        kind: context.input.kind,
        nodeId: context.input.nodeId,
        timestamp: gateTimestamp(),
        type: "runtime.gate.started",
      });
    },
    emitResult: ({ context }) => {
      const result = context.result;
      if (!result) {
        return;
      }
      context.input.emit?.({
        actor: context.input.actor,
        gateId: result.gateId,
        kind: result.kind,
        nodeId: result.nodeId,
        passed: result.passed,
        reason: result.reason,
        timestamp: gateTimestamp(),
        type: "runtime.gate.finished",
      });
      if (!result.passed) {
        context.input.emit?.({
          actor: context.input.actor,
          gateId: result.gateId,
          kind: result.kind,
          nodeId: result.nodeId,
          reason: result.reason ?? "gate failed",
          timestamp: gateTimestamp(),
          type: "runtime.gate.failed",
        });
      }
    },
    emitCancelled: ({ context, event }) => {
      context.input.emit?.({
        actor: context.input.actor,
        gateId: context.input.gateId,
        kind: context.input.kind,
        nodeId: context.input.nodeId,
        reason:
          event.type === "CANCEL"
            ? (event.reason ?? "gate cancelled")
            : "gate cancelled",
        timestamp: gateTimestamp(),
        type: "runtime.gate.cancelled",
      });
    },
  },
  guards: {
    passed: ({ context }) => context.result?.passed === true,
  },
}).createMachine({
  id: "gateEvaluation",
  initial: "pending",
  context: ({ input }) => ({ input }),
  states: {
    pending: {
      tags: ["waiting", "gate"],
      on: {
        CANCEL: { actions: "emitCancelled", target: "cancelled" },
        START: { target: "running" },
      },
    },
    running: {
      entry: "emitStarted",
      invoke: {
        id: "evaluateGate",
        input: ({ context }) => context.input,
        onDone: {
          actions: "markResult",
          target: "classifyResult",
        },
        onError: {
          actions: "markThrownFailure",
          target: "failed",
        },
        src: "evaluateGate",
      },
      tags: ["running", "gate"],
    },
    classifyResult: {
      always: [{ guard: "passed", target: "passed" }, { target: "failed" }],
    },
    passed: {
      entry: "emitResult",
      tags: ["terminal", "gate"],
      type: "final",
    },
    failed: {
      entry: "emitResult",
      tags: ["terminal", "failure", "gate"],
      type: "final",
    },
    timedOut: {
      tags: ["terminal", "failure", "gate"],
      type: "final",
    },
    cancelled: {
      tags: ["terminal", "cancelled", "gate"],
      type: "final",
    },
  },
});
