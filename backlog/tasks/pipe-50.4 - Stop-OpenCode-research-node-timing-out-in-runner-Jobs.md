---
id: PIPE-50.4
title: Stop OpenCode research node timing out in runner Jobs
status: Done
assignee: []
created_date: '2026-06-06 09:12'
updated_date: '2026-06-06 09:27'
labels:
  - runner-job
  - opencode
  - runtime
  - timeout
dependencies: []
references:
  - src/runner.ts
  - src/config.ts
  - src/schedule-planner.ts
modified_files:
  - src/config.ts
  - src/runner.ts
  - tests/config.test.ts
  - tests/runner.test.ts
  - tests/runner-job.test.ts
parent_task_id: PIPE-50
priority: high
ordinal: 133000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Direct OpenCode runner Job runner-direct-20260606085245-opencode failed in research-current-club with evidence: profile=pipeline-researcher runner=opencode, normalized runner output from OpenCode JSON events, agent timed out, node exited with code 1. The Job had already cloned, generated a schedule, posted events, and launched OpenCode; the blocker is OpenCode runtime/profile execution behavior.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The OpenCode package default runner/profile path has an explicit timeout appropriate for Rondo feature-ticket research or a bounded research prompt that completes within the existing timeout.
- [x] #2 A focused live-runner or mocked-runner regression covers OpenCode timeout handling and reports the failing node/profile clearly.
- [x] #3 A rerun of direct no-console OpenCode runner dogfood reaches at least the next phase after research, or fails with a non-timeout actionable runtime error.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Inspect OpenCode runner invocation, default node timeout, and generated schedule prompts for runner jobs. Adjust timeout/prompt/output handling at the package default seam, then verify with an OpenCode runner smoke before rerunning Kubernetes dogfood.
<!-- SECTION:PLAN:END -->
