---
id: PIPE-50.6
title: Force OpenCode schedule planner output to package schema
status: Done
assignee: []
created_date: "2026-06-06 09:54"
updated_date: "2026-06-06 10:18"
labels:
  - runner-job
  - opencode
  - schedule-planner
  - schema
dependencies: []
references:
  - src/schedule-planner.ts
  - src/config.ts
  - tests/schedule-planner.test.ts
modified_files:
  - src/schedule-planner.ts
  - tests/schedule-planner.test.ts
parent_task_id: PIPE-50
priority: high
ordinal: 135000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->

Direct no-console OpenCode runner Job `runner-50-4-20260606095012-opencode` used published image digest `sha256:5c0045e29abdf5b8201453314a40406f06e55a8df16d7948a0113837f04e2a3f` and did not hit the old OpenCode timeout. It failed at schedule validation because the OpenCode schedule planner emitted invalid package schema: command nodes used scalar `command` strings instead of string arrays, and agent nodes included unsupported node-level `instructions` fields.

<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->

- [x] #1 The schedule planner prompt and/or parser boundary prevents generated command nodes with scalar `command` values.
- [x] #2 The schedule planner prompt and/or parser boundary prevents generated workflow nodes from including unsupported `instructions` fields.
- [x] #3 A regression test covers the OpenCode-style invalid schedule output and proves it is rejected with actionable repair or normalized before execution.
- [x] #4 A direct no-console OpenCode runner Job reaches workflow node execution after schedule generation.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->

Trace the schedule planner output contract, repair/canonicalization path, and generated schedule validation. Fix the package schema boundary so OpenCode cannot produce syntactically plausible but invalid schedule YAML that blocks runner jobs before workflow execution.

<!-- SECTION:PLAN:END -->

## Verification

<!-- SECTION:VERIFICATION:BEGIN -->

- Commit `81e58909580a7f4eef108cbaf41093ee0dfe6d84` added an explicit planner node-schema contract plus one bounded schedule repair pass through the configured planner profile. The repaired artifact still goes through strict `parseScheduleArtifact`, id canonicalization, validation, and compile before execution.
- Local verification passed: `bun test tests/schedule-planner.test.ts`, `bun run typecheck`, `bun run check`, `bun run build`, and `bun run test` (`vitest run`, 425 passed / 8 skipped).
- GitHub Actions Release run `27059292873` passed release and Publish runner image jobs. `ghcr.io/oisin-ee/pipeline-runner:81e58909580a7f4eef108cbaf41093ee0dfe6d84` and `:latest` both resolved to digest `sha256:254a5f0e0b8de3d9c18ca8bbd1841982679506551d9aa068a69d06670e5b0205`.
- Direct no-console OpenCode Kubernetes Job `runner-50-6-202606061004-opencode` in namespace `momokaya-pipeline` used `ghcr.io/oisin-ee/pipeline-runner:latest`, `imagePullPolicy: Always`, image ID `ghcr.io/oisin-ee/pipeline-runner@sha256:254a5f0e0b8de3d9c18ca8bbd1841982679506551d9aa068a69d06670e5b0205`, and mounted `codex-auth-1`, `opencode-auth-1`, `oisin-bot-github-auth`, `ghcr-pull-secret`, and `pipeline-runner-event-auth` by name.
- The direct Job posted to temporary non-console receiver `runner-events-50-6-202606061004`. Event evidence showed `schedule.generated` at `2026-06-06T10:05:10.401Z`, `workflow.planned` with all nodes using `runnerId: opencode`, `workflow.start`, and `node.start` for `research` at sequence 53. It failed later at `acceptance` gates, not schedule validation.
<!-- SECTION:VERIFICATION:END -->
