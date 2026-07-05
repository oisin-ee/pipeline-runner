import { stat } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

import { Effect, Option } from "effect";

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

export const requireRunEffect = (
  store: RunControlStore,
  runId: string
): Effect.Effect<MokaRunManifest, unknown> =>
  Effect.gen(function* effectBody() {
    const run = yield* store.readRun({ runId });
    if (!run) {
      return yield* Effect.fail(new Error(`Run ${runId} does not exist.`));
    }
    return run;
  });

const runSortTimeEffect = (
  workspaceRoot: string,
  runId: string
): Effect.Effect<number, unknown> =>
  Effect.tryPromise({
    catch: (error) => error,
    try: async () =>
      await stat(
        runPaths(workspaceRoot, parseLogicalSegment("runId", runId)).manifest
      ),
  }).pipe(
    Effect.map((manifest) => manifest.mtimeMs),
    Effect.catch((error) =>
      isNotFound(error) ? Effect.succeed(0) : Effect.fail(error)
    )
  );

const compareRunsNewestFirst = (left: RunSortRecord, right: RunSortRecord) => {
  const timeOrder = right.sortTime - left.sortTime;
  if (timeOrder !== 0) {
    return timeOrder;
  }
  return right.run.runId.localeCompare(left.run.runId);
};

const listRunsNewestFirstEffect = (
  store: RunControlStore,
  workspaceRoot: string
): Effect.Effect<MokaRunManifest[], unknown> =>
  Effect.gen(function* effectBody() {
    const runs = yield* store.listRuns();
    const records = yield* Effect.forEach(runs, (run) =>
      runSortTimeEffect(workspaceRoot, run.runId).pipe(
        Effect.map((sortTime) => ({ run, sortTime }))
      )
    );

    return records.toSorted(compareRunsNewestFirst).map((record) => record.run);
  });

const formatRunStatus = (run: MokaRunManifest): string =>
  [
    `Run: ${run.runId}`,
    `Status: ${run.status}`,
    `Active: ${isRunActive(run) ? "yes" : "no"}`,
    `Target: ${run.target}`,
    `Effort: ${run.effort}`,
    `Mode: ${run.mode}`,
    "Nodes:",
    ...Object.entries(run.nodes)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([nodeId, status]) => `- ${nodeId}: ${status}`),
    `Events: ${run.events.length}`,
  ].join("\n");

const runStatus = (run: MokaRunManifest) => ({
  active: isRunActive(run),
  effort: run.effort,
  events: run.events,
  mode: run.mode,
  nodes: run.nodes,
  runId: run.runId,
  status: run.status,
  target: run.target,
});

const logStatusEffect = (
  flags: StatusFlags,
  run: MokaRunManifest
): Effect.Effect<void> =>
  logEffect(
    flags.json === true ? JSON.stringify(runStatus(run)) : formatRunStatus(run)
  );

const shouldWatchStatus = (flags: StatusFlags, run: MokaRunManifest): boolean =>
  flags.watch === true && isRunActive(run);

const formatLatestInactiveRun = (run: MokaRunManifest): string =>
  `No active Moka runs found. Latest run is ${run.runId} (${run.status}); pass a run id explicitly.`;

const formatMultipleActiveRuns = (activeRuns: MokaRunManifest[]): string =>
  [
    "Multiple active runs found; pass a run id explicitly:",
    ...activeRuns.map((run) => `- ${run.runId} (${run.status})`),
  ].join("\n");
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

const statusSelectionError = (
  runs: MokaRunManifest[],
  activeRuns: MokaRunManifest[]
): Option.Option<string> => {
  const selection = STATUS_RUN_SELECTIONS.find((candidate) =>
    candidate.matches(runs, activeRuns)
  );
  return Option.fromNullishOr(selection).pipe(
    Option.map((value) => value.error(runs, activeRuns))
  );
};

const selectDefaultStatusRunEffect = (
  runs: MokaRunManifest[]
): Effect.Effect<MokaRunManifest, unknown> => {
  const activeRuns = runs.filter(isRunActive);
  const selected = statusSelectionError(runs, activeRuns);
  if (Option.isSome(selected)) {
    return Effect.fail(new Error(selected.value));
  }
  const activeRun = activeRuns[0];
  return Option.match(Option.fromNullishOr(activeRun), {
    onNone: () => Effect.fail(new Error(formatLatestInactiveRun(runs[0]))),
    onSome: Effect.succeed,
  });
};

const resolveDefaultStatusRunEffect = (
  store: RunControlStore,
  workspaceRoot: string
): Effect.Effect<MokaRunManifest, unknown> =>
  listRunsNewestFirstEffect(store, workspaceRoot).pipe(
    Effect.flatMap(selectDefaultStatusRunEffect)
  );

const resolveStatusRunEffect = (
  store: RunControlStore,
  workspaceRoot: string,
  runId: Option.Option<string>
): Effect.Effect<MokaRunManifest, unknown> =>
  Option.match(runId, {
    onNone: () => resolveDefaultStatusRunEffect(store, workspaceRoot),
    onSome: (value) => requireRunEffect(store, value),
  });

const formatNodeSummary = (nodes: Record<string, MokaNodeStatus>): string => {
  const entries = Object.entries(nodes).toSorted(([left], [right]) =>
    left.localeCompare(right)
  );
  return entries.length === 0
    ? "none"
    : entries.map(([nodeId, status]) => `${nodeId}=${status}`).join(",");
};

const formatRuns = (runs: MokaRunManifest[]): string => {
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
};

export const printRunsEffect = (
  store: RunControlStore,
  workspaceRoot: string
): Effect.Effect<void, unknown> =>
  listRunsNewestFirstEffect(store, workspaceRoot).pipe(
    Effect.map(formatRuns),
    Effect.flatMap(logEffect)
  );

const delayEffect = (milliseconds: number): Effect.Effect<void, unknown> =>
  Effect.tryPromise({
    catch: (error) => error,
    try: async () => {
      await delay(milliseconds);
    },
  });

export const printStatusEffect = function printStatusEffect(input: {
  flags: StatusFlags;
  runId?: string;
  store: RunControlStore;
  workspaceRoot: string;
}): Effect.Effect<void, unknown> {
  return resolveStatusRunEffect(
    input.store,
    input.workspaceRoot,
    Option.fromNullishOr(input.runId).pipe(
      Option.filter((value) => value.length > 0)
    )
  ).pipe(
    Effect.flatMap((run) =>
      logStatusEffect(input.flags, run).pipe(
        Effect.andThen(
          shouldWatchStatus(input.flags, run)
            ? delayEffect(WATCH_INTERVAL_MS).pipe(
                Effect.flatMap(() => printStatusEffect(input))
              )
            : Effect.void
        )
      )
    )
  );
};
