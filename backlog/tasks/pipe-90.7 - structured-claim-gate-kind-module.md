---
id: PIPE-90.7
title: structured-claim gate kind module
status: To Do
assignee: []
created_date: '2026-06-26 14:47'
labels: []
dependencies:
  - PIPE-90.2
  - PIPE-90.1
references:
  - docs/moka-orchestrator-design.md
modified_files:
  - src/runtime/gates/kinds/structured-claim/structured-claim.ts
parent_task_id: PIPE-90
priority: high
ordinal: 268000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Workflow: feature-implementation
Scope: new gate kind in its own module gates/kinds/structured-claim/ (name.ts + name.test.ts + index.ts). Validates that each acceptance criterion has non-empty evidence of the declared shape; emits structured refusal (unmet[]) for missing/empty evidence. Exports a GateEvaluator descriptor; does NOT edit the shared registry barrel (wired in the adjudicator ticket) to keep this parallel with the llm-judge kind.
Escalation: report Met/Unmet criteria with evidence/blocker.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A criterion with missing/empty evidence yields an unmet entry naming that criterion -- Evidence: unit test asserting unmet[].criterion
- [ ] #2 Module is self-contained and exports a GateEvaluator descriptor; no edits to gates.ts/registry.ts -- Evidence: diff touches only gates/kinds/structured-claim/*
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Run the feature-implementation workflow in order
- [ ] #2 pnpm run check + module unit tests ran fresh; output recorded
<!-- DOD:END -->
