---
id: PIPE-89.4
title: Migrate moka (codex-auth-sync) to @oisin-ee/agent-auth
status: To Do
assignee: []
created_date: '2026-06-22 20:30'
updated_date: '2026-06-22 20:40'
labels: []
dependencies: []
references:
  - src/codex-auth-sync.ts
modified_files:
  - src/codex-auth-sync.ts
parent_task_id: PIPE-89
priority: medium
ordinal: 257000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Workflow: feature-implementation
Scope: replace src/codex-auth-sync.ts internals with the lib (opencode + oc-codex-multi-auth wiring) while preserving behaviour. No change to argo-workflow mounts.
Escalation: report Met/Unmet criteria with evidence/blocker.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 codex-auth-sync delegates to the lib -- Evidence: import of @oisin-ee/agent-auth, no duplicated wiring
- [ ] #2 Existing codex-auth-sync behaviour preserved -- Evidence: existing tests pass unchanged
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Run feature-implementation workflow in order
- [ ] #2 bun test passes -- record output
<!-- DOD:END -->
