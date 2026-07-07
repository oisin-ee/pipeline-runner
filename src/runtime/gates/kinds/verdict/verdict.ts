import { isRecord } from "../../../../safe-json";
import type {
  NodeAttemptResult,
  RuntimeGateResult,
  VerdictGateSpec,
} from "../../../contracts";
import type { JsonSourceContext } from "../../gates";
import { parseGateJson } from "../../gates";

/**
 * Checks that a named field in the node's JSON output (or artifact) equals an
 * expected string value — defaults to `field="verdict"` and `equals="PASS"`.
 */
export const evaluateVerdictGate = (
  gate: VerdictGateSpec,
  gateId: string,
  nodeId: string,
  context: JsonSourceContext,
  attempt: NodeAttemptResult
): RuntimeGateResult => {
  const parsed = parseGateJson(gate, context, attempt);
  const field = gate.field ?? "verdict";
  const expected = gate.equals ?? "PASS";
  if (parsed.evidence !== undefined && parsed.evidence.length > 0) {
    return {
      evidence: [parsed.evidence],
      gateId,
      kind: gate.kind,
      nodeId,
      passed: false,
      reason: "verdict gate JSON parse failed",
    };
  }
  const value = isRecord(parsed.value) ? parsed.value[field] : undefined;
  const passed = value === expected;
  return {
    evidence: [
      passed
        ? `verdict '${field}' matched '${expected}'`
        : `verdict '${field}' expected '${expected}', got '${String(value)}'`,
    ],
    gateId,
    kind: gate.kind,
    nodeId,
    passed,
    reason: passed ? undefined : "verdict requirement failed",
  };
};
