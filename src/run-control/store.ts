// fallow-ignore-file unused-export complexity code-duplication
import type { Dirent } from "node:fs";
import {
  appendFile,
  mkdir,
  readdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { Effect } from "effect";
import {
  DEFAULT_RUN_CONTROL_STALE_DETECTION,
  type MokaNodeStatus,
  type MokaRunControlEvent,
  type MokaRunController,
  type MokaRunEvent,
  type MokaRunManifest,
  type MokaRunStatus,
  parseMokaNodeStatus,
  parseMokaRunController,
  parseMokaRunEvent,
  parseMokaRunManifest,
  parseMokaRunStatus,
  parseRunControlStaleDetection,
  parseRunEffort,
  parseRunMode,
  parseRunTarget,
  type RunControlStaleDetection,
  type RunEffort,
  type RunMode,
  type RunTarget,
} from "./contracts";
import { ensurePipelineWorkspaceIgnore } from "./workspace";

interface StoreContext {
  workspaceRoot: string;
}

export interface CreateRunInput extends StoreContext {
  effort: RunEffort;
  mode: RunMode;
  nodeIds: string[];
  runId: string;
  staleDetection?: RunControlStaleDetection;
  target: RunTarget;
}

export interface ReadRunInput extends StoreContext {
  runId: string;
}

export interface RunControlStatusPaths {
  events: string;
  manifest: string;
  status: string;
}

export interface RecordEventInput extends StoreContext {
  event: MokaRunControlEvent;
  runId: string;
}

export interface UpdateRunControllerInput extends StoreContext {
  controller: MokaRunController;
  runId: string;
}

export interface UpdateRunStatusInput extends StoreContext {
  at: string;
  runId: string;
  status: MokaRunStatus;
}

export interface UpdateNodeStatusInput extends StoreContext {
  at: string;
  nodeId: string;
  runId: string;
  status: MokaNodeStatus;
}

export interface UpdateNodeSessionInput extends StoreContext {
  nodeId: string;
  runId: string;
  sessionId: string;
}

export interface WriteNodeArtifactInput extends StoreContext {
  content: string;
  contentType?: string;
  name: string;
  nodeId: string;
  runId: string;
}

export interface NodeArtifactReference {
  path: string;
}

interface RunStatusFile {
  nodes: Record<string, RunStatusNode>;
  status: MokaRunStatus;
}

type RunStatusNode =
  | MokaNodeStatus
  | {
      sessionId?: string;
      status: MokaNodeStatus;
    };

const RUNS_DIRECTORY = ".pipeline/runs";
const MANIFEST_FILE = "manifest.json";
const STATUS_FILE = "status.json";
const EVENTS_FILE = "events.jsonl";
const NODES_DIRECTORY = "nodes";

export function createRun(input: CreateRunInput): Promise<MokaRunManifest> {
  return Effect.runPromise(createRunEffect(input));
}

export function createRunEffect(
  input: CreateRunInput
): Effect.Effect<MokaRunManifest, unknown> {
  return Effect.gen(function* () {
    const { manifest, nodeIds, runId } = yield* Effect.sync(() =>
      createRunManifest(input)
    );
    const paths = runPaths(input.workspaceRoot, runId);

    yield* Effect.sync(() =>
      ensurePipelineWorkspaceIgnore(input.workspaceRoot)
    );
    yield* mkdirEffect(paths.runsRoot, { recursive: true });
    yield* mkdirEffect(paths.runRoot, { recursive: true });
    yield* mkdirEffect(paths.nodesRoot, { recursive: true });

    for (const nodeId of nodeIds) {
      yield* mkdirEffect(join(paths.nodesRoot, nodeId), { recursive: true });
    }

    yield* writeJsonEffect(paths.manifest, manifest);
    yield* writeJsonEffect(paths.status, statusFromManifest(manifest));
    yield* writeFileUtf8Effect(paths.events, "");

    return manifest;
  });
}

export function updateRunController(
  input: UpdateRunControllerInput
): Promise<MokaRunManifest> {
  return Effect.runPromise(updateRunControllerEffect(input));
}

export function updateRunControllerEffect(
  input: UpdateRunControllerInput
): Effect.Effect<MokaRunManifest, unknown> {
  return Effect.gen(function* () {
    const runId = yield* logicalSegmentEffect("runId", input.runId);
    const paths = runPaths(input.workspaceRoot, runId);
    yield* ensureRunExistsEffect(paths.manifest, runId);
    const manifest = yield* readManifestEffect(paths.manifest);
    const updated = yield* Effect.sync(() =>
      parseMokaRunManifest({
        ...manifest,
        controller: parseMokaRunController(input.controller),
      })
    );
    yield* writeJsonEffect(paths.manifest, updated);
    return updated;
  });
}

export function runControlStatusPaths(
  input: ReadRunInput
): RunControlStatusPaths {
  return runStatusPaths(parseLogicalSegment("runId", input.runId));
}

export function recordEvent(input: RecordEventInput): Promise<void> {
  return Effect.runPromise(recordEventEffect(input));
}

export function recordEventEffect(
  input: RecordEventInput
): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    const runId = yield* logicalSegmentEffect("runId", input.runId);
    const event = yield* Effect.sync(() => parseMokaRunEvent(input.event));
    const paths = runPaths(input.workspaceRoot, runId);

    yield* ensureRunExistsEffect(paths.manifest, runId);
    yield* appendFileUtf8Effect(paths.events, `${JSON.stringify(event)}\n`);
    const run = yield* readRunEffect({
      runId,
      workspaceRoot: input.workspaceRoot,
    });

    if (!run) {
      return yield* Effect.fail(new Error(`Run ${runId} does not exist.`));
    }

    const currentStatus = yield* readStatusEffect(paths.status);
    yield* writeJsonEffect(
      paths.status,
      statusFromManifest(run, currentStatus)
    );
  });
}

export function updateRunStatus(input: UpdateRunStatusInput): Promise<void> {
  return Effect.runPromise(updateRunStatusEffect(input));
}

export function updateRunStatusEffect(
  input: UpdateRunStatusInput
): Effect.Effect<void, unknown> {
  return recordEventEffect({
    event: {
      at: input.at,
      status: parseMokaRunStatus(input.status),
      type: "run.status",
    },
    runId: input.runId,
    workspaceRoot: input.workspaceRoot,
  });
}

export function updateNodeStatus(input: UpdateNodeStatusInput): Promise<void> {
  return Effect.runPromise(updateNodeStatusEffect(input));
}

export function updateNodeStatusEffect(
  input: UpdateNodeStatusInput
): Effect.Effect<void, unknown> {
  return recordEventEffect({
    event: {
      at: input.at,
      nodeId: parseLogicalSegment("nodeId", input.nodeId),
      status: parseMokaNodeStatus(input.status),
      type: "node.status",
    },
    runId: input.runId,
    workspaceRoot: input.workspaceRoot,
  });
}

export function updateNodeSession(
  input: UpdateNodeSessionInput
): Promise<void> {
  return Effect.runPromise(updateNodeSessionEffect(input));
}

export function updateNodeSessionEffect(
  input: UpdateNodeSessionInput
): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    const runId = yield* logicalSegmentEffect("runId", input.runId);
    const nodeId = yield* logicalSegmentEffect("nodeId", input.nodeId);
    const sessionId = yield* nonEmptyStringEffect("sessionId", input.sessionId);
    const paths = runPaths(input.workspaceRoot, runId);

    yield* ensureRunExistsEffect(paths.manifest, runId);
    const run = yield* readRunEffect({
      runId,
      workspaceRoot: input.workspaceRoot,
    });

    if (!run) {
      return yield* Effect.fail(new Error(`Run ${runId} does not exist.`));
    }
    if (!(nodeId in run.nodes)) {
      return yield* Effect.fail(
        new Error(`Node ${nodeId} does not exist in run ${runId}.`)
      );
    }

    const currentStatus = yield* readStatusEffect(paths.status);
    const nextStatus = statusFromManifest(run, currentStatus);
    nextStatus.nodes[nodeId] = {
      sessionId,
      status: run.nodes[nodeId],
    };
    yield* writeJsonEffect(paths.status, nextStatus);
  });
}

export function writeNodeArtifact(
  input: WriteNodeArtifactInput
): Promise<NodeArtifactReference> {
  return Effect.runPromise(writeNodeArtifactEffect(input));
}

export function writeNodeArtifactEffect(
  input: WriteNodeArtifactInput
): Effect.Effect<NodeArtifactReference, unknown> {
  return Effect.gen(function* () {
    const runId = yield* logicalSegmentEffect("runId", input.runId);
    const nodeId = yield* logicalSegmentEffect("nodeId", input.nodeId);
    const name = yield* logicalSegmentEffect("artifact name", input.name);
    const paths = runPaths(input.workspaceRoot, runId);
    const nodeRoot = join(paths.nodesRoot, nodeId);

    yield* ensureRunExistsEffect(paths.manifest, runId);
    yield* mkdirEffect(nodeRoot, { recursive: true });
    const artifactPath = join(nodeRoot, name);
    yield* writeFileUtf8Effect(artifactPath, input.content);

    return {
      path: normalizeWorkspaceRelative(input.workspaceRoot, artifactPath),
    };
  });
}

export function readRun(
  input: ReadRunInput
): Promise<MokaRunManifest | undefined> {
  return Effect.runPromise(readRunEffect(input));
}

export function readRunEffect(
  input: ReadRunInput
): Effect.Effect<MokaRunManifest | undefined, unknown> {
  return Effect.gen(function* () {
    const runId = yield* logicalSegmentEffect("runId", input.runId);
    const paths = runPaths(input.workspaceRoot, runId);
    const manifestJson = yield* readOptionalFileEffect(paths.manifest);

    if (manifestJson === undefined) {
      return;
    }

    const manifest = yield* Effect.sync(() =>
      parseMokaRunManifest(JSON.parse(manifestJson))
    );
    const events = yield* readEventsEffect(paths.events);

    return replayEvents(manifest, events);
  });
}

export function listRuns(input: StoreContext): Promise<MokaRunManifest[]> {
  return Effect.runPromise(listRunsEffect(input));
}

export function listRunsEffect(
  input: StoreContext
): Effect.Effect<MokaRunManifest[], unknown> {
  return Effect.gen(function* () {
    const runsRoot = join(input.workspaceRoot, RUNS_DIRECTORY);
    const entries = yield* readRunDirectoryEntriesEffect(runsRoot);
    const runs: Array<MokaRunManifest | undefined> = [];

    for (const entry of entries) {
      runs.push(
        yield* readRunEffect({
          runId: entry.name,
          workspaceRoot: input.workspaceRoot,
        })
      );
    }

    return runs.filter((run): run is MokaRunManifest => run !== undefined);
  });
}

function createRunManifest(input: CreateRunInput): {
  manifest: MokaRunManifest;
  nodeIds: string[];
  runId: string;
} {
  const runId = parseLogicalSegment("runId", input.runId);
  const nodeIds = input.nodeIds.map((nodeId) =>
    parseLogicalSegment("nodeId", nodeId)
  );
  const nodes = Object.fromEntries(
    nodeIds.map((nodeId) => [nodeId, "queued" as const])
  );
  const manifest = parseMokaRunManifest({
    effort: parseRunEffort(input.effort),
    events: [],
    mode: parseRunMode(input.mode),
    nodes,
    runId,
    staleDetection: parseRunControlStaleDetection(
      input.staleDetection ?? DEFAULT_RUN_CONTROL_STALE_DETECTION
    ),
    status: "queued",
    target: parseRunTarget(input.target),
  });

  return { manifest, nodeIds, runId };
}

function runPaths(workspaceRoot: string, runId: string) {
  const runsRoot = join(workspaceRoot, RUNS_DIRECTORY);
  const runRoot = join(runsRoot, runId);

  return {
    events: join(runRoot, EVENTS_FILE),
    manifest: join(runRoot, MANIFEST_FILE),
    nodesRoot: join(runRoot, NODES_DIRECTORY),
    runRoot,
    runsRoot,
    status: join(runRoot, STATUS_FILE),
  };
}

function runStatusPaths(runId: string): RunControlStatusPaths {
  const runRoot = `${RUNS_DIRECTORY}/${runId}`;
  return {
    events: `${runRoot}/${EVENTS_FILE}`,
    manifest: `${runRoot}/${MANIFEST_FILE}`,
    status: `${runRoot}/${STATUS_FILE}`,
  };
}

function replayEvents(
  manifest: MokaRunManifest,
  events: MokaRunControlEvent[]
): MokaRunManifest {
  const statusEvents = events.filter(
    (event): event is MokaRunEvent => event.type !== "run.heartbeat"
  );
  const rebuilt: MokaRunManifest = {
    ...manifest,
    events: statusEvents,
    nodes: { ...manifest.nodes },
  };

  for (const event of events) {
    switch (event.type) {
      case "run.heartbeat":
        break;
      case "run.status":
        rebuilt.status = event.status;
        break;
      case "node.status":
        rebuilt.nodes[event.nodeId] = event.status;
        break;
      default:
        assertNever(event);
    }
  }

  return parseMokaRunManifest(rebuilt);
}

function readEventsEffect(
  eventsPath: string
): Effect.Effect<MokaRunControlEvent[], unknown> {
  return Effect.gen(function* () {
    const eventLog = yield* readOptionalFileEffect(eventsPath);

    if (eventLog === undefined) {
      return [];
    }

    return yield* Effect.try({
      catch: (error) => error,
      try: () =>
        eventLog
          .split("\n")
          .filter((line) => line.trim().length > 0)
          .map((line) => parseMokaRunEvent(JSON.parse(line))),
    });
  });
}

function readRunDirectoryEntriesEffect(
  runsRoot: string
): Effect.Effect<Dirent[], unknown> {
  return Effect.tryPromise({
    catch: (error) => error,
    try: () => readdir(runsRoot, { withFileTypes: true }),
  }).pipe(
    Effect.map((entries) =>
      entries
        .filter((entry) => entry.isDirectory())
        .sort((left, right) => left.name.localeCompare(right.name))
    ),
    Effect.catch((error) =>
      isNotFound(error) ? Effect.succeed([]) : Effect.fail(error)
    )
  );
}

function readOptionalFileEffect(
  path: string
): Effect.Effect<string | undefined, unknown> {
  return Effect.tryPromise({
    catch: (error) => error,
    try: () => readFile(path, "utf8"),
  }).pipe(
    Effect.catch((error) =>
      isNotFound(error) ? Effect.succeed(undefined) : Effect.fail(error)
    )
  );
}

function ensureRunExistsEffect(
  manifestPath: string,
  runId: string
): Effect.Effect<void, unknown> {
  return Effect.tryPromise({
    catch: (error) => error,
    try: () => stat(manifestPath),
  }).pipe(
    Effect.asVoid,
    Effect.catch((error) =>
      isNotFound(error)
        ? Effect.fail(new Error(`Run ${runId} does not exist.`))
        : Effect.fail(error)
    )
  );
}

function readManifestEffect(
  path: string
): Effect.Effect<MokaRunManifest, unknown> {
  return Effect.gen(function* () {
    const manifestJson = yield* readFileUtf8Effect(path);
    return yield* Effect.try({
      catch: (error) => error,
      try: () => parseMokaRunManifest(JSON.parse(manifestJson)),
    });
  });
}

function readStatusEffect(
  path: string
): Effect.Effect<RunStatusFile | undefined, unknown> {
  return Effect.gen(function* () {
    const statusJson = yield* readOptionalFileEffect(path);

    if (statusJson === undefined) {
      return;
    }

    return yield* Effect.try({
      catch: (error) => error,
      try: () => JSON.parse(statusJson) as RunStatusFile,
    });
  });
}

function writeJsonEffect(
  path: string,
  value: unknown
): Effect.Effect<void, unknown> {
  return writeFileUtf8Effect(path, `${JSON.stringify(value, null, 2)}\n`);
}

function readFileUtf8Effect(path: string): Effect.Effect<string, unknown> {
  return Effect.tryPromise({
    catch: (error) => error,
    try: () => readFile(path, "utf8"),
  });
}

function writeFileUtf8Effect(
  path: string,
  content: string
): Effect.Effect<void, unknown> {
  return Effect.tryPromise({
    catch: (error) => error,
    try: () => writeFile(path, content, "utf8"),
  });
}

function appendFileUtf8Effect(
  path: string,
  content: string
): Effect.Effect<void, unknown> {
  return Effect.tryPromise({
    catch: (error) => error,
    try: () => appendFile(path, content, "utf8"),
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

function logicalSegmentEffect(
  label: string,
  value: string
): Effect.Effect<string, unknown> {
  return Effect.try({
    catch: (error) => error,
    try: () => parseLogicalSegment(label, value),
  });
}

function nonEmptyStringEffect(
  label: string,
  value: string
): Effect.Effect<string, unknown> {
  return Effect.try({
    catch: (error) => error,
    try: () => parseNonEmptyString(label, value),
  });
}

function statusFromManifest(
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
  if (typeof node !== "object" || node === null) {
    return;
  }
  return typeof node.sessionId === "string" && node.sessionId.length > 0
    ? node.sessionId
    : undefined;
}

function parseLogicalSegment(label: string, value: string): string {
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

function parseNonEmptyString(label: string, value: string): string {
  if (value.length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }

  return value;
}

function normalizeWorkspaceRelative(
  workspaceRoot: string,
  path: string
): string {
  return relative(workspaceRoot, path).split(sep).join("/");
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function assertNever(value: never): never {
  throw new Error(`Unhandled run-control event: ${JSON.stringify(value)}`);
}
