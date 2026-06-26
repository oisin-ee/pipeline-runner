---
id: PIPE-92.4
title: Extract runtime remediation module
status: To Do
assignee: []
created_date: '2026-06-26 22:06'
labels: []
dependencies:
  - PIPE-92.3
references:
  - src/pipeline-runtime.ts
  - tests/pipeline-runtime.test.ts
  - >-
    backlog/tasks/pipe-57 -
    Refactor-safety-net-pin-engine-behavior-with-golden-tests.md
modified_files:
  - src/runtime/remediation/remediation.ts
  - src/runtime/remediation/index.ts
  - src/pipeline-runtime.ts
  - tests/pipeline-runtime.test.ts
parent_task_id: PIPE-92
priority: medium
ordinal: 293000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Workflow: feature-implementation
Scope: move remediation policy and prompt construction out of src/pipeline-runtime.ts into src/runtime/remediation/ behind a small interface. Preserve one-engine semantics, retry flow, node-state updates, and existing public runtime outputs.
Dependencies: PIPE-92.3
Likely modified files: src/runtime/remediation/remediation.ts, src/runtime/remediation/index.ts, src/pipeline-runtime.ts, tests/pipeline-runtime.test.ts or focused remediation tests
Escalation: report Met/Unmet criteria with evidence/blocker.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 pipeline-runtime delegates remediation through one small remediation interface instead of owning remediation policy inline -- Evidence: source inspection shows one call seam and removed inline helpers
- [ ] #2 Self-remediation, upstream implementation remediation, mechanical/builtin remediation, no-change ancestor, and parallel-child ancestor behaviour remain unchanged -- Evidence: focused remediation tests pass
- [ ] #3 The extracted module owns prompt text and implementation-ancestor selection with explicit dependencies, not hidden mutation spread through pipeline-runtime -- Evidence: module interface review plus tests
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Run the feature-implementation workflow in order: research + library-first-development -> inspect existing patterns -> Build Contract -> targeted tests -> implementation -> quality-gate/critique -> verify
- [ ] #2 Proof commands recorded: bun run test tests/pipeline-runtime.test.ts -- -t remediation && bun run test tests/runtime-retry.test.ts tests/runtime-node-state-tracker.test.ts && bun run typecheck && bun run check
<!-- DOD:END -->
