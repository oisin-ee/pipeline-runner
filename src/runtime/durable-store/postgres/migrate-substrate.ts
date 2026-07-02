import { fileURLToPath } from "node:url";
import { type MigrationMeta, readMigrationFiles } from "drizzle-orm/migrator";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { MOKA_POSTGRES_SCHEMA } from "./schema";

const migrationsFolder = fileURLToPath(
  new URL("./migrations", import.meta.url)
);

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

async function relationExists(
  client: PgClient,
  schemaName: string,
  relationName: string
): Promise<boolean> {
  const rows = await client<{ relation: string | null }[]>`
    select to_regclass(${`${schemaName}.${relationName}`})::text as relation
  `;
  return rows[0]?.relation !== null && rows[0]?.relation !== undefined;
}

async function schemaExists(
  client: PgClient,
  schemaName: string
): Promise<boolean> {
  const rows = await client<{ schema_name: string | null }[]>`
    select to_regnamespace(${schemaName})::text as schema_name
  `;
  return rows[0]?.schema_name !== null && rows[0]?.schema_name !== undefined;
}

async function ensureMokaSchema(client: PgClient): Promise<void> {
  if (await schemaExists(client, MOKA_POSTGRES_SCHEMA)) {
    return;
  }
  await client`create schema ${client(MOKA_POSTGRES_SCHEMA)}`;
}

async function ensureMokaMigrationLedger(client: PgClient): Promise<void> {
  await ensureMokaSchema(client);
  await client`
    create table if not exists ${client(MOKA_POSTGRES_SCHEMA)}.${client(DRIZZLE_MIGRATIONS_TABLE)} (
      id serial primary key,
      hash text not null,
      created_at bigint
    )
  `;
}

async function copyLegacyDrizzleLedger(client: PgClient): Promise<void> {
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
}

async function moveLegacyPublicTables(client: PgClient): Promise<void> {
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
}

async function groupTablesExist(
  client: PgClient,
  tableNames: readonly string[]
): Promise<boolean> {
  const checks = await Promise.all(
    tableNames.map((tableName) =>
      relationExists(client, MOKA_POSTGRES_SCHEMA, tableName)
    )
  );
  return checks.every((exists) => exists);
}

function migrationAt(
  migrations: readonly MigrationMeta[],
  index: number
): MigrationMeta {
  const migration = migrations[index];
  if (migration === undefined) {
    throw new Error(`Missing Drizzle migration at journal index ${index}.`);
  }
  return migration;
}

async function markMigrationApplied(
  client: PgClient,
  migration: MigrationMeta
): Promise<void> {
  await client`
    insert into ${client(MOKA_POSTGRES_SCHEMA)}.${client(DRIZZLE_MIGRATIONS_TABLE)} (hash, created_at)
    select ${migration.hash}, ${migration.folderMillis}
    where not exists (
      select 1
      from ${client(MOKA_POSTGRES_SCHEMA)}.${client(DRIZZLE_MIGRATIONS_TABLE)}
      where created_at = ${migration.folderMillis}
    )
  `;
}

async function markExistingMokaLayoutMigrations(
  client: PgClient
): Promise<void> {
  const migrations = readMigrationFiles({ migrationsFolder });
  for (const group of LEGACY_MIGRATION_GROUPS) {
    if (await groupTablesExist(client, group.tableNames)) {
      await markMigrationApplied(
        client,
        migrationAt(migrations, group.journalIndex)
      );
    }
  }
}

async function prepareMokaSchema(client: PgRootClient): Promise<void> {
  await client.begin(async (tx) => {
    await ensureMokaMigrationLedger(tx);
    await copyLegacyDrizzleLedger(tx);
    await moveLegacyPublicTables(tx);
    await markExistingMokaLayoutMigrations(tx);
  });
}

/**
 * Apply the Drizzle migrations shared by the run-control and durable stores to
 * `dbUrl`. Idempotent (Drizzle tracks applied migrations in the `moka`
 * schema) and safe under concurrent callers (Postgres advisory lock serializes
 * them). Opens and closes its own single-connection client.
 */
export async function migratePostgresSubstrate(dbUrl: string): Promise<void> {
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
}
