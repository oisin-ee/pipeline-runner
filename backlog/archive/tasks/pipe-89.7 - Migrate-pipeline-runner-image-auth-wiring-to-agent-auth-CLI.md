---
id: PIPE-89.7
title: Migrate pipeline-runner image auth wiring to agent-auth CLI
status: To Do
assignee: []
created_date: '2026-06-22 20:30'
updated_date: '2026-06-22 20:40'
labels: []
dependencies: []
modified_files:
  - infra/k8s/images/pipeline-runner/entrypoint-preflight.sh
  - infra/k8s/images/pipeline-runner/Dockerfile
parent_task_id: PIPE-89
priority: medium
ordinal: 260000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Workflow: feature-implementation
Scope (infra repo): replace bespoke codex/oc-codex-multi-auth wiring in k8s/images/pipeline-runner (Dockerfile + entrypoint-preflight.sh) with the agent-auth CLI. Behaviour preserved.
Escalation: report Met/Unmet criteria with evidence/blocker.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 preflight calls agent-auth CLI, no bespoke wiring -- Evidence: diff shows CLI call replacing inline logic
- [ ] #2 runner still authenticates to shared accounts -- Evidence: https-clone-smoke / runner job succeeds
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Run feature-implementation workflow in order
- [ ] #2 Runner smoke recorded
<!-- DOD:END -->
