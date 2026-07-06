import * as Schema from "effect/Schema";

import { hookArtifactSchema } from "./hooks";
import type { RunnerEventRecord } from "./runner-command-contract";
import {
  mutableArray,
  nonNegativeInteger,
  positiveInteger,
  integer,
  requiredString,
  stringArray,
  unknownRecord,
  urlString,
  struct,
} from "./schema-boundary";
import { loopStateSchema, ticketGraphDtoSchema } from "./tickets/ticket-graph-dto";

/*
 * Effect Schema definitions for runner event records — the items that the runner
 * POSTs to /api/pipeline/runner-events in batches of the shape { events: [...] }.
 *
 * These are the stable external contract for Pipeline Console and any other
 * consumer of the runner event stream. Breaking changes require a contract
 * version bump and an explicit compatibility plan.
 */

const runnerEventEnvelopeFields = {
  at: Schema.optional(Schema.String),
  // Every record carries the runId of the run it belongs to so the event-sink
  // server can resolve the batch's run without relying on URL path/query. The
  // runner is the source of truth for this contract; consumers (Pipeline
  // Console) conform by reading the per-event runId.
  runId: requiredString,
  sequence: positiveInteger,
};

const isRequiredWireField = "required";

/* ---------- detail definitions ---------- */

const runnerWorkflowNodeDetails = struct({
  id: requiredString,
  kind: requiredString,
  needs: stringArray,
  profile: Schema.optional(Schema.String),
  runnerId: Schema.optional(Schema.String),
});

const runnerWorkflowEdgeDetails = struct({
  source: requiredString,
  target: requiredString,
});

const runnerWorkflowPlanDetails = struct({
  edges: Schema.optional(mutableArray(runnerWorkflowEdgeDetails)),
  nodeIds: Schema.optional(mutableArray(requiredString)),
  nodes: Schema.optional(mutableArray(runnerWorkflowNodeDetails)),
  workflowId: requiredString,
});

const runnerWorkflowEdgeRecordDetails = struct({
  id: requiredString,
  source: requiredString,
  target: requiredString,
});

const runnerNodeDetails = struct({
  attempt: nonNegativeInteger,
  exitCode: Schema.optional(integer),
  nodeId: requiredString,
  profile: Schema.optional(Schema.String),
  runnerId: Schema.optional(Schema.String),
  status: Schema.Literals(["agent-finished", "agent-running", "failed", "passed", "running"]),
});

const runnerGateDetails = struct({
  event: Schema.optional(Schema.String),
  evidence: Schema.optional(stringArray),
  gateId: Schema.optional(Schema.String),
  hookId: Schema.optional(Schema.String),
  kind: Schema.optional(Schema.String),
  label: Schema.optional(Schema.String),
  nodeId: Schema.optional(Schema.String),
  passed: Schema.optional(Schema.Boolean),
  reason: Schema.optional(Schema.String),
  [isRequiredWireField]: Schema.optional(Schema.Boolean),
  status: Schema.Literals(["failed", "passed", "running"]),
  workflowId: Schema.optional(Schema.String),
});

const runnerHookResultDetails = struct({
  artifacts: Schema.optional(mutableArray(hookArtifactSchema)),
  event: requiredString,
  functionId: requiredString,
  gateId: Schema.optional(Schema.String),
  hookId: requiredString,
  nodeId: Schema.optional(Schema.String),
  outputs: Schema.optional(unknownRecord),
  status: Schema.Literals(["fail", "pass", "skip"]),
  summary: Schema.optional(Schema.String),
  workflowId: requiredString,
});

const runnerArtifactDetails = struct({
  kind: Schema.Literal("artifact"),
  label: requiredString,
  nodeId: requiredString,
  passed: Schema.optional(Schema.Boolean),
  path: requiredString,
  reason: Schema.optional(Schema.String),
  [isRequiredWireField]: Schema.Boolean,
  status: Schema.Literals(["failed", "passed", "running"]),
  uri: requiredString,
});

const runnerLogDetails = struct({
  attempt: Schema.optional(nonNegativeInteger),
  format: Schema.optional(Schema.String),
  level: Schema.Literals(["info", "warn"]),
  message: Schema.String,
  nodeId: Schema.optional(Schema.String),
  output: Schema.optional(Schema.Unknown),
  passed: Schema.optional(Schema.Boolean),
  reason: Schema.optional(Schema.String),
  workflowId: Schema.optional(Schema.String),
});

const runnerFinalResultDetails = struct({
  outcome: Schema.Literals(["CANCELLED", "FAIL", "PASS"]),
  workflowId: requiredString,
});

const runnerPullRequestDeliveryDetails = struct({
  action: Schema.Literals(["opened", "updated"]),
  url: urlString,
});

/* ---------- event record variants ---------- */

const workflowPlanEvent = struct({
  ...runnerEventEnvelopeFields,
  type: Schema.Literals(["workflow.planned", "workflow.start"]),
  workflowPlan: runnerWorkflowPlanDetails,
});

const workflowEdgeEvent = struct({
  ...runnerEventEnvelopeFields,
  edge: runnerWorkflowEdgeRecordDetails,
  type: Schema.Literal("workflow.edge"),
});

const nodeEvent = struct({
  ...runnerEventEnvelopeFields,
  node: runnerNodeDetails,
  type: Schema.Literals(["agent.finish", "agent.start", "node.finish", "node.start"]),
});

const gateEvent = struct({
  ...runnerEventEnvelopeFields,
  gate: runnerGateDetails,
  type: Schema.Literals(["gate.finish", "gate.start", "hook.finish", "hook.start"]),
});

const hookResultEvent = struct({
  ...runnerEventEnvelopeFields,
  hookResult: runnerHookResultDetails,
  type: Schema.Literal("hook.result"),
});

const artifactEvent = struct({
  ...runnerEventEnvelopeFields,
  artifact: runnerArtifactDetails,
  type: Schema.Literals(["artifact.check.finish", "artifact.check.start"]),
});

const logEvent = struct({
  ...runnerEventEnvelopeFields,
  log: runnerLogDetails,
  type: Schema.Literals([
    "node.output.recorded",
    "output.repair",
    "run.cancelled",
    "runner.command.phase",
    "runner.schema.validation",
    "runtime.observability",
  ]),
});

const finalResultEvent = struct({
  ...runnerEventEnvelopeFields,
  finalResult: runnerFinalResultDetails,
  type: Schema.Literal("workflow.finish"),
});

const pullRequestDeliveryEvent = struct({
  ...runnerEventEnvelopeFields,
  deliveryPullRequest: runnerPullRequestDeliveryDetails,
  type: Schema.Literal("delivery.pull-request"),
});

/* ---------- loop.* detail definitions ---------- */

const loopStartDetails = struct({
  projectId: requiredString,
  root: Schema.optional(requiredString),
  strategy: requiredString,
});

// Reuse ticketGraphDtoSchema from the DTO module so one owner defines the wire shape.
const loopGraphSnapshotDetails = ticketGraphDtoSchema;

const loopNodeTransitionDetails = struct({
  loopState: loopStateSchema,
  ticketId: requiredString,
});

const loopFinishDetails = struct({
  blocked: nonNegativeInteger,
  passed: nonNegativeInteger,
});

/* ---------- loop.* event record variants ---------- */

const loopStartEvent = struct({
  ...runnerEventEnvelopeFields,
  loopStart: loopStartDetails,
  type: Schema.Literal("loop.start"),
});

const loopGraphSnapshotEvent = struct({
  ...runnerEventEnvelopeFields,
  loopGraphSnapshot: loopGraphSnapshotDetails,
  type: Schema.Literal("loop.graph.snapshot"),
});

const loopNodeTransitionEvent = struct({
  ...runnerEventEnvelopeFields,
  loopNodeTransition: loopNodeTransitionDetails,
  type: Schema.Literal("loop.node.transition"),
});

const loopFinishEvent = struct({
  ...runnerEventEnvelopeFields,
  loopFinish: loopFinishDetails,
  type: Schema.Literal("loop.finish"),
});

/**
 * Effect Schema for a single runner event record — one item in the events array
 * that the runner POSTs to /api/pipeline/runner-events.
 */
const runnerEventRecord = Schema.Union([
  workflowPlanEvent,
  workflowEdgeEvent,
  nodeEvent,
  gateEvent,
  hookResultEvent,
  artifactEvent,
  logEvent,
  finalResultEvent,
  pullRequestDeliveryEvent,
  loopStartEvent,
  loopGraphSnapshotEvent,
  loopNodeTransitionEvent,
  loopFinishEvent,
]);

/**
 * Effect Schema for the POST body of /api/pipeline/runner-events.
 * The runner sends { events: RunnerEventRecord[] }.
 */
const runnerEventBatch = struct({
  events: mutableArray(runnerEventRecord).check(Schema.isNonEmpty()),
});

export { runnerEventBatch as runnerEventBatchSchema, runnerEventRecord as runnerEventRecordSchema };

export type RunnerEventRecordSchema = typeof runnerEventRecord;
export type RunnerEventBatchSchema = typeof runnerEventBatch;

// Re-export the inferred types from the contract module so consumers only
// need to import from ./events.
export type { RunnerEventRecord } from "./runner-command-contract";

// Compile-time guard: the schema must be assignable to RunnerEventRecord.
// If the schema drifts from the TypeScript type a type error appears here.
export const _runnerEventRecordTypeCheck: { readonly Type: RunnerEventRecord } = runnerEventRecord;
