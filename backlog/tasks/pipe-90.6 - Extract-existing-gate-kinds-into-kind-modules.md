---
id: PIPE-90.6
title: Extract existing gate kinds into kind modules
status: To Do
assignee: []
created_date: '2026-06-26 14:47'
labels: []
dependencies:
  - PIPE-90.2
references:
  - docs/moka-orchestrator-design.md
modified_files:
  - src/runtime/gates/gates.ts
  - src/runtime/gates/registry.ts
parent_task_id: PIPE-90
priority: medium
ordinal: 267000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Workflow: feature-implementation
Scope: behavior-preserving (B) refactor. Move the 7 inline evaluate*Gate fns out of gates.ts into self-contained modules gates/kinds/{command,artifact,builtin,verdict,acceptance,changed-files,json-schema}/ (each name.ts + name.test.ts + index.ts exporting a GateEvaluator descriptor), registered via the registry from PIPE-90.2. No behavior change. Atomic refactor kept separate from feature kinds for clean review/verify.
Escalation: report Met/Unmet criteria with evidence/blocker.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Each of the 7 kinds lives in its own gates/kinds/<kind>/ module with colocated test -- Evidence: tree listing + per-kind unit tests green
- [ ] #2 gates.ts no longer contains inline kind evaluators; registry resolves all 7 -- Evidence: gates.test.ts passes unchanged; gates.ts line count materially reduced
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Run the feature-implementation workflow in order
- [ ] #2 pnpm run check + full gates test suite ran fresh; output recorded
<!-- DOD:END -->
