import { join } from "node:path";
import { parseJsonResult } from "../../safe-json";
import type { JsonSourceGateSpec, NodeAttemptResult } from "../contracts";
import { readOptionalFile } from "../json-validation";

/**
 * Minimal context shape needed for JSON-source gate resolution. Kind modules
 * (verdict, acceptance, json-schema) narrow their context parameter to this
 * interface — or a subtype of it — so they remain unit-testable without a full
 * RuntimeContext.
 */
export interface JsonSourceContext {
  worktreePath: string;
}

/**
 * Resolves the raw JSON string for a gate that targets either the node's stdout
 * output or an artifact file. Returns `{ evidence }` on read error so callers
 * can short-circuit before parsing.
 */
function gateJsonSource(
  gate: JsonSourceGateSpec,
  context: JsonSourceContext,
  attempt: NodeAttemptResult
): { evidence?: string; source?: string } {
  if (gate.target === "artifact") {
    if (!gate.path) {
      return { evidence: "missing JSON artifact path" };
    }
    const source = readOptionalFile(join(context.worktreePath, gate.path));
    return source === null
      ? { evidence: `missing JSON artifact: ${gate.path}` }
      : { source };
  }
  return { source: attempt.output };
}

/**
 * Parses the gate JSON source to an unknown value. Returns `{ evidence }` on
 * parse error so callers can short-circuit with a failed gate result.
 */
export function parseGateJson(
  gate: JsonSourceGateSpec,
  context: JsonSourceContext,
  attempt: NodeAttemptResult
): { evidence?: string; value?: unknown } {
  const src = gateJsonSource(gate, context, attempt);
  if (src.evidence) {
    return { evidence: src.evidence };
  }
  const parsed = parseJsonResult(src.source ?? "", "gate JSON");
  return parsed.error ? { evidence: parsed.error } : { value: parsed.value };
}
