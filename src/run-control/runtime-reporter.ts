// fallow-ignore-file unused-export complexity code-duplication
import { appendFile, mkdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import { Effect } from "effect";

import type {
  PipelineRuntimeEvent,
  PipelineRuntimeOptions,
} from "../pipeline-runtime";
import { createSerializedWriteQueue } from "../serialized-write-queue";
import type { RunControlStore } from "./run-control-store";
import { withRunStateLock } from "./run-state-lock";
import {
  createRuntimeEventProjectionState,
  projectRuntimeEvent,
} from "./runtime-event-projection";
import type { RuntimeEventStoreWriteIntent } from "./runtime-event-projection";

type RuntimeReporter = NonNullable<PipelineRuntimeOptions["reporter"]>;

export interface CreateRunStoreRuntimeReporterInput {
  now?: () => Date;
  reporter?: PipelineRuntimeOptions["reporter"];
  runId: string;
  /**
   * The run-control store the run-state writes go through. The program
   * entrypoint resolves it via the `db.url` seam and threads it here.
   * Observability artifacts (runtime-events.jsonl, node stdout) are
   * filesystem-only by design and always use `workspaceRoot`.
   */
  store: RunControlStore;
  workspaceRoot: string;
}

export interface RunStoreRuntimeReporter {
  flush: () => Promise<void>;
  flushEffect: () => Effect.Effect<void, unknown>;
  reporter: RuntimeReporter;
}

const RUNS_DIRECTORY = ".pipeline/runs";
const RUNTIME_EVENTS_FILE = "runtime-events.jsonl";
const NODES_DIRECTORY = "nodes";
const STDOUT_ARTIFACT = "stdout.jsonl";

const writesFilesystemRunState = (
  store: RunControlStore,
  runId: string
): boolean =>
  store.statusPaths({ runId }).manifest.startsWith(`${RUNS_DIRECTORY}/`);

const appendJsonlEffect = (
  path: string,
  value: unknown
): Effect.Effect<void, unknown> =>
  Effect.tryPromise({
    catch: (error) => error,
    try: async () => {
      await appendFile(path, `${JSON.stringify(value)}\n`, "utf-8");
    },
  });

const mkdirEffect = (
  path: string,
  options: Parameters<typeof mkdir>[1]
): Effect.Effect<void, unknown> =>
  Effect.tryPromise({
    catch: (error) => error,
    try: async () => await mkdir(path, options),
  }).pipe(Effect.asVoid);

const logicalSegment = (label: string, value: string): string => {
  if (
    value.length === 0 ||
    isAbsolute(value) ||
    value.includes("/") ||
    value.includes("\\") ||
    value === "." ||
    value === ".."
  ) {
    throw new Error(`${label} must be a non-empty logical identifier.`);
  }

  return value;
};

const runDirectory = (workspaceRoot: string, runId: string): string =>
  join(workspaceRoot, RUNS_DIRECTORY, logicalSegment("runId", runId));

const runDirectoryEffect = (
  workspaceRoot: string,
  runId: string
): Effect.Effect<string, unknown> =>
  Effect.try({
    catch: (error) => error,
    try: () => runDirectory(workspaceRoot, runId),
  });

const appendRuntimeEventEffect = (
  input: CreateRunStoreRuntimeReporterInput,
  event: PipelineRuntimeEvent
): Effect.Effect<void, unknown> =>
  Effect.gen(function* effectBody() {
    const runRoot = yield* runDirectoryEffect(input.workspaceRoot, input.runId);
    yield* mkdirEffect(runRoot, { recursive: true });
    yield* appendJsonlEffect(join(runRoot, RUNTIME_EVENTS_FILE), event);
  });

const logicalSegmentEffect = (
  label: string,
  value: string
): Effect.Effect<string, unknown> =>
  Effect.try({
    catch: (error) => error,
    try: () => logicalSegment(label, value),
  });

const appendNodeStdoutEffect = (
  input: CreateRunStoreRuntimeReporterInput,
  nodeId: string,
  event: Extract<PipelineRuntimeEvent, { type: "node.output.recorded" }>
): Effect.Effect<void, unknown> =>
  Effect.gen(function* effectBody() {
    const runRoot = yield* runDirectoryEffect(input.workspaceRoot, input.runId);
    const logicalNodeId = yield* logicalSegmentEffect("nodeId", nodeId);
    const nodeRoot = join(runRoot, NODES_DIRECTORY, logicalNodeId);
    yield* mkdirEffect(nodeRoot, { recursive: true });
    yield* appendJsonlEffect(join(nodeRoot, STDOUT_ARTIFACT), event);
  });

const timestamp = (now: () => Date): string => now().toISOString();

const assertNever = (value: never): never => {
  throw new Error(`Unhandled runtime reporter value: ${String(value)}`);
};

const persistStoreWriteIntentEffect = (
  input: CreateRunStoreRuntimeReporterInput,
  store: RunControlStore,
  writeIntent: RuntimeEventStoreWriteIntent,
  now: () => Date
): Effect.Effect<void, unknown> => {
  switch (writeIntent.type) {
    case "node.session": {
      return store.updateNodeSession({
        nodeId: writeIntent.nodeId,
        runId: input.runId,
        sessionId: writeIntent.sessionId,
      });
    }
    case "node.status": {
      return store.updateNodeStatus({
        at: timestamp(now),
        nodeId: writeIntent.nodeId,
        runId: input.runId,
        status: writeIntent.status,
      });
    }
    case "run.status": {
      return store.updateRunStatus({
        at: timestamp(now),
        runId: input.runId,
        status: writeIntent.status,
      });
    }
    default: {
      return assertNever(writeIntent);
    }
  }
};

const persistRuntimeEventEffect = (
  input: CreateRunStoreRuntimeReporterInput,
  store: RunControlStore,
  event: PipelineRuntimeEvent,
  writeIntents: RuntimeEventStoreWriteIntent[],
  now: () => Date
): Effect.Effect<void, unknown> =>
  Effect.gen(function* effectBody() {
    const writesFilesystemObservability = writesFilesystemRunState(
      store,
      input.runId
    );

    if (writesFilesystemObservability) {
      yield* appendRuntimeEventEffect(input, event);
    }

    for (const writeIntent of writeIntents) {
      yield* persistStoreWriteIntentEffect(input, store, writeIntent, now);
    }

    if (
      writesFilesystemObservability &&
      event.type === "node.output.recorded"
    ) {
      yield* appendNodeStdoutEffect(input, event.nodeId, event);
    }
  });

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const warnPersistSkipped = (
  input: CreateRunStoreRuntimeReporterInput,
  event: PipelineRuntimeEvent,
  error: unknown
): Effect.Effect<void> =>
  Effect.sync(() => {
    const nodeId =
      "nodeId" in event && typeof event.nodeId === "string"
        ? ` node=${event.nodeId}`
        : "";
    process.stderr.write(
      `run-control: skipped persisting ${event.type}${nodeId} for run ${input.runId}: ${errorMessage(error)}\n`
    );
  });

const createRunStoreRuntimeReporterRuntime = (
  input: CreateRunStoreRuntimeReporterInput
): RunStoreRuntimeReporter => {
  const now = input.now ?? (() => new Date());
  const { store } = input;
  let projectionState = createRuntimeEventProjectionState();
  const writes = createSerializedWriteQueue();

  const enqueue = (event: PipelineRuntimeEvent): void => {
    const projection = projectRuntimeEvent(event, projectionState);
    projectionState = projection.state;
    // Run-control persistence is observability and must never abort the pipeline
    // run: a single event that cannot be recorded (e.g. a session reported by an
    // internal sub-invocation such as the `<node>:handoff` finalizer, which is
    // not a declared run node) is logged and skipped, not propagated into the
    // write chain that flush() rethrows.
    const persisted = persistRuntimeEventEffect(
      input,
      store,
      event,
      projection.writes,
      now
    ).pipe(Effect.catch((error) => warnPersistSkipped(input, event, error)));
    writes.enqueue(async () => {
      // Serialize against the builtin run-state hide window: persistence writes
      // under .pipeline/runs/<id>/, which a concurrent lint/fallow builtin
      // temporarily relocates. The lock keeps the two mutually exclusive so a
      // sibling node-status event never observes a missing run directory.
      await withRunStateLock(async () => {
        await Effect.runPromise(persisted);
      });
    });
  };

  const flushEffect = (): Effect.Effect<void, unknown> =>
    Effect.tryPromise({
      catch: (error) => error,
      try: async () => {
        await writes.flush();
      },
    });

  return {
    flush: async () => {
      await Effect.runPromise(flushEffect());
    },
    flushEffect,
    reporter(event) {
      enqueue(event);
      input.reporter?.(event);
    },
  };
};

export const createRunStoreRuntimeReporterEffect = (
  input: CreateRunStoreRuntimeReporterInput
): Effect.Effect<RunStoreRuntimeReporter> =>
  Effect.sync(() => createRunStoreRuntimeReporterRuntime(input));

export const createRunStoreRuntimeReporter = (
  input: CreateRunStoreRuntimeReporterInput
): RunStoreRuntimeReporter =>
  Effect.runSync(createRunStoreRuntimeReporterEffect(input));
