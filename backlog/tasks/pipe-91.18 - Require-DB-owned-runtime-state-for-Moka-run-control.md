---
id: PIPE-91.18
title: Require DB-owned runtime state for Moka run-control
status: Done
assignee: []
created_date: '2026-06-28 09:04'
updated_date: '2026-06-28 09:49'
labels: []
dependencies: []
references:
  - src/run-control/run-control-store.ts
  - src/runtime/durable-store/acquisition.ts
  - src/moka-global-config.ts
modified_files:
  - src/moka-global-config.ts
  - src/run-control/run-control-store.ts
  - src/runtime/durable-store/acquisition.ts
  - src/run-control/command-context.ts
  - src/cli/run-service.ts
parent_task_id: PIPE-91
priority: high
ordinal: 316000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Workflow: feature-implementation
Scope: make default Moka run-control and durable node-result paths require momokaya.db.url for stateful orchestration, eliminating workspace .pipeline/runs/.pipeline/journal fallbacks from run, next-node, submit-result, and resume entrypoints.
Dependencies: none
Likely modified files: src/moka-global-config.ts; src/run-control/run-control-store.ts; src/runtime/durable-store/acquisition.ts; src/run-control/command-context.ts; src/cli/run-service.ts; tests/run-control*.test.ts
Escalation: report Met/Unmet criteria with evidence/blocker.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Stateful Moka commands fail fast with a clear db.url-required error when momokaya.db.url is absent, before creating .pipeline or run-state files -- Evidence: CLI/integration test runs scheduled moka command in temp git repo with no db.url and asserts nonzero error plus no .pipeline path exists
- [x] #2 When db.url is present, run-control uses Postgres store and durable node results use Postgres store; no workspace filesystem store is selected by default runtime commands -- Evidence: tests spy/inspect resolveRunControlStore and resolveDurableStore branches; rg shows default command paths no longer call fileRunControlStore for runtime state
- [x] #3 Filesystem-backed run-control code remains only for explicitly named legacy/test fixtures, not default Moka orchestration -- Evidence: source grep and tests document any remaining file-store call sites
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Implemented required DB-owned runtime-state policy. resolveRunControlStore and resolveDurableStore now fail with db.url-required when momokaya.db.url is absent; runtime reporter/supervisor require explicit store injection; filesystem/in-memory adapters remain explicit legacy/test fixtures only.

Evidence:
- bunx vitest run tests/run-control-store-cutover.test.ts tests/next-node-submit-result-pg.test.ts tests/run-control-commands.test.ts tests/moka-run-cli-resolver.test.ts tests/moka-run-db-url-required.test.ts tests/run-control-runtime-reporter.test.ts tests/run-control-heartbeats.test.ts => 33 pass, 3 skipped live-PG cases
- bun run typecheck => tsc --noEmit exit 0
- bun run check => ultracite checked 469 files, no fixes
- git diff --check => clean
- rg audit: default resolvers require db.url; fileRunControlStore/inMemoryDurableRunStore remain direct explicit test/legacy adapters; next-node/submit-result/runtime journal call the required resolvers.
<!-- SECTION:FINAL_SUMMARY:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [x] #1 Run the ticket's global-rules workflow in order
- [x] #2 Run focused run-control/durable-store tests plus bun run typecheck; record output
<!-- DOD:END -->
