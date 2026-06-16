import type { PipelineConfig } from "../../config";
import type { PlannedWorkflowNode } from "../../planning/compile";
import { createRunnerLaunchPlan, type RunnerLaunchPlan } from "../../runner";
import { normalizeRunnerOutput } from "../../runner-output";
import type { NodeAttemptResult, RuntimeContext } from "../contracts";
import { parseJsonObject } from "../json-validation";

const SCORE_RE = /-?\d+(?:\.\d+)?/;

/**
 * PIPE-83.9: select-candidate builtin. Sits between a best-of-N kind:parallel
 * (PIPE-83.7) and its consumer. Reads each candidate's output, derives a hybrid
 * score (execution status PASS/FAIL + an optional LLM judge score), and emits
 * the winning candidate's output so downstream sees one selected result.
 *
 * Selection prefers a PASS candidate, breaks ties by the highest judge score,
 * and FAILs the node when no candidate passes (no silent self-fix). When
 * best_of_n.judge_model is set, each candidate is scored by that model (a
 * read-only judge call); otherwise selection is status-only.
 */
export interface Candidate {
  judgeScore: number | null;
  nodeId: string;
  output: string;
  status: "FAIL" | "PASS";
}

// fallow-ignore-next-line unused-export
export function selectBestCandidate(candidates: Candidate[]): Candidate | null {
  const passing = candidates.filter((candidate) => candidate.status === "PASS");
  if (passing.length === 0) {
    return null;
  }
  return passing.reduce((best, candidate) =>
    (candidate.judgeScore ?? 0) > (best.judgeScore ?? 0) ? candidate : best
  );
}

export async function executeSelectCandidateBuiltin(
  context: RuntimeContext,
  node?: PlannedWorkflowNode
): Promise<NodeAttemptResult> {
  const candidates = await scoreCandidates(
    context,
    readCandidates(context, node?.needs.at(0) ?? null)
  );
  const selected = selectBestCandidate(candidates);
  if (!selected) {
    return {
      evidence: [
        `select-candidate: no passing candidate among ${candidates.length}`,
        ...candidates.map((candidate) => `- ${candidate.nodeId}: FAIL`),
      ],
      exitCode: 1,
      output: "",
    };
  }
  return {
    evidence: [
      `select-candidate: selected '${selected.nodeId}' (judge=${selected.judgeScore ?? "n/a"}) from ${candidates.length} candidates`,
    ],
    exitCode: 0,
    output: selected.output,
  };
}

async function scoreCandidates(
  context: RuntimeContext,
  candidates: Candidate[]
): Promise<Candidate[]> {
  const model = context.config.best_of_n?.judge_model;
  const runner = Object.keys(context.config.runners).at(0);
  if (!(model && runner)) {
    return candidates;
  }
  return await Promise.all(
    candidates.map((candidate) =>
      scoreCandidate(context, candidate, runner, model)
    )
  );
}

async function scoreCandidate(
  context: RuntimeContext,
  candidate: Candidate,
  runner: string,
  model: string
): Promise<Candidate> {
  const plan = judgePlan(context, candidate, runner, model);
  context.agentInvocations.push(plan);
  const result = await context.executor(plan, { signal: context.signal });
  const judgeScore = parseScore(
    normalizeRunnerOutput(plan, result.stdout).output
  );
  return judgeScore === null ? candidate : { ...candidate, judgeScore };
}

function judgePlan(
  context: RuntimeContext,
  candidate: Candidate,
  runner: string,
  model: string
): RunnerLaunchPlan {
  const profileId = `select-candidate:judge:${candidate.nodeId}`;
  const config: PipelineConfig = {
    ...context.config,
    profiles: {
      ...context.config.profiles,
      [profileId]: {
        filesystem: { mode: "read-only" },
        instructions: { inline: "Score the candidate implementation." },
        network: { mode: "disabled" },
        output: { format: "text" },
        runner,
        tools: [],
      },
    },
  };
  return createRunnerLaunchPlan(config, {
    model,
    nodeId: profileId,
    profileId,
    prompt: judgePrompt(context.task, candidate.output),
    worktreePath: context.worktreePath,
  });
}

function judgePrompt(task: string, output: string): string {
  return [
    "Score how well this candidate implementation satisfies the task.",
    "Return ONLY a number between 0 and 1 (1 = best). No prose, no fences.",
    "",
    `Task: ${task}`,
    "",
    "Candidate result:",
    output,
  ].join("\n");
}

function parseScore(text: string): number | null {
  const match = SCORE_RE.exec(text);
  if (!match) {
    return null;
  }
  const value = Number(match[0]);
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : null;
}

function readCandidates(
  context: RuntimeContext,
  upstreamNodeId: string | null
): Candidate[] {
  if (!upstreamNodeId) {
    return [];
  }
  const upstream = context.plan.graph.node(upstreamNodeId);
  const aggregate = parseJsonObject(
    context.nodeStateStore.getOutput(upstreamNodeId)
  );
  const childrenOutput = parseJsonObject(aggregate.children);
  return (upstream?.children ?? []).flatMap((child) => {
    const raw = childrenOutput[child.id];
    return raw === undefined ? [] : [parseCandidate(child.id, raw)];
  });
}

function parseCandidate(nodeId: string, raw: unknown): Candidate {
  const output = typeof raw === "string" ? raw : JSON.stringify(raw);
  const parsed = safeParseObject(output);
  return {
    judgeScore: candidateJudgeScore(parsed),
    nodeId,
    output,
    status: candidateStatus(parsed),
  };
}

// An explicit verdict/status FAIL marks a candidate as failing; otherwise it is
// selectable (candidates without a verdict gate are treated as PASS).
function candidateStatus(
  parsed: Record<string, unknown> | null
): "FAIL" | "PASS" {
  if (!parsed) {
    return "PASS";
  }
  return parsed.verdict === "FAIL" || parsed.status === "FAIL"
    ? "FAIL"
    : "PASS";
}

function candidateJudgeScore(
  parsed: Record<string, unknown> | null
): number | null {
  return typeof parsed?.judge_score === "number" ? parsed.judge_score : null;
}

function safeParseObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
