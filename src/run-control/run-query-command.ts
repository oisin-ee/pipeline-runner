import { stat } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { Effect } from "effect";
import { logEffect } from "./command-context";
import type { MokaNodeStatus, MokaRunManifest } from "./contracts";
import { isNotFound } from "./file-errors";
import { parseLogicalSegment } from "./logical-segment";
import { isRunActive } from "./run-command-domain";
import type { RunControlStore } from "./run-control-store";
import { runPaths } from "./store-paths";

export interface StatusFlags {
  json?: boolean;
  watch?: boolean;
}

interface RunSortRecord {
  run: MokaRunManifest;
  sortTime: number;
}

const WATCH_INTERVAL_MS = 1000;
const STATUS_RUN_SELECTIONS = [
  {
    error: (_runs: MokaRunManifest[], activeRuns: MokaRunManifest[]) =>
      formatMultipleActiveRuns(activeRuns),
    matches: (_runs: MokaRunManifest[], activeRuns: MokaRunManifest[]) =>
      activeRuns.length > 1,
  },
  {
    error: () => "No Moka runs found.",
    matches: (runs: MokaRunManifest[]) => runs.length === 0,
  },
] as const;

export function printRunsEffect(
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
  return resolveStatusRunEffect(
    input.store,
    input.workspaceRoot,
    input.runId
  ).pipe(
    Effect.flatMap((run) =>
      logStatusEffect(input.flags, run).pipe(
        Effect.andThen(continueStatusWatchEffect(input, run))
      )
    )
  );
}

export function requireRunEffect(
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

function listRunsNewestFirstEffect(
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

function resolveStatusRunEffect(
  store: RunControlStore,
  workspaceRoot: string,
  runId: string | undefined
): Effect.Effect<MokaRunManifest, unknown> {
  return runId
    ? requireRunEffect(store, runId)
    : resolveDefaultStatusRunEffect(store, workspaceRoot);
}

function resolveDefaultStatusRunEffect(
  store: RunControlStore,
  workspaceRoot: string
): Effect.Effect<MokaRunManifest, unknown> {
  return listRunsNewestFirstEffect(store, workspaceRoot).pipe(
    Effect.flatMap(selectDefaultStatusRunEffect)
  );
}

function selectDefaultStatusRunEffect(
  runs: MokaRunManifest[]
): Effect.Effect<MokaRunManifest, unknown> {
  const activeRuns = runs.filter(isRunActive);
  const selected = statusSelectionError(runs, activeRuns);
  if (selected) {
    return Effect.fail(new Error(selected));
  }
  const activeRun = activeRuns[0];
  return activeRun
    ? Effect.succeed(activeRun)
    : Effect.fail(new Error(formatLatestInactiveRun(runs[0])));
}

function statusSelectionError(
  runs: MokaRunManifest[],
  activeRuns: MokaRunManifest[]
): string | undefined {
  const selection = STATUS_RUN_SELECTIONS.find((candidate) =>
    candidate.matches(runs, activeRuns)
  );
  return selection?.error(runs, activeRuns);
}

function runSortTimeEffect(
  workspaceRoot: string,
  runId: string
): Effect.Effect<number, unknown> {
  return Effect.tryPromise({
    catch: (error) => error,
    try: () =>
      stat(
        runPaths(workspaceRoot, parseLogicalSegment("runId", runId)).manifest
      ),
  }).pipe(
    Effect.map((manifest) => manifest.mtimeMs),
    Effect.catch((error) =>
      isNotFound(error) ? Effect.succeed(0) : Effect.fail(error)
    )
  );
}

function compareRunsNewestFirst(left: RunSortRecord, right: RunSortRecord) {
  const timeOrder = right.sortTime - left.sortTime;
  if (timeOrder !== 0) {
    return timeOrder;
  }
  return right.run.runId.localeCompare(left.run.runId);
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

function logStatusEffect(
  flags: StatusFlags,
  run: MokaRunManifest
): Effect.Effect<void> {
  return logEffect(
    flags.json ? JSON.stringify(runStatus(run)) : formatRunStatus(run)
  );
}

function continueStatusWatchEffect(
  input: {
    flags: StatusFlags;
    runId?: string;
    store: RunControlStore;
    workspaceRoot: string;
  },
  run: MokaRunManifest
): Effect.Effect<void, unknown> {
  return shouldWatchStatus(input.flags, run)
    ? delayEffect(WATCH_INTERVAL_MS).pipe(
        Effect.flatMap(() => printStatusEffect(input))
      )
    : Effect.void;
}

function shouldWatchStatus(flags: StatusFlags, run: MokaRunManifest): boolean {
  return Boolean(flags.watch && isRunActive(run));
}

function formatLatestInactiveRun(run: MokaRunManifest): string {
  return `No active Moka runs found. Latest run is ${run.runId} (${run.status}); pass a run id explicitly.`;
}

function formatMultipleActiveRuns(activeRuns: MokaRunManifest[]): string {
  return [
    "Multiple active runs found; pass a run id explicitly:",
    ...activeRuns.map((run) => `- ${run.runId} (${run.status})`),
  ].join("\n");
}

function formatNodeSummary(nodes: Record<string, MokaNodeStatus>): string {
  const entries = Object.entries(nodes).sort(([left], [right]) =>
    left.localeCompare(right)
  );
  return entries.length === 0
    ? "none"
    : entries.map(([nodeId, status]) => `${nodeId}=${status}`).join(",");
}

function delayEffect(milliseconds: number): Effect.Effect<void, unknown> {
  return Effect.tryPromise({
    catch: (error) => error,
    try: () => delay(milliseconds),
  });
}
