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

// Agent nodes dispatch to an external runner (opencode) whose sessions can fail
// transiently (e.g. "Unexpected server error" under concurrency). Without a retry
// cushion a single blip fails the whole lane, so agent nodes default to a few
// attempts with backoff. Command/builtin nodes are deterministic and keep a single
// attempt. Explicit per-node `retries` always win.
const AGENT_RETRY_DEFAULTS = {
  backoffMs: 2000,
  maxAttempts: 3,
  multiplier: 2,
} as const;
const SINGLE_RETRY_DEFAULTS = {
  backoffMs: 0,
  maxAttempts: 1,
  multiplier: 1,
} as const;

export function nodeRetryPolicy(node: PlannedWorkflowNode): NodeRetryPolicy {
  const defaults =
    node.kind === "agent" ? AGENT_RETRY_DEFAULTS : SINGLE_RETRY_DEFAULTS;
  const retryOn: RetryReason[] = node.retries?.retry_on
    ? [...node.retries.retry_on]
    : ["exit_nonzero", "gate_failure", "timeout"];
  return {
    backoffMs: node.retries?.backoff_ms ?? defaults.backoffMs,
    maxAttempts: node.retries?.max_attempts ?? defaults.maxAttempts,
    multiplier: node.retries?.multiplier ?? defaults.multiplier,
    retryOn,
  };
}

export function retryDelayMs(policy: NodeRetryPolicy, attempt: number): number {
  return (
    policy.backoffMs *
    Math.max(1, policy.multiplier) ** Math.max(0, attempt - 1)
  );
}

export function decideNodeRetry(
  input: NodeRetryDecisionInput
): NodeRetryDecision {
  const scheduled =
    input.policy.retryOn.includes(input.retryReason) &&
    input.attempt < input.policy.maxAttempts;

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
}
