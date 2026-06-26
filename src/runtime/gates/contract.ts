import type { Effect } from "effect";
import type { PlannedWorkflowNode } from "../../planning/compile";
import type { CommandExecutionContext } from "../command-executor";
import type {
  CommandExecutionOptions,
  GateSpec,
  NodeAttemptResult,
  RuntimeContext,
  RuntimeGateResult,
  UnmetCriterion,
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

/**
 * The adjudicator's terminal output (PIPE-90.10): the composed verdict of the
 * layered completion gate (deterministic -> structured-claim -> llm-judge). A
 * passing verdict carries an empty `unmet`; a refusal carries every distinct
 * failing {@link UnmetCriterion} aggregated across all layers (deduped by
 * criterion id), so `passed === (unmet.length === 0)` always holds. Defined on
 * the gate contract surface so PIPE-90.11 can consume it without depending on
 * the adjudicator's internals.
 */
export interface GateVerdict {
  readonly passed: boolean;
  readonly unmet: UnmetCriterion[];
}

/**
 * Descriptor that pairs a gate kind with its uniform evaluator. The registry
 * reduces an array of these into `Record<GateKind, GateEvaluator>`.
 * Later kinds (structured-claim, llm-judge) add a new descriptor + one entry
 * in the registry object — no other files change.
 */
export interface GateKindModule {
  readonly evaluate: GateEvaluator;
  readonly kind: GateKind;
}

/**
 * User-defined type guard: narrows a gate to its variant for a generic kind
 * `K`. A bare `gate.kind === kind` comparison does not narrow the discriminated
 * union when `kind` is a type parameter, so this guard carries the narrowing
 * without a type assertion.
 */
function hasKind<K extends GateKind>(
  gate: GateSpec,
  kind: K
): gate is Extract<GateSpec, { kind: K }> {
  return gate.kind === kind;
}

/**
 * Binds one gate kind to its narrowly-typed evaluator and adapts it to the
 * uniform {@link GateEvaluator} shape. The {@link hasKind} guard narrows the
 * input gate to the kind's variant; it also fails loud if a module is ever
 * wired to the wrong key, surfacing the bug instead of silently evaluating the
 * wrong gate.
 */
export function forKind<K extends GateKind>(
  kind: K,
  evaluate: (
    gate: Extract<GateSpec, { kind: K }>,
    input: GateEvaluationInput
  ) => ReturnType<GateEvaluator>
): GateEvaluator {
  return (input) => {
    if (!hasKind(input.gate, kind)) {
      throw new Error(
        `gate registry mismatch: handler '${kind}' received '${input.gate.kind}'`
      );
    }
    return evaluate(input.gate, input);
  };
}
