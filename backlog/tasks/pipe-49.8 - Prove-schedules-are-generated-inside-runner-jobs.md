---
id: PIPE-49.8
title: Prove schedules are generated inside runner jobs
status: Done
assignee: []
created_date: "2026-06-05 12:27"
updated_date: "2026-07-04 19:42"
labels:
  - runner-job
  - schedule
  - artifacts
dependencies: []
references:
  - src/planning/generate.ts
  - src/runner-command/pre-schedule.ts
  - tests/runner-pre-schedule.test.ts
  - tests/dogfood-installed.test.ts
  - tests/schedule-planner-boundaries.test.ts
modified_files:
  - tests
parent_task_id: PIPE-49
priority: high
ordinal: 124000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->

Verify scheduled entrypoints used by runner-job generate ticket-specific schedules and run artifacts inside the clean workspace instead of requiring precommitted schedule files.

<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->

- [x] #1 A clean workspace scheduled run generates .pipeline/runs/<runId>/schedule.yaml inside /workspace.
- [x] #2 Runner-job does not require a ticket-specific schedule in the repository before execution.
- [x] #3 Generated schedule validation/explain coverage runs against the in-job artifact.
- [x] #4 Schedule planner remains unaware of Kubernetes and /workspace conventions.
- [x] #5 Tests or dogfood evidence inspect the generated schedule artifact.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->

Add focused runner-job/runtime coverage around scheduled entrypoints and assert artifact paths live under the prepared workspace.

<!-- SECTION:PLAN:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->

Done. Schedules are generated in-job under the prepared workspace. Ticket refs are stale: the planner moved to src/planning/generate.ts (+ src/schedule/) and the in-job entrypoint is src/runner-command/pre-schedule.ts.

Evidence:

- AC#1 clean workspace generates .pipeline/runs/<id>/schedule.yaml inside the workspace — scheduleArtifactPath() returns join(worktreePath, ".pipeline", "runs", scheduleId, "schedule.yaml") (src/planning/generate.ts:419-423); compileScheduleArtifact mkdirSync's that dir and writes it (src/planning/generate.ts:409-412). dogfood-installed.test.ts:554 asserts a generated .pipeline/runs/run-pc37-dogfood/schedule.yaml.
- AC#2 no precommitted ticket schedule required — src/runner-command/pre-schedule.ts drives the pre-research/pre-planning/pre-generate-schedule phases and produces a dynamic schedule artifact from the payload TicketPlan; the file-schedule source is optional (src/runner-command/schedule-source-options.ts, requireScheduleFileForFileSource).
- AC#3 validation/explain over the in-job artifact — tests/dogfood-installed.test.ts:447 "validates and explains ticket-accurate epic schedules ... through the CLI" runs the explain-plan CLI (src/cli/plan-commands.ts:55) against the generated artifact.
- AC#4 planner is k8s/workspace-agnostic — worktreePath is a plain injected parameter; module boundaries asserted by tests/schedule-planner-boundaries.test.ts (generate barrel + schedule passes, no k8s imports).
- AC#5 tests inspect the generated artifact — tests/runner-pre-schedule.test.ts (pre-schedule phase seeds run + records status) and dogfood-installed.test.ts (reads generated schedule.yaml).
<!-- SECTION:FINAL_SUMMARY:END -->
