import { z } from "zod";
import {
  DEFAULT_RUN_CONTROL_STALE_DETECTION,
  type MokaNodeStatus,
  type MokaRunControlEvent,
  type MokaRunEvent,
  type MokaRunManifest,
  mokaNodeStatusSchema,
  mokaRunStatusSchema,
  parseMokaRunManifest,
  parseRunControlStaleDetection,
  parseRunEffort,
  parseRunMode,
  parseRunTarget,
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

export function createRunManifest(input: CreateRunInput): {
  manifest: MokaRunManifest;
  nodeIds: string[];
  runId: string;
} {
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
    ...(input.schedule ? { schedule: input.schedule } : {}),
    staleDetection: parseRunControlStaleDetection(
      input.staleDetection ?? DEFAULT_RUN_CONTROL_STALE_DETECTION
    ),
    status: "queued",
    target: parseRunTarget(input.target),
  });

  return { manifest, nodeIds, runId };
}

export function replayEvents(
  manifest: MokaRunManifest,
  events: MokaRunControlEvent[]
): MokaRunManifest {
  const rebuilt: MokaRunManifest = {
    ...manifest,
    events: events.filter(isStatusEvent),
    nodes: { ...manifest.nodes },
  };

  for (const event of events) {
    applyRunControlEvent(rebuilt, event);
  }

  return parseMokaRunManifest(rebuilt);
}

export function parseRunStatusFile(input: unknown): RunStatusFile {
  return runStatusFileSchema.parse(input);
}

export function statusFromManifest(
  manifest: MokaRunManifest,
  existing?: RunStatusFile
): RunStatusFile {
  return {
    nodes: Object.fromEntries(
      Object.entries(manifest.nodes).map(([nodeId, status]) => [
        nodeId,
        statusNodeWithMetadata(status, existing?.nodes[nodeId]),
      ])
    ),
    status: manifest.status,
  };
}

function applyRunControlEvent(
  manifest: MokaRunManifest,
  event: MokaRunControlEvent
): void {
  switch (event.type) {
    case "run.heartbeat":
      return;
    case "run.status":
      manifest.status = event.status;
      return;
    case "node.status":
      manifest.nodes[event.nodeId] = event.status;
      return;
    default:
      assertNever(event);
  }
}

function statusNodeWithMetadata(
  status: MokaNodeStatus,
  existing: RunStatusNode | undefined
): RunStatusNode {
  const sessionId = existingSessionId(existing);

  return sessionId ? { sessionId, status } : status;
}

function existingSessionId(
  node: RunStatusNode | undefined
): string | undefined {
  const result = runStatusSessionSchema.safeParse(node);
  return result.success ? result.data.sessionId : undefined;
}

function isStatusEvent(event: MokaRunControlEvent): event is MokaRunEvent {
  return event.type !== "run.heartbeat";
}

function assertNever(value: never): never {
  throw new Error(`Unhandled run-control event: ${JSON.stringify(value)}`);
}
