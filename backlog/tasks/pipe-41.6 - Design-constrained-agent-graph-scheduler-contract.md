---
id: PIPE-41.6
title: Design constrained agent-graph scheduler contract
status: Done
assignee: []
created_date: "2026-06-03 18:30"
updated_date: "2026-06-04 09:22"
labels:
  - pipeline
  - schedules
  - design
dependencies:
  - PIPE-41.5
references:
  - src/schedule-planner.ts
  - .pipeline/prompts/schedule-planner.md
  - docs/operator-guide.md
parent_task_id: PIPE-41
priority: high
ordinal: 94000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->

Document the constrained `agent_graph` scheduling contract before implementation. The contract should define what the schedule planner may generate, which inputs it receives, how coverage is represented, and which advanced features are intentionally deferred.

<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->

- [x] #1 The contract lists allowed primitives: configured profile ids, configured workflow ids, embedded workflows, DAG dependencies, gates, worktree roots, and node `task_context`
- [x] #2 The planner input shape is documented: task, baseline artifact, backlog work units, allowed profiles/workflows, gate recipes, and max parallel policy
- [x] #3 Required coverage rules are documented for research, RED/test, implementation, acceptance/verification, and review
- [x] #4 The design explicitly defers node-level skill overrides and requires profile/workflow reuse instead
- [x] #5 The design explains approval-before-execution: generation writes `schedule.yaml` and does not execute workflow nodes
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->

Add a short design note in the operator guide or a focused docs section. Keep it aligned with the schedule planner prompt and validation rules that later tickets implement.

<!-- SECTION:PLAN:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->

Documented the constrained agent-graph scheduler contract, including allowed primitives, planner inputs, coverage rules, deferred node-level skill overrides, and approval-before-execution behavior. Verified during backlog grooming on 2026-06-04 with the full repository verification suite.

<!-- SECTION:FINAL_SUMMARY:END -->
