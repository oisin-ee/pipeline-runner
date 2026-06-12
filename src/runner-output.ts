import type { RunnerLaunchPlan } from "./runner";
import { opencodeSdkRuntimeAdapter } from "./runtime/opencode-adapter";

export interface NormalizedRunnerOutput {
  evidence: string[];
  output: string;
}

export interface RunnerTextCandidate {
  evidence: string;
  output: string;
}

export function normalizeRunnerOutput(
  plan: RunnerLaunchPlan,
  stdout: string
): NormalizedRunnerOutput {
  const candidates = runnerTextCandidates(plan, stdout);
  const latest = candidates.at(-1);
  if (latest) {
    return {
      evidence: [latest.evidence],
      output: latest.output,
    };
  }

  return { evidence: [], output: stdout };
}

export function runnerTextCandidates(
  plan: RunnerLaunchPlan,
  stdout: string
): RunnerTextCandidate[] {
  if (plan.type === "opencode") {
    return opencodeSdkRuntimeAdapter.outputCandidates(stdout);
  }

  return [];
}
