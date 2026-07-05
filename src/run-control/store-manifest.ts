import { Option } from "effect";
import { z } from "zod";

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
import type {
  MokaNodeStatus,
  MokaRunControlEvent,
  MokaRunEvent,
  MokaRunManifest,
} from "./contracts";
import { parseLogicalSegment } from "./logical-segment";
import type {
  CreateRunInput,
  RunStatusFile,
  RunStatusNode,
} from "./store-types";

const runStatusNodeSchema = z.union([
  mokaNodeStatusSchema,
  z
    .object({
      sessionId: z.string().min(1).optional(),
      status: mokaNodeStatusSchema,
    })
    .strict(),
]);

const runStatusFileSchema = z
  .object({
    nodes: z.record(z.string().min(1), runStatusNodeSchema),
    status: mokaRunStatusSchema,
  })
  .strict();
const runStatusSessionSchema = z
  .object({ sessionId: z.string().min(1) })
  .passthrough();

export const createRunManifest = (
  input: CreateRunInput
): {
  manifest: MokaRunManifest;
  nodeIds: string[];
  runId: string;
} => {
  const runId = parseLogicalSegment("runId", input.runId);
  const nodeIds = input.nodeIds.map((nodeId) =>
    parseLogicalSegment("nodeId", nodeId)
  );
  const nodes = Object.fromEntries(nodeIds.map((nodeId) => [nodeId, "queued"]));
  const manifest = parseMokaRunManifest({
    effort: parseRunEffort(input.effort),
    events: [],
    mode: parseRunMode(input.mode),
    nodes,
    runId,
    ...(input.schedule !== undefined && input.schedule.length > 0
      ? { schedule: input.schedule }
      : {}),
    staleDetection: parseRunControlStaleDetection(
      input.staleDetection ?? DEFAULT_RUN_CONTROL_STALE_DETECTION
    ),
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
  if (input.schedule.length === 0) {
    throw new Error("schedule must be a non-empty string.");
  }
  if (
    input.manifest.schedule !== undefined &&
    input.manifest.schedule !== input.schedule
  ) {
    throw new Error(
      `Run ${input.manifest.runId} already has a different published schedule.`
    );
  }
  const nodeIds = input.nodeIds.map((nodeId) =>
    parseLogicalSegment("nodeId", nodeId)
  );
  return parseMokaRunManifest({
    ...input.manifest,
    nodes: {
      ...input.manifest.nodes,
      ...Object.fromEntries(
        nodeIds
          .filter((nodeId) => !(nodeId in input.manifest.nodes))
          .map((nodeId) => [nodeId, "queued" as const])
      ),
    },
    schedule: input.schedule,
  });
};

export const parseRunStatusFile = (input: unknown): RunStatusFile =>
  runStatusFileSchema.parse(input);

const existingSessionId = (
  node: Option.Option<RunStatusNode>
): Option.Option<string> =>
  Option.flatMap(node, (value) => {
    const result = runStatusSessionSchema.safeParse(value);
    return result.success ? Option.some(result.data.sessionId) : Option.none();
  });

const statusNodeWithMetadata = (
  status: MokaNodeStatus,
  existing: Option.Option<RunStatusNode>
): RunStatusNode => {
  const sessionId = existingSessionId(existing);

  return Option.match(sessionId, {
    onNone: () => status,
    onSome: (value) => ({ sessionId: value, status }),
  });
};

export const statusFromManifest = (
  manifest: MokaRunManifest,
  existing?: RunStatusFile
): RunStatusFile => ({
  nodes: Object.fromEntries(
    Object.entries(manifest.nodes).map(([nodeId, status]) => [
      nodeId,
      statusNodeWithMetadata(
        status,
        Option.fromNullishOr(existing?.nodes[nodeId])
      ),
    ])
  ),
  status: manifest.status,
});

const isStatusEvent = (event: MokaRunControlEvent): event is MokaRunEvent =>
  event.type !== "run.heartbeat";

const assertNever = (value: never): never => {
  throw new Error(`Unhandled run-control event: ${JSON.stringify(value)}`);
};

const applyRunControlEvent = (
  manifest: MokaRunManifest,
  event: MokaRunControlEvent
): void => {
  switch (event.type) {
    case "run.heartbeat": {
      return;
    }
    case "run.status": {
      manifest.status = event.status;
      return;
    }
    case "node.status": {
      manifest.nodes[event.nodeId] = event.status;
      return;
    }
    default: {
      assertNever(event);
    }
  }
};

export const replayEvents = (
  manifest: MokaRunManifest,
  events: MokaRunControlEvent[]
): MokaRunManifest => {
  const rebuilt: MokaRunManifest = {
    ...manifest,
    events: events.filter(isStatusEvent),
    nodes: { ...manifest.nodes },
  };

  for (const event of events) {
    applyRunControlEvent(rebuilt, event);
  }

  return parseMokaRunManifest(rebuilt);
};
