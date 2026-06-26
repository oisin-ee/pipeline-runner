import type {
  AcceptanceCriterion,
  CompletionClaim,
  CriterionEvidence,
  UnmetCriterion,
} from "../../contracts";

/**
 * One completeness rule for a single criterion evidence entry.
 * `test` returns true when the rule's failure condition is met;
 * `reason` produces the human-readable failure message for the
 * {@link UnmetCriterion} emitted.
 *
 * Rules are evaluated in order; the first match names the failure.
 * Variation (missing / empty / blank) lives here as data, not as
 * an if-ladder in the caller (PIPE-90.7).
 */
interface CompletenessRule {
  reason: (id: string) => string;
  test: (entry: CriterionEvidence | undefined) => boolean;
}

/**
 * Ordered completeness rules. Each rule is independently testable;
 * together they are exhaustive — a criterion that passes all three
 * is fully evidenced.
 */
const COMPLETENESS_RULES: readonly CompletenessRule[] = [
  {
    reason: (id) => `no claim entry for criterion '${id}'`,
    test: (entry) => entry === undefined,
  },
  {
    reason: (id) => `empty evidence for criterion '${id}'`,
    test: (entry) => entry !== undefined && entry.evidence.length === 0,
  },
  {
    reason: (id) => `blank evidence for criterion '${id}'`,
    test: (entry) =>
      entry !== undefined &&
      entry.evidence.length > 0 &&
      entry.evidence.every((s) => !s.trim()),
  },
];

function criterionUnmet(
  criterion: AcceptanceCriterion,
  claim: CompletionClaim
): UnmetCriterion | null {
  const entry = claim.criteria.find((e) => e.criterion === criterion.id);
  const rule = COMPLETENESS_RULES.find((r) => r.test(entry));
  if (rule === undefined) {
    return null;
  }
  return {
    criterion: criterion.id,
    evidence: entry?.evidence ?? [],
    reason: rule.reason(criterion.id),
  };
}

/**
 * Structured-claim adjudication layer (PIPE-90.7): deterministic, pure
 * check below the LLM-judge in the completion pipeline.
 *
 * For each declared {@link AcceptanceCriterion}, emits an
 * {@link UnmetCriterion} when the agent's {@link CompletionClaim} has:
 * - no entry for that criterion, OR
 * - an empty evidence array, OR
 * - only blank/whitespace evidence strings.
 *
 * A criterion with at least one non-blank evidence string produces no
 * entry. Returns an empty array when the claim covers all declared
 * criteria. Pure — no I/O, no LLM, deterministic.
 */
export function structuredClaimUnmet(
  criteria: readonly AcceptanceCriterion[],
  claim: CompletionClaim
): UnmetCriterion[] {
  return criteria.flatMap((criterion) => {
    const unmet = criterionUnmet(criterion, claim);
    return unmet === null ? [] : [unmet];
  });
}
