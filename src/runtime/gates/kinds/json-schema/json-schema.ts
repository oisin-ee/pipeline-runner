import { join } from "node:path";

import { Option } from "effect";

import type {
  JsonSchemaGateSpec,
  NodeAttemptResult,
  RuntimeGateResult,
} from "../../../contracts";
import {
  readOptionalFile,
  validateJsonSchemaSource,
} from "../../../json-validation";

/** Minimal context shape needed by JSON-schema evaluation. */
export interface JsonSchemaContext {
  worktreePath: string;
}

/**
 * Validates the node's output (or artifact) against a JSON Schema file located
 * in the worktree. Fails immediately if the source is missing or the schema
 * does not validate.
 */
export const evaluateJsonSchemaGate = (
  gate: JsonSchemaGateSpec,
  gateId: string,
  nodeId: string,
  context: JsonSchemaContext,
  attempt: NodeAttemptResult
): RuntimeGateResult => {
  const schemaPath = gate.schema_path;
  const source =
    gate.target === "artifact" &&
    gate.path !== undefined &&
    gate.path.length > 0
      ? readOptionalFile(join(context.worktreePath, gate.path))
      : Option.some(attempt.output);
  if (Option.isNone(source)) {
    return {
      evidence: [`missing JSON artifact: ${gate.path ?? ""}`],
      gateId,
      kind: gate.kind,
      nodeId,
      passed: false,
      reason: `missing JSON artifact '${gate.path ?? ""}'`,
    };
  }
  const result = validateJsonSchemaSource(
    source.value,
    schemaPath,
    context.worktreePath
  );
  return {
    evidence: result.evidence,
    gateId,
    kind: gate.kind,
    nodeId,
    passed: result.passed,
    reason: result.reason,
  };
};
