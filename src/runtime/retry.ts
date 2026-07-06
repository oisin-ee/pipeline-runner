import type { PlannedWorkflowNode } from "../planning/compile";
import type { NodeRetryPolicyContract, RetryReason } from "./actor-ids";

export type NodeRetryPolicy = NodeRetryPolicyContract;

export interface NodeRetryDecisionInput {
  attempt: number;
  evidence: string[];
  gate: string;
  policy: NodeRetryPolicy;
  reason: string;
  retryReason: RetryReason;
}

export interface NodeRetryDecision {
  attempt: number;
  delayMs: number;
  evidence: string[];
  exhausted: boolean;
  gate: string;
  reason: string;
  retryReason: RetryReason;
  scheduled: boolean;
}

/*
 * This retry delay stays hand-rolled because the runtime has to honor
 * AbortSignal cancellation while turning gate failure into a remediation
 * reprompt. p-retry models generic retries, but not this node/gate evidence
 * contract or the abortable delay boundary used by the scheduler.
 */

export const nodeRetryPolicy = (node: PlannedWorkflowNode): NodeRetryPolicy => {
  let retryOn: RetryReason[] = ["exit_nonzero", "gate_failure", "timeout"];
  if (node.retries?.retry_on) {
    retryOn = [...node.retries.retry_on];
  }
  return {
    backoffMs: node.retries?.backoff_ms ?? 0,
    maxAttempts: node.retries?.max_attempts ?? 1,
    multiplier: node.retries?.multiplier ?? 1,
    retryOn,
  };
};

export const retryDelayMs = (policy: NodeRetryPolicy, attempt: number): number =>
  policy.backoffMs * Math.max(1, policy.multiplier) ** Math.max(0, attempt - 1);

export const decideNodeRetry = (input: NodeRetryDecisionInput): NodeRetryDecision => {
  const scheduled = input.policy.retryOn.includes(input.retryReason) && input.attempt < input.policy.maxAttempts;

  return {
    attempt: input.attempt,
    delayMs: scheduled ? retryDelayMs(input.policy, input.attempt) : 0,
    evidence: input.evidence,
    exhausted: !scheduled,
    gate: input.gate,
    reason: input.reason,
    retryReason: input.retryReason,
    scheduled,
  };
};
