import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { PipelineRuntimeEvent, PipelineTaskContext } from "../contracts";
import { goalStateNextRequirement } from "./goal-requirement";

const OUTCOME_VALUES = ["BLOCKED", "CANCELLED", "FAIL", "PASS"] as const;
const NODE_STATUS_VALUES = ["failed", "passed", "pending", "running"] as const;
const VERDICT_VALUES = ["FAIL", "PASS"] as const;
const MAX_EVIDENCE_ITEMS = 8;
const MAX_EVIDENCE_LENGTH = 500;

const evidenceSchema = z.array(z.string().max(MAX_EVIDENCE_LENGTH)).max(32);

const acceptanceCriterionVerdictSchema = z
  .object({
    evidence: evidenceSchema.default([]),
    id: z.string().min(1),
    violations: evidenceSchema.optional(),
    verdict: z.enum(VERDICT_VALUES),
  })
  .strict();

const goalGateAttemptSchema = z
  .object({
    evidence: evidenceSchema.default([]),
    gateId: z.string().min(1),
    kind: z.string().min(1),
    nodeId: z.string().min(1),
    passed: z.boolean(),
    reason: z.string().min(1).optional(),
  })
  .strict();

const goalNodeStateSchema = z
  .object({
    attempts: z.number().int().nonnegative(),
    changedFiles: z.array(z.string().min(1)).default([]),
    exitCode: z.number().int().optional(),
    gates: z.array(goalGateAttemptSchema).default([]),
    nodeId: z.string().min(1),
    profile: z.string().min(1).optional(),
    runnerId: z.string().min(1).optional(),
    status: z.enum(NODE_STATUS_VALUES),
  })
  .strict();

const continuationAttemptSchema = z
  .object({
    attempt: z.number().int().positive(),
    promptPath: z.string().min(1).optional(),
    reason: z.string().min(1),
    verifierNodeId: z.string().min(1).optional(),
  })
  .strict();

const goalStateSchema = z
  .object({
    acceptance: z.array(acceptanceCriterionVerdictSchema).default([]),
    blockedReasons: evidenceSchema.default([]),
    changedFiles: z.array(z.string().min(1)).default([]),
    continuationAttempts: z.array(continuationAttemptSchema).default([]),
    gateFailures: z.array(goalGateAttemptSchema).default([]),
    nodes: z.record(z.string().min(1), goalNodeStateSchema).default({}),
    runId: z.string().min(1).optional(),
    schedule: z
      .object({
        id: z.string().min(1).optional(),
        path: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    task: z
      .object({
        context: z.unknown().optional(),
        original: z.string(),
      })
      .strict(),
    terminalOutcome: z.enum(OUTCOME_VALUES).optional(),
    verifier: z
      .object({
        evidence: evidenceSchema.default([]),
        nodeId: z.string().min(1).optional(),
        reason: z.string().min(1).optional(),
        violations: evidenceSchema.optional(),
        verdict: z.enum(VERDICT_VALUES).optional(),
      })
      .strict()
      .default({ evidence: [] }),
    version: z.literal(1),
    workflowId: z.string().min(1),
  })
  .strict();

export const pipelineGoalStateSchema = goalStateSchema;
export type PipelineGoalState = z.infer<typeof pipelineGoalStateSchema>;

export interface CreateGoalStateOptions {
  runId?: string;
  scheduleId?: string;
  schedulePath?: string;
  task: string;
  taskContext?: PipelineTaskContext;
  workflowId: string;
}

export function createGoalState(
  options: CreateGoalStateOptions
): PipelineGoalState {
  return parseGoalState({
    acceptance: [],
    blockedReasons: [],
    changedFiles: [],
    continuationAttempts: [],
    gateFailures: [],
    nodes: {},
    ...(options.runId ? { runId: options.runId } : {}),
    ...(options.scheduleId || options.schedulePath
      ? {
          schedule: {
            ...(options.scheduleId ? { id: options.scheduleId } : {}),
            ...(options.schedulePath ? { path: options.schedulePath } : {}),
          },
        }
      : {}),
    task: {
      ...(options.taskContext ? { context: options.taskContext } : {}),
      original: options.task,
    },
    verifier: {},
    version: 1,
    workflowId: options.workflowId,
  });
}

export function parseGoalState(value: unknown): PipelineGoalState {
  return pipelineGoalStateSchema.parse(value);
}

export function applyGoalStateEvent(
  state: PipelineGoalState,
  event: PipelineRuntimeEvent
): PipelineGoalState {
  const next = cloneGoalState(state);
  switch (event.type) {
    case "workflow.planned":
      for (const node of event.nodes) {
        upsertNode(next, node.id, {
          profile: node.profile,
          runnerId: node.runnerId,
          status: "pending",
        });
      }
      break;
    case "node.start":
    case "agent.start":
      upsertNode(next, event.nodeId, {
        attempts: event.attempt,
        profile: event.profile,
        runnerId: event.runnerId,
        status: "running",
      });
      break;
    case "node.finish":
      upsertNode(next, event.nodeId, {
        attempts: event.attempt,
        exitCode: event.exitCode,
        profile: event.profile,
        runnerId: event.runnerId,
        status: event.status === "passed" ? "passed" : "failed",
      });
      break;
    case "gate.finish":
      recordGateAttempt(next, {
        evidence: safeEvidence(event.evidence),
        gateId: event.gateId,
        kind: event.kind,
        nodeId: event.nodeId,
        passed: event.passed,
        ...(event.reason ? { reason: event.reason } : {}),
      });
      break;
    case "node.output.recorded":
      recordStructuredVerdicts(next, event);
      break;
    case "workflow.finish":
      next.terminalOutcome = event.outcome;
      break;
    default:
      break;
  }
  return parseGoalState(next);
}

export function reconstructGoalStateFromEvents(
  options: CreateGoalStateOptions,
  events: PipelineRuntimeEvent[]
): PipelineGoalState {
  return events.reduce(applyGoalStateEvent, createGoalState(options));
}

export function recordGoalStateChangedFiles(
  state: PipelineGoalState,
  nodeId: string,
  files: string[]
): PipelineGoalState {
  const next = cloneGoalState(state);
  const uniqueFiles = uniqueStrings(files);
  upsertNode(next, nodeId, { changedFiles: uniqueFiles });
  next.changedFiles = uniqueStrings([...next.changedFiles, ...uniqueFiles]);
  return parseGoalState(next);
}

export function recordGoalStateContinuationAttempt(
  state: PipelineGoalState,
  attempt: {
    promptPath?: string;
    reason: string;
    verifierNodeId?: string;
  }
): PipelineGoalState {
  const next = cloneGoalState(state);
  next.continuationAttempts.push({
    attempt: next.continuationAttempts.length + 1,
    ...(attempt.promptPath ? { promptPath: attempt.promptPath } : {}),
    reason: attempt.reason,
    ...(attempt.verifierNodeId
      ? { verifierNodeId: attempt.verifierNodeId }
      : {}),
  });
  return parseGoalState(next);
}

export function markGoalStateBlocked(
  state: PipelineGoalState,
  reason: string
): PipelineGoalState {
  const next = cloneGoalState(state);
  next.blockedReasons = safeEvidence([...next.blockedReasons, reason]);
  next.terminalOutcome = "BLOCKED";
  return parseGoalState(next);
}

export function goalStateCompletionEvidence(state: PipelineGoalState): {
  evidence: string[];
  passed: boolean;
} {
  const evidence: string[] = [];
  const verifierPassed =
    state.verifier.verdict === "PASS" &&
    state.verifier.evidence.length > 0 &&
    (state.verifier.violations?.length ?? 0) === 0;
  evidence.push(
    verifierPassed
      ? `verifier '${state.verifier.nodeId ?? "verify"}' passed with evidence`
      : "missing passing verifier evidence"
  );

  for (const item of acceptanceCompletionEvidence(state)) {
    evidence.push(item);
  }
  return {
    evidence,
    passed:
      verifierPassed &&
      evidence.every((item) => !item.startsWith("missing ")) &&
      evidence.every((item) => !item.includes(" failed")) &&
      evidence.every((item) => !item.includes(" violations")),
  };
}

export function goalStateContinuationInput(state: PipelineGoalState) {
  return {
    acceptance: state.acceptance,
    changedFiles: state.changedFiles,
    currentNodeId: currentFailedNodeId(state),
    exactNextRequirement: goalStateNextRequirement(state),
    failedGates: state.gateFailures.filter((gate) => !gate.passed),
    failureSignature: goalStateFailureSignature(state),
    originalTask: state.task.original,
    priorAttempts: state.continuationAttempts,
    taskContext: state.task.context,
    verifier: state.verifier,
  };
}

export function goalStateFailureSignature(state: PipelineGoalState): string {
  return [
    ...state.gateFailures.map((gate) =>
      [gate.nodeId, gate.gateId, gate.reason ?? "", ...gate.evidence].join("/")
    ),
    state.verifier.verdict === "FAIL"
      ? [
          state.verifier.nodeId ?? "verify",
          state.verifier.reason ?? "",
          ...state.verifier.evidence,
          ...(state.verifier.violations ?? []),
        ].join("/")
      : "",
    ...state.acceptance
      .filter((item) => item.verdict === "FAIL")
      .map((item) =>
        ["acceptance", item.id, ...item.evidence, ...(item.violations ?? [])]
          .filter(Boolean)
          .join("/")
      ),
  ]
    .filter(Boolean)
    .join("\0");
}

export function goalStateArtifactPath(runDirectory: string): string {
  return join(runDirectory, "goal-state.json");
}

export function saveGoalState(
  state: PipelineGoalState,
  runDirectory: string
): void {
  writeFileSync(
    goalStateArtifactPath(runDirectory),
    `${JSON.stringify(parseGoalState(state), null, 2)}\n`
  );
}

export function loadGoalState(path: string): PipelineGoalState {
  return parseGoalState(JSON.parse(readFileSync(path, "utf8")));
}

export function loadGoalStateFromRunDirectory(
  runDirectory: string
): PipelineGoalState {
  const path = goalStateArtifactPath(runDirectory);
  if (!existsSync(path)) {
    throw new Error(`goal state artifact not found: ${path}`);
  }
  return loadGoalState(path);
}

function recordGateAttempt(
  state: PipelineGoalState,
  gate: z.infer<typeof goalGateAttemptSchema>
): void {
  upsertNode(state, gate.nodeId, {});
  state.nodes[gate.nodeId].gates.push(gate);
  if (!gate.passed) {
    state.gateFailures.push(gate);
    if (isVerifierGate(gate)) {
      state.verifier = {
        evidence: safeEvidence([...state.verifier.evidence, ...gate.evidence]),
        nodeId: gate.nodeId,
        ...(gate.reason ? { reason: gate.reason } : {}),
        ...(state.verifier.violations
          ? { violations: state.verifier.violations }
          : {}),
        verdict: "FAIL",
      };
    }
  }
}

function recordStructuredVerdicts(
  state: PipelineGoalState,
  event: Extract<PipelineRuntimeEvent, { type: "node.output.recorded" }>
): void {
  const output = event.output;
  if (!isRecord(output)) {
    return;
  }
  const acceptance = output.acceptance;
  if (Array.isArray(acceptance)) {
    state.acceptance = acceptance.flatMap((item) => {
      if (
        !(isRecord(item) && isVerdict(item.verdict)) ||
        typeof item.id !== "string"
      ) {
        return [];
      }
      return [
        {
          evidence: safeEvidence(
            Array.isArray(item.evidence) ? item.evidence : []
          ),
          id: item.id,
          ...optionalEvidence("violations", item.violations),
          verdict: item.verdict,
        },
      ];
    });
  }
  if (isVerifierNode(event) && isVerdict(output.verdict)) {
    state.verifier = {
      evidence: safeEvidence(
        Array.isArray(output.evidence) ? output.evidence : []
      ),
      nodeId: event.nodeId,
      ...optionalEvidence("violations", output.violations),
      verdict: output.verdict,
    };
  }
}

function upsertNode(
  state: PipelineGoalState,
  nodeId: string,
  patch: Partial<Omit<PipelineGoalState["nodes"][string], "nodeId">>
): void {
  const current = state.nodes[nodeId] ?? {
    attempts: 0,
    changedFiles: [],
    gates: [],
    nodeId,
    status: "pending",
  };
  state.nodes[nodeId] = {
    ...current,
    ...patch,
    attempts: Math.max(current.attempts, patch.attempts ?? 0),
    changedFiles: uniqueStrings([
      ...current.changedFiles,
      ...(patch.changedFiles ?? []),
    ]),
    gates: patch.gates ?? current.gates,
    nodeId,
  };
}

function isVerifierGate(gate: z.infer<typeof goalGateAttemptSchema>): boolean {
  return gate.kind === "verdict" || gate.nodeId.includes("verif");
}

function isVerifierNode(
  event: Extract<PipelineRuntimeEvent, { type: "node.output.recorded" }>
): boolean {
  return (
    event.nodeId.includes("verif") ||
    Boolean(event.profile?.includes("verif")) ||
    Boolean(event.schemaPath?.includes("verify"))
  );
}

function isVerdict(value: unknown): value is (typeof VERDICT_VALUES)[number] {
  return value === "PASS" || value === "FAIL";
}

function safeEvidence(value: unknown[] | undefined): string[] {
  return (value ?? [])
    .flatMap((item) => (typeof item === "string" ? [item] : []))
    .slice(0, MAX_EVIDENCE_ITEMS)
    .map((item) => item.slice(0, MAX_EVIDENCE_LENGTH));
}

function optionalEvidence(
  key: "violations",
  value: unknown
): { violations?: string[] } {
  const evidence = Array.isArray(value) ? safeEvidence(value) : [];
  return evidence.length > 0 ? { [key]: evidence } : {};
}

function acceptanceCompletionEvidence(state: PipelineGoalState): string[] {
  const expected = expectedAcceptanceIds(state.task.context);
  if (expected.length === 0) {
    return ["acceptance criteria not required by task context"];
  }
  const byId = new Map(state.acceptance.map((item) => [item.id, item]));
  return expected.map((id) => {
    const item = byId.get(id);
    if (!item) {
      return `missing acceptance criterion '${id}' evidence`;
    }
    if (item.verdict !== "PASS") {
      return `acceptance criterion '${id}' failed`;
    }
    if (item.evidence.length === 0) {
      return `missing acceptance criterion '${id}' evidence`;
    }
    if ((item.violations?.length ?? 0) > 0) {
      return `acceptance criterion '${id}' has violations`;
    }
    return `acceptance criterion '${id}' passed with evidence`;
  });
}

function expectedAcceptanceIds(context: unknown): string[] {
  if (!(isRecord(context) && Array.isArray(context.acceptanceCriteria))) {
    return [];
  }
  return context.acceptanceCriteria.flatMap((item) =>
    isRecord(item) && typeof item.id === "string" ? [item.id] : []
  );
}

function currentFailedNodeId(state: PipelineGoalState): string | undefined {
  return Object.values(state.nodes)
    .filter((node) => node.status === "failed")
    .at(-1)?.nodeId;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort();
}

function cloneGoalState(state: PipelineGoalState): PipelineGoalState {
  return JSON.parse(JSON.stringify(state)) as PipelineGoalState;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
