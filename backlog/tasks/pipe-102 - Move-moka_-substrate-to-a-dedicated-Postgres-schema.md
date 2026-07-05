---
id: PIPE-102
title: Move moka_* substrate to a dedicated Postgres schema
status: Done
assignee: []
created_date: "2026-07-02 14:31"
updated_date: "2026-07-02 17:48"
labels: []
dependencies: []
references:
  - src/run-control/postgres/schema.ts
  - src/runtime/durable-store/postgres/schema.ts
  - src/runtime/durable-store/postgres/migrate-substrate.ts
  - drizzle.config.ts
  - "https://orm.drizzle.team/docs/sql-schema-declaration"
modified_files:
  - src/run-control/postgres/schema.ts
  - src/runtime/durable-store/postgres/schema.ts
  - src/runtime/durable-store/postgres/migrate-substrate.ts
  - src/runtime/durable-store/postgres/migrations/
  - drizzle.config.ts
  - tests/postgres-substrate-auto-migrate.test.ts
  - src/runtime/durable-store/postgres/postgres-store.test.ts
  - src/run-control/postgres/postgres-run-control-store.test.ts
  - docs/adr-moka-postgres-schema-isolation.md
priority: medium
ordinal: 339000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->

Workflow: security
What to build: Isolate moka's durable/run-control substrate into a dedicated Postgres schema and role so runner auto-migrations cannot mutate pipeline-console application tables in public.
Scope: Drizzle schema ownership, migration generation/application, runtime migrator search_path/schema handling, test Postgres grant assertions, existing public-table upgrade path, and ADR.
Dependencies / Blocked by: None - can start immediately.
Likely modified files: src/run-control/postgres/schema.ts, src/runtime/durable-store/postgres/schema.ts, src/runtime/durable-store/postgres/migrate-substrate.ts, src/runtime/durable-store/postgres/migrations/, drizzle.config.ts, tests/postgres-substrate-auto-migrate.test.ts, src/runtime/durable-store/postgres/postgres-store.test.ts, src/run-control/postgres/postgres-run-control-store.test.ts, docs/adr-moka-postgres-schema-isolation.md.
Research required: Drizzle `pgSchema` and migration-generation support; Postgres `search_path`, schema grants, default privileges, and safe table move/upgrade SQL.
Model recommendation:

- Claude: unknown -- no Claude model inventory evidenced in this Codex session.
- Codex: gpt-5.5-xhigh -- multi_agent_v1 metadata exposes gpt-5.5 with xhigh reasoning; choose xhigh because this is database isolation/security plus migration/upgrade work.
- OpenCode: moka-code-writer/default -- defaults/profiles.yaml defines moka-code-writer and defaults/pipeline.yaml routes implementation through broker/gpt-5.5 fallbacks; dispatch must revalidate live availability.
  Implementation decisions:
- Use a dedicated schema name such as `moka` and a dedicated role/connection whose privileges are limited to that schema.
- MOKA_DB_URL should target the schema through search_path or equivalent connection option; migrations may still run at pod start only if they cannot touch public.
- Provide an explicit migration path from existing public `moka_durable_*` and `moka_run_control_*` tables to the `moka` schema. Do not drop existing data.
- Record ADR because this decision is cross-repo, security-sensitive, and costly to reverse.
  Escalation:
- Met: every AC below with command output.
- Unmet: criterion id, failing command/output, migration/grant SQL attempted, and whether blocker is Drizzle, Postgres privileges, or live test DB access.
Origin: pipeline-console target-state spec (pipeline-console/backlog/docs/doc-8), 2026-07-02 audit.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->

- [x] #1 All moka\_\* tables are created in the moka schema for fresh installs -- Evidence: migration test against test Postgres queries information_schema/table_schema.
- [x] #2 Dedicated moka role cannot create/alter/drop tables in public -- Evidence: grant assertion test against test Postgres with expected permission failure.
- [x] #3 Existing public moka\_\* tables migrate into the moka schema without data loss -- Evidence: upgrade test seeds current public layout, runs migrator, and reads rows from moka schema.
- [x] #4 ADR records schema/role/search_path decision and rollback/upgrade notes -- Evidence: docs ADR added and referenced from this ticket.
<!-- AC:END -->

## Definition of Done

<!-- DOD:BEGIN -->

- [x] #1 The security workflow was run in order, including trust boundary and attacker/accidental-writer analysis.
- [x] #2 `MOKA_PG_TEST_URL=<test-db> bun run test -- tests/postgres-substrate-auto-migrate.test.ts src/runtime/durable-store/postgres/postgres-store.test.ts src/run-control/postgres/postgres-run-control-store.test.ts` passed, or live-DB blocker recorded with narrower local proof.
- [x] #3 `bun run typecheck` passed.
- [x] #4 `bun run check` passed.
- [x] #5 ADR recorded.
<!-- DOD:END -->
