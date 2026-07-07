import { Option } from "effect";

import { goalStateNextRequirement } from "../goal-state/goal-requirement";
import type { PipelineGoalState } from "../goal-state/goal-state";

export interface ContinuationPromptInput {
  currentNodeId?: string;
  exactNextRequirement?: string;
  state: PipelineGoalState;
}

export const exactNextRequirement = (state: PipelineGoalState): string =>
  goalStateNextRequirement(state);

const currentScheduleNode = (
  state: PipelineGoalState,
  requestedNodeId?: string
): Option.Option<PipelineGoalState["nodes"][string]> => {
  if (
    requestedNodeId !== undefined &&
    requestedNodeId.length > 0 &&
    requestedNodeId in state.nodes
  ) {
    return Option.some(state.nodes[requestedNodeId]);
  }
  const failedNode = Object.values(state.nodes)
    .toReversed()
    .find((node) => node.status === "failed");
  return Option.fromUndefinedOr(
    failedNode ?? Object.values(state.nodes).at(-1)
  );
};

const optionalLine = (label: string, value?: string): string =>
  value === undefined || value.length === 0 ? "" : `- ${label}: ${value}`;

const scheduleLines = (state: PipelineGoalState): string[] =>
  [
    `- workflow_id: ${state.workflowId}`,
    optionalLine("run_id", state.runId),
    optionalLine("schedule_id", state.schedule?.id),
    optionalLine("schedule_path", state.schedule?.path),
  ].filter(Boolean);

const nodeContextLines = (
  node: Option.Option<PipelineGoalState["nodes"][string]>
): string[] =>
  Option.match(node, {
    onNone: () => ["- No schedule node has run yet."],
    onSome: (value) =>
      [
        `- node_id: ${value.nodeId}`,
        `- status: ${value.status}`,
        `- attempts: ${value.attempts}`,
        optionalLine("profile", value.profile),
        optionalLine("runner", value.runnerId),
        value.changedFiles.length > 0
          ? `- node_changed_files: ${value.changedFiles.join(", ")}`
          : "",
        ...value.gates.map(
          (gate) =>
            `- gate ${gate.gateId}: ${gate.passed ? "PASS" : "FAIL"}${gate.reason === undefined || gate.reason.length === 0 ? "" : ` (${gate.reason})`}`
        ),
      ].filter(Boolean),
  });

const failedGateLines = (
  gates: PipelineGoalState["gateFailures"]
): string[] => {
  if (gates.length === 0) {
    return ["- No failed gates recorded."];
  }
  return gates.flatMap((gate) => [
    `- ${gate.nodeId}/${gate.gateId}: ${gate.reason ?? "failed"}`,
    ...gate.evidence.map((item) => `  evidence: ${item}`),
  ]);
};

const verifierLines = (state: PipelineGoalState): string[] => {
  const { verifier } = state;
  if (verifier.verdict === undefined && verifier.evidence.length === 0) {
    return ["- No verifier evidence recorded."];
  }
  return [
    optionalLine("node_id", verifier.nodeId),
    optionalLine("verdict", verifier.verdict),
    optionalLine("reason", verifier.reason),
    ...verifier.evidence.map((item) => `- evidence: ${item}`),
  ].filter(Boolean);
};

const acceptanceLines = (state: PipelineGoalState): string[] => {
  if (state.acceptance.length === 0) {
    return ["- No acceptance evidence recorded."];
  }
  return state.acceptance.flatMap((item) => [
    `- ${item.id}: ${item.verdict}`,
    ...item.evidence.map((evidence) => `  evidence: ${evidence}`),
  ]);
};

const changedFileLines = (state: PipelineGoalState): string[] => {
  if (state.changedFiles.length === 0) {
    return ["- No changed files recorded."];
  }
  return state.changedFiles.map((file) => `- ${file}`);
};

const priorAttemptLines = (state: PipelineGoalState): string[] => {
  if (state.continuationAttempts.length === 0) {
    return ["- No prior continuation attempts."];
  }
  return state.continuationAttempts.map(
    (attempt) =>
      `- #${attempt.attempt}: ${attempt.reason}${attempt.promptPath === undefined || attempt.promptPath.length === 0 ? "" : ` (${attempt.promptPath})`}`
  );
};

const lineFor = (label: string, value: unknown): string =>
  typeof value === "string" && value.length > 0 ? `- ${label}: ${value}` : "";

const compactLines = (lines: string[]): string =>
  `${lines
    .join("\n")
    .replaceAll(/\n{3,}/gu, "\n\n")
    .trim()}\n`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const acceptanceCriteriaRefLines = (value: unknown): string[] => {
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
};

const taskRefLines = (context: unknown): string[] => {
  if (!isRecord(context)) {
    return ["- No task context recorded."];
  }
  return [
    lineFor("id", context.id),
    lineFor("title", context.title),
    lineFor("description", context.description),
    ...acceptanceCriteriaRefLines(context.acceptanceCriteria),
  ].filter(Boolean);
};

export const renderContinuationPrompt = (
  input: ContinuationPromptInput
): string => {
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
};
