// fallow-ignore-file unused-export unused-type
import { z } from "zod";

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

export const runTargetSchema = z.enum(RUN_TARGETS);
export const runEffortSchema = z.enum(RUN_EFFORTS);
export const runModeSchema = z.enum(RUN_MODES);
export const mokaRunStatusSchema = z.enum(MOKA_RUN_STATUSES);
export const mokaNodeStatusSchema = z.enum(MOKA_NODE_STATUSES);

export const mokaRunTargetSchema = runTargetSchema;
export const mokaRunEffortSchema = runEffortSchema;
export const mokaRunModeSchema = runModeSchema;

const nonEmptyStringSchema = z.string().min(1);
const eventTimestampSchema = z.string().datetime();
const positiveMillisecondsSchema = z.number().int().positive();

export const runControlStaleDetectionSchema = z
  .object({
    heartbeatIntervalMs: positiveMillisecondsSchema,
    nodeStaleAfterMs: positiveMillisecondsSchema,
  })
  .strict();

export const mokaRunControllerSchema = z
  .object({
    argv: z.array(nonEmptyStringSchema),
    cwd: nonEmptyStringSchema,
    paths: z
      .object({
        events: nonEmptyStringSchema,
        manifest: nonEmptyStringSchema,
        status: nonEmptyStringSchema,
      })
      .strict(),
    pid: z.number().int().positive(),
    startedAt: eventTimestampSchema,
  })
  .strict();

export const mokaRunStatusEventSchema = z
  .object({
    at: eventTimestampSchema,
    status: mokaRunStatusSchema,
    type: z.literal("run.status"),
  })
  .strict();

export const mokaNodeStatusEventSchema = z
  .object({
    at: eventTimestampSchema,
    nodeId: nonEmptyStringSchema,
    status: mokaNodeStatusSchema,
    type: z.literal("node.status"),
  })
  .strict();

export const mokaRunHeartbeatEventSchema = z
  .object({
    at: eventTimestampSchema,
    heartbeatIntervalMs: positiveMillisecondsSchema,
    nodeId: z.never().optional(),
    status: z.never().optional(),
    type: z.literal("run.heartbeat"),
  })
  .strict();

export const mokaRunEventSchema = z.discriminatedUnion("type", [
  mokaRunStatusEventSchema,
  mokaNodeStatusEventSchema,
]);

export const mokaRunControlEventSchema = z.discriminatedUnion("type", [
  mokaRunHeartbeatEventSchema,
  mokaRunStatusEventSchema,
  mokaNodeStatusEventSchema,
]);

export const mokaRunManifestSchema = z
  .object({
    controller: mokaRunControllerSchema.optional(),
    effort: runEffortSchema,
    events: z.array(mokaRunEventSchema),
    mode: runModeSchema,
    nodes: z.record(nonEmptyStringSchema, mokaNodeStatusSchema),
    runId: nonEmptyStringSchema,
    staleDetection: runControlStaleDetectionSchema.optional(),
    status: mokaRunStatusSchema,
    target: runTargetSchema,
  })
  .strict();

export type RunTarget = z.infer<typeof runTargetSchema>;
export type RunEffort = z.infer<typeof runEffortSchema>;
export type RunMode = z.infer<typeof runModeSchema>;
export type MokaRunStatus = z.infer<typeof mokaRunStatusSchema>;
export type MokaNodeStatus = z.infer<typeof mokaNodeStatusSchema>;
export type RunControlStaleDetection = z.infer<
  typeof runControlStaleDetectionSchema
>;
export type MokaRunController = z.infer<typeof mokaRunControllerSchema>;
export type MokaRunEvent = z.infer<typeof mokaRunEventSchema>;
export type MokaRunHeartbeatEvent = z.infer<typeof mokaRunHeartbeatEventSchema>;
export type MokaRunControlEvent = z.infer<typeof mokaRunControlEventSchema>;
export type MokaRunManifest = z.infer<typeof mokaRunManifestSchema>;

export function parseRunTarget(input: unknown): RunTarget {
  return runTargetSchema.parse(input);
}

export function parseRunEffort(input: unknown): RunEffort {
  return runEffortSchema.parse(input);
}

export function parseRunMode(input: unknown): RunMode {
  return runModeSchema.parse(input);
}

export function parseMokaRunStatus(input: unknown): MokaRunStatus {
  return mokaRunStatusSchema.parse(input);
}

export function parseMokaNodeStatus(input: unknown): MokaNodeStatus {
  return mokaNodeStatusSchema.parse(input);
}

export function parseRunControlStaleDetection(
  input: unknown
): RunControlStaleDetection {
  return runControlStaleDetectionSchema.parse(input);
}

export function parseMokaRunController(input: unknown): MokaRunController {
  return mokaRunControllerSchema.parse(input);
}

export function parseMokaRunEvent(input: unknown): MokaRunControlEvent {
  return mokaRunControlEventSchema.parse(input);
}

export function parseMokaRunManifest(input: unknown): MokaRunManifest {
  return mokaRunManifestSchema.parse(input);
}

export const safeParseRunTarget = (input: unknown) =>
  runTargetSchema.safeParse(input);

export const safeParseRunEffort = (input: unknown) =>
  runEffortSchema.safeParse(input);

export const safeParseRunMode = (input: unknown) =>
  runModeSchema.safeParse(input);

export const safeParseMokaRunStatus = (input: unknown) =>
  mokaRunStatusSchema.safeParse(input);

export const safeParseMokaNodeStatus = (input: unknown) =>
  mokaNodeStatusSchema.safeParse(input);

export const safeParseRunControlStaleDetection = (input: unknown) =>
  runControlStaleDetectionSchema.safeParse(input);

export const safeParseMokaRunController = (input: unknown) =>
  mokaRunControllerSchema.safeParse(input);

export const safeParseMokaRunEvent = (input: unknown) =>
  mokaRunControlEventSchema.safeParse(input);

export const safeParseMokaRunManifest = (input: unknown) =>
  mokaRunManifestSchema.safeParse(input);
