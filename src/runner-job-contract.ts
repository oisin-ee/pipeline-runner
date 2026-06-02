import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import type { PipelineRuntimeEvent } from "./pipeline-runtime.js";

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

export interface RunnerEventRecord {
  artifact?: Record<string, unknown>;
  at?: string;
  edge?: Record<string, unknown>;
  finalResult?: Record<string, unknown>;
  gate?: Record<string, unknown>;
  log?: Record<string, unknown>;
  node?: Record<string, unknown>;
  sequence: number;
  type: string;
  workflowPlan?: Record<string, unknown>;
}

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
    parsed = JSON.parse(rawPayload);
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

export function mapRuntimeEventToRunnerEventRecord(
  event: PipelineRuntimeEvent,
  context: RunnerEventMappingContext
): RunnerEventRecord {
  return mapRuntimeEventToRunnerEventRecords(event, context)[0];
}

export function mapRuntimeEventToRunnerEventRecords(
  event: PipelineRuntimeEvent,
  context: RunnerEventMappingContext
): RunnerEventRecord[] {
  const record: RunnerEventRecord = {
    sequence: context.sequence ?? 1,
    type: event.type,
    at: context.timestamp,
  };

  switch (event.type) {
    case "workflow.planned": {
      const planRecord = {
        ...record,
        workflowPlan: {
          edges: event.edges,
          nodes: event.nodes,
          workflowId: event.workflowId,
        },
      };
      const edgeRecords = event.edges.map((edge, index) => ({
        at: context.timestamp,
        edge: {
          id: `${edge.source}:${edge.target}`,
          source: edge.source,
          target: edge.target,
        },
        sequence: (context.sequence ?? 1) + index + 1,
        type: "workflow.edge",
      }));
      return [planRecord, ...edgeRecords];
    }
    case "workflow.start":
      return [
        {
          ...record,
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
          finalResult: {
            outcome: event.outcome,
            workflowId: event.workflowId,
          },
        },
      ];
    default:
      return [record];
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

function omitUndefined(
  value: Record<string, unknown | undefined>
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined)
  );
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
