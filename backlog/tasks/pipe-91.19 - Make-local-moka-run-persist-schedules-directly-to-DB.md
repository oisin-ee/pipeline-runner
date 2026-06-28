---
id: PIPE-91.19
title: Make local moka run persist schedules directly to DB
status: To Do
assignee: []
created_date: '2026-06-28 09:04'
labels: []
dependencies:
  - PIPE-91.17
  - PIPE-91.18
references:
  - src/cli/run-service.ts
  - src/runtime/journal-acquisition.ts
  - tests/moka-resume-schedule.test.ts
modified_files:
  - src/cli/run-service.ts
  - src/run-control/detach.ts
  - tests/cli.test.ts
  - tests/detached-run.test.ts
  - tests/moka-resume-schedule.test.ts
parent_task_id: PIPE-91
priority: high
ordinal: 317000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Workflow: feature-implementation
Scope: migrate local supervised and detached moka run paths from .pipeline/runs schedule handoff to in-memory schedule YAML persisted through RunControlStore.createRun({ schedule }).
Dependencies: PIPE-91.17, PIPE-91.18
Likely modified files: src/cli/run-service.ts; src/run-control/detach.ts; tests/cli.test.ts; tests/detached-run.test.ts; tests/moka-resume-schedule.test.ts
Escalation: report Met/Unmet criteria with evidence/blocker.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Scheduled local run uses generated in-memory YAML and never writes or reads .pipeline/runs/<runId>/schedule.yaml -- Evidence: focused CLI test asserts no .pipeline directory is created and output no longer says Schedule generated: .pipeline/runs/...
- [ ] #2 RunControlStore.createRun receives the serialized schedule before execution for both supervised and detached paths -- Evidence: tests assert manifest.schedule is populated in the DB-backed store for generated and explicit schedules
- [ ] #3 moka resume rebuilds the graph from manifest.schedule and does not depend on a worktree schedule file -- Evidence: moka-resume-schedule test kills a custom generated schedule, resumes from DB, and runs only unfinished nodes
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Run the ticket's global-rules workflow in order
- [ ] #2 Run bun test tests/cli.test.ts tests/detached-run.test.ts tests/moka-resume-schedule.test.ts and bun run typecheck; record output
<!-- DOD:END -->
