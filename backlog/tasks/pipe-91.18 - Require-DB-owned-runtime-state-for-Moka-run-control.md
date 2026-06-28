---
id: PIPE-91.18
title: Require DB-owned runtime state for Moka run-control
status: To Do
assignee: []
created_date: '2026-06-28 09:04'
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
- [ ] #1 Stateful Moka commands fail fast with a clear db.url-required error when momokaya.db.url is absent, before creating .pipeline or run-state files -- Evidence: CLI/integration test runs scheduled moka command in temp git repo with no db.url and asserts nonzero error plus no .pipeline path exists
- [ ] #2 When db.url is present, run-control uses Postgres store and durable node results use Postgres store; no workspace filesystem store is selected by default runtime commands -- Evidence: tests spy/inspect resolveRunControlStore and resolveDurableStore branches; rg shows default command paths no longer call fileRunControlStore for runtime state
- [ ] #3 Filesystem-backed run-control code remains only for explicitly named legacy/test fixtures, not default Moka orchestration -- Evidence: source grep and tests document any remaining file-store call sites
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Run the ticket's global-rules workflow in order
- [ ] #2 Run focused run-control/durable-store tests plus bun run typecheck; record output
<!-- DOD:END -->
