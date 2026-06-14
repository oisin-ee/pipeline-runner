---
id: PIPE-82.5
title: Enforce per-category fan-out width caps in the scheduler
status: To Do
assignee: []
created_date: '2026-06-14 22:36'
labels:
  - token-engineering
  - scheduler
dependencies:
  - PIPE-82.2
references:
  - /Users/oisin/.claude/plans/federated-sparking-truffle.md
  - src/runtime/scheduler.ts
  - src/planning/compile.ts
modified_files:
  - src/runtime/scheduler.ts
  - src/planning/compile.ts
parent_task_id: PIPE-82
priority: high
ordinal: 215000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Cap concurrently-launched nodes per category using token_budget.fan_out_width, layered under the existing global maxParallelNodes, so code (`green`) lanes stay narrow per the Anthropic sizing tiers ("most coding tasks involve fewer truly parallelizable tasks").

DEPENDS ON PIPE-82.2 (provides token_budget.fan_out_width on PipelineConfig).

SEAM: thread `category` onto PlannedWorkflowNode in toPlannedNode (src/planning/compile.ts) from the source/catalog node when present. In launchReadyNodes (src/runtime/scheduler.ts), when picking the ready set per tick, launch at most fan_out_width.by_category[category] ?? fan_out_width.default same-category nodes, still bounded by the global maxParallelNodes. Nodes without a category fall under the default.

QUALITY: no casts; do not regress the existing global maxParallelNodes behaviour.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 PlannedWorkflowNode carries an optional category, populated in toPlannedNode (src/planning/compile.ts) when present on the source node
- [ ] #2 launchReadyNodes (src/runtime/scheduler.ts) launches at most fan_out_width.by_category[category] ?? fan_out_width.default same-category nodes per tick, still respecting global maxParallelNodes
- [ ] #3 A scheduler test asserts: a ready batch of N same-category nodes launches <= the category cap per tick; mixed categories each respect their own cap; absence of token_budget preserves current behaviour
- [ ] #4 npx vitest run (scheduler test) passes and npx tsc --noEmit is clean
<!-- AC:END -->
