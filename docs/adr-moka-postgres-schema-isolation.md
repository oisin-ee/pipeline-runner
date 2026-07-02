# ADR: Moka Postgres Schema Isolation

Date: 2026-07-02

Status: Accepted

## Context

Moka's durable store and run-control store use Postgres as shared substrate. The same cluster can also host
pipeline-console application tables in `public`. Before PIPE-102, Drizzle table definitions and migrations created
`moka_durable_*` and `moka_run_control_*` tables in `public`, so an automatic runner migration could accidentally
create or change objects in the application schema.

Trust boundary:

- Trusted input: `MOKA_DB_URL` as deploy configuration pointing at the intended database role.
- Attacker or accidental-writer input: role grants, `search_path`, old public `moka_*` tables, and future migration SQL.
- Protected asset: non-moka application tables in `public`.

## Decision

All Moka substrate tables live in the dedicated Postgres schema `moka`. Drizzle schema declarations use
`pgSchema("moka")`, and the runtime migrator sets `search_path` to `moka, pg_catalog` before applying migrations.
The Drizzle migration ledger is stored in `moka.__drizzle_migrations` via the official `migrationsSchema` option.

The intended runtime role should have:

- `USAGE` and `CREATE` on schema `moka`.
- No `CREATE` on schema `public`.
- No ownership or DDL grants on pipeline-console tables in `public`.

The role may own old public `moka_*` tables during upgrade so the migrator can move those known tables into `moka`.
That ownership is not a grant to mutate unrelated public tables.

## Upgrade

`migratePostgresSubstrate` runs a preflight under the existing advisory lock:

1. Ensure schema `moka` and `moka.__drizzle_migrations` exist.
2. Copy rows from the old `drizzle.__drizzle_migrations` ledger when present.
3. Move known public `moka_durable_*` and `moka_run_control_*` tables into `moka` with `ALTER TABLE ... SET SCHEMA`.
4. Mark the old Drizzle migrations applied when the expected tables already exist in `moka`.
5. Run Drizzle migrations with `migrationsSchema: "moka"`.

If both `public.<moka_table>` and `moka.<moka_table>` exist, migration fails instead of merging or dropping data. That
preserves data and forces manual reconciliation of a split-brain layout.

## Rollback

Rollback is a Git revert plus database restore if the schema move has already run. Moving tables back to `public` is
possible with `ALTER TABLE moka.<table> SET SCHEMA public`, but should only be done from a database backup or an
operator-reviewed rollback because application safety depends on the runtime role not regaining broad public DDL.

## Consequences

Fresh installs create Moka tables in `moka`, not `public`. Existing public layouts get an in-place table move without
row copy or data loss. Future migrations must keep schema-qualified Drizzle declarations and keep the runtime role's
public grants restricted.
