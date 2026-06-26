import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll } from "vitest";
import { migratePostgresDurableStore } from "../src/runtime/durable-store/postgres/postgres-store";

export interface LivePgDurableSuite {
  /** A namespaced run id under the suite's unique prefix. */
  runId(label: string): string;
}

/**
 * Shared scaffolding for live cluster-Postgres durable-store suites. Namespaces
 * every run id under a unique per-suite prefix so concurrent workers and prior
 * runs never collide on the shared cluster DB, migrates the durable schema before
 * the suite, and prefix-deletes every record the suite created on teardown.
 *
 * Call inside a `describe` block (it registers `beforeAll`/`afterAll`).
 */
export function setupLivePgDurableSuite(
  dbUrl: string,
  prefix: string
): LivePgDurableSuite {
  const suitePrefix = `${prefix}-${randomUUID()}`;
  let admin: postgres.Sql;

  beforeAll(async () => {
    await migratePostgresDurableStore(dbUrl);
    admin = postgres(dbUrl, { max: 1 });
  });

  afterAll(async () => {
    await admin`delete from moka_durable_node_record where run_id like ${`${suitePrefix}%`}`;
    await admin`delete from moka_durable_run where run_id like ${`${suitePrefix}%`}`;
    await admin.end();
  });

  return {
    runId: (label) => `${suitePrefix}:${label}:${randomUUID()}`,
  };
}
