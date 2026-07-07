import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  integer,
  mutableArray,
  nonNegativeInteger,
  parseStrictWithSchema,
  positiveInteger,
  requiredString,
  withDefault,
  struct,
} from "../../schema-boundary";
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

const evidenceItem = Schema.String.check(
  Schema.isMaxLength(MAX_EVIDENCE_LENGTH)
);
const evidenceSchema = mutableArray(evidenceItem).check(Schema.isMaxLength(32));

const acceptanceCriterionVerdictSchema = struct({
  evidence: withDefault(evidenceSchema, []),
  id: requiredString,
  verdict: Schema.Literals(VERDICT_VALUES),
  violations: Schema.optional(evidenceSchema),
});

const goalGateAttemptSchema = struct({
  evidence: withDefault(evidenceSchema, []),
  gateId: requiredString,
  kind: requiredString,
  nodeId: requiredString,
  passed: Schema.Boolean,
  reason: Schema.optional(requiredString),
});

const goalNodeStateSchema = struct({
  attempts: nonNegativeInteger,
  changedFiles: withDefault(mutableArray(requiredString), []),
  exitCode: Schema.optional(integer),
  gates: withDefault(mutableArray(goalGateAttemptSchema), []),
  nodeId: requiredString,
  profile: Schema.optional(requiredString),
  runnerId: Schema.optional(requiredString),
  status: Schema.Literals(NODE_STATUS_VALUES),
});

const continuationAttemptSchema = struct({
  attempt: positiveInteger,
  promptPath: Schema.optional(requiredString),
  reason: requiredString,
  verifierNodeId: Schema.optional(requiredString),
});

const goalStateSchema = struct({
  acceptance: withDefault(mutableArray(acceptanceCriterionVerdictSchema), []),
  blockedReasons: withDefault(evidenceSchema, []),
  changedFiles: withDefault(mutableArray(requiredString), []),
  continuationAttempts: withDefault(
    mutableArray(continuationAttemptSchema),
    []
  ),
  gateFailures: withDefault(mutableArray(goalGateAttemptSchema), []),
  nodes: withDefault(Schema.Record(requiredString, goalNodeStateSchema), {}),
  runId: Schema.optional(requiredString),
  schedule: Schema.optional(
    struct({
      id: Schema.optional(requiredString),
      path: Schema.optional(requiredString),
    })
  ),
  task: struct({
    context: Schema.optional(Schema.Unknown),
    original: Schema.String,
  }),
  terminalOutcome: Schema.optional(Schema.Literals(OUTCOME_VALUES)),
  verifier: withDefault(
    struct({
      evidence: withDefault(evidenceSchema, []),
      nodeId: Schema.optional(requiredString),
      reason: Schema.optional(requiredString),
      verdict: Schema.optional(Schema.Literals(VERDICT_VALUES)),
      violations: Schema.optional(evidenceSchema),
    }),
    { evidence: [] }
  ),
  version: Schema.Literal(1),
  workflowId: requiredString,
});

export const pipelineGoalStateSchema = goalStateSchema;
export type PipelineGoalState = typeof pipelineGoalStateSchema.Type;
type Mutable<T> = {
  -readonly [K in keyof T]: T[K] extends readonly (infer Item)[]
    ? Mutable<Item>[]
    : T[K] extends object
      ? Mutable<T[K]>
      : T[K];
};
type MutablePipelineGoalState = Mutable<PipelineGoalState>;

export interface CreateGoalStateOptions {
  runId?: string;
  scheduleId?: string;
  schedulePath?: string;
  task: string;
  taskContext?: PipelineTaskContext;
  workflowId: string;
}

export const parseGoalState = (value: unknown): PipelineGoalState =>
  parseStrictWithSchema(pipelineGoalStateSchema, value);

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

const isVerifierGate = (gate: typeof goalGateAttemptSchema.Type): boolean =>
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
      Object.values(state.nodes).findLast((node) => node.status === "failed")
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
  state: MutablePipelineGoalState,
  nodeId: string,
  patch: Partial<Omit<MutablePipelineGoalState["nodes"][string], "nodeId">>
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
  state: MutablePipelineGoalState,
  gate: typeof goalGateAttemptSchema.Type
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

const cloneGoalState = (state: PipelineGoalState): MutablePipelineGoalState =>
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
  state: MutablePipelineGoalState,
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

type RuntimeEventType = PipelineRuntimeEvent["type"];
type RuntimeEventOf<Type extends RuntimeEventType> = Extract<
  PipelineRuntimeEvent,
  { type: Type }
>;
type GoalStateEventHandler<Type extends RuntimeEventType> = (
  state: MutablePipelineGoalState,
  event: RuntimeEventOf<Type>
) => void;
type AnyGoalStateEventHandler = (
  state: MutablePipelineGoalState,
  event: PipelineRuntimeEvent
) => void;

const noGoalStateChange: AnyGoalStateEventHandler = (state) => {
  void state;
};

const isRuntimeEventOfType = <Type extends RuntimeEventType>(
  event: PipelineRuntimeEvent,
  type: Type
): event is RuntimeEventOf<Type> => event.type === type;

const goalStateEventHandler =
  <Type extends RuntimeEventType>(
    type: Type,
    handler: GoalStateEventHandler<Type>
  ): AnyGoalStateEventHandler =>
  (state, event) => {
    if (!isRuntimeEventOfType(event, type)) {
      throw new Error(`Goal-state handler mismatch for event type ${type}`);
    }
    handler(state, event);
  };

const recordPendingWorkflowNodes: GoalStateEventHandler<"workflow.planned"> = (
  state,
  event
) => {
  for (const node of event.nodes) {
    upsertNode(state, node.id, {
      profile: node.profile,
      runnerId: node.runnerId,
      status: "pending",
    });
  }
};

const recordStartedNode = (
  state: MutablePipelineGoalState,
  event: RuntimeEventOf<"agent.start" | "node.start">
): void => {
  upsertNode(state, event.nodeId, {
    attempts: event.attempt,
    profile: event.profile,
    runnerId: event.runnerId,
    status: "running",
  });
};

const recordFinishedNode: GoalStateEventHandler<"node.finish"> = (
  state,
  event
) => {
  upsertNode(state, event.nodeId, {
    attempts: event.attempt,
    exitCode: event.exitCode,
    profile: event.profile,
    runnerId: event.runnerId,
    status: event.status === "passed" ? "passed" : "failed",
  });
};

const recordFinishedGate: GoalStateEventHandler<"gate.finish"> = (
  state,
  event
) => {
  recordGateAttempt(state, {
    evidence: safeEvidence(event.evidence),
    gateId: event.gateId,
    kind: event.kind,
    nodeId: event.nodeId,
    passed: event.passed,
    ...(isNonEmptyString(event.reason) ? { reason: event.reason } : {}),
  });
};

const recordTerminalOutcome: GoalStateEventHandler<"workflow.finish"> = (
  state,
  event
) => {
  state.terminalOutcome = event.outcome;
};

const GOAL_STATE_EVENT_HANDLERS: Record<
  RuntimeEventType,
  AnyGoalStateEventHandler
> = {
  "agent.finish": noGoalStateChange,
  "agent.start": goalStateEventHandler("agent.start", recordStartedNode),
  "artifact.check.finish": noGoalStateChange,
  "artifact.check.start": noGoalStateChange,
  "delivery.pull-request": noGoalStateChange,
  "gate.finish": goalStateEventHandler("gate.finish", recordFinishedGate),
  "gate.start": noGoalStateChange,
  "hook.finish": noGoalStateChange,
  "hook.result": noGoalStateChange,
  "hook.start": noGoalStateChange,
  "node.finish": goalStateEventHandler("node.finish", recordFinishedNode),
  "node.output.recorded": goalStateEventHandler(
    "node.output.recorded",
    recordStructuredVerdicts
  ),
  "node.session": noGoalStateChange,
  "node.start": goalStateEventHandler("node.start", recordStartedNode),
  "output.repair": noGoalStateChange,
  "runtime.observability": noGoalStateChange,
  "workflow.finish": goalStateEventHandler(
    "workflow.finish",
    recordTerminalOutcome
  ),
  "workflow.planned": goalStateEventHandler(
    "workflow.planned",
    recordPendingWorkflowNodes
  ),
  "workflow.start": noGoalStateChange,
};

export const applyGoalStateEvent = (
  state: PipelineGoalState,
  event: PipelineRuntimeEvent
): PipelineGoalState => {
  const next = cloneGoalState(state);
  GOAL_STATE_EVENT_HANDLERS[event.type](next, event);
  return parseGoalState(next);
};

export const reconstructGoalStateFromEvents = (
  options: CreateGoalStateOptions,
  events: PipelineRuntimeEvent[]
): PipelineGoalState =>
  Arr.reduce(events, createGoalState(options), applyGoalStateEvent);

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
