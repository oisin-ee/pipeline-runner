---
id: PIPE-89.8
title: Migrate coder dev-workspace auth wiring to agent-auth CLI
status: To Do
assignee: []
created_date: '2026-06-22 20:30'
updated_date: '2026-06-22 20:40'
labels: []
dependencies: []
modified_files:
  - infra/coder-templates/dev-workspace/main.tf
parent_task_id: PIPE-89
priority: low
ordinal: 261000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Workflow: feature-implementation
Scope (infra repo): replace the codex-multi-auth shell block in coder-templates/dev-workspace/main.tf with the agent-auth CLI.
Escalation: report Met/Unmet criteria with evidence/blocker.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 main.tf uses agent-auth CLI, bespoke shell removed -- Evidence: tf diff
- [ ] #2 workspace codex/opencode authenticates -- Evidence: workspace smoke (codex-multi-auth switch / opencode run)
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Run feature-implementation workflow in order
- [ ] #2 Workspace auth smoke recorded
<!-- DOD:END -->
