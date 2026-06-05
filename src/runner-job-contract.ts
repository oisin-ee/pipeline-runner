import { readFileSync } from "node:fs";
import { z } from "zod";
import type { PipelineRuntimeEvent } from "./pipeline-runtime.js";
import { parseJson } from "./safe-json.js";

export const RUNNER_JOB_CONTRACT_VERSION = "1";

export const runnerRunIdentitySchema = z
  .object({
    id: z.string().min(1),
    project: z.string().min(1),
    requestedBy: z.string().min(1).optional(),
  })
  .strict();

export const runnerTaskPromptSchema = z
  .object({
    kind: z.literal("prompt"),
    prompt: z.string().min(1),
    title: z.string().min(1).optional(),
  })
  .strict();

export const runnerTaskTicketSchema = z
  .object({
    id: z.string().min(1),
    kind: z.literal("ticket"),
    path: z.string().min(1).optional(),
    title: z.string().min(1).optional(),
  })
  .strict();

export const runnerTaskSchema = z.discriminatedUnion("kind", [
  runnerTaskPromptSchema,
  runnerTaskTicketSchema,
]);

export const runnerRepositoryContextSchema = z
  .object({
    baseBranch: z.string().min(1),
    sha: z.string().min(1).optional(),
    url: z.string().url(),
  })
  .strict();

export const runnerDeliverySchema = z
  .object({
    pullRequest: z.boolean().default(false),
  })
  .strict();

export const runnerEventsSchema = z
  .object({
    authHeader: z.string().min(1).default("Authorization"),
    authTokenFile: z.string().min(1),
    url: z.string().url(),
  })
  .strict();

export const runnerMomokayaContextSchema = z
  .object({
    automationNamespace: z.string().min(1).optional(),
    previewEnabled: z.boolean(),
    repoKey: z.string().min(1).optional(),
  })
  .strict();

export const runnerJobPayloadSchema = z
  .object({
    contractVersion: z
      .literal(RUNNER_JOB_CONTRACT_VERSION, {
        error: "runner job payload contract version must be 1",
      })
      .default(RUNNER_JOB_CONTRACT_VERSION),
    delivery: runnerDeliverySchema.default({ pullRequest: false }),
    events: runnerEventsSchema,
    momokaya: runnerMomokayaContextSchema.optional(),
    repository: runnerRepositoryContextSchema,
    run: runnerRunIdentitySchema,
    task: runnerTaskSchema,
  })
  .strict();

export type RunnerDelivery = z.infer<typeof runnerDeliverySchema>;
export type RunnerEvents = z.infer<typeof runnerEventsSchema>;
export type RunnerJobPayload = z.infer<typeof runnerJobPayloadSchema>;
export type RunnerMomokayaContext = z.infer<typeof runnerMomokayaContextSchema>;
export type RunnerRepositoryContext = z.infer<
  typeof runnerRepositoryContextSchema
>;
export type RunnerRunIdentity = z.infer<typeof runnerRunIdentitySchema>;
export type RunnerTaskPrompt = z.infer<typeof runnerTaskPromptSchema>;
export type RunnerTaskTicket = z.infer<typeof runnerTaskTicketSchema>;
export type RunnerTask = z.infer<typeof runnerTaskSchema>;

export const runnerJobPayloadJsonSchema = z.toJSONSchema(
  runnerJobPayloadSchema
);

export interface RunnerJobPayloadValidationIssue {
  code: string;
  message: string;
  path: string;
}

export interface RecoverableRunnerJobPayloadEnvelope {
  events: RunnerEvents;
  run: RunnerRunIdentity;
}

export class RunnerJobPayloadValidationError extends Error {
  readonly issues: RunnerJobPayloadValidationIssue[];

  constructor(message: string, issues: RunnerJobPayloadValidationIssue[]) {
    super(message);
    this.name = "RunnerJobPayloadValidationError";
    this.issues = issues;
  }
}

export type RunnerJobPayloadParseResult =
  | { ok: true; payload: RunnerJobPayload }
  | {
      error: RunnerJobPayloadValidationError;
      ok: false;
      recoverable?: RecoverableRunnerJobPayloadEnvelope;
    };

export interface BuildRunnerJobPayloadOptions {
  delivery?: RunnerDelivery;
  events: RunnerEvents;
  momokaya?: RunnerMomokayaContext;
  repository: RunnerRepositoryContext;
  run: RunnerRunIdentity;
  task: RunnerTask;
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

export type RunnerNodeStatus =
  | "agent-finished"
  | "agent-running"
  | "failed"
  | "passed"
  | "running";

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

export interface RunnerHookResultDetails {
  artifacts?: Array<{ contentType?: string; name: string; path: string }>;
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
  sequence: number;
  type: string;
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
        | "runner.job.phase"
        | "runner.schema.validation"
        | "runtime.observability";
    })
  | (RunnerEventEnvelope & {
      finalResult: RunnerFinalResultDetails;
      type: "workflow.finish";
    });

export function resolveRunnerEventSinkAuthToken(
  options: ResolveRunnerEventSinkAuthTokenOptions
): string {
  if (options.authTokenFile) {
    const readFile: (path: string) => string =
      options.readFile ?? ((p: string) => readFileSync(p, "utf8"));
    return readFile(options.authTokenFile).trim();
  }

  throw new Error(
    "Runner event auth token is required. Set events.authTokenFile in the runner payload."
  );
}

export function resolveRunnerEventSinkAuthHeader(
  options: ResolveRunnerEventSinkAuthTokenOptions
): string {
  return `Bearer ${resolveRunnerEventSinkAuthToken(options)}`;
}

export function buildRunnerJobPayload(
  options: BuildRunnerJobPayloadOptions
): RunnerJobPayload {
  return runnerJobPayloadSchema.parse({
    contractVersion: RUNNER_JOB_CONTRACT_VERSION,
    delivery: options.delivery,
    events: options.events,
    momokaya: options.momokaya,
    repository: options.repository,
    run: options.run,
    task: options.task,
  });
}

export function parseRunnerJobPayload(rawPayload: string): RunnerJobPayload {
  const result = parseRunnerJobPayloadWithIssues(rawPayload);
  if (!result.ok) {
    throw result.error;
  }
  return result.payload;
}

export function parseRunnerJobPayloadWithIssues(
  rawPayload: string
): RunnerJobPayloadParseResult {
  let parsed: unknown;
  try {
    parsed = parseJson(rawPayload, "runner payload JSON");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const error = new RunnerJobPayloadValidationError(
      `Malformed runner payload JSON: ${message}`,
      [
        {
          code: "invalid_json",
          message,
          path: "payload",
        },
      ]
    );
    return { error, ok: false };
  }
  const result = runnerJobPayloadSchema.safeParse(parsed);
  if (!result.success) {
    const issues = runnerJobPayloadIssues(result.error);
    const error = new RunnerJobPayloadValidationError(
      formatRunnerJobPayloadIssues(issues, parsed),
      issues
    );
    return {
      error,
      ok: false,
      ...recoverablePayloadEnvelope(parsed),
    };
  }
  return { ok: true, payload: result.data };
}

export function mapRuntimeEventToRunnerEventRecords(
  event: PipelineRuntimeEvent,
  context: RunnerEventMappingContext
): RunnerEventRecord[] {
  const record = {
    at: context.timestamp,
    sequence: context.sequence ?? 1,
  };

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
      const edgeRecords: RunnerEventRecord[] = event.edges.map(
        (edge, index) => ({
          at: context.timestamp,
          edge: {
            id: `${edge.source}:${edge.target}`,
            source: edge.source,
            target: edge.target,
          },
          sequence: (context.sequence ?? 1) + index + 1,
          type: "workflow.edge",
        })
      );
      return [planRecord, ...edgeRecords];
    }
    case "workflow.start":
      return [
        {
          ...record,
          type: event.type,
          workflowPlan: {
            nodeIds: event.nodeIds,
            workflowId: event.workflowId,
          },
        },
      ];
    case "node.start":
      return [
        {
          ...record,
          type: event.type,
          node: omitUndefined({
            attempt: event.attempt,
            nodeId: event.nodeId,
            profile: event.profile,
            runnerId: event.runnerId,
            status: "running",
          }),
        },
      ];
    case "node.finish":
      return [
        {
          ...record,
          type: event.type,
          node: omitUndefined({
            attempt: event.attempt,
            exitCode: event.exitCode,
            nodeId: event.nodeId,
            profile: event.profile,
            runnerId: event.runnerId,
            status: event.status,
          }),
        },
      ];
    case "agent.start":
      return [
        {
          ...record,
          type: event.type,
          node: omitUndefined({
            attempt: event.attempt,
            nodeId: event.nodeId,
            profile: event.profile,
            runnerId: event.runnerId,
            status: "agent-running",
          }),
        },
      ];
    case "agent.finish":
      return [
        {
          ...record,
          type: event.type,
          node: omitUndefined({
            attempt: event.attempt,
            exitCode: event.exitCode,
            nodeId: event.nodeId,
            profile: event.profile,
            runnerId: event.runnerId,
            status: "agent-finished",
          }),
        },
      ];
    case "gate.start":
      return [
        {
          ...record,
          type: event.type,
          gate: {
            gateId: event.gateId,
            label: event.gateId,
            kind: event.kind,
            nodeId: event.nodeId,
            status: "running",
          },
        },
      ];
    case "gate.finish":
      return [
        {
          ...record,
          type: event.type,
          gate: omitUndefined({
            evidence: event.evidence,
            gateId: event.gateId,
            label: event.gateId,
            kind: event.kind,
            nodeId: event.nodeId,
            passed: event.passed,
            reason: event.reason,
            status: event.passed ? "passed" : "failed",
          }),
        },
      ];
    case "artifact.check.start":
      return [
        {
          ...record,
          type: event.type,
          artifact: {
            kind: "artifact",
            label: event.path,
            nodeId: event.nodeId,
            path: event.path,
            required: event.required,
            status: "running",
            uri: event.path,
          },
        },
      ];
    case "artifact.check.finish":
      return [
        {
          ...record,
          type: event.type,
          artifact: omitUndefined({
            kind: "artifact",
            label: event.path,
            nodeId: event.nodeId,
            passed: event.passed,
            path: event.path,
            reason: event.reason,
            required: event.required,
            status: event.passed ? "passed" : "failed",
            uri: event.path,
          }),
        },
      ];
    case "hook.start":
      return [
        {
          ...record,
          type: event.type,
          gate: omitUndefined({
            event: event.event,
            gateId: event.gateId,
            hookId: event.hookId,
            nodeId: event.nodeId,
            required: event.required,
            status: "running",
            workflowId: event.workflowId,
          }),
        },
      ];
    case "hook.finish":
      return [
        {
          ...record,
          type: event.type,
          gate: omitUndefined({
            event: event.event,
            gateId: event.gateId,
            hookId: event.hookId,
            nodeId: event.nodeId,
            passed: event.passed,
            reason: event.reason,
            required: event.required,
            status: event.passed ? "passed" : "failed",
            workflowId: event.workflowId,
          }),
        },
      ];
    case "hook.result":
      return [
        {
          ...record,
          type: event.type,
          hookResult: omitUndefined({
            artifacts: event.artifacts,
            event: event.event,
            functionId: event.functionId,
            gateId: event.gateId,
            hookId: event.hookId,
            nodeId: event.nodeId,
            outputs: event.outputs,
            status: event.status,
            summary: event.summary,
            workflowId: event.workflowId,
          }),
        },
      ];
    case "node.output.recorded":
      return [
        {
          ...record,
          type: event.type,
          log: omitUndefined({
            format: event.format,
            level: event.parseError ? "warn" : "info",
            message: formatLogMessage(event.output),
            nodeId: event.nodeId,
            output: event.output,
          }),
        },
      ];
    case "output.repair":
      return [
        {
          ...record,
          type: event.type,
          log: omitUndefined({
            attempt: event.attempt,
            level: event.passed ? "info" : "warn",
            message:
              event.reason ??
              `Output repair ${event.passed ? "passed" : "failed"}`,
            nodeId: event.nodeId,
            passed: event.passed,
            reason: event.reason,
          }),
        },
      ];
    case "runtime.observability":
      return [
        {
          ...record,
          type: event.type,
          log: omitUndefined({
            level: event.level,
            message: `Runtime observed: ${event.name} - ${event.summary}`,
            nodeId: event.nodeId,
            workflowId: event.workflowId,
          }),
        },
      ];
    case "workflow.finish":
      return [
        {
          ...record,
          type: event.type,
          finalResult: {
            outcome: event.outcome,
            workflowId: event.workflowId,
          },
        },
      ];
    default:
      return assertNever(event);
  }
}

function formatLogMessage(output: unknown): string {
  if (typeof output === "string") {
    return output;
  }
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}

function formatRunnerJobPayloadIssues(
  issues: RunnerJobPayloadValidationIssue[],
  _payload: unknown
): string {
  return issues
    .map((issue) => `${issue.path || "payload"}: ${issue.message}`)
    .join("; ");
}

function runnerJobPayloadIssues(
  error: z.ZodError
): RunnerJobPayloadValidationIssue[] {
  return error.issues.flatMap((issue) => {
    const path = issue.path.join(".");
    if (issue.code === "unrecognized_keys" && Array.isArray(issue.keys)) {
      return issue.keys.map((key) => ({
        code: issue.code,
        message: "Unrecognized key",
        path: [path, key].filter(Boolean).join("."),
      }));
    }
    if (issue.code === "invalid_type" && issue.input === undefined) {
      return [
        {
          code: issue.code,
          message: "is required",
          path: path || "payload",
        },
      ];
    }
    if (path === "repository.url") {
      return [
        {
          code: issue.code,
          message: "must be a valid URL",
          path,
        },
      ];
    }
    if (path === "contractVersion") {
      return [
        {
          code: issue.code,
          message: `runner job payload contract version must be ${RUNNER_JOB_CONTRACT_VERSION}`,
          path,
        },
      ];
    }
    return [
      {
        code: issue.code,
        message: issue.message,
        path: path || "payload",
      },
    ];
  });
}

function recoverablePayloadEnvelope(
  payload: unknown
):
  | { recoverable: RecoverableRunnerJobPayloadEnvelope }
  | Record<string, never> {
  const envelope = readRecord(payload);
  if (!envelope) {
    return {};
  }
  const run = runnerRunIdentitySchema.safeParse(envelope.run);
  const events = runnerEventsSchema.safeParse(envelope.events);
  if (!(run.success && events.success)) {
    return {};
  }
  return {
    recoverable: {
      events: events.data,
      run: run.data,
    },
  };
}

function omitUndefined<const T extends Record<string, unknown | undefined>>(
  value: T
): { [K in keyof T]: Exclude<T[K], undefined> } {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined)
  ) as { [K in keyof T]: Exclude<T[K], undefined> };
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function assertNever(value: never): never {
  throw new Error(`Unhandled runtime event: ${String(value)}`);
}
