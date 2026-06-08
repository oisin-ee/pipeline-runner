import type { RunnerLaunchPlan } from "./runner.js";
import { isRecord, parseJson } from "./safe-json.js";

const LINE_RE = /\r?\n/;

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
    return jsonLineValues(stdout, opencodeTextPart).map((output) => ({
      evidence: "normalized runner output from opencode JSON events",
      output,
    }));
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

function opencodeTextPart(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return;
  }
  const part = value.part;
  if (isRecord(part) && part.type === "text") {
    return typeof part.text === "string" ? part.text : undefined;
  }
}

function jsonLineValues(
  text: string,
  extract: (value: unknown) => string | undefined
): string[] {
  const values: string[] = [];
  for (const line of text.split(LINE_RE)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const extracted = extract(parseJson(trimmed, "runner JSON event"));
      if (extracted) {
        values.push(extracted);
      }
    } catch {
      // Non-JSON lines are valid for non-event runner output.
    }
  }
  return values;
}
