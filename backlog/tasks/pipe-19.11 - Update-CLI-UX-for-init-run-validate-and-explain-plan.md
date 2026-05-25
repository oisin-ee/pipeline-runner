---
id: PIPE-19.11
title: 'Update CLI UX for init, run, validate, and explain-plan'
status: To Do
assignee: []
created_date: '2026-05-24 14:18'
updated_date: '2026-05-24 14:18'
labels:
  - pipeline
  - cli
  - ux
dependencies:
  - PIPE-19.2
  - PIPE-19.3
  - PIPE-19.5
  - PIPE-19.6
  - PIPE-19.9
  - PIPE-19.10
references:
  - src/index.ts
parent_task_id: PIPE-19
priority: high
ordinal: 30000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Update the command-line interface for the new config-driven architecture. Users should be able to scaffold config, validate config, inspect the compiled plan, and run a workflow using the same YAML source of truth.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 CLI supports initializing a default config and running a named workflow from `.pipeline/pipeline.yaml`.
- [ ] #2 CLI validation reports schema, reference, capability, runner, and host-support errors before execution.
- [ ] #3 CLI explain/dry-run output shows workflow nodes, dependencies, runner choice, native-versus-subprocess strategy, gates, hooks, and expected artifacts.
- [ ] #4 CLI errors clearly distinguish config errors, validation errors, runner capability errors, gate failures, and agent execution failures.
- [ ] #5 Tests cover successful and failing CLI flows without requiring paid model calls.
<!-- AC:END -->
