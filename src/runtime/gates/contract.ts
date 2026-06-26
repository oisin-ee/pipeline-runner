import type { Effect } from "effect";
import type { PlannedWorkflowNode } from "../../planning/compile";
import type { CommandExecutionContext } from "../command-executor";
import type {
  CommandExecutionOptions,
  GateSpec,
  NodeAttemptResult,
  RuntimeContext,
  RuntimeGateResult,
} from "../contracts";

/**
 * The discriminant that keys the gate dispatch table. Derived from the
 * {@link GateSpec} union so the registry's `Record<GateKind, GateEvaluator>`
 * stays exhaustive by construction: adding a gate kind to the config schema
 * surfaces a missing-key compile error here instead of a silent runtime gap.
 */
export type GateKind = GateSpec["kind"];

/**
 * The command-executor seam a command gate evaluates through. Kept as a
 * structural interface (not the live service tag) so evaluators stay unit
 * testable with a plain stub.
 */
export interface CommandExecutorService {
  readonly execute: (
    command: string[],
    context: CommandExecutionContext,
    options?: CommandExecutionOptions
  ) => Effect.Effect<NodeAttemptResult, unknown>;
}

/**
 * Everything a gate evaluator may need, bundled so every kind shares one
 * uniform call shape. The dispatch table maps each {@link GateKind} to a
 * {@link GateEvaluator}; the orchestrator builds this input once per gate.
 */
export interface GateEvaluationInput {
  attempt: NodeAttemptResult;
  context: RuntimeContext;
  executor: CommandExecutorService;
  gate: GateSpec;
  gateId: string;
  node?: PlannedWorkflowNode;
  nodeId: string;
}

/**
 * A single gate kind's evaluation step. Synchronous kinds return the result
 * directly; I/O-bound kinds (command, builtin) return a promise.
 */
export type GateEvaluator = (
  input: GateEvaluationInput
) => RuntimeGateResult | Promise<RuntimeGateResult>;

export type GateFailureHook = (
  node: PlannedWorkflowNode,
  result: RuntimeGateResult
) => Promise<void> | void;
