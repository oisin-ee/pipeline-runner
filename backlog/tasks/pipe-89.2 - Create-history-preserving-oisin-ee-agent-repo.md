---
id: PIPE-89.2
title: Create history-preserving oisin-ee/agent repo
status: To Do
assignee: []
created_date: '2026-06-22 21:02'
labels: []
dependencies:
  - PIPE-89.1
references:
  - /Users/oisin/dev/skills
  - /Users/oisin/dev/agent-rules
  - /Users/oisin/dev/agent-hooks
parent_task_id: PIPE-89
priority: high
ordinal: 255000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Workflow: feature-implementation
Scope: create oisin-ee/agent and import skills, rules, and hooks as physical subdirectories with preserved history; no git submodules.
Escalation: report Met/Unmet criteria with evidence/blocker.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 GitHub repo oisin-ee/agent exists and local clone is configured -- Evidence: gh repo view oisin-ee/agent and git remote -v
- [ ] #2 Histories are preserved under skills/, rules/, and hooks/ -- Evidence: git log --follow for representative files from each source
- [ ] #3 No git submodules are used -- Evidence: test ! -f .gitmodules and git submodule status output
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Run the ticket's agent-rules workflow in order
- [ ] #2 Run proof command/check and record output
<!-- DOD:END -->
