import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { Option } from "effect";
import { z } from "zod";

import { uniqueStrings } from "../../strings";
import type { PipelineRuntimeEvent, PipelineTaskContext } from "../contracts";
import { goalStateNextRequirement } from "./goal-requirement";

const OUTCOME_VALUES = ["BLOCKED", "CANCELLED", "FAIL", "PASS"] as const;
const NODE_STATUS_VALUES = ["failed", "passed", "pending", "running"] as const;
const VERDICT_VALUES = ["FAIL", "PASS"] as const;
const MAX_EVIDENCE_ITEMS = 8;
const MAX_EVIDENCE_LENGTH = 500;

const isNonEmptyString = (value?: string): boolean =>
  value !== undefined && value.length > 0;

const evidenceSchema = z.array(z.string().max(MAX_EVIDENCE_LENGTH)).max(32);

const acceptanceCriterionVerdictSchema = z
  .object({
    evidence: evidenceSchema.default([]),
    id: z.string().min(1),
    verdict: z.enum(VERDICT_VALUES),
    violations: evidenceSchema.optional(),
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
        verdict: z.enum(VERDICT_VALUES).optional(),
        violations: evidenceSchema.optional(),
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

export const parseGoalState = (value: unknown): PipelineGoalState =>
  pipelineGoalStateSchema.parse(value);

export const createGoalState = (
  options: CreateGoalStateOptions
): PipelineGoalState =>
  parseGoalState({
    acceptance: [],
    blockedReasons: [],
    changedFiles: [],
    continuationAttempts: [],
    gateFailures: [],
    nodes: {},
    ...(isNonEmptyString(options.runId) ? { runId: options.runId } : {}),
    ...(isNonEmptyString(options.scheduleId) ||
    isNonEmptyString(options.schedulePath)
      ? {
          schedule: {
            ...(isNonEmptyString(options.scheduleId)
              ? { id: options.scheduleId }
              : {}),
            ...(isNonEmptyString(options.schedulePath)
              ? { path: options.schedulePath }
              : {}),
          },
        }
      : {}),
    task: {
      ...(options.taskContext === undefined
        ? {}
        : { context: options.taskContext }),
      original: options.task,
    },
    verifier: {},
    version: 1,
    workflowId: options.workflowId,
  });

export const goalStateFailureSignature = (state: PipelineGoalState): string =>
  [
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

export const goalStateArtifactPath = (runDirectory: string): string =>
  join(runDirectory, "goal-state.json");

export const saveGoalState = (
  state: PipelineGoalState,
  runDirectory: string
): void => {
  writeFileSync(
    goalStateArtifactPath(runDirectory),
    `${JSON.stringify(parseGoalState(state), null, 2)}\n`
  );
};

export const loadGoalState = (path: string): PipelineGoalState =>
  parseGoalState(JSON.parse(readFileSync(path, "utf-8")));

export const loadGoalStateFromRunDirectory = (
  runDirectory: string
): PipelineGoalState => {
  const path = goalStateArtifactPath(runDirectory);
  if (!existsSync(path)) {
    throw new Error(`goal state artifact not found: ${path}`);
  }
  return loadGoalState(path);
};

const isVerifierGate = (gate: z.infer<typeof goalGateAttemptSchema>): boolean =>
  gate.kind === "verdict" || gate.nodeId.includes("verif");

const isVerifierNode = (
  event: Extract<PipelineRuntimeEvent, { type: "node.output.recorded" }>
): boolean =>
  event.nodeId.includes("verif") ||
  Boolean(event.profile?.includes("verif")) ||
  Boolean(event.schemaPath?.includes("verify"));

const isVerdict = (value: unknown): value is (typeof VERDICT_VALUES)[number] =>
  value === "PASS" || value === "FAIL";

const safeEvidence = (value?: unknown[]): string[] =>
  (value ?? [])
    .flatMap((item) => (typeof item === "string" ? [item] : []))
    .slice(0, MAX_EVIDENCE_ITEMS)
    .map((item) => item.slice(0, MAX_EVIDENCE_LENGTH));

const optionalEvidence = (
  key: "violations",
  value: unknown
): { violations?: string[] } => {
  const evidence = Array.isArray(value) ? safeEvidence(value) : [];
  return evidence.length > 0 ? { [key]: evidence } : {};
};

const currentFailedNodeId = (state: PipelineGoalState): Option.Option<string> =>
  Option.map(
    Option.fromUndefinedOr(
      Object.values(state.nodes)
        .filter((node) => node.status === "failed")
        .at(-1)
    ),
    (node) => node.nodeId
  );

export const goalStateContinuationInput = (state: PipelineGoalState) => ({
  acceptance: state.acceptance,
  changedFiles: state.changedFiles,
  currentNodeId: Option.getOrUndefined(currentFailedNodeId(state)),
  exactNextRequirement: goalStateNextRequirement(state),
  failedGates: state.gateFailures.filter((gate) => !gate.passed),
  failureSignature: goalStateFailureSignature(state),
  originalTask: state.task.original,
  priorAttempts: state.continuationAttempts,
  taskContext: state.task.context,
  verifier: state.verifier,
});

const uniqueChangedFiles = (values: string[]): string[] =>
  uniqueStrings(values, { filterEmpty: true, sort: true });

const upsertNode = (
  state: PipelineGoalState,
  nodeId: string,
  patch: Partial<Omit<PipelineGoalState["nodes"][string], "nodeId">>
): void => {
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
    changedFiles: uniqueChangedFiles([
      ...current.changedFiles,
      ...(patch.changedFiles ?? []),
    ]),
    gates: patch.gates ?? current.gates,
    nodeId,
  };
};

const recordGateAttempt = (
  state: PipelineGoalState,
  gate: z.infer<typeof goalGateAttemptSchema>
): void => {
  upsertNode(state, gate.nodeId, {});
  state.nodes[gate.nodeId].gates.push(gate);
  if (!gate.passed) {
    state.gateFailures.push(gate);
    if (isVerifierGate(gate)) {
      state.verifier = {
        evidence: safeEvidence([...state.verifier.evidence, ...gate.evidence]),
        nodeId: gate.nodeId,
        ...(isNonEmptyString(gate.reason) ? { reason: gate.reason } : {}),
        ...(state.verifier.violations === undefined
          ? {}
          : { violations: state.verifier.violations }),
        verdict: "FAIL",
      };
    }
  }
};

const cloneGoalState = (state: PipelineGoalState): PipelineGoalState =>
  structuredClone(state);

export const recordGoalStateChangedFiles = (
  state: PipelineGoalState,
  nodeId: string,
  files: string[]
): PipelineGoalState => {
  const next = cloneGoalState(state);
  const uniqueFiles = uniqueChangedFiles(files);
  upsertNode(next, nodeId, { changedFiles: uniqueFiles });
  next.changedFiles = uniqueChangedFiles([
    ...next.changedFiles,
    ...uniqueFiles,
  ]);
  return parseGoalState(next);
};

export const recordGoalStateContinuationAttempt = (
  state: PipelineGoalState,
  attempt: {
    promptPath?: string;
    reason: string;
    verifierNodeId?: string;
  }
): PipelineGoalState => {
  const next = cloneGoalState(state);
  next.continuationAttempts.push({
    attempt: next.continuationAttempts.length + 1,
    ...(isNonEmptyString(attempt.promptPath)
      ? { promptPath: attempt.promptPath }
      : {}),
    reason: attempt.reason,
    ...(isNonEmptyString(attempt.verifierNodeId)
      ? { verifierNodeId: attempt.verifierNodeId }
      : {}),
  });
  return parseGoalState(next);
};

export const markGoalStateBlocked = (
  state: PipelineGoalState,
  reason: string
): PipelineGoalState => {
  const next = cloneGoalState(state);
  next.blockedReasons = safeEvidence([...next.blockedReasons, reason]);
  next.terminalOutcome = "BLOCKED";
  return parseGoalState(next);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const recordStructuredVerdicts = (
  state: PipelineGoalState,
  event: Extract<PipelineRuntimeEvent, { type: "node.output.recorded" }>
): void => {
  const { output } = event;
  if (!isRecord(output)) {
    return;
  }
  const { acceptance } = output;
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
};

export const applyGoalStateEvent = (
  state: PipelineGoalState,
  event: PipelineRuntimeEvent
): PipelineGoalState => {
  const next = cloneGoalState(state);
  switch (event.type) {
    case "workflow.planned": {
      for (const node of event.nodes) {
        upsertNode(next, node.id, {
          profile: node.profile,
          runnerId: node.runnerId,
          status: "pending",
        });
      }
      break;
    }
    case "node.start":
    case "agent.start": {
      upsertNode(next, event.nodeId, {
        attempts: event.attempt,
        profile: event.profile,
        runnerId: event.runnerId,
        status: "running",
      });
      break;
    }
    case "node.finish": {
      upsertNode(next, event.nodeId, {
        attempts: event.attempt,
        exitCode: event.exitCode,
        profile: event.profile,
        runnerId: event.runnerId,
        status: event.status === "passed" ? "passed" : "failed",
      });
      break;
    }
    case "gate.finish": {
      recordGateAttempt(next, {
        evidence: safeEvidence(event.evidence),
        gateId: event.gateId,
        kind: event.kind,
        nodeId: event.nodeId,
        passed: event.passed,
        ...(isNonEmptyString(event.reason) ? { reason: event.reason } : {}),
      });
      break;
    }
    case "node.output.recorded": {
      recordStructuredVerdicts(next, event);
      break;
    }
    case "workflow.finish": {
      next.terminalOutcome = event.outcome;
      break;
    }
    case "agent.finish": {
      throw new Error('Not implemented yet: "agent.finish" case');
    }
    case "artifact.check.finish": {
      throw new Error('Not implemented yet: "artifact.check.finish" case');
    }
    case "artifact.check.start": {
      throw new Error('Not implemented yet: "artifact.check.start" case');
    }
    case "delivery.pull-request": {
      throw new Error('Not implemented yet: "delivery.pull-request" case');
    }
    case "gate.start": {
      throw new Error('Not implemented yet: "gate.start" case');
    }
    case "hook.finish": {
      throw new Error('Not implemented yet: "hook.finish" case');
    }
    case "hook.result": {
      throw new Error('Not implemented yet: "hook.result" case');
    }
    case "hook.start": {
      throw new Error('Not implemented yet: "hook.start" case');
    }
    case "node.session": {
      throw new Error('Not implemented yet: "node.session" case');
    }
    case "output.repair": {
      throw new Error('Not implemented yet: "output.repair" case');
    }
    case "runtime.observability": {
      throw new Error('Not implemented yet: "runtime.observability" case');
    }
    case "workflow.start": {
      throw new Error('Not implemented yet: "workflow.start" case');
    }
    default: {
      break;
    }
  }
  return parseGoalState(next);
};

export const reconstructGoalStateFromEvents = (
  options: CreateGoalStateOptions,
  events: PipelineRuntimeEvent[]
): PipelineGoalState =>
  events.reduce(applyGoalStateEvent, createGoalState(options));

const expectedAcceptanceIds = (context: unknown): string[] => {
  if (!(isRecord(context) && Array.isArray(context.acceptanceCriteria))) {
    return [];
  }
  return context.acceptanceCriteria.flatMap((item) =>
    isRecord(item) && typeof item.id === "string" ? [item.id] : []
  );
};

const acceptanceCompletionEvidence = (state: PipelineGoalState): string[] => {
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
};

export const goalStateCompletionEvidence = (
  state: PipelineGoalState
): {
  evidence: string[];
  passed: boolean;
} => {
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
};
