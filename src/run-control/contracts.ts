import { z } from "zod";

export const RUN_TARGETS = ["local", "remote"] as const;
export const RUN_EFFORTS = ["quick", "normal", "thorough"] as const;
export const RUN_MODES = ["read-only", "write"] as const;

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

export const mokaRunEventSchema = z.discriminatedUnion("type", [
  mokaRunStatusEventSchema,
  mokaNodeStatusEventSchema,
]);

export const mokaRunManifestSchema = z
  .object({
    effort: runEffortSchema,
    events: z.array(mokaRunEventSchema),
    mode: runModeSchema,
    nodes: z.record(nonEmptyStringSchema, mokaNodeStatusSchema),
    runId: nonEmptyStringSchema,
    status: mokaRunStatusSchema,
    target: runTargetSchema,
  })
  .strict();

export type RunTarget = z.infer<typeof runTargetSchema>;
export type RunEffort = z.infer<typeof runEffortSchema>;
export type RunMode = z.infer<typeof runModeSchema>;
export type MokaRunStatus = z.infer<typeof mokaRunStatusSchema>;
export type MokaNodeStatus = z.infer<typeof mokaNodeStatusSchema>;
export type MokaRunEvent = z.infer<typeof mokaRunEventSchema>;
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

export function parseMokaRunEvent(input: unknown): MokaRunEvent {
  return mokaRunEventSchema.parse(input);
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

export const safeParseMokaRunEvent = (input: unknown) =>
  mokaRunEventSchema.safeParse(input);

export const safeParseMokaRunManifest = (input: unknown) =>
  mokaRunManifestSchema.safeParse(input);
