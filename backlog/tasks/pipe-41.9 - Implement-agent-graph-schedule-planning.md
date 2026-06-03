---
id: PIPE-41.9
title: Implement constrained agent-graph schedule planning
status: To Do
assignee: []
created_date: '2026-06-03 18:33'
labels:
  - pipeline
  - schedules
  - planner
dependencies:
  - PIPE-41.8
references:
  - .pipeline/pipeline.yaml
  - .pipeline/prompts/schedule-planner.md
  - src/pipeline-init.ts
  - src/schedule-planner.ts
  - tests/schedule-planner.test.ts
parent_task_id: PIPE-41
priority: high
ordinal: 97000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Use constrained agent-graph planning for scheduled entrypoints. The configured `baseline` remains as the seed artifact, but there is no separate baseline-refinement planner mode.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Schedule policies no longer accept `planner_strategy`; `baseline` is only the seed artifact for planner generation
- [ ] #2 Checked-in and scaffolded schedules omit obsolete planner strategy config
- [ ] #3 The planner prompt includes backlog work units, allowed profiles/workflows, gate recipes, max parallel policy, and the baseline artifact
- [ ] #4 The prompt requires one implementation assignment per backlog child ticket
- [ ] #5 The planner may choose only existing configured profiles/workflows and must not invent node-level skill overrides
- [ ] #6 Schedule generation still writes `kind: pipeline-schedule` artifacts that compile through `compileScheduleArtifact`
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Remove schedule-strategy branching, enrich the schedule-planner prompt for constrained graph generation, and keep the written artifact format unchanged.
<!-- SECTION:PLAN:END -->
