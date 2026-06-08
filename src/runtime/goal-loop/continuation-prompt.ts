import { goalStateNextRequirement } from "../goal-state/goal-requirement";
import type { PipelineGoalState } from "../goal-state/goal-state";

export interface ContinuationPromptInput {
  currentNodeId?: string;
  exactNextRequirement?: string;
  state: PipelineGoalState;
}

export function renderContinuationPrompt(
  input: ContinuationPromptInput
): string {
  const currentNode = currentScheduleNode(input.state, input.currentNodeId);
  const failedGates = input.state.gateFailures.filter((gate) => !gate.passed);
  return compactLines([
    "# Pipeline Continuation",
    "",
    "## Original Task",
    input.state.task.original,
    "",
    "## Task Refs",
    ...taskRefLines(input.state.task.context),
    "",
    "## Schedule",
    ...scheduleLines(input.state),
    "",
    "## Current Schedule Node Context",
    ...nodeContextLines(currentNode),
    "",
    "## Failed Gates",
    ...failedGateLines(failedGates),
    "",
    "## Verifier Evidence",
    ...verifierLines(input.state),
    "",
    "## Acceptance Evidence",
    ...acceptanceLines(input.state),
    "",
    "## Changed Files Summary",
    ...changedFileLines(input.state),
    "",
    "## Prior Attempts",
    ...priorAttemptLines(input.state),
    "",
    "## Exact Next Requirement",
    input.exactNextRequirement ?? exactNextRequirement(input.state),
    "",
    "## Discipline",
    "- Continue from the persisted goal state; do not restart the task.",
    "- Address the failed evidence directly and preserve completed work.",
    "- Run the real verification path needed to prove the fix.",
    "- Stop and report blocked if the same failure repeats without new files or evidence.",
  ]);
}

export function exactNextRequirement(state: PipelineGoalState): string {
  return goalStateNextRequirement(state);
}

function currentScheduleNode(
  state: PipelineGoalState,
  requestedNodeId: string | undefined
): PipelineGoalState["nodes"][string] | undefined {
  if (requestedNodeId && state.nodes[requestedNodeId]) {
    return state.nodes[requestedNodeId];
  }
  const failedNode = [...Object.values(state.nodes)]
    .reverse()
    .find((node) => node.status === "failed");
  return failedNode ?? Object.values(state.nodes).at(-1);
}

function taskRefLines(context: unknown): string[] {
  if (!isRecord(context)) {
    return ["- No task context recorded."];
  }
  return [
    lineFor("id", context.id),
    lineFor("title", context.title),
    lineFor("description", context.description),
    ...acceptanceCriteriaRefLines(context.acceptanceCriteria),
  ].filter(Boolean);
}

function acceptanceCriteriaRefLines(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    return [];
  }
  return [
    "- acceptance_criteria:",
    ...value.flatMap((item) => {
      if (!isRecord(item)) {
        return [];
      }
      return [`  - ${String(item.id ?? "?")}: ${String(item.text ?? "")}`];
    }),
  ];
}

function scheduleLines(state: PipelineGoalState): string[] {
  return [
    `- workflow_id: ${state.workflowId}`,
    state.runId ? `- run_id: ${state.runId}` : "",
    state.schedule?.id ? `- schedule_id: ${state.schedule.id}` : "",
    state.schedule?.path ? `- schedule_path: ${state.schedule.path}` : "",
  ].filter(Boolean);
}

function nodeContextLines(
  node: PipelineGoalState["nodes"][string] | undefined
): string[] {
  if (!node) {
    return ["- No schedule node has run yet."];
  }
  return [
    `- node_id: ${node.nodeId}`,
    `- status: ${node.status}`,
    `- attempts: ${node.attempts}`,
    node.profile ? `- profile: ${node.profile}` : "",
    node.runnerId ? `- runner: ${node.runnerId}` : "",
    node.changedFiles.length
      ? `- node_changed_files: ${node.changedFiles.join(", ")}`
      : "",
    ...node.gates.map(
      (gate) =>
        `- gate ${gate.gateId}: ${gate.passed ? "PASS" : "FAIL"}${gate.reason ? ` (${gate.reason})` : ""}`
    ),
  ].filter(Boolean);
}

function failedGateLines(gates: PipelineGoalState["gateFailures"]): string[] {
  if (gates.length === 0) {
    return ["- No failed gates recorded."];
  }
  return gates.flatMap((gate) => [
    `- ${gate.nodeId}/${gate.gateId}: ${gate.reason ?? "failed"}`,
    ...gate.evidence.map((item) => `  evidence: ${item}`),
  ]);
}

function verifierLines(state: PipelineGoalState): string[] {
  const verifier = state.verifier;
  if (!verifier.verdict && verifier.evidence.length === 0) {
    return ["- No verifier evidence recorded."];
  }
  return [
    verifier.nodeId ? `- node_id: ${verifier.nodeId}` : "",
    verifier.verdict ? `- verdict: ${verifier.verdict}` : "",
    verifier.reason ? `- reason: ${verifier.reason}` : "",
    ...verifier.evidence.map((item) => `- evidence: ${item}`),
  ].filter(Boolean);
}

function acceptanceLines(state: PipelineGoalState): string[] {
  if (state.acceptance.length === 0) {
    return ["- No acceptance evidence recorded."];
  }
  return state.acceptance.flatMap((item) => [
    `- ${item.id}: ${item.verdict}`,
    ...item.evidence.map((evidence) => `  evidence: ${evidence}`),
  ]);
}

function changedFileLines(state: PipelineGoalState): string[] {
  if (state.changedFiles.length === 0) {
    return ["- No changed files recorded."];
  }
  return state.changedFiles.map((file) => `- ${file}`);
}

function priorAttemptLines(state: PipelineGoalState): string[] {
  if (state.continuationAttempts.length === 0) {
    return ["- No prior continuation attempts."];
  }
  return state.continuationAttempts.map(
    (attempt) =>
      `- #${attempt.attempt}: ${attempt.reason}${attempt.promptPath ? ` (${attempt.promptPath})` : ""}`
  );
}

function lineFor(label: string, value: unknown): string {
  return typeof value === "string" && value.length > 0
    ? `- ${label}: ${value}`
    : "";
}

function compactLines(lines: string[]): string {
  return `${lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()}\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
