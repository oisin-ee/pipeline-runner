---
id: PIPE-94.9
title: "Integration dogfood: submit -> kill -> inspect -> resume end-to-end"
status: Done
assignee: []
created_date: "2026-06-28 19:52"
updated_date: "2026-06-28 22:42"
labels: []
dependencies:
  - PIPE-94.5
  - PIPE-94.6
  - PIPE-94.7
  - PIPE-94.8
modified_files:
  - tests/next-node-submit-result-pg.test.ts
  - tests/moka-resume-schedule.test.ts
parent_task_id: PIPE-94
priority: high
ordinal: 330000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->

Workflow: feature-implementation
Scope: end-to-end proof (mirrors PIPE-91.9 dogfood) that a SUBMITTED run is durable + replayable: submit a multi-node run, interrupt mid-way, assert moka next node + status reconstruct exact state from the DB, then resume drains it. Verification is via the published global moka package on a non-trivial workload (per project verification rule), not a local build.
Dependencies: PIPE-94.5, PIPE-94.6, PIPE-94.7, PIPE-94.8
Escalation: report Met/Unmet criteria with evidence/blocker.

<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->

- [ ] #1 Submitted run interrupted mid-way: moka next node + status show correct DB-backed state -- Evidence: integration test transcript
- [ ] #2 moka resume drains the remaining nodes of a submitted run to completion -- Evidence: integration run output recorded
<!-- AC:END -->

## Definition of Done

<!-- DOD:BEGIN -->

- [ ] #1 Run the feature-implementation workflow in order
- [ ] #2 Verify via published global moka package on a real workload and record output
<!-- DOD:END -->
