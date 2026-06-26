// fallow-ignore-file unused-export complexity
import { Effect } from "effect";
import type {
  PipelineRuntimeEvent,
  PipelineRuntimeOptions,
} from "../pipeline-runtime";
import {
  DEFAULT_RUN_CONTROL_HEARTBEAT_INTERVAL_MS,
  DEFAULT_RUN_CONTROL_NODE_STALE_AFTER_MS,
  type MokaNodeStatus,
  parseRunControlStaleDetection,
} from "./contracts";
import { fileRunControlStore, type RunControlStore } from "./run-control-store";
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
   * via the `db.url` seam; when omitted it defaults to the filesystem store for
   * `workspaceRoot`, keeping `.pipeline/runs` behaviour byte-identical.
   */
  store?: RunControlStore;
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

const RUNNING_NODE_EVENT_TYPES = new Set<PipelineRuntimeEvent["type"]>([
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
]);

export function createRunControlSupervisor(
  input: CreateRunControlSupervisorInput
): RunControlSupervisor {
  return Effect.runSync(createRunControlSupervisorEffect(input));
}

export function createRunControlSupervisorEffect(
  input: CreateRunControlSupervisorInput
): Effect.Effect<RunControlSupervisor> {
  return Effect.sync(() => createRunControlSupervisorRuntime(input));
}

function createRunControlSupervisorRuntime(
  input: CreateRunControlSupervisorInput
): RunControlSupervisor {
  const now = input.now ?? (() => new Date());
  const staleDetection = parseRunControlStaleDetection({
    heartbeatIntervalMs:
      input.heartbeatIntervalMs ?? DEFAULT_RUN_CONTROL_HEARTBEAT_INTERVAL_MS,
    nodeStaleAfterMs:
      input.nodeStaleAfterMs ?? DEFAULT_RUN_CONTROL_NODE_STALE_AFTER_MS,
  });
  const store = input.store ?? fileRunControlStore(input.workspaceRoot);
  const bridge = createRunStoreRuntimeReporter({
    now,
    reporter: input.reporter,
    runId: input.runId,
    store,
    workspaceRoot: input.workspaceRoot,
  });
  const nodeActivity = new Map<string, NodeActivity>();
  let controlWriteChain: Promise<void> = Promise.resolve();
  let heartbeatTimer: TimerHandle | undefined;
  let runActive = false;
  let stopped = false;

  const controlWriteChainEffect = (): Effect.Effect<void, unknown> =>
    Effect.tryPromise({
      catch: (error) => error,
      try: () => controlWriteChain,
    });

  const enqueueControlWriteEffect = (
    write: Effect.Effect<void, unknown>
  ): Effect.Effect<void> =>
    Effect.sync(() => {
      controlWriteChain = controlWriteChain.then(() =>
        Effect.runPromise(bridge.flushEffect().pipe(Effect.zipRight(write)))
      );
    });

  const enqueueHeartbeatEffect = (): Effect.Effect<void> =>
    Effect.gen(function* () {
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
        })
      );
    });

  const enqueueHeartbeat = (): void => {
    Effect.runSync(enqueueHeartbeatEffect());
  };

  const scheduleStaleTimerEffect = (
    nodeId: string,
    activity: NodeActivity,
    delayMs = staleDetection.nodeStaleAfterMs
  ): Effect.Effect<void> =>
    Effect.sync(() => {
      if (activity.staleTimer) {
        clearTimeout(activity.staleTimer);
      }
      activity.staleTimer = setTimeout(() => markNodeStalled(nodeId), delayMs);
    });

  const markNodeStalledEffect = (nodeId: string): Effect.Effect<void> =>
    Effect.gen(function* () {
      const activity = nodeActivity.get(nodeId);
      if (
        !(activity && runActive && !stopped && activity.status === "running")
      ) {
        return;
      }

      const elapsedMs = now().getTime() - activity.lastActivityMs;
      if (elapsedMs < staleDetection.nodeStaleAfterMs) {
        yield* scheduleStaleTimerEffect(
          nodeId,
          activity,
          staleDetection.nodeStaleAfterMs - elapsedMs
        );
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
        })
      );
    });

  const markNodeStalled = (nodeId: string): void => {
    Effect.runSync(markNodeStalledEffect(nodeId));
  };

  const markNodeRunningEffect = (nodeId: string): Effect.Effect<void> =>
    Effect.gen(function* () {
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
      yield* scheduleStaleTimerEffect(nodeId, activity);

      if (wasStalled) {
        const at = timestamp(now);
        yield* enqueueControlWriteEffect(
          store.updateNodeStatus({
            at,
            nodeId,
            runId: input.runId,
            status: "running",
          })
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
    Effect.forEach([...nodeActivity.keys()], clearNodeEffect).pipe(
      Effect.asVoid
    );

  const observeRuntimeEventEffect = (
    event: PipelineRuntimeEvent
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
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
      if (!nodeId) {
        return;
      }
      if (shouldClearNodeActivity(event)) {
        yield* clearNodeEffect(nodeId);
        return;
      }
      if (shouldMarkNodeRunning(event)) {
        yield* markNodeRunningEffect(nodeId);
      }
    });

  const startEffect = (): Effect.Effect<void> =>
    Effect.sync(() => {
      if (heartbeatTimer || stopped) {
        return;
      }
      heartbeatTimer = setInterval(
        enqueueHeartbeat,
        staleDetection.heartbeatIntervalMs
      );
    });

  const stopEffect = (): Effect.Effect<void, unknown> =>
    Effect.gen(function* () {
      stopped = true;
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = undefined;
      }
      yield* clearAllNodesEffect();
      yield* bridge.flushEffect();
      yield* controlWriteChainEffect();
    });

  const flushEffect = (): Effect.Effect<void, unknown> =>
    Effect.gen(function* () {
      yield* bridge.flushEffect();
      yield* controlWriteChainEffect();
    });

  return {
    flush: () => Effect.runPromise(flushEffect()),
    flushEffect,
    reporter(event) {
      bridge.reporter(event);
      Effect.runSync(observeRuntimeEventEffect(event));
    },
    start() {
      Effect.runSync(startEffect());
    },
    startEffect,
    stop: () => Effect.runPromise(stopEffect()),
    stopEffect,
  };
}

function timestamp(now: () => Date): string {
  return now().toISOString();
}

function nodeIdFromEvent(event: PipelineRuntimeEvent): string | undefined {
  if (!("nodeId" in event)) {
    return;
  }
  return event.nodeId;
}

function shouldClearNodeActivity(event: PipelineRuntimeEvent): boolean {
  switch (event.type) {
    case "node.finish":
      return true;
    case "agent.finish":
      return event.exitCode !== 0;
    case "artifact.check.finish":
    case "hook.finish":
      return event.required && !event.passed;
    case "gate.finish":
      return !event.passed;
    default:
      return false;
  }
}

function shouldMarkNodeRunning(event: PipelineRuntimeEvent): boolean {
  if (RUNNING_NODE_EVENT_TYPES.has(event.type)) {
    return true;
  }
  switch (event.type) {
    case "agent.finish":
      return event.exitCode === 0;
    case "artifact.check.finish":
    case "hook.finish":
      return event.passed || !event.required;
    case "gate.finish":
      return event.passed;
    default:
      return false;
  }
}
