// fallow-ignore-file unused-export complexity code-duplication
import { appendFile, mkdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { Effect } from "effect";
import type {
  PipelineRuntimeEvent,
  PipelineRuntimeOptions,
} from "../pipeline-runtime";
import type { MokaNodeStatus, MokaRunStatus } from "./contracts";
import { fileRunControlStore, type RunControlStore } from "./run-control-store";
import { withRunStateLock } from "./run-state-lock";

type RuntimeReporter = NonNullable<PipelineRuntimeOptions["reporter"]>;

export interface CreateRunStoreRuntimeReporterInput {
  now?: () => Date;
  reporter?: PipelineRuntimeOptions["reporter"];
  runId: string;
  /**
   * The run-control store the run-state writes go through. The program
   * entrypoint resolves it via the `db.url` seam and threads it here; when
   * omitted it defaults to the filesystem store for `workspaceRoot`, keeping the
   * `.pipeline/runs` behaviour byte-identical. Observability artifacts
   * (runtime-events.jsonl, node stdout) are filesystem-only by design and always
   * use `workspaceRoot`.
   */
  store?: RunControlStore;
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

export function createRunStoreRuntimeReporter(
  input: CreateRunStoreRuntimeReporterInput
): RunStoreRuntimeReporter {
  return Effect.runSync(createRunStoreRuntimeReporterEffect(input));
}

export function createRunStoreRuntimeReporterEffect(
  input: CreateRunStoreRuntimeReporterInput
): Effect.Effect<RunStoreRuntimeReporter> {
  return Effect.sync(() => createRunStoreRuntimeReporterRuntime(input));
}

function createRunStoreRuntimeReporterRuntime(
  input: CreateRunStoreRuntimeReporterInput
): RunStoreRuntimeReporter {
  const now = input.now ?? (() => new Date());
  const store = input.store ?? fileRunControlStore(input.workspaceRoot);
  const observedNodeStatuses = new Map<string, MokaNodeStatus>();
  const activeHookPreviousStatuses = new Map<string, MokaNodeStatus>();
  let writeChain: Promise<void> = Promise.resolve();

  const enqueue = (event: PipelineRuntimeEvent): void => {
    const projection = projectRuntimeEvent(event, {
      activeHookPreviousStatuses,
      observedNodeStatuses,
    });
    // Run-control persistence is observability and must never abort the pipeline
    // run: a single event that cannot be recorded (e.g. a session reported by an
    // internal sub-invocation such as the `<node>:handoff` finalizer, which is
    // not a declared run node) is logged and skipped, not propagated into the
    // write chain that flush() rethrows.
    const persisted = persistRuntimeEventEffect(
      input,
      store,
      event,
      projection,
      now
    ).pipe(Effect.catchAll((error) => warnPersistSkipped(input, event, error)));
    writeChain = writeChain.then(() =>
      // Serialize against the builtin run-state hide window: persistence writes
      // under .pipeline/runs/<id>/, which a concurrent lint/fallow builtin
      // temporarily relocates. The lock keeps the two mutually exclusive so a
      // sibling node-status event never observes a missing run directory.
      withRunStateLock(() => Effect.runPromise(persisted))
    );
  };

  const flushEffect = (): Effect.Effect<void, unknown> =>
    Effect.tryPromise({
      catch: (error) => error,
      try: () => writeChain,
    });

  return {
    flush: () => Effect.runPromise(flushEffect()),
    flushEffect,
    reporter(event) {
      enqueue(event);
      input.reporter?.(event);
    },
  };
}

interface ProjectionState {
  activeHookPreviousStatuses: Map<string, MokaNodeStatus>;
  observedNodeStatuses: Map<string, MokaNodeStatus>;
}

interface RuntimeEventProjection {
  node?: {
    nodeId: string;
    status: MokaNodeStatus;
  };
  run?: MokaRunStatus;
  session?: {
    nodeId: string;
    sessionId: string;
  };
}

function persistRuntimeEventEffect(
  input: CreateRunStoreRuntimeReporterInput,
  store: RunControlStore,
  event: PipelineRuntimeEvent,
  projection: RuntimeEventProjection,
  now: () => Date
): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    yield* appendRuntimeEventEffect(input, event);

    if (projection.run) {
      yield* store.updateRunStatus({
        at: timestamp(now),
        runId: input.runId,
        status: projection.run,
      });
    }

    if (projection.node) {
      yield* store.updateNodeStatus({
        at: timestamp(now),
        nodeId: projection.node.nodeId,
        runId: input.runId,
        status: projection.node.status,
      });
    }

    if (projection.session) {
      yield* store.updateNodeSession({
        nodeId: projection.session.nodeId,
        runId: input.runId,
        sessionId: projection.session.sessionId,
      });
    }

    if (event.type === "node.output.recorded") {
      yield* appendNodeStdoutEffect(input, event.nodeId, event);
    }
  });
}

function projectRuntimeEvent(
  event: PipelineRuntimeEvent,
  state: ProjectionState
): RuntimeEventProjection {
  const projection =
    projectRunStatus(event) ??
    projectNodeStatus(event, state) ??
    projectNodeSession(event);

  if (projection?.node) {
    state.observedNodeStatuses.set(
      projection.node.nodeId,
      projection.node.status
    );
  }

  return projection ?? {};
}

function projectNodeSession(
  event: PipelineRuntimeEvent
): RuntimeEventProjection | null {
  if (event.type !== "node.session") {
    return null;
  }

  return {
    session: {
      nodeId: event.nodeId,
      sessionId: event.sessionId,
    },
  };
}

function projectRunStatus(
  event: PipelineRuntimeEvent
): RuntimeEventProjection | null {
  switch (event.type) {
    case "workflow.start":
      return { run: "starting" };
    case "workflow.finish":
      return { run: workflowOutcomeStatus(event.outcome) };
    default:
      return null;
  }
}

function projectNodeStatus(
  event: PipelineRuntimeEvent,
  state: ProjectionState
): RuntimeEventProjection | null {
  switch (event.type) {
    case "node.start":
      return nodeProjection(event.nodeId, "running");
    case "node.finish":
      return nodeProjection(event.nodeId, runtimeNodeStatus(event.status));
    case "agent.start":
      return nodeProjection(event.nodeId, "running");
    case "agent.finish":
      return nodeProjection(event.nodeId, agentFinishStatus(event.exitCode));
    case "gate.start":
      return nodeProjection(event.nodeId, "running");
    case "gate.finish":
      return nodeProjection(event.nodeId, event.passed ? "running" : "blocked");
    case "hook.start":
      return projectHookStart(event, state);
    case "hook.finish":
      return projectHookFinish(event, state);
    default:
      return null;
  }
}

function projectHookStart(
  event: Extract<PipelineRuntimeEvent, { type: "hook.start" }>,
  state: ProjectionState
): RuntimeEventProjection | null {
  if (!event.nodeId) {
    return null;
  }

  const previous = state.observedNodeStatuses.get(event.nodeId);
  if (previous) {
    state.activeHookPreviousStatuses.set(event.hookId, previous);
  }

  return nodeProjection(event.nodeId, "running");
}

function projectHookFinish(
  event: Extract<PipelineRuntimeEvent, { type: "hook.finish" }>,
  state: ProjectionState
): RuntimeEventProjection | null {
  if (!event.nodeId) {
    return null;
  }

  const previousStatus = state.activeHookPreviousStatuses.get(event.hookId);
  state.activeHookPreviousStatuses.delete(event.hookId);

  if (!event.passed && event.required) {
    return nodeProjection(event.nodeId, "blocked");
  }

  return nodeProjection(event.nodeId, previousStatus ?? "running");
}

function nodeProjection(
  nodeId: string,
  status: MokaNodeStatus
): RuntimeEventProjection {
  return {
    node: {
      nodeId,
      status,
    },
  };
}

function workflowOutcomeStatus(
  outcome: Extract<PipelineRuntimeEvent, { type: "workflow.finish" }>["outcome"]
): MokaRunStatus {
  switch (outcome) {
    case "PASS":
      return "passed";
    case "FAIL":
      return "failed";
    case "CANCELLED":
      return "aborted";
    default:
      return assertNever(outcome);
  }
}

function runtimeNodeStatus(
  status: Extract<PipelineRuntimeEvent, { type: "node.finish" }>["status"]
): MokaNodeStatus {
  switch (status) {
    case "failed":
      return "failed";
    case "passed":
      return "passed";
    default:
      return assertNever(status);
  }
}

function agentFinishStatus(exitCode: number): MokaNodeStatus {
  return exitCode === 0 ? "running" : "failed";
}

function appendRuntimeEventEffect(
  input: CreateRunStoreRuntimeReporterInput,
  event: PipelineRuntimeEvent
): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    const runRoot = yield* runDirectoryEffect(input.workspaceRoot, input.runId);
    yield* mkdirEffect(runRoot, { recursive: true });
    yield* appendJsonlEffect(join(runRoot, RUNTIME_EVENTS_FILE), event);
  });
}

function appendNodeStdoutEffect(
  input: CreateRunStoreRuntimeReporterInput,
  nodeId: string,
  event: Extract<PipelineRuntimeEvent, { type: "node.output.recorded" }>
): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    const runRoot = yield* runDirectoryEffect(input.workspaceRoot, input.runId);
    const logicalNodeId = yield* logicalSegmentEffect("nodeId", nodeId);
    const nodeRoot = join(runRoot, NODES_DIRECTORY, logicalNodeId);
    yield* mkdirEffect(nodeRoot, { recursive: true });
    yield* appendJsonlEffect(join(nodeRoot, STDOUT_ARTIFACT), event);
  });
}

function appendJsonlEffect(
  path: string,
  value: unknown
): Effect.Effect<void, unknown> {
  return Effect.tryPromise({
    catch: (error) => error,
    try: () => appendFile(path, `${JSON.stringify(value)}\n`, "utf8"),
  });
}

function mkdirEffect(
  path: string,
  options: Parameters<typeof mkdir>[1]
): Effect.Effect<void, unknown> {
  return Effect.tryPromise({
    catch: (error) => error,
    try: () => mkdir(path, options),
  }).pipe(Effect.asVoid);
}

function runDirectory(workspaceRoot: string, runId: string): string {
  return join(workspaceRoot, RUNS_DIRECTORY, logicalSegment("runId", runId));
}

function runDirectoryEffect(
  workspaceRoot: string,
  runId: string
): Effect.Effect<string, unknown> {
  return Effect.try({
    catch: (error) => error,
    try: () => runDirectory(workspaceRoot, runId),
  });
}

function logicalSegment(label: string, value: string): string {
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
}

function logicalSegmentEffect(
  label: string,
  value: string
): Effect.Effect<string, unknown> {
  return Effect.try({
    catch: (error) => error,
    try: () => logicalSegment(label, value),
  });
}

function timestamp(now: () => Date): string {
  return now().toISOString();
}

function assertNever(value: never): never {
  throw new Error(`Unhandled runtime reporter value: ${String(value)}`);
}

function warnPersistSkipped(
  input: CreateRunStoreRuntimeReporterInput,
  event: PipelineRuntimeEvent,
  error: unknown
): Effect.Effect<void> {
  return Effect.sync(() => {
    const nodeId =
      "nodeId" in event && typeof event.nodeId === "string"
        ? ` node=${event.nodeId}`
        : "";
    process.stderr.write(
      `run-control: skipped persisting ${event.type}${nodeId} for run ${input.runId}: ${errorMessage(error)}\n`
    );
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
