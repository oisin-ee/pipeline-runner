import type { GateSpec } from "../contracts";
import type { GateEvaluationInput, GateEvaluator, GateKind } from "./contract";
import {
  evaluateAcceptanceGate,
  evaluateArtifactGate,
  evaluateBuiltinGate,
  evaluateChangedFilesGate,
  evaluateCommandGate,
  evaluateJsonSchemaGate,
  evaluateVerdictGate,
} from "./gates";

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
 * input gate to the kind's variant; it also fails loud if the registry is ever
 * wired to the wrong key, surfacing the bug instead of silently evaluating the
 * wrong gate.
 */
function forKind<K extends GateKind>(
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

/**
 * The gate dispatch table — one entry per {@link GateKind}, replacing the former
 * kind-discriminated branch ladder. Typed as `Record<GateKind, GateEvaluator>`
 * so the compiler rejects the object literal unless every kind is registered;
 * this is the exhaustiveness guarantee that retired the old exhaustive-default
 * check. New gate kinds land as a single drop-in entry here.
 */
export const gateRegistry: Record<GateKind, GateEvaluator> = {
  acceptance: forKind("acceptance", (gate, input) =>
    evaluateAcceptanceGate(
      gate,
      input.gateId,
      input.nodeId,
      input.context,
      input.attempt,
      input.node
    )
  ),
  artifact: forKind("artifact", (gate, input) =>
    evaluateArtifactGate(gate, input.gateId, input.nodeId, input.context)
  ),
  builtin: forKind("builtin", (gate, input) =>
    evaluateBuiltinGate(gate, input.gateId, input.nodeId, input.context)
  ),
  changed_files: forKind("changed_files", (gate, input) =>
    evaluateChangedFilesGate(gate, input.gateId, input.nodeId, input.context)
  ),
  command: forKind("command", (gate, input) =>
    evaluateCommandGate(
      gate,
      input.gateId,
      input.nodeId,
      input.context,
      input.executor
    )
  ),
  json_schema: forKind("json_schema", (gate, input) =>
    evaluateJsonSchemaGate(
      gate,
      input.gateId,
      input.nodeId,
      input.context,
      input.attempt
    )
  ),
  verdict: forKind("verdict", (gate, input) =>
    evaluateVerdictGate(
      gate,
      input.gateId,
      input.nodeId,
      input.context,
      input.attempt
    )
  ),
};

/**
 * Resolves a gate to its registered evaluator and runs it. Behaviour-preserving
 * replacement for the former `evaluateGate` switch: a single table lookup.
 */
export function evaluateGate(
  input: GateEvaluationInput
): ReturnType<GateEvaluator> {
  return gateRegistry[input.gate.kind](input);
}
