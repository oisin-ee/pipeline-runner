import * as Arr from "effect/Array";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as R from "effect/Record";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

import { parseResultWithSchema, parseStrictWithSchema, requiredString, struct } from "../schema-boundary";
import {
  DEFAULT_RUN_CONTROL_STALE_DETECTION,
  mokaNodeStatusSchema,
  mokaRunStatusSchema,
  parseMokaRunManifest,
  parseRunControlStaleDetection,
  parseRunEffort,
  parseRunMode,
  parseRunTarget,
} from "./contracts";
import type { MokaNodeStatus, MokaRunControlEvent, MokaRunEvent, MokaRunManifest } from "./contracts";
import { parseLogicalSegment } from "./logical-segment";
import type { CreateRunInput, RunStatusFile, RunStatusNode } from "./store-types";

const runStatusNode = Schema.Union([
  mokaNodeStatusSchema,
  struct({
    sessionId: Schema.optional(requiredString),
    status: mokaNodeStatusSchema,
  }),
]);

const runStatusFileSchema = struct({
  nodes: Schema.Record(requiredString, runStatusNode),
  status: mokaRunStatusSchema,
});
const runStatusSessionSchema = struct({
  sessionId: requiredString,
});

const schedulePatch = (schedule: Option.Option<string>): Partial<Pick<MokaRunManifest, "schedule">> =>
  Option.match(schedule, {
    onNone: () => ({}),
    onSome: (value) => (Str.isNonEmpty(value) ? { schedule: value } : {}),
  });

class EmptyPublishedScheduleError extends Schema.TaggedErrorClass<EmptyPublishedScheduleError>()(
  "EmptyPublishedScheduleError",
  {
    message: Schema.String,
  },
) {
  constructor() {
    super({ message: "schedule must be a non-empty string." });
  }
}

class PublishedScheduleConflictError extends Schema.TaggedErrorClass<PublishedScheduleConflictError>()(
  "PublishedScheduleConflictError",
  {
    message: Schema.String,
    runId: requiredString,
  },
) {
  constructor(runId: string) {
    super({
      message: `Run ${runId} already has a different published schedule.`,
      runId,
    });
  }
}

const queuedNodeEntry = (nodeId: string): readonly [string, MokaNodeStatus] => [nodeId, "queued"];

const queuedNodeRecord = (nodeIds: readonly string[]): MokaRunManifest["nodes"] =>
  R.fromEntries(Arr.map(nodeIds, queuedNodeEntry));

export const createRunManifest = (
  input: CreateRunInput,
): {
  manifest: MokaRunManifest;
  nodeIds: string[];
  runId: string;
} => {
  const runId = parseLogicalSegment("runId", input.runId);
  const nodeIds = input.nodeIds.map((nodeId) => parseLogicalSegment("nodeId", nodeId));
  const nodes = queuedNodeRecord(nodeIds);
  const manifest = parseMokaRunManifest({
    effort: parseRunEffort(input.effort),
    events: [],
    mode: parseRunMode(input.mode),
    nodes,
    runId,
    ...schedulePatch(Option.fromUndefinedOr(input.schedule)),
    staleDetection: parseRunControlStaleDetection(input.staleDetection ?? DEFAULT_RUN_CONTROL_STALE_DETECTION),
    status: "queued",
    target: parseRunTarget(input.target),
  });

  return { manifest, nodeIds, runId };
};

export const publishScheduleManifest = (input: {
  manifest: MokaRunManifest;
  nodeIds: string[];
  schedule: string;
}): MokaRunManifest => {
  if (Str.isEmpty(input.schedule)) {
    throw new EmptyPublishedScheduleError();
  }
  if (input.manifest.schedule !== undefined && input.manifest.schedule !== input.schedule) {
    throw new PublishedScheduleConflictError(input.manifest.runId);
  }
  const nodeIds = input.nodeIds.map((nodeId) => parseLogicalSegment("nodeId", nodeId));
  const missingNodes = Arr.filter(nodeIds, (nodeId) => !R.has(input.manifest.nodes, nodeId));
  return parseMokaRunManifest({
    ...input.manifest,
    nodes: {
      ...input.manifest.nodes,
      ...queuedNodeRecord(missingNodes),
    },
    schedule: input.schedule,
  });
};

export const parseRunStatusFile = (input: unknown): RunStatusFile => parseStrictWithSchema(runStatusFileSchema, input);

const existingSessionId = (node: Option.Option<RunStatusNode>): Option.Option<string> =>
  Option.flatMap(node, (value) => {
    const result = parseResultWithSchema(runStatusSessionSchema, value, {
      onExcessProperty: "preserve",
    });
    return result.ok ? Option.some(result.value.sessionId) : Option.none();
  });

const statusNodeWithMetadata = (status: MokaNodeStatus, existing: Option.Option<RunStatusNode>): RunStatusNode => {
  const sessionId = existingSessionId(existing);

  return Option.match(sessionId, {
    onNone: () => status,
    onSome: (value) => ({ sessionId: value, status }),
  });
};

const existingStatusNode = (existing: Option.Option<RunStatusFile>, nodeId: string): Option.Option<RunStatusNode> =>
  Option.flatMap(existing, (file) => Option.fromNullishOr(file.nodes[nodeId]));

const statusNodeEntry = (
  existing: Option.Option<RunStatusFile>,
  [nodeId, status]: readonly [string, MokaNodeStatus],
): readonly [string, RunStatusNode] => [nodeId, statusNodeWithMetadata(status, existingStatusNode(existing, nodeId))];

export const statusFromManifest = (manifest: MokaRunManifest, existing?: RunStatusFile): RunStatusFile => {
  const existingFile = Option.fromUndefinedOr(existing);
  return {
    nodes: R.fromEntries(Arr.map(R.toEntries(manifest.nodes), (entry) => statusNodeEntry(existingFile, entry))),
    status: manifest.status,
  };
};

const isStatusEvent = (event: MokaRunControlEvent): event is MokaRunEvent => event.type !== "run.heartbeat";

const applyRunControlEvent = (manifest: MokaRunManifest, event: MokaRunControlEvent): MokaRunManifest =>
  Match.value(event).pipe(
    Match.when({ type: "run.heartbeat" }, () => manifest),
    Match.when({ type: "run.status" }, ({ status }) => ({
      ...manifest,
      status,
    })),
    Match.when({ type: "node.status" }, ({ nodeId, status }) => ({
      ...manifest,
      nodes: { ...manifest.nodes, [nodeId]: status },
    })),
    Match.exhaustive,
  );

export const replayEvents = (manifest: MokaRunManifest, events: MokaRunControlEvent[]): MokaRunManifest => {
  const replayStart: MokaRunManifest = {
    ...manifest,
    events: Arr.filter(events, isStatusEvent),
    nodes: { ...manifest.nodes },
  };

  return parseMokaRunManifest(Arr.reduce(events, replayStart, applyRunControlEvent));
};
