import { Effect } from "effect";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { resolveRunControlStore } from "../src/run-control/run-control-store";
import { resolveDurableStore } from "../src/runtime/durable-store/acquisition";
import { migratePostgresSubstrate } from "../src/runtime/durable-store/postgres/migrate-substrate";

// Gated the same way as the other live-cluster PG suites (run-control-writers-pg,
// next-node-submit-result-pg): set MOKA_PG_TEST_URL to run for real.
//
// PIPE-94 dogfood found that a genuinely fresh Postgres has none of the
// run-control/durable-store tables until something calls migrate -- and
// nothing did, anywhere in the CLI or runner. resolveRunControlStore/
// resolveDurableStore now migrate automatically before returning a store, so
// this proves a store resolves against a schema-less database with no prior
// explicit migrate call.
const PG_URL = process.env.MOKA_PG_TEST_URL ?? "";
const describePg = PG_URL ? describe : describe.skip;

describePg("Postgres substrate auto-migrates on store resolution", () => {
  const dbUrl = PG_URL;
  let admin: postgres.Sql;

  afterAll(async () => {
    await admin?.end();
  });

  it("resolveRunControlStore provisions the schema from an empty database", async () => {
    admin = postgres(dbUrl, { max: 1 });
    await admin`drop schema public cascade`;
    await admin`create schema public`;
    await admin`drop schema if exists drizzle cascade`;

    const run = await Effect.runPromise(
      Effect.scoped(
        resolveRunControlStore(dbUrl, "/tmp").pipe(
          Effect.flatMap((store) =>
            store
              .createRun({
                effort: "quick",
                mode: "write",
                nodeIds: ["a"],
                runId: "auto-migrate-rc-check",
                target: "local",
              })
              .pipe(
                Effect.flatMap(() =>
                  store.readRun({ runId: "auto-migrate-rc-check" })
                )
              )
          )
        )
      )
    );

    expect(run?.runId).toBe("auto-migrate-rc-check");

    const tables = await admin`
      select table_name from information_schema.tables
      where table_schema = 'public' and table_name like 'moka_%'
      order by table_name
    `;
    expect(tables.map((row) => row.table_name)).toEqual(
      expect.arrayContaining([
        "moka_run_control_run",
        "moka_run_control_event",
        "moka_durable_run",
        "moka_durable_node_record",
      ])
    );

    await admin`delete from moka_run_control_run where run_id = 'auto-migrate-rc-check'`;
  });

  it("resolveDurableStore also resolves against the already-migrated schema", async () => {
    const closed = await Effect.runPromise(
      Effect.scoped(
        resolveDurableStore(dbUrl, "auto-migrate-durable-check").pipe(
          Effect.map(() => true)
        )
      )
    );
    expect(closed).toBe(true);
  });

  it("migratePostgresSubstrate is idempotent under repeated calls", async () => {
    await expect(migratePostgresSubstrate(dbUrl)).resolves.toBeUndefined();
    await expect(migratePostgresSubstrate(dbUrl)).resolves.toBeUndefined();
  });
});
