---
id: PIPE-45.10
title: Shrink runtime facade dependency result lifecycle
status: To Do
assignee: []
created_date: '2026-06-27 14:03'
labels: []
dependencies:
  - PIPE-45.3
  - PIPE-45.4
  - PIPE-45.7
references:
  - src/pipeline-runtime.ts
modified_files:
  - src/pipeline-runtime.ts
  - tests/pipeline-runtime.test.ts
parent_task_id: PIPE-45
priority: high
ordinal: 305000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Workflow: feature-implementation
Scope: Split src/pipeline-runtime.ts into runtime facade, dependency/result mapping, lifecycle execution, journal acquisition, and public error formatting.
Dependencies: PIPE-45.3, PIPE-45.4, PIPE-45.7
Likely modified files: src/pipeline-runtime.ts, src/runtime/workflow/*, tests/pipeline-runtime.test.ts, tests/runtime-*.test.ts
Reuse: Effect runtime substrate remains; existing scheduler/journal modules stay owners.
Escalation: report Met/Unmet criteria with evidence/blocker.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Public ./runtime facade stays compatible while internals move behind owned modules -- Evidence: package API tests and runtime tests pass.
- [ ] #2 src/pipeline-runtime.ts falls below 1k lines or records structural justification -- Evidence: wc/fallow output.
- [ ] #3 No scheduler/runtime semantics drift -- Evidence: focused runtime scheduler tests pass.
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Run feature-implementation workflow in order and record proof.
<!-- DOD:END -->
