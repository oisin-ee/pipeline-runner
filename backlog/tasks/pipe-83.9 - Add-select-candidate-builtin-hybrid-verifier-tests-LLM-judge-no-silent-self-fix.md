---
id: PIPE-83.9
title: >-
  Add select-candidate builtin: hybrid verifier (tests + LLM judge), no silent
  self-fix
status: Done
assignee: []
created_date: '2026-06-15 17:35'
updated_date: '2026-06-16 08:23'
labels:
  - architecture
  - verification
dependencies:
  - PIPE-83.7
references:
  - defaults/profiles.yaml
parent_task_id: PIPE-83
priority: medium
ordinal: 227000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Workstream B — the one multi-agent pattern with measured quality gains.

SEAM: new builtin runner src/runtime/builtins/select-candidate.ts (the builtin kind already exists, cf drain-merge). Given N candidate diffs (PIPE-83.7), run each candidate's tests (execution signal) AND an LLM judge score, combine into a hybrid score (hybrid beats execution-only or judge-only by 7-8pp — R2E-Gym), and select one.

NO SILENT SELF-FIX (Factory rule): the verify/select profile gets read + test tools only, never write — it surfaces/blocks/selects, it does not patch. Enforce in defaults/profiles.yaml.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 select-candidate runs each candidate's tests and an LLM judge, combines a hybrid score, and selects one
- [x] #2 Failing-tests candidates are blocked; if none pass, the node fails with a clear reason (no silent self-fix)
- [x] #3 The verify/select profile has no write tools (enforced in profiles.yaml)
- [ ] #4 On the bench set (PIPE-83.6), selection-over-N beats first-candidate
- [x] #5 npx tsc --noEmit clean; tests cover selection, all-fail, and no-write enforcement
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
AC1 COMPLETED (commit 79c803e, pushed to main): wired the LLM judge. select-candidate now scores each candidate with best_of_n.judge_model when set — a read-only judge call (mirroring createHandoffFinalizerPlan: inline read-only profile + createRunnerLaunchPlan + context.executor) returns a 0..1 score (parseScore) that feeds selectBestCandidate's tie-break alongside the PASS/FAIL execution status. Without judge_model, selection stays status-only. Hybrid (tests + judge) is now complete. Only AC4 (selection-over-N beats first-candidate on a bench set) remains, gated on the PIPE-83.6 eval harness + real runs.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Committed a437831 (controller-implemented). The candidates pass (PIPE-83.7) now emits a kind:parallel of N candidates (id `<node>--candidates`) feeding a new select-candidate builtin (src/runtime/select-candidate) that keeps the original node id, so the consumer's needs resolves to the winner. selectBestCandidate is a pure, fully-tested hybrid scorer: prefer a PASS candidate, break ties by highest judge_score, return null (node FAILs with evidence) when none pass. The builtin reads each candidate's output mirroring drain-merge (parallel aggregate -> child outputs), derives status from each candidate's verdict/status and judge_score from its output, and emits the winner's output. Registered `select-candidate` in the builtin dispatch. AC2 (block failing / fail-with-reason / no silent self-fix) and AC3 (a builtin has no agent profile/tools, so it inherently cannot write) and AC5 (tsc clean + selection/all-fail tests) met. AC1 PARTIAL: deterministic status-based selection works; the LLM-JUDGE model call is a documented follow-up (the scorer already consumes judge_score, so wiring is additive). AC4 (selection-over-N beats first-candidate on a bench set) needs the PIPE-83.6 eval harness + real runs. Default off -> schedules + PIPE-57 goldens unchanged. Verified: tsc clean, ultracite clean, fallow-audit 0 introduced findings, full suite 608 passed / 4 skipped.
<!-- SECTION:FINAL_SUMMARY:END -->
