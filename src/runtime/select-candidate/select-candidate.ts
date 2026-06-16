import type { PlannedWorkflowNode } from "../../planning/compile";
import type { NodeAttemptResult, RuntimeContext } from "../contracts";
import { parseJsonObject } from "../json-validation";

/**
 * PIPE-83.9: select-candidate builtin. Sits between a best-of-N kind:parallel
 * (PIPE-83.7) and its consumer. Reads each candidate's output, derives a hybrid
 * score (execution status PASS/FAIL + an optional LLM judge score), and emits
 * the winning candidate's output so downstream sees one selected result.
 *
 * v1 selection is deterministic: prefer a PASS candidate, break ties by the
 * highest judge score (when present), and FAIL the node when no candidate
 * passes. The LLM-judge half writes `judge_score` into a candidate's output;
 * wiring that model call is a follow-up — the scoring already consumes it.
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

export function executeSelectCandidateBuiltin(
  context: RuntimeContext,
  node?: PlannedWorkflowNode
): NodeAttemptResult {
  const candidates = readCandidates(context, node?.needs.at(0) ?? null);
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
