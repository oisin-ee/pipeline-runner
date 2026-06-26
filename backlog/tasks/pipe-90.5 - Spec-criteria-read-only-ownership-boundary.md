---
id: PIPE-90.5
title: 'Spec: criteria read-only ownership boundary'
status: To Do
assignee: []
created_date: '2026-06-26 14:26'
labels: []
dependencies: []
references:
  - docs/moka-orchestrator-design.md
parent_task_id: PIPE-90
priority: medium
ordinal: 266000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Workflow: plan-scope-spec
Scope: locate and specify the enforcement seam making a ticket's acceptance criteria + their adjudicating tests READ-ONLY to the node's executing agent (anti reward-hacking; the agent must not weaken the tests that gate it). Inspect the agent FS sandbox/profile config and where criteria/tests live; produce assumptions + AC for a follow-up security ticket. No edits.
Escalation: report Met/Unmet criteria with evidence/blocker.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Enforcement seam identified with file:line (where agent FS access to criteria/tests is configured) -- Evidence: written findings citing the sandbox/profile code path
- [ ] #2 Follow-up security ticket drafted with concrete AC for read-only enforcement -- Evidence: ticket text with abuse-path test criteria
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Run the plan-scope-spec workflow in order (inspect -> assumptions -> AC -> grill/doubt review)
- [ ] #2 No code edits; findings + draft ticket recorded
<!-- DOD:END -->
