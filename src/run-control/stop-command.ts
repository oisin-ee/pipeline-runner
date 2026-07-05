import { Effect, Option } from "effect";

import type { MokaRunManifest } from "./contracts";
import {
  ACTIVE_NODE_STATUSES,
  requireKnownNodeEffect,
} from "./run-command-domain";
import type { RunControlStore } from "./run-control-store";
import { requireRunEffect } from "./run-query-command";

const stopNodeEffect = (
  store: RunControlStore,
  run: MokaRunManifest,
  requestedNodeId: string,
  at: string
): Effect.Effect<string, unknown> =>
  Effect.gen(function* effectBody() {
    const nodeId = yield* requireKnownNodeEffect(run, requestedNodeId);
    yield* store.updateNodeStatus({
      at,
      nodeId,
      runId: run.runId,
      status: "aborted",
    });
    return `Run ${run.runId} node ${nodeId} aborted.`;
  });

const activeNodeIds = (run: MokaRunManifest): string[] =>
  Object.entries(run.nodes)
    .filter(([, status]) => ACTIVE_NODE_STATUSES.has(status))
    .map(([nodeId]) => nodeId);

const isNoSuchProcess = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === "ESRCH";

const stopControllerProcessEffect = (
  pid: Option.Option<number>
): Effect.Effect<void, unknown> =>
  Effect.sync(() => {
    if (Option.isNone(pid) || pid.value === 0) {
      return;
    }

    try {
      process.kill(-pid.value, "SIGTERM");
    } catch (error) {
      if (isNoSuchProcess(error)) {
        return;
      }
      process.kill(pid.value, "SIGTERM");
    }
  });

const stopRunEffect = (
  store: RunControlStore,
  run: MokaRunManifest,
  at: string
): Effect.Effect<string, unknown> =>
  Effect.gen(function* effectBody() {
    yield* stopControllerProcessEffect(
      Option.fromNullishOr(run.controller?.pid)
    );
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

export const stopRunOrNodeEffect = (input: {
  nodeId?: string;
  runId: string;
  store: RunControlStore;
}): Effect.Effect<string, unknown> =>
  Effect.gen(function* effectBody() {
    const run = yield* requireRunEffect(input.store, input.runId);
    const at = new Date().toISOString();

    const nodeId = Option.fromNullishOr(input.nodeId).pipe(
      Option.filter((value) => value.length > 0)
    );
    if (Option.isSome(nodeId)) {
      return yield* stopNodeEffect(input.store, run, nodeId.value, at);
    }

    return yield* stopRunEffect(input.store, run, at);
  });
