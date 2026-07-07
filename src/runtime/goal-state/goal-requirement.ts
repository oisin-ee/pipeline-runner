import type { PipelineGoalState } from "./goal-state";

export const goalStateNextRequirement = (state: PipelineGoalState): string => {
  const failedAcceptance = state.acceptance.filter(
    (item) => item.verdict === "FAIL"
  );
  if (failedAcceptance.length > 0) {
    return `Satisfy failed acceptance criteria: ${failedAcceptance.map((item) => item.id).join(", ")}.`;
  }
  if (state.verifier.verdict === "FAIL") {
    return `Satisfy verifier node '${state.verifier.nodeId ?? "verify"}' and return passing evidence.`;
  }
  const latestGate = state.gateFailures.at(-1);
  if (latestGate) {
    return `Resolve failed gate '${latestGate.gateId}' on node '${latestGate.nodeId}' and rerun the required verification.`;
  }
  return "Complete the remaining schedule work and provide passing evidence.";
};
