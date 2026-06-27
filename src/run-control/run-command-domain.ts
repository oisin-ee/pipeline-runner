import { Effect } from "effect";
import type {
  MokaNodeStatus,
  MokaRunManifest,
  MokaRunStatus,
} from "./contracts";
import { parseLogicalSegment } from "./logical-segment";

const ACTIVE_RUN_STATUSES = new Set<MokaRunStatus>([
  "queued",
  "starting",
  "running",
  "stalled",
]);

export const ACTIVE_NODE_STATUSES = new Set<MokaNodeStatus>([
  "queued",
  "starting",
  "running",
  "stalled",
]);

export function isRunActive(run: MokaRunManifest): boolean {
  return ACTIVE_RUN_STATUSES.has(run.status);
}

export function requireKnownNodeEffect(
  run: MokaRunManifest,
  nodeId: string
): Effect.Effect<string, unknown> {
  return Effect.try({
    catch: (error) => error,
    try: () => requireKnownNode(run, nodeId),
  });
}

function requireKnownNode(run: MokaRunManifest, nodeId: string): string {
  const logicalNodeId = parseLogicalSegment("nodeId", nodeId);
  if (!Object.hasOwn(run.nodes, logicalNodeId)) {
    throw new Error(`Run ${run.runId} does not have node ${logicalNodeId}.`);
  }
  return logicalNodeId;
}
