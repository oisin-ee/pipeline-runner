import { readFileSync } from "node:fs";

import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import parseGitUrl from "git-url-parse";

import type { PipelineRuntimeEvent } from "./pipeline-runtime";
import type { HookRuntimePolicy } from "./runtime/contracts";
import { parseJsonResult } from "./safe-json";
import {
  EffectSchemaIssue,
  mutableArray,
  nonEmptyMutableArray,
  parseResultWithSchema,
  parseStrictWithSchema,
  positiveInteger,
  requiredString,
  stringRecord,
  urlString,
  withDefault,
  struct,
} from "./schema-boundary";

const RUNNER_COMMAND_CONTRACT_VERSION = "1";

const isGitRemoteUrl = (value: string): boolean => {
  try {
    parseGitUrl(value);
    return true;
  } catch {
    return false;
  }
};

/*
 * Runner payload v1, event record schema shapes, schedule artifact references,
 * and pipeline.oisin.dev/* Kubernetes label conventions are stable external
 * contracts for Pipeline Console and other external consumers. Breaking changes
 * require a contract version bump and an explicit compatibility plan.
 */
export const gitRemoteUrlSchema = requiredString.check(
  Schema.makeFilter((value) => isGitRemoteUrl(value) || "must be a valid git remote URL", {
    description: "Git remote URL parseable by git-url-parse.",
    identifier: "GitRemoteUrl",
    title: "Git remote URL",
  }),
);

export const runnerRunIdentitySchema = struct({
  id: requiredString,
  project: requiredString,
  requestedBy: Schema.optional(requiredString),
});

export const runnerWorkflowIdentitySchema = struct({
  id: requiredString,
});

export const runnerTaskPromptSchema = struct({
  kind: Schema.Literal("prompt"),
  prompt: requiredString,
  title: Schema.optional(requiredString),
});

export const runnerTaskTicketSchema = struct({
  id: requiredString,
  kind: Schema.Literal("ticket"),
  path: Schema.optional(requiredString),
  title: Schema.optional(requiredString),
});

export const runnerTask = Schema.Union([runnerTaskPromptSchema, runnerTaskTicketSchema]);
export type runnerTask = typeof runnerTask.Type;

export const runnerRepositoryContextSchema = struct({
  baseBranch: requiredString,
  headBranch: Schema.optional(requiredString),
  sha: Schema.optional(requiredString),
  url: gitRemoteUrlSchema,
});

export const runnerDeliverySchema = struct({
  mode: withDefault(Schema.Literals(["create-new-pr", "update-existing-pr"]), "create-new-pr"),
  pullRequest: withDefault(Schema.Boolean, false),
});

const mokaGraphSubmissionSchema = struct({
  kind: Schema.Literal("graph"),
  mode: Schema.Literals(["full", "quick"]),
});

const mokaCommandSubmissionSchema = struct({
  argv: nonEmptyMutableArray(requiredString),
  kind: Schema.Literal("command"),
});

const mokaSubmission = Schema.Union([mokaGraphSubmissionSchema, mokaCommandSubmissionSchema]);

export const runnerEventsSchema = struct({
  authHeader: withDefault(requiredString, "Authorization"),
  authTokenFile: requiredString,
  url: urlString,
});

export const runnerHookPolicySchema = struct({
  allowCommandHooks: Schema.optional(Schema.Boolean),
  allowUntrustedCommandHooks: Schema.optional(Schema.Boolean),
  env: Schema.optional(stringRecord),
  envPassthrough: Schema.optional(mutableArray(requiredString)),
  outputLimitBytes: Schema.optional(positiveInteger),
  timeoutMs: Schema.optional(positiveInteger),
});

const runnerMomokayaContextSchema = struct({
  automationNamespace: Schema.optional(requiredString),
  previewEnabled: Schema.Boolean,
  repoKey: Schema.optional(requiredString),
});

export const runnerCommandPayloadSchema = struct({
  contractVersion: withDefault(Schema.Literal(RUNNER_COMMAND_CONTRACT_VERSION), RUNNER_COMMAND_CONTRACT_VERSION),
  delivery: withDefault(runnerDeliverySchema, {
    mode: "create-new-pr",
    pullRequest: false,
  }),
  events: runnerEventsSchema,
  hookPolicy: Schema.optional(runnerHookPolicySchema),
  momokaya: Schema.optional(runnerMomokayaContextSchema),
  repository: runnerRepositoryContextSchema,
  run: runnerRunIdentitySchema,
  submission: withDefault(mokaSubmission, {
    kind: "graph",
    mode: "full",
  }),
  task: runnerTask,
  workflow: runnerWorkflowIdentitySchema,
});

export type RunnerDelivery = typeof runnerDeliverySchema.Type;
export type RunnerEvents = typeof runnerEventsSchema.Type;
export type RunnerHookPolicy = typeof runnerHookPolicySchema.Type;
export type MokaSubmission = typeof mokaSubmission.Type;
export type RunnerCommandPayload = typeof runnerCommandPayloadSchema.Type;
export type RunnerMomokayaContext = typeof runnerMomokayaContextSchema.Type;
export type RunnerRepositoryContext = typeof runnerRepositoryContextSchema.Type;
export type RunnerRunIdentity = typeof runnerRunIdentitySchema.Type;
export type RunnerTask = typeof runnerTask.Type;
export type RunnerWorkflowIdentity = typeof runnerWorkflowIdentitySchema.Type;

export interface RunnerCommandPayloadValidationIssue {
  code: string;
  message: string;
  path: string;
}

interface RecoverableRunnerCommandPayloadEnvelope {
  events: RunnerEvents;
  run: RunnerRunIdentity;
}

const runnerCommandPayloadValidationIssue = Schema.Class<RunnerCommandPayloadValidationIssue>(
  "RunnerCommandPayloadValidationIssue",
)({
  code: Schema.String,
  message: Schema.String,
  path: Schema.String,
});

export class RunnerCommandPayloadValidationError extends Schema.TaggedErrorClass<RunnerCommandPayloadValidationError>()(
  "RunnerCommandPayloadValidationError",
  {
    issues: Schema.Array(runnerCommandPayloadValidationIssue),
    message: Schema.String,
  },
) {
  constructor(message: string, issues: RunnerCommandPayloadValidationIssue[]) {
    super({ issues, message });
  }
}

type RunnerCommandPayloadParseResult =
  | { ok: true; payload: RunnerCommandPayload }
  | {
      error: RunnerCommandPayloadValidationError;
      ok: false;
      recoverable?: RecoverableRunnerCommandPayloadEnvelope;
    };

export interface BuildRunnerCommandPayloadOptions {
  delivery?: RunnerDelivery;
  events: RunnerEvents;
  hookPolicy?: HookRuntimePolicy;
  momokaya?: RunnerMomokayaContext;
  repository: RunnerRepositoryContext;
  run: RunnerRunIdentity;
  submission?: MokaSubmission;
  task: RunnerTask;
  workflow: RunnerWorkflowIdentity;
}

export interface ResolveRunnerEventSinkAuthTokenOptions {
  authTokenFile?: string;
  readFile?: (path: string) => string;
}

export interface RunnerEventMappingContext {
  runId: string;
  sequence?: number;
  timestamp: string;
}

export interface RunnerWorkflowNodeDetails {
  id: string;
  kind: string;
  needs: string[];
  profile?: string;
  runnerId?: string;
}

export interface RunnerWorkflowEdgeDetails {
  source: string;
  target: string;
}

export interface RunnerWorkflowPlanDetails {
  edges?: RunnerWorkflowEdgeDetails[];
  nodeIds?: string[];
  nodes?: RunnerWorkflowNodeDetails[];
  workflowId: string;
}

export interface RunnerWorkflowEdgeRecordDetails {
  id: string;
  source: string;
  target: string;
}

export type RunnerNodeStatus = "agent-finished" | "agent-running" | "failed" | "passed" | "running";

export interface RunnerNodeDetails {
  attempt: number;
  exitCode?: number;
  nodeId: string;
  profile?: string;
  runnerId?: string;
  status: RunnerNodeStatus;
}

export type RunnerGateStatus = "failed" | "passed" | "running";

export interface RunnerGateDetails {
  event?: string;
  evidence?: string[];
  gateId?: string;
  hookId?: string;
  kind?: string;
  label?: string;
  nodeId?: string;
  passed?: boolean;
  reason?: string;
  required?: boolean;
  status: RunnerGateStatus;
  workflowId?: string;
}

export type RunnerArtifactStatus = "failed" | "passed" | "running";

export interface RunnerArtifactDetails {
  kind: "artifact";
  label: string;
  nodeId: string;
  passed?: boolean;
  path: string;
  reason?: string;
  required: boolean;
  status: RunnerArtifactStatus;
  uri: string;
}

export type RunnerLogLevel = "info" | "warn";

export interface RunnerLogDetails {
  attempt?: number;
  format?: string;
  level: RunnerLogLevel;
  message: string;
  nodeId?: string;
  output?: unknown;
  passed?: boolean;
  reason?: string;
  workflowId?: string;
}

export interface RunnerFinalResultDetails {
  outcome: "CANCELLED" | "FAIL" | "PASS";
  workflowId: string;
}

export interface RunnerPullRequestDeliveryDetails {
  action: "opened" | "updated";
  url: string;
}

export interface RunnerHookResultDetails {
  artifacts?: { contentType?: string; name: string; path: string }[];
  event: string;
  functionId: string;
  gateId?: string;
  hookId: string;
  nodeId?: string;
  outputs?: Record<string, unknown>;
  status: "fail" | "pass" | "skip";
  summary?: string;
  workflowId: string;
}

interface RunnerEventEnvelope {
  at?: string;
  runId: string;
  sequence: number;
  type: string;
}

/** Lifecycle of a single ticket node in the cloud loop controller. */
export type LoopState = "queued" | "running" | "merging" | "passed" | "blocked";

export interface LoopStartDetails {
  readonly projectId: string;
  readonly root?: string;
  readonly strategy: string;
}

export interface LoopGraphSnapshotNodeDetails {
  readonly id: string;
  readonly loopState: LoopState;
  readonly priority?: "high" | "medium" | "low";
  readonly status: "To Do" | "In Progress" | "Done";
  readonly title: string;
}

export interface LoopGraphSnapshotEdgeDetails {
  readonly from: string;
  readonly to: string;
}

export interface LoopGraphSnapshotDetails {
  readonly batches: readonly (readonly string[])[];
  readonly dangling: readonly string[];
  readonly edges: readonly LoopGraphSnapshotEdgeDetails[];
  readonly nodes: readonly LoopGraphSnapshotNodeDetails[];
}

export interface LoopNodeTransitionDetails {
  readonly loopState: LoopState;
  readonly ticketId: string;
}

export interface LoopFinishDetails {
  readonly blocked: number;
  readonly passed: number;
}

export type RunnerEventRecord =
  | (RunnerEventEnvelope & {
      type: "workflow.planned" | "workflow.start";
      workflowPlan: RunnerWorkflowPlanDetails;
    })
  | (RunnerEventEnvelope & {
      edge: RunnerWorkflowEdgeRecordDetails;
      type: "workflow.edge";
    })
  | (RunnerEventEnvelope & {
      node: RunnerNodeDetails;
      type: "agent.finish" | "agent.start" | "node.finish" | "node.start";
    })
  | (RunnerEventEnvelope & {
      gate: RunnerGateDetails;
      type: "gate.finish" | "gate.start" | "hook.finish" | "hook.start";
    })
  | (RunnerEventEnvelope & {
      hookResult: RunnerHookResultDetails;
      type: "hook.result";
    })
  | (RunnerEventEnvelope & {
      artifact: RunnerArtifactDetails;
      type: "artifact.check.finish" | "artifact.check.start";
    })
  | (RunnerEventEnvelope & {
      log: RunnerLogDetails;
      type:
        | "node.output.recorded"
        | "output.repair"
        | "run.cancelled"
        | "runner.command.phase"
        | "runner.schema.validation"
        | "runtime.observability";
    })
  | (RunnerEventEnvelope & {
      finalResult: RunnerFinalResultDetails;
      type: "workflow.finish";
    })
  | (RunnerEventEnvelope & {
      deliveryPullRequest: RunnerPullRequestDeliveryDetails;
      type: "delivery.pull-request";
    })
  | (RunnerEventEnvelope & {
      loopStart: LoopStartDetails;
      type: "loop.start";
    })
  | (RunnerEventEnvelope & {
      loopGraphSnapshot: LoopGraphSnapshotDetails;
      type: "loop.graph.snapshot";
    })
  | (RunnerEventEnvelope & {
      loopNodeTransition: LoopNodeTransitionDetails;
      type: "loop.node.transition";
    })
  | (RunnerEventEnvelope & {
      loopFinish: LoopFinishDetails;
      type: "loop.finish";
    });

type RunnerEventRecordBase = Pick<RunnerEventEnvelope, "at" | "runId" | "sequence">;

export const resolveRunnerEventSinkAuthToken = (options: ResolveRunnerEventSinkAuthTokenOptions): string => {
  if (options.authTokenFile !== undefined && options.authTokenFile.length > 0) {
    const readFile: (path: string) => string = options.readFile ?? ((p: string) => readFileSync(p, "utf-8"));
    return readFile(options.authTokenFile).trim();
  }

  throw new RunnerCommandPayloadValidationError(
    "Runner event auth token is required. Set events.authTokenFile in the runner payload.",
    [
      {
        code: "missing_runner_event_auth_token",
        message: "Runner event auth token is required. Set events.authTokenFile in the runner payload.",
        path: "events.authTokenFile",
      },
    ],
  );
};

export const buildRunnerCommandPayload = (options: BuildRunnerCommandPayloadOptions): RunnerCommandPayload =>
  parseStrictWithSchema(runnerCommandPayloadSchema, {
    contractVersion: RUNNER_COMMAND_CONTRACT_VERSION,
    delivery: options.delivery,
    events: options.events,
    hookPolicy: options.hookPolicy,
    ...(options.momokaya ? { momokaya: options.momokaya } : {}),
    repository: options.repository,
    run: options.run,
    submission: options.submission,
    task: options.task,
    workflow: options.workflow,
  });

const mapWorkflowRunnerEvent = (
  event: PipelineRuntimeEvent,
  context: RunnerEventMappingContext,
  record: RunnerEventRecordBase,
): Option.Option<RunnerEventRecord[]> => {
  switch (event.type) {
    case "workflow.planned": {
      const planRecord: RunnerEventRecord = {
        ...record,
        type: event.type,
        workflowPlan: {
          edges: event.edges,
          nodes: event.nodes,
          workflowId: event.workflowId,
        },
      };
      const edgeRecords: RunnerEventRecord[] = event.edges.map((edge, index) => ({
        at: context.timestamp,
        edge: {
          id: `${edge.source}:${edge.target}`,
          source: edge.source,
          target: edge.target,
        },
        runId: context.runId,
        sequence: (context.sequence ?? 1) + index + 1,
        type: "workflow.edge",
      }));
      return Option.some([planRecord, ...edgeRecords]);
    }
    case "workflow.start": {
      return Option.some([
        {
          ...record,
          type: event.type,
          workflowPlan: {
            nodeIds: event.nodeIds,
            workflowId: event.workflowId,
          },
        },
      ]);
    }
    case "workflow.finish": {
      return Option.some([
        {
          ...record,
          finalResult: {
            outcome: event.outcome,
            workflowId: event.workflowId,
          },
          type: event.type,
        },
      ]);
    }
    default: {
      return Option.none();
    }
  }
};

const mapDeliveryRunnerEvent = (
  event: PipelineRuntimeEvent,
  record: RunnerEventRecordBase,
): Option.Option<RunnerEventRecord[]> => {
  switch (event.type) {
    case "delivery.pull-request": {
      return Option.some([
        {
          ...record,
          deliveryPullRequest: event.deliveryPullRequest,
          type: event.type,
        },
      ]);
    }
    default: {
      return Option.none();
    }
  }
};

const formatLogMessage = (output: unknown): string => {
  if (typeof output === "string") {
    return output;
  }
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
};

const formatRunnerCommandPayloadIssues = (issues: RunnerCommandPayloadValidationIssue[], _payload: unknown): string =>
  issues.map((issue) => `${issue.path.length > 0 ? issue.path : "payload"}: ${issue.message}`).join("; ");

const runnerCommandPayloadIssues = (issues: readonly EffectSchemaIssue[]): RunnerCommandPayloadValidationIssue[] =>
  issues.map((issue) => {
    const path = issue.path.map(String).join(".");
    if (path === "repository.url") {
      return {
        code: "invalid_value",
        message: "must be a valid URL",
        path,
      };
    }
    if (path === "contractVersion") {
      return {
        code: "invalid_value",
        message: `runner command payload contract version must be ${RUNNER_COMMAND_CONTRACT_VERSION}`,
        path,
      };
    }
    if (issue.sourceMessage === "Missing key") {
      return {
        code: "invalid_value",
        message: `${path} is required`,
        path: path.length > 0 ? path : "payload",
      };
    }
    return {
      code: "invalid_value",
      message: issue.message,
      path: path.length > 0 ? path : "payload",
    };
  });

type NodeRuntimeEvent = Extract<
  PipelineRuntimeEvent,
  { type: "agent.finish" | "agent.start" | "node.finish" | "node.start" }
>;

const NODE_EVENT_STATUSES: Record<NodeRuntimeEvent["type"], RunnerNodeStatus> = {
  "agent.finish": "agent-finished",
  "agent.start": "agent-running",
  "node.finish": "passed",
  "node.start": "running",
};

const isNodeRuntimeEvent = (event: PipelineRuntimeEvent): event is NodeRuntimeEvent =>
  Object.hasOwn(NODE_EVENT_STATUSES, event.type);

const nodeEventStatus = (event: NodeRuntimeEvent): RunnerNodeStatus =>
  event.type === "node.finish" ? event.status : NODE_EVENT_STATUSES[event.type];

const nodeEventDetails = (event: NodeRuntimeEvent): RunnerNodeDetails => ({
  attempt: event.attempt,
  ...("exitCode" in event ? { exitCode: event.exitCode } : {}),
  nodeId: event.nodeId,
  ...(event.profile === undefined ? {} : { profile: event.profile }),
  ...(event.runnerId === undefined ? {} : { runnerId: event.runnerId }),
  status: nodeEventStatus(event),
});

const nodeEventRecord = (event: NodeRuntimeEvent, record: RunnerEventRecordBase): RunnerEventRecord => ({
  ...record,
  node: nodeEventDetails(event),
  type: event.type,
});

const mapNodeRunnerEvent = (
  event: PipelineRuntimeEvent,
  record: RunnerEventRecordBase,
): Option.Option<RunnerEventRecord[]> => {
  if (event.type === "node.session") {
    // node.session associates a node with its agent session id. It is an
    // in-process run-control/projection concern (see projectNodeSession in
    // run-control/runtime-reporter) with no representation in the
    // runner -> event-sink wire contract, so it maps to no records rather
    // than falling through to throwUnhandledRuntimeEvent.
    return Option.some([]);
  }
  return isNodeRuntimeEvent(event) ? Option.some([nodeEventRecord(event, record)]) : Option.none();
};

const mapGateRunnerEvent = (
  event: PipelineRuntimeEvent,
  record: RunnerEventRecordBase,
): Option.Option<RunnerEventRecord[]> => {
  switch (event.type) {
    case "gate.start": {
      return Option.some([
        {
          ...record,
          gate: {
            gateId: event.gateId,
            kind: event.kind,
            label: event.gateId,
            nodeId: event.nodeId,
            status: "running",
          },
          type: event.type,
        },
      ]);
    }
    case "gate.finish": {
      return Option.some([
        {
          ...record,
          gate: {
            ...(event.evidence === undefined ? {} : { evidence: event.evidence }),
            gateId: event.gateId,
            kind: event.kind,
            label: event.gateId,
            nodeId: event.nodeId,
            passed: event.passed,
            ...(event.reason === undefined ? {} : { reason: event.reason }),
            status: event.passed ? "passed" : "failed",
          },
          type: event.type,
        },
      ]);
    }
    default: {
      return Option.none();
    }
  }
};

type ArtifactRuntimeEvent = Extract<PipelineRuntimeEvent, { type: "artifact.check.finish" | "artifact.check.start" }>;

const artifactEventStatus = (event: ArtifactRuntimeEvent): RunnerArtifactStatus => {
  if (!("passed" in event)) {
    return "running";
  }
  return event.passed ? "passed" : "failed";
};

const artifactEventDetails = (event: ArtifactRuntimeEvent): RunnerArtifactDetails => ({
  kind: "artifact",
  label: event.path,
  nodeId: event.nodeId,
  ...("passed" in event ? { passed: event.passed } : {}),
  path: event.path,
  ...("reason" in event && event.reason !== undefined ? { reason: event.reason } : {}),
  required: event.required,
  status: artifactEventStatus(event),
  uri: event.path,
});

const artifactEventRecord = (event: ArtifactRuntimeEvent, record: RunnerEventRecordBase): RunnerEventRecord => ({
  ...record,
  artifact: artifactEventDetails(event),
  type: event.type,
});

const mapArtifactRunnerEvent = (
  event: PipelineRuntimeEvent,
  record: RunnerEventRecordBase,
): Option.Option<RunnerEventRecord[]> => {
  switch (event.type) {
    case "artifact.check.start": {
      return Option.some([artifactEventRecord(event, record)]);
    }
    case "artifact.check.finish": {
      return Option.some([artifactEventRecord(event, record)]);
    }
    default: {
      return Option.none();
    }
  }
};

type HookGateRuntimeEvent = Extract<PipelineRuntimeEvent, { type: "hook.finish" | "hook.start" }>;

const hookGateStatus = (event: HookGateRuntimeEvent): RunnerGateStatus => {
  if (!("passed" in event)) {
    return "running";
  }
  return event.passed ? "passed" : "failed";
};

const hookGateDetails = (event: HookGateRuntimeEvent): RunnerGateDetails => ({
  event: event.event,
  ...(event.gateId === undefined ? {} : { gateId: event.gateId }),
  hookId: event.hookId,
  ...(event.nodeId === undefined ? {} : { nodeId: event.nodeId }),
  ...("passed" in event ? { passed: event.passed } : {}),
  ...("reason" in event && event.reason !== undefined ? { reason: event.reason } : {}),
  required: event.required,
  status: hookGateStatus(event),
  workflowId: event.workflowId,
});

const hookGateRecord = (event: HookGateRuntimeEvent, record: RunnerEventRecordBase): RunnerEventRecord => ({
  ...record,
  gate: hookGateDetails(event),
  type: event.type,
});

type HookResultRuntimeEvent = Extract<PipelineRuntimeEvent, { type: "hook.result" }>;

const hookResultDetails = (event: HookResultRuntimeEvent): RunnerHookResultDetails => ({
  ...(event.artifacts === undefined ? {} : { artifacts: event.artifacts }),
  event: event.event,
  functionId: event.functionId,
  ...(event.gateId === undefined ? {} : { gateId: event.gateId }),
  hookId: event.hookId,
  ...(event.nodeId === undefined ? {} : { nodeId: event.nodeId }),
  ...(event.outputs === undefined ? {} : { outputs: event.outputs }),
  status: event.status,
  ...(event.summary === undefined ? {} : { summary: event.summary }),
  workflowId: event.workflowId,
});

const hookResultRecord = (event: HookResultRuntimeEvent, record: RunnerEventRecordBase): RunnerEventRecord => ({
  ...record,
  hookResult: hookResultDetails(event),
  type: event.type,
});

const mapHookRunnerEvent = (
  event: PipelineRuntimeEvent,
  record: RunnerEventRecordBase,
): Option.Option<RunnerEventRecord[]> => {
  switch (event.type) {
    case "hook.start": {
      return Option.some([hookGateRecord(event, record)]);
    }
    case "hook.finish": {
      return Option.some([hookGateRecord(event, record)]);
    }
    case "hook.result": {
      return Option.some([hookResultRecord(event, record)]);
    }
    default: {
      return Option.none();
    }
  }
};

type LogRuntimeEvent = Extract<
  PipelineRuntimeEvent,
  {
    type: "node.output.recorded" | "output.repair" | "runtime.observability";
  }
>;
type LogRuntimeEventType = LogRuntimeEvent["type"];
type LogRuntimeEventOf<Type extends LogRuntimeEventType> = Extract<LogRuntimeEvent, { type: Type }>;
type LogRunnerEventMapper<Type extends LogRuntimeEventType> = (
  event: LogRuntimeEventOf<Type>,
  record: RunnerEventRecordBase,
) => RunnerEventRecord;
type AnyLogRunnerEventMapper = (event: PipelineRuntimeEvent, record: RunnerEventRecordBase) => RunnerEventRecord;

const isRuntimeEventOfType = <Type extends PipelineRuntimeEvent["type"]>(
  event: PipelineRuntimeEvent,
  type: Type,
): event is Extract<PipelineRuntimeEvent, { type: Type }> => event.type === type;

const logRunnerEventMapper =
  <Type extends LogRuntimeEventType>(type: Type, mapper: LogRunnerEventMapper<Type>): AnyLogRunnerEventMapper =>
  (event, record) => {
    if (!isRuntimeEventOfType(event, type)) {
      throw new RunnerCommandPayloadValidationError(`Log runner-event mapper mismatch for event type ${type}`, [
        {
          code: "runner_event_mapper_mismatch",
          message: `Log runner-event mapper mismatch for event type ${type}`,
          path: "event.type",
        },
      ]);
    }
    return mapper(event, record);
  };

const logEventRecord = (
  event: LogRuntimeEvent,
  record: RunnerEventRecordBase,
  log: RunnerLogDetails,
): RunnerEventRecord => ({
  ...record,
  log,
  type: event.type,
});

const nodeOutputLogRecord: LogRunnerEventMapper<"node.output.recorded"> = (event, record) =>
  logEventRecord(event, record, {
    format: event.format,
    level: event.parseError !== undefined && event.parseError.length > 0 ? "warn" : "info",
    message: formatLogMessage(event.output),
    nodeId: event.nodeId,
    output: event.output,
  });

const outputRepairLogMessage = (event: LogRuntimeEventOf<"output.repair">): string =>
  event.reason ?? `Output repair ${event.passed ? "passed" : "failed"}`;

const outputRepairLogRecord: LogRunnerEventMapper<"output.repair"> = (event, record) =>
  logEventRecord(event, record, {
    attempt: event.attempt,
    level: event.passed ? "info" : "warn",
    message: outputRepairLogMessage(event),
    nodeId: event.nodeId,
    passed: event.passed,
    ...(event.reason === undefined ? {} : { reason: event.reason }),
  });

const runtimeObservabilityLogRecord: LogRunnerEventMapper<"runtime.observability"> = (event, record) =>
  logEventRecord(event, record, {
    level: event.level,
    message: `Runtime observed: ${event.name} - ${event.summary}`,
    nodeId: event.nodeId,
    workflowId: event.workflowId,
  });

const LOG_EVENT_RECORDERS: Record<LogRuntimeEventType, AnyLogRunnerEventMapper> = {
  "node.output.recorded": logRunnerEventMapper("node.output.recorded", nodeOutputLogRecord),
  "output.repair": logRunnerEventMapper("output.repair", outputRepairLogRecord),
  "runtime.observability": logRunnerEventMapper("runtime.observability", runtimeObservabilityLogRecord),
};

const isLogRuntimeEvent = (event: PipelineRuntimeEvent): event is LogRuntimeEvent =>
  Object.hasOwn(LOG_EVENT_RECORDERS, event.type);

const mapLogRunnerEvent = (
  event: PipelineRuntimeEvent,
  record: RunnerEventRecordBase,
): Option.Option<RunnerEventRecord[]> =>
  isLogRuntimeEvent(event) ? Option.some([LOG_EVENT_RECORDERS[event.type](event, record)]) : Option.none();

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readRecord = (value: unknown): Option.Option<Record<string, unknown>> =>
  isRecord(value) ? Option.some(value) : Option.none();

const recoverablePayloadEnvelope = (
  payload: unknown,
): { recoverable: RecoverableRunnerCommandPayloadEnvelope } | Record<string, never> => {
  const envelope = readRecord(payload);
  if (Option.isNone(envelope)) {
    return {};
  }
  const run = parseResultWithSchema(runnerRunIdentitySchema, envelope.value.run);
  const events = parseResultWithSchema(runnerEventsSchema, envelope.value.events);
  if (!(run.ok && events.ok)) {
    return {};
  }
  return {
    recoverable: {
      events: events.value,
      run: run.value,
    },
  };
};

const parseRunnerCommandPayloadWithIssues = (rawPayload: string): RunnerCommandPayloadParseResult => {
  const parsedJson = parseJsonResult(rawPayload, "runner payload JSON");
  if (parsedJson.error !== undefined) {
    const { error: message } = parsedJson;
    const error = new RunnerCommandPayloadValidationError(`Malformed runner payload JSON: ${message}`, [
      {
        code: "invalid_json",
        message,
        path: "payload",
      },
    ]);
    return { error, ok: false };
  }
  const { value: parsed } = parsedJson;
  const result = parseResultWithSchema(runnerCommandPayloadSchema, parsed, {
    onExcessProperty: "error",
  });
  if (!result.ok) {
    const issues = runnerCommandPayloadIssues(result.issues);
    const error = new RunnerCommandPayloadValidationError(formatRunnerCommandPayloadIssues(issues, parsed), issues);
    return {
      error,
      ok: false,
      ...recoverablePayloadEnvelope(parsed),
    };
  }
  return { ok: true, payload: result.value };
};

export const parseRunnerCommandPayload = (rawPayload: string): RunnerCommandPayload => {
  const result = parseRunnerCommandPayloadWithIssues(rawPayload);
  if (!result.ok) {
    throw result.error;
  }
  return result.payload;
};

const throwUnhandledRuntimeEvent = (value: PipelineRuntimeEvent): never => {
  throw new RunnerCommandPayloadValidationError(`Unhandled runtime event: ${value.type}`, [
    {
      code: "unhandled_runtime_event",
      message: `Unhandled runtime event: ${value.type}`,
      path: "event.type",
    },
  ]);
};

export const mapRuntimeEventToRunnerEventRecords = (
  event: PipelineRuntimeEvent,
  context: RunnerEventMappingContext,
): RunnerEventRecord[] => {
  const record: RunnerEventRecordBase = {
    at: context.timestamp,
    runId: context.runId,
    sequence: context.sequence ?? 1,
  };
  const records = Option.firstSomeOf([
    mapWorkflowRunnerEvent(event, context, record),
    mapNodeRunnerEvent(event, record),
    mapGateRunnerEvent(event, record),
    mapArtifactRunnerEvent(event, record),
    mapHookRunnerEvent(event, record),
    mapDeliveryRunnerEvent(event, record),
    mapLogRunnerEvent(event, record),
  ]);
  return Option.isSome(records) ? records.value : throwUnhandledRuntimeEvent(event);
};

export { runnerTask as runnerTaskSchema };
