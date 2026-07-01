import { join } from "node:path";
import { Effect } from "effect";
import {
  type MokaRunControlEvent,
  type MokaRunManifest,
  parseMokaNodeStatus,
  parseMokaRunController,
  parseMokaRunEvent,
  parseMokaRunManifest,
  parseMokaRunStatus,
} from "./contracts";
import { isNotFound } from "./file-errors";
import { logicalSegmentEffect } from "./logical-segment";
import {
  appendFileUtf8Effect,
  ensureRunExistsEffect,
  mkdirEffect,
  readDirectoryEntriesEffect,
  readFileUtf8Effect,
  readOptionalFileEffect,
  writeFileUtf8Effect,
  writeJsonEffect,
} from "./store-fs-effects";
import {
  createRunManifest,
  parseRunStatusFile,
  publishScheduleManifest,
  replayEvents,
  statusFromManifest,
} from "./store-manifest";
import {
  nonEmptyStringEffect,
  normalizeWorkspaceRelative,
  RUNS_DIRECTORY,
  runPaths,
} from "./store-paths";
import type {
  CreateRunInput,
  NodeArtifactReference,
  PublishScheduleInput,
  ReadRunInput,
  RecordEventInput,
  RunStatusFile,
  StoreContext,
  UpdateNodeSessionInput,
  UpdateNodeStatusInput,
  UpdateRunControllerInput,
  UpdateRunStatusInput,
  WriteNodeArtifactInput,
} from "./store-types";
import { ensurePipelineWorkspaceIgnore } from "./workspace";

export function createRunEffect(
  input: CreateRunInput
): Effect.Effect<MokaRunManifest, unknown> {
  return Effect.gen(function* () {
    const { manifest, nodeIds, runId } = yield* Effect.sync(() =>
      createRunManifest(input)
    );
    const paths = runPaths(input.workspaceRoot, runId);

    // Idempotency: if the manifest file already exists return it unchanged so
    // both `moka submit` and `runner-lifecycle workflow.start` can safely call
    // createRun for the same runId without resetting the event log.
    const existingJson = yield* readOptionalFileEffect(paths.manifest);
    if (existingJson !== undefined) {
      return yield* parseManifestJsonEffect(existingJson);
    }

    yield* Effect.sync(() =>
      ensurePipelineWorkspaceIgnore(input.workspaceRoot)
    );
    yield* mkdirEffect(paths.runsRoot, { recursive: true });
    yield* mkdirEffect(paths.runRoot, { recursive: true });
    yield* mkdirEffect(paths.nodesRoot, { recursive: true });
    yield* Effect.forEach(nodeIds, (nodeId) =>
      mkdirEffect(join(paths.nodesRoot, nodeId), { recursive: true })
    );

    yield* writeJsonEffect(paths.manifest, manifest);
    yield* writeJsonEffect(paths.status, statusFromManifest(manifest));
    yield* writeFileUtf8Effect(paths.events, "");

    return manifest;
  });
}

export function updateRunControllerEffect(
  input: UpdateRunControllerInput
): Effect.Effect<MokaRunManifest, unknown> {
  return updateManifestEffect(input, (manifest) =>
    parseMokaRunManifest({
      ...manifest,
      controller: parseMokaRunController(input.controller),
    })
  );
}

export function publishScheduleEffect(
  input: PublishScheduleInput
): Effect.Effect<MokaRunManifest, unknown> {
  return Effect.gen(function* () {
    const runId = yield* logicalSegmentEffect("runId", input.runId);
    yield* updateManifestEffect({ ...input, runId }, (manifest) =>
      publishScheduleManifest({
        manifest,
        nodeIds: input.nodeIds,
        schedule: input.schedule,
      })
    );
    const paths = runPaths(input.workspaceRoot, runId);
    const replayed = yield* readRunEffect({
      runId,
      workspaceRoot: input.workspaceRoot,
    });
    if (!replayed) {
      return yield* Effect.fail(new Error(`Run ${runId} does not exist.`));
    }
    const currentStatus = yield* readStatusEffect(paths.status);
    yield* writeJsonEffect(
      paths.status,
      statusFromManifest(replayed, currentStatus)
    );
    return replayed;
  });
}

function updateManifestEffect(
  input: Pick<UpdateRunControllerInput, "runId" | "workspaceRoot">,
  update: (manifest: MokaRunManifest) => MokaRunManifest
): Effect.Effect<MokaRunManifest, unknown> {
  return Effect.gen(function* () {
    const runId = yield* logicalSegmentEffect("runId", input.runId);
    const paths = runPaths(input.workspaceRoot, runId);
    yield* ensureRunExistsEffect(paths.manifest, runId);
    const manifest = yield* readManifestEffect(paths.manifest);
    const updated = yield* Effect.try({
      catch: (error) => error,
      try: () => update(manifest),
    });
    yield* writeJsonEffect(paths.manifest, updated);
    return updated;
  });
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

export function updateNodeStatusEffect(
  input: UpdateNodeStatusInput
): Effect.Effect<void, unknown> {
  return recordEventEffect({
    event: {
      at: input.at,
      nodeId: input.nodeId,
      status: parseMokaNodeStatus(input.status),
      type: "node.status",
    },
    runId: input.runId,
    workspaceRoot: input.workspaceRoot,
  });
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

    const manifest = yield* parseManifestJsonEffect(manifestJson);
    const events = yield* readEventsEffect(paths.events);

    return replayEvents(manifest, events);
  });
}

export function listRunsEffect(
  input: StoreContext
): Effect.Effect<MokaRunManifest[], unknown> {
  return Effect.gen(function* () {
    const entries = yield* readRunDirectoryEntriesEffect(input.workspaceRoot);
    const runs = yield* Effect.forEach(entries, (entry) =>
      readRunEffect({
        runId: entry.name,
        workspaceRoot: input.workspaceRoot,
      })
    );

    return runs.filter((run): run is MokaRunManifest => run !== undefined);
  });
}

function readRunDirectoryEntriesEffect(
  workspaceRoot: string
): Effect.Effect<Array<{ name: string }>, unknown> {
  return readDirectoryEntriesEffect(join(workspaceRoot, RUNS_DIRECTORY)).pipe(
    Effect.map((entries) =>
      entries
        .filter((entry) => entry.isDirectory())
        .sort((left, right) => left.name.localeCompare(right.name))
        .map((entry) => ({ name: entry.name }))
    ),
    Effect.catch((error) =>
      isNotFound(error) ? Effect.succeed([]) : Effect.fail(error)
    )
  );
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

function readManifestEffect(
  path: string
): Effect.Effect<MokaRunManifest, unknown> {
  return readFileUtf8Effect(path).pipe(Effect.flatMap(parseManifestJsonEffect));
}

function parseManifestJsonEffect(
  manifestJson: string
): Effect.Effect<MokaRunManifest, unknown> {
  return Effect.try({
    catch: (error) => error,
    try: () => parseMokaRunManifest(JSON.parse(manifestJson)),
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
      try: () => parseRunStatusFile(JSON.parse(statusJson)),
    });
  });
}
