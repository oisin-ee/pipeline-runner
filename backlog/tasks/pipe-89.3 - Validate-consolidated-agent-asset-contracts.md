---
id: PIPE-89.3
title: Validate consolidated agent asset contracts
status: To Do
assignee: []
created_date: '2026-06-22 21:03'
labels: []
dependencies:
  - PIPE-89.2
references:
  - /Users/oisin/dev/agent
parent_task_id: PIPE-89
priority: high
ordinal: 256000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Workflow: feature-implementation
Scope: validate oisin-ee/agent repository shape, skill discovery, hook tests, rules concat, and stale source references.
Escalation: report Met/Unmet criteria with evidence/blocker.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Skills are discoverable and install from top-level skills/ -- Evidence: scratch npx --yes skills add ./skills --skill '*' --agent opencode --global --yes --copy in temp HOME
- [ ] #2 Hook tests pass from hooks/ after path relocation -- Evidence: sh hooks/tests/*.test.sh output
- [ ] #3 Rules concatenate from top-level rules/*.md -- Evidence: scripts/generate-rules.sh --stdout output includes expected ordered sections
- [ ] #4 Docs and installed rules no longer name old repos as canonical -- Evidence: grep for stale repo names reviewed
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Run the ticket's agent-rules workflow in order
- [ ] #2 Run proof command/check and record output
<!-- DOD:END -->
