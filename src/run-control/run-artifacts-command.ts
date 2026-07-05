import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { Effect, Option } from "effect";

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

const PATH_SEPARATOR_RE = /[\\/]/u;
const WATCH_INTERVAL_MS = 1000;
const SENSITIVE_BASENAME_PARTS = ["prompt", "session"];
const SENSITIVE_BASENAME_PREFIXES = ["body."];
const SENSITIVE_PATH_PARTS = ["session-body", "session_body"];
const SENSITIVE_BASENAMES = new Set(["body"]);

const formatArtifacts = (artifacts: ArtifactSnapshot[]): string => {
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
};

const artifactKey = (artifact: ArtifactSnapshot): string =>
  `${artifact.nodeId}/${artifact.name}`;

const artifactDelta = (
  artifact: ArtifactSnapshot,
  printedLengths: Map<string, number>
): Option.Option<ArtifactSnapshot> => {
  const key = artifactKey(artifact);
  const previousLength = printedLengths.get(key) ?? 0;
  printedLengths.set(key, artifact.content.length);
  if (artifact.content.length <= previousLength) {
    return Option.none();
  }

  return Option.some({
    ...artifact,
    content: artifact.content.slice(previousLength),
  });
};

const logArtifactDeltasEffect = (
  artifacts: ArtifactSnapshot[],
  printedLengths: Map<string, number>
): Effect.Effect<void> => {
  const deltas = artifacts.flatMap((artifact) =>
    Option.match(artifactDelta(artifact, printedLengths), {
      onNone: () => [],
      onSome: (value) => [value],
    })
  );
  return deltas.length === 0 ? Effect.void : logEffect(formatArtifacts(deltas));
};

const artifactLengths = (artifacts: ArtifactSnapshot[]): Map<string, number> =>
  new Map(
    artifacts.map((artifact) => [
      artifactKey(artifact),
      artifact.content.length,
    ])
  );

const isSensitiveArtifactName = (name: string): boolean => {
  const normalized = name.toLowerCase();
  const basename = normalized.split(PATH_SEPARATOR_RE).pop() ?? normalized;
  return [
    SENSITIVE_BASENAME_PARTS.some((part) => basename.includes(part)),
    SENSITIVE_BASENAME_PREFIXES.some((prefix) => basename.startsWith(prefix)),
    SENSITIVE_BASENAMES.has(basename),
    SENSITIVE_PATH_PARTS.some((part) => normalized.includes(part)),
  ].some(Boolean);
};

const shouldFollowArtifacts = (
  flags: LogsFlags,
  run: MokaRunManifest
): boolean => flags.follow === true && isRunActive(run);

const readDirectoryEntriesEffect = (
  current: string
): Effect.Effect<Dirent[], unknown> =>
  Effect.tryPromise({
    catch: (error) => error,
    try: async () => await readdir(current, { withFileTypes: true }),
  }).pipe(
    Effect.catch((error) =>
      isNotFound(error) ? Effect.succeed([]) : Effect.fail(error)
    )
  );

const readArtifactPathsEffect = function readArtifactPathsEffect(
  current: string
): Effect.Effect<string[], unknown> {
  return Effect.gen(function* effectBody() {
    const entries = yield* readDirectoryEntriesEffect(current);
    const paths = yield* Effect.forEach(
      entries.toSorted((left, right) => left.name.localeCompare(right.name)),
      (entry) => {
        const path = join(current, entry.name);
        if (entry.isDirectory()) {
          return readArtifactPathsEffect(path);
        }
        return entry.isFile() ? Effect.succeed([path]) : Effect.succeed([]);
      }
    );

    return paths.flat();
  });
};

const readFileUtf8Effect = (path: string): Effect.Effect<string, unknown> =>
  Effect.tryPromise({
    catch: (error) => error,
    try: async () => await readFile(path, "utf-8"),
  });

const delayEffect = (milliseconds: number): Effect.Effect<void, unknown> =>
  Effect.tryPromise({
    catch: (error) => error,
    try: async () => {
      await delay(milliseconds);
    },
  });

const normalizeRelative = (from: string, path: string): string =>
  relative(from, path).split(sep).join("/");

const readNodeArtifactsEffect = (
  workspaceRoot: string,
  runId: string,
  nodeId: string
): Effect.Effect<ArtifactSnapshot[], unknown> => {
  const nodeRoot = join(
    runPaths(workspaceRoot, parseLogicalSegment("runId", runId)).nodesRoot,
    parseLogicalSegment("nodeId", nodeId)
  );
  return Effect.gen(function* effectBody() {
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
};

const readArtifactsEffect = (
  workspaceRoot: string,
  run: MokaRunManifest,
  nodeId: Option.Option<string> = Option.none()
): Effect.Effect<ArtifactSnapshot[], unknown> =>
  Effect.gen(function* effectBody() {
    const nodeIds = yield* Option.match(nodeId, {
      onNone: () =>
        Effect.succeed(
          Object.keys(run.nodes).toSorted((left, right) =>
            left.localeCompare(right)
          )
        ),
      onSome: (value) =>
        requireKnownNodeEffect(run, value).pipe(Effect.map((id) => [id])),
    });
    const artifacts = yield* Effect.forEach(nodeIds, (id) =>
      readNodeArtifactsEffect(workspaceRoot, run.runId, id)
    );

    return artifacts
      .flat()
      .toSorted((left, right) =>
        `${left.nodeId}/${left.name}`.localeCompare(
          `${right.nodeId}/${right.name}`
        )
      );
  });

const followArtifactsEffect = (
  input: {
    nodeId?: string;
    runId: string;
    store: RunControlStore;
    workspaceRoot: string;
  },
  printedLengths: Map<string, number>
): Effect.Effect<void, unknown> =>
  Effect.gen(function* effectBody() {
    for (;;) {
      yield* delayEffect(WATCH_INTERVAL_MS);
      const latestRun = yield* requireRunEffect(input.store, input.runId);
      const artifacts = yield* readArtifactsEffect(
        input.workspaceRoot,
        latestRun,
        Option.fromNullishOr(input.nodeId)
      );
      yield* logArtifactDeltasEffect(artifacts, printedLengths);

      if (!isRunActive(latestRun)) {
        return;
      }
    }
  });

export const printLogsEffect = (input: {
  flags: LogsFlags;
  nodeId?: string;
  runId: string;
  store: RunControlStore;
  workspaceRoot: string;
}): Effect.Effect<void, unknown> =>
  Effect.gen(function* effectBody() {
    const run = yield* requireRunEffect(input.store, input.runId);
    const artifacts = yield* readArtifactsEffect(
      input.workspaceRoot,
      run,
      Option.fromNullishOr(input.nodeId)
    );
    yield* logEffect(formatArtifacts(artifacts));

    if (!shouldFollowArtifacts(input.flags, run)) {
      return;
    }

    yield* followArtifactsEffect(input, artifactLengths(artifacts));
  });

export const exportSanitizedRunBundleEffect = (input: {
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
> =>
  Effect.gen(function* effectBody() {
    const run = yield* requireRunEffect(input.store, input.runId);
    const artifacts = (yield* readArtifactsEffect(
      input.workspaceRoot,
      run
    )).filter((artifact) => !isSensitiveArtifactName(artifact.name));

    return { artifacts, run, version: 1 };
  });
