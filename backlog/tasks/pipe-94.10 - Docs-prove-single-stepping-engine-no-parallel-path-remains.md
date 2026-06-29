---
id: PIPE-94.10
title: Docs + prove single stepping engine (no parallel path remains)
status: Done
assignee: []
created_date: '2026-06-28 19:52'
updated_date: '2026-06-29 06:48'
labels: []
dependencies:
  - PIPE-94.9
modified_files:
  - docs/moka-orchestrator-design.md
  - docs/operator-guide.md
parent_task_id: PIPE-94
priority: medium
ordinal: 331000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Workflow: feature-implementation
Scope: update docs to describe submit -> durable substrate flow; prove the node-protocol/stepNode core is no longer an island (real callers in runner-command + local run + CLI). Prove no .pipeline runtime-state regression for submitted runs (mirrors PIPE-91.22).
Dependencies: PIPE-94.9
Escalation: report Met/Unmet criteria with evidence/blocker.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Docs describe the submitted-run durable flow + resume semantics -- Evidence: docs/moka-orchestrator-design.md + operator-guide.md diffs
- [ ] #2 stepNode/buildNextNodeEnvelope/recordSubmitResult have real engine callers -- Evidence: fallow audit / grep proof recorded, no unused-export findings
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Run the feature-implementation workflow in order
- [ ] #2 Run fallow audit + grep proof fresh and record output
<!-- DOD:END -->
