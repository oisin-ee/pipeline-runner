---
id: PIPE-19.6
title: Implement native-preferred multi-agent execution engine
status: Done
assignee: []
created_date: '2026-05-24 14:17'
updated_date: '2026-05-25 09:44'
labels:
  - pipeline
  - multi-agent
  - runtime
dependencies:
  - PIPE-19.3
  - PIPE-19.5
  - PIPE-19.8
  - PIPE-19.9
references:
  - src/mastra/pipeline-primitive.ts
  - src/mastra/runner.ts
modified_files:
  - src/pipeline-runtime.ts
  - src/index.ts
  - tests/pipeline-runtime.test.ts
  - tests/tracer-bullet.test.ts
parent_task_id: PIPE-19
priority: high
ordinal: 25000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Replace the current sequential hardcoded primitive with an execution engine that consumes the compiled DAG and executes agent nodes as real separate agents. Native host subagents should be used when they can preserve configured semantics; otherwise the engine must launch a separate subprocess for the node. The engine must never merge a multi-agent workflow into one prompt.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Each agent node execution has a distinct agent invocation boundary recorded in runtime evidence/logs.
- [x] #2 Native subagent execution is preferred when the selected runner supports it and the configured capabilities can be represented safely.
- [x] #3 Subprocess-per-agent execution is used when native subagents cannot preserve runner, model, permissions, skills, MCP access, or output contract semantics.
- [x] #4 Parallelizable nodes can execute concurrently while preserving deterministic dependency and gate ordering.
- [x] #5 Tests assert that a workflow with multiple agent nodes does not execute as one merged prompt.
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Implemented a DAG runtime that records separate agent boundaries, prefers native runner strategy when supported, runs parallel batches, and blocks dependents on execution or gate failure.
<!-- SECTION:FINAL_SUMMARY:END -->
