---
id: PIPE-19.9
title: 'Implement deterministic gates, artifacts, retries, and schema validation'
status: Done
assignee: []
created_date: '2026-05-24 14:18'
updated_date: '2026-05-25 09:44'
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
modified_files:
  - src/mastra/config.ts
  - src/pipeline-runtime.ts
  - tests/pipeline-runtime.test.ts
  - tests/tracer-bullet.test.ts
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
- [x] #1 Gates can evaluate command exit expectations, required artifacts, JSON Schema validation, and built-in test/typecheck/duplication checks.
- [x] #2 Retries are configured per node and are driven by gate outcomes or execution failures.
- [x] #3 Gate results are recorded with evidence that can be inspected after the run.
- [x] #4 A failing gate blocks dependent nodes unless the workflow explicitly defines another path.
- [x] #5 Tests cover passing gates, failing gates, retries, schema failures, missing artifacts, and dependent-node blocking.
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Added runtime gates for commands, artifacts, builtins, retries, and JSON Schema output, with recorded evidence and dependent-node blocking on required failures.
<!-- SECTION:FINAL_SUMMARY:END -->
