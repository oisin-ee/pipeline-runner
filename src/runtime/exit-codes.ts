/**
 * Agent runner exit-code convention, shared by the opencode session executor
 * (which produces these codes) and the agent node (which routes on them).
 *
 * Distinguish infra failure (server/session/provider error -> retry-eligible
 * exit 70) from a normal agent completion (the agent may still have produced a
 * wrong answer; gates decide that, exit 0) and an agent-task error (exit 1).
 * EXIT_INFRA is what lets a node fall back to the next model in its array
 * instead of dying when one provider's session fails.
 */
export const EXIT_OK = 0;
export const EXIT_AGENT_ERROR = 1;
export const EXIT_INFRA = 70;
