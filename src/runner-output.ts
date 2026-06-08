import { jsonLineValues } from "./json-line-values";
import type { RunnerLaunchPlan } from "./runner";
import { opencodeCliRuntimeAdapter } from "./runtime/opencode-adapter";
import { isRecord } from "./safe-json";

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
  if (plan.type === "codex") {
    return jsonLineValues(stdout, codexAgentMessageText).map((output) => ({
      evidence: "normalized runner output from codex JSONL",
      output,
    }));
  }

  if (plan.type === "opencode") {
    return opencodeCliRuntimeAdapter.outputCandidates(stdout);
  }

  return [];
}

function codexAgentMessageText(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return;
  }
  const item = value.item;
  if (isRecord(item) && item.type === "agent_message") {
    return typeof item.text === "string" ? item.text : undefined;
  }
  if (value.type === "agent_message") {
    return typeof value.text === "string" ? value.text : undefined;
  }
}
