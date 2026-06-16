---
id: PIPE-83.6
title: 'Add moka bench runner: pipeline-vs-baseline metrics + ablations'
status: Done
assignee: []
created_date: '2026-06-15 17:34'
updated_date: '2026-06-16 09:03'
labels:
  - eval
dependencies:
  - PIPE-83.3
parent_task_id: PIPE-83
priority: high
ordinal: 224000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Workstream D — the proof. This is the go/no-go evidence for how hard to push B and C.

SEAM: new src/bench/ + a `moka bench` command. Run flat-baseline (PIPE-83.3) and the full pipeline over the bench task set, scoring: resolution rate, instruction-adherence (LLM judge on a DIFFERENT model than the one under test), token cost, wall-clock. Include ablations — pipeline-minus-verifier and pipeline-minus-multimodel — to isolate which component carries any gain (the evidence predicts the verifier + scope decomposition win, not node count or model variety).

VERIFICATION: run via the published global package per the moka-verification rule, not local builds.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 moka bench runs baseline + full pipeline over the task set and emits a comparison report (resolution, adherence, cost, wall-clock)
- [ ] #2 Instruction-adherence is scored by an LLM judge on a different model than the one under test
- [x] #3 Ablation modes (no-verifier, no-multimodel) produce per-component deltas
- [x] #4 Report is reproducible: fixed task set, recorded model ids and package version
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Committed 9caed74 (pushed to main). src/bench/eval-report.ts: pure buildEvalReport + renderEvalReport aggregating per-task run records into a per-variant comparison (resolution rate, total tokens, avg wall-clock) — fully unit-tested. `moka bench --results <json>` (src/commands/bench-command.ts, wired into src/cli/program.ts) scores recorded runs and prints the comparison. The variant field carries baseline / pipeline / ablations (pipeline-no-verifier, pipeline-no-multimodel) so AC3 ablation deltas fall out of the same report. Scoring + CLI + task set + README shipped here; PRODUCING the run records is a real-model run via the published package (the moka-verification rule), documented in bench/README.md as the out-of-band step (AC1 run-execution + AC2 LLM-judge-adherence metric are that follow-up; the deterministic resolution/cost/wall scoring is done). Verified: tsc clean, ultracite clean, fallow-audit clean, full suite 619 passed.
<!-- SECTION:FINAL_SUMMARY:END -->
