---
id: PIPE-45.2
title: Split config schema ownership
status: To Do
assignee: []
created_date: '2026-06-27 14:03'
labels: []
dependencies:
  - PIPE-45.1
references:
  - src/config/schemas.ts
  - src/config/validate.ts
modified_files:
  - src/config/schemas.ts
  - src/config/validate.ts
  - tests/config.test.ts
parent_task_id: PIPE-45
priority: high
ordinal: 297000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Workflow: feature-implementation
Scope: Split src/config/schemas.ts into domain schema modules and keep src/config/validate.ts as validation owner. Move cross-reference validation out of schema assembly where it improves ownership.
Dependencies: PIPE-45.1
Likely modified files: src/config/schemas.ts, src/config/schema/*, src/config/validate.ts, tests/config.test.ts
Reuse: Zod remains schema/validation library; no local parser replacement.
Escalation: report Met/Unmet criteria with evidence/blocker.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Config schema construction is split by domain without config behaviour drift -- Evidence: tests/config.test.ts and public API/config tests pass.
- [ ] #2 Cross-reference validation has one owner outside raw schema assembly where practical -- Evidence: source inspection and focused invalid-config assertions.
- [ ] #3 src/config/schemas.ts falls below 1k lines or records a specific structural justification -- Evidence: wc/fallow output.
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Run feature-implementation workflow in order and record proof.
<!-- DOD:END -->
