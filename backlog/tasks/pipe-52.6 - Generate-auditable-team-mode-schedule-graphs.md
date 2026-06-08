---
id: PIPE-52.6
title: Generate auditable team-mode schedule graphs
status: Done
assignee: []
created_date: '2026-06-08 19:01'
updated_date: '2026-06-08 19:57'
labels:
  - scheduler
  - team-mode
dependencies:
  - PIPE-52.1
references:
  - src/schedule-planner.ts
  - .pipeline/prompts/schedule-planner.md
  - .pipeline/skills/schedule-graph-shaping/SKILL.md
modified_files:
  - src/schedule-planner.ts
  - .pipeline/prompts/schedule-planner.md
  - .pipeline/skills/schedule-graph-shaping/SKILL.md
parent_task_id: PIPE-52
priority: high
ordinal: 151000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Add a scheduler strategy that produces OpenCode-team-like collaboration as explicit pipeline schedule DAGs with lead, specialist, integration, acceptance, and verifier nodes.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Schedule policy can request a team graph strategy that emits explicit root workflow nodes, never hidden dynamic team state.
- [ ] #2 Generated team graphs include a lead/planner node, parallel specialist implementation or research nodes, integration or drain-merge where needed, acceptance reviewer, and verifier.
- [ ] #3 Every specialist node declares a configured profile, task_context when applicable, needs edges, filesystem policy, and downstream coverage.
- [ ] #4 Validation rejects team graphs with write-capable parallel nodes sharing the same worktree unless isolated worktree roots or merge strategy are declared.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Extend schedule-planner policy/schema and prompt contract. Reuse existing explicit schedule validation and schedule-graph-shaping skill. Do not import OmO Team Mode tools; represent team behavior as pipeline DAG nodes.
<!-- SECTION:PLAN:END -->
