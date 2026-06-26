import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import pino from "pino";
import postgres from "postgres";
import type { RunJournal } from "../../run-journal";
import type { DurableNodeRecord, DurableRunStore } from "../durable-store";
import { durableNodeRecord, durableRun } from "./schema";

/**
 * PIPE-91.4: the Postgres-backed {@link DurableRunStore} plus the lifecycle the
 * sync interface cannot express. Reads (`get`/`resumeCompleted`) are served
 * synchronously from an in-memory mirror hydrated from Postgres at construction;
 * writes (`record`) update the mirror synchronously and are persisted through a
 * serialized write-through queue. `flush` drains that queue (and surfaces any
 * write failure); `close` flushes then releases the connection pool.
 *
 * The async factory + the `flush`/`close` lifecycle are the seam the 91.5/91.11
 * cutover must honor (see module notes): the cutover should await writes at the
 * call site and call `close` on run completion.
 */
export interface PostgresDurableRunStore extends DurableRunStore {
  /** Release the Postgres connection pool. Flushes pending writes first. */
  close(): Promise<void>;
  /** Await all pending write-through persistence; rejects if any write failed. */
  flush(): Promise<void>;
}

const logger = pino({ name: "postgres-durable-store" });

const migrationsFolder = fileURLToPath(
  new URL("./migrations", import.meta.url)
);

type DurableDb = ReturnType<typeof drizzle>;

function openClient(dbUrl: string): postgres.Sql {
  // max: 1 — the migrator requires a single connection, and the store's writes
  // are serialized, so a larger pool buys nothing here.
  return postgres(dbUrl, { max: 1 });
}

/**
 * Apply the Drizzle migrations to `dbUrl`. Idempotent: Drizzle tracks applied
 * migrations in `__drizzle_migrations` by content hash, so re-running is a
 * no-op. Opens and closes its own single-connection client.
 */
export async function migratePostgresDurableStore(
  dbUrl: string
): Promise<void> {
  const client = openClient(dbUrl);
  try {
    await migrate(drizzle(client), { migrationsFolder });
  } finally {
    await client.end();
  }
}

function makeBucket(
  mirror: Map<string, Map<string, DurableNodeRecord>>,
  runId: string
): Map<string, DurableNodeRecord> {
  let bucket = mirror.get(runId);
  if (!bucket) {
    bucket = new Map();
    mirror.set(runId, bucket);
  }
  return bucket;
}

async function hydrate(
  db: DurableDb
): Promise<Map<string, Map<string, DurableNodeRecord>>> {
  const mirror = new Map<string, Map<string, DurableNodeRecord>>();
  const rows = await db.select().from(durableNodeRecord);
  for (const row of rows) {
    makeBucket(mirror, row.runId).set(row.nodeId, {
      criteria: row.criteria,
      inputs: row.inputs,
      recordedAt: row.recordedAt.toISOString(),
      result: row.result,
    });
  }
  return mirror;
}

async function persist(
  db: DurableDb,
  runId: string,
  nodeId: string,
  record: DurableNodeRecord
): Promise<void> {
  const recordedAt = new Date(record.recordedAt);
  const values = {
    criteria: record.criteria,
    inputs: record.inputs ?? null,
    nodeId,
    recordedAt,
    result: record.result,
    runId,
    status: record.result.status,
  };
  await db.insert(durableRun).values({ runId }).onConflictDoNothing();
  await db
    .insert(durableNodeRecord)
    .values(values)
    .onConflictDoUpdate({
      set: {
        criteria: values.criteria,
        inputs: values.inputs,
        recordedAt: values.recordedAt,
        result: values.result,
        status: values.status,
      },
      target: [durableNodeRecord.runId, durableNodeRecord.nodeId],
    });
}

export async function postgresDurableRunStore(
  dbUrl: string
): Promise<PostgresDurableRunStore> {
  const client = openClient(dbUrl);
  const db = drizzle(client);
  const mirror = await hydrate(db);

  // Serialized write-through: ordering is preserved (last write wins, mirroring
  // the in-memory overwrite), every write is attempted, and failures are logged
  // and collected so `flush` can surface them instead of swallowing them.
  let writeChain: Promise<void> = Promise.resolve();
  const writeErrors: unknown[] = [];

  function enqueueWrite(
    runId: string,
    nodeId: string,
    record: DurableNodeRecord
  ): void {
    writeChain = writeChain.then(async () => {
      try {
        await persist(db, runId, nodeId, record);
      } catch (error) {
        logger.error(
          { err: error, nodeId, runId },
          "durable node record write failed"
        );
        writeErrors.push(error);
      }
    });
  }

  function passedResultsForRun(runId: string) {
    const bucket = mirror.get(runId);
    if (!bucket) {
      return [];
    }
    return [...bucket.values()]
      .filter((entry) => entry.result.status === "passed")
      .map((entry) => entry.result);
  }

  async function flush(): Promise<void> {
    await writeChain;
    const failure = writeErrors[0];
    if (failure !== undefined) {
      throw failure instanceof Error ? failure : new Error(String(failure));
    }
  }

  return {
    async close() {
      try {
        await flush();
      } finally {
        await client.end();
      }
    },

    flush,

    get(runId, nodeId) {
      return mirror.get(runId)?.get(nodeId);
    },

    record(runId, nodeId, entry) {
      const record: DurableNodeRecord = {
        ...entry,
        recordedAt: new Date().toISOString(),
      };
      makeBucket(mirror, runId).set(nodeId, record);
      enqueueWrite(runId, nodeId, record);
    },

    resumeCompleted(runId) {
      return passedResultsForRun(runId);
    },

    toRunJournal(runId): RunJournal {
      return {
        record: (result) => {
          const record: DurableNodeRecord = {
            criteria: [],
            inputs: undefined,
            recordedAt: new Date().toISOString(),
            result,
          };
          makeBucket(mirror, runId).set(result.nodeId, record);
          enqueueWrite(runId, result.nodeId, record);
        },
        resumeCompleted: () => passedResultsForRun(runId),
      };
    },
  };
}
