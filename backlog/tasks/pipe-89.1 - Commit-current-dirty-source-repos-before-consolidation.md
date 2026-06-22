---
id: PIPE-89.1
title: Commit current dirty source repos before consolidation
status: To Do
assignee: []
created_date: '2026-06-22 21:02'
labels: []
dependencies: []
references:
  - /Users/oisin/dev/agent-rules
  - /Users/oisin/dev/agent-hooks
modified_files:
  - docs/mcp-gateway.md
  - >-
    backlog/tasks/pipe-88 -
    Epic-Autonomous-ticket-loop-orchestrator-with-graph-traversal-console-observer.md
  - scripts/dedicate-codex-to-cluster.sh
  - scripts/update-openbao-codex-accounts.sh
parent_task_id: PIPE-89
priority: high
ordinal: 254000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Workflow: feature-implementation
Scope: commit current dirty changes in skills/rules/hooks/pipeline before moving history.
Escalation: report Met/Unmet criteria with evidence/blocker.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Dirty changes in agent-rules, agent-hooks, and oisin-pipeline are inspected and committed atomically, or excluded with explicit reason -- Evidence: git status/diff/log outputs and commit SHAs
- [ ] #2 Untracked pipeline scripts are secret-scanned before any commit -- Evidence: scan command output and reviewed file list
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Run the ticket's agent-rules workflow in order
- [ ] #2 Run proof command/check and record output
<!-- DOD:END -->
