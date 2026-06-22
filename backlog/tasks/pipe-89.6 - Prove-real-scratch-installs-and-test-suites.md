---
id: PIPE-89.6
title: Prove real scratch installs and test suites
status: To Do
assignee: []
created_date: '2026-06-22 21:03'
labels: []
dependencies:
  - PIPE-89.5
references:
  - tests/pipeline-init.test.ts
  - tests/install-hooks.test.ts
  - tests/install-rules.test.ts
parent_task_id: PIPE-89
priority: high
ordinal: 259000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Workflow: completion-claim
Scope: verify consolidated source and pipeline behavior with real scratch installs and full relevant test suites.
Escalation: report Met/Unmet criteria with evidence/blocker.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Real npx skills add oisin-ee/agent/skills installs expected skills in temp HOME -- Evidence: command output and installed files
- [ ] #2 Real moka init installs skills, hooks, and rules from oisin-ee/agent into temp HOME -- Evidence: non-check moka init output plus generated host files
- [ ] #3 moka init --check passes after install -- Evidence: command output
- [ ] #4 Pipeline tests and checks pass -- Evidence: targeted installer tests, bun run typecheck, bun run test, bun run build
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Run the ticket's agent-rules workflow in order
- [ ] #2 Run proof command/check and record output
<!-- DOD:END -->
