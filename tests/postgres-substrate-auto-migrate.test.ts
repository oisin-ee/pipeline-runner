import { randomUUID } from "node:crypto";

import { Effect, Option } from "effect";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";

import { resolveRunControlStore } from "../src/run-control/run-control-store";
import { resolveDurableStore } from "../src/runtime/durable-store/acquisition";
import { migratePostgresSubstrate } from "../src/runtime/durable-store/postgres/migrate-substrate";
import { MOKA_POSTGRES_SCHEMA } from "../src/runtime/durable-store/postgres/schema";

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

const SUBSTRATE_TABLES: readonly string[] = [
  "moka_durable_node_record",
  "moka_durable_run",
  "moka_run_control_event",
  "moka_run_control_node_artifact",
  "moka_run_control_node_session",
  "moka_run_control_run",
];

const LEGACY_DURABLE_RECORD = {
  criteria: [{ id: "ac-upgrade", text: "survives schema move" }],
  inputs: { source: "legacy-public" },
  result: {
    attempts: 1,
    evidence: ["legacy seed"],
    exitCode: 0,
    nodeId: "legacy-node",
    output: "legacy output",
    status: "passed",
  },
};

const testRoleName = (): string =>
  `moka_acl_${randomUUID().replaceAll("-", "_")}`;

const postgresErrorCode = (error: unknown): Option.Option<string> => {
  if (!(error instanceof Error)) {
    return Option.none();
  }
  const code = Reflect.get(error, "code");
  return typeof code === "string" ? Option.some(code) : Option.none();
};

const assertPostgresCode = (error: unknown, code: string): void => {
  if (!(error instanceof Error)) {
    throw new Error(`Expected Postgres error ${code}, got non-Error value.`);
  }
  const actual = Option.getOrUndefined(postgresErrorCode(error));
  if (actual !== code) {
    throw new Error(`Expected Postgres error ${code}, got ${actual}.`);
  }
};

const expectPermissionDenied = async (
  query: Promise<unknown>
): Promise<void> => {
  let thrown: unknown;
  try {
    await query;
  } catch (error) {
    thrown = error;
  }
  if (thrown === undefined) {
    throw new Error("Expected Postgres permission denial.");
  }
  assertPostgresCode(thrown, "42501");
};

const resetSubstrateSchemas = async (admin: postgres.Sql): Promise<void> => {
  await admin`drop schema if exists ${admin(MOKA_POSTGRES_SCHEMA)} cascade`;
  await admin`drop schema if exists drizzle cascade`;
  await admin`drop schema public cascade`;
  await admin`create schema public`;
  await admin`revoke create on schema public from public`;
};

const currentUser = async (admin: postgres.Sql): Promise<string> => {
  const rows = await admin<{ current_user: string }[]>`select current_user`;
  const [row] = rows;
  return row.current_user;
};

const runWithRole = async (
  admin: postgres.Sql,
  roleName: string,
  operation: () => Promise<void>
): Promise<void> => {
  await admin`set role ${admin(roleName)}`;
  try {
    await operation();
  } finally {
    await admin`reset role`;
  }
};

const readSubstrateTableSchemas = async (
  admin: postgres.Sql
): Promise<Map<string, string>> => {
  const rows = await admin<{ table_name: string; table_schema: string }[]>`
    select table_name, table_schema
    from information_schema.tables
    where table_name in ${admin(SUBSTRATE_TABLES)}
    order by table_name
  `;
  return new Map(rows.map((row) => [row.table_name, row.table_schema]));
};

const seedLegacyPublicLayout = async (admin: postgres.Sql): Promise<void> => {
  await admin`
    create table public.moka_durable_run (
      created_at timestamp with time zone default now() not null,
      run_id text primary key not null
    )
  `;
  await admin`
    create table public.moka_durable_node_record (
      criteria jsonb default '[]'::jsonb not null,
      inputs jsonb,
      node_id text not null,
      recorded_at timestamp with time zone default now() not null,
      result jsonb not null,
      run_id text not null references public.moka_durable_run(run_id),
      status text not null,
      constraint moka_durable_node_record_run_id_node_id_pk primary key (run_id, node_id)
    )
  `;
  await admin`
    create table public.moka_run_control_run (
      created_at timestamp with time zone default now() not null,
      manifest jsonb not null,
      run_id text primary key not null
    )
  `;
  await admin`
    create table public.moka_run_control_event (
      event jsonb not null,
      recorded_at timestamp with time zone default now() not null,
      run_id text not null references public.moka_run_control_run(run_id),
      seq bigserial primary key not null
    )
  `;
  await admin`
    create table public.moka_run_control_node_session (
      node_id text not null,
      run_id text not null references public.moka_run_control_run(run_id),
      session_id text not null,
      constraint moka_run_control_node_session_run_id_node_id_pk primary key (run_id, node_id)
    )
  `;
  await admin`
    create table public.moka_run_control_node_artifact (
      content text not null,
      content_type text,
      name text not null,
      node_id text not null,
      recorded_at timestamp with time zone default now() not null,
      run_id text not null references public.moka_run_control_run(run_id),
      constraint moka_run_control_node_artifact_run_id_node_id_name_pk primary key (run_id, node_id, name)
    )
  `;
  await admin`
    insert into public.moka_durable_run (run_id)
    values ('legacy-upgrade-run')
  `;
  await admin`
    insert into public.moka_durable_node_record (
      criteria,
      inputs,
      node_id,
      result,
      run_id,
      status
    )
    values (
      ${admin.json(LEGACY_DURABLE_RECORD.criteria)},
      ${admin.json(LEGACY_DURABLE_RECORD.inputs)},
      'legacy-node',
      ${admin.json(LEGACY_DURABLE_RECORD.result)},
      'legacy-upgrade-run',
      'passed'
    )
  `;
  await admin`
    insert into public.moka_run_control_run (manifest, run_id)
    values (
      ${admin.json({
        effort: "normal",
        events: [],
        mode: "write",
        nodes: { "legacy-node": "queued" },
        runId: "legacy-upgrade-run",
        staleDetection: {
          heartbeatIntervalMs: 30_000,
          nodeStaleAfterMs: 120_000,
        },
        status: "queued",
        target: "local",
      })},
      'legacy-upgrade-run'
    )
  `;
  await admin`
    insert into public.moka_run_control_node_session (node_id, run_id, session_id)
    values ('legacy-node', 'legacy-upgrade-run', 'legacy-session')
  `;
};

describePg("Postgres substrate auto-migrates on store resolution", () => {
  const dbUrl = PG_URL;
  let admin = Option.none<postgres.Sql>();

  const openAdmin = (): postgres.Sql => {
    const client = postgres(dbUrl, { max: 1 });
    admin = Option.some(client);
    return client;
  };

  const adminConnection = (): postgres.Sql =>
    Option.match(admin, {
      onNone: openAdmin,
      onSome: (client) => client,
    });

  afterAll(async () => {
    if (Option.isSome(admin)) {
      await admin.value.end();
    }
  });

  it("resolveRunControlStore provisions the schema from an empty database", async () => {
    const adminClient = openAdmin();
    await resetSubstrateSchemas(adminClient);

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

    const schemas = await readSubstrateTableSchemas(adminClient);
    expect(schemas).toEqual(
      new Map(SUBSTRATE_TABLES.map((table) => [table, MOKA_POSTGRES_SCHEMA]))
    );
    expect(schemas.get("moka_run_control_run")).toBe(MOKA_POSTGRES_SCHEMA);
    const publicTables = await adminClient<{ table_name: string }[]>`
      select table_name
      from information_schema.tables
      where table_schema = 'public' and table_name like 'moka_%'
    `;
    expect(publicTables).toEqual([]);

    await adminClient`
      delete from ${adminClient(MOKA_POSTGRES_SCHEMA)}.moka_run_control_run
      where run_id = 'auto-migrate-rc-check'
    `;
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

  it("dedicated moka role cannot create, alter, or drop public tables", async () => {
    const adminClient = adminConnection();
    await resetSubstrateSchemas(adminClient);
    const roleName = testRoleName();
    const publicTable = "pipeline_console_owned";
    await adminClient`create role ${adminClient(roleName)}`;
    try {
      await adminClient`grant ${adminClient(roleName)} to ${adminClient(await currentUser(adminClient))}`;
      await adminClient`create table public.pipeline_console_owned (id integer primary key)`;
      await adminClient`create schema ${adminClient(MOKA_POSTGRES_SCHEMA)} authorization ${adminClient(roleName)}`;
      await adminClient`grant usage on schema public to ${adminClient(roleName)}`;
      await adminClient`grant usage, create on schema ${adminClient(MOKA_POSTGRES_SCHEMA)} to ${adminClient(roleName)}`;
      await adminClient`revoke create on schema public from public`;
      await adminClient`revoke create on schema public from ${adminClient(roleName)}`;

      await runWithRole(adminClient, roleName, async () => {
        await expectPermissionDenied(
          adminClient`create table public.moka_forbidden_create (id integer)`
        );
        await expectPermissionDenied(
          adminClient`
            alter table public.pipeline_console_owned
            add column touched_by_moka integer
          `
        );
        await expectPermissionDenied(
          adminClient`drop table public.pipeline_console_owned`
        );
      });

      const rows = await adminClient<{ table_name: string }[]>`
        select table_name from information_schema.tables
        where table_schema = 'public' and table_name = ${publicTable}
      `;
      expect(rows.map((row) => row.table_name)).toEqual([publicTable]);
    } finally {
      await adminClient`drop owned by ${adminClient(roleName)}`;
      await adminClient`drop schema if exists ${adminClient(MOKA_POSTGRES_SCHEMA)} cascade`;
      await adminClient`drop table if exists public.pipeline_console_owned`;
      await adminClient`drop role if exists ${adminClient(roleName)}`;
    }
  });

  it("moves existing public moka tables into the moka schema without data loss", async () => {
    const adminClient = adminConnection();
    await resetSubstrateSchemas(adminClient);
    await seedLegacyPublicLayout(adminClient);

    await migratePostgresSubstrate(dbUrl);

    const schemas = await readSubstrateTableSchemas(adminClient);
    expect(schemas).toEqual(
      new Map(SUBSTRATE_TABLES.map((table) => [table, MOKA_POSTGRES_SCHEMA]))
    );
    const publicTables = await adminClient<{ table_name: string }[]>`
      select table_name
      from information_schema.tables
      where table_schema = 'public' and table_name like 'moka_%'
    `;
    expect(publicTables).toEqual([]);

    const durableRows = await adminClient<
      { criteria: unknown; inputs: unknown; result: unknown; run_id: string }[]
    >`
      select criteria, inputs, result, run_id
      from ${adminClient(MOKA_POSTGRES_SCHEMA)}.moka_durable_node_record
      where run_id = 'legacy-upgrade-run' and node_id = 'legacy-node'
    `;
    expect(durableRows).toEqual([
      {
        criteria: LEGACY_DURABLE_RECORD.criteria,
        inputs: LEGACY_DURABLE_RECORD.inputs,
        result: LEGACY_DURABLE_RECORD.result,
        run_id: "legacy-upgrade-run",
      },
    ]);
    const sessionRows = await adminClient<{ session_id: string }[]>`
      select session_id
      from ${adminClient(MOKA_POSTGRES_SCHEMA)}.moka_run_control_node_session
      where run_id = 'legacy-upgrade-run' and node_id = 'legacy-node'
    `;
    expect(sessionRows).toEqual([{ session_id: "legacy-session" }]);
  });
});
