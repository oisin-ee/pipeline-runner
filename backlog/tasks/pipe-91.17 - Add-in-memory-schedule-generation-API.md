---
id: PIPE-91.17
title: Add in-memory schedule generation API
status: Done
assignee: []
created_date: '2026-06-28 09:04'
updated_date: '2026-06-28 09:32'
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
- [x] #1 Schedule generation can produce artifact + YAML entirely in memory with no mkdirSync/writeFileSync/ensurePipelineWorkspaceIgnore side effects -- Evidence: focused schedule-planner test asserts generate-in-memory call leaves no .pipeline directory in a temp repo
- [x] #2 Existing validation/normalization passes still run before returning generated YAML -- Evidence: focused tests cover invalid generated output repair, task_context hydration, model fallback, and compileScheduleArtifact on returned artifact
- [x] #3 Legacy file-writing helper is either removed or explicitly isolated from default run paths -- Evidence: rg shows default run/submit paths call the in-memory API, not persistScheduleArtifact
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Implemented in-memory schedule generation via generateScheduleArtifactInMemory. Default local run, detached run preparation, and moka submit graph generation consume returned YAML directly; legacy generateScheduleArtifact remains explicit persistence adapter only.

Evidence:
- bun test tests/schedule-planner.test.ts => 33 pass, 0 fail
- bunx vitest run tests/moka-submit.test.ts => 20 pass, 0 fail
- bunx vitest run tests/cli.test.ts -t "generates and executes schedule artifacts" => 1 pass, 52 skipped
- bun run typecheck => tsc --noEmit exit 0
- git diff --check for changed files => clean
- rg audit: default run/submit paths call generateScheduleArtifactInMemory; persistScheduleArtifact only reachable via legacy generateScheduleArtifact.
<!-- SECTION:FINAL_SUMMARY:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [x] #1 Run the ticket's global-rules workflow in order
- [x] #2 Run bun test tests/schedule-planner.test.ts and bun run typecheck; record output
<!-- DOD:END -->
