// fallow-ignore-file unused-export complexity code-duplication
import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Command } from "commander";
import { Effect } from "effect";
import { loadMokaDbUrl } from "../moka-global-config";
import { resumeRun } from "../pipeline-runtime";
import type {
  MokaNodeStatus,
  MokaRunManifest,
  MokaRunStatus,
} from "./contracts";
import { registerNextNodeSubcommand } from "./next-node";
import {
  type RunControlStore,
  resolveRunControlStore,
} from "./run-control-store";
import { registerSubmitResultSubcommand } from "./submit-result";

interface StatusFlags {
  json?: boolean;
  watch?: boolean;
}

interface LogsFlags {
  follow?: boolean;
}

interface ExportFlags {
  sanitize?: boolean;
}

interface ArtifactSnapshot {
  content: string;
  name: string;
  nodeId: string;
  path: string;
}

interface RunSortRecord {
  run: MokaRunManifest;
  sortTime: number;
}

const RUNS_DIRECTORY = ".pipeline/runs";
const MANIFEST_FILE = "manifest.json";
const NODES_DIRECTORY = "nodes";
const WATCH_INTERVAL_MS = 1000;
const PATH_SEPARATOR_RE = /[\\/]/;

const ACTIVE_RUN_STATUSES = new Set<MokaRunStatus>([
  "queued",
  "starting",
  "running",
  "stalled",
]);

const ACTIVE_NODE_STATUSES = new Set<MokaNodeStatus>([
  "queued",
  "starting",
  "running",
  "stalled",
]);

export function registerRunControlCommands(program: Command): void {
  program
    .command("runs")
    .description("List known Moka runs, newest first")
    .action(async () => {
      await Effect.runPromise(
        withRunControlStore((store, root) => printRunsEffect(store, root))
      );
    });

  program
    .command("status")
    .description("Show run-control status for a Moka run")
    .argument("[run-id]", "run id to inspect; defaults to latest active run")
    .option("--watch", "poll status until the selected run is no longer active")
    .option("--json", "print machine-readable run status")
    .action(async (runId: string | undefined, flags: StatusFlags) => {
      await Effect.runPromise(
        withRunControlStore((store, root) =>
          printStatusEffect({ flags, runId, store, workspaceRoot: root })
        )
      );
    });

  program
    .command("logs")
    .description("Print whole-run or node-specific run-control artifacts")
    .argument("<run-id>", "run id to inspect")
    .argument("[node-id]", "node id whose artifacts should be printed")
    .option(
      "--follow",
      "continue printing appended artifact content while the run is active"
    )
    .action(
      async (runId: string, nodeId: string | undefined, flags: LogsFlags) => {
        await Effect.runPromise(
          withRunControlStore((store, root) =>
            printLogsEffect({
              flags,
              nodeId,
              runId,
              store,
              workspaceRoot: root,
            })
          )
        );
      }
    );

  program
    .command("stop")
    .description("Mark a Moka run or node as aborted")
    .argument("<run-id>", "run id to stop")
    .argument("[node-id]", "node id to stop without aborting sibling work")
    .action(async (runId: string, nodeId?: string) => {
      await Effect.runPromise(
        withRunControlStore((store) =>
          stopRunOrNodeEffect({
            nodeId,
            runId,
            store,
          }).pipe(Effect.flatMap(logEffect))
        )
      );
    });

  program
    .command("export")
    .description("Print a sanitized portable run evidence bundle")
    .argument("<run-id>", "run id to export")
    .requiredOption(
      "--sanitize",
      "omit prompt and session body text from exported artifacts"
    )
    .action(async (runId: string, flags: ExportFlags) => {
      if (!flags.sanitize) {
        throw new Error("Run exports must be requested with --sanitize.");
      }
      await Effect.runPromise(
        withRunControlStore((store, root) =>
          exportSanitizedRunBundleEffect({
            runId,
            store,
            workspaceRoot: root,
          }).pipe(
            Effect.map((bundle) => JSON.stringify(bundle)),
            Effect.flatMap(logEffect)
          )
        )
      );
    });

  // PIPE-91.6: `moka next node <run-id> --schedule-file <path>` — emit the
  // next ready node envelope from a persisted run without executing it.
  const nextCommand = program
    .command("next")
    .description("Advance a persisted durable run one step");
  registerNextNodeSubcommand(nextCommand);

  // PIPE-91.7: `moka submit-result <run-id> <node-id> --json <payload>` —
  // persist a node's terminal result into the durable run store. A distinct
  // top-level command; `moka submit` already exists for job submission.
  registerSubmitResultSubcommand(program);

  // PIPE-91.8: `moka resume <run-id> <description...>` — rehydrate a persisted
  // run's state from the durable Postgres store and CONTINUE it with the default
  // spawn-and-run executor. Already-passed nodes replay from the journal and are
  // never re-run (the PIPE-91.5 resumeCompleted seed). The task description and
  // workflow selection are re-supplied because they are not persisted in the
  // durable node store; the run id is the durable key.
  registerResumeSubcommand(program);
}

interface ResumeFlags {
  entrypoint?: string;
  workflow?: string;
}

function registerResumeSubcommand(program: Command): void {
  program
    .command("resume")
    .description(
      "Rehydrate a persisted run from the durable store and continue it"
    )
    .argument("<run-id>", "the persisted run id to resume")
    .argument("<description...>", "task description for the remaining nodes")
    .option("--entrypoint <entrypoint>", "entrypoint alias from package config")
    .option("--workflow <workflow>", "workflow id from package config")
    .action(
      async (runId: string, descriptionParts: string[], flags: ResumeFlags) => {
        await resumeRunFromCli(runId, descriptionParts.join(" "), flags);
      }
    );
}

async function resumeRunFromCli(
  runId: string,
  task: string,
  flags: ResumeFlags
): Promise<void> {
  try {
    const result = await resumeRun({
      dbUrl: loadMokaDbUrl(),
      ...(flags.entrypoint ? { entrypoint: flags.entrypoint } : {}),
      runId,
      task,
      worktreePath: workspaceRoot(),
      ...(flags.workflow ? { workflow: flags.workflow } : {}),
    });
    console.log(`Resumed run ${runId}: ${result.outcome}.`);
    if (result.outcome !== "PASS") {
      process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(
      `Failed to resume run ${runId}: ${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exitCode = 1;
  }
}

/**
 * PIPE-91.12: resolve the run-control store (Postgres when `db.url` is set, else
 * the filesystem default) once per command invocation and run the command's
 * effect against it inside a scope, so the Postgres connection is released on
 * completion. With `db.url` absent this is byte-identical to the prior direct
 * filesystem store calls. The workspace root is computed once and threaded so
 * the store and the filesystem-only artifact reads share a single root.
 */
function withRunControlStore<A>(
  use: (
    store: RunControlStore,
    workspaceRoot: string
  ) => Effect.Effect<A, unknown>
): Effect.Effect<A, unknown> {
  const root = workspaceRoot();
  const dbUrl = loadMokaDbUrl();
  return Effect.scoped(
    resolveRunControlStore(dbUrl, root).pipe(
      Effect.flatMap((store) => use(store, root))
    )
  );
}

function printRunsEffect(
  store: RunControlStore,
  workspaceRoot: string
): Effect.Effect<void, unknown> {
  return listRunsNewestFirstEffect(store, workspaceRoot).pipe(
    Effect.map(formatRuns),
    Effect.flatMap(logEffect)
  );
}

export function printStatusEffect(input: {
  flags: StatusFlags;
  runId?: string;
  store: RunControlStore;
  workspaceRoot: string;
}): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    for (;;) {
      const run = yield* resolveStatusRunEffect(
        input.store,
        input.workspaceRoot,
        input.runId
      );
      yield* logEffect(
        input.flags.json ? JSON.stringify(runStatus(run)) : formatRunStatus(run)
      );
      if (!(input.flags.watch && isRunActive(run))) {
        return;
      }
      yield* delayEffect(WATCH_INTERVAL_MS);
    }
  });
}

export function printLogsEffect(input: {
  flags: LogsFlags;
  nodeId?: string;
  runId: string;
  store: RunControlStore;
  workspaceRoot: string;
}): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    const run = yield* requireRunEffect(input.store, input.runId);
    let artifacts = yield* readArtifactsEffect(
      input.workspaceRoot,
      run,
      input.nodeId
    );
    yield* logEffect(formatArtifacts(artifacts));

    if (!(input.flags.follow && isRunActive(run))) {
      return;
    }

    const printedLengths = new Map(
      artifacts.map((artifact) => [
        artifactKey(artifact),
        artifact.content.length,
      ])
    );

    for (;;) {
      yield* delayEffect(WATCH_INTERVAL_MS);
      const latestRun = yield* requireRunEffect(input.store, input.runId);
      artifacts = yield* readArtifactsEffect(
        input.workspaceRoot,
        latestRun,
        input.nodeId
      );
      const deltas = artifacts
        .map((artifact) => artifactDelta(artifact, printedLengths))
        .filter(
          (artifact): artifact is ArtifactSnapshot => artifact !== undefined
        );

      if (deltas.length > 0) {
        yield* logEffect(formatArtifacts(deltas));
      }

      if (!isRunActive(latestRun)) {
        return;
      }
    }
  });
}

export function stopRunOrNodeEffect(input: {
  nodeId?: string;
  runId: string;
  store: RunControlStore;
}): Effect.Effect<string, unknown> {
  return Effect.gen(function* () {
    const run = yield* requireRunEffect(input.store, input.runId);
    const at = new Date().toISOString();

    if (input.nodeId) {
      const nodeId = yield* requireKnownNodeEffect(run, input.nodeId);
      yield* input.store.updateNodeStatus({
        at,
        nodeId,
        runId: run.runId,
        status: "aborted",
      });
      return `Run ${run.runId} node ${nodeId} aborted.`;
    }

    yield* stopControllerProcessEffect(run);
    yield* input.store.updateRunStatus({
      at,
      runId: run.runId,
      status: "aborted",
    });
    for (const [nodeId, status] of Object.entries(run.nodes)) {
      if (!ACTIVE_NODE_STATUSES.has(status)) {
        continue;
      }
      yield* input.store.updateNodeStatus({
        at,
        nodeId,
        runId: run.runId,
        status: "aborted",
      });
    }
    return `Run ${run.runId} aborted.`;
  });
}

export function exportSanitizedRunBundleEffect(input: {
  runId: string;
  store: RunControlStore;
  workspaceRoot: string;
}): Effect.Effect<
  {
    artifacts: Array<{
      content: string;
      name: string;
      nodeId: string;
      path: string;
    }>;
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

    return {
      artifacts: artifacts.map((artifact) => ({
        content: artifact.content,
        name: artifact.name,
        nodeId: artifact.nodeId,
        path: artifact.path,
      })),
      run,
      version: 1 as const,
    };
  });
}

export function listRunsNewestFirstEffect(
  store: RunControlStore,
  workspaceRoot: string
): Effect.Effect<MokaRunManifest[], unknown> {
  return Effect.gen(function* () {
    const runs = yield* store.listRuns();
    const records = yield* Effect.forEach(runs, (run) =>
      runSortTimeEffect(workspaceRoot, run.runId).pipe(
        Effect.map((sortTime) => ({ run, sortTime }))
      )
    );

    return records.sort(compareRunsNewestFirst).map((record) => record.run);
  });
}

function compareRunsNewestFirst(left: RunSortRecord, right: RunSortRecord) {
  const timeOrder = right.sortTime - left.sortTime;
  if (timeOrder !== 0) {
    return timeOrder;
  }
  return right.run.runId.localeCompare(left.run.runId);
}

function runSortTimeEffect(
  workspaceRoot: string,
  runId: string
): Effect.Effect<number, unknown> {
  return Effect.tryPromise({
    catch: (error) => error,
    try: () =>
      stat(
        join(
          workspaceRoot,
          RUNS_DIRECTORY,
          logicalSegment("runId", runId),
          MANIFEST_FILE
        )
      ),
  }).pipe(
    Effect.map((manifest) => manifest.mtimeMs),
    Effect.catchAll((error) =>
      isNotFound(error) ? Effect.succeed(0) : Effect.fail(error)
    )
  );
}

function resolveStatusRunEffect(
  store: RunControlStore,
  workspaceRoot: string,
  runId: string | undefined
): Effect.Effect<MokaRunManifest, unknown> {
  return Effect.gen(function* () {
    if (runId) {
      return yield* requireRunEffect(store, runId);
    }

    const runs = yield* listRunsNewestFirstEffect(store, workspaceRoot);
    const activeRuns = runs.filter(isRunActive);
    if (activeRuns.length === 1) {
      return activeRuns[0];
    }
    if (activeRuns.length > 1) {
      return yield* Effect.fail(
        new Error(formatMultipleActiveRuns(activeRuns))
      );
    }
    if (runs.length === 0) {
      return yield* Effect.fail(new Error("No Moka runs found."));
    }
    return yield* Effect.fail(
      new Error(
        `No active Moka runs found. Latest run is ${runs[0].runId} (${runs[0].status}); pass a run id explicitly.`
      )
    );
  });
}

function requireRunEffect(
  store: RunControlStore,
  runId: string
): Effect.Effect<MokaRunManifest, unknown> {
  return Effect.gen(function* () {
    const run = yield* store.readRun({ runId });
    if (!run) {
      return yield* Effect.fail(new Error(`Run ${runId} does not exist.`));
    }
    return run;
  });
}

function formatRuns(runs: MokaRunManifest[]): string {
  if (runs.length === 0) {
    return "No Moka runs found.";
  }

  return ["RUN ID\tSTATUS\tTARGET\tEFFORT\tMODE\tNODES"]
    .concat(
      runs.map((run) =>
        [
          run.runId,
          run.status,
          run.target,
          run.effort,
          run.mode,
          formatNodeSummary(run.nodes),
        ].join("\t")
      )
    )
    .join("\n");
}

function formatRunStatus(run: MokaRunManifest): string {
  return [
    `Run: ${run.runId}`,
    `Status: ${run.status}`,
    `Active: ${isRunActive(run) ? "yes" : "no"}`,
    `Target: ${run.target}`,
    `Effort: ${run.effort}`,
    `Mode: ${run.mode}`,
    "Nodes:",
    ...Object.entries(run.nodes)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([nodeId, status]) => `- ${nodeId}: ${status}`),
    `Events: ${run.events.length}`,
  ].join("\n");
}

function runStatus(run: MokaRunManifest) {
  return {
    active: isRunActive(run),
    effort: run.effort,
    events: run.events,
    mode: run.mode,
    nodes: run.nodes,
    runId: run.runId,
    status: run.status,
    target: run.target,
  };
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

function formatMultipleActiveRuns(activeRuns: MokaRunManifest[]): string {
  return [
    "Multiple active runs found; pass a run id explicitly:",
    ...activeRuns.map((run) => `- ${run.runId} (${run.status})`),
  ].join("\n");
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
    workspaceRoot,
    RUNS_DIRECTORY,
    logicalSegment("runId", runId),
    NODES_DIRECTORY,
    logicalSegment("nodeId", nodeId)
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
      (entry) => {
        const path = join(current, entry.name);
        if (entry.isDirectory()) {
          return readArtifactPathsEffect(path);
        }
        if (!entry.isFile()) {
          return Effect.succeed([]);
        }
        return Effect.succeed([path]);
      }
    );

    return paths.flat();
  });
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

function artifactKey(artifact: ArtifactSnapshot): string {
  return `${artifact.nodeId}/${artifact.name}`;
}

function formatNodeSummary(nodes: Record<string, MokaNodeStatus>): string {
  const entries = Object.entries(nodes).sort(([left], [right]) =>
    left.localeCompare(right)
  );
  return entries.length === 0
    ? "none"
    : entries.map(([nodeId, status]) => `${nodeId}=${status}`).join(",");
}

function isRunActive(run: MokaRunManifest): boolean {
  return ACTIVE_RUN_STATUSES.has(run.status);
}

function requireKnownNode(run: MokaRunManifest, nodeId: string): string {
  const logicalNodeId = logicalSegment("nodeId", nodeId);
  if (!Object.hasOwn(run.nodes, logicalNodeId)) {
    throw new Error(`Run ${run.runId} does not have node ${logicalNodeId}.`);
  }
  return logicalNodeId;
}

function requireKnownNodeEffect(
  run: MokaRunManifest,
  nodeId: string
): Effect.Effect<string, unknown> {
  return Effect.try({
    catch: (error) => error,
    try: () => requireKnownNode(run, nodeId),
  });
}

function stopControllerProcessEffect(
  run: MokaRunManifest
): Effect.Effect<void, unknown> {
  return Effect.sync(() => {
    const pid = run.controller?.pid;
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

function readDirectoryEntriesEffect(
  current: string
): Effect.Effect<Dirent[], unknown> {
  return Effect.tryPromise({
    catch: (error) => error,
    try: () => readdir(current, { withFileTypes: true }),
  }).pipe(
    Effect.catchAll((error) =>
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

function logEffect(message: string): Effect.Effect<void> {
  return Effect.sync(() => console.log(message));
}

function isSensitiveArtifactName(name: string): boolean {
  const normalized = name.toLowerCase();
  const basename = normalized.split(PATH_SEPARATOR_RE).pop() ?? normalized;
  return (
    basename.includes("prompt") ||
    basename.includes("session") ||
    basename === "body" ||
    basename.startsWith("body.") ||
    normalized.includes("session-body") ||
    normalized.includes("session_body")
  );
}

function workspaceRoot(): string {
  return process.env.PIPELINE_TARGET_PATH ?? process.cwd();
}

function logicalSegment(label: string, value: string): string {
  if (
    value.length === 0 ||
    value.includes("/") ||
    value.includes("\\") ||
    value === "." ||
    value === ".."
  ) {
    throw new Error(`${label} must be a non-empty logical identifier.`);
  }
  return value;
}

function normalizeRelative(from: string, path: string): string {
  return relative(from, path).split(sep).join("/");
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function isNoSuchProcess(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ESRCH"
  );
}
