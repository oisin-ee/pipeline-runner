import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Effect } from "effect";
import { logEffect } from "./command-context";
import type { MokaRunManifest } from "./contracts";
import { isNotFound } from "./file-errors";
import { parseLogicalSegment } from "./logical-segment";
import { isRunActive, requireKnownNodeEffect } from "./run-command-domain";
import type { RunControlStore } from "./run-control-store";
import { requireRunEffect } from "./run-query-command";
import { runPaths } from "./store-paths";

export interface LogsFlags {
  follow?: boolean;
}

interface ArtifactSnapshot {
  content: string;
  name: string;
  nodeId: string;
  path: string;
}

const PATH_SEPARATOR_RE = /[\\/]/;
const WATCH_INTERVAL_MS = 1000;
const SENSITIVE_BASENAME_PARTS = ["prompt", "session"];
const SENSITIVE_BASENAME_PREFIXES = ["body."];
const SENSITIVE_PATH_PARTS = ["session-body", "session_body"];
const SENSITIVE_BASENAMES = new Set(["body"]);

export function printLogsEffect(input: {
  flags: LogsFlags;
  nodeId?: string;
  runId: string;
  store: RunControlStore;
  workspaceRoot: string;
}): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    const run = yield* requireRunEffect(input.store, input.runId);
    const artifacts = yield* readArtifactsEffect(
      input.workspaceRoot,
      run,
      input.nodeId
    );
    yield* logEffect(formatArtifacts(artifacts));

    if (!shouldFollowArtifacts(input.flags, run)) {
      return;
    }

    yield* followArtifactsEffect(input, artifactLengths(artifacts));
  });
}

export function exportSanitizedRunBundleEffect(input: {
  runId: string;
  store: RunControlStore;
  workspaceRoot: string;
}): Effect.Effect<
  {
    artifacts: ArtifactSnapshot[];
    run: MokaRunManifest;
    version: 1;
  },
  unknown
> {
  return Effect.gen(function* () {
    const run = yield* requireRunEffect(input.store, input.runId);
    const artifacts = (yield* readArtifactsEffect(
      input.workspaceRoot,
      run
    )).filter((artifact) => !isSensitiveArtifactName(artifact.name));

    return { artifacts, run, version: 1 };
  });
}

function readArtifactsEffect(
  workspaceRoot: string,
  run: MokaRunManifest,
  nodeId?: string
): Effect.Effect<ArtifactSnapshot[], unknown> {
  return Effect.gen(function* () {
    const nodeIds = nodeId
      ? [yield* requireKnownNodeEffect(run, nodeId)]
      : Object.keys(run.nodes).sort((left, right) => left.localeCompare(right));
    const artifacts = yield* Effect.forEach(nodeIds, (id) =>
      readNodeArtifactsEffect(workspaceRoot, run.runId, id)
    );

    return artifacts
      .flat()
      .sort((left, right) =>
        `${left.nodeId}/${left.name}`.localeCompare(
          `${right.nodeId}/${right.name}`
        )
      );
  });
}

function readNodeArtifactsEffect(
  workspaceRoot: string,
  runId: string,
  nodeId: string
): Effect.Effect<ArtifactSnapshot[], unknown> {
  const nodeRoot = join(
    runPaths(workspaceRoot, parseLogicalSegment("runId", runId)).nodesRoot,
    parseLogicalSegment("nodeId", nodeId)
  );
  return Effect.gen(function* () {
    const artifactPaths = yield* readArtifactPathsEffect(nodeRoot);

    return yield* Effect.forEach(artifactPaths, (path) =>
      readFileUtf8Effect(path).pipe(
        Effect.map((content) => ({
          content,
          name: normalizeRelative(nodeRoot, path),
          nodeId,
          path: normalizeRelative(workspaceRoot, path),
        }))
      )
    );
  });
}

function readArtifactPathsEffect(
  current: string
): Effect.Effect<string[], unknown> {
  return Effect.gen(function* () {
    const entries = yield* readDirectoryEntriesEffect(current);
    const paths = yield* Effect.forEach(
      entries.sort((left, right) => left.name.localeCompare(right.name)),
      (entry) => artifactPathEffect(current, entry)
    );

    return paths.flat();
  });
}

function artifactPathEffect(
  current: string,
  entry: Dirent
): Effect.Effect<string[], unknown> {
  const path = join(current, entry.name);
  if (entry.isDirectory()) {
    return readArtifactPathsEffect(path);
  }
  return entry.isFile() ? Effect.succeed([path]) : Effect.succeed([]);
}

function artifactDelta(
  artifact: ArtifactSnapshot,
  printedLengths: Map<string, number>
): ArtifactSnapshot | undefined {
  const key = artifactKey(artifact);
  const previousLength = printedLengths.get(key) ?? 0;
  printedLengths.set(key, artifact.content.length);
  if (artifact.content.length <= previousLength) {
    return;
  }

  return {
    ...artifact,
    content: artifact.content.slice(previousLength),
  };
}

function followArtifactsEffect(
  input: {
    nodeId?: string;
    runId: string;
    store: RunControlStore;
    workspaceRoot: string;
  },
  printedLengths: Map<string, number>
): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    for (;;) {
      yield* delayEffect(WATCH_INTERVAL_MS);
      const latestRun = yield* requireRunEffect(input.store, input.runId);
      const artifacts = yield* readArtifactsEffect(
        input.workspaceRoot,
        latestRun,
        input.nodeId
      );
      yield* logArtifactDeltasEffect(artifacts, printedLengths);

      if (!isRunActive(latestRun)) {
        return;
      }
    }
  });
}

function logArtifactDeltasEffect(
  artifacts: ArtifactSnapshot[],
  printedLengths: Map<string, number>
): Effect.Effect<void> {
  const deltas = artifacts.flatMap(
    (artifact) => artifactDelta(artifact, printedLengths) ?? []
  );
  return deltas.length === 0 ? Effect.void : logEffect(formatArtifacts(deltas));
}

function artifactLengths(artifacts: ArtifactSnapshot[]): Map<string, number> {
  return new Map(
    artifacts.map((artifact) => [
      artifactKey(artifact),
      artifact.content.length,
    ])
  );
}

function formatArtifacts(artifacts: ArtifactSnapshot[]): string {
  if (artifacts.length === 0) {
    return "No artifacts found.";
  }

  return artifacts
    .map((artifact) => {
      const content = artifact.content.endsWith("\n")
        ? artifact.content
        : `${artifact.content}\n`;
      return `== ${artifact.nodeId}/${artifact.name} ==\n${content}`;
    })
    .join("\n");
}

function artifactKey(artifact: ArtifactSnapshot): string {
  return `${artifact.nodeId}/${artifact.name}`;
}

function isSensitiveArtifactName(name: string): boolean {
  const normalized = name.toLowerCase();
  const basename = normalized.split(PATH_SEPARATOR_RE).pop() ?? normalized;
  return [
    SENSITIVE_BASENAME_PARTS.some((part) => basename.includes(part)),
    SENSITIVE_BASENAME_PREFIXES.some((prefix) => basename.startsWith(prefix)),
    SENSITIVE_BASENAMES.has(basename),
    SENSITIVE_PATH_PARTS.some((part) => normalized.includes(part)),
  ].some(Boolean);
}

function shouldFollowArtifacts(
  flags: LogsFlags,
  run: MokaRunManifest
): boolean {
  return Boolean(flags.follow && isRunActive(run));
}

function readDirectoryEntriesEffect(
  current: string
): Effect.Effect<Dirent[], unknown> {
  return Effect.tryPromise({
    catch: (error) => error,
    try: () => readdir(current, { withFileTypes: true }),
  }).pipe(
    Effect.catch((error) =>
      isNotFound(error) ? Effect.succeed([]) : Effect.fail(error)
    )
  );
}

function readFileUtf8Effect(path: string): Effect.Effect<string, unknown> {
  return Effect.tryPromise({
    catch: (error) => error,
    try: () => readFile(path, "utf8"),
  });
}

function delayEffect(milliseconds: number): Effect.Effect<void, unknown> {
  return Effect.tryPromise({
    catch: (error) => error,
    try: () => delay(milliseconds),
  });
}

function normalizeRelative(from: string, path: string): string {
  return relative(from, path).split(sep).join("/");
}
