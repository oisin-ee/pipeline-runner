import { Option } from "effect";

import type {
  AcceptanceCriterion,
  CompletionClaim,
  UnmetCriterion,
} from "../../contracts";

/**
 * The verdict an injected {@link LlmJudge} returns for one residual acceptance
 * criterion. `satisfied` is the judge's claim; `citedEvidence` MUST reference
 * deterministic evidence the judge relied on (this layer rejects any verdict
 * that cannot anchor); `rationale` is the human-readable justification.
 */
export interface LlmJudgeVerdict {
  citedEvidence: string[];
  rationale: string;
  satisfied: boolean;
}

/**
 * The injected adjudication dependency. Kept as a plain function (not a live
 * model client) so this layer is pure and unit-testable with a stub — no real
 * network/LLM call ever runs in tests.
 */
export type LlmJudge = (input: {
  claimedEvidence: string[];
  criterion: AcceptanceCriterion;
  deterministicEvidence: string[];
}) => LlmJudgeVerdict;

/**
 * One rule in the "is this verdict honored" policy. The single owner of when a
 * judge `satisfied: true` is rejected; the per-criterion adjudicator evaluates
 * the table in order and the first match makes the criterion unmet. Anchoring
 * (orchestrator-design decision #5): a pass is only honored if it cites
 * deterministic evidence that actually exists — the judge cannot invent an
 * anchor, and an unanchored "pass" is never standalone-authoritative.
 */
interface HonorPolicy {
  readonly failed: (verdict: LlmJudgeVerdict, anchored: string[]) => boolean;
  readonly reason: string;
}

const HONOR_POLICIES: readonly HonorPolicy[] = [
  {
    failed: (verdict) => !verdict.satisfied,
    reason: "llm-judge marked the residual criterion unsatisfied",
  },
  {
    failed: (verdict) => verdict.citedEvidence.length === 0,
    reason: "llm-judge pass rejected: verdict cited no deterministic evidence",
  },
  {
    failed: (verdict, anchored) =>
      anchored.length < verdict.citedEvidence.length,
    reason:
      "llm-judge pass rejected: cited evidence is not present in the deterministic evidence set",
  },
];

const TRIVIAL_REFUSAL =
  "trivial completion claim refused without consulting llm-judge: no non-blank claimed evidence";

const adjudicateCriterion = (
  criterion: AcceptanceCriterion,
  claimedEvidence: string[],
  deterministicEvidence: string[],
  judge: LlmJudge
): Option.Option<UnmetCriterion> => {
  const meaningful = claimedEvidence.filter((item) => item.trim().length > 0);
  if (meaningful.length === 0) {
    return Option.some({
      criterion: criterion.id,
      evidence: claimedEvidence,
      reason: TRIVIAL_REFUSAL,
    });
  }
  const verdict = judge({
    claimedEvidence: meaningful,
    criterion,
    deterministicEvidence,
  });
  const anchored = verdict.citedEvidence.filter((item) =>
    deterministicEvidence.includes(item)
  );
  const broken = HONOR_POLICIES.find((policy) =>
    policy.failed(verdict, anchored)
  );
  if (broken === undefined) {
    return Option.none();
  }
  return Option.some({
    criterion: criterion.id,
    evidence:
      verdict.citedEvidence.length > 0 ? verdict.citedEvidence : meaningful,
    reason: broken.reason,
  });
};

const claimedEvidenceFor = (
  criterion: AcceptanceCriterion,
  claim: CompletionClaim
): string[] =>
  claim.criteria.find((entry) => entry.criterion === criterion.id)?.evidence ??
  [];

/**
 * Adjudicates the residual acceptance criteria — the un-encodable residue the
 * deterministic and structured-claim layers could not settle — against the
 * agent's {@link CompletionClaim}, anchored to deterministic evidence. Returns
 * one {@link UnmetCriterion} for every residue criterion that is refused for
 * trivial input, fails anchoring, or the judge marks unsatisfied. Honored
 * criteria are omitted. Pure given the injected `judge`.
 */
export const llmJudgeUnmet = (
  residue: readonly AcceptanceCriterion[],
  claim: CompletionClaim,
  deterministicEvidence: string[],
  judge: LlmJudge
): UnmetCriterion[] =>
  residue.flatMap((criterion) => {
    const failure = adjudicateCriterion(
      criterion,
      claimedEvidenceFor(criterion, claim),
      deterministicEvidence,
      judge
    );
    return Option.isSome(failure) ? [failure.value] : [];
  });
