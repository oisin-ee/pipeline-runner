---
id: PIPE-89.2
title: Implement @oisin-ee/agent-auth library core (runner table + materialize API)
status: To Do
assignee: []
created_date: '2026-06-22 20:30'
updated_date: '2026-06-22 20:40'
labels: []
dependencies: []
references:
  - src/codex-auth-sync.ts
modified_files:
  - packages/agent-auth/src/materialize.ts
  - packages/agent-auth/src/runner-table.ts
parent_task_id: PIPE-89
priority: high
ordinal: 255000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Workflow: feature-implementation
Scope: the package core. Declarative runner table (data) keyed by runner -> {auth/accounts paths, plugin/config wiring, env}; materialize(runner, source, {check,dryRun}) generalised from src/codex-auth-sync.ts; account-source reader (mounted accounts.json). No CLI here.
Escalation: report Met/Unmet criteria with evidence/blocker.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 materialize() writes correct files+config for each runner in the table -- Evidence: vitest per-runner cases (tmp HOME) assert file contents
- [ ] #2 Variation is the runner table (data), not branching -- Evidence: code review shows one table owns per-runner differences
- [ ] #3 check/dryRun report actions without writing -- Evidence: test asserts no fs writes in check mode
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Run feature-implementation workflow in order (research/library-first, Build Contract, failing test, impl, quality-gate/critique, verify)
- [ ] #2 bun test for the package passes -- record output
<!-- DOD:END -->
