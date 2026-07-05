import { fileURLToPath } from "node:url";

import { readMigrationFiles } from "drizzle-orm/migrator";
import type { MigrationMeta } from "drizzle-orm/migrator";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { isSome, none, some, type Option } from "effect/Option";
import postgres from "postgres";

import { MOKA_POSTGRES_SCHEMA } from "./schema";

const migrationsFolder = fileURLToPath(new URL("migrations", import.meta.url));

// drizzle-orm's migrate() has no built-in protection against concurrent
// execution (drizzle-team/drizzle-orm#874) -- every store resolution (one per
// node, potentially many concurrent pods per run) calls this, so callers must
// serialize themselves. Session-level advisory lock, released before the
// connection closes; arbitrary fixed key, unique to this migration.
const MIGRATION_LOCK_KEY = 8_942_017;
const DRIZZLE_MIGRATIONS_TABLE = "__drizzle_migrations";

const LEGACY_TABLE_MOVE_ORDER: readonly string[] = [
  "moka_durable_run",
  "moka_durable_node_record",
  "moka_run_control_run",
  "moka_run_control_event",
  "moka_run_control_node_session",
  "moka_run_control_node_artifact",
];

interface LegacyMigrationGroup {
  journalIndex: number;
  tableNames: readonly string[];
}

const LEGACY_MIGRATION_GROUPS: readonly LegacyMigrationGroup[] = [
  {
    journalIndex: 0,
    tableNames: ["moka_durable_run", "moka_durable_node_record"],
  },
  {
    journalIndex: 1,
    tableNames: [
      "moka_run_control_run",
      "moka_run_control_event",
      "moka_run_control_node_session",
      "moka_run_control_node_artifact",
    ],
  },
];

type PgClient = postgres.Sql | postgres.TransactionSql;
type PgRootClient = postgres.Sql;

const firstTextField = (
  rows: readonly Record<string, unknown>[],
  field: string
): Option<string> => {
  const value = rows.at(0)?.[field];
  return typeof value === "string" ? some(value) : none();
};

const relationExists = async (
  client: PgClient,
  schemaName: string,
  relationName: string
): Promise<boolean> => {
  const rows = await client<Record<string, unknown>[]>`
    select to_regclass(${`${schemaName}.${relationName}`})::text as relation
  `;
  return isSome(firstTextField(rows, "relation"));
};

const schemaExists = async (
  client: PgClient,
  schemaName: string
): Promise<boolean> => {
  const rows = await client<Record<string, unknown>[]>`
    select to_regnamespace(${schemaName})::text as schema_name
  `;
  return isSome(firstTextField(rows, "schema_name"));
};

const ensureMokaSchema = async (client: PgClient): Promise<void> => {
  if (await schemaExists(client, MOKA_POSTGRES_SCHEMA)) {
    return;
  }
  await client`create schema ${client(MOKA_POSTGRES_SCHEMA)}`;
};

const ensureMokaMigrationLedger = async (client: PgClient): Promise<void> => {
  await ensureMokaSchema(client);
  await client`
    create table if not exists ${client(MOKA_POSTGRES_SCHEMA)}.${client(DRIZZLE_MIGRATIONS_TABLE)} (
      id serial primary key,
      hash text not null,
      created_at bigint
    )
  `;
};

const copyLegacyDrizzleLedger = async (client: PgClient): Promise<void> => {
  const legacyLedgerExists = await relationExists(
    client,
    "drizzle",
    DRIZZLE_MIGRATIONS_TABLE
  );
  if (!legacyLedgerExists) {
    return;
  }

  await client`
    insert into ${client(MOKA_POSTGRES_SCHEMA)}.${client(DRIZZLE_MIGRATIONS_TABLE)} (hash, created_at)
    select source.hash, source.created_at
    from ${client("drizzle")}.${client(DRIZZLE_MIGRATIONS_TABLE)} source
    where not exists (
      select 1
      from ${client(MOKA_POSTGRES_SCHEMA)}.${client(DRIZZLE_MIGRATIONS_TABLE)} target
      where target.created_at = source.created_at
    )
  `;
};

const moveLegacyPublicTables = async (client: PgClient): Promise<void> => {
  for (const tableName of LEGACY_TABLE_MOVE_ORDER) {
    const sourceExists = await relationExists(client, "public", tableName);
    if (!sourceExists) {
      continue;
    }
    const targetExists = await relationExists(
      client,
      MOKA_POSTGRES_SCHEMA,
      tableName
    );
    if (targetExists) {
      throw new Error(
        `Cannot move public.${tableName} into ${MOKA_POSTGRES_SCHEMA}: target table already exists.`
      );
    }
    await client`
      alter table ${client("public")}.${client(tableName)}
      set schema ${client(MOKA_POSTGRES_SCHEMA)}
    `;
  }
};

const groupTablesExist = async (
  client: PgClient,
  tableNames: readonly string[]
): Promise<boolean> => {
  const checks = await Promise.all(
    tableNames.map(
      async (tableName) =>
        await relationExists(client, MOKA_POSTGRES_SCHEMA, tableName)
    )
  );
  return checks.every(Boolean);
};

const migrationAt = (
  migrations: readonly MigrationMeta[],
  index: number
): MigrationMeta => {
  const migration = migrations.at(index);
  if (migration === undefined) {
    throw new Error(`Missing Drizzle migration at journal index ${index}.`);
  }
  return migration;
};

const markMigrationApplied = async (
  client: PgClient,
  migration: MigrationMeta
): Promise<void> => {
  await client`
    insert into ${client(MOKA_POSTGRES_SCHEMA)}.${client(DRIZZLE_MIGRATIONS_TABLE)} (hash, created_at)
    select ${migration.hash}, ${migration.folderMillis}
    where not exists (
      select 1
      from ${client(MOKA_POSTGRES_SCHEMA)}.${client(DRIZZLE_MIGRATIONS_TABLE)}
      where created_at = ${migration.folderMillis}
    )
  `;
};

const markExistingMokaLayoutMigrations = async (
  client: PgClient
): Promise<void> => {
  const migrations = readMigrationFiles({ migrationsFolder });
  for (const group of LEGACY_MIGRATION_GROUPS) {
    if (await groupTablesExist(client, group.tableNames)) {
      await markMigrationApplied(
        client,
        migrationAt(migrations, group.journalIndex)
      );
    }
  }
};

const prepareMokaSchema = async (client: PgRootClient): Promise<void> => {
  await client.begin(async (tx) => {
    await ensureMokaMigrationLedger(tx);
    await copyLegacyDrizzleLedger(tx);
    await moveLegacyPublicTables(tx);
    await markExistingMokaLayoutMigrations(tx);
  });
};

/**
 * Apply the Drizzle migrations shared by the run-control and durable stores to
 * `dbUrl`. Idempotent (Drizzle tracks applied migrations in the `moka`
 * schema) and safe under concurrent callers (Postgres advisory lock serializes
 * them). Opens and closes its own single-connection client.
 */
export const migratePostgresSubstrate = async (
  dbUrl: string
): Promise<void> => {
  const client = postgres(dbUrl, { max: 1 });
  try {
    await client`select pg_advisory_lock(${MIGRATION_LOCK_KEY}::bigint)`;
    try {
      await client`set search_path to ${client(MOKA_POSTGRES_SCHEMA)}, pg_catalog`;
      await prepareMokaSchema(client);
      await migrate(drizzle(client), {
        migrationsFolder,
        migrationsSchema: MOKA_POSTGRES_SCHEMA,
      });
    } finally {
      await client`select pg_advisory_unlock(${MIGRATION_LOCK_KEY}::bigint)`;
    }
  } finally {
    await client.end();
  }
};
