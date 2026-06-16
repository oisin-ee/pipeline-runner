import { Effect } from "effect";
import type { PipelineConfig } from "../../config";
import type { PlannedWorkflowNode } from "../../planning/compile";
import { createRunnerLaunchPlan, type RunnerLaunchPlan } from "../../runner";
import { normalizeRunnerOutput } from "../../runner-output";
import type { NodeAttemptResult, RuntimeContext } from "../contracts";
import { parseJsonObject } from "../json-validation";
import {
  SelectCandidateService,
  SelectCandidateServiceLive,
} from "../services/select-candidate-service";

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
  const program = executeSelectCandidateBuiltinProgram(context, node);
  return await Effect.runPromise(
    Effect.provide(program, SelectCandidateServiceLive)
  );
}

function executeSelectCandidateBuiltinProgram(
  context: RuntimeContext,
  node?: PlannedWorkflowNode
): Effect.Effect<NodeAttemptResult, unknown, SelectCandidateService> {
  return Effect.gen(function* () {
    const candidates = yield* scoreCandidates(
      context,
      readCandidates(context, firstNeed(node))
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
    const promoted = yield* promoteWinner(context, node, selected.nodeId);
    return {
      evidence: selectionEvidence(selected, candidates.length, promoted),
      exitCode: 0,
      output: selected.output,
    };
  });
}

function selectionEvidence(
  selected: Candidate,
  candidateCount: number,
  promoted: string[]
): string[] {
  const lines = [
    `select-candidate: selected '${selected.nodeId}' (judge=${selected.judgeScore ?? "n/a"}) from ${candidateCount} candidates`,
  ];
  if (promoted.length > 0) {
    lines.push(`promoted ${promoted.length} file(s) from the winning worktree`);
  }
  return lines;
}

// PIPE-83.14: merge the winning candidate's edits from its isolated worktree
// back into the main worktree so downstream nodes see them. No-op unless
// parallel_worktrees is on (otherwise candidates already ran in the shared tree).
function promoteWinner(
  context: RuntimeContext,
  node: PlannedWorkflowNode | undefined,
  winnerNodeId: string
): Effect.Effect<string[], never, SelectCandidateService> {
  const parentNodeId = firstNeed(node);
  if (!shouldPromoteWinner(context, parentNodeId)) {
    return Effect.succeed([]);
  }
  return SelectCandidateService.pipe(
    Effect.flatMap((service) =>
      service.promoteWinner(
        context.worktreePath,
        context.runId,
        parentNodeId,
        winnerNodeId
      )
    )
  );
}

function shouldPromoteWinner(
  context: RuntimeContext,
  parentNodeId: string | null
): parentNodeId is string {
  const parallelWorktrees = context.config.parallel_worktrees;
  return Boolean(parallelWorktrees?.enabled) && parentNodeId !== null;
}

function firstNeed(node: PlannedWorkflowNode | undefined): string | null {
  return node?.needs.at(0) ?? null;
}

function scoreCandidates(
  context: RuntimeContext,
  candidates: Candidate[]
): Effect.Effect<Candidate[], unknown, SelectCandidateService> {
  const model = context.config.best_of_n?.judge_model;
  const runner = Object.keys(context.config.runners).at(0);
  if (!(model && runner)) {
    return Effect.succeed(candidates);
  }
  return Effect.forEach(
    candidates,
    (candidate) => scoreCandidate(context, candidate, runner, model),
    { concurrency: "unbounded" }
  );
}

function scoreCandidate(
  context: RuntimeContext,
  candidate: Candidate,
  runner: string,
  model: string
): Effect.Effect<Candidate, unknown, SelectCandidateService> {
  return Effect.gen(function* () {
    const plan = judgePlan(context, candidate, runner, model);
    context.agentInvocations.push(plan);
    const service = yield* SelectCandidateService;
    const result = yield* service.executeRunner(context.executor, plan, {
      signal: context.signal,
    });
    const judgeScore = parseScore(
      normalizeRunnerOutput(plan, result.stdout).output
    );
    return judgeScore === null ? candidate : { ...candidate, judgeScore };
  });
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
