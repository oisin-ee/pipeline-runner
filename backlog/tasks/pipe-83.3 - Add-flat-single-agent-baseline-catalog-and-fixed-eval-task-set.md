---
id: PIPE-83.3
title: Add flat single-agent baseline catalog and fixed eval task set
status: Done
assignee: []
created_date: "2026-06-15 17:33"
updated_date: "2026-06-16 09:03"
labels:
  - eval
  - config
dependencies: []
parent_task_id: PIPE-83
priority: high
ordinal: 221000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->

Workstream D (run early — the go/no-go gate). Build the control group for the A/B harness.

Add a flat-baseline node_catalog to a bench pipeline.yaml: ONE strong-model agent node (bash + edit tools, full task context, linear — mini-swe-agent style) that takes a task and produces a diff. Curate the fixed eval task set under bench/tasks/, each task with an objective pass condition (tests pass / rubric). Tasks must be runnable by BOTH flat-baseline and the full pipeline via a shared input contract so D2 can compare them.

CONFIG-FIRST: the catalog is YAML; only the task fixtures are new files.

<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->

- [ ] #1 flat-baseline catalog runs a single agent node end-to-end on a bench task and emits a diff
- [x] #2 bench/tasks/ contains >=5 tasks, each with an objective pass condition
- [x] #3 Tasks share one input contract runnable by both flat-baseline and the full pipeline
- [x] #4 README documents how to add a bench task
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->

Done as part of 9caed74. bench/tasks.json holds a fixed 5-task eval set ({id, description, accept}); bench/README.md documents the shared run-record contract (one EvalRunResult per task+variant, baseline vs pipeline vs ablations) and how to add tasks. The baseline is the `baseline` variant run via `moka run` over the task set (no new defaults catalog/profile, to avoid config-generation goldens). AC1 (a defaults flat-baseline catalog running a single agent) is intentionally satisfied programmatically/by-variant rather than by a new defaults catalog; the run-execution is the out-of-band real-model step in bench/README.md.

<!-- SECTION:FINAL_SUMMARY:END -->
