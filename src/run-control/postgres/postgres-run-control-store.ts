import { fileURLToPath } from "node:url";
import { asc, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { Effect } from "effect";
import postgres from "postgres";
import {
  DEFAULT_RUN_CONTROL_STALE_DETECTION,
  type MokaRunControlEvent,
  type MokaRunEvent,
  type MokaRunManifest,
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

const migrationsFolder = fileURLToPath(
  // Co-located with the PIPE-91.4 durable store so a single `migrate` provisions
  // both stores (durable tables in 0000, run-control tables in 0001).
  new URL("../../runtime/durable-store/postgres/migrations", import.meta.url)
);

function openClient(dbUrl: string): postgres.Sql {
  // max: 1 — matches the durable store; the migrator needs a single connection
  // and run-control writes are low-volume.
  return postgres(dbUrl, { max: 1 });
}

/**
 * Apply the shared Drizzle migrations to `dbUrl`. Idempotent: Drizzle tracks
 * applied migrations in `__drizzle_migrations` by content hash, so re-running is
 * a no-op. Because the migrations folder is shared with the durable store, this
 * provisions both stores. Opens and closes its own single-connection client.
 */
export async function migratePostgresRunControlStore(
  dbUrl: string
): Promise<void> {
  const client = openClient(dbUrl);
  try {
    await migrate(drizzle(client), { migrationsFolder });
  } finally {
    await client.end();
  }
}

export function postgresRunControlStore(
  dbUrl: string
): PostgresRunControlStore {
  const client = openClient(dbUrl);
  const db = drizzle(client);

  return {
    close: () => client.end(),
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
}

function createRun(
  db: RunControlDb,
  input: CreateRunRequest
): Effect.Effect<MokaRunManifest, unknown> {
  return Effect.gen(function* () {
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

    // Read back the canonical manifest — may be the row just inserted or the
    // pre-existing one when the insert was a no-op due to conflict.
    const existing = yield* readRun(db, manifest.runId);
    if (existing === undefined) {
      return yield* Effect.fail(
        new Error(`Run ${manifest.runId} not found after createRun upsert.`)
      );
    }
    return existing;
  });
}

function publishSchedule(
  db: RunControlDb,
  input: PublishScheduleRequest
): Effect.Effect<MokaRunManifest, unknown> {
  return Effect.gen(function* () {
    const runId = yield* requireRunId(input.runId);
    yield* updateRunManifest(db, runId, (manifest) =>
      publishScheduleManifest({
        manifest,
        nodeIds: input.nodeIds,
        schedule: input.schedule,
      })
    );
    const replayed = yield* readRun(db, runId);
    if (replayed === undefined) {
      return yield* Effect.fail(new Error(`Run ${runId} does not exist.`));
    }
    return replayed;
  });
}

function readRun(
  db: RunControlDb,
  runId: string
): Effect.Effect<MokaRunManifest | undefined, unknown> {
  return Effect.gen(function* () {
    const base = yield* loadBaseManifest(db, runId);
    if (base === undefined) {
      return;
    }
    const events = yield* loadEvents(db, [runId]);
    return yield* Effect.try({
      catch: (error) => error,
      try: () => replayManifest(base, events.get(runId) ?? []),
    });
  });
}

function listRuns(db: RunControlDb): Effect.Effect<MokaRunManifest[], unknown> {
  return Effect.gen(function* () {
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
}

function recordEvent(
  db: RunControlDb,
  input: RecordEventRequest
): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    const runId = yield* requireRunId(input.runId);
    const event = yield* Effect.try({
      catch: (error) => error,
      try: () => parseMokaRunEvent(input.event),
    });
    yield* ensureRunExists(db, runId);
    yield* dbEffect(() => db.insert(runControlEvent).values({ event, runId }));
  });
}

function updateRunController(
  db: RunControlDb,
  input: UpdateRunControllerRequest
): Effect.Effect<MokaRunManifest, unknown> {
  return Effect.gen(function* () {
    const runId = yield* requireRunId(input.runId);
    return yield* updateRunManifest(db, runId, (manifest) =>
      parseMokaRunManifest({
        ...manifest,
        controller: parseMokaRunController(input.controller),
      })
    );
  });
}

function updateRunManifest(
  db: RunControlDb,
  runId: string,
  update: (manifest: MokaRunManifest) => MokaRunManifest
): Effect.Effect<MokaRunManifest, unknown> {
  return Effect.gen(function* () {
    const base = yield* loadBaseManifest(db, runId);
    if (base === undefined) {
      return yield* Effect.fail(new Error(`Run ${runId} does not exist.`));
    }
    const updated = yield* Effect.try({
      catch: (error) => error,
      try: () => update(base),
    });
    yield* dbEffect(() =>
      db
        .update(runControlRun)
        .set({ manifest: updated })
        .where(eq(runControlRun.runId, runId))
    );
    return updated;
  });
}

function updateRunStatus(
  db: RunControlDb,
  input: UpdateRunStatusRequest
): Effect.Effect<void, unknown> {
  return recordEvent(db, {
    event: {
      at: input.at,
      status: parseMokaRunStatus(input.status),
      type: "run.status",
    },
    runId: input.runId,
  });
}

function updateNodeStatus(
  db: RunControlDb,
  input: UpdateNodeStatusRequest
): Effect.Effect<void, unknown> {
  return recordEvent(db, {
    event: {
      at: input.at,
      nodeId: input.nodeId,
      status: parseMokaNodeStatus(input.status),
      type: "node.status",
    },
    runId: input.runId,
  });
}

function updateNodeSession(
  db: RunControlDb,
  input: UpdateNodeSessionRequest
): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    const runId = yield* requireRunId(input.runId);
    const nodeId = yield* requireNonEmpty("nodeId", input.nodeId);
    const sessionId = yield* requireNonEmpty("sessionId", input.sessionId);
    const base = yield* loadBaseManifest(db, runId);
    if (base === undefined) {
      return yield* Effect.fail(new Error(`Run ${runId} does not exist.`));
    }
    if (!(nodeId in base.nodes)) {
      return yield* Effect.fail(
        new Error(`Node ${nodeId} does not exist in run ${runId}.`)
      );
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
}

function writeNodeArtifact(
  db: RunControlDb,
  input: WriteNodeArtifactRequest
): Effect.Effect<NodeArtifactReference, unknown> {
  return Effect.gen(function* () {
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
}

function statusPaths(runId: string): RunControlStatusPaths {
  const base = `moka_run_control/${runId}`;
  return {
    events: `${base}/events`,
    manifest: `${base}/manifest`,
    status: `${base}/status`,
  };
}

function buildBaseManifest(input: CreateRunRequest): MokaRunManifest {
  const nodes = Object.fromEntries(
    input.nodeIds.map((nodeId) => [nodeId, "queued" as const])
  );
  return parseMokaRunManifest({
    effort: parseRunEffort(input.effort),
    events: [],
    mode: parseRunMode(input.mode),
    nodes,
    runId: input.runId,
    ...(input.schedule ? { schedule: input.schedule } : {}),
    staleDetection: parseRunControlStaleDetection(
      input.staleDetection ?? DEFAULT_RUN_CONTROL_STALE_DETECTION
    ),
    status: "queued",
    target: parseRunTarget(input.target),
  });
}

/**
 * Fold an event log onto a base manifest — the pure event-sourcing replay that
 * `readRun`/`listRuns` share. Mirrors the file store's replay: heartbeats are
 * dropped from the manifest's `events`, run/node status events advance state.
 */
function replayManifest(
  base: MokaRunManifest,
  events: MokaRunControlEvent[]
): MokaRunManifest {
  const statusEvents = events.filter(
    (event): event is MokaRunEvent => event.type !== "run.heartbeat"
  );
  const rebuilt: MokaRunManifest = {
    ...base,
    events: statusEvents,
    nodes: { ...base.nodes },
  };
  for (const event of statusEvents) {
    if (event.type === "run.status") {
      rebuilt.status = event.status;
    } else {
      rebuilt.nodes[event.nodeId] = event.status;
    }
  }
  return parseMokaRunManifest(rebuilt);
}

function loadBaseManifest(
  db: RunControlDb,
  runId: string
): Effect.Effect<MokaRunManifest | undefined, unknown> {
  return Effect.gen(function* () {
    const rows = yield* dbEffect(() =>
      db
        .select()
        .from(runControlRun)
        .where(eq(runControlRun.runId, runId))
        .limit(1)
    );
    const row = rows[0];
    if (row === undefined) {
      return;
    }
    return yield* Effect.try({
      catch: (error) => error,
      try: () => parseMokaRunManifest(row.manifest),
    });
  });
}

function loadEvents(
  db: RunControlDb,
  runIds: string[]
): Effect.Effect<Map<string, MokaRunControlEvent[]>, unknown> {
  return Effect.gen(function* () {
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
}

function ensureRunExists(
  db: RunControlDb,
  runId: string
): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    const base = yield* loadBaseManifest(db, runId);
    if (base === undefined) {
      return yield* Effect.fail(new Error(`Run ${runId} does not exist.`));
    }
  });
}

function dbEffect<T>(run: () => Promise<T>): Effect.Effect<T, unknown> {
  return Effect.tryPromise({ catch: (error) => error, try: run });
}

function requireRunId(runId: string): Effect.Effect<string, unknown> {
  return requireNonEmpty("runId", runId);
}

function requireNonEmpty(
  label: string,
  value: string
): Effect.Effect<string, unknown> {
  return value.length > 0
    ? Effect.succeed(value)
    : Effect.fail(new Error(`${label} must be a non-empty string.`));
}
