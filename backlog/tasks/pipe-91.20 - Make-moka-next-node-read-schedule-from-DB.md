---
id: PIPE-91.20
title: Make moka next node read schedule from DB
status: To Do
assignee: []
created_date: '2026-06-28 09:04'
labels: []
dependencies:
  - PIPE-91.19
references:
  - src/run-control/next-node.ts
  - src/run-control/contracts.ts
  - src/runtime/node-protocol/node-protocol.ts
modified_files:
  - src/run-control/next-node.ts
  - src/run-control/commands.ts
  - src/run-control/submit-result.ts
  - tests/next-node-submit-result-pg.test.ts
parent_task_id: PIPE-91
priority: high
ordinal: 318000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Workflow: feature-implementation
Scope: change moka next node from --schedule-file handoff to runId-only DB lookup of manifest.schedule, then compile that schedule and compute next ready node from durable results.
Dependencies: PIPE-91.19
Likely modified files: src/run-control/next-node.ts; src/run-control/commands.ts; src/run-control/submit-result.ts; tests/next-node-submit-result-pg.test.ts; src/run-control/next-node.test.ts
Escalation: report Met/Unmet criteria with evidence/blocker.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 moka next node <runId> works without --schedule-file by reading manifest.schedule from RunControlStore -- Evidence: CLI/unit test seeds DB manifest.schedule and asserts emitted NextNodeEnvelope for first ready node
- [ ] #2 --schedule-file is removed or rejected with migration guidance; no default stepping path accepts repo-local schedule files -- Evidence: command help snapshot and rg show no active --schedule-file requirement for moka next node
- [ ] #3 next-node + submit-result round-trip advances across separate processes using only DB state -- Evidence: Postgres integration test runs next-node, submit-result, next-node from separate invocations and asserts dependent node appears
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Run the ticket's global-rules workflow in order
- [ ] #2 Run bun test tests/next-node-submit-result-pg.test.ts plus next-node focused tests and bun run typecheck; record output
<!-- DOD:END -->
