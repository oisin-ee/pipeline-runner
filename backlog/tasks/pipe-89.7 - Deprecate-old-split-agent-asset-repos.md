---
id: PIPE-89.7
title: Deprecate old split agent asset repos
status: To Do
assignee: []
created_date: '2026-06-22 21:04'
labels: []
dependencies:
  - PIPE-89.6
references:
  - /Users/oisin/dev/skills
  - /Users/oisin/dev/agent-rules
  - /Users/oisin/dev/agent-hooks
parent_task_id: PIPE-89
priority: medium
ordinal: 260000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Workflow: plan-scope-spec
Scope: after verification, mark old oisin-ee/skills, oisin-ee/rules, and oisin-ee/agent-hooks as deprecated or archived with pointers to oisin-ee/agent.
Escalation: report Met/Unmet criteria with evidence/blocker.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Old repos point to oisin-ee/agent as canonical replacement -- Evidence: README/deprecation text or gh repo archive state
- [ ] #2 No active oisin-pipeline install path still uses old repos -- Evidence: grep across oisin-pipeline and oisin-ee/agent
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Run the ticket's agent-rules workflow in order
- [ ] #2 Run proof command/check and record output
<!-- DOD:END -->
