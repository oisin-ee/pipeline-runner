import { asc, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import postgres from "postgres";

import { migratePostgresSubstrate } from "../../runtime/durable-store/postgres/migrate-substrate";
import {
  DEFAULT_RUN_CONTROL_STALE_DETECTION,
  parseMokaNodeStatus,
  parseMokaRunController,
  parseMokaRunEvent,
  parseMokaRunManifest,
  parseMokaRunStatus,
  parseRunControlStaleDetection,
  parseRunEffort,
  parseRunMode,
  parseRunTarget,
} from "../contracts";
import type {
  MokaRunControlEvent,
  MokaRunEvent,
  MokaRunManifest,
} from "../contracts";
import type {
  CreateRunRequest,
  PublishScheduleRequest,
  RecordEventRequest,
  RunControlStore,
  UpdateNodeSessionRequest,
  UpdateNodeStatusRequest,
  UpdateRunControllerRequest,
  UpdateRunStatusRequest,
  WriteNodeArtifactRequest,
} from "../run-control-store";
import { publishScheduleManifest } from "../store-manifest";
import type {
  NodeArtifactReference,
  RunControlStatusPaths,
} from "../store-types";
import {
  runControlEvent,
  runControlNodeArtifact,
  runControlNodeSession,
  runControlRun,
} from "./schema";

/**
 * PIPE-91.11: Postgres-backed {@link RunControlStore}. It mirrors the PIPE-91.4
 * durable store's one DB stack — a single-connection `postgres` client wrapped
 * by Drizzle, migrations applied through the same `drizzle-orm/postgres-js`
 * migrator — and preserves the file store's event-sourced model: `createRun`
 * writes the base manifest, `recordEvent` appends to an append-only log, and
 * `readRun`/`listRuns` reconstruct the manifest by replaying that log.
 *
 * The interface is connectionless, so the factory binds one connection at
 * construction and exposes `close` (as the durable store does) for the
 * 91.12 cutover to release on run completion.
 */
export interface PostgresRunControlStore extends RunControlStore {
  /** Release the Postgres connection pool. */
  close(): Promise<void>;
}

type RunControlDb = ReturnType<typeof drizzle>;

const openClient = (dbUrl: string): postgres.Sql =>
  // max: 1 — matches the durable store; the migrator needs a single connection
  // and run-control writes are low-volume.
  postgres(dbUrl, { max: 1 });

/**
 * Apply the shared Drizzle migrations to `dbUrl`. Delegates to
 * {@link migratePostgresSubstrate} (shared with the durable store, lock-guarded
 * for concurrent callers).
 */
export const migratePostgresRunControlStore = async (
  dbUrl: string
): Promise<void> => {
  await migratePostgresSubstrate(dbUrl);
};

const statusPaths = (runId: string): RunControlStatusPaths => {
  const base = `moka_run_control/${runId}`;
  return {
    events: `${base}/events`,
    manifest: `${base}/manifest`,
    status: `${base}/status`,
  };
};

const buildBaseManifest = (input: CreateRunRequest): MokaRunManifest => {
  const nodes = Object.fromEntries(
    input.nodeIds.map((nodeId) => [nodeId, "queued" as const])
  );
  return parseMokaRunManifest({
    effort: parseRunEffort(input.effort),
    events: [],
    mode: parseRunMode(input.mode),
    nodes,
    runId: input.runId,
    ...(input.schedule !== undefined && input.schedule.length > 0
      ? { schedule: input.schedule }
      : {}),
    staleDetection: parseRunControlStaleDetection(
      input.staleDetection ?? DEFAULT_RUN_CONTROL_STALE_DETECTION
    ),
    status: "queued",
    target: parseRunTarget(input.target),
  });
};

/**
 * Fold an event log onto a base manifest — the pure event-sourcing replay that
 * `readRun`/`listRuns` share. Mirrors the file store's replay: heartbeats are
 * dropped from the manifest's `events`, run/node status events advance state.
 */
const replayManifest = (
  base: MokaRunManifest,
  events: MokaRunControlEvent[]
): MokaRunManifest => {
  const statusEvents = events.filter(
    (event): event is MokaRunEvent => event.type !== "run.heartbeat"
  );
  const nodes = { ...base.nodes };
  let { status } = base;
  for (const event of statusEvents) {
    if (event.type === "run.status") {
      const { status: eventStatus } = event;
      status = eventStatus;
    } else {
      nodes[event.nodeId] = event.status;
    }
  }
  return parseMokaRunManifest({
    ...base,
    events: statusEvents,
    nodes,
    status,
  });
};

const dbEffect = <T>(run: () => Promise<T>): Effect.Effect<T, unknown> =>
  Effect.tryPromise({ catch: (error) => error, try: run });

const loadBaseManifest = (
  db: RunControlDb,
  runId: string
): Effect.Effect<Option.Option<MokaRunManifest>, unknown> =>
  Effect.gen(function* effectBody() {
    const rows = yield* dbEffect(() =>
      db
        .select()
        .from(runControlRun)
        .where(eq(runControlRun.runId, runId))
        .limit(1)
    );
    const row = rows.at(0);
    if (row === undefined) {
      return Option.none();
    }
    const manifest = yield* Effect.try({
      catch: (error) => error,
      try: () => parseMokaRunManifest(row.manifest),
    });
    return Option.some(manifest);
  });

const ensureRunExists = (
  db: RunControlDb,
  runId: string
): Effect.Effect<void, unknown> =>
  Effect.gen(function* effectBody() {
    const base = yield* loadBaseManifest(db, runId);
    yield* Option.match(base, {
      onNone: () => Effect.fail(new Error(`Run ${runId} does not exist.`)),
      onSome: () => Effect.void,
    });
  });

const createRun = (
  db: RunControlDb,
  input: CreateRunRequest
): Effect.Effect<MokaRunManifest, unknown> =>
  Effect.gen(function* effectBody() {
    const manifest = yield* Effect.try({
      catch: (error) => error,
      try: () => buildBaseManifest(input),
    });

    // Idempotent upsert: DO NOTHING on conflict preserves the existing row and
    // its event log. Both `moka submit` and `runner-lifecycle workflow.start`
    // may call createRun for the same runId; the first writer wins atomically.
    yield* dbEffect(() =>
      db
        .insert(runControlRun)
        .values({ manifest, runId: manifest.runId })
        .onConflictDoNothing()
    );

    // Read back the BASE manifest only (no event replay) — may be the row
    // just inserted or the pre-existing one when the insert was a no-op due to
    // conflict. Matches the file-backed store's createRun, which returns the
    // manifest file unchanged rather than a replayed view: callers rely on a
    // second createRun for an existing run reflecting the row as last
    // written, not events recorded since. Use readRun (which replays) to see
    // the run's current live state.
    const existing = yield* loadBaseManifest(db, manifest.runId);
    if (Option.isNone(existing)) {
      return yield* Effect.fail(
        new Error(`Run ${manifest.runId} not found after createRun upsert.`)
      );
    }
    return existing.value;
  });

const updateRunManifest = (
  db: RunControlDb,
  runId: string,
  update: (manifest: MokaRunManifest) => MokaRunManifest
): Effect.Effect<MokaRunManifest, unknown> =>
  Effect.gen(function* effectBody() {
    const base = yield* loadBaseManifest(db, runId);
    if (Option.isNone(base)) {
      return yield* Effect.fail(new Error(`Run ${runId} does not exist.`));
    }
    const updated = yield* Effect.try({
      catch: (error) => error,
      try: () => update(base.value),
    });
    yield* dbEffect(() =>
      db
        .update(runControlRun)
        .set({ manifest: updated })
        .where(eq(runControlRun.runId, runId))
    );
    return updated;
  });

const loadEvents = (
  db: RunControlDb,
  runIds: string[]
): Effect.Effect<Map<string, MokaRunControlEvent[]>, unknown> =>
  Effect.gen(function* effectBody() {
    const grouped = new Map<string, MokaRunControlEvent[]>();
    if (runIds.length === 0) {
      return grouped;
    }
    const rows = yield* dbEffect(() =>
      db
        .select()
        .from(runControlEvent)
        .where(inArray(runControlEvent.runId, runIds))
        .orderBy(asc(runControlEvent.seq))
    );
    for (const row of rows) {
      const event = parseMokaRunEvent(row.event);
      const bucket = grouped.get(row.runId);
      if (bucket) {
        bucket.push(event);
      } else {
        grouped.set(row.runId, [event]);
      }
    }
    return grouped;
  });

const readRun = (db: RunControlDb, runId: string) =>
  Effect.gen(function* effectBody() {
    const base = yield* loadBaseManifest(db, runId);
    if (Option.isNone(base)) {
      return Option.getOrUndefined(Option.none<MokaRunManifest>());
    }
    const events = yield* loadEvents(db, [runId]);
    return yield* Effect.try({
      catch: (error) => error,
      try: () => replayManifest(base.value, events.get(runId) ?? []),
    });
  });

const listRuns = (
  db: RunControlDb
): Effect.Effect<MokaRunManifest[], unknown> =>
  Effect.gen(function* effectBody() {
    const rows = yield* dbEffect(() =>
      db.select().from(runControlRun).orderBy(asc(runControlRun.runId))
    );
    if (rows.length === 0) {
      return [];
    }
    const events = yield* loadEvents(
      db,
      rows.map((row) => row.runId)
    );
    return yield* Effect.try({
      catch: (error) => error,
      try: () =>
        rows.map((row) =>
          replayManifest(
            parseMokaRunManifest(row.manifest),
            events.get(row.runId) ?? []
          )
        ),
    });
  });

const requireNonEmpty = (
  label: string,
  value: string
): Effect.Effect<string, unknown> =>
  value.length > 0
    ? Effect.succeed(value)
    : Effect.fail(new Error(`${label} must be a non-empty string.`));

const requireRunId = (runId: string): Effect.Effect<string, unknown> =>
  requireNonEmpty("runId", runId);

const publishSchedule = (
  db: RunControlDb,
  input: PublishScheduleRequest
): Effect.Effect<MokaRunManifest, unknown> =>
  Effect.gen(function* effectBody() {
    const runId = yield* requireRunId(input.runId);
    yield* updateRunManifest(db, runId, (manifest) =>
      publishScheduleManifest({
        manifest,
        nodeIds: input.nodeIds,
        schedule: input.schedule,
      })
    );
    // Unlike createRun's "return unchanged on no-op", publishSchedule is a
    // state transition whose caller expects the full current picture --
    // including node statuses recorded via events before this call -- so this
    // reads back through readRun's replay, not the base row.
    const replayed = yield* readRun(db, runId);
    if (replayed === undefined) {
      return yield* Effect.fail(new Error(`Run ${runId} does not exist.`));
    }
    return replayed;
  });

const recordEvent = (
  db: RunControlDb,
  input: RecordEventRequest
): Effect.Effect<void, unknown> =>
  Effect.gen(function* effectBody() {
    const runId = yield* requireRunId(input.runId);
    const event = yield* Effect.try({
      catch: (error) => error,
      try: () => parseMokaRunEvent(input.event),
    });
    yield* ensureRunExists(db, runId);
    yield* dbEffect(() => db.insert(runControlEvent).values({ event, runId }));
  });

const updateRunStatus = (
  db: RunControlDb,
  input: UpdateRunStatusRequest
): Effect.Effect<void, unknown> =>
  recordEvent(db, {
    event: {
      at: input.at,
      status: parseMokaRunStatus(input.status),
      type: "run.status",
    },
    runId: input.runId,
  });

const updateNodeStatus = (
  db: RunControlDb,
  input: UpdateNodeStatusRequest
): Effect.Effect<void, unknown> =>
  recordEvent(db, {
    event: {
      at: input.at,
      nodeId: input.nodeId,
      status: parseMokaNodeStatus(input.status),
      type: "node.status",
    },
    runId: input.runId,
  });

const updateRunController = (
  db: RunControlDb,
  input: UpdateRunControllerRequest
): Effect.Effect<MokaRunManifest, unknown> =>
  Effect.gen(function* effectBody() {
    const runId = yield* requireRunId(input.runId);
    return yield* updateRunManifest(db, runId, (manifest) =>
      parseMokaRunManifest({
        ...manifest,
        controller: parseMokaRunController(input.controller),
      })
    );
  });

const updateNodeSession = (
  db: RunControlDb,
  input: UpdateNodeSessionRequest
): Effect.Effect<void, unknown> =>
  Effect.gen(function* effectBody() {
    const runId = yield* requireRunId(input.runId);
    const nodeId = yield* requireNonEmpty("nodeId", input.nodeId);
    const sessionId = yield* requireNonEmpty("sessionId", input.sessionId);
    const base = yield* loadBaseManifest(db, runId);
    const manifest = yield* Option.match(base, {
      onNone: () => Effect.fail(new Error(`Run ${runId} does not exist.`)),
      onSome: Effect.succeed,
    });
    if (!(nodeId in manifest.nodes)) {
      yield* Effect.fail(
        new Error(`Node ${nodeId} does not exist in run ${runId}.`)
      );
      return;
    }
    yield* dbEffect(() =>
      db
        .insert(runControlNodeSession)
        .values({ nodeId, runId, sessionId })
        .onConflictDoUpdate({
          set: { sessionId },
          target: [runControlNodeSession.runId, runControlNodeSession.nodeId],
        })
    );
  });

const writeNodeArtifact = (
  db: RunControlDb,
  input: WriteNodeArtifactRequest
): Effect.Effect<NodeArtifactReference, unknown> =>
  Effect.gen(function* effectBody() {
    const runId = yield* requireRunId(input.runId);
    const nodeId = yield* requireNonEmpty("nodeId", input.nodeId);
    const name = yield* requireNonEmpty("artifact name", input.name);
    yield* ensureRunExists(db, runId);
    yield* dbEffect(() =>
      db
        .insert(runControlNodeArtifact)
        .values({
          content: input.content,
          contentType: input.contentType ?? null,
          name,
          nodeId,
          runId,
        })
        .onConflictDoUpdate({
          set: {
            content: input.content,
            contentType: input.contentType ?? null,
          },
          target: [
            runControlNodeArtifact.runId,
            runControlNodeArtifact.nodeId,
            runControlNodeArtifact.name,
          ],
        })
    );
    return { path: `moka_run_control/${runId}/nodes/${nodeId}/${name}` };
  });

export const postgresRunControlStore = (
  dbUrl: string
): PostgresRunControlStore => {
  const client = openClient(dbUrl);
  const db = drizzle(client);

  return {
    close: async () => {
      await client.end();
    },
    createRun: (input) => createRun(db, input),
    listRuns: () => listRuns(db),
    publishSchedule: (input) => publishSchedule(db, input),
    readRun: (input) => readRun(db, input.runId),
    recordEvent: (input) => recordEvent(db, input),
    statusPaths: (input) => statusPaths(input.runId),
    updateNodeSession: (input) => updateNodeSession(db, input),
    updateNodeStatus: (input) => updateNodeStatus(db, input),
    updateRunController: (input) => updateRunController(db, input),
    updateRunStatus: (input) => updateRunStatus(db, input),
    writeNodeArtifact: (input) => writeNodeArtifact(db, input),
  };
};
