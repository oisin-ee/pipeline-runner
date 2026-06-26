---
id: PIPE-89.9
title: 'Verify shared-auth end-to-end: rotation + all consumers'
status: To Do
assignee: []
created_date: '2026-06-22 20:30'
updated_date: '2026-06-22 20:40'
labels: []
dependencies: []
references:
  - infra/scripts/rotate-codex-accounts.sh
parent_task_id: PIPE-89
priority: high
ordinal: 262000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Workflow: completion-claim
Scope: prove the unified path works after migrations. Run scripts/rotate-codex-accounts.sh (or confirm a rotation) and confirm moka, autofix, pipeline-runner, coder all consume the refreshed shared accounts via agent-auth. No consumer retains bespoke auth.
Escalation: report Met/Unmet criteria with evidence/blocker.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 All four consumers authenticate via agent-auth off the shared store -- Evidence: one live run/smoke per consumer recorded
- [ ] #2 No bespoke auth-materialization path remains -- Evidence: grep shows codex-auth-sync/preflight/main.tf/agent-credentials all delegate to agent-auth
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Run completion-claim workflow (verify): run real checks, read output, report exact results
<!-- DOD:END -->
