---
id: PIPE-45.15
title: Split install command planner and writer
status: To Do
assignee: []
created_date: '2026-06-27 14:03'
labels: []
dependencies:
  - PIPE-45.5
references:
  - src/install-commands.ts
modified_files:
  - src/install-commands.ts
  - src/install-commands/opencode.ts
  - tests/install-commands.test.ts
parent_task_id: PIPE-45
priority: medium
ordinal: 310000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Workflow: feature-implementation
Scope: Split src/install-commands.ts and host-specific install modules into planning, ownership/conflict handling, obsolete cleanup, and host writers/renderers.
Dependencies: PIPE-45.5
Likely modified files: src/install-commands.ts, src/install-commands/*, src/install/*, tests/install-commands.test.ts
Reuse: existing generated-marker convention and host renderers; no new installer framework.
Escalation: report Met/Unmet criteria with evidence/blocker.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Install planning and filesystem writing are separate owners -- Evidence: source inspection.
- [ ] #2 Host-specific generated command output remains stable -- Evidence: install command tests pass.
- [ ] #3 No generated files are hand-edited -- Evidence: diff review.
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Run feature-implementation workflow in order and record proof.
<!-- DOD:END -->
