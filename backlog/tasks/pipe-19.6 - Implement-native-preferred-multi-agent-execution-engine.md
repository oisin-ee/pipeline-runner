---
id: PIPE-19.6
title: Implement native-preferred multi-agent execution engine
status: To Do
assignee: []
created_date: '2026-05-24 14:17'
updated_date: '2026-05-24 14:18'
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
- [ ] #1 Each agent node execution has a distinct agent invocation boundary recorded in runtime evidence/logs.
- [ ] #2 Native subagent execution is preferred when the selected runner supports it and the configured capabilities can be represented safely.
- [ ] #3 Subprocess-per-agent execution is used when native subagents cannot preserve runner, model, permissions, skills, MCP access, or output contract semantics.
- [ ] #4 Parallelizable nodes can execute concurrently while preserving deterministic dependency and gate ordering.
- [ ] #5 Tests assert that a workflow with multiple agent nodes does not execute as one merged prompt.
<!-- AC:END -->
