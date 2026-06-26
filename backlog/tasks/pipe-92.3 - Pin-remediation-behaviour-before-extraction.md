---
id: PIPE-92.3
title: Pin remediation behaviour before extraction
status: To Do
assignee: []
created_date: '2026-06-26 22:05'
labels: []
dependencies: []
references:
  - src/pipeline-runtime.ts
  - tests/pipeline-runtime.test.ts
modified_files:
  - tests/pipeline-runtime.test.ts
parent_task_id: PIPE-92
priority: medium
ordinal: 292000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Workflow: feature-implementation
Scope: add or tighten focused tests around current remediation behaviour before moving code. Cover self-remediation, coverage-node upstream remediation, mechanical/builtin remediation prompt content, no-change ancestor handling, and parallel-child implementation ancestor routing.
Dependencies: none
Likely modified files: tests/pipeline-runtime.test.ts or a new focused remediation test file using public runtime seams
Escalation: report Met/Unmet criteria with evidence/blocker.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Focused remediation proof covers self-remediation of a writable node and preserves changed-file gate feedback -- Evidence: test output names the focused case
- [ ] #2 Focused remediation proof covers coverage/mechanical failures remediating upstream implementation nodes, including no-change ancestor and parallel-child ancestor regressions -- Evidence: test output names the focused cases
- [ ] #3 Tests use public runtime seams and do not reach into private pipeline-runtime helpers -- Evidence: source inspection
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Run the feature-implementation workflow in order: research + library-first-development -> inspect existing patterns -> Build Contract -> failing/targeted tests -> implementation -> quality-gate/critique -> verify
- [ ] #2 Proof commands recorded: bun run test tests/pipeline-runtime.test.ts -- -t remediation && bun run typecheck && bun run check
<!-- DOD:END -->
