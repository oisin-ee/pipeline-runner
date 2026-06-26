---
id: PIPE-91.1
title: Durable run-store contract + in-memory impl (keystone seam)
status: Done
assignee: []
created_date: '2026-06-26 17:20'
updated_date: '2026-06-26 19:14'
labels: []
dependencies: []
references:
  - docs/moka-orchestrator-design.md
modified_files:
  - src/runtime/durable-store/durable-store.ts
  - src/runtime/durable-store/index.ts
parent_task_id: PIPE-91
priority: high
ordinal: 275000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Workflow: feature-implementation
Scope: deep module src/runtime/durable-store/ ({durable-store.ts,.test.ts,index.ts}) defining the persistence interface that generalizes today's RunJournal (src/runtime/run-journal.ts): record / query / resume node records keyed (runId,nodeId) carrying inputs + outputs (RuntimeNodeResult) + criteria. Ship the in-memory impl first (back-compat: byte-identical to no-store, like inMemoryRunJournal). This interface is the swappable seam consumed by the Postgres impl, the journal cutover, and the stepping CLI. Cut FIRST so downstream parallelizes (mirrors Layer A cutting RuntimeGateResult.unmet[] first). KEEP the Effect scheduler — persistence behind the existing journal/runNode seam, NOT a new engine.
Escalation: report Met/Unmet criteria with evidence/blocker.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 DurableRunStore records a node record keyed (runId,nodeId) with inputs+outputs+criteria and reads it back -- Evidence: type def + in-memory impl unit test round-trips a record by (runId,nodeId)
- [ ] #2 resume query returns prior passed node results for a runId (the scheduler resume seed) -- Evidence: unit test seeds 2 passed + 1 failed, asserts resume returns only the passed set (mirrors run-journal passedOnly)
- [ ] #3 Existing RunJournal seam stays satisfiable (superset/adapter) so the scheduler is untouched -- Evidence: pnpm run check green; scheduler.ts unchanged in diff
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Run the feature-implementation workflow in order
- [ ] #2 pnpm run check + durable-store unit tests ran fresh; output recorded
<!-- DOD:END -->
