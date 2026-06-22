---
id: PIPE-89.5
title: Update pipeline docs and generated package output
status: To Do
assignee: []
created_date: '2026-06-22 21:03'
labels: []
dependencies:
  - PIPE-89.4
modified_files:
  - README.md
  - docs/config-architecture.md
  - docs/operator-guide.md
  - dist
parent_task_id: PIPE-89
priority: medium
ordinal: 258000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Workflow: feature-implementation
Scope: update oisin-pipeline docs to describe oisin-ee/agent and regenerate dist from source.
Escalation: report Met/Unmet criteria with evidence/blocker.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 README and operator/config docs describe one asset repo oisin-ee/agent -- Evidence: grep for old repo names returns only intentional migration/deprecation references
- [ ] #2 dist output reflects source after build, with no hand edits -- Evidence: bun run build and git diff -- dist
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Run the ticket's agent-rules workflow in order
- [ ] #2 Run proof command/check and record output
<!-- DOD:END -->
