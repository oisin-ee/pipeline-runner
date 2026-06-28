---
id: PIPE-91.17
title: Add in-memory schedule generation API
status: To Do
assignee: []
created_date: '2026-06-28 09:04'
labels: []
dependencies: []
references:
  - src/planning/generate.ts
  - src/schedule/baseline.ts
modified_files:
  - src/planning/generate.ts
  - tests/schedule-planner.test.ts
parent_task_id: PIPE-91
priority: high
ordinal: 315000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Workflow: feature-implementation
Scope: introduce a schedule-generation API that returns ScheduleArtifact + serialized YAML without writing .pipeline/runs, while keeping any legacy writer isolated until downstream consumers migrate.
Dependencies: none
Likely modified files: src/planning/generate.ts; tests/schedule-planner.test.ts
Escalation: report Met/Unmet criteria with evidence/blocker.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Schedule generation can produce artifact + YAML entirely in memory with no mkdirSync/writeFileSync/ensurePipelineWorkspaceIgnore side effects -- Evidence: focused schedule-planner test asserts generate-in-memory call leaves no .pipeline directory in a temp repo
- [ ] #2 Existing validation/normalization passes still run before returning generated YAML -- Evidence: focused tests cover invalid generated output repair, task_context hydration, model fallback, and compileScheduleArtifact on returned artifact
- [ ] #3 Legacy file-writing helper is either removed or explicitly isolated from default run paths -- Evidence: rg shows default run/submit paths call the in-memory API, not persistScheduleArtifact
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Run the ticket's global-rules workflow in order
- [ ] #2 Run bun test tests/schedule-planner.test.ts and bun run typecheck; record output
<!-- DOD:END -->
