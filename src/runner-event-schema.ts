import { z } from "zod";
import type { RunnerEventRecord } from "./runner-command-contract";
import {
  loopStateSchema,
  ticketGraphDtoSchema,
} from "./tickets/ticket-graph-dto";

/*
 * Zod schemas for runner event records — the items that the runner POSTs to
 * /api/pipeline/runner-events in batches of the shape { events: [...] }.
 *
 * These are the stable external contract for Pipeline Console and any other
 * consumer of the runner event stream. Breaking changes require a contract
 * version bump and an explicit compatibility plan.
 */

const runnerEventEnvelopeSchema = z.object({
  at: z.string().optional(),
  // Every record carries the runId of the run it belongs to so the event-sink
  // server can resolve the batch's run without relying on URL path/query. The
  // runner is the source of truth for this contract; consumers (Pipeline
  // Console) conform by reading the per-event runId.
  runId: z.string().min(1),
  sequence: z.number().int().positive(),
});

/* ---------- detail schemas ---------- */

const runnerWorkflowNodeDetailsSchema = z.object({
  id: z.string().min(1),
  kind: z.string().min(1),
  needs: z.array(z.string()),
  profile: z.string().optional(),
  runnerId: z.string().optional(),
});

const runnerWorkflowEdgeDetailsSchema = z.object({
  source: z.string().min(1),
  target: z.string().min(1),
});

const runnerWorkflowPlanDetailsSchema = z.object({
  edges: z.array(runnerWorkflowEdgeDetailsSchema).optional(),
  nodeIds: z.array(z.string().min(1)).optional(),
  nodes: z.array(runnerWorkflowNodeDetailsSchema).optional(),
  workflowId: z.string().min(1),
});

const runnerWorkflowEdgeRecordDetailsSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  target: z.string().min(1),
});

const runnerNodeDetailsSchema = z.object({
  attempt: z.number().int().nonnegative(),
  exitCode: z.number().int().optional(),
  nodeId: z.string().min(1),
  profile: z.string().optional(),
  runnerId: z.string().optional(),
  status: z.enum([
    "agent-finished",
    "agent-running",
    "failed",
    "passed",
    "running",
  ]),
});

const runnerGateDetailsSchema = z.object({
  event: z.string().optional(),
  evidence: z.array(z.string()).optional(),
  gateId: z.string().optional(),
  hookId: z.string().optional(),
  kind: z.string().optional(),
  label: z.string().optional(),
  nodeId: z.string().optional(),
  passed: z.boolean().optional(),
  reason: z.string().optional(),
  required: z.boolean().optional(),
  status: z.enum(["failed", "passed", "running"]),
  workflowId: z.string().optional(),
});

const runnerHookResultDetailsSchema = z.object({
  artifacts: z
    .array(
      z.object({
        contentType: z.string().optional(),
        name: z.string().min(1),
        path: z.string().min(1),
      })
    )
    .optional(),
  event: z.string().min(1),
  functionId: z.string().min(1),
  gateId: z.string().optional(),
  hookId: z.string().min(1),
  nodeId: z.string().optional(),
  outputs: z.record(z.string(), z.unknown()).optional(),
  status: z.enum(["fail", "pass", "skip"]),
  summary: z.string().optional(),
  workflowId: z.string().min(1),
});

const runnerArtifactDetailsSchema = z.object({
  kind: z.literal("artifact"),
  label: z.string().min(1),
  nodeId: z.string().min(1),
  passed: z.boolean().optional(),
  path: z.string().min(1),
  reason: z.string().optional(),
  required: z.boolean(),
  status: z.enum(["failed", "passed", "running"]),
  uri: z.string().min(1),
});

const runnerLogDetailsSchema = z.object({
  attempt: z.number().int().nonnegative().optional(),
  format: z.string().optional(),
  level: z.enum(["info", "warn"]),
  message: z.string(),
  nodeId: z.string().optional(),
  output: z.unknown().optional(),
  passed: z.boolean().optional(),
  reason: z.string().optional(),
  workflowId: z.string().optional(),
});

const runnerFinalResultDetailsSchema = z.object({
  outcome: z.enum(["CANCELLED", "FAIL", "PASS"]),
  workflowId: z.string().min(1),
});

const runnerPullRequestDeliveryDetailsSchema = z.object({
  action: z.enum(["opened", "updated"]),
  url: z.string().url(),
});

/* ---------- event record variants ---------- */

const workflowPlanEventSchema = runnerEventEnvelopeSchema.extend({
  type: z.enum(["workflow.planned", "workflow.start"]),
  workflowPlan: runnerWorkflowPlanDetailsSchema,
});

const workflowEdgeEventSchema = runnerEventEnvelopeSchema.extend({
  edge: runnerWorkflowEdgeRecordDetailsSchema,
  type: z.literal("workflow.edge"),
});

const nodeEventSchema = runnerEventEnvelopeSchema.extend({
  node: runnerNodeDetailsSchema,
  type: z.enum(["agent.finish", "agent.start", "node.finish", "node.start"]),
});

const gateEventSchema = runnerEventEnvelopeSchema.extend({
  gate: runnerGateDetailsSchema,
  type: z.enum(["gate.finish", "gate.start", "hook.finish", "hook.start"]),
});

const hookResultEventSchema = runnerEventEnvelopeSchema.extend({
  hookResult: runnerHookResultDetailsSchema,
  type: z.literal("hook.result"),
});

const artifactEventSchema = runnerEventEnvelopeSchema.extend({
  artifact: runnerArtifactDetailsSchema,
  type: z.enum(["artifact.check.finish", "artifact.check.start"]),
});

const logEventSchema = runnerEventEnvelopeSchema.extend({
  log: runnerLogDetailsSchema,
  type: z.enum([
    "node.output.recorded",
    "output.repair",
    "run.cancelled",
    "runner.command.phase",
    "runner.schema.validation",
    "runtime.observability",
  ]),
});

const finalResultEventSchema = runnerEventEnvelopeSchema.extend({
  finalResult: runnerFinalResultDetailsSchema,
  type: z.literal("workflow.finish"),
});

const pullRequestDeliveryEventSchema = runnerEventEnvelopeSchema.extend({
  deliveryPullRequest: runnerPullRequestDeliveryDetailsSchema,
  type: z.literal("delivery.pull-request"),
});

/* ---------- loop.* detail schemas ---------- */

const loopStartDetailsSchema = z.object({
  projectId: z.string().min(1),
  root: z.string().min(1).optional(),
  strategy: z.string().min(1),
});

// Reuse ticketGraphDtoSchema from the DTO module so the wire shape has one owner.
const loopGraphSnapshotDetailsSchema = ticketGraphDtoSchema;

const loopNodeTransitionDetailsSchema = z.object({
  loopState: loopStateSchema,
  ticketId: z.string().min(1),
});

const loopFinishDetailsSchema = z.object({
  blocked: z.number().int().nonnegative(),
  passed: z.number().int().nonnegative(),
});

/* ---------- loop.* event record variants ---------- */

const loopStartEventSchema = runnerEventEnvelopeSchema.extend({
  loopStart: loopStartDetailsSchema,
  type: z.literal("loop.start"),
});

const loopGraphSnapshotEventSchema = runnerEventEnvelopeSchema.extend({
  loopGraphSnapshot: loopGraphSnapshotDetailsSchema,
  type: z.literal("loop.graph.snapshot"),
});

const loopNodeTransitionEventSchema = runnerEventEnvelopeSchema.extend({
  loopNodeTransition: loopNodeTransitionDetailsSchema,
  type: z.literal("loop.node.transition"),
});

const loopFinishEventSchema = runnerEventEnvelopeSchema.extend({
  loopFinish: loopFinishDetailsSchema,
  type: z.literal("loop.finish"),
});

/**
 * Zod schema for a single runner event record — one item in the events array
 * that the runner POSTs to /api/pipeline/runner-events.
 */
export const runnerEventRecordSchema = z.union([
  workflowPlanEventSchema,
  workflowEdgeEventSchema,
  nodeEventSchema,
  gateEventSchema,
  hookResultEventSchema,
  artifactEventSchema,
  logEventSchema,
  finalResultEventSchema,
  pullRequestDeliveryEventSchema,
  loopStartEventSchema,
  loopGraphSnapshotEventSchema,
  loopNodeTransitionEventSchema,
  loopFinishEventSchema,
]);

/**
 * Zod schema for the POST body of /api/pipeline/runner-events.
 * The runner sends { events: RunnerEventRecord[] }.
 */
export const runnerEventBatchSchema = z
  .object({
    events: z.array(runnerEventRecordSchema).min(1),
  })
  .strict();

export type RunnerEventRecordSchema = typeof runnerEventRecordSchema;
export type RunnerEventBatchSchema = typeof runnerEventBatchSchema;

// Re-export the inferred types from the contract module so consumers only
// need to import from ./events.
export type { RunnerEventRecord } from "./runner-command-contract";

// Compile-time guard: the schema must be assignable to z.ZodType<RunnerEventRecord>.
// If the schema drifts from the TypeScript type a type error appears here.
export const _runnerEventRecordTypeCheck: z.ZodType<RunnerEventRecord> =
  runnerEventRecordSchema;
