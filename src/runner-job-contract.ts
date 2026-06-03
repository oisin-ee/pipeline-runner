import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import type { PipelineRuntimeEvent } from "./pipeline-runtime.js";
import { parseJson } from "./safe-json.js";

export const RUNNER_PAYLOAD_ENV = "OISIN_PIPELINE_RUNNER_PAYLOAD_JSON";

export const runnerEventSinkConfigSchema = z
  .object({
    authHeader: z.string().min(1),
    url: z.string().url(),
  })
  .strict();

export const runnerRunIdentitySchema = z
  .object({
    projectId: z.string().min(1),
    requestedBy: z.string().min(1).optional(),
    runId: z.string().min(1),
  })
  .strict();

export const runnerWorkflowSelectorSchema = z
  .object({
    workflowId: z.string().min(1),
  })
  .strict();

export const runnerTaskPromptSchema = z
  .object({
    prompt: z.string().min(1),
    taskId: z.string().min(1),
  })
  .strict();

export const runnerJobPayloadSchema = z
  .object({
    eventSink: runnerEventSinkConfigSchema,
    run: runnerRunIdentitySchema,
    selector: runnerWorkflowSelectorSchema,
    task: runnerTaskPromptSchema,
  })
  .strict();

export type RunnerEventSinkConfig = z.infer<typeof runnerEventSinkConfigSchema>;
export type RunnerJobPayload = z.infer<typeof runnerJobPayloadSchema>;
export type RunnerRunIdentity = z.infer<typeof runnerRunIdentitySchema>;
export type RunnerTaskPrompt = z.infer<typeof runnerTaskPromptSchema>;
export type RunnerWorkflowSelector = z.infer<
  typeof runnerWorkflowSelectorSchema
>;

export interface CreateRunnerJobPayloadEnvOptions {
  eventSinkUrl: string;
  projectId: string;
  requestedBy?: string;
  runId: string;
  taskId: string;
  taskPrompt: string;
  workflowId: string;
}

export interface ResolveRunnerEventSinkAuthTokenOptions {
  env?: Record<string, string | undefined>;
  serviceAccountTokenPath?: string;
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
}

export interface RunnerFinalResultDetails {
  outcome: "CANCELLED" | "FAIL" | "PASS";
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
      artifact: RunnerArtifactDetails;
      type: "artifact.check.finish" | "artifact.check.start";
    })
  | (RunnerEventEnvelope & {
      log: RunnerLogDetails;
      type: "node.output.recorded" | "output.repair" | "run.cancelled";
    })
  | (RunnerEventEnvelope & {
      finalResult: RunnerFinalResultDetails;
      type: "workflow.finish";
    });

const EVENT_AUTH_TOKEN_ENV_KEYS = [
  "OISIN_PIPELINE_EVENT_AUTH_TOKEN",
  "PIPELINE_EVENT_API_TOKEN",
] as const;
const DEFAULT_SERVICE_ACCOUNT_TOKEN_PATH =
  "/var/run/secrets/kubernetes.io/serviceaccount/token";

export function resolveRunnerEventSinkAuthToken(
  options: ResolveRunnerEventSinkAuthTokenOptions = {}
): string {
  const env = options.env ?? process.env;
  for (const key of EVENT_AUTH_TOKEN_ENV_KEYS) {
    const token = env[key]?.trim();
    if (token) {
      return token;
    }
  }

  const tokenPath =
    options.serviceAccountTokenPath ?? DEFAULT_SERVICE_ACCOUNT_TOKEN_PATH;
  if (existsSync(tokenPath)) {
    const token = readFileSync(tokenPath, "utf8").trim();
    if (token) {
      return token;
    }
  }

  throw new Error(
    `Runner event auth token is required. Set ${EVENT_AUTH_TOKEN_ENV_KEYS.join(
      " or "
    )}, or mount a readable Kubernetes service account token at ${tokenPath}.`
  );
}

export function resolveRunnerEventSinkAuthHeader(
  options: ResolveRunnerEventSinkAuthTokenOptions = {}
): string {
  return `Bearer ${resolveRunnerEventSinkAuthToken(options)}`;
}

export function createRunnerJobPayloadEnv(
  options: CreateRunnerJobPayloadEnvOptions
): { name: typeof RUNNER_PAYLOAD_ENV; value: string } {
  const payload = runnerJobPayloadSchema.parse({
    eventSink: {
      authHeader: "Authorization",
      url: options.eventSinkUrl,
    },
    run: {
      projectId: options.projectId,
      requestedBy: options.requestedBy,
      runId: options.runId,
    },
    selector: {
      workflowId: options.workflowId,
    },
    task: {
      prompt: options.taskPrompt,
      taskId: options.taskId,
    },
  });
  return {
    name: RUNNER_PAYLOAD_ENV,
    value: JSON.stringify(payload),
  };
}

export function parseRunnerJobPayload(rawPayload: string): RunnerJobPayload {
  let parsed: unknown;
  try {
    parsed = parseJson(rawPayload, "runner payload JSON");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Malformed runner payload JSON: ${message}`);
  }

  const result = runnerJobPayloadSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(formatRunnerJobPayloadIssues(result.error, parsed));
  }
  return result.data;
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
  error: z.ZodError,
  payload: unknown
): string {
  const selector = readRecord(readRecord(payload)?.selector);
  if (
    selector &&
    !("workflowId" in selector) &&
    Object.keys(selector).length > 0
  ) {
    return `Unsupported selector fields: ${Object.keys(selector).join(", ")}; selector.workflowId is required`;
  }

  return error.issues
    .map((issue) => {
      const path = issue.path.join(".");
      if (issue.code === "invalid_type" && issue.input === undefined) {
        return `${path || "payload"} is required`;
      }
      if (path === "eventSink.url") {
        return "eventSink.url must be a valid URL";
      }
      return `${path || "payload"}: ${issue.message}`;
    })
    .join("; ");
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
