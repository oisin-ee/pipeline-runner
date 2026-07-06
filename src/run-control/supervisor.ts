// fallow-ignore-file unused-export complexity
import { Effect, Option } from "effect";

import type { PipelineRuntimeEvent, PipelineRuntimeOptions } from "../pipeline-runtime";
import { createSerializedWriteQueue } from "../serialized-write-queue";
import {
  DEFAULT_RUN_CONTROL_HEARTBEAT_INTERVAL_MS,
  DEFAULT_RUN_CONTROL_NODE_STALE_AFTER_MS,
  parseRunControlStaleDetection,
} from "./contracts";
import type { MokaNodeStatus } from "./contracts";
import type { RunControlStore } from "./run-control-store";
import { createRunStoreRuntimeReporter } from "./runtime-reporter";

type RuntimeReporter = NonNullable<PipelineRuntimeOptions["reporter"]>;
type TimerHandle = ReturnType<typeof setTimeout>;

export interface CreateRunControlSupervisorInput {
  heartbeatIntervalMs?: number;
  nodeStaleAfterMs?: number;
  now?: () => Date;
  reporter?: PipelineRuntimeOptions["reporter"];
  runId: string;
  /**
   * The run-control store the supervisor's heartbeat/stall writes go through,
   * also threaded into the bridge reporter. The program entrypoint resolves it
   * via the `db.url` seam.
   */
  store: RunControlStore;
  workspaceRoot: string;
}

export interface RunControlSupervisor {
  flush: () => Promise<void>;
  flushEffect: () => Effect.Effect<void, unknown>;
  reporter: RuntimeReporter;
  start: () => void;
  startEffect: () => Effect.Effect<void>;
  stop: () => Promise<void>;
  stopEffect: () => Effect.Effect<void, unknown>;
}

interface NodeActivity {
  lastActivityMs: number;
  staleTimer?: TimerHandle;
  status: MokaNodeStatus;
}

type EventPredicate = (event: PipelineRuntimeEvent) => boolean;

const isRunningNodeEvent: EventPredicate = (event) =>
  [
    "agent.start",
    "artifact.check.start",
    "gate.start",
    "hook.result",
    "hook.start",
    "node.output.recorded",
    "node.session",
    "node.start",
    "output.repair",
    "runtime.observability",
  ].includes(event.type);

const CLEAR_NODE_ACTIVITY: readonly EventPredicate[] = [
  (event) => event.type === "node.finish",
  (event) => event.type === "agent.finish" && event.exitCode !== 0,
  (event) =>
    (event.type === "artifact.check.finish" || event.type === "hook.finish") && event.required && !event.passed,
  (event) => event.type === "gate.finish" && !event.passed,
];

const MARK_NODE_RUNNING: readonly EventPredicate[] = [
  isRunningNodeEvent,
  (event) => event.type === "agent.finish" && event.exitCode === 0,
  (event) =>
    (event.type === "artifact.check.finish" || event.type === "hook.finish") && (event.passed || !event.required),
  (event) => event.type === "gate.finish" && event.passed,
];

const timestamp = (now: () => Date): string => now().toISOString();

const nodeIdFromEvent = (event: PipelineRuntimeEvent): Option.Option<string> => {
  if (!("nodeId" in event)) {
    return Option.none();
  }
  return Option.fromUndefinedOr(event.nodeId);
};

const shouldClearNodeActivity = (event: PipelineRuntimeEvent): boolean =>
  CLEAR_NODE_ACTIVITY.some((predicate) => predicate(event));

const shouldMarkNodeRunning = (event: PipelineRuntimeEvent): boolean =>
  MARK_NODE_RUNNING.some((predicate) => predicate(event));

const scheduleStaleTimerEffect = (input: {
  activity: NodeActivity;
  delayMs: number;
  nodeId: string;
  onTimer: (nodeId: string) => void;
}): Effect.Effect<void> =>
  Effect.sync(() => {
    if (input.activity.staleTimer) {
      clearTimeout(input.activity.staleTimer);
    }
    input.activity.staleTimer = setTimeout(() => {
      input.onTimer(input.nodeId);
    }, input.delayMs);
  });

const createRunControlSupervisorRuntime = (input: CreateRunControlSupervisorInput): RunControlSupervisor => {
  const now = input.now ?? (() => new Date());
  const staleDetection = parseRunControlStaleDetection({
    heartbeatIntervalMs: input.heartbeatIntervalMs ?? DEFAULT_RUN_CONTROL_HEARTBEAT_INTERVAL_MS,
    nodeStaleAfterMs: input.nodeStaleAfterMs ?? DEFAULT_RUN_CONTROL_NODE_STALE_AFTER_MS,
  });
  const { store } = input;
  const bridge = createRunStoreRuntimeReporter({
    now,
    reporter: input.reporter,
    runId: input.runId,
    store,
    workspaceRoot: input.workspaceRoot,
  });
  const nodeActivity = new Map<string, NodeActivity>();
  const controlWrites = createSerializedWriteQueue();
  let heartbeatTimer = Option.none<TimerHandle>();
  let runActive = false;
  let stopped = false;

  const flushControlWritesEffect = (): Effect.Effect<void, unknown> =>
    Effect.tryPromise({
      catch: (error) => error,
      try: async () => {
        await controlWrites.flush();
      },
    });

  const enqueueControlWriteEffect = (write: Effect.Effect<void, unknown>): Effect.Effect<void> =>
    Effect.sync(() => {
      controlWrites.enqueue(async () => {
        await Effect.runPromise(bridge.flushEffect().pipe(Effect.andThen(write)));
      });
    });

  const enqueueHeartbeatEffect = (): Effect.Effect<void> =>
    Effect.gen(function* enqueueHeartbeatProgram() {
      if (!(runActive && !stopped)) {
        return;
      }
      const at = timestamp(now);
      yield* enqueueControlWriteEffect(
        store.recordEvent({
          event: {
            at,
            heartbeatIntervalMs: staleDetection.heartbeatIntervalMs,
            type: "run.heartbeat",
          },
          runId: input.runId,
        }),
      );
    });

  const enqueueHeartbeat = (): void => {
    Effect.runSync(enqueueHeartbeatEffect());
  };

  const markNodeStalledEffect = (nodeId: string): Effect.Effect<void> =>
    Effect.gen(function* effectBody() {
      const activity = nodeActivity.get(nodeId);
      if (!(activity && runActive && !stopped && activity.status === "running")) {
        return;
      }

      const elapsedMs = now().getTime() - activity.lastActivityMs;
      if (elapsedMs < staleDetection.nodeStaleAfterMs) {
        const delayMs = staleDetection.nodeStaleAfterMs - elapsedMs;
        yield* scheduleStaleTimerEffect({
          activity,
          delayMs,
          nodeId,
          onTimer: (stalledNodeId) => {
            Effect.runSync(markNodeStalledEffect(stalledNodeId));
          },
        });
        return;
      }

      activity.status = "stalled";
      activity.staleTimer = undefined;
      const at = timestamp(now);
      yield* enqueueControlWriteEffect(
        store.updateNodeStatus({
          at,
          nodeId,
          runId: input.runId,
          status: "stalled",
        }),
      );
    });

  const markNodeRunningEffect = (nodeId: string): Effect.Effect<void> =>
    Effect.gen(function* markNodeRunningProgram() {
      if (!(runActive && !stopped)) {
        return;
      }
      const previous = nodeActivity.get(nodeId);
      const wasStalled = previous?.status === "stalled";
      const activity: NodeActivity = {
        lastActivityMs: now().getTime(),
        staleTimer: previous?.staleTimer,
        status: "running",
      };
      nodeActivity.set(nodeId, activity);
      yield* scheduleStaleTimerEffect({
        activity,
        delayMs: staleDetection.nodeStaleAfterMs,
        nodeId,
        onTimer: (stalledNodeId) => {
          Effect.runSync(markNodeStalledEffect(stalledNodeId));
        },
      });

      if (wasStalled) {
        const at = timestamp(now);
        yield* enqueueControlWriteEffect(
          store.updateNodeStatus({
            at,
            nodeId,
            runId: input.runId,
            status: "running",
          }),
        );
      }
    });

  const clearNodeEffect = (nodeId: string): Effect.Effect<void> =>
    Effect.sync(() => {
      const activity = nodeActivity.get(nodeId);
      if (activity?.staleTimer) {
        clearTimeout(activity.staleTimer);
      }
      nodeActivity.delete(nodeId);
    });

  const clearAllNodesEffect = (): Effect.Effect<void> =>
    Effect.forEach([...nodeActivity.keys()], clearNodeEffect, {
      concurrency: 1,
    }).pipe(Effect.asVoid);

  const observeRuntimeEventEffect = (event: PipelineRuntimeEvent): Effect.Effect<void> =>
    Effect.gen(function* observeRuntimeEventProgram() {
      if (event.type === "workflow.start") {
        runActive = true;
        return;
      }
      if (event.type === "workflow.finish") {
        runActive = false;
        yield* clearAllNodesEffect();
        return;
      }

      const nodeId = nodeIdFromEvent(event);
      if (Option.isNone(nodeId) || nodeId.value.length === 0) {
        return;
      }
      if (shouldClearNodeActivity(event)) {
        yield* clearNodeEffect(nodeId.value);
        return;
      }
      if (shouldMarkNodeRunning(event)) {
        yield* markNodeRunningEffect(nodeId.value);
      }
    });

  const startEffect = (): Effect.Effect<void> =>
    Effect.sync(() => {
      if (Option.isSome(heartbeatTimer) || stopped) {
        return;
      }
      heartbeatTimer = Option.some(setInterval(enqueueHeartbeat, staleDetection.heartbeatIntervalMs));
    });

  const stopEffect = (): Effect.Effect<void, unknown> =>
    Effect.gen(function* stopProgram() {
      stopped = true;
      if (Option.isSome(heartbeatTimer)) {
        clearInterval(heartbeatTimer.value);
        heartbeatTimer = Option.none();
      }
      yield* clearAllNodesEffect();
      yield* bridge.flushEffect();
      yield* flushControlWritesEffect();
    });

  const flushEffect = (): Effect.Effect<void, unknown> =>
    Effect.gen(function* flushProgram() {
      yield* bridge.flushEffect();
      yield* flushControlWritesEffect();
    });

  return {
    flush: async () => {
      await Effect.runPromise(flushEffect());
    },
    flushEffect,
    reporter(event) {
      bridge.reporter(event);
      Effect.runSync(observeRuntimeEventEffect(event));
    },
    start() {
      Effect.runSync(startEffect());
    },
    startEffect,
    stop: async () => {
      await Effect.runPromise(stopEffect());
    },
    stopEffect,
  };
};

export const createRunControlSupervisorEffect = (
  input: CreateRunControlSupervisorInput,
): Effect.Effect<RunControlSupervisor> => Effect.sync(() => createRunControlSupervisorRuntime(input));

export const createRunControlSupervisor = (input: CreateRunControlSupervisorInput): RunControlSupervisor =>
  Effect.runSync(createRunControlSupervisorEffect(input));
