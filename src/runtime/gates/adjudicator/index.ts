import type { AcceptanceCriterion, CompletionClaim } from "../../contracts";
import type { LlmJudge } from "../adjudication/llm-judge";
import { llmJudgeUnmet } from "../adjudication/llm-judge";
import { structuredClaimUnmet } from "../adjudication/structured-claim";
import type { GateEvaluationInput, GateVerdict } from "../contract";
import {
  dedupeByCriterion,
  residueCriteria,
  runDeterministicLayer,
} from "./adjudicator";

/**
 * One deterministic gate the adjudicator runs as its first layer. `input` is a
 * ready-to-dispatch {@link GateEvaluationInput} (the caller — PIPE-90.11 — owns
 * building the runtime context); `covers` names the acceptance criterion ids
 * this gate settles. A covered criterion is removed from the llm-judge residue
 * whether the gate passes (settled met) or fails (settled unmet) — deterministic
 * coverage is authoritative, so the judge is never consulted for it.
 */
export interface DeterministicGate {
  readonly covers: readonly string[];
  readonly input: GateEvaluationInput;
}

/**
 * The single input to {@link adjudicate}. `criteria` are the ticket's declared
 * acceptance criteria; `claim` is the agent-authored completion claim; `judge`
 * is the injected adjudication dependency (a plain function, so the module is
 * pure and stub-testable — no real LLM). `deterministicGates` is optional: when
 * absent the deterministic evidence pool is empty, which (by the judge's
 * anchoring rule) means no residue criterion can be honored.
 */
export interface AdjudicationInput {
  readonly claim: CompletionClaim;
  readonly criteria: readonly AcceptanceCriterion[];
  readonly deterministicGates?: readonly DeterministicGate[];
  readonly judge: LlmJudge;
}

/**
 * Composes the layered completion gate into one deep module (PIPE-90.10,
 * orchestrator-design decision #5 — layered, evidence-anchored). This is the
 * module's whole public interface; the layer mechanics are hidden in
 * `./adjudicator`.
 *
 * Runs all three layers in order and aggregates EVERY distinct failing
 * criterion (not first-fail-only):
 *   1. deterministic — registry gates via the registry's evaluator; failures
 *      refuse, passing-gate evidence anchors the judge, covered criteria leave
 *      the residue.
 *   2. structured-claim — {@link structuredClaimUnmet} over all criteria.
 *   3. llm-judge — {@link llmJudgeUnmet} over only the residue (criteria neither
 *      deterministically covered nor already flagged incomplete), anchored to
 *      the deterministic evidence pool so an unanchored "pass" stays unmet.
 *
 * The union is deduped by criterion id (earliest layer wins) so every distinct
 * failing criterion appears exactly once. `passed` is true iff `unmet` is empty.
 */
export async function adjudicate(
  input: AdjudicationInput
): Promise<GateVerdict> {
  const deterministic = await runDeterministicLayer(
    input.deterministicGates ?? []
  );
  const structured = structuredClaimUnmet(input.criteria, input.claim);
  const residue = residueCriteria(
    input.criteria,
    deterministic.covered,
    structured
  );
  const judged = llmJudgeUnmet(
    residue,
    input.claim,
    deterministic.evidence,
    input.judge
  );
  const unmet = dedupeByCriterion([
    ...deterministic.unmet,
    ...structured,
    ...judged,
  ]);
  return { passed: unmet.length === 0, unmet };
}
