---
id: PIPE-19.9
title: 'Implement deterministic gates, artifacts, retries, and schema validation'
status: To Do
assignee: []
created_date: '2026-05-24 14:18'
updated_date: '2026-05-24 14:18'
labels:
  - pipeline
  - gates
  - verification
dependencies:
  - PIPE-19.1
  - PIPE-19.3
references:
  - src/mastra/gates.ts
  - src/mastra/pipeline-primitive.ts
parent_task_id: PIPE-19
priority: high
ordinal: 28000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Build the deterministic control layer around agent execution. Gates must evaluate objective evidence such as command exit codes, tests, typecheck, duplication checks, artifact existence, and JSON Schema validation. Agent self-reporting must not be enough to pass a gate.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Gates can evaluate command exit expectations, required artifacts, JSON Schema validation, and built-in test/typecheck/duplication checks.
- [ ] #2 Retries are configured per node and are driven by gate outcomes or execution failures.
- [ ] #3 Gate results are recorded with evidence that can be inspected after the run.
- [ ] #4 A failing gate blocks dependent nodes unless the workflow explicitly defines another path.
- [ ] #5 Tests cover passing gates, failing gates, retries, schema failures, missing artifacts, and dependent-node blocking.
<!-- AC:END -->
