import { Effect } from "effect";

import type { CommandExecutionContext } from "../../../command-executor";
import type { CommandGateSpec, RuntimeGateResult } from "../../../contracts";
import type { CommandExecutorService } from "../../contract";

/**
 * Runs the gate's command through the executor and maps its exit code to a
 * pass/fail result. Context is narrowed to {@link CommandExecutionContext}
 * (worktreePath + signal) — the only fields the executor needs.
 */
export const evaluateCommandGate = async (
  gate: CommandGateSpec,
  gateId: string,
  nodeId: string,
  context: CommandExecutionContext,
  executor: CommandExecutorService
): Promise<RuntimeGateResult> => {
  const result = await Effect.runPromise(
    executor.execute(gate.command, context, { timeout: gate.timeout_ms })
  );
  const expected = gate.expect_exit_code ?? 0;
  return {
    evidence: result.evidence,
    gateId,
    kind: gate.kind,
    nodeId,
    passed: result.exitCode === expected,
    reason:
      result.exitCode === expected
        ? undefined
        : `expected exit ${expected}, got ${result.exitCode}`,
  };
};
