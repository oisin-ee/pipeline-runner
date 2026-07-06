import type { AcceptanceCriterion, RuntimeGateResult, UnmetCriterion } from "../../contracts";
import { evaluateGate } from "../registry";
import type { DeterministicGate } from "./index";

/**
 * The reduced result of layer 1 (deterministic registry gates). `covered` is
 * every criterion id any deterministic gate is bound to (settled, so excluded
 * from residue); `evidence` is the pool of passing-gate evidence that anchors
 * the judge; `unmet` is the structured refusal contributed by failing gates.
 */
export interface DeterministicOutcome {
  readonly covered: ReadonlySet<string>;
  readonly evidence: string[];
  readonly unmet: UnmetCriterion[];
}

/**
 * Maps a failing deterministic gate to its structured refusal. A criterion-aware
 * gate (acceptance) already reports `unmet`; a binary gate (command, artifact,
 * ...) reports only pass/fail, so synthesize one entry per covered criterion —
 * or, when the gate covers nothing, a single entry keyed by the gate id so the
 * failure is never swallowed.
 */
const gateUnmet = (gate: DeterministicGate, result: RuntimeGateResult): UnmetCriterion[] => {
  if (result.unmet && result.unmet.length > 0) {
    return result.unmet;
  }
  const reason = result.reason ?? `deterministic gate '${result.gateId}' failed`;
  if (gate.covers.length === 0) {
    return [{ criterion: result.gateId, evidence: result.evidence, reason }];
  }
  return gate.covers.map((id) => ({
    criterion: id,
    evidence: result.evidence,
    reason,
  }));
};

/**
 * Runs the deterministic layer: every {@link DeterministicGate} through the
 * registry's {@link evaluateGate}. Each gate's `covers` ids are settled
 * (excluded from the residue) whether it passes or fails; passing gates feed the
 * anchor evidence pool, failing gates feed the structured refusal.
 */
export const runDeterministicLayer = async (gates: readonly DeterministicGate[]): Promise<DeterministicOutcome> => {
  const covered = new Set<string>();
  const evidence: string[] = [];
  const unmet: UnmetCriterion[] = [];
  for (const gate of gates) {
    for (const id of gate.covers) {
      covered.add(id);
    }
    const result = await evaluateGate(gate.input);
    if (result.passed) {
      evidence.push(...result.evidence);
    } else {
      unmet.push(...gateUnmet(gate, result));
    }
  }
  return { covered, evidence, unmet };
};

/**
 * The llm-judge residue: criteria neither settled by a deterministic gate nor
 * already flagged incomplete by the structured-claim layer. Only this residue
 * reaches the judge, keeping it from re-adjudicating settled criteria.
 */
export const residueCriteria = (
  criteria: readonly AcceptanceCriterion[],
  covered: ReadonlySet<string>,
  structured: readonly UnmetCriterion[],
): AcceptanceCriterion[] => {
  const structuredIds = new Set(structured.map((entry) => entry.criterion));
  return criteria.filter((criterion) => !(covered.has(criterion.id) || structuredIds.has(criterion.id)));
};

/**
 * Collapses the layer union to one entry per distinct failing criterion id,
 * keeping the earliest (deterministic before structured-claim before llm-judge)
 * — the most authoritative reason for that criterion.
 */
export const dedupeByCriterion = (entries: UnmetCriterion[]): UnmetCriterion[] => {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    if (seen.has(entry.criterion)) {
      return false;
    }
    seen.add(entry.criterion);
    return true;
  });
};
