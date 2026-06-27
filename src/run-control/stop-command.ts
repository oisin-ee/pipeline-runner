import { Effect } from "effect";
import type { MokaRunManifest } from "./contracts";
import {
  ACTIVE_NODE_STATUSES,
  requireKnownNodeEffect,
} from "./run-command-domain";
import type { RunControlStore } from "./run-control-store";
import { requireRunEffect } from "./run-query-command";

export function stopRunOrNodeEffect(input: {
  nodeId?: string;
  runId: string;
  store: RunControlStore;
}): Effect.Effect<string, unknown> {
  return Effect.gen(function* () {
    const run = yield* requireRunEffect(input.store, input.runId);
    const at = new Date().toISOString();

    if (input.nodeId) {
      return yield* stopNodeEffect(input.store, run, input.nodeId, at);
    }

    return yield* stopRunEffect(input.store, run, at);
  });
}

function stopNodeEffect(
  store: RunControlStore,
  run: MokaRunManifest,
  requestedNodeId: string,
  at: string
): Effect.Effect<string, unknown> {
  return Effect.gen(function* () {
    const nodeId = yield* requireKnownNodeEffect(run, requestedNodeId);
    yield* store.updateNodeStatus({
      at,
      nodeId,
      runId: run.runId,
      status: "aborted",
    });
    return `Run ${run.runId} node ${nodeId} aborted.`;
  });
}

function stopRunEffect(
  store: RunControlStore,
  run: MokaRunManifest,
  at: string
): Effect.Effect<string, unknown> {
  return Effect.gen(function* () {
    yield* stopControllerProcessEffect(run.controller?.pid);
    yield* store.updateRunStatus({
      at,
      runId: run.runId,
      status: "aborted",
    });
    yield* Effect.forEach(activeNodeIds(run), (nodeId) =>
      store.updateNodeStatus({
        at,
        nodeId,
        runId: run.runId,
        status: "aborted",
      })
    );
    return `Run ${run.runId} aborted.`;
  });
}

function activeNodeIds(run: MokaRunManifest): string[] {
  return Object.entries(run.nodes)
    .filter(([, status]) => ACTIVE_NODE_STATUSES.has(status))
    .map(([nodeId]) => nodeId);
}

function stopControllerProcessEffect(
  pid: number | undefined
): Effect.Effect<void, unknown> {
  return Effect.sync(() => {
    if (!pid) {
      return;
    }

    try {
      process.kill(-pid, "SIGTERM");
    } catch (error) {
      if (isNoSuchProcess(error)) {
        return;
      }
      process.kill(pid, "SIGTERM");
    }
  });
}

function isNoSuchProcess(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ESRCH"
  );
}
