import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const migrationsFolder = fileURLToPath(
  new URL("./migrations", import.meta.url)
);

// drizzle-orm's migrate() has no built-in protection against concurrent
// execution (drizzle-team/drizzle-orm#874) -- every store resolution (one per
// node, potentially many concurrent pods per run) calls this, so callers must
// serialize themselves. Session-level advisory lock, released before the
// connection closes; arbitrary fixed key, unique to this migration.
const MIGRATION_LOCK_KEY = 8_942_017;

/**
 * Apply the Drizzle migrations shared by the run-control and durable stores to
 * `dbUrl`. Idempotent (Drizzle tracks applied migrations in
 * `__drizzle_migrations` by content hash) and safe under concurrent callers
 * (Postgres advisory lock serializes them). Opens and closes its own
 * single-connection client.
 */
export async function migratePostgresSubstrate(dbUrl: string): Promise<void> {
  const client = postgres(dbUrl, { max: 1 });
  try {
    await client`select pg_advisory_lock(${MIGRATION_LOCK_KEY}::bigint)`;
    try {
      await migrate(drizzle(client), { migrationsFolder });
    } finally {
      await client`select pg_advisory_unlock(${MIGRATION_LOCK_KEY}::bigint)`;
    }
  } finally {
    await client.end();
  }
}
