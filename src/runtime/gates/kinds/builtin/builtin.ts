import { executeBuiltin } from "../../../builtins";
import type {
  BuiltinGateSpec,
  RuntimeContext,
  RuntimeGateResult,
} from "../../../contracts";

/**
 * Runs a named builtin via the executor and maps its exit code to a gate result.
 * Context must satisfy {@link RuntimeContext} since {@link executeBuiltin} uses
 * the full runtime context (cwd, signal, store, etc.).
 */
export const evaluateBuiltinGate = async (
  gate: BuiltinGateSpec,
  gateId: string,
  nodeId: string,
  context: RuntimeContext
): Promise<RuntimeGateResult> => {
  const result = await executeBuiltin(gate.builtin, context);
  return {
    evidence: result.evidence,
    gateId,
    kind: gate.kind,
    nodeId,
    passed: result.exitCode === 0,
    reason:
      result.exitCode === 0 ? undefined : `builtin '${gate.builtin}' failed`,
  };
};
