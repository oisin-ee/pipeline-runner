// fallow-ignore-file unused-export unused-type
import { isSuccess } from "effect/Result";
import * as Schema from "effect/Schema";

import {
  literalEnum,
  mutableArray,
  parseStrictWithSchema,
  parseResultWithSchema,
  positiveInteger,
  requiredString,
  struct,
} from "../schema-boundary";

export const RUN_TARGETS = ["local", "remote"] as const;
export const RUN_EFFORTS = ["quick", "normal", "thorough"] as const;
export const RUN_MODES = ["read-only", "write"] as const;

/** Default fixed cadence for run-control heartbeat events. */
export const DEFAULT_RUN_CONTROL_HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * Default silence threshold before an active run-control node is marked
 * stalled. This only changes observability state; it does not kill work.
 */
export const DEFAULT_RUN_CONTROL_NODE_STALE_AFTER_MS = 120_000;

export const DEFAULT_RUN_CONTROL_STALE_DETECTION = {
  heartbeatIntervalMs: DEFAULT_RUN_CONTROL_HEARTBEAT_INTERVAL_MS,
  nodeStaleAfterMs: DEFAULT_RUN_CONTROL_NODE_STALE_AFTER_MS,
} as const;

export const MOKA_RUN_STATUSES = [
  "queued",
  "starting",
  "running",
  "stalled",
  "passed",
  "failed",
  "timed_out",
  "aborted",
  "blocked",
] as const;

export const MOKA_NODE_STATUSES = [
  "queued",
  "starting",
  "running",
  "stalled",
  "passed",
  "failed",
  "timed_out",
  "aborted",
  "blocked",
] as const;

export const runTargetSchema = literalEnum(RUN_TARGETS);
export const runEffortSchema = literalEnum(RUN_EFFORTS);
export const runModeSchema = literalEnum(RUN_MODES);
export const mokaRunStatusSchema = literalEnum(MOKA_RUN_STATUSES);
export const mokaNodeStatusSchema = literalEnum(MOKA_NODE_STATUSES);

export const mokaRunTargetSchema = runTargetSchema;
export const mokaRunEffortSchema = runEffortSchema;
export const mokaRunModeSchema = runModeSchema;

const nonEmptyStringSchema = requiredString;
const eventTimestamp = Schema.String.check(
  Schema.makeFilter(
    (value) =>
      isSuccess(Schema.decodeUnknownResult(Schema.DateTimeUtcFromString)(value))
        ? true
        : "must be a valid ISO timestamp",
    {
      description: "ISO timestamp accepted by Effect DateTime parsing.",
      identifier: "RunControlEventTimestamp",
      jsonSchema: { format: "date-time" },
      title: "Run-control event timestamp",
    }
  )
);
const positiveMillisecondsSchema = positiveInteger;

export const runControlStaleDetectionSchema = struct({
  heartbeatIntervalMs: positiveMillisecondsSchema,
  nodeStaleAfterMs: positiveMillisecondsSchema,
});

export const mokaRunControllerSchema = struct({
  argv: mutableArray(nonEmptyStringSchema),
  cwd: nonEmptyStringSchema,
  paths: struct({
    events: nonEmptyStringSchema,
    manifest: nonEmptyStringSchema,
    status: nonEmptyStringSchema,
  }),
  pid: positiveInteger,
  startedAt: eventTimestamp,
});

export const mokaRunStatusEventSchema = struct({
  at: eventTimestamp,
  status: mokaRunStatusSchema,
  type: Schema.Literal("run.status"),
});

export const mokaNodeStatusEventSchema = struct({
  at: eventTimestamp,
  nodeId: nonEmptyStringSchema,
  status: mokaNodeStatusSchema,
  type: Schema.Literal("node.status"),
});

export const mokaRunHeartbeatEventSchema = struct({
  at: eventTimestamp,
  heartbeatIntervalMs: positiveMillisecondsSchema,
  type: Schema.Literal("run.heartbeat"),
});

export const mokaRunEvent = Schema.Union([
  mokaRunStatusEventSchema,
  mokaNodeStatusEventSchema,
]);
export type mokaRunEvent = typeof mokaRunEvent.Type;

export const mokaRunControlEvent = Schema.Union([
  mokaRunHeartbeatEventSchema,
  mokaRunStatusEventSchema,
  mokaNodeStatusEventSchema,
]);
export type mokaRunControlEvent = typeof mokaRunControlEvent.Type;

export const mokaRunManifestSchema = struct({
  controller: Schema.optional(mokaRunControllerSchema),
  effort: runEffortSchema,
  events: mutableArray(mokaRunEvent),
  mode: runModeSchema,
  nodes: Schema.Record(nonEmptyStringSchema, mokaNodeStatusSchema),
  runId: nonEmptyStringSchema,
  // PIPE-91.16: the serialized schedule artifact (schedule.yaml) the run was
  // started with. Persisted once at createRun so `moka resume` reconstructs the
  // run's exact graph from it instead of recompiling the package default
  // workflow. Optional: runs started from a package workflow carry no schedule.
  schedule: Schema.optional(nonEmptyStringSchema),
  staleDetection: Schema.optional(runControlStaleDetectionSchema),
  status: mokaRunStatusSchema,
  target: runTargetSchema,
});

export type RunTarget = typeof runTargetSchema.Type;
export type RunEffort = typeof runEffortSchema.Type;
export type RunMode = typeof runModeSchema.Type;
export type MokaRunStatus = typeof mokaRunStatusSchema.Type;
export type MokaNodeStatus = typeof mokaNodeStatusSchema.Type;
export type RunControlStaleDetection =
  typeof runControlStaleDetectionSchema.Type;
export type MokaRunController = typeof mokaRunControllerSchema.Type;
export type MokaRunEvent = typeof mokaRunEvent.Type;
export type MokaRunHeartbeatEvent = typeof mokaRunHeartbeatEventSchema.Type;
export type MokaRunControlEvent = typeof mokaRunControlEvent.Type;
export type MokaRunManifest = typeof mokaRunManifestSchema.Type;

export const parseRunTarget = (input: unknown): RunTarget =>
  parseStrictWithSchema(runTargetSchema, input);

export const parseRunEffort = (input: unknown): RunEffort =>
  parseStrictWithSchema(runEffortSchema, input);

export const parseRunMode = (input: unknown): RunMode =>
  parseStrictWithSchema(runModeSchema, input);

export const parseMokaRunStatus = (input: unknown): MokaRunStatus =>
  parseStrictWithSchema(mokaRunStatusSchema, input);

export const parseMokaNodeStatus = (input: unknown): MokaNodeStatus =>
  parseStrictWithSchema(mokaNodeStatusSchema, input);

export const parseRunControlStaleDetection = (
  input: unknown
): RunControlStaleDetection =>
  parseStrictWithSchema(runControlStaleDetectionSchema, input);

export const parseMokaRunController = (input: unknown): MokaRunController =>
  parseStrictWithSchema(mokaRunControllerSchema, input);

export const parseMokaRunEvent = (input: unknown): MokaRunControlEvent =>
  parseStrictWithSchema(mokaRunControlEvent, input);

export const parseMokaRunManifest = (input: unknown): MokaRunManifest =>
  parseStrictWithSchema(mokaRunManifestSchema, input);

export const safeParseRunTarget = (input: unknown) =>
  parseResultWithSchema(runTargetSchema, input);

export const safeParseRunEffort = (input: unknown) =>
  parseResultWithSchema(runEffortSchema, input);

export const safeParseRunMode = (input: unknown) =>
  parseResultWithSchema(runModeSchema, input);

export const safeParseMokaRunStatus = (input: unknown) =>
  parseResultWithSchema(mokaRunStatusSchema, input);

export const safeParseMokaNodeStatus = (input: unknown) =>
  parseResultWithSchema(mokaNodeStatusSchema, input);

export const safeParseRunControlStaleDetection = (input: unknown) =>
  parseResultWithSchema(runControlStaleDetectionSchema, input);

export const safeParseMokaRunController = (input: unknown) =>
  parseResultWithSchema(mokaRunControllerSchema, input);

export const safeParseMokaRunEvent = (input: unknown) =>
  parseResultWithSchema(mokaRunControlEvent, input, {
    onExcessProperty: "error",
  });

export const safeParseMokaRunManifest = (input: unknown) =>
  parseResultWithSchema(mokaRunManifestSchema, input, {
    onExcessProperty: "error",
  });

export { mokaRunEvent as mokaRunEventSchema };
export { mokaRunControlEvent as mokaRunControlEventSchema };
