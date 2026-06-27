---
id: PIPE-45.16
title: Performance cleanup pass
status: To Do
assignee: []
created_date: '2026-06-27 14:03'
labels: []
dependencies:
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
  - .fallowrc.json
parent_task_id: PIPE-45
priority: medium
ordinal: 311000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Workflow: performance
Scope: Measure current hot/complex paths after structural splits and remove measurable avoidable cost only where evidence shows a bottleneck.
Dependencies: all structural cleanup tickets through PIPE-45.15
Likely modified files: modules identified by fallow/hotspot baseline
Reuse: existing fallow health/hotspot tooling and test suite; no speculative perf rewrites.
Escalation: report Met/Unmet criteria with evidence/blocker.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Baseline and after measurements use same command/conditions -- Evidence: before/after fallow/perf output.
- [ ] #2 Only measured bottlenecks are changed; no speculative optimization complexity is added -- Evidence: critique review.
- [ ] #3 Performance changes preserve behaviour -- Evidence: focused tests pass.
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Run performance workflow: baseline, identify bottleneck, change one bottleneck, remeasure, verify.
<!-- DOD:END -->
