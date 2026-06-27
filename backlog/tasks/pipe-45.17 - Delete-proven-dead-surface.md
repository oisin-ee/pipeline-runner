---
id: PIPE-45.17
title: Delete proven dead surface
status: To Do
assignee: []
created_date: '2026-06-27 14:03'
labels: []
dependencies:
  - PIPE-45.1
  - PIPE-45.2
  - PIPE-45.3
  - PIPE-45.4
  - PIPE-45.5
  - PIPE-45.6
  - PIPE-45.7
  - PIPE-45.8
  - PIPE-45.9
  - PIPE-45.10
  - PIPE-45.11
  - PIPE-45.12
  - PIPE-45.13
  - PIPE-45.14
  - PIPE-45.15
references:
  - src/runtime/index.ts
  - src/schedule/artifact.ts
  - package.json
modified_files:
  - package.json
parent_task_id: PIPE-45
priority: medium
ordinal: 312000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Workflow: feature-implementation
Scope: Delete static-analysis-proven dead files/exports/deps only after public contract guard proves they are private. Candidate surfaces from baseline include src/runtime/index.ts, src/schedule/artifact.ts, unused run-control exports, duplicate runner adapter exports, and package.json unused dependency rulesync if still confirmed.
Dependencies: PIPE-45.1 and structural splits through PIPE-45.15
Likely modified files: src/runtime/index.ts, src/schedule/artifact.ts, package.json, focused importers/tests
Reuse: knip, fallow, rg, package public API tests; no manual guess deletion.
Escalation: report Met/Unmet criteria with evidence/blocker.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Every deletion has static-analysis and rg/import evidence proving no public/internal consumer -- Evidence: knip/fallow/rg notes.
- [ ] #2 Public package surface remains compatible or migration evidence is explicit -- Evidence: public API/dist tests.
- [ ] #3 Package dependency deletion updates lockfile through package manager only -- Evidence: package manager command output if package.json changes.
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Run feature-implementation workflow with dead-code proof and quality-gate review; record proof.
<!-- DOD:END -->
