import type { PlannedWorkflowNode } from "../../../../planning/compile";
import { isRecord } from "../../../../safe-json";
import type {
  AcceptanceCriterion,
  AcceptanceGateSpec,
  NodeAttemptResult,
  PipelineTaskContext,
  RuntimeGateResult,
  UnmetCriterion,
} from "../../../contracts";
import { parseGateJson } from "../../gates";
import type { AcceptanceContext } from "../json-source";

const effectiveTaskContext = (
  node: PlannedWorkflowNode,
  context: AcceptanceContext
): PipelineTaskContext | undefined => node.taskContext ?? context.taskContext;

const acceptanceEntries = (
  value: unknown,
  key = "acceptance"
): Record<string, unknown>[] => {
  if (!isRecord(value)) {
    return [];
  }
  const raw = value[key] ?? value.criteria ?? value.acceptanceCriteria;
  return Array.isArray(raw)
    ? raw.filter((item): item is Record<string, unknown> => isRecord(item))
    : [];
};

const coverageCountUnmetCriteria = (
  id: string,
  count: number
): UnmetCriterion[] => {
  const unmet: UnmetCriterion[] = [];
  if (count === 0) {
    unmet.push({
      criterion: id,
      evidence: [`criterion '${id}' absent from acceptance report`],
      reason: `missing acceptance criterion '${id}'`,
    });
  }
  if (count > 1) {
    unmet.push({
      criterion: id,
      evidence: [`criterion '${id}' reported ${count} times`],
      reason: `duplicate acceptance criterion '${id}'`,
    });
  }
  return unmet;
};

const hasNonEmptyEvidence = (value: unknown): boolean =>
  Array.isArray(value) &&
  value.some((item) => typeof item === "string" && item.trim().length > 0);

const entryUnmetCriteria = (
  entry: Record<string, unknown>,
  expectedIds: Set<string>,
  seen: Map<string, number>
): UnmetCriterion[] => {
  const id = typeof entry.id === "string" ? entry.id : "";
  if (id.length === 0) {
    return [
      {
        criterion: "",
        evidence: ["acceptance entry has no id field"],
        reason: "acceptance entry missing id",
      },
    ];
  }
  seen.set(id, (seen.get(id) ?? 0) + 1);
  const unmet: UnmetCriterion[] = [];
  if (!expectedIds.has(id)) {
    unmet.push({
      criterion: id,
      evidence: [`id '${id}' not in task acceptance context`],
      reason: `extra acceptance criterion '${id}'`,
    });
  }
  const { verdict } = entry;
  if (verdict !== "PASS") {
    unmet.push({
      criterion: id,
      evidence: [`reported verdict '${String(verdict)}'`],
      reason: `acceptance criterion '${id}' verdict '${String(verdict)}'`,
    });
  }
  if (verdict === "PASS" && !hasNonEmptyEvidence(entry.evidence)) {
    unmet.push({
      criterion: id,
      evidence: ["verdict 'PASS' reported without supporting evidence"],
      reason: `acceptance criterion '${id}' has no evidence`,
    });
  }
  return unmet;
};

/**
 * Structured refusal producer (PIPE-90.1): the single source of truth for which
 * acceptance criteria a node failed to satisfy. Each {@link UnmetCriterion}
 * names the criterion, a human-readable reason, and deterministic proof. The
 * acceptance gate's flat `evidence` field is the `reason` projection of this,
 * so refusal text and ordering stay in lockstep with the structured form.
 */
export const acceptanceUnmetCriteria = (
  expected: AcceptanceCriterion[],
  entries: Record<string, unknown>[]
): UnmetCriterion[] => {
  const unmet: UnmetCriterion[] = [];
  const expectedIds = new Set(expected.map((criterion) => criterion.id));
  const seen = new Map<string, number>();
  for (const entry of entries) {
    unmet.push(...entryUnmetCriteria(entry, expectedIds, seen));
  }
  for (const id of expectedIds) {
    unmet.push(...coverageCountUnmetCriteria(id, seen.get(id) ?? 0));
  }
  return unmet;
};

/**
 * Evaluates whether the node's JSON output (or artifact) covers all acceptance
 * criteria declared in the task context. Uses
 * {@link acceptanceUnmetCriteria} as the single source of truth for which
 * criteria remain unmet, so refusal text and structured form stay in lockstep.
 */
export const evaluateAcceptanceGate = (
  gate: AcceptanceGateSpec,
  gateId: string,
  nodeId: string,
  context: AcceptanceContext,
  attempt: NodeAttemptResult,
  node?: PlannedWorkflowNode
): RuntimeGateResult => {
  const expected =
    (node ? effectiveTaskContext(node, context) : context.taskContext)
      ?.acceptanceCriteria ?? [];
  if (expected.length === 0) {
    return {
      evidence: ["no acceptance criteria in task context"],
      gateId,
      kind: gate.kind,
      nodeId,
      passed: gate.required === false,
      reason:
        gate.required === false ? undefined : "missing task acceptance context",
    };
  }
  const parsed = parseGateJson(gate, context, attempt);
  if (parsed.evidence !== undefined && parsed.evidence.length > 0) {
    return {
      evidence: [parsed.evidence],
      gateId,
      kind: gate.kind,
      nodeId,
      passed: false,
      reason: "acceptance gate JSON parse failed",
    };
  }
  const entries = acceptanceEntries(parsed.value, gate.acceptance_key);
  const unmet = acceptanceUnmetCriteria(expected, entries);
  const passed = unmet.length === 0;
  return {
    evidence: passed
      ? ["acceptance coverage passed"]
      : unmet.map((item) => item.reason),
    gateId,
    kind: gate.kind,
    nodeId,
    passed,
    reason: passed ? undefined : "acceptance coverage failed",
    unmet,
  };
};
